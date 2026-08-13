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
  const [result, kpisResult] = await Promise.all([
    apiFetchSafe<CampaignPage>("/v1/campaigns"),
    apiFetchSafe<DashboardKpis>("/v1/dashboard/kpis"),
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
