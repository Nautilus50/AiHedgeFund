import { generateId } from "@arf-os/contracts";
import type { Database } from "./client.js";
import {
  campaigns,
  memberships,
  organisations,
  pineRevisions,
  storefronts,
  strategies,
  strategyVersions,
  users,
  volumeDiscountTiers,
} from "./schema/index.js";

export interface SeededOrganisation {
  organisationId: string;
  userId: string;
  campaignId: string;
}

/**
 * Creates a complete organisation -> user -> membership -> campaign chain.
 * Integration tests need two of these to prove cross-organisation isolation,
 * so this returns fresh ids on every call rather than fixed constants.
 */
export async function seedOrganisation(
  db: Database,
  options: { slug?: string; role?: "ADMIN" | "RESEARCHER" | "COMMITTEE_MEMBER" | "DEVELOPER" } = {},
): Promise<SeededOrganisation> {
  const organisationId = generateId<string>();
  const userId = generateId<string>();
  const campaignId = generateId<string>();
  const slug = options.slug ?? `org-${organisationId.slice(0, 8)}`;

  await db.insert(organisations).values({ id: organisationId, name: slug, slug });
  await db.insert(users).values({
    id: userId,
    externalAuthSubject: `sub-${userId}`,
    email: `${slug}@test.local`,
  });
  await db.insert(memberships).values({
    id: generateId<string>(),
    organisationId,
    userId,
    role: options.role ?? "ADMIN",
  });
  await db.insert(campaigns).values({
    id: campaignId,
    organisationId,
    name: `${slug} campaign`,
    brief: "Integration test campaign",
    allowedMarkets: ["crypto"],
    createdByUserId: userId,
  });

  return { organisationId, userId, campaignId };
}

export interface SeededStrategy {
  strategyId: string;
  strategyVersionId: string;
}

export async function seedStrategyVersion(
  db: Database,
  seed: SeededOrganisation,
  options: {
    workflowState?: "PINE_DEVELOPMENT" | "TRADINGVIEW_VERIFICATION" | "PAPER_APPROVAL_REVIEW" | "PAPER_APPROVED";
    createdByAgentRunId?: string;
  } = {},
): Promise<SeededStrategy> {
  const strategyId = generateId<string>();
  const strategyVersionId = generateId<string>();

  await db.insert(strategies).values({
    id: strategyId,
    organisationId: seed.organisationId,
    campaignId: seed.campaignId,
    name: "Integration test strategy",
  });

  await db.insert(strategyVersions).values({
    id: strategyVersionId,
    strategyId,
    parentVersionId: null,
    versionNumber: 1,
    workflowState: options.workflowState ?? "TRADINGVIEW_VERIFICATION",
    createdByAgentRunId: options.createdByAgentRunId ?? null,
  });

  return { strategyId, strategyVersionId };
}

export interface SeededStorefront {
  storefrontId: string;
  slug: string;
}

/** Creates the storefront that fronts an already-seeded organisation (ADR 0015). */
export async function seedStorefront(
  db: Database,
  seed: SeededOrganisation,
  options: { slug?: string; tiers?: { minAlgos: number; discountBps: number }[] } = {},
): Promise<SeededStorefront> {
  const storefrontId = generateId<string>();
  const slug = options.slug ?? `shop-${storefrontId.slice(0, 8)}`;

  await db.insert(storefronts).values({
    id: storefrontId,
    organisationId: seed.organisationId,
    slug,
    name: `${slug} storefront`,
    tagline: "Integration test storefront",
    supportEmail: `support@${slug}.test`,
    defaultCurrency: "USD",
  });

  const tiers = options.tiers ?? [
    { minAlgos: 2, discountBps: 1000 },
    { minAlgos: 4, discountBps: 2000 },
  ];
  if (tiers.length > 0) {
    await db.insert(volumeDiscountTiers).values(
      tiers.map((tier) => ({ id: generateId<string>(), storefrontId, ...tier })),
    );
  }

  return { storefrontId, slug };
}

/**
 * Attaches a Pine revision to a strategy version, which is what a release
 * ultimately delivers. Source is deliberately recognisable so a test can assert
 * the customer received exactly this text.
 */
export async function seedPineRevision(
  db: Database,
  strategyVersionId: string,
  options: { source?: string; sourceHash?: string } = {},
): Promise<{ pineRevisionId: string; source: string; sourceHash: string }> {
  const pineRevisionId = generateId<string>();
  const source = options.source ?? `//@version=6\nstrategy("Fixture ${strategyVersionId.slice(0, 8)}")`;
  const sourceHash = options.sourceHash ?? `hash-${strategyVersionId.slice(0, 12)}`;

  await db.insert(pineRevisions).values({
    id: pineRevisionId,
    strategyVersionId,
    source,
    sourceHash,
    manifest: {},
    manifestHash: `manifest-${strategyVersionId.slice(0, 12)}`,
    compileStatus: "SUCCEEDED",
  });

  return { pineRevisionId, source, sourceHash };
}
