"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Alert } from "../../../components/primitives";
import { createStrategyAction, type CreateStrategyActionState } from "./actions";

const initialState: CreateStrategyActionState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Creating…" : "Create strategy"}
    </button>
  );
}

export function NewStrategyForm({ campaignId }: { campaignId: string }) {
  const boundAction = createStrategyAction.bind(null, campaignId);
  const [state, formAction] = useFormState(boundAction, initialState);

  return (
    <form action={formAction}>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <div className="field">
        <label htmlFor="strategy-name">Strategy name</label>
        <input id="strategy-name" name="name" required maxLength={255} placeholder="RSI mean reversion" />
      </div>
      <SubmitButton />
    </form>
  );
}
