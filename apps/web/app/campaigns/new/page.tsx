"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createCampaignAction, type CreateCampaignActionState } from "./actions";

const initialState: CreateCampaignActionState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create campaign"}
    </button>
  );
}

export default function NewCampaignPage() {
  const [state, formAction] = useFormState(createCampaignAction, initialState);

  return (
    <main>
      <h1>New research campaign</h1>
      <form action={formAction}>
        <div>
          <label htmlFor="name">Name</label>
          <input id="name" name="name" required maxLength={255} />
        </div>
        <div>
          <label htmlFor="brief">Brief</label>
          <textarea id="brief" name="brief" required />
        </div>
        <div>
          <label htmlFor="allowedMarkets">Allowed markets (comma-separated)</label>
          <input id="allowedMarkets" name="allowedMarkets" placeholder="crypto, forex" required />
        </div>
        {state.error && <p role="alert">{state.error}</p>}
        <SubmitButton />
      </form>
    </main>
  );
}
