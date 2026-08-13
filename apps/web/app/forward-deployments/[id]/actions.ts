"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { apiFetch, ApiError } from "../../../lib/api";

export interface TransitionActionState {
  error?: string;
}

async function transition(deploymentId: string, path: "pause" | "resume" | "complete"): Promise<TransitionActionState> {
  try {
    await apiFetch(`/v1/forward-deployments/${deploymentId}/${path}`, {
      method: "POST",
      body: JSON.stringify({}),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    const detail = error instanceof ApiError ? (error.problem?.detail ?? error.message) : `Failed to ${path} deployment.`;
    return { error: detail };
  }

  revalidatePath(`/forward-deployments/${deploymentId}`);
  return {};
}

export async function pauseDeploymentAction(
  deploymentId: string,
  _prevState: TransitionActionState,
): Promise<TransitionActionState> {
  return transition(deploymentId, "pause");
}

export async function resumeDeploymentAction(
  deploymentId: string,
  _prevState: TransitionActionState,
): Promise<TransitionActionState> {
  return transition(deploymentId, "resume");
}

export async function completeDeploymentAction(
  deploymentId: string,
  _prevState: TransitionActionState,
): Promise<TransitionActionState> {
  return transition(deploymentId, "complete");
}
