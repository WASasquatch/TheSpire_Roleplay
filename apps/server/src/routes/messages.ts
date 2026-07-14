import type { FastifyInstance } from "fastify";
import type {
  Role,
  ForumPermission,
  AuditAction,
  ChatMessage,
  ClientToServerEvents,
  ServerToClientEvents,
  PinnedMessage,
  MessageKind,
  ServerPermission,
} from "@thekeep/shared";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import { RICH_HTML_MAX_BYTES, containerFields, mentionsField, parseNpcStats, richHtmlToText } from "@thekeep/shared";
import { recordAudit } from "../audit.js";
import { messages, rooms, roomThreadCategories, roomMembers, pinnedMessages, users } from "../db/schema.js";
import { callerCanEditRoom } from "../auth/roomPermissions.js";
import { effectiveRoomNsfw } from "../lib/nsfwRooms.js";
import { emitToPairStaff } from "../lib/pairStaffView.js";
import { boardAgeDenied } from "../forums/nsfw.js";
import { linkPreviewFromRow } from "../unfurl.js";
import { maskForMinors, maskMessageForMinors } from "../realtime/minorLanguageFilter.js";
import { messageForSocket } from "../realtime/broadcast.js";
import { sanitizeBio } from "../auth/html.js";
import { sanitizeRichMessageHtml } from "../lib/richHtml.js";
import { areServersEnabled, getServerSettings, getSettings } from "../settings.js";
import { resolveRoomServerId } from "../earning/pool.js";
import { hasPermission } from "../auth/permissions.js";
import type { Db } from "../db/index.js";
import { tFor } from "../i18n.js";
import { getSessionUser } from "./auth.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

// Edit / delete grace window for chat (flat) rooms is now admin-
// configurable via `siteSettings.editGraceMs`. Each handler below
// reads the current value via `getSettings(db)` so a runtime tweak
// takes effect on the next attempt without restart. Forum rooms
// (replyMode="nested") bypass the cap entirely, posts there are
// long-lived and authors are expected to refine them indefinitely,
// with the (edited) badge providing transparency.

/**
 * Look up whether the message's room is a forum (nested-mode). Forum posts
 * skip the edit/delete grace window. Cached single-row lookup; cheap.
 */
async function isForumMessage(db: Db, roomId: string): Promise<boolean> {
  const row = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  return row?.replyMode === "nested";
}

/**
 * Powers-matrix tier for a FORUM board (rooms.forumId set), consulted by
 * the moderation gates below IN ADDITION to the sitewide permission keys:
 *
 *   owner (forum owner / manage_any_forum staff): sticky, lock, edit, and
 *     delete anything on their boards.
 *   mod (owner-assigned Forum Moderator): the same topic-level powers
 *     EXCEPT content authored by the forum owner — per the matrix a mod
 *     can never edit or delete the owner's posts (lock/sticky are state,
 *     not content, and stay allowed).
 *
 * Returns null for non-board rooms so flat chat and standalone nested
 * rooms keep today's gates untouched.
 */
async function boardModTier(
  db: Db,
  user: { id: string; role: Role },
  roomId: string,
): Promise<{
  /** True for the forum owner / manage_any_forum staff. */
  isOwner: boolean;
  /** Effective forum permissions this user holds (owner = all). */
  permissions: ForumPermission[];
  forumOwnerUserId: string;
} | null> {
  const room = (await db.select({ forumId: rooms.forumId }).from(rooms)
    .where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room?.forumId) return null;
  const { forumAuthority } = await import("../forums/authority.js");
  const a = await forumAuthority(db, user, room.forumId);
  if (!a.forum) return null;
  return {
    isOwner: a.isOwner,
    permissions: a.permissions,
    forumOwnerUserId: a.forum.ownerUserId,
  };
}

/** Owner-implies-all check for a board tier (mirrors forums/authority.forumCan
 *  without importing it, to keep messages.ts off the authority module's
 *  static import graph — boardModTier already imports it dynamically). */
function boardCan(
  board: { isOwner: boolean; permissions: ForumPermission[] } | null,
  key: ForumPermission,
): boolean {
  return !!board && (board.isOwner || board.permissions.includes(key));
}

/**
 * Per-SERVER moderation tier for a message's room (multi-server lift, Phase 5).
 * The analog of {@link boardModTier} for the server layer: resolves the room's
 * owning server and the caller's `serverAuthority` over it, so the message
 * delete/edit gates can consult the server's granular moderation grants
 * (`delete_others_message` / `edit_others_message`) in ADDITION to the
 * sitewide permission keys.
 *
 * Returns null (→ today's global-only gates apply unchanged) when:
 *   - the feature is OFF (`!serversEnabled`), so flag-off is byte-identical;
 *   - the room has no server, or its server is the SYSTEM/default server
 *     (default-server moderation stays on the global panel per plan §9.8).
 *
 * Owner-content invariant (mirrors forums): a server mod may never act on the
 * server OWNER's own messages, even with the matching grant. We surface
 * `serverOwnerUserId` so the call site can enforce that.
 */
async function serverModTier(
  db: Db,
  user: { id: string; role: Role },
  roomId: string,
): Promise<{
  isOwner: boolean;
  permissions: ServerPermission[];
  serverOwnerUserId: string;
} | null> {
  if (!areServersEnabled(await getSettings(db))) return null;
  const room = (await db.select({ serverId: rooms.serverId }).from(rooms)
    .where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room?.serverId) return null;
  const { serverAuthority } = await import("../servers/authority.js");
  const a = await serverAuthority(db, user, room.serverId);
  // System/default server keeps today's GLOBAL moderation gates; only real
  // sub-servers route through the per-server grant set.
  if (!a.server || a.server.isSystem) return null;
  return {
    isOwner: a.isOwner,
    permissions: a.permissions,
    serverOwnerUserId: a.server.ownerUserId,
  };
}

/** Owner-implies-all check for a server moderation tier (mirrors
 *  servers/authority.serverCan; kept local so messages.ts stays off that
 *  module's static import graph — serverModTier imports it dynamically). */
function serverTierCan(
  tier: { isOwner: boolean; permissions: ServerPermission[] } | null,
  key: ServerPermission,
): boolean {
  return !!tier && (tier.isOwner || tier.permissions.includes(key));
}

/**
 * Record a forum-board moderation action into the audit log, stamping the
 * board's `forumId` into metadata so the forum's Mod Log can filter to it.
 * No-op for non-forum-board rooms (forumId null), so the chat moderation
 * paths that share these handlers don't pollute any forum's log.
 */
async function auditForumTopic(
  db: Db,
  actorUserId: string,
  roomId: string,
  messageId: string,
  action: AuditAction,
  metadata: Record<string, unknown>,
  targetUserId?: string | null,
): Promise<void> {
  const room = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room?.forumId) return;
  await recordAudit(db, {
    actorUserId,
    action,
    targetRoomId: roomId,
    targetMessageId: messageId,
    ...(targetUserId ? { targetUserId } : {}),
    metadata: { ...metadata, forumId: room.forumId },
  });
}

const editBody = z.object({ body: z.string().min(1).max(20_000) }).strict();

/**
 * Hard cap on pinned messages per room. Pins are room furniture, not a
 * second inbox — keeping the strip short keeps it scannable and bounds the
 * `room:pins` delta payload. Adding beyond the cap is rejected (409) rather
 * than silently rotating the oldest out, so a mod is never surprised by a pin
 * vanishing to make room.
 */
const MAX_PINS_PER_ROOM = 10;

/** One `pinned_messages` row → the shared `PinnedMessage` wire shape. */
function pinRowToWire(p: typeof pinnedMessages.$inferSelect): PinnedMessage {
  return {
    id: p.id,
    roomId: p.roomId,
    messageId: p.messageId,
    serverId: p.serverId,
    pinnedByUserId: p.pinnedByUserId,
    pinnedByDisplayName: p.pinnedByDisplayName,
    pinnedAt: +p.pinnedAt,
    sortOrder: p.sortOrder,
    authorUserId: p.authorUserId,
    authorCharacterId: p.authorCharacterId,
    displayName: p.displayName,
    kind: (p.kind as MessageKind | null) ?? null,
    body: p.body,
    color: p.color,
    cmdCss: p.cmdCss,
    sceneImageUrl: p.sceneImageUrl,
    bodyHtml: p.bodyHtml,
    origCreatedAt: p.origCreatedAt,
    isNsfw: p.isNsfw,
  };
}

/**
 * Read a room's full pin set (ascending by sortOrder, then pinnedAt) and map
 * it to the wire shape. Used by the GET route and by the emit helper so the
 * ordering the client renders is identical wherever the set is served.
 */
async function loadRoomPins(db: Db, roomId: string): Promise<PinnedMessage[]> {
  const rows = await db
    .select()
    .from(pinnedMessages)
    .where(eq(pinnedMessages.roomId, roomId))
    .orderBy(asc(pinnedMessages.sortOrder), asc(pinnedMessages.pinnedAt));
  return rows.map(pinRowToWire);
}

/**
 * Minor language filter (Phase 7, plan_ext.md §J) over a pin set: pins
 * snapshot chat BODIES, so the same line that reads masked in a minor's
 * backlog must read masked in the strip pinned above it. Returns null when
 * no pin masked — callers then serve the ORIGINAL array untouched, keeping
 * the adult/clean path byte-identical (the same null-means-clean contract
 * as maskForMinors). A non-null return holds shallow clones for the dirty
 * pins only; `bodyHtml` stays untouched, mirroring maskMessageForMinors's
 * documented exclusion (masking inside HTML could split tags).
 */
function maskPinsForMinors(pins: PinnedMessage[]): PinnedMessage[] | null {
  let maskedAny = false;
  const out = pins.map((p) => {
    const masked = p.body ? maskForMinors(p.body) : null;
    if (masked === null) return p;
    maskedAny = true;
    return { ...p, body: masked };
  });
  return maskedAny ? out : null;
}

/**
 * Broadcast the room's authoritative pin set to everyone in it. A single
 * delta-free replace: the client swaps its cached pins for `roomId` wholesale
 * (empty `pins: []` clears the strip). Kept as one payload per the contract —
 * not a per-pin stream.
 *
 * Flipped-back rooms (age plan, Phase 2): pins snapshot message BODIES, so a
 * pin of an 18+-stamped message must not broadcast to minor occupants — the
 * same per-viewer split the GET route applies. A LIVE pin consults its
 * source row's `messages.isNsfw` (authoritative; also catches a forum
 * topic's later NSFW re-tag); a SNAPSHOT-ONLY pin (source hard-deleted or
 * retention-expired, messageId NULL) consults its own `is_nsfw` stamp
 * frozen at pin time (migration 0340).
 *
 * Minor language filter (Phase 7, plan_ext.md §J): the set a minor receives
 * is additionally body-masked, computed ONCE over the filtered set and
 * shared by every non-adult socket. When anything filters or masks, the
 * emit goes per-socket (adult-ness rides the handshake snapshot on
 * `socket.data.user`, mirroring emitFiltered; a snapshot-less socket fails
 * closed); the common all-SFW-and-clean set keeps the cheap room-wide emit.
 */
async function emitRoomPins(io: Io, db: Db, roomId: string): Promise<void> {
  const pins = await loadRoomPins(db, roomId);
  const liveIds = pins.map((p) => p.messageId).filter((v): v is string => !!v);
  const stamped = liveIds.length === 0
    ? new Set<string>()
    : new Set(
        (await db
          .select({ id: messages.id })
          .from(messages)
          .where(and(inArray(messages.id, liveIds), eq(messages.isNsfw, true))))
          .map((r) => r.id),
      );
  const filtered = pins.filter((p) => (p.messageId ? !stamped.has(p.messageId) : !p.isNsfw));
  // One socket enumeration serves both the NSFW split and the minor-mask
  // presence check (in-memory on the default adapter — same call
  // emitFiltered makes on every message).
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  const anyMinor = sockets.some(
    (s) => !(s.data as { user?: { isAdult?: boolean } }).user?.isAdult,
  );
  // §J: at most one mask pass per broadcast, shared by every minor socket.
  const minorPins = anyMinor ? maskPinsForMinors(filtered) : null;
  if (filtered.length === pins.length && !minorPins) {
    io.to(`room:${roomId}`).emit("room:pins", { roomId, pins });
    return;
  }
  for (const s of sockets) {
    const adult = !!(s.data as { user?: { isAdult?: boolean } }).user?.isAdult;
    s.emit("room:pins", { roomId, pins: adult ? pins : minorPins ?? filtered });
  }
}

/**
 * Tiered pin gate, mirrors the sticky/delete routes. Accepts either:
 *   - `hasPermission(user, "pin_message")` — the sitewide grant (mods + admins
 *     by default, plus any matrix / per-user override), OR
 *   - `callerCanEditRoom` — the room owner or a room mod (or the site-wide
 *     `edit_any_room_metadata` grant).
 *
 * A server owner/mod's authority over a sub-server room lands in
 * `room_members.role`, so `callerCanEditRoom` already folds the per-server
 * tier in — no separate serverModTier branch is needed for pins.
 */
async function canCallerPin(
  db: Db,
  user: { id: string; role: Role },
  roomId: string,
): Promise<boolean> {
  if (await hasPermission(user, "pin_message", db)) return true;
  return callerCanEditRoom(db, user, roomId);
}

/**
 * Visibility gate for pinning / reading pins: the caller must be able to SEE
 * the room's messages. Mirrors {@link registerBookmarkRoutes}'
 * `canCallerSeeMessage`: whispers are never pinnable (private threads), and
 * private-room messages require room membership. Returns the message row on
 * success, null on any failure (merged 404/403 so private-room existence never
 * leaks).
 */
async function canCallerPinMessage(db: Db, viewer: { id: string; isAdult: boolean }, messageId: string) {
  const m = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0];
  if (!m) return null;
  // Whispers are private conversations, not room furniture — never pinnable.
  if (m.kind === "whisper") return null;
  // Age plan, Phase 2: a minor (e.g. a room mod in a flipped-back room)
  // can't pin an 18+-stamped row — the pin snapshots the body room-wide.
  if (m.isNsfw && !viewer.isAdult) return null;
  const room = (await db.select().from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
  if (!room) return null;
  // Board-aware (Phase 3): a board of an 18+ FORUM denies like an 18+ room.
  if (await boardAgeDenied(db, viewer, room)) return null;
  if (room.type === "private") {
    const member = (await db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, viewer.id)))
      .limit(1))[0];
    if (!member) return null;
  }
  return m;
}

/** Can the caller merely SEE a room's pins (read gate for GET /rooms/:id/pins)?
 *  Public rooms: any authenticated user. Private rooms: members only.
 *  Effectively-18+ rooms (age plan, Phase 2): adults only — pins carry
 *  message bodies, so they're a read path like backlog/search. */
async function canCallerSeeRoomPins(db: Db, viewer: { id: string; isAdult: boolean }, roomId: string): Promise<boolean> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return false;
  if (await boardAgeDenied(db, viewer, room)) return false;
  if (room.type !== "private") return true;
  const member = (await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, viewer.id)))
    .limit(1))[0];
  return !!member;
}

export function toWire(m: typeof messages.$inferSelect, viewerIsAdmin = false): ChatMessage {
  // Mirrors the row→ChatMessage shape used in broadcast.ts; if either side
  // adds fields, both should be updated. Snapshotted fields stay as-is on
  // edit (mood, npcVoicedBy, replyTo*, etc.), only `body` and `editedAt`
  // change.
  //
  // Deleted messages: the visible body is stripped to "" for everyone
  // (renderer paints "[message removed]"). Viewers with the
  // `view_deleted_message_body` permission additionally receive the
  // original body on a separate `originalBody` field so they can
  // audit what got hidden. Viewers without the permission don't get
  // the field, gate is `viewerIsAdmin`, which the caller computes
  // from `hasPermission(viewer, "view_deleted_message_body")`. (The
  // parameter name is kept for back-compat; semantics moved to the
  // catalog key, but every existing call site passes the same boolean.)
  return {
    id: m.id,
    roomId: m.roomId,
    userId: m.userId,
    characterId: m.characterId,
    displayName: m.displayName,
    kind: m.kind,
    body: m.deletedAt ? "" : m.body,
    // Rich-format marker + plaintext mirror (migration 0352). Deleted
    // rows strip the mirror alongside the body.
    ...(m.format === "html"
      ? { format: "html" as const, bodyText: m.deletedAt ? "" : m.bodyText }
      : {}),
    color: m.color,
    createdAt: +m.createdAt,
    ...(m.toUserId ? { toUserId: m.toUserId } : {}),
    ...(m.toCharacterId ? { toCharacterId: m.toCharacterId } : {}),
    ...(m.toDisplayName ? { toDisplayName: m.toDisplayName } : {}),
    ...(m.replyToId ? { replyToId: m.replyToId } : {}),
    ...(m.replyToDisplayName ? { replyToDisplayName: m.replyToDisplayName } : {}),
    ...(m.replyToBodySnippet ? { replyToBodySnippet: m.replyToBodySnippet } : {}),
    ...(m.moodSnapshot ? { moodSnapshot: m.moodSnapshot } : {}),
    ...(m.npcVoicedBy ? { npcVoicedBy: m.npcVoicedBy } : {}),
    ...(m.npcStatsJson ? { npcStats: parseNpcStats(m.npcStatsJson) } : {}),
    ...(m.threadCategoryId ? { threadCategoryId: m.threadCategoryId } : {}),
    ...(m.title ? { title: m.title } : {}),
    ...(m.prefixId ? { prefixId: m.prefixId } : {}),
    ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    ...(m.editedAt ? { editedAt: +m.editedAt } : {}),
    ...(m.deletedAt ? { deletedAt: +m.deletedAt } : {}),
    ...(m.lockedAt ? { lockedAt: +m.lockedAt } : {}),
    ...(m.lastActivityAt ? { lastActivityAt: +m.lastActivityAt } : {}),
    ...(m.isSticky ? { isSticky: true } : {}),
    ...(m.cmdCss ? { cmdCss: m.cmdCss } : {}),
    ...(() => { const lp = linkPreviewFromRow(m.linkPreviewJson); return lp ? { linkPreview: lp } : {}; })(),
    ...(m.sceneImageUrl ? { sceneImageUrl: m.sceneImageUrl } : {}),
    ...containerFields(m),
    ...(m.bodyHtml ? { bodyHtml: m.bodyHtml } : {}),
    ...mentionsField(m.mentionsJson),
    ...(m.rankKey ? { rankKey: m.rankKey } : {}),
    ...(m.tier != null ? { tier: m.tier } : {}),
    // NSFW topic tag / write-time stamp (age plan, Phase 3). Not in the
    // frozen shared ChatMessage type yet, so it rides as a spread; readers
    // who can't see the row never receive it (the list/thread routes filter
    // first), and the client renders it as the built-in "NSFW" chip.
    ...(m.isNsfw ? { isNsfw: true } : {}),
    ...(m.senderInlineAvatarEnabled ? { senderInlineAvatarEnabled: true } : {}),
    ...(m.senderSelectedBorderRankKey ? { senderSelectedBorderRankKey: m.senderSelectedBorderRankKey } : {}),
    ...(viewerIsAdmin && m.deletedAt ? { originalBody: m.format === "html" ? (m.bodyText ?? m.body) : m.body } : {}),
    // Admin-only audit snapshot of who performed the delete. Mirrors
    // the originalBody carve-out, site admins see who took the
    // moderation action; mods and ordinary viewers don't. Falls back
    // to undefined when the snapshot isn't present (pre-0084 deletes).
    ...(viewerIsAdmin && m.deletedAt && m.deletedByUserId
      ? { deletedByUserId: m.deletedByUserId }
      : {}),
    ...(viewerIsAdmin && m.deletedAt && m.deletedByDisplayName
      ? { deletedByDisplayName: m.deletedByDisplayName }
      : {}),
  };
}

/**
 * Broadcast a `message:update` for `row` to its room. An 18+-stamped row
 * (age plan, Phase 2) must not hand its body to minor occupants — the same
 * toggle-race class `message:new` gates via emitFiltered: a stamped row
 * edited (or unfurled) after its room flips back SFW would otherwise
 * broadcast to minors now legitimately present. Stamped rows emit
 * per-socket, skipping sockets whose session snapshot isn't adult
 * (snapshot-less sockets fail closed). Shared by the edit route, the
 * link-preview removal route, the lock/sticky/category/prefix/nsfw-tag
 * routes, and unfurlAndAttach so the rule can't drift apart.
 *
 * Minor language filter (Phase 7, plan_ext.md §J): the refreshed row rides
 * the SAME masking split as emitFiltered — without it, the unfurl that
 * follows any profane message with a URL (or an edit that introduces
 * profanity) would hand minors the ORIGINAL body over the top of the
 * masked `message:new` they were served seconds earlier. The masked
 * variant is computed at most ONCE per update and shared by every
 * non-adult socket; adults always receive the shared original,
 * byte-identical. The cheap room-wide emit is kept when the row is
 * unstamped and no connected minor needs a mask.
 */
export async function emitMessageUpdate(io: Io, db: Db, row: typeof messages.$inferSelect): Promise<void> {
  const wire = toWire(row);
  const sockets = await io.in(`room:${row.roomId}`).fetchSockets();
  const anyMinor = sockets.some(
    (s) => !(s.data as { user?: { isAdult?: boolean } }).user?.isAdult,
  );
  // Staff pair oversight (lib/pairStaffView.ts): edits/tombstones of public
  // room lines mirror to the ADULT staff standing in the pair's other side,
  // so their merged view never shows a stale body. Whispers/targeted rows
  // never mirror; staff recipients are adults, so they get the plain wire —
  // through the same per-socket rich-HTML capability downgrade as the room
  // fan-out below, so a pre-rich bundle never receives raw markup.
  const mirror = row.kind !== "whisper" && !row.targetUserId
    ? emitToPairStaff(io, db, row.roomId, (s) =>
        s.emit("message:update", messageForSocket(wire, s.data as { richHtml?: boolean })))
    : Promise.resolve();
  // §J: at most one mask compute per update; null = clean (or filter off).
  // An 18+-stamped row skips the compute — minors never receive it at all.
  const minorVariant = anyMinor && !row.isNsfw ? maskMessageForMinors(wire) : null;
  // Rich rows (migration 0352) take the per-socket path while any
  // recipient runs a pre-rich bundle, mirroring emitFiltered's
  // deploy-window downgrade so an edit can't hand old bundles tag soup.
  const anyLegacySocket = row.format === "html"
    && sockets.some((s) => !(s.data as { richHtml?: boolean }).richHtml);
  if (!row.isNsfw && !minorVariant && !anyLegacySocket) {
    io.to(`room:${row.roomId}`).emit("message:update", wire);
    await mirror;
    return;
  }
  for (const s of sockets) {
    const adult = !!(s.data as { user?: { isAdult?: boolean } }).user?.isAdult;
    if (row.isNsfw && !adult) continue;
    const base = adult ? wire : minorVariant ?? wire;
    s.emit("message:update", messageForSocket(base, s.data as { richHtml?: boolean }));
  }
  await mirror;
}

export async function registerMessageRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
): Promise<void> {
  /**
   * Edit a message.
   *
   * Auth: author within the grace window (flat rooms) / anytime (forum
   * rooms), OR any admin / masteradmin (no grace window, no room-shape
   * restriction). Mods are intentionally left out: they can hide a post
   * via DELETE but rewriting another user's words is reserved for the
   * admin tier. Authors who miss the edit window can request an admin
   * touch-up.
   *
   * Replies: when a parent is edited the snapshot in the child's
   * `replyToBodySnippet` is *not* rewritten, child snapshots remain frozen
   * at the moment they were created, which keeps the audit trail honest
   * and matches the "snapshot at send time" pattern used for displayName
   * and to_display_name.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body;
    try { body = editBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }

    const isAuthor = m.userId === me.id;
    // `edit_others_message` covers both the gate for editing someone
    // else's message AND the grace-window bypass for editing past the
    // author cap. One permission, one decision. Authors get
    // unconditional access to their own messages (within the window)
    // independently.
    const canEditOthers = await hasPermission(me, "edit_others_message", db);
    if (!isAuthor && !canEditOthers) {
      // Forum boards: the owner may edit anything; a mod needs the
      // `edit_posts` grant AND may never edit the owner's own posts.
      const board = await boardModTier(db, me, m.roomId);
      const boardOk = !!board && (board.isOwner
        || (boardCan(board, "edit_posts") && m.userId !== board.forumOwnerUserId));
      // Server rooms (non-default): the server owner may edit anything; a
      // server mod needs the `edit_others_message` grant AND may never edit
      // the server owner's own messages. Global admin override is already
      // covered by `canEditOthers` above; flag-off → tier is null → no change.
      const server = await serverModTier(db, me, m.roomId);
      const serverOk = !!server && (server.isOwner
        || (serverTierCan(server, "edit_others_message") && m.userId !== server.serverOwnerUserId));
      if (!boardOk && !serverOk) { reply.code(403); return { error: "not yours" }; }
    }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }

    const now = Date.now();
    const forum = await isForumMessage(db, m.roomId);
    // Single settings read covers both gates (edit window + size cap)
    // so we don't pay two round-trips per edit. Per-server: resolve the
    // message's room→server (NULL/legacy → DEFAULT_SERVER_ID) so a server's
    // own caps apply; NULL overrides inherit the platform default, so flag-off
    // is byte-identical to the old `getSettings(db)` read.
    const { maxMessageLength, maxForumPostLength, editGraceMs } =
      await getServerSettings(db, await resolveRoomServerId(db, m.roomId));
    // Holders of edit_others_message bypass the grace window entirely
    // (a moderation lever for touch-ups requested by an author after
    // the cap has expired).
    if (!canEditOthers && !forum && now - +m.createdAt > editGraceMs) {
      reply.code(403);
      return { error: tFor(me.locale, "errors:server.messages.editWindowClosed", { seconds: Math.round(editGraceMs / 1000) }) };
    }

    // Apply the same per-surface length cap as fresh messages so
    // editing isn't a back door around the configured limit. Forum
    // posts use the larger forum cap; flat-chat edits use the chat
    // cap.
    const trimmed = body.body.trim();
    if (!trimmed) { reply.code(400); return { error: "empty" }; }
    // Persisted plain body keeps a leading blank line (trimEnd), so an edit
    // can start content below the author name — same contract as a fresh send
    // (dispatch.ts). `trimmed` stays full-trim for the empty check + caps.
    const kept = body.body.trimEnd();
    const effectiveCap = forum ? maxForumPostLength : maxMessageLength;

    // Rich-format rows (migration 0352) keep their format on edit: the
    // incoming body is the rich editor's HTML serialization, sanitized
    // against the same strict whitelist as fresh sends, with the same
    // pair of caps (raw-byte ceiling + visible-character cap) and a
    // refreshed plaintext mirror. md rows keep the historic path
    // byte-identically.
    let safeBody: string;
    let bodyTextUpdate: string | null = null;
    if (m.format === "html") {
      if (Buffer.byteLength(trimmed, "utf8") > RICH_HTML_MAX_BYTES) {
        reply.code(413);
        return { error: tFor(me.locale, "errors:server.realtime.richTooLarge") };
      }
      // Per-room rich-text toggle (migration 0354): edits into a
      // rich-disabled room take the same reduced profile as fresh sends —
      // headings unwrap to paragraphs, alignment strips — so the edit
      // route can't back-door a construct dispatch would have degraded.
      const editRoom = (await db
        .select({ richTextDisabled: rooms.richTextDisabled })
        .from(rooms)
        .where(eq(rooms.id, m.roomId))
        .limit(1))[0];
      safeBody = sanitizeRichMessageHtml(
        trimmed,
        editRoom?.richTextDisabled ? { blocksDisabled: true } : undefined,
      );
      bodyTextUpdate = richHtmlToText(safeBody).trim();
      if (!bodyTextUpdate) { reply.code(400); return { error: "empty" }; }
      if (bodyTextUpdate.length > effectiveCap) {
        reply.code(413);
        return {
          error: forum
            ? tFor(me.locale, "errors:server.realtime.forumPostsCapped", { max: effectiveCap })
            : tFor(me.locale, "errors:server.realtime.messagesCapped", { max: effectiveCap }),
        };
      }
    } else {
      if (trimmed.length > effectiveCap) {
        reply.code(413);
        return {
          error: forum
            ? tFor(me.locale, "errors:server.realtime.forumPostsCapped", { max: effectiveCap })
            : tFor(me.locale, "errors:server.realtime.messagesCapped", { max: effectiveCap }),
        };
      }
      // Re-sanitise for kinds whose bodies feed renderers that trust them. We
      // don't currently render body via dangerouslySetInnerHTML on the chat
      // line, but be defensive, sanitiseBio is the same routine used for bio
      // HTML and is safe to apply to plain text (it's a no-op for text-only).
      safeBody = m.kind === "say" || m.kind === "me" || m.kind === "ooc" || m.kind === "scene" || m.kind === "container"
        ? kept
        : sanitizeBio(trimmed);
    }

    const editedAt = new Date(now);
    await db
      .update(messages)
      .set({
        body: safeBody,
        ...(m.format === "html" ? { bodyText: bodyTextUpdate } : {}),
        editedAt,
      })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    await emitMessageUpdate(io, db, updated);
    // Cross-room whisper overlay: the recipient may be viewing the
    // whisper from another room (their bucket holds it under a
    // different roomId). Fan the update out to their sockets too so
    // the live edit lands wherever they're looking. Skips if recipient
    // is already in the sender's room, the room broadcast above
    // already covered them, and the client's updateMessage is
    // idempotent on duplicate updates anyway.
    if (updated.kind === "whisper" && updated.toUserId) {
      const toId = updated.toUserId;
      const wire = toWire(updated);
      const sockets = await io.fetchSockets();
      // §J: the whisper recipient may be under 18 — same per-socket variant
      // pick as emitMessageUpdate (a snapshot-less socket fails closed),
      // computed lazily so the common adult-recipient case does no masking
      // work. Without this, profanity edited INTO a whisper would land raw
      // on the minor's cross-room view.
      let minorVariant: ChatMessage | null | undefined;
      for (const s of sockets) {
        const uid = (s.data as { userId?: string }).userId;
        if (uid !== toId) continue;
        if ((s.data as { roomId?: string }).roomId === m.roomId) continue;
        if ((s.data as { user?: { isAdult?: boolean } }).user?.isAdult) {
          s.emit("message:update", wire);
          continue;
        }
        if (minorVariant === undefined) minorVariant = maskMessageForMinors(wire);
        s.emit("message:update", minorVariant ?? wire);
      }
    }
    return { ok: true };
  });

  /**
   * Soft-delete a message. Permitted for:
   *   * the author (within 60s in flat rooms, anytime in forum rooms)
   *   * any moderator or admin (no time gate, moderation action)
   *
   * The body is preserved on the row server-side so admin/report review
   * can still see the original content; `toWire` returns body="" to all
   * end-user surfaces (the renderer paints "[message removed]"). Reply
   * snippets in children stay coherent regardless since they were
   * frozen at reply time.
   */
  app.delete<{ Params: { id: string } }>("/messages/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }

    const isAuthor = m.userId === me.id;
    // `delete_others_message` covers both gate + grace-window bypass
    // for moderators. Same shape as the edit path above.
    const canDeleteOthers = await hasPermission(me, "delete_others_message", db);
    if (!isAuthor && !canDeleteOthers) {
      // Forum boards: owner deletes anything; a mod needs the
      // `delete_posts` grant AND may never delete owner-authored content.
      const board = await boardModTier(db, me, m.roomId);
      const boardOk = !!board && (board.isOwner
        || (boardCan(board, "delete_posts") && m.userId !== board.forumOwnerUserId));
      // Server rooms (non-default): server owner deletes anything; a server
      // mod needs the `delete_others_message` grant AND may never delete the
      // server owner's own messages. Global admin override already handled by
      // `canDeleteOthers`; flag-off → tier null → unchanged.
      const server = await serverModTier(db, me, m.roomId);
      const serverOk = !!server && (server.isOwner
        || (serverTierCan(server, "delete_others_message") && m.userId !== server.serverOwnerUserId));
      if (!boardOk && !serverOk) { reply.code(403); return { error: "not yours" }; }
    }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }

    const now = Date.now();
    const forum = await isForumMessage(db, m.roomId);
    // Holders of `delete_others_message` bypass the grace window
    // entirely; authors only get the bypass in forum rooms (and in
    // flat-chat rooms within the admin-configured grace window). Per-server:
    // the grace window is the message's room→server effective value (NULL
    // override inherits the platform default, so flag-off is byte-identical).
    const { editGraceMs } = await getServerSettings(db, await resolveRoomServerId(db, m.roomId));
    if (!canDeleteOthers && !forum && now - +m.createdAt > editGraceMs) {
      reply.code(403);
      return { error: tFor(me.locale, "errors:server.messages.deleteWindowClosed", { seconds: Math.round(editGraceMs / 1000) }) };
    }

    const deletedAt = new Date(now);
    // Snapshot the actor's identity onto the row so the admin-audit
    // render in chat can show who performed the delete (self vs
    // admin/mod). We snapshot `username` (the underlying account)
    // rather than the active character's displayName because
    // moderation transparency is the goal, admins doing a delete
    // should be identifiable as their account, not as whatever
    // character they happened to be voicing at the time. Self-delete
    // detection at render time compares by userId, so the snapshot
    // name is presentation-only.
    await db
      .update(messages)
      .set({
        deletedAt,
        deletedByUserId: me.id,
        deletedByDisplayName: me.username,
      })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    // Auto-unpin: a removed message must not linger as a pinned card. The
    // strip's frozen snapshot would otherwise keep showing the (now hidden)
    // original body, defeating the moderation AND permanently eating a pin-cap
    // slot. Drop any pin(s) for this message and re-broadcast the room's set.
    // Runs BEFORE the socket-count early-return below so it happens even when
    // no one is currently in the room. (`/trash` hard-delete + the retention
    // janitor live in other modules and rely on the FK SET NULL instead — an
    // orphaned pin there stays removable via the pin-id unpin path.)
    const removedPins = await db
      .delete(pinnedMessages)
      .where(eq(pinnedMessages.messageId, m.id));
    if (removedPins.changes > 0) await emitRoomPins(io, db, m.roomId);
    // Mod Log: a moderator removing someone ELSE's forum post (self-deletes
    // aren't moderation). No-op off forum boards.
    if (!isAuthor) {
      await auditForumTopic(db, me.id, m.roomId, m.id, "forum_post_delete", { isTopic: !m.replyToId, title: m.title ?? null }, m.userId);
    }
    // Per-socket emit so site admins (admin / masteradmin) receive the
    // original body alongside the deletion marker, they need to see
    // what got hidden in case the author was burying something. Mods,
    // room-owner mods, and ordinary viewers get the bare wire payload
    // (no `originalBody` field). This means the deleted content never
    // crosses the wire to anyone who shouldn't have it.
    const adminWire = toWire(updated, true);
    const plainWire = toWire(updated, false);
    // §J: a deleted row's wire strips the body, but the update still carries
    // user text (forum topic title, reply quote snippet) — minor viewers get
    // the masked variant of the plain wire, computed lazily at most once.
    // Permission-holders keep adminWire untouched (staff accounts are adult
    // accounts — the same posture as maskMessageForMinors's originalBody
    // exclusion).
    let minorPlainWire: ChatMessage | null | undefined;
    const plainWireFor = (adult: boolean): ChatMessage => {
      if (adult) return plainWire;
      if (minorPlainWire === undefined) minorPlainWire = maskMessageForMinors(plainWire);
      return minorPlainWire ?? plainWire;
    };
    // Staff pair oversight: the tombstone mirror must run BEFORE the
    // empty-room early return — the headline oversight flow is a staffer
    // standing in the pair's OTHER side deleting a row from the merged
    // view while the row's own room is empty (0 sockets). Without this,
    // the deleted body kept rendering in every overseer's merged feed
    // until a rejoin. Plain adult tombstone; the originalBody reveal
    // stays scoped to the room's own fanout below.
    if (updated.kind !== "whisper" && !updated.targetUserId) {
      await emitToPairStaff(io, db, m.roomId, (s) => s.emit("message:update", plainWireFor(true)));
    }
    const roomSockets = await io.in(`room:${m.roomId}`).fetchSockets();
    if (roomSockets.length === 0) return { ok: true };
    // Look the viewer roles up in one batch, typical room has ≤ 50
    // sockets, so a single SELECT keyed by userId beats per-socket
    // round-trips. Sockets with no resolvable userId (unauthenticated
    // edge cases) get the plain payload by default.
    const userIds = [
      ...new Set(
        roomSockets
          .map((s) => (s.data as { userId?: string }).userId)
          .filter((u): u is string => !!u),
      ),
    ];
    const roles =
      userIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await db
                .select({ id: users.id, role: users.role })
                .from(users)
                .where(inArray(users.id, userIds))
            ).map((r) => [r.id, r.role]),
          );
    // Server-aware `view_deleted` (Phase 5): on a non-default server room, a
    // server mod/owner holding `view_deleted_post_body` ALSO sees the original
    // body — not only sitewide admins. Resolve the room's server ONCE; the
    // per-socket grant check below ORs the server tier with the global
    // permission. Off-flag / system-server / non-server rooms → null → today's
    // global-only reveal is unchanged.
    const delServerId = await (async () => {
      if (!areServersEnabled(await getSettings(db))) return null;
      const room = (await db.select({ serverId: rooms.serverId }).from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
      if (!room?.serverId) return null;
      const { serverAuthority } = await import("../servers/authority.js");
      // Resolve the server once to learn whether it's the system default (which
      // keeps global-only reveal). We re-check membership per viewer below.
      const probe = await serverAuthority(db, null, room.serverId);
      return probe.server && !probe.server.isSystem ? room.serverId : null;
    })();
    for (const s of roomSockets) {
      const uid = (s.data as { userId?: string }).userId ?? "";
      const role = roles.get(uid) ?? "user";
      const adult = !!(s.data as { user?: { isAdult?: boolean } }).user?.isAdult;
      // Age plan Phase 2: mirror emitMessageUpdate's stamped-row posture —
      // an 18+-stamped row's update never crosses to a non-adult socket
      // (snapshot-less sockets fail closed). The deleted wire strips the
      // body but still carries user text (topic title, reply snippet) the
      // backlog/topics gates never hand minors; e.g. a mod deleting an
      // 18+-era topic in a room that has since flipped back SFW.
      if (updated.isNsfw && !adult) continue;
      // Reveal `originalBody` only to viewers with the
      // `view_deleted_message_body` permission. The per-viewer check
      // is per-socket so granting / revoking the permission in the
      // matrix takes effect on the next fanout without code changes.
      let canSeeOriginal = await hasPermission({ id: uid, role: role as Role }, "view_deleted_message_body", db);
      if (!canSeeOriginal && delServerId && uid) {
        const { serverAuthority, serverCan } = await import("../servers/authority.js");
        const a = await serverAuthority(db, { id: uid, role: role as Role }, delServerId);
        canSeeOriginal = serverCan(a, "view_deleted_post_body");
      }
      s.emit("message:update", canSeeOriginal ? adminWire : plainWireFor(adult));
    }
    // Cross-room whisper overlay: fan the delete out to the recipient
    // even when they're viewing from another room. Same shape as the
    // edit path; recipient role determines admin vs plain wire (it
    // matters for the originalBody audit field, though admins viewing
    // their own whispers from outside the sender's room is rare).
    if (updated.kind === "whisper" && updated.toUserId) {
      const toId = updated.toUserId;
      const allSockets = await io.fetchSockets();
      const recipientSockets = allSockets.filter((s) => {
        const uid = (s.data as { userId?: string }).userId;
        if (uid !== toId) return false;
        return (s.data as { roomId?: string }).roomId !== m.roomId;
      });
      if (recipientSockets.length > 0) {
        const recipRole = (await db
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, toId))
          .limit(1))[0]?.role ?? "user";
        const canSeeOriginal = await hasPermission({ id: toId, role: recipRole as Role }, "view_deleted_message_body", db);
        // §J: same per-socket adult/minor pick — and the same stamped-row
        // skip — as the room loop above.
        for (const s of recipientSockets) {
          const adult = !!(s.data as { user?: { isAdult?: boolean } }).user?.isAdult;
          if (updated.isNsfw && !adult) continue;
          s.emit("message:update", canSeeOriginal ? adminWire : plainWireFor(adult));
        }
      }
    }
    return { ok: true };
  });

  /**
   * Lock or unlock a forum topic. Locked topics still display normally
   * but reject new replies server-side (`dispatch.ts` checks
   * `parent.lockedAt` and returns LOCKED). Permitted for:
   *   * the topic's author (close-my-own-thread)
   *   * any mod or admin (moderation)
   *
   * Only works on top-level topics (`replyToId IS NULL`) in nested-mode
   * rooms, locking a reply or a flat-chat message is a category error
   * and is rejected with 400.
   */
  const lockBody = z.object({ locked: z.boolean() }).strict();
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id/lock", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let parsed;
    try { parsed = lockBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }
    if (m.replyToId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.onlyTopicsLocked") }; }

    const forum = await isForumMessage(db, m.roomId);
    if (!forum) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.lockForumOnly") }; }

    const isAuthor = m.userId === me.id;
    // Authors can lock their own topic; mods/admins with the
    // appropriate permission lock or unlock any topic. On forum BOARDS
    // the forum owner + Forum Moderators get the same lever (lock is
    // state, not content, so the owner-content exception doesn't apply).
    const key = parsed.locked ? "lock_forum_topic" : "unlock_forum_topic";
    const canModerate = await hasPermission(me, key, db);
    if (!isAuthor && !canModerate) {
      const board = await boardModTier(db, me, m.roomId);
      if (!boardCan(board, "lock_topics")) { reply.code(403); return { error: "not yours" }; }
    }

    const lockedAt = parsed.locked ? new Date() : null;
    await db
      .update(messages)
      .set({ lockedAt })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    await emitMessageUpdate(io, db, updated);
    // Mod Log: only when a moderator acts on someone ELSE's topic (an author
    // locking their own thread isn't moderation).
    if (m.userId !== me.id) {
      await auditForumTopic(db, me.id, m.roomId, m.id, "forum_topic_lock", { locked: parsed.locked, title: m.title ?? null }, m.userId);
    }
    return { ok: true };
  });

  /**
   * Pin or unpin a forum topic (admin-only). Sticky topics float to
   * the top of their category section regardless of `lastActivityAt`
   * ordering and stay loaded on every page of `/rooms/:id/topics`.
   * Mods can lock/delete but NOT pin, pinning is a persistent
   * room-furniture decision reserved for site admins.
   *
   * Same shape as the lock route: forum rooms only, topics only,
   * non-deleted only, `{ sticky: boolean }` body.
   */
  const stickyBody = z.object({ sticky: z.boolean() }).strict();
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id/sticky", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let parsed;
    try { parsed = stickyBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }
    // Sitewide pin permission (admins), OR — on a forum board — the forum
    // owner / a Forum Moderator (stickies are the matrix's topic-level
    // furniture; mods CAN sticky, including the owner's topics).
    if (!(await hasPermission(me, "pin_forum_topic", db))) {
      const board = await boardModTier(db, me, m.roomId);
      if (!boardCan(board, "pin_topics")) { reply.code(403); return { error: "admins only" }; }
    }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }
    if (m.replyToId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.onlyTopicsPinned") }; }

    const forum = await isForumMessage(db, m.roomId);
    if (!forum) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.pinForumOnly") }; }

    await db
      .update(messages)
      .set({ isSticky: parsed.sticky })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    await emitMessageUpdate(io, db, updated);
    await auditForumTopic(db, me.id, m.roomId, m.id, "forum_topic_sticky", { sticky: parsed.sticky, title: m.title ?? null }, m.userId);
    return { ok: true };
  });

  /**
   * Move a forum topic to a different category (or to Uncategorized with
   * `categoryId: null`). Mods/admins only — recategorizing is a curation
   * lever, not an authoring one, so the topic author does NOT get it by
   * default; it reuses the `lock_forum_topic` permission (the general
   * "can moderate forum topics" capability) plus the forum-board
   * owner/Forum-Moderator tier.
   *
   * Same guards as lock/sticky: forum room only, top-level topic only,
   * non-deleted only. A non-null target category must belong to the
   * topic's own room (you can't fling a topic into another board).
   */
  const categoryBody = z.object({ categoryId: z.string().min(1).nullable() }).strict();
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id/category", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let parsed;
    try { parsed = categoryBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }
    if (m.replyToId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.onlyTopicsMoved") }; }

    const forum = await isForumMessage(db, m.roomId);
    if (!forum) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.moveForumOnly") }; }

    if (!(await hasPermission(me, "lock_forum_topic", db))) {
      const board = await boardModTier(db, me, m.roomId);
      if (!boardCan(board, "move_topics")) { reply.code(403); return { error: "mods only" }; }
    }

    // A non-null target must be a real category in this same room.
    if (parsed.categoryId) {
      const cat = (await db
        .select()
        .from(roomThreadCategories)
        .where(and(eq(roomThreadCategories.id, parsed.categoryId), eq(roomThreadCategories.roomId, m.roomId)))
        .limit(1))[0];
      if (!cat) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.categoryNotInBoard") }; }
    }

    await db
      .update(messages)
      .set({ threadCategoryId: parsed.categoryId })
      .where(eq(messages.id, m.id));

    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (!updated) { reply.code(404); return { error: "not found" }; }
    await emitMessageUpdate(io, db, updated);
    await auditForumTopic(db, me.id, m.roomId, m.id, "forum_topic_move", { from: m.threadCategoryId ?? null, to: parsed.categoryId, title: m.title ?? null }, m.userId);
    return { ok: true };
  });

  /**
   * PATCH /messages/:id/prefix — set or clear a forum topic's prefix.
   * Allowed for the topic author OR a mod holding `manage_prefixes`. The
   * prefix must belong to the topic's own forum. `prefixId: null` clears it.
   */
  const prefixBody = z.object({ prefixId: z.string().min(1).nullable() }).strict();
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id/prefix", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let parsed: z.infer<typeof prefixBody>;
    try { parsed = prefixBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m || m.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (m.replyToId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.onlyTopicsPrefix") }; }
    const room = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    if (!room?.forumId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.prefixForumOnly") }; }
    // Author may tag their own topic; otherwise needs the manage_prefixes grant.
    // We resolve the grant up front because staff-only tags are manager-gated
    // even for the author (see below).
    const isManager = boardCan(await boardModTier(db, me, m.roomId), "manage_prefixes");
    if (m.userId !== me.id && !isManager) { reply.code(403); return { error: "not yours" }; }
    const { forumPrefixes } = await import("../db/schema.js");
    // A staff-only tag already ON the topic can only be changed or cleared by a
    // manager — an author can't quietly drop the keeper's "Announcement".
    if (m.prefixId && !isManager) {
      const cur = (await db.select({ staffOnly: forumPrefixes.staffOnly }).from(forumPrefixes)
        .where(eq(forumPrefixes.id, m.prefixId)).limit(1))[0];
      if (cur?.staffOnly) { reply.code(403); return { error: tFor(me.locale, "errors:server.messages.staffOnlyTag") }; }
    }
    // A non-null prefix must belong to THIS forum AND be offered in the
    // topic's category (global tags apply everywhere; scoped tags only in
    // their listed categories). Author and mod alike respect the scope. A
    // staff-only tag additionally requires the manage_prefixes grant to apply.
    if (parsed.prefixId) {
      const { parsePrefixCategoryIds, prefixAppliesToCategory } = await import("@thekeep/shared");
      const pref = (await db.select({ id: forumPrefixes.id, categoryIdsJson: forumPrefixes.categoryIdsJson, staffOnly: forumPrefixes.staffOnly }).from(forumPrefixes)
        .where(and(eq(forumPrefixes.id, parsed.prefixId), eq(forumPrefixes.forumId, room.forumId))).limit(1))[0];
      if (!pref) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.prefixNotInForum") }; }
      if (pref.staffOnly && !isManager) { reply.code(403); return { error: tFor(me.locale, "errors:server.messages.tagStaffOnly") }; }
      if (!prefixAppliesToCategory({ categoryIds: parsePrefixCategoryIds(pref.categoryIdsJson) }, m.threadCategoryId ?? null)) {
        reply.code(400); return { error: tFor(me.locale, "errors:server.messages.tagNotInCategory") };
      }
    }
    await db.update(messages).set({ prefixId: parsed.prefixId }).where(eq(messages.id, m.id));
    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (updated) await emitMessageUpdate(io, db, updated);
    return { ok: true };
  });

  /**
   * PATCH /messages/:id/nsfw — set or clear a forum topic's NSFW tag (age
   * plan, Phase 3; the "system tag" rendered as the built-in NSFW chip).
   * Allowed for the topic AUTHOR or a mod holding `manage_prefixes` (the tag
   * is curation furniture, so it rides the prefix grant) — and ALWAYS adults
   * only: a minor can neither set nor clear any NSFW flag, even on their own
   * topic, whatever forum role they hold.
   *
   * Tagging retro-stamps every reply under the topic so the filters keyed
   * on `messages.is_nsfw` (searches, notification re-reads, backlog clause)
   * cover the whole thread. Clearing the tag can never drop the stamp below
   * the board room's own effective 18+ state — content written in an 18+
   * room stays 18+ — and NEVER touches the replies at all: `is_nsfw` on a
   * reply doubles as the write-time era stamp (rows written while the
   * board/server was 18+), which one routine untag must not erase. Tag-
   * inherited replies stay over-hidden instead (keep-but-hide).
   */
  const nsfwTagBody = z.object({ nsfw: z.boolean() }).strict();
  app.patch<{ Params: { id: string }; Body: unknown }>("/messages/:id/nsfw", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let parsed: z.infer<typeof nsfwTagBody>;
    try { parsed = nsfwTagBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }
    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m || m.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (m.replyToId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.onlyTopicsNsfw") }; }
    const room = (await db
      .select({ isNsfw: rooms.isNsfw, serverId: rooms.serverId, forumId: rooms.forumId })
      .from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    if (!room?.forumId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.nsfwForumOnly") }; }
    if (!me.isAdult) {
      reply.code(403);
      return { error: tFor(me.locale, "errors:server.messages.nsfwAdultsOnly") };
    }
    const isManager = boardCan(await boardModTier(db, me, m.roomId), "manage_prefixes");
    if (m.userId !== me.id && !isManager) { reply.code(403); return { error: "not yours" }; }
    // The board room's effective 18+ state is the tag's FLOOR: clearing the
    // tag inside an 18+ room/server leaves the write-time stamp in place.
    const value = parsed.nsfw || (await effectiveRoomNsfw(db, room));
    await db.update(messages).set({ isNsfw: value }).where(eq(messages.id, m.id));
    // Retro-stamp the whole thread ON RAISE ONLY (forum replies always
    // attach directly to the topic) so a tag covers replies in search +
    // notifications too. A clear deliberately leaves the replies untouched:
    // their `is_nsfw` doubles as the write-time era stamp (rows written
    // while the board/server was 18+ and later flipped back), and the floor
    // above only reflects the room's CURRENT state — a blanket downgrade
    // here would erase that era protection on the first routine untag.
    // Tag-inherited replies stay over-hidden instead (keep-but-hide; the
    // thread route still renders them for adults).
    if (value) {
      await db.update(messages).set({ isNsfw: true }).where(eq(messages.replyToId, m.id));
    }
    await auditForumTopic(db, me.id, m.roomId, m.id, "topic_nsfw_update", { isNsfw: value, title: m.title ?? null }, m.userId);
    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (updated) await emitMessageUpdate(io, db, updated);
    return { ok: true, isNsfw: value };
  });

  /** Shared move/merge permission check: the sitewide forum-topic permission
   *  OR the `move_topics` grant on the topic's own board. Returns true when
   *  allowed. */
  async function canMoveTopics(meUser: { id: string; role: Role }, roomId: string): Promise<boolean> {
    if (await hasPermission(meUser, "lock_forum_topic", db)) return true;
    return boardCan(await boardModTier(db, meUser, roomId), "move_topics");
  }

  /**
   * POST /messages/:id/move-to-board — move a whole topic (header + every
   * reply) to a DIFFERENT board in the SAME forum, optionally dropping it
   * into a category there. Needs `move_topics`. Cross-FORUM moves are
   * refused (a topic can't leave its forum). Replies follow the header.
   */
  const moveBoardBody = z.object({
    boardRoomId: z.string().min(1),
    categoryId: z.string().min(1).nullable().optional(),
  }).strict();
  app.post<{ Params: { id: string }; Body: unknown }>("/messages/:id/move-to-board", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let parsed: z.infer<typeof moveBoardBody>;
    try { parsed = moveBoardBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m || m.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (m.replyToId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.onlyTopicsMoved") }; }
    const srcRoom = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    if (!srcRoom?.forumId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.moveBoardsForumOnly") }; }
    const tgtRoom = (await db.select({ id: rooms.id, forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, parsed.boardRoomId)).limit(1))[0];
    if (!tgtRoom?.forumId) { reply.code(404); return { error: tFor(me.locale, "errors:server.messages.boardMissing") }; }
    if (tgtRoom.forumId !== srcRoom.forumId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.moveSameForum") }; }
    if (tgtRoom.id === m.roomId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.alreadyOnBoard") }; }
    if (!(await canMoveTopics(me, m.roomId))) { reply.code(403); return { error: "mods only" }; }
    // A non-null target category must belong to the TARGET board.
    if (parsed.categoryId) {
      const cat = (await db.select({ id: roomThreadCategories.id }).from(roomThreadCategories)
        .where(and(eq(roomThreadCategories.id, parsed.categoryId), eq(roomThreadCategories.roomId, tgtRoom.id))).limit(1))[0];
      if (!cat) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.categoryNotOnDestination") }; }
    }
    const oldRoomId = m.roomId;
    await db.update(messages).set({ roomId: tgtRoom.id, threadCategoryId: parsed.categoryId ?? null }).where(eq(messages.id, m.id));
    // Re-home the replies (matched by the OLD room so we don't catch unrelated rows).
    await db.update(messages).set({ roomId: tgtRoom.id }).where(and(eq(messages.replyToId, m.id), eq(messages.roomId, oldRoomId)));
    await auditForumTopic(db, me.id, tgtRoom.id, m.id, "forum_topic_move", { toBoard: tgtRoom.id, fromBoard: oldRoomId, title: m.title ?? null }, m.userId);
    return { ok: true };
  });

  /**
   * POST /messages/:id/merge-into — merge THIS topic into another topic in
   * the same forum. Non-destructive: this topic's replies become replies of
   * the target, and this topic's header becomes a plain reply (its title is
   * dropped, its sticky/lock cleared). The target's last-activity is
   * recomputed so it floats correctly. Needs `move_topics`.
   */
  const mergeBody = z.object({ targetTopicId: z.string().min(1) }).strict();
  app.post<{ Params: { id: string }; Body: unknown }>("/messages/:id/merge-into", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let parsed: z.infer<typeof mergeBody>;
    try { parsed = mergeBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const src = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!src || src.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (src.replyToId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.onlyTopicsMerged") }; }
    if (parsed.targetTopicId === src.id) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.mergeSelf") }; }
    const tgt = (await db.select().from(messages).where(eq(messages.id, parsed.targetTopicId)).limit(1))[0];
    if (!tgt || tgt.deletedAt || tgt.replyToId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.mergeDestinationLive") }; }
    const srcRoom = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, src.roomId)).limit(1))[0];
    const tgtRoom = (await db.select({ forumId: rooms.forumId }).from(rooms).where(eq(rooms.id, tgt.roomId)).limit(1))[0];
    if (!srcRoom?.forumId || srcRoom.forumId !== tgtRoom?.forumId) { reply.code(400); return { error: tFor(me.locale, "errors:server.messages.mergeSameForum") }; }
    if (!(await canMoveTopics(me, src.roomId))) { reply.code(403); return { error: "mods only" }; }

    const oldRoomId = src.roomId;
    // Source's replies → replies of the target, in the target's room.
    await db.update(messages).set({ replyToId: tgt.id, roomId: tgt.roomId })
      .where(and(eq(messages.replyToId, src.id), eq(messages.roomId, oldRoomId)));
    // Source header → a plain reply of the target (drop topic-only fields).
    await db.update(messages).set({
      replyToId: tgt.id, roomId: tgt.roomId, title: null,
      threadCategoryId: tgt.threadCategoryId, isSticky: false, lockedAt: null,
    }).where(eq(messages.id, src.id));
    // Recompute the target's last-activity across its (now larger) thread.
    const latest = (await db
      .select({ mx: sql<number>`max(${messages.createdAt})` })
      .from(messages)
      .where(or(eq(messages.id, tgt.id), eq(messages.replyToId, tgt.id))))[0];
    if (latest?.mx) {
      await db.update(messages).set({ lastActivityAt: new Date(Number(latest.mx)) }).where(eq(messages.id, tgt.id));
    }
    await auditForumTopic(db, me.id, tgt.roomId, tgt.id, "forum_topic_move", { mergedFrom: src.id, mergedTitle: src.title ?? null, title: tgt.title ?? null }, src.userId);
    return { ok: true };
  });

  /**
   * DELETE /messages/:id/link-preview — the author removes the unfurled
   * card from their own message (Discord's ✕). Writes a {"hidden":true}
   * tombstone (so a late/re-run unfurl can't resurrect it) and
   * broadcasts the refreshed row; the card disappears for everyone.
   */
  app.delete<{ Params: { id: string } }>("/messages/:id/link-preview", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const m = (await db.select().from(messages).where(eq(messages.id, req.params.id)).limit(1))[0];
    if (!m) { reply.code(404); return { error: "not found" }; }
    if (m.userId !== me.id) { reply.code(403); return { error: tFor(me.locale, "errors:server.messages.linkPreviewAuthorOnly") }; }
    await db
      .update(messages)
      .set({ linkPreviewJson: JSON.stringify({ hidden: true }) })
      .where(eq(messages.id, m.id));
    const updated = (await db.select().from(messages).where(eq(messages.id, m.id)).limit(1))[0];
    if (updated) await emitMessageUpdate(io, db, updated);
    return { ok: true };
  });

  /**
   * POST /messages/:id/pin — pin a chat message to the top of its room
   * (migration 0316). Gate mirrors the tiered moderation gates above:
   * the sitewide `pin_message` permission OR the room owner/mod (which also
   * covers a server owner/mod, whose room authority lands in room_members).
   *
   * The pin carries a display SNAPSHOT frozen at pin time (author, body,
   * styling, original createdAt) so the strip stays readable after the
   * underlying message is edited or hard-deleted — the same convention
   * bookmarks and reply previews use. Because pins live in their own table
   * with `messageId` FK SET NULL, chat retention needs no changes.
   *
   * Guards: whispers are never pinnable; private-room messages require the
   * caller be a room member (the visibility check); the per-room count is
   * capped at {@link MAX_PINS_PER_ROOM}; re-pinning an already-pinned message
   * is idempotent (the unique (roomId, messageId) index). On success the
   * room's full pin set is re-broadcast via `room:pins`.
   */
  app.post<{ Params: { id: string } }>("/messages/:id/pin", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    // Visibility first (also loads the row + resolves the room). Whispers and
    // messages the caller can't see are indistinguishable 404s so private-room
    // existence never leaks.
    const m = await canCallerPinMessage(db, me, req.params.id);
    if (!m) { reply.code(404); return { error: "message not found or not visible" }; }
    if (m.deletedAt) { reply.code(410); return { error: "already removed" }; }

    // Authorization: sitewide pin_message, or room owner/mod (server
    // owner/mod authority folds in here via room_members).
    if (!(await canCallerPin(db, me, m.roomId))) { reply.code(403); return { error: "not allowed" }; }

    // Idempotent: re-pinning an already-pinned message is a no-op (unique
    // (roomId, messageId)). Re-broadcast so the caller's client still syncs.
    const existing = (await db
      .select()
      .from(pinnedMessages)
      .where(and(eq(pinnedMessages.roomId, m.roomId), eq(pinnedMessages.messageId, m.id)))
      .limit(1))[0];
    if (existing) {
      await emitRoomPins(io, db, m.roomId);
      return { ok: true, id: existing.id };
    }

    // Enforce the per-room cap (count only real rows for THIS room).
    const countRow = (await db
      .select({ n: sql<number>`count(*)` })
      .from(pinnedMessages)
      .where(eq(pinnedMessages.roomId, m.roomId)))[0];
    if ((countRow?.n ?? 0) >= MAX_PINS_PER_ROOM) {
      reply.code(409);
      return { error: tFor(me.locale, "errors:server.messages.maxPins", { max: MAX_PINS_PER_ROOM }) };
    }

    // Next sortOrder = current max + 1 (append to the end of the strip).
    const maxRow = (await db
      .select({ mx: sql<number>`max(${pinnedMessages.sortOrder})` })
      .from(pinnedMessages)
      .where(eq(pinnedMessages.roomId, m.roomId)))[0];
    const nextSort = (maxRow?.mx == null ? -1 : Number(maxRow.mx)) + 1;

    // Snapshot the message content at pin time so the strip survives edits /
    // hard-delete. `serverId` mirrors the room's owning server (null on the
    // default server), matching the column's contract.
    const room = (await db.select({ serverId: rooms.serverId }).from(rooms).where(eq(rooms.id, m.roomId)).limit(1))[0];
    const id = nanoid();
    await db.insert(pinnedMessages).values({
      id,
      roomId: m.roomId,
      messageId: m.id,
      serverId: room?.serverId ?? null,
      pinnedByUserId: me.id,
      pinnedByDisplayName: me.username,
      sortOrder: nextSort,
      authorUserId: m.userId,
      authorCharacterId: m.characterId ?? null,
      displayName: m.displayName,
      kind: m.kind,
      // Rich-format rows (migration 0352) pin their VISIBLE text: the
      // pin strip is a plaintext surface, and the snapshot must outlive
      // the source row, so freeze the mirror rather than raw markup.
      body: m.format === "html" ? (m.bodyText ?? m.body) : m.body,
      color: m.color,
      cmdCss: m.cmdCss ?? null,
      sceneImageUrl: m.sceneImageUrl ?? null,
      bodyHtml: m.bodyHtml ?? null,
      origCreatedAt: +m.createdAt,
      // Freeze the source row's 18+ stamp (age plan; migration 0340) so the
      // minor gate still holds once retention expires the source and the
      // live `messages.isNsfw` join can no longer see it.
      isNsfw: m.isNsfw,
    });

    await emitRoomPins(io, db, m.roomId);
    await recordAudit(db, {
      actorUserId: me.id,
      action: "message_pin",
      targetRoomId: m.roomId,
      targetMessageId: m.id,
      ...(m.userId ? { targetUserId: m.userId } : {}),
      metadata: { pinId: id },
    });
    return { ok: true, id };
  });

  /**
   * DELETE /messages/:id/pin — unpin a message from its room. Same tiered
   * gate as pinning. Unpinning resolves the PIN ROW itself, never the
   * underlying message, so a pin ALWAYS removable even after its source was
   * hard-deleted (the FK sets `pinnedMessages.messageId` to NULL, which no
   * `messageId = :id` lookup can ever match — that was the "un-unpinnable pin
   * permanently eating a cap slot" bug).
   *
   * `:id` accepts EITHER identifier so both callers work:
   *   - a live pin's SOURCE message id (the in-chat Pin/Unpin toggle + the
   *     pins-strip button for pins whose message still exists), or
   *   - the PIN row's own id (the pins-strip button for a pin whose source was
   *     hard-deleted — its `messageId` is NULL, so only the pin id can find it).
   * We try the messageId match first (the common live case), then fall back to
   * the pin-id match. The room comes from the pin row, so a missing message is
   * irrelevant. Re-broadcasts the room's pin set on success.
   */
  app.delete<{ Params: { id: string } }>("/messages/:id/pin", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const pin = (await db
      .select()
      .from(pinnedMessages)
      .where(or(eq(pinnedMessages.messageId, req.params.id), eq(pinnedMessages.id, req.params.id)))
      .limit(1))[0];
    if (!pin) { reply.code(404); return { error: "not pinned" }; }
    // Room is always taken from the pin row — the source message may be gone.
    const roomId = pin.roomId;

    if (!(await canCallerPin(db, me, roomId))) { reply.code(403); return { error: "not allowed" }; }

    await db.delete(pinnedMessages).where(eq(pinnedMessages.id, pin.id));
    await emitRoomPins(io, db, roomId);
    await recordAudit(db, {
      actorUserId: me.id,
      action: "message_unpin",
      targetRoomId: roomId,
      // Stamp the real source message id when it still exists; a hard-deleted
      // source leaves `pin.messageId` NULL, so omit it rather than record the
      // pin id in the message-id slot.
      ...(pin.messageId ? { targetMessageId: pin.messageId } : {}),
      metadata: { pinId: pin.id },
    });
    return { ok: true };
  });

  /**
   * GET /rooms/:id/pins — the room's pinned-message set. Visibility-gated:
   * public rooms are readable by any authenticated user, private rooms by
   * members only. Used by the client to seed the pins strip on room open (the
   * live `room:pins` broadcasts keep it current thereafter).
   */
  app.get<{ Params: { id: string } }>("/rooms/:id/pins", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await canCallerSeeRoomPins(db, me, req.params.id))) {
      reply.code(404);
      return { error: "room not found or not visible" };
    }
    let pins = await loadRoomPins(db, req.params.id);
    // Flipped-back rooms (age plan, Phase 2): 18+ pins drop for minors,
    // matching the backlog clause. A LIVE pin consults its source row's
    // `messages.isNsfw` (authoritative; also catches a forum topic's later
    // NSFW re-tag); a SNAPSHOT-ONLY pin (source hard-deleted or
    // retention-expired, messageId NULL) consults its own `is_nsfw` stamp
    // frozen at pin time (migration 0340) — same split as emitRoomPins.
    if (!me.isAdult && pins.length > 0) {
      const liveIds = pins.map((p) => p.messageId).filter((v): v is string => !!v);
      const stamped = liveIds.length === 0
        ? new Set<string>()
        : new Set(
            (await db
              .select({ id: messages.id })
              .from(messages)
              .where(and(inArray(messages.id, liveIds), eq(messages.isNsfw, true))))
              .map((r) => r.id),
          );
      pins = pins.filter((p) => (p.messageId ? !stamped.has(p.messageId) : !p.isNsfw));
      // §J: the surviving pins' snapshot bodies are chat text a minor reads —
      // mask them like the backlog (per-request objects, so this can never
      // touch what an adult is served; stored rows stay untouched).
      pins = maskPinsForMinors(pins) ?? pins;
    }
    return { pins };
  });
}
