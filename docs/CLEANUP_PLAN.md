# The Spire — Codebase Cleanup & Professionalization Plan

*Refactor/organization plan. **Hard constraint: preserve existing functionality and display exactly.** Every behavior-affecting change below is flagged, and each carries a neutralization strategy (options-flags, characterization tests, or "leave as-is"). Nothing here is a feature or behavior change; where a "consolidation" would alter a user-visible string or code path, it is called out as **NOT behavior-preserving** and demoted/split so the safe part can proceed alone.*

---

## 1. Executive Summary — highest-leverage cleanups

1. **Adopt ESLint + Prettier + `tsc --noEmit` in CI in report-only mode first** — no repo has them today; introduce as non-blocking to avoid a 505-file reformat churn, then ratchet.
2. **Land ~8 tiny shared utilities that already have a canonical home** (`http.jsonOrThrow`, `withIdentityQuery`, `escapeHtml`, `escapeRegExp`, `emitToUser`, `onlineUserIds`, `startOfUtcDayMs`, `initials`) — these absorb 100+ copies and most are provably byte-identical.
3. **Consolidate the earning/arcade money primitives** (`resolveActiveServerId` ×3 byte-identical, `ownsPurchase`, `earnedTodayForCap`, sync `debitPool`) into `apps/server/src/earning/` — highest correctness value since these are currency paths.
4. **Route the two remaining title commands through the canonical `resolveIdentityArg`** — the last consumer of a first-hit-wins identity resolver the shared one was written to kill (behavior-changing; needs ambiguity branches).
5. **Extract the server-side "per-user socket fan-out" and "presence rebroadcast" helpers** — ~16 hand-rolled `fetchSockets()` loops in `broadcast.ts`/`engine.ts`/`titles`/`servers` collapse to two helpers.
6. **Split the five worst god-files by responsibility** (`schema.ts` 6740, `AdminPanel.tsx` 5902, `App.tsx` 5570, `MessageList.tsx` 5502, `broadcast.ts` 3375) via pure move-only extraction guarded by characterization tests.
7. **Domain-folder the flat 151-file `apps/web/src/components/` directory** and add barrels — mechanical, zero-behavior, done last so it doesn't collide with in-flight extractions.
8. **Add a "shared-first" custom lint** (ban re-declaring `jsonOrThrow`/`escapeHtml`/`identityKey`/`resolveActiveServerId` etc.) so the dedup doesn't re-drift.

---

## 2. Codebase Map

### 2.1 Counts by category (501 categorized files)

| Category | Approx. count | Where |
|---|---|---|
| `ui-component` / `ui-modal` | ~150 | `apps/web/src/components` (flat, 151 files) |
| `data-hook` | ~40 | `apps/web/src/lib`, `apps/web/src/state` |
| `api-route` | ~55 | `apps/server/src/routes`, `admin/*`, `servers/*`, `analytics/*` |
| `command-handler` | ~45 | `apps/server/src/commands/builtins`, `games/` |
| `domain-logic` | ~70 | `apps/server/src/earning`, `auth`, `realtime`, `analytics`, `backup`, `web/src/lib` |
| `types` (wire contracts) | ~40 | `packages/shared/src` |
| `util-helper` | ~45 | both apps + shared |
| `style-injection` | ~15 | `apps/web/src/lib` (injectors, ornaments), `styles.css` |
| `schema` | 1 | `apps/server/src/db/schema.ts` |
| `config` / `script` / `socket-realtime` | ~40 | scattered |

### 2.2 God-files (>1500 lines) and what each conflates

| File | Lines | Conflates |
|---|---|---|
| `apps/server/src/db/schema.ts` | 6740 | Every table/column/index for the whole app in one Drizzle module |
| `apps/web/src/components/AdminPanel.tsx` | 5902 | Admin console shell + all tab wiring + inline helpers (duration parse, clipboard, password gen) |
| `apps/web/src/App.tsx` | 5570 | Router + socket hub + auth/splash gate + code-split modal orchestration + banner-dismiss store |
| `apps/web/src/components/MessageList.tsx` | 5502 | Feed render + time formatters + identity matching + 5× per-field occupant selectors + forum topic admin + visibility gating |
| `apps/web/src/components/EarningDashboard.tsx` | 5423 | Rank/XP/currency/cosmetics/shop views + fetch + tab strip |
| `apps/web/src/styles.css` | 5310 | All static custom CSS (reduce-motion, animations, themes, per-component) |
| `apps/web/src/components/ForumsCatalogModal.tsx` | 4959 | Boards + topics + posting + permalink building + slug derivation |
| `apps/web/src/components/ProfileEditor.tsx` | 4797 | Fields + portraits + flair + NSFW + styling + designer-tour flag |
| `apps/server/src/routes/earning.ts` | 4215 | Wallet + ledger + rank-up + catalog slices + privacy + cosmetics + cursor pagination |
| `apps/web/src/components/AdminEarningTab.tsx` | 3986 | Earning catalog CRUD + its own `formatDurationShort` + nonce/shadow style injection |
| `apps/server/src/routes/stories.ts` | 3974 | Catalog + chapters + collaborators + applause + entities + earning + daily-cap clamps ×2 |
| `apps/web/src/components/HelpGuides.tsx` | 3554 | All long-form guide copy in one component |
| `apps/server/src/realtime/broadcast.ts` | 3375 | Persistence + presence + room lifecycle + broadcast + 6× inline incognito predicate |
| `apps/server/src/routes/forums.ts` | 3020 | Catalog + detail + mutations + roles + banners + gates (also imported *by* rooms.ts) |
| `apps/server/src/routes/servers.ts` | 2818 | Registry + applications + join/leave + review + console + bans + transfer |
| `apps/server/src/index.ts` | 2803 | One `main()`: Fastify+Socket.IO bootstrap + route reg + handshake + inline socket rate limiters |
| `apps/web/src/components/ServerSettingsView.tsx` | 2712 | Many server-admin tabs + inline `jsonOrThrow` + `parseDurationMs` |
| `apps/web/src/components/ProfileModal.tsx` | 2702 | Viewer + NSFW gate + reporting + bio render + 2× clipboard + image lightbox |
| `apps/server/src/routes/worlds.ts` | 2685 | Catalog + applications + membership + entities + arcs + sessions + lore |
| `apps/server/src/admin/earning.ts` | 2542 | Awards/ranks/cosmetics/config CRUD in one router |
| `apps/web/src/components/MessagesModal.tsx` | 2485 | DM inbox/thread + composer + reactions + identity key + initials + dimension persistence |
| `apps/server/src/admin/routes.ts` | 2457 | users/commands/reports/automod/titles/worlds + sub-route wiring + online-set build ×2 |
| `apps/server/src/servers/earning.ts` | 2100 | Per-server faucet/sink/grant/clawback/cosmetics (twin of admin/earning) |
| `apps/web/src/lib/earning.ts` | 2028 | Earning wire types + all fetch helpers |
| `apps/web/src/lib/markdown.tsx` | 1836 | Inline markdown/mention/emoticon/chip/media renderer |
| `apps/web/src/components/WorldEditorModal.tsx` | 1783 | Entities + arcs + sessions editor |
| `apps/web/src/components/AdminPermissionsTab.tsx` | 1565 | Role matrix + per-user overrides + own tab strip |
| `apps/web/src/components/ToolPanel.tsx` | 1531 | Command/tool launcher for many surfaces |

Near-god (1000–1500, watch): `RoomsTree.tsx` 1193, `AuthGate.tsx` 1214, `characters.ts` 1276, `profile.ts` (cmd) 1175, `rooms.ts` 1602, `users.ts` 1425, `emoticons.ts` 1473, `messages.ts` 1154, `directMessages.ts` 920, `store.ts` 1871, `seo.ts` 1238, `StoryEditorModal.tsx` 1323, `EarningTab.tsx` (server-admin) 1294.

### 2.3 Structural observations worth carrying forward

- **Deliberate mirrors (do not "merge away", only share scaffolding):** every `servers/*.ts` route is a per-server twin of an `admin/*.ts`/`routes/*.ts` module; `servers/authority.ts` mirrors `forums/authority.ts`; `server-admin/*Tab.tsx` mirrors global `Admin*Tab.tsx`; `state/identityTokens.ts` mirrors `state/mentions.ts`; three arcade client modules (`arcade`/`urugal`/`grimhold`) share one run-session shape.
- **Well-factored subsystems to emulate, not touch:** `earning/` single-funnel discipline (`pool.ts` sole read, `award.ts` sole credit — CI-grep-gated), `auth/permissionsCore` pure/IO split, `games/registry.ts` plugin framework, `packages/shared` single-source-of-truth types.
- **Cross-cutting concerns already centralized:** `getSessionUser`, `serverAuthority`/`forumAuthority`, `blockedUserIdsFor`, `hasPermission`, `cspNonce`/`injectStyle`, `reducedMotion`.

---

## 3. Duplication → Modularization Plan

Grouped by proposed shared module home; ordered within the document roughly by (severity, low-risk-first). **BP = behavior-preserving.** Findings marked *NOT BP* must ship as an options-carrying helper or be split so the byte-identical subset lands separately from the behavior change.

### Group A — `apps/web/src/lib/http.ts` (existing)

**A1. `jsonOrThrow<T>` fetch unwrapper — 10 copies** *(severity high, NOT BP)*
Concept: parse JSON body, return as `T`, throw on non-OK. Copies split into form-A (`readError`-based: richer zod/`{message}` text) at `emoticonSubmissions.ts:104`, `earning.ts:486`, `worldEntities.ts:32`; form-B (`{error}`-only, `"Request failed (N)."` fallback) at `forums.ts:89`, `servers.ts:182`, `affiliates.ts:40`, `ServerSettingsView.tsx:243`, `server-admin/ReportsTab.tsx:51`, `server-admin/CommandsTitlesTab.tsx:106`, `AdminServersTab.tsx:63`.
Single home: one `readError`-based `jsonOrThrow` in `http.ts`.
**Preserve / risk:** the 7 form-B sites would gain different error strings (`"500 Internal Server Error"` vs `"Request failed (500)."`) and lose the "non-JSON 200 returns null" quirk (would throw). **Plan:** land form-A sites first (byte-identical, zero-change). For form-B, add the helper but keep it opt-in per call site, converting only after confirming the richer error text is acceptable display — treat as an intentional UX improvement, not a silent refactor. Leave the bespoke non-`jsonOrThrow` fetches (`servers.ts:177/192` "Couldn't load…") untouched. Respect the "do NOT widen `lib/servers.ts`" comments by homing in `http.ts`.

**A2. Manual `?characterId=` building vs `withIdentityQuery` — 7 copies** *(medium, BP)*
`arcade.ts:37`, `grimhold.ts:19`, `earning.ts:927`, `storyCopies.ts:31`, `urugal.ts:20`, `ProfileFlairSurfaces.tsx:191`, `ProfileFlairEditor.tsx:171`.
**Preserve:** 5 return a bare suffix; `withIdentityQuery` takes/returns a full URL — rewrite those call sites to assemble the URL. `ProfileFlairEditor` inlines `/me/profile-flair` (no base param). `?`-vs-`&` hardening is inert today (no base has a query) so output is byte-identical. Pure fetch URLs, no display.

### Group B — `apps/server/src/lib/fetchWithTimeout.ts` (new)

**B1. AbortController fetch-timeout scaffolding — 3 copies + 1 convergence** *(medium, BP if done right)*
`googleOauth.ts:92` (`fetchJson`), `youtube.ts:71` (`apiGet`), `unfurl.ts:103` (`fetchHtml`); `mailer.ts:83` already uses `AbortSignal.timeout`.
Home: `fetchWithTimeout(url, init, ms)` returning `fetch(url, {...init, signal: AbortSignal.timeout(ms)})` (fires regardless, covers body read, self-cleans).
**Preserve:** the signal MUST stay live through body consumption (all three read the body under the timer) — a naive `clearTimeout`-on-resolve version narrows to headers-only = behavior change. Keep per-caller: distinct timeout constants, distinct catch/return shapes (`null` vs `{data,error}` vs logging), and `unfurl`'s manual per-hop redirect loop. Only the scaffolding moves.

### Group C — `packages/shared/src/duration.ts` (new)

**C1. Duration string → ms parser — 5 copies** *(high, NOT BP)*
`commands/duration.ts:14` (s/m/h/d, 365d cap, strict whitelist), `shared/export.ts:33` (d/h/m + long spellings, bare=hours), `AdminPanel.tsx:742` & `ServerSettingsView.tsx:2067` (true clones, bare=ms, differ only on empty→0 vs null), `shared/announcement.ts:116` (ordered single-occurrence regex, ok/message result).
**Plan:** merge the two web clones now behind an `emptyValue` option (zero-change). Offer a canonical parser with options `{units, bareMode, cap, whitelist, emptyValue, returnShape}` for the others, but do **not** fold `announcement.parseScheduleSpec` — its ordered regex + range messages + `Date()` fallthrough can't be reproduced without extra branching; leave it.

**C2. ms → compact label — 4 copies** *(medium, BP with options)*
`commands/duration.ts:45` (no-sep, shows seconds), `shared/export.ts:217` (`formatDurationShort`, space-joined, all d/h/m), `announcement.ts:179` (no-sep), `AdminEarningTab.tsx:2663` (**name-collides** with the shared export but uses a different ladder: ≤60m shows minutes, max 2 units, drops minutes when days present).
**Preserve via options** `{separator, maxUnits, showSeconds, zeroLabel, clampNegative}`. Swapping `AdminEarningTab` to the shared helper as-is **would change output** — keep its ladder behind `maxUnits:2` + drop-lower semantics or leave it. `export.ts` lacks a negative guard; keep parity.

### Group D — time helpers

**D1. Relative "time ago" ladder — 4 copies** *(medium, NOT BP)* → `apps/web/src/lib/relativeTime.ts` (new)
`forums.ts:66` (90s just-now, 48h cutoff, "ago"), `NotificationCenter.tsx:94` (60s "now", adds weeks, no suffix), `MessageList.tsx:374` (60s/24h then date fallthrough), `PollCard.tsx:69` (future-facing "closes in", `Math.round`). Only the `Date.now()-ms / 60_000 / 3_600_000 / 86_400_000` arithmetic is common. Extract a config-driven core `{justNowSec, hourCutoffHrs, suffix, addWeeks, clampNegative, roundMode}`; each surface keeps its own tier/word config so display is identical. Low priority — nearly trivial shared fragment.

**D2. Zero-padded wall-clock timestamp — 3 copies** *(low, NOT BP)* → `packages/shared/src/datetime.ts` (new)
`MessageList.tsx:342` (local HH:MM:SS), `AdminVerifyLogTab.tsx:54` (local YYYY-MM-DD HH:MM:SS, `"-"` on non-finite), `chatLog.ts:225` (tz-offset via `getUTC*`). Only the `padStart(2,'0')` is common. Share a `pad2` + optional assemblers; keep date-vs-no-date, local-vs-UTC-offset, and the `"-"` fallback per caller.

**D3. `startOfUtcDayMs` — 6 copies** *(low, BP)* → `packages/shared/src/time.ts`
`arcadeUrugal.ts:53`, `arcadeGrimhold.ts:67`, `stories.ts:2056/3886`, `analytics/rollup.ts:50`, `analytics/admin.ts:52`. All yield the identical value; drop-in. Do **not** fold `eidolon.ts`'s day-*number* (`/86_400_000`) — different unit. `rollup.ts` slots in as `const start = startOfUtcDayMs(ref)` feeding its existing bounds.

### Group E — `packages/shared/src/profile.ts` (existing)

**E1. `isModeratorRole` re-derived as `roleRank(x) >= roleRank("mod")` — 5 copies** *(medium, BP)*
`rooms.ts:210`, `staff.ts:158` (negated), `commands/profile.ts:146`, `ProfileModal.tsx:186/467`. Result sets are identical (mod/admin/masteradmin). Use existing `isModeratorRole`; `staff.ts` becomes `!isModeratorRole(...)`; keep the `!== null &&` null-guards.

**E2. "actor outranks target" open-coded — 6 sites** *(medium, BP with two helpers)*
`mod.ts:208/345/720`, `users.ts:775` (strict `>`), `users.ts:880` (inclusive `>=`, blocks peers), `RoomsTree.tsx:986`. Add `outranks` (strict) **and** `outranksOrEqual` (inclusive) next to `roleRank`; apply the right one per site. Helper must accept a nullable actor role (RoomsTree). Do **not** fold `users.ts:772` (grants-vs-actor, a different check). Refusal messages/HTTP codes stay at call sites — no display change.

### Group F — `apps/server/src/auth/scopedAuthority.ts` (new)

**F1. `forumAuthority` ≈ `serverAuthority` — parameterize shared scaffold** *(low, medium risk, BP)*
`forums/authority.ts:63/74`, `servers/authority.ts:85/99`. Share only the generic core (usergroup-perm resolution, lazy-ban expiry, owner-implies-all, NONE sentinel, `xCan = isOwner || permissions.includes(key)`), injected with: parse-fn (`parseForumPermissions` vs `parseServerFeaturePermissions`), fallback feature-set constant, mod-tier derivation (servers add an `admin` lieutenant tier), and the `isServerModerationActive` gate in `canParticipate` (servers only). Low priority; touching two authority resolvers is inherently risky — gate behind full authority-matrix characterization tests.

### Group G — URL / slug / navigation helpers

**G1. Forum `/f/<slug>[/t/<id>]` parse regex — 2 byte-identical App.tsx copies** *(medium, BP)* → `apps/web/src/lib/forums.ts` (add `parseForumUrl`)
`App.tsx:896/898` (anon router) and `App.tsx:1315/1318` (signed-in effect). Hoist regex + group extraction into `parseForumUrl(pathname, hash)`; each caller passes its own pathname source (state var vs `window.location`). Leave `nav-metrics.ts:301` (looser analytics classifier) separate — not a true dup.

**G2. Server `/s/<slug>` parse regex — 2 App.tsx copies** *(medium, BP)* → `apps/web/src/lib/servers.ts`
`App.tsx:917/1358`. Same pattern as G1; hoist regex only, keep the `readReturnServer`/`serversEnabled` gates at call sites.

**G3. Forum permalink builder — 4 sites** *(medium, BP)* → `apps/web/src/lib/forums.ts` (add `forumPermalink`/`forumShareUrl`)
`ForumPublicLanding.tsx:143` (relative), `ForumsCatalogModal.tsx:357` (state-gated), `ForumsCatalogModal.tsx:2005` (absolute + `#p-` fragment → needs `forumShareUrl(slug,topicId,postId)`), `AuthGate.tsx:964` (display fallback label — cosmetically a stretch, output identical). Mirror `scriptoriumUrl.storyPermalink`. `encodeURIComponent` is a no-op on legal slugs (regex-constrained). Keep builder aligned with G1 parser to prevent share-link drift.

**G4. SPA `pushState + PopStateEvent` navigate — 5+ copies** *(low, medium risk, NOT BP)* → `apps/web/src/lib/spaNav.ts` (new)
`App.tsx:844`, `TopCommunitiesPage.tsx:52`, `faqUrl.ts:33/40`, `rulesUrl.ts:34/46` (**pushes WITHOUT dispatch**), plus `scriptoriumUrl`/`worlds`/`profiles`. Copies disagree on same-path guard and whether they dispatch popstate. Only safe as `spaNavigate(to, {guard?, dispatch?})`; a flat always-guard-always-dispatch helper would change `rulesUrl` (adds re-route) and `TopCommunities` (adds guard). Low priority.

### Group H — `packages/shared/src/html.ts` (new)

**H1. HTML-escape helper — 9+ copies** *(medium, BP with two named exports)*
`uiRoutes.ts:479/487`, `seo.ts:84`, `chatLog.ts:117/127`, `email/templates.ts:10`, `email/layout.ts:109`, `freeformBorderTemplate.ts:25`, `nameStyleTemplate.ts:32`, `cssScope.ts:75`. Provide `escapeHtml` (`&<>`) and `escapeHtmlAttr` (`+" '`). All share `&`-first ordering so a canonical fixed order is safe.
**Preserve:** `cssScope.escapeAttr` escapes only `&"` (subset — map to a limited variant, not the full escaper); `seo.escapeHtmlAttr` collapses `\s+` first (keep as a thin wrapper). Placing in `shared` is reachable from web+server. Overlaps finding **H4** below (template-gen escapers) — same module, do together.

**H4. Template-gen escapers — subset of H1.** `nameStyleTemplate.escapeHtml` and `freeformBorderTemplate.escapeHtmlAttr` are byte-identical → the only two that fold with zero change; `cssScope`/`seo` need their variants preserved as above.

### Group I — mention / markdown parsing

**I1. `@kind:slug` DOM chip decorator (world vs story) — structural clones** *(medium, BP with params)* → `apps/web/src/lib/mentionChips.ts` (new)
`storyMentions.ts:28/50/62`, `worldMentions.ts:14/29/40`. Share the tree walker + fragment builder + `story-chip`/data-attrs + `lastIndex` advance + 1400ms flash. Parameterize: kind-matcher regex, `href` scheme, click dispatch (CustomEvent/scroll vs injected `onOpenEntry`).

**I2. Kebab-slug regex fragment `[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?` — 3 sites** *(low, BP)* → import existing `packages/shared/src/mentions.ts:46 MENTION_WORLD_SLUG_CHARS`
`worldMentions.ts:14`, `storyMentions.ts:28` re-embed the literal. Import the constant only; keep the surrounding per-copy boundaries/kind-classes and the module-level singleton `RegExp`s (stateful `.lastIndex`). Note this couples three slug domains — the finding's intent, a deliberate decision.

**I3. `url()` scheme scrubber — 3 copies with drift** *(medium, NOT BP)* → `packages/shared/src/cssSanitize.ts` (new)
`auth/html.ts:184` (`url('')`), `auth/html.ts:219` (`url("")`), `cssScope.ts:85` (flat regex, no `file:` block, no nested-paren handling). Unifying to the server's balanced-paren regex **adds** `file:` blocking + nested-paren handling + quote-char change to the client copy — real changes (defense-in-depth hardening, but not zero-change). Keep the surrounding `behavior:`/`-moz-binding` scrubs where they are. Ship as a hardening PR with its own review, not folded into "cleanup."

**I4. Chat inline-markdown re-implemented server-side for export** *(low, HIGH risk, NOT BP)* → do NOT unify the renderers
`chatLog.ts:137/194` vs `markdown.tsx:289`. The grammars genuinely diverge (underscore-double forms, intraword rule, spoilers/code/emoji, link stripping) and target different output types. The **only** safe shared artifact is the inline tag-alias key list (`b/strong/i/em/u/s/strike/del/code`) → export a shared `SAFE_INLINE_TAGS`. Leave both renderers.

**I5. `escapeRegExp` — 1.5 copies** *(low, BP)* → `packages/shared/src/regex.ts` (new)
`automod.ts:256` (full, module-private) vs `unfurl.ts:157` (narrow `[:.]` inline). Export the full escaper; `unfurl` only ever passes literal keys (`og:title`…) with no other metachars, so output is byte-identical — confirm no dynamic key is ever passed.

### Group J — CSP nonce & style injection

**J1. CSP nonce meta read — 4 copies** *(medium, BP)* → use existing `apps/web/src/lib/cspNonce.ts CSP_NONCE`
`nameStyleInjector.ts:64`, `freeformBorderInjector.ts:40`, `StyledName.tsx:128`, `AdminEarningTab.tsx:1363`. All guard `if (nonce)`, so `null` vs `""` default is unobservable. The two component copies "re-read per creation" (nonce rotation) is equivalent within a single SPA load — safe, but note the dropped re-read intent in a comment.

**J2. Nonce-stamped `<style>` creation — 5 copies** *(medium, medium risk, BP if minimal)* → `apps/web/src/lib/injectStyle.ts`
`nameStyleInjector.ts:70`, `freeformBorderInjector.ts:93`, `injectStyle.ts:20`, `StyledName.tsx:119`, `AdminEarningTab.tsx:1362`. Extract only `createNonceStyleTag()` that creates + stamps + **returns an unattached element**; keep append/keying/rewrite/cleanup per caller. Must use the live meta read (not the module-load constant) or `injectStyle` semantics change; `AdminEarningTab` appends to a **shadow root** (helper must not append internally).

### Group K — identity resolution & rendering

**K1. Titles' `resolveIdentityByName` bypasses canonical `resolveIdentityArg`** *(high, NOT BP)* → `apps/server/src/commands/identityArg.ts`
`titles/service.ts:59-107`, consumed by `titles.ts:140/252` + `service.ts:500/605`. The titles copy silently returns the first master hit — the exact first-hit-wins bug the canonical resolver exists to prevent. **Changes needed:** add ambiguous/none branches at 3 consumers; reconcile NBSP-fold differences (3-variant IN list vs `char(160)` fold); reconcile token-whitespace handling (`slice(5).trim()` accepts `@cid: abc`); adapt return shape (`ResolvedTarget` carries `masterUsername`). This is a **correctness fix**, not zero-change — ship with tests asserting ambiguous-name behavior, and treat the resolution-result change as intended.

**K2. Client identity-tuple equality + `identityKey` — many copies, two delimiters** *(medium, medium risk, BP)* → `apps/web/src/lib/identity.ts` (new)
`identityKey` differs: `MessageList.tsx:913` uses `::`, `MessagesModal.tsx:535` uses `:` (keys are component-internal, never persisted → unifying is safe if producer+comparator both use the helper in each file). Equality copies split normalized (`?? null` both sides) vs unnormalized (`sound.ts:104`, `AdminEarningTab.tsx:1626/1887`, `EarningDashboard.tsx:394`, `MessagesModal.tsx:1279`). Fields are `string | null` (no `undefined`), so a `?? null`-folding `identityEquals` is behavior-identical. `MessagesModal:634` compares `otherUserId/otherCharacterId` (field adaptation). **Edits land in hot zustand selectors — preserve selector reference stability** (React #185 hazard). Land carefully with the god-file splits, not before.

**K3. 5× per-field occupant-scan selectors in MessageList** *(low, medium risk, NOT BP as proposed)* → `apps/web/src/lib/occupants.ts`
`MessageList.tsx:2743-2795` (×5), `MessagesModal.tsx:1792/1801`, `AdminEarningTab.tsx:1626`, `EarningDashboard.tsx:394`. A row-returning `useOccupantRow` is **not** zero-behavior: `avatarUrl` uses a truthy-continue guard (keeps scanning) vs crop/border stop-at-first-match; row-reference return changes zustand re-render granularity on a hot path; matcher null-normalization differs per site. **Safe form:** a field-level helper that encapsulates the loop but takes a caller-supplied primitive picker + per-field truthy semantics. Defer to the MessageList split.

### Group L — names / slugs (`packages/shared/src/names.ts`, `packages/shared/src/slug.ts` — new)

**L1. Char-name validation regex + `normalizeCharName` — 3+2 copies** *(medium, BP with flag)* → `names.ts`
Server `char.ts:14/27` and `characters.ts:41/52` are **byte-identical** (regex + `input.trim()`) — consolidate with zero change. Client `CreateCharacterModal.tsx:58` intentionally drops ASCII space and does length as a separate `trimmed.length` check. Helper needs an `allowAsciiSpace` flag; keep the client's own length check (UTF-16 units vs regex code points diverge on astral letters). Keep client UX (`hasAsciiSpace` warning) and server Zod `min(1).max(40)` at call sites. Carry the NBSP rationale comments.

**L2. NBSP-fold name normalizer — 2 client copies + server twin** *(medium, BP)* → `names.ts` (export `canonicalizeNameForLookup`)
`markdown.tsx:1299`, `MessageList.tsx:3955` (client twins of `nameLookup.ts:63`, uncopyable server-only). Order differs (lowercase-then-replace vs replace-then-lowercase) but result-identical. Home in `shared` so both apps import. Note the SQL-side twin (`char(160)`) in `nameLookup.ts` still needs manual lockstep — not covered by the JS import.

**L3. `deriveSlug` — 4 copies** *(medium, BP with params)* → `slug.ts`
`world.ts:547` (canonical) duplicated as `story.ts:223`; `ServerDiscoverModal.tsx:911` (max 40), `ForumsCatalogModal.tsx:715` (`_` sep, max 40). Parameterize `{sep, max}`; **build the edge-trim regex from `sep`** (forum trims `_`, not `-`).

**L4. Slug format-validation regex — 8 sites, 3 shapes** *(medium, BP)* → `slug.ts`
Shape A (max 60): `worlds.ts:88`, `stories.ts:108`, `room.ts:479`. Shape B (max 42): `emoticons.ts:48`, `servers/emoticons.ts:70`, `EmoticonSubmissionModal.tsx:34`. Shape C (`[a-z0-9_-]{1,32}`, allows `_`/edge/single-char): `commandsTitles.ts:147`, `admin/routes.ts:2264`. A+B collapse to `slugRx(max)` (6 sites, zero-change); **C needs its own separate constant** — it can't be produced by a max-parameterized A/B. Per-site error strings stay separate. Client copy imports from `shared` without server deps.

### Group M — server infra helpers

**M1. Sliding-window rate limiter — 4 copies** *(low, BP)* → `apps/server/src/lib/slidingWindow.ts` (new)
`dispatch.ts:43`, `antiSpam.ts:139`, `index.ts:2091` & `:2119`. The two `index.ts` copies are a clean pair → full replacement with `makeRateLimiter({windowMs, max})`. `checkChatRate` and `antiSpam` reuse only the counting core (keep `cooldownUntil` penalty / `retryMs` / no-push-on-reject / escalation ladder + differing key lifetimes: process-global Map vs per-socket closure).

**M2. Per-user socket fan-out — ~11 sites, 3 variants** *(medium, BP)* → `apps/server/src/realtime/presence.ts` (new `emitToUser` / `socketsForUser` / `socketsForUsers`)
`engine.ts:230/259`, `session.ts:31`, `titles/service.ts:754/773`, `servers/notifications.ts:59/95`, `roomReads.ts:220`, `admin/earning.ts:1640`, `servers/earning.ts:658`, `earning/award.ts:209`, `incognito.ts:135`. **Not uniform:** `pulse()` returns liveness + emits two events (use `socketsForUser`), `session.ts` emits two + delayed disconnect, `award.ts` emits conditional second event, `service.ts:773` filters a Set of many users (`socketsForUsers`). Provide both a single-user and multi-user filter helper; keep per-site event sequences and best-effort try/catch exactly (don't add/remove the catch).

**M3. Collect occupied rooms → rebroadcast presence — 5 sites** *(medium, medium risk, BP for 2)* → `broadcast.ts` (`roomsForUser` + `rebroadcastPresenceForUser`)
`worlds.ts:802` & `world.ts:54` are verbatim twins → clean drop-in. `incognito.ts:24` seeds with `ctx.roomId` and only collects; `broadcast.ts:2582` fuses collect with a per-socket emit (needs a second pass); `broadcast.ts:2768` iterates two users. Share `roomsForUser(io, userId, seedRoomId?)` for all 5; keep the two-user + single-pass-emit cases custom. Preserve `.catch(()=>{})` presence on the twins but not where absent.

**M4. Inline incognito-hidden predicate — 6 sites bypass `isHiddenIncognitoIdentity`** *(low, BP)* → call existing `broadcast.ts:2513`
`broadcast.ts:332` (also ANDs `kind !== "system"` — keep that AND at the site), `:1926`, `:2113` (negated in a compound), `:2690`, `:2935`, `:2953`. Helper already normalizes `?? null`; passing each site's raw char-id source is byte-equivalent.

**M5. Online-user Set from `fetchSockets()` — 3 sites** *(low, BP)* → `broadcast.ts` (`onlineUserIds(io): Promise<Set<string>>`)
`admin/routes.ts:239/476`, `eidolonNudge.ts:55`. Identical; drop-in.

### Group N — React UI scaffolding

**N1. Tab-pill button — 4+ copies** *(medium, BP with variant prop)* → `apps/web/src/components/TabBtn.tsx` (new)
`EarningDashboard.tsx:300` & `AdminPanel.tsx:580` (byte-identical; AdminPanel adds `tourAnchor`), `AdminPermissionsTab.tsx:236` & `AdminEarningTab.tsx:160` (drop `shrink-0 whitespace-nowrap`), `HelpModal.tsx:202` (different token pair). Expose `{variant, includeShrink, tourAnchor}`. `includeShrink` must NOT default-on (could alter wrap/shrink in the two strips that omit it).

**N2. Copy-to-clipboard + transient flash — ~7 copies** *(medium, medium risk, BP with options)* → `apps/web/src/lib/useCopyToClipboard.ts` (new)
`RoomInfoBar.tsx:382`, `ProfileModal.tsx:1672` (+ a 2nd copy ~1694), `TheaterPanel.tsx:425`, `WorldViewerModal.tsx:135`, `AffiliateSubmitPortal.tsx:517`, `AdminPanel.tsx:4352`. `useCopyToClipboard(text, {resetMs, onError})`. Reset delay varies (1200/1500/3000); failure branch varies (silent vs `window.prompt` fallback with distinct labels) — must be an option or behavior drops. `AdminPanel` is NOT a clean copy (password gen + `execCommand` fallback + timeout-inside-try) — don't force-fit.

**N3. Modal backdrop shell reimplemented — 4 sites** *(medium, medium risk, NOT BP)* → keep, do not swap to `Modal.tsx`
`ThreadModal.tsx:169`, `ItemZoomView.tsx:48`, `ProfileModal.tsx:2186`, `NotificationCenter.tsx:261`. `Modal` has no `aria-label` prop (swap drops accessible names), always portals (ThreadModal/ItemZoomView intentionally don't), always applies `tk-fade-in` (ThreadModal has none), and can't express `backdrop-blur`/`flex-col`/`overflow-auto`/body-scroll-lock/anchored-dropdown. **Prereq work:** add `aria-label` + `className` passthrough to `Modal` first, then migrate only the true-centered-modal cases; leave the dropdown (`NotificationCenter`) and non-portaled lightboxes. Low urgency.

**N4. Lucide-X header close button — 3 copies** *(low, BP)* → new `IconCloseButton` (or icon variant of `CloseButton.tsx`)
`NotificationCenter.tsx:287` (lacks `shrink-0`), `ServerEventsPanel.tsx:381`, `ServerSettingsView.tsx:2686`. Existing `CloseButton` renders a Unicode `×` at a different size — a swap is **not** zero-change; add an icon variant with `className` passthrough.

### Group O — `apps/server/src/lib/pagination.ts` + SQL helpers (new)

**O1. `?limit` clamp idiom — ~17 sites** *(high, NOT BP)* → `pagination.ts`
Sites listed across `rooms/worlds/stories/users/search/forums/notifications/reports/servers-reports/permissions/admin-routes`. Diverge: floor varies (`max(1)` vs `max(5)` at `forums.ts:1211` vs **no floor** at `reports.ts:222`, `servers/reports.ts:75`, `permissions.ts:575`, `admin/routes.ts:2380`); `Number()` vs `parseInt(…,10)` (`forums.ts:2910`, `notifications.ts:41`); separate offset variant (`users.ts:97/463`). Helper needs `{min, max, default, parseMode}`; adopting it at the no-floor sites is a real (probably desirable) behavior change — do those knowingly, in a separate commit, or leave them.

**O2. LIKE-wildcard escaping — 5 escape sites + 2 divergent** *(medium, NOT BP wholesale)* → `nameLookup.ts` (export narrow `escapeLike`)
Extract a pure `escapeLike(s)=s.replace(/[%_]/g,c=>`\\${c}`)` for `rooms.ts:376`, `worlds.ts:897`, `stories.ts:1075`, `users.ts:489`, `search.ts:181` (zero-change). Do **not** reuse the named `substringNameInsensitive` wholesale (it forces NBSP-fold + `char(160)` canonicalization → changes message-body/non-name-column matching). `forums.ts:1760` & `servers.ts:2178` use STRIP + prefix pattern + no ESCAPE (autocomplete) — making them "agree" is a behavior change (bug fix), keep separate.

**O3. Comma-wrapped tag membership filter — 4+1 sites** *(medium, BP)* → `apps/server/src/lib/tagFilter.ts` (new)
`worlds.ts:911/919`, `stories.ts:1085/1091` (+ uncited `stories.ts:1070`). `tagIncludes(col,tag)`/`tagExcludes(col,cw)`; reproduce exact lowercase + comma-wrap + **no** LIKE-escaping.

**O4. Offset-catalog scaffolding (worlds + stories)** *(medium, medium risk, BP for the slice)* → `pagination.ts`
`worlds.ts:228/882`, `stories.ts:179/1035/1116`. Share only the `page/pageSize` zod fragment + `count` + `hasMore`/envelope helper. Keep per-route: parse-failure handling (empty `{}` vs HTTP 400), extra envelope fields (`copyEnabled`/`ownedStoryIds`), entity-specific conds/orderBy, distinct tables. Don't extract the whole typed query.

**O5. `createdAt` cursor pagination — 2 divergent** *(medium, medium risk, NOT BP)* → `pagination.ts`
`engine.ts:354` (correct `limit+1` / `rows.length > limit`) vs `earning.ts:1386` (fetches `limit`, `=== limit` → **spurious cursor + extra empty page**). Unifying onto the correct test **is** the fix, not preservation — ship as an off-by-one bug fix with a test. Shareable sliver is only the `limit+1`/slice/`nextCursor` fragment; cursor parsing, WHERE building, and row-mapping stay per caller.

**O6. `strftime` day-bucket — 2 sites, divergent tz** *(low, BP)* → `apps/server/src/lib/sqlTime.ts` (new)
`admin/routes.ts:621` (tz-shifted) vs `stats.ts:58` (UTC). `dayBucket(col, tzShiftSec=0)` with `.as("day")`; default 0 keeps `stats` UTC. Preserve the intentional divergence (don't unify onto one tz).

### Group P — earning / arcade money paths (`apps/server/src/earning/*`)

**P1. `resolveActiveServerId` — 3 byte-identical copies** *(high, BP)* → `earning/pool.ts`
`arcade.ts:56`, `arcadeUrugal.ts:102`, `arcadeGrimhold.ts:114`. Only JSDoc wording differs. Extract taking `(db, me, requestedServerId)`. Highest-value low-risk win in the money layer.

**P2. Arcade purchase-unlock gate — 4 copies, serverId divergence** *(high, BP with optional param)* → `earning/purchases.ts` (new `ownsPurchase`)
`arcade.ts:93` (scopes `eq(serverId)` — per-server), `arcadeUrugal.ts:84`, `arcadeGrimhold.ts:96`, `eidolon.ts:46` (all global — no serverId). Helper takes **optional** `serverId`; returns boolean only. Keep the differing failures at call sites (HTTP 402 `needsUnlock` vs `error:notice EIDOLON_LOCKED`) and the per-game permission double-gate.

**P3. Daily-cap ledger scan + clamp — 4 copies** *(medium, medium risk, BP with params)* → `earning/dailyCap.ts` (new)
`arcadeGrimhold.ts:140`, `arcadeUrugal.ts:129`, `stories.ts:2055/3886`. Share `earnedTodayForCap` (parameterized on reason-match mode `LIKE`-prefix vs `eq`, and summed fields xp/currency) + `clampToDailyCap` (covers the two identical arcade clamps only). Preserve: arcade's single cap gating XP + `capped` flag vs chapter's two independent caps; **Urugal reads the sum outside the tx, clamps inside** — keep that read timing. `sweeps.isPresenceCapHit` (rolling-24h COUNT) genuinely can't share the query.

**P4. Sync currency debit + ledger write** *(medium, medium risk, BP as a new primitive)* → `earning/award.ts` (add `debitPool` beside `creditPool`)
`arcade.ts:246` (`debitCurrency` char/user branches) + `arcade.ts:717` (sell tx). A new sync primitive absorbs all 4 branches. It must **not** be `creditPool` (which opens its own tx, floors at 0, and rewrites rank). Preserve: reject-on-insufficient (param), **no rank recompute / no `recordRankUp`**, run **inside the caller's tx**, no `Math.max(0,…)` floor, emit stays caller-side, reason/metadata as params.

### Group Q — client persistence (`apps/web/src/lib/*`)

**Q1. localStorage + `useSyncExternalStore` toggle store — 3 real copies** *(medium, medium risk, BP with factory)* → `apps/web/src/lib/persistedToggleStore.ts` (new)
`reducedMotion.ts`, `perfMode.ts`, `calmCosmetics.ts` (exclude `dismissedBanners.ts` — different shape). Factory must be configurable: value serde (three-state `'auto'|'on'|'off'` vs `"1"/"0"`), a passed-in `compute()` callback (live media-query re-read vs one-shot hardware verdict vs OR-of-two-stores), per-store root class, module-load side effects (matchMedia listener with Safari `addListener` fallback; `applyRootClass()` after snapshot init), and each copy's typed accessors. `calmCosmetics` exports no `onChange` wrapper.

**Q2. Clamped persisted dimension — 3 copies** *(medium, medium risk, BP with params)* → `apps/web/src/lib/persistedDimension.ts` (new)
`MessagesModal.tsx:205` (clamps out-of-range), `RoomsTree.tsx:38` (rejects → default), `TheaterPanel.tsx:69` (no MAX). Helper needs `{min, max?, default, outOfRange: 'clamp'|'reject', ssrGuard?}`; a naive single clamp changes RoomsTree + imposes a MAX on Theater. Writers are identical.

**Q3. "Return after auth" read/write — 2 copies** *(medium, BP)* → `apps/web/src/lib/pendingDestination.ts` (new)
`ServerPublicLanding.tsx:35/88`, `ForumPublicLanding.tsx:41/329`. Only the storage-key constant differs; keep exporting both key names (`RETURN_SERVER_STORAGE_KEY`/`RETURN_FORUM_STORAGE_KEY`) under existing names so `App.tsx`/`AuthGate` imports don't change. Writer takes `slug,name`.

**Q4. Per-room dismissed-state bypasses `dismissedBanners`** *(low, medium risk, NOT BP)* → leave `App.tsx:5399` as-is
Its value-keyed single-overwrite semantics (topic A→B→A re-shows; one entry per room; survives failed `setItem` in React state) **cannot** be folded into `dismissedBanners`' per-value map without changing behavior + leaking entries. `ProfileEditor.tsx:280` seen-flag maps cleanly but migrating loses the old key value (tour re-shows once). Skip unless intentionally accepted.

### Group R — shell / deploy scripts (`scripts/*.sh` shared includes)

**R1. Hardcoded Node-22 nvm bin path — 5 scripts** *(high, NOT BP wholesale)* → `scripts/node-env.sh` (define `NODE_V22_BIN` only)
`local-deploy.sh:84`, `ship.sh:72`, both `start-detached.sh`, `register-and-promote.sh:11`. Three behaviors: `local-deploy` guards + verbose warning; `ship` guards + **silent** else; the other three export **unconditionally**. Share only the path string; each script keeps its own guard/warning (a single "guarded export" helper would change the 3 unconditional scripts' missing-dir behavior).

**R2. SQLite DB-path env-fallback — ~14 sites** *(high, NOT BP wholesale)* → share the fallback string only
Canonical `db/index.ts:13` (local const). Three resolution bases (script-dir vs `cwd` vs raw dirname) mean one `resolveDbPath()` can't drop in unchanged. `port-border-colors*.mjs` ignore the env entirely (latent bug). Share the default string / a per-side helper (scripts anchored to scripts dir, TS to cwd); converting the two drifted scripts to honor env is a deliberate fix.

**R3. Smoketest BASE URL `http://127.0.0.1:3001` — 8 sites** *(medium, BP)* → `scripts/base-url.mjs` + shell default in `node-env.sh`
`.mjs` import a shared `BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3001"`; the two bash scripts source a shell default. `check-api.mjs` inlines the literal twice (swap both, keep the template). Dev/test-only.

**R4. start/stop-detached duplicated server↔web** *(medium, BP)* → `scripts/detached.sh` (parameterized)
`apps/{server,web}/scripts/{start,stop}-detached.sh`. Parameterize `NAME` + launch command; keep the nvm PATH export, web's `--host 0.0.0.0 --port 5173`, and exact `/tmp/thekeep-<name>.{log,pid}` paths.

**R5. main-branch guard + clean-tree check** *(medium, medium risk, NOT BP wholesale)* → `scripts/git-guards.sh` (predicate only)
`ship.sh:164/225`, `first-deployment.sh:45/55`. Branch-guard messages differ entirely; clean-tree **semantics are opposite** (`first-deployment` aborts on dirty; `ship` uses the same expr to *decide to commit* the dirty tree). Share only a low-level `working_tree_dirty` boolean; callers keep messages/branching.

**R6. flyctl secret existence-check + `--stage`** *(low, BP for the check pair)* → `scripts/fly-secrets.sh`
`first-deployment.sh:91/125` (identical existence checks → `fly_secret_exists`). The stage-set sites differ (`--app` explicit vs default, fatal vs `|| true`, verbose vs quiet) — a `fly_stage_secret` must encode those or leave them. Preserve `grep -qx`; don't fold the volumes check (`awk $3`).

---

## 4. Structural / Organization Improvements

### 4.1 Folder & barrel conventions

**`apps/web/src/components/` (flat, 151 files) → domain folders.** Clear clusters already exist in the categorization's `d` field. Proposed layout (move-only, add barrels):

```
components/
  admin/        Admin*Tab, AdminPanel, admin/AnalyticsTab
  server-admin/ (exists) AnnouncementsTab, EarningTab, …
  earning/      EarningDashboard, EarningRibbon, EarningStatsStrip, RankSigil, CoinAmount
  chat/         MessageList, Composer, RoomsTree, RoomInfoBar, ReactionBar, PollCard,
                Bookmarks/Search/Users/Messages modals, Typing/Connection/…
  forums/       ForumsCatalogModal, ThreadModal, ForumPublicLanding, ForumBanFromProfile
  scriptorium/  Story*, RatingPicker, BookshelfStrip
  worlds/       World*, EntryLinkPicker, ApplicationFormModal
  servers/      Server*, Rules*, ImageCropField, Popular/RoleplayCommunities
  profile/      Profile*, CreateCharacterModal, DisplayPrivacyRow, EditBioModal
  cosmetics/    BorderedAvatar, StyledName, ThemePicker, ProfileFlair*, KeepPanelCorners, Modal, ItemZoomView
  emoticons/    Emoticon*
  moderation/   Ban/Account controls, Staff*, ModCases, UserLookupPicker
  marketing/    Splash*, Feature*, Featured*, Affiliate*, CommunityBoard
  tours/        CoachTour, ContextualTour, DesignerTour, SiteTour
  arcade/       (exists)
  shared/       CloseButton, ErrorBoundary, TabBtn, IconCloseButton, TagInput, RichEditor
```

- Add a barrel (`index.ts`) per folder re-exporting the public components; update imports mechanically. Because the categorization already tags every file with a `d` domain, the mapping is largely deterministic.
- Do the same for `apps/server/src/routes` only lightly — it's already uniform (`registerXRoutes`); prefer a per-domain subfolder for the biggest offenders (`earning`, `forums`, `servers`, `worlds`) once they're split (§4.3).

**Naming consistency to fix (mechanical):**
- Two `formatDurationShort` (shared export vs `AdminEarningTab` local) — rename the local one (`formatCapWindow`) to end the name collision even before consolidation.
- `identityKey` two delimiters (§K2) — one helper.
- `escapeHtml`/`escapeHtmlAttr`/`escapeAttr`/`esc` — standardize on the shared two names (§H1).

### 4.2 Mixed-responsibility modules to unbundle (non-behavioral)

- `ReactionBar.tsx` exports `toggleReaction` → move helper to `apps/web/src/lib/reactions.ts`, keep component re-export.
- `ServerEventsPanel`/`ServerPublicLanding`/`TopCommunitiesPage` export constants → move constants to a `servers/constants.ts`; re-export to avoid import churn.
- `state/store.ts` (1871, god-store): the codebase already split `earning`/`emoticons`/`mentions` into slices — continue the pattern by carving `theater`, `profiles`, `notifications`, and `branding/theme-cache` into sibling slices. This is a **behavior-sensitive** change (selector identity) — do last, with characterization of subscription behavior.

### 4.3 God-file splits by responsibility (non-behavioral extraction)

Split by moving cohesive blocks into sibling modules that the god-file re-imports — no logic change. Priority order and cut lines:

- **`schema.ts` (6740)** → per-domain schema files (`schema/chat.ts`, `schema/earning.ts`, `schema/forums.ts`, …) re-exported from `schema/index.ts`. Zero runtime risk (Drizzle table objects are just data); verify by `drizzle-kit` diff = empty.
- **`broadcast.ts` (3375)** → `broadcast/persistence.ts`, `broadcast/presence.ts` (with §M2–M5 helpers), `broadcast/incognito.ts` (with §M4), keep `broadcast/index.ts` as the emit hub. Guard with socket characterization tests.
- **`MessageList.tsx` (5502)** → extract `messageTime.ts` (§D1/D2), `occupantSelectors.ts` (§K3), `forumTopicAdmin.tsx`, `messageRow.tsx`. Preserve zustand selector identities.
- **`AdminPanel.tsx` (5902)** → it's already a tab host; move each tab body to its own file (many already exist as `Admin*Tab`), extract inline `parseDurationMs` (§C1), clipboard (§N2), `TabBtn` (§N1).
- **`App.tsx` (5570)** → extract the router (`parseForumUrl`/`parseServerUrl`/`spaNav` from §G), the socket-subscription block, and the `useStoredValue`/banner-dismiss store into `lib/`. Keep the shell component thin.
- **`index.ts` server (2803)** → `bootstrap.ts` (Fastify/IO setup), `registerRoutes.ts`, `handshake.ts`, with the two inline socket rate limiters using §M1.
- Route god-files (`earning` 4215, `stories` 3974, `forums` 3020, `servers` 2818, `worlds` 2685, `admin/*`) → split each into `catalog.ts` / `mutations.ts` / `admin.ts` sub-registrars invoked by the existing `registerXRoutes`.

### 4.4 Dead-code candidates to investigate (do not delete blindly — confirm)

- `FeaturedWorldsCarousel.tsx` (683, marked `dead-code-suspect`, "legacy variant" vs `FeaturedWorldCards.tsx`) — confirm no import path before removal.
- `analytics/geo.ts` — documented null-geo stub; keep (it's a wired hook), just annotate.
- `arcadeUrugal.ts` payouts — intentionally phase-gated/logged-only; **not** dead, per memory.
- `dataExport.ts` — new/untracked GDPR export; confirm it's route-registered (two entries in the data show `l:0` and `l:247` — the `l:0` is a stale/empty scan artifact).
- Two `perfMode.ts` entries in the scan are the same file (duplicate scan row) — no action.

---

## 5. Tooling & Guardrails

**Nothing exists today (no ESLint/Prettier).** Introduce without churn:

1. **Prettier (report-only first).** Add `.prettierrc` matching current dominant style (2-space, semicolons, double quotes per the samples). Run `prettier --check` in CI as a **non-blocking** job. Do a **single** repo-wide `prettier --write` commit *after* the god-file splits (§Phase 3) so formatting noise doesn't collide with move diffs; add that commit's SHA to `.git-blame-ignore-revs`.
2. **ESLint (typescript-eslint) staged.** Start with `eslint --max-warnings=Infinity` and a minimal ruleset: `no-unused-vars` (warn), `no-duplicate-imports`, `import/order` (autofix), `@typescript-eslint/consistent-type-imports`. Keep `.js`-extension import convention (the codebase uses explicit `.js` in TS imports — configure `import/extensions` accordingly so the linter doesn't fight it).
3. **`tsc --noEmit` in CI** for all three packages (`apps/server`, `apps/web`, `packages/shared`) — cheapest highest-value guardrail; likely green today given the strict Zod discipline.
4. **"Shared-first" custom lint** (`no-restricted-syntax` / a tiny local rule): forbid re-declaring the canonical helpers once extracted — `jsonOrThrow`, `escapeHtml`, `escapeRegExp`, `identityKey`, `resolveActiveServerId`, `emitToUser`, `startOfUtcDayMs`, `parseLimit`, inline `characterId ? '?characterId='` — flag with a message pointing at the shared module. This is what prevents re-drift, which the mirror-heavy architecture is prone to.
5. **Preserve existing CI grep gates.** The `earning/pool.ts` single-funnel grep gate must keep passing after §P extractions — add the new `debitPool`/`ownsPurchase` to the allowed funnel list.
6. **Rollout mechanics:** land config in Phase 0 as warnings only; ratchet individual rules to `error` per-directory as each domain folder is cleaned, using `overrides` so untouched god-files aren't blocked.

---

## 6. Sequenced Roadmap

Each phase states concrete steps, rough size, risk, and a verification method **proving display/behavior unchanged**.

### Phase 0 — Tooling (no source churn)
- **Steps:** add Prettier config (check-only), ESLint minimal ruleset (warn-only), `tsc --noEmit` CI jobs for all 3 packages, the shared-first lint skeleton (empty allowlist), `.git-blame-ignore-revs`.
- **Size:** S (config only). **Risk:** none (no code changes).
- **Verify:** CI runs green/yellow; `git diff` on source is empty. Baseline the typecheck output.

### Phase 1 — Safe extractions (byte-identical, BP-true findings)
- **Steps:** land the zero-change helpers and their proven-identical call sites: §P1 (`resolveActiveServerId`), §D3 (`startOfUtcDayMs`), §M5 (`onlineUserIds`), §M2 single-user `emitToUser` at the uniform sites, §M4 (incognito predicate), §E1 (`isModeratorRole`), §H1/H4 (the two identical template escapers), §I5 (`escapeRegExp`), §A2 (`withIdentityQuery`), §J1 (`CSP_NONCE`), §O3 (`tagFilter`), §O6 (`dayBucket`), §L1 server-pair + §L3/L4-A/B, §C1 web-clone merge, §R3/R4/R6-check.
- **Size:** M (many small PRs). **Risk:** low.
- **Verify per PR:** (a) `tsc --noEmit` clean; (b) for pure functions, add **characterization tests** that pin current output on a table of inputs *before* extraction, then prove identical after; (c) for server socket/DB helpers, run the existing smoketest scripts (`smoketest*.mjs`) against a local server and diff responses; (d) `git grep` confirms no remaining inline copies (feeds the shared-first allowlist).

### Phase 2 — Duplication consolidation (options-carrying, medium risk)
- **Steps:** §A1 form-A now / form-B opt-in, §B1 `fetchWithTimeout`, §C1/C2 parsers+formatters with options, §D1/D2 time ladders, §H1 full escaper variants, §I1/I2 mention chips, §L2 NBSP-fold, §M2 multi-user + M3, §N1 `TabBtn`, §N2 `useCopyToClipboard`, §N4 `IconCloseButton`, §O2 `escapeLike`, §O4 catalog envelope, §Q1/Q2/Q3 persistence factories, §P2/P3/P4 arcade money helpers, §J2 `createNonceStyleTag`, §K2 client identity helper, §F1 scoped authority.
- **Explicitly deferred / handled-as-bugfix (not "cleanup"):** §K1 titles resolver (correctness fix + tests), §O1 no-floor limit sites, §O5 cursor off-by-one, §I3 CSS scrubber hardening — each shipped as a labeled behavior change with its own review, **not** silently.
- **Size:** L. **Risk:** medium (each item has a "preserve" list in §3).
- **Verify:** characterization tests per helper covering **every** documented divergence (e.g. `formatDurationShort` options matrix, `persistedDimension` clamp-vs-reject, `dailyCap` reason-mode/field matrix); for UI (`TabBtn`, `useCopyToClipboard`, close buttons) do a visual diff / screenshot review of each affected surface; for money paths (§P) add ledger-balance assertions (debit rejects on insufficient, no rank rewrite) and run the arcade flows end-to-end (`/verify`).

### Phase 3 — God-file splits (move-only)
- **Steps:** §4.3 in order: `schema.ts` → `broadcast.ts` → `MessageList.tsx` → `AdminPanel.tsx` → `App.tsx` → server `index.ts` → route god-files. Pure block moves with re-export.
- **Size:** L. **Risk:** medium (import graph, selector identity, tsx-watch mount caveat — restart server to load changes).
- **Verify:** `drizzle-kit` diff empty for schema; `tsc --noEmit` clean; smoketests + socket characterization for `broadcast`; full manual pass of chat feed, admin console, and routing for the tsx/web splits; **then** the one-shot `prettier --write` commit (blame-ignored).

### Phase 4 — Folder reorg + barrels + store slices
- **Steps:** §4.1 domain folders + barrels (mechanical `git mv` + import rewrite), §4.2 store-slice carve, ratchet ESLint rules to `error` per cleaned directory.
- **Size:** M–L (large but mechanical). **Risk:** low for moves, medium for store slices.
- **Verify:** build + `tsc` clean; app boots and every top-nav surface renders (run/screenshot); for store slices, characterize subscription/re-render behavior on the affected components (chat, theater, notifications) before/after.

---

## 7. Risks & Non-Goals

### 7.1 Behavior-looking oddities that are INTENTIONAL — confirm before "fixing"
Per project memory, these must NOT be "cleaned up" as bugs:
- **`/away` hard-mutes all sounds** in `sound.ts` — the gate is by design.
- **Reduce-motion scoping** — fades only when on; keep `force:true`; equipped transitions under reduce-motion are intentional. Don't make `calmCosmetics` global when factoring §Q1.
- **Per-server economy** with deliberate exceptions: **arcade unlocks buy flair on the DEFAULT server** (no serverId) — do NOT "fix" the missing serverId in §P2 (the Eidolon-route per-server scoping vs global is intentional and asymmetric).
- **Targeted-system-message redundancy** — server persists but does NOT emit (client synthesizes); don't dedupe.
- **NBSP name rule** — creation preserves NBSP; §L1/L2 must keep the ASCII-space rejection and NBSP fold, not "normalize" names.
- **Tour copy** — don't touch `HelpGuides`/tour wording; the split is structural only.
- **Two mute tables** (`mutes` vs `account_mutes`), **sessions.ip login-only vs event-time `user_ip_log`**, **IP-ban collateral on shared networks**, **Eidolon daily-chore decay**, **Top Communities synthetic traffic padding** (SENSITIVE) — all deliberate; leave.
- **`ModCasesTab`/server-admin inline fetch shapes** — deliberately NOT sharing `lib/servers.ts` ("do-not-touch"); §A1 homes helpers in `http.ts` to respect this.

### 7.2 Findings that are NOT behavior-preserving (handle as labeled changes, never silent)
§A1 (form-B error text), §C1 (parser semantics), §D1 (ago wording), §I3 (CSS scrub hardening), §I4 (do NOT unify renderers), §K1 (titles resolver ambiguity), §K3 (occupant scan re-render), §O1 (no-floor limits), §O5 (cursor off-by-one), §Q4 (room-banner dismissal), §R1/R2/R5 (script guard behaviors). Each ships in its own reviewed commit with a note that display/flow changes, plus a test pinning the new behavior.

### 7.3 Explicit non-goals
- No feature additions, no UI redesign, no dependency upgrades, no DB migrations (schema split is object-move only).
- No touching the well-factored subsystems (`earning/` funnel, `permissionsCore`, `games/registry`) beyond adding the new shared primitives to their allowlists.
- No repo-wide reformat until Phase 3 completes (avoid colliding with move diffs).
- No consolidation of the **intentional mirrors** (`servers/*` ↔ `admin/*`, `identityTokens` ↔ `mentions`, arcade triplets) into single modules — only shared *scaffolding* is extracted; the twin surfaces remain for their divergent scopes.

### 7.4 Cross-cutting risk controls
- **Selector identity in hot paths** (`MessageList`, `store.ts`, `MessagesModal`) — every zustand-touching change (§K2, §K3, §4.2) needs before/after re-render characterization; comments in these files already warn of React #185.
- **Dev-env caveat** (memory): migrations/better-sqlite3 need nvm Node 22; `tsx watch` misses edits over the `\\wsl.localhost` mount — **restart the server** to load server-code changes during verification.
- **CSP nonce** (memory): runtime `<style>` must stay nonce-stamped via injectors (§J2) — never introduce a React `<style>`; works in dev, breaks on remote.