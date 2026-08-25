"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Alert } from "../../../components/primitives";
import { publishAlgoAction, retireAlgoAction, type ActionState } from "./actions";

const initialState: ActionState = {};

function SubmitButton({ label, pendingLabel, variant }: { label: string; pendingLabel: string; variant: "primary" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={variant === "primary" ? "btn btn-primary" : "btn btn-danger"} disabled={pending}>
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
