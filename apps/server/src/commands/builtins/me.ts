import { addMessage } from "../../realtime/broadcast.js";
import type { CommandHandler } from "../types.js";

/**
 * Action / pose command.
 *
 * Renders as `<DisplayName> <body>` — no brackets, no colon, no prefix.
 * The body is treated as the rest of the message, *not* tokenized: punctuation
 * and casing are preserved exactly as typed.
 *
 * Pronoun aliases (`/he`, `/she`, `/they`, `/it`, `/em`) all resolve to this
 * handler — the display name is always the sender's display name; pronouns
 * inside the action text remain the author's responsibility (this matches the
 * roleplay convention of writing your own pronouns).
 */
export const meCommand: CommandHandler = {
  name: "me",
  aliases: ["he", "she", "they", "it", "em", "action", "pose", "emote"],
  usage: "/me <action>",
  description: "Send an action — renders as 'YourName does the thing.' with no brackets.",
  async run(ctx) {
    const body = ctx.argsText.trim();
    if (!body) {
      ctx.socket.emit("error:notice", {
        code: "EMPTY_ACTION",
        message: `Usage: /${ctx.invokedAs} <action>`,
      });
      return;
    }
    await addMessage(ctx, { kind: "me", body });
  },
};
