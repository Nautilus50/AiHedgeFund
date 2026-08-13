"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Alert } from "../../../components/primitives";
import { completeDeploymentAction, pauseDeploymentAction, resumeDeploymentAction, type TransitionActionState } from "./actions";

const initialState: TransitionActionState = {};

function TransitionButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

export function DeploymentActions({ deploymentId, state }: { deploymentId: string; state: string }) {
  const pauseAction = pauseDeploymentAction.bind(null, deploymentId);
  const resumeAction = resumeDeploymentAction.bind(null, deploymentId);
  const completeAction = completeDeploymentAction.bind(null, deploymentId);

  const [pauseState, pauseFormAction] = useFormState(pauseAction, initialState);
  const [resumeState, resumeFormAction] = useFormState(resumeAction, initialState);
  const [completeState, completeFormAction] = useFormState(completeAction, initialState);

  if (state !== "ACTIVE" && state !== "PAUSED") return null;

  return (
    <div className="row">
      {state === "ACTIVE" && (
        <form action={pauseFormAction}>
          <TransitionButton label="Pause" pendingLabel="Pausing…" />
        </form>
      )}
      {state === "PAUSED" && (
        <form action={resumeFormAction}>
          <TransitionButton label="Resume" pendingLabel="Resuming…" />
        </form>
      )}
      <form action={completeFormAction}>
        <TransitionButton label="Complete" pendingLabel="Completing…" />
      </form>
      {(pauseState.error ?? resumeState.error ?? completeState.error) && (
        <Alert tone="error">{pauseState.error ?? resumeState.error ?? completeState.error}</Alert>
      )}
    </div>
  );
}
