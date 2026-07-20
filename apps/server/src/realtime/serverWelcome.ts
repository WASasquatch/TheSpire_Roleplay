/**
 * First-join welcome (migration 0366) — the in-chat replacement for the old
 * first-words NOTIFICATION.
 *
 * The first time a person appears in a server (the main Spire on registration,
 * a community server when they join), a single SYSTEM line is posted into the
 * room they land in: "Welcome {user} to {server}! …". It is:
 *   - Once per (user, server), ever — an atomic claim row (`server_welcomes`,
 *     inserted onConflictDoNothing) makes the presence-hook fire idempotent, so
 *     reconnects and same-server room hops never re-announce.
 *   - Opt-out per server — ON by default; an owner can turn it off, and set a
 *     custom template (with {user} + {server} placeholders) in Server Settings.
 *   - Best-effort — a failure here must never break the join.
 *
 * Posting into the room the newcomer actually entered (rather than resolving a
 * separate "main" room) keeps the welcome where they and the active members
 * are, and avoids an import cycle with the landing-room resolver.
 */
import { eq } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { servers, serverWelcomes } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getServerSettings } from "../settings.js";
import { isInfoRoomId } from "../lib/postMode.js";
import { addSystemMessage } from "./broadcast/persistence.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Built-in copy when a server hasn't set its own template. Stays English like
 *  every persisted chat/system row; an owner localizes by editing the template. */
const DEFAULT_TEMPLATE = "Welcome {user} to {server}! They have just joined us for the first time.";

/** Longest a rendered welcome line may be (guards a pathological template). */
const MAX_BODY_LEN = 600;

/** Substitute {user} / {server} (case-insensitive) in a template. */
export function renderWelcomeTemplate(template: string, vars: { user: string; server: string }): string {
  return template
    .replace(/\{user\}/gi, vars.user)
    .replace(/\{server\}/gi, vars.server);
}

/**
 * Post the once-ever welcome for `userId` entering `serverId`, into `roomId`
 * (the room they landed in). No-op when the server has the feature off or the
 * pair was already welcomed. Fire-and-forget; never throws to the caller.
 */
export async function maybeSendServerJoinWelcome(
  io: Io,
  db: Db,
  opts: { userId: string; serverId: string; roomId: string; displayName: string },
): Promise<void> {
  const { userId, serverId, roomId, displayName } = opts;
  try {
    const settings = await getServerSettings(db, serverId);
    if (!settings.joinWelcomeEnabled) return;
    // An info room swallows system lines (addSystemMessage no-ops there). Bail
    // BEFORE claiming so a first appearance that happens to land in one doesn't
    // silently burn the once-ever claim — the member is greeted next time they
    // land somewhere postable instead.
    if (await isInfoRoomId(db, roomId)) return;

    // Atomic once-per-(server, user) claim. Only the insert that actually adds
    // the row (changes > 0) posts; a pre-existing row means we've welcomed them
    // before, so a reconnect / re-entry stays silent. The toggle is checked
    // FIRST so turning the feature off never consumes the claim — a later
    // enable can still greet a not-yet-welcomed member.
    const res = await db
      .insert(serverWelcomes)
      .values({ serverId, userId, welcomedAt: new Date() })
      .onConflictDoNothing();
    if (Number(res.changes ?? 0) === 0) return;

    const serverRow = (await db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1))[0];
    const serverName = serverRow?.name ?? "the server";
    const template = settings.joinWelcomeTemplate?.trim() || DEFAULT_TEMPLATE;
    const body = renderWelcomeTemplate(template, { user: displayName, server: serverName }).slice(0, MAX_BODY_LEN);
    // addSystemMessage no-ops for info rooms; landing rooms are never info
    // rooms, so a genuine first-entry always lands somewhere visible.
    await addSystemMessage(io, db, roomId, body);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[server-welcome] first-join welcome failed", { serverId, userId, err });
  }
}
