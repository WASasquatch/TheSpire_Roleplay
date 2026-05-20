/**
 * Wire types for the admin Backups tab — full-DB snapshots and
 * content (cosmetics + configuration) snapshots.
 *
 * Two kinds of backup, both produced + consumed by the same admin
 * panel:
 *
 *   "full"    — a complete .sqlite file copy produced by
 *               `VACUUM INTO`. Captures every table including user
 *               accounts, messages, earning ledger, sessions, etc.
 *               Disaster-recovery / install-migration use case.
 *
 *   "content" — a JSON document of admin-customizable tables only:
 *               items, name styles, ranks, rank tiers (borders live
 *               here), custom commands, title kinds, system rooms,
 *               system worlds + their pages, and site_settings
 *               (with install-specific VAPID keys stripped).
 *               Cross-install portable because every row is keyed
 *               by a natural identifier (slug / key / name), so an
 *               import upserts cleanly even on a fresh DB with no
 *               matching autoincrement row IDs.
 */

/**
 * Format version embedded in every backup artifact. Bumped when the
 * shape changes incompatibly (a column added, a table added, a
 * representation changed). Import refuses on version mismatch so
 * silent corruption is impossible — the user gets a clear "this
 * backup was made by a newer build, upgrade first" message instead.
 */
export const BACKUP_FORMAT_VERSION = 1;

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
 *  Content backup — JSON document of admin-customizable tables
 * ============================================================ */

/**
 * Row shapes mirror the database columns closely. We keep them
 * permissive (`Record<string, unknown>` style with required-key
 * helpers) because the server is the source of truth — a strict
 * row interface here would force a copy whenever a column is added
 * to the DB and the only consumer client-side is the diff renderer
 * (which inspects keys generically).
 */
export interface BackupContentTables {
  items: Array<Record<string, unknown>>;
  name_styles: Array<Record<string, unknown>>;
  ranks: Array<Record<string, unknown>>;
  rank_tiers: Array<Record<string, unknown>>;
  custom_commands: Array<Record<string, unknown>>;
  title_kinds: Array<Record<string, unknown>>;
  /** Single-row table — represented as the row object directly when present, null otherwise. */
  site_settings: Record<string, unknown> | null;
  /** is_system=1 rows only. Filtered server-side on export. */
  system_rooms: Array<Record<string, unknown>>;
  /** owner_user_id="system" worlds + their pages. */
  system_worlds: Array<Record<string, unknown>>;
  /** Keyed by world.slug → array of pages for that world (ordered). */
  world_pages_by_world_slug: Record<string, Array<Record<string, unknown>>>;
}

export interface BackupContentDocument extends BackupHeader {
  kind: "content";
  tables: BackupContentTables;
}

/**
 * Diff summary returned by the inspect endpoint. Shows the admin
 * what an import WOULD do before they confirm. Counts only — the
 * server keeps the heavy data in scope until the confirm POST.
 */
export interface ContentImportDiffEntry {
  /** Table name as it appears in the document (e.g. "items"). */
  table: string;
  /** Rows that don't exist on the target → will be INSERTED. */
  toAdd: number;
  /** Rows present on the target but with different values → will be UPDATED. */
  toUpdate: number;
  /**
   * Rows present on the target that are MISSING from the backup. The
   * importer never deletes — these rows survive the import. Surfaced
   * so the admin sees what the import won't touch.
   */
  onlyOnTarget: number;
  /** Rows identical on both sides → no-op. */
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
  /** File size in bytes. */
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
  /** "full" → .sqlite; "content" → .json. */
  kind: "full" | "content";
  /**
   * Why the snapshot exists. Drives client labelling so the admin
   * can tell pre-restore safety copies apart from manual ones.
   */
  trigger: "manual" | "pre_full_import" | "pre_content_import";
  /** Filename on disk (informational; downloads use `id`). */
  filename: string;
}
