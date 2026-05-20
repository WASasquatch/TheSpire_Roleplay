/**
 * Content-snapshot export + import.
 *
 * "Content" = the admin-customizable cosmetic and configuration tables.
 * Specifically NOT user data (accounts, messages, earning ledger, etc.) —
 * for those, the full-DB snapshot (./full.ts) is the right path.
 *
 * Two operations:
 *
 *   exportContent(db): produces a BackupContentDocument
 *       - reads every row of each in-scope table
 *       - filters system_rooms / system_worlds to is_system=1 /
 *         owner_user_id="system" so per-user/per-character rows
 *         never leak into the export
 *       - strips install-specific identity fields (VAPID keys,
 *         updated_by_id user references) so the export is portable
 *         and re-importing on a different install can't break
 *         existing push subscriptions or dangle a user-id FK
 *
 *   importContent(db, doc, actorUserId): applies the document
 *       - upserts by NATURAL KEY (slug / key / name), not by row id,
 *         so a fresh-install target with no matching auto-IDs still
 *         lands the data cleanly
 *       - runs in a single transaction so a mid-import failure
 *         rolls back the whole document, never leaves the install in
 *         a half-applied state
 *       - applies tables in FK-safe order (ranks before rank_tiers,
 *         worlds before world_pages, etc.) so the inserts succeed
 *         even when the target install was empty
 *       - never deletes — rows present on the target but missing
 *         from the document survive (admin-added customization that
 *         the source install doesn't have)
 *
 * Diff helpers (diffContent) compute the add/update/onlyOnTarget/
 * unchanged counts per table for the inspect endpoint's preview
 * modal, without applying anything.
 *
 * Implementation note: this module bypasses the drizzle ORM and uses
 * the raw better-sqlite3 handle. The reason is that backup work
 * needs dynamic SQL on a table name chosen at runtime (PRAGMA
 * table_info("<table>"), INSERT INTO "<table>" (…)) which drizzle's
 * typed query builder doesn't model. The `sqliteHandle` export from
 * db/index.ts is the documented escape hatch for cases like this.
 */

import {
  BACKUP_FORMAT_VERSION,
  type BackupContentDocument,
  type BackupContentTables,
  type ContentImportDiff,
  type ContentImportDiffEntry,
} from "@thekeep/shared";
import type Database from "better-sqlite3";

/**
 * Columns we DROP from the site_settings export. These are
 * install-specific identity values; round-tripping them across
 * installs causes silent breakage (VAPID key swap invalidates every
 * existing browser subscription; updated_by_id references a user
 * that doesn't exist on the target install).
 */
const SITE_SETTINGS_STRIP = new Set([
  "vapid_public_key",
  "vapid_private_key",
  "updated_by_id",
]);

/**
 * Read every applied migration filename from the `_migrations`
 * tracking table. Used in both the export (stamps the source
 * install's schema) and the import (compares against the doc's
 * stamp to decide whether the target install can safely apply it).
 *
 * Returns an empty array if the table doesn't exist yet — a pre-
 * migration-system install can't host a content backup anyway, but
 * the empty-array fallback keeps the call shape predictable.
 */
function readSchemaMigrations(sqlite: Database.Database): string[] {
  try {
    const rows = sqlite
      .prepare(`SELECT filename FROM _migrations ORDER BY filename`)
      .all() as Array<{ filename: string }>;
    return rows.map((r) => r.filename);
  } catch {
    return [];
  }
}

/* ============================================================
 *  Export
 * ============================================================ */

export function exportContent(sqlite: Database.Database): BackupContentDocument {
  const tables: BackupContentTables = {
    items: readAll(sqlite, "items"),
    name_styles: readAll(sqlite, "name_styles"),
    ranks: readAll(sqlite, "ranks"),
    rank_tiers: readAll(sqlite, "rank_tiers"),
    custom_commands: readAll(sqlite, "custom_commands"),
    title_kinds: readAll(sqlite, "title_kinds"),
    site_settings: readSiteSettings(sqlite),
    system_rooms: readSystemRooms(sqlite),
    system_worlds: readSystemWorlds(sqlite),
    world_pages_by_world_slug: readSystemWorldPages(sqlite),
  };

  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: Date.now(),
    sourceApp: "thekeep",
    schemaMigrations: readSchemaMigrations(sqlite),
    kind: "content",
    tables,
  };
}

function readAll(sqlite: Database.Database, table: string): Array<Record<string, unknown>> {
  // Table name is a literal from this file — never user input.
  // better-sqlite3 doesn't parameter-bind identifiers anyway, so the
  // inline interpolation here is the standard pattern.
  return sqlite.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
}

function readSiteSettings(sqlite: Database.Database): Record<string, unknown> | null {
  const row = sqlite
    .prepare(`SELECT * FROM "site_settings" WHERE id = 'singleton' LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SITE_SETTINGS_STRIP.has(k)) continue;
    cleaned[k] = v;
  }
  return cleaned;
}

function readSystemRooms(sqlite: Database.Database): Array<Record<string, unknown>> {
  return sqlite
    .prepare(`SELECT * FROM "rooms" WHERE is_system = 1`)
    .all() as Array<Record<string, unknown>>;
}

function readSystemWorlds(sqlite: Database.Database): Array<Record<string, unknown>> {
  return sqlite
    .prepare(`SELECT * FROM "worlds" WHERE owner_user_id = 'system'`)
    .all() as Array<Record<string, unknown>>;
}

function readSystemWorldPages(
  sqlite: Database.Database,
): Record<string, Array<Record<string, unknown>>> {
  // Pages join their world by id; we key the export by world slug
  // because slug is stable across installs while id is not.
  const rows = sqlite
    .prepare(`
      SELECT wp.*, w.slug AS __world_slug
      FROM "world_pages" wp
      JOIN "worlds" w ON w.id = wp.world_id
      WHERE w.owner_user_id = 'system'
      ORDER BY wp.world_id, wp.sort_order, wp.created_at
    `)
    .all() as Array<Record<string, unknown> & { __world_slug: string }>;
  const grouped: Record<string, Array<Record<string, unknown>>> = {};
  for (const row of rows) {
    const slug = row.__world_slug;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k !== "__world_slug") rest[k] = v;
    }
    if (!grouped[slug]) grouped[slug] = [];
    grouped[slug]!.push(rest);
  }
  return grouped;
}

/* ============================================================
 *  Diff (for the inspect endpoint)
 * ============================================================ */

/**
 * Compute the per-table add/update/onlyOnTarget/unchanged counts
 * without applying anything. The numbers feed the admin's preview
 * modal so they confirm an import with eyes open.
 */
export function diffContent(
  sqlite: Database.Database,
  doc: BackupContentDocument,
): ContentImportDiff {
  const liveMigrations = readSchemaMigrations(sqlite);
  const liveSet = new Set(liveMigrations);
  const docSet = new Set(doc.schemaMigrations);
  const missingMigrations = doc.schemaMigrations.filter((m) => !liveSet.has(m));
  const extraMigrationsOnServer = liveMigrations.filter((m) => !docSet.has(m));

  const entries: ContentImportDiffEntry[] = [];
  entries.push(diffTable(sqlite, "ranks", doc.tables.ranks, ["key"]));
  entries.push(diffTable(sqlite, "rank_tiers", doc.tables.rank_tiers, ["rank_key", "tier"]));
  entries.push(diffTable(sqlite, "name_styles", doc.tables.name_styles, ["key"]));
  entries.push(diffTable(sqlite, "items", doc.tables.items, ["key"]));
  entries.push(diffTable(sqlite, "title_kinds", doc.tables.title_kinds, ["slug"]));
  entries.push(diffTable(sqlite, "custom_commands", doc.tables.custom_commands, ["name"]));
  entries.push(diffSingleton(sqlite, doc.tables.site_settings));
  entries.push(diffTable(sqlite, "system_rooms", doc.tables.system_rooms, ["name"], "rooms", "is_system = 1"));
  entries.push(diffTable(sqlite, "system_worlds", doc.tables.system_worlds, ["slug"], "worlds", "owner_user_id = 'system'"));

  // World pages — flatten the grouping for counting purposes. We
  // don't try to compute "unchanged" for pages because the
  // composite-key resolution against the target's world ids would
  // require a per-row roundtrip; treat the whole bucket as
  // overwrite-on-import (page bodies are small; rewriting all of
  // them is fine).
  const flatPages: Array<Record<string, unknown>> = [];
  for (const pages of Object.values(doc.tables.world_pages_by_world_slug)) {
    for (const p of pages) flatPages.push(p);
  }
  entries.push({
    table: "world_pages_by_world_slug",
    toAdd: flatPages.length,
    toUpdate: 0,
    onlyOnTarget: 0,
    unchanged: 0,
  });

  return {
    uploadedVersion: doc.version,
    serverVersion: BACKUP_FORMAT_VERSION,
    missingMigrations,
    extraMigrationsOnServer,
    entries,
  };
}

/**
 * Generic per-table diff. `naturalKey` is the column or columns that
 * uniquely identify a row across installs. `physicalTable` lets the
 * diff label differ from the SQL table name (system_rooms /
 * system_worlds). `whereClause` narrows the target query when the
 * export only covered a subset.
 */
function diffTable(
  sqlite: Database.Database,
  diffLabel: string,
  incoming: Array<Record<string, unknown>>,
  naturalKey: string[],
  physicalTable?: string,
  whereClause?: string,
): ContentImportDiffEntry {
  const table = physicalTable ?? diffLabel;
  const where = whereClause ? `WHERE ${whereClause}` : "";
  const target = sqlite
    .prepare(`SELECT * FROM "${table}" ${where}`)
    .all() as Array<Record<string, unknown>>;
  const keyOf = (row: Record<string, unknown>) =>
    naturalKey.map((k) => String(row[k] ?? "")).join("\x1f");
  const targetByKey = new Map<string, Record<string, unknown>>();
  for (const row of target) targetByKey.set(keyOf(row), row);

  let toAdd = 0;
  let toUpdate = 0;
  let unchanged = 0;
  const seen = new Set<string>();
  for (const row of incoming) {
    const k = keyOf(row);
    seen.add(k);
    const existing = targetByKey.get(k);
    if (!existing) {
      toAdd++;
      continue;
    }
    if (rowsEqualForUpsert(existing, row)) unchanged++;
    else toUpdate++;
  }
  let onlyOnTarget = 0;
  for (const k of targetByKey.keys()) {
    if (!seen.has(k)) onlyOnTarget++;
  }
  return { table: diffLabel, toAdd, toUpdate, onlyOnTarget, unchanged };
}

function diffSingleton(
  sqlite: Database.Database,
  incoming: Record<string, unknown> | null,
): ContentImportDiffEntry {
  if (!incoming) {
    return { table: "site_settings", toAdd: 0, toUpdate: 0, onlyOnTarget: 0, unchanged: 0 };
  }
  const target = sqlite
    .prepare(`SELECT * FROM "site_settings" WHERE id = 'singleton' LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  if (!target) return { table: "site_settings", toAdd: 1, toUpdate: 0, onlyOnTarget: 0, unchanged: 0 };
  // Only compare keys present in `incoming`; columns intentionally
  // stripped from the export (VAPID keys, updated_by_id) shouldn't
  // trigger a "different" flag just because they exist on the target.
  const cleanedTarget: Record<string, unknown> = {};
  for (const k of Object.keys(incoming)) cleanedTarget[k] = target[k];
  if (rowsEqualForUpsert(cleanedTarget, incoming)) {
    return { table: "site_settings", toAdd: 0, toUpdate: 0, onlyOnTarget: 0, unchanged: 1 };
  }
  return { table: "site_settings", toAdd: 0, toUpdate: 1, onlyOnTarget: 0, unchanged: 0 };
}

/**
 * Compare two rows for upsert equivalence. JSON-normalizes values so
 * SQLite's int-as-boolean (0/1) and JSON's `false`/`true` count as
 * equal, ditto numbers vs string-of-numbers when one side came from
 * a JSON parse.
 */
function rowsEqualForUpsert(
  target: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(target), ...Object.keys(incoming)]);
  for (const k of keys) {
    if (JSON.stringify(target[k]) !== JSON.stringify(incoming[k])) return false;
  }
  return true;
}

/* ============================================================
 *  Import
 * ============================================================ */

export interface ImportResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Apply a content document. Transactional via better-sqlite3's
 * `db.transaction()` wrapper, which rolls back on any thrown error.
 *
 * Caller MUST have validated the schema-migration prerequisites
 * before calling (via `diffContent`).
 *
 * `actorUserId` is used as the fallback for fields like
 * `custom_commands.created_by_id` (NOT NULL on the schema). Without
 * the fallback, an upload from a different install would carry a
 * user id that doesn't exist on the target and the insert would
 * fail FK. Attributing system-owned customization to the importing
 * admin is the cleanest "real user that exists on this install"
 * choice.
 */
export function importContent(
  sqlite: Database.Database,
  doc: BackupContentDocument,
  actorUserId: string,
): ImportResult {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const tally = (r: "inserted" | "updated" | "unchanged") => {
    if (r === "inserted") inserted++;
    else if (r === "updated") updated++;
    else unchanged++;
  };

  const schemaCache = new Map<string, TableSchema>();

  const tx = sqlite.transaction(() => {
    // ranks before rank_tiers — FK from rank_tiers.rank_key.
    for (const row of doc.tables.ranks) tally(upsertRow(sqlite, schemaCache, "ranks", row, ["key"]));
    for (const row of doc.tables.rank_tiers) tally(upsertRow(sqlite, schemaCache, "rank_tiers", row, ["rank_key", "tier"]));
    for (const row of doc.tables.name_styles) tally(upsertRow(sqlite, schemaCache, "name_styles", row, ["key"]));
    for (const row of doc.tables.items) tally(upsertRow(sqlite, schemaCache, "items", row, ["key"]));
    for (const row of doc.tables.title_kinds) {
      // created_by_id → users.id (nullable). Source row's user might
      // not exist on the target install, so fall back to the
      // importing admin to keep the FK satisfied.
      const rowWithActor = { ...row, created_by_id: actorUserId };
      tally(upsertRow(sqlite, schemaCache, "title_kinds", rowWithActor, ["slug"]));
    }
    for (const row of doc.tables.custom_commands) {
      // created_by_id is NOT NULL — fall back to the importing admin
      // so the import never tries to write a missing user id.
      const rowWithActor = { ...row, created_by_id: actorUserId };
      tally(upsertRow(sqlite, schemaCache, "custom_commands", rowWithActor, ["name"]));
    }
    if (doc.tables.site_settings) {
      // Force the singleton id so an upload from a misshapen schema
      // doesn't accidentally land a second row.
      const row: Record<string, unknown> = { ...doc.tables.site_settings, id: "singleton" };
      // Drop any stripped keys that survived round-tripping just in case.
      for (const k of SITE_SETTINGS_STRIP) delete row[k];
      tally(upsertRow(sqlite, schemaCache, "site_settings", row, ["id"]));
    }
    // System rooms — match by name, force is_system=1 and
    // owner_id=null. System rooms have no owner by convention, and
    // an imported system room overwriting a user-owned room with
    // the same name should not silently inherit that ownership.
    for (const row of doc.tables.system_rooms) {
      const sysRow = { ...row, is_system: 1, owner_id: null };
      tally(upsertRow(sqlite, schemaCache, "rooms", sysRow, ["name"]));
    }
    // System worlds — keyed by (owner_user_id="system", slug). The
    // "system" sentinel user is created by ensureSystemSeeds, so
    // the FK reference is guaranteed to resolve on any install.
    for (const row of doc.tables.system_worlds) {
      tally(upsertRow(sqlite, schemaCache, "worlds", { ...row, owner_user_id: "system" }, ["slug", "owner_user_id"]));
    }
    // World pages — bucketed by world slug. Resolve each bucket's
    // world id on the target install, then upsert pages by
    // (world_id, slug).
    //
    // Hierarchy handling: page tree edges live on `parent_page_id`,
    // which references another world_page row by its nanoid. Those
    // ids are install-specific (generated at insert time), so
    // copying parent_page_id verbatim from the source would point at
    // rows that don't exist on the target — silently broken tree.
    // Until we extend the export with a slug-based parent reference,
    // strip parent_page_id on import so every page lands as
    // top-level. Admins can re-nest after import via the world
    // editor.
    for (const [worldSlug, pages] of Object.entries(doc.tables.world_pages_by_world_slug)) {
      const targetWorld = sqlite
        .prepare(`SELECT id FROM "worlds" WHERE owner_user_id = 'system' AND slug = ? LIMIT 1`)
        .get(worldSlug) as { id: string } | undefined;
      if (!targetWorld) continue;
      for (const page of pages) {
        const pageWithWorld: Record<string, unknown> = {
          ...page,
          world_id: targetWorld.id,
          parent_page_id: null,
        };
        tally(upsertRow(sqlite, schemaCache, "world_pages", pageWithWorld, ["world_id", "slug"]));
      }
    }
  });
  tx();

  return { inserted, updated, unchanged };
}

/**
 * Per-table schema metadata cache. Avoids re-running PRAGMA table_info
 * once per row during a multi-hundred-row import. Cleared between
 * top-level export/import calls because the cache is local to each
 * function invocation (the module-level closure isn't shared).
 */
interface TableSchema {
  validCols: Set<string>;
  /**
   * Primary-key column names. We NEVER overwrite a PK on update —
   * doing so would re-key the row, invalidating any FK from another
   * table that points at the old id. Common case in this codebase:
   * rank_tiers / title_kinds / custom_commands / worlds / world_pages
   * all use a nanoid `id` PK with a SEPARATE natural key (slug, name,
   * composite) used for the upsert lookup.
   */
  pkCols: Set<string>;
}

function readTableSchema(
  sqlite: Database.Database,
  cache: Map<string, TableSchema>,
  table: string,
): TableSchema {
  const cached = cache.get(table);
  if (cached) return cached;
  const colInfo = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string;
    pk: number;
  }>;
  const schema: TableSchema = {
    validCols: new Set(colInfo.map((c) => c.name)),
    pkCols: new Set(colInfo.filter((c) => c.pk > 0).map((c) => c.name)),
  };
  cache.set(table, schema);
  return schema;
}

/**
 * Upsert one row keyed by `naturalKey`. Behaviour:
 *
 *   1. Drop unknown columns from the incoming row (newer-format
 *      export onto an older schema doesn't crash).
 *   2. Look up the existing row by the natural key.
 *   3. Absent → INSERT.
 *   4. Present + identical → "unchanged" (no write).
 *   5. Present + different → UPDATE only the columns that actually
 *      differ, NEVER touching the natural-key columns OR the
 *      primary-key columns (re-keying an existing row would
 *      invalidate every FK that points at the old id).
 */
function upsertRow(
  sqlite: Database.Database,
  schemaCache: Map<string, TableSchema>,
  table: string,
  row: Record<string, unknown>,
  naturalKey: string[],
): "inserted" | "updated" | "unchanged" {
  const schema = readTableSchema(sqlite, schemaCache, table);

  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (schema.validCols.has(k)) filtered[k] = normalizeSqliteValue(v);
  }
  if (Object.keys(filtered).length === 0) return "unchanged";

  const whereParts = naturalKey.map((k) => `"${k}" = ?`).join(" AND ");
  const whereVals = naturalKey.map((k) => filtered[k] ?? null);
  const existing = sqlite
    .prepare(`SELECT * FROM "${table}" WHERE ${whereParts} LIMIT 1`)
    .get(...whereVals) as Record<string, unknown> | undefined;

  if (!existing) {
    const cols = Object.keys(filtered);
    const placeholders = cols.map(() => "?").join(", ");
    const colList = cols.map((c) => `"${c}"`).join(", ");
    sqlite
      .prepare(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`)
      .run(...cols.map((c) => filtered[c]));
    return "inserted";
  }

  const toSet: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filtered)) {
    if (naturalKey.includes(k)) continue;
    if (schema.pkCols.has(k)) continue;
    if (JSON.stringify(existing[k]) !== JSON.stringify(v)) {
      toSet[k] = v;
    }
  }
  if (Object.keys(toSet).length === 0) return "unchanged";

  const setCols = Object.keys(toSet);
  const setClause = setCols.map((c) => `"${c}" = ?`).join(", ");
  const setVals = setCols.map((c) => toSet[c]);
  sqlite
    .prepare(`UPDATE "${table}" SET ${setClause} WHERE ${whereParts}`)
    .run(...setVals, ...whereVals);
  return "updated";
}

/**
 * Coerce JSON-shaped values to what better-sqlite3 accepts as bind
 * parameters: booleans → 0/1 ints; arrays/objects untouched (the
 * caller is responsible for JSON-stringifying when the target column
 * is text-storing-JSON; backups round-trip via SELECT * which gives
 * us TEXT already on the way out).
 *
 * Without this coercion an `INSERT … VALUES (?, ?)` with a `true`
 * boolean throws "SQLite3 can only bind numbers, strings, bigints,
 * buffers, and null" at runtime.
 */
function normalizeSqliteValue(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}
