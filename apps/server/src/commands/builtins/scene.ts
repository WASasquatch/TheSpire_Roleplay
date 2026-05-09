import { and, eq } from "drizzle-orm";
import { roomMembers } from "../../db/schema.js";
import { addMessage } from "../../realtime/broadcast.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Caller must be the room owner, a room mod, or a site admin/mod. /scene is
 * a director-shaped feature - random users shouldn't be able to drop scene
 * banners into someone else's room.
 */
async function canMarkScene(ctx: CommandContext): Promise<boolean> {
  if (ctx.user.role === "admin" || ctx.user.role === "mod") return true;
  const member = (await ctx.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, ctx.roomId), eq(roomMembers.userId, ctx.user.id)))
    .limit(1))[0];
  return member?.role === "owner" || member?.role === "mod";
}

/**
 * /scene <title>      - mark a scene start with a tinted banner
 * /scene end          - mark a scene end
 *
 * Renders distinctly from /announce (which is a sitewide admin shout) and
 * from system messages (joins/parts). Used by directors of a session to
 * delineate beats.
 */
export const sceneCommand: CommandHandler = {
  name: "scene",
  usage: "/scene <title> | /scene end",
  description:
    "Mark a scene start or end with a banner. Visible to everyone in the room. Owner/mod only.",
  subcommands: [
    { verb: "<title>", usage: "/scene The market at dusk", description: "Open a new scene with a banner." },
    { verb: "end", usage: "/scene end", description: "Close the current scene with a banner.", aliases: ["close", "stop"] },
  ],
  async run(ctx) {
    if (!(await canMarkScene(ctx))) {
      notice(ctx, "PERM", "Only the room owner or a mod can mark scenes.");
      return;
    }
    const raw = ctx.argsText.trim();
    if (!raw) {
      notice(ctx, "SCENE_USAGE", "Usage: /scene <title> or /scene end.");
      return;
    }
    const isEnd = /^(end|close|stop)$/i.test(raw);
    const body = isEnd ? "Scene ends." : `Scene: ${raw}`;
    await addMessage(ctx, { kind: "scene", body });
  },
};
