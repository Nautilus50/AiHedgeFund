import Link from "next/link";
import { apiFetchSafe } from "../../../../../lib/api";
import { Alert, Card, CardBody, CardHead } from "../../../../../components/primitives";
import { NewForwardDeploymentForm } from "./NewForwardDeploymentForm";

interface StrategyVersionDetail {
  id: string;
  workflowState: string;
}

export default async function NewForwardDeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: strategyVersionId } = await params;

  const versionResult = await apiFetchSafe<StrategyVersionDetail>(`/v1/strategy-versions/${strategyVersionId}`);

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

  if (version.workflowState !== "PAPER_APPROVED") {
    return (
      <>
        {backLink}
        <Alert tone="warn">
          Forward deployments only run a PAPER_APPROVED strategy version — this one is {version.workflowState}.
        </Alert>
      </>
    );
  }

  return (
    <>
      {backLink}

      <div className="page-head">
        <div className="page-title-group">
          <h1>New forward deployment</h1>
          <p className="page-subtitle">
            Paper-only (CLAUDE.md 3.9) — real TradingView alerts, deterministic simulated fills, no live order
            routing. The webhook token is shown exactly once, right after creation.
          </p>
        </div>
      </div>

      <Card>
        <CardHead
          title="Deployment configuration"
          hint="Every field here is recorded permanently against the deployment — its fill model can never be edited afterward; a change means a new deployment."
        />
        <CardBody>
          <NewForwardDeploymentForm strategyVersionId={strategyVersionId} />
        </CardBody>
      </Card>
    </>
  );
}
