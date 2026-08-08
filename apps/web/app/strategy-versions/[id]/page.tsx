import Link from "next/link";
import { apiFetchSafe } from "../../../lib/api";
import { DecisionForm, RequestVerificationForm, SaveDefinitionForm, SavePineForm } from "./StrategyForms";

interface StrategyVersionDetail {
  id: string;
  strategyId: string;
  parentVersionId: string | null;
  versionNumber: number;
  workflowState: string;
  definitionHash: string | null;
  pineSourceHash: string | null;
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

export default async function StrategyVersionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [versionResult, lineageResult, auditResult] = await Promise.all([
    apiFetchSafe<StrategyVersionDetail>(`/v1/strategy-versions/${id}`),
    apiFetchSafe<LineageEntry[]>(`/v1/strategy-versions/${id}/lineage`),
    apiFetchSafe<AuditEvent[]>(`/v1/strategy-versions/${id}/audit`),
  ]);

  if ("error" in versionResult) {
    return (
      <main>
        <p role="alert">Could not load strategy version: {versionResult.error.message}</p>
      </main>
    );
  }

  const version = versionResult.data;

  return (
    <main>
      <p>
        <Link href="/">← Command Centre</Link>
      </p>
      <h1>
        Strategy Version v{version.versionNumber} — {version.workflowState}
      </h1>
      <dl>
        <dt>Definition hash</dt>
        <dd>{version.definitionHash ?? "not set"}</dd>
        <dt>Pine source hash</dt>
        <dd>{version.pineSourceHash ?? "not set"}</dd>
        <dt>Created</dt>
        <dd>{new Date(version.createdAt).toLocaleString()}</dd>
      </dl>

      <section>
        <h2>Lineage</h2>
        {"error" in lineageResult ? (
          <p role="alert">Could not load lineage: {lineageResult.error.message}</p>
        ) : lineageResult.data.length === 0 ? (
          <p>Root version — no parent.</p>
        ) : (
          <ul>
            {lineageResult.data.map((entry) => (
              <li key={entry.id}>
                {entry.changeCategory} from <Link href={`/strategy-versions/${entry.parentVersionId}`}>{entry.parentVersionId}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SaveDefinitionForm strategyVersionId={id} />
      </section>

      <section>
        <SavePineForm strategyVersionId={id} />
      </section>

      <section>
        <RequestVerificationForm strategyVersionId={id} />
      </section>

      <section>
        <DecisionForm strategyVersionId={id} />
      </section>

      <section>
        <h2>Audit timeline</h2>
        {"error" in auditResult ? (
          <p role="alert">Could not load audit timeline: {auditResult.error.message}</p>
        ) : auditResult.data.length === 0 ? (
          <p>No audit events yet.</p>
        ) : (
          <ul>
            {auditResult.data.map((event) => (
              <li key={event.id}>
                {new Date(event.createdAt).toLocaleString()} — {event.action} by {event.actor}
                {event.reason ? `: ${event.reason}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
