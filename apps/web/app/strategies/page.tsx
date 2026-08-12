import Link from "next/link";
import { apiFetchSafe } from "../../lib/api";
import { StateBadge } from "../../components/Badge";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../../components/primitives";

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

/**
 * Every strategy across the organisation, not scoped to one campaign
 * (unlike the campaign detail page's strategies table, which reuses the
 * same `GET /v1/strategies` endpoint with a `campaignId` filter).
 *
 * State/market/timeframe/parity filtering from the original spec isn't
 * implemented yet — market/timeframe/parity live on strategy_definitions
 * and backtest_runs, not the strategies list query, and state filtering
 * would need to filter by each strategy's *latest* version's state, which
 * `listStrategies` doesn't support yet. Left for a follow-up rather than
 * building it speculatively here.
 */
export default async function StrategyLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const result = await apiFetchSafe<StrategyPage>(`/v1/strategies${query}`);

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
        <CardHead title="Strategies" />
        {"error" in result ? (
          <CardBody>
            <Alert tone="error">Could not load strategies. {result.error.message}</Alert>
          </CardBody>
        ) : result.data.items.length === 0 ? (
          <EmptyState title="No strategies yet">
            Strategies are created from a campaign — open a campaign and add one there.
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
            {result.data.nextCursor && (
              <CardBody>
                <Link href={`/strategies?cursor=${encodeURIComponent(result.data.nextCursor)}`} className="btn">
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
