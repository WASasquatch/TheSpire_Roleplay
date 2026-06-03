/**
 * On-disk snapshot directory management.
 *
 * Every backup artifact (whether the admin clicked "Create download"
 * or the importer auto-saved a pre-restore safety copy) lands under
 * `/data/backups/` on the persistent volume. That gives the admin
 * panel a single inventory listing of every snapshot the install
 * still holds, and lets them download or roll back from any of them
 * without juggling files locally.
 *
 * Filename convention:
 *
 *   <kind>-<trigger>-<iso-utc-ts>.zip
 *
 *   kind     : "full" | "content"
 *   trigger  : "manual" | "pre-full-import" | "pre-content-import"
 *   iso-utc  : 2026-05-19T14-32-11Z (colons replaced with dashes so the
 *              filename is filesystem-safe on Windows volumes too)
 *
 * Both kinds use a `.zip` envelope (format v3+) so the database
 * payload AND the `/data/uploads/` tree travel together — restoring on
 * a fresh host gets the emoticon sheets, logo images, and rank sigil
 * PNGs alongside the database rows that reference them. The inner
 * layout differs per kind (`content.json` vs `database.sqlite`); the
 * outer extension is uniform.
 *
 * Retention: keep the last MAX_PER_KIND of each {kind, trigger}
 * combination. FIFO rotation by mtime. We don't trim by total size —
 * a single full snapshot can be 100MB+ but the volume is the deploy's
 * persistent /data and is sized for the whole DB, not for backups
 * alone; cap the count and call it a day.
 *
 * Concurrent-writer note: file operations are not atomic across the
 * "rename, list, delete" sequence, but backup creation is admin-
 * gated and not high-traffic. If two admins click Backup at the
 * exact same second we might keep N+1 for one tick; that's fine.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BackupSnapshotEntry } from "@thekeep/shared";
import { sqlitePath } from "../db/index.js";

/** Per-kind retention cap. 10 of each `(kind, trigger)` bucket. */
const MAX_PER_KIND = 10;

/**
 * Backups live next to the SQLite file on the same persistent
 * volume — when SQLITE_PATH is `/data/thekeep.sqlite`, this resolves
 * to `/data/backups/`. The directory is created lazily on first
 * write so a fresh deploy doesn't need a separate provisioning step.
 */
export function backupsDir(): string {
  return resolve(dirname(sqlitePath), "backups");
}

function ensureDir(): string {
  const dir = backupsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

type Kind = "full" | "content";
type Trigger = "manual" | "pre_full_import" | "pre_content_import";

/**
 * Compose the filename for a new snapshot. Iso timestamp is colon-
 * stripped so the resulting filename is safe on every filesystem.
 * Returns the absolute path.
 */
export function newSnapshotPath(kind: Kind, trigger: Trigger, at: Date = new Date()): string {
  const dir = ensureDir();
  const iso = at.toISOString().replace(/[:.]/g, "-");
  const triggerSlug = trigger.replace(/_/g, "-");
  return join(dir, `${kind}-${triggerSlug}-${iso}.zip`);
}

/**
 * Parse a snapshot filename back to its metadata. Returns null on a
 * filename that doesn't match the convention (admin-dropped file,
 * leftover from a different naming scheme) so the listing route
 * silently skips it instead of throwing.
 */
export function parseSnapshotFilename(
  filename: string,
): { kind: Kind; trigger: Trigger; createdAt: number } | null {
  // Pattern: <kind>-<trigger-slug>-<iso>.zip
  // Trigger slug uses dashes, e.g. "pre-full-import"; we capture
  // the kind and the rest, then split the trigger off the leading
  // segment of the rest. Format v3+ uses a uniform `.zip` extension
  // for both kinds (the database payload + `/uploads/` tree are
  // bundled together in the envelope).
  const m = filename.match(/^(full|content)-([\w-]+?)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.zip$/);
  if (!m) return null;
  const [, kindRaw, triggerSlug, isoStamp] = m;
  const kind = kindRaw as Kind;
  const triggerMap: Record<string, Trigger> = {
    "manual": "manual",
    "pre-full-import": "pre_full_import",
    "pre-content-import": "pre_content_import",
  };
  const trigger = triggerMap[triggerSlug!];
  if (!trigger) return null;
  // Reverse the colon strip: the seconds slot has the format
  // "14-32-11-123" (was 14:32:11.123). Reconstruct an ISO string
  // for Date parsing.
  const iso = isoStamp!
    .replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/, "$1T$2:$3:$4.$5Z");
  const createdAt = Date.parse(iso);
  if (Number.isNaN(createdAt)) return null;
  return { kind, trigger, createdAt };
}

/**
 * List every snapshot in the directory, newest first. Filenames that
 * don't match the convention are skipped silently.
 */
export function listSnapshots(): BackupSnapshotEntry[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];
  const entries: BackupSnapshotEntry[] = [];
  for (const filename of readdirSync(dir)) {
    const meta = parseSnapshotFilename(filename);
    if (!meta) continue;
    const fullPath = join(dir, filename);
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(fullPath).size;
    } catch {
      continue;
    }
    entries.push({
      // The id is the filename itself — opaque-enough from the
      // client's perspective, and the download/delete handlers can
      // round-trip back to a real path via the same parse step.
      id: filename,
      sizeBytes,
      createdAt: meta.createdAt,
      kind: meta.kind,
      trigger: meta.trigger,
      filename,
    });
  }
  entries.sort((a, b) => b.createdAt - a.createdAt);
  return entries;
}

/**
 * Resolve a snapshot id (== filename) to its absolute path, after
 * verifying it lives directly under the backups directory. Returns
 * null on any path-traversal attempt or missing file.
 */
export function resolveSnapshotPath(id: string): string | null {
  // Reject anything that could escape the directory. The legal set
  // is the same as our generator: kind-trigger-iso.ext, no slashes.
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  if (!parseSnapshotFilename(id)) return null;
  const fullPath = join(backupsDir(), id);
  if (!existsSync(fullPath)) return null;
  return fullPath;
}

/** Delete a snapshot by id. Returns true on success. */
export function deleteSnapshot(id: string): boolean {
  const fullPath = resolveSnapshotPath(id);
  if (!fullPath) return false;
  try {
    unlinkSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Trim each `(kind, trigger)` bucket down to MAX_PER_KIND entries,
 * dropping the oldest first. Called after every write so the
 * directory never accumulates past the cap; also safe to call from
 * the janitor as a periodic sweep.
 */
export function pruneSnapshots(): { removed: number } {
  const entries = listSnapshots();
  const buckets = new Map<string, BackupSnapshotEntry[]>();
  for (const e of entries) {
    const key = `${e.kind}::${e.trigger}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(e);
  }
  let removed = 0;
  for (const bucket of buckets.values()) {
    // listSnapshots returns newest-first; we want to delete from the
    // tail (oldest) once the count exceeds the cap.
    bucket.sort((a, b) => b.createdAt - a.createdAt);
    for (let i = MAX_PER_KIND; i < bucket.length; i++) {
      const entry = bucket[i]!;
      if (deleteSnapshot(entry.id)) removed++;
    }
  }
  return { removed };
}

/* ============================================================
 *  Read / write helpers (used by the routes layer)
 * ============================================================ */

/** Open a write stream targeting a fresh snapshot path. Caller pipes
 *  data in; the file ends up under /data/backups/ with the canonical
 *  filename. */
export function createSnapshotWriteStream(
  kind: Kind,
  trigger: Trigger,
): { stream: ReturnType<typeof createWriteStream>; path: string } {
  const path = newSnapshotPath(kind, trigger);
  const stream = createWriteStream(path);
  return { stream, path };
}

/** Open a read stream from an existing snapshot. Caller is
 *  responsible for handling 'end'/'error' and for setting
 *  appropriate response headers. */
export function createSnapshotReadStream(
  id: string,
): { stream: ReturnType<typeof createReadStream>; sizeBytes: number; filename: string } | null {
  const path = resolveSnapshotPath(id);
  if (!path) return null;
  const stat = statSync(path);
  return {
    stream: createReadStream(path),
    sizeBytes: stat.size,
    filename: id,
  };
}

/** Move/rename a file into a snapshot slot. Used by the full-DB
 *  exporter after VACUUM INTO finishes writing to a temp path. */
export function moveIntoSnapshots(
  tempPath: string,
  kind: Kind,
  trigger: Trigger,
): string {
  const dest = newSnapshotPath(kind, trigger);
  renameSync(tempPath, dest);
  return dest;
}
