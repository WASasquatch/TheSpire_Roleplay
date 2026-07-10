/**
 * /gopair <name> — create a room WITH its 18+ channel in one step and join
 * the SFW side. The chat-first twin of the Room Builder / server console
 * "18+ channel" checkbox (lib/adultChannel.ts): the channel is an
 * adults-only side feed behind a SFW/18+ toggle on the room's rail row,
 * never a separately-listed room. Managing the channel afterwards is
 * `/nsfw channel on|off` (or the console checkbox).
 */

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { roomMembers, rooms } from "../../db/schema.js";
import { enableAdultChannel } from "../../lib/adultChannel.js";
import { deriveUniqueRoomSlug } from "../../lib/roomSlug.js";
import { resolveRoomServerId } from "../../earning/pool.js";
import { recordAudit } from "../../audit.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";
import { checkRoomCap, findRoomByName, NAME_RX } from "./room.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

export const goPairCommand: CommandHandler = {
  name: "gopair",
  aliases: ["gochannel"],
  usage: "/gopair <name>",
  description:
    "Create a room together with its 18+ channel (an adults-only side feed behind a SFW/18+ toggle) and join it. Adults only.",
  subcommands: [
    { verb: "<name>", usage: "/gopair Oak_Tavern", description: "Creates Oak_Tavern with an 18+ channel behind its SFW/18+ toggle." },
  ],
  async run(ctx) {
    const name = ctx.argsText.trim().replace(/\s+/g, "_");
    if (!name) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:goPair.usage"));
    // Creating an 18+ channel is an adult-only write, same posture as /nsfw.
    if (!ctx.user.isAdult) {
      return notice(ctx, "ADULTS_ONLY", tFor(ctx.user.locale, "commands:goPair.adultsOnly"));
    }
    // The channel's internal feed is "<name>_Adult" and must fit the same
    // 40-char room-name cap the base does.
    if (!NAME_RX.test(name) || !NAME_RX.test(`${name}_Adult`)) {
      return notice(ctx, "BAD_ROOM_NAME", tFor(ctx.user.locale, "commands:goPair.badName"));
    }
    // Strict on collisions (including archived name reservations): the
    // resurrection semantics of /go don't compose cleanly with channel
    // creation, so point the caller at /go + /nsfw channel on instead.
    if ((await findRoomByName(ctx, name)) || (await findRoomByName(ctx, `${name}_Adult`))) {
      return notice(ctx, "NAME_TAKEN", tFor(ctx.user.locale, "commands:goPair.nameTaken"));
    }
    // The room + its channel count as TWO rooms against the per-owner cap.
    if (!(await checkRoomCap(ctx))) return;

    const serverId = await resolveRoomServerId(ctx.db, ctx.roomId);
    const id = nanoid();
    await ctx.db.insert(rooms).values({
      id,
      name,
      slug: await deriveUniqueRoomSlug(ctx.db, name),
      type: "public",
      serverId,
      ownerId: ctx.user.id,
      originalOwnerUserId: ctx.user.id,
      lastOwnerUserId: ctx.user.id,
    });
    await ctx.db.insert(roomMembers).values({ roomId: id, userId: ctx.user.id, role: "owner" }).onConflictDoNothing();
    const base = (await ctx.db.select().from(rooms).where(eq(rooms.id, id)).limit(1))[0]!;

    // Cap check for the channel's own row runs after the base insert so the
    // count includes it; a cap hit keeps the (already useful) base room and
    // just skips the channel — checkRoomCap already told the user why.
    if (await checkRoomCap(ctx)) {
      const ch = await enableAdultChannel(ctx.db, base);
      if (ch.ok) {
        await recordAudit(ctx.db, {
          actorUserId: ctx.user.id,
          action: "room_link",
          targetRoomId: base.id,
          metadata: { adultChannel: true, channelRoomId: ch.channelRoomId, created: true },
        });
      } else {
        notice(ctx, `CHANNEL_${ch.error}`, tFor(ctx.user.locale, `errors:server.rooms.adultChannel.${ch.error}`));
      }
    }
    const { joinRoom, emitTreeChanged } = await import("../../realtime/broadcast.js");
    await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, base.id);
    emitTreeChanged(ctx.io, serverId ?? null);
  },
};
