"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { apiFetch } from "../../lib/api";

export interface CreateBenchmarkTaskActionState {
  error?: string;
  success?: boolean;
}

export async function createBenchmarkTaskAction(
  _prevState: CreateBenchmarkTaskActionState,
  formData: FormData,
): Promise<CreateBenchmarkTaskActionState> {
  const role = String(formData.get("role") ?? "").trim();
  const objective = String(formData.get("objective") ?? "").trim();
  const visibility = String(formData.get("visibility") ?? "VISIBLE").trim();
  if (!role) return { error: "Role is required." };
  if (!objective) return { error: "Objective is required." };

  try {
    await apiFetch<{ benchmarkTaskId: string }>("/v1/benchmark-tasks", {
      method: "POST",
      body: JSON.stringify({ role, objective, visibility }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to create benchmark task." };
  }

  revalidatePath("/practice-arena");
  return { success: true };
}
