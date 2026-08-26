"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, ApiError } from "../../../lib/api";

export interface ActionState {
  error?: string;
}

async function transition(algoId: string, slug: string, path: "publish" | "retire"): Promise<ActionState> {
  try {
    await apiFetch(`/v1/algos/${algoId}/${path}`, { method: "POST" });
  } catch (error) {
    const detail =
      error instanceof ApiError ? (error.problem?.detail ?? error.message) : `Failed to ${path} this algo.`;
    return { error: detail };
  }

  revalidatePath(`/algos/${slug}`);
  return {};
}

/** Requires a published release and at least one evidence snapshot — enforced by the API, not this action. */
export async function publishAlgoAction(algoId: string, slug: string, _prevState: ActionState): Promise<ActionState> {
  return transition(algoId, slug, "publish");
}

/** Hides the algo from the active library; its releases and evidence stay readable (ADR 0015). */
export async function retireAlgoAction(algoId: string, slug: string, _prevState: ActionState): Promise<ActionState> {
  return transition(algoId, slug, "retire");
}

/**
 * Re-recomputes the release's FORWARD_PAPER snapshot from the same deployment's
 * current fills. publishStatSnapshot upserts on (releaseId, scope, sourceId), so
 * this updates the existing snapshot in place rather than minting a duplicate —
 * the shortcut a deployment accumulating trades needs without a trip back
 * through the strategy-version page's catalogue form.
 */
export async function refreshForwardEvidenceAction(
  releaseId: string,
  forwardDeploymentId: string,
  slug: string,
  _prevState: ActionState,
): Promise<ActionState> {
  try {
    await apiFetch(`/v1/algo-releases/${releaseId}/stats`, {
      method: "POST",
      body: JSON.stringify({ kind: "FORWARD_DEPLOYMENT", forwardDeploymentId }),
    });
  } catch (error) {
    const detail =
      error instanceof ApiError ? (error.problem?.detail ?? error.message) : "Failed to refresh forward evidence.";
    return { error: detail };
  }

  revalidatePath(`/algos/${slug}`);
  return {};
}
