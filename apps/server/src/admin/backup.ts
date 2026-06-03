/**
 * Admin Backups routes — produces and consumes ZIP-envelope backups
 * (format v3+) that bundle the database payload AND the entire
 * `/data/uploads/` tree.
 *
 * Mounted under /admin/backup. Every endpoint is masteradmin-only
 * (the destructive-restore semantics make this stricter than the
 * plain-`admin` gate covering most of the panel).
 *
 * Endpoint shapes:
 *
 *   POST   /admin/backup/content/create       → packs a content snapshot
 *                                                (content.json + uploads/),
 *                                                saves it as .zip under
 *                                                /data/backups/, returns its
 *                                                BackupSnapshotEntry.
 *   POST   /admin/backup/full/create          → VACUUM INTO + packs into a
 *                                                .zip with database.sqlite +
 *                                                uploads/. Same metadata
 *                                                response.
 *   POST   /admin/backup/content/inspect      → octet-stream body = uploaded
 *                                                .zip; returns
 *                                                ContentBackupInspectReport so
 *                                                the admin can preview the
 *                                                per-table diff + bundled
 *                                                uploads counts.
 *   POST   /admin/backup/content/import       → octet-stream body = .zip;
 *                                                takes a pre-import auto-
 *                                                snapshot, applies the
 *                                                document transactionally,
 *                                                then atomically syncs the
 *                                                uploads tree into /data/uploads/.
 *   POST   /admin/backup/full/inspect         → octet-stream body = .zip;
 *                                                streams to a temp file,
 *                                                peeks the envelope, returns
 *                                                FullBackupInspectReport.
 *   POST   /admin/backup/full/import          → octet-stream body = .zip;
 *                                                pre-import snapshot, stages
 *                                                pending DB + pending uploads,
 *                                                queues process exit. Body
 *                                                must be the result of a
 *                                                recent /full/inspect that
 *                                                confirmed ok=true — we
 *                                                re-inspect the staged file
 *                                                too as a safety step.
 *   GET    /admin/backup/snapshots            → list every snapshot in
 *                                                /data/backups/.
 *   GET    /admin/backup/snapshots/:id        → stream the snapshot back
 *                                                with a Content-Disposition
 *                                                attachment so the browser
 *                                                triggers a download.
 *   DELETE /admin/backup/snapshots/:id        → remove a snapshot file.
 *
 * Audit: every mutation logs a `backup_create` / `backup_import` /
 * `backup_delete` row via recordAudit so an admin can trace who
 * exported / imported / removed which snapshot.
 */

import { createWriteStream, existsSync, statSync, unlinkSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  BACKUP_FORMAT_VERSION,
  type BackupSnapshotEntry,
  type ContentBackupInspectReport,
  type FullBackupInspectReport,
  type PermissionKey,
  type Role,
} from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { sqliteHandle } from "../db/index.js";
import { requireSessionPermission } from "../auth/requireSessionPermission.js";
import { recordAudit } from "../audit.js";
import { exportContent, importContent, diffContent } from "../backup/content.js";
import {
  archiveUpload,
  createFullSnapshot,
  inspectFullBackup,
  newUploadTempPath,
  stagePendingRestore,
} from "../backup/full.js";
import {
  packContentArchive,
  peekArchive,
  readContentDocument,
  syncUploadsFromArchive,
} from "../backup/archive.js";
import {
  createSnapshotReadStream,
  deleteSnapshot,
  listSnapshots,
  newSnapshotPath,
  pruneSnapshots,
} from "../backup/snapshots.js";
import { getStatus, updateMessage, withLock } from "../backup/state.js";

interface SessionUserCtx {
  id: string;
  role: Role;
}

type ReqWithSession = FastifyRequest & { sessionUser?: SessionUserCtx };

/**
 * One-time content-type parser registration. Fastify routes that
 * accept a raw .zip upload need this so they get the IncomingMessage
 * stream as `req.body` instead of Fastify's default JSON parser
 * choking on the binary. Registered at the app level because
 * Fastify's parser registry is per-instance global. Guarded by
 * `hasContentTypeParser` so a double-call from a future second call
 * site is a no-op instead of a throw.
 *
 * Both `application/octet-stream` and `application/zip` route here —
 * browsers vary on which content-type they send for a File picked
 * via <input type="file" accept=".zip"> depending on the OS mime
 * registry, so we accept either.
 */
function ensureBinaryParsers(app: FastifyInstance): void {
  const pass = (_req: FastifyRequest, payload: NodeJS.ReadableStream, done: (err: Error | null, body?: unknown) => void) => {
    done(null, payload);
  };
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", pass);
  }
  if (!app.hasContentTypeParser("application/zip")) {
    app.addContentTypeParser("application/zip", pass);
  }
  if (!app.hasContentTypeParser("application/x-zip-compressed")) {
    // Some Windows browsers report this legacy type for .zip files.
    app.addContentTypeParser("application/x-zip-compressed", pass);
  }
}

/**
 * Body-size caps. The ZIP envelope holds the full database payload
 * (the .sqlite for a full backup runs into hundreds of MB on busy
 * installs) AND every uploaded image. Allow 4 GB for both kinds —
 * the same cap covers both because v3 content backups now carry
 * upload binaries too, not just the JSON table dump.
 */
const BACKUP_BODY_LIMIT = 4 * 1024 * 1024 * 1024;

export function registerAdminBackupRoutes(
  app: FastifyInstance,
  deps: { db: Db; uploadsRoot: string },
): void {
  const { db, uploadsRoot } = deps;
  ensureBinaryParsers(app);

  // Granular permission gate. All backup endpoints are routed through
  // `manage_backups` (masteradmin-default but matrix-grantable — the
  // destructive-restore semantics are why the seed pins this to
  // masteradmin only). Thin closure over the shared
  // `requireSessionPermission` helper so call sites don't have to
  // thread `db` through every call.
  const requirePermission = (
    req: ReqWithSession,
    reply: FastifyReply,
    key: PermissionKey = "manage_backups",
  ) => requireSessionPermission(req, reply, key, db);

  /* ---------- status ---------- */

  app.get("/admin/backup/status", async (req, reply) => {
    if (!(await requirePermission(req as ReqWithSession, reply))) return;
    return getStatus();
  });

  /* ---------- create snapshots ---------- */

  app.post("/admin/backup/content/create", async (req, reply) => {
    if (!(await requirePermission(req as ReqWithSession, reply))) return;
    const actor = (req as ReqWithSession).sessionUser!;
    const locked = await withLock("content_export", "Exporting content snapshot…", async () => {
      const doc = exportContent(sqliteHandle);
      const path = newSnapshotPath("content", "manual");
      const result = await packContentArchive({
        document: doc,
        uploadsRoot,
        destPath: path,
      });
      pruneSnapshots();
      await recordAudit(db, {
        actorUserId: actor.id,
        action: "backup_create",
        metadata: {
          kind: "content",
          filename: pathBasename(path),
          uploadsFileCount: result.uploadsFileCount,
        },
      });
      return entryFor(path, "content", "manual");
    });
    if (!locked.ok) {
      reply.code(409);
      return { error: "busy", busy: locked.busy };
    }
    return locked.value;
  });

  app.post("/admin/backup/full/create", async (req, reply) => {
    if (!(await requirePermission(req as ReqWithSession, reply))) return;
    const actor = (req as ReqWithSession).sessionUser!;
    const locked = await withLock("full_export", "Running VACUUM INTO + packing uploads…", async () => {
      const { path, uploadsFileCount } = await createFullSnapshot("manual", uploadsRoot);
      pruneSnapshots();
      await recordAudit(db, {
        actorUserId: actor.id,
        action: "backup_create",
        metadata: { kind: "full", filename: pathBasename(path), uploadsFileCount },
      });
      return entryFor(path, "full", "manual");
    });
    if (!locked.ok) {
      reply.code(409);
      return { error: "busy", busy: locked.busy };
    }
    return locked.value;
  });

  /* ---------- inspect (preview a candidate import) ---------- */

  app.post(
    "/admin/backup/content/inspect",
    { bodyLimit: BACKUP_BODY_LIMIT },
    async (req, reply) => {
      if (!(await requirePermission(req as ReqWithSession, reply))) return;
      const stream = req.body as NodeJS.ReadableStream;
      if (!stream || typeof (stream as { pipe?: unknown }).pipe !== "function") {
        reply.code(400);
        return { error: "expected octet-stream/zip body" };
      }
      const locked = await withLock("content_import", "Receiving + inspecting content archive…", async () => {
        const tempPath = newUploadTempPath();
        try {
          await streamToFile(stream, tempPath);
          updateMessage("Validating uploaded ZIP envelope…");
          let peek;
          try {
            peek = await peekArchive(tempPath);
          } catch {
            if (existsSync(tempPath)) unlinkSync(tempPath);
            return { error400: { error: "not a valid backup archive" } } as const;
          }
          if (peek.kind !== "content") {
            if (existsSync(tempPath)) unlinkSync(tempPath);
            return {
              error400: {
                error: "wrong kind",
                message: "This archive is a full-DB backup, not a content backup. Use the full DB panel.",
              },
            } as const;
          }
          const doc = await readContentDocument(tempPath);
          if (doc.version !== BACKUP_FORMAT_VERSION) {
            if (existsSync(tempPath)) unlinkSync(tempPath);
            return {
              error409: {
                error: "format version mismatch",
                message: `Backup was created with format v${doc.version}; this server only understands v${BACKUP_FORMAT_VERSION}.`,
                uploadedVersion: doc.version,
                serverVersion: BACKUP_FORMAT_VERSION,
              },
            } as const;
          }
          const diff = diffContent(sqliteHandle, doc);
          const report: ContentBackupInspectReport = {
            ok: true,
            sizeBytes: peek.archiveBytes,
            diff,
            uploadsFileCount: peek.uploadsFileCount,
            uploadsBytes: peek.uploadsBytes,
          };
          // Successful inspect → archive the upload into snapshots so
          // the admin can keep / re-inspect it without uploading again.
          const archived = archiveUpload(tempPath, "content");
          pruneSnapshots();
          return {
            okReport: { ...report, archivedId: pathBasename(archived) },
          } as const;
        } catch (err) {
          if (existsSync(tempPath)) unlinkSync(tempPath);
          throw err;
        }
      });
      if (!locked.ok) {
        reply.code(409);
        return { error: "busy", busy: locked.busy };
      }
      const v = locked.value;
      if ("error400" in v) {
        reply.code(400);
        return v.error400;
      }
      if ("error409" in v) {
        reply.code(409);
        return v.error409;
      }
      return v.okReport;
    },
  );

  app.post(
    "/admin/backup/full/inspect",
    { bodyLimit: BACKUP_BODY_LIMIT },
    async (req, reply) => {
      if (!(await requirePermission(req as ReqWithSession, reply))) return;
      const stream = req.body as NodeJS.ReadableStream;
      if (!stream || typeof (stream as { pipe?: unknown }).pipe !== "function") {
        reply.code(400);
        return { error: "expected octet-stream/zip body" };
      }
      // Inspect is read-only on the live DB, but it competes with
      // import for the same /data/backups/ slots (archives the
      // upload on success), and a large upload can take a while to
      // stream to disk — so we serialize behind the same lock that
      // gates create/import.
      const locked = await withLock("full_import", "Receiving + inspecting upload…", async () => {
        const tempPath = newUploadTempPath();
        try {
          await streamToFile(stream, tempPath);
          updateMessage("Validating uploaded backup archive…");
          const report: FullBackupInspectReport = await inspectFullBackup(tempPath);
          if (report.ok) {
            const archived = archiveUpload(tempPath, "full");
            pruneSnapshots();
            return { ...report, archivedId: pathBasename(archived) } as FullBackupInspectReport & { archivedId?: string };
          }
          if (existsSync(tempPath)) unlinkSync(tempPath);
          return report;
        } catch (err) {
          if (existsSync(tempPath)) unlinkSync(tempPath);
          throw err;
        }
      });
      if (!locked.ok) {
        reply.code(409);
        return { error: "busy", busy: locked.busy };
      }
      return locked.value;
    },
  );

  /* ---------- import (apply) ---------- */

  app.post(
    "/admin/backup/content/import",
    { bodyLimit: BACKUP_BODY_LIMIT },
    async (req, reply) => {
      if (!(await requirePermission(req as ReqWithSession, reply))) return;
      const actor = (req as ReqWithSession).sessionUser!;
      const stream = req.body as NodeJS.ReadableStream;
      if (!stream || typeof (stream as { pipe?: unknown }).pipe !== "function") {
        reply.code(400);
        return { error: "expected octet-stream/zip body" };
      }
      const locked = await withLock("content_import", "Receiving content archive…", async () => {
        const tempPath = newUploadTempPath();
        try {
          await streamToFile(stream, tempPath);
          updateMessage("Validating uploaded ZIP envelope…");
          let peek;
          try {
            peek = await peekArchive(tempPath);
          } catch {
            if (existsSync(tempPath)) unlinkSync(tempPath);
            return { error400: { error: "not a valid backup archive" } } as const;
          }
          if (peek.kind !== "content") {
            if (existsSync(tempPath)) unlinkSync(tempPath);
            return {
              error400: { error: "wrong kind", message: "This archive is a full-DB backup, not a content backup." },
            } as const;
          }
          const doc = await readContentDocument(tempPath);
          if (doc.version !== BACKUP_FORMAT_VERSION) {
            if (existsSync(tempPath)) unlinkSync(tempPath);
            return {
              error409: {
                error: "format version mismatch",
                message: `Backup was created with format v${doc.version}; this server only understands v${BACKUP_FORMAT_VERSION}.`,
                uploadedVersion: doc.version,
                serverVersion: BACKUP_FORMAT_VERSION,
              },
            } as const;
          }
          // Refuse if the source install is on migrations we don't have.
          const diff = diffContent(sqliteHandle, doc);
          if (diff.missingMigrations.length > 0) {
            if (existsSync(tempPath)) unlinkSync(tempPath);
            return {
              error409: {
                error: "schema behind",
                message: "Target install is missing migrations the backup expects",
                missingMigrations: diff.missingMigrations,
              },
            } as const;
          }
          // Pre-import safety snapshot of CURRENT content + uploads
          // (so a botched import is one click away from undo).
          updateMessage("Saving pre-import safety snapshot…");
          const safetyDoc = exportContent(sqliteHandle);
          const safetyPath = newSnapshotPath("content", "pre_content_import");
          await packContentArchive({
            document: safetyDoc,
            uploadsRoot,
            destPath: safetyPath,
          });
          // Apply the DB mirror restore.
          updateMessage("Applying content row replays…");
          const result = importContent(sqliteHandle, doc, actor.id);
          // Sync the uploads tree from the archive into the live
          // uploads root. Atomic via staging-dir + rename swap; if it
          // throws, the DB import already committed but the rollback
          // is "import the safety snapshot" which carries the prior
          // uploads tree too.
          updateMessage("Syncing uploads tree…");
          const uploadsSync = await syncUploadsFromArchive({
            zipPath: tempPath,
            uploadsRoot,
          });
          // Consume the upload.
          try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* nothing */ }
          pruneSnapshots();
          await recordAudit(db, {
            actorUserId: actor.id,
            action: "backup_import",
            metadata: {
              kind: "content",
              preSnapshot: pathBasename(safetyPath),
              inserted: result.inserted,
              updated: result.updated,
              unchanged: result.unchanged,
              uploadsRestored: uploadsSync.fileCount,
            },
          });
          return {
            okResult: {
              ok: true as const,
              ...result,
              uploadsRestored: uploadsSync.fileCount,
              preSnapshotId: pathBasename(safetyPath),
            },
          } as const;
        } catch (err) {
          try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* nothing */ }
          throw err;
        }
      });
      if (!locked.ok) {
        reply.code(409);
        return { error: "busy", busy: locked.busy };
      }
      const v = locked.value;
      if ("error400" in v) {
        reply.code(400);
        return v.error400;
      }
      if ("error409" in v) {
        reply.code(409);
        return v.error409;
      }
      return v.okResult;
    },
  );

  app.post(
    "/admin/backup/full/import",
    { bodyLimit: BACKUP_BODY_LIMIT },
    async (req, reply) => {
      if (!(await requirePermission(req as ReqWithSession, reply))) return;
      const actor = (req as ReqWithSession).sessionUser!;
      const stream = req.body as NodeJS.ReadableStream;
      if (!stream || typeof (stream as { pipe?: unknown }).pipe !== "function") {
        reply.code(400);
        return { error: "expected octet-stream/zip body" };
      }
      const locked = await withLock("full_import", "Receiving uploaded archive…", async () => {
        const tempPath = newUploadTempPath();
        try {
          await streamToFile(stream, tempPath);
          updateMessage("Validating uploaded backup archive…");
          const report = await inspectFullBackup(tempPath);
          if (!report.ok) {
            if (existsSync(tempPath)) unlinkSync(tempPath);
            return { error400: { error: "not a valid full backup archive" } } as const;
          }
          if (report.missingMigrations.length > 0) {
            if (existsSync(tempPath)) unlinkSync(tempPath);
            return {
              error409: {
                error: "schema behind",
                message: "Target install is missing migrations the backup expects",
                missingMigrations: report.missingMigrations,
              },
            } as const;
          }
          // Pre-restore safety snapshot of the LIVE DB + uploads. Done
          // BEFORE staging the pending restore so a crash between
          // these two steps still leaves the safety copy behind.
          updateMessage("Saving pre-restore safety snapshot…");
          const safety = await createFullSnapshot("pre_full_import", uploadsRoot);
          // Stage the upload as the pending restore (extracts the
          // inner .sqlite and the uploads tree into their respective
          // pending slots and unlinks the upload zip).
          updateMessage("Staging pending DB + uploads for boot swap…");
          const staged = await stagePendingRestore(tempPath, uploadsRoot);
          await recordAudit(db, {
            actorUserId: actor.id,
            action: "backup_import",
            metadata: {
              kind: "full",
              preSnapshot: pathBasename(safety.path),
              stagedAt: staged.stagedAt,
              stagedUploadsAt: staged.stagedUploadsAt,
              uploadsRestored: staged.uploadsFileCount,
            },
          });
          return {
            okResult: {
              ok: true as const,
              preSnapshotId: pathBasename(safety.path),
              uploadsRestored: staged.uploadsFileCount,
              message: "Restore staged. The server will restart momentarily; refresh in ~30 seconds.",
            },
          } as const;
        } catch (err) {
          if (existsSync(tempPath)) unlinkSync(tempPath);
          throw err;
        }
      });
      if (!locked.ok) {
        reply.code(409);
        return { error: "busy", busy: locked.busy };
      }
      const v = locked.value;
      if ("error400" in v) {
        reply.code(400);
        return v.error400;
      }
      if ("error409" in v) {
        reply.code(409);
        return v.error409;
      }
      // Success: send the response, then exit so Fly restarts the
      // container and the entry script applies the pending swap.
      reply.send(v.okResult);
      const exitOnce = (() => {
        let exited = false;
        return () => {
          if (exited) return;
          exited = true;
          // eslint-disable-next-line no-console
          console.log("[backup] full-restore staged — exiting for boot swap");
          process.exit(0);
        };
      })();
      reply.raw.on("finish", exitOnce);
      setTimeout(exitOnce, 2000);
      return reply;
    },
  );

  /* ---------- snapshot inventory ---------- */

  app.get("/admin/backup/snapshots", async (req, reply) => {
    if (!(await requirePermission(req as ReqWithSession, reply))) return;
    return { snapshots: listSnapshots() };
  });

  app.get<{ Params: { id: string } }>(
    "/admin/backup/snapshots/:id",
    async (req, reply) => {
      if (!(await requirePermission(req as ReqWithSession, reply))) return;
      const streamInfo = createSnapshotReadStream(req.params.id);
      if (!streamInfo) {
        reply.code(404);
        return { error: "snapshot not found" };
      }
      // Every snapshot is a .zip in v3+ — both kinds share one mime
      // so the download Content-Type doesn't depend on the kind.
      reply.header("content-type", "application/zip");
      reply.header("content-length", String(streamInfo.sizeBytes));
      reply.header(
        "content-disposition",
        `attachment; filename="${req.params.id}"`,
      );
      return reply.send(streamInfo.stream);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/backup/snapshots/:id",
    async (req, reply) => {
      if (!(await requirePermission(req as ReqWithSession, reply))) return;
      const actor = (req as ReqWithSession).sessionUser!;
      const ok = deleteSnapshot(req.params.id);
      if (!ok) {
        reply.code(404);
        return { error: "snapshot not found" };
      }
      await recordAudit(db, {
        actorUserId: actor.id,
        action: "backup_delete",
        metadata: { filename: req.params.id },
      });
      return { ok: true };
    },
  );
}

/* ============================================================
 *  Helpers
 * ============================================================ */

function pathBasename(p: string): string {
  const slash = p.lastIndexOf("/");
  const back = p.lastIndexOf("\\");
  return p.slice(Math.max(slash, back) + 1);
}

function entryFor(
  fullPath: string,
  kind: "full" | "content",
  trigger: "manual" | "pre_full_import" | "pre_content_import",
): BackupSnapshotEntry {
  const filename = pathBasename(fullPath);
  const stat = statSync(fullPath);
  return {
    id: filename,
    sizeBytes: stat.size,
    createdAt: stat.mtimeMs,
    kind,
    trigger,
    filename,
  };
}

/**
 * Pipe a stream into a file on disk. Resolves when the file is
 * fully written and the stream's 'end' has fired; rejects on any
 * error. Used to land the raw octet-stream body of the upload
 * endpoints into a temp file before validation.
 */
function streamToFile(stream: NodeJS.ReadableStream, destPath: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const out = createWriteStream(destPath);
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { out.destroy(); } catch { /* nothing */ }
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
