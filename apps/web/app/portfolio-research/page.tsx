import { apiFetchSafe } from "../../lib/api";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../../components/primitives";

interface StrategyEvidence {
  strategyId: string;
  strategyName: string;
  strategyVersionId: string;
  backtestRunId: string;
  segmentKind: string;
  symbol: string;
}

interface ExcludedStrategy {
  strategyId: string;
  strategyName: string;
  reasonCode: string;
}

interface SeriesCorrelationResult {
  coefficient: number | null;
  overlapDays: number;
  overlapPct: number;
  reasonCode?: string;
}

interface ExposureOverlapResult {
  overlapHours: number;
  jaccardPct: number;
}

interface PairCorrelation {
  strategyAId: string;
  strategyBId: string;
  returnCorrelation: SeriesCorrelationResult;
  drawdownCorrelation: SeriesCorrelationResult;
  exposureOverlap: ExposureOverlapResult;
  evidenceTierMismatch: boolean;
}

interface MarketConcentrationRow {
  symbol: string;
  count: number;
}

interface TurnoverRow {
  strategyId: string;
  strategyName: string;
  symbol: string;
  turnoverNotional: string;
  fees: string;
  turnoverPct: number;
  feePct: number;
}

interface PortfolioCorrelationReport {
  computedAt: string;
  methodologyNote: string;
  strategies: StrategyEvidence[];
  excludedStrategies: ExcludedStrategy[];
  pairCorrelations: PairCorrelation[];
  marketConcentration: MarketConcentrationRow[];
  turnoverConcentration: TurnoverRow[];
}

function strategyName(strategies: StrategyEvidence[], strategyId: string): string {
  return strategies.find((s) => s.strategyId === strategyId)?.strategyName ?? strategyId;
}

function formatCorrelation(result: SeriesCorrelationResult): string {
  if (result.coefficient === null) {
    return `insufficient overlap (${result.overlapDays} day${result.overlapDays === 1 ? "" : "s"}, ${result.overlapPct.toFixed(0)}% of union)`;
  }
  return `${result.coefficient.toFixed(3)} (${result.overlapDays} overlapping days, ${result.overlapPct.toFixed(0)}% of union)`;
}

export default async function PortfolioResearchPage() {
  const result = await apiFetchSafe<PortfolioCorrelationReport>("/v1/portfolio-research/correlation");

  return (
    <>
      <div className="page-head">
        <h1>Portfolio Research</h1>
        <p className="page-hint">
          Return correlation, drawdown correlation, exposure overlap, and market/turnover concentration across every
          PAPER_APPROVED strategy in this organisation — computed live from existing backtest evidence, no new table
          (see ADR 0011).
        </p>
      </div>

      {"error" in result ? (
        <Alert tone="error">Could not load portfolio research. {result.error.message}</Alert>
      ) : (
        <>
          <Card>
            <CardBody>
              <p className="page-hint">{result.data.methodologyNote}</p>
              <p className="page-hint">
                Computed <Timestamp value={result.data.computedAt} />.
              </p>
            </CardBody>
          </Card>

          {result.data.excludedStrategies.length > 0 && (
            <Card>
              <CardHead title="Excluded from this report" hint="PAPER_APPROVED strategies with no SUCCEEDED backtest run to draw evidence from." />
              <CardBody>
                <ul>
                  {result.data.excludedStrategies.map((s) => (
                    <li key={s.strategyId}>
                      {s.strategyName} — {s.reasonCode === "NO_SUCCEEDED_RUN" ? "no SUCCEEDED backtest run" : s.reasonCode}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHead title="Market concentration" hint="Selected strategies grouped by their representative run's symbol." />
            <CardBody>
              {result.data.marketConcentration.length === 0 ? (
                <EmptyState title="No PAPER_APPROVED strategies with evidence yet">
                  Approve a strategy version and give it a SUCCEEDED backtest run to see it here.
                </EmptyState>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.marketConcentration.map((row) => (
                      <tr key={row.symbol}>
                        <td>{row.symbol}</td>
                        <td>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHead
              title="Turnover / fee concentration"
              hint="Assumes every selected strategy's symbol is quoted in the same currency — unverified by the schema. Raw symbol shown so this can be eyeballed."
            />
            <CardBody>
              {result.data.turnoverConcentration.length === 0 ? (
                <EmptyState title="Nothing to show yet" />
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th>Symbol</th>
                      <th>Turnover notional</th>
                      <th>% of total turnover</th>
                      <th>Fees</th>
                      <th>% of total fees</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.turnoverConcentration.map((row) => (
                      <tr key={row.strategyId}>
                        <td>{row.strategyName}</td>
                        <td>{row.symbol}</td>
                        <td>{row.turnoverNotional}</td>
                        <td>{row.turnoverPct.toFixed(1)}%</td>
                        <td>{row.fees}</td>
                        <td>{row.feePct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHead
              title="Pairwise correlation and exposure overlap"
              hint="⚠ marks a pair whose representative runs come from different segment kinds (e.g. one in-sample, one out-of-sample) — don't read the coefficient as apples-to-apples without checking."
            />
            <CardBody>
              {result.data.pairCorrelations.length === 0 ? (
                <EmptyState title="Need at least two strategies with evidence to compute a pair">Nothing to compare yet.</EmptyState>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Pair</th>
                      <th>Return correlation</th>
                      <th>Drawdown correlation</th>
                      <th>Exposure overlap (Jaccard)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.pairCorrelations.map((pair) => (
                      <tr key={`${pair.strategyAId}-${pair.strategyBId}`}>
                        <td>
                          {pair.evidenceTierMismatch && <span title="Representative runs differ in segment kind">⚠ </span>}
                          {strategyName(result.data.strategies, pair.strategyAId)} × {strategyName(result.data.strategies, pair.strategyBId)}
                        </td>
                        <td>{formatCorrelation(pair.returnCorrelation)}</td>
                        <td>{formatCorrelation(pair.drawdownCorrelation)}</td>
                        <td>
                          {pair.exposureOverlap.jaccardPct.toFixed(1)}% ({pair.exposureOverlap.overlapHours.toFixed(1)}h)
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHead title="Not yet built" />
            <CardBody>
              <p className="page-hint">
                AI_RESEARCH_HEDGE_FUND_SPEC.md §7.11 spec's remaining Portfolio Researcher responsibilities — none
                improvised here. See ADR 0011.
              </p>
              <ul>
                <li>Signal overlap — needs indicator/entry-condition introspection this repo doesn't have</li>
                <li>Strategy-family concentration — no tagging/categorisation system exists</li>
                <li>Capacity assumptions — needs real liquidity/ADV data</li>
                <li>Portfolio-level stress tests — needs a real methodology, not improvised here</li>
                <li>Risk-budget proposals — needs a real methodology, not improvised here</li>
                <li>Strategy redundancy / replacement analysis — needs a real methodology, not improvised here</li>
              </ul>
            </CardBody>
          </Card>
        </>
      )}
    </>
  );
}
