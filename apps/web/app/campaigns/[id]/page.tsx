import Link from "next/link";
import { apiFetchSafe } from "../../../lib/api";
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
      <main>
        <p role="alert">Could not load campaign: {campaignResult.error.message}</p>
      </main>
    );
  }

  const campaign = campaignResult.data;

  return (
    <main>
      <p>
        <Link href="/">← Command Centre</Link>
      </p>
      <h1>{campaign.name}</h1>
      <p>
        <strong>Status:</strong> {campaign.status}
      </p>
      <p>{campaign.brief}</p>
      <p>
        <strong>Markets:</strong> {campaign.allowedMarkets.join(", ")}
      </p>

      <h2>Strategies</h2>
      {"error" in strategiesResult ? (
        <p role="alert">Could not load strategies: {strategiesResult.error.message}</p>
      ) : strategiesResult.data.items.length === 0 ? (
        <p>No strategies yet.</p>
      ) : (
        <ul>
          {strategiesResult.data.items.map((strategy) => (
            <li key={strategy.id}>
              {strategy.latestVersionId ? (
                <Link href={`/strategy-versions/${strategy.latestVersionId}`}>
                  {strategy.name} (v{strategy.latestVersionNumber}, {strategy.latestWorkflowState})
                </Link>
              ) : (
                strategy.name
              )}
            </li>
          ))}
        </ul>
      )}

      <NewStrategyForm campaignId={id} />
    </main>
  );
}
