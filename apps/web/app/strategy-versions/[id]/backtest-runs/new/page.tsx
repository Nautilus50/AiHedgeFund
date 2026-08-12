import Link from "next/link";
import { apiFetchSafe } from "../../../../../lib/api";
import { Alert, Card, CardBody, CardHead } from "../../../../../components/primitives";
import { NewBacktestRunForm } from "./NewBacktestRunForm";

interface StrategyVersionDetail {
  id: string;
  workflowState: string;
  pineSourceHash: string | null;
}

interface DatasetVersionOption {
  id: string;
  symbol: string;
  timeframe: string;
  fromTs: string;
  toTs: string;
  barCount: number;
}

interface DatasetVersionPage {
  items: DatasetVersionOption[];
}

const TERMINAL_STATES = new Set(["PAPER_APPROVED", "REJECTED"]);

export default async function NewBacktestRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: strategyVersionId } = await params;

  const [versionResult, datasetsResult] = await Promise.all([
    apiFetchSafe<StrategyVersionDetail>(`/v1/strategy-versions/${strategyVersionId}`),
    apiFetchSafe<DatasetVersionPage>(`/v1/dataset-versions?limit=100`),
  ]);

  const backLink = (
    <Link href={`/strategy-versions/${strategyVersionId}`} className="breadcrumb">
      ← Strategy version
    </Link>
  );

  if ("error" in versionResult) {
    return (
      <>
        {backLink}
        <Alert tone="error">Could not load strategy version. {versionResult.error.message}</Alert>
      </>
    );
  }

  const version = versionResult.data;

  if (TERMINAL_STATES.has(version.workflowState)) {
    return (
      <>
        {backLink}
        <Alert tone="warn">
          This version has reached a terminal state and can no longer take new backtest runs. Create a child version
          to continue researching this strategy.
        </Alert>
      </>
    );
  }

  if (!version.pineSourceHash) {
    return (
      <>
        {backLink}
        <Alert tone="warn">
          This version has no Pine source revision yet. Save one from the strategy version page before launching a
          backtest run — the run's source hash is what makes its result reproducible.
        </Alert>
      </>
    );
  }

  return (
    <>
      {backLink}

      <div className="page-head">
        <div className="page-title-group">
          <h1>New backtest run</h1>
          <p className="page-subtitle">
            Runs the local runner directly — a small, stateless evaluator of the SDL's signal expressions, not
            generated Pine source. See ADR 0005 for what it does and doesn&apos;t support.
          </p>
        </div>
      </div>

      <Card>
        <CardHead
          title="Run configuration"
          hint="Every field here is recorded permanently against the resulting run — nothing is defaulted silently."
        />
        <CardBody>
          {"error" in datasetsResult ? (
            <Alert tone="error">Could not load datasets. {datasetsResult.error.message}</Alert>
          ) : datasetsResult.data.items.length === 0 ? (
            <Alert tone="warn">
              No dataset versions exist in this organisation yet. There is no self-service dataset upload — one must
              be seeded before a local-runner backtest can run against it.
            </Alert>
          ) : (
            <NewBacktestRunForm
              strategyVersionId={strategyVersionId}
              sourceHash={version.pineSourceHash}
              datasets={datasetsResult.data.items}
            />
          )}
        </CardBody>
      </Card>
    </>
  );
}
