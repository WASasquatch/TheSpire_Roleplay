import { tFor } from "../../i18n.js";
import type { CommandHandler } from "../types.js";

/**
 * /bookmarks - open the user's bookmarks modal.
 *
 * No args. Bookmarks are user-scoped chat-message saves, organized into
 * free-form categories the user defines. Listing, editing, and removal
 * all happen inside the modal; this command exists so the in-chat
 * shortcut + the Tools-drawer button share a uniform
 * `onCommand("/bookmarks")` shape.
 */
export const bookmarksCommand: CommandHandler = {
  name: "bookmarks",
  aliases: ["saved", "marks"],
  usage: "/bookmarks",
  description: "Open your bookmarks, chat messages and threads you've saved for later.",
  run(ctx) {
    if (ctx.argsText.trim()) {
      ctx.socket.emit("error:notice", {
        code: "NO_ARGS",
        message: tFor(ctx.user.locale, "commands:bookmarks.noArgs"),
      });
      return;
    }
    ctx.socket.emit("ui:hint", { kind: "open-bookmarks" });
  },
};
