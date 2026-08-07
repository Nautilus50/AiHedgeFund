import { describe, expect, it } from "vitest";
import { generateId, isValidId, type StrategyId } from "./ids.js";

describe("generateId", () => {
  it("produces a valid UUID", () => {
    const id = generateId<StrategyId>();
    expect(isValidId(id)).toBe(true);
  });

  it("produces unique values across calls", () => {
    const a = generateId<StrategyId>();
    const b = generateId<StrategyId>();
    expect(a).not.toBe(b);
  });
});

describe("isValidId", () => {
  it("rejects non-uuid strings", () => {
    expect(isValidId("not-a-uuid")).toBe(false);
  });
});
