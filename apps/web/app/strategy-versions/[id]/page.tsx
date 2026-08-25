import Link from "next/link";
import { apiFetchSafe } from "../../../lib/api";
import { StateBadge } from "../../../components/Badge";
import { Alert, Card, CardBody, CardHead, EmptyState, Hash, Timestamp } from "../../../components/primitives";
import {
  CatalogueAlgoForm,
  DecisionForm,
  RequestVerificationForm,
  SaveDefinitionForm,
  SavePineForm,
} from "./StrategyForms";

interface StrategyVersionDetail {
  id: string;
  strategyId: string;
  parentVersionId: string | null;
  versionNumber: number;
  workflowState: string;
  definitionHash: string | null;
  pineSourceHash: string | null;
  manifestHash: string | null;
  changeReason: string | null;
  createdAt: string;
}

interface LineageEntry {
  id: string;
  parentVersionId: string;
  changeCategory: string;
  createdAt: string;
}

interface AuditEvent {
  id: string;
  action: string;
  actor: string;
  reason: string | null;
  createdAt: string;
}

interface BacktestRunSummary {
  id: string;
  runnerType: string;
  symbol: string;
  timeframe: string;
  segmentKind: string;
  status: string;
  createdAt: string;
}

interface BacktestRunPage {
  items: BacktestRunSummary[];
}

interface AlgoListItem {
  slug: string;
  name: string;
}

interface Me {
  role: string;
}

/** Cataloguing is an operator action — mirrors PUBLISHING_ROLES in routes/algo-library.ts. */
const CATALOGUING_ROLES = new Set(["OPERATOR", "ADMIN"]);

const TERMINAL_STATES = new Set(["PAPER_APPROVED", "REJECTED"]);

export default async function StrategyVersionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [versionResult, lineageResult, auditResult, runsResult, algosResult, meResult] = await Promise.all([
    apiFetchSafe<StrategyVersionDetail>(`/v1/strategy-versions/${id}`),
    apiFetchSafe<LineageEntry[]>(`/v1/strategy-versions/${id}/lineage`),
    apiFetchSafe<AuditEvent[]>(`/v1/strategy-versions/${id}/audit`),
    apiFetchSafe<BacktestRunPage>(`/v1/strategy-versions/${id}/backtest-runs`),
    apiFetchSafe<{ items: AlgoListItem[] }>("/v1/algos"),
    apiFetchSafe<Me>("/v1/me"),
  ]);

  if ("error" in versionResult) {
    return (
      <>
        <Link href="/" className="breadcrumb">
          ← Command Centre
        </Link>
        <Alert tone="error">Could not load strategy version. {versionResult.error.message}</Alert>
      </>
    );
  }

  const version = versionResult.data;
  const isTerminal = TERMINAL_STATES.has(version.workflowState);
  const hasDefinition = Boolean(version.definitionHash);
  const hasPine = Boolean(version.pineSourceHash);

  const runs = "error" in runsResult ? [] : runsResult.data.items;
  const succeededRuns = runs.filter((run) => run.status === "SUCCEEDED");
  const canCatalogue =
    version.workflowState === "PAPER_APPROVED" && hasPine && !("error" in meResult) && CATALOGUING_ROLES.has(meResult.data.role);

  return (
    <>
      <Link href="/" className="breadcrumb">
        ← Command Centre
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <div className="row">
            <h1>Strategy version v{version.versionNumber}</h1>
            <StateBadge state={version.workflowState} />
          </div>
          <p className="page-subtitle">
            Tested versions are immutable — any material change creates a child version.
          </p>
        </div>
      </div>

      {isTerminal && (
        <Alert tone={version.workflowState === "PAPER_APPROVED" ? "ok" : "warn"}>
          This version has reached a terminal state. It can no longer be edited or transitioned;
          continuing this line of research means creating a child version.
        </Alert>
      )}

      {canCatalogue && (
        <Card>
          <CardHead
            title="Catalogue this algo"
            hint="Adds this version to the Algo Library as a release, with evidence recomputed from one of its own runs (ADR 0015)."
          />
          <CardBody>
            <CatalogueAlgoForm
              strategyVersionId={id}
              algos={"error" in algosResult ? [] : algosResult.data.items}
              succeededRuns={succeededRuns}
              defaultSymbol={succeededRuns[0]?.symbol ?? runs[0]?.symbol ?? ""}
              defaultTimeframe={succeededRuns[0]?.timeframe ?? runs[0]?.timeframe ?? ""}
            />
          </CardBody>
        </Card>
      )}

      {version.workflowState === "PAPER_APPROVED" && (
        <Card>
          <CardHead
            title="Forward testing"
            hint="Run this approved version against real TradingView alerts with deterministic paper fills (CLAUDE.md 16)."
            actions={
              <Link href={`/strategy-versions/${id}/forward-deployments/new`} className="btn btn-primary">
                New forward deployment
              </Link>
            }
          />
        </Card>
      )}

      <Card>
        <CardHead title="Artefact identity" hint="Content hashes are what make a result reproducible." />
        <CardBody>
          <dl className="dl">
            <dt>Definition hash</dt>
            <dd>
              <Hash value={version.definitionHash} />
            </dd>
            <dt>Pine source hash</dt>
            <dd>
              <Hash value={version.pineSourceHash} />
            </dd>
            <dt>Manifest hash</dt>
            <dd>
              <Hash value={version.manifestHash} />
            </dd>
            <dt>Created</dt>
            <dd>
              <Timestamp value={version.createdAt} />
            </dd>
            {version.changeReason && (
              <>
                <dt>Change reason</dt>
                <dd>{version.changeReason}</dd>
              </>
            )}
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Lineage" />
        {"error" in lineageResult ? (
          <CardBody>
            <Alert tone="error">Could not load lineage. {lineageResult.error.message}</Alert>
          </CardBody>
        ) : lineageResult.data.length === 0 ? (
          <EmptyState title="Root version">This version has no parent.</EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Change</th>
                    <th>Parent version</th>
                    <th>Recorded (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {lineageResult.data.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.changeCategory}</td>
                      <td>
                        <Link className="mono" href={`/strategy-versions/${entry.parentVersionId}`}>
                          {entry.parentVersionId.slice(0, 8)}…
                        </Link>
                      </td>
                      <td>
                        <Timestamp value={entry.createdAt} />
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
        <CardHead
          title="Backtest runs"
          hint="Trades, equity, drawdown, metrics, and parity are read per run — open a run to see its evidence."
          actions={
            !isTerminal && hasPine ? (
              <Link href={`/strategy-versions/${id}/backtest-runs/new`} className="btn btn-primary">
                New backtest run
              </Link>
            ) : undefined
          }
        />
        {"error" in runsResult ? (
          <CardBody>
            <Alert tone="error">Could not load backtest runs. {runsResult.error.message}</Alert>
          </CardBody>
        ) : runsResult.data.items.length === 0 ? (
          <EmptyState title="No backtest runs yet">
            {isTerminal ? (
              "This version is terminal — no new runs can be launched against it."
            ) : hasPine ? (
              <Link href={`/strategy-versions/${id}/backtest-runs/new`}>Launch one against the local runner</Link>
            ) : (
              "Save a Pine source revision first — a run's source hash is what makes its result reproducible."
            )}
          </EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Runner</th>
                    <th>Symbol / timeframe</th>
                    <th>Segment</th>
                    <th>Status</th>
                    <th>Created (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {runsResult.data.items.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <Link href={`/backtest-runs/${run.id}`}>{run.runnerType}</Link>
                      </td>
                      <td className="mono">
                        {run.symbol} / {run.timeframe}
                      </td>
                      <td>{run.segmentKind}</td>
                      <td>
                        <StateBadge state={run.status} kind="runStatus" />
                      </td>
                      <td>
                        <Timestamp value={run.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        )}
      </Card>

      {!isTerminal && (
        <>
          <Card>
            <CardHead
              title="Strategy Definition (SDL)"
              hint="Stored once per version. Editing a tested version is not possible — create a child instead."
            />
            <CardBody>
              <SaveDefinitionForm strategyVersionId={id} alreadySet={hasDefinition} />
            </CardBody>
          </Card>

          <Card>
            <CardHead title="Pine Script revision" hint="Source is hashed verbatim; reformatting is a different revision." />
            <CardBody>
              <SavePineForm strategyVersionId={id} alreadySet={hasPine} />
            </CardBody>
          </Card>

          <Card>
            <CardHead
              title="TradingView verification"
              hint="TradingView is the acceptance environment — results are ingested as CSV, never screenshots."
            />
            <CardBody>
              <RequestVerificationForm strategyVersionId={id} />
            </CardBody>
          </Card>

          <Card>
            <CardHead
              title="Committee decision"
              hint="Both the strongest positive and the strongest rejection case are mandatory, including for approvals."
            />
            <CardBody>
              <DecisionForm
                strategyVersionId={id}
                versionNumber={version.versionNumber}
                workflowState={version.workflowState}
                hasDefinition={hasDefinition}
                hasPine={hasPine}
              />
            </CardBody>
          </Card>
        </>
      )}

      <Card>
        <CardHead title="Audit timeline" hint="Append-only. Every transition, decision, and override is recorded." />
        {"error" in auditResult ? (
          <CardBody>
            <Alert tone="error">Could not load audit timeline. {auditResult.error.message}</Alert>
          </CardBody>
        ) : auditResult.data.length === 0 ? (
          <EmptyState title="No audit events yet">
            Events appear here once this version is transitioned or decided upon.
          </EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When (UTC)</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {auditResult.data.map((event) => (
                    <tr key={event.id}>
                      <td>
                        <Timestamp value={event.createdAt} />
                      </td>
                      <td className="mono">{event.action}</td>
                      <td className="mono">{event.actor.slice(0, 8)}…</td>
                      <td>{event.reason ?? <span className="unset">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        )}
      </Card>
    </>
  );
}
