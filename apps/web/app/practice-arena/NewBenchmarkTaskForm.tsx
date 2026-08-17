"use client";

import { useFormState, useFormStatus } from "react-dom";
import { AGENT_RUNTIME_REGISTRY } from "@arf-os/agent-runtime";
import { Alert } from "../../components/primitives";
import { createBenchmarkTaskAction, type CreateBenchmarkTaskActionState } from "./actions";

const initialState: CreateBenchmarkTaskActionState = {};

// Same source of truth the API validates against — a role with no worker
// implementation is never offered here.
const REGISTERED_ROLES = Object.keys(AGENT_RUNTIME_REGISTRY);

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Creating…" : "New benchmark task"}
    </button>
  );
}

export function NewBenchmarkTaskForm() {
  const [state, formAction] = useFormState(createBenchmarkTaskAction, initialState);

  return (
    <form action={formAction}>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      {state.success && <Alert tone="ok">Benchmark task created.</Alert>}
      <div className="field">
        <label htmlFor="benchmark-task-role">Role</label>
        <select id="benchmark-task-role" name="role" required defaultValue={REGISTERED_ROLES[0]}>
          {REGISTERED_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="benchmark-task-objective">Objective</label>
        <input
          id="benchmark-task-objective"
          name="objective"
          required
          placeholder="Propose one falsifiable idea for BTC perpetuals."
        />
      </div>
      <div className="field">
        <label htmlFor="benchmark-task-visibility">Visibility</label>
        <select id="benchmark-task-visibility" name="visibility" defaultValue="VISIBLE">
          <option value="VISIBLE">Visible to the whole organisation</option>
          <option value="HIDDEN">Hidden — only I can see it</option>
        </select>
      </div>
      <SubmitButton />
    </form>
  );
}
