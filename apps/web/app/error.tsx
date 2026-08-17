"use client";

import { useEffect } from "react";
import { Alert, Card, CardBody } from "../components/primitives";

/**
 * Route-level error boundary (Next.js convention). Catches anything an
 * apiFetchSafe-wrapped page didn't already turn into an inline Alert —
 * mainly exceptions thrown from Server Actions (strategies/import/actions.ts,
 * strategy-versions/[id]/actions.ts, forward-deployments/[id]/actions.ts all
 * call apiFetch directly, not apiFetchSafe) and genuine rendering bugs.
 *
 * Never renders error.message: in production Next.js already strips it down
 * to a digest for server-side errors, but client-thrown errors keep their
 * real message, and CLAUDE.md 7.5 forbids surfacing stack traces or internal
 * detail to clients regardless of source.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="stack">
      <Card>
        <CardBody>
          <Alert tone="error">
            <div>Something went wrong loading this page.</div>
            {error.digest && <p className="card-hint">Reference: {error.digest}</p>}
          </Alert>
          <div className="row" style={{ marginTop: "var(--sp-4)" }}>
            <button type="button" className="btn btn-primary" onClick={reset}>
              Try again
            </button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
