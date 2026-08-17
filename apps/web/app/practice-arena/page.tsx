import Link from "next/link";
import { apiFetchSafe } from "../../lib/api";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../../components/primitives";
import { NewBenchmarkTaskForm } from "./NewBenchmarkTaskForm";

interface BenchmarkTaskItem {
  id: string;
  role: string;
  objective: string;
  visibility: "VISIBLE" | "HIDDEN";
  createdAt: string;
}

export default async function PracticeArenaPage() {
  const result = await apiFetchSafe<{ items: BenchmarkTaskItem[] }>("/v1/benchmark-tasks");

  return (
    <>
      <div className="page-head">
        <h1>Practice Arena</h1>
        <p className="page-hint">
          Blind benchmark tasks, run against any prompt version — DRAFT or APPROVED — through the same agent-runtime
          path real research uses. Human-graded, not model-graded: no live LLM provider exists in this deployment to
          judge output automatically (see ADR 0010).
        </p>
      </div>

      <Card>
        <CardHead title="Benchmark tasks" hint="Newest first. Hidden tasks are visible only to whoever created them." />
        <CardBody>
          {"error" in result ? (
            <Alert tone="error">Could not load benchmark tasks. {result.error.message}</Alert>
          ) : result.data.items.length === 0 ? (
            <EmptyState title="No benchmark tasks yet">Create one below to start practising an agent role.</EmptyState>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Objective</th>
                  <th>Visibility</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <Link href={`/practice-arena/${task.id}`}>{task.role}</Link>
                    </td>
                    <td>{task.objective}</td>
                    <td>{task.visibility === "HIDDEN" ? "Hidden" : "Visible"}</td>
                    <td>
                      <Timestamp value={task.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHead title="New benchmark task" />
        <CardBody>
          <NewBenchmarkTaskForm />
        </CardBody>
      </Card>
    </>
  );
}
