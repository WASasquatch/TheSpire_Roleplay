import { sendRoomStateTo } from "../../realtime/broadcast.js";
import type { CommandHandler } from "../types.js";

const MIN_SECONDS = 5;
const MAX_SECONDS = 3600;
const OFF_RX = /^(off|none|stop|cancel|no|0)$/i;

/**
 * /refresh           — one-shot: re-send room state + presence to your socket.
 * /refresh <N>       — set auto-refresh interval (5–3600 seconds). Replaces any prior interval.
 * /refresh off       — disable auto-refresh.
 *
 * Implementation note: the server only emits a `set-refresh-interval` UI hint;
 * the client owns the actual setInterval. This keeps server CPU/IO predictable
 * — we never schedule per-socket timers. The one-shot path also sends only to
 * the requesting socket, so auto-refresh from one user does not spam everyone.
 */
export const refreshCommand: CommandHandler = {
  name: "refresh",
  aliases: ["r"],
  usage: "/refresh [N|off]   (omit for one-shot, N = 5–3600 seconds)",
  description: "Refresh the userlist + topic. With a number, sets an auto-refresh interval.",
  subcommands: [
    { verb: "(none)", usage: "/refresh", description: "One-shot: re-fetch this room's state right now." },
    { verb: "<seconds>", usage: "/refresh 30", description: "Auto-refresh every N seconds (5–3600)." },
    {
      verb: "off",
      usage: "/refresh off",
      description: "Disable auto-refresh.",
      aliases: ["0", "none", "stop", "cancel", "no"],
    },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim();

    if (!arg) {
      await sendRoomStateTo(ctx.socket, ctx.io, ctx.db, ctx.roomId);
      return;
    }

    if (OFF_RX.test(arg)) {
      ctx.socket.emit("ui:hint", { kind: "set-refresh-interval", seconds: 0 });
      ctx.socket.emit("error:notice", {
        code: "REFRESH_OFF",
        message: "Auto-refresh disabled.",
      });
      return;
    }

    const n = parseInt(arg, 10);
    if (!Number.isFinite(n) || String(n) !== arg.replace(/^\+/, "")) {
      ctx.socket.emit("error:notice", {
        code: "BAD_REFRESH",
        message: `Usage: /refresh [seconds|off]. Got "${arg}".`,
      });
      return;
    }
    if (n < MIN_SECONDS || n > MAX_SECONDS) {
      ctx.socket.emit("error:notice", {
        code: "BAD_REFRESH",
        message: `Auto-refresh must be between ${MIN_SECONDS} and ${MAX_SECONDS} seconds (or 'off').`,
      });
      return;
    }

    ctx.socket.emit("ui:hint", { kind: "set-refresh-interval", seconds: n });
    ctx.socket.emit("error:notice", {
      code: "REFRESH_ON",
      message: `Auto-refresh: every ${n}s. Use /refresh off to stop.`,
    });
    // One-shot now too, so the user sees the immediate refresh.
    await sendRoomStateTo(ctx.socket, ctx.io, ctx.db, ctx.roomId);
  },
};
