/**
 * Admin Backups routes — produces and consumes full-DB + content
 * snapshots.
 *
 * Mounted under /admin/backup. Every endpoint is masteradmin-only
 * (the destructive-restore semantics make this stricter than the
 * plain-`admin` gate covering most of the panel).
 *
 * Endpoint shapes:
 *
 *   POST   /admin/backup/content/create       → produces a content JSON
 *                                                snapshot, saves it under
 *                                                /data/backups/, returns its
 *                                                BackupSnapshotEntry.
 *   POST   /admin/backup/full/create          → VACUUM INTO a fresh .sqlite,
 *                                                same metadata response.
 *   POST   /admin/backup/content/inspect      → JSON body = uploaded doc;
 *                                                returns ContentImportDiff
 *                                                so the admin can preview.
 *   POST   /admin/backup/content/import       → JSON body = doc; takes a
 *                                                pre-import auto-snapshot,
 *                                                applies the document
 *                                                transactionally.
 *   POST   /admin/backup/full/inspect         → octet-stream body = .sqlite;
 *                                                streams to a temp file,
 *                                                returns FullBackupInspectReport.
 *   POST   /admin/backup/full/import          → octet-stream body = .sqlite;
 *                                                pre-import snapshot, stages
 *                                                pending restore, queues
 *                                                process exit. Body must be
 *                                                the result of a recent
 *                                                /full/inspect that confirmed
 *                                                ok=true — we re-inspect the
 *                                                staged file too as a safety
 *                                                step.
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

import { createWriteStream, existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  BACKUP_FORMAT_VERSION,
  isMasterAdminRole,
  type BackupContentDocument,
  type BackupSnapshotEntry,
  type ContentImportDiff,
  type FullBackupInspectReport,
  type Role,
} from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { sqliteHandle } from "../db/index.js";
import { recordAudit } from "../audit.js";
import { exportContent, importContent, diffContent } from "../backup/content.js";
import {
  archiveFullUpload,
  createFullSnapshot,
  inspectFullBackup,
  newUploadTempPath,
  stagePendingRestore,
} from "../backup/full.js";
import {
  createSnapshotReadStream,
  deleteSnapshot,
  listSnapshots,
  newSnapshotPath,
  parseSnapshotFilename,
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
 * accept a raw .sqlite upload need this so they get the
 * IncomingMessage stream as `req.body` instead of Fastify's default
 * JSON parser choking on the binary. Registered at the app level
 * because Fastify's parser registry is per-instance global. Guarded
 * by `hasContentTypeParser` so a double-call from a future second
 * call site (e.g. if we ever split this function) is a no-op
 * instead of a throw.
 */
function ensureOctetStreamParser(app: FastifyInstance): void {
  if (app.hasContentTypeParser("application/octet-stream")) return;
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => {
    // Pass the raw stream through; the route handler streams it to
    // disk via fs.createWriteStream + pipe.
    done(null, payload);
  });
}

/**
 * Body-size caps. SQLite databases for an active install can run
 * hundreds of MB; allow up to 2 GB for full-DB uploads. Content JSON
 * is small (under ~5 MB even for a thoroughly admin-edited install),
 * but allow a generous 50 MB so a fat custom_commands.template or
 * site_settings.rulesHtml doesn't get truncated.
 */
const FULL_BACKUP_BODY_LIMIT = 2 * 1024 * 1024 * 1024;
const CONTENT_BACKUP_BODY_LIMIT = 50 * 1024 * 1024;

export function registerAdminBackupRoutes(
  app: FastifyInstance,
  deps: { db: Db },
): void {
  const { db } = deps;
  ensureOctetStreamParser(app);

  function masterAdminOnly(req: ReqWithSession, reply: FastifyReply): boolean {
    const u = req.sessionUser;
    if (!u || !isMasterAdminRole(u.role)) {
      reply.code(403);
      reply.send({ error: "master admin only" });
      return false;
    }
    return true;
  }

  /* ---------- status ---------- */

  app.get("/admin/backup/status", async (req, reply) => {
    if (!masterAdminOnly(req as ReqWithSession, reply)) return;
    return getStatus();
  });

  /* ---------- create snapshots ---------- */

  app.post("/admin/backup/content/create", async (req, reply) => {
    if (!masterAdminOnly(req as ReqWithSession, reply)) return;
    const actor = (req as ReqWithSession).sessionUser!;
    const locked = await withLock("content_export", "Exporting content snapshot…", async () => {
      const doc = exportContent(sqliteHandle);
      const path = newSnapshotPath("content", "manual");
      writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");
      pruneSnapshots();
      await recordAudit(db, {
        actorUserId: actor.id,
        action: "backup_create",
        metadata: { kind: "content", filename: pathBasename(path) },
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
    if (!masterAdminOnly(req as ReqWithSession, reply)) return;
    const actor = (req as ReqWithSession).sessionUser!;
    const locked = await withLock("full_export", "Running VACUUM INTO (snapshot copy)…", async () => {
      const { path, sizeBytes } = await createFullSnapshot("manual");
      void sizeBytes;
      pruneSnapshots();
      await recordAudit(db, {
        actorUserId: actor.id,
        action: "backup_create",
        metadata: { kind: "full", filename: pathBasename(path) },
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

  app.post<{ Body: BackupContentDocument }>(
    "/admin/backup/content/inspect",
    { bodyLimit: CONTENT_BACKUP_BODY_LIMIT },
    async (req, reply) => {
      if (!masterAdminOnly(req as ReqWithSession, reply)) return;
      const doc = req.body;
      if (!doc || doc.kind !== "content") {
        reply.code(400);
        return { error: "not a content backup" };
      }
      if (doc.version !== BACKUP_FORMAT_VERSION) {
        reply.code(409);
        return {
          error: "format version mismatch",
          message: `Backup was created with format v${doc.version}; this server only understands v${BACKUP_FORMAT_VERSION}.`,
          uploadedVersion: doc.version,
          serverVersion: BACKUP_FORMAT_VERSION,
        };
      }
      const diff: ContentImportDiff = diffContent(sqliteHandle, doc);
      return diff;
    },
  );

  app.post(
    "/admin/backup/full/inspect",
    { bodyLimit: FULL_BACKUP_BODY_LIMIT },
    async (req, reply) => {
      if (!masterAdminOnly(req as ReqWithSession, reply)) return;
      const stream = req.body as NodeJS.ReadableStream;
      if (!stream || typeof (stream as { pipe?: unknown }).pipe !== "function") {
        reply.code(400);
        return { error: "expected octet-stream body" };
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
          updateMessage("Validating uploaded SQLite file…");
          const report: FullBackupInspectReport = inspectFullBackup(tempPath);
          if (report.ok) {
            const archived = archiveFullUpload(tempPath);
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

  app.post<{ Body: BackupContentDocument }>(
    "/admin/backup/content/import",
    { bodyLimit: CONTENT_BACKUP_BODY_LIMIT },
    async (req, reply) => {
      if (!masterAdminOnly(req as ReqWithSession, reply)) return;
      const actor = (req as ReqWithSession).sessionUser!;
      const doc = req.body;
      if (!doc || doc.kind !== "content") {
        reply.code(400);
        return { error: "not a content backup" };
      }
      if (doc.version !== BACKUP_FORMAT_VERSION) {
        reply.code(409);
        return {
          error: "format version mismatch",
          message: `Backup was created with format v${doc.version}; this server only understands v${BACKUP_FORMAT_VERSION}.`,
          uploadedVersion: doc.version,
          serverVersion: BACKUP_FORMAT_VERSION,
        };
      }
      const locked = await withLock("content_import", "Importing content backup…", async () => {
        // Refuse if the source install is on migrations we don't have.
        const diff = diffContent(sqliteHandle, doc);
        if (diff.missingMigrations.length > 0) {
          return {
            error409: {
              error: "schema behind",
              message: "Target install is missing migrations the backup expects",
              missingMigrations: diff.missingMigrations,
            },
          };
        }
        // Pre-import safety snapshot of CURRENT content (so a botched
        // import is one click away from undo).
        updateMessage("Saving pre-import safety snapshot…");
        const safetyDoc = exportContent(sqliteHandle);
        const safetyPath = newSnapshotPath("content", "pre_content_import");
        writeFileSync(safetyPath, JSON.stringify(safetyDoc, null, 2), "utf8");
        // Apply.
        updateMessage("Applying content upserts…");
        const result = importContent(sqliteHandle, doc, actor.id);
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
          },
        });
        return {
          okResult: {
            ok: true as const,
            ...result,
            preSnapshotId: pathBasename(safetyPath),
          },
        };
      });
      if (!locked.ok) {
        reply.code(409);
        return { error: "busy", busy: locked.busy };
      }
      if (locked.value.error409) {
        reply.code(409);
        return locked.value.error409;
      }
      return locked.value.okResult;
    },
  );

  app.post(
    "/admin/backup/full/import",
    { bodyLimit: FULL_BACKUP_BODY_LIMIT },
    async (req, reply) => {
      if (!masterAdminOnly(req as ReqWithSession, reply)) return;
      const actor = (req as ReqWithSession).sessionUser!;
      const stream = req.body as NodeJS.ReadableStream;
      if (!stream || typeof (stream as { pipe?: unknown }).pipe !== "function") {
        reply.code(400);
        return { error: "expected octet-stream body" };
      }
      const locked = await withLock("full_import", "Receiving uploaded database…", async () => {
        const tempPath = newUploadTempPath();
        try {
          await streamToFile(stream, tempPath);
          updateMessage("Validating uploaded SQLite file…");
          const report = inspectFullBackup(tempPath);
          if (!report.ok) {
            if (existsSync(tempPath)) unlinkSync(tempPath);
            return { error400: { error: "not a valid sqlite backup" } } as const;
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
          // Pre-restore safety snapshot of the LIVE DB. Done BEFORE
          // staging the pending restore so a crash between these
          // two steps still leaves the safety copy behind.
          updateMessage("Saving pre-restore safety snapshot…");
          const safety = await createFullSnapshot("pre_full_import");
          // Stage the upload as the pending restore. The container
          // entry script will swap it into place on next boot.
          updateMessage("Staging pending restore for boot swap…");
          const staged = stagePendingRestore(tempPath);
          await recordAudit(db, {
            actorUserId: actor.id,
            action: "backup_import",
            metadata: {
              kind: "full",
              preSnapshot: pathBasename(safety.path),
              stagedAt: staged.stagedAt,
            },
          });
          return {
            okResult: {
              ok: true as const,
              preSnapshotId: pathBasename(safety.path),
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
    if (!masterAdminOnly(req as ReqWithSession, reply)) return;
    return { snapshots: listSnapshots() };
  });

  app.get<{ Params: { id: string } }>(
    "/admin/backup/snapshots/:id",
    async (req, reply) => {
      if (!masterAdminOnly(req as ReqWithSession, reply)) return;
      const streamInfo = createSnapshotReadStream(req.params.id);
      if (!streamInfo) {
        reply.code(404);
        return { error: "snapshot not found" };
      }
      const meta = parseSnapshotFilename(req.params.id);
      const contentType = meta?.kind === "content" ? "application/json" : "application/octet-stream";
      reply.header("content-type", contentType);
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
      if (!masterAdminOnly(req as ReqWithSession, reply)) return;
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

