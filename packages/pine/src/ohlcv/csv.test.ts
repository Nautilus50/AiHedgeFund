import { describe, expect, it } from "vitest";
import { parseOhlcvCsv } from "./csv.js";
import type { OhlcvParseResult } from "./types.js";

const VALID = `time,open,high,low,close,volume
2024-01-01T00:00:00Z,100,101,99,100.5,1000
2024-01-01T01:00:00Z,100.5,102,100,101.5,1200`;

describe("parseOhlcvCsv", () => {
  it("parses a well-formed file", () => {
    const result = parseOhlcvCsv(VALID) as OhlcvParseResult;
    expect(result.ok).toBe(true);
    expect(result.bars).toHaveLength(2);
    expect(result.bars[0]).toEqual({
      time: "2024-01-01T00:00:00.000Z",
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000,
    });
    expect(result.warnings).toHaveLength(0);
  });

  it("sorts bars by time ascending regardless of input order", () => {
    const reversed = `time,open,high,low,close,volume
2024-01-01T01:00:00Z,100.5,102,100,101.5,1200
2024-01-01T00:00:00Z,100,101,99,100.5,1000`;
    const result = parseOhlcvCsv(reversed) as OhlcvParseResult;
    expect(result.bars.map((b) => b.time)).toEqual(["2024-01-01T00:00:00.000Z", "2024-01-01T01:00:00.000Z"]);
  });

  it("rejects a file missing required columns", () => {
    const result = parseOhlcvCsv("time,open,close\n2024-01-01T00:00:00Z,100,101");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reasonCode).toBe("MISSING_REQUIRED_COLUMNS");
    expect(result.missingColumns).toEqual(["high", "low", "volume"]);
  });

  it("rejects an empty file", () => {
    const result = parseOhlcvCsv("");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reasonCode).toBe("EMPTY_FILE");
  });

  it("drops rows with unparseable values and warns", () => {
    const withBadRow = `time,open,high,low,close,volume
2024-01-01T00:00:00Z,100,101,99,100.5,1000
not-a-time,100,101,99,100.5,1000
2024-01-01T02:00:00Z,abc,101,99,100.5,1000`;
    const result = parseOhlcvCsv(withBadRow) as OhlcvParseResult;
    expect(result.bars).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]?.code).toBe("UNPARSEABLE_TIME");
    expect(result.warnings[1]?.code).toBe("UNPARSEABLE_NUMBER");
  });
});
