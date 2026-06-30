import type { FastifyInstance } from "fastify";
import type { Server as IoServer } from "socket.io";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { hasPermission } from "../auth/permissions.js";
import type {
  ClientToServerEvents,
  EmoticonSheet as WireEmoticonSheet,
  ReactionEvent,
  ReactionRef,
  ReactionSummary,
  ReactionTargetKind,
  ServerToClientEvents,
} from "@thekeep/shared";
import {
  COMMUNITY_EMOTICON_USE_COST,
  EMOTICON_SHEET_CELL_COUNT,
  isEmoticonCellEmpty,
  lookupUnicodeEmojiCharByName,
  lookupUnicodeEmojiName,
} from "@thekeep/shared";
import {
  characterEarning,
  characters,
  cosmetics,
  directConversations,
  directMessages,
  earningLedger,
  emoticonSheets,
  messageReactions,
  messages,
  userEarning,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { areServersEnabled, getSettings } from "../settings.js";
import { recordAudit } from "../audit.js";
import { loadReactionsForTargets, parseSheetCells } from "../reactions.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const SLUG_RX = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

/* =====================================================================
 *  Image upload helpers, same posture as admin/upload/logo: small
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

function sheetRowToWire(
  row: typeof emoticonSheets.$inferSelect,
  creatorUsername: string | null = null,
): WireEmoticonSheet {
  // System vs community classification on the way out, `createdByUserId`
  // null = admin-seeded system sheet (free to use); non-null = a
  // moderator-approved user submission (paid per use via the
  // /emoticons/community/:sheetId/use route).
  const isCommunity = !!row.createdByUserId;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    imageUrl: row.imageUrl,
    cells: parseSheetCells(row.cells),
    sortOrder: row.sortOrder,
    kind: isCommunity ? "community" : "system",
    creatorUserId: isCommunity ? row.createdByUserId : null,
    creatorUsername: isCommunity ? creatorUsername : null,
    // System sheets ignore commerce, they're always free regardless
    // of the column value. Community sheets honor the toggle.
    commerceEnabled: isCommunity ? !!row.commerceEnabled : false,
    useCount: row.useCount ?? 0,
    createdAt: row.createdAt ? +row.createdAt : 0,
  };
}

/* =====================================================================
 *  Authorization, does this viewer have read access to a target so
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
    // trusts the same posture, if a user has seen the message id,
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
 *  Realtime fan-out, chat reactions go to the room socket-room; DM
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
/** Toggle-reaction body. Exactly one ref shape must be supplied:
 *   - sheet:    `{ sheetSlug, cellIndex }` for legacy sticker-sheet reactions
 *   - unicode:  `{ unicodeChar }` for raw-codepoint reactions added via
 *               the Unicode tab in the picker
 *  Zod's `.refine` enforces the "exactly one" rule. */
const toggleReactionBody = z.object({
  targetKind: z.enum(["chat_message", "dm", "forum_post"]),
  targetId: z.string().min(1).max(64),
  // Sheet ref, both fields optional individually, presence-validated
  // together below.
  sheetSlug: z.string().min(1).max(64).optional(),
  cellIndex: z.number().int().min(0).max(EMOTICON_SHEET_CELL_COUNT - 1).optional(),
  // Unicode ref. 16 chars is the catalog ceiling for compound RGI
  // sequences (ZWJ families etc.); we cap here too so the column
  // constraint matches the API contract. The `.refine` rejects
  // whitespace-only strings, `z.string().min(1)` only checks
  // length, so a single " " or a lone zero-width joiner used to
  // sneak through and render as a blank chip on the client.
  unicodeChar: z.string().min(1).max(16).refine(
    (s) => s.trim() !== "",
    { message: "unicodeChar must contain a visible codepoint" },
  ).optional(),
  /** Identity to react as, null = master handle, otherwise a
   *  character id the caller owns. Mirrors how `chat:input` picks an
   *  identity at send time. */
  asCharacterId: z.string().min(1).max(64).nullable().optional(),
}).refine(
  (b) => {
    const hasSheet = b.sheetSlug !== undefined && b.cellIndex !== undefined;
    const hasUnicode = b.unicodeChar !== undefined;
    return hasSheet !== hasUnicode; // exactly one
  },
  { message: "supply exactly one of { sheetSlug + cellIndex } or { unicodeChar }" },
);

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

  /* =====================================================================
   *  Per-server catalog scoping (multi-server lift, Phase 6b).
   *
   *  FLAG-OFF SAFETY: with servers OFF these helpers return a "no scope"
   *  sentinel (`null`) and the routes behave EXACTLY as before — every
   *  read/write touches the single global catalog and only the existing
   *  global permission gate runs. When servers are ON the catalog and the
   *  submission-review admin scope to a server: reads filter to the
   *  server's sheets (plus platform-shared NULL-serverId rows), writes
   *  stamp the server id, and a server owner/mod holding `manage_emoticons`
   *  for THAT server may act in addition to the existing global admins.
   *
   *  The acting server is derived from the request's `serverId` (query or
   *  body) — the acting room/context the client is operating in — falling
   *  back to {@link DEFAULT_SERVER_ID} (the Spire system server) when
   *  absent or unknown. The system/default server keeps today's global
   *  catalog posture: an unscoped read and the global-only admin gate.
   * ===================================================================== */

  /** Read the requested acting server id from the request without trusting
   *  it blindly: an unknown/blank value collapses to the default server. */
  function requestedServerId(req: { query?: unknown; body?: unknown }): string {
    const q = (req.query as { serverId?: unknown } | undefined)?.serverId;
    const b = (req.body as { serverId?: unknown } | undefined)?.serverId;
    const raw = typeof q === "string" && q ? q : typeof b === "string" && b ? b : "";
    return raw || DEFAULT_SERVER_ID;
  }

  /**
   * Resolve the catalog scope for a request. Returns `null` when servers are
   * OFF (or the resolved server is the system/default), meaning "behave as
   * today: no server filter, global admin gate only". Otherwise returns the
   * resolved (real, non-system) server id to scope reads/writes to.
   */
  async function resolveCatalogScope(req: { query?: unknown; body?: unknown }): Promise<string | null> {
    if (!areServersEnabled(await getSettings(db))) return null;
    const serverId = requestedServerId(req);
    const { serverAuthority } = await import("../servers/authority.js");
    // Resolve anonymously just to learn whether the server exists and is the
    // system default; the system default keeps today's global posture.
    const probe = await serverAuthority(db, null, serverId);
    if (!probe.server || probe.server.isSystem) return null;
    return serverId;
  }

  /**
   * Authorize a catalog/submission admin action. Always honors the EXISTING
   * global permission check ({@link globalPerm}); when servers are ON and the
   * action targets a real (non-system) server, ALSO admits a server
   * owner/mod who holds `manage_emoticons` for that server. Returns the
   * scope id (or null for the global/default posture) on success, or an
   * error tuple the caller turns into the same 403 shape as before.
   */
  async function authorizeCatalogAdmin(
    me: { id: string; role: import("@thekeep/shared").Role },
    globalPerm: "manage_emoticon_catalog" | "review_emoticon_submissions",
    scopeServerId: string | null,
  ): Promise<{ ok: true; scope: string | null } | { ok: false }> {
    if (await hasPermission(me, globalPerm, db)) return { ok: true, scope: scopeServerId };
    if (scopeServerId) {
      const { serverAuthority, serverCan } = await import("../servers/authority.js");
      const a = await serverAuthority(db, me, scopeServerId);
      if (serverCan(a, "manage_emoticons")) return { ok: true, scope: scopeServerId };
    }
    return { ok: false };
  }

  /**
   * Cross-server isolation for mutating an EXISTING row. A caller who got in
   * only via a server's `manage_emoticons` grant (i.e. lacks the global
   * permission) may touch only rows owned by THAT server — never another
   * server's content nor a platform-shared (NULL-serverId) sheet. Global
   * admins (and the flag-off path, where `scope` is null) are unaffected.
   */
  async function callerOwnsSheetScope(
    me: { id: string; role: import("@thekeep/shared").Role },
    globalPerm: "manage_emoticon_catalog" | "review_emoticon_submissions",
    scope: string | null,
    rowServerId: string | null,
  ): Promise<boolean> {
    if (scope === null) return true; // flag off / default-server posture
    if (await hasPermission(me, globalPerm, db)) return true; // global admin
    return rowServerId === scope; // server admin: own server's rows only
  }

  /* ---------- Public catalog ----------
   *
   * Approved-only filter (migration 0151). Pending and rejected
   * user submissions live in the same table but must NEVER surface
   * in the picker, pending rows aren't live, and rejected rows
   * exist only as moderation history with their image files
   * already deleted.
   */
  app.get("/emoticons", async (req) => {
    // LEFT JOIN users so community sheets ship with the creator's
    // master username for "by @<name>" display in the picker. System
    // sheets (createdByUserId IS NULL) join-miss and stay anonymous.
    //
    // FLAG-OFF: `scope` is null → the original status-only WHERE, byte
    // identical. Servers ON + a real acting server → also restrict to
    // that server's sheets PLUS platform-shared (NULL-serverId) rows.
    const scope = await resolveCatalogScope(req);
    const where = scope
      ? and(
          eq(emoticonSheets.status, "approved"),
          or(eq(emoticonSheets.serverId, scope), isNull(emoticonSheets.serverId)),
        )
      : eq(emoticonSheets.status, "approved");
    const rows = await db
      .select({
        sheet: emoticonSheets,
        creatorUsername: users.username,
      })
      .from(emoticonSheets)
      .leftJoin(users, eq(users.id, emoticonSheets.createdByUserId))
      .where(where)
      .orderBy(asc(emoticonSheets.sortOrder), asc(emoticonSheets.createdAt));
    return { sheets: rows.map((r) => sheetRowToWire(r.sheet, r.creatorUsername)) };
  });

  /* ---------- Admin: create sheet ---------- */
  app.post<{ Body: unknown }>("/admin/emoticons/sheets", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(403); return { error: "forbidden", missing: "manage_emoticon_catalog" }; }
    const scope = await resolveCatalogScope(req);
    const auth = await authorizeCatalogAdmin(me, "manage_emoticon_catalog", scope);
    if (!auth.ok) { reply.code(403); return { error: "forbidden", missing: "manage_emoticon_catalog" }; }

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
      // FLAG-OFF: scope is null → column unset (NULL), exactly as today.
      // Servers ON + a real acting server → stamp the sheet to it.
      ...(auth.scope ? { serverId: auth.scope } : {}),
    });

    await recordAudit(db, {
      actorUserId: me.id,
      action: "emoticon_sheet_create",
      metadata: { id, slug, name: body.name, bytes: imageResult.bytes, mime: imageResult.mime, serverId: auth.scope ?? null },
    });

    io.emit("emoticons:updated");
    const row = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, id)).limit(1))[0]!;
    reply.code(201);
    return sheetRowToWire(row);
  });

  /* ---------- Admin: update sheet ---------- */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/emoticons/sheets/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(403); return { error: "forbidden", missing: "manage_emoticon_catalog" }; }
    const scope = await resolveCatalogScope(req);
    const auth = await authorizeCatalogAdmin(me, "manage_emoticon_catalog", scope);
    if (!auth.ok) { reply.code(403); return { error: "forbidden", missing: "manage_emoticon_catalog" }; }
    const current = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, req.params.id)).limit(1))[0];
    if (!current) { reply.code(404); return { error: "not found" }; }
    if (!(await callerOwnsSheetScope(me, "manage_emoticon_catalog", auth.scope, current.serverId))) {
      reply.code(404); return { error: "not found" };
    }

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
    if (!me) { reply.code(403); return { error: "forbidden", missing: "manage_emoticon_catalog" }; }
    const scope = await resolveCatalogScope(req);
    const auth = await authorizeCatalogAdmin(me, "manage_emoticon_catalog", scope);
    if (!auth.ok) { reply.code(403); return { error: "forbidden", missing: "manage_emoticon_catalog" }; }
    const current = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, req.params.id)).limit(1))[0];
    if (!current) { reply.code(404); return { error: "not found" }; }
    if (!(await callerOwnsSheetScope(me, "manage_emoticon_catalog", auth.scope, current.serverId))) {
      reply.code(404); return { error: "not found" };
    }

    // Phase 3, DELETE refuses to touch pending submissions. Those
    // rows hold the submitter's paid Currency until the moderation
    // queue resolves them; a blind DELETE here would orphan the
    // payment with no refund. Force the admin through the
    // moderation queue's reject path so the refund + audit row fire
    // together.
    if (current.status === "pending") {
      reply.code(409);
      return {
        error: "submission is pending review",
        message: "Use the Reject button in the user-submissions queue to refund the submitter's Currency. Direct delete would orphan their payment.",
      };
    }

    // FK ON DELETE CASCADE on message_reactions.sheet_id wipes any
    // reactions placed with this sheet. That's intentional, pulling
    // a sheet means every emoticon from it disappears everywhere.
    // For rejected rows the image file is already gone (Phase 3
    // reject path deletes it); the unlink below is a no-op then.
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

    // Resolve the ref shape. The zod refine above already guaranteed
    // exactly one is present, so we just branch on which one.
    let sheet: typeof emoticonSheets.$inferSelect | null = null;
    let label = "";
    let ref: ReactionRef;
    if (body.unicodeChar !== undefined) {
      // Unicode path. Normalize the incoming value through the
      // name→char reverse lookup first. The picker has been sending
      // the codepoint correctly for a while, but an older client
      // path stored the catalog NAME ("100") in place of the
      // codepoint ("💯"), guarding here makes the route resilient
      // to any stale client + retroactively repairs a re-toggle of
      // an old broken row. Anything not in the curated catalog
      // (free-form OS-picker paste) falls through unchanged.
      const normalizedChar = lookupUnicodeEmojiCharByName(body.unicodeChar) ?? body.unicodeChar;
      ref = { kind: "unicode", char: normalizedChar };
      label = lookupUnicodeEmojiName(normalizedChar) ?? normalizedChar;
    } else {
      // Sheet path. Resolve slug → row, validate the cell isn't
      // "empty" (those cells aren't pickable). Pending and rejected
      // sheets (migration 0151) are NOT reactable, the picker
      // filters them out, but a client could in principle know the
      // slug of a friend's pending submission and try to bypass;
      // reject server-side too.
      sheet = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.slug, body.sheetSlug!)).limit(1))[0] ?? null;
      if (!sheet || sheet.status !== "approved") { reply.code(404); return { error: "emoticon sheet not found" }; }
      const cells = parseSheetCells(sheet.cells);
      label = cells[body.cellIndex!] ?? "";
      if (isEmoticonCellEmpty(label)) {
        reply.code(400);
        return { error: "cell is empty and cannot be reacted with" };
      }
      ref = { kind: "sheet", sheetSlug: sheet.slug, cellIndex: body.cellIndex! };
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
    // (target_kind, target_id, user_id, COALESCE(sheet_id||':'||cell_index, unicode_char))
    // gives us "one user, one emoji, one target" across both ref
    // shapes. We branch the lookup WHERE clause on which ref this
    // request carries, the COALESCE expression isn't easy to
    // re-execute through Drizzle, so we just match the same columns
    // the application set.
    const existing = ref.kind === "sheet"
      ? (await db.select({ id: messageReactions.id }).from(messageReactions)
          .where(and(
            eq(messageReactions.targetKind, body.targetKind),
            eq(messageReactions.targetId, body.targetId),
            eq(messageReactions.userId, me.id),
            eq(messageReactions.sheetId, sheet!.id),
            eq(messageReactions.cellIndex, ref.cellIndex),
          ))
          .limit(1))[0]
      : (await db.select({ id: messageReactions.id }).from(messageReactions)
          .where(and(
            eq(messageReactions.targetKind, body.targetKind),
            eq(messageReactions.targetId, body.targetId),
            eq(messageReactions.userId, me.id),
            eq(messageReactions.unicodeChar, ref.char),
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
        // Set the appropriate ref-shape columns and leave the others
        // null. The COALESCE-based unique index relies on this
        // mutual-exclusion to dedupe correctly.
        sheetId: ref.kind === "sheet" ? sheet!.id : null,
        cellIndex: ref.kind === "sheet" ? ref.cellIndex : null,
        unicodeChar: ref.kind === "unicode" ? ref.char : null,
        createdAt: now,
      });
      op = "add";
    }

    const event: ReactionEvent = {
      targetKind: body.targetKind,
      targetId: body.targetId,
      ref,
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

  /* =========================================================
   *  User submissions, Phase 3 of the cosmetic expansion.
   *
   *  Flow:
   *    1. User submits a custom 4×4 reaction sheet via POST
   *       /me/emoticon-submissions with a base64 image data URL.
   *    2. Server validates, writes the file, debits the cost of
   *       `flair_reaction_sheet` from the active identity's pool,
   *       and inserts an emoticon_sheets row with status='pending'.
   *    3. Admin reviews via the moderation queue (GET /admin/
   *       emoticons/submissions), then approves or rejects.
   *    4. Reject path refunds the cost (single credit-back ledger
   *       entry) and deletes the asset file.
   *    5. Approve path flips status='approved'; the row immediately
   *       surfaces in the user-facing picker (filtered above).
   *
   *  Anti-abuse: 3 concurrent pending submissions per user. A user
   *  with 3 pending can't submit a 4th until one resolves. Approved
   *  and rejected rows don't count.
   * ========================================================= */

  /** Per-user concurrent-pending cap. Prevents an abuser from
   *  flooding the moderation queue with junk in hopes of getting a
   *  refund treadmill going. Approvers can raise this in code; an
   *  admin-tunable setting would be overkill for the first cut. */
  const MAX_PENDING_PER_USER = 3;

  const submitSheetBody = z.object({
    slug: z.string().min(1).max(40).regex(SLUG_RX, "slug must be 1-40 lowercase letters / digits / hyphens"),
    name: z.string().min(1).max(80),
    cells: z.array(z.string().max(40)).length(EMOTICON_SHEET_CELL_COUNT),
    imageDataUrl: z.string().min(32).max(8 * 1024 * 1024),
    /** Per-identity pool that pays. Null/omitted = master/OOC pool;
     *  a character id pays from that character's pool and tags the
     *  submission so the refund (if any) lands on the right pool. */
    characterId: z.string().nullable().optional(),
    /** Acting server context (multi-server lift). Only consulted when
     *  servers are ON; routes the submission into THAT server's review
     *  queue. Omitted/unknown → the Spire system server (no serverId
     *  stamp), exactly as today. */
    serverId: z.string().nullable().optional(),
  }).strict();

  app.post<{ Body: unknown }>("/me/emoticon-submissions", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body: z.infer<typeof submitSheetBody>;
    try { body = submitSheetBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

    const slug = body.slug.toLowerCase();
    const dup = (await db.select({ id: emoticonSheets.id })
      .from(emoticonSheets).where(eq(emoticonSheets.slug, slug)).limit(1))[0];
    if (dup) { reply.code(409); return { error: "slug already in use" }; }

    // Per-server review routing. FLAG-OFF: null → the sheet's serverId
    // column is left unset (NULL), byte identical to today. Servers ON +
    // a real acting server → stamp it so it lands in that server's queue.
    const submissionScope = await resolveCatalogScope({ body });

    const scopeCharacterId = body.characterId ?? null;
    if (scopeCharacterId) {
      const c = (await db
        .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
        .from(characters)
        .where(eq(characters.id, scopeCharacterId))
        .limit(1))[0];
      if (!c || c.userId !== me.id || c.deletedAt) {
        reply.code(403);
        return { error: "not your character" };
      }
    }

    // Cap concurrent pending submissions across ALL of the user's
    // identities, the abuse concern is per-account, not per-pool.
    // We include both master-paid (submitter_pool_id = me.id) AND
    // character-paid pending rows owned by this user's characters.
    const myCharIds = (await db
      .select({ id: characters.id })
      .from(characters)
      .where(and(eq(characters.userId, me.id), sql`${characters.deletedAt} IS NULL`))).map((r) => r.id);
    const poolIds = [me.id, ...myCharIds];
    const pending = await db
      .select({ id: emoticonSheets.id })
      .from(emoticonSheets)
      .where(and(
        eq(emoticonSheets.status, "pending"),
        inArray(emoticonSheets.submitterPoolId, poolIds),
      ));
    if (pending.length >= MAX_PENDING_PER_USER) {
      reply.code(429);
      return { error: `you already have ${pending.length} pending submission${pending.length === 1 ? "" : "s"}; wait for review before submitting more` };
    }

    // Look up the current submission cost. The `flair_reaction_sheet`
    // cosmetic row is seeded by migration 0151; admins can tune the
    // price via the Flair admin tab. Per-submission (NOT a one-time
    // purchase), each upload re-pays.
    const costRow = (await db
      .select({ cost: cosmetics.cost, enabled: cosmetics.enabled })
      .from(cosmetics)
      // Per-server catalog (migration 0297): read the cost/enabled from the same
      // server the debit below charges (DEFAULT-pinned). Flag off ⇒ the default
      // server, byte-identical to today.
      .where(and(eq(cosmetics.serverId, DEFAULT_SERVER_ID), eq(cosmetics.key, "flair_reaction_sheet")))
      .limit(1))[0];
    if (!costRow || !costRow.enabled) {
      reply.code(503);
      return { error: "reaction sheet submissions are currently disabled" };
    }
    const cost = costRow.cost;

    // Write the image BEFORE the txn. We use a freshly-generated id
    // as the content-hash prefix so the file path is unique to this
    // submission; if the txn fails (race on funds, slug uniqueness)
    // we clean up the orphan file in the catch below.
    const submissionId = nanoid();
    const imageResult = await writeSheetImage(submissionId, body.imageDataUrl);
    if ("error" in imageResult) { reply.code(imageResult.status); return { error: imageResult.error }; }

    // Resolve the refund-target pool id. For master scope this is
    // the user id; for character scope it's the character id.
    const submitterScope: "user" | "character" = scopeCharacterId ? "character" : "user";
    const submitterPoolId = scopeCharacterId ?? me.id;

    try {
      db.transaction((tx) => {
        // Race-safe re-check of funds + lazy-ensure the earning row
        // exists. Same pattern as runPurchaseTxn in earning.ts.
        if (scopeCharacterId) {
          tx.insert(characterEarning).values({ serverId: DEFAULT_SERVER_ID, characterId: scopeCharacterId }).onConflictDoNothing().run();
          const row = tx.select({ currency: characterEarning.currency })
            .from(characterEarning).where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, scopeCharacterId))).limit(1).all()[0];
          const balance = row?.currency ?? 0;
          if (balance < cost) throw new InsufficientFunds(cost, balance);
          tx.update(characterEarning)
            .set({ currency: balance - cost, updatedAt: new Date() })
            .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, scopeCharacterId)))
            .run();
        } else {
          tx.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId: me.id }).onConflictDoNothing().run();
          const row = tx.select({ currency: userEarning.currency })
            .from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id))).limit(1).all()[0];
          const balance = row?.currency ?? 0;
          if (balance < cost) throw new InsufficientFunds(cost, balance);
          tx.update(userEarning)
            .set({ currency: balance - cost, updatedAt: new Date() })
            .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id)))
            .run();
        }
        // Append the ledger row. Reason embeds the submission id so
        // the refund path can find the matching debit if needed; the
        // refund record uses a parallel `emoticon_submission_refund_<id>`
        // reason.
        tx.insert(earningLedger).values({
          id: nanoid(),
          serverId: DEFAULT_SERVER_ID,
          scope: submitterScope,
          ownerId: submitterPoolId,
          xpDelta: 0,
          currencyDelta: -cost,
          reason: `emoticon_submission_${submissionId}`,
          metadataJson: JSON.stringify({ kind: "emoticon_submission", submissionId, slug, name: body.name }),
          createdAt: new Date(),
        }).run();
        // And finally the sheet row itself. status='pending' keeps
        // it out of the picker until an admin approves.
        tx.insert(emoticonSheets).values({
          id: submissionId,
          slug,
          name: body.name,
          imageUrl: imageResult.url,
          cells: JSON.stringify(body.cells),
          // Pending submissions don't compete for the sortOrder slot,
          // admins decide where it sits when they approve. Start at 0;
          // the approve endpoint reorders to the tail.
          sortOrder: 0,
          createdByUserId: me.id,
          status: "pending",
          submitterScope,
          submitterPoolId,
          costPaid: cost,
          ...(submissionScope ? { serverId: submissionScope } : {}),
        }).run();
      });
    } catch (err) {
      // Roll back the orphan file write (best-effort) and surface
      // the actual error to the caller.
      unlink(join(emoticonsDir, imageResult.url.slice("/uploads/emoticons/".length)))
        .catch(() => { /* best-effort */ });
      if (err instanceof InsufficientFunds) {
        reply.code(402);
        return { error: "insufficient funds", required: err.required, balance: err.balance };
      }
      throw err;
    }

    await recordAudit(db, {
      actorUserId: me.id,
      action: "emoticon_sheet_submit",
      metadata: {
        id: submissionId, slug, name: body.name,
        cost, scope: submitterScope, ownerId: submitterPoolId,
      },
    });

    reply.code(201);
    return { ok: true, submissionId, slug, status: "pending", costPaid: cost };
  });

  /* ---------- Community emoticon use (pay-per-use) ----------
   *
   * Each use of a community sheet's emoticon charges the buyer 1
   * Currency and credits the creator's master pool 1 Currency. The
   * buyer's identity (master or character) selects which pool pays.
   * System sheets (createdByUserId IS NULL) are free and don't
   * accept this endpoint, clients should never call it for them.
   *
   * Transaction: balance read + debit + credit + two ledger rows
   * land in a single sqlite write lock so a concurrent submission
   * can't bypass the funds check. Self-purchase (buyer == creator)
   * is explicitly blocked so the loopback doesn't game any future
   * leaderboard metric.
   */
  const useCommunityEmoticonBody = z.object({
    cellIndex: z.number().int().min(0).max(EMOTICON_SHEET_CELL_COUNT - 1),
    /** Which pool the buyer is paying from. Null/omitted = master/OOC. */
    characterId: z.string().nullable().optional(),
  }).strict();

  app.post<{ Params: { sheetId: string }; Body: unknown }>(
    "/emoticons/community/:sheetId/use",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }

      let body: z.infer<typeof useCommunityEmoticonBody>;
      try { body = useCommunityEmoticonBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

      const sheet = (await db.select()
        .from(emoticonSheets)
        .where(eq(emoticonSheets.id, req.params.sheetId))
        .limit(1))[0];
      if (!sheet) { reply.code(404); return { error: "sheet not found" }; }
      if (sheet.status !== "approved") { reply.code(404); return { error: "sheet not available" }; }
      if (!sheet.createdByUserId) {
        // System sheets are free; the client shouldn't call this for them.
        reply.code(400);
        return { error: "system sheets do not require payment" };
      }
      if (sheet.createdByUserId === me.id) {
        // Self-purchase blocked. The picker should disable the buy
        // path on the creator's own community sheets; this is the
        // belt-and-braces server gate.
        reply.code(403);
        return { error: "you cannot buy use of your own sheet" };
      }

      // Validate cell isn't empty so a typoed index can't waste coin.
      const cells = parseSheetCells(sheet.cells);
      const label = cells[body.cellIndex];
      if (!label || isEmoticonCellEmpty(label)) {
        reply.code(400);
        return { error: "cell is empty" };
      }

      // Optional character-pool buyer must belong to the caller.
      const scopeCharacterId = body.characterId ?? null;
      if (scopeCharacterId) {
        const c = (await db.select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters).where(eq(characters.id, scopeCharacterId)).limit(1))[0];
        if (!c || c.deletedAt || c.userId !== me.id) {
          reply.code(403);
          return { error: "not your character" };
        }
      }
      const buyerScope: "user" | "character" = scopeCharacterId ? "character" : "user";
      const buyerPoolId = scopeCharacterId ?? me.id;
      const cost = COMMUNITY_EMOTICON_USE_COST;
      const creatorUserId = sheet.createdByUserId;
      const useId = nanoid();
      const commerceOn = !!sheet.commerceEnabled;

      // Free path: commerce disabled by the owner. Skip the debit /
      // credit / ledger entries entirely, there's no transfer to
      // make. Still bump `use_count` below so the "Top used" sort
      // reflects every use regardless of payment status. Return the
      // same shape callers expect (`charged: 0`).
      if (!commerceOn) {
        try {
          await db.update(emoticonSheets)
            .set({ useCount: sql`${emoticonSheets.useCount} + 1` })
            .where(eq(emoticonSheets.id, sheet.id));
        } catch { /* non-fatal */ }
        return { ok: true, charged: 0, useId };
      }

      try {
        db.transaction((tx) => {
          // Debit buyer pool.
          if (scopeCharacterId) {
            tx.insert(characterEarning).values({ serverId: DEFAULT_SERVER_ID, characterId: scopeCharacterId }).onConflictDoNothing().run();
            const row = tx.select({ currency: characterEarning.currency })
              .from(characterEarning).where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, scopeCharacterId))).limit(1).all()[0];
            const balance = row?.currency ?? 0;
            if (balance < cost) throw new InsufficientFunds(cost, balance);
            tx.update(characterEarning)
              .set({ currency: balance - cost, updatedAt: new Date() })
              .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, scopeCharacterId)))
              .run();
          } else {
            tx.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId: me.id }).onConflictDoNothing().run();
            const row = tx.select({ currency: userEarning.currency })
              .from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id))).limit(1).all()[0];
            const balance = row?.currency ?? 0;
            if (balance < cost) throw new InsufficientFunds(cost, balance);
            tx.update(userEarning)
              .set({ currency: balance - cost, updatedAt: new Date() })
              .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id)))
              .run();
          }
          // Credit creator master pool. Revenue always lands in the
          // creator's user pool regardless of which pool they used to
          // submit; the creator is the user account, not a specific
          // character.
          tx.insert(userEarning).values({ serverId: DEFAULT_SERVER_ID, userId: creatorUserId }).onConflictDoNothing().run();
          const creatorRow = tx.select({ currency: userEarning.currency })
            .from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, creatorUserId))).limit(1).all()[0];
          const creatorBalance = creatorRow?.currency ?? 0;
          tx.update(userEarning)
            .set({ currency: creatorBalance + cost, updatedAt: new Date() })
            .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, creatorUserId)))
            .run();
          // Twin ledger rows so both sides of the transfer are
          // auditable. The reasons share the useId so a future
          // refund / dispute tool can pair them.
          const meta = {
            kind: "community_emoticon_use",
            useId,
            sheetId: sheet.id,
            sheetSlug: sheet.slug,
            cellIndex: body.cellIndex,
            buyerUserId: me.id,
            creatorUserId,
          };
          tx.insert(earningLedger).values({
            id: nanoid(),
            serverId: DEFAULT_SERVER_ID,
            scope: buyerScope,
            ownerId: buyerPoolId,
            xpDelta: 0,
            currencyDelta: -cost,
            reason: `community_emoticon_use_${useId}`,
            metadataJson: JSON.stringify(meta),
            createdAt: new Date(),
          }).run();
          tx.insert(earningLedger).values({
            id: nanoid(),
            serverId: DEFAULT_SERVER_ID,
            scope: "user",
            ownerId: creatorUserId,
            xpDelta: 0,
            currencyDelta: cost,
            reason: `community_emoticon_revenue_${useId}`,
            metadataJson: JSON.stringify(meta),
            createdAt: new Date(),
          }).run();
          // Bump the sheet's lifetime usage tally. Same transaction so
          // counter + ledger move together, a partial commit can't
          // leave a credited revenue row without its matching tally
          // bump or vice versa.
          tx.update(emoticonSheets)
            .set({ useCount: sql`${emoticonSheets.useCount} + 1` })
            .where(eq(emoticonSheets.id, sheet.id))
            .run();
        });
      } catch (err) {
        if (err instanceof InsufficientFunds) {
          reply.code(402);
          return { error: "insufficient funds", required: err.required, balance: err.balance };
        }
        throw err;
      }

      // Best-effort post-commit notify: emit `earning:earned` to both
      // sides so any open Earning dashboard / wallet pip updates in
      // real time without a manual refresh. We re-read the new
      // currency totals from the just-committed transaction so the
      // wire payload carries the correct value. Failure here is
      // non-fatal, the charge has landed and the next normal earning
      // fetch will reconcile.
      try {
        const buyerNow = scopeCharacterId
          ? (await db.select({ xp: characterEarning.xp, currency: characterEarning.currency })
              .from(characterEarning).where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, scopeCharacterId))).limit(1))[0]
          : (await db.select({ xp: userEarning.xp, currency: userEarning.currency })
              .from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, me.id))).limit(1))[0];
        const creatorNow = (await db.select({ xp: userEarning.xp, currency: userEarning.currency })
          .from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, creatorUserId))).limit(1))[0];
        const sockets = await io.fetchSockets();
        for (const s of sockets) {
          const uid = (s.data as { userId?: string }).userId;
          if (uid === me.id && buyerNow) {
            s.emit("earning:earned", {
              scope: buyerScope,
              ownerId: buyerPoolId,
              xpDelta: 0,
              currencyDelta: -cost,
              xpTotal: buyerNow.xp,
              currencyTotal: buyerNow.currency,
              rankKey: null,
              tier: null,
              reason: `community_emoticon_use_${useId}`,
            });
          } else if (uid === creatorUserId && creatorNow) {
            s.emit("earning:earned", {
              scope: "user",
              ownerId: creatorUserId,
              xpDelta: 0,
              currencyDelta: cost,
              xpTotal: creatorNow.xp,
              currencyTotal: creatorNow.currency,
              rankKey: null,
              tier: null,
              reason: `community_emoticon_revenue_${useId}`,
            });
          }
        }
      } catch { /* socket emit best-effort */ }

      return { ok: true, charged: cost, useId };
    },
  );

  /* ---------- Sheet owner: toggle commerce on/off ----------
   *
   * Only the sheet's `createdByUserId` (or an admin) can flip this.
   * Flipping doesn't refund any prior uses, it just decides what
   * happens to FUTURE use calls.
   */
  const toggleCommerceBody = z.object({
    commerceEnabled: z.boolean(),
  }).strict();

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/me/emoticon-submissions/:id/commerce",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      let body: z.infer<typeof toggleCommerceBody>;
      try { body = toggleCommerceBody.parse(req.body); }
      catch (err) { reply.code(400); return { error: err instanceof Error ? err.message : "invalid body" }; }

      const sheet = (await db.select()
        .from(emoticonSheets)
        .where(eq(emoticonSheets.id, req.params.id))
        .limit(1))[0];
      if (!sheet) { reply.code(404); return { error: "sheet not found" }; }
      if (!sheet.createdByUserId) {
        reply.code(400);
        return { error: "system sheets do not support commerce" };
      }
      const isOwner = sheet.createdByUserId === me.id;
      const canAdmin = await hasPermission(me, "manage_emoticon_catalog", db);
      if (!isOwner && !canAdmin) {
        reply.code(403);
        return { error: "not your sheet" };
      }
      await db.update(emoticonSheets)
        .set({ commerceEnabled: body.commerceEnabled, updatedAt: new Date() })
        .where(eq(emoticonSheets.id, sheet.id));
      return { ok: true, commerceEnabled: body.commerceEnabled };
    },
  );

  /* ---------- User: list my submissions (any status) ---------- */
  app.get("/me/emoticon-submissions", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    // Caller's submissions = master-paid (pool = me.id) ∪
    // character-paid (pool ∈ caller's characters). Same pool-id
    // construction as the cap check above.
    const myCharIds = (await db
      .select({ id: characters.id })
      .from(characters)
      .where(and(eq(characters.userId, me.id), sql`${characters.deletedAt} IS NULL`))).map((r) => r.id);
    const poolIds = [me.id, ...myCharIds];
    const rows = await db
      .select()
      .from(emoticonSheets)
      .where(and(
        // Only rows that went through the submission flow have a
        // non-null submitterPoolId; admin-created rows are excluded
        // even when the admin happens to be the caller.
        sql`${emoticonSheets.submitterPoolId} IS NOT NULL`,
        inArray(emoticonSheets.submitterPoolId, poolIds),
      ))
      .orderBy(desc(emoticonSheets.createdAt));
    return {
      submissions: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        imageUrl: r.imageUrl,
        cells: parseSheetCells(r.cells),
        status: r.status,
        submitterScope: r.submitterScope,
        submitterPoolId: r.submitterPoolId,
        costPaid: r.costPaid,
        rejectionReason: r.rejectionReason,
        reviewedAt: r.reviewedAt ? +r.reviewedAt : null,
        createdAt: +r.createdAt,
        commerceEnabled: !!r.commerceEnabled,
        useCount: r.useCount ?? 0,
      })),
    };
  });

  /* ---------- Admin: list pending + recent submissions ----------
   *
   * Returns up to 50 most-recent submissions of any status. The
   * Flair admin UI uses this for the moderation queue card.
   */
  app.get("/admin/emoticons/submissions", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(403); return { error: "forbidden", missing: "review_emoticon_submissions" }; }
    const scope = await resolveCatalogScope(req);
    const auth = await authorizeCatalogAdmin(me, "review_emoticon_submissions", scope);
    if (!auth.ok) { reply.code(403); return { error: "forbidden", missing: "review_emoticon_submissions" }; }
    // FLAG-OFF: scope null → the original submitter-pool-only WHERE (all
    // submissions), byte identical. Servers ON + real acting server → the
    // queue shows only THAT server's submissions.
    const where = auth.scope
      ? and(sql`${emoticonSheets.submitterPoolId} IS NOT NULL`, eq(emoticonSheets.serverId, auth.scope))
      : sql`${emoticonSheets.submitterPoolId} IS NOT NULL`;
    const rows = await db
      .select()
      .from(emoticonSheets)
      .where(where)
      .orderBy(desc(emoticonSheets.createdAt))
      .limit(50);
    // Resolve submitter display names so admin doesn't have to
    // squint at uuids. Pull user + character rows in two batched
    // queries, then map by pool id.
    const userPoolIds = rows.filter((r) => r.submitterScope === "user").map((r) => r.submitterPoolId!).filter(Boolean);
    const charPoolIds = rows.filter((r) => r.submitterScope === "character").map((r) => r.submitterPoolId!).filter(Boolean);
    const userRows = userPoolIds.length
      ? await db.select({ id: users.id, username: users.username })
          .from(users)
          .where(inArray(users.id, userPoolIds))
      : [];
    const charRows = charPoolIds.length
      ? await db.select({ id: characters.id, name: characters.name, userId: characters.userId })
          .from(characters)
          .where(inArray(characters.id, charPoolIds))
      : [];
    const usernameById = new Map(userRows.map((r) => [r.id, r.username]));
    const charById = new Map(charRows.map((r) => [r.id, r]));
    return {
      submissions: rows.map((r) => {
        let submitterLabel = "(unknown)";
        if (r.submitterScope === "user" && r.submitterPoolId) {
          submitterLabel = usernameById.get(r.submitterPoolId) ?? "(deleted user)";
        } else if (r.submitterScope === "character" && r.submitterPoolId) {
          const c = charById.get(r.submitterPoolId);
          if (c) {
            submitterLabel = `${c.name} (${usernameById.get(c.userId) ?? "?"})`;
          } else {
            submitterLabel = "(deleted character)";
          }
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
          submitterUserId: r.createdByUserId,
          costPaid: r.costPaid,
          rejectionReason: r.rejectionReason,
          reviewedAt: r.reviewedAt ? +r.reviewedAt : null,
          createdAt: +r.createdAt,
        };
      }),
    };
  });

  /* ---------- Admin: approve a pending submission ----------
   *
   * Flips status='approved', tail-orders the sortOrder so the new
   * sheet surfaces last in the picker (admin can reorder later via
   * the existing sheet PATCH), records audit, broadcasts the
   * `emoticons:updated` pulse so every connected client re-fetches.
   * No Currency movement, the submission cost was debited at
   * submission time and stays spent.
   */
  app.post<{ Params: { id: string } }>(
    "/admin/emoticons/submissions/:id/approve",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(403); return { error: "forbidden", missing: "review_emoticon_submissions" }; }
      const scope = await resolveCatalogScope(req);
      const auth = await authorizeCatalogAdmin(me, "review_emoticon_submissions", scope);
      if (!auth.ok) { reply.code(403); return { error: "forbidden", missing: "review_emoticon_submissions" }; }
      const row = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, req.params.id)).limit(1))[0];
      if (!row) { reply.code(404); return { error: "not found" }; }
      if (!(await callerOwnsSheetScope(me, "review_emoticon_submissions", auth.scope, row.serverId))) {
        reply.code(404); return { error: "not found" };
      }
      if (row.status !== "pending") {
        reply.code(409);
        return { error: `submission already ${row.status}` };
      }
      const tail = (await db
        .select({ max: sql<number>`coalesce(max(${emoticonSheets.sortOrder}), -1)` })
        .from(emoticonSheets))[0];
      const newSortOrder = (tail?.max ?? -1) + 1;
      await db.update(emoticonSheets)
        .set({
          status: "approved",
          sortOrder: newSortOrder,
          reviewedAt: Date.now(),
          reviewedByUserId: me.id,
          updatedAt: new Date(),
        })
        .where(eq(emoticonSheets.id, row.id));
      await recordAudit(db, {
        actorUserId: me.id,
        action: "emoticon_sheet_approve",
        targetUserId: row.createdByUserId ?? null,
        metadata: { id: row.id, slug: row.slug, costPaid: row.costPaid },
      });
      io.emit("emoticons:updated");
      return { ok: true };
    },
  );

  /* ---------- Admin: reject a pending submission ----------
   *
   * Flips status='rejected', refunds the snapshotted cost to the
   * paying identity, deletes the image file, records audit. The
   * row is retained for the moderation audit trail (with the
   * imageUrl pointing at a now-deleted file, clients filter by
   * status='approved' so this never reaches them).
   */
  const rejectSubmissionBody = z.object({
    reason: z.string().max(500).optional(),
  }).strict();

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/admin/emoticons/submissions/:id/reject",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(403); return { error: "forbidden", missing: "review_emoticon_submissions" }; }
      // Scope from the query only — the reject body is `.strict()`, so the
      // acting server rides on `?serverId=` rather than the JSON body.
      const scope = await resolveCatalogScope({ query: req.query });
      const auth = await authorizeCatalogAdmin(me, "review_emoticon_submissions", scope);
      if (!auth.ok) { reply.code(403); return { error: "forbidden", missing: "review_emoticon_submissions" }; }
      let body: z.infer<typeof rejectSubmissionBody>;
      try { body = rejectSubmissionBody.parse(req.body ?? {}); }
      catch { reply.code(400); return { error: "invalid body" }; }
      const row = (await db.select().from(emoticonSheets).where(eq(emoticonSheets.id, req.params.id)).limit(1))[0];
      if (!row) { reply.code(404); return { error: "not found" }; }
      if (!(await callerOwnsSheetScope(me, "review_emoticon_submissions", auth.scope, row.serverId))) {
        reply.code(404); return { error: "not found" };
      }
      if (row.status !== "pending") {
        reply.code(409);
        return { error: `submission already ${row.status}` };
      }
      const refundAmount = row.costPaid ?? 0;
      const refundScope = row.submitterScope as "user" | "character" | null;
      const refundPoolId = row.submitterPoolId;
      // Refund + status flip in one transaction so a crash between
      // the two can't leave the user out their Currency on a
      // rejected submission.
      db.transaction((tx) => {
        if (refundAmount > 0 && refundScope && refundPoolId) {
          if (refundScope === "character") {
            const cur = tx.select({ currency: characterEarning.currency })
              .from(characterEarning).where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, refundPoolId))).limit(1).all()[0];
            const balance = cur?.currency ?? 0;
            tx.update(characterEarning)
              .set({ currency: balance + refundAmount, updatedAt: new Date() })
              .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, refundPoolId)))
              .run();
          } else {
            const cur = tx.select({ currency: userEarning.currency })
              .from(userEarning).where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, refundPoolId))).limit(1).all()[0];
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
            }),
            createdAt: new Date(),
          }).run();
        }
        tx.update(emoticonSheets)
          .set({
            status: "rejected",
            reviewedAt: Date.now(),
            reviewedByUserId: me.id,
            rejectionReason: body.reason ?? null,
            updatedAt: new Date(),
          })
          .where(eq(emoticonSheets.id, row.id))
          .run();
      });
      // Delete the asset file outside the txn. Best-effort, a stale
      // file on disk after a successful reject is a janitor problem,
      // not a correctness issue (the row is rejected, picker won't
      // see it, the URL is dead from the client's perspective).
      if (row.imageUrl.startsWith("/uploads/emoticons/")) {
        const filename = row.imageUrl.slice("/uploads/emoticons/".length);
        unlink(join(emoticonsDir, filename)).catch(() => { /* best-effort */ });
      }
      await recordAudit(db, {
        actorUserId: me.id,
        action: "emoticon_sheet_reject",
        targetUserId: row.createdByUserId ?? null,
        reason: body.reason ?? null,
        metadata: { id: row.id, slug: row.slug, refundAmount, refundScope, refundPoolId },
      });
      return { ok: true, refundedAmount: refundAmount };
    },
  );
}

/** Local sentinel for the insufficient-funds branch inside the
 *  submission transaction. Thrown to roll back the txn and let the
 *  outer handler emit the right 402 response without leaking a
 *  generic 500. */
class InsufficientFunds extends Error {
  required: number;
  balance: number;
  constructor(required: number, balance: number) {
    super("insufficient funds");
    this.required = required;
    this.balance = balance;
  }
}
