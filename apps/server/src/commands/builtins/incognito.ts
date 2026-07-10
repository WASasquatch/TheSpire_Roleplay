import { eq } from "drizzle-orm";
import { users } from "../../db/schema.js";
import { addSystemMessage, broadcastPresence, roomsForUser } from "../../realtime/broadcast.js";
import { emitToUser } from "../../realtime/presence.js";
import { tFor } from "../../i18n.js";
import type { CommandContext as Ctx , CommandContext, CommandHandler } from "../types.js";

/**
 * Every room the toggling user currently has a live socket in.
 * Going incognito has to land a presence refresh on each of those
 * rooms simultaneously, broadcasting only on `ctx.roomId` (the room
 * where /incognito was typed) left every other room the user is
 * present in showing them as visible until the next /rooms poll
 * (20s). For a feature whose contract is "global invisible, no trace"
 * a 20-second leak window on every other tab the moderator had open
 * is way too much, so we walk the user's sockets up front and refresh
 * each room they're currently joined to.
 *
 * Returns the unique set of roomIds, sockets can repeat the same
 * room when the user has multiple tabs on it, so we dedupe before
 * iterating. Includes `ctx.roomId` even if no live socket is in it
 * (defensive: the command was issued from that room, so there must
 * have been a socket there at dispatch time, but if it's already
 * gone by the time we walk we still want to fire the broadcast).
 */
async function roomsUserIsIn(ctx: Ctx): Promise<string[]> {
  return roomsForUser(ctx.io, ctx.user.id, ctx.roomId);
}
import { recordAudit } from "../../audit.js";

/**
 * /incognito (alias /ghost), moderator observation tool.
 *
 * When a mod or admin enters incognito mode:
 *   - They disappear from every userlist they're in. The next
 *     presence broadcast filters them out (see broadcast.ts
 *     `INCOGNITO FILTER` block).
 *   - The current room sees a system "X has left the chat" line
 *     (or their custom exit message), visually identical to the
 *     mod legitimately leaving the room, so other participants
 *     stop adjusting their behavior around staff presence.
 *   - Room transitions (joining / leaving rooms) STOP broadcasting
 *     their leave/join events while incognito, so they can drift
 *     across rooms without trace.
 *   - Any chat message they send while incognito renders as a
 *     server-system line under `incognito_alias` (default
 *     "System"). The audit log records the actual sender for
 *     accountability.
 *
 * When they leave incognito:
 *   - A system "X has joined the chat" line broadcasts (or their
 *     custom return message), then the next presence broadcast
 *     puts them back in the userlist.
 *
 * State persists on the user row (incognito_mode + incognito_alias
 * + custom messages) so a tab refresh / network blip doesn't pop
 * them back into visibility mid-investigation. Toggle is the only
 * way out, there's no automatic timeout.
 *
 * Subcommand shape:
 *   /incognito                     , toggle on/off
 *   /incognito on                  , explicit on
 *   /incognito off                 , explicit off
 *   /incognito <alias>             , set alias + turn on (if off)
 *   /incognito alias <name>        , set alias only
 *   /incognito exit <message>      , set custom leave-message
 *   /incognito return <message>    , set custom join-message
 *   /incognito clear               , reset alias + custom messages
 *
 * Permission-gated. Users without `use_ghost_mode` get the same
 * "unknown command" surface as if the command didn't exist (the
 * dispatcher's permission check + the /commands endpoint's filter
 * keep it out of `/help` for them).
 */

/** Default placeholder used in the "X has left the chat" line when
 *  the user hasn't set a custom exit message. */
function defaultExitMessage(displayName: string): string {
  return `${displayName} has left the chat.`;
}

function defaultReturnMessage(displayName: string): string {
  return `${displayName} has joined the chat.`;
}

/**
 * Update the user's incognito fields and re-fetch so subsequent
 * dispatch ticks see the updated state. Returns the fresh row.
 *
 * Also fans a `me:incognito-update` socket event out to EVERY live
 * socket the user owns (current tab + any sibling tabs), so the
 * "Go Incognito / Leave Incognito" menu label and the "You are in
 * incognito mode" chat banner flip immediately on every surface
 * without waiting on the /auth/me poll (60-second cadence) to
 * eventually notice. Before this, the visible UI lagged the actual
 * server state by up to a minute, which read as "the command didn't
 * land" and led mods to re-issue it.
 */
async function patchUser(
  ctx: CommandContext,
  patch: Partial<typeof users.$inferInsert>,
): Promise<typeof users.$inferSelect> {
  await ctx.db.update(users).set(patch).where(eq(users.id, ctx.user.id));
  const fresh = (await ctx.db.select().from(users).where(eq(users.id, ctx.user.id)).limit(1))[0]!;
  // Keep the in-memory session user (and the per-socket cached
  // user, if present) in sync so downstream code paths in this
  // dispatch tick, and on the NEXT dispatched event from the same
  // socket, see the updated state without a round-trip through
  // loadSessionUser.
  ctx.user.incognitoMode = fresh.incognitoMode;
  ctx.user.incognitoAlias = fresh.incognitoAlias;
  ctx.user.incognitoCharacterId = fresh.incognitoCharacterId;
  ctx.user.incognitoExitMessage = fresh.incognitoExitMessage;
  ctx.user.incognitoReturnMessage = fresh.incognitoReturnMessage;
  const cached = (ctx.socket.data as { user?: typeof ctx.user }).user;
  if (cached && cached.id === ctx.user.id) {
    cached.incognitoMode = fresh.incognitoMode;
    cached.incognitoAlias = fresh.incognitoAlias;
    cached.incognitoCharacterId = fresh.incognitoCharacterId;
    cached.incognitoExitMessage = fresh.incognitoExitMessage;
    cached.incognitoReturnMessage = fresh.incognitoReturnMessage;
  }
  // Push the new state to every live socket the user owns so each
  // tab's `me.incognitoMode` / `me.incognitoAlias` updates the
  // moment the toggle / alias change lands, not on the next
  // /auth/me poll. The handler on the client side updates the
  // chat store directly, same posture as `me:character-update`.
  await emitToUser(ctx.io, ctx.user.id, "me:incognito-update", {
    incognitoMode: fresh.incognitoMode,
    incognitoAlias: fresh.incognitoAlias,
    incognitoCharacterId: fresh.incognitoCharacterId,
  });
  return fresh;
}

async function enterIncognito(ctx: CommandContext, opts: { aliasOverride?: string | null }): Promise<void> {
  // Snapshot the display name BEFORE flipping the mode bit so the
  // exit-message broadcast uses the real identity (otherwise the
  // chat would say "System has left the chat" which is nonsensical).
  const realDisplayName = ctx.user.displayName;

  // Stamp WHICH identity this tab is going incognito as, so only that
  // one character (or OOC, when null) gets hidden. Prefer the socket's
  // per-tab character; fall back to the account's default active one.
  const tabRaw = (ctx.socket.data as { tabCharId?: string | null }).tabCharId;
  const identityCharId = tabRaw !== undefined ? tabRaw : (ctx.user.activeCharacterId ?? null);
  const patch: Partial<typeof users.$inferInsert> = { incognitoMode: true, incognitoCharacterId: identityCharId };
  if (opts.aliasOverride !== undefined) patch.incognitoAlias = opts.aliasOverride;
  const fresh = await patchUser(ctx, patch);

  // Broadcast the "X has left the chat" line BEFORE the presence
  // broadcast hides the user, otherwise other clients couldn't
  // visually correlate the leave message with a specific row.
  // Use addSystemMessage (not addMessage with kind:"system") so the
  // persisted row's displayName is the literal "system" and the
  // client renders it as a bare system notice. addMessage would have
  // stamped the moderator's real displayName onto the row, which the
  // client now surfaces as a `[Name]` prefix, leaking the mod's
  // identity on the very line that's supposed to disguise it.
  const exitLine = fresh.incognitoExitMessage ?? defaultExitMessage(realDisplayName);
  // Exit line goes ONLY to ctx.roomId, that's the room the mod was
  // visible in when they typed the command, so other participants
  // see one coherent "X has left the chat." The OTHER rooms the
  // mod has tabs in get a silent presence refresh (no exit message)
  // so the leaving moderator doesn't accidentally light up every
  // room with a leave broadcast.
  await addSystemMessage(ctx.io, ctx.db, ctx.roomId, exitLine);
  const rooms = await roomsUserIsIn(ctx);
  for (const rid of rooms) {
    await broadcastPresence(ctx.io, ctx.db, rid);
  }

  await recordAudit(ctx.db, {
    actorUserId: ctx.user.id,
    action: "incognito_enter",
    metadata: {
      roomId: ctx.roomId,
      alias: fresh.incognitoAlias ?? "System",
      hadCustomExit: !!fresh.incognitoExitMessage,
    },
  });

  // Quiet confirmation to the caller only, other clients see the
  // exit message above, but the mod themself needs an explicit
  // ack so they know the toggle landed.
  ctx.socket.emit("error:notice", {
    code: "INCOGNITO_ON",
    message: tFor(ctx.user.locale, "commands:incognito.on", { alias: fresh.incognitoAlias ?? "System" }),
  });
}

async function leaveIncognito(ctx: CommandContext): Promise<void> {
  // The current user row carries the alias the mod was wearing
  // while incognito; their actual display name is whatever they'd
  // normally render as. We have to compute the "real" display name
  // since ctx.user.displayName may have been incognito-rewritten.
  // Easiest: fetch their master row + active character name.
  const meRow = (await ctx.db.select().from(users).where(eq(users.id, ctx.user.id)).limit(1))[0]!;
  // Real display name = the user's master username, or the active
  // character's name if one is attached. We don't need the full
  // resolver here, the system line just identifies who came back.
  const realDisplayName = ctx.user.activeCharacterId == null
    ? meRow.username
    : ctx.user.displayName;  // already character-resolved by the dispatcher

  const fresh = await patchUser(ctx, { incognitoMode: false, incognitoCharacterId: null });

  const returnLine = fresh.incognitoReturnMessage ?? defaultReturnMessage(realDisplayName);
  // Same addSystemMessage rationale as enterIncognito, keep the
  // persisted displayName as the bare "system" sentinel so the
  // client doesn't render this as `[Name] X has joined the chat.`.
  await addSystemMessage(ctx.io, ctx.db, ctx.roomId, returnLine);
  // Symmetric to enterIncognito: refresh the userlist in every room
  // the moderator has a live socket in, so they reappear immediately
  // everywhere instead of waiting on the 20s /rooms poll for the
  // rooms beyond ctx.roomId.
  const rooms = await roomsUserIsIn(ctx);
  for (const rid of rooms) {
    await broadcastPresence(ctx.io, ctx.db, rid);
  }

  await recordAudit(ctx.db, {
    actorUserId: ctx.user.id,
    action: "incognito_exit",
    metadata: {
      roomId: ctx.roomId,
      hadCustomReturn: !!fresh.incognitoReturnMessage,
    },
  });

  ctx.socket.emit("error:notice", {
    code: "INCOGNITO_OFF",
    message: tFor(ctx.user.locale, "commands:incognito.off"),
  });
}

export const incognitoCommand: CommandHandler = {
  name: "incognito",
  aliases: ["ghost"],
  usage: "/incognito [<alias> | on | off | alias <name> | exit <message> | return <message> | clear]",
  description: "Disappear from the userlist and observe rooms unseen. Mod/admin only.",
  permission: "use_ghost_mode",
  subcommands: [
    { verb: "(no args)", usage: "/incognito", description: "Toggle incognito on or off." },
    { verb: "on", usage: "/incognito on", description: "Explicitly go incognito." },
    { verb: "off", usage: "/incognito off", description: "Explicitly leave incognito." },
    { verb: "<alias>", usage: "/incognito God", description: "Go incognito and use <alias> as your message-author name (default \"System\")." },
    { verb: "alias", usage: "/incognito alias <name>", description: "Change the alias without flipping mode." },
    { verb: "exit", usage: "/incognito exit <message>", description: "Set the custom leave-message broadcast when you go incognito." },
    { verb: "return", usage: "/incognito return <message>", description: "Set the custom join-message broadcast when you come back." },
    { verb: "clear", usage: "/incognito clear", description: "Reset alias + exit/return messages to defaults." },
  ],
  async run(ctx) {
    const [verb, ...rest] = ctx.args;
    const verbLower = (verb ?? "").toLowerCase();
    const meRow = (await ctx.db
      .select({
        incognitoMode: users.incognitoMode,
        incognitoAlias: users.incognitoAlias,
        incognitoExitMessage: users.incognitoExitMessage,
        incognitoReturnMessage: users.incognitoReturnMessage,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1))[0]!;

    // No args → straight toggle.
    if (!verb) {
      if (meRow.incognitoMode) {
        await leaveIncognito(ctx);
      } else {
        await enterIncognito(ctx, {});
      }
      return;
    }

    // Explicit on/off.
    if (verbLower === "on") {
      if (meRow.incognitoMode) {
        ctx.socket.emit("error:notice", {
          code: "INCOGNITO_ALREADY_ON",
          message: tFor(ctx.user.locale, "commands:incognito.alreadyOn"),
        });
        return;
      }
      await enterIncognito(ctx, {});
      return;
    }
    if (verbLower === "off") {
      if (!meRow.incognitoMode) {
        ctx.socket.emit("error:notice", {
          code: "INCOGNITO_ALREADY_OFF",
          message: tFor(ctx.user.locale, "commands:incognito.alreadyOff"),
        });
        return;
      }
      await leaveIncognito(ctx);
      return;
    }

    // Alias / exit / return setters. Each is a sub-verb with the
    // rest of the args as the payload.
    if (verbLower === "alias") {
      const alias = rest.join(" ").trim();
      if (!alias) {
        ctx.socket.emit("error:notice", {
          code: "INCOGNITO_ALIAS_USAGE",
          message: tFor(ctx.user.locale, "commands:incognito.aliasUsage"),
        });
        return;
      }
      if (alias.length > 60) {
        ctx.socket.emit("error:notice", {
          code: "INCOGNITO_ALIAS_TOO_LONG",
          message: tFor(ctx.user.locale, "commands:incognito.aliasTooLong"),
        });
        return;
      }
      await patchUser(ctx, { incognitoAlias: alias });
      ctx.socket.emit("error:notice", {
        code: "INCOGNITO_ALIAS_SET",
        message: tFor(ctx.user.locale, "commands:incognito.aliasSet", { alias }),
      });
      return;
    }
    if (verbLower === "exit") {
      const message = rest.join(" ").trim();
      if (!message) {
        ctx.socket.emit("error:notice", {
          code: "INCOGNITO_EXIT_USAGE",
          message: tFor(ctx.user.locale, "commands:incognito.exitUsage"),
        });
        return;
      }
      if (message.length > 280) {
        ctx.socket.emit("error:notice", {
          code: "INCOGNITO_EXIT_TOO_LONG",
          message: tFor(ctx.user.locale, "commands:incognito.exitTooLong"),
        });
        return;
      }
      await patchUser(ctx, { incognitoExitMessage: message });
      ctx.socket.emit("error:notice", {
        code: "INCOGNITO_EXIT_SET",
        message: tFor(ctx.user.locale, "commands:incognito.exitSaved"),
      });
      return;
    }
    if (verbLower === "return") {
      const message = rest.join(" ").trim();
      if (!message) {
        ctx.socket.emit("error:notice", {
          code: "INCOGNITO_RETURN_USAGE",
          message: tFor(ctx.user.locale, "commands:incognito.returnUsage"),
        });
        return;
      }
      if (message.length > 280) {
        ctx.socket.emit("error:notice", {
          code: "INCOGNITO_RETURN_TOO_LONG",
          message: tFor(ctx.user.locale, "commands:incognito.returnTooLong"),
        });
        return;
      }
      await patchUser(ctx, { incognitoReturnMessage: message });
      ctx.socket.emit("error:notice", {
        code: "INCOGNITO_RETURN_SET",
        message: tFor(ctx.user.locale, "commands:incognito.returnSaved"),
      });
      return;
    }
    if (verbLower === "clear") {
      await patchUser(ctx, {
        incognitoAlias: null,
        incognitoExitMessage: null,
        incognitoReturnMessage: null,
      });
      ctx.socket.emit("error:notice", {
        code: "INCOGNITO_CLEARED",
        message: tFor(ctx.user.locale, "commands:incognito.cleared"),
      });
      return;
    }

    // Bare positional alias, `/incognito God` → set alias to "God"
    // AND enter incognito in one step. The args.join here gathers
    // multi-word aliases ("/incognito The Watcher").
    const alias = ctx.argsText.trim();
    if (alias.length > 60) {
      ctx.socket.emit("error:notice", {
        code: "INCOGNITO_ALIAS_TOO_LONG",
        message: tFor(ctx.user.locale, "commands:incognito.aliasTooLong"),
      });
      return;
    }
    if (meRow.incognitoMode) {
      // Already on, just update alias.
      await patchUser(ctx, { incognitoAlias: alias });
      ctx.socket.emit("error:notice", {
        code: "INCOGNITO_ALIAS_SET",
        message: tFor(ctx.user.locale, "commands:incognito.aliasSet", { alias }),
      });
      return;
    }
    await enterIncognito(ctx, { aliasOverride: alias });
  },
};
