/**
 * Evidence provenance tags (CLAUDE.md 18.1).
 *
 * The rule is that a reader must never have to infer where a number came
 * from. These are the vocabulary the spec names — segment, basis, and
 * source — rendered as metadata rather than as status, so they are not
 * confused with lifecycle state.
 */

export type Segment = "IN_SAMPLE" | "VALIDATION" | "OUT_OF_SAMPLE" | "FINAL_HOLDOUT" | "FORWARD";
export type Basis = "GROSS" | "NET";
export type Source = "TRADINGVIEW" | "LOCAL_RUNNER" | "SIMULATED" | "PAPER";

const SEGMENT_LABEL: Record<Segment, string> = {
  IN_SAMPLE: "in-sample",
  VALIDATION: "validation",
  OUT_OF_SAMPLE: "out-of-sample",
  FINAL_HOLDOUT: "final holdout",
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

export function SegmentTag({ segment }: { segment: Segment }) {
  return (
    <ProvenanceTag
      label={SEGMENT_LABEL[segment] ?? segment}
      title={`Data segment: ${SEGMENT_LABEL[segment] ?? segment}`}
    />
  );
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
