"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { Alert, Card, CardBody, CardHead } from "../../../components/primitives";
import { createCampaignAction, type CreateCampaignActionState } from "./actions";

const initialState: CreateCampaignActionState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Creating…" : "Create campaign"}
    </button>
  );
}

export default function NewCampaignPage() {
  const [state, formAction] = useFormState(createCampaignAction, initialState);

  return (
    <>
      <Link href="/" className="breadcrumb">
        ← Command Centre
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <h1>New campaign</h1>
          <p className="page-subtitle">
            Define the objective and the markets research under it may touch.
          </p>
        </div>
      </div>

      <Card>
        <CardHead title="Campaign brief" />
        <CardBody>
          <form action={formAction}>
            {state.error && <Alert tone="error">{state.error}</Alert>}

            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" required maxLength={255} placeholder="BTC trend following" />
            </div>

            <div className="field">
              <label htmlFor="brief">Brief</label>
              <textarea
                id="brief"
                name="brief"
                required
                placeholder="What is being investigated, and what would count as a result?"
              />
              <span className="field-hint">
                State the hypothesis in terms that could be falsified, not just explored.
              </span>
            </div>

            <div className="field">
              <label htmlFor="allowedMarkets">Allowed markets</label>
              <input id="allowedMarkets" name="allowedMarkets" placeholder="crypto, forex" required />
              <span className="field-hint">Comma-separated. Constrains where strategies may be tested.</span>
            </div>

            <div className="row">
              <SubmitButton />
              <Link href="/" className="btn">
                Cancel
              </Link>
            </div>
          </form>
        </CardBody>
      </Card>
    </>
  );
}
