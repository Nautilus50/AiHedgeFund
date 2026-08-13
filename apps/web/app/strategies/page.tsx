import Link from "next/link";
import { apiFetchSafe } from "../../lib/api";
import { humanise, StateBadge } from "../../components/Badge";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../../components/primitives";

// Matches apps/api/src/routes/strategies.ts's `WORKFLOW_STATES`/`PARITY_STATUSES`.
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

const PARITY_STATUSES = ["PASS", "WARN", "FAIL", "INSUFFICIENT_DATA"] as const;

interface StrategyListItem {
  id: string;
  name: string;
  campaignId: string;
  createdAt: string;
  latestVersionId?: string;
  latestVersionNumber?: number;
  latestWorkflowState?: string;
}

interface StrategyPage {
  items: StrategyListItem[];
  nextCursor?: string;
}

interface StrategyLibrarySearchParams {
  cursor?: string;
  workflowState?: string;
  symbol?: string;
  timeframe?: string;
  parityStatus?: string;
}

/** Builds the shared filter querystring (no cursor) reused for both the API call and the "next page" link. */
function buildFilterParams(params: StrategyLibrarySearchParams): URLSearchParams {
  const search = new URLSearchParams();
  if (params.workflowState) search.set("workflowState", params.workflowState);
  if (params.symbol) search.set("symbol", params.symbol);
  if (params.timeframe) search.set("timeframe", params.timeframe);
  if (params.parityStatus) search.set("parityStatus", params.parityStatus);
  return search;
}

/**
 * Every strategy across the organisation, not scoped to one campaign
 * (unlike the campaign detail page's strategies table, which reuses the
 * same `GET /v1/strategies` endpoint with a `campaignId` filter).
 *
 * Filters by state (the strategy's *latest* version's workflow state), SDL
 * market symbol/timeframe, and parity outcome (any run of any version) —
 * pushed down to real SQL in `listStrategies`, not filtered client-side.
 */
export default async function StrategyLibraryPage({
  searchParams,
}: {
  searchParams: Promise<StrategyLibrarySearchParams>;
}) {
  const params = await searchParams;
  const filterParams = buildFilterParams(params);
  const hasFilter = filterParams.size > 0;

  const apiParams = new URLSearchParams(filterParams);
  if (params.cursor) apiParams.set("cursor", params.cursor);
  const query = apiParams.size > 0 ? `?${apiParams.toString()}` : "";
  const result = await apiFetchSafe<StrategyPage>(`/v1/strategies${query}`);

  const nextPageHref = (() => {
    if (!("data" in result) || !result.data.nextCursor) return undefined;
    const next = new URLSearchParams(filterParams);
    next.set("cursor", result.data.nextCursor);
    return `/strategies?${next.toString()}`;
  })();

  return (
    <>
      <Link href="/" className="breadcrumb">
        ← Command Centre
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <h1>Strategy Library</h1>
          <p className="page-subtitle">Every strategy in your organisation, with its most recent immutable version.</p>
        </div>
        <Link href="/strategies/import" className="btn btn-primary">
          Import strategy
        </Link>
      </div>

      <Card>
        <CardHead title="Filters" hint="Applied server-side — state is the latest version's, parity is any run of any version's." />
        <CardBody>
          {/* Keyed on the active filters: without this, a client-side Link
              navigation reuses the same <select>/<input> DOM nodes, and
              `defaultValue` (uncontrolled) never re-applies — the control
              would keep showing a stale selection even after the filter was
              actually cleared. The key forces a full remount instead. */}
          <form
            method="get"
            key={filterParams.toString()}
            className="field-row"
            style={{ flexWrap: "wrap", alignItems: "flex-end" }}
          >
            <div className="field">
              <label htmlFor="workflowState">State</label>
              <select id="workflowState" name="workflowState" defaultValue={params.workflowState ?? ""}>
                <option value="">Any</option>
                {WORKFLOW_STATES.map((state) => (
                  <option key={state} value={state}>
                    {humanise(state)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="symbol">Symbol</label>
              <input id="symbol" name="symbol" defaultValue={params.symbol ?? ""} placeholder="BTCUSD" />
            </div>
            <div className="field">
              <label htmlFor="timeframe">Timeframe</label>
              <input id="timeframe" name="timeframe" defaultValue={params.timeframe ?? ""} placeholder="1h" />
            </div>
            <div className="field">
              <label htmlFor="parityStatus">Parity</label>
              <select id="parityStatus" name="parityStatus" defaultValue={params.parityStatus ?? ""}>
                <option value="">Any</option>
                {PARITY_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {humanise(status)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: "var(--sp-4)" }}>
              <button type="submit" className="btn btn-primary">
                Apply
              </button>
            </div>
            {hasFilter && (
              <div className="field" style={{ marginBottom: "var(--sp-4)" }}>
                <Link href="/strategies" className="btn">
                  Clear filters
                </Link>
              </div>
            )}
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Strategies" />
        {"error" in result ? (
          <CardBody>
            <Alert tone="error">Could not load strategies. {result.error.message}</Alert>
          </CardBody>
        ) : result.data.items.length === 0 ? (
          <EmptyState title={hasFilter ? "No strategies match these filters" : "No strategies yet"}>
            {hasFilter ? (
              <Link href="/strategies">Clear filters</Link>
            ) : (
              "Strategies are created from a campaign — open a campaign and add one there."
            )}
          </EmptyState>
        ) : (
          <>
            <CardBody flush>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th>Latest version</th>
                      <th>State</th>
                      <th>Created (UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.items.map((strategy) => (
                      <tr key={strategy.id}>
                        <td>
                          {strategy.latestVersionId ? (
                            <Link href={`/strategy-versions/${strategy.latestVersionId}`}>{strategy.name}</Link>
                          ) : (
                            strategy.name
                          )}
                        </td>
                        <td className="num">
                          {strategy.latestVersionNumber ? `v${strategy.latestVersionNumber}` : "—"}
                        </td>
                        <td>
                          {strategy.latestWorkflowState ? (
                            <StateBadge state={strategy.latestWorkflowState} />
                          ) : (
                            <span className="unset">—</span>
                          )}
                        </td>
                        <td>
                          <Timestamp value={strategy.createdAt} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
            {nextPageHref && (
              <CardBody>
                <Link href={nextPageHref} className="btn">
                  Next page →
                </Link>
              </CardBody>
            )}
          </>
        )}
      </Card>
    </>
  );
}
