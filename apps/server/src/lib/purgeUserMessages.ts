import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { messages } from "../db/schema.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const CHUNK = 500;

/**
 * A "remove their recent posts" window for a ban: either a number of
 * milliseconds back from now, or `"all"` to hide everything the user
 * ever posted. The ban modals expose this as 1h … 7d … All.
 */
export type PurgeWindow = number | "all";

/**
 * Soft-hide (tombstone) a user's public messages — the SAME mechanism the
 * mod `/clear <duration>` soft-clear uses: rows are KEPT (admins keep the
 * evidence + who/when via `originalBody`) but blanked for everyone else and
 * removed live. Used by the ban flows to wipe a spammer's recent posts at
 * ban time without destroying the audit trail.
 *
 * Skips whispers (private) and system lines (join/leave/announcements aren't
 * the spam we're cleaning), and rows already removed. Returns the count hidden.
 *
 * `roomIds`: when provided, scopes the purge to those rooms (a SERVER ban only
 * wipes posts inside that server's rooms); omit for an account-wide purge.
 */
export async function softHideUserMessages(
  db: Db,
  io: Io,
  opts: {
    targetUserId: string;
    window: PurgeWindow;
    actor: { userId: string; displayName: string };
    roomIds?: string[];
  },
): Promise<number> {
  if (opts.roomIds && opts.roomIds.length === 0) return 0;

  const where = and(
    eq(messages.userId, opts.targetUserId),
    sql`${messages.kind} != 'whisper'`,
    sql`${messages.kind} != 'system'`,
    isNull(messages.deletedAt),
    ...(opts.window === "all" ? [] : [gte(messages.createdAt, new Date(Date.now() - opts.window))]),
    ...(opts.roomIds ? [inArray(messages.roomId, opts.roomIds)] : []),
  );

  const doomed = await db.select({ id: messages.id, roomId: messages.roomId }).from(messages).where(where);
  if (doomed.length === 0) return 0;

  // SOFT remove: keep the rows, snapshot the actor's account name for the
  // admin-audit blockquote, matching the single-message + /clear delete paths.
  const now = new Date();
  const ids = doomed.map((r) => r.id);
  for (let i = 0; i < ids.length; i += CHUNK) {
    await db.update(messages)
      .set({ deletedAt: now, deletedByUserId: opts.actor.userId, deletedByDisplayName: opts.actor.displayName })
      .where(inArray(messages.id, ids.slice(i, i + CHUNK)));
  }

  // Live-remove from every client's buffer, grouped per room (reload then
  // shows the standard "[message removed]" tombstones; admins see originals).
  const byRoom = new Map<string, string[]>();
  for (const r of doomed) {
    const list = byRoom.get(r.roomId);
    if (list) list.push(r.id);
    else byRoom.set(r.roomId, [r.id]);
  }
  for (const [roomId, rids] of byRoom) {
    io.to(`room:${roomId}`).emit("message:bulk-delete", { roomId, ids: rids });
  }

  return ids.length;
}
