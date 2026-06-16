import { randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { roomMembers, rooms } from "../../db/schema.js";
import { addMessage, addSystemMessage } from "../../realtime/broadcast.js";
import { hasPermission } from "../../auth/permissions.js";
import type { CommandContext, CommandHandler } from "../types.js";

// `NdM` with an optional `±X` flat modifier, e.g. 1d20+3, 3d6-1, 2d10+0.
// The modifier sign is captured separately from the magnitude so a single
// expression of intent (`+3`) shows up the same in the rendered output
// regardless of whether the user wrote `+3` or `+03` (parseInt collapses
// leading zeros). Whitespace inside the expression is not accepted,
// `1d20 + 3` would be a parse error, which keeps the regex tight and the
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

/** Hard cap on a settable room difficulty. Generous (handles big modifier
 *  stacks) without letting a typo park an unreachable value. */
const MAX_DC = 1000;

/** Fetch the current room's configured Difficulty Class, or null when
 *  unset / the room row is missing. */
async function getRoomDc(ctx: CommandContext): Promise<number | null> {
  const r = (await ctx.db
    .select({ dc: rooms.difficultyClass })
    .from(rooms)
    .where(eq(rooms.id, ctx.roomId))
    .limit(1))[0];
  return r?.dc ?? null;
}

/**
 * Authority to set the room's difficulty. Mirrors room.ts's
 * `callerCanEditRoom`: site admins (via `edit_any_room_metadata`), the
 * room owner, or a roomMembers "owner"/"mod".
 */
async function callerCanSetDc(ctx: CommandContext): Promise<boolean> {
  if (await hasPermission(ctx.user, "edit_any_room_metadata", ctx.db)) return true;
  const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
  if (!room) return false;
  if (room.ownerId === ctx.user.id) return true;
  const m = (await ctx.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, ctx.roomId), eq(roomMembers.userId, ctx.user.id)))
    .limit(1))[0];
  return m?.role === "owner" || m?.role === "mod";
}

/**
 * Pass/fail suffix appended to a roll's body when the room has a DC set.
 * Empty string when no DC is configured, so a difficulty-free room's
 * rolls render exactly as before. A roll MEETS OR BEATS the DC to pass.
 */
function formatDcSuffix(finalTotal: number, dc: number | null): string {
  if (dc == null) return "";
  return `  — vs DC ${dc} ${finalTotal >= dc ? "✓ Pass" : "✗ Fail"}`;
}

/**
 * `/roll dc` subcommand. View (no further args), set (`/roll dc 15`), or
 * clear (`/roll dc clear|off|none`) the room's Difficulty Class. Viewing
 * is open to anyone in the room; changing it is owner/mod/admin only.
 */
async function handleDcSubcommand(ctx: CommandContext): Promise<void> {
  const rest = ctx.args.slice(1);
  if (rest.length === 0) {
    const dc = await getRoomDc(ctx);
    notice(
      ctx,
      "ROLL_DC",
      dc != null
        ? `Room difficulty is ${dc}. Rolls meet or beat it to pass.`
        : "No difficulty set for this room. Owners/mods can set one with /roll dc <n>.",
    );
    return;
  }
  if (!(await callerCanSetDc(ctx))) {
    notice(ctx, "PERM", "Only the room owner, a mod, or an admin can set the difficulty.");
    return;
  }
  const first = (rest[0] ?? "").toLowerCase();
  if (first === "clear" || first === "off" || first === "none") {
    await ctx.db.update(rooms).set({ difficultyClass: null }).where(eq(rooms.id, ctx.roomId));
    await addSystemMessage(ctx.io, ctx.db, ctx.roomId, `${ctx.user.displayName} cleared the room difficulty.`);
    return;
  }
  const n = Number(first);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DC) {
    notice(ctx, "BAD_DC", `Difficulty must be a whole number from 1 to ${MAX_DC}. Try /roll dc 15.`);
    return;
  }
  await ctx.db.update(rooms).set({ difficultyClass: n }).where(eq(rooms.id, ctx.roomId));
  await addSystemMessage(
    ctx.io,
    ctx.db,
    ctx.roomId,
    `${ctx.user.displayName} set the room difficulty to ${n}. Rolls must meet or beat it to pass.`,
  );
}

/**
 * /roll <dice>
 *   /roll 1d20      - roll one twenty-sided
 *   /roll 3d6       - roll three six-siders, returns "[4, 2, 6] = 12"
 *   /roll d20       - defaults count to 1
 *   /roll 1d20+3    - roll plus a flat modifier; output appends " + 3 = N"
 *   /roll 2d6-1     - subtraction works too
 *   /roll dc 15     - (owner/mod/admin) set the room's Difficulty Class
 *   /roll dc        - show the room's current difficulty
 *   /roll dc clear  - remove the room's difficulty
 *
 * Output is a `kind=roll` message so it can be styled distinctly. The body is
 * authoritative - clients should not re-roll. Uses crypto.randomInt for fair,
 * non-predictable values. When the room has a difficulty set, every roll's
 * body is tagged with a pass/fail verdict against it.
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
    {
      verb: "dc <n>",
      usage: "/roll dc 15",
      description: "Owner/mod/admin: set the room's Difficulty Class. /roll dc shows it; /roll dc clear removes it. When set, every roll is tagged pass/fail against it.",
    },
  ],
  async run(ctx) {
    const arg = ctx.argsText.trim();
    if (!arg) {
      notice(ctx, "ROLL_HELP", "Usage: /roll <NdM[±X]>. Try /roll 1d20, /roll 3d6, /roll 1d20+3.");
      return;
    }
    // `/roll dc [...]` manages the room's Difficulty Class instead of
    // rolling. Checked before dice parsing so "dc" isn't mistaken for an
    // expression.
    if ((ctx.args[0] ?? "").toLowerCase() === "dc") {
      await handleDcSubcommand(ctx);
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
    // Pass/fail tag against the room's difficulty, if one is set. The
    // comparison uses the modifier-adjusted total so "/roll 1d20+3"
    // checks 17, not 14.
    const dcSuffix = formatDcSuffix(total + parsed.modifier, await getRoomDc(ctx));
    // Body format chosen to read naturally with kind=roll's "rolls" prefix.
    // The modifier suffix (when present) is appended to BOTH the single-die
    // and multi-die forms so the running arithmetic stays visible:
    //   "rolls 1d20+3: 14 + 3 = 17"
    //   "rolls 3d6+2: [4, 2, 6] = 12 + 2 = 14"
    const body =
      parsed.count === 1
        ? `rolls ${dice}: ${total}${suffix}${dcSuffix}`
        : `rolls ${dice}: [${rolls.join(", ")}] = ${total}${suffix}${dcSuffix}`;
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

/** Optional flat initiative modifier, e.g. `/init +3` or `/init -1`. */
const INIT_MOD_RX = /^([+-]?\d+)$/;
const MAX_INIT_MOD = 999;

/**
 * /initiative  (alias /init)
 *   Roll 1d20 for turn order. Takes an optional flat modifier
 *   (`/init +3`). When the room has a Difficulty Class set (via
 *   `/roll dc`), the result is tagged pass/fail against it, same as
 *   `/roll`. Output is an authoritative `kind=roll` message.
 */
export const initiativeCommand: CommandHandler = {
  name: "initiative",
  aliases: ["init"],
  usage: "/initiative [±X]   (e.g. /init, /init +3)",
  description: "Roll 1d20 for initiative, with an optional flat modifier. If the room has a difficulty set (/roll dc), the result is marked pass/fail.",
  async run(ctx) {
    const arg = ctx.argsText.trim();
    let mod = 0;
    if (arg) {
      const m = INIT_MOD_RX.exec(arg);
      if (!m) {
        notice(ctx, "BAD_INIT", "Initiative takes an optional flat modifier, e.g. /init +3.");
        return;
      }
      mod = parseInt(m[1] ?? "0", 10);
      if (!Number.isFinite(mod) || mod < -MAX_INIT_MOD || mod > MAX_INIT_MOD) {
        notice(ctx, "BAD_INIT", `Initiative modifier must be between -${MAX_INIT_MOD} and +${MAX_INIT_MOD}.`);
        return;
      }
    }
    const die = randomInt(1, 21);
    const total = die + mod;
    const modSuffix = formatModifierSuffix(mod, die);
    const dcSuffix = formatDcSuffix(total, await getRoomDc(ctx));
    await addMessage(ctx, { kind: "roll", body: `rolls for initiative 🎲 1d20: ${die}${modSuffix}${dcSuffix}` });
  },
};
