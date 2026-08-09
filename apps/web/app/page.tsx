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

export default async function CommandCentrePage() {
  const result = await apiFetchSafe<CampaignPage>("/v1/campaigns");

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
