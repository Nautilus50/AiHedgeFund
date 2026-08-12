"use client";

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Alert } from "../../../../../components/primitives";
import { launchBacktestRunAction, type LaunchBacktestRunActionState } from "./actions";

const initialState: LaunchBacktestRunActionState = {};

const SEGMENT_KINDS = [
  "IN_SAMPLE",
  "VALIDATION",
  "OUT_OF_SAMPLE",
  "FINAL_HOLDOUT",
  "ROLLING_WALK_FORWARD",
  "ANCHORED_WALK_FORWARD",
  "REGIME",
] as const;

const COMMISSION_TYPES = ["percent", "cash_per_order", "cash_per_contract"] as const;

interface DatasetVersionOption {
  id: string;
  symbol: string;
  timeframe: string;
  fromTs: string;
  toTs: string;
  barCount: number;
}

/** `datetime-local` wants "YYYY-MM-DDTHH:mm", not a full ISO string with seconds/zone. */
function toDatetimeLocal(iso: string): string {
  return iso.slice(0, 16);
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Launching…" : "Launch backtest run"}
    </button>
  );
}

export function NewBacktestRunForm({
  strategyVersionId,
  sourceHash,
  datasets,
}: {
  strategyVersionId: string;
  sourceHash: string;
  datasets: DatasetVersionOption[];
}) {
  const [state, formAction] = useFormState(launchBacktestRunAction, initialState);
  const [datasetVersionId, setDatasetVersionId] = useState(datasets[0]?.id ?? "");

  const selected = useMemo(
    () => datasets.find((d) => d.id === datasetVersionId) ?? datasets[0],
    [datasets, datasetVersionId],
  );

  return (
    <form action={formAction}>
      {state.error && <Alert tone="error">{state.error}</Alert>}

      <input type="hidden" name="strategyVersionId" value={strategyVersionId} />
      <input type="hidden" name="sourceHash" value={sourceHash} />

      <div className="field">
        <label htmlFor="datasetVersionId">Dataset</label>
        <select
          id="datasetVersionId"
          name="datasetVersionId"
          required
          value={datasetVersionId}
          onChange={(e) => setDatasetVersionId(e.target.value)}
        >
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.symbol} / {d.timeframe} — {d.barCount} bars ({d.fromTs.slice(0, 10)} to {d.toTs.slice(0, 10)})
            </option>
          ))}
        </select>
        <span className="field-hint">Symbol and timeframe are read from the dataset, not entered separately.</span>
      </div>

      <div className="field">
        <label htmlFor="segmentKind">Segment kind</label>
        <select id="segmentKind" name="segmentKind" required defaultValue="IN_SAMPLE">
          {SEGMENT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="fromTs">From (UTC)</label>
          <input
            id="fromTs"
            name="fromTs"
            type="datetime-local"
            required
            defaultValue={selected ? toDatetimeLocal(selected.fromTs) : ""}
            key={`from-${selected?.id ?? "none"}`}
          />
        </div>
        <div className="field">
          <label htmlFor="toTs">To (UTC)</label>
          <input
            id="toTs"
            name="toTs"
            type="datetime-local"
            required
            defaultValue={selected ? toDatetimeLocal(selected.toTs) : ""}
            key={`to-${selected?.id ?? "none"}`}
          />
        </div>
      </div>
      <span className="field-hint">
        Defaults to the dataset&apos;s full range — narrow it to carve out a segment (walk-forward, holdout, etc).
      </span>

      <div className="field">
        <label htmlFor="initialCapital">Initial capital</label>
        <input id="initialCapital" name="initialCapital" defaultValue="10000" required inputMode="decimal" />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="commissionType">Commission type</label>
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
          <input id="commissionValue" name="commissionValue" type="number" step="any" min={0} defaultValue="0.1" required />
        </div>
      </div>

      <div className="field">
        <label htmlFor="slippageTicks">Slippage (ticks)</label>
        <input id="slippageTicks" name="slippageTicks" type="number" step={1} min={0} defaultValue="0" required />
        <span className="field-hint">
          Must stay 0 — the local runner has no tick-size source to apply nonzero slippage against, and rejects the
          run at compile time otherwise.
        </span>
      </div>

      <div className="field">
        <label htmlFor="runnerVersion">Runner version</label>
        <input id="runnerVersion" name="runnerVersion" defaultValue="0.1.0" required />
        <span className="field-hint">The local runner's version (arf-os-local-pine-runner), recorded on the run for reproducibility.</span>
      </div>

      <SubmitButton />
    </form>
  );
}
