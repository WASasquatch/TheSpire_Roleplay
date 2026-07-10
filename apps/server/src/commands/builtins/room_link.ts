/**
 * Linked SFW/18+ room pairs — the command surface.
 *
 *   /linkroom <room>   Pair the current room with <room> as one rail entry.
 *                      Run from either side; whichever room carries the
 *                      room-level 18+ flag becomes the hidden annex, the
 *                      other stays listed with a SFW/18+ toggle.
 *   /unlinkroom        Dissolve the current room's pair (either side).
 *   /gopair <name>     Create <name> (SFW) plus <name>_Adult (18+), link
 *                      them, and join the SFW side. The Room Builder's
 *                      "with a linked 18+ room" checkbox composes this.
 *
 * Shape rules (same server, both public, exactly one 18+, not already
 * paired, …) live in lib/roomLinks.ts; this file owns permissions, i18n
 * notices, creation, and broadcasts.
 */

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { roomMembers, rooms } from "../../db/schema.js";
import { callerCanEditRoom } from "../../auth/roomPermissions.js";
import { linkRoomPair, unlinkRoomPair, type RoomLinkError } from "../../lib/roomLinks.js";
import { deriveUniqueRoomSlug } from "../../lib/roomSlug.js";
import { resolveRoomServerId } from "../../earning/pool.js";
import { recordAudit } from "../../audit.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";
import { checkRoomCap, findRoomByName, NAME_RX } from "./room.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/** i18n key per shape-rule violation from lib/roomLinks. */
const LINK_ERROR_KEYS: Record<RoomLinkError, string> = {
  SELF: "commands:linkRoom.self",
  FORUM_BOARD: "commands:linkRoom.forumBoard",
  SYSTEM: "commands:linkRoom.system",
  ARCHIVED: "commands:linkRoom.archived",
  DIFFERENT_SERVER: "commands:linkRoom.differentServer",
  NOT_PUBLIC: "commands:linkRoom.notPublic",
  NEED_ONE_NSFW: "commands:linkRoom.needOneNsfw",
  ALREADY_LINKED: "commands:linkRoom.alreadyLinked",
};

async function refreshPair(ctx: CommandContext, baseId: string, annexId: string) {
  const { broadcastRoomState, emitTreeChanged } = await import("../../realtime/broadcast.js");
  await broadcastRoomState(ctx.io, ctx.db, baseId).catch(() => {});
  await broadcastRoomState(ctx.io, ctx.db, annexId).catch(() => {});
  const base = (await ctx.db.select().from(rooms).where(eq(rooms.id, baseId)).limit(1))[0];
  emitTreeChanged(ctx.io, base?.serverId ?? null);
}

export const linkRoomCommand: CommandHandler = {
  name: "linkroom",
  aliases: ["pairroom"],
  usage: "/linkroom <room>",
  description:
    "Pair this room with its SFW/18+ counterpart so they list as ONE room with a SFW/18+ toggle (owner/mod of both rooms; the 18+ side must be flagged with /nsfw first).",
  subcommands: [
    { verb: "<room>", usage: "/linkroom Oak_Tavern_Adult", description: "Link the named room to this one. Whichever side is flagged 18+ becomes the hidden annex behind the toggle." },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim();
    if (!arg) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:linkRoom.usage"));

    const here = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!here) return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:shared.roomNotFound"));
    const other = await findRoomByName(ctx, arg);
    if (!other) {
      return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:linkRoom.notFound", { name: arg }));
    }

    // The caller must hold room-edit rights on BOTH sides — pairing changes
    // how both rooms present, so editing one of them isn't enough.
    if (
      !(await callerCanEditRoom(ctx.db, ctx.user, here.id))
      || !(await callerCanEditRoom(ctx.db, ctx.user, other.id))
    ) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:linkRoom.permission"));
    }

    const result = await linkRoomPair(ctx.db, here, other);
    if (!result.ok) {
      return notice(ctx, `LINK_${result.error}`, tFor(ctx.user.locale, LINK_ERROR_KEYS[result.error]));
    }

    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "room_link",
      targetRoomId: result.base.id,
      metadata: { baseName: result.base.name, annexId: result.annex.id, annexName: result.annex.name },
    });
    const { addMessage } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, {
      kind: "system",
      body: tFor(ctx.user.locale, "commands:linkRoom.linked", {
        base: result.base.name,
        annex: result.annex.name,
      }),
    });
    await refreshPair(ctx, result.base.id, result.annex.id);
  },
};

export const unlinkRoomCommand: CommandHandler = {
  name: "unlinkroom",
  aliases: ["unpairroom"],
  usage: "/unlinkroom",
  description: "Dissolve this room's SFW/18+ pair so both rooms list separately again (owner/mod only).",
  async run(ctx) {
    const here = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!here) return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:shared.roomNotFound"));
    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:linkRoom.permission"));
    }
    const pair = await unlinkRoomPair(ctx.db, here);
    if (!pair) return notice(ctx, "NOT_LINKED", tFor(ctx.user.locale, "commands:linkRoom.notLinked"));

    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "room_unlink",
      targetRoomId: pair.baseId,
      metadata: { annexId: pair.annexId },
    });
    const { addMessage } = await import("../../realtime/broadcast.js");
    await addMessage(ctx, {
      kind: "system",
      body: tFor(ctx.user.locale, "commands:linkRoom.unlinked"),
    });
    await refreshPair(ctx, pair.baseId, pair.annexId);
  },
};

export const goPairCommand: CommandHandler = {
  name: "gopair",
  aliases: ["createpair"],
  usage: "/gopair <name>",
  description:
    "Create a room together with a linked 18+ twin (<name> and <name>_Adult), listed as one room with a SFW/18+ toggle, and join the SFW side. Adults only.",
  subcommands: [
    { verb: "<name>", usage: "/gopair Oak_Tavern", description: "Creates Oak_Tavern (SFW) and Oak_Tavern_Adult (18+), linked as one rail entry." },
  ],
  async run(ctx) {
    const name = ctx.argsText.trim().replace(/\s+/g, "_");
    if (!name) return notice(ctx, "EMPTY", tFor(ctx.user.locale, "commands:goPair.usage"));
    // Creating an 18+ room is an adult-only write, same posture as /nsfw on.
    if (!ctx.user.isAdult) {
      return notice(ctx, "ADULTS_ONLY", tFor(ctx.user.locale, "commands:goPair.adultsOnly"));
    }
    const annexName = `${name}_Adult`;
    if (!NAME_RX.test(name) || !NAME_RX.test(annexName)) {
      return notice(ctx, "BAD_ROOM_NAME", tFor(ctx.user.locale, "commands:goPair.badName"));
    }
    // Strict on collisions (including archived name reservations): the
    // resurrection semantics of /go don't compose cleanly with pair
    // creation, so point the caller at /go + /nsfw + /linkroom instead.
    if ((await findRoomByName(ctx, name)) || (await findRoomByName(ctx, annexName))) {
      return notice(ctx, "NAME_TAKEN", tFor(ctx.user.locale, "commands:goPair.nameTaken"));
    }
    // The pair counts as TWO rooms against the per-owner cap; check twice
    // (checkRoomCap counts existing rooms, so the second check runs after
    // the first insert below).
    if (!(await checkRoomCap(ctx))) return;

    const serverId = await resolveRoomServerId(ctx.db, ctx.roomId);
    const mkRoom = async (roomName: string, isNsfw: boolean, linkedRoomId: string | null) => {
      const id = nanoid();
      await ctx.db.insert(rooms).values({
        id,
        name: roomName,
        slug: await deriveUniqueRoomSlug(ctx.db, roomName),
        type: "public",
        serverId,
        ownerId: ctx.user.id,
        originalOwnerUserId: ctx.user.id,
        lastOwnerUserId: ctx.user.id,
        isNsfw,
        linkedRoomId,
      });
      await ctx.db.insert(roomMembers).values({ roomId: id, userId: ctx.user.id, role: "owner" }).onConflictDoNothing();
      return id;
    };

    const baseId = await mkRoom(name, false, null);
    if (!(await checkRoomCap(ctx))) {
      // Cap hit between the two inserts: keep the SFW room (already
      // created + owned), just skip the annex. The notice from
      // checkRoomCap already explained the cap.
      const { joinRoom } = await import("../../realtime/broadcast.js");
      await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, baseId);
      return;
    }
    const annexId = await mkRoom(annexName, true, baseId);

    await recordAudit(ctx.db, {
      actorUserId: ctx.user.id,
      action: "room_link",
      targetRoomId: baseId,
      metadata: { baseName: name, annexId, annexName, created: true },
    });
    const { joinRoom, emitTreeChanged } = await import("../../realtime/broadcast.js");
    await joinRoom(ctx.io, ctx.db, ctx.socket, ctx.user, baseId);
    emitTreeChanged(ctx.io, serverId ?? null);
  },
};
