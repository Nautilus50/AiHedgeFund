import Decimal from "decimal.js";

/** All monetary aggregation runs through decimal.js — CLAUDE.md 7.4 forbids binary floating point for authoritative totals. */
export { Decimal };

export function toDecimal(value: number | string): Decimal {
  return new Decimal(value);
}
