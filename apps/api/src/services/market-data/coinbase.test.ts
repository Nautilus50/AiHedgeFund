import { afterEach, describe, expect, it, vi } from "vitest";
import { candlesToOhlcvCsv, fetchCoinbaseCandles, mapSymbolToCoinbaseProductId, type Candle } from "./coinbase.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapSymbolToCoinbaseProductId", () => {
  it("maps a USDT-suffixed symbol to a USD Coinbase product", () => {
    expect(mapSymbolToCoinbaseProductId("BTCUSDT")).toBe("BTC-USD");
    expect(mapSymbolToCoinbaseProductId("ZECUSDT")).toBe("ZEC-USD");
  });

  it("maps a USD-suffixed symbol to a USD Coinbase product", () => {
    expect(mapSymbolToCoinbaseProductId("BTCUSD")).toBe("BTC-USD");
  });

  it("rejects a symbol it cannot map", () => {
    expect(() => mapSymbolToCoinbaseProductId("XAUUSD-FOO")).toThrow(/Cannot map/);
  });
});

describe("fetchCoinbaseCandles", () => {
  it("returns a single page when the range fits under the 300-candle cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        [1_700_003_600, 100, 115, 105, 110, 8.25], // [time, low, high, open, close, volume], newest first
        [1_700_000_000, 90, 110, 100, 105, 12.5],
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const candles = await fetchCoinbaseCandles({
      symbol: "BTCUSDT",
      timeframe: "1h",
      startTime: new Date(1_700_000_000_000),
      endTime: new Date(1_700_010_000_000),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("/products/BTC-USD/candles");

    expect(candles).toEqual<Candle[]>([
      { time: 1_700_000_000, open: 100, high: 110, low: 90, close: 105, volume: 12.5 },
      { time: 1_700_003_600, open: 105, high: 115, low: 100, close: 110, volume: 8.25 },
    ]);
  });

  it("walks multiple fixed-size windows for a range exceeding the 300-candle cap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([[1_700_000_000, 1, 1, 1, 1, 1]]))
      .mockResolvedValueOnce(jsonResponse([[1_700_000_000 + 300 * 3600, 2, 2, 2, 2, 2]]));
    vi.stubGlobal("fetch", fetchMock);

    const candles = await fetchCoinbaseCandles({
      symbol: "BTCUSDT",
      timeframe: "1h",
      startTime: new Date(1_700_000_000_000),
      endTime: new Date(1_700_000_000_000 + 301 * 3600 * 1000),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(candles).toHaveLength(2);
  });

  it("rejects an unsupported timeframe before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchCoinbaseCandles({ symbol: "BTCUSDT", timeframe: "4h", startTime: new Date(0), endTime: new Date(1) }),
    ).rejects.toThrow(/Unsupported timeframe/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Coinbase's own error body (e.g. an unknown product)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "NotFound" }, false, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchCoinbaseCandles({
        symbol: "NOPEUSDT",
        timeframe: "1h",
        startTime: new Date(1_700_000_000_000),
        endTime: new Date(1_700_010_000_000),
      }),
    ).rejects.toThrow(/NotFound/);
  });
});

describe("candlesToOhlcvCsv", () => {
  it("emits the header parseOhlcvCsv expects, with ISO timestamps", () => {
    const csv = candlesToOhlcvCsv([{ time: 1_700_000_000, open: 100, high: 110, low: 90, close: 105, volume: 12.5 }]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("time,open,high,low,close,volume");
    expect(lines[1]).toBe(`${new Date(1_700_000_000_000).toISOString()},100,110,90,105,12.5`);
  });
});
