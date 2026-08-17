"use client";

/**
 * Catches errors thrown by the root layout itself (Clerk/org resolution
 * failures before app/error.tsx's boundary even exists). Next.js requires
 * this file to render its own <html>/<body> since it replaces the root
 * layout entirely — it intentionally does not import globals.css or the
 * shared primitives, since those are exactly what may have failed to load.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "48px", color: "#16181d" }}>
        <div style={{ maxWidth: 480 }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>ARF-OS failed to load</h1>
          <p style={{ color: "#5d6470", marginBottom: 16 }}>
            Something went wrong before the page could render. This usually clears on retry.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{ padding: "7px 14px", borderRadius: 6, border: "1px solid #2f5fd0", background: "#2f5fd0", color: "#fff", cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
