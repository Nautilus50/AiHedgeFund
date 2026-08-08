"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch } from "../../../lib/api";

export interface ActionState {
  error?: string;
  success?: string;
}

export async function saveDefinitionAction(
  strategyVersionId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = String(formData.get("definition") ?? "");
  let definition: unknown;
  try {
    definition = JSON.parse(raw);
  } catch {
    return { error: "Definition must be valid JSON." };
  }

  try {
    await apiFetch(`/v1/strategy-versions/${strategyVersionId}/definition`, {
      method: "PUT",
      body: JSON.stringify(definition),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to save definition." };
  }

  return { success: "Strategy definition saved." };
}

export async function savePineAction(
  strategyVersionId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const source = String(formData.get("source") ?? "");
  const manifestRaw = String(formData.get("manifest") ?? "{}");

  if (!source.trim()) {
    return { error: "Pine source is required." };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    return { error: "Manifest must be valid JSON." };
  }

  try {
    await apiFetch(`/v1/strategy-versions/${strategyVersionId}/pine`, {
      method: "PUT",
      body: JSON.stringify({ source, manifest }),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to save Pine revision." };
  }

  return { success: "Pine revision saved." };
}

export async function requestVerificationAction(
  strategyVersionId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const requiredSymbol = String(formData.get("requiredSymbol") ?? "").trim();
  const requiredTimeframe = String(formData.get("requiredTimeframe") ?? "").trim();

  if (!requiredSymbol || !requiredTimeframe) {
    return { error: "Symbol and timeframe are required." };
  }

  let result: { verificationId: string };
  try {
    result = await apiFetch<{ verificationId: string }>("/v1/verifications", {
      method: "POST",
      body: JSON.stringify({ strategyVersionId, requiredSymbol, requiredTimeframe }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to create verification." };
  }

  redirect(`/verifications/${result.verificationId}`);
}

export async function recordDecisionAction(
  strategyVersionId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const decision = String(formData.get("decision") ?? "");
  const rejectionCase = String(formData.get("rejectionCase") ?? "").trim();
  const positiveCase = String(formData.get("positiveCase") ?? "").trim();
  const reasonCodes = String(formData.get("reasonCodes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const evidenceIds = String(formData.get("evidenceIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!["REJECT", "REWORK_WITH_NEW_VERSION", "PAPER_APPROVED"].includes(decision)) {
    return { error: "Choose a decision." };
  }
  if (reasonCodes.length === 0 || evidenceIds.length === 0 || !rejectionCase || !positiveCase) {
    return { error: "Reason codes, evidence ids, rejection case, and positive case are all required." };
  }

  try {
    await apiFetch(`/v1/strategy-versions/${strategyVersionId}/decisions`, {
      method: "POST",
      body: JSON.stringify({ decision, reasonCodes, evidenceIds, rejectionCase, positiveCase }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to record decision." };
  }

  return { success: `Decision recorded: ${decision}.` };
}
