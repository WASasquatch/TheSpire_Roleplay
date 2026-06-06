import { eq, sql } from "drizzle-orm";
import { roomInvites, rooms, users } from "../db/schema.js";
import { addMessage } from "./broadcast.js";
import type { CommandContext } from "../commands/types.js";

export async function invite(ctx: CommandContext, username: string): Promise<void> {
  const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room) {
    ctx.socket.emit("error:notice", { code: "NO_ROOM", message: "Room not found." });
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

  const target = (await ctx.db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
    .limit(1))[0];
  if (!target) {
    ctx.socket.emit("error:notice", { code: "NO_USER", message: `No user named "${username}".` });
    return;
  }

  await ctx.db
    .insert(roomInvites)
    .values({
      roomId: ctx.roomId,
      invitedUserId: target.id,
      invitedById: ctx.user.id,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24h
    })
    .onConflictDoNothing();

  await addMessage(ctx, {
    kind: "system",
    body: `${ctx.user.displayName} invited ${target.username} to the room.`,
  });

  // Notify the invitee on every socket they have open. Without this, an
  // invite to a public room is invisible (the invitee isn't in the room
  // to see the system message above), and an invite to a private room
  // only shows up the next time they try to /go to it. The toast lets
  // them know now, regardless of room type. If the invitee is offline
  // the roomInvites row above stays for 24h and unlocks them on next
  // login attempt against that room.
  const sockets = await ctx.io.fetchSockets();
  const verb = room.type === "private" ? "(private - no password needed)" : "";
  const inviteMsg = `${ctx.user.displayName} invited you to "${room.name}". Use /go ${room.name} to head over. ${verb}`.trim();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid === target.id) {
      s.emit("error:notice", { code: "INVITED", message: inviteMsg });
    }
  }
}
