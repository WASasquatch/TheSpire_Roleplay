/**
 * Server notifications — the live, fire-and-forget socket toast helper the
 * /servers routes use to nudge an online actor the moment a decision lands
 * (creation application approved/rejected, membership approved/rejected,
 * banned). The deliberate mirror of the `error:notice` emits scattered through
 * `routes/forums.ts`, lifted into one place so every server route phrases its
 * notices the same way.
 *
 * Persistent inbox notifications (the forum module's `forum_notifications`
 * table + watch engine) have NO server-table analog in Phase 0's registry, so
 * there is nothing to clone for them yet — this file ships only the live-toast
 * pulse the Phase-4 routes actually need. The forum-reply notification engine
 * (`forums/notifications.ts`) is the template a later phase would follow if
 * server boards ever grow their own watch inbox.
 *
 * Best-effort by contract: a socket lookup or emit failure NEVER fails the
 * route action it accompanies (the DB write already committed).
 */
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Push a one-off `error:notice` toast to every live socket of `userId`.
 * `error:notice` is the site's generic client toast channel (same one the
 * forum approve/ban paths use); the `code` lets the client theme the toast and
 * the `message` is shown verbatim. Swallows any failure.
 */
export async function notifyUser(
  io: Io,
  userId: string,
  code: string,
  message: string,
): Promise<void> {
  try {
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
      if ((s.data as { userId?: string }).userId !== userId) continue;
      s.emit("error:notice", { code, message });
    }
  } catch {
    /* live toast is best-effort; the persisted state is the source of truth */
  }
}
