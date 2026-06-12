import type { CommandHandler } from "../types.js";

/**
 * /forums [slug] — open the Forums Catalog modal (Forums revamp). With a
 * slug, lands directly on that forum. Pure UI hint; the modal fetches the
 * catalog itself over HTTP so the socket stays light.
 */
export const forumsCommand: CommandHandler = {
  name: "forums",
  aliases: ["forum", "boards"],
  usage: "/forums [forum-slug]",
  description: "Open the Forums Catalog. Add a forum's slug to land on it directly, e.g. /forums spire.",
  run(ctx) {
    const slug = ctx.argsText.trim().toLowerCase();
    ctx.socket.emit("ui:hint", slug ? { kind: "open-forums", slug } : { kind: "open-forums" });
  },
};
