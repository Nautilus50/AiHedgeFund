import { randomBytes } from "node:crypto";
import { sha256Hex } from "@arf-os/contracts";

/**
 * Generates a high-entropy, URL-safe deployment webhook token
 * (CLAUDE.md 16.1). Only its hash is ever persisted (see `hashToken`) — the
 * plaintext is returned once, at creation, and never logged or stored.
 */
export function generateDeploymentToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Deterministic hash a stored `deploymentTokenHash` is compared against. */
export function hashToken(token: string): string {
  return sha256Hex(token);
}
