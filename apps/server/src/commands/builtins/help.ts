import type { CommandHandler } from "../types.js";

/**
 * /help [command]
 *
 * Opens the help modal on the client. With an argument, the modal pre-filters
 * to that command (so /help char highlights the /char card with its
 * subcommand reference). The modal fetches the rich command list from
 * GET /commands.
 */
export function makeHelpCommand(_getRegistry: () => { listCanonical(): CommandHandler[] }): CommandHandler {
  return {
    name: "help",
    aliases: ["h", "?"],
    usage: "/help [command]",
    description: "Open the help modal. With an argument, jump straight to that command.",
    run(ctx) {
      const target = ctx.argsText.trim().toLowerCase().replace(/^\//, "");
      const hint =
        target.length > 0
          ? { kind: "open-help" as const, filter: target }
          : { kind: "open-help" as const };
      ctx.socket.emit("ui:hint", hint);
    },
  };
}
