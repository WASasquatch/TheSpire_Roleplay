import { eq } from "drizzle-orm";
import { roomInvites, rooms, users } from "../db/schema.js";
import type { CommandContext } from "../commands/types.js";
import { emitAmbiguousIdentityModal, resolveIdentityArg } from "../commands/identityArg.js";
import { isBlockedBetween } from "../auth/blocks.js";
import { isIsolatedBetweenIds } from "../auth/ageIsolation.js";
import { tFor } from "../i18n.js";
import { addMessage } from "./broadcast.js";

export async function invite(ctx: CommandContext, raw: string): Promise<void> {
  const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room) {
    ctx.socket.emit("error:notice", { code: "NO_ROOM", message: tFor(ctx.user.locale, "errors:server.realtime.roomNotFound") });
    return;
  }

  // Anyone currently in the room can invite, owners and mods aren't
  // always around when a friend needs to be pulled into a private
  // session. The caller's presence in the room is already implicit
  // via `ctx.roomId` (commands only dispatch against the socket's
  // joined room), so we don't need a separate membership check. The
  // social-fabric guard is: invitees receive a one-shot 24h invite
  // they have to act on, room mods can /kick + /ban anyone abusing
  // the channel, and self-invites are harmless no-ops (the target
  // lookup matches the caller; the toast just goes back to them).

  // Target resolution goes through the shared identity resolver so
  // /invite accepts the same @id:/@cid: tokens (and the NBSP-aware
  // name matching + ambiguity prompt) as every other target command.
  // The old inline lower(username) lookup here only matched master
  // usernames, so tokens pasted from the userlist/profile chip died
  // with NO_USER even though the composer preview resolved them.
  const resolution = await resolveIdentityArg(ctx.db, raw);
  if (resolution.kind === "none") {
    ctx.socket.emit("error:notice", { code: "NO_USER", message: tFor(ctx.user.locale, "errors:server.realtime.noUserNamed", { name: raw }) });
    return;
  }
  if (resolution.kind === "ambiguous") {
    emitAmbiguousIdentityModal(ctx, raw, resolution.matches);
    return;
  }
  const target = resolution.target;

  // Blocks + minor isolation (age plan, Phase 5): same posture as whisper
  // and every other target command — a hidden pair behaves as if the other
  // doesn't exist, so the refusal is the exact "no such user" line, never a
  // hint that a block or isolation is on. Without this, /invite was the one
  // target command that resolved hidden accounts: it writes a roomInvites
  // row (which unlocks a private room for 24h) and toasts the target with
  // the inviter's display name — a direct contact channel across the fence,
  // in both directions. Self-invites pass (both helpers are false for
  // self) and stay harmless no-ops.
  if (
    (await isBlockedBetween(ctx.db, ctx.user.id, target.userId))
    || (await isIsolatedBetweenIds(ctx.db, ctx.user.id, target.userId))
  ) {
    ctx.socket.emit("error:notice", { code: "NO_USER", message: tFor(ctx.user.locale, "errors:server.realtime.noUserNamed", { name: raw }) });
    return;
  }

  await ctx.db
    .insert(roomInvites)
    .values({
      roomId: ctx.roomId,
      invitedUserId: target.userId,
      invitedById: ctx.user.id,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24h
    })
    .onConflictDoNothing();

  await addMessage(ctx, {
    kind: "system",
    body: `${ctx.user.displayName} invited ${target.displayName} to the room.`,
  });

  // Notify the invitee on every socket they have open. Without this, an
  // invite to a public room is invisible (the invitee isn't in the room
  // to see the system message above), and an invite to a private room
  // only shows up the next time they try to /go to it. The toast lets
  // them know now, regardless of room type. If the invitee is offline
  // the roomInvites row above stays for 24h and unlocks them on next
  // login attempt against that room. The invite lands on the ACCOUNT
  // (target.userId) even when the caller pointed at a character, same
  // contract as /kick and /ignore.
  const sockets = await ctx.io.fetchSockets();
  // Localize the toast to the TARGET's saved language (this is a transient
  // per-recipient notice, not room content). One bounded read; null = en.
  const targetLocale = (await ctx.db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, target.userId))
    .limit(1))[0]?.locale ?? null;
  const inviteMsg = room.type === "private"
    ? tFor(targetLocale, "errors:server.realtime.invitedYouPrivate", { name: ctx.user.displayName, room: room.name })
    : tFor(targetLocale, "errors:server.realtime.invitedYou", { name: ctx.user.displayName, room: room.name });
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid === target.userId) {
      s.emit("error:notice", { code: "INVITED", message: inviteMsg });
    }
  }
}
