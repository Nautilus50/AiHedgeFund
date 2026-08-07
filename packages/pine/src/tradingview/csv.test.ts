import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, parseLocaleNumber } from "./csv.js";

describe("detectDelimiter", () => {
  it("detects comma delimiter", () => {
    expect(detectDelimiter("Trade #,Type,Date/Time")).toBe(",");
  });

  it("detects semicolon delimiter", () => {
    expect(detectDelimiter("Trade #;Type;Date/Time")).toBe(";");
  });
});

describe("parseCsv", () => {
  it("splits headers and rows", () => {
    const result = parseCsv("a,b,c\n1,2,3\n4,5,6");
    expect(result.headers).toEqual(["a", "b", "c"]);
    expect(result.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles quoted fields containing the delimiter", () => {
    const result = parseCsv('a,b\n"1,000",2');
    expect(result.rows[0]).toEqual(["1,000", "2"]);
  });

  it("returns empty result for an empty file", () => {
    expect(parseCsv("")).toEqual({ delimiter: ",", headers: [], rows: [] });
  });
});

describe("parseLocaleNumber", () => {
  it("parses US-convention numbers with a comma delimiter file (dot decimal)", () => {
    expect(parseLocaleNumber("1,234.56", ",")).toBeCloseTo(1234.56);
    expect(parseLocaleNumber("43500.50", ",")).toBeCloseTo(43500.5);
  });

  it("parses EU-convention numbers with a semicolon delimiter file (comma decimal)", () => {
    expect(parseLocaleNumber("1.234,56", ";")).toBeCloseTo(1234.56);
    expect(parseLocaleNumber("43500,50", ";")).toBeCloseTo(43500.5);
  });

  it("returns undefined for an empty or non-numeric value", () => {
    expect(parseLocaleNumber("", ",")).toBeUndefined();
    expect(parseLocaleNumber("   ", ",")).toBeUndefined();
  });

  it("strips a trailing percent sign", () => {
    expect(parseLocaleNumber("1.53%", ",")).toBeCloseTo(1.53);
  });
});
