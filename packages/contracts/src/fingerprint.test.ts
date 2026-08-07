import { describe, expect, it } from "vitest";
import { canonicalHash, fingerprint } from "./index.js";

describe("fingerprint", () => {
  it("is stable across key order", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it("ignores undefined values", () => {
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }));
  });

  it("differs when a value differs", () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it("canonicalizes nested objects and arrays recursively", () => {
    const a = { outer: { z: 1, a: 2 }, list: [{ b: 1, a: 2 }] };
    const b = { list: [{ a: 2, b: 1 }], outer: { a: 2, z: 1 } };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});

describe("canonicalHash", () => {
  it("is deterministic and key-order independent", () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it("produces a 64-character hex sha256 digest", () => {
    expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the value changes", () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});
