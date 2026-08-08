/**
 * Opaque cursor pagination (spec 14.11 — "Use cursor pagination for large
 * collections"). The cursor is base64 of `${createdAtIso}|${id}`: ordering
 * by createdAt with id as a tiebreaker keeps pagination stable even when
 * multiple rows share a timestamp.
 */
export interface CursorFields {
  id: string;
  createdAt: Date | string;
}

export function encodeCursor(row: CursorFields): string {
  const createdAtIso = typeof row.createdAt === "string" ? row.createdAt : row.createdAt.toISOString();
  return Buffer.from(`${createdAtIso}|${row.id}`, "utf-8").toString("base64url");
}

export interface DecodedCursor {
  createdAtIso: string;
  id: string;
}

export type DecodeCursorResult = { ok: true; cursor: DecodedCursor } | { ok: false; reasonCode: "INVALID_CURSOR" };

export function decodeCursor(cursor: string): DecodeCursorResult {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf-8");
  } catch {
    return { ok: false, reasonCode: "INVALID_CURSOR" };
  }

  const separatorIndex = decoded.indexOf("|");
  if (separatorIndex < 0) {
    return { ok: false, reasonCode: "INVALID_CURSOR" };
  }

  const createdAtIso = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (Number.isNaN(Date.parse(createdAtIso)) || id.length === 0) {
    return { ok: false, reasonCode: "INVALID_CURSOR" };
  }

  return { ok: true, cursor: { createdAtIso, id } };
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Clamps a client-supplied page size into a safe range rather than trusting it outright. */
export function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

export interface Page<T> {
  items: T[];
  nextCursor: string | undefined;
}

/**
 * Repositories fetch `limit + 1` rows; this turns that into a page plus a
 * cursor for the next one, without a separate COUNT query.
 */
export function buildPage<T extends CursorFields>(rowsFetchedWithExtra: T[], limit: number): Page<T> {
  const hasMore = rowsFetchedWithExtra.length > limit;
  const items = hasMore ? rowsFetchedWithExtra.slice(0, limit) : rowsFetchedWithExtra;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last) : undefined };
}
