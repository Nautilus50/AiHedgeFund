"use server";

import { randomUUID } from "node:crypto";
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
