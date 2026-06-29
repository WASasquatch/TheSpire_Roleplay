/**
 * Phase 4, per-room typing indicator tracker.
 *
 * Pure in-memory state. The wire shape is intentionally small:
 *   - Client emits `chat:typing` (just `{ roomId }`) on keystroke,
 *     throttled to roughly once every 2s.
 *   - Server records the entry with a ~5s expiry and broadcasts
 *     `chat:typing:update` to the room, but ONLY when the room's
 *     typer SET actually changed. Re-pings from a still-typing user
 *     extend their entry's expiry without re-broadcasting.
 *
 * There is no explicit "stop" signal. The composer simply stops
 * emitting when the user pauses, sends, or navigates away. The
 * sweep timer drops expired entries and re-broadcasts when a drop
 * shrinks the set. This keeps the wire quiet on the common case
 * (sentence finished, user walked away) without the client having
 * to remember to send a "stopped" pulse.
 *
 * Per-receiver ignore filtering happens at broadcast time, each
 * subscribed socket gets a payload with the typers it can actually
 * see, mirroring how chat messages are filtered.
 *
 * Not persisted. A server restart resets every room's typer set,
 * which is fine, within a couple of seconds the next keystrokes
 * rebuild the right state.
 */

import type { Server as IoServer } from "socket.io";
import { and, eq, inArray } from "drizzle-orm";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  TypingEntry,
} from "@thekeep/shared";
import { type Role } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { characterEarning, ignores, userActiveCosmetics, userEarning } from "../db/schema.js";
import { hasPermission } from "../auth/permissions.js";
import { blocksAmong } from "../auth/blocks.js";
import { resolveRoomServerId } from "../earning/pool.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

interface RoomTyperEntry {
  userId: string;
  displayName: string;
  characterId: string | null;
  /** Epoch ms after which this typer is considered idle and gets
   *  swept from the room's set on the next tick. */
  expiresAt: number;
}

/** How long a single `chat:typing` pulse keeps the user in the
 *  typer set. The client re-pulses every ~2s while still typing;
 *  this is the grace window before a sudden quiet drops them. */
const ENTRY_TTL_MS = 5_000;

/** Sweep cadence. Fast enough that a stale entry doesn't sit in
 *  the indicator long after the user paused, slow enough that we
 *  aren't running a no-op timer thousands of times. */
const SWEEP_INTERVAL_MS = 1_500;

/** Per-room typer state. Keyed by roomId, then by userId (one row
 *  per identity slot, a user voicing two different characters on
 *  two tabs in the same room would show as ONE row keyed by
 *  userId, with whichever displayName was most recently reported). */
const roomTypers = new Map<string, Map<string, RoomTyperEntry>>();

/** Sweep timer handle, set once on first `start()`. */
let sweepHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic sweep. Idempotent, repeat calls are a no-op,
 * which lets the integration site call it from a connection handler
 * without tracking startup state.
 */
export function startTypingTracker(io: Io, db: Db): void {
  if (sweepHandle) return;
  sweepHandle = setInterval(() => {
    sweepExpired(io, db);
  }, SWEEP_INTERVAL_MS);
  // Don't keep the Node process alive just for the sweep, tests
  // and graceful shutdowns shouldn't have to manually unref this.
  // `unref` is missing in some test envs; guard with `as any` cast
  // is overkill so a typeof check is enough.
  if (typeof sweepHandle.unref === "function") sweepHandle.unref();
}

/**
 * Record a typing pulse. If this is a new typer for the room, fires
 * a `chat:typing:update` broadcast. If this is a re-pulse from an
 * existing typer, extends the entry's expiry WITHOUT broadcasting
 * (the set didn't change).
 *
 * When `displayName` changes (e.g. the user switched characters
 * mid-sentence on this tab) we DO re-broadcast even when the userId
 * was already in the set, so peers see the right name.
 */
export function markTyping(
  io: Io,
  db: Db,
  args: {
    roomId: string;
    userId: string;
    displayName: string;
    characterId: string | null;
  },
): void {
  const room = roomTypers.get(args.roomId) ?? new Map<string, RoomTyperEntry>();
  const prior = room.get(args.userId);
  const next: RoomTyperEntry = {
    userId: args.userId,
    displayName: args.displayName,
    characterId: args.characterId,
    expiresAt: Date.now() + ENTRY_TTL_MS,
  };
  room.set(args.userId, next);
  roomTypers.set(args.roomId, room);
  // Broadcast only when the visible state changed: new typer, or
  // existing typer whose displayName/characterId shifted. Pure
  // expiry-extension pulses don't reach the wire.
  const changed =
    !prior ||
    prior.displayName !== next.displayName ||
    prior.characterId !== next.characterId;
  if (changed) {
    void broadcastTyperSet(io, db, args.roomId);
  }
}

/**
 * Remove a user from a specific room's typer set. Called when the
 * user sends a message (the "is typing…" indicator naturally clears
 * once the line lands), leaves the room, or disconnects.
 */
export function clearTyperFromRoom(
  io: Io,
  db: Db,
  args: { roomId: string; userId: string },
): void {
  const room = roomTypers.get(args.roomId);
  if (!room) return;
  if (!room.delete(args.userId)) return;
  if (room.size === 0) roomTypers.delete(args.roomId);
  void broadcastTyperSet(io, db, args.roomId);
}

/**
 * Remove a user from ALL rooms' typer sets. Used on disconnect /
 * me:exit, we don't always know every room they were typing in,
 * so we sweep the lot. Cheap: the outer map is bounded by active
 * rooms.
 */
export function clearTyperEverywhere(
  io: Io,
  db: Db,
  userId: string,
): void {
  const affected: string[] = [];
  for (const [roomId, room] of roomTypers) {
    if (room.delete(userId)) {
      if (room.size === 0) roomTypers.delete(roomId);
      affected.push(roomId);
    }
  }
  for (const roomId of affected) {
    void broadcastTyperSet(io, db, roomId);
  }
}

/**
 * Expire stale entries across every room. Called by the sweep
 * timer. Rooms whose set shrinks get re-broadcast; untouched rooms
 * stay quiet.
 */
function sweepExpired(io: Io, db: Db): void {
  const now = Date.now();
  const affected: string[] = [];
  for (const [roomId, room] of roomTypers) {
    let dropped = false;
    for (const [userId, entry] of room) {
      if (entry.expiresAt <= now) {
        room.delete(userId);
        dropped = true;
      }
    }
    if (dropped) {
      if (room.size === 0) roomTypers.delete(roomId);
      affected.push(roomId);
    }
  }
  for (const roomId of affected) {
    void broadcastTyperSet(io, db, roomId);
  }
}

/**
 * Emit `chat:typing:update` to every socket in the room, filtered
 * by each receiver's ignore list. The set is small (typically 0-3
 * entries) and the audience is bounded to the room, so this is
 * cheap.
 *
 * Each receiver gets the typer set MINUS:
 *   - users they've ignored
 *   - themselves (the composer hides its own indicator anyway,
 *     but suppressing it on the wire keeps the network shape clean
 *     and the indicator logic on the client trivial)
 */
async function broadcastTyperSet(io: Io, db: Db, roomId: string): Promise<void> {
  const room = roomTypers.get(roomId);
  const allTypers: TypingEntry[] = room
    ? Array.from(room.values()).map((r) => ({
        userId: r.userId,
        displayName: r.displayName,
        characterId: r.characterId,
      }))
    : [];

  // Per-typer flags read at broadcast time (not pulse time) so a
  // user editing their phrase OR toggling Lurking Master mid-
  // session sees the change land on the next set-change broadcast.
  // The lurking map is kept SEPARATE from `TypingEntry` because
  // the lurking flag is server-internal filtering metadata, the
  // wire only carries entries the receiver is allowed to see.
  const lurkingTypers = new Set<string>(); // userIds of typers currently lurking
  // Phase 5b: typing-phrase / lurking flags are read from the
  // per-server earning pool, so scope these reads to the room's
  // server (flag-off: the room homes to DEFAULT_SERVER_ID, the
  // single existing pool, so this is byte-identical).
  const sid = await resolveRoomServerId(db, roomId);

  // Phase 5 + Phase 6, splice typing-phrase + lurking flags into
  // per-typer state. Two batched queries (one per scope) keep this
  // cheap even with several typers. Master scope reads phrase from
  // user_earning AND lurking from user_active_cosmetics (different
  // tables); character scope reads both from character_earning.
  if (allTypers.length > 0) {
    const charIds = allTypers
      .map((t) => t.characterId)
      .filter((id): id is string => id !== null);
    const userIds = allTypers
      .filter((t) => t.characterId === null)
      .map((t) => t.userId);
    const charPhraseByChar = new Map<string, string | null>();
    const charLurkingByChar = new Map<string, boolean>();
    if (charIds.length > 0) {
      const rows = await db
        .select({
          characterId: characterEarning.characterId,
          phrase: characterEarning.typingPhrase,
          lurking: characterEarning.lurkingMasterEnabled,
        })
        .from(characterEarning)
        .where(and(eq(characterEarning.serverId, sid), inArray(characterEarning.characterId, charIds)));
      for (const r of rows) {
        charPhraseByChar.set(r.characterId, r.phrase);
        charLurkingByChar.set(r.characterId, !!r.lurking);
      }
    }
    const userPhraseByUser = new Map<string, string | null>();
    const userLurkingByUser = new Map<string, boolean>();
    if (userIds.length > 0) {
      const phraseRows = await db
        .select({ userId: userEarning.userId, phrase: userEarning.typingPhrase })
        .from(userEarning)
        .where(and(eq(userEarning.serverId, sid), inArray(userEarning.userId, userIds)));
      for (const r of phraseRows) userPhraseByUser.set(r.userId, r.phrase);
      const lurkingRows = await db
        .select({ userId: userActiveCosmetics.userId, lurking: userActiveCosmetics.lurkingMasterEnabled })
        .from(userActiveCosmetics)
        .where(inArray(userActiveCosmetics.userId, userIds));
      for (const r of lurkingRows) userLurkingByUser.set(r.userId, !!r.lurking);
    }
    for (const t of allTypers) {
      const phrase = t.characterId
        ? (charPhraseByChar.get(t.characterId) ?? null)
        : (userPhraseByUser.get(t.userId) ?? null);
      if (phrase) t.phrase = phrase;
      const lurking = t.characterId
        ? (charLurkingByChar.get(t.characterId) ?? false)
        : (userLurkingByUser.get(t.userId) ?? false);
      if (lurking) lurkingTypers.add(t.userId);
    }
  }

  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  // Pre-pull every (ignorer, ignored) pair where the ignored side
  // is one of the current typers. Same shape as `emitFiltered` for
  // chat messages, one DB query, filter in-memory. Skipped when
  // the typer set is empty (broadcast goes to everyone as a "clear
  // indicator" wire).
  let ignorersByTyper = new Map<string, Set<string>>();
  if (allTypers.length > 0) {
    const rows = await db
      .select({ userId: ignores.userId, ignoredUserId: ignores.ignoredUserId })
      .from(ignores)
      .where(inArray(ignores.ignoredUserId, allTypers.map((t) => t.userId)));
    for (const r of rows) {
      const set = ignorersByTyper.get(r.ignoredUserId) ?? new Set<string>();
      set.add(r.userId);
      ignorersByTyper.set(r.ignoredUserId, set);
    }
  }

  // Mutual-block filtering: a receiver must not see a typer they're blocked
  // with (and vice versa, handled symmetrically since each receiver filters
  // their own view). Batched over the typers + receivers; empty when no pair
  // is blocked, the common case.
  let blockGraph = new Map<string, Set<string>>();
  if (allTypers.length > 0) {
    const ids = new Set<string>(allTypers.map((t) => t.userId));
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) ids.add(uid);
    }
    blockGraph = await blocksAmong(db, [...ids]);
  }

  for (const s of sockets) {
    const receiverId = (s.data as { userId?: string }).userId;
    if (!receiverId) continue;
    // Phase 6, Lurking Master receivers: holders of
    // `view_deleted_message_body` always see the full set (the matrix
    // ships this admin-by-default but it's a usable proxy for "this
    // user has moderation visibility"); other receivers don't see
    // lurking typers at all. We resolve the permission once per socket
    // here rather than once per broadcast since the receiver loop is
    // already keyed on the socket.
    const receiverRole = (s.data as { user?: { role?: Role } }).user?.role;
    const receiverIsAdmin = !!receiverRole && (await hasPermission(
      { id: receiverId, role: receiverRole },
      "view_deleted_message_body",
      db,
    ));
    const blockedWithReceiver = blockGraph.get(receiverId);
    const visible = allTypers.filter((t) => {
      // The composer hides its own indicator client-side, but keep
      // the wire clean by suppressing on the server too.
      if (t.userId === receiverId) return false;
      // Mutual block: hide the typer from this receiver entirely.
      if (blockedWithReceiver && blockedWithReceiver.has(t.userId)) return false;
      const ignorers = ignorersByTyper.get(t.userId);
      if (ignorers && ignorers.has(receiverId)) return false;
      // Lurking typer + non-admin receiver = skip. Admins fall
      // through and see everything.
      if (lurkingTypers.has(t.userId) && !receiverIsAdmin) return false;
      return true;
    });
    s.emit("chat:typing:update", { roomId, typers: visible });
  }
}
