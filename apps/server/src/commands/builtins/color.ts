import { eq } from "drizzle-orm";
import { characters, users } from "../../db/schema.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

const HEX_RX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

function normalize(hex: string): string {
  const v = hex.startsWith("#") ? hex.slice(1) : hex;
  // Expand #abc → #aabbcc so client doesn't have to.
  const full =
    v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  return `#${full.toLowerCase()}`;
}

/**
 * /color <hex>   → "#990000", "990000", "#abc" all valid
 * /color clear   → revert to default
 *
 * Aliases: /co (the phpMyChat shorthand), /colour (en-GB)
 */
export const colorCommand: CommandHandler = {
  name: "color",
  aliases: ["co", "colour"],
  usage: "/color <hex>   or   /color clear",
  description: "Set the hex color used for your chat messages and actions. Sets the active character's color when you're in-character, your master/OOC color otherwise, so Character A and Character B can keep different chat colors.",
  subcommands: [
    {
      verb: "(no args)",
      usage: "/color",
      description: "Show your current chat color.",
    },
    {
      verb: "<hex>",
      usage: "/color #990000",
      description: "Set your chat color. Accepts #rrggbb, rrggbb, #rgb, or rgb (e.g. /color 990000, /color #abc).",
    },
    {
      verb: "clear",
      usage: "/color clear",
      description: "Revert to the default chat color.",
      aliases: ["none", "off", "default"],
    },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim();
    // Pick the target identity. When in-character, /color sets the
    // character's own chatColor so Character A and Character B can
    // keep distinct chat colors under the same master account. When
    // OOC, /color sets the master's chatColor as before.
    const charId = ctx.user.activeCharacterId;
    const scope = charId ? "character" : "master";
    // Resolve the CURRENT color for the active identity. The session-
    // loaded ctx.user.chatColor is always the master's value; for an
    // in-character session we need a fresh DB read of the character's
    // override before reporting it back to the user.
    let currentColor: string | null = ctx.user.chatColor;
    if (charId) {
      const c = (await ctx.db
        .select({ chatColor: characters.chatColor })
        .from(characters)
        .where(eq(characters.id, charId))
        .limit(1))[0];
      currentColor = c?.chatColor ?? null;
    }

    if (!arg) {
      notice(
        ctx,
        "COLOR_HELP",
        currentColor
          ? tFor(
              ctx.user.locale,
              scope === "character" ? "commands:color.currentCharacter" : "commands:color.currentOoc",
              { color: currentColor },
            )
          : tFor(
              ctx.user.locale,
              scope === "character" ? "commands:color.noneCharacter" : "commands:color.noneOoc",
            ),
      );
      return;
    }
    if (/^(clear|none|off|default)$/i.test(arg)) {
      if (charId) {
        await ctx.db.update(characters).set({ chatColor: null }).where(eq(characters.id, charId));
      } else {
        await ctx.db.update(users).set({ chatColor: null }).where(eq(users.id, ctx.user.id));
        ctx.user.chatColor = null;
      }
      notice(
        ctx,
        "COLOR_CLEARED",
        tFor(
          ctx.user.locale,
          scope === "character" ? "commands:color.clearedCharacter" : "commands:color.clearedOoc",
        ),
      );
      const { broadcastPresence } = await import("../../realtime/broadcast.js");
      await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
      return;
    }
    if (!HEX_RX.test(arg)) {
      notice(
        ctx,
        "BAD_COLOR",
        tFor(ctx.user.locale, "commands:color.invalidHex"),
      );
      return;
    }
    const normalized = normalize(arg);
    if (charId) {
      await ctx.db.update(characters).set({ chatColor: normalized }).where(eq(characters.id, charId));
    } else {
      await ctx.db.update(users).set({ chatColor: normalized }).where(eq(users.id, ctx.user.id));
      ctx.user.chatColor = normalized;
    }
    notice(
      ctx,
      "COLOR_SET",
      tFor(
        ctx.user.locale,
        scope === "character" ? "commands:color.setCharacter" : "commands:color.setOoc",
        { color: normalized },
      ),
    );

    // Refresh occupant list so other clients see the new color metadata.
    const { broadcastPresence } = await import("../../realtime/broadcast.js");
    await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
  },
};
