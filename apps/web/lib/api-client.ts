"use client";

import { useCallback, useMemo } from "react";
import { useAuth } from "@clerk/nextjs";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface ClientFetchOptions extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

/**
 * Client-side counterpart to lib/api.ts's apiFetch, for the one flow that
 * genuinely needs to run in the browser: uploading a file directly from the
 * user's machine to R2 via a presigned URL (server actions can't stream a
 * browser File object). Everything else should prefer a Server Action.
 */
export function useApiClient() {
  const { getToken } = useAuth();

  // Both `call` and the returned object must keep a stable identity across
  // renders. A caller that puts `call` in a `useCallback`/`useEffect`
  // dependency list — the natural way to write "fetch this on mount" — would
  // otherwise re-run that effect on every render, since a fresh function
  // identity looks like a changed dependency. That loops: fetch → setState →
  // render → new `call` → fetch, at whatever rate the network allows, until
  // the API's rate limiter starts returning 429s.
  const call = useCallback(
    async function call<T>(path: string, options: ClientFetchOptions = {}): Promise<T> {
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

      const response = await fetch(`${API_URL}${path}`, { ...options, headers });

      if (!response.ok) {
        const problem = (await response.json().catch(() => undefined)) as { detail?: string } | undefined;
        throw new Error(problem?.detail ?? `Request failed with status ${response.status}`);
      }
      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    },
    [getToken],
  );

  return useMemo(() => ({ call }), [call]);
}
