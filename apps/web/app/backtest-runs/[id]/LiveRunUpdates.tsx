"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useApiClient } from "../../../lib/api-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const RECONNECT_DELAY_MS = 2000;

interface TicketResponse {
  ticket: string;
  expiresAt: string;
}

/**
 * Live-refreshes this page when the run's own job-progress events arrive
 * (CLAUDE.md 17.4). Renders nothing — it only calls `router.refresh()`,
 * which re-runs the Server Component's data fetch.
 *
 * Browser `EventSource` can't set an `Authorization` header, so a
 * single-use ticket is minted first (ADR 0007) via the same
 * browser-direct-to-API pattern `useApiClient` already exists for.
 * Reconnection is hand-rolled rather than relying on `EventSource`'s
 * native retry, which would resend the now-invalidated ticket in the same
 * URL — `onerror` closes the connection itself first, then mints a fresh
 * ticket and resumes from the last event id it saw.
 */
export function LiveRunUpdates({ backtestRunId }: { backtestRunId: string }) {
  const { call } = useApiClient();
  const router = useRouter();

  const lastEventIdRef = useRef<string | undefined>(undefined);
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    async function connect() {
      if (stoppedRef.current) return;

      let ticket: TicketResponse;
      try {
        ticket = await call<TicketResponse>("/v1/sse/tickets", { method: "POST" });
      } catch {
        // Minting failed (network hiccup, session refreshing) — retry
        // shortly rather than silently give up live updates for the rest
        // of the page's lifetime.
        reconnectTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
        return;
      }
      if (stoppedRef.current) return;

      const query = new URLSearchParams({ aggregateId: backtestRunId });
      if (lastEventIdRef.current) query.set("cursor", lastEventIdRef.current);

      source = new EventSource(`${API_URL}/v1/events/stream/${ticket.ticket}?${query.toString()}`);

      const onJobProgress = (event: MessageEvent<string>) => {
        lastEventIdRef.current = event.lastEventId;
        router.refresh();
      };
      source.addEventListener("backtest_run.completed", onJobProgress);
      source.addEventListener("trades.normalised", onJobProgress);

      source.onerror = () => {
        source?.close();
        if (!stoppedRef.current) {
          reconnectTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
        }
      };
    }

    void connect();

    return () => {
      stoppedRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [backtestRunId, router, call]);

  return null;
}
