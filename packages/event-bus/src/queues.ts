import { z } from "zod";
import { AgentRole } from "@arf-os/contracts";

/** Every BullMQ queue the platform uses. Named centrally so producers and consumers can never drift on a string literal. */
export const QUEUE_NAMES = {
  reportParse: "report-parse",
  tradeNormalisation: "trade-normalisation",
  metricCalculation: "metric-calculation",
  equityReconstruction: "equity-reconstruction",
  parityCalculation: "parity-calculation",
  readModelRefresh: "read-model-refresh",
  agentRun: "agent-run",
  localRunnerExecution: "local-runner-execution",
  forwardSignalProcessing: "forward-signal-processing",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ReportParseJob = z.object({
  reportUploadId: z.string().uuid(),
  verificationId: z.string().uuid(),
  organisationId: z.string().uuid(),
  objectKey: z.string().min(1),
  kind: z.enum(["PERFORMANCE_SUMMARY", "LIST_OF_TRADES"]),
  /** The run this ledger belongs to, carried through from upload completion — see completeReportUpload's CompleteUploadInput. Only meaningful for a List of Trades. */
  backtestRunId: z.string().uuid().optional(),
});
export type ReportParseJob = z.infer<typeof ReportParseJob>;

export const TradeNormalisationJob = z.object({
  backtestRunId: z.string().uuid(),
  reportUploadId: z.string().uuid(),
});
export type TradeNormalisationJob = z.infer<typeof TradeNormalisationJob>;

export const MetricCalculationJob = z.object({
  backtestRunId: z.string().uuid(),
});
export type MetricCalculationJob = z.infer<typeof MetricCalculationJob>;

export const EquityReconstructionJob = z.object({
  backtestRunId: z.string().uuid(),
  initialCapital: z.string().min(1),
});
export type EquityReconstructionJob = z.infer<typeof EquityReconstructionJob>;

export const ParityCalculationJob = z.object({
  backtestRunId: z.string().uuid(),
  verificationId: z.string().uuid(),
});
export type ParityCalculationJob = z.infer<typeof ParityCalculationJob>;

export const ReadModelRefreshJob = z.object({
  organisationId: z.string().uuid(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().uuid(),
});
export type ReadModelRefreshJob = z.infer<typeof ReadModelRefreshJob>;

export const LocalRunnerExecutionJob = z.object({
  backtestRunId: z.string().uuid(),
});
export type LocalRunnerExecutionJob = z.infer<typeof LocalRunnerExecutionJob>;

export const ForwardSignalProcessingJob = z.object({
  deploymentId: z.string().uuid(),
  signalEventId: z.string().uuid(),
});
export type ForwardSignalProcessingJob = z.infer<typeof ForwardSignalProcessingJob>;

export const AgentRunJob = z.object({
  campaignId: z.string().uuid(),
  researchTaskId: z.string().uuid(),
  role: AgentRole,
});
export type AgentRunJob = z.infer<typeof AgentRunJob>;

/**
 * Separator for composite job ids. Deliberately NOT ":" — BullMQ reserves
 * that as its internal Redis key separator and rejects custom job ids
 * containing it ("Custom Id cannot contain :").
 */
const JOB_ID_SEPARATOR = "__";

/**
 * Deterministic BullMQ job id. Re-enqueueing the same logical unit of work
 * (e.g. an outbox relay retry after a crash) collapses onto the same job
 * instead of running twice — CLAUDE.md 3.6 requires every background job to
 * be idempotent.
 */
export function deterministicJobId(queue: QueueName, ...parts: string[]): string {
  return [queue, ...parts].join(JOB_ID_SEPARATOR);
}
