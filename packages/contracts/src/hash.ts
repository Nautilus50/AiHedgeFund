import { createHash } from "node:crypto";
import { fingerprint } from "./fingerprint.js";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Deterministic content hash of an arbitrary value, independent of key
 * order. Used for `strategy_versions.definition_hash` /
 * `pine_revisions.manifest_hash` — CLAUDE.md 3.1: any change to any of
 * these hashed fields is what signals a new immutable version is required.
 */
export function canonicalHash(value: unknown): string {
  return sha256Hex(fingerprint(value));
}
