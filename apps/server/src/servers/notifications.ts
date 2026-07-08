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
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  NotificationCategory,
  NotificationKind,
} from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { notify, type NotifyTarget } from "../notifications/engine.js";
import { emitToUser } from "../realtime/presence.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Persistent-inbox half of a {@link notifyUser} call (the live toast always
 *  fires; this lands the durable Notification Center row when supplied). */
export interface NotifyUserPersist {
  category: NotificationCategory;
  kind: NotificationKind;
  serverId?: string | null;
  /** Inbox headline; defaults to the toast `message`. */
  title?: string;
  snippet?: string;
  target?: NotifyTarget;
  actor?: { id: string; name: string } | null;
}

/**
 * Nudge a user about a decision that just landed (creation/membership approval,
 * transfer, ban, …). Always fires the live `error:notice` toast (the site's
 * generic toast channel) to every live socket of `userId`; when `persist` is
 * supplied it ALSO writes a durable Notification Center row (badge + offline
 * web push) via the engine, so the user finds out even if they were away.
 * Best-effort: never throws back into the route action.
 */
export async function notifyUser(
  io: Io,
  db: Db,
  userId: string,
  args: { code: string; message: string; persist?: NotifyUserPersist },
): Promise<void> {
  try {
    await emitToUser(io, userId, "error:notice", { code: args.code, message: args.message });
  } catch {
    /* live toast is best-effort; the persisted row is the source of truth */
  }
  if (args.persist) {
    await notify(db, io, {
      userId,
      category: args.persist.category,
      kind: args.persist.kind,
      serverId: args.persist.serverId ?? null,
      title: args.persist.title ?? args.message,
      snippet: args.persist.snippet ?? "",
      ...(args.persist.actor ? { actor: args.persist.actor } : {}),
      ...(args.persist.target ? { target: args.persist.target } : {}),
    });
  }
}

/**
 * Nudge a user's LIVE server rail to refresh — a server just became available to
 * them (creation application approved, membership accepted), so the rail should
 * pick it up and fade it in without a page refresh. Best-effort, mirroring
 * {@link notifyUser}: a socket lookup / emit failure never fails the route
 * action (the membership row already committed, and the durable notification is
 * the source of truth).
 */
export async function emitServersChanged(
  io: Io,
  userId: string,
  addedServerId?: string | null,
): Promise<void> {
  try {
    await emitToUser(io, userId, "servers:changed", { addedServerId: addedServerId ?? null });
  } catch {
    /* best-effort */
  }
}
