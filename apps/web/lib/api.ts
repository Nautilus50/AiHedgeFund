import "server-only";
import { auth } from "@clerk/nextjs/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code?: string;
  validationErrors?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails | undefined;

  constructor(status: number, problem: ProblemDetails | undefined) {
    super(problem?.detail ?? `API request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

/**
 * Server-only fetch wrapper: attaches the caller's Clerk session token as a
 * Bearer token, so apps/api's auth plugin resolves the same organisation-
 * scoped identity a direct API caller would get (CLAUDE.md 18.5 — "Central
 * typed API client. No direct database access from the web app.").
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const problem = (await response.json().catch(() => undefined)) as ProblemDetails | undefined;
    throw new ApiError(response.status, problem);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** For pages that should render an empty/error state rather than crash when the API/DB is unavailable. */
export async function apiFetchSafe<T>(path: string, options?: ApiFetchOptions): Promise<{ data: T } | { error: ApiError | Error }> {
  try {
    return { data: await apiFetch<T>(path, options) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}
