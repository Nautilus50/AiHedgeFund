"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch, apiFetchSafe, ApiError } from "../../../../../lib/api";

export interface LaunchBacktestRunActionState {
  error?: string;
}

interface DatasetVersionOption {
  id: string;
  symbol: string;
  timeframe: string;
}

interface DatasetVersionPage {
  items: DatasetVersionOption[];
}

/** `datetime-local` inputs carry no timezone; the form labels them UTC and this appends the zone explicitly rather than trusting `new Date(local)`, which would read the server's own timezone (CLAUDE.md 7.3). */
function toUtcIso(datetimeLocalValue: string): string {
  return `${datetimeLocalValue}:00.000Z`;
}

export async function launchBacktestRunAction(
  _prevState: LaunchBacktestRunActionState,
  formData: FormData,
): Promise<LaunchBacktestRunActionState> {
  const strategyVersionId = String(formData.get("strategyVersionId") ?? "");
  const sourceHash = String(formData.get("sourceHash") ?? "");
  const datasetVersionId = String(formData.get("datasetVersionId") ?? "");
  const segmentKind = String(formData.get("segmentKind") ?? "");
  const fromLocal = String(formData.get("fromTs") ?? "");
  const toLocal = String(formData.get("toTs") ?? "");
  const initialCapital = String(formData.get("initialCapital") ?? "").trim();
  const commissionType = String(formData.get("commissionType") ?? "");
  const commissionValue = Number(formData.get("commissionValue"));
  const slippageTicks = Number(formData.get("slippageTicks"));
  const runnerVersion = String(formData.get("runnerVersion") ?? "").trim();

  if (!strategyVersionId || !sourceHash) return { error: "Missing strategy version identity." };
  if (!datasetVersionId) return { error: "Choose a dataset." };
  if (!segmentKind) return { error: "Choose a segment kind." };
  if (!fromLocal || !toLocal) return { error: "From and to are required." };
  if (!/^\d+(\.\d+)?$/.test(initialCapital)) return { error: "Initial capital must be a positive decimal." };
  if (!Number.isFinite(commissionValue) || commissionValue < 0) {
    return { error: "Commission value must be a non-negative number." };
  }
  if (!Number.isInteger(slippageTicks) || slippageTicks < 0) {
    return { error: "Slippage ticks must be a non-negative integer." };
  }
  if (!runnerVersion) return { error: "Runner version is required." };

  // Symbol/timeframe are derived from the dataset server-side rather than
  // trusted from the form — the client only ever sends the id, so a run's
  // recorded market identity can't drift from what it actually ran against.
  const datasetsResult = await apiFetchSafe<DatasetVersionPage>(`/v1/dataset-versions?limit=100`);
  if ("error" in datasetsResult) {
    return { error: `Could not verify the chosen dataset: ${datasetsResult.error.message}` };
  }
  const dataset = datasetsResult.data.items.find((d) => d.id === datasetVersionId);
  if (!dataset) return { error: "That dataset is no longer available. Refresh and try again." };

  const fromTs = toUtcIso(fromLocal);
  const toTs = toUtcIso(toLocal);
  if (new Date(fromTs) >= new Date(toTs)) return { error: "From must be before to." };

  let backtestRunId: string;
  try {
    const created = await apiFetch<{ backtestRunId: string }>("/v1/backtest-runs", {
      method: "POST",
      body: JSON.stringify({
        strategyVersionId,
        runnerType: "LOCAL_RUNNER",
        runnerVersion,
        datasetVersionId,
        symbol: dataset.symbol,
        timeframe: dataset.timeframe,
        segmentKind,
        fromTs,
        toTs,
        costModel: { commissionType, commissionValue, slippageTicks },
        initialCapital,
        sourceHash,
      }),
      idempotencyKey: randomUUID(),
    });
    backtestRunId = created.backtestRunId;
  } catch (error) {
    const detail =
      error instanceof ApiError ? (error.problem?.detail ?? error.message) : "Failed to launch backtest run.";
    return { error: detail };
  }

  redirect(`/backtest-runs/${backtestRunId}`);
}
