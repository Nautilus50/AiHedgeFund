"use server";

import { randomUUID } from "node:crypto";
import { apiFetch, ApiError } from "../../../../../lib/api";

export interface LaunchForwardDeploymentActionState {
  error?: string;
  success?: { deploymentId: string; token: string };
}

export async function launchForwardDeploymentAction(
  _prevState: LaunchForwardDeploymentActionState,
  formData: FormData,
): Promise<LaunchForwardDeploymentActionState> {
  const strategyVersionId = String(formData.get("strategyVersionId") ?? "");
  const symbol = String(formData.get("symbol") ?? "").trim();
  const timeframe = String(formData.get("timeframe") ?? "").trim();
  const initialCapital = Number(formData.get("initialCapital"));
  const timestampToleranceSeconds = Number(formData.get("timestampToleranceSeconds"));
  const fillModelVersion = String(formData.get("fillModelVersion") ?? "").trim();
  const latencySeconds = Number(formData.get("latencySeconds"));
  const slippageType = String(formData.get("slippageType") ?? "");
  const slippageValue = Number(formData.get("slippageValue"));
  const commissionType = String(formData.get("commissionType") ?? "");
  const commissionValue = Number(formData.get("commissionValue"));
  const quantityModelType = String(formData.get("quantityModelType") ?? "");
  const quantityValue = Number(formData.get("quantityValue"));
  const thresholdRaw = String(formData.get("maxDrawdownPctAlertThreshold") ?? "").trim();

  if (!strategyVersionId) return { error: "Missing strategy version identity." };
  if (!symbol) return { error: "Symbol is required." };
  if (!timeframe) return { error: "Timeframe is required." };
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) return { error: "Initial capital must be positive." };
  if (!Number.isInteger(timestampToleranceSeconds) || timestampToleranceSeconds <= 0) {
    return { error: "Timestamp tolerance must be a positive integer number of seconds." };
  }
  if (!fillModelVersion) return { error: "Fill model version is required." };
  if (!Number.isFinite(latencySeconds) || latencySeconds < 0) return { error: "Latency must be non-negative." };
  if (!Number.isFinite(slippageValue) || slippageValue < 0) return { error: "Slippage value must be non-negative." };
  if (!Number.isFinite(commissionValue) || commissionValue < 0) return { error: "Commission value must be non-negative." };
  if (!Number.isFinite(quantityValue) || quantityValue <= 0) return { error: "Quantity value must be positive." };

  let maxDrawdownPctAlertThreshold: number | undefined;
  if (thresholdRaw) {
    maxDrawdownPctAlertThreshold = Number(thresholdRaw);
    if (!Number.isFinite(maxDrawdownPctAlertThreshold) || maxDrawdownPctAlertThreshold <= 0 || maxDrawdownPctAlertThreshold > 100) {
      return { error: "Drawdown alert threshold must be a percent between 0 and 100." };
    }
  }

  const quantityModel =
    quantityModelType === "percent_of_equity"
      ? { type: "percent_of_equity" as const, percent: quantityValue }
      : quantityModelType === "fixed"
        ? { type: "fixed" as const, quantity: quantityValue }
        : quantityModelType === "cash"
          ? { type: "cash" as const, cashAmount: quantityValue }
          : undefined;
  if (!quantityModel) return { error: "Choose a quantity model." };

  let result: { deploymentId: string; token: string };
  try {
    result = await apiFetch<{ deploymentId: string; token: string }>("/v1/forward-deployments", {
      method: "POST",
      body: JSON.stringify({
        strategyVersionId,
        symbol,
        timeframe,
        initialCapital,
        timestampToleranceSeconds,
        maxDrawdownPctAlertThreshold,
        fillModel: {
          fillModelVersion,
          latencyModel: { type: "fixed_seconds", seconds: latencySeconds },
          slippageModel: { type: slippageType, value: slippageValue },
          commissionModel: { type: commissionType, value: commissionValue },
          quantityModel,
          stopTargetRule: { type: "external_alert_only" },
        },
      }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    const detail = error instanceof ApiError ? (error.problem?.detail ?? error.message) : "Failed to create forward deployment.";
    return { error: detail };
  }

  return { success: result };
}
