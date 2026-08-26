"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Alert } from "../../../components/primitives";
import { publishAlgoAction, refreshForwardEvidenceAction, retireAlgoAction, type ActionState } from "./actions";

const initialState: ActionState = {};

const VARIANT_CLASS = { primary: "btn btn-primary", danger: "btn btn-danger", quiet: "btn" } as const;

function SubmitButton({
  label,
  pendingLabel,
  variant,
}: {
  label: string;
  pendingLabel: string;
  variant: keyof typeof VARIANT_CLASS;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={VARIANT_CLASS[variant]} disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * Publish/retire, the two lifecycle transitions the API exposes beyond
 * cataloguing a release (CLAUDE.md 17.1 — thin client, the actual gates live
 * in publishAlgo/retireAlgo). Which button shows is decided by the server
 * component from the algo's current status; this only submits the command
 * and surfaces the API's own rejection reason when one comes back.
 */
export function PublishAlgoButton({ algoId, slug }: { algoId: string; slug: string }) {
  const [state, formAction] = useFormState(publishAlgoAction.bind(null, algoId, slug), initialState);
  return (
    <form action={formAction}>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <SubmitButton label="Publish to the library" pendingLabel="Publishing…" variant="primary" />
    </form>
  );
}

export function RetireAlgoButton({ algoId, slug }: { algoId: string; slug: string }) {
  const [state, formAction] = useFormState(retireAlgoAction.bind(null, algoId, slug), initialState);
  return (
    <form action={formAction}>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <SubmitButton label="Retire this algo" pendingLabel="Retiring…" variant="danger" />
    </form>
  );
}

/**
 * Shown next to the Evidence card only when the release already has a
 * FORWARD_PAPER snapshot — re-runs the same recomputation against the same
 * deployment's current fills, so the evidence tracks a still-running
 * deployment without another trip through the strategy-version page.
 */
export function RefreshForwardEvidenceButton({
  releaseId,
  forwardDeploymentId,
  slug,
}: {
  releaseId: string;
  forwardDeploymentId: string;
  slug: string;
}) {
  const [state, formAction] = useFormState(
    refreshForwardEvidenceAction.bind(null, releaseId, forwardDeploymentId, slug),
    initialState,
  );
  return (
    <form action={formAction}>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <SubmitButton label="Refresh forward evidence" pendingLabel="Refreshing…" variant="quiet" />
    </form>
  );
}
