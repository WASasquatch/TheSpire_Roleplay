import { sendRoomStateTo } from "../../realtime/broadcast.js";
import { tFor } from "../../i18n.js";
import type { CommandHandler } from "../types.js";

const MIN_SECONDS = 5;
const MAX_SECONDS = 3600;
const OFF_RX = /^(off|none|stop|cancel|no|0)$/i;

/**
 * /refresh           - one-shot: re-send room state + presence to your socket.
 * /refresh <N>       - SLOW MODE: throttle the real-time firehose to ease load
 *                      on a low-end device. The client stops applying the
 *                      loudest ambient events (presence / userlist churn,
 *                      typing pulses, floating theater emoji) and re-fetches
 *                      room state every N seconds (5-3600) instead. Chat
 *                      messages stay live. Replaces any prior interval.
 * /refresh off       - disable slow mode / auto-refresh.
 *
 * Implementation note: the server only emits a `set-refresh-interval` UI hint;
 * the client owns BOTH the periodic re-fetch (setInterval) AND the ambient-
 * event suppression (the App.tsx socket handlers gate on refreshIntervalSec).
 * The server never schedules per-socket timers, keeping its CPU/IO predictable;
 * the one-shot path sends only to the requesting socket, so one user's slow
 * mode never spams everyone.
 */
export const refreshCommand: CommandHandler = {
  name: "refresh",
  aliases: ["r"],
  usage: "/refresh [N|off]   (omit for one-shot, N = 5-3600 seconds)",
  description: "Refresh the userlist + topic. With a number, turns on slow mode — pauses real-time userlist/typing churn and resyncs every N seconds to ease load on slower devices.",
  subcommands: [
    { verb: "(none)", usage: "/refresh", description: "One-shot: re-fetch this room's state right now." },
    { verb: "<seconds>", usage: "/refresh 30", description: "Slow mode: pause real-time userlist/typing updates; resync every N seconds (5-3600). Chat stays live." },
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
      // Resync once immediately so the userlist (frozen under slow mode) snaps
      // back to live the instant real-time updates resume.
      await sendRoomStateTo(ctx.socket, ctx.io, ctx.db, ctx.roomId);
      ctx.socket.emit("error:notice", {
        code: "REFRESH_OFF",
        message: tFor(ctx.user.locale, "commands:refresh.slowModeOff"),
      });
      return;
    }

    const n = parseInt(arg, 10);
    if (!Number.isFinite(n) || String(n) !== arg.replace(/^\+/, "")) {
      ctx.socket.emit("error:notice", {
        code: "BAD_REFRESH",
        message: tFor(ctx.user.locale, "commands:refresh.badArg", { arg }),
      });
      return;
    }
    if (n < MIN_SECONDS || n > MAX_SECONDS) {
      ctx.socket.emit("error:notice", {
        code: "BAD_REFRESH",
        message: tFor(ctx.user.locale, "commands:refresh.outOfRange", {
          min: MIN_SECONDS,
          max: MAX_SECONDS,
        }),
      });
      return;
    }

    ctx.socket.emit("ui:hint", { kind: "set-refresh-interval", seconds: n });
    ctx.socket.emit("error:notice", {
      code: "REFRESH_ON",
      message: tFor(ctx.user.locale, "commands:refresh.slowModeOn", { seconds: n }),
    });
    // One-shot now too, so the user sees the immediate refresh.
    await sendRoomStateTo(ctx.socket, ctx.io, ctx.db, ctx.roomId);
  },
};
