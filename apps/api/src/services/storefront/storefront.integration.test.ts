import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  algoListings,
  auditEvents,
  backtestRuns,
  billingEvents,
  closeDatabase,
  createTestDatabase,
  customers,
  entitlements,
  isTestDatabaseAvailable,
  seedOrganisation,
  seedPineRevision,
  seedStorefront,
  seedStrategyVersion,
  subscriptions,
  trades,
  truncateAll,
  users,
  type Database,
} from "@arf-os/db";
import { generateId } from "@arf-os/contracts";
import { getPublishedListingDetail, getStorefrontBySlug, listPublishedListings } from "./catalogue.js";
import { createCheckout, quoteSelection } from "./checkout.js";
import { deliverAlgoSource, listCustomerEntitlements } from "./delivery.js";
import { InMemoryBillingProvider } from "./in-memory-provider.js";
import {
  createListing,
  publishListing,
  publishRelease,
  publishStatSnapshot,
  retireListing,
  setListingPrice,
} from "./publishing.js";
import { handleBillingWebhook } from "./webhooks.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("storefront (integration)", () => {
  let db: Database;
  let provider: InMemoryBillingProvider;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    provider = new InMemoryBillingProvider();
  });

  /** Builds a fully published, priced algo with evidence, the way an operator would. */
  async function publishAlgo(
    options: {
      slug?: string;
      amountMinor?: number;
      /** Reuse an existing storefront to publish a second algo into it. */
      into?: { org: Awaited<ReturnType<typeof seedOrganisation>>; storefront: Awaited<ReturnType<typeof seedStorefront>> };
    } = {},
  ) {
    // Explicit unique slugs: seedOrganisation derives its default slug from a
    // UUIDv7 prefix, and two orgs created in the same millisecond share it.
    const org = options.into?.org ?? (await seedOrganisation(db, { slug: `org-${generateId<string>().slice(24)}` }));
    const storefront =
      options.into?.storefront ?? (await seedStorefront(db, org, { slug: `shop-${generateId<string>().slice(24)}` }));
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const revision = await seedPineRevision(db, strategy.strategyVersionId);

    const listing = await createListing(db, {
      storefrontId: storefront.storefrontId,
      organisationId: org.organisationId,
      actorUserId: org.userId,
      slug: options.slug ?? "momentum-btc",
      name: "Momentum BTC",
      tagline: "Trend continuation on BTC 1h.",
      description: "A long-only momentum system.",
      riskNote: "Past performance does not predict future results.",
      marketCategory: "CRYPTO",
      symbol: "BTCUSD",
      timeframe: "60",
    });
    if (!listing.ok) throw new Error(`listing not created: ${listing.message}`);

    await setListingPrice(db, {
      listingId: listing.listingId,
      currency: "USD",
      monthlyAmountMinor: options.amountMinor ?? 4900,
    });

    const release = await publishRelease(db, {
      listingId: listing.listingId,
      strategyVersionId: strategy.strategyVersionId,
      changelog: "First public release.",
      setupInstructions: "Paste into TradingView and set the alert webhook.",
      actorUserId: org.userId,
    });
    if (!release.ok) throw new Error(`release not published: ${release.message}`);

    const backtestRunId = await seedSucceededRun(strategy.strategyVersionId);
    const stats = await publishStatSnapshot(db, {
      releaseId: release.releaseId,
      backtestRunId,
      scope: "OUT_OF_SAMPLE",
      actorUserId: org.userId,
    });
    if (!stats.ok) throw new Error(`stats not published: ${stats.message}`);

    const published = await publishListing(db, { listingId: listing.listingId, actorUserId: org.userId });
    if (!published.ok) throw new Error(`listing not published: ${published.message}`);

    return { org, storefront, strategy, revision, listingId: listing.listingId, releaseId: release.releaseId };
  }

  async function seedSucceededRun(strategyVersionId: string): Promise<string> {
    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId,
      runnerType: "LOCAL_RUNNER",
      runnerVersion: "1.0.0",
      symbol: "BTCUSD",
      timeframe: "60",
      segmentKind: "VALIDATION",
      fromTs: new Date("2025-01-01T00:00:00.000Z"),
      toTs: new Date("2025-06-30T00:00:00.000Z"),
      costModel: { commissionPct: 0.05, slippageTicks: 1 },
      initialCapital: "10000",
      status: "SUCCEEDED",
      sourceHash: "source-hash",
    });

    await db.insert(trades).values([
      {
        id: generateId<string>(),
        backtestRunId,
        sequenceNumber: 1,
        direction: "LONG",
        entryTime: new Date("2025-01-05T00:00:00.000Z"),
        exitTime: new Date("2025-01-06T00:00:00.000Z"),
        entryPrice: "100",
        exitPrice: "110",
        quantity: "1",
        grossPnl: "10",
        fees: "1",
        netPnl: "900",
      },
      {
        id: generateId<string>(),
        backtestRunId,
        sequenceNumber: 2,
        direction: "LONG",
        entryTime: new Date("2025-02-05T00:00:00.000Z"),
        exitTime: new Date("2025-02-06T00:00:00.000Z"),
        entryPrice: "110",
        exitPrice: "105",
        quantity: "1",
        grossPnl: "-5",
        fees: "1",
        netPnl: "-300",
      },
    ]);

    return backtestRunId;
  }

  /** Drives a complete checkout, including the webhook that actually grants access. */
  async function buyAlgos(
    storefrontSlug: string,
    listingIds: string[],
    options: { userEmail?: string } = {},
  ): Promise<{ customerUserId: string; providerSubscriptionId: string }> {
    const storefront = await getStorefrontBySlug(db, storefrontSlug);
    if (!storefront) throw new Error("storefront missing");

    // A buyer is a plain user row with no membership — exactly what a Clerk
    // personal account resolves to.
    const customerUserId = generateId<string>();
    await db.insert(users).values({
      id: customerUserId,
      externalAuthSubject: `sub-${customerUserId}`,
      email: options.userEmail ?? `buyer-${customerUserId.slice(0, 6)}@test.local`,
    });

    const checkout = await createCheckout(db, provider, {
      storefront,
      userId: customerUserId,
      listingIds,
      successUrl: "https://shop.test/success",
      cancelUrl: "https://shop.test/cancel",
      idempotencyKey: `key-${generateId<string>()}`,
    });
    if (!checkout.ok) throw new Error(`checkout failed: ${checkout.message}`);

    const providerSessionId = [...provider.checkouts.keys()].at(-1);
    if (!providerSessionId) throw new Error("provider recorded no checkout session");
    const providerSubscriptionId = `sub_${providerSessionId}`;
    provider.seedSubscription({
      providerSubscriptionId,
      status: "ACTIVE",
      currentPeriodEnd: new Date("2026-12-31T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
    });

    const body = JSON.stringify({
      id: `evt_${providerSessionId}`,
      type: "checkout.session.completed",
      data: { object: { id: providerSessionId, subscription: providerSubscriptionId, metadata: {} } },
    });
    const outcome = await handleBillingWebhook({ db, provider }, body, provider.signatureFor(body));
    expect(outcome.outcome).toBe("PROCESSED");

    return { customerUserId, providerSubscriptionId };
  }

  it("publishes an algo and serves it in the public catalogue with its evidence", async () => {
    const { storefront } = await publishAlgo();

    const items = await listPublishedListings(db, storefront.storefrontId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ slug: "momentum-btc", monthlyPrice: { currency: "USD", amountMinor: 4900 } });
    // Net profit of 600 on 10,000 initial capital, recomputed from the ledger.
    expect(items[0]?.headline).toMatchObject({ scope: "OUT_OF_SAMPLE", netProfitPct: 6, tradeCount: 2 });

    const detail = await getPublishedListingDetail(db, storefront.storefrontId, "momentum-btc");
    expect(detail?.currentRelease).toMatchObject({ releaseNumber: 1 });
    expect(detail?.snapshots).toHaveLength(1);
    expect(detail?.snapshots[0]?.monthlyReturns.map((entry) => entry.month)).toEqual(["2025-01", "2025-02"]);
    // The public payload must never carry source, however deep it is nested.
    expect(JSON.stringify(detail)).not.toContain("@version=6");
  });

  it("refuses to publish a release from a strategy version that is not PAPER_APPROVED", async () => {
    const org = await seedOrganisation(db);
    const storefront = await seedStorefront(db, org);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PINE_DEVELOPMENT" });
    await seedPineRevision(db, strategy.strategyVersionId);

    const listing = await createListing(db, {
      storefrontId: storefront.storefrontId,
      organisationId: org.organisationId,
      actorUserId: org.userId,
      slug: "unvalidated",
      name: "Unvalidated",
      tagline: "",
      description: "",
      riskNote: "",
      marketCategory: "CRYPTO",
      symbol: "BTCUSD",
      timeframe: "60",
    });
    if (!listing.ok) throw new Error("listing not created");

    const release = await publishRelease(db, {
      listingId: listing.listingId,
      strategyVersionId: strategy.strategyVersionId,
      changelog: "",
      setupInstructions: "",
      actorUserId: org.userId,
    });

    expect(release).toMatchObject({ ok: false, reasonCode: "NOT_PAPER_APPROVED" });
  });

  it("refuses to publish a listing with no evidence snapshot", async () => {
    const org = await seedOrganisation(db);
    const storefront = await seedStorefront(db, org);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    await seedPineRevision(db, strategy.strategyVersionId);

    const listing = await createListing(db, {
      storefrontId: storefront.storefrontId,
      organisationId: org.organisationId,
      actorUserId: org.userId,
      slug: "no-evidence",
      name: "No evidence",
      tagline: "",
      description: "",
      riskNote: "",
      marketCategory: "CRYPTO",
      symbol: "BTCUSD",
      timeframe: "60",
    });
    if (!listing.ok) throw new Error("listing not created");

    await setListingPrice(db, { listingId: listing.listingId, currency: "USD", monthlyAmountMinor: 4900 });
    await publishRelease(db, {
      listingId: listing.listingId,
      strategyVersionId: strategy.strategyVersionId,
      changelog: "",
      setupInstructions: "",
      actorUserId: org.userId,
    });

    const outcome = await publishListing(db, { listingId: listing.listingId, actorUserId: org.userId });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "NO_PUBLISHED_EVIDENCE" });

    const [row] = await db
      .select({ status: algoListings.status })
      .from(algoListings)
      .where(eq(algoListings.id, listing.listingId));
    expect(row?.status).toBe("DRAFT");
  });

  it("never returns another storefront's listing", async () => {
    const first = await publishAlgo({ slug: "algo-one" });
    const secondOrg = await seedOrganisation(db, { slug: `org-${generateId<string>().slice(24)}` });
    const secondStorefront = await seedStorefront(db, secondOrg, { slug: `shop-${generateId<string>().slice(24)}` });

    const items = await listPublishedListings(db, secondStorefront.storefrontId);
    expect(items).toEqual([]);

    const detail = await getPublishedListingDetail(db, secondStorefront.storefrontId, "algo-one");
    expect(detail).toBeNull();
    expect(first.listingId).toBeTruthy();
  });

  it("prices a multi-algo selection with the volume discount", async () => {
    const first = await publishAlgo({ slug: "algo-one" });
    const second = await publishAlgo({
      slug: "algo-two",
      into: { org: first.org, storefront: first.storefront },
    });

    const quoted = await quoteSelection(db, {
      storefrontId: first.storefront.storefrontId,
      listingIds: [first.listingId, second.listingId],
    });

    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.quote.appliedTier?.discountBps).toBe(1000);
    expect(quoted.quote.totalMinor).toBe(2 * (4900 - 490));
    expect(quoted.quote.lines.reduce((sum, line) => sum + line.netAmountMinor, 0)).toBe(quoted.quote.totalMinor);
  });

  it("refuses to price a listing that is not published in this storefront", async () => {
    const { storefront } = await publishAlgo();
    const quoted = await quoteSelection(db, {
      storefrontId: storefront.storefrontId,
      listingIds: [generateId<string>()],
    });
    expect(quoted).toMatchObject({ ok: false, reasonCode: "LISTING_NOT_AVAILABLE" });
  });

  it("delivers Pine source to an entitled customer and audits the read", async () => {
    const { storefront, listingId, revision } = await publishAlgo();
    const buyer = await buyAlgos(storefront.slug, [listingId]);

    const customerId = await customerIdFor(storefront.storefrontId, buyer.customerUserId);
    const delivered = await deliverAlgoSource(db, {
      storefrontId: storefront.storefrontId,
      customerId,
      listingSlug: "momentum-btc",
      traceId: "trace-1",
    });

    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    // The customer receives exactly the immutable revision the release points
    // at, hash included, so they can verify it themselves.
    expect(delivered.delivery.pineSource).toBe(revision.source);
    expect(delivered.delivery.pineSourceHash).toBe(revision.sourceHash);

    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ALGO_SOURCE_DELIVERED"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe(`customer:${customerId}`);
    // The audit trail records the hash, never a second copy of the source.
    expect(JSON.stringify(audits[0]?.newStateSummary)).not.toContain("@version=6");
  });

  it("refuses source to a customer with no entitlement", async () => {
    const { storefront, listingId } = await publishAlgo();
    const buyer = await buyAlgos(storefront.slug, [listingId]);

    // A second buyer who bought nothing.
    const strangerUserId = generateId<string>();
    await db.insert(users).values({
      id: strangerUserId,
      externalAuthSubject: `sub-${strangerUserId}`,
      email: `stranger-${strangerUserId.slice(0, 6)}@test.local`,
    });
    const strangerCustomerId = generateId<string>();
    await db.insert(customers).values({
      id: strangerCustomerId,
      storefrontId: storefront.storefrontId,
      userId: strangerUserId,
      providerCustomerId: `cus_stranger_${strangerCustomerId.slice(0, 6)}`,
    });

    const denied = await deliverAlgoSource(db, {
      storefrontId: storefront.storefrontId,
      customerId: strangerCustomerId,
      listingSlug: "momentum-btc",
    });

    expect(denied).toMatchObject({ ok: false, reasonCode: "NOT_ENTITLED" });
    expect(buyer.customerUserId).toBeTruthy();

    // A denied read is not a protected-data read, so it writes no delivery audit.
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.action, "ALGO_SOURCE_DELIVERED"));
    expect(audits).toHaveLength(0);
  });

  it("processes a webhook once, however many times it is redelivered", async () => {
    const { storefront, listingId } = await publishAlgo();
    const buyer = await buyAlgos(storefront.slug, [listingId]);

    const providerSessionId = [...provider.checkouts.keys()].at(-1);
    if (!providerSessionId) throw new Error("provider recorded no checkout session");
    const body = JSON.stringify({
      id: `evt_${providerSessionId}`,
      type: "checkout.session.completed",
      data: {
        object: { id: providerSessionId, subscription: buyer.providerSubscriptionId, metadata: {} },
      },
    });

    const replayed = await handleBillingWebhook({ db, provider }, body, provider.signatureFor(body));
    expect(replayed.outcome).toBe("REPLAY");

    const subscriptionRows = await db.select().from(subscriptions);
    expect(subscriptionRows).toHaveLength(1);

    const entitlementRows = await db.select().from(entitlements);
    expect(entitlementRows).toHaveLength(1);

    const eventRows = await db.select().from(billingEvents);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]?.status).toBe("PROCESSED");
  });

  it("changes nothing when the webhook signature does not verify", async () => {
    const { storefront, listingId } = await publishAlgo();
    const providerSessionId = "cs_forged";
    const body = JSON.stringify({
      id: "evt_forged",
      type: "checkout.session.completed",
      data: { object: { id: providerSessionId, subscription: "sub_forged", metadata: {} } },
    });

    const rejected = await handleBillingWebhook({ db, provider }, body, "t=1,v1=deadbeef");
    expect(rejected).toMatchObject({ outcome: "REJECTED", reasonCode: "INVALID_SIGNATURE" });

    // Not even recorded: an unverified delivery is not evidence of anything.
    expect(await db.select().from(billingEvents)).toHaveLength(0);
    expect(await db.select().from(entitlements)).toHaveLength(0);
    expect(listingId).toBeTruthy();
    expect(storefront.slug).toBeTruthy();
  });

  it("revokes access when the subscription is cancelled, and reports it on the account page", async () => {
    const { storefront, listingId } = await publishAlgo();
    const buyer = await buyAlgos(storefront.slug, [listingId]);
    const customerId = await customerIdFor(storefront.storefrontId, buyer.customerUserId);

    const body = JSON.stringify({
      id: "evt_cancelled",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: buyer.providerSubscriptionId,
          status: "canceled",
          current_period_end: null,
          cancel_at_period_end: true,
        },
      },
    });

    const outcome = await handleBillingWebhook({ db, provider }, body, provider.signatureFor(body));
    expect(outcome.outcome).toBe("PROCESSED");

    const owned = await listCustomerEntitlements(db, customerId);
    expect(owned[0]?.status).toBe("REVOKED");

    const denied = await deliverAlgoSource(db, {
      storefrontId: storefront.storefrontId,
      customerId,
      listingSlug: "momentum-btc",
    });
    expect(denied).toMatchObject({ ok: false, reasonCode: "NOT_ENTITLED" });
  });

  it("keeps access until the paid-through date when cancellation is scheduled", async () => {
    const { storefront, listingId } = await publishAlgo();
    const buyer = await buyAlgos(storefront.slug, [listingId]);
    const customerId = await customerIdFor(storefront.storefrontId, buyer.customerUserId);

    const periodEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const body = JSON.stringify({
      id: "evt_cancel_scheduled",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: buyer.providerSubscriptionId,
          status: "active",
          current_period_end: Math.floor(periodEnd.getTime() / 1000),
          cancel_at_period_end: true,
        },
      },
    });

    expect((await handleBillingWebhook({ db, provider }, body, provider.signatureFor(body))).outcome).toBe("PROCESSED");

    const stillEntitled = await deliverAlgoSource(db, {
      storefrontId: storefront.storefrontId,
      customerId,
      listingSlug: "momentum-btc",
    });
    expect(stillEntitled.ok).toBe(true);

    const [row] = await db.select().from(entitlements).where(eq(entitlements.customerId, customerId));
    expect(row?.expiresAt?.getTime()).toBe(Math.floor(periodEnd.getTime() / 1000) * 1000);
  });

  it("leaves entitlements alone while a payment is being retried", async () => {
    const { storefront, listingId } = await publishAlgo();
    const buyer = await buyAlgos(storefront.slug, [listingId]);
    const customerId = await customerIdFor(storefront.storefrontId, buyer.customerUserId);

    const body = JSON.stringify({
      id: "evt_past_due",
      type: "customer.subscription.updated",
      data: {
        object: { id: buyer.providerSubscriptionId, status: "past_due", cancel_at_period_end: false },
      },
    });

    expect((await handleBillingWebhook({ db, provider }, body, provider.signatureFor(body))).outcome).toBe("PROCESSED");

    const stillEntitled = await deliverAlgoSource(db, {
      storefrontId: storefront.storefrontId,
      customerId,
      listingSlug: "momentum-btc",
    });
    expect(stillEntitled.ok).toBe(true);

    const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.customerId, customerId));
    expect(subscription?.status).toBe("PAST_DUE");
  });

  it("retiring a listing hides it without taking access away from subscribers", async () => {
    const { storefront, listingId, org } = await publishAlgo();
    const buyer = await buyAlgos(storefront.slug, [listingId]);
    const customerId = await customerIdFor(storefront.storefrontId, buyer.customerUserId);

    const retired = await retireListing(db, { listingId, actorUserId: org.userId });
    expect(retired).toMatchObject({ ok: true });

    expect(await listPublishedListings(db, storefront.storefrontId)).toEqual([]);

    const stillEntitled = await deliverAlgoSource(db, {
      storefrontId: storefront.storefrontId,
      customerId,
      listingSlug: "momentum-btc",
    });
    expect(stillEntitled.ok).toBe(true);
  });

  async function customerIdFor(storefrontId: string, userId: string): Promise<string> {
    const [row] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.storefrontId, storefrontId), eq(customers.userId, userId)))
      .limit(1);
    if (!row) throw new Error("customer row missing");
    return row.id;
  }
});
