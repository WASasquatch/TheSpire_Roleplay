import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  LinkedWorldRef,
  RoomOccupant,
  RoomSummary,
  ServerToClientEvents,
} from "@thekeep/shared";
import {
  clampAvatarCrop,
  DEFAULT_PRESENCE_TEMPLATES,
  renderPresenceTemplate,
} from "@thekeep/shared";
import {
  bans,
  characterEarning,
  characterOwnedFreeformBorders,
  characterOwnedNameStyles,
  characters,
  friends,
  messages,
  roomInvites,
  roomMembers,
  roomMods,
  roomWorldLinks,
  rooms,
  servers,
  userActiveCosmetics,
  userOwnedFreeformBorders,
  userOwnedNameStyles,
  userEarning,
  userServerLastRoom,
  users,
  worlds,
} from "../../db/schema.js";
import type { Db } from "../../db/index.js";
import { socketsForUsers } from "../presence.js";
import { markRoomRead } from "../../routes/roomReads.js";
import {
  greetNewcomerOnce,
  persistRoomDescriptionOnce,
  persistTargetedSystemMessageToActiveRooms,
} from "../targetedMessages.js";
import { blockedUserIdsFor, blocksAmong } from "../../auth/blocks.js";
import { isolationAmong, isolationHiddenSetFor, unionGraphInto } from "../../auth/ageIsolation.js";
import type { SessionUser } from "../../commands/types.js";
import { getSettings, areServersEnabledCached } from "../../settings.js";
import { getAway, clearAllAwayForUser } from "../awayState.js";
import { getMood, clearAllMoodForUser } from "../moodState.js";
import {
  checkpointFor,
  getTheater,
  hydrate as hydrateTheater,
  parseCheckpoint,
  parsePlaylist,
  serializeCheckpoint,
  theaterRoomIds,
  theaterSyncPayload,
} from "../theaterState.js";
import { DEFAULT_SERVER_ID, resolveRoomServerId } from "../../earning/pool.js";
import { serverAuthority } from "../../servers/authority.js";
import { userlistBadgesFor } from "../../servers/usergroups.js";
import { effectiveRoomNsfw } from "../../lib/nsfwRooms.js";
import { findLinkedAnnex } from "../../lib/roomLinks.js";
import { stampPairStaffView } from "../../lib/pairStaffView.js";
import { anyInfoRoomsExist, isInfoRoom, stampPostLocked } from "../../lib/postMode.js";
import { roleAccessDeniedFor, roleLockedRoomIdsForServer, stampAnnexRoleDenied } from "../../lib/roleGates.js";
import { tFor } from "../../i18n.js";
import { addSystemMessage, sendRoomBacklogTo } from "./persistence.js";
import { isHiddenIncognitoIdentity } from "./incognito.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Idle-ghost registry.
 *
 * Socket-level lifecycles don't map cleanly to user-level lifecycles. A user
 * sitting in a room can have their socket transiently drop and reconnect for
 * many reasons that have nothing to do with them logging in or out: tab
 * close + reopen, page refresh, background-throttled tabs, brief network
 * blips, server reload in dev, the socket.io heartbeat misfiring once. With
 * no grace, every blip would yank them out of the userlist + fire
 * "X has disconnected" / "X has connected" pairs, misleading both to the
 * affected user and to onlookers (it looks like they came and went, when
 * actually they were here the whole time).
 *
 * Instead, when a user's last socket disconnects without an explicit Exit
 * click, we keep an "idle ghost" per (room, identity) tuple. `currentOccupants`
 * merges ghosts into its output marked `idle: true` so the userlist still
 * renders the row (faded with an "(idle)" suffix on the client). The
 * disconnect is silent in chat. The ghost's room is held open against
 * `expireIfEmpty` so a private single-user room doesn't archive while its
 * only occupant is just refreshing.
 *
 * Lifetime is per-user, configurable via `site_settings.idleGraceMs`
 * (default 30 minutes). When the timer fires, the sweep clears every ghost
 * the user holds, runs `expireIfEmpty` on the affected rooms, and emits a
 * final `broadcastPresence` so the idle row finally disappears from every
 * viewer's rail. No "X has disconnected." line, silent end-to-end (the
 * opt-in announce happens at the immediate exit-click path, not here).
 *
 * On reconnect (or on the user choosing to log in elsewhere), the
 * `consumePendingDisconnect` path clears ALL of the user's ghosts and
 * rebroadcasts presence to each formerly-ghosted room so the idle row
 * vanishes cleanly. The same call returns true, which `joinRoom` reads as
 * "this is a reconnect, suppress the connected announcement."
 *
 * Why per-identity, not per-user: a user with two tabs voicing two
 * different characters in the same room shows two userlist rows (one per
 * identity). If only one tab closes, only that identity should ghost, the
 * other stays live. Per-identity keys preserve that asymmetry.
 *
 * Why a single timer per user (not per ghost): a user closing three tabs
 * across two rooms in quick succession should get one consolidated sweep
 * at the end of the window, not three sweeps. Each ghost addition resets
 * the user's timer to the configured grace.
 *
 * Memory is bounded by the number of identities currently in their idle
 * window. Entries self-clear via the timer or via the consume path.
 */
export type IdleGhost = {
  userId: string;
  characterId: string | null;
  roomId: string;
  /** Captured at ghost-creation time so callers don't need to re-resolve. Display data on the wire is rebuilt fresh by `currentOccupants` from the live DB row, not from this snapshot. */
  displayName: string;
};
function ghostKey(roomId: string, userId: string, characterId: string | null): string {
  return `${roomId}::${userId}::${characterId ?? ""}`;
}
const idleGhostsByKey = new Map<string, IdleGhost>();
const ghostKeysByUser = new Map<string, Set<string>>();
const ghostTimerByUser = new Map<string, NodeJS.Timeout>();

function trackGhost(g: IdleGhost): void {
  const key = ghostKey(g.roomId, g.userId, g.characterId);
  idleGhostsByKey.set(key, g);
  let keys = ghostKeysByUser.get(g.userId);
  if (!keys) {
    keys = new Set();
    ghostKeysByUser.set(g.userId, keys);
  }
  keys.add(key);
}

/**
 * True iff any ghost is currently held for the given room. Consulted by
 * `expireIfEmpty` so a room with only ghost occupants doesn't get archived
 * out from under them.
 */
export function hasIdleGhostsForRoom(roomId: string): boolean {
  const prefix = `${roomId}::`;
  for (const key of idleGhostsByKey.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Return the ghost identities for the given room. Consumed by
 * `currentOccupants` to merge ghosts into the live-socket presence before
 * the per-row joins run.
 */
export function getIdleGhostsForRoom(roomId: string): Array<{ userId: string; characterId: string | null }> {
  const prefix = `${roomId}::`;
  const out: Array<{ userId: string; characterId: string | null }> = [];
  for (const [key, g] of idleGhostsByKey) {
    if (key.startsWith(prefix)) {
      out.push({ userId: g.userId, characterId: g.characterId });
    }
  }
  return out;
}

/** Dump every idle ghost for the presence snapshot (graceful-shutdown
 *  persistence) so the next boot can re-show the same "(idle)" rows. */
export function exportIdleGhosts(): IdleGhost[] {
  return Array.from(idleGhostsByKey.values());
}

/** Re-register idle ghosts restored from a presence snapshot on boot. Reuses
 *  `registerIdleGhost`, so each re-tracked ghost (re)arms the per-user sweep
 *  timer at `idleGraceMs` from now — a returning user clears it silently via
 *  `consumePendingDisconnect`, a no-show is swept normally. */
export async function importIdleGhosts(db: Db, ghosts: IdleGhost[]): Promise<void> {
  for (const g of ghosts) {
    await registerIdleGhost(db, g);
  }
}

/**
 * Server-boot quiet window. The idle-ghost registry above only survives
 * inside a single process lifetime - any restart (tsx-watch reload in dev,
 * a real Fly deploy in prod) wipes it. Without a boot-grace, every client
 * that reconnects after the restart shows up looking like a fresh connect
 * and we paint a "has connected" line for each one - which is wrong both
 * semantically (they never left, the SERVER left) and visually (a single
 * dev-loop edit can spam dozens of these into the chat).
 *
 * So: for the first BOOT_GRACE_MS after this process starts, we suppress
 * "has connected" announcements entirely. Real fresh connects after the
 * window starts behaving normally. The trade-off in prod is that the very
 * first cohort of reconnects after a deploy aren't announced - which is
 * the desired behavior anyway, since those users were already in the room
 * before the deploy.
 */
const BOOT_GRACE_MS = 30_000;
const BOOT_TIME_MS = Date.now();
function isInBootGrace(): boolean {
  return Date.now() - BOOT_TIME_MS < BOOT_GRACE_MS;
}

/**
 * In-process tracker for "has this user already seen the description
 * for this room?" Joined the codebase to fix the "room description
 * fires every time I come back to the tab on mobile" complaint,
 * the prior implementation only suppressed re-emission during the
 * 20-second reconnect-grace window, so a longer suspension (screen
 * off for 30+ min) lost the marker and the description fired again
 * on the next join.
 *
 * Scope is per-process: keys are `userId`, values are sets of room
 * ids the user has seen the description for during this server's
 * lifetime. A process restart resets the map and users see each
 * room's description once again, acceptable, since restarts are
 * intentional and infrequent. If we ever need durable suppression
 * across restarts we'd promote this to a `user_seen_descriptions`
 * table.
 */
const seenDescriptions = new Map<string, Set<string>>();
function hasSeenDescription(userId: string, roomId: string): boolean {
  return seenDescriptions.get(userId)?.has(roomId) ?? false;
}
function markSeenDescription(userId: string, roomId: string): void {
  let set = seenDescriptions.get(userId);
  if (!set) {
    set = new Set();
    seenDescriptions.set(userId, set);
  }
  set.add(roomId);
}

/**
 * Drop every ghost the user currently holds, cancel their sweep timer, and
 * rebroadcast presence to each formerly-ghosted room so the idle row
 * vanishes from every viewer's rail. Returns true when at least one ghost
 * was cleared, `joinRoom` reads that as the reconnect signal and
 * suppresses the "X has connected." announcement.
 *
 * Awaited inside `joinRoom` before its own broadcast for the room being
 * joined. The double-broadcast for that one room is intentional and cheap:
 * the consume path emits the without-the-user state, then the join path
 * emits the with-the-user state. Net effect on the rail is the user
 * "returning" from idle to live, which is what we want.
 */
export async function consumePendingDisconnect(io: Io, db: Db, userId: string): Promise<boolean> {
  const keys = ghostKeysByUser.get(userId);
  if (!keys || keys.size === 0) {
    // Even with no ghosts, make sure any stray timer is cleared. Belt-and-
    // suspenders, the timer is only ever set alongside ghost entries, so
    // a leftover here would indicate a bookkeeping bug, but the cost of
    // the extra clear is nil.
    const t = ghostTimerByUser.get(userId);
    if (t) {
      clearTimeout(t);
      ghostTimerByUser.delete(userId);
    }
    return false;
  }
  const timer = ghostTimerByUser.get(userId);
  if (timer) {
    clearTimeout(timer);
    ghostTimerByUser.delete(userId);
  }
  const affectedRooms = new Set<string>();
  for (const key of keys) {
    const g = idleGhostsByKey.get(key);
    if (g) affectedRooms.add(g.roomId);
    idleGhostsByKey.delete(key);
  }
  ghostKeysByUser.delete(userId);
  for (const roomId of affectedRooms) {
    // Try to expire the room first, clearing the ghost may have left
    // it empty (no live sockets, no remaining ghosts). Without this,
    // a user-created public room they were the sole occupant of would
    // linger in the rooms tree as a zombie row: the ghost-sweep timer
    // (which would have archived it via expireIfEmpty after the grace
    // window) gets cancelled by this consume path, so the only
    // remaining archive trigger is a fresh occupant explicitly exiting
    // or switching rooms, neither of which is going to happen for an
    // unoccupied room.
    const expired = await expireIfEmpty(io, db, roomId);
    if (!expired) await broadcastPresence(io, db, roomId);
  }
  return true;
}

/**
 * Register a ghost for the given (room, identity) tuple and (re)arm the
 * user's sweep timer at `idleGraceMs`. Called by the disconnect handler
 * when a non-intentional disconnect leaves an identity with no live socket
 * in a room. Each new ghost extends the user's timer, three tabs closing
 * across two rooms get one consolidated sweep at the end, not three.
 *
 * The caller is responsible for the immediate `broadcastPresence` so the
 * idle row appears in onlookers' rails right away. We don't do it here
 * because the caller often has several rooms to ghost in one go and
 * batching the broadcasts (one per room, after all ghosts are tracked)
 * keeps `currentOccupants` from seeing partial state.
 */
export async function registerIdleGhost(
  db: Db,
  ghost: IdleGhost,
): Promise<void> {
  trackGhost(ghost);
  const { idleGraceMs } = await getSettings(db);
  const existing = ghostTimerByUser.get(ghost.userId);
  if (existing) clearTimeout(existing);
  const userId = ghost.userId;
  const timer = setTimeout(() => {
    // Move this into a fire-and-forget async closure, setTimeout can't
    // await directly, and uncaught rejections here would crash the
    // process. The sweep runs the same per-room cleanup the old grace
    // window did (expireIfEmpty + broadcastPresence) so a now-empty
    // room finally archives and the rail finally drops the idle row.
    (async () => {
      const keys = ghostKeysByUser.get(userId);
      ghostTimerByUser.delete(userId);
      if (!keys) return;
      const affectedRooms = new Set<string>();
      for (const key of keys) {
        const g = idleGhostsByKey.get(key);
        if (g) affectedRooms.add(g.roomId);
        idleGhostsByKey.delete(key);
      }
      ghostKeysByUser.delete(userId);
      // Lazy-import io from the ghost record's callback context isn't
      // possible, we need it here. The disconnect handler captures `io`
      // at ghost-creation time via a closure (see index.ts).
      // Instead we accept that this sweep needs io passed in. To keep
      // the public API simple, we stash io on the first ghost call;
      // re-stash on each call so an io rebind (unlikely) is honored.
      const io = sweepIo;
      if (!io) return;
      for (const roomId of affectedRooms) {
        try {
          const expired = await expireIfEmpty(io, db, roomId);
          if (!expired) await broadcastPresence(io, db, roomId);
        } catch { /* swallow, sweep must not crash */ }
      }
      // The user idled out without returning within the grace window, so the
      // transient session signals (away + mood) that the disconnect handler
      // deliberately LEFT in place — so a quick reconnect could keep your
      // /away mark — are finally safe to drop for a clean next-login slate.
      // Guard on still-offline: a sibling tab on another identity may have
      // reconnected while this ghost sat out its window in a different room.
      try {
        if (!(await userIsOnline(io, userId))) {
          clearAllAwayForUser(userId);
          clearAllMoodForUser(userId);
        }
      } catch { /* swallow, sweep must not crash */ }
    })().catch(() => {});
  }, idleGraceMs);
  ghostTimerByUser.set(userId, timer);
}

/**
 * Module-local io handle for the ghost-sweep timer. Set the first time
 * `setGhostSweepIo` is called (during boot wiring). The sweep timer
 * captures io via this reference rather than via per-ghost closure so the
 * `registerIdleGhost` signature stays small.
 */
let sweepIo: Io | null = null;
export function setGhostSweepIo(io: Io): void {
  sweepIo = io;
}
/**
 * Resolve the canonical landing room. Used by every "where do we put this
 * user" path: cold-connect with no sibling tab and no last-room memory,
 * kick / ban relocation, and admin room-delete.
 *
 * Resolution order:
 *   1. The admin-flagged default room (rooms.is_default = 1). Exactly one
 *      row carries the flag thanks to the partial unique index. This is
 *      the source of truth on any post-migration install.
 *   2. Legacy fallback by name (`The_Spire`) for installs that haven't
 *      yet flipped the flag, the seed migrates them on next boot, but
 *      this guards the gap.
 *   3. The alphabetically-first system room as a last resort so a
 *      malformed install (no default, no Spire) still lands users
 *      somewhere deterministic instead of SQLite's natural row order.
 *
 * Info rooms (post_mode = 'staff') are skipped at every tier: they are
 * read-only channels that DISPLAY no occupants, so a landing there would
 * park arrivals in a room where nobody can see (or talk to) them.
 */
export async function findCanonicalLanding(db: Db): Promise<typeof rooms.$inferSelect | null> {
  const defaulted = (await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.isDefault, true), ne(rooms.postMode, "staff")))
    .limit(1))[0];
  if (defaulted) return defaulted;
  const named = (await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.name, "The_Spire"), ne(rooms.postMode, "staff")))
    .limit(1))[0];
  if (named) return named;
  const fallback = (await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.isSystem, true), ne(rooms.postMode, "staff")))
    .orderBy(asc(rooms.name))
    .limit(1))[0];
  return fallback ?? null;
}

/**
 * Liveliest-room landing for a brand-new account's FIRST-EVER socket landing
 * (migration 0353, retention package). Instead of parking every newcomer in
 * the fixed canonical lobby — which is empty half the day — prefer the
 * default-server public room with the most recent HUMAN chat, so their first
 * screen has a conversation on it.
 *
 * Candidate gates compose with every existing scrub, viewer-agnostically:
 *   - public, live (not archived), on the default server (NULL serverId is
 *     adopted by the default server everywhere — same predicate as /rooms)
 *   - flat chat only: no forum boards (forumId) and no standalone
 *     nested-mode rooms (their feed is a topic list, hostile to a newcomer)
 *   - SFW only (room flag; the default server is SFW by invariant), so the
 *     pick is safe for minors without viewer plumbing
 *   - never an 18+ annex (linkedRoomId)
 *   - never role-locked (room_role_gates kind='access')
 * The CALLER additionally re-validates the winner through its own join gates
 * (ban / private / age), so a race can only degrade to the canonical landing.
 *
 * "Human chat" = speech kinds within the last 24h; system/whisper/announce
 * lines don't make a room feel alive. One grouped query over the recent
 * window plus one bounded role-gate read; runs only on a first-ever landing.
 *
 * Returns null when nothing qualifies (quiet day) — callers fall back to
 * their existing landing resolution unchanged.
 */
export async function findLiveliestLanding(db: Db): Promise<typeof rooms.$inferSelect | null> {
  const HUMAN_KINDS = ["say", "me", "ooc", "roll", "npc", "scene"] as const;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({ room: rooms, lastHuman: sql<number>`max(${messages.createdAt})` })
    .from(messages)
    .innerJoin(rooms, eq(rooms.id, messages.roomId))
    .where(and(
      gt(messages.createdAt, cutoff),
      inArray(messages.kind, [...HUMAN_KINDS]),
      eq(rooms.type, "public"),
      isNull(rooms.archivedAt),
      isNull(rooms.forumId),
      isNull(rooms.linkedRoomId),
      eq(rooms.replyMode, "flat"),
      eq(rooms.isNsfw, false),
      // Never an info room (post_mode 'staff'): read-only, displays nobody —
      // hostile as a first screen even when its announcements are recent.
      ne(rooms.postMode, "staff"),
      or(eq(rooms.serverId, DEFAULT_SERVER_ID), isNull(rooms.serverId)),
    ))
    .groupBy(rooms.id)
    .orderBy(desc(sql`max(${messages.createdAt})`))
    .limit(5);
  if (candidates.length === 0) return null;
  const locked = await roleLockedRoomIdsForServer(db, candidates.map((c) => c.room.id));
  const hit = candidates.find((c) => !locked.has(c.room.id));
  return hit?.room ?? null;
}

/**
 * Server-scoped sibling of `findCanonicalLanding` (multi-server feature,
 * plan §7.3/§7.7). Resolves the room a user should land in WITHIN a single
 * server. Resolution order mirrors the canonical resolver but is filtered
 * to `serverId`:
 *
 *   1. The default-flagged room (`rooms.is_default = 1`) that belongs to
 *      this server. Post-Phase-2 each server carries at most one such row.
 *   2. The oldest system room (`rooms.is_system = 1`) in this server, so a
 *      server with no explicit default still lands users somewhere
 *      deterministic instead of on SQLite's natural row order.
 *
 * Returns null when the server has no joinable system room at all (caller
 * degrades to its next placement tier). This is NEVER consulted on the
 * flag-off path: the connection handler only calls it when serversEnabled
 * is true, so `findCanonicalLanding` remains the sole resolver today.
 */
export async function findServerLanding(
  db: Db,
  serverId: string,
  opts: { skipArchivedDefault?: boolean } = {},
): Promise<typeof rooms.$inferSelect | null> {
  // NOTE: the default room may come back ARCHIVED (pre-fix servers whose
  // front door got auto-parked). Callers that hand the id to a client for
  // joining must heal it first (see the /visit route) — a parked landing
  // 404s the join and bounces the visitor back to the home server.
  // Callers that CANNOT heal (display-only resolution like the reader-
  // attribution anchor) pass `skipArchivedDefault` so tier 1 falls through
  // to the live-room tiers instead of handing back a dead landing.
  //
  // Role-locked rooms (room_role_gates kind='access', migration 0349) are
  // skipped at EVERY tier: the landing is where arbitrary members get
  // placed, so a room most of the server can't even see must never be it.
  // Info rooms (post_mode 'staff') are skipped at every tier for the same
  // reason as findCanonicalLanding: read-only channels display no
  // occupants, so a landing there strands arrivals invisibly.
  // Tiers resolve LAZILY — the overwhelmingly common case (default room
  // exists, no access gate) costs one indexed rooms read plus one gate
  // read, and the wider fallback scans only run when an earlier tier is
  // missing or fully locked.
  const defaulted = (await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.isDefault, true), eq(rooms.serverId, serverId)))
    .limit(1))[0];
  if (
    defaulted
    && !isInfoRoom(defaulted)
    && !(opts.skipArchivedDefault && defaulted.archivedAt)
    && !(await roleLockedRoomIdsForServer(db, [defaulted.id])).has(defaulted.id)
  ) {
    return defaulted;
  }
  // Fallbacks must be LIVE rooms: an archived non-default row can't be
  // healed by the visit path (only the default room is unambiguously the
  // server's structure), so it would be a guaranteed dead landing.
  const fallbacks = await db
    .select()
    .from(rooms)
    .where(and(
      eq(rooms.isSystem, true),
      eq(rooms.serverId, serverId),
      isNull(rooms.archivedAt),
      ne(rooms.postMode, "staff"),
    ))
    .orderBy(asc(rooms.name));
  if (fallbacks.length > 0) {
    const locked = await roleLockedRoomIdsForServer(db, fallbacks.map((c) => c.id));
    const hit = fallbacks.find((c) => !locked.has(c.id));
    if (hit) return hit;
  }
  // Last resort: ANY live public room in the server, so a server whose
  // owner unset/deleted the default still has a working front door.
  const anyLive = await db
    .select()
    .from(rooms)
    .where(and(
      eq(rooms.serverId, serverId),
      eq(rooms.type, "public"),
      isNull(rooms.archivedAt),
      isNull(rooms.forumId),
      isNull(rooms.linkedRoomId),
      ne(rooms.postMode, "staff"),
    ))
    .orderBy(asc(rooms.name));
  if (anyLive.length > 0) {
    const locked = await roleLockedRoomIdsForServer(db, anyLive.map((c) => c.id));
    const hit = anyLive.find((c) => !locked.has(c.id));
    if (hit) return hit;
  }
  return null;
}

/**
 * The single chokepoint for the "your rooms tree is stale" pulse (multi-
 * server feature, plan §7.8). Every site that used to call the bare
 * `io.emit("rooms:tree-changed")` routes through here instead.
 *
 * Flag-OFF (the default) OR no server in hand: behaves EXACTLY like the
 * old bare emit — a single global `io.emit("rooms:tree-changed")`, nothing
 * else. This is the byte-identical path a reviewer diffs against.
 *
 * Flag-ON with a known `serverId`: emit the scoped `server:tree-changed`
 * to that server's socket band so clients viewing OTHER servers ignore it,
 * AND dual-emit the bare `rooms:tree-changed` globally so older client
 * bundles (which never learned server scoping) still refresh. Old clients
 * see today's behavior; new clients additionally get the scoped pulse.
 */
export function emitTreeChanged(io: Io, serverId?: string | null): void {
  // Flag-off, or no server in hand → the exact bare global emit, unchanged.
  if (!serverId || !areServersEnabledCached()) {
    io.emit("rooms:tree-changed");
    return;
  }
  // Flag-on with a known server: scoped pulse to that server's socket band,
  // PLUS the bare global emit for old bundles (plan §7.8).
  io.to(`server:${serverId}`).emit("server:tree-changed", { serverId });
  io.emit("rooms:tree-changed");
}
/**
 * Per-socket joinRoom serialization queue. socket.io's per-socket
 * event dispatch processes events in order, but it does NOT wait for
 * async handlers to finish before dispatching the next event. The
 * room:join handler is async and contains many awaits (auth checks,
 * membership lookups, presence-template fetches, broadcastPresence
 * calls). Without this lock, two rapid room:join events from the
 * same socket interleave: handler A captures priorRooms = [The_Spire]
 * and calls socket.leave; while A yields on the next await, handler
 * B captures priorRooms = [] (A already left), skips the leave loop,
 * and socket.joins its target. A then resumes and socket.joins ITS
 * target. The socket ends up in both target rooms, the userlist shows
 * the user in both rooms, and the per-room join/leave broadcasts go
 * to the wrong rooms.
 *
 * The fix is a per-socket promise chain: each new joinRoom awaits the
 * previous one's completion before starting its own work. socket.io
 * already wraps each socket with a unique object, so a WeakMap keyed
 * on the socket gives us per-socket isolation that cleans up
 * automatically on disconnect.
 */
const joinRoomQueue = new WeakMap<Sock, Promise<void>>();

export async function joinRoom(
  io: Io,
  db: Db,
  socket: Sock,
  user: SessionUser,
  roomId: string,
  opts: { passwordOk?: boolean } = {},
): Promise<void> {
  // Chain this call onto the socket's queue. The queued promise
  // resolves AFTER the previous joinRoom finishes (or after a
  // resolved promise if there's no in-flight one). We then await
  // the chain head before doing any work. The new promise we store
  // back into the WeakMap covers BOTH waiting for the previous one
  // AND running our own body, so the NEXT call's await sees the
  // tail of our work and not the head.
  const prev = joinRoomQueue.get(socket) ?? Promise.resolve();
  let release: () => void = () => {};
  const ours = new Promise<void>((res) => { release = res; });
  joinRoomQueue.set(socket, prev.then(() => ours));
  try {
    await prev;
    await joinRoomBody(io, db, socket, user, roomId, opts);
  } finally {
    release();
  }
}

async function joinRoomBody(
  io: Io,
  db: Db,
  socket: Sock,
  user: SessionUser,
  roomId: string,
  opts: { passwordOk?: boolean } = {},
): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) {
    socket.emit("error:notice", { code: "NO_ROOM", message: tFor(user.locale, "errors:server.realtime.roomNotFound") });
    return;
  }
  if (room.archivedAt) {
    if (!room.isSystem && room.ownerId === user.id) {
      // OWNER SELF-HEAL. The auto-parker (expireIfEmpty) archives a
      // user room the moment it sits empty, and only the /go-by-NAME
      // create path resurrected it. Every join-by-ID path (tab
      // restore, reconnect, rail click, slug link) hit the 404 below
      // instead — so an owner who made a room, left, and came back
      // through any of those landed in a stale view of a room the
      // server considered gone, invisible in everyone's rail. Revive
      // the row in place for its CURRENT owner: no ownership
      // transfer and no member/ban/invite wipe (that reset belongs
      // to the name-resurrect TAKEOVER in room.ts, where ownership
      // changes hands). Non-owners still 404: a parked room stays
      // parked until its owner returns or someone claims the name.
      await db
        .update(rooms)
        .set({ archivedAt: null, archiveHiddenAt: null })
        .where(eq(rooms.id, room.id));
      room.archivedAt = null;
      room.archiveHiddenAt = null;
      // Rails everywhere just gained a room back.
      emitTreeChanged(io, room.serverId);
    } else {
      // Stale id from before the room auto-archived. The room is
      // effectively gone to end users; the row only exists to preserve
      // settings for a future same-name resurrect via the create path.
      // Treat as 404 for this socket.
      socket.emit("error:notice", { code: "NO_ROOM", message: tFor(user.locale, "errors:server.realtime.roomNotFound") });
      return;
    }
  }

  // Forum boards live ENTIRELY in the Forums Catalog (Forums revamp,
  // Phase 1C): reading and posting happen in the modal over HTTP +
  // forum:post, never by occupying the room. Chat joins are therefore
  // refused outright — for everyone — so a board can never appear as
  // someone's "current room", leak into presence, or pull forum
  // interactions back into chat. Legacy sessions whose lastRoomId is a
  // board fall through to the canonical landing on reconnect.
  if (room.forumId) {
    socket.emit("error:notice", {
      code: "FORUM_BOARD",
      message: tFor(user.locale, "errors:server.realtime.forumBoardRefusal"),
    });
    return;
  }

  // HARD age gate (age-restriction plan, Phase 2): an 18+ room refuses
  // minors outright — no password, invite, membership, or staff role gets
  // a minor account past this. Adults always pass, hide preference or not.
  // The EFFECTIVE rating (room flag OR its server's) is checked here, like
  // every other surface (rail listing, by-slug, read routes, reconnect
  // placement): the serversEnabled block below also folds the server flag
  // into canParticipate, but that block is skipped entirely when the
  // servers feature is toggled OFF — and an 18+ SERVER's rooms must stay
  // refused by id even then, or they'd be hidden-but-joinable.
  if (!user.isAdult && (await effectiveRoomNsfw(db, room))) {
    socket.emit("error:notice", {
      code: "AGE_RESTRICTED",
      message: tFor(user.locale, "errors:server.realtime.adultsOnlyRoom"),
    });
    return;
  }

  const banned = (await db
    .select()
    .from(bans)
    .where(and(eq(bans.roomId, roomId), eq(bans.userId, user.id)))
    .limit(1))[0];
  if (banned && (!banned.until || +banned.until > Date.now())) {
    socket.emit("error:notice", { code: "BANNED", message: tFor(user.locale, "errors:server.realtime.banishedFromRoom") });
    return;
  }

  // Per-server gate: a SUB-server's ban and join mode (application/invite) are
  // enforced on join, mirroring the HTTP path (schema.ts contract) so a server
  // ban isn't just a one-time live-socket eviction a reconnect can bypass. The
  // default/system server keeps the legacy global behavior (its membership is
  // "any signed-in user"), and the flag-off path is byte-identical.
  if (areServersEnabledCached() && room.serverId && room.serverId !== DEFAULT_SERVER_ID) {
    const sa = await serverAuthority(db, user, room.serverId);
    if (!sa.canParticipate) {
      // Age fold: serverAuthority zeroes canParticipate for a minor on an
      // 18+ server. Surface that as the same "adults only" refusal a
      // room-level flag gives, not the misleading "join first" copy.
      const ageBlocked = !!sa.server?.isNsfw && !user.isAdult;
      socket.emit("error:notice", {
        code: ageBlocked ? "AGE_RESTRICTED" : sa.ban ? "SERVER_BANNED" : "SERVER_NO_ACCESS",
        message: ageBlocked
          ? tFor(user.locale, "errors:server.realtime.adultsOnlyRoom")
          : sa.ban
            ? tFor(user.locale, "errors:server.servers.banned")
            : tFor(user.locale, "errors:server.realtime.joinServerFirst"),
      });
      return;
    }
  }

  // Role-locked rooms (room_role_gates, migration 0349): any kind='access'
  // row restricts entry to holders of one of those usergroups (plus site
  // staff, server staff and the room owner — the helper's built-in
  // bypasses). Refused with the SAME NO_ROOM shape a nonexistent room
  // gives, so a role-locked room's existence never leaks — mirroring the
  // by-slug 404 contract. Composes with every gate above and the private
  // gate below: each must independently pass.
  {
    const { roleAccessDeniedFor } = await import("../../lib/roleGates.js");
    if (await roleAccessDeniedFor(db, user, room)) {
      socket.emit("error:notice", { code: "NO_ROOM", message: tFor(user.locale, "errors:server.realtime.roomNotFound") });
      return;
    }
  }

  // Private rooms: owner always in; otherwise need either a valid password OR
  // an outstanding /invite. /invite acts as a per-user whitelist that lets the
  // user skip the password prompt. UNEXPIRED invites only: the row carries a
  // 24h expiresAt that this gate previously never read, which quietly made
  // every invite a forever-key (a re-invite refreshes the window).
  if (room.type === "private" && room.ownerId !== user.id) {
    const invite = opts.passwordOk
      ? null
      : (await db
          .select()
          .from(roomInvites)
          .where(
            and(
              eq(roomInvites.roomId, roomId),
              eq(roomInvites.invitedUserId, user.id),
              gt(roomInvites.expiresAt, new Date()),
            ),
          )
          .limit(1))[0];
    const member = (await db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)))
      .limit(1))[0];
    const allowed = opts.passwordOk || !!invite || !!member;
    if (!allowed) {
      socket.emit("ui:hint", {
        kind: "prompt-room-password",
        roomId: room.id,
        roomName: room.name,
      });
      return;
    }
  }

  // Upsert membership (best-effort). SQLite/Drizzle: use onConflictDoNothing.
  await db
    .insert(roomMembers)
    .values({ roomId, userId: user.id, role: "member" })
    .onConflictDoNothing();

  // Capture state BEFORE we mutate socket.rooms so we can tell:
  //   1. whether this is a fresh connect (no prior live socket of this user
  //      anywhere) - drives "X has connected" vs "X arrived";
  //   2. which rooms this socket is leaving - drives "X left." in each.
  const userWasOnlineBefore = await userIsOnline(io, user.id, socket.id);

  // Resolve the per-identity room-presence templates ONCE per join.
  // Character-active rooms read the character's OWN templates only;
  // OOC (no active character) reads the master's. We deliberately do
  // NOT fall back character -> master: the custom entrance/exit flair
  // is bought per identity, so an OOC-purchased template must never
  // leak onto a character that never bought (or enabled) one. Null on
  // the chosen source = use the default phrasing. The session-presence
  // templates are master-only.
  // Reads are bounded, one row from each table the user touches.
  // Presence templates are per-server cosmetics: read from THIS room's
  // server (flag-off: room.serverId is null/the default, so this is the
  // single existing pool — byte-identical to today).
  const joinServerId = room.serverId ?? DEFAULT_SERVER_ID;
  const presenceMaster = (await db
    .select({
      roomJoinTemplate: userEarning.roomJoinTemplate,
      roomLeaveTemplate: userEarning.roomLeaveTemplate,
      sessionConnectTemplate: userEarning.sessionConnectTemplate,
    })
    .from(userEarning)
    .where(and(eq(userEarning.serverId, joinServerId), eq(userEarning.userId, user.id)))
    .limit(1))[0] ?? null;
  const presenceCharacter = user.activeCharacterId
    ? (await db
        .select({
          roomJoinTemplate: characterEarning.roomJoinTemplate,
          roomLeaveTemplate: characterEarning.roomLeaveTemplate,
        })
        .from(characterEarning)
        .where(and(eq(characterEarning.serverId, joinServerId), eq(characterEarning.characterId, user.activeCharacterId)))
        .limit(1))[0] ?? null
    : null;
  // `presenceCharacter` is non-null only when a character is active, so
  // its presence is the in-character signal. When OOC it's null and we
  // fall through to the master row; when in-character we use ONLY the
  // character's columns (null -> default), never the master's.
  const roomJoinTemplate = user.activeCharacterId
    ? (presenceCharacter?.roomJoinTemplate ?? null)
    : (presenceMaster?.roomJoinTemplate ?? null);
  const roomLeaveTemplate = user.activeCharacterId
    ? (presenceCharacter?.roomLeaveTemplate ?? null)
    : (presenceMaster?.roomLeaveTemplate ?? null);
  const sessionConnectTemplate = presenceMaster?.sessionConnectTemplate ?? null;
  // Reconnect detection: if a "has disconnected" was scheduled for this user
  // and hasn't fired yet, this connect is a reconnect inside the grace window.
  // Sweep any idle ghosts the user was holding. Returns true when at
  // least one was cleared, we read that as "this is a reconnect inside
  // the idle window" and use it further down to suppress the "X has
  // connected." message + the room description re-emit. The same call
  // also rebroadcasts presence to each formerly-ghosted room so onlookers
  // see the idle row vanish (the current-room re-broadcast a few lines
  // later overlays the live state on top of it for THIS room).
  const isReconnect = await consumePendingDisconnect(io, db, user.id);
  const priorRooms = [...socket.rooms]
    .filter((r) => r.startsWith("room:") && r !== `room:${roomId}`)
    .map((r) => r.slice(5));

  // Phantom presence (info rooms display no readers). Stamp the reading /
  // anchor state for THIS join before anything broadcasts:
  //   - entering an info room from a normal room anchors the presence to
  //     that normal room (an info→info hop keeps the original anchor, so
  //     the walk-back always lands on the last NORMAL room);
  //   - entering any normal room clears both stamps and resumes ordinary
  //     presence.
  // The pre-move state is captured first: it drives the "returning to the
  // room everyone still sees you in" announce suppression below and the
  // prompt anchor-room repaints after the join broadcast.
  const presenceData = socket.data as ReaderSocketData;
  // Stale-stamp guard (same band check the render pass applies): a
  // relocate (kick/boot/evict/room-delete) moves this socket's bands
  // without a joinRoom pass, so a surviving stamp may describe an info
  // room the socket no longer holds. Treating it as live would skip the
  // anchor update below AND wrongly suppress the arrival announce via
  // `returningToAnchor`, so clear it before reading.
  if (
    presenceData.presenceInfoRoomId
    && !socket.rooms.has(`room:${presenceData.presenceInfoRoomId}`)
  ) {
    presenceData.presenceInfoRoomId = null;
    presenceData.presenceAnchorRoomId = null;
  }
  const wasReadingInfo = !!presenceData.presenceInfoRoomId;
  const priorAnchorRoomId = presenceData.presenceAnchorRoomId ?? null;
  const enteringInfo = isInfoRoom(room);
  if (enteringInfo) {
    if (!wasReadingInfo) presenceData.presenceAnchorRoomId = priorRooms[0] ?? null;
    presenceData.presenceInfoRoomId = roomId;
  } else {
    presenceData.presenceInfoRoomId = null;
    presenceData.presenceAnchorRoomId = null;
  }

  // Drop the user from any previous room before joining the new one.
  // Per-room "X has left the room." chat broadcasts fire on real
  // room switches, but ONLY when no OTHER socket of this account
  // remains in the room being left, `userHasSocketInRoom` is the
  // multi-tab gate. If the user has another tab still parked in
  // the old room (desktop tab stays put while phone tab moves;
  // second browser window) the move from THIS socket isn't a real
  // "departure" and we stay silent; userlist update via
  // `broadcastPresence` is the visible signal regardless. Boot
  // grace and forum rooms suppress the broadcast. Note we do NOT
  // gate on `isReconnect` here: a real room switch always comes
  // through the explicit room:join event on a live socket, so
  // `consumePendingDisconnect` having found stale ghosts elsewhere
  // (a tab the user closed minutes ago in a different room)
  // shouldn't mute the current move. Same rationale for the entry
  // broadcast below.
  for (const prevId of priorRooms) {
    socket.leave(`room:${prevId}`);
    const expired = await expireIfEmpty(io, db, prevId);
    if (expired) continue;
    await broadcastPresence(io, db, prevId);
    const stillThere = await userHasSocketInRoom(io, user.id, prevId);
    if (stillThere || isInBootGrace()) continue;
    // Incognito gate: room transitions stay silent for an incognito
    // moderator, the whole point is they can drift across rooms
    // without trace. Their "X has left the chat" line already
    // broadcast at the moment they went incognito. Scoped to the
    // identity they went incognito AS, so a leave broadcast for a
    // DIFFERENT character on another tab still fires.
    const _leaveTabRaw = (socket.data as { tabCharId?: string | null }).tabCharId;
    const _leaveCharId = _leaveTabRaw !== undefined ? _leaveTabRaw : (user.activeCharacterId ?? null);
    if (isHiddenIncognitoIdentity(user, _leaveCharId)) continue;
    const prevRoom = (await db.select().from(rooms).where(eq(rooms.id, prevId)).limit(1))[0];
    if (!prevRoom || prevRoom.replyMode === "nested") continue;
    // Info-room silence (phantom presence): departures are never announced
    // in a room that displays nobody; and a move INTO an info room is not
    // a departure at all — the mover keeps their displayed presence in
    // this room via the anchor attribution, so a "has left" line would
    // contradict the userlist.
    if (enteringInfo || isInfoRoom(prevRoom)) continue;
    await addSystemMessage(io, db, prevId, renderPresenceTemplate(
      roomLeaveTemplate,
      DEFAULT_PRESENCE_TEMPLATES.roomLeave,
      { name: user.displayName, room: prevRoom.name },
    ));
  }

  socket.join(`room:${roomId}`);

  // Staff pair oversight (lib/pairStaffView.ts): stamp whether THIS socket,
  // standing in THIS room, gets the merged two-channel view. Cached on
  // socket.data so the hot summary paths (summaryFor / sendRoomStateTo)
  // read it without queries; recomputed on every join, so toggling sides
  // or switching rooms refreshes it.
  await stampPairStaffView(db, socket, user, roomId);

  // Read-only posting mode (lib/postMode.ts): stamp whether THIS socket may
  // post in THIS room, cached on socket.data exactly like pairStaffView so
  // the hot summary paths never re-query. 'everyone' rooms short-circuit
  // inside the helper (no queries).
  await stampPostLocked(db, socket, user, room);

  // Role-gated annex scrub (lib/roleGates.ts): stamp whether this viewer is
  // denied the room's 18+ annex, so the summary paths can null the
  // `linkedNsfwRoomId` pointer per-socket the way GET /rooms does — the
  // console can gate the annex alone, and the pointer would otherwise
  // re-leak the annex's existence on every room:state broadcast.
  await stampAnnexRoleDenied(db, socket, user, roomId);

  // Multi-server socket banding (plan §7). Each socket joins a
  // `server:<serverId>` band alongside its `room:` band so server-scoped
  // broadcasts (emitTreeChanged's `server:tree-changed`) reach exactly the
  // sockets viewing that server. On a cross-server move we drop the old
  // band first so a socket never lingers in two servers' bands at once.
  //
  // GATED on the servers feature: when off we touch NO bands at all, so the
  // socket's room membership set is byte-identical to today and every
  // existing broadcast path is unaffected.
  if (areServersEnabledCached()) {
    const targetServerBand = room.serverId ? `server:${room.serverId}` : null;
    for (const band of socket.rooms) {
      if (band.startsWith("server:") && band !== targetServerBand) socket.leave(band);
    }
    if (targetServerBand) socket.join(targetServerBand);
    // Per-(user, server) last-room memory (plan §7.4). Upsert the room the
    // user is now in for this server so a later same-server placement can
    // restore it ahead of the account-global users.lastRoomId fallback.
    // Only meaningful when the room actually belongs to a server.
    if (room.serverId) {
      await db
        .insert(userServerLastRoom)
        .values({ userId: user.id, serverId: room.serverId, roomId })
        .onConflictDoUpdate({
          target: [userServerLastRoom.userId, userServerLastRoom.serverId],
          set: { roomId, updatedAt: new Date() },
        });
    }
  }

  socket.data.roomId = roomId;
  // Cache the room's server on the socket so command dispatch + inline `!cmd`
  // expansion can scope custom commands to THIS server without a per-message DB
  // read. Updated on every join, so it never goes stale on a room switch.
  (socket.data as { serverId?: string }).serverId = room.serverId ?? DEFAULT_SERVER_ID;
  // Persist as the account-global last-room slot on EVERY join, not
  // just on the disconnect path. Mobile suspension can lose the per-
  // tab sessionStorage cache (iOS reaping the tab from memory wipes
  // it), and the disconnect-side write is only made on
  // `fullyOffline=true`, so a stale sibling socket anywhere (a
  // forgotten desktop tab, a second phone tab) would have caused the
  // mobile disconnect to skip the lastRoomId write, leaving the DB
  // pointing at whatever room the user logged in to days ago. Writing
  // here is idempotent (UPDATE to the same value when unchanged) and
  // cheap (one row, indexed PK). Mirrors the per-tab cache update the
  // client already does via `rememberTabRoom` on `room:state`.
  await db.update(users).set({ lastRoomId: roomId }).where(eq(users.id, user.id));
  // Per-channel read marker (migration 0318). Entering a room clears its
  // unread: advance the user's `room_reads` high-water mark to now and pulse
  // `room:unread {unread:0}` so every tab drops the dot for this room. Fire-and-
  // forget + best-effort — a stuck read marker must never block the join.
  void markRoomRead(io, db, user.id, roomId, null).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[room-reads] join read-marker failed", { roomId, userId: user.id, err });
  });
  // One occupant rebuild + one block graph for BOTH room:state and
  // presence:update (was two sequential broadcasts, each rebuilding the
  // userlist). Emits both wire events, same as before.
  await broadcastRoomStateAndPresence(io, db, roomId);

  // Phantom-presence repaints. The attribution pass only counts sockets
  // that already hold the info room's band, so the leave-loop broadcast
  // above ran BEFORE this socket's attribution could apply. Repaint the
  // anchor room now that the join is complete:
  //   - entering an info room → the anchor gains the attributed (reading)
  //     row;
  //   - leaving one for a normal room → the OLD anchor drops it (skipped
  //     when the destination IS that anchor: the join broadcast above
  //     already repainted it).
  // Best-effort: the tree pulse + 20s poll are the backstop either way.
  if (enteringInfo && !wasReadingInfo && presenceData.presenceAnchorRoomId) {
    await broadcastPresence(io, db, presenceData.presenceAnchorRoomId).catch(() => {});
  } else if (wasReadingInfo && !enteringInfo && priorAnchorRoomId && priorAnchorRoomId !== roomId) {
    await broadcastPresence(io, db, priorAnchorRoomId).catch(() => {});
  }

  // Send recent backlog to just this socket. Whisper privacy + ignore
  // filtering + soft-delete blanking all live in sendRoomBacklogTo so the
  // moderation-relocate path uses the same logic.
  //
  // The arrival announcement is emitted AFTER the backlog so the joining
  // socket doesn't see it twice (once in backlog, once via room broadcast).
  await sendRoomBacklogTo(socket, db, roomId, user.id);

  // Theater rooms: snap this socket to the room's live playback state so
  // a late joiner lands on the current source + position rather than the
  // playlist's first frame. No-op when nothing has played yet.
  {
    const tp = theaterSyncPayload(roomId);
    if (tp) socket.emit("theater:sync", tp);
  }

  // Room description: fire ONCE per (user, room) over the lifetime of
  // this process. Previously we only suppressed on reconnect-inside-
  // grace, so a long mobile suspension (screen off past the 20s grace)
  // dropped the marker and the description re-fired on the next
  // joinRoom. The `seenDescriptions` map persists across reconnects
  // for the life of the server, so a returning mobile tab now only
  // sees the description on its *original* entry.
  //
  // Forum rooms still skip the description entirely, the topic feed
  // isn't a chat log, and other UI affordances surface the description
  // there.
  if (room.description && !hasSeenDescription(user.id, roomId) && room.replyMode !== "nested") {
    markSeenDescription(user.id, roomId);
    // Persist a per-user copy so the line survives a buffer-replacing
    // refetch. `isNew` is true only on the genuinely first view; on a
    // process restart the in-memory seen-set resets but the persisted
    // copy already rides the backlog (sent just above), so we must NOT
    // re-emit the live line then or the user sees it twice.
    const isNew = await persistRoomDescriptionOnce(db, user.id, roomId, `[Description]: ${room.description}`);
    if (isNew) {
      socket.emit("message:new", {
        id: `desc-${nanoid()}`,
        roomId,
        userId: "system",
        characterId: null,
        displayName: "system",
        kind: "system",
        body: `[Description]: ${room.description}`,
        color: null,
        createdAt: Date.now(),
      });
    }
  }

  // One-time personal greeter (migration 0353): a brand-new account's first
  // flat-room landing gets a targeted, actionable welcome line. Runs AFTER
  // the backlog + description sends so the live copy lands last (like the
  // description's isNew emit); the atomic greeted_at claim inside makes this
  // a no-op for everyone but a genuinely never-greeted account, so the hot
  // join path pays one indexed UPDATE that matches zero rows. Forum rooms
  // skip it — their feed is a topic list, not a chat log. Best-effort: a
  // greeter failure must never break the join.
  // Info rooms also skip the greeter: the welcome is a "say something
  // here" prompt, and a read-only room can't take the reply. The atomic
  // greeted_at claim stays unconsumed, so the greeting fires in the
  // newcomer's first NORMAL room instead.
  if (room.replyMode !== "nested" && !enteringInfo) {
    try {
      await greetNewcomerOnce(db, socket, { id: user.id, username: user.username }, { id: roomId, name: room.name });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[greeter] first-landing greeting failed", { userId: user.id, roomId, err });
    }
  }

  // Entry/connect chat broadcast. Three mutually-exclusive cases,
  // distinguished by `loginIntent` (fresh login/register handshake)
  // and `priorRooms.length` (was this socket already in another
  // chat room before this join, i.e. a real room switch):
  //
  //   loginIntent && priorRooms.length === 0  → "X has connected."
  //     The handshake just finished, this is the user's first room
  //     of the session. `isReconnect` gates this off because
  //     mobile suspend → wake re-runs the handshake and we don't
  //     want to spam "connected" every time the screen turns back
  //     on.
  //   priorRooms.length > 0                   → "X has entered the room."
  //     Same socket moved A → B via the room:join event; pair with
  //     the "X has left the room." departure broadcast emitted in
  //     the leave loop above. NOT gated on `isReconnect`, a real
  //     room switch is an explicit action on a live socket, and
  //     `consumePendingDisconnect` may have legitimately swept
  //     ghosts from a tab the user closed in some OTHER room.
  //     That shouldn't mute this tab's announce.
  //   Anything else (reconnect after suspend, page reload, network
  //   blip, watchers reattaching)            → silent.
  //
  // Both announce paths share the multi-tab gate via
  // `userHasSocketInRoom`: if another tab of this account is
  // already in the destination, we suppress the broadcast (account
  // is "already here" from the room's perspective, even though
  // THIS socket just arrived). The userlist update via
  // `broadcastPresence` above is the visible signal regardless.
  // Boot grace and forum rooms suppress both paths.
  const loginIntent =
    (socket.data as { loginIntent?: boolean }).loginIntent === true;
  // Gate "X has connected / entered" on the IDENTITY tuple, not the raw
  // userId. A user can be live on desktop as Character A and then log
  // in on mobile as Character B, that's two distinct identities even
  // though it's one user, and the room should learn about Character B
  // arriving. The legacy user-only check (userHasSocketInRoom)
  // silenced the mobile broadcast in that case because "the user was
  // already here," masking the per-character join from observers.
  //
  // Resolve the socket's current characterId the same way the
  // userlist render path does: a per-tab `tabCharId` set by `/char`
  // wins; otherwise fall back to the user's master-row default.
  // `undefined` only happens on a socket that hasn't issued any
  // /char yet, which still resolves to the DB default, never null
  // by accident.
  const tabCharRaw = (socket.data as { tabCharId?: string | null }).tabCharId;
  const socketCharacterId: string | null =
    tabCharRaw !== undefined ? tabCharRaw : (user.activeCharacterId ?? null);
  const otherIdentitySocketHere = await userIdentityHasSocketInRoom(
    io,
    user.id,
    socketCharacterId,
    roomId,
    socket.id,
  );
  // The user-scoped check is still useful for the watcher-ping branch
  // further down: watchers care about the user coming online, not
  // about which character they happen to be voicing.
  const otherSocketHere = await userHasSocketInRoom(io, user.id, roomId, socket.id);
  const isForumRoom = room.replyMode === "nested";
  const isRoomSwitch = priorRooms.length > 0;
  // Incognito gate folds into baseGate: ANY enter/connect broadcast
  // is suppressed while the user is in incognito mode. Pair with the
  // suppress on the leave path above so the moderator can hop rooms
  // entirely silently.
  // Info-room silence rides baseGate: arrivals ("has connected" included)
  // are never announced in a room that displays nobody. `returningToAnchor`
  // additionally silences the re-entry into the room the reader's presence
  // never visibly left — everyone there watched them sit idle the whole
  // time, so an "has entered" line would contradict the userlist.
  const returningToAnchor = wasReadingInfo && priorAnchorRoomId === roomId;
  const baseGate = !otherIdentitySocketHere && !isInBootGrace() && !isForumRoom && !enteringInfo && !isHiddenIncognitoIdentity(user, socketCharacterId);
  if (loginIntent && !isRoomSwitch && baseGate && !isReconnect) {
    await addSystemMessage(io, db, roomId, renderPresenceTemplate(
      sessionConnectTemplate,
      DEFAULT_PRESENCE_TEMPLATES.sessionConnect,
      { name: user.displayName, room: room.name },
    ));
  } else if (isRoomSwitch && baseGate && !returningToAnchor) {
    await addSystemMessage(io, db, roomId, renderPresenceTemplate(
      roomJoinTemplate,
      DEFAULT_PRESENCE_TEMPLATES.roomJoin,
      { name: user.displayName, room: room.name },
    ));
  }
  // Consume the loginIntent flag after the first room of the session
  // has been announced. Without this, any subsequent joinRoom on the
  // same socket whose priorRooms snapshot looks empty (e.g. a queued
  // re-join after a transient network event) would re-evaluate the
  // first branch and emit a duplicate "X has connected." line.
  (socket.data as { loginIntent?: boolean }).loginIntent = false;
  if (!otherSocketHere && !isReconnect && !userWasOnlineBefore && !isRoomSwitch) {
    // Watcher pings: still relevant in forum rooms, they're per-user
    // notifications, not room broadcasts. Fire whenever this is a
    // true online transition regardless of room type. Decoupled from
    // the chat broadcast, a watcher should still get pinged when
    // their friend reconnects after a mobile suspend, even though
    // the chat itself stays silent.
    //
    // `!isRoomSwitch` is load-bearing here. `userWasOnlineBefore`
    // alone is NOT a sufficient gate, `userIsOnline` excludes the
    // current socket so a single-tab user moving room A → room B
    // sees their only socket excluded from the check and the
    // function returns false, even though the user is plainly
    // already online. Without this gate, watchers received a
    // spurious "Wallace is online" toast (which `App.tsx` paints
    // into the watcher's CURRENT room as `☆ Wallace is online.`)
    // immediately AFTER the user's "has left the room." broadcast.
    // The room-switch path is not an online transition.
    //
    // Pass the identity this socket is voicing so watchers are only pinged
    // for the exact handle they friended, not every character on the
    // account. `socketCharacterId` was resolved above the same way the
    // userlist render path does (per-tab /char wins, else master default).
    await pingWatchers(io, db, user, socketCharacterId);
  }
}

/**
 * True iff the user has at least one live socket in the given room.
 * `excludeSocketId` skips the named socket - used at join time so the
 * caller's freshly-joined socket doesn't count as a "prior" presence.
 */
export async function userHasSocketInRoom(
  io: Io,
  userId: string,
  roomId: string,
  excludeSocketId?: string,
): Promise<boolean> {
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  for (const s of sockets) {
    if (excludeSocketId && s.id === excludeSocketId) continue;
    if ((s.data as { userId?: string }).userId === userId) return true;
  }
  return false;
}

/**
 * True iff the user has at least one live socket voicing the given
 * `characterId` in the given room. Used by the disconnect handler to
 * decide whether the just-disconnected identity needs an idle ghost or
 * whether a sibling tab is still carrying the same identity. `null`
 * characterId means "OOC" (the user's master identity).
 *
 * Resolution mirrors `currentOccupants`: tabCharId === undefined falls
 * back to the user's DB-default activeCharacterId, but we don't have
 * the user row here, so the caller is responsible for resolving
 * `undefined` to a concrete characterId before calling. (The disconnect
 * handler does this via the SessionUser it holds.)
 */
export async function userIdentityHasSocketInRoom(
  io: Io,
  userId: string,
  characterId: string | null,
  roomId: string,
  excludeSocketId?: string,
): Promise<boolean> {
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  for (const s of sockets) {
    if (excludeSocketId && s.id === excludeSocketId) continue;
    if ((s.data as { userId?: string }).userId !== userId) continue;
    const raw = (s.data as { tabCharId?: string | null }).tabCharId;
    // `undefined` over the wire means "no per-tab override." For matching
    // purposes we can't resolve it without the user row, so we conservatively
    // treat it as a non-match against an explicit characterId. The
    // disconnect handler that calls this always passes the resolved
    // characterId; sibling sockets that haven't issued /char will read
    // as `undefined` here. To avoid leaking that ambiguity, fall back
    // to "any sibling socket of this user counts as the identity still
    // being live for the master/OOC case", same conservatism we used
    // before per-tab routing existed. If you ever see a regression where
    // an idle ghost lingers despite a sibling tab, this is the place
    // to thread a userById lookup through.
    if (raw === undefined) {
      if (characterId === null) return true;
      continue;
    }
    if (raw === characterId) return true;
  }
  return false;
}

/**
 * True iff the user has at least one live socket anywhere on the io server.
 * Used to distinguish "first connect" from "another tab" when announcing
 * arrivals.
 */
export async function userIsOnline(
  io: Io,
  userId: string,
  excludeSocketId?: string,
): Promise<boolean> {
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    if (excludeSocketId && s.id === excludeSocketId) continue;
    if ((s.data as { userId?: string }).userId === userId) return true;
  }
  return false;
}

/**
 * The set of distinct userIds with at least one live socket, deduped across
 * tabs. One `fetchSockets()` pass; callers that need the whole online set
 * (admin metrics, offline-only nudge sweeps) share this instead of hand-rolling
 * the loop.
 */
export async function onlineUserIds(io: Io): Promise<Set<string>> {
  const sockets = await io.fetchSockets();
  const online = new Set<string>();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid) online.add(uid);
  }
  return online;
}

/**
 * Every room `userId` currently has a live socket in, deduped across tabs (a
 * user with three tabs on the same room yields one id). A user's presence
 * spans every room they're joined to, so any state change that alters their
 * userlist row (membership/incognito/block) has to refresh ALL of them, not
 * just the one room the action fired in.
 *
 * `seedRoomId`, when given, is included even if no live socket is currently in
 * it and is placed FIRST in the result (insertion order): /incognito seeds the
 * room the command was typed in so the exit/return refresh still fires there
 * even if that socket has already dropped by the time we walk. One
 * `fetchSockets()` pass; same `socket.data.userId` match rule as the rest of
 * this module.
 */
export async function roomsForUser(io: Io, userId: string, seedRoomId?: string): Promise<string[]> {
  const sockets = await io.fetchSockets();
  const roomIds = new Set<string>();
  if (seedRoomId !== undefined) roomIds.add(seedRoomId);
  for (const s of sockets) {
    if ((s.data as { userId?: string }).userId !== userId) continue;
    for (const r of s.rooms) {
      if (r.startsWith("room:")) roomIds.add(r.slice(5));
    }
  }
  return [...roomIds];
}

/**
 * Re-broadcast presence in every room `userId` currently occupies. The
 * canonical form of the route/command "membership changed → resort every
 * userlist the user appears in" pass. Best-effort per room: a single room's
 * broadcast failing (`.catch`) never aborts the rest, matching the inline
 * copies this replaced.
 */
export async function rebroadcastPresenceForUser(io: Io, db: Db, userId: string): Promise<void> {
  const roomIds = await roomsForUser(io, userId);
  for (const rid of roomIds) {
    await broadcastPresence(io, db, rid).catch(() => {});
  }
}

/**
 * Single source of truth for the wire-shape of a room. Used by every
 * surface that emits a RoomSummary (the websocket broadcasts AND the
 * `GET /rooms` HTTP route) so the optional `linkedWorld`/`npcDisabled`/
 * `messageExpiryMinutes`/`replyMode` fields always land populated. When
 * /rooms used to construct its own summary inline, those fields were
 * silently undefined, which broke the rail's primary-world grouping.
 */
export async function buildRoomSummary(
  db: Db,
  room: typeof rooms.$inferSelect,
  // GET /rooms hands one Map for its whole tree so the server→world banner
  // fallback resolves ONCE per (server, rating) instead of once per room —
  // the route is the hottest endpoint and a 50-room server would otherwise
  // pay ~50 identical servers/worlds/users reads per refetch. Single-room
  // broadcast callers omit it (one room = one resolve, same as before).
  serverWorldCache?: ServerWorldFallbackCache,
): Promise<RoomSummary> {
  const memberCountRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, room.id));
  // EFFECTIVE 18+ rating (server OR room — age plan, Phase 2). Computed once:
  // it feeds the summary's own isNsfw field AND the server-world fallback's
  // rating gate below.
  const isNsfw = await effectiveRoomNsfw(db, room);
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    topic: room.topic,
    ownerId: room.ownerId,
    memberCount: memberCountRows[0]?.n ?? 0,
    npcDisabled: room.npcDisabled,
    persistent: room.persistent,
    // Drives the rail/info-bar "18+" chip. Minors never receive a summary
    // with this set because the /rooms route + join gates drop 18+ rooms
    // for them first.
    isNsfw,
    // Explicit room link first; a room with NO room_world_links row inherits
    // its server's community world (migration 0346) so the whole server's
    // rooms carry the lore banner without per-room linking. The explicit
    // link always wins; the fallback costs one indexed servers read and only
    // on the no-link path.
    linkedWorld: (await loadLinkedWorld(db, room.id)) ?? (await loadServerWorldFallback(db, room, isNsfw, serverWorldCache)),
    messageExpiryMinutes: room.messageExpiryMinutes,
    replyMode: room.replyMode,
    theaterMode: room.theaterMode,
    theaterLoop: room.theaterLoop,
    theaterPlaylist: parsePlaylist(room.theaterPlaylist),
    forumId: room.forumId ?? null,
    // Linked SFW/18+ pair (migration 0343). The annex carries the stored
    // pointer to its base; the base's reverse pointer is looked up live so
    // the rail can draw the SFW/18+ toggle on the listed row. An archived
    // annex reads as "no pair" (the toggle would join a parked room).
    linkedSfwRoomId: room.linkedRoomId ?? null,
    linkedNsfwRoomId: room.linkedRoomId
      ? null
      : (await findLinkedAnnex(db, room.id))?.id ?? null,
    // The client derives its CURRENT server from the room it occupies, which
    // drives the rail's active pill and the per-server rooms scoping. Emit the
    // EFFECTIVE server (a NULL row is adopted by the default/is_system server)
    // ONLY when the flag is on; flag-off this stays null so currentServerId
    // never engages and the shell is byte-identical to today.
    serverId: areServersEnabledCached() ? (room.serverId ?? DEFAULT_SERVER_ID) : null,
    // Room Info bar fields (migration 0258). The lightweight ones ride the
    // broadcast so the collapsed bar renders without a follow-up fetch; the
    // heavier dossier (description, NPC list, metadata) is lazy-loaded via
    // GET /rooms/:id/info only when the bar is expanded.
    icon: room.icon ?? null,
    createdAt: +room.createdAt,
    messageCount: room.messageCount ?? 0,
    currentSceneTitle: room.currentSceneTitle ?? null,
    // Rail section (migration 0344). Not per-viewer — categories are pure
    // presentation, so this rides the room-wide fast path safely. Null = the
    // trailing uncategorized bucket.
    categoryId: room.categoryId ?? null,
    // Read-only posting mode (migration 0345). The MODE itself is not
    // per-viewer (it drives the rail's megaphone glyph for everyone); the
    // per-viewer `postLocked` flag is layered on in summaryFor / the /rooms
    // route from the join-time socket stamp.
    postMode: room.postMode,
    // "Never expire" opt-out (migration 0347); the dossier + expiry strips
    // read it. Not per-viewer.
    retentionExempt: room.retentionExempt,
    // Per-room rich-text toggle (migration 0354); the composer hides its
    // rich-only controls on it. Not per-viewer, so it rides the room-wide
    // fast path safely.
    richTextDisabled: room.richTextDisabled,
  };
}

/**
 * Push the room's LIVE theater playback state to every socket in the
 * room. Called after a controller action mutates `theaterState`. No-op
 * when there is no live state yet (nothing has played) - in that case
 * clients just sit on the playlist's first source, paused at 0.
 */
export async function broadcastTheaterSync(io: Io, roomId: string): Promise<void> {
  const payload = theaterSyncPayload(roomId);
  if (!payload) return;
  io.to(`room:${roomId}`).emit("theater:sync", payload);
}

/**
 * Persist the room's current (extrapolated) theater playback into
 * `rooms.theater_playback` so a restart can resume near where viewers
 * were. Writes NULL when there's no live state (theater off / nothing
 * played). Called on each control change and by the periodic sweep -
 * never per playback tick.
 */
export async function persistTheaterCheckpoint(db: Db, roomId: string): Promise<void> {
  const cp = checkpointFor(roomId, Date.now());
  await db
    .update(rooms)
    .set({ theaterPlayback: cp ? serializeCheckpoint(cp) : null })
    .where(eq(rooms.id, roomId));
}

/**
 * Periodic sweep: re-checkpoint every room that's actively PLAYING so
 * its persisted position stays fresh (within one sweep interval) while
 * a long video runs without any control events. Paused rooms were
 * already checkpointed at the moment they paused, so they're skipped.
 */
export async function checkpointPlayingTheaters(db: Db): Promise<void> {
  for (const roomId of theaterRoomIds()) {
    if (getTheater(roomId)?.isPlaying) {
      await persistTheaterCheckpoint(db, roomId);
    }
  }
}

/**
 * Boot rehydration: load persisted checkpoints for every theater-mode
 * room back into the in-memory map so reconnecting clients resync to the
 * resumed position. `hydrate` re-anchors the clock to now, treating the
 * downtime as a pause. Returns how many rooms were restored.
 */
export async function hydrateTheaterFromDb(db: Db): Promise<number> {
  const rows = await db
    .select({ id: rooms.id, theaterPlayback: rooms.theaterPlayback })
    .from(rooms)
    .where(and(eq(rooms.theaterMode, true), isNotNull(rooms.theaterPlayback)));
  const now = Date.now();
  let restored = 0;
  for (const r of rows) {
    const cp = parseCheckpoint(r.theaterPlayback);
    if (cp) {
      hydrateTheater(r.id, cp, now);
      restored += 1;
    }
  }
  return restored;
}

/**
 * Build the mutual-block graph for everyone relevant to a room's userlist:
 * the occupants plus the sockets parked in the room (viewers). Returns the
 * room sockets (reused by the caller to emit) and the graph. An empty graph
 * (`.size === 0`) means no two of them are blocked, so the caller can take the
 * single room-wide emit fast path instead of fanning out per-socket.
 *
 * Isolation (age plan, Phase 5) rides the same graph: `isolationAmong`
 * returns the block-shaped Map of isolated-minor × adult pairs among the
 * same ids, unioned in so every per-viewer consumer (occupantsForViewer,
 * room:state / presence:update fan-outs) inherits the mutual hiding with
 * zero extra plumbing. Empty in the common no-isolated-minors case, so the
 * fast path survives.
 */
async function roomBlockGraph(
  io: Io,
  db: Db,
  roomId: string,
  occupants: RoomOccupant[],
): Promise<{ sockets: Awaited<ReturnType<Io["fetchSockets"]>>; blockGraph: Map<string, Set<string>> }> {
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  const ids = new Set<string>(occupants.map((o) => o.userId));
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid) ids.add(uid);
  }
  const blockGraph = await blocksAmong(db, [...ids]);
  return { sockets, blockGraph: unionGraphInto(blockGraph, await isolationAmong(db, [...ids])) };
}

/** The occupant list a given viewer should see: occupants they're blocked
 *  with removed. Blocks are symmetric, so this also keeps each blocked pair
 *  out of the OTHER's list when applied per-viewer. */
function occupantsForViewer(
  occupants: RoomOccupant[],
  blockGraph: Map<string, Set<string>>,
  viewerUserId: string | undefined,
): RoomOccupant[] {
  const hide = viewerUserId ? blockGraph.get(viewerUserId) : undefined;
  return hide ? occupants.filter((o) => !hide.has(o.userId)) : occupants;
}

/**
 * Emit `room:state` for a room from an ALREADY-COMPUTED occupant list. The
 * per-viewer block filtering + fast-path/fan-out emit + tree pulse that used to
 * live inline in `broadcastRoomState`. Extracted so the combined join path can
 * reuse one occupant rebuild + one block graph across both room:state and
 * presence:update.
 */
type BlockGraphResult = Awaited<ReturnType<typeof roomBlockGraph>>;

async function emitRoomStateWith(
  io: Io,
  db: Db,
  roomId: string,
  summary: Awaited<ReturnType<typeof buildRoomSummary>>,
  occupants: RoomOccupant[],
  serverId: string | null | undefined,
  // When the caller already built the block graph (combined join path), reuse
  // it to avoid a redundant fetchSockets + blocksAmong. Standalone callers omit
  // it and we build it here, byte-identical to the old inline behavior.
  precomputedGraph?: BlockGraphResult,
): Promise<void> {
  // Per-viewer block filtering (see roomBlockGraph). Fast path: no blocks
  // among the room → one room-wide emit. Otherwise fan out filtered lists.
  const { sockets, blockGraph } = precomputedGraph ?? (await roomBlockGraph(io, db, roomId, occupants));
  // Linked-pair scrub (same contract as GET /rooms): a base room's pointer
  // to its 18+ annex must never reach an under-18 occupant of the (all-ages)
  // base, so a summary carrying one forces the per-socket fan-out and nulls
  // the pointer for non-adult viewers.
  const summaryFor = (s: (typeof sockets)[number]) => {
    const sd = s.data as { user?: { isAdult?: boolean }; pairStaffView?: boolean; postLocked?: boolean; annexRoleDenied?: boolean };
    // Staff pair oversight flag (per-viewer; stamped on socket.data at
    // join): tells the client to render the pair's two message buckets
    // merged. Only meaningful on paired rooms; adults only (the stamp
    // itself requires isAdult, so no minor can carry it).
    let withFlag = sd.pairStaffView && (summary.linkedNsfwRoomId || summary.linkedSfwRoomId)
      ? { ...summary, pairStaffView: true }
      : summary;
    // Read-only posting flag (per-viewer; stamped at join by
    // stampPostLocked, NEVER computed here): tells the client to swap the
    // composer for the lock strip. Only meaningful on restricted-post
    // rooms (post_mode 'staff' or 'roles').
    if (summary.postMode !== "everyone" && sd.postLocked) {
      withFlag = { ...withFlag, postLocked: true };
    }
    if (!withFlag.linkedNsfwRoomId) return withFlag;
    // Scrub for non-adults AND for viewers the annex's own access gate
    // denies (join-time stamp; see stampAnnexRoleDenied) — same contract
    // as GET /rooms' roleDropped pointer scrub.
    return sd.user?.isAdult && !sd.annexRoleDenied ? withFlag : { ...withFlag, linkedNsfwRoomId: null };
  };
  // Fast path only when NO per-viewer variance is possible: any pair
  // pointer (either direction) can require the per-socket staff flag or
  // the minor scrub, and a restricted-post room ('staff'/'roles') needs
  // the per-socket postLocked flag, so those rooms always take the fan-out.
  if (blockGraph.size === 0 && !summary.linkedNsfwRoomId && !summary.linkedSfwRoomId && summary.postMode === "everyone") {
    io.to(`room:${roomId}`).emit("room:state", { room: summary, occupants });
  } else {
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      s.emit("room:state", { room: summaryFor(s), occupants: occupantsForViewer(occupants, blockGraph, uid) });
    }
  }
  // Tree-wide invalidate. Room metadata changed (topic, replyMode,
  // owner, archive flip, etc.), anyone with a rooms rail open
  // needs to know. Sockets in other rooms wouldn't see the room-
  // scoped emit above, so they'd be stuck on a stale tree until
  // the 20s backstop poll. Payload-free pulse; the client refetches
  // `/rooms` (debounced) and re-renders. The room row is already in hand,
  // so its serverId is free here; emitTreeChanged ignores it when the flag
  // is off and emits the same bare global pulse as before.
  emitTreeChanged(io, serverId ?? null);
}

/**
 * Emit `presence:update` for a room from an ALREADY-COMPUTED occupant list.
 * The block-filtering + emit + tree pulse that used to live inline in
 * `broadcastPresence`. See `emitRoomStateWith`.
 */
async function emitPresenceWith(
  io: Io,
  db: Db,
  roomId: string,
  occupants: RoomOccupant[],
  // See emitRoomStateWith: reuse a precomputed block graph on the combined path.
  precomputedGraph?: BlockGraphResult,
): Promise<void> {
  // Per-viewer block filtering: blocked accounts must not see each other in
  // the userlist. Fast path (no blocks among the room) keeps the single
  // room-wide emit; otherwise fan out filtered lists per socket.
  const { sockets, blockGraph } = precomputedGraph ?? (await roomBlockGraph(io, db, roomId, occupants));
  if (blockGraph.size === 0) {
    io.to(`room:${roomId}`).emit("presence:update", { roomId, occupants });
  } else {
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      s.emit("presence:update", { roomId, occupants: occupantsForViewer(occupants, blockGraph, uid) });
    }
  }
  // Same tree-invalidate as broadcastRoomState. Presence changes the
  // occupant count next to each room in the rail, and the only way
  // a viewer in room A finds out about a join/leave in room B is to
  // re-fetch the rooms tree. Client-side debounce coalesces a flurry
  // (rapid /char switches, mass disconnect) into a single refetch.
  //
  // This path doesn't already hold the room row (only an id), so resolving
  // the serverId costs a row read. Pay it ONLY when the servers feature is
  // live; on the flag-off path we skip the lookup entirely and emit the
  // exact bare global pulse, leaving today's behavior byte-identical.
  let presenceServerId: string | null = null;
  if (areServersEnabledCached()) {
    presenceServerId = (await db
      .select({ serverId: rooms.serverId })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1))[0]?.serverId ?? null;
  }
  emitTreeChanged(io, presenceServerId);
}

export async function broadcastRoomState(
  io: Io,
  db: Db,
  roomId: string,
): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return;
  const summary = await buildRoomSummary(db, room);
  const occupants = await currentOccupants(io, db, roomId, { room });
  await emitRoomStateWith(io, db, roomId, summary, occupants, room.serverId);
}

export async function broadcastPresence(io: Io, db: Db, roomId: string): Promise<void> {
  const occupants = await currentOccupants(io, db, roomId);
  await emitPresenceWith(io, db, roomId, occupants);
}
/**
 * Combined join broadcast: compute the occupant list ONCE and emit BOTH
 * `room:state` and `presence:update` from that single result.
 *
 * `joinRoomBody` previously called `broadcastRoomState` then `broadcastPresence`
 * back-to-back for the same room. Each independently rebuilt `currentOccupants`
 * (~12 DB queries) and ran its own `roomBlockGraph` (an extra `fetchSockets`),
 * so every join rebuilt the userlist twice and fetched sockets ~4×. This helper
 * rebuilds occupants once and reuses that one list for both emits. Both wire
 * events are still sent (clients may listen to each) and
 * the tree pulse still fires (once per emit, as before).
 */
async function broadcastRoomStateAndPresence(io: Io, db: Db, roomId: string): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return;
  const summary = await buildRoomSummary(db, room);
  const occupants = await currentOccupants(io, db, roomId, { room });
  // Build the block graph ONCE (one fetchSockets + one blocksAmong) and reuse it
  // for both emits. Both wire events (room:state, presence:update) are still
  // sent; the tree pulse fires once per emit, exactly as the two old
  // back-to-back broadcasts did.
  const graph = await roomBlockGraph(io, db, roomId, occupants);
  await emitRoomStateWith(io, db, roomId, summary, occupants, room.serverId, graph);
  await emitPresenceWith(io, db, roomId, occupants, graph);
}

/**
 * Resolve the world linked to a room, if any. Returns the brief identity
 * record the client uses to render the chat banner. Cheap join (no page
 * data; the viewer modal fetches that on demand).
 */
async function loadLinkedWorld(db: Db, roomId: string): Promise<LinkedWorldRef | null> {
  const link = (await db.select().from(roomWorldLinks).where(eq(roomWorldLinks.roomId, roomId)).limit(1))[0];
  if (!link) return null;
  return worldRefById(db, link.worldId);
}

/**
 * Chat-banner fallback (migration 0346): a room with no explicit
 * room_world_links row inherits its SERVER's community world, so a server
 * owner links lore once and every unlinked room carries the banner.
 * RoomSummary is a room-wide broadcast (no per-viewer resolve is possible),
 * so the inherited world is gated HERE instead of through resolveWorld:
 * a private world never inherits (its name/slug/owner would fan out to
 * viewers the world's own visibility gate denies), and an 18+ world only
 * inherits into rooms whose effective rating is 18+ (minors never occupy
 * those, so the name never reaches them). One indexed servers read plus
 * the world row it already needed, and only when the servers feature is
 * live: flag-off, summaries stay byte-identical to today.
 */
/**
 * Per-request memo for the server→world fallback, keyed on
 * `serverId:rating` (the rating gate is per-room, so a mixed-rating server
 * costs at most two resolves). Values are PROMISES so the /rooms
 * Promise.all fan-out dedupes even when many rooms of one server race the
 * first resolve.
 */
export type ServerWorldFallbackCache = Map<string, Promise<LinkedWorldRef | null>>;

async function loadServerWorldFallback(
  db: Db,
  room: { serverId: string | null },
  roomIsNsfw: boolean,
  cache?: ServerWorldFallbackCache,
): Promise<LinkedWorldRef | null> {
  if (!areServersEnabledCached()) return null;
  const serverId = room.serverId ?? DEFAULT_SERVER_ID;
  if (!cache) return resolveServerWorldFallback(db, serverId, roomIsNsfw);
  const key = `${serverId}:${roomIsNsfw ? "1" : "0"}`;
  let p = cache.get(key);
  if (!p) {
    p = resolveServerWorldFallback(db, serverId, roomIsNsfw);
    cache.set(key, p);
  }
  return p;
}

async function resolveServerWorldFallback(
  db: Db,
  serverId: string,
  roomIsNsfw: boolean,
): Promise<LinkedWorldRef | null> {
  const s = (await db
    .select({ worldId: servers.worldId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1))[0];
  if (!s?.worldId) return null;
  const w = (await db.select().from(worlds).where(eq(worlds.id, s.worldId)).limit(1))[0];
  if (!w) return null;
  if (w.visibility === "private") return null;
  if (w.isNsfw && !roomIsNsfw) return null;
  return worldRefFromRow(db, w);
}

/** Load a world's brief identity record ({@link LinkedWorldRef}) by id. */
async function worldRefById(db: Db, worldId: string): Promise<LinkedWorldRef | null> {
  const w = (await db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1))[0];
  if (!w) return null;
  return worldRefFromRow(db, w);
}

/** Map a worlds row to the brief banner identity record (one owner read). */
async function worldRefFromRow(db: Db, w: typeof worlds.$inferSelect): Promise<LinkedWorldRef> {
  const owner = (await db.select({ username: users.username }).from(users).where(eq(users.id, w.ownerUserId)).limit(1))[0];
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    ownerUsername: owner?.username ?? "(deleted user)",
  };
}

/**
 * Fan out a `watch:online` push to every live socket of every user who is
 * friends with the EXACT identity the user just came online as.
 *
 * Friendships are per-identity: you can friend someone's master/OOC handle
 * OR a specific character, and the row pins that side's character id (null
 * for master). `onlineAsCharacterId` is the identity this user is connecting
 * as. We only ping watchers whose friendship is pinned to that same identity,
 * so a player who friended @Aphelios does NOT get an "online" ping when the
 * owner logs in voicing a different character (or OOC). Matching the owner's
 * other characters would leak identities the watcher never friended.
 *
 * `displayName` in the payload is the connecting identity's public name, so a
 * character-pinned ping reads "☆ Aphelios is online." with no OOC crossover.
 *
 * The event name on the wire is still `watch:online` (changing it would break
 * older cached client bundles); the underlying table moved from `watches` to
 * `friends`, and as of migration 0051 friendship is symmetric, so we look at
 * both sides of every accepted edge that touches `user`.
 */
async function pingWatchers(
  io: Io,
  db: Db,
  user: SessionUser,
  onlineAsCharacterId: string | null,
): Promise<void> {
  // Incognito gate. An incognito moderator coming online (login, reconnect,
  // /char-switch, etc.) is supposed to leave no trace, friends receiving
  // a "☆ X is online" system line in their current room would directly
  // out the moderator's presence. Same rationale as the userlist
  // suppression in currentOccupants. Scoped to the identity that went
  // incognito, so friends of a DIFFERENT character the account voices
  // on another tab still get the online ping.
  if (isHiddenIncognitoIdentity(user, onlineAsCharacterId)) return;
  const rows = await db
    .select({
      frienderUserId: friends.frienderUserId,
      frienderCharacterId: friends.frienderCharacterId,
      friendedUserId: friends.friendedUserId,
      friendedCharacterId: friends.friendedCharacterId,
    })
    .from(friends)
    .where(and(
      or(eq(friends.frienderUserId, user.id), eq(friends.friendedUserId, user.id)),
      eq(friends.status, "accepted"),
    ));
  if (rows.length === 0) return;
  // Keep only edges whose USER side is pinned to the identity they're online
  // as, then collect the OTHER side's user to notify. Each side is checked
  // independently so a (rare) self-friendship across two of the user's own
  // characters resolves correctly; self-pings are dropped.
  const friendSet = new Set<string>();
  for (const r of rows) {
    if (r.frienderUserId === user.id && (r.frienderCharacterId ?? null) === onlineAsCharacterId) {
      if (r.friendedUserId !== user.id) friendSet.add(r.friendedUserId);
    }
    if (r.friendedUserId === user.id && (r.friendedCharacterId ?? null) === onlineAsCharacterId) {
      if (r.frienderUserId !== user.id) friendSet.add(r.frienderUserId);
    }
  }
  if (friendSet.size === 0) return;
  // Drop any friend who is now blocked with this user (either direction): a
  // block must suppress the "online" ping the same way it hides chat/presence.
  for (const blockedId of await blockedUserIdsFor(db, user.id)) friendSet.delete(blockedId);
  // Isolation (age plan, Phase 5): friendships across the isolation fence
  // are hidden-not-severed, so a watcher the user is isolated with must not
  // get the "online" ping (or the persisted ☆ line below) either way round.
  for (const hiddenId of await isolationHiddenSetFor(db, user, friendSet)) friendSet.delete(hiddenId);
  if (friendSet.size === 0) return;
  const sockets = await io.fetchSockets();
  const payload = {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
  };
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid && friendSet.has(uid)) {
      s.emit("watch:online", payload);
    }
  }
  // Persist the "☆ X is online." line per watcher so it survives a
  // refetch. The live copy is still synthesized client-side from the
  // `watch:online` event above (so older bundles keep working); this only
  // writes the durable copy and does not emit. Body matches the client's
  // synthesized text exactly so the two are indistinguishable.
  await persistTargetedSystemMessageToActiveRooms(
    io,
    db,
    friendSet,
    `☆ ${user.displayName} is online.`,
  );
}

/**
 * Make a freshly-created or -removed block take effect live for both parties,
 * without either having to reload. Two halves:
 *
 *   1. Re-run `broadcastPresence` for every room that holds a socket of
 *      either user, so the per-viewer presence filter (see currentOccupants /
 *      broadcastPresence) repaints, the blocked pair vanish from each other's
 *      userlists (on block) or reappear (on unblock).
 *   2. Emit `relationships:changed` to both users' sockets so the client can
 *      drop the other's messages from its buffer, close an open profile / DM,
 *      and refresh its friends list.
 *
 * `blocked` is the NEW state (true = just blocked, false = just unblocked).
 */
export async function notifyBlockChange(
  io: Io,
  db: Db,
  userA: string,
  userB: string,
  blocked: boolean,
): Promise<void> {
  // One socket pass over both parties: collect the rooms to refresh AND tell
  // each socket which relationship flipped.
  const mine = await socketsForUsers(io, [userA, userB]);
  const roomIds = new Set<string>();
  for (const s of mine) {
    const uid = (s.data as { userId?: string }).userId;
    for (const r of s.rooms) if (r.startsWith("room:")) roomIds.add(r.slice(5));
    // Tell this socket which relationship flipped. A socket belonging to A
    // hears about B and vice versa.
    s.emit("relationships:changed", { withUserId: uid === userA ? userB : userA, blocked });
  }
  for (const roomId of roomIds) await broadcastPresence(io, db, roomId);
}

/**
 * If a user-created room has no live sockets in it, ARCHIVE it.
 * Previously this was a hard DELETE that cascaded onto room_members /
 * messages / bans / invites; the user-visible behavior is the same
 * (room disappears from the tree and search) but the row + its
 * configuration (topic, description, theme via linked world,
 * replyMode, messageExpiryMinutes, npcDisabled, type/passwordHash)
 * stick around. The matching create flow detects the archived row
 * on a same-name create and resurrects it with the new caller as
 * owner, see `resurrectArchivedRoom` in routes/commands/builtins/
 * room.ts. System rooms (isSystem=true) are still exempt: they need
 * to stay live so users always have a landing place.
 *
 * Already-archived rows short-circuit so a noisy reconnect loop
 * can't churn the archived_at timestamp every pass.
 *
 * Returns true when the row transitioned active → archived (caller
 * uses it to skip the "X left." announcement the room is no longer
 * around to need). False when the room was system, populated, or
 * already archived.
 */
export async function expireIfEmpty(io: Io, db: Db, roomId: string): Promise<boolean> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return false;
  if (room.isSystem) return false;
  // Persistent rooms (server channels by default) survive an empty moment the
  // same way system rooms do — they're the server's structure, not throwaways.
  if (room.persistent) return false;
  // A server's DEFAULT room is its front door: /visit hands its id to every
  // entering member, so parking it makes the whole server unenterable (the
  // "clicking Enter boots me back to the Spire" report). Belt-and-braces
  // beside the `persistent` seed — pre-fix servers may carry a default room
  // without the flag.
  if (room.isDefault) return false;
  // Forum boards live entirely in the Forums Catalog: chat joins are refused
  // outright (see the FORUM_BOARD refusal in `join`), so a board NEVER holds
  // sockets — zero occupants is its permanent steady state, not a sign of
  // abandonment. Without this exemption the boot zombie sweep archived every
  // board 60s after start, stranding its topics in an archived room. Board
  // lifecycle is owner-driven (the forums boards DELETE route archives).
  if (room.forumId) return false;
  // A linked 18+ annex sits empty most of the time BY DESIGN — it's reached
  // through the base row's SFW/18+ toggle, not the rail, so empty is its
  // steady state, not abandonment. Keep it alive while its base room is
  // alive; once the base itself archives (or the pair is dissolved), the
  // annex becomes an ordinary room and the next sweep can park it.
  if (room.linkedRoomId) {
    const base = (await db
      .select({ archivedAt: rooms.archivedAt })
      .from(rooms)
      .where(eq(rooms.id, room.linkedRoomId))
      .limit(1))[0];
    if (base && !base.archivedAt) return false;
  }
  if (room.archivedAt) return false;
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  if (sockets.length > 0) return false;
  // The BASE of a linked pair is one occupancy unit with its annex: the
  // pair's primary flow (everyone toggles to the 18+ side) empties the base
  // while the pair is in active use, and archiving it would tear the rail
  // row (and the way back) out from under the annex's occupants. Survive
  // while the annex holds live sockets or idle ghosts; a fully-empty pair
  // still parks (base first, then the annex via the cascade below).
  const pairAnnex = await findLinkedAnnex(db, roomId);
  if (pairAnnex) {
    const annexSockets = await io.in(`room:${pairAnnex.id}`).fetchSockets();
    if (annexSockets.length > 0 || hasIdleGhostsForRoom(pairAnnex.id)) return false;
  }
  // Idle ghosts hold a room open against archival the same way live
  // sockets do, the user is conceptually "still here, just idle." If
  // we archived now we'd race the ghost's eventual sweep (which calls
  // back into expireIfEmpty) and a single-occupant private room would
  // disappear on every tab close. The ghost-sweep timer drives the
  // real archival call after `idleGraceMs` elapses with no return.
  if (hasIdleGhostsForRoom(roomId)) return false;
  await db.update(rooms).set({ archivedAt: new Date() }).where(eq(rooms.id, roomId));
  // Archived rooms are filtered out of the tree, so the rail in every
  // open client just got stale. Caller skips broadcastPresence on the
  // expired branch, so we emit the tree pulse here instead. The room row
  // is in hand, so its serverId is free; emitTreeChanged falls back to the
  // bare global pulse when the flag is off.
  emitTreeChanged(io, room.serverId);
  // A base just parked: its (empty — the guard above proved it) annex lost
  // its keep-alive and would otherwise linger as an orphaned rail row until
  // the next boot sweep. Re-run the sweep on it now; its own annex-side
  // exemption sees the base archived and lets it park in this same pass.
  if (pairAnnex) await expireIfEmpty(io, db, pairAnnex.id).catch(() => false);
  return true;
}

/**
 * Send room state + presence to a single socket without disturbing others in
 * the room. Used by /refresh and its auto-refresh interval - broadcasting to
 * the whole room every N seconds would create noise for users who didn't
 * opt in.
 */
export async function sendRoomStateTo(
  socket: Sock,
  io: Io,
  db: Db,
  roomId: string,
): Promise<void> {
  const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  if (!room) return;
  // Phantom-presence stamps: refresh the reading/anchor flags to describe
  // the room the socket actually stands in now. The callers are /refresh
  // and me:resync — usually a no-op, but a resync after a live post-mode
  // flip (or any band move that skipped joinRoom) re-syncs a stale stamp
  // here.
  {
    const sd = socket.data as ReaderSocketData;
    if (isInfoRoom(room)) {
      if (sd.presenceInfoRoomId !== room.id) {
        sd.presenceInfoRoomId = room.id;
        sd.presenceAnchorRoomId = sd.presenceAnchorRoomId ?? null;
      }
    } else if (sd.presenceInfoRoomId) {
      sd.presenceInfoRoomId = null;
      sd.presenceAnchorRoomId = null;
    }
  }
  const summary = await buildRoomSummary(db, room);
  const occupants = await currentOccupants(io, db, roomId, { room });
  // Hide occupants this single viewer is blocked with (mutual). One viewer
  // here, so a direct block-set lookup is cheaper than the room graph.
  const viewerUserId = (socket.data as { userId?: string }).userId;
  const blocked = viewerUserId ? await blockedUserIdsFor(db, viewerUserId) : new Set<string>();
  // Isolation (age plan, Phase 5): same per-viewer hiding as the broadcast
  // paths. The viewer side rides the socket's session snapshot (set at
  // handshake, patched by the settings toggle), so no extra viewer lookup.
  const viewerSnapshot = (socket.data as { user?: SessionUser }).user;
  for (const hiddenId of await isolationHiddenSetFor(db, viewerSnapshot, occupants.map((o) => o.userId))) {
    blocked.add(hiddenId);
  }
  const view = blocked.size ? occupants.filter((o) => !blocked.has(o.userId)) : occupants;
  // Linked-pair scrub (same contract as GET /rooms + emitRoomStateWith):
  // never hand a non-adult viewer the base room's pointer to its 18+ annex.
  // Staff pair oversight: the per-socket flag rides the same summary so
  // the client knows to merge the pair's buckets. RE-STAMPED here (not
  // just read) because the relocate paths (kick/ban/boot) land a socket
  // via this function without a joinRoom pass — the join-time stamp would
  // still describe the PREVIOUS room. Gated on the pair pointers so
  // normal rooms pay no queries.
  if ((summary.linkedNsfwRoomId || summary.linkedSfwRoomId) && viewerSnapshot) {
    await stampPairStaffView(db, socket, viewerSnapshot, roomId);
  }
  // Read-only posting flag: RE-STAMPED here for the same relocate-path
  // reason as pairStaffView above. Gated on the restricted post modes
  // ('staff'/'roles') so 'everyone' rooms pay no queries.
  if (summary.postMode !== "everyone" && viewerSnapshot) {
    await stampPostLocked(db, socket, viewerSnapshot, room);
  }
  // Annex role-gate scrub flag: RE-STAMPED for the same relocate-path
  // reason. Gated on the base→annex pointer so unpaired rooms pay nothing.
  if (summary.linkedNsfwRoomId && viewerSnapshot) {
    await stampAnnexRoleDenied(db, socket, viewerSnapshot, roomId);
  }
  let staffFlagged = (socket.data as { pairStaffView?: boolean }).pairStaffView
    && (summary.linkedNsfwRoomId || summary.linkedSfwRoomId)
    ? { ...summary, pairStaffView: true }
    : summary;
  if (summary.postMode !== "everyone" && (socket.data as { postLocked?: boolean }).postLocked) {
    staffFlagged = { ...staffFlagged, postLocked: true };
  }
  const scrubbedSummary = staffFlagged.linkedNsfwRoomId
    && (!viewerSnapshot?.isAdult || (socket.data as { annexRoleDenied?: boolean }).annexRoleDenied)
    ? { ...staffFlagged, linkedNsfwRoomId: null }
    : staffFlagged;
  socket.emit("room:state", { room: scrubbedSummary, occupants: view });
  socket.emit("presence:update", { roomId, occupants: view });
  // Re-snap to live theater playback on resync (reconnect, tab wake).
  const tp = theaterSyncPayload(roomId);
  if (tp) socket.emit("theater:sync", tp);
}

/**
 * Phantom presence for info rooms (post_mode = 'staff').
 *
 * Info rooms are purely informational: they never DISPLAY their readers.
 * A socket standing in one still holds real membership of the room's
 * socket band (live messages + reactions keep flowing), but the presence
 * layer attributes it to an ANCHOR room instead:
 *
 *   - `socket.data.presenceInfoRoomId`  = the info room being read (also
 *     the "is reading" flag). Stamped on join; cleared on entering any
 *     normal room; maintained by the post-mode flip restamp.
 *   - `socket.data.presenceAnchorRoomId` = the last NORMAL room this
 *     session (an info→info hop keeps the original anchor). Null when
 *     there was no usable prior room.
 *
 * The anchor is VALIDATED at render time (`resolveReaderAnchor`): a dead
 * anchor (archived / deleted / turned info or board / private the reader
 * lost / reader banned) falls back to the server's landing room. The
 * attributed occupant row is folded into `currentOccupants` for the
 * anchor room BEFORE any per-viewer filtering, so blocks / isolation /
 * incognito / identity dedup apply to it exactly as if the reader stood
 * there. The info room itself reports ZERO occupants on every surface.
 *
 * Display-layer only: socket membership, message delivery, posting gates
 * and the user's real /away state are untouched.
 */
interface ReaderSocketData {
  userId?: string;
  tabCharId?: string | null;
  presenceInfoRoomId?: string | null;
  presenceAnchorRoomId?: string | null;
}

/**
 * Per-request memo for the attribution pass. GET /rooms rebuilds
 * occupants for EVERY room in the tree; without this each room would
 * re-fetch the socket list and re-resolve every reader's anchor. Values
 * are PROMISES so concurrent rebuilds dedupe the first resolve.
 */
export interface PresenceAttributionCache {
  /** socket.id → resolved effective anchor room id (null = display nowhere). */
  anchorBySocket: Map<string, Promise<string | null>>;
  /** room id → room row (anchor/info validation reads). */
  roomById: Map<string, Promise<typeof rooms.$inferSelect | undefined>>;
  /** One fetchSockets() for the whole batch. */
  allSockets?: Promise<Awaited<ReturnType<Io["fetchSockets"]>>>;
}

export function makePresenceAttributionCache(): PresenceAttributionCache {
  return { anchorBySocket: new Map(), roomById: new Map() };
}

function cachedRoomById(
  db: Db,
  cache: PresenceAttributionCache,
  roomId: string,
): Promise<typeof rooms.$inferSelect | undefined> {
  let p = cache.roomById.get(roomId);
  if (!p) {
    p = db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1).then((r) => r[0]);
    cache.roomById.set(roomId, p);
  }
  return p;
}

/**
 * May the reader's attributed row DISPLAY in `room`? Mirrors the standing
 * rules of actually being there: live, not a board, not itself an info
 * room, not a private room the reader has no membership of, no active
 * room ban, and no role-access gate the reader fails. Reads are bounded
 * and indexed, and only run for readers; the role-gate re-check only runs
 * when the room actually carries an access row.
 */
async function anchorUsableFor(
  db: Db,
  userId: string,
  room: typeof rooms.$inferSelect | undefined,
): Promise<boolean> {
  if (!room || room.archivedAt || room.forumId || isInfoRoom(room)) return false;
  const ban = (await db
    .select({ until: bans.until })
    .from(bans)
    .where(and(eq(bans.roomId, room.id), eq(bans.userId, userId)))
    .limit(1))[0];
  if (ban && (!ban.until || +ban.until > Date.now())) return false;
  if (room.type === "private" && room.ownerId !== userId) {
    const member = (await db
      .select({ userId: roomMembers.userId })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)))
      .limit(1))[0];
    if (!member) return false;
  }
  // Role-access gate (room_role_gates kind='access'): the reader's role can
  // be revoked while they sit in the info room (the live evict only
  // relocates sockets physically inside the gated room), so re-check the
  // same gate the join path uses before displaying them there.
  if ((await roleLockedRoomIdsForServer(db, [room.id])).has(room.id)) {
    const viewer = (await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1))[0];
    if (!viewer || (await roleAccessDeniedFor(db, viewer, room))) return false;
  }
  return true;
}

/**
 * Resolve the room a reading socket's presence should display in:
 * stamped anchor if still usable, else the server's landing room, else
 * nowhere (null). Also re-validates that the socket really is reading an
 * info room right now — a live post-mode flip or a relocate can leave a
 * stale stamp, and a stale stamp must never double-display the user.
 */
async function resolveReaderAnchor(
  db: Db,
  sd: ReaderSocketData,
  cache: PresenceAttributionCache,
): Promise<string | null> {
  const infoId = sd.presenceInfoRoomId;
  const userId = sd.userId;
  if (!infoId || !userId) return null;
  const info = await cachedRoomById(db, cache, infoId);
  if (!info || !isInfoRoom(info)) return null;
  if (sd.presenceAnchorRoomId) {
    const anchor = await cachedRoomById(db, cache, sd.presenceAnchorRoomId);
    if (anchor && (await anchorUsableFor(db, userId, anchor))) return anchor.id;
  }
  // Fallback: the info room's server landing. This resolver is display-
  // only (nothing here can heal an archived default the way /visit does),
  // so tier 1 must skip an archived default rather than hand back a dead
  // landing; the re-check below still guards bans/private membership.
  const serverId = info.serverId ?? DEFAULT_SERVER_ID;
  const landing = areServersEnabledCached() && serverId !== DEFAULT_SERVER_ID
    ? await findServerLanding(db, serverId, { skipArchivedDefault: true })
    : await findCanonicalLanding(db);
  if (landing && (await anchorUsableFor(db, userId, landing))) return landing.id;
  return null;
}

export async function currentOccupants(
  io: Io,
  db: Db,
  roomId: string,
  // Callers that already hold the room row pass it to skip the re-read;
  // GET /rooms additionally shares one attribution cache across its whole
  // tree so each reader's anchor resolves once per request, not per room.
  opts: { room?: typeof rooms.$inferSelect; attribution?: PresenceAttributionCache } = {},
): Promise<RoomOccupant[]> {
  const room = opts.room
    ?? (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
  // Info rooms display NOBODY — live sockets and idle ghosts alike are
  // invisible here (their presence is attributed to their anchor rooms by
  // the reader pass below). Zero occupants on every surface: this one
  // early return covers room:state, presence:update, GET /rooms and the
  // /refresh resync path, since they all assemble through this function.
  if (room && isInfoRoom(room)) return [];
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  // Per-tab character routing: each socket carries its own `tabCharId`
  // override (seeded from `users.activeCharacterId` at connect, then
  // mutated only by /char or me:switch-character from THAT socket).
  // The userlist must reflect what each socket is actually voicing in
  // THIS room, falling back to the DB column would leak a /char run
  // on a sibling tab into this room's occupant display.
  //
  // Dedupe is on the IDENTITY tuple (userId, resolved characterId),
  // not on userId alone. That makes a user with two tabs voicing two
  // different characters in the same room render as TWO occupants
  // (one per character), which is the per-identity contract the rest
  // of the app (DMs, friends, @mentions) already uses. Two tabs as
  // the same character (or both OOC) collapse to one row, since
  // they're the same identity. The previous userId-only dedup made
  // the second tab invisible in the userlist while their messages
  // still flowed through, the bug this comment block now exists to
  // prevent regressing.
  //
  // Resolution-before-dedup is load-bearing. `tabCharId === undefined`
  // means "this tab hasn't issued a /char yet, fall back to the user's
  // DB-default active character." If we'd deduped on the raw value, a
  // tab with `undefined` and a sibling tab with the same effective
  // character set explicitly would land in different buckets and both
  // pass dedup, even though they'd render as the same identity. We
  // therefore fetch user rows first, then key dedup on the resolved
  // `(userId, characterId)` tuple, the same tuple the render loop
  // emits, so the two layers can't disagree.
  type Raw = { userId: string; tabCharId: string | null | undefined };
  const raws: Raw[] = [];
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (!uid) continue;
    const tabRaw = (s.data as { tabCharId?: string | null }).tabCharId;
    raws.push({ userId: uid, tabCharId: tabRaw });
  }
  // Merge idle ghosts: identities the user was voicing in this room when
  // their last socket dropped, kept visible (faded + "(idle)") through the
  // configured idle-grace window. A ghost is dropped from the merge as
  // soon as a live socket carries the same (userId, characterId) tuple,
  // the dedup pass below handles that automatically since live raws are
  // processed first.
  const ghosts = getIdleGhostsForRoom(roomId);
  // Attributed readers (see the phantom-presence block above): sockets
  // standing in an info room whose effective anchor is THIS room join the
  // occupant set as if they stood here, marked `reading`. The socket must
  // still hold the info room's band (`s.rooms`) — a kick/boot relocate
  // moves bands without a joinRoom pass, and its stale stamp must not
  // re-attribute a socket that already left. Skipped when the room row is
  // unknown (deleted mid-broadcast).
  type Reader = { userId: string; tabCharId: string | null | undefined };
  const readers: Reader[] = [];
  // Short-circuit for installs with no info rooms at all: the scan below
  // costs a full io.fetchSockets() per broadcast batch and can only ever
  // find readers when at least one info room exists. The flag is one
  // TTL-cached indexed read (lib/postMode.ts), invalidated by the
  // post-mode write paths.
  if (room && (await anyInfoRoomsExist(db))) {
    const cache = opts.attribution ?? makePresenceAttributionCache();
    if (!cache.allSockets) cache.allSockets = io.fetchSockets();
    for (const s of await cache.allSockets) {
      const sd = s.data as ReaderSocketData;
      if (!sd.presenceInfoRoomId || !sd.userId) continue;
      if (!s.rooms.has(`room:${sd.presenceInfoRoomId}`)) continue;
      let anchor = cache.anchorBySocket.get(s.id);
      if (!anchor) {
        anchor = resolveReaderAnchor(db, sd, cache);
        cache.anchorBySocket.set(s.id, anchor);
      }
      if ((await anchor) !== roomId) continue;
      readers.push({ userId: sd.userId, tabCharId: sd.tabCharId });
    }
  }
  if (!raws.length && !ghosts.length && !readers.length) return [];

  const userIds = [
    ...new Set([
      ...raws.map((r) => r.userId),
      ...ghosts.map((g) => g.userId),
      ...readers.map((r) => r.userId),
    ]),
  ];
  const userRows = await db
    .select()
    .from(users)
    .where(sql`${users.id} IN (${sql.join(userIds.map((u) => sql`${u}`), sql`, `)})`);
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const resolvedIdentities: Array<{ userId: string; characterId: string | null }> = [];
  const idleKeys = new Set<string>();
  const seen = new Set<string>();
  for (const r of raws) {
    const u = userById.get(r.userId);
    if (!u) continue;
    // Incognito filter: users with `incognitoMode = true` are
    // observation-tool moderators who chose to vanish from every
    // userlist. They still appear in the per-room socket set (so
    // socket events reach them and they can read chat normally)
    // but they don't surface in this presence list at all. The
    // /incognito command broadcasts the visible leave-message
    // before flipping the bit, so other participants saw them
    // "leave" already.
    // `tabCharId === undefined` → no per-tab override yet, fall back
    // to the DB-default active character. `null` → explicit OOC.
    // A string → /char-switched on this socket.
    const characterId = r.tabCharId !== undefined ? r.tabCharId : (u.activeCharacterId ?? null);
    // Hide only the identity the account went incognito AS, so another
    // tab voicing a different character stays in the userlist.
    if (isHiddenIncognitoIdentity(u, characterId)) continue;
    const key = `${r.userId}::${characterId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolvedIdentities.push({ userId: r.userId, characterId });
  }
  // Attributed readers resolve their identity exactly like live raws
  // (per-tab /char override, else the DB-default active character) and
  // pass the SAME incognito gate — attribution must never out a hidden
  // moderator in their anchor room. A live socket of the same identity in
  // this room wins the dedup (they're genuinely here on another tab).
  const readingKeys = new Set<string>();
  for (const r of readers) {
    const u = userById.get(r.userId);
    if (!u) continue;
    const characterId = r.tabCharId !== undefined ? r.tabCharId : (u.activeCharacterId ?? null);
    if (isHiddenIncognitoIdentity(u, characterId)) continue;
    const key = `${r.userId}::${characterId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolvedIdentities.push({ userId: r.userId, characterId });
    readingKeys.add(key);
  }
  // Ghost identities are explicit (characterId was resolved at
  // ghost-creation), so we add them straight to `resolvedIdentities`
  // after the live pass. Anything the dedup already saw via a live
  // socket wins, a ghost only surfaces when the identity has no
  // live presence.
  for (const g of ghosts) {
    const user = userById.get(g.userId);
    if (!user) continue;
    // Same incognito filter for the idle-ghost re-introduction
    // path, a moderator who went incognito just before their last
    // live socket dropped shouldn't reappear as an "(idle)" row.
    // Scoped to the identity that went incognito.
    if (isHiddenIncognitoIdentity(user, g.characterId)) continue;
    const key = `${g.userId}::${g.characterId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolvedIdentities.push({ userId: g.userId, characterId: g.characterId });
    idleKeys.add(key);
  }
  if (!resolvedIdentities.length) return [];
  const charIds = [...new Set(resolvedIdentities.map((i) => i.characterId).filter((v): v is string => !!v))];
  const charRows = charIds.length
    ? await db
        .select()
        .from(characters)
        .where(sql`${characters.id} IN (${sql.join(charIds.map((c) => sql`${c}`), sql`, `)}) AND ${isNull(characters.deletedAt)}`)
    : [];
  const charById = new Map(charRows.map((c) => [c.id, c]));

  // Userlist crown is PER-IDENTITY (see room_mods). Authority remains
  // per-account on room_members.role, but that role would paint a crown
  // on EVERY character an owner/mod voices, leaking staff/owner status
  // into RP. Instead we derive each occupant row's displayed role from:
  //   - room OWNER → shown only on that account's OOC/master row
  //     (ownership is an account-level fact; rooms.owner_id).
  //   - room MOD   → shown only on the exact identity a /promote targeted
  //     (room_mods, character_id '' = OOC).
  // Anyone else reads as "member" (no crown).
  const roomOwnerId = room?.ownerId ?? null;
  const modRows = await db
    .select({ userId: roomMods.userId, characterId: roomMods.characterId })
    .from(roomMods)
    .where(eq(roomMods.roomId, roomId));
  // Key: `${userId}::${characterId}` with '' for OOC, matching the
  // stored sentinel; occupant lookups map their null characterId to ''.
  const modIdentityKeys = new Set(modRows.map((m) => `${m.userId}::${m.characterId}`));

  // Primary-world resolution was removed in migration 0187. With
  // per-identity memberships there's no single "primary" badge to
  // attach to the userlist row, and the world-bucket grouping that
  // ran off of it was the surface that publicly linked a character
  // back to their master's world affiliation. Occupant payloads no
  // longer carry `primaryWorld`; the world's own member list is the
  // source of truth for "who's affiliated with this world."

  // Earning, batched rank lookup for sigil rendering. We pull the
  // denormalized (rankKey, tier) from user_earning for every user in
  // the occupant set, and from character_earning for every active
  // character. The occupant render below picks the pool that matches
  // the resolved identity (character pool when attached, master pool
  // otherwise). Both queries skip when there are no candidates.
  // Userlist rank/cosmetic snapshots read from THIS room's server
  // (flag-off: the room homes to the default server, so these are the
  // single existing pools — byte-identical to today).
  const listServerId = await resolveRoomServerId(db, roomId);
  const userEarningRows = userIds.length
    ? await db
        .select({ userId: userEarning.userId, rankKey: userEarning.rankKey, tier: userEarning.tier })
        .from(userEarning)
        .where(and(eq(userEarning.serverId, listServerId), inArray(userEarning.userId, userIds)))
    : [];
  const userRankByUser = new Map(userEarningRows.map((r) => [r.userId, { rankKey: r.rankKey, tier: r.tier }]));
  const charEarningRows = charIds.length
    ? await db
        .select({ characterId: characterEarning.characterId, rankKey: characterEarning.rankKey, tier: characterEarning.tier })
        .from(characterEarning)
        .where(and(eq(characterEarning.serverId, listServerId), inArray(characterEarning.characterId, charIds)))
    : [];
  const charRankByChar = new Map(charEarningRows.map((r) => [r.characterId, { rankKey: r.rankKey, tier: r.tier }]));

  // Usergroup badge (migration 0348): each member's highest-sort_order group
  // with `showBadge` enabled on THIS room's server, batched over the whole
  // occupant set like the earning reads above. Viewer-agnostic, so it rides
  // the shared payload untouched by the per-viewer scrubs. Per-ACCOUNT
  // (server_usergroup_members keys userId), so a character row wears the
  // same badge as the account's OOC row — mirroring the profile "Roles"
  // row, which also shows account groups on character profiles.
  const badgeByUser = await userlistBadgesFor(db, listServerId, userIds);

  // Active name style + inline-avatar toggle. Partitioned per
  // identity (since migration 0085): characters carry their own
  // active slots on `character_earning`; the master/OOC slot lives
  // on `user_active_cosmetics`. The render loop below picks the
  // right one based on whether the occupant is on a character.
  const userActiveRows = userIds.length
    ? await db
        .select({
          userId: userActiveCosmetics.userId,
          activeNameStyleKey: userActiveCosmetics.activeNameStyleKey,
          inlineAvatarEnabled: userActiveCosmetics.inlineAvatarEnabled,
        })
        .from(userActiveCosmetics)
        // Per-server cosmetics (migrations 0295-0299): scope to THIS room's
        // server like the character-scope read below already does, so the
        // master/OOC name-style + inline-avatar in the userlist are per-server
        // too (flag off → default server, byte-identical to today).
        .where(and(eq(userActiveCosmetics.serverId, listServerId), inArray(userActiveCosmetics.userId, userIds)))
    : [];
  const masterActiveStyleByUser = new Map(
    userActiveRows
      .filter((r): r is { userId: string; activeNameStyleKey: string; inlineAvatarEnabled: boolean } => r.activeNameStyleKey !== null)
      .map((r) => [r.userId, r.activeNameStyleKey]),
  );
  const masterInlineAvatarByUser = new Map(
    userActiveRows.map((r) => [r.userId, !!r.inlineAvatarEnabled]),
  );
  // Character-scoped active cosmetics. Pulled from the same
  // `character_earning` rows already fetched above for rank/tier;
  // we re-query just the cosmetic columns to keep the existing
  // rank-fetch helper untouched. Empty when no characters are
  // present in the room.
  const charActiveRows = charIds.length
    ? await db
        .select({
          characterId: characterEarning.characterId,
          activeNameStyleKey: characterEarning.activeNameStyleKey,
          inlineAvatarEnabled: characterEarning.inlineAvatarEnabled,
        })
        .from(characterEarning)
        .where(and(eq(characterEarning.serverId, listServerId), inArray(characterEarning.characterId, charIds)))
    : [];
  const charActiveStyleByChar = new Map(
    charActiveRows
      .filter((r): r is { characterId: string; activeNameStyleKey: string; inlineAvatarEnabled: boolean } => r.activeNameStyleKey !== null)
      .map((r) => [r.characterId, r.activeNameStyleKey]),
  );
  const charInlineAvatarByChar = new Map(
    charActiveRows.map((r) => [r.characterId, !!r.inlineAvatarEnabled]),
  );
  // Selected border rank, keyed by the SCOPE of the occupant
  // (character row's selectedBorderRankKey when attached, master row's
  // otherwise). We've already pulled both earning tables above for
  // rank/tier; reuse the same query results by re-issuing two
  // lightweight column selections rather than threading the field
  // through the larger result set.
  const userBorderRows = userIds.length
    ? await db
        .select({
          userId: userEarning.userId,
          selectedBorderRankKey: userEarning.selectedBorderRankKey,
          selectedFreeformBorderKey: userEarning.selectedFreeformBorderKey,
        })
        .from(userEarning)
        .where(and(eq(userEarning.serverId, listServerId), inArray(userEarning.userId, userIds)))
    : [];
  const userBorderByUser = new Map(userBorderRows.map((r) => [r.userId, r.selectedBorderRankKey]));
  const userFreeformBorderByUser = new Map(userBorderRows.map((r) => [r.userId, r.selectedFreeformBorderKey]));
  const charBorderRows = charIds.length
    ? await db
        .select({
          characterId: characterEarning.characterId,
          selectedBorderRankKey: characterEarning.selectedBorderRankKey,
          selectedFreeformBorderKey: characterEarning.selectedFreeformBorderKey,
        })
        .from(characterEarning)
        .where(and(eq(characterEarning.serverId, listServerId), inArray(characterEarning.characterId, charIds)))
    : [];
  const charBorderByChar = new Map(charBorderRows.map((r) => [r.characterId, r.selectedBorderRankKey]));
  const charFreeformBorderByChar = new Map(charBorderRows.map((r) => [r.characterId, r.selectedFreeformBorderKey]));
  // Pull owned-style configs per identity (since migration 0086).
  // Master configs come from `user_owned_name_styles`; per-character
  // configs come from `character_owned_name_styles`. We only fetch
  // the rows for users / characters that actually have a style
  // active, so the lookup is bounded by what the render loop needs.
  const usersWithMasterStyle = [...masterActiveStyleByUser.keys()];
  const charsWithStyle = charActiveRows
    .filter((r) => r.activeNameStyleKey !== null)
    .map((r) => r.characterId);
  const masterOwnedStyleRows = usersWithMasterStyle.length > 0
    ? await db
        .select({ userId: userOwnedNameStyles.userId, styleKey: userOwnedNameStyles.styleKey, configJson: userOwnedNameStyles.configJson })
        .from(userOwnedNameStyles)
        .where(inArray(userOwnedNameStyles.userId, usersWithMasterStyle))
    : [];
  const charOwnedStyleRows = charsWithStyle.length > 0
    ? await db
        .select({ characterId: characterOwnedNameStyles.characterId, styleKey: characterOwnedNameStyles.styleKey, configJson: characterOwnedNameStyles.configJson })
        .from(characterOwnedNameStyles)
        .where(inArray(characterOwnedNameStyles.characterId, charsWithStyle))
    : [];
  // Index by identity tuple so the render loop's lookup is a single
  // map get. Master rows use the "u::<userId>::<styleKey>" key
  // pattern; character rows use "c::<charId>::<styleKey>".
  const ownedConfigByIdentityStyle = new Map<string, Record<string, unknown> | null>();
  function parseConfig(json: string | null): Record<string, unknown> | null {
    if (!json) return null;
    try { return JSON.parse(json) as Record<string, unknown>; }
    catch { return null; }
  }
  for (const r of masterOwnedStyleRows) {
    ownedConfigByIdentityStyle.set(`u::${r.userId}::${r.styleKey}`, parseConfig(r.configJson));
  }
  for (const r of charOwnedStyleRows) {
    ownedConfigByIdentityStyle.set(`c::${r.characterId}::${r.styleKey}`, parseConfig(r.configJson));
  }

  // Parallel lookup for freeform-border per-identity color configs.
  // Only fetched for identities whose `selectedFreeformBorderKey` is
  // set, characters cascade off their own row, master cascades off
  // its own row, so we hit each ownership table once with the union of
  // (identity, borderKey) pairs.
  const usersWithFreeformBorder = [...userFreeformBorderByUser.entries()]
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([userId]) => userId);
  const charsWithFreeformBorder = [...charFreeformBorderByChar.entries()]
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([characterId]) => characterId);
  const masterFreeformBorderRows = usersWithFreeformBorder.length > 0
    ? await db
        .select({
          userId: userOwnedFreeformBorders.userId,
          borderKey: userOwnedFreeformBorders.borderKey,
          configJson: userOwnedFreeformBorders.configJson,
        })
        .from(userOwnedFreeformBorders)
        .where(inArray(userOwnedFreeformBorders.userId, usersWithFreeformBorder))
    : [];
  const charFreeformBorderRows = charsWithFreeformBorder.length > 0
    ? await db
        .select({
          characterId: characterOwnedFreeformBorders.characterId,
          borderKey: characterOwnedFreeformBorders.borderKey,
          configJson: characterOwnedFreeformBorders.configJson,
        })
        .from(characterOwnedFreeformBorders)
        .where(inArray(characterOwnedFreeformBorders.characterId, charsWithFreeformBorder))
    : [];
  function parseFreeformConfig(json: string | null): Record<string, string> | null {
    if (!json) return null;
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) out[k] = v;
      }
      return Object.keys(out).length > 0 ? out : null;
    } catch { return null; }
  }
  const masterFreeformConfigByUserBorder = new Map<string, Record<string, string> | null>();
  for (const r of masterFreeformBorderRows) {
    masterFreeformConfigByUserBorder.set(`u::${r.userId}::${r.borderKey}`, parseFreeformConfig(r.configJson));
  }
  const charFreeformConfigByCharBorder = new Map<string, Record<string, string> | null>();
  for (const r of charFreeformBorderRows) {
    charFreeformConfigByCharBorder.set(`c::${r.characterId}::${r.borderKey}`, parseFreeformConfig(r.configJson));
  }

  // Denote-unverified chip (migration 0353): admin toggle, resolved once per
  // occupant rebuild off the in-process settings cache. The flag only rides
  // the wire while the toggle is ON — no wire noise when off. Per-ACCOUNT
  // (email verification is account-level), so character rows wear it too.
  const denoteUnverified = (await getSettings(db)).denoteUnverifiedUsers;

  // Render one occupant per resolved identity. Two characters of the
  // same player in the same room (two tabs voicing different chars)
  // come out as two rows; the same character on multiple tabs (or
  // both OOC) collapses to one because the dedup pass above keys on
  // the identity tuple. Downstream consumers (React keys, @mention
  // autocomplete, gender lookup) cope fine with multiple rows
  // sharing a userId because each carries its own characterId.
  const out: RoomOccupant[] = [];
  for (const id of resolvedIdentities) {
    const u = userById.get(id.userId);
    if (!u) continue;
    const c = id.characterId ? charById.get(id.characterId) : undefined;
    // Privacy is NOT a userlist hide: a private account (`users.isPublic
    // = false`) still appears in the room it's in, OOC or in character —
    // it's present, and it posts OOC under that name anyway, so omitting
    // it from the rail only desynced the userlist from the chat. "Private"
    // means two narrower things, both enforced elsewhere: the profile
    // isn't viewable to ANONYMOUS (logged-out) visitors — gated on the
    // /profiles endpoint — and the OOC identity is never linked to the
    // account's characters (the per-identity contract: OOC and character
    // rows are independent here, neither reveals the other). So we render
    // every resolved occupant; incognito (the deliberate vanish) is the
    // only thing that removes someone from the list, handled above.
    // Same character-first / master-fallback logic the message-author
    // color path uses (see addMessage). Userlist + chat lines have to
    // agree, otherwise a user posting as Character A would show up
    // with their OOC color in the rail and a different color on the
    // line, which looks broken.
    const effectiveColor = c?.chatColor ?? u.chatColor;
    // Pick the pool whose rank should drive THIS occupant's sigil.
    // Same scope rule the award engine uses: an in-character row
    // shows the character pool's rank, an OOC row shows the master
    // pool's rank. Falls back to nulls when the pool has no earning
    // row yet (fresh account / unranked).
    const poolRank = c
      ? (charRankByChar.get(c.id) ?? { rankKey: null, tier: null })
      : (userRankByUser.get(u.id) ?? { rankKey: null, tier: null });
    // Active style + its config are both per-identity since
    // migration 0086: characters read from `character_earning`
    // (active) + `character_owned_name_styles` (config); the master
    // reads from `user_active_cosmetics` + `user_owned_name_styles`.
    // Each character can hold a different style than the master and
    // tune its colors independently.
    const activeStyleKey = c
      ? (charActiveStyleByChar.get(c.id) ?? null)
      : (masterActiveStyleByUser.get(u.id) ?? null);
    const nameStyleConfig = activeStyleKey
      ? (c
          ? (ownedConfigByIdentityStyle.get(`c::${c.id}::${activeStyleKey}`) ?? null)
          : (ownedConfigByIdentityStyle.get(`u::${u.id}::${activeStyleKey}`) ?? null))
      : null;
    // Also surface the user's MASTER slot independently. When this
    // occupant is voicing a character, the master slot is what the
    // renderer should use for any of the user's OOC backlog (and
    // for OOC whispers, etc.), without it the chat renderer has
    // no entry for `identityKey(userId, null)` while the user is
    // attached to a character, and OOC messages render unstyled.
    const masterStyleKey = masterActiveStyleByUser.get(u.id) ?? null;
    const masterStyleConfig = masterStyleKey
      ? (ownedConfigByIdentityStyle.get(`u::${u.id}::${masterStyleKey}`) ?? null)
      : null;
    // Avatar + border + inline-avatar toggle. Avatar follows the
    // character / master fallback already used for chat-line
    // snapshots in addMessage. Border + inline-avatar pick the
    // scope-appropriate row (character_earning when attached,
    // user_active_cosmetics when OOC).
    const occupantAvatarUrl = c?.avatarUrl ?? u.avatarUrl ?? null;
    // Owner-chosen zoom/pan for that resolved avatar. Same scope rule:
    // character columns when attached, master columns otherwise. The
    // schema columns are NOT NULL with sensible defaults (zoom 1.0,
    // offsets 50/50) so the fallback is just the defaults, but we
    // round-trip via `clampAvatarCrop` so any out-of-range row written
    // by an older client can't poison the wire shape.
    const occupantAvatarCrop = clampAvatarCrop(
      c
        ? { zoom: c.avatarZoom, offsetX: c.avatarOffsetX, offsetY: c.avatarOffsetY }
        : { zoom: u.avatarZoom, offsetX: u.avatarOffsetX, offsetY: u.avatarOffsetY },
    );
    const selectedBorderRankKey = c
      ? (charBorderByChar.get(c.id) ?? null)
      : (userBorderByUser.get(u.id) ?? null);
    const selectedFreeformBorderKey = c
      ? (charFreeformBorderByChar.get(c.id) ?? null)
      : (userFreeformBorderByUser.get(u.id) ?? null);
    const freeformBorderConfig = selectedFreeformBorderKey
      ? (c
          ? (charFreeformConfigByCharBorder.get(`c::${c.id}::${selectedFreeformBorderKey}`) ?? null)
          : (masterFreeformConfigByUserBorder.get(`u::${u.id}::${selectedFreeformBorderKey}`) ?? null))
      : null;
    const inlineAvatarEnabled = c
      ? (charInlineAvatarByChar.get(c.id) ?? false)
      : (masterInlineAvatarByUser.get(u.id) ?? false);
    // Master-slot fallbacks for the user's OOC identity. The chat
    // renderer indexes a separate identityKey(userId, null) entry
    // for OOC messages; these fields populate that entry even when
    // the occupant row represents the user's current character.
    const masterAvatarUrl = u.avatarUrl ?? null;
    const masterAvatarCrop = clampAvatarCrop({
      zoom: u.avatarZoom,
      offsetX: u.avatarOffsetX,
      offsetY: u.avatarOffsetY,
    });
    const masterSelectedBorderRankKey = userBorderByUser.get(u.id) ?? null;
    const masterSelectedFreeformBorderKey = userFreeformBorderByUser.get(u.id) ?? null;
    const masterFreeformBorderConfig = masterSelectedFreeformBorderKey
      ? (masterFreeformConfigByUserBorder.get(`u::${u.id}::${masterSelectedFreeformBorderKey}`) ?? null)
      : null;
    const masterInlineAvatarEnabled = masterInlineAvatarByUser.get(u.id) ?? false;
    // Away is per-identity (see `realtime/awayState.ts`): the same
    // user voicing different characters carries one row per identity
    // here, so reading from the legacy master-row column would smear
    // a /away marked on one character onto all the others. The
    // in-memory store keys on the resolved (userId, characterId)
    // tuple, same key the rest of this loop's dedupe uses.
    const awayState = getAway(u.id, id.characterId);
    const identityKey = `${u.id}::${id.characterId ?? ""}`;
    out.push({
      userId: u.id,
      displayName: c ? c.name : u.username,
      characterId: c?.id ?? null,
      away: awayState != null,
      awayMessage: awayState?.message ?? null,
      // Attributed readers also read as idle so older bundles degrade to
      // the plain dimmed/idle presentation; the real /away state above is
      // untouched (it's user-controlled).
      idle: idleKeys.has(identityKey) || readingKeys.has(identityKey),
      ...(readingKeys.has(identityKey) ? { reading: true as const } : {}),
      chatColor: effectiveColor,
      gender: resolveGender(u.gender, c?.statsJson),
      // Per-identity displayed role (see modIdentityKeys / roomOwnerId
      // above). Owner shows only on the OOC/master row; a mod crown shows
      // only on the exact identity that was /promoted.
      role:
        roomOwnerId === u.id && id.characterId === null
          ? "owner"
          : modIdentityKeys.has(`${u.id}::${id.characterId ?? ""}`)
            ? "mod"
            : "member",
      accountRole: u.role,
      // Mood is per-identity in the same in-memory store as away.
      // Reading the master column here would smear a /mood set on
      // Character A onto Character B / OOC.
      mood: getMood(u.id, id.characterId),
      // Per-user toggle. When `showRankInUserlist` is off, the
      // broadcast omits the rank fields entirely (renders as
      // null/null on the wire) so the UserNameTag falls back to the
      // gender glyph automatically, no extra prop wiring needed
      // downstream. Toggling re-fires presence on the next /me/profile
      // save (see characters.ts re-broadcast gate).
      rankKey: u.showRankInUserlist ? poolRank.rankKey : null,
      tier: u.showRankInUserlist ? poolRank.tier : null,
      activeNameStyleKey: activeStyleKey,
      nameStyleConfig,
      masterNameStyleKey: masterStyleKey,
      masterNameStyleConfig: masterStyleConfig,
      avatarUrl: occupantAvatarUrl,
      avatarCrop: occupantAvatarCrop,
      selectedBorderRankKey,
      selectedFreeformBorderKey,
      freeformBorderConfig,
      inlineAvatarEnabled,
      masterAvatarUrl,
      masterAvatarCrop,
      masterSelectedBorderRankKey,
      masterSelectedFreeformBorderKey,
      masterFreeformBorderConfig,
      masterInlineAvatarEnabled,
      useRankAsUserlistIcon: u.useRankAsUserlistIcon,
      badge: badgeByUser.get(u.id) ?? null,
      // Only stamped while the admin toggle is on (viewer-agnostic).
      ...(denoteUnverified && !u.emailVerifiedAt ? { unverified: true as const } : {}),
    });
  }
  return out;
}

/** When a character is active, prefer its stats.gender; else the user's OOC gender. */
function resolveGender(
  userGender: "male" | "female" | "nonbinary" | "other" | "undisclosed",
  characterStatsJson?: string | null,
): "male" | "female" | "nonbinary" | "other" | "undisclosed" {
  if (!characterStatsJson) return userGender;
  try {
    const parsed = JSON.parse(characterStatsJson) as { gender?: string };
    const g = parsed.gender?.toLowerCase();
    if (g === "male" || g === "female" || g === "nonbinary" || g === "other") return g;
  } catch { /* fall through */ }
  return userGender;
}
