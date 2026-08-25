"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Alert } from "../../../components/primitives";
import {
  catalogueAlgoAction,
  recordDecisionAction,
  requestVerificationAction,
  saveDefinitionAction,
  savePineAction,
  type ActionState,
} from "./actions";

const initialState: ActionState = {};

function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
  disabled = false,
}: {
  label: string;
  pendingLabel: string;
  variant?: "primary" | "default";
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={variant === "primary" ? "btn btn-primary" : "btn"}
      disabled={pending || disabled}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function Feedback({ state }: { state: ActionState }) {
  if (state.error) return <Alert tone="error">{state.error}</Alert>;
  if (state.success) return <Alert tone="ok">{state.success}</Alert>;
  return null;
}

/** Storage is one-per-version at the database level, so warn before the constraint does. */
function ImmutabilityNotice({ what }: { what: string }) {
  return (
    <Alert tone="warn">
      A {what} is already stored for this version. Versions are immutable — saving again will be
      rejected. Create a child version to make a change.
    </Alert>
  );
}

export function SaveDefinitionForm({
  strategyVersionId,
  alreadySet,
}: {
  strategyVersionId: string;
  alreadySet: boolean;
}) {
  const [state, formAction] = useFormState(saveDefinitionAction.bind(null, strategyVersionId), initialState);
  return (
    <form action={formAction}>
      {alreadySet && <ImmutabilityNotice what="strategy definition" />}
      <Feedback state={state} />
      <div className="field">
        <label htmlFor="definition">SDL document (JSON)</label>
        <textarea id="definition" name="definition" rows={10} required placeholder='{ "schemaVersion": "1.0.0", … }' />
        <span className="field-hint">
          Validated against the Strategy Definition schema before anything is written.
        </span>
      </div>
      <SubmitButton label="Save definition" pendingLabel="Saving…" disabled={alreadySet} />
    </form>
  );
}

export function SavePineForm({
  strategyVersionId,
  alreadySet,
}: {
  strategyVersionId: string;
  alreadySet: boolean;
}) {
  const [state, formAction] = useFormState(savePineAction.bind(null, strategyVersionId), initialState);
  return (
    <form action={formAction}>
      {alreadySet && <ImmutabilityNotice what="Pine revision" />}
      <Feedback state={state} />
      <div className="field">
        <label htmlFor="source">Pine Script v6 source</label>
        <textarea id="source" name="source" rows={10} required placeholder="//@version=6&#10;strategy(…)" />
      </div>
      <div className="field">
        <label htmlFor="manifest">Manifest (JSON)</label>
        <textarea id="manifest" name="manifest" rows={4} placeholder='{ "symbol": "BYBIT:BTCUSDT.P" }' />
        <span className="field-hint">Hashed independently of the source, so settings drift is detectable.</span>
      </div>
      <SubmitButton label="Save Pine revision" pendingLabel="Saving…" disabled={alreadySet} />
    </form>
  );
}

export function RequestVerificationForm({ strategyVersionId }: { strategyVersionId: string }) {
  const [state, formAction] = useFormState(
    requestVerificationAction.bind(null, strategyVersionId),
    initialState,
  );
  return (
    <form action={formAction}>
      <Feedback state={state} />
      <div className="field-row">
        <div className="field">
          <label htmlFor="requiredSymbol">Symbol</label>
          <input id="requiredSymbol" name="requiredSymbol" placeholder="BYBIT:BTCUSDT.P" required />
        </div>
        <div className="field">
          <label htmlFor="requiredTimeframe">Timeframe</label>
          <input id="requiredTimeframe" name="requiredTimeframe" placeholder="60" required />
        </div>
      </div>
      <span className="field-hint">
        These are pinned into the verification task so the operator runs the exact configuration.
      </span>
      <div style={{ marginTop: "var(--sp-4)" }}>
        <SubmitButton label="Create verification" pendingLabel="Creating…" />
      </div>
    </form>
  );
}

/**
 * CLAUDE.md 18.3: a decision must surface the exact version, mandatory
 * evidence status, the strongest rejection case, and override status — and
 * approval must never be one click that hides the evidence. The checklist
 * and the explicit acknowledgement below exist for that reason, not for
 * decoration.
 */
export function DecisionForm({
  strategyVersionId,
  versionNumber,
  workflowState,
  hasDefinition,
  hasPine,
}: {
  strategyVersionId: string;
  versionNumber: number;
  workflowState: string;
  hasDefinition: boolean;
  hasPine: boolean;
}) {
  const [state, formAction] = useFormState(recordDecisionAction.bind(null, strategyVersionId), initialState);
  const [decision, setDecision] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const isApproval = decision === "PAPER_APPROVED";
  const evidence = [
    { label: "Strategy definition stored", ok: hasDefinition },
    { label: "Pine revision stored", ok: hasPine },
  ];
  const missing = evidence.filter((e) => !e.ok);

  return (
    <form action={formAction}>
      <Feedback state={state} />

      <div className="card" style={{ marginBottom: "var(--sp-4)" }}>
        <div className="card-body">
          <h3 style={{ marginBottom: "var(--sp-3)" }}>Deciding on</h3>
          <dl className="dl">
            <dt>Version</dt>
            <dd>
              v{versionNumber} <span className="mono">({strategyVersionId.slice(0, 8)}…)</span>
            </dd>
            <dt>Current state</dt>
            <dd>{workflowState.replace(/_/g, " ").toLowerCase()}</dd>
            <dt>Mandatory evidence</dt>
            <dd>
              <ul style={{ margin: 0, paddingLeft: "1.1em" }}>
                {evidence.map((e) => (
                  <li key={e.label}>
                    <span aria-hidden="true">{e.ok ? "✓ " : "✕ "}</span>
                    {e.label}
                    {!e.ok && <span className="unset"> — missing</span>}
                  </li>
                ))}
              </ul>
            </dd>
            <dt>Validator recommendation</dt>
            <dd>
              <span className="unset">not available — the validation lane is not built yet</span>
            </dd>
          </dl>
        </div>
      </div>

      {missing.length > 0 && (
        <Alert tone="warn">
          {missing.length} mandatory evidence item{missing.length === 1 ? " is" : "s are"} missing. A decision
          recorded now is made without it, and the gap is permanent in the audit trail.
        </Alert>
      )}

      <div className="field">
        <label htmlFor="decision">Decision</label>
        <select
          id="decision"
          name="decision"
          required
          value={decision}
          onChange={(e) => {
            setDecision(e.target.value);
            setAcknowledged(false);
          }}
        >
          <option value="" disabled>
            Choose…
          </option>
          <option value="REJECT">Reject</option>
          <option value="REWORK_WITH_NEW_VERSION">Rework with new version</option>
          <option value="PAPER_APPROVED">Approve for paper testing</option>
        </select>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="reasonCodes">Reason codes</label>
          <input id="reasonCodes" name="reasonCodes" required placeholder="OOS_POSITIVE, PARITY_PASS" />
          <span className="field-hint">Comma-separated.</span>
        </div>
        <div className="field">
          <label htmlFor="evidenceIds">Evidence ids</label>
          <input id="evidenceIds" name="evidenceIds" required placeholder="UUID, UUID" />
          <span className="field-hint">Comma-separated UUIDs.</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="positiveCase">Strongest positive case</label>
        <textarea id="positiveCase" name="positiveCase" rows={3} required />
      </div>

      <div className="field">
        <label htmlFor="rejectionCase">Strongest rejection case</label>
        <textarea id="rejectionCase" name="rejectionCase" rows={3} required />
        <span className="field-hint">
          Required even when approving — an approval that cannot state its own counter-argument has not
          been examined.
        </span>
      </div>

      {isApproval && (
        <Alert tone="warn">
          <label style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-start", fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              style={{ width: "auto", marginTop: 3 }}
            />
            <span>
              I have reviewed the evidence above, including the rejection case. Paper approval permits a
              controlled forward test only — it is not authorisation to deploy capital.
            </span>
          </label>
        </Alert>
      )}

      <SubmitButton
        label="Record decision"
        pendingLabel="Recording…"
        variant={isApproval ? "default" : "primary"}
        disabled={isApproval && !acknowledged}
      />
    </form>
  );
}

export interface CatalogueRunOption {
  id: string;
  symbol: string;
  timeframe: string;
  segmentKind: string;
}

export interface CatalogueAlgoOption {
  slug: string;
  name: string;
}

const MARKETS = ["CRYPTO", "INDEX_FUTURES", "FX", "COMMODITIES", "EQUITIES"] as const;
const SCOPES = ["OUT_OF_SAMPLE", "IN_SAMPLE"] as const;

const SCOPE_HINT: Record<(typeof SCOPES)[number], string> = {
  OUT_OF_SAMPLE: "A period held back during development and tested once.",
  IN_SAMPLE: "The period this was developed on — the weakest claim available.",
};

/**
 * Catalogues an approved version as an algo (ADR 0015).
 *
 * Four commands behind one form: resolve or create the algo, pin a release to
 * this version, record evidence from one of the version's own succeeded runs,
 * and publish. Evidence and publishing are separate checkboxes rather than
 * implied, because publishing is the point at which a number becomes a claim.
 */
export function CatalogueAlgoForm({
  strategyVersionId,
  algos,
  succeededRuns,
  defaultSymbol,
  defaultTimeframe,
}: {
  strategyVersionId: string;
  algos: CatalogueAlgoOption[];
  succeededRuns: CatalogueRunOption[];
  defaultSymbol: string;
  defaultTimeframe: string;
}) {
  const [state, formAction] = useFormState(catalogueAlgoAction.bind(null, strategyVersionId), initialState);
  const [existingSlug, setExistingSlug] = useState("");
  const [backtestRunId, setBacktestRunId] = useState(succeededRuns[0]?.id ?? "");

  const creatingNew = existingSlug === "";
  const hasEvidence = backtestRunId !== "";

  return (
    <form action={formAction}>
      <Feedback state={state} />

      {succeededRuns.length === 0 && (
        <Alert tone="warn">
          This version has no succeeded backtest run, so there is no evidence to catalogue with it. You can still create
          the algo and its release, but it stays a draft until a snapshot exists.
        </Alert>
      )}

      <div className="field">
        <label htmlFor="existingSlug">Algo</label>
        <select
          id="existingSlug"
          name="existingSlug"
          value={existingSlug}
          onChange={(event) => setExistingSlug(event.target.value)}
        >
          <option value="">Create a new algo</option>
          {algos.map((algo) => (
            <option key={algo.slug} value={algo.slug}>
              Add a release to “{algo.name}”
            </option>
          ))}
        </select>
        <span className="field-hint">
          Releasing into an existing algo supersedes its current release — the algo keeps one current version.
        </span>
      </div>

      {creatingNew && (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor="algoName">Name</label>
              <input id="algoName" name="name" placeholder="Momentum BTC" required={creatingNew} />
            </div>
            <div className="field">
              <label htmlFor="algoSlug">Slug</label>
              <input
                id="algoSlug"
                name="slug"
                placeholder="momentum-btc"
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                required={creatingNew}
              />
              <span className="field-hint">Lower-case words, single hyphens. Permanent — it is the algo&rsquo;s URL.</span>
            </div>
          </div>

          <div className="field">
            <label htmlFor="algoTagline">Tagline</label>
            <input id="algoTagline" name="tagline" placeholder="Trend continuation on BTC 1h." maxLength={240} />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="marketCategory">Market</label>
              <select id="marketCategory" name="marketCategory" defaultValue="CRYPTO">
                {MARKETS.map((market) => (
                  <option key={market} value={market}>
                    {market.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="algoSymbol">Symbol</label>
              <input id="algoSymbol" name="symbol" defaultValue={defaultSymbol} placeholder="BTCUSD" required={creatingNew} />
            </div>
            <div className="field">
              <label htmlFor="algoTimeframe">Timeframe</label>
              <input
                id="algoTimeframe"
                name="timeframe"
                defaultValue={defaultTimeframe}
                placeholder="60"
                required={creatingNew}
              />
            </div>
          </div>
          <span className="field-hint">
            Symbol and timeframe default to this version&rsquo;s most recent run — they describe the algo, not the run.
          </span>
        </>
      )}

      <div className="field" style={{ marginTop: "var(--sp-4)" }}>
        <label htmlFor="changelog">Changelog</label>
        <input id="changelog" name="changelog" placeholder="First release." maxLength={4000} />
      </div>

      <div className="field">
        <label htmlFor="setupInstructions">Setup notes</label>
        <textarea
          id="setupInstructions"
          name="setupInstructions"
          rows={3}
          placeholder="Paste into TradingView, set the alert webhook, confirm the symbol and timeframe."
        />
        <span className="field-hint">Shown next to the source when you come back to run this algo.</span>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="backtestRunId">Evidence run</label>
          <select
            id="backtestRunId"
            name="backtestRunId"
            value={backtestRunId}
            onChange={(event) => setBacktestRunId(event.target.value)}
          >
            <option value="">None for now</option>
            {succeededRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.segmentKind} · {run.symbol} / {run.timeframe} · {run.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Metrics are recomputed from this run&rsquo;s trade ledger — nothing is copied from a runner summary.
          </span>
        </div>
        <div className="field">
          <label htmlFor="scope">Scope</label>
          <select id="scope" name="scope" defaultValue="OUT_OF_SAMPLE" disabled={!hasEvidence}>
            {SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {scope.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
          <span className="field-hint">{SCOPE_HINT.OUT_OF_SAMPLE}</span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="publishNow" className="row" style={{ gap: "var(--sp-2)" }}>
          <input id="publishNow" name="publishNow" type="checkbox" disabled={!hasEvidence} />
          Publish to the library now
        </label>
        <span className="field-hint">
          {hasEvidence
            ? "Publishing marks the algo ready to run. It stays a draft otherwise."
            : "Requires an evidence run — an algo you cannot check does not get published."}
        </span>
      </div>

      <SubmitButton label="Catalogue this algo" pendingLabel="Cataloguing…" />
    </form>
  );
}
