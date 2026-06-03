/**
 * Wire types for the admin Backups tab — full-DB snapshots and
 * content (cosmetics + configuration) snapshots.
 *
 * Two kinds of backup, both produced + consumed by the same admin
 * panel:
 *
 *   "full"    — a complete .sqlite file copy produced by
 *               `VACUUM INTO`. Captures every table byte-for-byte
 *               including user accounts, messages, earning ledger,
 *               sessions, etc. Fastest restore path on the same
 *               schema version.
 *
 *   "content" — a JSON document of EVERY exportable table (as of
 *               format v2 — see migration note below). Same coverage
 *               as a full backup, just in a JSON-portable shape
 *               that survives cross-version migration. Excludes
 *               only the transient / install-specific tables
 *               (`sessions`, `push_subscriptions`, `message_activity`,
 *               `_migrations`, `sqlite_sequence`) and strips
 *               install-specific columns from `site_settings`
 *               (VAPID keys, audit attribution to a user that
 *               doesn't exist on the target).
 *
 * Format v1 → v2 migration: v1 documents are REJECTED on import.
 * v1 only covered the admin-customization subset (items/ranks/etc.);
 * v2 is a full mirror that also carries users, characters, messages,
 * earning state, friends, world memberships, item inventories, and
 * everything else per-user. Anyone with a v1 export must re-export
 * from a current install before importing.
 */

/**
 * Format version embedded in every backup artifact. Bumped when the
 * shape changes incompatibly (a column added, a table added, a
 * representation changed). Import refuses on version mismatch so
 * silent corruption is impossible — the user gets a clear "this
 * backup was made by an older build, re-export to migrate" message
 * instead.
 *
 * v3 (current): both kinds are wrapped in a ZIP envelope that
 * carries the database payload AND the full `/data/uploads/` tree
 * (emoticon sheets, logo images, rank sigil + border PNGs). v2 and
 * earlier shipped only the database row referencing `/uploads/...`
 * URLs, which left every uploaded image orphaned on restore. The
 * envelope is the same shape for both kinds; the inner database
 * payload differs:
 *   - content: `content.json` (a BackupContentDocument)
 *   - full:    `database.sqlite` (a VACUUM-INTO snapshot)
 * Plus, for both: `uploads/**` mirroring the live uploads root.
 */
export const BACKUP_FORMAT_VERSION = 3;

/**
 * Filenames inside the ZIP envelope. Stable — restore code matches
 * on these literal paths.
 */
export const BACKUP_ZIP_CONTENT_JSON = "content.json";
export const BACKUP_ZIP_DATABASE_SQLITE = "database.sqlite";
export const BACKUP_ZIP_UPLOADS_PREFIX = "uploads/";

/** Header common to both content + full backups. */
export interface BackupHeader {
  version: number;
  /** Epoch ms when the export was generated. */
  exportedAt: number;
  /** App identifier. Always "thekeep" for now; reserved for forks. */
  sourceApp: "thekeep";
  /**
   * Ordered list of every migration filename recorded in the source
   * install's `_migrations` table. Used on import to refuse when the
   * target install is behind on schema migrations (the import would
   * reference columns that don't exist yet). The target is allowed to
   * be AHEAD — newer columns get default values on upsert.
   */
  schemaMigrations: string[];
}

/* ============================================================
 *  Content backup — JSON document mirroring every exportable table
 * ============================================================ */

/**
 * Per-table row dump. Keyed by SQLite table name; value is the
 * rows as plain objects (one entry per column). Server fills this
 * dynamically by enumerating `sqlite_master` so adding a column
 * (or even a table) doesn't require shared-types churn — the
 * exporter just picks it up and the importer replays it.
 *
 * Tables explicitly NOT included in this map:
 *   - `_migrations`         — bookkeeping; tracked via `schemaMigrations` instead.
 *   - `sessions`            — live auth state; importing them would
 *                             splice another install's logins onto
 *                             this one. Everyone gets re-prompted.
 *   - `push_subscriptions`  — bound to the source install's VAPID
 *                             keys, which don't carry across.
 *   - `message_activity`    — transient activity-beacon ledger;
 *                             rebuilds itself within 24h.
 *   - `sqlite_sequence`     — SQLite internal AUTOINCREMENT counter.
 *
 * `site_settings` is included, but the server strips install-specific
 * columns (VAPID keys, `updated_by_id`) before adding the row to
 * this map.
 */
export type BackupContentTableMap = Record<string, Array<Record<string, unknown>>>;

export interface BackupContentDocument extends BackupHeader {
  kind: "content";
  /**
   * Dynamic per-table row dumps. Every exportable table on the
   * source install lands here. Import replays each table on the
   * target with `INSERT OR REPLACE` semantics under deferred FK
   * checks (so mass-replace doesn't fight cascade triggers). See
   * `importContent` for the full sequence.
   */
  tableData: BackupContentTableMap;
}

/**
 * Diff summary returned by the inspect endpoint. Shows the admin
 * what an import WOULD do before they confirm. Counts only — the
 * server keeps the heavy data in scope until the confirm POST.
 */
export interface ContentImportDiffEntry {
  /** Table name as it appears in the document (e.g. "items"). */
  table: string;
  /**
   * Rows the import will land in this table. With v2 mirror-restore
   * semantics, that's every row in the document — the import wipes
   * the target table first, then re-inserts from source. Surfaced
   * here so the admin sees the post-import row count.
   */
  toAdd: number;
  /** Reserved for future "selective update" mode. Always 0 in v2 (mirror restore replaces). */
  toUpdate: number;
  /**
   * Rows currently on the target that the import WILL DELETE because
   * the document doesn't include them. v2 import is destructive — a
   * full mirror REPLACES the target table — so this number is the
   * "you're about to lose this much data" warning surface.
   */
  onlyOnTarget: number;
  /** Reserved. Always 0 in v2. */
  unchanged: number;
}

export interface ContentImportDiff {
  /** Format version of the uploaded document. */
  uploadedVersion: number;
  /** Format version the server understands. */
  serverVersion: number;
  /**
   * Migrations the uploaded doc was made against that the server
   * hasn't applied yet. Non-empty → refuse the import.
   */
  missingMigrations: string[];
  /**
   * Migrations the server has applied that the uploaded doc wasn't
   * aware of. Allowed; informational only.
   */
  extraMigrationsOnServer: string[];
  entries: ContentImportDiffEntry[];
}

/* ============================================================
 *  Full-DB backup — opaque .sqlite stream
 * ============================================================ */

/**
 * Metadata returned by /admin/backup/full/inspect after the admin
 * uploads a candidate .sqlite. The server opens the uploaded file
 * read-only, validates SQLite magic + the `_migrations` table, and
 * returns this. Lets the admin compare against the live DB before
 * committing to a destructive restore.
 */
export interface FullBackupInspectReport {
  /** Magic-byte validated; we know this is a SQLite file. */
  ok: boolean;
  /** File size in bytes (the outer .zip envelope). */
  sizeBytes: number;
  /** Migrations recorded in the uploaded file's `_migrations` table. */
  schemaMigrations: string[];
  /** Migrations the live install has applied but the upload doesn't. */
  missingMigrations: string[];
  /** Migrations the upload has applied that the live install doesn't. */
  extraMigrationsOnServer: string[];
  /** Row counts for the "is this the right install?" gut-check. */
  counts: {
    users: number;
    characters: number;
    messages: number;
    rooms: number;
  };
  /**
   * Number of files bundled under `uploads/` in the ZIP envelope.
   * Zero is legal (an install with no uploaded emoticons/logos/ranks)
   * but rare. Surfaced so the admin can sanity-check that the archive
   * actually carries the assets they expect.
   */
  uploadsFileCount: number;
  /** Total bytes of all `uploads/**` entries (uncompressed). */
  uploadsBytes: number;
}

/**
 * Inspect report returned by /admin/backup/content/inspect after the
 * admin uploads a candidate content .zip. Wraps the existing per-table
 * diff with the same uploads-bundle headline numbers the full inspect
 * carries.
 */
export interface ContentBackupInspectReport {
  /** True when content.json parsed + the format version matched. */
  ok: boolean;
  /** Size of the outer .zip envelope. */
  sizeBytes: number;
  /** Per-table diff (unchanged from v2). */
  diff: ContentImportDiff;
  /** Files bundled under `uploads/` in the ZIP envelope. */
  uploadsFileCount: number;
  /** Total bytes of all `uploads/**` entries (uncompressed). */
  uploadsBytes: number;
}

/* ============================================================
 *  Snapshot directory (on-disk artifacts)
 * ============================================================ */

/* ============================================================
 *  Operation lock + status
 * ============================================================ */

/**
 * What the backup subsystem is currently doing. At most one
 * operation runs at a time across the whole server — `full_export`
 * and `full_import` move large files around and call `VACUUM INTO`
 * (which blocks SQLite globally on its source), and `content_*`
 * holds a database transaction. Concurrent attempts would compete
 * for the same on-disk slots, so the lock serializes them.
 */
export type BackupOperationKind =
  | "full_export"
  | "full_import"
  | "content_export"
  | "content_import";

/**
 * Returned by GET /admin/backup/status so the admin Backups tab
 * can disable buttons + show "still running" copy while a long
 * VACUUM INTO is in flight. Idle → `currentOperation` is null.
 */
export interface BackupOperationStatus {
  /** When set, no new backup operation can start until this one finishes. */
  currentOperation: {
    kind: BackupOperationKind;
    /** Epoch ms when the operation began — clients format relative time. */
    startedAt: number;
    /** Free-form one-line label suitable for "In progress: <message>" UI. */
    message: string;
  } | null;
}

/**
 * One artifact in the /data/backups/ directory. Returned by
 * /admin/backup/snapshots. Each snapshot is either a
 * pre-import auto-snapshot (taken automatically before any
 * destructive restore/import) or a manual download artifact.
 */
export interface BackupSnapshotEntry {
  /** Server-generated id used for download / delete URLs. Opaque. */
  id: string;
  /** File or document size in bytes. */
  sizeBytes: number;
  /** Epoch ms of file mtime / creation. */
  createdAt: number;
  /** "full" → database.sqlite + uploads/; "content" → content.json + uploads/. Both wrapped in a .zip envelope. */
  kind: "full" | "content";
  /**
   * Why the snapshot exists. Drives client labelling so the admin
   * can tell pre-restore safety copies apart from manual ones.
   */
  trigger: "manual" | "pre_full_import" | "pre_content_import";
  /** Filename on disk (informational; downloads use `id`). */
  filename: string;
}
