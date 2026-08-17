import Link from "next/link";
import { apiFetchSafe } from "../../../lib/api";
import { StateBadge } from "../../../components/Badge";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../../../components/primitives";
import { EquityDrawdownChart } from "../../../components/EquityDrawdownChart";
import { DeploymentActions } from "./DeploymentActions";

interface ForwardDeploymentDetail {
  id: string;
  strategyVersionId: string;
  currentVersionNumber: number;
  symbol: string;
  timeframe: string;
  initialCapital: string;
  fillModel: {
    fillModelVersion: string;
    latencyModel: { type: string; seconds: number };
    slippageModel: { type: string; value: number };
    commissionModel: { type: string; value: number };
    quantityModel: Record<string, unknown> & { type: string };
    stopTargetRule: { type: string };
  };
  timestampToleranceSeconds: number;
  maxDrawdownPctAlertThreshold: string | null;
  state: string;
  createdAt: string;
  activatedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  newerApprovedVersionExists: boolean;
}

interface ForwardDeploymentHealth {
  deploymentState: string;
  infrastructureHealth: string;
  infrastructureReasons: string[];
  strategyPerformanceHealth: string;
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

interface SignalEventRow {
  id: string;
  eventType: string;
  direction: string | null;
  processingStatus: string;
  rejectionReason: string | null;
  receivedAt: string;
}

interface HealthSnapshotRow {
  id: string;
  tickAt: string;
  infrastructureHealth: string;
  rejectionRate: string;
  strategyPerformanceHealth: string;
  currentDrawdownPct: string | null;
}

function quantityModelLabel(model: ForwardDeploymentDetail["fillModel"]["quantityModel"]): string {
  if (model.type === "percent_of_equity") return `${model.percent}% of equity`;
  if (model.type === "fixed") return `${model.quantity} units (fixed)`;
  if (model.type === "cash") return `${model.cashAmount} cash`;
  return model.type;
}

export default async function ForwardDeploymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [deploymentResult, healthResult, equityResult, drawdownResult, signalsResult, healthSnapshotsResult] = await Promise.all([
    apiFetchSafe<ForwardDeploymentDetail>(`/v1/forward-deployments/${id}`),
    apiFetchSafe<ForwardDeploymentHealth>(`/v1/forward-deployments/${id}/health`),
    apiFetchSafe<{ items: EquityPoint[] }>(`/v1/forward-deployments/${id}/equity`),
    apiFetchSafe<{ items: DrawdownPoint[] }>(`/v1/forward-deployments/${id}/drawdown`),
    apiFetchSafe<{ items: SignalEventRow[] }>(`/v1/forward-deployments/${id}/signals`),
    apiFetchSafe<{ items: HealthSnapshotRow[] }>(`/v1/forward-deployments/${id}/health-snapshots`),
  ]);

  if ("error" in deploymentResult) {
    return (
      <>
        <Link href="/" className="breadcrumb">
          ← Command Centre
        </Link>
        <Alert tone="error">Could not load forward deployment. {deploymentResult.error.message}</Alert>
      </>
    );
  }

  const deployment = deploymentResult.data;
  const { fillModel } = deployment;

  return (
    <>
      <Link href={`/strategy-versions/${deployment.strategyVersionId}`} className="breadcrumb">
        ← Strategy version
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <div className="row">
            <h1>Forward deployment</h1>
            <StateBadge state={deployment.state} kind="forwardDeployment" />
          </div>
          <p className="page-subtitle">
            Paper-only (CLAUDE.md 3.9). {deployment.symbol} / {deployment.timeframe}, strategy v{deployment.currentVersionNumber}.
          </p>
        </div>
        <DeploymentActions deploymentId={deployment.id} state={deployment.state} />
      </div>

      {deployment.newerApprovedVersionExists && (
        <Alert tone="warn">
          A newer PAPER_APPROVED version of this strategy exists. This deployment keeps running against the version
          it was created for — nothing here changes automatically (CLAUDE.md 3.4).
        </Alert>
      )}

      <Card>
        <CardHead title="Health" hint="Two independent axes — infrastructure and strategy performance are never conflated (CLAUDE.md 16.3). Polled, not pushed: CLAUDE.md 17.4 names SSE for this, deliberately deferred (ADR 0006)." />
        <CardBody>
          {"error" in healthResult ? (
            <Alert tone="error">Could not load health. {healthResult.error.message}</Alert>
          ) : (
            <dl className="dl">
              <dt>Infrastructure</dt>
              <dd>
                <StateBadge state={healthResult.data.infrastructureHealth} kind="health" />
                {healthResult.data.infrastructureReasons.length > 0 && (
                  <span className="field-hint"> — {healthResult.data.infrastructureReasons.join(", ")}</span>
                )}
              </dd>
              <dt>Strategy performance</dt>
              <dd>
                <StateBadge state={healthResult.data.strategyPerformanceHealth} kind="health" />
              </dd>
            </dl>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Health history"
          hint="Periodic snapshots of the two axes above, written by an operator-run sweep (ADR 0012) — not pushed live, same polling deviation as the Health card."
        />
        {"error" in healthSnapshotsResult ? (
          <CardBody>
            <Alert tone="error">Could not load health history. {healthSnapshotsResult.error.message}</Alert>
          </CardBody>
        ) : healthSnapshotsResult.data.items.length === 0 ? (
          <EmptyState title="No snapshots yet">
            Snapshots are written by an operator-run or platform-scheduled sweep, not automatically by this app.
          </EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Tick (UTC)</th>
                    <th>Infrastructure</th>
                    <th>Rejection rate</th>
                    <th>Strategy performance</th>
                    <th>Drawdown %</th>
                  </tr>
                </thead>
                <tbody>
                  {healthSnapshotsResult.data.items.map((snapshot) => (
                    <tr key={snapshot.id}>
                      <td>
                        <Timestamp value={snapshot.tickAt} />
                      </td>
                      <td>
                        <StateBadge state={snapshot.infrastructureHealth} kind="health" />
                      </td>
                      <td className="num">{(Number(snapshot.rejectionRate) * 100).toFixed(1)}%</td>
                      <td>
                        <StateBadge state={snapshot.strategyPerformanceHealth} kind="health" />
                      </td>
                      <td className="num">{snapshot.currentDrawdownPct ?? <span className="unset">—</span>}</td>
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
          hint="Reconstructed from paper fills alone — never a runner-reported summary (CLAUDE.md 26)."
          actions={
            <Link href={`/forward-deployments/${deployment.id}/drift`} className="btn">
              Drift report
            </Link>
          }
        />
        <CardBody>
          {"error" in equityResult || "error" in drawdownResult ? (
            <Alert tone="error">Could not load evidence.</Alert>
          ) : equityResult.data.items.length === 0 ? (
            <EmptyState title="No closed trades yet">Equity appears once the first position closes.</EmptyState>
          ) : (
            <EquityDrawdownChart
              equityPoints={equityResult.data.items}
              drawdownPoints={"error" in drawdownResult ? [] : drawdownResult.data.items}
              isStale={deployment.state !== "ACTIVE" && deployment.state !== "PAUSED"}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Configuration" hint="Declared and versioned at creation — never edited afterward; a change means a new deployment (CLAUDE.md 16.2)." />
        <CardBody>
          <dl className="dl">
            <dt>Initial capital</dt>
            <dd className="mono">{deployment.initialCapital}</dd>
            <dt>Timestamp tolerance</dt>
            <dd>{deployment.timestampToleranceSeconds}s</dd>
            <dt>Fill model version</dt>
            <dd className="mono">{fillModel.fillModelVersion}</dd>
            <dt>Latency</dt>
            <dd>{fillModel.latencyModel.seconds}s (fixed)</dd>
            <dt>Slippage</dt>
            <dd>
              {fillModel.slippageModel.type}: {fillModel.slippageModel.value}
            </dd>
            <dt>Commission</dt>
            <dd>
              {fillModel.commissionModel.type}: {fillModel.commissionModel.value}
            </dd>
            <dt>Quantity model</dt>
            <dd>{quantityModelLabel(fillModel.quantityModel)}</dd>
            <dt>Stop/target rule</dt>
            <dd className="mono">{fillModel.stopTargetRule.type}</dd>
            <dt>Drawdown alert threshold</dt>
            <dd>{deployment.maxDrawdownPctAlertThreshold ? `${deployment.maxDrawdownPctAlertThreshold}%` : <span className="unset">Not configured</span>}</dd>
            <dt>Created</dt>
            <dd>
              <Timestamp value={deployment.createdAt} />
            </dd>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Signal events" hint="Every inbound alert, accepted or rejected — the raw payload is always preserved (CLAUDE.md 16.1)." />
        {"error" in signalsResult ? (
          <CardBody>
            <Alert tone="error">Could not load signal events. {signalsResult.error.message}</Alert>
          </CardBody>
        ) : signalsResult.data.items.length === 0 ? (
          <EmptyState title="No signals received yet">
            Point your TradingView alert&apos;s webhook at this deployment&apos;s token to start receiving them.
          </EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Received (UTC)</th>
                    <th>Event</th>
                    <th>Direction</th>
                    <th>Status</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {signalsResult.data.items.map((signal) => (
                    <tr key={signal.id}>
                      <td>
                        <Timestamp value={signal.receivedAt} />
                      </td>
                      <td className="mono">{signal.eventType}</td>
                      <td>{signal.direction ?? <span className="unset">—</span>}</td>
                      <td>
                        <StateBadge state={signal.processingStatus} kind="signalProcessing" />
                      </td>
                      <td>{signal.rejectionReason ?? <span className="unset">—</span>}</td>
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
