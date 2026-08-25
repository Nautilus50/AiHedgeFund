"use client";

import { useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { StatSnapshot } from "@arf-os/contracts";
import { SCOPE_LABEL, SCOPE_NOTE, formatPct } from "../lib/algo-display";
import { EmptyState } from "./primitives";

/**
 * Evidence for one algo, one scope at a time.
 *
 * Scopes are tabs rather than overlaid series on purpose: an in-sample curve
 * and a forward paper curve are different claims, and drawing them as one
 * uninterrupted line is exactly the misrepresentation CLAUDE.md 18.1 forbids.
 */
export function AlgoEvidence({ snapshots }: { snapshots: StatSnapshot[] }) {
  const [activeId, setActiveId] = useState(snapshots[0]?.snapshotId ?? "");
  const active = snapshots.find((snapshot) => snapshot.snapshotId === activeId) ?? snapshots[0];

  if (!active) {
    return (
      <EmptyState title="No evidence catalogued">
        <p>Publish a snapshot from a succeeded backtest run to record what this release actually did.</p>
      </EmptyState>
    );
  }

  const curve = active.equityCurve.map((point) => ({ at: point.at.slice(0, 10), equity: point.equity }));

  return (
    <div className="algo-evidence">
      <div className="algo-scope-tabs" role="tablist" aria-label="Evidence scope">
        {snapshots.map((snapshot) => (
          <button
            key={snapshot.snapshotId}
            type="button"
            role="tab"
            aria-selected={snapshot.snapshotId === active.snapshotId}
            className={snapshot.snapshotId === active.snapshotId ? "algo-tab algo-tab-active" : "algo-tab"}
            onClick={() => setActiveId(snapshot.snapshotId)}
          >
            {SCOPE_LABEL[snapshot.scope]}
          </button>
        ))}
      </div>

      <p className="algo-scope-note">{SCOPE_NOTE[active.scope]}</p>
      <p className="algo-scope-meta">
        {active.periodStart.slice(0, 10)} → {active.periodEnd.slice(0, 10)} · metrics v{active.calculationVersion} ·{" "}
        {active.costsApplied ? "net of modelled costs" : "gross — costs not applied"} · source{" "}
        <code>{active.sourceId.slice(0, 8)}</code>
      </p>

      <dl className="algo-stats">
        <div>
          <dt>Net return</dt>
          <dd className={active.metrics.netProfitPct >= 0 ? "algo-num algo-num-pos" : "algo-num algo-num-neg"}>
            {formatPct(active.metrics.netProfitPct)}
          </dd>
        </div>
        <div>
          <dt>Max drawdown</dt>
          <dd className="algo-num">{formatPct(active.metrics.maxDrawdownPct)}</dd>
        </div>
        <div>
          <dt>Profit factor</dt>
          <dd className="algo-num">{active.metrics.profitFactor?.toFixed(2) ?? "—"}</dd>
        </div>
        <div>
          <dt>Win rate</dt>
          <dd className="algo-num">
            {active.metrics.winRatePct === null ? "—" : formatPct(active.metrics.winRatePct)}
          </dd>
        </div>
        <div>
          <dt>Closed trades</dt>
          <dd className="algo-num">{active.metrics.tradeCount}</dd>
        </div>
      </dl>

      {curve.length > 1 && (
        <figure className="algo-chart">
          <figcaption>
            Equity, {SCOPE_LABEL[active.scope].toLowerCase()}. Reconstructed from the trade ledger, not read from a
            runner summary.
          </figcaption>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={curve} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--c-border)" vertical={false} />
              <XAxis dataKey="at" tick={{ fontSize: 11 }} stroke="var(--c-text-faint)" minTickGap={40} />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--c-text-faint)" width={72} />
              <Tooltip
                contentStyle={{ background: "var(--c-surface)", border: "1px solid var(--c-border)", fontSize: 12 }}
                formatter={(value) => [typeof value === "number" ? value.toFixed(2) : String(value), "Equity"]}
              />
              <Area type="monotone" dataKey="equity" stroke="var(--c-accent)" fill="var(--c-accent-soft)" />
            </AreaChart>
          </ResponsiveContainer>
        </figure>
      )}

      {active.monthlyReturns.length > 0 && (
        <table className="data algo-monthly">
          <caption>Monthly return, {SCOPE_LABEL[active.scope].toLowerCase()}</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Return</th>
            </tr>
          </thead>
          <tbody>
            {active.monthlyReturns.map((entry) => (
              <tr key={entry.month}>
                <th scope="row">{entry.month}</th>
                <td className={entry.returnPct >= 0 ? "algo-num algo-num-pos" : "algo-num algo-num-neg"}>
                  {formatPct(entry.returnPct, 2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
