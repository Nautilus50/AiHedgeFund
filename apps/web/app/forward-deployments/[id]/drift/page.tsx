import Link from "next/link";
import { apiFetchSafe } from "../../../../lib/api";
import { Alert, Card, CardBody, CardHead, EmptyState } from "../../../../components/primitives";
import { SegmentTag } from "../../../../components/Provenance";

interface DegradationResult {
  netProfitDegradationPct: number | null;
  profitFactorDegradationPct: number | null;
  winRateDegradationPct: number;
}

interface ForwardDriftReport {
  methodologyNote: string;
  baseline?: { backtestRunId: string; segmentKind: string };
  reasonCode?: "NO_BASELINE_RUN" | "INSUFFICIENT_FORWARD_TRADES";
  closedForwardTradeCount?: number;
  result?: DegradationResult;
}

function pct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits)}%`;
}

export default async function ForwardDriftReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const result = await apiFetchSafe<ForwardDriftReport>(`/v1/forward-deployments/${id}/drift-report`);

  if ("error" in result) {
    return (
      <>
        <Link href={`/forward-deployments/${id}`} className="breadcrumb">
          ← Forward deployment
        </Link>
        <Alert tone="error">Could not load the drift report. {result.error.message}</Alert>
      </>
    );
  }

  const report = result.data;

  return (
    <>
      <Link href={`/forward-deployments/${id}`} className="breadcrumb">
        ← Forward deployment
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <h1>Drift report</h1>
          <p className="page-subtitle">{report.methodologyNote}</p>
        </div>
      </div>

      <Card>
        <CardHead
          title="Backtest-vs-forward degradation"
          hint="One representative backtest run for this deployment's strategy version, compared against every closed paper trade so far."
        />
        <CardBody>
          {report.reasonCode === "NO_BASELINE_RUN" ? (
            <EmptyState title="No baseline backtest run yet">
              This strategy version has no SUCCEEDED backtest run to compare against. Run a backtest first.
            </EmptyState>
          ) : report.reasonCode === "INSUFFICIENT_FORWARD_TRADES" ? (
            <EmptyState title="Not enough closed forward trades yet">
              {report.closedForwardTradeCount ?? 0} closed trade(s) so far — a comparison needs at least 5, since
              fewer would be dominated by whichever trade closed most recently rather than showing anything
              resembling drift.
            </EmptyState>
          ) : report.baseline && report.result ? (
            <dl className="dl">
              <dt>Baseline run</dt>
              <dd>
                <Link href={`/backtest-runs/${report.baseline.backtestRunId}`} className="mono">
                  {report.baseline.backtestRunId.slice(0, 8)}…
                </Link>{" "}
                <SegmentTag segment={report.baseline.segmentKind} />
              </dd>
              <dt>Closed forward trades</dt>
              <dd className="num">{report.closedForwardTradeCount}</dd>
              <dt>Net profit degradation</dt>
              <dd className="num">{pct(report.result.netProfitDegradationPct)}</dd>
              <dt>Profit factor degradation</dt>
              <dd className="num">{pct(report.result.profitFactorDegradationPct)}</dd>
              <dt>Win rate degradation (pts)</dt>
              <dd className="num">{report.result.winRateDegradationPct.toFixed(1)}</dd>
            </dl>
          ) : (
            <EmptyState title="Nothing to show yet" />
          )}
        </CardBody>
      </Card>
    </>
  );
}
