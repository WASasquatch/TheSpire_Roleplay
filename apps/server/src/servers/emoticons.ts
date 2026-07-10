/**
 * Per-server Emoticons admin (Admin Partition — plan_ext.md §4, surface B).
 *
 * The server-scoped analog of the GLOBAL emoticon catalog admin
 * (`routes/emoticons.ts`). A server owner/mod holding `manage_emoticons`
 * curates THIS server's emoticon sheets and reviews THIS server's user
 * submissions, never touching another server's content nor the
 * platform-shared (NULL-serverId) built-ins.
 *
 * Scoping rule (matches the global module's `resolveCatalogScope`/server
 * stamping): `emoticon_sheets.server_id = :id` is the editable set; rows with
 * `server_id IS NULL` are platform-shared/built-in and surface here READ-ONLY
 * (a sub-server cannot edit, delete, or re-review the shared catalog). Every
 * mutating route additionally refuses any row whose `server_id` is not exactly
 * `:id`, so a guessed sheet id from another server resolves to a 404.
 *
 * Authorization mirrors `routes/servers.ts` `requireServerPermission`: the
 * servers flag must be ON (else 404, flag-off byte-identical to today since
 * this module's routes simply don't answer), the caller must be signed in, and
 * `serverCan(a, "manage_emoticons")` must hold for THIS server (owner/staff via
 * `manage_any_server` resolve owner-equivalent in `serverAuthority`).
 *
 * Image pipeline: identical posture to the global module — base64 data URL in,
 * magic-byte sniff, content-hashed filename under `<uploadsRoot>/emoticons`, so
 * a re-upload of the same bytes dedupes and new bytes bust the picker cache.
 * This is why the register fn takes `uploadsRoot` (note for the orchestrator).
 *
 * Submission review: the per-server submission queue is the subset of
 * `routes/emoticons.ts` /me/emoticon-submissions rows that were stamped with
 * this server's id at submit time. Approve flips status live (+ `emoticons:updated`
 * broadcast so connected pickers re-fetch); reject refunds the snapshotted cost
 * to the submitter's pool (on DEFAULT_SERVER_ID, exactly where the submission
 * debited it — the submission economy is global, only the review routing is
 * per-server) and deletes the asset file.
 *
 * Self-contained per plan_ext.md §3: imports the exported `getSessionUser`
 * (`../routes/auth.js`), settings helpers (`../settings.js`), and
 * `serverAuthority`/`serverCan` (`./authority.js`) directly; no dependency on
 * `routes/servers.ts` closures. Audit rows go straight into `auditLog` with the
 * `serverId` column set (mirroring `auditServer`), best-effort.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { EMOTICON_SHEET_CELL_COUNT, slugRx } from "@thekeep/shared";
import {
  auditLog,
  characterEarning,
  characters,
  earningLedger,
  emoticonSheets,
  userEarning,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "../routes/auth.js";
import { notify } from "../notifications/engine.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { areServersEnabled, getSettings } from "../settings.js";
import { parseSheetCells } from "../reactions.js";
import { tFor } from "../i18n.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const SLUG_RX = slugRx(42);

/* =====================================================================
 *  Image upload helpers — same posture as routes/emoticons.ts: small
 *  magic-byte whitelist, content-hashed filenames so a re-upload of the
 *  same bytes dedupes and replaced bytes always yield a fresh URL that
 *  busts any stale picker / sprite cache.
 * ===================================================================== */
const ACCEPTED_IMAGE_PREFIXES: Array<{ mime: string; ext: string; magic: number[] }> = [
  { mime: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/webp", ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
  { mime: "image/gif", ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
];

function detectImage(bytes: Buffer): { ext: string; mime: string } | null {
  for (const sig of ACCEPTED_IMAGE_PREFIXES) {
    if (bytes.length < sig.magic.length) continue;
    let match = true;
    for (let i = 0; i < sig.magic.length; i++) {
      if (bytes[i] !== sig.magic[i]) { match = false; break; }
    }
    if (match) return { ext: sig.ext, mime: sig.mime };
  }
  return null;
}

function decodeDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl.trim());
  if (!m) return null;
  try { return Buffer.from(m[2]!, "base64"); }
  catch { return null; }
}

/* =====================================================================
 *  Wire shape for the console tab. A superset of the global picker's
 *  EmoticonSheet, plus the moderation fields the admin surface needs
 *  (status, submitter label/cost, scope) and an `editable` flag so the
 *  tab can render shared/built-in (NULL-serverId) rows read-only.
 * ===================================================================== */
interface ServerSheetWire {
  id: string;
  slug: string;
  name: string;
  imageUrl: string;
  cells: string[];
  sortOrder: number;
  status: string;
  /** NULL = platform-shared/built-in (shown read-only here). */
  serverId: string | null;
  /** True when this row belongs to THIS server and may be edited/deleted. */
  editable: boolean;
  useCount: number;
  createdAt: number;
}

interface ServerSubmissionWire {
  id: string;
  slug: string;
  name: string;
  imageUrl: string;
  cells: string[];
  status: string;
  submitterScope: string | null;
  submitterPoolId: string | null;
  submitterLabel: string;
  costPaid: number | null;
  rejectionReason: string | null;
  reviewedAt: number | null;
  createdAt: number;
}

/* =====================================================================
 *  Route registration
 * ===================================================================== */
const createSheetBody = z.object({
  slug: z.string().min(1).max(40).regex(SLUG_RX, "slug must be 1-40 lowercase letters / digits / hyphens"),
  name: z.string().min(1).max(80),
  cells: z.array(z.string().max(40)).length(EMOTICON_SHEET_CELL_COUNT),
  imageDataUrl: z.string().min(32).max(8 * 1024 * 1024),
  sortOrder: z.number().int().optional(),
}).strict();

const updateSheetBody = z.object({
  name: z.string().min(1).max(80).optional(),
  cells: z.array(z.string().max(40)).length(EMOTICON_SHEET_CELL_COUNT).optional(),
  imageDataUrl: z.string().min(32).max(8 * 1024 * 1024).optional(),
  sortOrder: z.number().int().optional(),
}).strict();

const rejectSubmissionBody = z.object({
  reason: z.string().max(500).optional(),
}).strict();

export async function registerServerEmoticonRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
  uploadsRoot: string,
): Promise<void> {
  const emoticonsDir = join(uploadsRoot, "emoticons");

  /** Write a base64 data URL to the emoticons volume, content-hashed. */
  async function writeSheetImage(
    sheetId: string,
    dataUrl: string,
  ): Promise<{ url: string; mime: string; bytes: number } | { error: string; status: number }> {
    const bytes = decodeDataUrl(dataUrl);
    if (!bytes) return { error: "expected a base64 data URL", status: 400 };
    const detected = detectImage(bytes);
    if (!detected) return { error: "unsupported image type (png, jpg, webp, gif only)", status: 415 };
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const filename = `${sheetId}-${hash}.${detected.ext}`;
    await mkdir(emoticonsDir, { recursive: true });
    await writeFile(join(emoticonsDir, filename), bytes);
    return { url: `/uploads/emoticons/${filename}`, mime: detected.mime, bytes: bytes.length };
  }

  /** Best-effort server-scoped audit row (mirror of `auditServer` in
   *  routes/servers.ts). A logging failure never fails the action. */
  async function audit(entry: {
    serverId: string;
    actorUserId: string;
    action: string;
    targetUserId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      await db.insert(auditLog).values({
        id: nanoid(),
        actorUserId: entry.actorUserId,
        action: entry.action,
        targetUserId: entry.targetUserId ?? null,
        reason: entry.reason ?? null,
        metadataJson: entry.metadata ? JSON.stringify(entry.metadata) : null,
        serverId: entry.serverId,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[audit] failed to record server emoticon entry", { action: entry.action, err });
    }
  }

  /**
   * Gate every route: flag ON, signed in, and `manage_emoticons` for THIS
   * server. Returns the resolved (signed-in) caller + server id on success, or
   * a `fail` tuple the caller turns into the response. Replicates the
   * requireServerPermission posture from routes/servers.ts but self-contained.
   */
  async function gate(
    req: Parameters<typeof getSessionUser>[0],
    serverId: string,
  ): Promise<
    | { ok: true; me: { id: string; role: import("@thekeep/shared").Role; locale: string | null }; serverId: string }
    | { fail: { code: number; error: string } }
  > {
    if (!areServersEnabled(await getSettings(db))) return { fail: { code: 404, error: "not found" } };
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401, error: "auth" } };
    const { serverAuthority, serverCan } = await import("./authority.js");
    const a = await serverAuthority(db, me, serverId);
    if (!a.server) return { fail: { code: 404, error: "no server" } };
    if (!serverCan(a, "manage_emoticons")) return { fail: { code: 403, error: "forbidden" } };
    return { ok: true, me: { id: me.id, role: me.role, locale: me.locale }, serverId };
  }

  /* ---------- List sheets: this server's (editable) + shared (read-only) ---------- */
  app.get<{ Params: { id: string } }>(
    "/servers/:id/emoticons/sheets",
    async (req, reply) => {
      const g = await gate(req, req.params.id);
      if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }
      // Approved sheets that belong to THIS server OR are platform-shared
      // (NULL serverId). Pending/rejected submissions live in the
      // submissions queue below, not in the catalog list.
      const rows = await db
        .select()
        .from(emoticonSheets)
        .where(and(
          eq(emoticonSheets.status, "approved"),
          or(eq(emoticonSheets.serverId, g.serverId), isNull(emoticonSheets.serverId)),
        ))
        .orderBy(asc(emoticonSheets.sortOrder), asc(emoticonSheets.createdAt));
      const sheets: ServerSheetWire[] = rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        imageUrl: r.imageUrl,
        cells: parseSheetCells(r.cells),
        sortOrder: r.sortOrder,
        status: r.status,
        serverId: r.serverId,
        // Shared/built-in (NULL serverId) rows are read-only from a
        // sub-server; only this server's own rows may be mutated.
        editable: r.serverId === g.serverId,
        useCount: r.useCount ?? 0,
        createdAt: r.createdAt ? +r.createdAt : 0,
      }));
      return { sheets };
    },
  );

  /* ---------- Create a sheet (stamped to this server) ---------- */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/servers/:id/emoticons/sheets",
    async (req, reply) => {
      const g = await gate(req, req.params.id);
      if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }

      let body: z.infer<typeof createSheetBody>;
      try { body = createSheetBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const slug = body.slug.toLowerCase();
      // slug is globally unique (column constraint) — check up front so the
      // image write below isn't wasted on a doomed insert.
      const dup = (await db.select({ id: emoticonSheets.id })
        .from(emoticonSheets).where(eq(emoticonSheets.slug, slug)).limit(1))[0];
      if (dup) { reply.code(409); return { error: "slug already in use" }; }

      const id = nanoid();
      const imageResult = await writeSheetImage(id, body.imageDataUrl);
      if ("error" in imageResult) { reply.code(imageResult.status); return { error: imageResult.error }; }

      // Tail-order within THIS server's sheets so a new sheet lands last.
      const tail = (await db
        .select({ max: sql<number>`coalesce(max(${emoticonSheets.sortOrder}), -1)` })
        .from(emoticonSheets)
        .where(eq(emoticonSheets.serverId, g.serverId)))[0];
      const sortOrder = body.sortOrder ?? (tail?.max ?? -1) + 1;

      await db.insert(emoticonSheets).values({
        id,
        slug,
        name: body.name,
        imageUrl: imageResult.url,
        cells: JSON.stringify(body.cells),
        sortOrder,
        createdByUserId: g.me.id,
        // Stamp to this server so it never leaks into another server's
        // catalog (and stays out of the platform-shared NULL bucket).
        serverId: g.serverId,
      });

      await audit({
        serverId: g.serverId,
        actorUserId: g.me.id,
        action: "server_emoticon_sheet_create",
        metadata: { id, slug, name: body.name, bytes: imageResult.bytes, mime: imageResult.mime },
      });

      io.emit("emoticons:updated");
      const row = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, id)).limit(1))[0]!;
      reply.code(201);
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        imageUrl: row.imageUrl,
        cells: parseSheetCells(row.cells),
        sortOrder: row.sortOrder,
        status: row.status,
        serverId: row.serverId,
        editable: true,
        useCount: row.useCount ?? 0,
        createdAt: row.createdAt ? +row.createdAt : 0,
      } satisfies ServerSheetWire;
    },
  );

  /* ---------- Edit a sheet (own server's rows only) ---------- */
  app.patch<{ Params: { id: string; sheetId: string }; Body: unknown }>(
    "/servers/:id/emoticons/sheets/:sheetId",
    async (req, reply) => {
      const g = await gate(req, req.params.id);
      if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }

      const current = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, req.params.sheetId)).limit(1))[0];
      // Cross-server isolation: a row that isn't stamped to THIS server
      // (including a platform-shared NULL row) is invisible/uneditable here.
      // 404 rather than 403 so we don't confirm the id even exists elsewhere.
      if (!current || current.serverId !== g.serverId) { reply.code(404); return { error: "not found" }; }

      let body: z.infer<typeof updateSheetBody>;
      try { body = updateSheetBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const update: Partial<typeof emoticonSheets.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) update.name = body.name;
      if (body.cells !== undefined) update.cells = JSON.stringify(body.cells);
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      if (body.imageDataUrl !== undefined) {
        const imageResult = await writeSheetImage(current.id, body.imageDataUrl);
        if ("error" in imageResult) { reply.code(imageResult.status); return { error: imageResult.error }; }
        update.imageUrl = imageResult.url;
        // Best-effort cleanup of the prior file if it lived on the volume.
        if (current.imageUrl.startsWith("/uploads/emoticons/")) {
          const oldFilename = current.imageUrl.slice("/uploads/emoticons/".length);
          if (oldFilename && oldFilename !== imageResult.url.slice("/uploads/emoticons/".length)) {
            unlink(join(emoticonsDir, oldFilename)).catch(() => { /* best-effort */ });
          }
        }
      }

      await db.update(emoticonSheets).set(update).where(eq(emoticonSheets.id, current.id));

      await audit({
        serverId: g.serverId,
        actorUserId: g.me.id,
        action: "server_emoticon_sheet_update",
        metadata: { id: current.id, fields: Object.keys(update).filter((k) => k !== "updatedAt") },
      });

      io.emit("emoticons:updated");
      const row = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, current.id)).limit(1))[0]!;
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        imageUrl: row.imageUrl,
        cells: parseSheetCells(row.cells),
        sortOrder: row.sortOrder,
        status: row.status,
        serverId: row.serverId,
        editable: true,
        useCount: row.useCount ?? 0,
        createdAt: row.createdAt ? +row.createdAt : 0,
      } satisfies ServerSheetWire;
    },
  );

  /* ---------- Delete a sheet (own server's rows only) ---------- */
  app.delete<{ Params: { id: string; sheetId: string } }>(
    "/servers/:id/emoticons/sheets/:sheetId",
    async (req, reply) => {
      const g = await gate(req, req.params.id);
      if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }

      const current = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, req.params.sheetId)).limit(1))[0];
      if (!current || current.serverId !== g.serverId) { reply.code(404); return { error: "not found" }; }

      // Pending submissions hold the submitter's paid Currency; force the
      // admin through the queue's Reject button so the refund fires. (Mirror
      // of the global module's DELETE guard.)
      if (current.status === "pending") {
        reply.code(409);
        return {
          error: "submission is pending review",
          message: tFor(g.me.locale, "errors:server.emoticons.pendingRejectViaQueue"),
        };
      }

      // FK ON DELETE CASCADE on message_reactions.sheet_id removes any
      // reactions placed with this sheet — intentional, pulling a sheet means
      // its emoticons vanish everywhere.
      await db.delete(emoticonSheets).where(eq(emoticonSheets.id, current.id));

      if (current.imageUrl.startsWith("/uploads/emoticons/")) {
        const filename = current.imageUrl.slice("/uploads/emoticons/".length);
        unlink(join(emoticonsDir, filename)).catch(() => { /* best-effort */ });
      }

      await audit({
        serverId: g.serverId,
        actorUserId: g.me.id,
        action: "server_emoticon_sheet_delete",
        metadata: { id: current.id, slug: current.slug },
      });

      io.emit("emoticons:updated");
      return { ok: true };
    },
  );

  /* ---------- Submissions: this server's review queue ---------- */
  app.get<{ Params: { id: string } }>(
    "/servers/:id/emoticons/submissions",
    async (req, reply) => {
      const g = await gate(req, req.params.id);
      if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }
      // Submission rows are those that went through the /me/emoticon-submissions
      // flow (non-null submitterPoolId) AND were stamped with THIS server's id
      // at submit time.
      const rows = await db
        .select()
        .from(emoticonSheets)
        .where(and(
          sql`${emoticonSheets.submitterPoolId} IS NOT NULL`,
          eq(emoticonSheets.serverId, g.serverId),
        ))
        .orderBy(desc(emoticonSheets.createdAt))
        .limit(50);

      // Resolve submitter display labels in two batched queries.
      const userPoolIds = rows.filter((r) => r.submitterScope === "user").map((r) => r.submitterPoolId!).filter(Boolean);
      const charPoolIds = rows.filter((r) => r.submitterScope === "character").map((r) => r.submitterPoolId!).filter(Boolean);
      const userRows = userPoolIds.length
        ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userPoolIds))
        : [];
      const charRows = charPoolIds.length
        ? await db.select({ id: characters.id, name: characters.name, userId: characters.userId })
            .from(characters).where(inArray(characters.id, charPoolIds))
        : [];
      const usernameById = new Map(userRows.map((r) => [r.id, r.username]));
      const charById = new Map(charRows.map((r) => [r.id, r]));

      const submissions: ServerSubmissionWire[] = rows.map((r) => {
        let submitterLabel = "(unknown)";
        if (r.submitterScope === "user" && r.submitterPoolId) {
          submitterLabel = usernameById.get(r.submitterPoolId) ?? "(deleted user)";
        } else if (r.submitterScope === "character" && r.submitterPoolId) {
          const c = charById.get(r.submitterPoolId);
          submitterLabel = c ? `${c.name} (${usernameById.get(c.userId) ?? "?"})` : "(deleted character)";
        }
        return {
          id: r.id,
          slug: r.slug,
          name: r.name,
          imageUrl: r.imageUrl,
          cells: parseSheetCells(r.cells),
          status: r.status,
          submitterScope: r.submitterScope,
          submitterPoolId: r.submitterPoolId,
          submitterLabel,
          costPaid: r.costPaid,
          rejectionReason: r.rejectionReason,
          reviewedAt: r.reviewedAt ? +r.reviewedAt : null,
          createdAt: r.createdAt ? +r.createdAt : 0,
        };
      });
      return { submissions };
    },
  );

  /* ---------- Approve a pending submission ---------- */
  app.post<{ Params: { id: string; sheetId: string } }>(
    "/servers/:id/emoticons/submissions/:sheetId/approve",
    async (req, reply) => {
      const g = await gate(req, req.params.id);
      if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }

      const row = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, req.params.sheetId)).limit(1))[0];
      // Must be a submission stamped to THIS server.
      if (!row || row.serverId !== g.serverId || !row.submitterPoolId) { reply.code(404); return { error: "not found" }; }
      if (row.status !== "pending") { reply.code(409); return { error: `submission already ${row.status}` }; }

      // Tail-order within this server's sheets so it surfaces last.
      const tail = (await db
        .select({ max: sql<number>`coalesce(max(${emoticonSheets.sortOrder}), -1)` })
        .from(emoticonSheets)
        .where(eq(emoticonSheets.serverId, g.serverId)))[0];
      const newSortOrder = (tail?.max ?? -1) + 1;

      await db.update(emoticonSheets)
        .set({
          status: "approved",
          sortOrder: newSortOrder,
          reviewedAt: Date.now(),
          reviewedByUserId: g.me.id,
          updatedAt: new Date(),
        })
        .where(eq(emoticonSheets.id, row.id));

      await audit({
        serverId: g.serverId,
        actorUserId: g.me.id,
        action: "server_emoticon_sheet_approve",
        targetUserId: row.createdByUserId ?? null,
        metadata: { id: row.id, slug: row.slug, costPaid: row.costPaid },
      });

      io.emit("emoticons:updated");
      if (row.createdByUserId) {
        // Bell-row copy renders in the SUBMITTER's language.
        const submitterLocale = (await db
          .select({ locale: users.locale })
          .from(users)
          .where(eq(users.id, row.createdByUserId))
          .limit(1))[0]?.locale ?? null;
        await notify(db, io, {
          userId: row.createdByUserId,
          category: "server",
          kind: "emoticon_approved",
          serverId: g.serverId,
          title: tFor(submitterLocale, "notifications:server.emoticonApprovedTitle"),
          snippet: tFor(submitterLocale, "notifications:server.emoticonApprovedSnippet", { slug: row.slug }),
          target: { kind: "server", id: g.serverId },
        });
      }
      return { ok: true };
    },
  );

  /* ---------- Reject a pending submission (refund + delete asset) ---------- */
  app.post<{ Params: { id: string; sheetId: string }; Body: unknown }>(
    "/servers/:id/emoticons/submissions/:sheetId/reject",
    async (req, reply) => {
      const g = await gate(req, req.params.id);
      if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }

      let body: z.infer<typeof rejectSubmissionBody>;
      try { body = rejectSubmissionBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const row = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, req.params.sheetId)).limit(1))[0];
      if (!row || row.serverId !== g.serverId || !row.submitterPoolId) { reply.code(404); return { error: "not found" }; }
      if (row.status !== "pending") { reply.code(409); return { error: `submission already ${row.status}` }; }

      const refundAmount = row.costPaid ?? 0;
      const refundScope = row.submitterScope as "user" | "character" | null;
      const refundPoolId = row.submitterPoolId;
      // Refund + status flip in one txn. The submission economy is global
      // (debited on DEFAULT_SERVER_ID at submit time — see
      // routes/emoticons.ts), so the refund credits the same pool there;
      // only the review ROUTING is per-server.
      db.transaction((tx) => {
        if (refundAmount > 0 && refundScope && refundPoolId) {
          if (refundScope === "character") {
            const cur = tx.select({ currency: characterEarning.currency })
              .from(characterEarning)
              .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, refundPoolId)))
              .limit(1).all()[0];
            const balance = cur?.currency ?? 0;
            tx.update(characterEarning)
              .set({ currency: balance + refundAmount, updatedAt: new Date() })
              .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, refundPoolId)))
              .run();
          } else {
            const cur = tx.select({ currency: userEarning.currency })
              .from(userEarning)
              .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, refundPoolId)))
              .limit(1).all()[0];
            const balance = cur?.currency ?? 0;
            tx.update(userEarning)
              .set({ currency: balance + refundAmount, updatedAt: new Date() })
              .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, refundPoolId)))
              .run();
          }
          tx.insert(earningLedger).values({
            id: nanoid(),
            serverId: DEFAULT_SERVER_ID,
            scope: refundScope,
            ownerId: refundPoolId,
            xpDelta: 0,
            currencyDelta: refundAmount,
            reason: `emoticon_submission_refund_${row.id}`,
            metadataJson: JSON.stringify({
              kind: "emoticon_submission_refund",
              submissionId: row.id,
              slug: row.slug,
              rejectionReason: body.reason ?? null,
              reviewedByServerId: g.serverId,
            }),
            createdAt: new Date(),
          }).run();
        }
        tx.update(emoticonSheets)
          .set({
            status: "rejected",
            reviewedAt: Date.now(),
            reviewedByUserId: g.me.id,
            rejectionReason: body.reason ?? null,
            updatedAt: new Date(),
          })
          .where(eq(emoticonSheets.id, row.id))
          .run();
      });

      // Delete the asset file outside the txn (best-effort).
      if (row.imageUrl.startsWith("/uploads/emoticons/")) {
        const filename = row.imageUrl.slice("/uploads/emoticons/".length);
        unlink(join(emoticonsDir, filename)).catch(() => { /* best-effort */ });
      }

      await audit({
        serverId: g.serverId,
        actorUserId: g.me.id,
        action: "server_emoticon_sheet_reject",
        targetUserId: row.createdByUserId ?? null,
        reason: body.reason ?? null,
        metadata: { id: row.id, slug: row.slug, refundAmount, refundScope, refundPoolId },
      });

      // Mirror approve/create/update/delete: refresh other open admin clients'
      // pending list so a rejected submission doesn't linger as stale.
      io.emit("emoticons:updated");

      if (row.createdByUserId) {
        // Bell-row copy renders in the SUBMITTER's language; a reviewer-typed
        // reason is content and passes through as written.
        const submitterLocale = (await db
          .select({ locale: users.locale })
          .from(users)
          .where(eq(users.id, row.createdByUserId))
          .limit(1))[0]?.locale ?? null;
        await notify(db, io, {
          userId: row.createdByUserId,
          category: "server",
          kind: "emoticon_rejected",
          serverId: g.serverId,
          title: tFor(submitterLocale, "notifications:server.emoticonDeclinedTitle"),
          snippet: body.reason
            ? body.reason
            : tFor(
                submitterLocale,
                refundAmount > 0
                  ? "notifications:server.emoticonDeclinedRefundSnippet"
                  : "notifications:server.emoticonDeclinedSnippet",
                { slug: row.slug },
              ),
          target: { kind: "server", id: g.serverId },
        });
      }

      return { ok: true, refundedAmount: refundAmount };
    },
  );
}
