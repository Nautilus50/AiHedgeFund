import { describe, expect, it } from "vitest";
import { buildPage, clampPageSize, decodeCursor, encodeCursor } from "./pagination.js";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a cursor", () => {
    const cursor = encodeCursor({ id: "row-1", createdAt: "2026-01-01T00:00:00.000Z" });
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ ok: true, cursor: { createdAtIso: "2026-01-01T00:00:00.000Z", id: "row-1" } });
  });

  it("accepts a Date instance too", () => {
    const cursor = encodeCursor({ id: "row-1", createdAt: new Date("2026-01-01T00:00:00.000Z") });
    expect(decodeCursor(cursor)).toMatchObject({ ok: true });
  });

  it("rejects garbage input rather than throwing", () => {
    expect(decodeCursor("not-valid-base64url-content!!!")).toMatchObject({ ok: false, reasonCode: "INVALID_CURSOR" });
  });

  it("rejects a cursor missing the separator", () => {
    const bogus = Buffer.from("no-separator-here", "utf-8").toString("base64url");
    expect(decodeCursor(bogus)).toMatchObject({ ok: false, reasonCode: "INVALID_CURSOR" });
  });

  it("rejects a cursor with an unparseable date", () => {
    const bogus = Buffer.from("not-a-date|row-1", "utf-8").toString("base64url");
    expect(decodeCursor(bogus)).toMatchObject({ ok: false, reasonCode: "INVALID_CURSOR" });
  });
});

describe("clampPageSize", () => {
  it("defaults when nothing is requested", () => {
    expect(clampPageSize(undefined)).toBe(20);
  });

  it("clamps to the maximum", () => {
    expect(clampPageSize(9999)).toBe(100);
  });

  it("rejects zero/negative values by falling back to the default", () => {
    expect(clampPageSize(0)).toBe(20);
    expect(clampPageSize(-5)).toBe(20);
  });

  it("floors a fractional request", () => {
    expect(clampPageSize(10.7)).toBe(10);
  });
});

describe("buildPage", () => {
  const rows = [
    { id: "a", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "b", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "c", createdAt: "2026-01-03T00:00:00.000Z" },
  ];

  it("returns no cursor when there are fewer rows than the limit", () => {
    const page = buildPage(rows, 10);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeUndefined();
  });

  it("trims to the limit and returns a cursor when there's an extra row", () => {
    const page = buildPage(rows, 2);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((r) => r.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBeDefined();
  });

  it("the returned cursor decodes back to the last item on the page", () => {
    const page = buildPage(rows, 2);
    expect(page.nextCursor).toBeDefined();
    const decoded = decodeCursor(page.nextCursor ?? "");
    expect(decoded).toMatchObject({ ok: true, cursor: { id: "b" } });
  });
});
