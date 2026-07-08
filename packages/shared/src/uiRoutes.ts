/**
 * Modal-opening / nav shortcut catalog, the `{token}` syntax used in
 * announcements (banner marquee + scheduled `/announce`) and chat
 * bodies to drop in clickable chips that open a modal or navigate to
 * a page.
 *
 * Examples authors type:
 *   {rules}                          → opens the Rules modal
 *   {modal:earning}                  → opens the Earning dashboard
 *   {modal:earning:items:shop}       → opens Earning → Items → Shop
 *   {scriptorium}                    → navigates to /scriptorium
 *   {scriptorium:latest}             → /scriptorium sorted newest-first
 *   {scriptorium:latest:story}       → opens the newest published story (title shown)
 *   {scriptorium:<slug>}             → opens that specific story (title shown)
 *
 * Adding a new shortcut = appending ONE entry to {@link UI_ROUTES}.
 * Each entry declares its display label, an optional viewer-role
 * gate, an optional author-role gate (admins-only tokens shouldn't be
 * smuggleable into a regular chat line), and a discriminated `target`
 * the client-side handler matches on to call the right modal setter
 * or nav action.
 *
 * Wire points:
 *   - Server: `validateAuthorUiRouteTokens(body, role)` rejects unknown
 *     or unauthorized tokens at save time on every announcement +
 *     chat surface that accepts user-authored text. The token text
 *     stays in the body verbatim so the storage shape is one thing,
 *     the client extracts and renders.
 *   - Client (markdown chat): `parseInline` recognizes `{token}` and
 *     emits a `UiRouteChip` node.
 *   - Client (HTML announcements): a post-sanitize string replace
 *     swaps `{token}` for `<a data-tk-ui-route="token">label</a>` so
 *     the banner / scheduled-announce bodies render the chip too.
 *   - Client (handler): a single delegated `tk:open-ui-route` event
 *     bubbles up to the Chat shell, which matches on the entry's
 *     `target.kind` and calls the existing modal setter.
 */

import type { Role } from "./profile.js";
import { roleRank } from "./profile.js";
import { ARCADE_GAMES, type ArcadeGameKey } from "./arcade.js";
import { escapeHtml, escapeHtmlAttr } from "./html.js";

/** Earning dashboard tabs, mirrors the `EarningOpenSpec` in apps/web. */
export type UiRouteEarningTab =
  | "overview"
  | "ledger"
  | "styles"
  | "borders"
  | "cosmetics"
  | "items"
  | "rankings"
  | "settings";
/** Items sub-tabs, mirrors `EarningOpenSpec.itemSubTab`. */
export type UiRouteItemSubTab = "inventory" | "shop" | "collection" | "pets";
/**
 * Earning ranking leaderboards a `{ranking:<board>}` chip can deep-link
 * to. Mirrors the server's `RankingBoardKey` (apps/server earning/
 * rankings.ts); kept as its own type here because shared can't import
 * from the server. When the chip opens, the Rankings tab scrolls to +
 * highlights this board's section.
 */
export type UiRouteRankingBoard =
  | "currency"
  | "xp"
  | "rank"
  | "items"
  | "messages"
  | "borders"
  | "styles"
  | "topics"
  | "reactions";

/**
 * Discriminated target the runtime handler dispatches on. New action
 * surfaces drop in a new kind here; the client's `tk:open-ui-route`
 * listener narrows on `kind` and calls the appropriate setter.
 */
export type UiRouteTarget =
  | { kind: "modal-earning"; tab?: UiRouteEarningTab; itemSubTab?: UiRouteItemSubTab; board?: UiRouteRankingBoard }
  | { kind: "modal-rules" }
  | { kind: "modal-messages" }
  | { kind: "modal-worlds" }
  | { kind: "modal-help" }
  | { kind: "modal-profile-own" }
  | { kind: "modal-admin"; tab?: string }
  | { kind: "nav-scriptorium"; sort?: "latest" }
  /**
   * DYNAMIC chip, the catalog entry's static label is the fallback
   * shown before / when the lookup fails; the chip's actual label
   * AND the click target both resolve at render time from the
   * `/stories/splash?limit=1` endpoint via the shared
   * `fetchLatestPublishedStory` helper. The renderer special-cases
   * this kind to render a fetching React component on chat surfaces
   * and to emit a `data-tk-ui-route-dynamic="latest-story"` marker on
   * HTML surfaces (banner marquee + scheduled-announce bodies) that
   * a hydration helper post-processes into the resolved title.
   */
  | { kind: "nav-scriptorium-latest-story" }
  /**
   * DYNAMIC member-spotlight chip. Resolves a member at render/click
   * time from `GET /members/spotlight?scope&pick` (public, non-NSFW
   * pool only), then opens that profile. `pick:'latest'` chips show the
   * resolved member's name as the label (newest registered); `random`
   * chips keep a static label and re-roll on every click. `scope:'user'`
   * resolves the master account; `'character'` a character.
   */
  | { kind: "open-member"; pick: "latest" | "random"; scope: "user" | "character" }
  /** Open the Spire Arcade launcher (a list of games). The dispatcher
   *  checks the `use_arcade` permission at click time and shows a
   *  notice if the viewer lacks it. */
  | { kind: "open-arcade" }
  /** Open a specific arcade game directly (e.g. the Eidolon Tamer
   *  window). `game` is a key from the shared ARCADE_GAMES registry;
   *  the dispatcher checks `use_arcade` + that game's permission, then
   *  opens its window (which handles the per-player unlock gate). */
  | { kind: "open-arcade-game"; game: ArcadeGameKey }
  /**
   * PARAMETRIC: open a SPECIFIC world's viewer by slug (or id). The
   * token is `{world:<slug>}` — NOT a static catalog row; it's
   * synthesized by `resolveUiRoute`'s parametric fallback. The chip
   * label hydrates to the world's real name at render time and is
   * visibility-gated: a private world the viewer can't see resolves to
   * no label, so the chip falls back to literal text. Dispatcher opens
   * it via `setWorldViewerId(ref)` (the viewer accepts id or slug).
   */
  | { kind: "open-world"; ref: string }
  /**
   * PARAMETRIC: navigate to a SPECIFIC chat room by slug. Token
   * `{room:<slug>}`. Like `open-world`: synthesized, name-hydrated, and
   * access-gated at resolve time (a private room a non-member can't see
   * resolves to no label). Dispatcher joins it via the room:join path.
   */
  | { kind: "nav-room"; ref: string }
  /**
   * PARAMETRIC: open a SPECIFIC Scriptorium story by slug (or id) in
   * the reader. Token `{scriptorium:<slug>}`. Like `open-world` /
   * `nav-room`: synthesized (not a static catalog row), title-hydrated
   * at render time, and access-gated at resolve time (a private story
   * the viewer can't see resolves to no label, so the chip falls back
   * to literal text). Dispatcher pops the StoryReader via the resolved
   * id. The static `{scriptorium}` / `{scriptorium:latest}` /
   * `{scriptorium:latest:story}` rows resolve from the catalog first,
   * so only an actual story slug reaches this parametric fallback.
   */
  | { kind: "open-story"; ref: string };

export interface UiRoute {
  /** Canonical token (lowercase, colon-delimited). Matches what the
   *  parser extracts. */
  token: string;
  /** Short user-facing label rendered on the chip. */
  label: string;
  /** Optional emoji/glyph rendered before the label. */
  icon?: string;
  /** Admin-facing description for help / picker UIs. */
  description: string;
  /** Minimum role required to AUTHOR this token (default: anyone). A
   *  regular `/say` that tries to embed an admin-only token fails
   *  server-side validation rather than silently strip the chip. */
  authorRole?: Role;
  /** Minimum role required to SEE the rendered chip (default:
   *  anyone). Lets the catalog include admin-only shortcuts in
   *  scheduled announcements without showing them to non-admin
   *  viewers, the chip simply doesn't render for them. */
  viewerRole?: Role;
  /** What the runtime handler does when the chip is clicked. */
  target: UiRouteTarget;
}

/**
 * The catalog itself. Add new routes here, every other surface
 * (parser, validator, renderer, dispatcher) picks them up
 * automatically. Token strings MUST be lowercase + use the
 * `[a-z][a-z0-9-]*(?::[a-z0-9-]+)*` shape; the parser regex won't
 * recognize anything else.
 */
/**
 * Catalog of every recognized `{token}`. Naming convention:
 *   - Bare token = the most natural thing to type (`{rules}`,
 *     `{shop}`, `{earning}`). Aliases live here too so the common
 *     plural / colloquial form ("earnings") works alongside the
 *     canonical ("earning") without the author having to know
 *     which is "the right one."
 *   - Colon-delimited segments = drilling INTO a surface
 *     (`{earning:items:shop}`, `{scriptorium:latest}`). Reads like
 *     a breadcrumb.
 *
 * Adding a new shortcut = append one entry. Every other surface
 * (parser, validator, both renderers, dispatcher) picks it up.
 */
export const UI_ROUTES: ReadonlyArray<UiRoute> = [
  // ----- Top-level pages / sitewide chrome -----
  // `icon` is a lucide-react icon NAME (PascalCase). The web side maps it
  // to a component (lib/uiRouteIcons); the HTML announcement path emits a
  // placeholder the same map hydrates. Unknown names render no glyph.
  { token: "rules", label: "Rules", icon: "Scroll", description: "Open the site rules modal.", target: { kind: "modal-rules" } },
  { token: "help", label: "Help", icon: "HelpCircle", description: "Open the chat help modal.", target: { kind: "modal-help" } },
  { token: "messages", label: "Messages", icon: "MessageSquare", description: "Open your Direct Messenger.", target: { kind: "modal-messages" } },
  { token: "dms", label: "DMs", icon: "MessageSquare", description: "Open your Direct Messenger.", target: { kind: "modal-messages" } },
  { token: "worlds", label: "Worlds", icon: "Globe", description: "Open the worlds catalog.", target: { kind: "modal-worlds" } },
  { token: "profile", label: "My profile", icon: "UserCircle", description: "Open your own profile editor.", target: { kind: "modal-profile-own" } },

  // ----- Earning dashboard + tabs (bare + common-plural alias) -----
  { token: "earning", label: "Earning", icon: "Award", description: "Open the Earning dashboard.", target: { kind: "modal-earning" } },
  { token: "earnings", label: "Earnings", icon: "Award", description: "Open the Earning dashboard.", target: { kind: "modal-earning" } },
  { token: "earning:overview", label: "Earning overview", icon: "LayoutDashboard", description: "Open Earning → Overview.", target: { kind: "modal-earning", tab: "overview" } },
  { token: "earning:ledger", label: "Earning ledger", icon: "NotebookText", description: "Open Earning → Ledger.", target: { kind: "modal-earning", tab: "ledger" } },
  { token: "earning:styles", label: "Name styles", icon: "Type", description: "Open Earning → Name Styles.", target: { kind: "modal-earning", tab: "styles" } },
  { token: "earning:borders", label: "Borders", icon: "Frame", description: "Open Earning → Borders.", target: { kind: "modal-earning", tab: "borders" } },
  { token: "earning:cosmetics", label: "Cosmetics", icon: "Palette", description: "Open Earning → Cosmetics.", target: { kind: "modal-earning", tab: "cosmetics" } },
  { token: "earning:settings", label: "Earning settings", icon: "Settings", description: "Open Earning → Settings.", target: { kind: "modal-earning", tab: "settings" } },

  // ----- Items sub-tabs (bare + nested forms; the bare forms read more
  //                       naturally inline, "check out the {shop}!") -----
  { token: "items", label: "Items", icon: "Package", description: "Open Earning → Items.", target: { kind: "modal-earning", tab: "items" } },
  { token: "earning:items", label: "Items", icon: "Package", description: "Open Earning → Items.", target: { kind: "modal-earning", tab: "items" } },
  { token: "earnings:items", label: "Items", icon: "Package", description: "Open Earning → Items.", target: { kind: "modal-earning", tab: "items" } },

  { token: "inventory", label: "Inventory", icon: "Backpack", description: "Open Items → Inventory.", target: { kind: "modal-earning", tab: "items", itemSubTab: "inventory" } },
  { token: "earning:items:inventory", label: "Inventory", icon: "Backpack", description: "Open Items → Inventory.", target: { kind: "modal-earning", tab: "items", itemSubTab: "inventory" } },
  { token: "earnings:items:inventory", label: "Inventory", icon: "Backpack", description: "Open Items → Inventory.", target: { kind: "modal-earning", tab: "items", itemSubTab: "inventory" } },

  { token: "shop", label: "Shop", icon: "ShoppingCart", description: "Open Items → Shop.", target: { kind: "modal-earning", tab: "items", itemSubTab: "shop" } },
  { token: "earning:items:shop", label: "Shop", icon: "ShoppingCart", description: "Open Items → Shop.", target: { kind: "modal-earning", tab: "items", itemSubTab: "shop" } },
  { token: "earnings:items:shop", label: "Shop", icon: "ShoppingCart", description: "Open Items → Shop.", target: { kind: "modal-earning", tab: "items", itemSubTab: "shop" } },

  { token: "collection", label: "Collection", icon: "Boxes", description: "Open Items → Collection.", target: { kind: "modal-earning", tab: "items", itemSubTab: "collection" } },
  { token: "earning:items:collection", label: "Collection", icon: "Boxes", description: "Open Items → Collection.", target: { kind: "modal-earning", tab: "items", itemSubTab: "collection" } },
  { token: "earnings:items:collection", label: "Collection", icon: "Boxes", description: "Open Items → Collection.", target: { kind: "modal-earning", tab: "items", itemSubTab: "collection" } },

  { token: "pets", label: "Pets", icon: "PawPrint", description: "Open Items → Pets.", target: { kind: "modal-earning", tab: "items", itemSubTab: "pets" } },
  { token: "earning:items:pets", label: "Pets", icon: "PawPrint", description: "Open Items → Pets.", target: { kind: "modal-earning", tab: "items", itemSubTab: "pets" } },
  { token: "earnings:items:pets", label: "Pets", icon: "PawPrint", description: "Open Items → Pets.", target: { kind: "modal-earning", tab: "items", itemSubTab: "pets" } },

  // ----- Scriptorium routes (full-page nav, not modals) -----
  { token: "scriptorium", label: "Scriptorium", icon: "Library", description: "Open the Scriptorium catalog.", target: { kind: "nav-scriptorium" } },
  { token: "scriptorium:latest", label: "Latest in Scriptorium", icon: "BookOpen", description: "Open the Scriptorium catalog sorted newest first.", target: { kind: "nav-scriptorium", sort: "latest" } },
  // DYNAMIC: chip label + click target resolve at render time from
  // the latest published story. The static `label` here is the
  // skeleton shown while the fetch is in flight (and the fallback
  // when nothing is published yet).
  { token: "scriptorium:latest:story", label: "Latest story", icon: "BookOpen", description: "Open the most recently published story in the Scriptorium.", target: { kind: "nav-scriptorium-latest-story" } },

  // ----- Earning rankings (Rankings tab + per-board deep links) -----
  // The bare {rankings} opens the tab; each {ranking:<board>} is a
  // DYNAMIC chip whose label surfaces that board's current #1 (resolved
  // at render time) and which scrolls the Rankings tab to that board.
  { token: "rankings", label: "Rankings", icon: "Trophy", description: "Open Earning → Rankings.", target: { kind: "modal-earning", tab: "rankings" } },
  { token: "earning:rankings", label: "Rankings", icon: "Trophy", description: "Open Earning → Rankings.", target: { kind: "modal-earning", tab: "rankings" } },
  { token: "earnings:rankings", label: "Rankings", icon: "Trophy", description: "Open Earning → Rankings.", target: { kind: "modal-earning", tab: "rankings" } },
  { token: "ranking:currency", label: "Wealthiest", icon: "Coins", description: "Top of the Wealthiest (Currency) leaderboard.", target: { kind: "modal-earning", tab: "rankings", board: "currency" } },
  { token: "ranking:xp", label: "Most XP", icon: "Sparkles", description: "Top of the Most XP leaderboard.", target: { kind: "modal-earning", tab: "rankings", board: "xp" } },
  { token: "ranking:rank", label: "Highest Rank", icon: "Medal", description: "Top of the Highest Rank leaderboard.", target: { kind: "modal-earning", tab: "rankings", board: "rank" } },
  { token: "ranking:items", label: "Most Items", icon: "Package", description: "Top of the Most Items leaderboard.", target: { kind: "modal-earning", tab: "rankings", board: "items" } },
  { token: "ranking:messages", label: "Most Talkative", icon: "MessageSquare", description: "Top of the Most Talkative (Messages) leaderboard.", target: { kind: "modal-earning", tab: "rankings", board: "messages" } },
  { token: "ranking:borders", label: "Most Borders", icon: "Frame", description: "Top of the Most Borders leaderboard.", target: { kind: "modal-earning", tab: "rankings", board: "borders" } },
  { token: "ranking:styles", label: "Most Styles", icon: "Type", description: "Top of the Most Styles leaderboard.", target: { kind: "modal-earning", tab: "rankings", board: "styles" } },
  { token: "ranking:topics", label: "Forum Founders", icon: "Pin", description: "Top of the Forum Founders (Topics) leaderboard.", target: { kind: "modal-earning", tab: "rankings", board: "topics" } },
  { token: "ranking:reactions", label: "Reactor", icon: "Heart", description: "Top of the Reactor (Reactions) leaderboard.", target: { kind: "modal-earning", tab: "rankings", board: "reactions" } },

  // ----- Member spotlight (dynamic; opens a profile) -----
  { token: "users:latest", label: "Newest member", icon: "UserPlus", description: "Open the most recently joined member's profile.", target: { kind: "open-member", pick: "latest", scope: "user" } },
  { token: "users:random", label: "Random member", icon: "Dices", description: "Open a random member's profile.", target: { kind: "open-member", pick: "random", scope: "user" } },
  { token: "users:character:latest", label: "Newest character", icon: "UserPlus", description: "Open the most recently created character's profile.", target: { kind: "open-member", pick: "latest", scope: "character" } },
  { token: "users:character:random", label: "Random character", icon: "Dices", description: "Open a random character's profile.", target: { kind: "open-member", pick: "random", scope: "character" } },

  // ----- Spire Arcade -----
  { token: "arcade", label: "Spire Arcade", icon: "Gamepad2", description: "Open the Spire Arcade.", target: { kind: "open-arcade" } },
  // One {arcade:<key>} chip per registered game — generated from the
  // shared ARCADE_GAMES registry so a new game lights up everywhere
  // (catalog, both renderers, validator, Help) from one registry entry.
  ...ARCADE_GAMES.map((g): UiRoute => ({
    token: `arcade:${g.key}`,
    label: g.label,
    icon: g.icon,
    description: g.description,
    target: { kind: "open-arcade-game", game: g.key },
  })),

  // ----- Admin / staff (author-gated; viewer-gated mirrors the admin-panel posture) -----
  { token: "admin", label: "Admin panel", icon: "Shield", description: "Open the admin panel.", authorRole: "admin", viewerRole: "mod", target: { kind: "modal-admin" } },
  { token: "admin:announcements", label: "Admin · Announcements", icon: "Megaphone", description: "Open the admin Announcements tab.", authorRole: "admin", viewerRole: "mod", target: { kind: "modal-admin", tab: "announcements" } },
];

/** Build-time lookup by token. */
const UI_ROUTES_BY_TOKEN = new Map<string, UiRoute>(
  UI_ROUTES.map((r) => [r.token.toLowerCase(), r]),
);

/**
 * PARAMETRIC tokens: `{world:<slug>}` and `{room:<slug>}` reference a
 * SPECIFIC entity, so they can't be enumerated in the static catalog.
 * They're synthesized on the fly with a skeleton label ("World"/"Room")
 * that the dynamic-label pass swaps for the entity's real name. The
 * slug ref is everything after the first colon (slugs never contain
 * colons, so multi-segment refs just defensively re-join).
 */
function synthesizeParametricRoute(prefix: string, ref: string): UiRoute | null {
  if (!ref) return null;
  if (prefix === "world") {
    return {
      token: `world:${ref}`,
      label: "World",
      icon: "Globe",
      description: `Open the world "${ref}".`,
      target: { kind: "open-world", ref },
    };
  }
  if (prefix === "room") {
    return {
      token: `room:${ref}`,
      label: "Room",
      icon: "DoorOpen",
      description: `Go to the room "${ref}".`,
      target: { kind: "nav-room", ref },
    };
  }
  if (prefix === "scriptorium") {
    return {
      token: `scriptorium:${ref}`,
      label: "Story",
      icon: "BookOpen",
      description: `Open the story "${ref}" in the Scriptorium.`,
      target: { kind: "open-story", ref },
    };
  }
  return null;
}

/**
 * Resolve a token (case-insensitive). Returns null when unknown. Tries
 * the static catalog first, then the parametric `{world:…}`/`{room:…}`
 * fallback. Parametric routes carry no author/viewer role gate here —
 * access is enforced at resolve time (a private world/room a viewer
 * can't see hydrates to no label and the chip degrades to plain text).
 */
export function resolveUiRoute(token: string): UiRoute | null {
  const lc = token.toLowerCase();
  const exact = UI_ROUTES_BY_TOKEN.get(lc);
  if (exact) return exact;
  const colon = lc.indexOf(":");
  if (colon > 0) {
    return synthesizeParametricRoute(lc.slice(0, colon), lc.slice(colon + 1));
  }
  return null;
}

/**
 * Pattern that matches a UI-route token in a body. Public so the
 * renderer can use the same regex to tokenize. The capture is the
 * inside-of-braces text. The token shape mirrors the catalog
 * registration: start with a letter, then letters/digits/hyphens,
 * with optional `:segment` parts of the same alphabet.
 */
export const UI_ROUTE_TOKEN_RE = /\{([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)\}/gi;

/**
 * Extract every UI-route token from a body. Used by the save-time
 * validator and by render-time chip extraction. Tokens are returned
 * in document order; duplicates are preserved so each occurrence
 * gets validated independently.
 */
export function findUiRouteTokens(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(UI_ROUTE_TOKEN_RE)) {
    out.push(m[1]!.toLowerCase());
  }
  return out;
}

export interface UiRouteValidationFailure {
  ok: false;
  token: string;
  reason: string;
}
export interface UiRouteValidationSuccess {
  ok: true;
}
export type UiRouteValidationResult = UiRouteValidationFailure | UiRouteValidationSuccess;

/**
 * Save-time guard for user-authored bodies. Walks every `{token}`
 * occurrence and rejects on the first KNOWN token whose author-role
 * gate the caller doesn't clear, so a regular user can't smuggle
 * `{modal:admin}` into a chat line and have the chip render for
 * mods downstream.
 *
 * Unknown tokens (anything matching the regex shape but not in the
 * catalog) pass through silently and render as plain literal
 * `{whatever}` text. That preserves backwards compatibility with
 * curly-brace usage in roleplay ("{nervously}", "{stage
 * direction}") that predates this feature and shouldn't suddenly
 * start rejecting saves. The editor's live preview is the feedback
 * channel for "did my token resolve?", if no chip renders, the
 * token didn't match the catalog.
 *
 * Pure: no DB or HTTP, just regex + catalog lookup + role-rank
 * comparison.
 */
export function validateAuthorUiRouteTokens(
  body: string,
  authorRole: Role,
): UiRouteValidationResult {
  const authorRank = roleRank(authorRole);
  for (const token of findUiRouteTokens(body)) {
    const entry = resolveUiRoute(token);
    if (!entry) continue; // unknown, treat as literal text
    if (entry.authorRole && authorRank < roleRank(entry.authorRole)) {
      return {
        ok: false,
        token,
        reason: `Authoring {${token}} requires the ${entry.authorRole} role or higher.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Viewer-side gate. Returns true when the viewer's role meets the
 * entry's `viewerRole` threshold (or no threshold was declared).
 * Used by the renderer to hide chips a viewer shouldn't see, the
 * raw `{token}` text falls back as plain text in that case so a
 * scheduled announcement targeted at mods doesn't reveal admin
 * tooling to a regular user.
 */
export function canViewerSeeUiRoute(entry: UiRoute, viewerRole: Role | null): boolean {
  if (!entry.viewerRole) return true;
  if (!viewerRole) return false;
  return roleRank(viewerRole) >= roleRank(entry.viewerRole);
}

/**
 * Author-side gate: can a user of `role` put this token in a message /
 * announcement? Mirrors the `authorRole` half of
 * {@link validateAuthorUiRouteTokens}, exposed on its own so the Help
 * modal can show each viewer ONLY the tags they're actually allowed to
 * use (a regular user never sees `{admin}` in the reference). Tokens
 * with no `authorRole` are usable by everyone, including logged-out.
 */
export function canViewerAuthorUiRoute(entry: UiRoute, viewerRole: Role | null): boolean {
  if (!entry.authorRole) return true;
  if (!viewerRole) return false;
  return roleRank(viewerRole) >= roleRank(entry.authorRole);
}

/**
 * Split a body into alternating text + token segments, the building
 * block both the markdown chat renderer and the HTML-body
 * post-processor share. Each token segment carries the original
 * lowercase token; consumers resolve via {@link resolveUiRoute}.
 */
export type UiRouteSegment =
  | { kind: "text"; raw: string }
  | { kind: "token"; token: string; raw: string };

export function splitOnUiRouteTokens(body: string): UiRouteSegment[] {
  if (!body.includes("{")) return [{ kind: "text", raw: body }];
  const out: UiRouteSegment[] = [];
  let lastIdx = 0;
  // Local regex copy so `matchAll`'s shared state doesn't trip a
  // re-enter from a different caller in the same tick.
  const re = new RegExp(UI_ROUTE_TOKEN_RE.source, UI_ROUTE_TOKEN_RE.flags);
  for (const m of body.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > lastIdx) out.push({ kind: "text", raw: body.slice(lastIdx, idx) });
    out.push({ kind: "token", token: m[1]!.toLowerCase(), raw: m[0]! });
    lastIdx = idx + m[0]!.length;
  }
  if (lastIdx < body.length) out.push({ kind: "text", raw: body.slice(lastIdx) });
  return out;
}

/**
 * Post-process server-sanitized HTML to swap every recognized
 * `{token}` text occurrence for an interactive `<button>` chip. Used
 * by the BannerMarquee + the announce-kind renderer's `bodyHtml`
 * branch, both surfaces render trusted HTML and would otherwise
 * leave the token as literal `{rules}` text inside a `<p>`.
 *
 * The chip carries `data-tk-ui-route="<token>"`; a delegated click
 * listener on the host container reads it and calls `openUiRoute`.
 * Unknown tokens (typos, catalog mismatches) are left alone so the
 * raw text passes through.
 *
 * Pure string transform. Idempotent: re-running won't double-wrap
 * because the regex only matches bare `{token}` text, not the
 * already-rendered `<button>` markup.
 */
/**
 * Marker tag for the post-mount hydration helper. A chip whose target
 * resolves dynamically (e.g. "latest published story", title only
 * known at render time) gets stamped with this attribute so the
 * helper can scan, fetch the resolved label, and rewrite the chip's
 * `.tk-ui-route-chip-label` span in place. Static targets return
 * null → no marker, no hydration, the static label stays as-is.
 */
export function dynamicMarkerFor(entry: UiRoute): string | null {
  const t = entry.target;
  switch (t.kind) {
    case "nav-scriptorium-latest-story":
      return "latest-story";
    // Member-spotlight: only the `latest` picks resolve to a stable
    // name worth showing as the label. `random` re-rolls each click, so
    // it keeps its static "Random member" label (no marker, no hydrate).
    case "open-member":
      return t.pick === "latest" ? "member" : null;
    // Ranking deep-links surface the board's current #1 as the label.
    // The bare {rankings} (no board) is static.
    case "modal-earning":
      return t.board ? "ranking" : null;
    // Parametric world/room chips hydrate their skeleton label
    // ("World"/"Room") into the entity's actual name, and the resolve
    // doubles as the visibility gate (no access → no label).
    case "open-world":
      return "world";
    case "nav-room":
      return "room";
    case "open-story":
      return "story";
    default:
      return null;
  }
}

export function renderUiRouteChipsInHtml(html: string): string {
  if (!html.includes("{")) return html;
  return html.replace(UI_ROUTE_TOKEN_RE, (raw, capturedToken: string) => {
    const token = capturedToken.toLowerCase();
    const entry = resolveUiRoute(token);
    if (!entry) return raw;
    const safeToken = escapeHtmlAttr(token);
    const safeLabel = escapeHtml(entry.label);
    // Icon is a lucide NAME, not a glyph. Emit an empty placeholder span
    // carrying the name; the client hydrator (hydrateDynamicUiRouteChips)
    // mounts the matching lucide SVG into it after mount. Surfaces that
    // never run the hydrator just show a label-only chip (graceful, no
    // broken glyph).
    //
    // `inline-flex items-center` makes the span center the mounted SVG
    // itself, instead of letting it ride the text baseline (which left the
    // glyph visibly high in the marquee). No trailing space — the button's
    // `gap-1` already spaces the icon from the label.
    const safeIcon = entry.icon
      ? `<span class="tk-ui-route-chip-icon inline-flex items-center" data-tk-ui-route-icon="${escapeHtmlAttr(entry.icon)}" aria-hidden="true"></span>`
      : "";
    const safeTitle = escapeHtmlAttr(entry.description);
    // Dynamic-resolved chips (e.g. {scriptorium:latest:story}) carry a
    // `data-tk-ui-route-dynamic="<marker>"` attribute that the
    // post-sanitize hydration pass keys on. The static `safeLabel`
    // above is the pre-resolve skeleton; the hydrator swaps it via
    // the `.tk-ui-route-chip-label` span.
    const dynamicMarker = dynamicMarkerFor(entry);
    const dynamicAttr = dynamicMarker
      ? ` data-tk-ui-route-dynamic="${escapeHtmlAttr(dynamicMarker)}"`
      : "";
    return (
      `<button type="button" data-tk-ui-route="${safeToken}"${dynamicAttr} title="${safeTitle}" aria-label="${safeTitle}"` +
      // Chip size matches the surrounding text (`text-[1em]`) instead
      // of the previous 0.85em shrink, at chat-line scale the
      // smaller pill read as a footnote, and inside the marquee
      // (text-sm wrapper) it looked visibly under-scaled next to
      // the rest of the body. Em-relative so a future surface that
      // sets a different base font (e.g. an `<h2>`-sized scheduled
      // announce) also gets a proportionally-sized chip.
      // Spacing posture: `mx-1.5` keeps the chip from kissing the
      // adjacent text, the previous `mx-0.5` left the bracketed
      // body wrapping the chip with no visual breathing room.
      // `px-1` trims the internal padding back from the pill
      // pre-bump so the chip doesn't read as oversized vs.
      // surrounding glyphs now that it inherits the body's full
      // font size.
      ` class="tk-ui-route-chip mx-1.5 inline-flex items-center gap-1 rounded border border-keep-action/50 bg-keep-action/10 px-1 py-0 align-baseline text-[1em] text-keep-action transition hover:border-keep-action hover:bg-keep-action/20">` +
      `${safeIcon}<span class="tk-ui-route-chip-label">${safeLabel}</span></button>`
    );
  });
}

/* ============================================================
 *  Help reference (Help modal → "Navigation tags" guide)
 * ============================================================ */

/**
 * Curated grouping for the Help modal's tag reference. Each group lists
 * the CANONICAL token per destination (aliases like `earnings` /
 * `earning:items` are intentionally omitted so the reference stays
 * scannable). Tokens are resolved through the live catalog at build
 * time, so a renamed/removed entry simply drops out instead of showing
 * stale docs — the curation can never silently lie about what works.
 *
 * The parametric `{world:<slug>}` / `{room:<slug>}` tags are NOT here
 * (they take an argument, not a fixed token); the guide documents them
 * with hand-written examples.
 */
export const UI_ROUTE_HELP_GROUPS: ReadonlyArray<{ label: string; tokens: ReadonlyArray<string> }> = [
  { label: "Pages & menus", tokens: ["rules", "help", "messages", "worlds", "profile"] },
  { label: "Earning", tokens: ["earning", "earning:ledger", "earning:styles", "earning:borders", "earning:cosmetics", "earning:settings"] },
  { label: "Items", tokens: ["items", "shop", "inventory", "collection", "pets"] },
  { label: "Scriptorium", tokens: ["scriptorium", "scriptorium:latest", "scriptorium:latest:story"] },
  { label: "Rankings", tokens: ["rankings", "ranking:currency", "ranking:xp", "ranking:rank", "ranking:items", "ranking:messages", "ranking:borders", "ranking:styles", "ranking:topics", "ranking:reactions"] },
  { label: "Members", tokens: ["users:latest", "users:random", "users:character:latest", "users:character:random"] },
  { label: "Arcade", tokens: ["arcade", ...ARCADE_GAMES.map((g) => `arcade:${g.key}`)] },
  { label: "Staff", tokens: ["admin", "admin:announcements"] },
];

export interface UiRouteHelpEntry {
  token: string;
  label: string;
  icon?: string;
  description: string;
}
export interface UiRouteHelpGroup {
  label: string;
  entries: UiRouteHelpEntry[];
}

/**
 * Build the Help-modal tag reference for a viewer of `viewerRole`:
 * resolves each curated token through the catalog, drops anything the
 * viewer isn't allowed to AUTHOR (so a regular user never sees the staff
 * tags), and omits now-empty groups. Pure — the React guide just maps
 * over the result.
 */
export function buildUiRouteHelp(viewerRole: Role | null): UiRouteHelpGroup[] {
  const out: UiRouteHelpGroup[] = [];
  for (const group of UI_ROUTE_HELP_GROUPS) {
    const entries: UiRouteHelpEntry[] = [];
    for (const token of group.tokens) {
      const entry = resolveUiRoute(token);
      if (!entry) continue;
      if (!canViewerAuthorUiRoute(entry, viewerRole)) continue;
      entries.push({
        token: entry.token,
        label: entry.label,
        ...(entry.icon ? { icon: entry.icon } : {}),
        description: entry.description,
      });
    }
    if (entries.length) out.push({ label: group.label, entries });
  }
  return out;
}
