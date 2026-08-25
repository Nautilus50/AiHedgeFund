import { v7 as uuidv7, validate as isUuid } from "uuid";

/**
 * Branded ID types prevent passing an OrganisationId where a CampaignId is
 * expected, even though both are plain strings at runtime (CLAUDE.md 7.2).
 */
export type OrganisationId = string & { readonly __brand: "OrganisationId" };
export type UserId = string & { readonly __brand: "UserId" };
export type CampaignId = string & { readonly __brand: "CampaignId" };
export type ResearchTaskId = string & { readonly __brand: "ResearchTaskId" };
export type StrategyId = string & { readonly __brand: "StrategyId" };
export type StrategyVersionId = string & { readonly __brand: "StrategyVersionId" };
export type StrategyDefinitionId = string & { readonly __brand: "StrategyDefinitionId" };
export type PineRevisionId = string & { readonly __brand: "PineRevisionId" };
export type ArtefactId = string & { readonly __brand: "ArtefactId" };
export type TradingViewVerificationId = string & { readonly __brand: "TradingViewVerificationId" };
export type ReportUploadId = string & { readonly __brand: "ReportUploadId" };
export type BacktestRunId = string & { readonly __brand: "BacktestRunId" };
export type DatasetVersionId = string & { readonly __brand: "DatasetVersionId" };
export type TradeId = string & { readonly __brand: "TradeId" };
export type MetricSnapshotId = string & { readonly __brand: "MetricSnapshotId" };
export type ParityReportId = string & { readonly __brand: "ParityReportId" };
export type CommitteeDecisionId = string & { readonly __brand: "CommitteeDecisionId" };
export type AuditEventId = string & { readonly __brand: "AuditEventId" };
export type HandoffId = string & { readonly __brand: "HandoffId" };
export type AlgoId = string & { readonly __brand: "AlgoId" };
export type AlgoReleaseId = string & { readonly __brand: "AlgoReleaseId" };
export type StatSnapshotId = string & { readonly __brand: "StatSnapshotId" };
export type IdempotencyKey = string & { readonly __brand: "IdempotencyKey" };

/** Generates a new UUIDv7-compatible identifier, branded to the requested ID type. */
export function generateId<TBrand extends string>(): TBrand & string {
  return uuidv7() as TBrand & string;
}

/** Runtime guard for an arbitrary branded UUID string. */
export function isValidId(value: string): boolean {
  return isUuid(value);
}
