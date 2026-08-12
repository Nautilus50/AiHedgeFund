"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Alert } from "../../../components/primitives";
import { importStrategyAction, type ImportStrategyActionState } from "./actions";

const initialState: ImportStrategyActionState = {};

interface CampaignOption {
  id: string;
  name: string;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Importing…" : "Import strategy"}
    </button>
  );
}

export function ImportStrategyForm({
  campaigns,
  defaultName,
  defaultSymbol,
  defaultTimeframe,
  defaultOrigin,
}: {
  campaigns: CampaignOption[];
  defaultName: string;
  defaultSymbol: string;
  defaultTimeframe: string;
  defaultOrigin: string;
}) {
  const [state, formAction] = useFormState(importStrategyAction, initialState);

  return (
    <form action={formAction}>
      {state.error && <Alert tone="error">{state.error}</Alert>}

      <div className="field">
        <label htmlFor="campaignId">Campaign</label>
        <select id="campaignId" name="campaignId" required defaultValue="">
          <option value="" disabled>
            Choose a campaign…
          </option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {campaigns.length === 0 && (
          <span className="field-hint">No campaigns yet — create one first from the Command Centre.</span>
        )}
      </div>

      <div className="field">
        <label htmlFor="name">Strategy name</label>
        <input id="name" name="name" required maxLength={255} defaultValue={defaultName} placeholder="Donchian Breakout Baseline" />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="symbol">Symbol</label>
          <input id="symbol" name="symbol" defaultValue={defaultSymbol} placeholder="BTCUSDT" />
        </div>
        <div className="field">
          <label htmlFor="timeframe">Timeframe</label>
          <input id="timeframe" name="timeframe" defaultValue={defaultTimeframe} placeholder="240" />
        </div>
      </div>
      <span className="field-hint">Recorded in the Pine revision's manifest, not validated against a live dataset yet.</span>

      <div className="field">
        <label htmlFor="origin">Origin (optional)</label>
        <input id="origin" name="origin" defaultValue={defaultOrigin} placeholder="trader-dev strategy 01K…" />
        <span className="field-hint">Free-text provenance note — where this Pine source actually came from.</span>
      </div>

      <div className="field">
        <label htmlFor="source">Pine Script v6 source</label>
        <textarea
          id="source"
          name="source"
          rows={16}
          required
          placeholder="//@version=6&#10;strategy(…)"
          className="mono"
        />
        <span className="field-hint">
          Paste it in — this page has no live connection to any external source; nothing is fetched on your behalf.
        </span>
      </div>

      <SubmitButton />
    </form>
  );
}
