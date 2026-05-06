import { randomInt } from "node:crypto";
import { addMessage } from "../../realtime/broadcast.js";
import type { CommandContext, CommandHandler } from "../types.js";

const DICE_RX = /^(\d*)d(\d+)$/i;
const MAX_DICE = 100;
const MAX_SIDES = 1000;

interface ParsedDice {
  count: number;
  sides: number;
}

function parseDice(input: string): ParsedDice | string {
  const m = DICE_RX.exec(input.trim());
  if (!m) return `Bad dice format. Try /roll 1d20 or /roll 3d6.`;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2] ?? "0", 10);
  if (!Number.isFinite(count) || count < 1 || count > MAX_DICE) {
    return `Dice count must be 1–${MAX_DICE}.`;
  }
  if (!Number.isFinite(sides) || sides < 2 || sides > MAX_SIDES) {
    return `Sides must be 2–${MAX_SIDES}.`;
  }
  return { count, sides };
}

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * /roll <dice>
 *   /roll 1d20      — roll one twenty-sided
 *   /roll 3d6       — roll three six-siders, returns "[4, 2, 6] = 12"
 *   /roll d20       — defaults count to 1
 *
 * Output is a `kind=roll` message so it can be styled distinctly. The body is
 * authoritative — clients should not re-roll. Uses crypto.randomInt for fair,
 * non-predictable values.
 */
export const rollCommand: CommandHandler = {
  name: "roll",
  aliases: ["dice"],
  usage: "/roll <NdM>   (e.g. 1d20, 3d6, 2d100)",
  description: "Roll dice. NdM = N dice with M sides each.",
  async run(ctx) {
    const arg = ctx.argsText.trim();
    if (!arg) {
      notice(ctx, "ROLL_HELP", "Usage: /roll <NdM>. Try /roll 1d20, /roll 3d6.");
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
    const dice = `${parsed.count}d${parsed.sides}`;
    // Body format chosen to read naturally with kind=roll's "rolls" prefix.
    const body =
      parsed.count === 1
        ? `rolls ${dice}: ${total}`
        : `rolls ${dice}: [${rolls.join(", ")}] = ${total}`;
    await addMessage(ctx, { kind: "roll", body });
  },
};
