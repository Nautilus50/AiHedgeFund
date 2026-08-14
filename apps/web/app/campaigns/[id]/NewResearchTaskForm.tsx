"use client";

import { useFormState, useFormStatus } from "react-dom";
import { AGENT_RUNTIME_REGISTRY } from "@arf-os/agent-runtime";
import { Alert } from "../../../components/primitives";
import { createResearchTaskAction, type CreateResearchTaskActionState } from "./actions";

const initialState: CreateResearchTaskActionState = {};

// Same source of truth the API validates against (AGENT_RUNTIME_REGISTRY) —
// a role with no worker implementation is never offered here.
const REGISTERED_ROLES = Object.keys(AGENT_RUNTIME_REGISTRY);

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Creating…" : "New research task"}
    </button>
  );
}

export function NewResearchTaskForm({ campaignId }: { campaignId: string }) {
  const boundAction = createResearchTaskAction.bind(null, campaignId);
  const [state, formAction] = useFormState(boundAction, initialState);

  return (
    <form action={formAction}>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      {state.success && <Alert tone="ok">Research task queued.</Alert>}
      <div className="field">
        <label htmlFor="research-task-role">Role</label>
        <select id="research-task-role" name="role" required defaultValue={REGISTERED_ROLES[0]}>
          {REGISTERED_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="research-task-objective">Objective</label>
        <input
          id="research-task-objective"
          name="objective"
          required
          placeholder="Propose one falsifiable idea for BTC perpetuals."
        />
      </div>
      <SubmitButton />
    </form>
  );
}
