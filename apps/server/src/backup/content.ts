/**
 * Content-snapshot export + import — JSON full-mirror format (v2).
 *
 * Format v1 was a curated subset (items / ranks / name-styles /
 * custom-commands / title-kinds / site-settings / system rooms +
 * worlds). v2 is a FULL MIRROR — every per-user, per-character,
 * per-room, per-world, per-message table lands in the document so
 * an import is "wipe + replace" semantics, not "merge customs."
 *
 * The full-DB backup (`./full.ts`, VACUUM INTO) is still the fast
 * path for same-schema-version disaster recovery; v2 content is
 * the slower JSON-portable alternative that survives cross-version
 * migration via the schemaMigrations gate.
 *
 * Two operations:
 *
 *   exportContent(db): produces a BackupContentDocument
 *       - enumerates `sqlite_master` for every user table
 *       - skips transient + install-specific tables (sessions,
 *         push_subscriptions, message_activity, _migrations,
 *         sqlite_sequence)
 *       - strips install-specific columns from site_settings
 *         (VAPID keys, updated_by_id user reference)
 *       - records the source install's applied migrations so import
 *         can refuse a mismatched target install
 *
 *   importContent(db, doc, actorUserId): destructive mirror restore
 *       - REJECTS doc.version !== BACKUP_FORMAT_VERSION
 *       - REJECTS doc.kind !== "content"
 *       - REJECTS docs with a migration the target install hasn't
 *         applied yet (would reference columns that don't exist)
 *       - opens a transaction with `PRAGMA defer_foreign_keys = ON`,
 *         disables `foreign_keys` enforcement during inserts (so
 *         mass-replace doesn't trip cascade rules mid-restore), then
 *         for each table in the doc: DELETE FROM, INSERT every row
 *       - runs `PRAGMA foreign_key_check` BEFORE COMMIT — any
 *         dangling reference aborts the whole transaction
 *       - re-enables `foreign_keys` after COMMIT (or rollback)
 *
 * Diff helper (diffContent) reports per-table row counts so the
 * inspect-preview modal warns the admin which rows they're about
 * to overwrite or lose.
 *
 * Implementation note: bypasses the drizzle ORM and uses the raw
 * better-sqlite3 handle. Backups need dynamic SQL on table names
 * chosen at runtime (PRAGMA table_info, DELETE FROM "<table>",
 * INSERT INTO "<table>" (...)), which drizzle's typed builder
 * doesn't model. The `sqliteHandle` export from db/index.ts is the
 * documented escape hatch.
 */

import {
  BACKUP_FORMAT_VERSION,
  type BackupContentDocument,
  type BackupContentTableMap,
  type ContentImportDiff,
  type ContentImportDiffEntry,
} from "@thekeep/shared";
import type Database from "better-sqlite3";

/**
 * Columns we DROP from the `site_settings` row before adding it to
 * the export. These are install-specific identity values; round-
 * tripping them across installs causes silent breakage (VAPID key
 * swap invalidates every existing browser subscription;
 * updated_by_id references a user that doesn't exist on the
 * target install).
 */
const SITE_SETTINGS_STRIP = new Set([
  "vapid_public_key",
  "vapid_private_key",
  "updated_by_id",
]);

/**
 * Tables that NEVER ride along in a content export.
 *
 *   _migrations         — bookkeeping; serialized into the
 *                         schemaMigrations header instead.
 *   sessions            — live auth state; importing them would
 *                         splice another install's logins onto this
 *                         one. Everyone gets re-prompted (correct
 *                         behavior post-restore anyway).
 *   push_subscriptions  — bound to the source install's VAPID keys;
 *                         re-using them would send pushes that
 *                         neither browser nor server can decrypt.
 *   message_activity    — transient 26h ledger driving the splash
 *                         beacon; rebuilds itself naturally.
 *   sqlite_sequence     — SQLite internal AUTOINCREMENT counter;
 *                         SQLite manages this row, not us.
 */
const SKIP_TABLES = new Set([
  "_migrations",
  "sessions",
  "push_subscriptions",
  "message_activity",
  "sqlite_sequence",
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

/**
 * Enumerate every user-defined table from `sqlite_master`, filter
 * out the SKIP_TABLES + SQLite internals (sqlite_*), and return
 * the names in alphabetical order. Stable ordering keeps the
 * export document diff-friendly across runs.
 */
function listExportableTables(sqlite: Database.Database): string[] {
  const rows = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((n) => !SKIP_TABLES.has(n));
}

/* ============================================================
 *  Export
 * ============================================================ */

export function exportContent(sqlite: Database.Database): BackupContentDocument {
  const tableData: BackupContentTableMap = {};
  for (const table of listExportableTables(sqlite)) {
    // Table name comes from sqlite_master — never user input.
    // better-sqlite3 doesn't parameter-bind identifiers anyway, so
    // the inline interpolation here is the standard pattern.
    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
    if (table === "site_settings") {
      // Strip the install-specific columns from each site_settings
      // row before adding it to the export. The table is a singleton
      // in practice; iterating just makes the strip pass uniform
      // with the rest of the function.
      tableData[table] = rows.map(stripSiteSettingsRow);
    } else {
      tableData[table] = rows;
    }
  }

  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: Date.now(),
    sourceApp: "thekeep",
    schemaMigrations: readSchemaMigrations(sqlite),
    kind: "content",
    tableData,
  };
}

function stripSiteSettingsRow(row: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SITE_SETTINGS_STRIP.has(k)) continue;
    cleaned[k] = v;
  }
  return cleaned;
}

/* ============================================================
 *  Diff (for the inspect endpoint)
 * ============================================================ */

/**
 * Per-table row count comparison for the admin's inspect modal.
 * v2 import is destructive (DELETE + INSERT per table), so the
 * useful numbers are:
 *   - toAdd        = rows the doc carries for this table (post-
 *                    import row count)
 *   - onlyOnTarget = rows currently on the target that will be
 *                    DELETED when the import wipes the table
 *   - toUpdate     = 0 (reserved for a future selective-merge mode)
 *   - unchanged    = 0 (every row gets re-inserted)
 *
 * Migration-mismatch detection mirrors v1: a target install behind
 * on schema migrations gets a `missingMigrations` warning that the
 * route handler turns into a refusal.
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

  const targetTables = new Set(listExportableTables(sqlite));
  const entries: ContentImportDiffEntry[] = [];

  // Tables the doc carries: each row is going to land; existing
  // target rows are going to be DELETEd.
  for (const [table, rows] of Object.entries(doc.tableData)) {
    if (!targetTables.has(table)) {
      // The target install doesn't have this table at all. The
      // import will skip it (logged), so report zero impact.
      entries.push({ table, toAdd: 0, toUpdate: 0, onlyOnTarget: 0, unchanged: 0 });
      continue;
    }
    const targetCount = countRows(sqlite, table);
    entries.push({
      table,
      toAdd: rows.length,
      toUpdate: 0,
      onlyOnTarget: targetCount,
      unchanged: 0,
    });
  }

  // Tables on the target that the doc DOESN'T carry. The import
  // leaves these alone — only tables explicitly in `tableData` get
  // wiped. Surfaced as onlyOnTarget so the admin can see them.
  const docTables = new Set(Object.keys(doc.tableData));
  for (const table of targetTables) {
    if (docTables.has(table)) continue;
    const targetCount = countRows(sqlite, table);
    if (targetCount === 0) continue;
    entries.push({
      table,
      toAdd: 0,
      toUpdate: 0,
      onlyOnTarget: targetCount,
      unchanged: 0,
    });
  }

  return {
    uploadedVersion: doc.version,
    serverVersion: BACKUP_FORMAT_VERSION,
    missingMigrations,
    extraMigrationsOnServer,
    entries,
  };
}

function countRows(sqlite: Database.Database, table: string): number {
  const row = sqlite
    .prepare(`SELECT count(*) AS n FROM "${table}"`)
    .get() as { n: number };
  return row.n;
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
 * Apply a content document as a destructive 1:1 mirror restore.
 * Caller MUST have validated the schema-migration prerequisites
 * before calling (via `diffContent`).
 *
 * Atomicity: better-sqlite3's `db.transaction()` wraps the work in
 * BEGIN/COMMIT. Inside the transaction we `PRAGMA defer_foreign_keys`
 * so dependent inserts don't fail mid-replay just because their
 * referenced rows haven't been re-inserted yet. We then DELETE
 * FROM each table in the doc and INSERT every row from source.
 * Before COMMIT we run `PRAGMA foreign_key_check` and abort the
 * whole transaction if any dangling references remain.
 *
 * `foreign_keys` pragma is turned OFF for the duration of the
 * import so the DELETE pass doesn't fire ON DELETE CASCADE triggers
 * that would chain-nuke dependents we're about to re-insert
 * ourselves. Restored to its prior value in `finally`.
 *
 * Returns a count of inserted rows. `updated` and `unchanged` are
 * always zero in v2 — every row goes through DELETE+INSERT — but
 * the field shape is preserved for back-compat with the admin UI.
 *
 * `actorUserId` is currently unused (kept in the signature for
 * back-compat with v1, where it acted as the FK-safe fallback for
 * `created_by_id` columns on imported customizations). v2's full
 * mirror carries source `created_by_id` values verbatim; if the
 * referenced user isn't in the same export, the FK check at COMMIT
 * catches it.
 */
export function importContent(
  sqlite: Database.Database,
  doc: BackupContentDocument,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actorUserId: string,
): ImportResult {
  if (doc.version !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Backup format v${doc.version} cannot be imported by this server (expects v${BACKUP_FORMAT_VERSION}). Re-export from a current install.`,
    );
  }
  if (doc.kind !== "content") {
    throw new Error(`Expected a content backup, got kind="${doc.kind}".`);
  }

  const targetTables = new Set(listExportableTables(sqlite));
  let inserted = 0;
  const skippedMissingTable: string[] = [];

  // `foreign_keys` is a connection-level pragma that doesn't roll
  // back with a transaction. We toggle it OFF before BEGIN so the
  // DELETE pass doesn't fire ON DELETE CASCADE rules (which would
  // chain-nuke dependents we're about to re-insert), then ON in
  // `finally` so subsequent connection usage stays safe.
  const previousFkRow = sqlite.pragma("foreign_keys", { simple: true });
  const previousFk = previousFkRow === 1 || previousFkRow === "1";

  try {
    sqlite.pragma("foreign_keys = OFF");

    const tx = sqlite.transaction(() => {
      // Defer FK validation to COMMIT time — lets us replay rows in
      // any order without each individual INSERT having to satisfy
      // FK preconditions. The pre-COMMIT `foreign_key_check` below
      // is the safety net.
      sqlite.exec("PRAGMA defer_foreign_keys = ON");

      for (const [table, rows] of Object.entries(doc.tableData)) {
        if (!targetTables.has(table)) {
          // Doc carries a table the target install doesn't have
          // (older schema). Skip cleanly and report; the migration-
          // mismatch check at the route layer should usually catch
          // this first.
          skippedMissingTable.push(table);
          continue;
        }
        sqlite.exec(`DELETE FROM "${table}"`);
        if (rows.length === 0) continue;
        // Build the INSERT statement once per table using the
        // union of columns across the document's rows (intersected
        // with the target schema). Different rows in the same
        // table dump should have the same shape since we read via
        // SELECT *, but defensive intersection here covers a
        // hand-edited document or a future export-time column add
        // on a target that hasn't migrated yet.
        const validCols = tableColumnSet(sqlite, table);
        // Use the FIRST row's keys (filtered) as the column list —
        // SELECT * always returns the same column set per call, so
        // every row in the dump shares the shape.
        const firstRow = rows[0]!;
        const cols = Object.keys(firstRow).filter((c) => validCols.has(c));
        if (cols.length === 0) continue;
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const placeholders = cols.map(() => "?").join(", ");
        const insert = sqlite.prepare(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
        );
        for (const row of rows) {
          const values = cols.map((c) => normalizeSqliteValue(row[c]));
          insert.run(...values);
          inserted += 1;
        }
      }

      // Before COMMIT, validate every FK still resolves. Returns
      // one row per violation; an empty array means the post-
      // import state is consistent. We sample the first few in the
      // error so the admin gets a useful hint without dumping the
      // entire violation list.
      const violations = sqlite.prepare("PRAGMA foreign_key_check").all() as Array<{
        table: string;
        rowid: number;
        parent: string;
        fkid: number;
      }>;
      if (violations.length > 0) {
        const sample = violations.slice(0, 5).map((v) => `${v.table}#${v.rowid}→${v.parent}`).join(", ");
        throw new Error(
          `Import would leave ${violations.length} FK violation(s) — aborted. First few: ${sample}`,
        );
      }
    });

    tx();
  } finally {
    // Restore the connection-level pragma. Most installs run with
    // `foreign_keys = ON` (set at db open time in db/index.ts).
    sqlite.pragma(`foreign_keys = ${previousFk ? "ON" : "OFF"}`);
  }

  if (skippedMissingTable.length > 0) {
    // Surface skipped tables in the result via a log; the result
    // shape doesn't have a free-form warning field, but the import
    // log line at the route layer captures it.
    // eslint-disable-next-line no-console
    console.warn(
      `[backup/content] skipped ${skippedMissingTable.length} table(s) not present on target: ${skippedMissingTable.join(", ")}`,
    );
  }

  return { inserted, updated: 0, unchanged: 0 };
}

/**
 * Per-call cache of valid column names per table. Avoids re-running
 * PRAGMA table_info during a multi-thousand-row import.
 */
const tableColumnCache = new Map<string, Set<string>>();
function tableColumnSet(sqlite: Database.Database, table: string): Set<string> {
  const cached = tableColumnCache.get(table);
  if (cached) return cached;
  const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  const set = new Set(cols.map((c) => c.name));
  tableColumnCache.set(table, set);
  return set;
}

/**
 * Coerce JSON-shaped values to what better-sqlite3 accepts as bind
 * parameters: booleans → 0/1 ints; `undefined` → null. Arrays /
 * objects pass through untouched (callers are responsible for
 * JSON-stringifying when the target column is text-storing-JSON;
 * backups round-trip via SELECT *, which gives us TEXT already on
 * the way out).
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
