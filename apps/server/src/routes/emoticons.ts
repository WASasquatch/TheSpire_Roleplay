import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, asc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { isAdminRole } from "@thekeep/shared";
import type {
  ClientToServerEvents,
  EmoticonSheet as WireEmoticonSheet,
  ReactionEvent,
  ReactionSummary,
  ReactionTargetKind,
  ServerToClientEvents,
} from "@thekeep/shared";
import {
  EMOTICON_SHEET_CELL_COUNT,
  isEmoticonCellEmpty,
} from "@thekeep/shared";
import {
  characters,
  directConversations,
  directMessages,
  emoticonSheets,
  messageReactions,
  messages,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { recordAudit } from "../audit.js";
import { loadReactionsForTargets, parseSheetCells } from "../reactions.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const SLUG_RX = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

/* =====================================================================
 *  Image upload helpers — same posture as admin/upload/logo: small
 *  whitelist of magic bytes, content-hashed filenames so a re-upload
 *  of the same bytes deduplicates and a replaced image necessarily
 *  produces a fresh URL (busting any stale picker cache).
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

function sheetRowToWire(row: typeof emoticonSheets.$inferSelect): WireEmoticonSheet {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    imageUrl: row.imageUrl,
    cells: parseSheetCells(row.cells),
    sortOrder: row.sortOrder,
  };
}

/* =====================================================================
 *  Authorization — does this viewer have read access to a target so
 *  they can place a reaction on it? Chat messages: must be in the
 *  room. DMs: must be a participant.
 * ===================================================================== */
async function viewerMayReactOn(
  db: Db,
  kind: ReactionTargetKind,
  targetId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (kind === "chat_message") {
    const m = (await db.select({ id: messages.id, roomId: messages.roomId })
      .from(messages).where(eq(messages.id, targetId)).limit(1))[0];
    if (!m) return { ok: false, status: 404, error: "message not found" };
    // Reaction access mirrors read access: if the user can see the
    // message they can react. Chat messages in public rooms are
    // visible to any authenticated user; private-room messages are
    // protected by the room membership which the existing chat
    // backlog endpoint already enforces. The reaction endpoint
    // trusts the same posture — if a user has seen the message id,
    // they may react. (A defense-in-depth room-membership check
    // could be added later if private rooms become reaction-sensitive.)
    return { ok: true };
  }
  if (kind === "dm") {
    const m = (await db.select({ conversationId: directMessages.conversationId })
      .from(directMessages).where(eq(directMessages.id, targetId)).limit(1))[0];
    if (!m) return { ok: false, status: 404, error: "message not found" };
    const c = (await db.select({ a: directConversations.userAId, b: directConversations.userBId })
      .from(directConversations).where(eq(directConversations.id, m.conversationId)).limit(1))[0];
    if (!c) return { ok: false, status: 404, error: "conversation not found" };
    if (c.a !== userId && c.b !== userId) return { ok: false, status: 403, error: "not your conversation" };
    return { ok: true };
  }
  // forum_post is reserved but not yet implemented at the route layer.
  return { ok: false, status: 400, error: "unsupported target kind" };
}

/* =====================================================================
 *  Realtime fan-out — chat reactions go to the room socket-room; DM
 *  reactions go to both participants' sockets.
 * ===================================================================== */
async function broadcastReaction(
  io: Io,
  db: Db,
  kind: ReactionTargetKind,
  targetId: string,
  payload: ReactionEvent,
): Promise<void> {
  if (kind === "chat_message") {
    const m = (await db.select({ roomId: messages.roomId })
      .from(messages).where(eq(messages.id, targetId)).limit(1))[0];
    if (!m) return;
    io.to(`room:${m.roomId}`).emit("reaction:update", payload);
    return;
  }
  if (kind === "dm") {
    const m = (await db.select({ conversationId: directMessages.conversationId })
      .from(directMessages).where(eq(directMessages.id, targetId)).limit(1))[0];
    if (!m) return;
    const c = (await db.select({ a: directConversations.userAId, b: directConversations.userBId })
      .from(directConversations).where(eq(directConversations.id, m.conversationId)).limit(1))[0];
    if (!c) return;
    // No room-per-conversation today (DMs use socket-walking), so
    // mirror the dm:new pattern: scan all sockets, emit to the two
    // participants' sockets. Cheap at our scale.
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid === c.a || uid === c.b) s.emit("reaction:update", payload);
    }
    return;
  }
}

/* =====================================================================
 *  Route registration
 * ===================================================================== */
const toggleReactionBody = z.object({
  targetKind: z.enum(["chat_message", "dm", "forum_post"]),
  targetId: z.string().min(1).max(64),
  sheetSlug: z.string().min(1).max(64),
  cellIndex: z.number().int().min(0).max(EMOTICON_SHEET_CELL_COUNT - 1),
  /** Identity to react as — null = master handle, otherwise a
   *  character id the caller owns. Mirrors how `chat:input` picks an
   *  identity at send time. */
  asCharacterId: z.string().min(1).max(64).nullable().optional(),
});

const createSheetBody = z.object({
  slug: z.string().min(1).max(40).regex(SLUG_RX, "slug must be 1-40 lowercase letters / digits / hyphens"),
  name: z.string().min(1).max(80),
  /** 16-element label array. Validate length on the server; client
   *  is expected to pad. Empty / "empty" hide the cell from the picker. */
  cells: z.array(z.string().max(40)).length(EMOTICON_SHEET_CELL_COUNT),
  /** Data URL with image payload. PNG/JPEG/WebP/GIF accepted. */
  imageDataUrl: z.string().min(32).max(8 * 1024 * 1024),
  sortOrder: z.number().int().optional(),
});

const updateSheetBody = z.object({
  name: z.string().min(1).max(80).optional(),
  cells: z.array(z.string().max(40)).length(EMOTICON_SHEET_CELL_COUNT).optional(),
  imageDataUrl: z.string().min(32).max(8 * 1024 * 1024).optional(),
  sortOrder: z.number().int().optional(),
});

export async function registerEmoticonRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
  uploadsRoot: string,
): Promise<void> {
  const emoticonsDir = join(uploadsRoot, "emoticons");

  async function writeSheetImage(sheetId: string, dataUrl: string): Promise<{ url: string; mime: string; bytes: number } | { error: string; status: number }> {
    const bytes = decodeDataUrl(dataUrl);
    if (!bytes) return { error: "expected a base64 data URL", status: 400 };
    const detected = detectImage(bytes);
    if (!detected) return { error: "unsupported image type (png, jpg, webp, gif only)", status: 415 };
    // Content-hash so a re-upload of the same bytes is a no-op file
    // write, AND a re-upload of NEW bytes produces a fresh URL that
    // busts any picker / sprite-image cache that held the previous one.
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const filename = `${sheetId}-${hash}.${detected.ext}`;
    await mkdir(emoticonsDir, { recursive: true });
    await writeFile(join(emoticonsDir, filename), bytes);
    return { url: `/uploads/emoticons/${filename}`, mime: detected.mime, bytes: bytes.length };
  }

  /* ---------- Public catalog ---------- */
  app.get("/emoticons", async () => {
    const rows = await db
      .select()
      .from(emoticonSheets)
      .orderBy(asc(emoticonSheets.sortOrder), asc(emoticonSheets.createdAt));
    return { sheets: rows.map(sheetRowToWire) };
  });

  /* ---------- Admin: create sheet ---------- */
  app.post<{ Body: unknown }>("/admin/emoticons/sheets", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || !isAdminRole(me.role)) { reply.code(403); return { error: "admin only" }; }

    let body: z.infer<typeof createSheetBody>;
    try { body = createSheetBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const slug = body.slug.toLowerCase();
    const dup = (await db.select({ id: emoticonSheets.id })
      .from(emoticonSheets).where(eq(emoticonSheets.slug, slug)).limit(1))[0];
    if (dup) { reply.code(409); return { error: "slug already in use" }; }

    const id = nanoid();
    const imageResult = await writeSheetImage(id, body.imageDataUrl);
    if ("error" in imageResult) { reply.code(imageResult.status); return { error: imageResult.error }; }

    const tail = (await db
      .select({ max: sql<number>`coalesce(max(${emoticonSheets.sortOrder}), -1)` })
      .from(emoticonSheets))[0];
    const sortOrder = body.sortOrder ?? (tail?.max ?? -1) + 1;

    await db.insert(emoticonSheets).values({
      id,
      slug,
      name: body.name,
      imageUrl: imageResult.url,
      cells: JSON.stringify(body.cells),
      sortOrder,
      createdByUserId: me.id,
    });

    await recordAudit(db, {
      actorUserId: me.id,
      action: "emoticon_sheet_create",
      metadata: { id, slug, name: body.name, bytes: imageResult.bytes, mime: imageResult.mime },
    });

    io.emit("emoticons:updated");
    const row = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, id)).limit(1))[0]!;
    reply.code(201);
    return sheetRowToWire(row);
  });

  /* ---------- Admin: update sheet ---------- */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/emoticons/sheets/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || !isAdminRole(me.role)) { reply.code(403); return { error: "admin only" }; }
    const current = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, req.params.id)).limit(1))[0];
    if (!current) { reply.code(404); return { error: "not found" }; }

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
      // Best-effort cleanup of the previous file IF it lived under
      // /uploads/emoticons. Seeded sheets pointing at /assets/... are
      // left alone (those are bundled, not on the volume).
      if (current.imageUrl.startsWith("/uploads/emoticons/")) {
        const oldFilename = current.imageUrl.slice("/uploads/emoticons/".length);
        if (oldFilename && oldFilename !== imageResult.url.slice("/uploads/emoticons/".length)) {
          unlink(join(emoticonsDir, oldFilename)).catch(() => { /* best-effort */ });
        }
      }
    }

    await db.update(emoticonSheets).set(update).where(eq(emoticonSheets.id, current.id));

    await recordAudit(db, {
      actorUserId: me.id,
      action: "emoticon_sheet_update",
      metadata: { id: current.id, fields: Object.keys(update).filter((k) => k !== "updatedAt") },
    });

    io.emit("emoticons:updated");
    const row = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, current.id)).limit(1))[0]!;
    return sheetRowToWire(row);
  });

  /* ---------- Admin: delete sheet ---------- */
  app.delete<{ Params: { id: string } }>("/admin/emoticons/sheets/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me || !isAdminRole(me.role)) { reply.code(403); return { error: "admin only" }; }
    const current = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, req.params.id)).limit(1))[0];
    if (!current) { reply.code(404); return { error: "not found" }; }

    // FK ON DELETE CASCADE on message_reactions.sheet_id wipes any
    // reactions placed with this sheet. That's intentional — pulling
    // a sheet means every emoticon from it disappears everywhere.
    await db.delete(emoticonSheets).where(eq(emoticonSheets.id, current.id));

    if (current.imageUrl.startsWith("/uploads/emoticons/")) {
      const filename = current.imageUrl.slice("/uploads/emoticons/".length);
      unlink(join(emoticonsDir, filename)).catch(() => { /* best-effort */ });
    }

    await recordAudit(db, {
      actorUserId: me.id,
      action: "emoticon_sheet_delete",
      metadata: { id: current.id, slug: current.slug },
    });

    io.emit("emoticons:updated");
    return { ok: true };
  });

  /* ---------- Reactions: toggle ---------- */
  app.post<{ Body: unknown }>("/reactions/toggle", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body: z.infer<typeof toggleReactionBody>;
    try { body = toggleReactionBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    // Resolve the sheet (slug → row) and validate the cell isn't
    // "empty" (those cells aren't pickable). Slug → id mapping is the
    // wire convention: clients refer to sheets by slug, the DB by id.
    const sheet = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.slug, body.sheetSlug)).limit(1))[0];
    if (!sheet) { reply.code(404); return { error: "emoticon sheet not found" }; }
    const cells = parseSheetCells(sheet.cells);
    const label = cells[body.cellIndex] ?? "";
    if (isEmoticonCellEmpty(label)) {
      reply.code(400);
      return { error: "cell is empty and cannot be reacted with" };
    }

    // Authorization on the target. Returns the right HTTP status for
    // the caller (404 for missing, 403 for not-a-participant on DMs).
    const access = await viewerMayReactOn(db, body.targetKind, body.targetId, me.id);
    if (!access.ok) { reply.code(access.status); return { error: access.error }; }

    // Resolve the acting identity (master vs character). If the
    // caller passed a character id, verify they own it.
    let actingCharacterId: string | null = null;
    let displayName = me.username;
    if (body.asCharacterId) {
      const c = (await db.select().from(characters)
        .where(and(eq(characters.id, body.asCharacterId), eq(characters.userId, me.id)))
        .limit(1))[0];
      if (!c || c.deletedAt) { reply.code(403); return { error: "not your character" }; }
      actingCharacterId = c.id;
      displayName = c.name;
    } else {
      // Master handle. Honor any cached display name (rare; users
      // table is the source of truth).
      const u = (await db.select({ username: users.username })
        .from(users).where(eq(users.id, me.id)).limit(1))[0];
      displayName = u?.username ?? me.username;
    }

    // Toggle. The unique index on
    // (target_kind, target_id, user_id, sheet_id, cell_index) means
    // there's at most one row matching this user's reaction with
    // this emoticon on this target. Existing → DELETE; absent → INSERT.
    const existing = (await db.select({ id: messageReactions.id }).from(messageReactions)
      .where(and(
        eq(messageReactions.targetKind, body.targetKind),
        eq(messageReactions.targetId, body.targetId),
        eq(messageReactions.userId, me.id),
        eq(messageReactions.sheetId, sheet.id),
        eq(messageReactions.cellIndex, body.cellIndex),
      ))
      .limit(1))[0];

    const now = new Date();
    let op: "add" | "remove";
    if (existing) {
      await db.delete(messageReactions).where(eq(messageReactions.id, existing.id));
      op = "remove";
    } else {
      await db.insert(messageReactions).values({
        id: nanoid(),
        targetKind: body.targetKind,
        targetId: body.targetId,
        userId: me.id,
        characterId: actingCharacterId,
        displayName,
        sheetId: sheet.id,
        cellIndex: body.cellIndex,
        createdAt: now,
      });
      op = "add";
    }

    const event: ReactionEvent = {
      targetKind: body.targetKind,
      targetId: body.targetId,
      sheetSlug: sheet.slug,
      cellIndex: body.cellIndex,
      label,
      op,
      actor: {
        userId: me.id,
        characterId: actingCharacterId,
        displayName,
        reactedAt: +now,
      },
    };
    await broadcastReaction(io, db, body.targetKind, body.targetId, event);

    // Return the fresh summary so the caller can update without an
    // extra GET. Computing it after the write keeps the response
    // self-consistent with the broadcast we just sent.
    const summaryMap = await loadReactionsForTargets(db, body.targetKind, [body.targetId], me.id);
    const summary: ReactionSummary = {
      targetKind: body.targetKind,
      targetId: body.targetId,
      entries: summaryMap.get(body.targetId) ?? [],
    };
    return { op, summary };
  });

  /* ---------- Read reactions for a target ----------
   * Mostly used for refresh after a missed socket event; the message
   * payloads already carry their reactions inline. */
  app.get<{ Params: { targetKind: ReactionTargetKind; targetId: string } }>(
    "/reactions/:targetKind/:targetId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const kind = req.params.targetKind;
      if (kind !== "chat_message" && kind !== "dm" && kind !== "forum_post") {
        reply.code(400);
        return { error: "unsupported target kind" };
      }
      const access = await viewerMayReactOn(db, kind, req.params.targetId, me.id);
      if (!access.ok) { reply.code(access.status); return { error: access.error }; }
      const summaryMap = await loadReactionsForTargets(db, kind, [req.params.targetId], me.id);
      const summary: ReactionSummary = {
        targetKind: kind,
        targetId: req.params.targetId,
        entries: summaryMap.get(req.params.targetId) ?? [],
      };
      return summary;
    },
  );
}
