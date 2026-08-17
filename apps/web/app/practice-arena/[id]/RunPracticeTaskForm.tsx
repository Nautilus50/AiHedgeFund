"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Alert } from "../../../components/primitives";
import { runPracticeTaskAction, type RunPracticeTaskActionState } from "./actions";

const initialState: RunPracticeTaskActionState = {};

interface PromptOption {
  id: string;
  semanticVersion: string;
  status: string;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Starting…" : "Run against this prompt"}
    </button>
  );
}

export function RunPracticeTaskForm({ benchmarkTaskId, prompts }: { benchmarkTaskId: string; prompts: PromptOption[] }) {
  const boundAction = runPracticeTaskAction.bind(null, benchmarkTaskId);
  const [state, formAction] = useFormState(boundAction, initialState);

  if (prompts.length === 0) {
    return <Alert tone="warn">No prompt versions exist for this role yet.</Alert>;
  }

  return (
    <form action={formAction}>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      {state.success && <Alert tone="ok">Practice run queued.</Alert>}
      <div className="field">
        <label htmlFor="practice-run-prompt">Prompt version</label>
        <select id="practice-run-prompt" name="promptId" required defaultValue={prompts[0]?.id}>
          {prompts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.semanticVersion} ({p.status})
            </option>
          ))}
        </select>
      </div>
      <SubmitButton />
    </form>
  );
}
