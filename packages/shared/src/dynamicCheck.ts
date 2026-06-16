/**
 * Dynamic pass/fail prompts ("checks") for chat + forum bodies.
 *
 * Authors embed a block in any message body:
 *
 *   <check>
 *     <pass>The lock clicks open.</pass>
 *     <fail>The pick snaps off in the mechanism.</fail>
 *   </check>
 *
 * or a dice-gated variant where the roll must MEET OR BEAT a target:
 *
 *   <roll:1d20:12>
 *     <pass>The ropes slice cleanly...</pass>
 *     <fail>The rope barely takes a mark...</fail>
 *   </roll>
 *
 * The dice expression accepts the same `NdM` shape as /roll plus one
 * optional modifier: a flat `+X` / `-X`, or a `xF` multiplier
 * (`1d20x1.5`). `:12` is the difficulty the (modified) total is
 * compared against.
 *
 * Resolution is SERVER-SIDE and authoritative: {@link processCheckBlocks}
 * rolls the dice / flips the coin once, decides the outcome, and replaces
 * the whole block with a single self-contained marker token carrying the
 * resolved data (outcome, the mechanical detail line, and BOTH prose
 * branches). The client renderer decodes the marker into a collapsible
 * Pass/Fail card, it never re-rolls, exactly like the /roll verification
 * contract.
 *
 * Forgery defense mirrors the inline-command markers (see inlineMark.ts):
 * the server strips any pre-existing check markers from user input BEFORE
 * processing, so the only way a marker reaches a recipient is via a real
 * server-side resolution.
 */

/** Marker delimiters. U+2063 (INVISIBLE SEPARATOR) + U+27E6/U+27E7
 *  brackets, the same invisible, not-normally-typed pair the inline
 *  verification markers use. The payload between them is a single
 *  URI-encoded JSON blob, so neither the close bracket nor the
 *  separator char can ever appear inside it. */
export const CHK_OPEN = "⁣⟦chk:";
export const CHK_CLOSE = "⟧⁣";

/** Matches a complete check marker and captures its encoded payload.
 *  `[^⟧⁣]*` is safe because the payload is URI-encoded (all
 *  non-ASCII, including the delimiters, escaped to %XX). */
export const CHK_SPAN_RE = /⁣⟦chk:([^⟧⁣]*)⟧⁣/g;

/** Strip pattern, run over user input before processing so a pasted
 *  "resolved" block can't masquerade as authentic. Same shape as the
 *  span pattern. */
const CHK_STRIP_RE = /⁣⟦chk:[^⟧⁣]*⟧⁣/g;

export type CheckMode = "check" | "roll";
export type CheckOutcome = "pass" | "fail";

/** Decoded payload carried by a check marker. `v` is a schema version so
 *  a future shape change can be detected and ignored gracefully by old
 *  clients rather than mis-rendered. */
export interface CheckResultData {
  v: 1;
  mode: CheckMode;
  outcome: CheckOutcome;
  /** Mechanical sub-line shown under the verdict, e.g.
   *  "1d20: 16  +3 = 19  vs 12". Empty for a plain coin-flip <check>. */
  detail: string;
  /** Pass-branch prose, raw author text (rendered through the inline
   *  markdown parser client-side). */
  pass: string;
  /** Fail-branch prose. */
  fail: string;
}

/* ------------------------------------------------------------------ *
 *  Dice parsing / evaluation
 * ------------------------------------------------------------------ */

const MAX_DICE = 100;
const MAX_SIDES = 1000;
const MAX_FLAT = 999;
const MAX_MULT = 100;

/** `NdM` with at most ONE modifier: a `xF` multiplier OR a flat `±X`. */
const CHECK_DICE_RX = /^(\d*)d(\d+)(?:x(\d+(?:\.\d+)?)|([+-]\d+))?$/i;

export interface ParsedCheckDice {
  count: number;
  sides: number;
  /** Multiplier applied to the dice total, or null when absent. */
  mult: number | null;
  /** Flat modifier added to the dice total, or null when absent. */
  add: number | null;
}

/** Parse a check-block dice expression. Returns null on any malformed or
 *  out-of-range input so the caller can leave the original block literal
 *  (the author sees their typo instead of a silently-dropped block). */
export function parseCheckDice(input: string): ParsedCheckDice | null {
  const m = CHECK_DICE_RX.exec(input.trim());
  if (!m) return null;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2] ?? "0", 10);
  const mult = m[3] != null ? parseFloat(m[3]) : null;
  const add = m[4] != null ? parseInt(m[4], 10) : null;
  if (!Number.isFinite(count) || count < 1 || count > MAX_DICE) return null;
  if (!Number.isFinite(sides) || sides < 2 || sides > MAX_SIDES) return null;
  if (mult != null && (!Number.isFinite(mult) || mult <= 0 || mult > MAX_MULT)) return null;
  if (add != null && (!Number.isFinite(add) || add < -MAX_FLAT || add > MAX_FLAT)) return null;
  return { count, sides, mult, add };
}

export interface CheckRollResult {
  rolls: number[];
  /** Sum of the raw dice before any modifier. */
  base: number;
  /** Final value compared against the difficulty (after mult / flat). */
  total: number;
}

/** Roll the parsed dice. `randInt(min, maxExclusive)` matches the
 *  signature of Node's `crypto.randomInt`, the server injects the
 *  cryptographic source; tests can inject a deterministic stub. */
export function evalCheckRoll(
  dice: ParsedCheckDice,
  randInt: (min: number, maxExclusive: number) => number,
): CheckRollResult {
  const rolls: number[] = [];
  for (let i = 0; i < dice.count; i++) rolls.push(randInt(1, dice.sides + 1));
  const base = rolls.reduce((a, b) => a + b, 0);
  let total = base;
  if (dice.mult != null) total = Math.round(base * dice.mult);
  else if (dice.add != null) total = base + dice.add;
  return { rolls, base, total };
}

/** Human-readable mechanical line for the result card, e.g.
 *   "1d20: 16  ×1.5 = 24  vs 12"
 *   "3d6: [4, 2, 6] = 12  vs 10"
 *   "1d20: 8  +3 = 11  vs 12" */
function formatRollDetail(dice: ParsedCheckDice, r: CheckRollResult, dc: number): string {
  const expr = `${dice.count}d${dice.sides}`;
  const dicePart = dice.count === 1 ? `${r.base}` : `[${r.rolls.join(", ")}] = ${r.base}`;
  let mod = "";
  if (dice.mult != null) mod = `  ×${dice.mult} = ${r.total}`;
  else if (dice.add != null) mod = `  ${dice.add >= 0 ? "+" : "−"}${Math.abs(dice.add)} = ${r.total}`;
  return `${expr}: ${dicePart}${mod}  vs ${dc}`;
}

/* ------------------------------------------------------------------ *
 *  Marker encode / decode
 * ------------------------------------------------------------------ */

/** Encode resolved data into a self-contained marker token. */
export function encodeCheckMarker(data: CheckResultData): string {
  return CHK_OPEN + encodeURIComponent(JSON.stringify(data)) + CHK_CLOSE;
}

/** Decode a marker payload (the captured group from {@link CHK_SPAN_RE})
 *  back into typed data. Returns null on any malformed / wrong-version
 *  payload so the renderer can fall back to literal text rather than
 *  throw. */
export function decodeCheckMarker(payload: string): CheckResultData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(payload));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const d = parsed as Record<string, unknown>;
  if (d.v !== 1) return null;
  if (d.mode !== "check" && d.mode !== "roll") return null;
  if (d.outcome !== "pass" && d.outcome !== "fail") return null;
  if (typeof d.detail !== "string" || typeof d.pass !== "string" || typeof d.fail !== "string") {
    return null;
  }
  return {
    v: 1,
    mode: d.mode,
    outcome: d.outcome,
    detail: d.detail,
    pass: d.pass,
    fail: d.fail,
  };
}

/** Remove every check marker from a body. Idempotent. Run on user input
 *  BEFORE {@link processCheckBlocks} to defeat forged markers. */
export function stripCheckMarkers(body: string): string {
  return body.replace(CHK_STRIP_RE, "");
}

/* ------------------------------------------------------------------ *
 *  Block processing
 * ------------------------------------------------------------------ */

/** A `<check>…</check>` or `<roll:EXPR:DC>…</roll>` block. The opener's
 *  closer may be `</check>` OR `</roll>` interchangeably, real authors
 *  mix them up and the distinction carries no meaning. */
const BLOCK_RE =
  /<(?:check|roll:(?<expr>[^:>\s]+):(?<dc>\d+))\s*>(?<inner>[\s\S]*?)<\/(?:check|roll)>/gi;
const PASS_RE = /<pass>([\s\S]*?)<\/pass>/i;
const FAIL_RE = /<fail>([\s\S]*?)<\/fail>/i;

/**
 * Find every check/roll block in `body`, resolve each ONCE against the
 * injected RNG, and replace it with an encoded marker. Blocks that don't
 * parse (bad dice expression, or neither a <pass> nor <fail> branch) are
 * left exactly as the author typed them so the mistake stays visible.
 *
 * Returns the rewritten body. A body with no `<check`/`<roll:` opener is
 * returned untouched (cheap fast-path).
 */
export function processCheckBlocks(
  body: string,
  randInt: (min: number, maxExclusive: number) => number,
): string {
  // Fast-path: nothing that could open a block.
  if (!/<(?:check|roll:)/i.test(body)) return body;
  return body.replace(BLOCK_RE, (match, expr: string | undefined, dc: string | undefined, inner: string) => {
    const passM = PASS_RE.exec(inner);
    const failM = FAIL_RE.exec(inner);
    const pass = passM ? passM[1]!.trim() : "";
    const fail = failM ? failM[1]!.trim() : "";
    // No usable branches → not really a check block; leave literal.
    if (!pass && !fail) return match;

    let mode: CheckMode;
    let outcome: CheckOutcome;
    let detail: string;

    if (expr != null && dc != null) {
      const dice = parseCheckDice(expr);
      if (!dice) return match; // malformed dice → leave the block literal
      const target = parseInt(dc, 10);
      const r = evalCheckRoll(dice, randInt);
      mode = "roll";
      outcome = r.total >= target ? "pass" : "fail";
      detail = formatRollDetail(dice, r, target);
    } else {
      mode = "check";
      // 50/50 coin flip. randInt(0, 2) → 0 or 1.
      outcome = randInt(0, 2) === 1 ? "pass" : "fail";
      detail = "";
    }

    return encodeCheckMarker({ v: 1, mode, outcome, detail, pass, fail });
  });
}
