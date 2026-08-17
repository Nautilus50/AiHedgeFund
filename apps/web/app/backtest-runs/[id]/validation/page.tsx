import Link from "next/link";
import { apiFetchSafe } from "../../../../lib/api";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../../../../components/primitives";
import { SegmentTag } from "../../../../components/Provenance";

interface SubsetMetrics {
  closedTradeCount: number;
  winningTrades: number;
  losingTrades: number;
  netProfit: string;
  profitFactor: number | null;
  winRatePct: number;
  avgWin: string;
  avgLoss: string;
  payoffRatio: number | null;
}

interface DegradationEntry {
  siblingRunId: string;
  segmentKind: string;
  createdAt: string;
  result: {
    netProfitDegradationPct: number | null;
    profitFactorDegradationPct: number | null;
    winRateDegradationPct: number;
  };
}

interface TradeContribution {
  tradeNumber: number;
  netPnl: number;
  cumulativePct: number;
}

interface ValidationLabReport {
  computedAt: string;
  targetRunId: string;
  segmentDistribution: { segmentKind: string; status: string; total: number }[];
  degradation: DegradationEntry[];
  tradeRemovalConcentration: { curve: TradeContribution[]; totalNetProfit: string; topN: number };
  directionalBreakdown: { long: SubsetMetrics; short: SubsetMetrics };
}

function pct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits)}%`;
}

const NOT_YET_BUILT = [
  "Parameter stability heatmap — needs child strategy versions per parameter variant, a real branching decision",
  "Neighbourhood survival — same dependency as above",
  "Monte Carlo fan (trade-order / return-path resampling) — a real statistical methodology, not improvised here",
  "Cost / slippage sensitivity — needs re-running the backtest with a perturbed cost model",
  "Entry-delay and missed-trade simulation — same dependency",
  "Start-date sensitivity — needs re-running against shifted windows",
  "Symbol transfer — needs additional datasets for other markets",
  "Regime breakdown — BacktestSegmentKind has a REGIME value, but no regime classifier or producer exists anywhere in this repo yet",
  "Multiple-testing penalty — needs a real statistical correction methodology",
  "Benchmark comparison — needs a benchmark data source this repo doesn't have",
];

export default async function ValidationLabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const result = await apiFetchSafe<ValidationLabReport>(`/v1/backtest-runs/${id}/validation-lab`);

  if ("error" in result) {
    return (
      <>
        <Link href={`/backtest-runs/${id}`} className="breadcrumb">
          ← Backtest run
        </Link>
        <Alert tone="error">Could not load the validation lab report. {result.error.message}</Alert>
      </>
    );
  }

  const report = result.data;

  return (
    <>
      <Link href={`/backtest-runs/${id}`} className="breadcrumb">
        ← Backtest run
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <h1>Validation Lab</h1>
          <p className="page-subtitle">
            Computed live from data already in Postgres for this run — nothing here is stored; the exact run ids
            compared are echoed below for reproducibility. <Timestamp value={report.computedAt} />.
          </p>
        </div>
      </div>

      <Card>
        <CardHead
          title="Segment distribution"
          hint="Every backtest run for this strategy version, grouped by segment kind and status — read this before trusting the degradation panel below."
        />
        {report.segmentDistribution.length === 0 ? (
          <EmptyState title="No runs found" />
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Segment kind</th>
                    <th>Status</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {report.segmentDistribution.map((row) => (
                    <tr key={`${row.segmentKind}-${row.status}`}>
                      <td>
                        <SegmentTag segment={row.segmentKind} />
                      </td>
                      <td className="mono">{row.status}</td>
                      <td className="num">{row.total}</td>
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
          title="In-sample / out-of-sample degradation"
          hint="This run compared against every SUCCEEDED sibling run on the same strategy version, symbol, and timeframe with a complementary segment kind."
        />
        {report.degradation.length === 0 ? (
          <EmptyState title="No comparable sibling runs yet">
            A degradation comparison needs at least one other SUCCEEDED run on this exact symbol and timeframe with a
            complementary segment kind (e.g. an OUT_OF_SAMPLE run to compare against an IN_SAMPLE target).
          </EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Sibling run</th>
                    <th>Segment kind</th>
                    <th>Net profit degradation</th>
                    <th>Profit factor degradation</th>
                    <th>Win rate degradation (pts)</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {report.degradation.map((entry) => (
                    <tr key={entry.siblingRunId}>
                      <td>
                        <Link href={`/backtest-runs/${entry.siblingRunId}`} className="mono">
                          {entry.siblingRunId.slice(0, 8)}…
                        </Link>
                      </td>
                      <td>
                        <SegmentTag segment={entry.segmentKind} />
                      </td>
                      <td className="num">{pct(entry.result.netProfitDegradationPct)}</td>
                      <td className="num">{pct(entry.result.profitFactorDegradationPct)}</td>
                      <td className="num">{entry.result.winRateDegradationPct.toFixed(1)}</td>
                      <td>
                        <Timestamp value={entry.createdAt} />
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
          title="Trade-removal concentration"
          hint={`Closed trades sorted by net P&L, largest contributor first — the cumulative curve answers whether the edge depends on a few extreme trades. Top ${report.tradeRemovalConcentration.topN} highlighted. Total net profit: ${report.tradeRemovalConcentration.totalNetProfit}.`}
        />
        {report.tradeRemovalConcentration.curve.length === 0 ? (
          <EmptyState title="No closed trades yet" />
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Trade</th>
                    <th>Net P&amp;L</th>
                    <th>Cumulative % of total net profit</th>
                  </tr>
                </thead>
                <tbody>
                  {report.tradeRemovalConcentration.curve.map((contribution, index) => (
                    <tr
                      key={contribution.tradeNumber}
                      style={index < report.tradeRemovalConcentration.topN ? { fontWeight: 600 } : undefined}
                    >
                      <td className="num">{index + 1}</td>
                      <td className="num">#{contribution.tradeNumber}</td>
                      <td className="num">{contribution.netPnl.toFixed(2)}</td>
                      <td className="num">{contribution.cumulativePct.toFixed(1)}%</td>
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
          title="Long / short breakdown"
          hint="longestLosingStreak and monthlyReturns are omitted here — both are shaped by the real interleaved trade sequence and would misrepresent a direction-filtered subset."
        />
        <CardBody flush>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Side</th>
                  <th>Closed trades</th>
                  <th>Net profit</th>
                  <th>Win rate</th>
                  <th>Profit factor</th>
                  <th>Payoff ratio</th>
                </tr>
              </thead>
              <tbody>
                {(["long", "short"] as const).map((side) => {
                  const m = report.directionalBreakdown[side];
                  return (
                    <tr key={side}>
                      <td>{side === "long" ? "Long" : "Short"}</td>
                      <td className="num">{m.closedTradeCount}</td>
                      <td className="num">{m.netProfit}</td>
                      <td className="num">{m.winRatePct.toFixed(1)}%</td>
                      <td className="num">{m.profitFactor === null ? "—" : m.profitFactor.toFixed(2)}</td>
                      <td className="num">{m.payoffRatio === null ? "—" : m.payoffRatio.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Not yet built"
          hint="AI_RESEARCH_HEDGE_FUND_SPEC.md §7.7/§15.8 spec 19 robustness test types; this slice honestly builds the four above. See ADR 0009."
        />
        <CardBody>
          <ul>
            {NOT_YET_BUILT.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="card-hint">
            Local-vs-TradingView parity and the repainting review already exist elsewhere in this app — see the
            Parity panel on the backtest-run page rather than duplicating it here.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
