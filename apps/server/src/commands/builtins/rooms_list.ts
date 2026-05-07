import { asc, eq, sql } from "drizzle-orm";
import { roomMembers, rooms } from "../../db/schema.js";
import type { CommandHandler } from "../types.js";

/**
 * /list - show all public rooms (name, topic, occupant count). Mirrors the
 * phpMyChat /list shorthand. Emitted as a notice (single message-list line)
 * so it doesn't pollute the room transcript for everyone else.
 *
 * Private rooms are intentionally omitted - listing them by name even
 * without messages would defeat the privacy contract. Use the admin
 * Rooms tab for the full inventory.
 */
export const listCommand: CommandHandler = {
  name: "list",
  aliases: ["rooms"],
  usage: "/list",
  description: "Show every public room (name + topic + member count).",
  async run(ctx) {
    const allRooms = await ctx.db
      .select({
        id: rooms.id,
        name: rooms.name,
        topic: rooms.topic,
        type: rooms.type,
      })
      .from(rooms)
      .where(eq(rooms.type, "public"))
      .orderBy(asc(rooms.name));

    if (allRooms.length === 0) {
      ctx.socket.emit("error:notice", { code: "ROOM_LIST", message: "No public rooms exist yet." });
      return;
    }

    const counts = await ctx.db
      .select({ roomId: roomMembers.roomId, n: sql<number>`count(*)` })
      .from(roomMembers)
      .groupBy(roomMembers.roomId);
    const countByRoom = new Map(counts.map((c) => [c.roomId, c.n]));

    const lines = allRooms.map((r) => {
      const n = countByRoom.get(r.id) ?? 0;
      return `  ${r.name} (${n})${r.topic ? ` - ${r.topic}` : ""}`;
    });
    ctx.socket.emit("error:notice", {
      code: "ROOM_LIST",
      message: `Public rooms (${allRooms.length}):\n${lines.join("\n")}`,
    });
  },
};

/**
 * /clear - wipe the local message buffer for the current room. Pure client
 * effect; no message history is touched server-side. Useful when a long
 * scrollback is making the page sluggish or the user wants a clean slate.
 */
export const clearCommand: CommandHandler = {
  name: "clear",
  aliases: ["cls"],
  usage: "/clear",
  description: "Clear the local view of messages in the current room (your view only).",
  run(ctx) {
    ctx.socket.emit("ui:hint", { kind: "clear-room-messages" });
  },
};

/**
 * /find <name> - open the users directory pre-filtered by name. Equivalent
 * to /users with a prefilled search box. Mirrors phpMyChat's /find.
 */
export const findCommand: CommandHandler = {
  name: "find",
  aliases: ["search"],
  usage: "/find [name]",
  description: "Open the users directory, optionally pre-filtered by name.",
  subcommands: [
    {
      verb: "<name>",
      usage: "/find Alice",
      description: "Open the directory with the search box pre-filled.",
    },
    {
      verb: "(no args)",
      usage: "/find",
      description: "Same as /users - open the directory with no filter.",
    },
  ],
  run(ctx) {
    const q = ctx.argsText.trim();
    ctx.socket.emit("ui:hint", q ? { kind: "open-users", query: q } : { kind: "open-users" });
  },
};
