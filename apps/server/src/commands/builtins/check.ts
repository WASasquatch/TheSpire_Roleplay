import { randomInt } from "node:crypto";
import { addMessage } from "../../realtime/broadcast.js";
import type { CommandHandler } from "../types.js";

/** Coin-flip a single Pass/Fail outcome. crypto.randomInt for a fair,
 *  non-predictable result (same source as /roll). */
function flip(): "Pass" | "Fail" {
  return randomInt(0, 2) === 1 ? "Pass" : "Fail";
}

/** Verdict glyph + word, e.g. "✓ Pass". Shared by the standalone and
 *  inline forms so both read identically. */
function verdict(): string {
  const r = flip();
  return r === "Pass" ? "✓ Pass" : "✗ Fail";
}

/**
 * /check
 *   A bare Pass/Fail check, the simplest dynamic prompt. Output is a
 *   `kind=roll` message (styled like /roll, body authoritative) so the
 *   result can't be re-rolled client-side:
 *     "Sigrid makes a check: ✓ Pass"
 *
 * For a check that branches into different prose on pass vs fail, use the
 * `<check>` block instead (see packages/shared/src/dynamicCheck.ts):
 *   <check>
 *     <pass>It works.</pass>
 *     <fail>It doesn't.</fail>
 *   </check>
 *
 * This is an official builtin, so it (and the inline `!check`) take
 * priority over any same-named custom command.
 */
export const checkCommand: CommandHandler = {
  name: "check",
  usage: "/check",
  description:
    "Make a 50/50 Pass/Fail check. Result is broadcast to the room and can't be re-rolled. For branching prose, use a <check>…</check> block.",
  async run(ctx) {
    await addMessage(ctx, { kind: "roll", body: `makes a check: ${verdict()}` });
  },
  /**
   * Inline form: `!check` drops a parenthesized verdict mid-sentence,
   * matching the `!roll` convention ("she tries the lock ( check: ✓ Pass )").
   * The dispatcher wraps the return in the verification marker so the
   * client paints the ✓ "authentic server output" tooltip.
   */
  inline() {
    return `( check: ${verdict()} )`;
  },
};
