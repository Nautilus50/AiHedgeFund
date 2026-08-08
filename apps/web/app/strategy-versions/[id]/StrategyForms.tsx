"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  recordDecisionAction,
  requestVerificationAction,
  saveDefinitionAction,
  savePineAction,
  type ActionState,
} from "./actions";

const initialState: ActionState = {};

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

function FormFeedback({ state }: { state: ActionState }) {
  if (state.error) return <p role="alert">{state.error}</p>;
  if (state.success) return <p>{state.success}</p>;
  return null;
}

export function SaveDefinitionForm({ strategyVersionId }: { strategyVersionId: string }) {
  const [state, formAction] = useFormState(saveDefinitionAction.bind(null, strategyVersionId), initialState);
  return (
    <form action={formAction}>
      <h3>Strategy Definition (SDL)</h3>
      <textarea name="definition" rows={10} cols={80} placeholder="Paste SDL JSON here" required />
      <FormFeedback state={state} />
      <SubmitButton label="Save definition" pendingLabel="Saving…" />
    </form>
  );
}

export function SavePineForm({ strategyVersionId }: { strategyVersionId: string }) {
  const [state, formAction] = useFormState(savePineAction.bind(null, strategyVersionId), initialState);
  return (
    <form action={formAction}>
      <h3>Pine Script Revision</h3>
      <textarea name="source" rows={10} cols={80} placeholder="//@version=6..." required />
      <textarea name="manifest" rows={4} cols={80} placeholder='{"sourceHashAlgorithm":"sha256"}' />
      <FormFeedback state={state} />
      <SubmitButton label="Save Pine revision" pendingLabel="Saving…" />
    </form>
  );
}

export function RequestVerificationForm({ strategyVersionId }: { strategyVersionId: string }) {
  const [state, formAction] = useFormState(requestVerificationAction.bind(null, strategyVersionId), initialState);
  return (
    <form action={formAction}>
      <h3>Request TradingView Verification</h3>
      <label htmlFor="requiredSymbol">Symbol</label>
      <input id="requiredSymbol" name="requiredSymbol" placeholder="BYBIT:BTCUSDT.P" required />
      <label htmlFor="requiredTimeframe">Timeframe</label>
      <input id="requiredTimeframe" name="requiredTimeframe" placeholder="60" required />
      <FormFeedback state={state} />
      <SubmitButton label="Create verification" pendingLabel="Creating…" />
    </form>
  );
}

export function DecisionForm({ strategyVersionId }: { strategyVersionId: string }) {
  const [state, formAction] = useFormState(recordDecisionAction.bind(null, strategyVersionId), initialState);
  return (
    <form action={formAction}>
      <h3>Committee Decision</h3>
      <label htmlFor="decision">Decision</label>
      <select id="decision" name="decision" required defaultValue="">
        <option value="" disabled>
          Choose…
        </option>
        <option value="REJECT">REJECT</option>
        <option value="REWORK_WITH_NEW_VERSION">REWORK_WITH_NEW_VERSION</option>
        <option value="PAPER_APPROVED">PAPER_APPROVED</option>
      </select>
      <label htmlFor="reasonCodes">Reason codes (comma-separated)</label>
      <input id="reasonCodes" name="reasonCodes" required />
      <label htmlFor="evidenceIds">Evidence ids (comma-separated UUIDs)</label>
      <input id="evidenceIds" name="evidenceIds" required />
      <label htmlFor="rejectionCase">Strongest rejection case</label>
      <textarea id="rejectionCase" name="rejectionCase" rows={3} cols={80} required />
      <label htmlFor="positiveCase">Strongest positive case</label>
      <textarea id="positiveCase" name="positiveCase" rows={3} cols={80} required />
      <FormFeedback state={state} />
      <SubmitButton label="Record decision" pendingLabel="Recording…" />
    </form>
  );
}
