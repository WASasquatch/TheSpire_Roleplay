import type { CommandHandler } from "../types.js";

/**
 * /forums [slug|create] — open the Forums Catalog modal (Forums revamp).
 * With a slug, lands directly on that forum; with `create`, opens the
 * "Create your Forum" application form. Pure UI hint; the modal fetches
 * the catalog itself over HTTP so the socket stays light.
 */
export const forumsCommand: CommandHandler = {
  name: "forums",
  aliases: ["forum", "boards"],
  usage: "/forums [forum-slug | create]",
  description: "Open the Forums Catalog. Add a forum's slug to land on it directly (e.g. /forums spire), or `create` to apply for your own.",
  run(ctx) {
    const arg = ctx.argsText.trim().toLowerCase();
    if (arg === "create" || arg === "new") {
      ctx.socket.emit("ui:hint", { kind: "open-forums", create: true });
      return;
    }
    ctx.socket.emit("ui:hint", arg ? { kind: "open-forums", slug: arg } : { kind: "open-forums" });
  },
};
