"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "../../../lib/api";

export interface ImportStrategyActionState {
  error?: string;
}

/**
 * Files an externally-sourced Pine strategy (e.g. forked from trader-dev)
 * into ARF-OS as a real, immutable Strategy + StrategyVersion + Pine
 * revision — the same two existing commands `NewStrategyForm` and
 * `SavePineForm` already use, just chained into one step. No new backend
 * endpoint: import is "create a strategy, then save its Pine source."
 */
export async function importStrategyAction(
  _prevState: ImportStrategyActionState,
  formData: FormData,
): Promise<ImportStrategyActionState> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const symbol = String(formData.get("symbol") ?? "").trim();
  const timeframe = String(formData.get("timeframe") ?? "").trim();
  const origin = String(formData.get("origin") ?? "").trim();
  const source = String(formData.get("source") ?? "");

  if (!campaignId) return { error: "Choose a campaign." };
  if (!name) return { error: "Strategy name is required." };
  if (!source.trim()) return { error: "Pine source is required." };

  let strategyVersionId: string;
  try {
    const created = await apiFetch<{ strategyVersionId: string }>("/v1/strategies", {
      method: "POST",
      body: JSON.stringify({ campaignId, name }),
      idempotencyKey: randomUUID(),
    });
    strategyVersionId = created.strategyVersionId;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to create strategy." };
  }

  const manifest: Record<string, string> = {};
  if (symbol) manifest.symbol = symbol;
  if (timeframe) manifest.timeframe = timeframe;
  if (origin) manifest.origin = origin;

  try {
    await apiFetch(`/v1/strategy-versions/${strategyVersionId}/pine`, {
      method: "PUT",
      body: JSON.stringify({ source, manifest }),
    });
  } catch (error) {
    // The strategy now exists without a Pine revision — not silently lost,
    // just short of one step. Point at the real version rather than fail
    // opaquely, since the researcher can retry the Pine save from there.
    const detail = error instanceof ApiError ? error.problem?.detail ?? error.message : "Failed to save Pine revision.";
    return { error: `Strategy created (v1), but saving the Pine source failed: ${detail} Open /strategy-versions/${strategyVersionId} to retry.` };
  }

  redirect(`/strategy-versions/${strategyVersionId}`);
}
