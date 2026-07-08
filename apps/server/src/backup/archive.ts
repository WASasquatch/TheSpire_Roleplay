/**
 * ZIP-envelope archive layer for both kinds of backup (format v3+).
 *
 * Earlier formats shipped JUST the database payload, a `.sqlite` for
 * full-DB snapshots and a `.json` table dump for content snapshots.
 * That left every uploaded asset (emoticon sheets, logo images, rank
 * sigil PNGs) on the source filesystem only; restoring the database on
 * a fresh host produced row references to `/uploads/...` paths that
 * 404'd because the binaries never travelled.
 *
 * v3 wraps the database payload in a ZIP that also carries the entire
 * `/data/uploads/` tree, so a snapshot is genuinely portable: import
 * on any host and every emoticon picker / logo / rank cosmetic shows
 * up with its original image.
 *
 * Envelope layout:
 *
 *   <archive>.zip
 *   ├── content.json   OR   database.sqlite     (the database payload)
 *   └── uploads/
 *       ├── emoticons/<id>.png
 *       ├── logos/<sha>.<ext>
 *       └── ranks/<hash>.png
 *
 * `content.json` is the existing v2 BackupContentDocument as JSON
 * text. `database.sqlite` is the `VACUUM INTO` output from full.ts.
 * Either path is mutually exclusive, the inspect/import code keys
 * the archive's kind off which payload entry is present.
 *
 * Two operational modes:
 *
 *   1. Content restore runs in-process. After the destructive DB
 *      mirror restore commits, syncUploadsFromArchive swaps the live
 *      uploads root atomically (extract to a sibling staging dir,
 *      rename current root to a rollback dir, rename staging into
 *      place). Failure of either half leaves the safety snapshot,
 *      itself a v3 archive, as the rollback path.
 *
 *   2. Full restore stages the .sqlite at the pending-restore slot
 *      AND the uploads tree at a pending-uploads dir; the
 *      Dockerfile/entrypoint swaps both before the server reopens
 *      the database. The process is about to exit anyway, so we
 *      don't do the live-rename dance, we just write to staging
 *      slots and exit.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import {
  BACKUP_ZIP_CONTENT_JSON,
  BACKUP_ZIP_DATABASE_SQLITE,
  BACKUP_ZIP_UPLOADS_PREFIX,
  type BackupContentDocument,
} from "@thekeep/shared";
import JSZip from "jszip";

/* ============================================================
 *  Pack, produce a ZIP envelope
 * ============================================================ */

interface PackResult {
  /** Size of the resulting .zip on disk. */
  sizeBytes: number;
  /** Number of `uploads/**` entries bundled into the archive. */
  uploadsFileCount: number;
  /** Total uncompressed bytes of `uploads/**` entries. */
  uploadsBytes: number;
}

/**
 * Pack a full-DB archive: `database.sqlite` (already produced by a
 * prior `VACUUM INTO` at sourceDbPath) + every file under uploadsRoot
 * mirrored at `uploads/<relpath>`.
 *
 * sourceDbPath is consumed: after the archive is written we unlink
 * the temp .sqlite. Callers want to pass a temp path produced by
 * newFullDbTempPath, not the live database.
 */
export async function packFullArchive(opts: {
  sourceDbPath: string;
  uploadsRoot: string;
  destPath: string;
}): Promise<PackResult> {
  const { sourceDbPath, uploadsRoot, destPath } = opts;
  if (!existsSync(sourceDbPath)) {
    throw new Error(`packFullArchive: source database missing at ${sourceDbPath}`);
  }
  const zip = new JSZip();
  // Stream the .sqlite into the zip via a node Buffer. The full DB
  // can run hundreds of MB; readFile holds it all in RAM, which is
  // unavoidable for JSZip's API. Acceptable trade-off, backups are
  // admin-initiated and serialized behind the backup state lock.
  const dbBytes = await readFile(sourceDbPath);
  zip.file(BACKUP_ZIP_DATABASE_SQLITE, dbBytes);
  const uploadsStats = await addUploadsToZip(zip, uploadsRoot);
  await writeZipToDisk(zip, destPath);
  try {
    unlinkSync(sourceDbPath);
  } catch {
    // Best-effort: a leftover temp .sqlite doesn't break anything.
  }
  return {
    sizeBytes: statSync(destPath).size,
    uploadsFileCount: uploadsStats.fileCount,
    uploadsBytes: uploadsStats.totalBytes,
  };
}

/**
 * Pack a content archive: `content.json` (a BackupContentDocument as
 * pretty-printed JSON) + the whole uploadsRoot tree.
 */
export async function packContentArchive(opts: {
  document: BackupContentDocument;
  uploadsRoot: string;
  destPath: string;
}): Promise<PackResult> {
  const { document, uploadsRoot, destPath } = opts;
  const zip = new JSZip();
  zip.file(BACKUP_ZIP_CONTENT_JSON, JSON.stringify(document, null, 2));
  const uploadsStats = await addUploadsToZip(zip, uploadsRoot);
  await writeZipToDisk(zip, destPath);
  return {
    sizeBytes: statSync(destPath).size,
    uploadsFileCount: uploadsStats.fileCount,
    uploadsBytes: uploadsStats.totalBytes,
  };
}

/**
 * Walk uploadsRoot recursively and add every regular file under the
 * `uploads/<relative-path>` prefix in the zip. Subdirectories are
 * implicit, JSZip creates them on add. Symlinks and special files
 * are skipped (only stats.isFile() entries are taken).
 */
async function addUploadsToZip(
  zip: JSZip,
  uploadsRoot: string,
): Promise<{ fileCount: number; totalBytes: number }> {
  if (!existsSync(uploadsRoot)) {
    // Fresh installs may have nothing under /data/uploads yet. Empty
    // tree is legal, the inspect surface will just show 0 files.
    return { fileCount: 0, totalBytes: 0 };
  }
  const rootStat = statSync(uploadsRoot);
  if (!rootStat.isDirectory()) {
    return { fileCount: 0, totalBytes: 0 };
  }
  let fileCount = 0;
  let totalBytes = 0;
  const stack: string[] = [uploadsRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(uploadsRoot, abs).split(sep).join("/");
      try {
        const bytes = await readFile(abs);
        zip.file(`${BACKUP_ZIP_UPLOADS_PREFIX}${rel}`, bytes);
        fileCount += 1;
        totalBytes += bytes.length;
      } catch {
        // Unreadable file (permissions, race with deletion), skip
        // silently rather than failing the whole snapshot.
      }
    }
  }
  return { fileCount, totalBytes };
}

/**
 * Write a JSZip to disk via streaming. JSZip emits a node stream when
 * `generateNodeStream` is called; pipe it through createWriteStream
 * so we never hold the compressed payload in RAM twice.
 */
function writeZipToDisk(zip: JSZip, destPath: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    mkdirSync(dirname(destPath), { recursive: true });
    const out = createWriteStream(destPath);
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { out.destroy(); } catch { /* nothing */ }
        try { if (existsSync(destPath)) unlinkSync(destPath); } catch { /* nothing */ }
        rejectP(err);
      } else {
        resolveP();
      }
    };
    out.on("error", settle);
    out.on("finish", () => settle());
    const stream = zip.generateNodeStream({
      type: "nodebuffer",
      streamFiles: true,
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    stream.on("error", settle);
    stream.pipe(out);
  });
}

/* ============================================================
 *  Peek, read archive metadata without extracting
 * ============================================================ */

export interface ArchivePeek {
  /** Which payload entry was found; the archive's kind. */
  kind: "full" | "content";
  /** Outer .zip size in bytes. */
  archiveBytes: number;
  /** Uncompressed byte count of all `uploads/**` entries. */
  uploadsBytes: number;
  /** Count of `uploads/**` entries (excludes directory placeholders). */
  uploadsFileCount: number;
}

/**
 * Open a ZIP from disk, validate the envelope, and return a summary.
 * Throws on:
 *   - file is not a ZIP / corrupted
 *   - both payload entries present, or neither
 *   - any `uploads/<...>` entry that would extract outside the
 *     destination root (path traversal defense, caught here too so
 *     a malicious archive is rejected at inspect time)
 *
 * Does NOT validate the inner database payload, content.json parsing
 * + database.sqlite migration check live in their dedicated helpers
 * below, so the route layer can return a more useful inspect report.
 */
export async function peekArchive(zipPath: string): Promise<ArchivePeek> {
  const archiveBytes = (await stat(zipPath)).size;
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const hasFull = zip.file(BACKUP_ZIP_DATABASE_SQLITE) != null;
  const hasContent = zip.file(BACKUP_ZIP_CONTENT_JSON) != null;
  if (hasFull && hasContent) {
    throw new Error(
      `Archive contains both ${BACKUP_ZIP_DATABASE_SQLITE} and ${BACKUP_ZIP_CONTENT_JSON}, invalid envelope.`,
    );
  }
  if (!hasFull && !hasContent) {
    throw new Error(
      `Archive is missing the database payload, expected ${BACKUP_ZIP_CONTENT_JSON} or ${BACKUP_ZIP_DATABASE_SQLITE}.`,
    );
  }
  const kind: "full" | "content" = hasFull ? "full" : "content";

  let uploadsBytes = 0;
  let uploadsFileCount = 0;
  for (const entry of Object.values(zip.files)) {
    if (!entry.name.startsWith(BACKUP_ZIP_UPLOADS_PREFIX)) continue;
    if (entry.dir) continue;
    // Path-traversal defense: reject entries that would extract outside
    // the uploads root. `/` and `..` segments inside the relative path
    // are the only ways out; we test by joining against a sentinel root
    // and verifying containment.
    const rel = entry.name.slice(BACKUP_ZIP_UPLOADS_PREFIX.length);
    if (rel.includes("..") || rel.startsWith("/") || rel.startsWith("\\")) {
      throw new Error(`Archive entry would escape uploads root: ${entry.name}`);
    }
    uploadsFileCount += 1;
    // JSZip doesn't expose uncompressed sizes without decoding. Read
    // each entry's bytes once just for the count; cheap enough for
    // inspect-time and avoids surprising the admin with a wildly
    // mis-sized "0 bytes" headline.
    const bytes = await entry.async("nodebuffer");
    uploadsBytes += bytes.length;
  }
  return { kind, archiveBytes, uploadsBytes, uploadsFileCount };
}

/* ============================================================
 *  Extract, pull payloads out of an archive
 * ============================================================ */

/**
 * Pull `content.json` out of a content archive, parse it as a
 * BackupContentDocument, and return it. Throws if the entry is
 * missing or the JSON is malformed.
 */
export async function readContentDocument(
  zipPath: string,
): Promise<BackupContentDocument> {
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const entry = zip.file(BACKUP_ZIP_CONTENT_JSON);
  if (!entry) {
    throw new Error(`Archive missing ${BACKUP_ZIP_CONTENT_JSON}`);
  }
  const text = await entry.async("string");
  const parsed = JSON.parse(text) as BackupContentDocument;
  if (parsed.kind !== "content") {
    throw new Error(`content.json kind is "${parsed.kind}", expected "content"`);
  }
  return parsed;
}

/**
 * Extract the embedded `database.sqlite` from a full-DB archive into
 * destDbPath. Caller is responsible for ensuring destDbPath is a
 * fresh path (no overwrite-in-place). Returns the extracted size.
 */
export async function extractFullDatabase(opts: {
  zipPath: string;
  destDbPath: string;
}): Promise<{ sizeBytes: number }> {
  const { zipPath, destDbPath } = opts;
  if (existsSync(destDbPath)) {
    throw new Error(`extractFullDatabase: ${destDbPath} already exists`);
  }
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const entry = zip.file(BACKUP_ZIP_DATABASE_SQLITE);
  if (!entry) {
    throw new Error(`Archive missing ${BACKUP_ZIP_DATABASE_SQLITE}`);
  }
  mkdirSync(dirname(destDbPath), { recursive: true });
  await writeFile(destDbPath, await entry.async("nodebuffer"));
  return { sizeBytes: statSync(destDbPath).size };
}

/**
 * Extract every `uploads/**` entry from the archive into destRoot.
 * The destination is created if missing; existing files are
 * overwritten. Path-traversal entries are rejected (the peek pass
 * usually catches them first, but this is the second line of
 * defense). Returns the count + bytes written.
 *
 * Caller chooses whether destRoot is the live `/data/uploads/` or a
 * staging dir. Use syncUploadsFromArchive for the atomic live-swap
 * variant; use this directly when you want to write to a staging
 * slot (full-DB pending-uploads, pre-import safety extraction).
 */
export async function extractUploadsTo(opts: {
  zipPath: string;
  destRoot: string;
}): Promise<{ fileCount: number; bytesWritten: number }> {
  const { zipPath, destRoot } = opts;
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const absRoot = resolve(destRoot);
  mkdirSync(absRoot, { recursive: true });

  let fileCount = 0;
  let bytesWritten = 0;
  for (const entry of Object.values(zip.files)) {
    if (!entry.name.startsWith(BACKUP_ZIP_UPLOADS_PREFIX)) continue;
    if (entry.dir) continue;
    const rel = entry.name.slice(BACKUP_ZIP_UPLOADS_PREFIX.length);
    const absDest = resolve(absRoot, rel);
    if (!isWithin(absRoot, absDest)) {
      // Defense-in-depth: skip entries that resolve outside the root
      // even after the peek pass. Doesn't throw, caller may be in a
      // post-DB-commit window where aborting would split state.
      continue;
    }
    await mkdir(dirname(absDest), { recursive: true });
    const bytes = await entry.async("nodebuffer");
    await writeFile(absDest, bytes);
    fileCount += 1;
    bytesWritten += bytes.length;
  }
  return { fileCount, bytesWritten };
}

/**
 * Atomically replace uploadsRoot with the `uploads/**` tree from the
 * archive. Used by the in-process content-restore path:
 *
 *   1. Extract the archive's uploads tree into a sibling staging
 *      directory `<root>.staging-<rand>`.
 *   2. Move the live root aside to `<root>.rollback-<rand>`.
 *   3. Rename the staging dir into place at the live root path.
 *   4. Delete the rollback dir (best-effort).
 *
 * If step 1 or 2 throws, the live root is untouched. If step 3
 * fails after step 2 succeeded, we attempt to restore the rollback
 * dir back into place so we don't end up uploads-less.
 */
export async function syncUploadsFromArchive(opts: {
  zipPath: string;
  uploadsRoot: string;
}): Promise<{ fileCount: number; bytesWritten: number }> {
  const { zipPath, uploadsRoot } = opts;
  const absRoot = resolve(uploadsRoot);
  const parent = dirname(absRoot);
  mkdirSync(parent, { recursive: true });

  const tag = randomBytes(4).toString("hex");
  const stagingRoot = join(parent, `${pathBase(absRoot)}.staging-${tag}`);
  const rollbackRoot = join(parent, `${pathBase(absRoot)}.rollback-${tag}`);

  // Step 1: extract into staging.
  let extractResult: { fileCount: number; bytesWritten: number };
  try {
    extractResult = await extractUploadsTo({ zipPath, destRoot: stagingRoot });
  } catch (err) {
    try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* nothing */ }
    throw err;
  }

  // Step 2: move live root aside (skipped if it doesn't exist yet).
  const liveExisted = existsSync(absRoot);
  if (liveExisted) {
    try {
      renameSync(absRoot, rollbackRoot);
    } catch (err) {
      try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* nothing */ }
      throw err;
    }
  }

  // Step 3: swap staging into place.
  try {
    renameSync(stagingRoot, absRoot);
  } catch (err) {
    // Try to put the live root back so we don't leave the install
    // without an uploads dir.
    if (liveExisted) {
      try { renameSync(rollbackRoot, absRoot); } catch { /* best-effort */ }
    }
    try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* nothing */ }
    throw err;
  }

  // Step 4: discard the rollback copy. Best-effort, a leftover
  // rollback dir is recoverable manually by the operator and doesn't
  // break anything.
  if (liveExisted) {
    try { rmSync(rollbackRoot, { recursive: true, force: true }); } catch { /* nothing */ }
  }

  return extractResult;
}

/* ============================================================
 *  Full-restore staging, for the boot-swap path
 * ============================================================ */

/**
 * Path the Dockerfile entrypoint reads to apply a pending uploads
 * tree on the next container boot. Sits next to the canonical
 * uploads root so a single `mv` on the same filesystem swaps it in
 * atomically. Caller (route layer) writes this in tandem with the
 * .sqlite pending-restore slot from full.ts/stagePendingRestore.
 */
export function pendingUploadsPath(uploadsRoot: string): string {
  return resolve(dirname(uploadsRoot), `.thekeep-pending-uploads`);
}

/* ============================================================
 *  Helpers
 * ============================================================ */

function isWithin(root: string, candidate: string): boolean {
  const rootResolved = resolve(root) + sep;
  const candidateResolved = resolve(candidate);
  return candidateResolved === resolve(root) || candidateResolved.startsWith(rootResolved);
}

function pathBase(p: string): string {
  const norm = p.endsWith(sep) ? p.slice(0, -1) : p;
  const i = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return i < 0 ? norm : norm.slice(i + 1);
}

/**
 * Path for a temp .sqlite file produced by `VACUUM INTO` before it
 * gets packed into a full-archive ZIP. Sits next to the snapshot
 * directory so the rename-into-place is on the same filesystem.
 */
export function newFullDbTempPath(snapshotsDir: string): string {
  const rand = randomBytes(4).toString("hex");
  return join(snapshotsDir, `.full-vacuum-${rand}.sqlite`);
}

/**
 * Stream a node-readable into a file on disk. Mirrors the helper
 * already in admin/backup.ts but exported here so the route layer
 * can land an uploaded .zip into a temp slot before peeking. Resolves
 * when 'finish' fires; rejects on any error.
 */
export function streamReadableToFile(
  stream: NodeJS.ReadableStream,
  destPath: string,
): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    mkdirSync(dirname(destPath), { recursive: true });
    const out = createWriteStream(destPath);
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { out.destroy(); } catch { /* nothing */ }
        try { if (existsSync(destPath)) unlinkSync(destPath); } catch { /* nothing */ }
        rejectP(err);
      } else {
        resolveP();
      }
    };
    stream.on("error", settle);
    out.on("error", settle);
    out.on("finish", () => settle());
    stream.pipe(out);
  });
}

/**
 * Open a snapshot file as a readable stream (for the download
 * endpoint). The archive layer doesn't know the snapshots directory
 *, that's snapshots.ts. This is here so the route layer has a
 * symmetric pair with streamReadableToFile.
 */
export function snapshotReadStream(path: string): NodeJS.ReadableStream {
  return createReadStream(path);
}
