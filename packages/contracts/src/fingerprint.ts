/**
 * Canonical JSON with sorted keys, so two logically-identical objects
 * always fingerprint the same way regardless of property order.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
