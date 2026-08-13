"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import { Alert } from "../../../../../components/primitives";
import { launchForwardDeploymentAction, type LaunchForwardDeploymentActionState } from "./actions";

const initialState: LaunchForwardDeploymentActionState = {};

const SLIPPAGE_TYPES = ["fixed_percent", "fixed_ticks"] as const;
const COMMISSION_TYPES = ["percent", "fixed_per_trade"] as const;
const QUANTITY_MODEL_TYPES = ["percent_of_equity", "fixed", "cash"] as const;

const QUANTITY_VALUE_LABEL: Record<(typeof QUANTITY_MODEL_TYPES)[number], string> = {
  percent_of_equity: "Percent of equity",
  fixed: "Fixed quantity (units)",
  cash: "Cash amount",
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Creating…" : "Create deployment"}
    </button>
  );
}

function TokenReveal({ deploymentId, token }: { deploymentId: string; token: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <>
      <Alert tone="warn">
        This is the only time the webhook token is shown. Copy it into your TradingView alert&apos;s webhook URL now
        — ARF-OS only ever stores its hash and cannot show it again.
      </Alert>
      <div className="field">
        <label htmlFor="deployment-token">Webhook token</label>
        <div className="row">
          <input id="deployment-token" className="mono" readOnly value={token} onFocus={(e) => e.target.select()} />
          <button
            type="button"
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(token);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <span className="field-hint">
          Webhook URL: <code>POST /v1/webhooks/tradingview/{token}</code>
        </span>
      </div>
      <Link href={`/forward-deployments/${deploymentId}`} className="btn btn-primary">
        Continue to deployment →
      </Link>
    </>
  );
}

export function NewForwardDeploymentForm({ strategyVersionId }: { strategyVersionId: string }) {
  const [state, formAction] = useFormState(launchForwardDeploymentAction, initialState);
  const [quantityModelType, setQuantityModelType] = useState<(typeof QUANTITY_MODEL_TYPES)[number]>("percent_of_equity");

  if (state.success) {
    return <TokenReveal deploymentId={state.success.deploymentId} token={state.success.token} />;
  }

  return (
    <form action={formAction}>
      {state.error && <Alert tone="error">{state.error}</Alert>}

      <input type="hidden" name="strategyVersionId" value={strategyVersionId} />

      <div className="field-row">
        <div className="field">
          <label htmlFor="symbol">Symbol</label>
          <input id="symbol" name="symbol" placeholder="BYBIT:BTCUSDT.P" required />
        </div>
        <div className="field">
          <label htmlFor="timeframe">Timeframe</label>
          <input id="timeframe" name="timeframe" placeholder="60" required />
        </div>
      </div>
      <span className="field-hint">
        Every inbound alert is checked against these before it can move a paper position (CLAUDE.md 16.1).
      </span>

      <div className="field-row">
        <div className="field">
          <label htmlFor="initialCapital">Initial capital</label>
          <input id="initialCapital" name="initialCapital" type="number" step="any" min={0} defaultValue="10000" required />
        </div>
        <div className="field">
          <label htmlFor="timestampToleranceSeconds">Timestamp tolerance (seconds)</label>
          <input id="timestampToleranceSeconds" name="timestampToleranceSeconds" type="number" min={1} defaultValue="300" required />
        </div>
      </div>

      <div className="field">
        <label htmlFor="fillModelVersion">Fill model version</label>
        <input id="fillModelVersion" name="fillModelVersion" defaultValue="1.0.0" required />
        <span className="field-hint">Recorded on the deployment for reproducibility — never edited afterward (CLAUDE.md 16.2).</span>
      </div>

      <div className="field">
        <label htmlFor="latencySeconds">Simulated latency (seconds)</label>
        <input id="latencySeconds" name="latencySeconds" type="number" min={0} step="any" defaultValue="2" required />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="slippageType">Slippage model</label>
          <select id="slippageType" name="slippageType" defaultValue="fixed_percent">
            {SLIPPAGE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="slippageValue">Slippage value</label>
          <input id="slippageValue" name="slippageValue" type="number" step="any" min={0} defaultValue="0.05" required />
        </div>
      </div>
      <span className="field-hint">
        Always moves the fill against the trader — a percent of price, or (fixed_ticks) a flat price delta; this repo
        has no per-symbol tick-size table.
      </span>

      <div className="field-row">
        <div className="field">
          <label htmlFor="commissionType">Commission model</label>
          <select id="commissionType" name="commissionType" defaultValue="percent">
            {COMMISSION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="commissionValue">Commission value</label>
          <input id="commissionValue" name="commissionValue" type="number" step="any" min={0} defaultValue="0.04" required />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="quantityModelType">Quantity model</label>
          <select
            id="quantityModelType"
            name="quantityModelType"
            value={quantityModelType}
            onChange={(e) => setQuantityModelType(e.target.value as (typeof QUANTITY_MODEL_TYPES)[number])}
          >
            {QUANTITY_MODEL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="quantityValue">{QUANTITY_VALUE_LABEL[quantityModelType]}</label>
          <input id="quantityValue" name="quantityValue" type="number" step="any" min={0} defaultValue="10" required />
        </div>
      </div>

      <div className="field">
        <label htmlFor="maxDrawdownPctAlertThreshold">Drawdown alert threshold (percent, optional)</label>
        <input id="maxDrawdownPctAlertThreshold" name="maxDrawdownPctAlertThreshold" type="number" step="any" min={0} max={100} />
        <span className="field-hint">
          Leave blank to skip — the health endpoint reports NOT_CONFIGURED rather than a fabricated default.
        </span>
      </div>

      <div className="field">
        <span className="field-hint">
          Stop/target rule: <code>external_alert_only</code> — TradingView&apos;s own alert reports a stop/target
          hit; ARF-OS does not simulate live monitoring against a price feed it doesn&apos;t have.
        </span>
      </div>

      <SubmitButton />
    </form>
  );
}
