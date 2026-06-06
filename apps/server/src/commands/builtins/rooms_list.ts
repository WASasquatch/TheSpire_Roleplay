import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { roomMembers, rooms } from "../../db/schema.js";
import type { CommandHandler } from "../types.js";

/**
 * /list - show all public rooms (name, topic, occupant count). Mirrors the
 * phpMyChat /list shorthand. Surfaced via the persistent info modal
 * (open-info-modal ui:hint) rather than the auto-dismissing toast,
 * because the list is too long to catch in passing and users
 * frequently want to scan it for the room they're looking for.
 *
 * Private rooms are intentionally omitted - listing them by name even
 * without messages would defeat the privacy contract for /list
 * specifically. Use /find for partial-match search (which DOES
 * include private + archived rooms, entry still gated by password)
 * or the admin Rooms tab for the full inventory.
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
      // Archived rows hold a name reservation but no users; hide them
      // from the user-facing list. They'll come back if anyone
      // recreates a room with the same name.
      .where(and(eq(rooms.type, "public"), isNull(rooms.archivedAt)))
      .orderBy(asc(rooms.name));

    if (allRooms.length === 0) {
      ctx.socket.emit("ui:hint", {
        kind: "open-info-modal",
        title: "Public rooms",
        body: "No public rooms exist yet.",
      });
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
    ctx.socket.emit("ui:hint", {
      kind: "open-info-modal",
      title: `Public rooms (${allRooms.length})`,
      body: lines.join("\n"),
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
 * /find <name> - search rooms by partial name. Helpful when you only
 * remember a fragment of a room name (e.g. an archived room you made
 * months ago).
 *
 * Privacy model, archived AND private rooms are INCLUDED:
 *   - Archived rooms are listed so the user can find (and then
 *     recreate) one they made; archived rows are name reservations
 *     with no occupants, and anyone can re-establish the room by
 *     navigating to it.
 *   - Private rooms are listed because surfacing the name doesn't
 *     bypass the privacy contract, entry still requires the
 *     password and there's no transcript leak from a name match.
 *
 * Authoritative full inventory still lives in the admin Rooms tab;
 * this is just a "what did I name that thing?" recall tool.
 */
export const findCommand: CommandHandler = {
  name: "find",
  aliases: ["search"],
  usage: "/find <name>",
  description: "Search rooms by partial name (case-insensitive). Includes archived + private rooms.",
  subcommands: [
    {
      verb: "<name>",
      usage: "/find tav",
      description: "Show every room whose name contains 'tav' (case-insensitive).",
    },
  ],
  async run(ctx) {
    const needle = ctx.argsText.trim();
    if (!needle) {
      // Usage hint is a single line, transient feedback, toast fits.
      ctx.socket.emit("error:notice", {
        code: "ROOM_FIND",
        message: "Usage: /find <name> - search rooms by partial name.",
      });
      return;
    }
    const RESULT_CAP = 25;
    const matches = await ctx.db
      .select({
        id: rooms.id,
        name: rooms.name,
        topic: rooms.topic,
        type: rooms.type,
        archivedAt: rooms.archivedAt,
      })
      .from(rooms)
      .where(sql`lower(${rooms.name}) LIKE ${"%" + needle.toLowerCase() + "%"}`)
      .orderBy(asc(rooms.name))
      .limit(RESULT_CAP + 1);

    if (matches.length === 0) {
      ctx.socket.emit("ui:hint", {
        kind: "open-info-modal",
        title: `Rooms matching "${needle}"`,
        body: `No rooms match "${needle}".`,
      });
      return;
    }

    const shown = matches.slice(0, RESULT_CAP);
    const truncated = matches.length > RESULT_CAP;

    // Occupant counts. Active rooms only, archived rooms always
    // have zero members by definition, so the join-then-filter on
    // shown ids skips them naturally.
    const counts = await ctx.db
      .select({ roomId: roomMembers.roomId, n: sql<number>`count(*)` })
      .from(roomMembers)
      .groupBy(roomMembers.roomId);
    const countByRoom = new Map(counts.map((c) => [c.roomId, c.n]));

    const lines = shown.map((r) => {
      const tags: string[] = [];
      if (r.type === "private") tags.push("private");
      if (r.archivedAt) tags.push("archived");
      const tagSuffix = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
      const topicPart = r.topic ? ` - ${r.topic}` : "";
      // Hide the "(0)" occupant count on archived rooms since it's
      // tautological and just adds visual noise.
      const occupantPart = r.archivedAt ? "" : ` (${countByRoom.get(r.id) ?? 0})`;
      return `  ${r.name}${occupantPart}${topicPart}${tagSuffix}`;
    });

    const title = truncated
      ? `Rooms matching "${needle}" (first ${RESULT_CAP} of ${matches.length}+)`
      : `Rooms matching "${needle}" (${shown.length})`;
    ctx.socket.emit("ui:hint", {
      kind: "open-info-modal",
      title,
      body: lines.join("\n"),
    });
  },
};
