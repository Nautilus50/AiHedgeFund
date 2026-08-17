/**
 * Route-level Suspense fallback (Next.js convention). Shown while a page's
 * server-component data fetch is in flight — every page under app/ renders
 * through this until it has its own more specific loading.tsx.
 */
export default function Loading() {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      <div className="page-head">
        <div className="page-title-group">
          <div className="skeleton" style={{ width: "220px", height: "21px" }} />
          <div className="skeleton" style={{ width: "340px" }} />
        </div>
      </div>
      <section className="card">
        <div className="card-body stack">
          <div className="skeleton" style={{ width: "60%" }} />
          <div className="skeleton" style={{ width: "85%" }} />
          <div className="skeleton" style={{ width: "40%" }} />
        </div>
      </section>
    </div>
  );
}
