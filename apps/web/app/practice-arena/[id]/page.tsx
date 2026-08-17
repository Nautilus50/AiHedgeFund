import Link from "next/link";
import { apiFetchSafe } from "../../../lib/api";
import { StateBadge } from "../../../components/Badge";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../../../components/primitives";
import { RunPracticeTaskForm } from "./RunPracticeTaskForm";
import { ReviewPracticeRunForm } from "./ReviewPracticeRunForm";

interface BenchmarkTaskDetail {
  id: string;
  role: string;
  objective: string;
  visibility: "VISIBLE" | "HIDDEN";
  createdAt: string;
}

interface PromptOption {
  id: string;
  role: string;
  semanticVersion: string;
  status: string;
}

interface PracticeRunItem {
  id: string;
  promptId: string;
  status: string;
  output: { result?: unknown } | { reasonCode?: string; issues?: string[] } | null;
  humanReviewScore: string | null;
  humanReviewNotes: string | null;
  humanReviewedAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

export default async function BenchmarkTaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const taskResult = await apiFetchSafe<BenchmarkTaskDetail>(`/v1/benchmark-tasks/${id}`);
  if ("error" in taskResult) {
    return (
      <>
        <Link href="/practice-arena" className="breadcrumb">
          ← Practice Arena
        </Link>
        <Alert tone="error">Could not load benchmark task. {taskResult.error.message}</Alert>
      </>
    );
  }
  const task = taskResult.data;

  const [promptsResult, runsResult] = await Promise.all([
    apiFetchSafe<{ items: PromptOption[] }>(`/v1/prompts?role=${task.role}`),
    apiFetchSafe<{ items: PracticeRunItem[] }>(`/v1/benchmark-tasks/${id}/practice-runs`),
  ]);

  const prompts = "error" in promptsResult ? [] : promptsResult.data.items;

  return (
    <>
      <Link href="/practice-arena" className="breadcrumb">
        ← Practice Arena
      </Link>

      <div className="page-head">
        <h1>{task.role}</h1>
        <p className="page-hint">{task.objective}</p>
        <p className="page-hint">
          {task.visibility === "HIDDEN" ? "Hidden — only the creator can see this task." : "Visible to the organisation."}{" "}
          Created <Timestamp value={task.createdAt} />.
        </p>
      </div>

      <Card>
        <CardHead title="Run against a prompt" hint="DRAFT or APPROVED — a practice run is not restricted to the currently-approved prompt." />
        <CardBody>
          <RunPracticeTaskForm benchmarkTaskId={id} prompts={prompts} />
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Practice runs"
          hint="schemaValid/costUsd/latencyMs are recorded for future comparability but carry no signal under the dev fixture provider — only the human review score is a real score this slice."
        />
        <CardBody>
          {"error" in runsResult ? (
            <Alert tone="error">Could not load practice runs. {runsResult.error.message}</Alert>
          ) : runsResult.data.items.length === 0 ? (
            <EmptyState title="No practice runs yet">Run this task against a prompt above.</EmptyState>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Output</th>
                  <th>Review score</th>
                  <th>Review notes</th>
                  <th>Started</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runsResult.data.items.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <StateBadge state={run.status} kind="runStatus" />
                    </td>
                    <td>
                      <pre className="output-preview">{JSON.stringify(run.output, null, 2)}</pre>
                    </td>
                    <td>{run.humanReviewScore ?? "—"}</td>
                    <td>{run.humanReviewNotes ?? "—"}</td>
                    <td>
                      <Timestamp value={run.createdAt} />
                    </td>
                    <td>{run.status === "SUCCEEDED" && <ReviewPracticeRunForm benchmarkTaskId={id} practiceRunId={run.id} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </>
  );
}
