import { and, eq, sql } from "drizzle-orm";
import { roomInvites, roomMembers, rooms, users } from "../db/schema.js";
import { addMessage } from "./broadcast.js";
import type { CommandContext } from "../commands/types.js";

export async function invite(ctx: CommandContext, username: string): Promise<void> {
  const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room) {
    ctx.socket.emit("error:notice", { code: "NO_ROOM", message: "Room not found." });
    return;
  }

  // Only owner/mod can invite
  const membership = (await ctx.db
    .select()
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, ctx.roomId), eq(roomMembers.userId, ctx.user.id)),
    )
    .limit(1))[0];
  const role = membership?.role;
  if (
    role !== "owner" &&
    role !== "mod" &&
    ctx.user.role !== "admin" &&
    room.ownerId !== ctx.user.id
  ) {
    ctx.socket.emit("error:notice", {
      code: "PERM",
      message: "Only the room owner or a mod can invite others.",
    });
    return;
  }

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
}
