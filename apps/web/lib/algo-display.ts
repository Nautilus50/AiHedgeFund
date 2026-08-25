import type { StatScope } from "@arf-os/contracts";

/**
 * Presentation helpers shared by server and client components. Deliberately
 * free of any server-only import so a client component can use them without
 * pulling `lib/api` (and Clerk's server SDK) into the browser bundle.
 */

/** Human labels for evidence scope. The label is never dropped from a number. */
export const SCOPE_LABEL: Record<StatScope, string> = {
  IN_SAMPLE: "In-sample backtest",
  OUT_OF_SAMPLE: "Out-of-sample backtest",
  FORWARD_PAPER: "Forward paper test",
};

export const SCOPE_NOTE: Record<StatScope, string> = {
  IN_SAMPLE: "The period this was developed on. The weakest evidence here, kept for completeness.",
  OUT_OF_SAMPLE: "A period held back during development. Net of the modelled cost model.",
  FORWARD_PAPER: "Simulated execution running forward with no parameter changes. Not real capital.",
};

/** Uses a true minus sign so the sign survives at small sizes and in greyscale. */
export function formatPct(value: number, fractionDigits = 1): string {
  return `${value >= 0 ? "" : "−"}${Math.abs(value).toFixed(fractionDigits)}%`;
}
