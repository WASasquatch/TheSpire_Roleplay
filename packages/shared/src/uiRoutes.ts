/**
 * Modal-opening / nav shortcut catalog — the `{token}` syntax used in
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
 *     stays in the body verbatim so the storage shape is one thing —
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

/** Earning dashboard tabs — mirrors the `EarningOpenSpec` in apps/web. */
export type UiRouteEarningTab =
  | "overview"
  | "ledger"
  | "styles"
  | "borders"
  | "cosmetics"
  | "items"
  | "settings";
/** Items sub-tabs — mirrors `EarningOpenSpec.itemSubTab`. */
export type UiRouteItemSubTab = "inventory" | "shop" | "collection" | "pets";

/**
 * Discriminated target the runtime handler dispatches on. New action
 * surfaces drop in a new kind here; the client's `tk:open-ui-route`
 * listener narrows on `kind` and calls the appropriate setter.
 */
export type UiRouteTarget =
  | { kind: "modal-earning"; tab?: UiRouteEarningTab; itemSubTab?: UiRouteItemSubTab }
  | { kind: "modal-rules" }
  | { kind: "modal-messages" }
  | { kind: "modal-worlds" }
  | { kind: "modal-help" }
  | { kind: "modal-profile-own" }
  | { kind: "modal-admin"; tab?: string }
  | { kind: "nav-scriptorium"; sort?: "latest" };

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
   *  viewers — the chip simply doesn't render for them. */
  viewerRole?: Role;
  /** What the runtime handler does when the chip is clicked. */
  target: UiRouteTarget;
}

/**
 * The catalog itself. Add new routes here — every other surface
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
  { token: "rules", label: "Rules", icon: "📜", description: "Open the site rules modal.", target: { kind: "modal-rules" } },
  { token: "help", label: "Help", icon: "❓", description: "Open the chat help modal.", target: { kind: "modal-help" } },
  { token: "messages", label: "Messages", icon: "💬", description: "Open your Direct Messenger.", target: { kind: "modal-messages" } },
  { token: "dms", label: "DMs", icon: "💬", description: "Open your Direct Messenger.", target: { kind: "modal-messages" } },
  { token: "worlds", label: "Worlds", icon: "🌍", description: "Open the worlds catalog.", target: { kind: "modal-worlds" } },
  { token: "profile", label: "My profile", icon: "🪞", description: "Open your own profile editor.", target: { kind: "modal-profile-own" } },

  // ----- Earning dashboard + tabs (bare + common-plural alias) -----
  { token: "earning", label: "Earning", icon: "🎖", description: "Open the Earning dashboard.", target: { kind: "modal-earning" } },
  { token: "earnings", label: "Earnings", icon: "🎖", description: "Open the Earning dashboard.", target: { kind: "modal-earning" } },
  { token: "earning:overview", label: "Earning overview", icon: "🎖", description: "Open Earning → Overview.", target: { kind: "modal-earning", tab: "overview" } },
  { token: "earning:ledger", label: "Earning ledger", icon: "📒", description: "Open Earning → Ledger.", target: { kind: "modal-earning", tab: "ledger" } },
  { token: "earning:styles", label: "Name styles", icon: "🅰️", description: "Open Earning → Name Styles.", target: { kind: "modal-earning", tab: "styles" } },
  { token: "earning:borders", label: "Borders", icon: "🖼", description: "Open Earning → Borders.", target: { kind: "modal-earning", tab: "borders" } },
  { token: "earning:cosmetics", label: "Cosmetics", icon: "🎨", description: "Open Earning → Cosmetics.", target: { kind: "modal-earning", tab: "cosmetics" } },
  { token: "earning:settings", label: "Earning settings", icon: "⚙️", description: "Open Earning → Settings.", target: { kind: "modal-earning", tab: "settings" } },

  // ----- Items sub-tabs (bare + nested forms; the bare forms read more
  //                       naturally inline — "check out the {shop}!") -----
  { token: "items", label: "Items", icon: "🧰", description: "Open Earning → Items.", target: { kind: "modal-earning", tab: "items" } },
  { token: "earning:items", label: "Items", icon: "🧰", description: "Open Earning → Items.", target: { kind: "modal-earning", tab: "items" } },
  { token: "earnings:items", label: "Items", icon: "🧰", description: "Open Earning → Items.", target: { kind: "modal-earning", tab: "items" } },

  { token: "inventory", label: "Inventory", icon: "🧰", description: "Open Items → Inventory.", target: { kind: "modal-earning", tab: "items", itemSubTab: "inventory" } },
  { token: "earning:items:inventory", label: "Inventory", icon: "🧰", description: "Open Items → Inventory.", target: { kind: "modal-earning", tab: "items", itemSubTab: "inventory" } },
  { token: "earnings:items:inventory", label: "Inventory", icon: "🧰", description: "Open Items → Inventory.", target: { kind: "modal-earning", tab: "items", itemSubTab: "inventory" } },

  { token: "shop", label: "Shop", icon: "🛒", description: "Open Items → Shop.", target: { kind: "modal-earning", tab: "items", itemSubTab: "shop" } },
  { token: "earning:items:shop", label: "Shop", icon: "🛒", description: "Open Items → Shop.", target: { kind: "modal-earning", tab: "items", itemSubTab: "shop" } },
  { token: "earnings:items:shop", label: "Shop", icon: "🛒", description: "Open Items → Shop.", target: { kind: "modal-earning", tab: "items", itemSubTab: "shop" } },

  { token: "collection", label: "Collection", icon: "📦", description: "Open Items → Collection.", target: { kind: "modal-earning", tab: "items", itemSubTab: "collection" } },
  { token: "earning:items:collection", label: "Collection", icon: "📦", description: "Open Items → Collection.", target: { kind: "modal-earning", tab: "items", itemSubTab: "collection" } },
  { token: "earnings:items:collection", label: "Collection", icon: "📦", description: "Open Items → Collection.", target: { kind: "modal-earning", tab: "items", itemSubTab: "collection" } },

  { token: "pets", label: "Pets", icon: "🐾", description: "Open Items → Pets.", target: { kind: "modal-earning", tab: "items", itemSubTab: "pets" } },
  { token: "earning:items:pets", label: "Pets", icon: "🐾", description: "Open Items → Pets.", target: { kind: "modal-earning", tab: "items", itemSubTab: "pets" } },
  { token: "earnings:items:pets", label: "Pets", icon: "🐾", description: "Open Items → Pets.", target: { kind: "modal-earning", tab: "items", itemSubTab: "pets" } },

  // ----- Scriptorium routes (full-page nav, not modals) -----
  { token: "scriptorium", label: "Scriptorium", icon: "📚", description: "Open the Scriptorium catalog.", target: { kind: "nav-scriptorium" } },
  { token: "scriptorium:latest", label: "Latest in Scriptorium", icon: "📖", description: "Open the Scriptorium catalog sorted newest first.", target: { kind: "nav-scriptorium", sort: "latest" } },

  // ----- Admin / staff (author-gated; viewer-gated mirrors the admin-panel posture) -----
  { token: "admin", label: "Admin panel", icon: "🛡", description: "Open the admin panel.", authorRole: "admin", viewerRole: "mod", target: { kind: "modal-admin" } },
  { token: "admin:announcements", label: "Admin · Announcements", icon: "📣", description: "Open the admin Announcements tab.", authorRole: "admin", viewerRole: "mod", target: { kind: "modal-admin", tab: "announcements" } },
];

/** Build-time lookup by token. */
const UI_ROUTES_BY_TOKEN = new Map<string, UiRoute>(
  UI_ROUTES.map((r) => [r.token.toLowerCase(), r]),
);

/** Resolve a token (case-insensitive). Returns null when unknown. */
export function resolveUiRoute(token: string): UiRoute | null {
  return UI_ROUTES_BY_TOKEN.get(token.toLowerCase()) ?? null;
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
 * gate the caller doesn't clear — so a regular user can't smuggle
 * `{modal:admin}` into a chat line and have the chip render for
 * mods downstream.
 *
 * Unknown tokens (anything matching the regex shape but not in the
 * catalog) pass through silently and render as plain literal
 * `{whatever}` text. That preserves backwards compatibility with
 * curly-brace usage in roleplay ("{nervously}", "{stage
 * direction}") that predates this feature and shouldn't suddenly
 * start rejecting saves. The editor's live preview is the feedback
 * channel for "did my token resolve?" — if no chip renders, the
 * token didn't match the catalog.
 *
 * Pure: no DB or HTTP — just regex + catalog lookup + role-rank
 * comparison.
 */
export function validateAuthorUiRouteTokens(
  body: string,
  authorRole: Role,
): UiRouteValidationResult {
  const authorRank = roleRank(authorRole);
  for (const token of findUiRouteTokens(body)) {
    const entry = resolveUiRoute(token);
    if (!entry) continue; // unknown — treat as literal text
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
 * Used by the renderer to hide chips a viewer shouldn't see — the
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
 * Split a body into alternating text + token segments — the building
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

/** HTML-attribute-safe escape — used by {@link renderUiRouteChipsInHtml}
 *  so the inserted chip markup can't smuggle a token's label into
 *  attribute context. The catalog labels are all hardcoded today,
 *  but the contract should hold if a future entry pulls its label
 *  from a config row. */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Post-process server-sanitized HTML to swap every recognized
 * `{token}` text occurrence for an interactive `<button>` chip. Used
 * by the BannerMarquee + the announce-kind renderer's `bodyHtml`
 * branch — both surfaces render trusted HTML and would otherwise
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
export function renderUiRouteChipsInHtml(html: string): string {
  if (!html.includes("{")) return html;
  return html.replace(UI_ROUTE_TOKEN_RE, (raw, capturedToken: string) => {
    const token = capturedToken.toLowerCase();
    const entry = resolveUiRoute(token);
    if (!entry) return raw;
    const safeToken = escapeHtmlAttr(token);
    const safeLabel = escapeHtml(entry.label);
    const safeIcon = entry.icon ? `<span aria-hidden="true">${escapeHtml(entry.icon)}</span> ` : "";
    const safeTitle = escapeHtmlAttr(entry.description);
    return (
      `<button type="button" data-tk-ui-route="${safeToken}" title="${safeTitle}" aria-label="${safeTitle}"` +
      // Chip size matches the surrounding text (`text-[1em]`) instead
      // of the previous 0.85em shrink — at chat-line scale the
      // smaller pill read as a footnote, and inside the marquee
      // (text-sm wrapper) it looked visibly under-scaled next to
      // the rest of the body. Em-relative so a future surface that
      // sets a different base font (e.g. an `<h2>`-sized scheduled
      // announce) also gets a proportionally-sized chip.
      // Spacing posture: `mx-1.5` keeps the chip from kissing the
      // adjacent text — the previous `mx-0.5` left the bracketed
      // body wrapping the chip with no visual breathing room.
      // `px-1` trims the internal padding back from the pill
      // pre-bump so the chip doesn't read as oversized vs.
      // surrounding glyphs now that it inherits the body's full
      // font size.
      ` class="tk-ui-route-chip mx-1.5 inline-flex items-center gap-1 rounded border border-keep-action/50 bg-keep-action/10 px-1 py-0 align-baseline text-[1em] text-keep-action transition hover:border-keep-action hover:bg-keep-action/20">` +
      `${safeIcon}<span>${safeLabel}</span></button>`
    );
  });
}
