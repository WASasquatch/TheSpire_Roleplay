/**
 * `/eidolon emote` — post the player's familiar's current mood into the room
 * as an action ("Mortis hums with quiet contentment."). The mood is computed
 * from the live (caught-up) stats via the shared mood logic, so it matches
 * exactly what the Eidolon Tamer sprite shows. Read-only: no persist.
 *
 * Gated the same three ways as the arcade routes: the `use_eidolon_tamer`
 * permission (the handler's `permission` field), the `use_arcade` section
 * permission, AND the per-identity `flair_eidolon_tamer` purchase (a ledger
 * row). gate() in routes/arcade.ts is a private closure, so the checks are
 * replicated here.
 */
import { and, eq } from "drizzle-orm";
import { FLAIR_EIDOLON_TAMER, eidolonMoodAction } from "@thekeep/shared";
import type { CommandContext, CommandHandler } from "../types.js";
import { addMessage } from "../../realtime/broadcast.js";
import { eidolonState, earningLedger } from "../../db/schema.js";
import { hasPermission } from "../../auth/permissions.js";
import { catchUp } from "../../earning/eidolon.js";

function notice(ctx: CommandContext, code: string, message: string): void {
  ctx.socket.emit("error:notice", { code, message });
}

export const eidolonCommand: CommandHandler = {
  name: "eidolon",
  aliases: ["familiar"],
  usage: "/eidolon emote",
  description: "Post your familiar's current mood into the room as an action.",
  subcommands: [{ verb: "emote", usage: "/eidolon emote", description: "Speak your familiar's current mood." }],
  permission: "use_eidolon_tamer",
  async run(ctx) {
    const sub = (ctx.args[0] ?? "emote").toLowerCase();
    if (sub !== "emote") { notice(ctx, "USAGE", "Usage: /eidolon emote"); return; }

    // Section gate (the per-game `use_eidolon_tamer` is enforced by `permission`).
    if (!(await hasPermission(ctx.user, "use_arcade", ctx.db))) {
      notice(ctx, "EIDOLON_LOCKED", "The Spire Arcade isn't available to you.");
      return;
    }

    const scope = ctx.user.activeCharacterId ? "character" : "user";
    const ownerId = ctx.user.activeCharacterId ?? ctx.user.id;

    // Purchase gate: the per-identity unlock ledger row.
    const owned = (await ctx.db.select({ id: earningLedger.id }).from(earningLedger)
      .where(and(eq(earningLedger.scope, scope), eq(earningLedger.ownerId, ownerId), eq(earningLedger.reason, `purchase_${FLAIR_EIDOLON_TAMER}`)))
      .limit(1))[0];
    if (!owned) { notice(ctx, "EIDOLON_LOCKED", "You haven't unlocked the Eidolon Tamer on this identity."); return; }

    const row = (await ctx.db.select().from(eidolonState)
      .where(and(eq(eidolonState.ownerScope, scope), eq(eidolonState.ownerId, ownerId))).limit(1))[0];
    if (!row) { notice(ctx, "NO_EIDOLON", "You don't have a familiar yet — hatch one in the Spire Arcade."); return; }

    // Live mood from the caught-up stats (matches the in-game sprite).
    const prog = catchUp(row, Date.now());
    const action = eidolonMoodAction(prog.stats, { asleep: prog.asleep, sick: prog.sick, dead: prog.dead });
    // kind "me" renders "<name> <action>"; override the actor to the familiar.
    await addMessage(ctx, { kind: "me", body: action, displayNameOverride: row.name });
  },
};
