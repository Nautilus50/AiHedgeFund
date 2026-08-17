"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Alert } from "../../../components/primitives";
import { reviewPracticeRunAction, type ReviewPracticeRunActionState } from "./actions";

const initialState: ReviewPracticeRunActionState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-secondary" disabled={pending}>
      {pending ? "Submitting…" : "Submit review"}
    </button>
  );
}

export function ReviewPracticeRunForm({ benchmarkTaskId, practiceRunId }: { benchmarkTaskId: string; practiceRunId: string }) {
  const boundAction = reviewPracticeRunAction.bind(null, benchmarkTaskId, practiceRunId);
  const [state, formAction] = useFormState(boundAction, initialState);

  return (
    <form action={formAction} className="inline-form">
      {state.error && <Alert tone="error">{state.error}</Alert>}
      {state.success && <Alert tone="ok">Review recorded.</Alert>}
      <label>
        Score (0–1)
        <input name="score" type="number" min="0" max="1" step="0.05" required />
      </label>
      <label>
        Notes
        <input name="notes" type="text" placeholder="Optional reviewer notes" />
      </label>
      <SubmitButton />
    </form>
  );
}
