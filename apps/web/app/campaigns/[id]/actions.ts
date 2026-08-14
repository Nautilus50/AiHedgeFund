"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiFetch } from "../../../lib/api";

export interface CreateStrategyActionState {
  error?: string;
}

export async function createStrategyAction(
  campaignId: string,
  _prevState: CreateStrategyActionState,
  formData: FormData,
): Promise<CreateStrategyActionState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { error: "Name is required." };
  }

  let result: { strategyVersionId: string };
  try {
    result = await apiFetch<{ strategyVersionId: string }>("/v1/strategies", {
      method: "POST",
      body: JSON.stringify({ campaignId, name }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to create strategy." };
  }

  redirect(`/strategy-versions/${result.strategyVersionId}`);
}

export interface CreateResearchTaskActionState {
  error?: string;
  success?: boolean;
}

export async function createResearchTaskAction(
  campaignId: string,
  _prevState: CreateResearchTaskActionState,
  formData: FormData,
): Promise<CreateResearchTaskActionState> {
  const role = String(formData.get("role") ?? "").trim();
  const objective = String(formData.get("objective") ?? "").trim();
  if (!role) return { error: "Role is required." };
  if (!objective) return { error: "Objective is required." };

  try {
    await apiFetch<{ researchTaskId: string }>(`/v1/campaigns/${campaignId}/research-tasks`, {
      method: "POST",
      body: JSON.stringify({ role, objective }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to create research task." };
  }

  revalidatePath(`/campaigns/${campaignId}`);
  return { success: true };
}
