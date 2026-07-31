import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { OVERLOOK_EDITORS_MAX, OVERLOOK_EMPTY_SCENE_JSON } from "@thekeep/shared";
import { overlookEditors, overlooks, users } from "../../db/schema.js";
import { callerCanEditRoom } from "../../auth/roomPermissions.js";
import { getSettings } from "../../settings.js";
import { emitAmbiguousIdentityModal, resolveIdentityArg, type ResolvedTarget } from "../identityArg.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Resolve `raw` to a target ACCOUNT. Grants are per-account (authority is
 * per-account everywhere but the display-only userlist crown), so we return
 * `userId` whether the caller pointed at a character or the master.
 */
async function resolveTarget(ctx: CommandContext, raw: string): Promise<ResolvedTarget | null> {
  const resolution = await resolveIdentityArg(ctx.db, raw);
  if (resolution.kind === "none") {
    notice(ctx, "NO_USER", tFor(ctx.user.locale, "commands:shared.noUserNamed", { name: raw }));
    return null;
  }
  if (resolution.kind === "ambiguous") {
    emitAmbiguousIdentityModal(ctx, raw, resolution.matches);
    return null;
  }
  return resolution.target;
}

/**
 * The room's canvas row, created on first touch. Mirrors the route's
 * `loadOrCreate`: `/overlook add` can legitimately run before anybody has
 * opened the canvas, and the grant needs a row to hang off.
 */
async function loadOrCreateForRoom(ctx: CommandContext) {
  const where = eq(overlooks.roomId, ctx.roomId);
  const existing = (await ctx.db.select().from(overlooks).where(where).limit(1))[0];
  if (existing) return existing;
  await ctx.db
    .insert(overlooks)
    .values({
      id: nanoid(),
      roomId: ctx.roomId,
      // The migration's CHECK wants exactly one scope, so the unused side is
      // explicitly null rather than omitted.
      worldId: null,
      sceneJson: OVERLOOK_EMPTY_SCENE_JSON,
      elementCount: 0,
      version: 0,
    })
    .onConflictDoNothing();
  // Re-read: two callers can race to create, and the loser takes the winner's row.
  return (await ctx.db.select().from(overlooks).where(where).limit(1))[0]!;
}

/**
 * /overlook                  - open this room's Overlook canvas
 * /overlook add <user>       - grant someone edit access
 * /overlook remove <user>    - take it back
 * /overlook list             - show who has been granted access
 *
 * The room owner and its mods can always draw and can always manage grants;
 * `add` exists to let them hand the pen to a player who is neither. Grants
 * are per-ACCOUNT, so a granted user can draw whichever character they are
 * voicing at the time.
 */
export const overlookCommand: CommandHandler = {
  name: "overlook",
  aliases: ["ov"],
  usage: "/overlook [add|remove|list] [user]",
  description:
    "Open this room's Overlook canvas: an infinite sketch surface for mapping out places, factions and how they connect. Owners and mods can grant others edit access.",
  subcommands: [
    { verb: "add", usage: "/overlook add <user>", description: "Let someone draw on this room's Overlook." },
    { verb: "remove", usage: "/overlook remove <user>", description: "Take back someone's edit access.", aliases: ["rm"] },
    { verb: "list", usage: "/overlook list", description: "Show who has been given edit access.", aliases: ["ls"] },
  ],
  async run(ctx) {
    if (!(await getSettings(ctx.db)).overlookEnabled) {
      return notice(ctx, "OVERLOOK_OFF", tFor(ctx.user.locale, "commands:overlook.disabled"));
    }

    const [first, ...rest] = ctx.args;
    const verb = (first ?? "").toLowerCase();

    // Bare `/overlook` just opens the window. Deliberately ungated: read
    // access follows the room, and the window itself renders view-only for
    // anyone who can't edit.
    if (!first) {
      ctx.socket.emit("ui:hint", { kind: "open-overlook", roomId: ctx.roomId });
      return;
    }

    const isManage = verb === "add" || verb === "remove" || verb === "rm" || verb === "list" || verb === "ls";
    if (!isManage) {
      // Anything else is a typo, not a target: `/overlook <name>` reads like
      // it should add someone, but silently granting edit access on a
      // mistyped verb is the wrong way to be helpful.
      return notice(ctx, "OVERLOOK_USAGE", tFor(ctx.user.locale, "commands:overlook.usage"));
    }

    // Managing grants is scope authority: room owner, room mod, or the
    // site-wide override. A granted editor deliberately does NOT inherit it,
    // otherwise access would spread past whoever owns the room.
    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "OVERLOOK_DENIED", tFor(ctx.user.locale, "commands:overlook.notAllowed"));
    }

    const row = await loadOrCreateForRoom(ctx);

    if (verb === "list" || verb === "ls") {
      const rows = await ctx.db
        .select({ username: users.username })
        .from(overlookEditors)
        .innerJoin(users, eq(users.id, overlookEditors.userId))
        .where(eq(overlookEditors.overlookId, row.id));
      const names = rows.map((r) => r.username).sort();
      return notice(
        ctx,
        "OVERLOOK_LIST",
        names.length
          ? tFor(ctx.user.locale, "commands:overlook.listHeader", { names: names.join(", ") })
          : tFor(ctx.user.locale, "commands:overlook.listEmpty"),
      );
    }

    const rawTarget = rest.join(" ").trim();
    if (!rawTarget) {
      return notice(ctx, "OVERLOOK_USAGE", tFor(ctx.user.locale, "commands:overlook.usage"));
    }
    const target = await resolveTarget(ctx, rawTarget);
    if (!target) return;

    if (verb === "add") {
      const existing = await ctx.db
        .select({ userId: overlookEditors.userId })
        .from(overlookEditors)
        .where(eq(overlookEditors.overlookId, row.id));
      if (existing.length >= OVERLOOK_EDITORS_MAX) {
        return notice(
          ctx,
          "OVERLOOK_CAP",
          tFor(ctx.user.locale, "commands:overlook.capReached", { max: OVERLOOK_EDITORS_MAX }),
        );
      }
      await ctx.db
        .insert(overlookEditors)
        .values({ overlookId: row.id, userId: target.userId, addedByUserId: ctx.user.id })
        .onConflictDoNothing();
      return notice(
        ctx,
        "OVERLOOK_ADDED",
        tFor(ctx.user.locale, "commands:overlook.added", { name: target.masterUsername }),
      );
    }

    // remove / rm
    const deleted = await ctx.db
      .delete(overlookEditors)
      .where(and(eq(overlookEditors.overlookId, row.id), eq(overlookEditors.userId, target.userId)))
      .returning({ userId: overlookEditors.userId });
    return notice(
      ctx,
      deleted.length ? "OVERLOOK_REMOVED" : "OVERLOOK_NOT_EDITOR",
      deleted.length
        ? tFor(ctx.user.locale, "commands:overlook.removed", { name: target.masterUsername })
        : tFor(ctx.user.locale, "commands:overlook.notAnEditor", { name: target.masterUsername }),
    );
  },
};
