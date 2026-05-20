/**
 * Full-database snapshot — atomic SQLite file copy.
 *
 * Two operations:
 *
 *   createFullSnapshot(trigger): runs `VACUUM INTO '<path>'` to
 *       produce a consistent copy of the live database in a single
 *       atomic SQL statement. The result is a plain SQLite file
 *       that the admin can download, archive, or upload back to
 *       another install. VACUUM INTO also rebuilds the page layout
 *       in the copy, so the snapshot is the smallest possible
 *       representation of the data (no fragmentation, no free pages).
 *
 *   stagePendingRestore(uploadPath): validates the uploaded file is
 *       a SQLite database with the expected schema migrations, then
 *       renames it into the canonical "pending restore" slot. The
 *       container entry script (Dockerfile CMD) checks for this slot
 *       on next boot and swaps it into place before
 *       apply-migrations.mjs runs.
 *
 * Why the boot-swap pattern instead of hot-swapping the better-
 * sqlite3 handle in-process: better-sqlite3 holds a long-lived
 * file descriptor + WAL pointer; swapping the file under it would
 * leave the existing handle reading stale pages and the WAL would
 * be against the wrong file. Restarting the process is the only
 * reliable way to land a different DB file. Fly auto-restarts
 * exited machines, so the route returns 200, the server exits,
 * and the new container boots into the restored DB.
 */

import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import type { FullBackupInspectReport } from "@thekeep/shared";
import { sqliteHandle, sqlitePath } from "../db/index.js";
import { moveIntoSnapshots, newSnapshotPath } from "./snapshots.js";

/**
 * Path to the "pending restore" file. When this file exists at
 * container start, the Dockerfile entry script renames it over the
 * canonical sqlite path (atomic on the same filesystem) and the
 * server boots into the restored database. The marker uses a
 * leading dot so it doesn't get mistaken for a normal data file by
 * casual operators eyeballing /data.
 */
export function pendingRestorePath(): string {
  return resolve(dirname(sqlitePath), ".thekeep-pending-restore.sqlite");
}

/**
 * Path to the worker script. Resolved relative to THIS module so
 * it survives bundling/copying — the worker is a sibling .mjs file
 * inside the same backup/ directory. Computed once at module-load
 * because workers respawn on every snapshot request and re-deriving
 * the path each call would mean redundant `fileURLToPath` work.
 */
const WORKER_PATH = fileURLToPath(new URL("./full-worker.mjs", import.meta.url));

/**
 * Run `VACUUM INTO` against the live DB to produce a consistent
 * snapshot at the given path. The target must not already exist —
 * VACUUM INTO refuses to overwrite, which is the safety we want
 * (we deliberately mint a fresh filename via newSnapshotPath).
 *
 * Runs the VACUUM INTO call inside a worker thread so the main Node
 * event loop stays unblocked. On a multi-hundred-MB DB the VACUUM
 * can take seconds; doing it on the main thread would freeze chat
 * for everyone the snapshot's duration. The worker holds its OWN
 * read-only better-sqlite3 handle on the same file — SQLite's WAL
 * mode lets readers proceed alongside the VACUUM's writer.
 *
 * Returns the absolute path + size of the new snapshot.
 */
export async function createFullSnapshot(
  trigger: "manual" | "pre_full_import" | "pre_content_import",
): Promise<{ path: string; sizeBytes: number }> {
  const dest = newSnapshotPath("full", trigger);
  await runVacuumWorker(sqlitePath, dest);
  const sizeBytes = statSync(dest).size;
  return { path: dest, sizeBytes };
}

/**
 * Spawn the VACUUM INTO worker and resolve when it finishes.
 * Rejects on worker error, non-zero exit, or an explicit
 * `{ ok: false }` message. Cleans up partially-written destination
 * files on failure so a crashed worker doesn't leave a corrupt
 * .sqlite stub in the snapshots directory.
 */
function runVacuumWorker(sourcePath: string, destPath: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { sourcePath, destPath },
    });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        // Best-effort cleanup of any half-written destination so a
        // later inspect doesn't pick up a corrupt file.
        try { if (existsSync(destPath)) unlinkSync(destPath); }
        catch { /* nothing useful to do */ }
        rejectP(err);
      } else {
        resolveP();
      }
    };
    worker.on("message", (msg: { ok: boolean; error?: string }) => {
      if (msg.ok) finish();
      else finish(new Error(msg.error ?? "VACUUM INTO worker reported failure"));
    });
    worker.on("error", (err) => finish(err));
    worker.on("exit", (code) => {
      if (code !== 0 && !settled) finish(new Error(`VACUUM INTO worker exited ${code}`));
    });
  });
}

/**
 * Inspect an uploaded .sqlite file without committing to a restore.
 * Opens the file read-only, validates magic + the `_migrations`
 * table, reads row counts for the headline tables. Lets the admin
 * sanity-check the upload (right install? right time period?)
 * before clicking Confirm.
 *
 * Returns `{ ok: false }` on any open/validation failure — the
 * caller surfaces that to the admin as "this doesn't look like a
 * valid SQLite backup."
 */
export function inspectFullBackup(uploadPath: string): FullBackupInspectReport {
  let candidate: Database.Database | null = null;
  try {
    const sizeBytes = statSync(uploadPath).size;
    // Open read-only so a hostile upload can't trigger writes during
    // open (e.g. WAL replay onto an attacker-controlled file).
    candidate = new Database(uploadPath, { readonly: true, fileMustExist: true });
    // Basic sanity: query the schema. Any throw here means it's not
    // a SQLite DB at all (different magic) or it's corrupt.
    candidate.prepare("SELECT name FROM sqlite_master LIMIT 1").all();

    // Schema-shape sanity: refuse a SQLite file that doesn't look
    // like one of OUR databases. Without this, an upload of an
    // unrelated SQLite (a customer's downloaded app data, a
    // browser's IndexedDB dump, etc.) would pass the magic-byte
    // check, get staged for restore, and on next boot every
    // migration in `drizzle/` would try to run against a totally
    // foreign schema — corrupting the install. The presence of the
    // `users` table + the seed-time 'system' sentinel row is the
    // cheapest "this came from a Spire install" gate; both are
    // guaranteed by ensureSystemSeeds on every fresh DB.
    const sentinel = candidate
      .prepare(`SELECT id FROM "users" WHERE id = 'system' LIMIT 1`)
      .get() as { id: string } | undefined;
    if (!sentinel) {
      return {
        ok: false,
        sizeBytes,
        schemaMigrations: [],
        missingMigrations: [],
        extraMigrationsOnServer: [],
        counts: { users: 0, characters: 0, messages: 0, rooms: 0 },
      };
    }

    // Migration list. Empty if the upload predates the migrations
    // table — we still allow inspect to succeed; the import gate
    // will refuse on the missingMigrations side.
    let candidateMigrations: string[] = [];
    try {
      const rows = candidate
        .prepare("SELECT filename FROM _migrations ORDER BY filename")
        .all() as Array<{ filename: string }>;
      candidateMigrations = rows.map((r) => r.filename);
    } catch {
      candidateMigrations = [];
    }
    const candidateSet = new Set(candidateMigrations);

    // Live migration list for the diff.
    let liveMigrations: string[] = [];
    try {
      const rows = sqliteHandle
        .prepare("SELECT filename FROM _migrations ORDER BY filename")
        .all() as Array<{ filename: string }>;
      liveMigrations = rows.map((r) => r.filename);
    } catch {
      liveMigrations = [];
    }
    const liveSet = new Set(liveMigrations);

    const missingMigrations = candidateMigrations.filter((m) => !liveSet.has(m));
    const extraMigrationsOnServer = liveMigrations.filter((m) => !candidateSet.has(m));

    // Row counts — wrap each in try/catch so a backup made from an
    // older schema (without one of these tables) still reports a
    // sensible inspect rather than failing outright.
    const counts = {
      users: safeCount(candidate, "users"),
      characters: safeCount(candidate, "characters"),
      messages: safeCount(candidate, "messages"),
      rooms: safeCount(candidate, "rooms"),
    };

    return {
      ok: true,
      sizeBytes,
      schemaMigrations: candidateMigrations,
      missingMigrations,
      extraMigrationsOnServer,
      counts,
    };
  } catch {
    return {
      ok: false,
      sizeBytes: 0,
      schemaMigrations: [],
      missingMigrations: [],
      extraMigrationsOnServer: [],
      counts: { users: 0, characters: 0, messages: 0, rooms: 0 },
    };
  } finally {
    try { candidate?.close(); } catch { /* nothing useful to do */ }
  }
}

function safeCount(db: Database.Database, table: string): number {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number } | undefined;
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Stage an uploaded SQLite file as the pending restore. On next
 * container boot the entry script will rename it over the canonical
 * sqlite path before the server starts. Caller is expected to:
 *
 *   1. Take a pre-restore safety snapshot of the LIVE DB FIRST
 *      (via createFullSnapshot("pre_full_import")) and stash the
 *      path in the audit log so a botched restore is one click
 *      away from undo.
 *   2. Validate the upload via inspectFullBackup first.
 *   3. Call this function to commit the restore.
 *   4. Return 200 to the admin and exit the process so the
 *      container restarts.
 *
 * Implementation: rename the upload to the .pending-restore slot.
 * Rename is atomic within the same filesystem (which /data is). If
 * the pending slot already holds a previous attempt, we overwrite
 * it — only the LATEST staged upload survives, which matches the
 * "click Import again with a different file" expectation.
 */
export function stagePendingRestore(uploadPath: string): { stagedAt: string } {
  const dest = pendingRestorePath();
  // Always explicit unlink-then-rename. POSIX rename(2) overwrites
  // by default; Windows fs.renameSync does not (it throws EEXIST).
  // The explicit unlink keeps the behavior identical across hosts
  // and survives a leftover pending file from a previous attempt
  // the admin abandoned without restarting.
  if (existsSync(dest)) unlinkSync(dest);
  renameSync(uploadPath, dest);
  return { stagedAt: dest };
}

/**
 * Path for a temp file used during a full-DB upload — sits next to
 * the snapshots so the rename-into-place into the pending slot is
 * an atomic move on the same filesystem. The filename includes a
 * random suffix so concurrent admin attempts don't clobber each
 * other.
 */
export function newUploadTempPath(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return join(dirname(sqlitePath), `.thekeep-upload-${rand}.sqlite`);
}

/**
 * Move a completed snapshot upload into the snapshots directory so
 * the admin can download/inspect it later (e.g. after they decide
 * NOT to commit to the restore). Returns the new absolute path.
 */
export function archiveFullUpload(tempPath: string): string {
  return moveIntoSnapshots(tempPath, "full", "manual");
}
