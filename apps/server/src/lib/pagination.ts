import { sql, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { Db } from "../db/index.js";

/**
 * Shared offset-catalog scaffolding for the parallel browse routes
 * (`/worlds/catalog`, `/stories/catalog`). Both routes independently grew the
 * same `page`/`pageSize` query fragment, a `count(*)` total, and a
 * `{ entries, page, pageSize, total, hasMore }` envelope; this module holds the
 * one copy each shares.
 *
 * Deliberately NOT extracted (kept per-route): the parse-failure handling
 * (worlds falls through to `{}`, stories returns HTTP 400), the entity-specific
 * WHERE conditions + ORDER BY, the distinct tables, and any extra envelope
 * fields (`copyEnabled` / `ownedStoryIds`). Callers spread those alongside the
 * shared pieces so their observable output stays byte-identical.
 */

/**
 * Zod shape for the offset-pagination query params. Spread into a route's
 * catalog `z.object({ ... })`. Both callers use identical clamps: `page` is
 * 0-based (0..1000) and `pageSize` is 1..50, both optional so the route can
 * apply the shared default when omitted.
 */
export const offsetPageQueryShape = {
  page: z.coerce.number().int().min(0).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
};

/** Default page size applied when the query omits `pageSize` (both routes: 24). */
export const DEFAULT_CATALOG_PAGE_SIZE = 24;

/**
 * Resolve the effective page/pageSize from a parsed query, applying the shared
 * defaults (page 0, pageSize 24). Pure — mirrors the inline
 * `q.pageSize ?? 24` / `q.page ?? 0` both routes used.
 */
export function resolveOffsetPage(q: {
  page?: number | undefined;
  pageSize?: number | undefined;
}): {
  page: number;
  pageSize: number;
} {
  return {
    page: q.page ?? 0,
    pageSize: q.pageSize ?? DEFAULT_CATALOG_PAGE_SIZE,
  };
}

/**
 * `count(*)` of rows in `table` matching `whereExpr` (0 when the row is
 * absent). Same query both routes ran to compute `total`.
 */
export async function countRows(
  db: Db,
  table: SQLiteTable,
  whereExpr: SQL | undefined,
): Promise<number> {
  const row = (await db
    .select({ n: sql<number>`count(*)` })
    .from(table)
    .where(whereExpr))[0];
  return row?.n ?? 0;
}

/**
 * Build the shared offset-catalog envelope fields. Callers spread any extra
 * fields (e.g. `copyEnabled` / `ownedStoryIds`) alongside the return value.
 * `hasMore` reproduces the exact `(page + 1) * pageSize < total` test.
 */
export function offsetPageEnvelope<T>(args: {
  entries: T[];
  page: number;
  pageSize: number;
  total: number;
}): { entries: T[]; page: number; pageSize: number; total: number; hasMore: boolean } {
  const { entries, page, pageSize, total } = args;
  return {
    entries,
    page,
    pageSize,
    total,
    hasMore: (page + 1) * pageSize < total,
  };
}

/**
 * Canonical `?limit` clamp for the many admin/queue routes that re-rolled
 * `Math.min(MAX, parse(req.query.limit ?? "D", 10) || D)` inline. Finding O1:
 * several of those copies had NO floor, so a `?limit=-5` (or any negative)
 * slipped through `Math.min` unchanged and reached the DB as `LIMIT -5`, which
 * SQLite treats as "no limit" — the route silently dumped every row.
 *
 * This adds the missing floor uniformly: any non-finite / zero / negative
 * input falls back to `default` (matching the existing `|| default` idiom for
 * `0`/`NaN`), then the result is clamped into `[min, max]`. Valid in-range
 * inputs are returned exactly as before, so the normal path is unchanged.
 *
 * @param raw   the raw query value (string from a querystring, or a number)
 * @param opts.max      hard ceiling (required)
 * @param opts.default  fallback when the input is missing/invalid (required)
 * @param opts.min      floor, default 1 (never returns below this)
 * @param opts.parseMode "int" (parseInt base-10, default) or "number" (Number)
 */
export function parseLimit(
  raw: string | number | null | undefined,
  opts: { max: number; default: number; min?: number; parseMode?: "int" | "number" },
): number {
  const min = opts.min ?? 1;
  const parseMode = opts.parseMode ?? "int";
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (raw == null || raw === "") {
    n = opts.default;
  } else {
    n = parseMode === "number" ? Number(raw) : Number.parseInt(raw, 10);
  }
  // Non-finite / zero / negative all fall back to the default, then clamp.
  if (!Number.isFinite(n) || n <= 0) n = opts.default;
  return Math.max(min, Math.min(opts.max, Math.floor(n)));
}

/**
 * Canonical `createdAt`-cursor page slice. Finding O5: two routes implemented
 * "fetch a page, decide if there's a next one" two different ways —
 * notifications/engine.ts correctly over-fetched `limit + 1` and tested
 * `rows.length > limit`, while the earning ledger fetched exactly `limit` and
 * tested `rows.length === limit`, which emits a SPURIOUS next-cursor whenever
 * the last page happens to be exactly full (leading the client to fetch one
 * extra, empty page).
 *
 * Canonical contract: the CALLER over-fetches `limit + 1` rows ordered newest
 * first; this returns the first `limit` as the page and derives `nextCursor`
 * from the last returned row ONLY when a `(limit + 1)`th row actually existed.
 * A full-but-final page therefore yields `nextCursor: null` — no duplicate and
 * no skipped item at the boundary. Normal (non-final) pages are unchanged.
 *
 * @param rows      the over-fetched rows (length up to `limit + 1`)
 * @param limit     the requested page size
 * @param cursorOf  extracts the cursor value (e.g. `+row.createdAt`) from a row
 */
export function cursorPageSlice<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => number,
): { page: T[]; nextCursor: number | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last !== undefined ? cursorOf(last) : null;
  return { page, nextCursor };
}
