import type { CommandHandler } from "../types.js";

/**
 * /users — open the searchable user directory modal.
 *
 * No args. The actual list is fetched by the modal via GET /users; this
 * command exists so users can open it from the composer (and so the
 * Tools panel button has a uniform `onCommand("/users")` shape).
 */
export const usersCommand: CommandHandler = {
  name: "users",
  aliases: ["who-list", "directory"],
  usage: "/users",
  description: "Open the directory of registered users (master + characters).",
  run(ctx) {
    if (ctx.argsText.trim()) {
      ctx.socket.emit("error:notice", {
        code: "NO_ARGS",
        message: "/users takes no arguments. Use /whois <name> to view someone specific.",
      });
      return;
    }
    ctx.socket.emit("ui:hint", { kind: "open-users" });
  },
};
