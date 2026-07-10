import { broadcastPresence } from "../../realtime/broadcast.js";
import { clearMood, setMood } from "../../realtime/moodState.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

const MAX_MOOD_LEN = 32;

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/** Strip control chars and trim; return null when the result is empty (i.e. clear). */
function normalizeMood(raw: string): string | null {
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_MOOD_LEN);
}

/**
 * /mood <text>     - set your current mood (rendered as a small chip beside
 *                    your name on outgoing messages and in the userlist).
 * /mood            - clear the mood.
 * /mood clear|off  - explicit synonyms for "clear it" so users who type a
 *                    word out of habit don't accidentally set a literal mood
 *                    of "clear".
 *
 * Scope: per-identity (see realtime/moodState.ts). Setting a mood
 * while voicing Character A no longer bleeds onto sibling tabs
 * voicing Character B or the master OOC handle.
 *
 * Mood is PUBLIC. It's sent to every occupant via presence updates and
 * snapshotted onto each outgoing chat message - users should not expect it
 * to be private. The /mood command itself emits no chat line; it just
 * updates the per-identity state and re-broadcasts presence.
 */
export const moodCommand: CommandHandler = {
  name: "mood",
  aliases: ["feel", "feeling", "expression"],
  usage: "/mood <text>",
  description:
    "Set a free-text mood/expression that renders next to your name (e.g. /mood angry). /mood with no args clears it.",
  subcommands: [
    { verb: "<text>", usage: "/mood <text>", description: "Set your mood (max 32 chars)." },
    { verb: "(no args)", usage: "/mood", description: "Clear your mood.", aliases: ["clear", "off"] },
  ],
  async run(ctx) {
    const raw = ctx.argsText.trim();
    let next: string | null;
    if (!raw || /^(clear|off|none)$/i.test(raw)) {
      next = null;
    } else {
      next = normalizeMood(raw);
      if (!next) {
        notice(ctx, "MOOD_EMPTY", tFor(ctx.user.locale, "commands:mood.empty"));
        return;
      }
    }

    const charId = ctx.user.activeCharacterId;
    if (next === null) {
      clearMood(ctx.user.id, charId);
    } else {
      setMood(ctx.user.id, charId, next);
    }
    // Keep the in-flight session user in sync so the message snapshot
    // path below (addMessage's `moodSnapshot` read) picks up the new
    // value for any sends piggybacked on the same socket event before
    // the next session reload.
    ctx.user.currentMood = next;
    await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
  },
};
