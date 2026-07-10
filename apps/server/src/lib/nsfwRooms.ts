/**
 * Room/server 18+ helpers (age-restriction plan, Phase 2).
 *
 * The EFFECTIVE rating of a room is `server.is_nsfw OR room.is_nsfw`: every
 * room inside an 18+ community is 18+ even when its own flag is off. All the
 * Phase 2 gates (rail listing, deep links, join, read routes, write stamping,
 * live fan-out) derive from these helpers so the rule lives in one place.
 *
 * The toggle core (`setRoomNsfw`) is shared by the three write surfaces —
 * the /nsfw chat command, the server console's room PATCH, and the admin
 * room PATCH — so the adult-only gate, the landing-room rule, the minor
 * eviction, the audit row, and the user-facing copy can never drift apart.
 *
 * Broadcast helpers are imported dynamically inside function bodies (the
 * room_modes.ts pattern) so this module stays OFF the realtime/broadcast
 * static graph — presence/persistence import the pure readers from here.
 */
import { eq } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { rooms, servers } from "../db/schema.js";
import { recordAudit } from "../audit.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { tFor } from "../i18n.js";
import type { Db } from "../db/index.js";
import type { SessionUser } from "../commands/types.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** The room-row slice the effective-rating reader needs. */
export interface RoomRatingSlice {
  isNsfw: boolean;
  serverId: string | null;
}

/**
 * EFFECTIVE 18+ rating for one room: its own flag OR its server's flag.
 * A NULL serverId is adopted by the default/system server, which is locked
 * SFW by invariant (assertServerInvariants + the settings-route rejection),
 * so it never needs a lookup. One indexed single-row read otherwise, and
 * only when the room's own flag doesn't already decide it.
 */
export async function effectiveRoomNsfw(db: Db, room: RoomRatingSlice): Promise<boolean> {
  if (room.isNsfw) return true;
  if (!room.serverId || room.serverId === DEFAULT_SERVER_ID) return false;
  const s = (await db
    .select({ isNsfw: servers.isNsfw })
    .from(servers)
    .where(eq(servers.id, room.serverId))
    .limit(1))[0];
  return !!s?.isNsfw;
}

/**
 * The set of 18+ server ids — one query, for callers that need the effective
 * rating of MANY rooms at once (the /rooms rail, /list, /find). A room is
 * effectively 18+ when `room.isNsfw || set.has(room.serverId ?? default)`;
 * the default server can never be in the set (SFW invariant).
 */
export async function nsfwServerIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.isNsfw, true));
  return new Set(rows.map((r) => r.id));
}

/** Effective rating against a prefetched {@link nsfwServerIds} set. */
export function effectiveRoomNsfwWith(room: RoomRatingSlice, nsfwServers: Set<string>): boolean {
  return room.isNsfw || nsfwServers.has(room.serverId ?? DEFAULT_SERVER_ID);
}

// NOTE: the former AGE_RESTRICTED_ROOM_MESSAGE constant is gone — the §G
// join-refusal copy lives ONLY in the catalog now
// (errors:server.realtime.adultsOnlyRoom), resolved per recipient via tFor.

/**
 * Resolve where to relocate an evicted minor: the room's server landing,
 * then the canonical landing — skipping any candidate that is itself
 * effectively 18+ (belt-and-braces; the landing-room rule already blocks
 * flagging a landing, but an 18+ SERVER's landing is 18+ by inheritance).
 * Null when no safe landing exists (the socket is left roomless).
 */
async function safeLandingForMinor(
  db: Db,
  serverId: string | null,
  excludeRoomId: string,
): Promise<typeof rooms.$inferSelect | null> {
  const { findCanonicalLanding, findServerLanding } = await import("../realtime/broadcast.js");
  const candidates: Array<typeof rooms.$inferSelect | null> = [];
  if (serverId && serverId !== DEFAULT_SERVER_ID) {
    candidates.push(await findServerLanding(db, serverId));
  }
  candidates.push(await findCanonicalLanding(db));
  for (const c of candidates) {
    if (!c || c.id === excludeRoomId) continue;
    if (await effectiveRoomNsfw(db, c)) continue;
    return c;
  }
  return null;
}

/**
 * Boot every under-18 occupant out of `room` (the /kick socket-eviction loop
 * pattern from commands/builtins/mod.ts), relocating each to a safe landing
 * with a fresh backlog. `room_members` rows are KEPT (keep-but-hide, like
 * kick/ban) so a later flip back restores membership untouched.
 *
 * Adult-ness is read from `socket.data.user` (the session snapshot set at
 * handshake) — no per-socket DB reads. A socket with NO user snapshot is
 * treated as not-adult (fail closed); such a socket shouldn't be in a room
 * at all. Returns the number of sockets booted.
 *
 * `noticeKey` is a CATALOG key (errors:server.*), not prebuilt text: each
 * evicted socket resolves it against its OWN session locale, so a Spanish
 * minor gets the Spanish eviction toast while an English one gets English.
 */
export async function evictMinorsFromRoom(
  io: Io,
  db: Db,
  room: { id: string; serverId: string | null },
  noticeKey: string,
): Promise<number> {
  const { broadcastPresence, broadcastRoomState, sendRoomBacklogTo } = await import("../realtime/broadcast.js");
  const landing = await safeLandingForMinor(db, room.serverId, room.id);
  const socks = await io.in(`room:${room.id}`).fetchSockets();
  let booted = 0;
  for (const s of socks) {
    const su = (s.data as { user?: SessionUser }).user;
    if (su?.isAdult) continue;
    s.leave(`room:${room.id}`);
    s.emit("error:notice", { code: "AGE_RESTRICTED", message: tFor(su?.locale, noticeKey) });
    const uid = (s.data as { userId?: string }).userId;
    if (landing) {
      s.join(`room:${landing.id}`);
      (s.data as { roomId?: string }).roomId = landing.id;
      if (uid) await sendRoomBacklogTo(s, db, landing.id, uid);
    }
    booted++;
  }
  if (booted > 0) {
    await broadcastPresence(io, db, room.id);
    if (landing) await broadcastRoomState(io, db, landing.id);
  }
  return booted;
}

/**
 * Server-level flip: boot every under-18 occupant out of EVERY room the
 * server owns (socket.data.serverId is cached on each join, so one
 * fetchSockets pass finds them without a per-room walk). `server_members`
 * rows are KEPT — the rail/discover/join gates are what keep minors out.
 * `noticeKey` is a catalog key, resolved per evicted socket's locale (see
 * evictMinorsFromRoom).
 */
export async function evictMinorsFromServer(
  io: Io,
  db: Db,
  serverId: string,
  noticeKey: string,
): Promise<number> {
  const { broadcastPresence, broadcastRoomState, sendRoomBacklogTo, findCanonicalLanding } = await import("../realtime/broadcast.js");
  // The whole server is 18+ now, so the only safe landing is outside it —
  // the canonical (system-server) landing, SFW by invariant.
  const landing = await findCanonicalLanding(db);
  const socks = await io.fetchSockets();
  const affectedRooms = new Set<string>();
  let booted = 0;
  for (const s of socks) {
    if ((s.data as { serverId?: string }).serverId !== serverId) continue;
    const su = (s.data as { user?: SessionUser }).user;
    if (su?.isAdult) continue;
    const inRoom = (s.data as { roomId?: string }).roomId;
    if (inRoom) {
      s.leave(`room:${inRoom}`);
      affectedRooms.add(inRoom);
    }
    s.emit("error:notice", { code: "AGE_RESTRICTED", message: tFor(su?.locale, noticeKey) });
    const uid = (s.data as { userId?: string }).userId;
    if (landing && !(await effectiveRoomNsfw(db, landing))) {
      s.join(`room:${landing.id}`);
      (s.data as { roomId?: string; serverId?: string }).roomId = landing.id;
      (s.data as { serverId?: string }).serverId = landing.serverId ?? DEFAULT_SERVER_ID;
      if (uid) await sendRoomBacklogTo(s, db, landing.id, uid);
    }
    booted++;
  }
  for (const rid of affectedRooms) await broadcastPresence(io, db, rid);
  // Landing destination needs full room state (room:state, not just
  // presence) so the booted sockets' clients actually switch current room
  // to the landing — the client only updates currentRoomId/currentServerId
  // on room:state, and without it the evicted minor is stuck rendering the
  // now-18+ room with an empty rail. Mirrors evictMinorsFromRoom and the
  // /kick pattern (commands/builtins/mod.ts).
  if (landing && booted > 0) await broadcastRoomState(io, db, landing.id);
  return booted;
}

export type SetRoomNsfwResult =
  | { ok: true; changed: boolean; isNsfw: boolean }
  | { ok: false; code: "AGE_RESTRICTED" | "LANDING_ROOM"; message: string };

/**
 * The one room-toggle core all three write surfaces call. Enforces:
 *   - adult-only writes (minors can never set OR clear the flag — there is
 *     deliberately no staff bypass for minor accounts);
 *   - the landing-room rule (§E): in an all-ages server the designated
 *     default/landing room can't be flagged 18+, or minors would have
 *     nowhere to land (moot inside an 18+ server — minors can't enter);
 *   - eviction of minor occupants on flip-ON (membership rows kept);
 *   - the audit row (`room_nsfw_update`) and the §G system line;
 *   - room-state + tree broadcasts so rails/chips refresh live.
 *
 * The caller has already verified EDIT RIGHTS (callerCanEditRoom /
 * manage_rooms / edit_any_room_metadata) — this core owns only the
 * age-specific rules layered on top.
 */
export async function setRoomNsfw(opts: {
  db: Db;
  io: Io;
  room: typeof rooms.$inferSelect;
  value: boolean;
  /** `locale` = the actor's users.locale; refusal copy resolves to it. */
  actor: { id: string; isAdult: boolean; locale?: string | null };
}): Promise<SetRoomNsfwResult> {
  const { db, io, room, value, actor } = opts;
  if (!actor.isAdult) {
    return {
      ok: false,
      code: "AGE_RESTRICTED",
      message: tFor(actor.locale, "errors:server.common.nsfwSettingAdultsOnly"),
    };
  }
  if (room.isNsfw === value) return { ok: true, changed: false, isNsfw: value };

  if (value) {
    // Landing-room rule (§E). Only meaningful in an ALL-AGES server: the
    // designated default/landing room must stay joinable for minors. Check
    // both the row's own default flag and the resolved landing (which
    // covers the legacy name/system-room fallbacks).
    const serverIsNsfw = await effectiveRoomNsfw(db, { isNsfw: false, serverId: room.serverId });
    if (!serverIsNsfw) {
      let isLanding = !!room.isDefault;
      if (!isLanding) {
        const { findCanonicalLanding, findServerLanding } = await import("../realtime/broadcast.js");
        const landing = room.serverId && room.serverId !== DEFAULT_SERVER_ID
          ? await findServerLanding(db, room.serverId)
          : await findCanonicalLanding(db);
        isLanding = landing?.id === room.id;
      }
      if (isLanding) {
        return {
          ok: false,
          code: "LANDING_ROOM",
          message: tFor(actor.locale, "errors:server.rooms.landingRoomCantBeNsfw"),
        };
      }
    }
  }

  await db.update(rooms).set({ isNsfw: value }).where(eq(rooms.id, room.id));

  if (value) {
    await evictMinorsFromRoom(io, db, room, "errors:server.rooms.nowAdultsOnly");
  }

  await recordAudit(db, {
    actorUserId: actor.id,
    action: "room_nsfw_update",
    targetRoomId: room.id,
    metadata: { roomName: room.name, isNsfw: value },
  });

  const { addSystemMessage, broadcastRoomState, emitTreeChanged } = await import("../realtime/broadcast.js");
  // §G copy, verbatim. Skipped for nested (forum-board) rooms — their feed
  // is a topic list, so a system line would render as a stray topic.
  if (room.replyMode !== "nested") {
    await addSystemMessage(io, db, room.id, value
      ? "This room is now 18+. Members under 18 can no longer see it."
      : "This room is no longer 18+. Messages written while it was 18+ stay hidden from members under 18.");
  }
  await broadcastRoomState(io, db, room.id);
  // Minors' rails drop (or regain) the room on the refetch this pulse triggers.
  emitTreeChanged(io, room.serverId);
  return { ok: true, changed: true, isNsfw: value };
}

// NOTE: there is deliberately NO room-tier "roomAgeDenied" helper here. The
// HARD age denial for HTTP read routes is `boardAgeDenied` (forums/nsfw.ts),
// which layers the parent-forum flag on top of the room/server tiers — a
// room-only variant would silently skip the whole-forum tier for board
// rooms, so every route must use the board-aware entry point.
