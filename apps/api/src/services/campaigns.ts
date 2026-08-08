import { and, eq, gt, or } from "drizzle-orm";
import { z } from "zod";
import { generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { campaigns } from "@arf-os/db";
import { buildPage, clampPageSize, decodeCursor, type Page } from "../lib/pagination.js";

export const CreateCampaignInput = z.object({
  name: z.string().min(1).max(255),
  brief: z.string().min(1),
  allowedMarkets: z.array(z.string().min(1)).min(1),
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignInput>;

export interface CampaignSummary {
  id: string;
  organisationId: string;
  name: string;
  brief: string;
  allowedMarkets: unknown;
  status: string;
  createdByUserId: string;
  createdAt: Date;
}

export async function createCampaign(
  db: Database,
  organisationId: string,
  createdByUserId: string,
  input: CreateCampaignInput,
): Promise<CampaignSummary> {
  const id = generateId<string>();

  const [row] = await db
    .insert(campaigns)
    .values({
      id,
      organisationId,
      name: input.name,
      brief: input.brief,
      allowedMarkets: input.allowedMarkets,
      createdByUserId,
    })
    .returning();

  if (!row) {
    throw new Error("Insert into campaigns returned no row.");
  }
  return row;
}

export async function getCampaign(
  db: Database,
  organisationId: string,
  campaignId: string,
): Promise<CampaignSummary | undefined> {
  const [row] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.organisationId, organisationId)))
    .limit(1);
  return row;
}

export interface ListCampaignsInput {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export type ListCampaignsResult = { ok: true; page: Page<CampaignSummary> } | { ok: false; reasonCode: "INVALID_CURSOR" };

/** Organisation-scoped, cursor-paginated (CLAUDE.md 19.1 / spec 14.11). */
export async function listCampaigns(
  db: Database,
  organisationId: string,
  input: ListCampaignsInput,
): Promise<ListCampaignsResult> {
  const limit = clampPageSize(input.limit);

  let cursorClause;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded.ok) {
      return { ok: false, reasonCode: "INVALID_CURSOR" };
    }
    const { createdAtIso, id } = decoded.cursor;
    const createdAtDate = new Date(createdAtIso);
    cursorClause = or(
      gt(campaigns.createdAt, createdAtDate),
      and(eq(campaigns.createdAt, createdAtDate), gt(campaigns.id, id)),
    );
  }

  const rows = await db
    .select()
    .from(campaigns)
    .where(cursorClause ? and(eq(campaigns.organisationId, organisationId), cursorClause) : eq(campaigns.organisationId, organisationId))
    .orderBy(campaigns.createdAt, campaigns.id)
    .limit(limit + 1);

  return { ok: true, page: buildPage(rows, limit) };
}
