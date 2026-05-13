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
  usage: "/away [reason]  (use /back to return)",
  description: "Mark yourself away with an optional reason. Use /back to return.",
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

/**
 * /back
 *   - Explicit return-from-away. Clears the away note if set; no-op
 *     otherwise (with a friendly notice so users don't think it broke).
 *
 * Why a separate command instead of just relying on `/away` to toggle:
 *   - New users were typing `/away` again to come back, mis-reading it
 *     as a verb ("go away") rather than a state. `/back` reads as the
 *     opposite and is what other chat clients use.
 */
export const backCommand: CommandHandler = {
  name: "back",
  aliases: ["unaway"],
  usage: "/back",
  description: "Clear your away state and return to present.",
  subcommands: [],
  async run(ctx) {
    const wasAway = ctx.user.awayMessage != null;
    if (!wasAway) {
      ctx.socket.emit("error:notice", {
        code: "not-away",
        message: "You're not marked as away.",
      });
      return;
    }
    await ctx.db
      .update(users)
      .set({ awayMessage: null, awaySince: null })
      .where(eq(users.id, ctx.user.id));
    ctx.user.awayMessage = null;
    await addMessage(ctx, { kind: "system", body: `${ctx.user.displayName} is back.` });
    await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
  },
};
