"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createStrategyAction, type CreateStrategyActionState } from "./actions";

const initialState: CreateStrategyActionState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create strategy"}
    </button>
  );
}

export function NewStrategyForm({ campaignId }: { campaignId: string }) {
  const boundAction = createStrategyAction.bind(null, campaignId);
  const [state, formAction] = useFormState(boundAction, initialState);

  return (
    <form action={formAction}>
      <label htmlFor="strategy-name">New strategy name</label>
      <input id="strategy-name" name="name" required maxLength={255} />
      {state.error && <p role="alert">{state.error}</p>}
      <SubmitButton />
    </form>
  );
}
