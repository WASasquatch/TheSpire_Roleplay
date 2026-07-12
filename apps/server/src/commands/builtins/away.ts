import { eq } from "drizzle-orm";
import { addMessage, broadcastPresence } from "../../realtime/broadcast.js";
import { clearAway, getAway, setAway } from "../../realtime/awayState.js";
import { rooms } from "../../db/schema.js";
import { isPostLockedFor } from "../../lib/postMode.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

/**
 * May this caller land the away/back SYSTEM line in the room? /away carries
 * arbitrary user text ("… is away: <note>"), so in a restricted-post room
 * (post_mode 'staff'/'roles') a locked member's line must be suppressed —
 * otherwise /away is a free bypass of the read-only gate (which runs before
 * this handler and deliberately lets status commands through). The away
 * STATE + presence badge still update; only the room line is dropped.
 */
async function awayLineAllowed(ctx: CommandContext): Promise<boolean> {
  const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room) return false;
  return !(await isPostLockedFor(ctx.db, ctx.user, room));
}

/**
 * /away [reason]
 *   - With a reason: marks you away with that note.
 *   - With no reason and currently away: returns you to present.
 *   - With no reason and currently present: marks you away with no note.
 *
 * Scoping (per the per-identity contract used everywhere else in the
 * app): away is keyed on (userId, activeCharacterId), where the
 * character id is the one the calling SOCKET is voicing, already
 * resolved per-tab by the chat:input dispatcher. So /away in a tab
 * voicing Character A doesn't bleed into a sibling tab voicing OOC
 * or Character B. State lives in `realtime/awayState.ts`; the chat
 * userlist render and presence broadcasts read from there.
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
    const charId = ctx.user.activeCharacterId;
    const wasAway = getAway(ctx.user.id, charId) != null;

    const lineAllowed = await awayLineAllowed(ctx);
    if (!reason && wasAway) {
      clearAway(ctx.user.id, charId);
      if (lineAllowed) await addMessage(ctx, { kind: "system", body: `${ctx.user.displayName} is back.` });
    } else {
      const note = reason || "(no reason given)";
      setAway(ctx.user.id, charId, note);
      if (lineAllowed) await addMessage(ctx, { kind: "system", body: `${ctx.user.displayName} is away: ${note}` });
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
    const charId = ctx.user.activeCharacterId;
    const wasAway = getAway(ctx.user.id, charId) != null;
    if (!wasAway) {
      ctx.socket.emit("error:notice", {
        code: "not-away",
        message: tFor(ctx.user.locale, "commands:away.notAway"),
      });
      return;
    }
    clearAway(ctx.user.id, charId);
    if (await awayLineAllowed(ctx)) {
      await addMessage(ctx, { kind: "system", body: `${ctx.user.displayName} is back.` });
    }
    await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
  },
};
