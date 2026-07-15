/**
 * Custom-command template engine.
 *
 * Admin-authored `/cmd` templates (and their inline `!cmd` bodies) are run
 * through this engine before the rendered text becomes a chat message. It is a
 * small, deliberately-constrained substitution language — NOT a general
 * scripting sandbox.
 *
 * ── Variables ──────────────────────────────────────────────────────────────
 *   {name} / {sender}   sender's display name (synonyms)
 *   {target}            first argument (same as {arg:1})
 *   {args}              full argument text after the command word
 *   {rest}              args without the first token
 *   {arg:N}             the Nth whitespace-separated argument (1-based). Missing
 *                       arguments render empty. So `/roll 3 20` gives
 *                       {arg:1} = "3", {arg:2} = "20".
 *   {loop}              inside a <loop>, the current pass number (1-based)
 *   {time}              HH:MM (24h)
 *   {date}              YYYY-MM-DD
 *   {room}              current room id
 *
 * ── Functions ({fn:body}) ──────────────────────────────────────────────────
 *   {rng:A:B}           a random whole number from A to B (inclusive)
 *   {roll:NdM}          random dice total (sum of N d-M dice)
 *   {choose:a|b|c}      pick one option at random
 *   {upper:text} {lower:text}
 *   {if:cond|then|else} conditional. `cond` is TRUE when it is non-empty and
 *                       not "0"/"false", OR when it is a comparison that holds:
 *                       {if:{arg:1}>10|big|small}. Operators: == != > < >= <=
 *                       (numeric when both sides are numbers, else text). The
 *                       else branch is optional.
 *
 * ── Sugar ──────────────────────────────────────────────────────────────────
 *   {a|b|c}             bare-pipe random pick (same as {choose:})
 *   {=expr}             safe arithmetic; numbers + + - * / % ( ) only
 *
 * ── Loops ──────────────────────────────────────────────────────────────────
 *   <loop:N>body</loop>              repeat body N times, joined by a space
 *   <loop:N sep="X">body</loop>      join the repeats with X instead ("" = none)
 *
 *   The count N can be any expression, so `<loop:{arg:1}>...</loop>` repeats
 *   as many times as the caller asked. The body is re-evaluated every pass, so
 *   `{rng:...}` / `{roll:...}` produce a fresh value each time:
 *
 *     {sender} rolls {arg:1} d{arg:2}: <loop:{arg:1}>{rng:1:{arg:2}}</loop>
 *       → "WAS rolls 3 d20: 14 8 2"
 *
 *   Loops may nest; the innermost {loop} wins inside its own body.
 *
 * Innermost {…} evaluate first, so nesting works ({=10+{roll:1d20}}). Anything
 * the engine doesn't understand is left on screen exactly as typed, so a typo
 * is visible instead of silently vanishing.
 *
 * ── Safety contract ─────────────────────────────────────────────────────────
 * This function returns a STRING which becomes the `body` field of a chat
 * message. The web client renders message bodies through `lib/markdown.tsx` as
 * React elements (never innerHTML), so anything substituted here — including
 * user-controlled values like display names and free-form args — is text
 * content first and markdown second. Do not change the client to render bodies
 * via `dangerouslySetInnerHTML` without revisiting this engine.
 *
 * Expansion is hard-bounded because loop counts, {rng} bounds, and argument
 * values are all caller-controlled:
 *   - Substituted VALUES have their braces neutralized (see the sentinels
 *     below) so a value like `{args}{args}{args}{args}` can never be
 *     re-interpreted as template and expand geometrically (billion-laughs).
 *   - A single loop runs at most MAX_LOOP_ITERS passes, a whole render at most
 *     MAX_TOTAL_ITERS, nesting at most MAX_LOOP_DEPTH, and total output is
 *     capped at MAX_OUTPUT_LEN.
 */

/** Per-loop cap (a single `<loop:N>` runs at most this many passes). */
const MAX_LOOP_ITERS = 200;
/** Total loop passes across one whole render (defends against nesting). */
const MAX_TOTAL_ITERS = 500;
/** Hard ceiling on generated output length (chars). */
const MAX_OUTPUT_LEN = 4000;
/** Max nesting depth of `<loop>` blocks. */
const MAX_LOOP_DEPTH = 25;
/** {roll:NdM} bounds (unchanged from the original engine). */
const MAX_ROLL_COUNT = 20;
const MAX_ROLL_SIDES = 1000;
/** {rng:A:B} magnitude clamp so a hostile arg can't request an absurd span. */
const RNG_LIMIT = 1_000_000;

/**
 * Private-use sentinels (U+E000 / U+E001) that stand in for `{`/`}` inside
 * SUBSTITUTED VALUES (display name, args, {arg:N}, …). The scalar loop
 * deliberately re-scans its own output so template structure can resolve
 * outward ({if:{target}|…}); without neutralization a caller-supplied value
 * like `{args}{args}{args}` would be re-interpreted as template on every pass
 * and expand geometrically. Sentinels ride through every pass (the token regex
 * never matches them) and are turned back into literal braces exactly once, at
 * the top-level return.
 */
const NEUTRAL_LB = String.fromCharCode(0xe000);
const NEUTRAL_RB = String.fromCharCode(0xe001);
const NEUTRAL_STRIP_RE = new RegExp("[" + NEUTRAL_LB + NEUTRAL_RB + "]", "g");
const RESTORE_LB_RE = new RegExp(NEUTRAL_LB, "g");
const RESTORE_RB_RE = new RegExp(NEUTRAL_RB, "g");

/** Neutralize braces in a substituted VALUE so it can never be treated as
 *  template source. Any pre-existing sentinels are stripped first so a
 *  caller can't smuggle one straight through. */
function neutralize(s: string): string {
  return s.replace(NEUTRAL_STRIP_RE, "").replace(/\{/g, NEUTRAL_LB).replace(/\}/g, NEUTRAL_RB);
}

/** Turn sentinels back into literal braces - called once on the final string. */
function restoreBraces(s: string): string {
  return s.replace(RESTORE_LB_RE, "{").replace(RESTORE_RB_RE, "}");
}

export interface TemplateScope {
  /** Sender's display name — fills {name} and {sender}. */
  name: string;
  /** {target}; defaults to positional[0] when omitted. */
  target?: string;
  /** {args} — full argument text. */
  args?: string;
  /** {rest} — args without the first token. */
  rest?: string;
  /** Positional args: {arg:1} = positional[0]. */
  positional?: string[];
  /** Current room id — fills {room}. */
  roomId: string;
  /** Clock source for {time}/{date}; defaults to now. Injectable for tests. */
  now?: Date;
  /** RNG source in [0,1); defaults to Math.random. Injectable for tests. */
  rng?: () => number;
}

interface RenderCtx {
  vars: Record<string, string>;
  positional: string[];
  rng: () => number;
  /** Shared, mutable across the whole render (survives ctx spreads by ref). */
  budget: { iters: number; outLen: number };
  depth: number;
}

/**
 * Render a custom-command template against a scope. Pure and deterministic
 * given `scope.rng` / `scope.now`.
 */
export function renderCommandTemplate(tpl: string, scope: TemplateScope): string {
  const now = scope.now ?? new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const positional = scope.positional ?? [];
  const ctx: RenderCtx = {
    vars: {
      name: scope.name,
      sender: scope.name,
      target: scope.target ?? positional[0] ?? "",
      args: scope.args ?? "",
      rest: scope.rest ?? "",
      time: `${hh}:${mm}`,
      date: now.toISOString().slice(0, 10),
      room: scope.roomId,
    },
    positional,
    rng: scope.rng ?? Math.random,
    budget: { iters: 0, outLen: 0 },
    depth: 0,
  };
  // Braces inside substituted values are neutralized during the render and
  // only restored here, at the very end, so nothing a value contains can be
  // re-parsed as a token by any pass.
  return restoreBraces(renderNode(tpl, ctx));
}

/** Expand loops first (fresh per-pass evaluation), then scalar {…} tokens. */
function renderNode(tpl: string, ctx: RenderCtx): string {
  const expanded = expandLoops(tpl, ctx);
  return substituteScalars(expanded, ctx);
}

/* ------------ loop expansion ------------ */

/**
 * Locate the FIRST (outermost) `<loop:…>…</loop>` starting at `from`, matching
 * nested `<loop>`s so the correct `</loop>` closes it. Returns null when none.
 */
function findLoop(
  s: string,
  from: number,
): { start: number; headerEnd: number; bodyStart: number; bodyEnd: number; blockEnd: number } | null {
  const open = "<loop:";
  const start = s.indexOf(open, from);
  if (start === -1) return null;
  // Find the header-terminating '>' that is NOT inside a {…} token or a quoted
  // sep="…" — otherwise a count expression using a comparison ({if:{arg:1}>2|…})
  // or a sep containing '>' would be truncated. Loop expansion runs before
  // scalar substitution, so the raw (unevaluated) count is what's scanned here.
  let headerEnd = -1;
  let braceDepth = 0;
  let inQuote = false;
  for (let j = start + open.length; j < s.length; j++) {
    const ch = s[j];
    if (inQuote) {
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === "{") braceDepth++;
    else if (ch === "}") { if (braceDepth > 0) braceDepth--; }
    else if (ch === ">" && braceDepth === 0) { headerEnd = j; break; }
  }
  if (headerEnd === -1) return null;
  const bodyStart = headerEnd + 1;
  let depth = 1;
  let i = bodyStart;
  while (i < s.length) {
    const nextOpen = s.indexOf(open, i);
    const nextClose = s.indexOf("</loop>", i);
    if (nextClose === -1) return null; // unbalanced → not a loop
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + open.length;
    } else {
      depth--;
      if (depth === 0) {
        return { start, headerEnd, bodyStart, bodyEnd: nextClose, blockEnd: nextClose + "</loop>".length };
      }
      i = nextClose + "</loop>".length;
    }
  }
  return null;
}

function expandLoops(s: string, ctx: RenderCtx): string {
  if (!s.includes("<loop:")) return s;
  if (ctx.depth >= MAX_LOOP_DEPTH) return s; // too deep — leave literal
  let out = "";
  let cursor = 0;
  let guard = 0;
  while (guard++ < 10_000) {
    const loc = findLoop(s, cursor);
    if (!loc) {
      out += s.slice(cursor);
      break;
    }
    out += s.slice(cursor, loc.start);
    const header = s.slice(loc.start + "<loop:".length, loc.headerEnd);
    const body = s.slice(loc.bodyStart, loc.bodyEnd);
    out += expandOneLoop(header, body, ctx);
    cursor = loc.blockEnd;
  }
  return out;
}

function expandOneLoop(header: string, body: string, ctx: RenderCtx): string {
  // Optional trailing `sep="…"`; the rest is the count expression.
  let sep = " ";
  let countRaw = header;
  const sepM = /\s*sep\s*=\s*"([^"]*)"\s*$/.exec(header);
  if (sepM) {
    sep = sepM[1] ?? " ";
    countRaw = header.slice(0, sepM.index);
  }
  const countStr = substituteScalars(countRaw, ctx).trim();
  const raw = Number(countStr);
  if (!Number.isFinite(raw)) {
    // Count didn't resolve to a number — leave the block literal so the author
    // sees the mistake (mirrors the scalar engine's fall-through contract).
    return `<loop:${header}>${body}</loop>`;
  }
  const n = Math.min(Math.max(0, Math.floor(raw)), MAX_LOOP_ITERS);
  const parts: string[] = [];
  for (let i = 1; i <= n; i++) {
    if (ctx.budget.iters >= MAX_TOTAL_ITERS) break;
    if (ctx.budget.outLen >= MAX_OUTPUT_LEN) break;
    ctx.budget.iters++;
    const childCtx: RenderCtx = {
      vars: { ...ctx.vars, loop: String(i) },
      positional: ctx.positional,
      rng: ctx.rng,
      budget: ctx.budget,
      depth: ctx.depth + 1,
    };
    const piece = renderNode(body, childCtx);
    ctx.budget.outLen += piece.length + sep.length;
    parts.push(piece);
  }
  return parts.join(sep);
}

/* ------------ scalar {…} substitution ------------ */

function substituteScalars(tpl: string, ctx: RenderCtx): string {
  if (!tpl.includes("{")) return tpl;
  let out = tpl;
  // Process innermost {…} (no nested braces) and loop until stable so outer
  // expressions can read inner results. Cap iterations AND output length as a
  // guard (substituted values are already brace-neutralized, so this only
  // bounds an over-eager author template).
  for (let i = 0; i < 16; i++) {
    let changed = false;
    const next = out.replace(/\{([^{}]*)\}/g, (m, raw: string) => {
      const replaced = evalNode(raw, ctx);
      if (replaced === null) return m;
      changed = true;
      return replaced;
    });
    out = next;
    if (out.length > MAX_OUTPUT_LEN) {
      out = out.slice(0, MAX_OUTPUT_LEN);
      break;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * Evaluate a single template node (the contents of a `{…}` with no nested
 * braces). Returns the replacement string, or null when the node should be
 * left as-is (so users see "{notarealvar}" come through unchanged rather than
 * silently disappear).
 */
function evalNode(raw: string, ctx: RenderCtx): string | null {
  const body = raw.trim();
  if (body === "") return null;

  // Math: {=expr}
  if (body.startsWith("=")) return safeEvalMath(body.slice(1));

  // Function call: {fn:args} (fn is a single identifier).
  const colon = body.indexOf(":");
  if (colon > 0 && /^[a-zA-Z]+$/.test(body.slice(0, colon))) {
    const fn = body.slice(0, colon).toLowerCase();
    const arg = body.slice(colon + 1);
    return evalFn(fn, arg, ctx);
  }

  // Bare-pipe random: {a|b|c}
  if (body.includes("|")) {
    const opts = body.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
    if (!opts.length) return "";
    return opts[Math.floor(ctx.rng() * opts.length)] ?? "";
  }

  // Variable lookup. Values are neutralized so they can't be re-interpreted.
  const v = ctx.vars[body.toLowerCase()];
  return v !== undefined ? neutralize(v) : null;
}

function evalFn(fn: string, arg: string, ctx: RenderCtx): string | null {
  switch (fn) {
    case "arg": {
      // {arg:N} — 1-based positional. Missing args render empty (like {target}).
      const n = parseInt(arg.trim(), 10);
      if (!Number.isInteger(n) || n < 1) return null;
      return neutralize(ctx.positional[n - 1] ?? "");
    }
    case "rng": {
      // {rng:A:B} — random whole number from A to B inclusive.
      const parts = arg.split(":");
      if (parts.length !== 2) return null;
      let min = Number((parts[0] ?? "").trim());
      let max = Number((parts[1] ?? "").trim());
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      min = clampInt(min);
      max = clampInt(max);
      if (min > max) [min, max] = [max, min];
      return String(min + Math.floor(ctx.rng() * (max - min + 1)));
    }
    case "roll": {
      const m = /^(\d*)d(\d+)$/i.exec(arg.trim());
      if (!m) return null;
      const count = Math.min(MAX_ROLL_COUNT, parseInt(m[1] || "1", 10) || 1);
      const sides = Math.min(MAX_ROLL_SIDES, parseInt(m[2] ?? "0", 10) || 0);
      if (sides < 2) return null;
      let total = 0;
      for (let i = 0; i < count; i++) total += 1 + Math.floor(ctx.rng() * sides);
      return String(total);
    }
    case "choose": {
      const opts = arg.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
      if (!opts.length) return "";
      return opts[Math.floor(ctx.rng() * opts.length)] ?? "";
    }
    case "upper":
      return arg.toUpperCase();
    case "lower":
      return arg.toLowerCase();
    case "if": {
      // {if:cond|then|else}
      const parts = arg.split("|");
      if (parts.length < 2) return null;
      const cond = (parts[0] ?? "").trim();
      const thenVal = parts[1] ?? "";
      const elseVal = parts.slice(2).join("|");
      return evalCondition(cond) ? thenVal : elseVal;
    }
    default:
      return null;
  }
}

function clampInt(n: number): number {
  return Math.max(-RNG_LIMIT, Math.min(RNG_LIMIT, Math.floor(n)));
}

/** A bare condition is truthy unless empty, "0", or "false". */
function truthy(s: string): boolean {
  const t = s.trim();
  return t !== "" && t !== "0" && t.toLowerCase() !== "false";
}

/**
 * Evaluate an {if:} condition. Supports a single comparison (== != > < >= <=);
 * numeric when both sides parse as numbers, otherwise a text comparison. With
 * no operator it falls back to the bare-truthiness rule, preserving the
 * historical `{if:{target}|…}` behavior.
 */
function evalCondition(cond: string): boolean {
  const m = /^(.*?)(==|!=|>=|<=|>|<)(.*)$/.exec(cond);
  if (!m) return truthy(cond);
  const lhs = (m[1] ?? "").trim();
  const op = m[2];
  const rhs = (m[3] ?? "").trim();
  const ln = Number(lhs);
  const rn = Number(rhs);
  const numeric = lhs !== "" && rhs !== "" && Number.isFinite(ln) && Number.isFinite(rn);
  switch (op) {
    case "==": return numeric ? ln === rn : lhs === rhs;
    case "!=": return numeric ? ln !== rn : lhs !== rhs;
    case ">": return numeric ? ln > rn : lhs > rhs;
    case "<": return numeric ? ln < rn : lhs < rhs;
    case ">=": return numeric ? ln >= rn : lhs >= rhs;
    case "<=": return numeric ? ln <= rn : lhs <= rhs;
    default: return false;
  }
}

/**
 * Evaluate a constrained arithmetic expression. Whitelisted to digits,
 * decimal points, parens, and the five binary operators — nothing else can
 * reach the Function constructor, so eval-style injection is impossible.
 */
function safeEvalMath(expr: string): string | null {
  const s = expr.replace(/\s+/g, "");
  if (s === "" || !/^[\d.+\-*/%()]+$/.test(s)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const result = Function(`"use strict"; return (${s});`)();
    if (typeof result === "number" && Number.isFinite(result)) {
      // Trim trailing .0 for clean display.
      return Number.isInteger(result) ? String(result) : String(+result.toFixed(6));
    }
  } catch { /* fall through */ }
  return null;
}
