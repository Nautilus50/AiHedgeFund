"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface EquityPoint {
  sequenceNumber: number;
  barTime: string;
  equity: string;
}

interface DrawdownPoint {
  sequenceNumber: number;
  barTime: string;
  drawdown: string;
  drawdownPct: string;
}

interface ChartRow {
  sequenceNumber: number;
  barTime: string;
  equity: number | undefined;
  drawdown: number | undefined;
  drawdownPct: number | undefined;
}

function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const isoStr = d.toISOString();
  return `${isoStr.slice(0, 10)} ${isoStr.slice(11, 16)}`;
}

/** Merges the two independently-fetched curves by sequenceNumber — they're reconstructed from the same trade ledger, but reads stay separate (CLAUDE.md 26). */
function mergeRows(equityPoints: EquityPoint[], drawdownPoints: DrawdownPoint[]): ChartRow[] {
  const bySeq = new Map<number, ChartRow>();
  for (const p of equityPoints) {
    bySeq.set(p.sequenceNumber, {
      sequenceNumber: p.sequenceNumber,
      barTime: p.barTime,
      equity: Number(p.equity),
      drawdown: undefined,
      drawdownPct: undefined,
    });
  }
  for (const p of drawdownPoints) {
    const existing = bySeq.get(p.sequenceNumber);
    if (existing) {
      existing.drawdown = Number(p.drawdown);
      existing.drawdownPct = Number(p.drawdownPct);
    } else {
      bySeq.set(p.sequenceNumber, {
        sequenceNumber: p.sequenceNumber,
        barTime: p.barTime,
        equity: undefined,
        drawdown: Number(p.drawdown),
        drawdownPct: Number(p.drawdownPct),
      });
    }
  }
  return [...bySeq.values()].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

function downloadCsv(rows: ChartRow[]): void {
  const header = "sequence_number,bar_time_utc,equity,drawdown,drawdown_pct";
  const lines = rows.map((r) =>
    [r.sequenceNumber, r.barTime, r.equity ?? "", r.drawdown ?? "", r.drawdownPct ?? ""].join(","),
  );
  const csv = [header, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "equity-drawdown.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function EquityTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartRow }> }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-time">{formatUtc(row.barTime)} UTC</div>
      {row.equity !== undefined && (
        <div>
          Equity: <span className="mono">{row.equity.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}

function DrawdownTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartRow }> }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-time">{formatUtc(row.barTime)} UTC</div>
      {row.drawdownPct !== undefined && (
        <div>
          Drawdown: <span className="mono">{row.drawdown?.toFixed(2)}</span> (
          <span className="mono">{row.drawdownPct.toFixed(3)}%</span>)
        </div>
      )}
    </div>
  );
}

/**
 * Two single-axis charts (equity, drawdown) stacked and linked — never one
 * dual-axis chart, which spec 15.18 treats as misleading. `syncId` links
 * their hover tooltip; a single shared Brush strip links the visible date
 * range across both, driven by slicing the same underlying rows.
 */
export function EquityDrawdownChart({
  equityPoints,
  drawdownPoints,
  isStale,
}: {
  equityPoints: EquityPoint[];
  drawdownPoints: DrawdownPoint[];
  isStale: boolean;
}) {
  const data = useMemo(() => mergeRows(equityPoints, drawdownPoints), [equityPoints, drawdownPoints]);

  const [range, setRange] = useState({ startIndex: 0, endIndex: Math.max(data.length - 1, 0) });
  const visible = data.slice(range.startIndex, range.endIndex + 1);

  const summary = useMemo(() => {
    const equities = data.map((d) => d.equity).filter((v): v is number => v !== undefined);
    const drawdownPcts = data.map((d) => d.drawdownPct).filter((v): v is number => v !== undefined);
    const start = equities[0];
    const end = equities[equities.length - 1];
    if (start === undefined || end === undefined) return undefined;
    return {
      start,
      end,
      maxDrawdownPct: drawdownPcts.length > 0 ? Math.max(...drawdownPcts) : 0,
    };
  }, [data]);

  if (data.length === 0) return null;

  return (
    <div className="chart-block">
      {isStale && (
        <p className="card-hint chart-stale-note">
          This run has not completed — the curve below may still be incomplete.
        </p>
      )}
      {summary !== undefined && (
        <p className="chart-summary">
          Equity went from <span className="mono">{summary.start.toFixed(2)}</span> to{" "}
          <span className="mono">{summary.end.toFixed(2)}</span>, with a maximum drawdown of{" "}
          <span className="mono">{summary.maxDrawdownPct.toFixed(3)}%</span>.
        </p>
      )}

      <div className="chart-panel">
        <div className="chart-panel-label">Equity</div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={visible} syncId="equity-drawdown" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--c-border)" />
            <XAxis
              dataKey="barTime"
              tickFormatter={formatUtc}
              tick={{ fontSize: 11, fill: "var(--c-text-faint)" }}
              minTickGap={40}
            />
            <YAxis tick={{ fontSize: 11, fill: "var(--c-text-faint)" }} width={70} domain={["auto", "auto"]} />
            <Tooltip content={<EquityTooltip />} />
            <Line
              type="monotone"
              dataKey="equity"
              stroke="var(--c-accent)"
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-panel">
        <div className="chart-panel-label">Drawdown %</div>
        <ResponsiveContainer width="100%" height={120}>
          <AreaChart data={visible} syncId="equity-drawdown" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--c-border)" />
            <XAxis
              dataKey="barTime"
              tickFormatter={formatUtc}
              tick={{ fontSize: 11, fill: "var(--c-text-faint)" }}
              minTickGap={40}
            />
            <YAxis tick={{ fontSize: 11, fill: "var(--c-text-faint)" }} width={70} reversed domain={[0, "auto"]} />
            <Tooltip content={<DrawdownTooltip />} />
            <Area
              type="monotone"
              dataKey="drawdownPct"
              stroke="var(--c-danger)"
              fill="var(--c-danger-soft)"
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <ResponsiveContainer width="100%" height={44}>
        <LineChart data={data} margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
          <Line dataKey="equity" stroke="transparent" dot={false} isAnimationActive={false} />
          <Brush
            dataKey="barTime"
            tickFormatter={formatUtc}
            height={28}
            travellerWidth={8}
            startIndex={range.startIndex}
            endIndex={range.endIndex}
            onChange={(next) => {
              if (next && typeof next.startIndex === "number" && typeof next.endIndex === "number") {
                setRange({ startIndex: next.startIndex, endIndex: next.endIndex });
              }
            }}
            stroke="var(--c-accent)"
          />
        </LineChart>
      </ResponsiveContainer>

      <button type="button" className="btn chart-export" onClick={() => downloadCsv(data)}>
        Download CSV
      </button>
    </div>
  );
}
