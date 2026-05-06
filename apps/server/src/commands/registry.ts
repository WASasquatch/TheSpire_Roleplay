import { eq } from "drizzle-orm";
import { customCommandAliases, customCommands } from "../db/schema.js";
import type { Db } from "../db/index.js";
import type { CommandContext, CommandHandler } from "./types.js";

/**
 * Global command registry.
 *
 * Names AND aliases share one keyspace, so `/me` and `/he` both resolve to the
 * same handler. Custom (admin-authored) commands are loaded from the DB at
 * startup and on edit, and are merged into the same map — built-ins win on
 * collision so an admin can't shadow `/kick`.
 */
export class CommandRegistry {
  private readonly byName = new Map<string, CommandHandler>();
  /** names that came from built-in handlers — these are protected from custom-command shadowing */
  private readonly builtinNames = new Set<string>();
  /** names contributed by custom commands — tracked so we can hot-swap on edit */
  private readonly customNames = new Set<string>();

  registerBuiltin(handler: CommandHandler): void {
    this.assertAvailable(handler.name, handler.aliases);
    this.byName.set(handler.name.toLowerCase(), handler);
    this.builtinNames.add(handler.name.toLowerCase());
    for (const alias of handler.aliases ?? []) {
      const k = alias.toLowerCase();
      this.byName.set(k, handler);
      this.builtinNames.add(k);
    }
  }

  /** Replace all custom-command entries with a fresh load from DB. */
  async reloadCustom(db: Db): Promise<void> {
    for (const name of this.customNames) this.byName.delete(name);
    this.customNames.clear();

    const cmds = await db.select().from(customCommands);
    if (cmds.length === 0) return;

    const aliases = await db.select().from(customCommandAliases);
    const aliasesByCmd = new Map<string, string[]>();
    for (const a of aliases) {
      const list = aliasesByCmd.get(a.commandId) ?? [];
      list.push(a.alias);
      aliasesByCmd.set(a.commandId, list);
    }

    for (const c of cmds) {
      if (!c.enabled) continue;
      const handler = makeCustomHandler(c, aliasesByCmd.get(c.id) ?? []);
      const allNames = [handler.name, ...(handler.aliases ?? [])].map((n) =>
        n.toLowerCase(),
      );
      for (const n of allNames) {
        if (this.builtinNames.has(n)) continue; // never shadow built-ins
        this.byName.set(n, handler);
        this.customNames.add(n);
      }
    }
  }

  resolve(name: string): CommandHandler | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /** Best-effort suggestion for unknown commands ("did you mean…"). */
  suggest(name: string, max = 3): string[] {
    const target = name.toLowerCase();
    const scored: Array<[string, number]> = [];
    for (const k of this.byName.keys()) {
      const d = levenshtein(target, k);
      if (d <= 2) scored.push([k, d]);
    }
    return scored
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, max)
      .map(([k]) => k);
  }

  /** Lists all visible commands (canonical names only). */
  listCanonical(): CommandHandler[] {
    const seen = new Set<CommandHandler>();
    for (const h of this.byName.values()) seen.add(h);
    return [...seen].sort((a, b) => a.name.localeCompare(b.name));
  }

  private assertAvailable(name: string, aliases: readonly string[] | undefined) {
    const all = [name, ...(aliases ?? [])].map((n) => n.toLowerCase());
    for (const n of all) {
      if (this.byName.has(n)) {
        throw new Error(`command name conflict: /${n} already registered`);
      }
    }
  }
}

/* ------------ custom command rendering ------------ */

function makeCustomHandler(
  c: {
    id: string;
    name: string;
    kind: "action" | "say";
    template: string;
    description: string | null;
    /** Optional per-command color (hex). Null = inherit sender's chat color. */
    color: string | null;
  },
  aliases: string[],
): CommandHandler {
  return {
    name: c.name.toLowerCase(),
    aliases: aliases.map((a) => a.toLowerCase()),
    description: c.description ?? `(custom)`,
    async run(ctx) {
      const rendered = renderTemplate(c.template, ctx);
      const { addMessage } = await import("../realtime/broadcast.js");
      await addMessage(ctx, {
        kind: c.kind === "action" ? "me" : "say",
        body: rendered,
        // Only override when the admin set a color; otherwise let the
        // sender's /color preference flow through.
        ...(c.color ? { color: c.color } : {}),
      });
    },
  };
}

/**
 * Custom-command template engine.
 *
 * Variables:
 *   {name} / {sender}  sender's display name (synonyms)
 *   {target}           first argument (e.g. "/hug Alice" → "Alice")
 *   {args}             full argument text
 *   {rest}             args without the first token
 *   {time}             HH:MM (24h)
 *   {date}             YYYY-MM-DD
 *   {room}             current room id
 *
 * Functions (prefix:body):
 *   {roll:NdM}                random dice roll
 *   {choose:a|b|c}            pick one at random
 *   {upper:text} {lower:text} case helpers
 *   {if:cond|then|else}       conditional — cond truthy iff non-empty,
 *                             non-zero, and not "false"
 *
 * Sugar:
 *   {a|b|c}                   bare-pipe random pick (sugar for {choose:})
 *   {=expr}                   safe arithmetic; numbers + + - * / % ( ) only
 *
 * Innermost braces evaluate first, so nesting works:
 *   {if:{target}|hugs {target}|waves to nobody in particular}
 *   {=10+{roll:1d20}}
 *   {choose:warmly|tightly|gently}
 *
 * The engine rejects anything it doesn't understand by leaving the original
 * tokens in place (so users see what didn't expand and can fix it).
 */
function renderTemplate(tpl: string, ctx: CommandContext): string {
  const target = ctx.args[0] ?? "";
  const rest = ctx.argsText.replace(/^\S+\s*/, "");
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");

  const vars: Record<string, string> = {
    name: ctx.user.displayName,
    sender: ctx.user.displayName, // alias for {name} so authors can keep "{sender} did X"
    target,
    args: ctx.argsText,
    rest,
    time: `${hh}:${mm}`,
    date: now.toISOString().slice(0, 10),
    room: ctx.roomId,
  };

  // Process innermost {…} (no nested braces inside). Loop until stable so
  // outer expressions can read inner results. Cap iterations as a guard.
  let out = tpl;
  for (let i = 0; i < 16; i++) {
    let changed = false;
    const next = out.replace(/\{([^{}]*)\}/g, (m, raw: string) => {
      const replaced = evalNode(raw, vars);
      if (replaced === null) return m;
      changed = true;
      return replaced;
    });
    out = next;
    if (!changed) break;
  }
  return out;
}

/**
 * Evaluate a single template node (the contents of a `{…}` with no nested
 * braces). Returns the replacement string, or null when the node should be
 * left as-is (so users see "{notarealvar}" come through unchanged rather
 * than silently disappear).
 */
function evalNode(raw: string, vars: Record<string, string>): string | null {
  const body = raw.trim();
  if (body === "") return null;

  // Math: {=expr}
  if (body.startsWith("=")) {
    return safeEvalMath(body.slice(1));
  }

  // Function call: {fn:args} (fn is a single identifier).
  const colon = body.indexOf(":");
  if (colon > 0 && /^[a-zA-Z]+$/.test(body.slice(0, colon))) {
    const fn = body.slice(0, colon).toLowerCase();
    const arg = body.slice(colon + 1);
    return evalFn(fn, arg);
  }

  // Bare-pipe random: {a|b|c}
  if (body.includes("|")) {
    const opts = body.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
    if (!opts.length) return "";
    return opts[Math.floor(Math.random() * opts.length)] ?? "";
  }

  // Variable lookup
  const v = vars[body.toLowerCase()];
  return v !== undefined ? v : null;
}

function evalFn(fn: string, arg: string): string | null {
  switch (fn) {
    case "roll": {
      const m = /^(\d*)d(\d+)$/i.exec(arg.trim());
      if (!m) return null;
      const count = Math.min(20, parseInt(m[1] || "1", 10) || 1);
      const sides = Math.min(1000, parseInt(m[2] ?? "0", 10) || 0);
      if (sides < 2) return null;
      let total = 0;
      for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
      return String(total);
    }
    case "choose": {
      const opts = arg.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
      if (!opts.length) return "";
      return opts[Math.floor(Math.random() * opts.length)] ?? "";
    }
    case "upper":
      return arg.toUpperCase();
    case "lower":
      return arg.toLowerCase();
    case "if": {
      // {if:cond|then|else} — cond is truthy unless empty, "0", or "false".
      const parts = arg.split("|");
      if (parts.length < 2) return null;
      const cond = (parts[0] ?? "").trim();
      const thenVal = parts[1] ?? "";
      const elseVal = parts.slice(2).join("|");
      const truthy = cond !== "" && cond !== "0" && cond.toLowerCase() !== "false";
      return truthy ? thenVal : elseVal;
    }
    default:
      return null;
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

/* ------------ small utilities ------------ */

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prevDiag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/* ------------ DB helpers (used by admin routes) ------------ */

export async function deleteCustomCommand(db: Db, id: string): Promise<void> {
  await db.delete(customCommands).where(eq(customCommands.id, id));
}
