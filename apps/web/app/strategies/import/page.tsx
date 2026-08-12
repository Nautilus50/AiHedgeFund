import Link from "next/link";
import { apiFetchSafe } from "../../../lib/api";
import { Alert, Card, CardBody, CardHead } from "../../../components/primitives";
import { ImportStrategyForm } from "./ImportStrategyForm";

interface CampaignSummary {
  id: string;
  name: string;
}

interface CampaignPage {
  items: CampaignSummary[];
}

export default async function ImportStrategyPage({
  searchParams,
}: {
  searchParams: Promise<{ name?: string; symbol?: string; timeframe?: string; origin?: string }>;
}) {
  const params = await searchParams;
  const result = await apiFetchSafe<CampaignPage>("/v1/campaigns");

  return (
    <>
      <Link href="/strategies" className="breadcrumb">
        ← Strategy Library
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <h1>Import strategy</h1>
          <p className="page-subtitle">
            Files a Pine v6 source as a new, immutable Strategy Version — the same two commands the strategy
            detail page's own forms use, chained into one step.
          </p>
        </div>
      </div>

      <Card>
        <CardHead
          title="New strategy from Pine source"
          hint="Creates the strategy, its first version, and its Pine revision together."
        />
        <CardBody>
          {"error" in result ? (
            <Alert tone="error">Could not load campaigns. {result.error.message}</Alert>
          ) : (
            <ImportStrategyForm
              campaigns={result.data.items}
              defaultName={params.name ?? ""}
              defaultSymbol={params.symbol ?? ""}
              defaultTimeframe={params.timeframe ?? ""}
              defaultOrigin={params.origin ?? ""}
            />
          )}
        </CardBody>
      </Card>
    </>
  );
}
