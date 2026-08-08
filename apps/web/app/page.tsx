import Link from "next/link";
import { apiFetchSafe } from "../lib/api";

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
    <main>
      <h1>ARF-OS Command Centre</h1>
      <p>
        <Link href="/campaigns/new">+ New campaign</Link>
      </p>

      {"error" in result ? (
        <p role="alert">Could not load campaigns: {result.error.message}</p>
      ) : result.data.items.length === 0 ? (
        <p>No campaigns yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {result.data.items.map((campaign) => (
              <tr key={campaign.id}>
                <td>
                  <Link href={`/campaigns/${campaign.id}`}>{campaign.name}</Link>
                </td>
                <td>{campaign.status}</td>
                <td>{new Date(campaign.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
