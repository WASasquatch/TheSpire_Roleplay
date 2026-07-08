import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
/** A single live socket as returned by `io.fetchSockets()` (a `RemoteSocket`). */
type RemoteSock = Awaited<ReturnType<Io["fetchSockets"]>>[number];

/**
 * Per-user socket fan-out: emit a single event to EVERY live socket owned by
 * `userId` (all their open tabs/devices), leaving other users' sockets alone.
 *
 * This is the canonical form of the "one `io.fetchSockets()`, filter by
 * `socket.data.userId`, emit" idiom that was copied across the notification,
 * server, room-read, earning, and title code paths. It is intentionally NOT
 * wrapped in try/catch: callers that treat delivery as best-effort keep their
 * own surrounding try/catch (and its exact logging) so the posture is unchanged.
 */
export async function emitToUser<Ev extends keyof ServerToClientEvents>(
  io: Io,
  userId: string,
  event: Ev,
  ...args: Parameters<ServerToClientEvents[Ev]>
): Promise<void> {
  const socks = await io.fetchSockets();
  for (const s of socks) {
    if ((s.data as { userId?: string }).userId === userId) {
      s.emit(event, ...args);
    }
  }
}

/**
 * The live sockets owned by `userId` (all tabs/devices). The filter half of the
 * same idiom `emitToUser` wraps, split out for callers that don't just fan a
 * single event: they emit a per-socket SEQUENCE (e.g. a fresh row + a badge),
 * need the socket handles themselves (liveness count, delayed `disconnect`), or
 * collect each socket's joined rooms. Same match rule as `emitToUser`
 * (`socket.data.userId === userId`); order preserved as `fetchSockets()`
 * returns them. Not wrapped in try/catch — callers keep their own posture.
 */
export async function socketsForUser(io: Io, userId: string): Promise<RemoteSock[]> {
  const socks = await io.fetchSockets();
  return socks.filter((s) => (s.data as { userId?: string }).userId === userId);
}

/**
 * The live sockets owned by ANY of `userIds` (deduped internally). Multi-user
 * analog of {@link socketsForUser} for the "notify a set of users" case
 * (mutual-title settle, block-change both parties). A socket with no `userId`
 * never matches. `userIds` may be any iterable (array or Set); it's normalized
 * to a Set for O(1) membership, matching the inline `ids.has(uid)` idiom.
 */
export async function socketsForUsers(io: Io, userIds: Iterable<string>): Promise<RemoteSock[]> {
  const ids = userIds instanceof Set ? userIds : new Set(userIds);
  const socks = await io.fetchSockets();
  return socks.filter((s) => {
    const uid = (s.data as { userId?: string }).userId;
    return !!uid && ids.has(uid);
  });
}
