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

interface BenchmarkComparisonPanel {
  result: { strategyReturnPct: number; benchmarkReturnPct: number; excessReturnPct: number } | undefined;
  reasonCode?: "NO_DATASET" | "NO_BARS_IN_WINDOW";
}

interface PercentileBand {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

interface MonteCarloFanResult {
  calculationVersion: string;
  iterations: number;
  seed: number;
  finalReturnPct: PercentileBand;
  maxDrawdownPct: PercentileBand;
}

interface ValidationLabReport {
  computedAt: string;
  targetRunId: string;
  segmentDistribution: { segmentKind: string; status: string; total: number }[];
  degradation: DegradationEntry[];
  tradeRemovalConcentration: { curve: TradeContribution[]; totalNetProfit: string; topN: number };
  directionalBreakdown: { long: SubsetMetrics; short: SubsetMetrics };
  benchmarkComparison: BenchmarkComparisonPanel;
  monteCarloFan: MonteCarloFanResult | undefined;
}

function pct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits)}%`;
}

const NOT_YET_BUILT = [
  "Parameter stability heatmap — needs child strategy versions per parameter variant, a real branching decision",
  "Neighbourhood survival — same dependency as above",
  "Cost / slippage sensitivity — needs re-running the backtest with a perturbed cost model",
  "Entry-delay and missed-trade simulation — same dependency",
  "Start-date sensitivity — needs re-running against shifted windows",
  "Symbol transfer — needs additional datasets for other markets",
  "Regime breakdown — BacktestSegmentKind has a REGIME value, but no regime classifier or producer exists anywhere in this repo yet",
  "Multiple-testing penalty — needs a real statistical correction methodology",
];

const BENCHMARK_REASON_TEXT: Record<NonNullable<BenchmarkComparisonPanel["reasonCode"]>, string> = {
  NO_DATASET: "This run has no linked dataset — only a run created against a real OHLCV dataset can compute this.",
  NO_BARS_IN_WINDOW: "The linked dataset has no bars inside this run's own [fromTs, toTs] window.",
};

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
          title="Benchmark comparison"
          hint="Total return only, over the same symbol and window — buy at the first bar's open, hold to the last bar's close. No risk adjustment, no statistical significance, and the benchmark side is frictionless while the strategy side already includes costs. Did the strategy beat just holding the asset, nothing more."
        />
        <CardBody>
          {report.benchmarkComparison.result ? (
            <dl className="dl">
              <dt>Strategy return</dt>
              <dd className="num">{report.benchmarkComparison.result.strategyReturnPct.toFixed(2)}%</dd>
              <dt>Buy-and-hold return</dt>
              <dd className="num">{report.benchmarkComparison.result.benchmarkReturnPct.toFixed(2)}%</dd>
              <dt>Excess (percentage points)</dt>
              <dd className="num">{report.benchmarkComparison.result.excessReturnPct.toFixed(2)}</dd>
            </dl>
          ) : (
            <EmptyState title="No benchmark available">
              {report.benchmarkComparison.reasonCode ? BENCHMARK_REASON_TEXT[report.benchmarkComparison.reasonCode] : null}
            </EmptyState>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Monte Carlo fan"
          hint="Bootstrap-resamples this run's own closed trades, with replacement, many times and reports percentile bands of the resulting equity paths — deterministic (a fixed seed, not true randomness), so re-loading this page never changes the fan. Measures trade-order luck alone: it reshuffles only outcomes this run actually had, so it says nothing about parameter robustness, regime sensitivity, or how a different set of trades might have gone."
        />
        <CardBody>
          {report.monteCarloFan ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th />
                    <th>p5</th>
                    <th>p25</th>
                    <th>p50</th>
                    <th>p75</th>
                    <th>p95</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Final return</td>
                    <td className="num">{report.monteCarloFan.finalReturnPct.p5.toFixed(2)}%</td>
                    <td className="num">{report.monteCarloFan.finalReturnPct.p25.toFixed(2)}%</td>
                    <td className="num">{report.monteCarloFan.finalReturnPct.p50.toFixed(2)}%</td>
                    <td className="num">{report.monteCarloFan.finalReturnPct.p75.toFixed(2)}%</td>
                    <td className="num">{report.monteCarloFan.finalReturnPct.p95.toFixed(2)}%</td>
                  </tr>
                  <tr>
                    <td>Max drawdown</td>
                    <td className="num">{report.monteCarloFan.maxDrawdownPct.p5.toFixed(2)}%</td>
                    <td className="num">{report.monteCarloFan.maxDrawdownPct.p25.toFixed(2)}%</td>
                    <td className="num">{report.monteCarloFan.maxDrawdownPct.p50.toFixed(2)}%</td>
                    <td className="num">{report.monteCarloFan.maxDrawdownPct.p75.toFixed(2)}%</td>
                    <td className="num">{report.monteCarloFan.maxDrawdownPct.p95.toFixed(2)}%</td>
                  </tr>
                </tbody>
              </table>
              <p className="card-hint">
                {report.monteCarloFan.iterations} resamples, seed {report.monteCarloFan.seed}, calculation v
                {report.monteCarloFan.calculationVersion}.
              </p>
            </div>
          ) : (
            <EmptyState title="No closed trades yet">A fan needs at least one closed trade to resample from.</EmptyState>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Not yet built"
          hint="AI_RESEARCH_HEDGE_FUND_SPEC.md §7.7/§15.8 spec 19 robustness test types; this slice honestly builds several of them, listed on this page. See ADR 0009."
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
