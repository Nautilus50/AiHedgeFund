import Link from "next/link";
import { apiFetchSafe } from "../../../lib/api";
import { StateBadge } from "../../../components/Badge";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../../../components/primitives";
import { NewStrategyForm } from "./NewStrategyForm";

interface CampaignDetail {
  id: string;
  name: string;
  brief: string;
  status: string;
  allowedMarkets: string[];
  createdAt: string;
}

interface StrategyListItem {
  id: string;
  name: string;
  latestVersionId?: string;
  latestVersionNumber?: number;
  latestWorkflowState?: string;
}

interface StrategyPage {
  items: StrategyListItem[];
}

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [campaignResult, strategiesResult] = await Promise.all([
    apiFetchSafe<CampaignDetail>(`/v1/campaigns/${id}`),
    apiFetchSafe<StrategyPage>(`/v1/strategies?campaignId=${id}`),
  ]);

  if ("error" in campaignResult) {
    return (
      <>
        <Link href="/" className="breadcrumb">
          ← Command Centre
        </Link>
        <Alert tone="error">Could not load campaign. {campaignResult.error.message}</Alert>
      </>
    );
  }

  const campaign = campaignResult.data;
  const markets = Array.isArray(campaign.allowedMarkets) ? campaign.allowedMarkets : [];

  return (
    <>
      <Link href="/" className="breadcrumb">
        ← Command Centre
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <div className="row">
            <h1>{campaign.name}</h1>
            <StateBadge state={campaign.status} kind="campaign" />
          </div>
          <p className="page-subtitle">{campaign.brief}</p>
        </div>
      </div>

      <Card>
        <CardHead title="Campaign" />
        <CardBody>
          <dl className="dl">
            <dt>Allowed markets</dt>
            <dd>{markets.length > 0 ? markets.join(", ") : <span className="unset">none specified</span>}</dd>
            <dt>Created</dt>
            <dd>
              <Timestamp value={campaign.createdAt} />
            </dd>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Strategies"
          hint="Each row shows its most recent immutable version and where that version sits in the lifecycle."
        />
        {"error" in strategiesResult ? (
          <CardBody>
            <Alert tone="error">Could not load strategies. {strategiesResult.error.message}</Alert>
          </CardBody>
        ) : strategiesResult.data.items.length === 0 ? (
          <EmptyState title="No strategies yet">
            Create one below to begin the definition, Pine, and verification chain.
          </EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Latest version</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {strategiesResult.data.items.map((strategy) => (
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHead title="New strategy" hint="Creates the strategy and its first immutable version." />
        <CardBody>
          <NewStrategyForm campaignId={id} />
        </CardBody>
      </Card>
    </>
  );
}
