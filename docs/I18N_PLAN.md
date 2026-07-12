# The Spire — Localization (i18n) Plan

Goal: localize the UI for the real user base and reach near-100% string coverage
with a guardrail that keeps it there.

> **EXECUTION STATUS (2026-07-09): COMPLETE.** Phases 0–5 shipped in three
> workflow runs (infra → externalization → Spanish set). Final state: 18
> namespaces / **7,179 en keys**, es **7,179/7,179 (100%)**, help guides 45/45
> as a per-locale JSX module (`helpGuides/locales/es.tsx`, auto-registered),
> glossary at `packages/shared/locales/es/GLOSSARY.md`. Gates green: typecheck
> ×3, 617/617 server tests, web build (es lazy chunk ~48 kB gzip), coverage
> script clean. Deliberate scope notes that SURVIVE into the code: persisted
> chat rows (system lines) stay English (shared content, can't be
> per-recipient); the ESLint literal-string ratchet remains the follow-up
> guardrail. This build implemented **English (source) + Spanish**, Phases 0–5,
> workflow-driven. Owner decisions baked in below:
> translation is done **in-house by Claude agents** (glossary + review pass), not
> DeepL — no MT provider keys needed; geo-based language suggestion is deferred
> (navigator.language covers first-visit detection); the ESLint literal-string
> ratchet is a follow-up (coverage script + pseudo-locale are this build's
> guardrails). Next free migration at execution time: **0338** (`users.locale`).
>
> **Accepted bundle cost (post-build review):** the en catalog ships EAGERLY
> in the main index chunk for synchronous first render (no fallback network
> race) — measured at ~117.8 kB gzip of the ~434 kB gzip index chunk
> (admin.json alone ~30.7 kB gzip). This is the documented design, accepted
> as-is for Wave 1; the recorded lever if it ever needs trimming is routing
> non-boot namespaces (admin, servers, tours, scriptorium, arcade) through
> the existing LAZY_MODULES loader with an awaited en pass on the authed
> app-shell mount. es correctly ships as lazy per-namespace chunks.

**Wave 1 (THIS BUILD):** English (source) + **Spanish**.
**Wave 1b (next, same pipeline):** Japanese · French · Chinese Simplified.
**Wave 2 (later, as traffic warrants):** Lithuanian, Dutch, and others.

Why Spanish first: the biggest non-English cohort (Mexico + wider LatAm), an
English-like 2-form plural system, and a direct owner request. ja/fr/zh-CN stay
next in line — none has exotic plural rules either. The harder cases stay in
Wave 2: **Lithuanian** brings CLDR 3-4 plural categories; **Dutch** is
straightforward but lower priority. The architecture supports all of them —
each later wave is locale files + a translation pass, no rework.

---

## 1. Current state (coverage assessment)

**There is no localization system today.** No i18n library, no `locale`/`language`
concept in the DB or settings, nothing reads `navigator.language`. All UI is
hardcoded English, across the whole stack:

| Surface | Approx. user-facing English strings |
|---|---|
| Web components (163 `.tsx`) | ~1,500 by a conservative `>Text<` regex; realistically **3,000-5,000** incl. `placeholder`/`title`/`aria-label`/button labels |
| `HelpGuides.tsx` long-form copy | 3,562 lines (own category) |
| Server command `notice()` | 324 |
| Server `error:notice` emits | 129 |
| Chat system messages (`kind:"system"`) | 44 |
| Email templates | 5 files |
| SEO splash (server-rendered) | 1 template + meta |

**Key insight:** a large share of user-facing text is generated **server-side**
(command responses, system messages, emails, SEO). i18n here is **full-stack**,
not just the React app — server strings must resolve to the *recipient's* locale.

**What we will NOT translate:** user-generated content — bios, chat messages,
world lore, stories, character names, custom command output. Those stay in
whatever language the author wrote. (On-demand machine translation of messages
is a possible future feature, explicitly out of scope here.)

---

## 2. Architecture

- **Client: `i18next` + `react-i18next`.** Mature, TS-friendly, lazy-loads locale
  bundles per namespace, CLDR plural rules (important for Lithuanian), ICU-ish
  interpolation, and a mature extraction/coverage toolchain (`i18next-parser`).
- **Server: `i18next` standalone** (same catalog format) to translate notices /
  system messages / emails into the recipient's locale.
- **Catalog location:** `packages/shared/locales/<lng>/<namespace>.json`, shared
  by client and server so `en` is a single source of truth. Namespaces by domain:
  `common, chat, forums, worlds, scriptorium, servers, admin, profile, earning,
  help, email, errors, commands` (+ small ones as needed: `arcade, tours,
  moderation, marketing, notifications`).
- **Namespace ownership rule (parallel-agent safety):** Phase 0 pre-registers the
  FULL namespace list in the i18n init, and the init auto-loads any
  `<ns>.json` present — so domain agents only ever touch their OWN namespace
  file + their own components, never the shared init. `common.json` is owned by
  the Phase-1 chrome agent; later agents may USE existing common keys but add
  new strings only to their own namespace (a dedupe pass can consolidate later).
- **Keys:** semantic (`chat.composer.send`) with the English string as the `en`
  value. `error:notice` already carries a `code` — those codes map cleanly to
  keys, making the server pass tractable.
- Alternatives weighed: FormatJS/`react-intl` (native ICU MessageFormat — nicer
  for complex plural/gender, heavier) and `lingui` (compile-time). `react-i18next`
  wins on ecosystem + incremental adoption; revisit ICU only if gender/complex
  plurals bite.

---

## 3. Locale model & detection (ties into the geo work)

- **`users.locale`** column (migration 0338) — persisted preference; null = auto.
- **Detection chain** (first hit wins): explicit user setting → `localStorage` →
  `navigator.language` (client) / `Accept-Language` (server, for logged-out
  responses like registration errors) → `en`.
- **Geo suggestion: DEFERRED** (owner-simplified 2026-07-09). `navigator.language`
  is a stronger first-visit signal than geo country and needs no lookup; the
  country→language suggestion toast moves to Wave 1b/2 if analytics show
  navigator detection missing real cohorts. (`analytics/geo.ts` remains available
  for it.)
- **Language switcher** in the Menu (and profile settings); writes `users.locale`
  and flips the UI live (i18next `changeLanguage`, no reload).
- **Server recipient locale:** system messages / notices / emails resolve the
  target user's `users.locale ?? en`; logged-out flows use `Accept-Language`.
  (Persisting last-seen Accept-Language per user: deferred, not needed while
  the switcher writes `users.locale` on first change.)
- MT-provider keys (DeepL/Google): **not used in this build** — translation is
  in-house (see §6). The env-gated provider slot remains a future option.

---

## 4. Formatting

- Dates/times: replace raw `toLocaleString()` + `lib/relativeTime.ts` with
  locale-aware `Intl.DateTimeFormat` / i18next formatters. Numbers/currency via
  `Intl.NumberFormat`.
- Plurals: i18next CLDR plural keys — English 2 forms, zh/ja 1 form, **Lithuanian
  has 3-4 plural categories** (one/few/many/other), which i18next handles.
- **Never concatenate translated fragments** — always full sentences with
  interpolation (`t('room.joined', { name })`).

---

## 5. Coverage strategy — how we reach & hold "near 100%"

- The migration is: wrap every hardcoded string in `t('key')` and add the key to
  `en/*.json`.
- **This build's guardrails:** a small custom coverage script
  (`scripts/i18n-coverage.mjs`: per-namespace `es keys / en keys`, orphan keys,
  interpolation-placeholder parity between locales) + the pseudo-locale sweep.
  No new parser/lint deps.
- **Follow-up ratchet: installed warn-only (2026-07-09), ratchet per-directory
  as touched.** `i18next/no-literal-string` (eslint-plugin-i18next, root devDep)
  is wired into `eslint.config.js`, scoped to `apps/web/src`, warn-only — same
  pattern as the cleanup plan's ESLint ratchet. Configured to ignore test
  files, protocol identifiers (permission keys, event names, `@id:`/`@cid:`
  tokens, slash-commands, bare lowercase kind/tab ids), className/style props
  and every other non-UI attribute (UI-attribute whitelist), plus the
  per-locale help-content JSX modules (§6 — their literals ARE the translation
  mechanism). Baseline at install: **40 warnings across 15 files**; `pnpm lint`
  still exits 0. Do not fix in bulk — burn down per-directory as code is
  touched, then flip that directory to `error`.
- **Coverage metric:** `translated keys / total en keys` per namespace per locale.
  Target for a shipped locale: **100% of en keys present** (agent-translated,
  native review still recommended before calling it polished).
- **Pseudo-locale** (`en-XX` that accents + pads strings ~40%) to (a) surface any
  un-wrapped string at a glance and (b) catch layout overflow before real
  translation — critical for `lt`/`nl`/`de`-style expansion and CJK line-breaking.

---

## 6. Translation sourcing

- **This build: in-house agent translation** (owner decision 2026-07-09). Claude
  workflow agents translate `en → es` directly, which beats provider MT for
  context-aware UI strings: agents see the component, the key name, and the
  interpolations. Process: one agent produces
  `packages/shared/locales/es/GLOSSARY.md` (tone + term decisions: neutral
  Latin-American Spanish, «tú» register, brand/protocol terms that stay
  untranslated — The Spire, command names, `@id:`/`@cid:` tokens, permission
  keys), then parallel translators fill `es/*.json` per namespace following it,
  then a dedicated reviewer pass checks glossary adherence, interpolation
  integrity, plural forms, and length blowouts.
- **Provider MT (DeepL/Google): optional future automation** for Wave 1b/2
  volume, env-gated as originally planned; not a dependency of this build.
- **Native-speaker review** is still the bar before calling a locale *polished*;
  the locale ships agent-translated and complete, flagged for community review.
- **HelpGuides (~3,500 lines of JSX)** is its own track and does NOT go through
  JSON keys: guides keep their rich JSX and get a **per-locale guide module**
  (`HelpGuides.es.tsx` or an `es/` guide directory) selected by locale with
  per-guide fallback to English — a missing translated guide renders the English
  one, so help is never blank.

---

## 7. SEO (optional, high value for the traffic goal)

- Per-locale server-rendered splash with `hreflang` alternates and localized
  `<title>`/meta (extend `seo.ts`). Localized landing pages materially help
  ranking in es/zh/etc. regions — directly serves "get more users from Mexico/
  China/…".

---

## 8. Phased rollout (workflow-driven, mirrors the cleanup plan)

- **Phase 0 — infra (no string changes):** add i18next + react-i18next (client)
  and i18next (server); locale file structure + `en` bootstrap with ALL
  namespaces pre-registered; the detection chain + `users.locale` migration
  (0338); language switcher; Intl formatters; pseudo-locale; the coverage
  script. Verify: en renders identically, build/typecheck/tests green.
- **Phase 1 — app chrome:** nav, menus, buttons, modal shells, `common`/`errors`
  namespaces. Highest visibility, smallest volume — proves the pipeline.
- **Phase 2 — per-domain UI (fan-out):** one workflow agent per domain folder
  (chat/forums/worlds/scriptorium/servers/profile/earning/admin) wraps strings +
  fills `en` keys; ratchet the lint to error for that dir when it hits 0. Verify:
  en output byte-identical (rendered text unchanged), pseudo-locale shows no raw
  literals, build green.
- **Phase 3 — server-side:** command notices (map existing `code`s → keys),
  system messages, emails — resolve recipient locale. Verify with the test suite.
- **Phase 4 — help guides + SEO per-locale.**
- **Phase 5 — MT-seed all target locales → native review → flip live per locale.**

**Behavior constraint throughout:** externalizing a string must not change the
**English** output — same rendered text; only the mechanism changes. (Same
"zero user-visible change for the default path" discipline as the cleanup plan.)

---

## 9. Risks & notes

- **Layout expansion:** Wave 1 — `es`/`fr` run ~15-30% longer than English, and
  `zh`/`ja` wrap/line-break differently (no spaces). Pseudo-locale + a pass over
  fixed-width chips/buttons. (Wave 2's `lt`/future `de` expand more — handled then.)
- **CJK fonts:** ensure the font stack + name-style cosmetics degrade gracefully
  for zh/ja (user cosmetic CSS is user content, unaffected).
- **Don't translate identifiers:** command names/aliases, permission keys,
  `error:notice` codes, slugs, `@id:`/`@cid:` tokens — these are protocol, not
  copy.
- **Intentional-design strings** (per project memory §7-style landmines) stay as
  designed; localizing copy ≠ changing behavior.
- **Effort:** this is the single largest initiative in the roadmap (thousands of
  strings). MT-seeding + per-locale live-flip keeps it from being all-or-nothing.
