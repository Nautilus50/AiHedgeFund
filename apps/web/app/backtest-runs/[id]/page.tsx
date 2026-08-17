import Link from "next/link";
import { apiFetchSafe } from "../../../lib/api";
import { StateBadge } from "../../../components/Badge";
import { EquityDrawdownChart } from "../../../components/EquityDrawdownChart";
import { Alert, Card, CardBody, CardHead, EmptyState, Hash, Timestamp } from "../../../components/primitives";
import { SegmentTag } from "../../../components/Provenance";
import { LiveRunUpdates } from "./LiveRunUpdates";

interface BacktestRunDetail {
  id: string;
  strategyVersionId: string;
  runnerType: string;
  runnerVersion: string;
  symbol: string;
  timeframe: string;
  segmentKind: string;
  fromTs: string;
  toTs: string;
  initialCapital: string;
  status: string;
  sourceHash: string;
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface Trade {
  id: string;
  sequenceNumber: number;
  direction: string;
  entryTime: string;
  exitTime: string | null;
  entryPrice: string;
  exitPrice: string | null;
  quantity: string;
  grossPnl: string | null;
  fees: string;
  netPnl: string | null;
  entryReason: string | null;
  exitReason: string | null;
}

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

interface MetricSnapshot {
  id: string;
  metricName: string;
  value: string;
  unit: string;
  calculationVersion: string;
}

interface ParityReport {
  id: string;
  status: string;
  firstDivergence: string | null;
  createdAt: string;
}

const TAIL_LENGTH = 20;

/** Shows the last N rows of a curve rather than every point — evidence, not a chart (CLAUDE.md 18.4's dedicated time-series library is out of scope for this slice). */
function tail<T>(items: T[], length: number): { rows: T[]; truncated: boolean } {
  return { rows: items.slice(-length), truncated: items.length > length };
}

export default async function BacktestRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [runResult, tradesResult, equityResult, drawdownResult, metricsResult, parityResult] = await Promise.all([
    apiFetchSafe<BacktestRunDetail>(`/v1/backtest-runs/${id}`),
    apiFetchSafe<{ items: Trade[] }>(`/v1/backtest-runs/${id}/trades`),
    apiFetchSafe<{ items: EquityPoint[] }>(`/v1/backtest-runs/${id}/equity`),
    apiFetchSafe<{ items: DrawdownPoint[] }>(`/v1/backtest-runs/${id}/drawdown`),
    apiFetchSafe<{ items: MetricSnapshot[] }>(`/v1/backtest-runs/${id}/metrics`),
    apiFetchSafe<{ items: ParityReport[] }>(`/v1/backtest-runs/${id}/parity`),
  ]);

  if ("error" in runResult) {
    return (
      <>
        <Link href="/" className="breadcrumb">
          ← Command Centre
        </Link>
        <Alert tone="error">Could not load backtest run. {runResult.error.message}</Alert>
      </>
    );
  }

  const run = runResult.data;

  // Only a run still in flight has anything left to notify about — no
  // point opening a stream for one already at a terminal status.
  const isInFlight = run.status === "QUEUED" || run.status === "RUNNING";

  return (
    <>
      {isInFlight && <LiveRunUpdates backtestRunId={run.id} />}

      <Link href={`/strategy-versions/${run.strategyVersionId}`} className="breadcrumb">
        ← Strategy version
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <div className="row">
            <h1>
              {run.runnerType} run · {run.symbol} / {run.timeframe}
            </h1>
            <StateBadge state={run.status} kind="runStatus" />
          </div>
          <p className="page-subtitle">
            <SegmentTag segment={run.segmentKind} /> · <Timestamp value={run.fromTs} dateOnly /> to{" "}
            <Timestamp value={run.toTs} dateOnly />
          </p>
        </div>
        <Link href={`/backtest-runs/${run.id}/validation`} className="btn">
          Validation Lab
        </Link>
      </div>

      {run.status === "FAILED_TERMINAL" && (
        <Alert tone="error">
          This run failed{run.errorCode ? `: ${run.errorCode}` : "."} It will not be retried automatically — a
          deterministic failure (an unsupported SDL feature, a malformed dataset) fails identically on retry.
        </Alert>
      )}

      <Card>
        <CardHead title="Run identity" hint="What this result is reproducible from." />
        <CardBody>
          <dl className="dl">
            <dt>Runner</dt>
            <dd className="mono">
              {run.runnerType} {run.runnerVersion}
            </dd>
            <dt>Initial capital</dt>
            <dd className="num">{run.initialCapital}</dd>
            <dt>Source hash</dt>
            <dd>
              <Hash value={run.sourceHash} />
            </dd>
            <dt>Started</dt>
            <dd>{run.startedAt ? <Timestamp value={run.startedAt} /> : <span className="unset">not started</span>}</dd>
            <dt>Completed</dt>
            <dd>
              {run.completedAt ? <Timestamp value={run.completedAt} /> : <span className="unset">not completed</span>}
            </dd>
            <dt>Created</dt>
            <dd>
              <Timestamp value={run.createdAt} />
            </dd>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Metrics"
          hint="Independently calculated by ARF-OS, never read from a TradingView screenshot (CLAUDE.md 26)."
        />
        {"error" in metricsResult ? (
          <CardBody>
            <Alert tone="error">Could not load metrics. {metricsResult.error.message}</Alert>
          </CardBody>
        ) : metricsResult.data.items.length === 0 ? (
          <EmptyState title="No metrics yet">Metrics are computed after the trade ledger is written.</EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Value</th>
                    <th>Unit</th>
                    <th>Calc. version</th>
                  </tr>
                </thead>
                <tbody>
                  {metricsResult.data.items.map((metric) => (
                    <tr key={metric.id}>
                      <td className="mono">{metric.metricName}</td>
                      <td className="num">{metric.value}</td>
                      <td>{metric.unit}</td>
                      <td className="mono">{metric.calculationVersion}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHead
          title="Parity"
          hint="Comparison against a TradingView Performance Summary — PASS/WARN/FAIL/INSUFFICIENT_DATA (CLAUDE.md 26)."
        />
        {"error" in parityResult ? (
          <CardBody>
            <Alert tone="error">Could not load parity reports. {parityResult.error.message}</Alert>
          </CardBody>
        ) : parityResult.data.items.length === 0 ? (
          <EmptyState title="No parity report yet">
            Parity is computed once a TradingView verification with a Performance Summary is attached to this run.
          </EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>First divergence</th>
                    <th>Computed (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {parityResult.data.items.map((report) => (
                    <tr key={report.id}>
                      <td>
                        <StateBadge state={report.status} kind="parity" />
                      </td>
                      <td>{report.firstDivergence ?? <span className="unset">none</span>}</td>
                      <td>
                        <Timestamp value={report.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHead
          title="Equity &amp; drawdown"
          hint="Reconstructed from the trade ledger alone, never from a reported summary figure (CLAUDE.md 26)."
        />
        {"error" in equityResult ? (
          <CardBody>
            <Alert tone="error">Could not load the equity curve. {equityResult.error.message}</Alert>
          </CardBody>
        ) : "error" in drawdownResult ? (
          <CardBody>
            <Alert tone="error">Could not load the drawdown curve. {drawdownResult.error.message}</Alert>
          </CardBody>
        ) : equityResult.data.items.length === 0 && drawdownResult.data.items.length === 0 ? (
          <EmptyState title="No equity or drawdown points yet" />
        ) : (
          <>
            <EquityDrawdownChart
              equityPoints={equityResult.data.items}
              drawdownPoints={drawdownResult.data.items}
              isStale={run.status !== "SUCCEEDED"}
            />

            <CardBody flush>
              <details>
                <summary className="card-hint" style={{ padding: "0 var(--sp-5) var(--sp-3)", cursor: "pointer" }}>
                  Equity table
                </summary>
                {(() => {
                  const { rows, truncated } = tail(equityResult.data.items, TAIL_LENGTH);
                  return (
                    <>
                      {truncated && (
                        <p className="card-hint" style={{ padding: "0 var(--sp-5)" }}>
                          Showing the last {TAIL_LENGTH} of {equityResult.data.items.length} points.
                        </p>
                      )}
                      <div className="table-wrap">
                        <table className="data">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Bar time (UTC)</th>
                              <th>Equity</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((point) => (
                              <tr key={point.sequenceNumber}>
                                <td className="num">{point.sequenceNumber}</td>
                                <td>
                                  <Timestamp value={point.barTime} />
                                </td>
                                <td className="num">{point.equity}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  );
                })()}
              </details>

              <details>
                <summary className="card-hint" style={{ padding: "0 var(--sp-5) var(--sp-3)", cursor: "pointer" }}>
                  Drawdown table
                </summary>
                {(() => {
                  const { rows, truncated } = tail(drawdownResult.data.items, TAIL_LENGTH);
                  return (
                    <>
                      {truncated && (
                        <p className="card-hint" style={{ padding: "0 var(--sp-5)" }}>
                          Showing the last {TAIL_LENGTH} of {drawdownResult.data.items.length} points.
                        </p>
                      )}
                      <div className="table-wrap">
                        <table className="data">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Bar time (UTC)</th>
                              <th>Drawdown</th>
                              <th>Drawdown %</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((point) => (
                              <tr key={point.sequenceNumber}>
                                <td className="num">{point.sequenceNumber}</td>
                                <td>
                                  <Timestamp value={point.barTime} />
                                </td>
                                <td className="num">{point.drawdown}</td>
                                <td className="num">{point.drawdownPct}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  );
                })()}
              </details>
            </CardBody>
          </>
        )}
      </Card>

      <Card>
        <CardHead
          title="Trades"
          hint="Independently reconstructed — never sourced from a screenshot (CLAUDE.md 26)."
        />
        {"error" in tradesResult ? (
          <CardBody>
            <Alert tone="error">Could not load trades. {tradesResult.error.message}</Alert>
          </CardBody>
        ) : tradesResult.data.items.length === 0 ? (
          <EmptyState title="No trades yet" />
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Direction</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Quantity</th>
                    <th>Net P&amp;L</th>
                    <th>Exit reason</th>
                  </tr>
                </thead>
                <tbody>
                  {tradesResult.data.items.map((trade) => (
                    <tr key={trade.id}>
                      <td className="num">{trade.sequenceNumber}</td>
                      <td>{trade.direction}</td>
                      <td>
                        <Timestamp value={trade.entryTime} /> <span className="mono">@ {trade.entryPrice}</span>
                      </td>
                      <td>
                        {trade.exitTime ? (
                          <>
                            <Timestamp value={trade.exitTime} /> <span className="mono">@ {trade.exitPrice}</span>
                          </>
                        ) : (
                          <span className="unset">open</span>
                        )}
                      </td>
                      <td className="num">{trade.quantity}</td>
                      <td className="num">
                        {trade.netPnl ?? <span className="unset">—</span>}
                      </td>
                      <td>{trade.exitReason ?? <span className="unset">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        )}
      </Card>
    </>
  );
}
