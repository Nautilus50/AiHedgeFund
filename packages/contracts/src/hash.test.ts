import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("hashes a string deterministically", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
    expect(sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("hashes raw bytes (e.g. an uploaded file's contents), not just strings", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(sha256Hex(bytes)).toBe(sha256Hex("hello"));
  });

  it("differs on any byte change", () => {
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).not.toBe(sha256Hex(new Uint8Array([1, 2, 4])));
  });
});
