import { randomInt } from "node:crypto";
import { addMessage } from "../../realtime/broadcast.js";
import type { CommandContext, CommandHandler } from "../types.js";

// `NdM` with an optional `±X` flat modifier — e.g. 1d20+3, 3d6-1, 2d10+0.
// The modifier sign is captured separately from the magnitude so a single
// expression of intent (`+3`) shows up the same in the rendered output
// regardless of whether the user wrote `+3` or `+03` (parseInt collapses
// leading zeros). Whitespace inside the expression is not accepted —
// `1d20 + 3` would be a parse error — which keeps the regex tight and the
// inline-command form (`!roll:1d20+3`) unambiguous to the parser.
const DICE_RX = /^(\d*)d(\d+)([+-]\d+)?$/i;
const MAX_DICE = 100;
const MAX_SIDES = 1000;
/** Magnitude cap on the optional flat modifier. Matches MAX_SIDES so
 *  the modifier never silently dominates a roll value's scale. */
const MAX_MODIFIER = 999;

interface ParsedDice {
  count: number;
  sides: number;
  /** Signed flat modifier added to the dice total. Zero when absent. */
  modifier: number;
}

function parseDice(input: string): ParsedDice | string {
  const m = DICE_RX.exec(input.trim());
  if (!m) return `Bad dice format. Try /roll 1d20, /roll 3d6, or /roll 1d20+3.`;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2] ?? "0", 10);
  // m[3] is the signed modifier ("+3" / "-1") or undefined when no
  // modifier was supplied. parseInt parses the leading sign too.
  const modifier = m[3] ? parseInt(m[3], 10) : 0;
  if (!Number.isFinite(count) || count < 1 || count > MAX_DICE) {
    return `Dice count must be 1-${MAX_DICE}.`;
  }
  if (!Number.isFinite(sides) || sides < 2 || sides > MAX_SIDES) {
    return `Sides must be 2-${MAX_SIDES}.`;
  }
  if (!Number.isFinite(modifier) || modifier < -MAX_MODIFIER || modifier > MAX_MODIFIER) {
    return `Modifier must be between -${MAX_MODIFIER} and +${MAX_MODIFIER}.`;
  }
  return { count, sides, modifier };
}

/**
 * Format the dice expression as it appeared in the user's input.
 * Suppresses the modifier when zero so a `+0`/`-0` round-trip
 * doesn't leak useless suffixes into the chat line.
 */
function formatDiceExpr(p: ParsedDice): string {
  const base = `${p.count}d${p.sides}`;
  if (p.modifier === 0) return base;
  return p.modifier > 0 ? `${base}+${p.modifier}` : `${base}${p.modifier}`;
}

/**
 * Render the modifier suffix appended to the result, e.g. " +3 = 17"
 * for a modifier of +3 against a dice total of 14. Empty string when
 * the modifier is zero so the existing single-die / multi-die output
 * stays unchanged for modifierless rolls.
 */
function formatModifierSuffix(modifier: number, diceTotal: number): string {
  if (modifier === 0) return "";
  const finalTotal = diceTotal + modifier;
  const sign = modifier > 0 ? "+" : "-";
  return ` ${sign} ${Math.abs(modifier)} = ${finalTotal}`;
}

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * /roll <dice>
 *   /roll 1d20      - roll one twenty-sided
 *   /roll 3d6       - roll three six-siders, returns "[4, 2, 6] = 12"
 *   /roll d20       - defaults count to 1
 *   /roll 1d20+3    - roll plus a flat modifier; output appends " + 3 = N"
 *   /roll 2d6-1     - subtraction works too
 *
 * Output is a `kind=roll` message so it can be styled distinctly. The body is
 * authoritative - clients should not re-roll. Uses crypto.randomInt for fair,
 * non-predictable values.
 */
export const rollCommand: CommandHandler = {
  name: "roll",
  aliases: ["dice"],
  usage: "/roll <NdM[±X]>   (e.g. 1d20, 3d6, 1d20+3, 2d6-1)",
  description: "Roll dice. NdM = N dice with M sides each. Optional ±X adds a flat modifier to the total. Result is broadcast to the room.",
  subcommands: [
    {
      verb: "1dM",
      usage: "/roll 1d20",
      description: "Roll one die with M sides. Output: 'rolls 1d20: 14'.",
    },
    {
      verb: "NdM",
      usage: "/roll 3d6",
      description: "Roll N dice with M sides each. Output shows individual rolls and total.",
    },
    {
      verb: "dM",
      usage: "/roll d20",
      description: "Shorthand for 1dM (count defaults to 1).",
    },
    {
      verb: "NdM±X",
      usage: "/roll 1d20+3",
      description: "Add (or subtract) a flat modifier. Output appends ' + 3 = 17' after the dice total.",
    },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim();
    if (!arg) {
      notice(ctx, "ROLL_HELP", "Usage: /roll <NdM[±X]>. Try /roll 1d20, /roll 3d6, /roll 1d20+3.");
      return;
    }
    const parsed = parseDice(arg);
    if (typeof parsed === "string") {
      notice(ctx, "BAD_DICE", parsed);
      return;
    }
    const rolls: number[] = [];
    for (let i = 0; i < parsed.count; i++) {
      rolls.push(randomInt(1, parsed.sides + 1));
    }
    const total = rolls.reduce((a, b) => a + b, 0);
    const dice = formatDiceExpr(parsed);
    const suffix = formatModifierSuffix(parsed.modifier, total);
    // Body format chosen to read naturally with kind=roll's "rolls" prefix.
    // The modifier suffix (when present) is appended to BOTH the single-die
    // and multi-die forms so the running arithmetic stays visible:
    //   "rolls 1d20+3: 14 + 3 = 17"
    //   "rolls 3d6+2: [4, 2, 6] = 12 + 2 = 14"
    const body =
      parsed.count === 1
        ? `rolls ${dice}: ${total}${suffix}`
        : `rolls ${dice}: [${rolls.join(", ")}] = ${total}${suffix}`;
    await addMessage(ctx, { kind: "roll", body });
  },
  /**
   * Inline form: `!roll` defaults to 1d20; `!roll:3d6` or `!roll:1d20+3`
   * lets a writer embed an arbitrary dice expression (with optional flat
   * modifier) mid-sentence. Output is parenthesized to match the
   * convention used by custom inline commands ("Sigrid hands him the
   * dagger ( rolls 🎲 1d20+3: 17 + 3 = 20 ) and waits") and gets
   * wrapped in the shared verification marker by the dispatcher so the
   * client renderer paints the ✓ tooltip.
   *
   * `args` here is the `:arg` payload only (the part after the colon).
   * Anything malformed returns null so the original `!roll[:…]` token
   * survives as literal text instead of silently disappearing.
   */
  inline(args) {
    const spec = (args || "1d20").trim();
    const parsed = parseDice(spec);
    if (typeof parsed === "string") return null;
    const rolls: number[] = [];
    for (let i = 0; i < parsed.count; i++) {
      rolls.push(randomInt(1, parsed.sides + 1));
    }
    const total = rolls.reduce((a, b) => a + b, 0);
    const dice = formatDiceExpr(parsed);
    const suffix = formatModifierSuffix(parsed.modifier, total);
    const result =
      parsed.count === 1 ? `${total}${suffix}` : `[${rolls.join(", ")}] = ${total}${suffix}`;
    return `( rolls 🎲 ${dice}: ${result} )`;
  },
};
