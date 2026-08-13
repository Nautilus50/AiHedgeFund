import Link from "next/link";
import { apiFetchSafe } from "../lib/api";
import { StateBadge } from "../components/Badge";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../components/primitives";

interface CampaignSummary {
  id: string;
  name: string;
  brief: string;
  status: string;
  createdAt: string;
}

interface CampaignPage {
  items: CampaignSummary[];
  nextCursor?: string;
}

interface DashboardKpis {
  campaigns: { total: number };
  strategies: { total: number; byWorkflowState: Record<string, number> };
  backtestRuns: { total: number; byStatus: Record<string, number>; byRunnerType: Record<string, number> };
  datasets: { total: number };
  parity: { total: number; byStatus: Record<string, number> };
}

interface RecentDecision {
  id: string;
  decision: string;
  strategyVersionId: string;
  strategyName: string;
  createdAt: string;
}

interface ParseFailure {
  id: string;
  verificationId: string;
  strategyVersionId: string;
  strategyName: string;
  kind: string;
}

interface QueueDepth {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

interface OperationsSummary {
  pendingVerifications: number;
  recentDecisions: RecentDecision[];
  parseFailures: ParseFailure[];
  queueDepths: QueueDepth[];
}

const WORKFLOW_STATES = [
  "CAMPAIGN_BACKLOG",
  "IDEA_RESEARCH",
  "HYPOTHESIS_DRAFT",
  "PINE_DEVELOPMENT",
  "TRADINGVIEW_VERIFICATION",
  "PAPER_APPROVAL_REVIEW",
  "PAPER_APPROVED",
  "REJECTED",
  "BLOCKED",
] as const;

const RUN_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED_RETRYABLE", "FAILED_TERMINAL", "CANCELLED"] as const;

const PARITY_STATUSES = ["PASS", "WARN", "FAIL", "INSUFFICIENT_DATA"] as const;

function BreakdownList({
  counts,
  states,
  kind,
}: {
  counts: Record<string, number>;
  states: readonly string[];
  kind: "workflow" | "runStatus" | "parity";
}) {
  const nonZero = states.filter((s) => (counts[s] ?? 0) > 0);
  if (nonZero.length === 0) {
    return <span className="unset">none yet</span>;
  }
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: "var(--sp-3)" }}>
      {nonZero.map((s) => (
        <span key={s} className="row" style={{ gap: "6px" }}>
          <StateBadge state={s} kind={kind} />
          <span className="num">{counts[s]}</span>
        </span>
      ))}
    </div>
  );
}

export default async function CommandCentrePage() {
  const [result, kpisResult, operationsResult] = await Promise.all([
    apiFetchSafe<CampaignPage>("/v1/campaigns"),
    apiFetchSafe<DashboardKpis>("/v1/dashboard/kpis"),
    apiFetchSafe<OperationsSummary>("/v1/operations/summary"),
  ]);

  return (
    <>
      <div className="page-head">
        <div className="page-title-group">
          <h1>Command Centre</h1>
          <p className="page-subtitle">Research campaigns in your organisation.</p>
        </div>
        <Link href="/campaigns/new" className="btn btn-primary">
          New campaign
        </Link>
      </div>

      <Card>
        <CardHead title="Overview" hint="Real counts from the database, organisation-scoped — not sampled from a paginated list." />
        {"error" in kpisResult ? (
          <CardBody>
            <Alert tone="error">Could not load KPIs. {kpisResult.error.message}</Alert>
          </CardBody>
        ) : (
          <CardBody>
            <div className="stat-grid" style={{ marginBottom: "var(--sp-5)" }}>
              <div className="stat-cell">
                <div className="stat-label">Campaigns</div>
                <div className="stat-value">{kpisResult.data.campaigns.total}</div>
              </div>
              <div className="stat-cell">
                <div className="stat-label">Strategies</div>
                <div className="stat-value">{kpisResult.data.strategies.total}</div>
              </div>
              <div className="stat-cell">
                <div className="stat-label">Backtest runs</div>
                <div className="stat-value">{kpisResult.data.backtestRuns.total}</div>
              </div>
              <div className="stat-cell">
                <div className="stat-label">Datasets</div>
                <div className="stat-value">{kpisResult.data.datasets.total}</div>
              </div>
              <div className="stat-cell">
                <div className="stat-label">Parity checks</div>
                <div className="stat-value">{kpisResult.data.parity.total}</div>
              </div>
            </div>

            <dl className="dl">
              <dt>Strategy pipeline</dt>
              <dd>
                <BreakdownList counts={kpisResult.data.strategies.byWorkflowState} states={WORKFLOW_STATES} kind="workflow" />
              </dd>
              <dt>Backtest run status</dt>
              <dd>
                <BreakdownList counts={kpisResult.data.backtestRuns.byStatus} states={RUN_STATUSES} kind="runStatus" />
              </dd>
              <dt>Parity outcome</dt>
              <dd>
                <BreakdownList counts={kpisResult.data.parity.byStatus} states={PARITY_STATUSES} kind="parity" />
              </dd>
            </dl>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHead
          title="Operations"
          hint="What needs a human right now, and what the background jobs are doing (CLAUDE.md 20)."
        />
        {"error" in operationsResult ? (
          <CardBody>
            <Alert tone="error">Could not load operations. {operationsResult.error.message}</Alert>
          </CardBody>
        ) : (
          <CardBody>
            <dl className="dl">
              <dt>Pending verifications</dt>
              <dd className="num">{operationsResult.data.pendingVerifications}</dd>

              <dt>Queue depth</dt>
              <dd>
                {operationsResult.data.queueDepths.length === 0 ? (
                  <span className="unset">not available</span>
                ) : (
                  <div className="row" style={{ flexWrap: "wrap", gap: "var(--sp-3)" }}>
                    {operationsResult.data.queueDepths
                      .filter((q) => q.waiting + q.active + q.delayed + q.failed > 0)
                      .map((q) => (
                        <span key={q.queue} className="mono" style={{ fontSize: "0.85em" }}>
                          {q.queue}: {q.waiting}w / {q.active}a / {q.failed}f
                        </span>
                      ))}
                    {operationsResult.data.queueDepths.every((q) => q.waiting + q.active + q.delayed + q.failed === 0) && (
                      <span className="unset">all queues empty</span>
                    )}
                  </div>
                )}
              </dd>

              <dt>Recent decisions</dt>
              <dd>
                {operationsResult.data.recentDecisions.length === 0 ? (
                  <span className="unset">none yet</span>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: "1.1em" }}>
                    {operationsResult.data.recentDecisions.map((d) => (
                      <li key={d.id}>
                        <Link href={`/strategy-versions/${d.strategyVersionId}`}>{d.strategyName}</Link>{" "}
                        <StateBadge state={d.decision} kind="decision" /> <Timestamp value={d.createdAt} />
                      </li>
                    ))}
                  </ul>
                )}
              </dd>

              <dt>Parse failures</dt>
              <dd>
                {operationsResult.data.parseFailures.length === 0 ? (
                  <span className="unset">none</span>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: "1.1em" }}>
                    {operationsResult.data.parseFailures.map((f) => (
                      <li key={f.id}>
                        <Link href={`/strategy-versions/${f.strategyVersionId}`}>{f.strategyName}</Link> — {f.kind}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
          </CardBody>
        )}
      </Card>

      {"error" in result ? (
        <Alert tone="error">
          Could not load campaigns. {result.error.message}
        </Alert>
      ) : (
        <Card>
          <CardHead
            title="Campaigns"
            hint={
              result.data.items.length === 1
                ? "1 campaign"
                : `${result.data.items.length} campaigns`
            }
          />
          {result.data.items.length === 0 ? (
            <EmptyState title="No campaigns yet">
              A campaign scopes a line of research — its objective, markets, and the
              strategies produced under it.
            </EmptyState>
          ) : (
            <CardBody flush>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Created (UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.items.map((campaign) => (
                      <tr key={campaign.id}>
                        <td>
                          <Link href={`/campaigns/${campaign.id}`}>{campaign.name}</Link>
                        </td>
                        <td>
                          <StateBadge state={campaign.status} kind="campaign" />
                        </td>
                        <td>
                          <Timestamp value={campaign.createdAt} dateOnly />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          )}
        </Card>
      )}
    </>
  );
}
