import { eq } from "drizzle-orm";
import {
  markVerified,
  sanitizeCustomCmdCss,
  splitOnCode,
  stripVerificationMarkers,
} from "@thekeep/shared";
import { customCommandAliases, customCommands } from "../db/schema.js";
import type { Db } from "../db/index.js";
import type { CommandContext, CommandHandler, SessionUser } from "./types.js";

/**
 * Per-name inline-command metadata. Populated alongside the regular
 * command map during `reloadCustom` (custom commands) and at builtin
 * registration time (builtins that expose an `inline` handler).
 *
 * The `render` closure unifies the two sources, custom commands run
 * their template through `renderTemplateWithVars`, builtins run their
 * `inline()` callback. The `expandInlineCommands` site doesn't care
 * which kind it's invoking.
 *
 * Keyed by every name + alias so callers can resolve case-insensitively
 * without re-scanning aliases on each hit.
 */
export interface InlineCommandEntry {
  canonicalName: string;
  /** True when the entry came from a builtin (e.g. `/roll`); false for
   *  admin-authored custom commands. Informational, currently only used
   *  to gate things like "show this in the !palette but not the admin
   *  CSS editor." */
  builtin: boolean;
  /** Snapshotted CSS to apply to the rendered span. Always null for
   *  builtin inlines; for custom commands it carries whatever the admin
   *  saved on the row (sanitized). */
  css: string | null;
  /** Snapshotted color, either a `#rrggbb` hex literal or a
   *  `theme:<slot>` token. Always null for builtin inlines (they
   *  inherit the chat's normal coloring); for custom commands it
   *  mirrors the value the admin set on the `/cmd` form. Rides through
   *  the verification marker so the inline chip renders in the same
   *  color as the standalone `/cmd` output. */
  color: string | null;
  /** Render the inline replacement text. `args` is whatever the user
   *  typed after a `:` delimiter (`!roll:3d6` → `"3d6"`; bare `!roll`
   *  → `""`). Returning null tells the dispatcher to leave the original
   *  `!name[:arg]` token literal in place (used for invalid dice
   *  expressions etc.). */
  render(args: string, user: SessionUser, roomId: string): string | null;
}

/**
 * Global command registry.
 *
 * Names AND aliases share one keyspace, so `/me` and `/he` both resolve to the
 * same handler. Custom (admin-authored) commands are loaded from the DB at
 * startup and on edit, and are merged into the same map - built-ins win on
 * collision so an admin can't shadow `/kick`.
 */
export class CommandRegistry {
  private readonly byName = new Map<string, CommandHandler>();
  /** names that came from built-in handlers - these are protected from custom-command shadowing */
  private readonly builtinNames = new Set<string>();
  /** names contributed by custom commands - tracked so we can hot-swap on edit */
  private readonly customNames = new Set<string>();
  /** Inline-eligible custom commands, keyed by every alias + canonical name. */
  private readonly inlineByName = new Map<string, InlineCommandEntry>();
  /** Canonical names of inline-enabled commands, for the `allowInline` flag
   *  surfaced via `/commands`. Cheaper than scanning inlineByName values. */
  private readonly inlineCanonicalNames = new Set<string>();

  registerBuiltin(handler: CommandHandler): void {
    this.assertAvailable(handler.name, handler.aliases);
    this.byName.set(handler.name.toLowerCase(), handler);
    this.builtinNames.add(handler.name.toLowerCase());
    for (const alias of handler.aliases ?? []) {
      const k = alias.toLowerCase();
      this.byName.set(k, handler);
      this.builtinNames.add(k);
    }
    // Builtins that opted into inline expansion get folded into the
    // same inline registry as custom commands. The render shape is
    // unified, `expandInlineCommands` doesn't know the difference.
    if (handler.inline) {
      const inlineFn = handler.inline;
      const entry: InlineCommandEntry = {
        canonicalName: handler.name.toLowerCase(),
        builtin: true,
        css: null,
        color: null,
        render: (args, user, roomId) => inlineFn(args, user, roomId),
      };
      this.inlineByName.set(handler.name.toLowerCase(), entry);
      for (const alias of handler.aliases ?? []) {
        this.inlineByName.set(alias.toLowerCase(), entry);
      }
      this.inlineCanonicalNames.add(handler.name.toLowerCase());
    }
  }

  /** Replace all custom-command entries with a fresh load from DB. */
  async reloadCustom(db: Db): Promise<void> {
    for (const name of this.customNames) this.byName.delete(name);
    this.customNames.clear();
    // Drop ONLY custom inline entries, builtin inlines (`!roll`,
    // `!dice`) were registered once at boot and aren't re-added by
    // this path, so a blanket clear killed them silently. The bug
    // manifested as "every custom-command admin edit makes `!roll`
    // stop expanding", the inline form rendered as literal text
    // until the next server restart. We walk the map by entry and
    // delete only the rows whose `builtin: false` flag marks them
    // as coming from the DB. The matching canonical-name set is
    // filtered the same way.
    const inlineToDelete: string[] = [];
    for (const [name, entry] of this.inlineByName) {
      if (!entry.builtin) inlineToDelete.push(name);
    }
    for (const name of inlineToDelete) this.inlineByName.delete(name);
    const canonicalToDelete: string[] = [];
    for (const name of this.inlineCanonicalNames) {
      const entry = this.inlineByName.get(name);
      if (!entry || !entry.builtin) canonicalToDelete.push(name);
    }
    for (const name of canonicalToDelete) this.inlineCanonicalNames.delete(name);

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
      // Inline registration: only when the admin opted this command in
      // *and* it survived the builtin-shadow filter above (an inline
      // command whose name was shadowed wouldn't resolve via /name
      // either, so keeping its inline form would surprise authors).
      if (c.allowInline) {
        // inline_template falls back to the standalone template, the
        // admin only authors a second body when the wording differs.
        // We treat empty strings AND whitespace-only strings as
        // "missing" so a defensive direct DB write of "" doesn't
        // render every inline call as a blank space.
        const inlineBody = c.inlineTemplate && c.inlineTemplate.trim()
          ? c.inlineTemplate
          : c.template;
        // Sanitize the CSS at load time so a hostile direct DB write
        // can't smuggle a disallowed property through; this is the same
        // pass the admin-route POST applies, applied defensively.
        const css = sanitizeCustomCmdCss(c.css ?? "") || null;
        const entry: InlineCommandEntry = {
          canonicalName: handler.name,
          builtin: false,
          css,
          // Carry the admin's color onto inline expansions too. Without
          // this the inline `!check` chip rendered as plain inherited
          // text even though the admin set `color: theme:system` on
          // the standalone `/check` form, only the standalone path
          // was applying it. The marker carries the snapshotted value
          // through to the FE which resolves theme tokens + nudges
          // hex against the viewer's theme bg.
          color: c.color ?? null,
          render: (_args, user, roomId) =>
            renderTemplateWithVars(inlineBody, {
              name: user.displayName,
              sender: user.displayName,
              target: "",
              args: "",
              rest: "",
              ...commonVars(roomId),
            }),
        };
        for (const n of allNames) {
          if (this.builtinNames.has(n)) continue;
          this.inlineByName.set(n, entry);
        }
        this.inlineCanonicalNames.add(handler.name);
      }
    }
  }

  /** Resolve an inline-eligible custom command by any of its names/aliases.
   *  Returns undefined when the name doesn't exist OR the command isn't
   *  inline-enabled (callers should fall through, leaving `!name` as
   *  literal text in the message). */
  resolveInline(name: string): InlineCommandEntry | undefined {
    return this.inlineByName.get(name.toLowerCase());
  }

  /** True iff this canonical-name custom command has the inline toggle on.
   *  Used by the /commands route to flag docs for the composer palette. */
  isInlineEnabled(canonicalName: string): boolean {
    return this.inlineCanonicalNames.has(canonicalName.toLowerCase());
  }

  resolve(name: string): CommandHandler | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /** Best-effort suggestion for unknown commands ("did you mean..."). */
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
    /** Optional CSS declaration list, applied to the rendered body. */
    css: string | null;
  },
  aliases: string[],
): CommandHandler {
  // Defensive sanitization mirrors the admin POST/PATCH pass, keeps a
  // direct DB write from sneaking a disallowed property into the live
  // broadcast.
  const safeCss = sanitizeCustomCmdCss(c.css ?? "") || null;
  return {
    name: c.name.toLowerCase(),
    aliases: aliases.map((a) => a.toLowerCase()),
    description: c.description ?? `(custom)`,
    async run(ctx) {
      const rendered = renderTemplate(c.template, ctx);
      const { addMessage } = await import("../realtime/broadcast.js");
      // Custom commands always emit `kind: "cmd"` now. The renderer
      // for cmd kind does NOT auto-prepend the display name, the
      // template's `{sender}` placeholder controls placement. Legacy
      // installations are migrated by 0061 which prepends `{sender} `
      // to every template lacking the placeholder so historical
      // behaviour is preserved on upgrade.
      //
      // We still track the original action/say distinction via the
      // (untyped on the wire) command row, but the message itself no
      // longer needs it, styling diverges by `kind: "cmd"` instead
      // of by the legacy "me"/"say" split.
      await addMessage(ctx, {
        kind: "cmd",
        body: rendered,
        // Only override when the admin set a color; otherwise let the
        // sender's /color preference flow through.
        ...(c.color ? { color: c.color } : {}),
        ...(safeCss ? { cmdCss: safeCss } : {}),
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
 *   {if:cond|then|else}       conditional - cond truthy iff non-empty,
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
 *
 * Safety contract: this function returns a STRING which becomes the
 * `body` field of a chat message. The web client renders message bodies
 * through `lib/markdown.tsx` as React elements (never innerHTML), so
 * anything substituted here - including arbitrary user-controlled values
 * like display names and free-form args - is text content first and
 * markdown second. The worst a hostile display name can do is style its
 * own appearance in bold/italics. Do not change the client to render
 * bodies via `dangerouslySetInnerHTML` without revisiting this engine.
 */
function renderTemplate(tpl: string, ctx: CommandContext): string {
  const target = ctx.args[0] ?? "";
  const rest = ctx.argsText.replace(/^\S+\s*/, "");
  return renderTemplateWithVars(tpl, {
    name: ctx.user.displayName,
    sender: ctx.user.displayName, // alias for {name} so authors can keep "{sender} did X"
    target,
    args: ctx.argsText,
    rest,
    ...commonVars(ctx.roomId),
  });
}

/**
 * Render a template node-by-node against an arbitrary vars dict. Shared
 * between the standalone `/cmd` path (above) and the inline `!cmd`
 * expansion path. Caller is responsible for producing the vars map,
 * inline expansion in particular has no `target`/`args` to plug in.
 */
function renderTemplateWithVars(tpl: string, vars: Record<string, string>): string {
  // Process innermost {...} (no nested braces inside). Loop until stable so
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

function commonVars(roomId: string): Record<string, string> {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return {
    time: `${hh}:${mm}`,
    date: now.toISOString().slice(0, 10),
    room: roomId,
  };
}

/**
 * Inline-trigger pattern. Matches `!name` where:
 *   - the `!` is not preceded by a word char or another `!` (so `n!=m`
 *     and `!!run` don't trigger);
 *   - the name starts with a letter and is built from the same alphabet
 *     custom-command names use (the admin route validates this on insert).
 *
 * The named "prefix" group captures the character immediately before
 * the `!` (or empty at start of input) so `expandInlineCommands` can
 * recognize a `\!` backslash escape and leave that occurrence literal.
 *
 * The capture group is the bare name (no leading `!`). Used both server-
 * side in `expandInlineCommands` and indirectly mirrored by the composer
 * trigger detector (which has its own caret-aware variant).
 *
 * Arg class accepts letters, digits, `+`, `-`, and `.` so dice
 * modifiers (`!roll:1d20+5`, `!roll:2d6-1`) survive intact. Without
 * `+/-` the inline form silently truncated arg to `1d20` and dropped
 * the modifier, leaving the `+5` as plain text after the rendered
 * roll, exactly the failure mode an initiative+damage scene
 * surfaced. The `.` is included for future decimal-friendly args; no
 * builtin uses it today but adding it costs nothing and matches how
 * `parseFloat`-shaped command args are usually written.
 */
const INLINE_TRIGGER_RE =
  /(?<prefix>^|[^\w!])!(?<name>[a-z][a-z0-9_-]{0,31})(?::(?<arg>[A-Za-z0-9+\-.]+))?/gi;

/**
 * Expand every `!name[:arg]` token in a chat-message body using the
 * registry's inline-eligible commands. Unknown names, or names whose
 * command exists but isn't inline-enabled, are left as literal
 * `!name[:arg]` text. The standalone slash-command path is unaffected.
 *
 * Suppression rules so a writer can show what a command LOOKS like
 * without firing it:
 *   - Tokens inside an inline `code` span or a fenced ```code``` block
 *     are left literal (the shared `splitOnCode` segmenter identifies
 *     those regions; this function only walks the text segments).
 *   - A backslash immediately before the `!` escapes the trigger: the
 *     backslash is stripped and `!name` survives as literal text.
 *   - Pre-existing verification markers (a user who typed the literal
 *     marker characters into chat trying to fake authentic output)
 *     are stripped BEFORE expansion runs, so the only way the markers
 *     reach a recipient is via a real expansion this function just
 *     produced. This is what makes the renderer's ✓ tooltip claim
 *     ("this actually came from the server-side command") trustworthy.
 *
 * Inline calls accept an optional `:arg` payload after the name,
 * `!roll:3d6`, `!flip:coin`, etc. Custom-command inline templates
 * ignore the arg (they render with empty `target`/`args`/`rest`);
 * builtins that opt in via {@link CommandHandler.inline} receive it
 * directly. Authors that need richer parameterization should keep
 * using `/cmd args`.
 *
 * Every real expansion is wrapped in {@link markVerified} so the client
 * can paint the verification tooltip; the wrapper rides through
 * persistence and re-broadcast unchanged.
 */
export function expandInlineCommands(
  body: string,
  registry: CommandRegistry,
  user: SessionUser,
  roomId: string,
): string {
  // Always strip pre-existing markers first, this is what guarantees
  // every marker the client sees came from this function on this call.
  const cleaned = stripVerificationMarkers(body);
  // Cheap escape hatch: bodies with no `!` at all skip the regex entirely.
  if (!cleaned.includes("!")) return cleaned;
  return splitOnCode(cleaned)
    .map((seg) => {
      if (seg.kind === "code") return seg.raw;
      return seg.raw.replace(
        INLINE_TRIGGER_RE,
        (match: string, prefix: string, name: string, arg: string | undefined) => {
          // Backslash escape, strip the `\`, keep the literal `!name[:arg]`.
          if (prefix === "\\") return arg ? `!${name}:${arg}` : `!${name}`;
          const entry = registry.resolveInline(name);
          if (!entry) return match;
          const rendered = entry.render(arg ?? "", user, roomId);
          if (rendered === null) return match;
          // Build the replacement so the captured prefix character isn't
          // dropped (it's part of the match), and wrap the body in
          // verification markers so the client paints the ✓ tooltip.
          // Both `entry.css` AND `entry.color` ride through the marker
          // (URI-encoded) so the renderer can apply the command's
          // sanitized style AND its admin-picked color to the spliced
          // span, without color in the marker the inline form fell
          // through to whatever the surrounding chat line was painted
          // in, even when the standalone `/cmd` rendered in a distinct
          // theme color.
          return prefix + markVerified(entry.canonicalName, rendered, entry.css, entry.color);
        },
      );
    })
    .join("");
}

/**
 * Evaluate a single template node (the contents of a `{...}` with no nested
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
      // {if:cond|then|else} - cond is truthy unless empty, "0", or "false".
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
 * decimal points, parens, and the five binary operators - nothing else can
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
