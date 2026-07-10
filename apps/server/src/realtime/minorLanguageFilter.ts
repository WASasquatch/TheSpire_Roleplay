/**
 * Minor language filter (age-restriction plan Phase 7, plan_ext.md §J).
 *
 * Masks strong language for UNDER-18 VIEWERS ONLY, at read time, where
 * payloads are built. Three invariants every caller can rely on:
 *
 *   1. Stored rows are NEVER modified — masking produces a per-delivery
 *      variant; the DB keeps what the author wrote.
 *   2. Adults ALWAYS receive the original body. Only code paths that have
 *      already decided "this recipient is a minor" (auth/ageGate.ts
 *      `isMinor`) consult this module.
 *   3. `maskForMinors` returning null means "clean" — serve the ORIGINAL
 *      object untouched (no clone, no re-serialize), so the common case
 *      costs a matcher scan and nothing else.
 *
 * Engine: the `obscenity` package — its English preset plus the
 * recommended transformer pipeline catches the bypass arsenal (leetspeak
 * "sh1t", repeated chars "fuuuck", Unicode confusables), and its whitelist
 * solves Scunthorpe-class false positives ("class", "assassin").
 *
 * SPACED BYPASSES ("f u c k") need a second pass: obscenity 0.4.x ships
 * `skipNonAlphabeticTransformer` commented OUT of its English preset
 * because skipping separators also erases the word boundaries the
 * dataset's anchored patterns rely on — with it on, plain "well shit,"
 * stops matching (the transformed "wellshit…" has no boundary before the
 * word). Neither pipeline alone covers both halves of the spec, so the
 * filter compiles the SAME word set twice and unions the results:
 *
 *   - `strict`: the stock preset pipeline — in-sentence hits, boundaries
 *     honored, upstream's false-positive tuning intact.
 *   - `spaced`: stock + skip-non-alphabetic (restored at its original
 *     position, before collapse-duplicates) — catches "f u c k" /
 *     "f.u.c.k" style separator tricks.
 *
 * Both matchers report spans in ORIGINAL-string indices, so the union
 * censors coherently; the union only ever ADDS matches over the stock
 * behavior, and probes like "push it" / "grass hit" / "his expertise"
 * stay clean under both. The admin "never censor" list is honored by
 * both pipelines.
 *
 * The union additionally requires a spaced-pass match's original span to
 * contain at least TWO separators. With separators skipped, a hit inside
 * "analyst" maps back to a span that absorbs the preceding space plus one
 * letter ("e anal" in "a fine analyst") — no longer INSIDE the whitelisted
 * "analyst" span, so the preset's own false-positive protection stops
 * applying. One separator is that boundary-absorption signature; a real
 * spaced-out word ("f u c k", "f.u.c.k") has one separator per gap. Do
 * NOT "fix" this by adding the skip transformer to the whitelist pipeline
 * instead — that regresses "grass hit" / "push it" into masks.
 *
 * On top of the preset sit two small admin-editable overlays from
 * site_settings (migration 0339, editable in Admin → Settings):
 *
 *   - ADDED words (`minor_filter_terms_json`): matched as literal
 *     substrings run through the same pipelines, so an added "damn" also
 *     catches "d4mn" and "d a m n". Pattern metacharacters in admin input
 *     are escaped — a stray "[" can never break the rebuild. Because both
 *     pipelines collapse duplicate letters in the INPUT before matching,
 *     each term is registered in that collapsed space too (see
 *     {@link collapseTermForPipelines}) — a verbatim "dammit" pattern
 *     could never match anything (no transformed input contains "mm").
 *   - NEVER-CENSOR words (`minor_filter_allow_json`): whitelisted spans;
 *     a blacklist hit inside one is ignored. A small BUILT-IN allow seed
 *     ({@link BUILT_IN_ALLOW}) ships in code beneath the admin list, so
 *     known false positives the preset's English-only whitelist misses
 *     ("análisis", "annals", "shiitake") stay visible out of the box.
 *
 * Masking shape: keep the first character, asterisk the rest — "damn" →
 * "d***" — so a minor reader still gets conversational context without
 * the word.
 *
 * Lifecycle: `rebuildMinorFilter(settings)` swaps the config whenever the
 * settings cache reseeds (boot + every updateSettings — see
 * ensureSiteSettings in settings.ts). The matchers themselves are
 * compiled LAZILY on the next mask call after a rebuild: rebuilds are
 * infrequent and cheap (a few ms), and a disabled filter never pays the
 * compile at all. Matching rides fan-out hot paths, so per-call work is
 * two `getAllMatches` scans (~0.4ms on a 1.8KB body, microseconds on
 * typical chat lines) — compute the masked variant ONCE per message and
 * hand it to every minor recipient; never re-scan per recipient.
 */

import type { MatchPayload } from "obscenity";
import {
  DataSet,
  RegExpMatcher,
  TextCensor,
  asteriskCensorStrategy,
  englishDataset,
  englishRecommendedTransformers,
  keepStartCensorStrategy,
  parseRawPattern,
  skipNonAlphabeticTransformer,
} from "obscenity";
import type { ChatMessage } from "@thekeep/shared";

/**
 * The slice of SiteSettings this module reads. Declared structurally (and
 * satisfied by the full SiteSettings object) so settings.ts can call
 * `rebuildMinorFilter(cached)` without this module importing settings.ts
 * back — no runtime import cycle.
 */
export interface MinorFilterSettings {
  minorFilterEnabled: boolean;
  minorFilterTerms: string[];
  minorFilterAllow: string[];
}

/** The strict + spaced matcher pair one compile produces (see header). */
interface MatcherPair {
  strict: RegExpMatcher;
  spaced: RegExpMatcher;
}

/** Module singleton: current config + the lazily compiled matchers for it. */
interface FilterState {
  enabled: boolean;
  terms: string[];
  allow: string[];
  /** null = not compiled yet for the current config (compile on next use). */
  matchers: MatcherPair | null;
}

/**
 * Boot default mirrors the migration-0339 column defaults (enabled, no
 * overlay), so the module is safe to consult even before the first
 * settings read — in practice ensureSiteSettings rebuilds this within the
 * first ms of boot.
 */
const state: FilterState = { enabled: true, terms: [], allow: [], matchers: null };

/** "damn" → "d***": keep the first character, asterisk the rest. */
const censor = new TextCensor().setStrategy(keepStartCensorStrategy(asteriskCensorStrategy()));

/**
 * Built-in never-censor seed, folded under the admin allowlist at compile
 * time. The English preset's whitelist only covers English word FORMS
 * ("analysis", "analyst"), so everyday words outside that list that contain
 * a collapsed profanity would mask mid-sentence — Spanish ones especially,
 * now the UI ships a complete Spanish locale: "analizar" / "análisis" /
 * "anales", plus English "annals" ("nn" collapses onto "anal") and
 * "shiitake" (collapses over "shit"). Seeded in CODE rather than the 0339
 * column default so every install gets them without touching stored
 * settings; the admin "never censor" box remains the runtime lever for
 * anything else (other conjugations like "analizando", or — deliberately
 * left to community judgment — the rooster sense of "cock").
 *
 * "penistone": Yorkshire town / surname (plausible RP vocabulary) the
 * upstream whitelist misses — "Scunthorpe" itself is covered there, its
 * neighbor is not. Add "lightwater"-class neighbors here as reported.
 */
const BUILT_IN_ALLOW = ["analizar", "análisis", "anales", "annals", "shiitake", "penistone"];

const ALPHANUMERIC_RX = /[\p{L}\p{N}]/u;

/**
 * True when the ORIGINAL-string span [startIndex, endIndex] (obscenity
 * spans are inclusive) contains at least two non-alphanumeric characters.
 * That is the signature of a genuinely spaced-out word — "f u c k",
 * "f.u.c.k", "s h i t" carry one separator per gap — while a spaced-pass
 * hit that merely absorbed a word boundary ("e anal" inside "a fine
 * analyst") carries exactly one. See the union loop in
 * {@link maskForMinors} for why the distinction matters.
 */
function spansTwoSeparators(body: string, startIndex: number, endIndex: number): boolean {
  let separators = 0;
  for (let i = Math.max(startIndex, 0); i <= endIndex && i < body.length; i += 1) {
    if (ALPHANUMERIC_RX.test(body[i]!)) continue;
    separators += 1;
    if (separators >= 2) return true;
  }
  return false;
}

/**
 * Escape obscenity pattern metacharacters (`\`, `[`, `]`, `?`, `|`) so an
 * admin-entered word is matched as the literal text they typed. Admins
 * write words, not patterns — pattern syntax staying an internal detail is
 * what makes the settings textarea safe to hand to a non-technical owner.
 */
function escapePatternLiteral(term: string): string {
  return term.replace(/[\\[\]?|]/g, (c) => `\\${c}`);
}

/** Trim, lowercase (all matcher pipelines lowercase their input, so
 *  uppercase entries would silently never match), drop empties. */
function normalizeOverlay(entries: string[]): string[] {
  return entries.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
}

/**
 * Letters whose runs the preset's collapse-duplicates transformer keeps at
 * TWO (so "boobs" / "hell" / "ass" style words survive the collapse); every
 * other character collapses to one. Mirrors the customThresholds map inside
 * obscenity's englishRecommendedTransformers — keep in lockstep on upgrades.
 */
const COLLAPSE_KEEP_TWO = new Set(["b", "e", "o", "l", "s", "g"]);

/**
 * Collapse an admin-added term into the post-transform space the matchers
 * actually see. BOTH pipelines run collapseDuplicatesTransformer on the
 * INPUT (default threshold 1, the {@link COLLAPSE_KEEP_TWO} letters at 2),
 * so input "dammit" reaches the matcher as "damit" — a verbatim "dammit"
 * pattern can never match its own word, silently. Registering the collapsed
 * spelling instead matches BOTH the doubled and collapsed inputs ("upper"
 * and "uper" both transform to "uper").
 *
 * Only ASCII letter runs are collapsed: the terms are already lowercased
 * (normalizeOverlay), the transformed input space is letters-only by the
 * time collapse runs, and leaving digits/punctuation untouched keeps the
 * escaped pattern metacharacters (see escapePatternLiteral) intact.
 */
function collapseTermForPipelines(term: string): string {
  let out = "";
  let prev = "";
  let run = 0;
  for (const ch of term) {
    if (ch === prev) run += 1;
    else { prev = ch; run = 1; }
    if (ch >= "a" && ch <= "z" && run > (COLLAPSE_KEEP_TWO.has(ch) ? 2 : 1)) continue;
    out += ch;
  }
  return out;
}

/**
 * Compile the matcher pair: English preset + admin overlay, once with the
 * stock transformer pipeline and once with skip-non-alphabetic restored.
 * Called lazily (see getMatchers); infrequent, a few ms. Any surprise here
 * must not take chat delivery down, so failures degrade instead of
 * throwing: a bad overlay entry is skipped, and a whole-build failure
 * falls back to the bare English preset (worst case the overlay is
 * ignored, never the base protection).
 */
function compileMatchers(terms: string[], allow: string[]): MatcherPair {
  const dataset = new DataSet<{ originalWord: string }>().addAll(englishDataset);
  for (const term of normalizeOverlay(terms)) {
    try {
      // Register in the collapsed space (see collapseTermForPipelines):
      // the collapsed pattern alone covers both spellings, because the
      // input is always collapsed before matching.
      dataset.addPhrase((phrase) =>
        phrase.setMetadata({ originalWord: term }).addPattern(parseRawPattern(escapePatternLiteral(collapseTermForPipelines(term)))),
      );
    } catch (err) {
      // Escaping should make every term parseable; belt-and-braces because
      // this input is an admin textarea and the rebuild must never wedge.
      console.error("[minorFilter] skipping unparseable added word", { term, err });
    }
  }
  const built = dataset.build();
  const whitelistedTerms = [
    ...(built.whitelistedTerms ?? []),
    ...BUILT_IN_ALLOW,
    ...normalizeOverlay(allow),
  ];
  // The spaced pipeline = stock pipeline with skip-non-alphabetic put back
  // at its original position: after case folding, BEFORE collapse-duplicates
  // (the last entry).
  const spacedTransformers = [...(englishRecommendedTransformers.blacklistMatcherTransformers ?? [])];
  spacedTransformers.splice(Math.max(spacedTransformers.length - 1, 0), 0, skipNonAlphabeticTransformer());
  return {
    strict: new RegExpMatcher({
      blacklistedTerms: built.blacklistedTerms,
      whitelistedTerms,
      ...englishRecommendedTransformers,
    }),
    spaced: new RegExpMatcher({
      blacklistedTerms: built.blacklistedTerms,
      whitelistedTerms,
      blacklistMatcherTransformers: spacedTransformers,
      // `?? []` for exactOptionalPropertyTypes; the preset always sets it.
      whitelistMatcherTransformers: englishRecommendedTransformers.whitelistMatcherTransformers ?? [],
    }),
  };
}

/** The compiled matchers for the current config, or null when even the
 *  fallback compile failed (masking then no-ops rather than crashing). */
function getMatchers(): MatcherPair | null {
  if (state.matchers) return state.matchers;
  try {
    state.matchers = compileMatchers(state.terms, state.allow);
  } catch (err) {
    console.error("[minorFilter] matcher build failed, retrying without overlay", err);
    try {
      state.matchers = compileMatchers([], []);
    } catch (err2) {
      console.error("[minorFilter] base matcher build failed, filter inert", err2);
      return null;
    }
  }
  return state.matchers;
}

/**
 * Swap in fresh settings. Invoked from ensureSiteSettings whenever the
 * settings cache reseeds — i.e. at boot and after every updateSettings
 * (which nulls the cache and re-reads through ensureSiteSettings), so an
 * admin save takes effect on the next masked read without a restart.
 * Cheap: the actual matcher compile is deferred to the next mask call.
 */
export function rebuildMinorFilter(settings: MinorFilterSettings): void {
  state.enabled = settings.minorFilterEnabled;
  state.terms = settings.minorFilterTerms;
  state.allow = settings.minorFilterAllow;
  state.matchers = null;
}

/**
 * The one call surfaces make: mask `body` for delivery to under-18
 * viewers. Returns the masked string, or null when the body is clean (or
 * the filter is disabled) — null means SERVE THE ORIGINAL OBJECT
 * UNTOUCHED. Callers decide who is a minor (auth/ageGate.ts) and compute
 * this at most ONCE per message, sharing the result across every minor
 * recipient in the fan-out.
 */
export function maskForMinors(body: string): string | null {
  if (!state.enabled) return null;
  if (!body) return null;
  const matchers = getMatchers();
  if (!matchers) return null;
  const matches: MatchPayload[] = matchers.strict.getAllMatches(body);
  // Union in the spaced pass, skipping spans the strict pass already found
  // (the censor tolerates overlap, but deduping keeps its work minimal).
  //
  // A spaced-pass ADDITION must also span at least two separators. With
  // separators skipped, a match maps back to an original span that absorbs
  // the preceding separator plus one letter ("e anal" in "a fine analyst"),
  // which no longer sits INSIDE the whitelisted "analyst" span — so the
  // preset's whitelist protection silently stops applying and everyday
  // words mask mid-sentence. Exactly one separator is that
  // boundary-absorption signature; every genuinely spaced-out word this
  // pass exists for ("f u c k", "f.u.c.k", "s h i t") separates each
  // letter and carries two or more. (Single-split forms like "fu ck you"
  // stay covered by the strict pass.)
  //
  // Known residual: a single-letter WORD before the term ("voy a analizar")
  // puts a second separator in the absorbed span, so that one shape still
  // masks. It fails SAFE (over-masks, never leaks), and no tighter gate we
  // probed keeps "f uck"-style spans caught — not worth the trade.
  const seen = new Set(matches.map((m) => `${m.startIndex}:${m.endIndex}`));
  for (const m of matchers.spaced.getAllMatches(body)) {
    if (seen.has(`${m.startIndex}:${m.endIndex}`)) continue;
    if (!spansTwoSeparators(body, m.startIndex, m.endIndex)) continue;
    matches.push(m);
  }
  if (matches.length === 0) return null;
  return censor.applyTo(body, matches);
}

/**
 * {@link maskForMinors} composed over a ChatMessage-shaped wire payload —
 * the ONE clone-and-mask implementation every ChatMessage surface (live
 * fan-out, backlog, older pages, jump window, forum topics/threads) shares
 * so their behavior can't drift. Masks the three user-authored text fields
 * a chat/forum wire object carries:
 *
 *   - `body`               — the message text itself
 *   - `title`              — forum topic titles (user text)
 *   - `replyToBodySnippet` — the inline quote of the PARENT message (the
 *                            parent's profanity would otherwise ride every
 *                            reply into a minor's view)
 *
 * Same contract as maskForMinors: null means "clean" — serve the ORIGINAL
 * object untouched (adults, and clean bodies, keep the exact shared
 * instance; no clone, no re-serialize). A non-null return is a shallow
 * CLONE with only the dirty fields replaced — the stored row and the
 * shared original are never mutated. Callers still decide who is a minor
 * (auth/ageGate.ts) and compute this at most ONCE per message, sharing the
 * clone across every minor recipient in a fan-out.
 *
 * Deliberately NOT masked here: `bodyHtml` (admin-authored announcement
 * markup — masking inside HTML could split tags), `originalBody` (the
 * admin-only deleted-body audit field; staff accounts are adult accounts),
 * link previews / poll text / display names (out of §J's surface list —
 * names are the queued follow-up pass).
 */
export function maskMessageForMinors(msg: ChatMessage): ChatMessage | null {
  const body = maskForMinors(msg.body);
  const title = msg.title ? maskForMinors(msg.title) : null;
  const snippet = msg.replyToBodySnippet ? maskForMinors(msg.replyToBodySnippet) : null;
  if (body === null && title === null && snippet === null) return null;
  return {
    ...msg,
    ...(body !== null ? { body } : {}),
    ...(title !== null ? { title } : {}),
    ...(snippet !== null ? { replyToBodySnippet: snippet } : {}),
  };
}
