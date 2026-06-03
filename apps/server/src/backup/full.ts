/**
 * Full-database snapshot — atomic SQLite copy bundled with the
 * uploads tree inside a ZIP envelope (format v3+).
 *
 * Two operations:
 *
 *   createFullSnapshot(trigger, uploadsRoot): runs `VACUUM INTO` to
 *       produce a consistent .sqlite copy of the live database in a
 *       single atomic SQL statement, then packs that .sqlite plus
 *       the entire `/data/uploads/` tree into a single .zip archive
 *       at /data/backups/. VACUUM INTO also rebuilds the page
 *       layout, so the inner .sqlite is the smallest possible
 *       representation of the data; ZIP deflate then compresses
 *       further. The temp .sqlite is unlinked after packing.
 *
 *   inspectFullBackup(uploadZipPath, uploadsRoot): peeks at an
 *       uploaded .zip without committing to a restore. Validates
 *       the ZIP envelope, extracts the inner .sqlite to a temp slot,
 *       opens it read-only to validate magic + the users.system
 *       sentinel, reads row counts + migrations. Returns a
 *       FullBackupInspectReport that also surfaces the bundled
 *       uploads count + bytes so the admin can sanity-check.
 *
 *   stagePendingRestore(uploadZipPath, uploadsRoot): extracts the
 *       inner .sqlite into the canonical "pending restore" slot
 *       AND extracts the uploads tree into the canonical
 *       "pending uploads" slot. The container entry script
 *       (Dockerfile CMD) checks for both on next boot and swaps
 *       them into place before apply-migrations.mjs runs.
 *
 * Why the boot-swap pattern instead of hot-swapping in-process:
 * better-sqlite3 holds a long-lived file descriptor + WAL pointer;
 * swapping the file under it would leave the existing handle reading
 * stale pages and the WAL would be against the wrong file.
 * Restarting the process is the only reliable way to land a
 * different DB file. Fly auto-restarts exited machines, so the
 * route returns 200, the server exits, and the new container boots
 * into the restored DB + restored uploads.
 */

import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import type { FullBackupInspectReport } from "@thekeep/shared";
import { sqliteHandle, sqlitePath } from "../db/index.js";
import {
  extractFullDatabase,
  extractUploadsTo,
  newFullDbTempPath,
  packFullArchive,
  peekArchive,
  pendingUploadsPath,
} from "./archive.js";
import { backupsDir, moveIntoSnapshots, newSnapshotPath } from "./snapshots.js";

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
 * SQLite copy at a temp path, then pack that copy plus the live
 * uploads tree into the .zip archive at the snapshot destination.
 * The temp .sqlite is unlinked after packing.
 *
 * The VACUUM INTO call runs inside a worker thread so the main Node
 * event loop stays unblocked. On a multi-hundred-MB DB the VACUUM
 * can take seconds; doing it on the main thread would freeze chat
 * for everyone the snapshot's duration. The worker holds its OWN
 * read-only better-sqlite3 handle on the same file — SQLite's WAL
 * mode lets readers proceed alongside the VACUUM's writer.
 *
 * Returns the absolute path + size of the new snapshot .zip.
 */
export async function createFullSnapshot(
  trigger: "manual" | "pre_full_import" | "pre_content_import",
  uploadsRoot: string,
): Promise<{ path: string; sizeBytes: number; uploadsFileCount: number; uploadsBytes: number }> {
  const dest = newSnapshotPath("full", trigger);
  const tempDbPath = newFullDbTempPath(backupsDir());
  // Defensive: VACUUM INTO refuses to overwrite, but we just minted
  // a fresh random temp name so it shouldn't already exist anyway.
  if (existsSync(tempDbPath)) unlinkSync(tempDbPath);

  await runVacuumWorker(sqlitePath, tempDbPath);
  // packFullArchive unlinks tempDbPath after packing.
  const result = await packFullArchive({
    sourceDbPath: tempDbPath,
    uploadsRoot,
    destPath: dest,
  });
  return {
    path: dest,
    sizeBytes: result.sizeBytes,
    uploadsFileCount: result.uploadsFileCount,
    uploadsBytes: result.uploadsBytes,
  };
}

/**
 * Spawn the VACUUM INTO worker and resolve when it finishes.
 * Rejects on worker error, non-zero exit, or an explicit
 * `{ ok: false }` message. Cleans up partially-written destination
 * files on failure so a crashed worker doesn't leave a corrupt
 * .sqlite stub.
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
 * Inspect an uploaded .zip backup without committing to a restore.
 * Validates the envelope, extracts the inner database.sqlite to a
 * temp path, opens it read-only to check schema-shape + row counts.
 *
 * Returns `{ ok: false, ...empty }` on any open/validation failure —
 * the caller surfaces that to the admin as "this doesn't look like a
 * valid Spire backup archive."
 */
export async function inspectFullBackup(
  uploadZipPath: string,
): Promise<FullBackupInspectReport> {
  const empty: FullBackupInspectReport = {
    ok: false,
    sizeBytes: 0,
    schemaMigrations: [],
    missingMigrations: [],
    extraMigrationsOnServer: [],
    counts: { users: 0, characters: 0, messages: 0, rooms: 0 },
    uploadsFileCount: 0,
    uploadsBytes: 0,
  };

  let peek: Awaited<ReturnType<typeof peekArchive>>;
  try {
    peek = await peekArchive(uploadZipPath);
  } catch {
    return empty;
  }
  if (peek.kind !== "full") {
    // Wrong kind — the inspect call should route to the content
    // inspector instead. Returning ok:false surfaces that.
    return { ...empty, sizeBytes: peek.archiveBytes };
  }

  // Extract the inner .sqlite to a sibling temp slot for read-only
  // inspection. We never open it in-place from the archive — JSZip
  // doesn't expose the entry as a seekable file descriptor.
  const tempInnerDb = join(dirname(uploadZipPath), `.inspect-inner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  try {
    await extractFullDatabase({ zipPath: uploadZipPath, destDbPath: tempInnerDb });
  } catch {
    return { ...empty, sizeBytes: peek.archiveBytes };
  }

  let candidate: Database.Database | null = null;
  try {
    // Open read-only so a hostile upload can't trigger writes during
    // open (e.g. WAL replay onto an attacker-controlled file).
    candidate = new Database(tempInnerDb, { readonly: true, fileMustExist: true });
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
      return { ...empty, sizeBytes: peek.archiveBytes, uploadsFileCount: peek.uploadsFileCount, uploadsBytes: peek.uploadsBytes };
    }

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

    const counts = {
      users: safeCount(candidate, "users"),
      characters: safeCount(candidate, "characters"),
      messages: safeCount(candidate, "messages"),
      rooms: safeCount(candidate, "rooms"),
    };

    return {
      ok: true,
      sizeBytes: peek.archiveBytes,
      schemaMigrations: candidateMigrations,
      missingMigrations,
      extraMigrationsOnServer,
      counts,
      uploadsFileCount: peek.uploadsFileCount,
      uploadsBytes: peek.uploadsBytes,
    };
  } catch {
    return { ...empty, sizeBytes: peek.archiveBytes };
  } finally {
    try { candidate?.close(); } catch { /* nothing useful to do */ }
    try { if (existsSync(tempInnerDb)) unlinkSync(tempInnerDb); }
    catch { /* nothing useful to do */ }
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
 * Stage an uploaded .zip archive as the pending full restore. On next
 * container boot the entry script renames the staged .sqlite over the
 * canonical sqlite path AND swaps the staged uploads tree over the
 * canonical uploads root before the server starts. Caller is expected
 * to:
 *
 *   1. Take a pre-restore safety snapshot of the LIVE DB+uploads
 *      FIRST (via createFullSnapshot("pre_full_import", uploadsRoot))
 *      and stash the path in the audit log so a botched restore is
 *      one click away from undo.
 *   2. Validate the upload via inspectFullBackup first.
 *   3. Call this function to commit the restore.
 *   4. Return 200 to the admin and exit the process so the container
 *      restarts.
 *
 * Implementation — two-phase to avoid the "DB swap but no uploads
 * swap" half-restore failure mode:
 *   Phase 1 (extract both to TEMP slots):
 *     - Extract database.sqlite to a sibling temp file.
 *     - Extract uploads/** to a sibling temp directory.
 *     If either phase-1 step throws, both temp slots are cleaned up
 *     and the pending slots are left untouched (and the operator
 *     sees the error). Crucially, the pending slots are NOT written
 *     until both extractions have completed successfully.
 *   Phase 2 (atomically swap temps into pending slots):
 *     - Rename temp .sqlite into the pending-restore slot.
 *     - Rename temp uploads dir into the pending-uploads slot.
 *     These are same-filesystem renames so each is atomic. The
 *     ordering means a crash between the two leaves the pending
 *     .sqlite written but no pending uploads — which the boot
 *     script handles fine: the .sqlite gets swapped, uploads stay
 *     untouched (mismatched but recoverable via the safety
 *     snapshot the caller took first). The phase-1 design makes
 *     this last-mile crash window vanishingly small.
 *   Cleanup: the source .zip upload is consumed at the end.
 */
export async function stagePendingRestore(
  uploadZipPath: string,
  uploadsRoot: string,
): Promise<{ stagedAt: string; stagedUploadsAt: string; uploadsFileCount: number }> {
  const dbDest = pendingRestorePath();
  const uploadsDest = pendingUploadsPath(uploadsRoot);
  mkdirSync(dirname(dbDest), { recursive: true });
  mkdirSync(dirname(uploadsDest), { recursive: true });

  const tag = randomBytes(4).toString("hex");
  const tempDb = join(dirname(dbDest), `.thekeep-pending-restore.${tag}.sqlite.staging`);
  const tempUploads = join(dirname(uploadsDest), `.thekeep-pending-uploads.${tag}.staging`);

  // Phase 1 — extract both to temp slots.
  let uploadsFileCount = 0;
  try {
    await extractFullDatabase({ zipPath: uploadZipPath, destDbPath: tempDb });
    const result = await extractUploadsTo({ zipPath: uploadZipPath, destRoot: tempUploads });
    uploadsFileCount = result.fileCount;
  } catch (err) {
    try { if (existsSync(tempDb)) unlinkSync(tempDb); } catch { /* nothing */ }
    try { if (existsSync(tempUploads)) rmSync(tempUploads, { recursive: true, force: true }); } catch { /* nothing */ }
    throw err;
  }

  // Phase 2 — swap temps into the pending slots. POSIX rename(2)
  // overwrites by default; Windows fs.renameSync does not (throws
  // EEXIST). Explicit unlink/rmSync keeps behavior identical across
  // hosts and survives a leftover pending slot from a previous
  // attempt the admin abandoned without restarting.
  if (existsSync(dbDest)) unlinkSync(dbDest);
  renameSync(tempDb, dbDest);
  if (existsSync(uploadsDest)) rmSync(uploadsDest, { recursive: true, force: true });
  renameSync(tempUploads, uploadsDest);

  // The upload .zip is consumed — it's been split into the pending
  // .sqlite + pending uploads dir. Leaving it around would clutter
  // /data with duplicated bytes.
  try { unlinkSync(uploadZipPath); } catch { /* nothing useful to do */ }

  return {
    stagedAt: dbDest,
    stagedUploadsAt: uploadsDest,
    uploadsFileCount,
  };
}

/**
 * Path for a temp file used during a backup .zip upload — sits next
 * to the snapshots so the rename-into-place into the pending slot is
 * an atomic move on the same filesystem. The filename includes a
 * random suffix so concurrent admin attempts don't clobber each
 * other.
 */
export function newUploadTempPath(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return join(dirname(sqlitePath), `.thekeep-upload-${rand}.zip`);
}

/**
 * Move a completed snapshot upload into the snapshots directory so
 * the admin can download/inspect it later (e.g. after they decide
 * NOT to commit to the restore). Returns the new absolute path.
 * The renamed file keeps the .zip extension via the canonical
 * snapshot filename convention.
 *
 * `kind` is required because the same call site handles uploads of
 * both content and full archives — mis-classifying mixes the two
 * kinds in the Snapshots panel and breaks the bucket display.
 */
export function archiveUpload(tempPath: string, kind: "full" | "content"): string {
  return moveIntoSnapshots(tempPath, kind, "manual");
}

