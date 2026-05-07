import { eq } from "drizzle-orm";
import { users } from "../../db/schema.js";
import { addMessage, broadcastPresence } from "../../realtime/broadcast.js";
import type { CommandHandler } from "../types.js";

/**
 * /away [reason]
 *   - With a reason: marks you away with that note.
 *   - With no reason and currently away: returns you to present.
 *   - With no reason and currently present: marks you away with no note.
 *
 * The presence panel and userlist render "[away]" markers using occupant.away.
 */
export const awayCommand: CommandHandler = {
  name: "away",
  aliases: ["afk", "brb"],
  usage: "/away [reason]  (omit reason while away to come back)",
  description: "Toggle your away state. Userlist shows '[away]' next to your name.",
  subcommands: [
    {
      verb: "<reason>",
      usage: "/away <reason>",
      description: "Mark yourself away with a reason (visible to others on hover).",
    },
    {
      verb: "(no args, present)",
      usage: "/away",
      description: "Mark yourself away with no reason note.",
    },
    {
      verb: "(no args, away)",
      usage: "/away",
      description: "If you're already away, this returns you to present.",
    },
  ],
  async run(ctx) {
    const reason = ctx.argsText.trim();
    const wasAway = ctx.user.awayMessage != null;

    if (!reason && wasAway) {
      await ctx.db
        .update(users)
        .set({ awayMessage: null, awaySince: null })
        .where(eq(users.id, ctx.user.id));
      ctx.user.awayMessage = null;
      await addMessage(ctx, { kind: "system", body: `${ctx.user.displayName} is back.` });
    } else {
      const note = reason || "(no reason given)";
      await ctx.db
        .update(users)
        .set({ awayMessage: note, awaySince: new Date() })
        .where(eq(users.id, ctx.user.id));
      ctx.user.awayMessage = note;
      await addMessage(ctx, { kind: "system", body: `${ctx.user.displayName} is away: ${note}` });
    }
    await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
  },
};
