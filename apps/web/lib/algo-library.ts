import type { AlgoDelivery, AlgoDetail, AlgoSummary } from "@arf-os/contracts";
import { apiFetchSafe, type ApiError } from "./api";

/**
 * Typed algo-library reads for server components. Types come from
 * `@arf-os/contracts`, so a contract change breaks the build here rather than
 * silently rendering a stale shape (CLAUDE.md 18.5).
 */

export type { AlgoDelivery, AlgoDetail, AlgoSummary };

export type Result<T> = { data: T } | { error: ApiError | Error };

export interface AlgoFilters {
  status?: string | undefined;
  marketCategory?: string | undefined;
  symbol?: string | undefined;
  timeframe?: string | undefined;
}

export function listAlgos(filters: AlgoFilters = {}): Promise<Result<{ items: AlgoSummary[] }>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return apiFetchSafe<{ items: AlgoSummary[] }>(`/v1/algos${suffix}`);
}

export function getAlgo(slug: string): Promise<Result<AlgoDetail>> {
  return apiFetchSafe<AlgoDetail>(`/v1/algos/${encodeURIComponent(slug)}`);
}

/** Reading source is audited server-side — only call this from a page that means to. */
export function getAlgoSource(slug: string): Promise<Result<AlgoDelivery>> {
  return apiFetchSafe<AlgoDelivery>(`/v1/algos/${encodeURIComponent(slug)}/source`);
}
