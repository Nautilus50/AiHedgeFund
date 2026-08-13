import { generateId } from "@arf-os/contracts";
import type { Database } from "./client.js";
import { campaigns, memberships, organisations, strategies, strategyVersions, users } from "./schema/index.js";

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
