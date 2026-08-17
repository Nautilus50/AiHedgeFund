"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { apiFetch } from "../../../lib/api";

export interface RunPracticeTaskActionState {
  error?: string;
  success?: boolean;
}

export async function runPracticeTaskAction(
  benchmarkTaskId: string,
  _prevState: RunPracticeTaskActionState,
  formData: FormData,
): Promise<RunPracticeTaskActionState> {
  const promptId = String(formData.get("promptId") ?? "").trim();
  if (!promptId) return { error: "Choose a prompt to run against." };

  try {
    await apiFetch<{ practiceRunId: string }>(`/v1/benchmark-tasks/${benchmarkTaskId}/practice-runs`, {
      method: "POST",
      body: JSON.stringify({ promptId }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to start practice run." };
  }

  revalidatePath(`/practice-arena/${benchmarkTaskId}`);
  return { success: true };
}

export interface ReviewPracticeRunActionState {
  error?: string;
  success?: boolean;
}

export async function reviewPracticeRunAction(
  benchmarkTaskId: string,
  practiceRunId: string,
  _prevState: ReviewPracticeRunActionState,
  formData: FormData,
): Promise<ReviewPracticeRunActionState> {
  const scoreRaw = String(formData.get("score") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  const score = Number(scoreRaw);
  if (!scoreRaw || Number.isNaN(score) || score < 0 || score > 1) {
    return { error: "Score must be a number between 0 and 1." };
  }

  try {
    await apiFetch<{ reviewed: boolean }>(`/v1/practice-runs/${practiceRunId}/review`, {
      method: "POST",
      body: JSON.stringify({ score, notes: notes || undefined }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to submit review." };
  }

  revalidatePath(`/practice-arena/${benchmarkTaskId}`);
  return { success: true };
}
