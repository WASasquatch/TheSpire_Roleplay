import { eq } from "drizzle-orm";
import { users } from "../../db/schema.js";
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
  description: "Set the hex color used for your chat messages and actions.",
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
    if (!arg) {
      notice(
        ctx,
        "COLOR_HELP",
        ctx.user.chatColor
          ? `Current color: ${ctx.user.chatColor}. Usage: /color <hex>  |  /color clear`
          : "No color set. Usage: /color <hex>  (e.g. /color 990000)",
      );
      return;
    }
    if (/^(clear|none|off|default)$/i.test(arg)) {
      await ctx.db.update(users).set({ chatColor: null }).where(eq(users.id, ctx.user.id));
      ctx.user.chatColor = null;
      notice(ctx, "COLOR_CLEARED", "Chat color cleared.");
      return;
    }
    if (!HEX_RX.test(arg)) {
      notice(
        ctx,
        "BAD_COLOR",
        "Color must be a hex value: e.g. /color 990000 or /color #abc.",
      );
      return;
    }
    const normalized = normalize(arg);
    await ctx.db.update(users).set({ chatColor: normalized }).where(eq(users.id, ctx.user.id));
    ctx.user.chatColor = normalized;
    notice(ctx, "COLOR_SET", `Chat color set to ${normalized}.`);

    // Refresh occupant list so other clients see the new color metadata.
    const { broadcastPresence } = await import("../../realtime/broadcast.js");
    await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
  },
};
