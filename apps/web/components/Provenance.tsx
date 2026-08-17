/**
 * Evidence provenance tags (CLAUDE.md 18.1).
 *
 * The rule is that a reader must never have to infer where a number came
 * from. These are the vocabulary the spec names — segment, basis, and
 * source — rendered as metadata rather than as status, so they are not
 * confused with lifecycle state.
 */

export type Segment =
  | "IN_SAMPLE"
  | "VALIDATION"
  | "OUT_OF_SAMPLE"
  | "FINAL_HOLDOUT"
  | "ROLLING_WALK_FORWARD"
  | "ANCHORED_WALK_FORWARD"
  | "REGIME"
  | "FORWARD";
export type Basis = "GROSS" | "NET";
export type Source = "TRADINGVIEW" | "LOCAL_RUNNER" | "SIMULATED" | "PAPER";

const SEGMENT_LABEL: Record<Segment, string> = {
  IN_SAMPLE: "in-sample",
  VALIDATION: "validation",
  OUT_OF_SAMPLE: "out-of-sample",
  FINAL_HOLDOUT: "final holdout",
  ROLLING_WALK_FORWARD: "rolling walk-forward",
  ANCHORED_WALK_FORWARD: "anchored walk-forward",
  REGIME: "regime",
  FORWARD: "forward",
};

const BASIS_LABEL: Record<Basis, string> = {
  GROSS: "gross",
  NET: "net",
};

const SOURCE_LABEL: Record<Source, string> = {
  TRADINGVIEW: "TradingView",
  LOCAL_RUNNER: "local runner",
  SIMULATED: "simulated",
  PAPER: "paper",
};

export function ProvenanceTag({ label, title }: { label: string; title: string }) {
  return (
    <span className="provenance" title={title}>
      {label}
    </span>
  );
}

/**
 * Accepts any string, not just `Segment`, so callers rendering a raw API
 * field (typed `string` at the fetch boundary) don't need an unsafe cast —
 * an unrecognised value still renders, just without the humanised label.
 */
export function SegmentTag({ segment }: { segment: Segment | (string & {}) }) {
  const label = SEGMENT_LABEL[segment as Segment] ?? segment;
  return <ProvenanceTag label={label} title={`Data segment: ${label}`} />;
}

export function BasisTag({ basis }: { basis: Basis }) {
  return (
    <ProvenanceTag
      label={BASIS_LABEL[basis]}
      title={basis === "NET" ? "Net of commission and slippage" : "Before costs"}
    />
  );
}

export function SourceTag({ source }: { source: Source }) {
  return <ProvenanceTag label={SOURCE_LABEL[source]} title={`Produced by: ${SOURCE_LABEL[source]}`} />;
}
