import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS } from "@thekeep/shared";
import { addMessage } from "../../realtime/broadcast.js";
import { buildPollData } from "../../polls.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Parse a `--for <duration>` flag value into an absolute close time (ms).
 * Accepts `30m`, `2h`, `1d`; returns null on anything unparseable.
 */
function parseDeadline(spec: string): number | null {
  const m = /^(\d+)\s*([mhd])$/i.exec(spec.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]!.toLowerCase();
  const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
  return Date.now() + ms;
}

/**
 * Pull leading `--flag [value]` tokens off the front of the argument string.
 * Supported: `--multi` (allow multiple choices), `--secret` (hide voters),
 * `--for <dur>` (auto-close deadline). Returns the parsed flags plus the
 * remaining text (the `question | options` part).
 */
function parseFlags(argsText: string): {
  allowMultiple: boolean;
  showVoters: boolean;
  closesAt: number | null;
  rest: string;
  /** i18n key for a flag-parse failure; rendered via tFor at the emit site. */
  error?: string;
} {
  let allowMultiple = false;
  let showVoters = true;
  let closesAt: number | null = null;
  const tokens = argsText.split(/\s+/);
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!.toLowerCase();
    if (t === "--multi" || t === "--multiple") { allowMultiple = true; continue; }
    if (t === "--secret" || t === "--anon" || t === "--anonymous") { showVoters = false; continue; }
    if (t === "--for" || t === "--deadline") {
      const val = tokens[i + 1];
      if (!val) return { allowMultiple, showVoters, closesAt, rest: "", error: "commands:poll.forMissing" };
      const at = parseDeadline(val);
      if (at === null) return { allowMultiple, showVoters, closesAt, rest: "", error: "commands:poll.forInvalid" };
      closesAt = at;
      i++;
      continue;
    }
    break; // first non-flag token starts the question
  }
  return { allowMultiple, showVoters, closesAt, rest: tokens.slice(i).join(" ") };
}

/**
 * /poll [--multi] [--secret] [--for <dur>] Question? | Option A | Option B [| ...]
 *
 * Creates a `kind: "poll"` message in the current room (chat) — the same
 * model the forum poll composer uses. The question is the body; options and
 * settings ride pollDataJson. Voting + closing happen over the poll:vote /
 * poll:close socket events; results render in the PollCard.
 */
export const pollCommand: CommandHandler = {
  name: "poll",
  usage: "/poll [--multi] [--secret] [--for 2h] <question> | <option1> | <option2> [| ...]",
  description:
    "Start a poll. Separate the question and each option with | . Flags: --multi (pick several), --secret (hide who voted), --for 2h (auto-close).",
  subcommands: [
    { verb: "basic", usage: "/poll Best season? | Spring | Summer | Fall | Winter", description: "Single-choice poll; voters' names show after they vote." },
    { verb: "--multi", usage: "/poll --multi Snacks? | Chips | Nuts | Fruit", description: "Let voters pick more than one option." },
    { verb: "--secret", usage: "/poll --secret Who wins? | A | B", description: "Hide who voted for what (counts only)." },
    { verb: "--for", usage: "/poll --for 2h Close soon? | Yes | No", description: "Auto-close after the duration (30m, 2h, 1d). You can also close it manually." },
  ],
  async run(ctx) {
    const argsText = ctx.argsText.trim();
    if (!argsText) {
      notice(ctx, "POLL_HELP", tFor(ctx.user.locale, "commands:poll.usage"));
      return;
    }
    const flags = parseFlags(argsText);
    if (flags.error) { notice(ctx, "POLL_BAD_FLAG", tFor(ctx.user.locale, flags.error)); return; }

    const parts = flags.rest.split("|").map((s) => s.trim());
    const question = parts[0] ?? "";
    const optionTexts = parts.slice(1);
    if (!question) {
      notice(ctx, "POLL_NO_QUESTION", tFor(ctx.user.locale, "commands:poll.noQuestion"));
      return;
    }
    if (optionTexts.length < POLL_MIN_OPTIONS) {
      notice(ctx, "POLL_TOO_FEW", tFor(ctx.user.locale, "commands:poll.tooFew", { min: POLL_MIN_OPTIONS, question }));
      return;
    }
    if (optionTexts.length > POLL_MAX_OPTIONS) {
      notice(ctx, "POLL_TOO_MANY", tFor(ctx.user.locale, "commands:poll.tooMany", { max: POLL_MAX_OPTIONS }));
      return;
    }

    const built = buildPollData({
      optionTexts,
      allowMultiple: flags.allowMultiple,
      showVoters: flags.showVoters,
      closesAt: flags.closesAt,
      question,
      locale: ctx.user.locale,
    });
    if (!built.ok) { notice(ctx, "POLL_INVALID", built.error); return; }

    await addMessage(ctx, { kind: "poll", body: question, pollDataJson: built.json });
  },
};
