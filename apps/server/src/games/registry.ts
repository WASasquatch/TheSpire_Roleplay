/**
 * Generic social-games session registry.
 *
 * Tracks one active "social game" per room (and at most one sitewide
 * game across the whole site). A game session is the active state of
 * a multi-participant social mini-game, currently RPS and raffles,
 * with the framework deliberately shaped so adding another game
 * (coin flip, dice tournament, …) only needs a new module that
 * speaks the same `GameKind` shape.
 *
 * Lifecycle:
 *   1. Host runs `/rps` or `/raffle …`. `startSession` is called with
 *      a kind tag, the host identity, the scope (room or sitewide),
 *      the initial per-game state object, and a window duration.
 *   2. Participants run `/rps <throw>` or `/claim`. Their handler
 *      calls `getActive(scope)` to find the session, then mutates
 *      `session.state` directly with the per-game shape it
 *      understands. The registry doesn't know what an "entry" looks
 *      like, that's the game module's job.
 *   3. A timer fires at `expiresAt`. The registry calls the per-kind
 *      `onResolve` callback (registered at module init) with the
 *      session, and clears its slot.
 *
 * Storage is intentionally in-memory only. A live game's state dies
 * with the server, which is acceptable because:
 *   - Game windows are short (30-120s). The expected restart frequency
 *     is far longer than any window.
 *   - The escrow side (raffle items, raffle currency) IS persisted,
 *     it's debited from the host's inventory / wallet on `/raffle`.
 *     If the server restarts mid-raffle the prize is stuck in the
 *     escrow state with nobody to award it to; an admin can restore
 *     it manually via the ledger or the inventory tool. The startup
 *     restore is out of scope here; refunds happen on the timer
 *     callback for the common path.
 *
 * Scope rules:
 *   - One room session per room id.
 *   - One sitewide session at a time. Starting a second one rejects.
 *   - `/claim` in a room with no room raffle falls back to the
 *     sitewide raffle when one is active. Implemented in the command
 *     handler, not here, the registry just exposes both lookups.
 */

import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { DEFAULT_SERVER_ID, resolveRoomServerId } from "../earning/pool.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Where a game runs. Room games are scoped to a single chat room;
 *  sitewide games can be joined from any room. */
export type GameScope =
  | { kind: "room"; roomId: string }
  | { kind: "sitewide" };

/**
 * Identity key, used as the Map key for "did this person already
 * enter?" lookups. Mirrors the per-identity contract every other
 * room-scoped feature follows: master and each character can each
 * play independently, and the same master playing two characters can
 * enter twice (once per character).
 */
export type IdentityKey = string;
export function identityKeyFor(userId: string, characterId: string | null): IdentityKey {
  return characterId ? `c:${characterId}` : `m:${userId}`;
}

/** Participant snapshot, the bits we need to print a result line
 *  without re-reading the user / character row at resolution time. */
export interface ParticipantRef {
  userId: string;
  characterId: string | null;
  displayName: string;
}

/**
 * Live session record. `state` is opaque to the registry; each game
 * module casts it to its own concrete shape inside its callbacks.
 */
export interface GameSession {
  id: string;
  /** Discriminator the game module registers under. Currently "rps",
   *  "room-raffle", "sitewide-raffle"; one tag per concrete game so
   *  the registry can dispatch to the right `onResolve`. */
  kind: string;
  host: ParticipantRef;
  scope: GameScope;
  startedAt: number;
  expiresAt: number;
  state: unknown;
  /** Internal timer handle so `cancel()` can clear it before the
   *  timer fires (e.g. host runs `/raffle cancel`). */
  timer: ReturnType<typeof setTimeout>;
  /** Flipped true once `onResolve` has run; defensive guard against
   *  a double-fire if the timer and a manual resolve race. */
  resolved: boolean;
}

/**
 * Per-kind resolution hooks. Each game module registers one of these
 * at boot via {@link registerGameKind}; the registry calls
 * `onResolve` when the window expires, and `onCancel` when the host
 * explicitly cancels (raffle refund path).
 *
 * The callbacks own everything game-specific: posting the result
 * message, paying out the prize, refunding escrowed value, etc. The
 * registry is purely scheduling + scope bookkeeping.
 */
export interface GameKindHandlers {
  onResolve: (session: GameSession, ctx: ResolveContext) => Promise<void> | void;
  onCancel?: (session: GameSession, ctx: ResolveContext) => Promise<void> | void;
}

/** Threaded into the resolution callbacks so game modules can post
 *  messages + mutate DB state without re-importing the world. */
export interface ResolveContext {
  db: Db;
  io: Io;
  /** The per-server economy partition this game's rewards/stats land on —
   *  the session room's server (or the default server for sitewide sessions).
   *  Resolvers pass this to mintRewardForWinner / formatWinningsLine so a game
   *  played in a sub-server credits that server's pool, not the default's. */
  serverId: string;
}

const handlers = new Map<string, GameKindHandlers>();
const roomSessions = new Map<string, GameSession>(); // roomId → session
let sitewideSession: GameSession | null = null;
const allSessions = new Map<string, GameSession>(); // id → session

/** Register the resolution hooks for a game kind. Called once per
 *  kind at boot from each game module's init function. */
export function registerGameKind(kind: string, hooks: GameKindHandlers): void {
  handlers.set(kind, hooks);
}

/**
 * Start a new session. Throws on scope conflict (a room session
 * already running in that room, or a sitewide session already
 * running). Callers must catch and surface a notice to the user,
 * the registry doesn't know about chat sockets at this layer.
 */
export function startSession(opts: {
  kind: string;
  host: ParticipantRef;
  scope: GameScope;
  state: unknown;
  windowMs: number;
  db: Db;
  io: Io;
}): GameSession {
  if (opts.scope.kind === "room") {
    const existing = roomSessions.get(opts.scope.roomId);
    if (existing) {
      throw new SessionConflictError(
        `A ${existing.kind} session is already running in this room. Wait for it to end or cancel.`,
      );
    }
  } else {
    if (sitewideSession) {
      throw new SessionConflictError(
        `A sitewide ${sitewideSession.kind} session is already running. Wait for it to end.`,
      );
    }
  }
  const now = Date.now();
  const id = randomId();
  // Closure captures the session id (not the object) so cancellation
  // via the registry's own `cancel` path can null out the timer
  // without the timer trying to mutate a torn-down session.
  const session: GameSession = {
    id,
    kind: opts.kind,
    host: opts.host,
    scope: opts.scope,
    startedAt: now,
    expiresAt: now + opts.windowMs,
    state: opts.state,
    timer: setTimeout(() => { void fireResolve(id, opts.db, opts.io); }, opts.windowMs),
    resolved: false,
  };
  allSessions.set(id, session);
  if (opts.scope.kind === "room") {
    roomSessions.set(opts.scope.roomId, session);
  } else {
    sitewideSession = session;
  }
  return session;
}

/** Thrown by `startSession` when a session already exists in the
 *  target scope. Command handlers catch this and emit a notice. */
export class SessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionConflictError";
  }
}

/**
 * Find the active session for a given room id, considering BOTH the
 * room slot AND the sitewide slot. Room game takes precedence, if
 * both are running, callers acting in that room interact with the
 * room game first. Pass `null` for the room id to look up only the
 * sitewide session (used by `/claim` when issued without a room
 * context).
 */
export function findActiveForRoom(roomId: string | null): GameSession | null {
  if (roomId) {
    const room = roomSessions.get(roomId);
    if (room) return room;
  }
  return sitewideSession ?? null;
}

/** Find the room-scoped session only (ignoring sitewide). Used by
 *  game-specific commands that should never bleed into the sitewide
 *  slot (e.g. `/rps` is room-only by design). */
export function findRoomSession(roomId: string): GameSession | null {
  return roomSessions.get(roomId) ?? null;
}

/** Find the sitewide session (or null when none is running). */
export function findSitewideSession(): GameSession | null {
  return sitewideSession;
}

/**
 * Cancel a live session before its timer fires. Calls the kind's
 * `onCancel` hook (so raffle refunds run) and clears the scope slot.
 * No-op when the session is already resolved.
 */
export async function cancel(session: GameSession, ctx: { db: Db; io: Io }): Promise<void> {
  if (session.resolved) return;
  clearTimeout(session.timer);
  session.resolved = true;
  const hooks = handlers.get(session.kind);
  if (hooks?.onCancel) {
    try {
      const serverId = session.scope.kind === "room"
        ? await resolveRoomServerId(ctx.db, session.scope.roomId)
        : DEFAULT_SERVER_ID;
      await hooks.onCancel(session, { db: ctx.db, io: ctx.io, serverId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[games] cancel hook failed", { kind: session.kind, err });
    }
  }
  evictFromSlots(session);
}

async function fireResolve(id: string, db: Db, io: Io): Promise<void> {
  const session = allSessions.get(id);
  if (!session || session.resolved) return;
  session.resolved = true;
  const hooks = handlers.get(session.kind);
  if (hooks) {
    try {
      const serverId = session.scope.kind === "room"
        ? await resolveRoomServerId(db, session.scope.roomId)
        : DEFAULT_SERVER_ID;
      await hooks.onResolve(session, { db, io, serverId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[games] resolve hook failed", { kind: session.kind, err });
    }
  }
  evictFromSlots(session);
}

function evictFromSlots(session: GameSession): void {
  allSessions.delete(session.id);
  if (session.scope.kind === "room") {
    const cur = roomSessions.get(session.scope.roomId);
    if (cur?.id === session.id) roomSessions.delete(session.scope.roomId);
  } else {
    if (sitewideSession?.id === session.id) sitewideSession = null;
  }
}

function randomId(): string {
  // Short, opaque, non-cryptographic. Sessions live for <2min so
  // collision risk over server uptime is effectively zero with 8
  // hex chars (~4B keyspace).
  return Math.random().toString(16).slice(2, 10);
}
