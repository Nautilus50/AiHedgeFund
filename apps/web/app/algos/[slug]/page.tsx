import Link from "next/link";
import { notFound } from "next/navigation";
import { AlgoEvidence } from "../../../components/AlgoEvidence";
import { AlgoSource } from "../../../components/AlgoSource";
import { Badge } from "../../../components/Badge";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../../../components/primitives";
import { getAlgo, getAlgoSource } from "../../../lib/algo-library";

const STATUS_TONE = { DRAFT: "neutral", PUBLISHED: "ok", RETIRED: "warn" } as const;

export default async function AlgoDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getAlgo(slug);

  if ("error" in result) {
    notFound();
  }

  const algo = result.data;
  // Fetching the source is an audited read, so it happens only on this page,
  // where the operator came to get the code.
  const source = algo.currentRelease ? await getAlgoSource(slug) : null;

  return (
    <>
      <Link href="/algos" className="breadcrumb">
        ← Algo Library
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <h1>{algo.name}</h1>
          <p className="page-subtitle">{algo.tagline}</p>
          <p className="page-subtitle">
            <Badge tone={STATUS_TONE[algo.status]}>{algo.status}</Badge>{" "}
            {/* Headline scope is priority-ranked server-side (FORWARD_PAPER beats any backtest
                scope) — if it's showing, the strongest evidence for this algo is a real forward
                paper run, not a historical simulation. */}
            {algo.headline?.scope === "FORWARD_PAPER" && <Badge tone="ok">Forward tested</Badge>}{" "}
            {algo.marketCategory.replace("_", " ")} · {algo.symbol} · {algo.timeframe}
          </p>
        </div>
      </div>

      <Card>
        <CardHead
          title="Evidence"
          hint="Every figure is recomputed from the trade ledger of the run named below — never copied from a runner summary."
        />
        <CardBody>
          <AlgoEvidence snapshots={algo.snapshots} />
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Current release" />
        <CardBody>
          {algo.currentRelease ? (
            <dl className="dl">
              <dt>Release</dt>
              <dd>#{algo.currentRelease.releaseNumber}</dd>
              <dt>Strategy version</dt>
              <dd>
                <Link href={`/strategy-versions/${algo.currentRelease.strategyVersionId}`}>
                  {algo.currentRelease.strategyVersionId}
                </Link>
              </dd>
              <dt>Published (UTC)</dt>
              <dd>
                {algo.currentRelease.publishedAt ? (
                  <Timestamp value={algo.currentRelease.publishedAt} />
                ) : (
                  <span className="unset">—</span>
                )}
              </dd>
              <dt>Source hash</dt>
              <dd className="mono">{algo.currentRelease.pineSourceHash}</dd>
              <dt>Changelog</dt>
              <dd>{algo.currentRelease.changelog || <span className="unset">—</span>}</dd>
            </dl>
          ) : (
            <EmptyState title="No published release">
              <p>Publish a release from a PAPER_APPROVED strategy version to pin what this algo actually runs.</p>
            </EmptyState>
          )}
        </CardBody>
      </Card>

      {algo.description && (
        <Card>
          <CardHead title="What it does" />
          <CardBody>
            {algo.description
              .split("\n")
              .filter((paragraph) => paragraph.trim().length > 0)
              .map((paragraph) => (
                <p key={paragraph.slice(0, 40)}>{paragraph}</p>
              ))}
          </CardBody>
        </Card>
      )}

      {algo.riskNote && (
        <Card>
          <CardHead title="Risk" />
          <CardBody>
            <p>{algo.riskNote}</p>
            <p className="card-hint">
              These figures come from historical or simulated trading. Simulated results assume the modelled costs and
              fills actually occur, and no simulation reproduces the effect of a real order in a real book.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHead
          title="Pine Script v6 source"
          hint="Read from the release's immutable strategy version. Check it against the source hash above."
        />
        <CardBody>
          {source === null ? (
            <EmptyState title="Nothing to run yet">
              <p>Publish a release first.</p>
            </EmptyState>
          ) : "error" in source ? (
            <Alert tone="error">Could not load the source. {source.error.message}</Alert>
          ) : (
            <AlgoSource source={source.data.pineSource} fileName={`${algo.slug}.pine`} />
          )}
        </CardBody>
      </Card>

      {source !== null && !("error" in source) && source.data.setupInstructions && (
        <Card>
          <CardHead title="Setup" />
          <CardBody>
            {source.data.setupInstructions
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .map((line) => (
                <p key={line.slice(0, 40)}>{line}</p>
              ))}
          </CardBody>
        </Card>
      )}
    </>
  );
}
