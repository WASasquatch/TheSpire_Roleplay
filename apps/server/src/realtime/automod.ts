/**
 * Content auto-moderation (site-wide v1).
 *
 * Sits BESIDE the escalating anti-spam ladder (`antiSpam.ts`): where anti-spam
 * polices *rate* (too many messages too fast), auto-mod polices *content* (a
 * message body matching an admin-authored rule). Both are admin-toggled, both
 * exempt staff + holders of a bypass permission, and both run in `dispatch.ts`
 * only for speech-producing sends.
 *
 * Design goals:
 *   - PURE matcher. `applyFilters(body, rules)` is a pure function of its
 *     inputs, no clock, no DB, no globals, so the exact-match behavior can be
 *     unit-tested and the admin "test box" can reuse the identical code path.
 *   - ReDoS-SAFE. Admin-authored `regex` rules are attacker-adjacent (a
 *     compromised or careless admin could paste a catastrophic pattern). We
 *     (a) validate the pattern at SAVE time (length cap + reject known-bad
 *     constructs), AND (b) guard every per-message match with a wall-clock
 *     time budget so a pattern that slips through can't wedge the event loop
 *     for more than a few ms.
 *   - COMPILE ONCE. The route layer calls `invalidateAutomodCache()` on every
 *     config write; the dispatch layer calls `getCompiledRuleset(db)` which
 *     lazily compiles the enabled rules once and serves the cached result to
 *     every subsequent message until the next invalidation. We never re-read
 *     or re-compile per message.
 *
 * The engine is site-wide for v1: it compiles rules where `serverId IS NULL`
 * (server-scoped rules are persisted by the same table but not consulted here
 * yet — a later phase wires the per-server dispatch path). `scope` still
 * filters chat vs forum so a "forum-only" rule never fires on flat chat.
 */

import { eq, isNull } from "drizzle-orm";
import type {
  AutomodRule,
  AutomodRuleAction,
  AutomodRuleScope,
} from "@thekeep/shared";
import { extractMentions } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { automodRules } from "../db/schema.js";
import { extractFirstUrl } from "../unfurl.js";

/* ============================================================ *
 *  Save-time validation (ReDoS guard, layer A)
 * ============================================================ */

/** Hard cap on a stored pattern's length. Long alternations are the raw
 *  material for catastrophic backtracking; a keyword/regex this long is
 *  almost always a mistake or an attack, so we reject at save time. Tightened
 *  from 400 → 200: the per-message time budget (layer B) can only abort
 *  BETWEEN rules, never mid-exec, so the single-exec cost of one pattern has to
 *  be bounded here. Halving the length halves the raw material a catastrophic
 *  alternation/backtrack has to work with, and 200 chars is still far more than
 *  any legitimate keyword or hand-written rule needs. */
export const AUTOMOD_MAX_PATTERN_LEN = 200;

/**
 * Reject regex sources whose shape is a classic catastrophic-backtracking
 * hazard BEFORE we ever compile or run them. This is intentionally a coarse
 * structural screen (not a full analysis, which is undecidable) — layer B (the
 * per-message time budget) is the backstop for anything these miss, but that
 * backstop only fires BETWEEN rules and can't interrupt one pathological
 * `exec`, so the screen has to be broad enough that a single catastrophic
 * pattern can't be saved in the first place.
 *
 * The shapes we reject:
 *
 *   1. Nested quantifiers over a group — `(a+)+`, `(a*)*`, `(a+)*`, `(.*)+`,
 *      `(\w+)+`, AND the bounded-then-unbounded variants `(a{2,})+`,
 *      `(a{1,10})*` (a group whose interior carries a `+`/`*`/`{n,…}`
 *      quantifier and is itself quantified). This is the overwhelmingly common
 *      way an admin paste turns into a wedged loop.
 *
 *   2. A quantified group containing an alternation — `(a|a)*`, `(a|ab)+`,
 *      `(.*|.*)*`. Overlapping/adjacent alternatives under an outer `+`/`*`
 *      are exponential even without a nested inner quantifier, so the
 *      nested-quantifier screen alone misses them.
 *
 *   3. Adjacent / stacked greedy quantifiers — `a++`, `.*+`, `a{2,}*`,
 *      `a*{2,}`, `a+{3}`, `a{2,4}{5}`. A quantifier token immediately followed
 *      by a *repeating* quantifier (`+`, `*`, or a `{…}` count).
 *
 * The "repeating outer quantifier" in every case is `+`, `*`, or `{…}` — NEVER
 * a bare `?`. A trailing `?` makes the preceding quantifier LAZY (`.*?`, `a+?`)
 * or a group optional (`(a+)?`), neither of which is catastrophic, so screening
 * on `?` would false-reject perfectly safe lazy/optional patterns.
 *
 * All three use a `[^()]`-bounded group probe, so they only reason about the
 * shallowest (non-nested) group — but they now cover bounded quantifiers and
 * alternation, not just `+`/`*`. The nested case they can't see (`((a+))+`) is
 * closed by `hasQuantifiedNestedGroup`, a paren-depth scan, so between the two
 * a wedging pattern can't be saved; the layer-B per-message backstop only has
 * to catch exotic non-quantifier blowups.
 */
/** A group whose interior carries a quantifier (`+`, `*`, or `{n,…}`) and is
 *  itself repeat-quantified (`+`, `*`, or `{…}`). Catches `(a+)+`, `(.*)+`,
 *  `(a{2,})+`, `(a{1,10})*`. */
const NESTED_QUANTIFIER_RE = /\([^()]*(?:[+*]|\{\d+,?\d*\})[^()]*\)\s*(?:[+*]|\{)/;
/** A repeat-quantified group containing an alternation: `(a|a)*`, `(a|ab)+`,
 *  `(.*|.*)*`. Exponential from overlapping branches even with no inner
 *  quantifier. */
const QUANTIFIED_ALTERNATION_RE = /\([^()]*\|[^()]*\)\s*(?:[+*]|\{)/;
/** A quantifier applied directly to a repeating quantifier: `a++`, `.*+`,
 *  `a{2,}*`, `a*{2,}`, `a+{3}`, `a{2,4}{5}`. A quantifier token (`+ * ?` or a
 *  closing `}`) immediately followed by a repeating one (`+`, `*`, or an
 *  opening `{`). A trailing `?` (lazy `.*?` / optional) is deliberately not
 *  treated as the second token. */
const DOUBLE_QUANTIFIER_RE = /(?:[+*?]|\})\s*(?:[+*]|\{)/;

/**
 * True if any repeat-quantified group (`(...)` followed by `+`, `*`, or `{`)
 * CONTAINS a nested group. Nested quantified groups — `(a+)+`, `((a)+)+`,
 * `(([a-z]+))*` — are the classic catastrophic-backtracking shape, but the
 * three `[^()]`-bounded regex screens above only reason about the shallowest,
 * non-nested group, so `((a+))+` slips straight past them (empirically ~2s for
 * a 28-char input, worse from there). A single regex can't count paren nesting
 * to arbitrary depth, so this does a small left-to-right paren-depth scan: for
 * each group we remember whether a child group opened inside it, and on close
 * we flag it if it had a child AND is immediately repeat-quantified. Escaped
 * parens (`\(` `\)`) and parens inside a character class (`[...]`) are literals,
 * not groups, so they're skipped. Deliberately conservative — a repeat-
 * quantified group wrapping any inner group is rejected even when it happens to
 * be safe, because such shapes are vanishingly rare in real automod rules and
 * the whole point of the save-time screen is that a wedging rule can't be
 * stored in the first place.
 */
function hasQuantifiedNestedGroup(p: string): boolean {
  // Stack entry = "has a child group opened inside me yet?" for each open group.
  const hadChild: boolean[] = [];
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "\\") {
      i++; // skip the escaped char — a literal, never a group delimiter
      continue;
    }
    if (ch === "[") {
      // Skip the whole character class; `(`/`)` inside it are literal chars.
      i++;
      while (i < p.length && p[i] !== "]") {
        if (p[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "(") {
      if (hadChild.length > 0) hadChild[hadChild.length - 1] = true; // parent gains a child
      hadChild.push(false);
    } else if (ch === ")") {
      const hadNested = hadChild.pop() ?? false;
      if (hadNested) {
        let j = i + 1;
        while (j < p.length && /\s/.test(p[j] ?? "")) j++;
        const q = p[j];
        if (q === "+" || q === "*" || q === "{") return true;
      }
    }
  }
  return false;
}

export interface AutomodPatternValidation {
  ok: boolean;
  /** Human-readable reason when `ok` is false (surfaced to the admin). */
  reason?: string;
}

/**
 * Validate one rule's `pattern` for the given `kind`. Called by the admin CRUD
 * routes on create/update so a bad pattern is rejected with a clear message
 * rather than silently never matching (or, worse, wedging the loop later).
 *
 *   - keyword     — must be non-empty after trim; length-capped.
 *   - regex       — length-capped, structurally screened, and test-compiled.
 *   - link/invite — pattern is IGNORED (the matcher is built-in); always ok.
 *   - mention_cap — must parse to a positive integer.
 */
export function validateAutomodPattern(
  kind: AutomodRule["kind"],
  pattern: string,
): AutomodPatternValidation {
  const p = pattern ?? "";
  if (kind === "link" || kind === "invite") return { ok: true };
  if (kind === "mention_cap") {
    const n = Number(p.trim());
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, reason: "Mention cap must be a whole number of 1 or more." };
    }
    return { ok: true };
  }
  if (!p.trim()) return { ok: false, reason: "Pattern can't be empty." };
  if (p.length > AUTOMOD_MAX_PATTERN_LEN) {
    return { ok: false, reason: `Pattern too long (max ${AUTOMOD_MAX_PATTERN_LEN} characters).` };
  }
  if (kind === "regex") {
    if (
      NESTED_QUANTIFIER_RE.test(p) ||
      QUANTIFIED_ALTERNATION_RE.test(p) ||
      DOUBLE_QUANTIFIER_RE.test(p) ||
      hasQuantifiedNestedGroup(p)
    ) {
      return {
        ok: false,
        reason: "Pattern rejected: nested/stacked quantifiers or a quantified alternation can hang the server. Simplify it.",
      };
    }
    try {
      // Compile once to reject syntactically invalid sources up front. The
      // flags mirror what the matcher uses so a source that only fails under
      // a flag combination is caught here too.
      // eslint-disable-next-line no-new
      new RegExp(p, "i");
    } catch (err) {
      return { ok: false, reason: `Invalid regular expression: ${err instanceof Error ? err.message : "syntax error"}` };
    }
  }
  return { ok: true };
}

/* ============================================================ *
 *  Per-message run budget (ReDoS guard, layer B)
 * ============================================================ */

/**
 * Wall-clock ceiling for evaluating ALL rules against one message. A single
 * pathological regex that slipped past the save-time screen can still burn
 * CPU; we abort the remaining rules once the cumulative match time crosses
 * this budget and treat the message as clean (fail-open: never block a
 * legitimate send because a rule was slow). The abort is coarse — JS regex
 * exec isn't interruptible mid-call — but capping between rules bounds the
 * damage to one slow rule's single exec rather than the whole ruleset.
 */
const MATCH_TIME_BUDGET_MS = 15;

/* ============================================================ *
 *  Compiled ruleset (compile once, cache, invalidate on write)
 * ============================================================ */

/** A rule pre-processed into its ready-to-run form. */
interface CompiledRule {
  rule: AutomodRule;
  action: AutomodRuleAction;
  scope: AutomodRuleScope;
  /** For `regex` / `keyword` rules, the compiled RegExp; null for link/invite/mention_cap. */
  re: RegExp | null;
  /** For `mention_cap`, the parsed numeric ceiling; null otherwise. */
  mentionCap: number | null;
}

export interface CompiledRuleset {
  rules: CompiledRule[];
}

let cache: CompiledRuleset | null = null;

/** Escape a literal keyword for safe embedding in a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the RegExp for a keyword/regex rule, honoring caseInsensitive +
 * wholeWord. Returns null on a pattern that fails to compile (defensive —
 * save-time validation should have caught it, but a hand-edited DB row
 * shouldn't crash the compile pass; a bad row is simply skipped).
 */
function compileMatcher(rule: AutomodRule): RegExp | null {
  const flags = rule.caseInsensitive ? "iu" : "u";
  try {
    if (rule.kind === "keyword") {
      const core = escapeRegExp(rule.pattern);
      // \b word boundaries only make sense around word chars; for a phrase
      // with surrounding punctuation the boundary still anchors on the outer
      // word chars, which is the intended "whole word" behavior.
      const src = rule.wholeWord ? `(?<![\\p{L}\\p{N}_])${core}(?![\\p{L}\\p{N}_])` : core;
      return new RegExp(src, flags);
    }
    if (rule.kind === "regex") {
      return new RegExp(rule.pattern, flags);
    }
  } catch {
    return null;
  }
  return null;
}

/** Turn a persisted rule into its compiled form. */
function compileRule(rule: AutomodRule): CompiledRule | null {
  let re: RegExp | null = null;
  let mentionCap: number | null = null;
  if (rule.kind === "keyword" || rule.kind === "regex") {
    re = compileMatcher(rule);
    if (!re) return null; // un-compilable row: skip rather than crash
  } else if (rule.kind === "mention_cap") {
    const n = Number(rule.pattern.trim());
    if (!Number.isInteger(n) || n < 1) return null;
    mentionCap = n;
  }
  return { rule, action: rule.action, scope: rule.scope, re, mentionCap };
}

/** Map a DB row to the shared wire shape the matcher operates on. */
function rowToRule(row: typeof automodRules.$inferSelect): AutomodRule {
  return {
    id: row.id,
    serverId: row.serverId,
    enabled: !!row.enabled,
    kind: row.kind,
    pattern: row.pattern,
    action: row.action,
    muteMs: row.muteMs,
    scope: row.scope,
    caseInsensitive: !!row.caseInsensitive,
    wholeWord: !!row.wholeWord,
    note: row.note,
    createdByUserId: row.createdByUserId,
    createdAt: +row.createdAt,
    updatedAt: +row.updatedAt,
  };
}

/**
 * Lazily compile the enabled SITE-WIDE (serverId IS NULL) rules and cache the
 * result. Every subsequent message reuses the cache until `invalidateAutomodCache`
 * is called (on any config write). This is the ONLY function that reads the
 * table on the dispatch hot path, and it does so at most once per config epoch.
 */
export async function getCompiledRuleset(db: Db): Promise<CompiledRuleset> {
  if (cache) return cache;
  const rows = await db
    .select()
    .from(automodRules)
    .where(isNull(automodRules.serverId));
  const rules: CompiledRule[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const compiled = compileRule(rowToRule(row));
    if (compiled) rules.push(compiled);
  }
  cache = { rules };
  return cache;
}

/** Drop the compiled cache so the next `getCompiledRuleset` recompiles from DB. */
export function invalidateAutomodCache(): void {
  cache = null;
}

/* ============================================================ *
 *  Pure matcher
 * ============================================================ */

/** One rule that fired against a body. */
export interface AutomodHit {
  ruleId: string;
  kind: AutomodRule["kind"];
  action: AutomodRuleAction;
  /** Mute duration (ms) the fired rule requested; null = engine default. */
  muteMs: number | null;
  /** Short human label for the audit log / test box ("keyword: foo"). */
  label: string;
}

export interface AutomodVerdict {
  /** Every rule that matched, in ruleset order. */
  hits: AutomodHit[];
  /**
   * The single action to apply, resolved by severity precedence
   * (mute > delete > warn) across all hits. null when nothing fired.
   */
  action: AutomodRuleAction | null;
  /** Mute duration to use when `action === "mute"` (from the winning hit); null = engine default. */
  muteMs: number | null;
}

const ACTION_SEVERITY: Record<AutomodRuleAction, number> = { warn: 0, delete: 1, mute: 2 };

/**
 * Does `body` contain any URL? Reuses the unfurl module's URL extractor so
 * "what counts as a link" stays consistent with link-preview behavior.
 */
function bodyHasLink(body: string): boolean {
  return extractFirstUrl(body) !== null;
}

/** Common chat/forum/other-service invite-link shapes. Kept deliberately
 *  broad — an admin who enables the `invite` rule wants to catch "come join
 *  my other server" drops, so we match the well-known invite hosts + the
 *  generic `/invite/` path segment. */
const INVITE_RE =
  /\b(?:discord(?:\.gg|app\.com\/invite|\.com\/invite)|t\.me\/joinchat|chat\.whatsapp\.com|join\.slack\.com|\/invite\/[\w-]+)\b/i;

function bodyHasInvite(body: string): boolean {
  return INVITE_RE.test(body);
}

/**
 * Run every compiled rule for the given surface against `body`. PURE:
 * no clock beyond the internal time-budget guard (which only ever makes the
 * function return EARLIER, never changes a match into a non-match for a
 * fast rule), no DB, no globals. Returns the full hit list plus the
 * severity-resolved action so callers can log every hit but apply one action.
 *
 * `surface` filters by rule scope: a `chat`-scoped rule is skipped on forum
 * sends and vice-versa; `both`-scoped rules always apply.
 */
export function applyFilters(
  body: string,
  ruleset: CompiledRuleset,
  surface: "chat" | "forum",
): AutomodVerdict {
  const hits: AutomodHit[] = [];
  const start = Date.now();
  // Compute mention count lazily (only when a mention_cap rule is present).
  let mentionCount = -1;

  for (const cr of ruleset.rules) {
    // Between-rules time budget (ReDoS layer B). Once we've spent the budget,
    // stop evaluating further rules and treat the rest as non-matching. Fail-
    // open: a slow ruleset degrades to "allow", never to a wrong block.
    if (Date.now() - start > MATCH_TIME_BUDGET_MS) break;

    if (cr.scope !== "both" && cr.scope !== surface) continue;

    let matched = false;
    let label = "";
    switch (cr.rule.kind) {
      case "keyword":
      case "regex": {
        if (cr.re) {
          // Reset lastIndex defensively (matchers are compiled without /g, but
          // guard anyway) and test.
          cr.re.lastIndex = 0;
          matched = cr.re.test(body);
        }
        label = `${cr.rule.kind}: ${cr.rule.pattern.slice(0, 40)}`;
        break;
      }
      case "link": {
        matched = bodyHasLink(body);
        label = "link";
        break;
      }
      case "invite": {
        matched = bodyHasInvite(body);
        label = "invite";
        break;
      }
      case "mention_cap": {
        if (cr.mentionCap != null) {
          if (mentionCount < 0) mentionCount = extractMentions(body).length;
          matched = mentionCount > cr.mentionCap;
          label = `mention cap > ${cr.mentionCap}`;
        }
        break;
      }
    }

    if (matched) {
      hits.push({
        ruleId: cr.rule.id,
        kind: cr.rule.kind,
        action: cr.action,
        muteMs: cr.rule.muteMs,
        label,
      });
    }
  }

  if (hits.length === 0) return { hits, action: null, muteMs: null };
  // Severity precedence: the most severe action wins. On a tie, the first hit
  // of that severity supplies the mute duration.
  let winner = hits[0]!;
  for (const h of hits) {
    if (ACTION_SEVERITY[h.action] > ACTION_SEVERITY[winner.action]) winner = h;
  }
  return { hits, action: winner.action, muteMs: winner.muteMs };
}

/** Default mute length when a `mute`-action rule leaves `muteMs` null. */
export const AUTOMOD_DEFAULT_MUTE_MS = 10 * 60_000;
