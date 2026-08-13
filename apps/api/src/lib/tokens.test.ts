import { describe, expect, it } from "vitest";
import { generateOpaqueToken, hashToken } from "./tokens.js";

describe("generateOpaqueToken", () => {
  it("generates a high-entropy, URL-safe token", () => {
    const token = generateOpaqueToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never generates the same token twice", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(20);
  });
});

describe("hashToken", () => {
  it("is deterministic for the same token", () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("differs for different tokens", () => {
    expect(hashToken(generateOpaqueToken())).not.toBe(hashToken(generateOpaqueToken()));
  });

  it("never returns the plaintext token itself", () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).not.toBe(token);
  });
});
