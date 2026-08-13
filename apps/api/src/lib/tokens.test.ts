import { describe, expect, it } from "vitest";
import { generateDeploymentToken, hashToken } from "./tokens.js";

describe("generateDeploymentToken", () => {
  it("generates a high-entropy, URL-safe token", () => {
    const token = generateDeploymentToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never generates the same token twice", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateDeploymentToken()));
    expect(tokens.size).toBe(20);
  });
});

describe("hashToken", () => {
  it("is deterministic for the same token", () => {
    const token = generateDeploymentToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("differs for different tokens", () => {
    expect(hashToken(generateDeploymentToken())).not.toBe(hashToken(generateDeploymentToken()));
  });

  it("never returns the plaintext token itself", () => {
    const token = generateDeploymentToken();
    expect(hashToken(token)).not.toBe(token);
  });
});
