import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Theme } from "@thekeep/shared";
import { DEFAULT_THEME, normalizeTheme } from "@thekeep/shared";
import type { Db } from "./db/index.js";
import { siteSettings } from "./db/schema.js";

/**
 * Stable, short hash of the welcome HTML used to decide whether a user has
 * acknowledged the CURRENT version. Sha-256 truncated to 16 hex chars is
 * collision-resistant in practice (~64 bits) and short enough to store
 * comfortably on `users.welcome_seen_hash`. Empty input returns "" so the
 * client can shortcut "no welcome to render" without any hash math.
 */
export function hashWelcome(html: string): string {
  if (!html.trim()) return "";
  return createHash("sha256").update(html).digest("hex").slice(0, 16);
}

/**
 * Parse a stored theme JSON (from `users.themeJson` / `characters.themeJson`)
 * and return a normalized Theme. On null or parse failure, falls back to the
 * sitewide admin-configured default theme. Used by the profile-fetch paths
 * that need to embed a viewable theme into a ProfileView for OTHER users.
 *
 * For "your own profile" reads where the client needs to distinguish
 * "user explicitly picked X" from "user has no preference, inherits site
 * default", use `parseOwnThemeJson` below instead — it returns null
 * rather than substituting the default. Without that distinction the
 * client would freeze a snapshot of the site default at fetch time and
 * stop responding to later admin changes (per-user theme save with
 * "Default" picked would still bake the current site default in).
 */
export async function parseUserThemeJson(db: Db, json: string | null): Promise<Theme> {
  if (json) {
    try { return normalizeTheme(JSON.parse(json)); }
    catch { /* fall through */ }
  }
  return (await getSettings(db)).defaultTheme;
}

/**
 * Strict parse — returns Theme on success, null when the column was null
 * or the stored JSON is unparseable. No site-default fallback. Use this
 * on read paths where the caller must know whether the user has an
 * explicit theme of their own (e.g. /me/profile, so the client can let
 * its own resolver pick between user / site / hardcoded layers live).
 */
export function parseOwnThemeJson(json: string | null): Theme | null {
  if (!json) return null;
  try { return normalizeTheme(JSON.parse(json)); }
  catch { return null; }
}

export interface SiteSettings {
  messageRetentionMs: number;
  sessionTtlMs: number;
  /** Resolved theme - already falls back to DEFAULT_THEME when unset. */
  defaultTheme: Theme;
  /** Same data as raw row - for serializing to admin endpoints. */
  defaultThemeJson: string | null;
  /** Public site name shown in the banner, login screen, tab title. */
  siteName: string;
  /** CSS background shorthand for the banner; null = use theme panel color. */
  bannerCoverCss: string | null;
  /** Hex color override for the logo text; null = inherit theme text. */
  logoColor: string | null;
  /** CSS font-family stack for the logo text; null = use font-action. */
  logoFont: string | null;
  /** Cap on characters per user. */
  maxCharactersPerUser: number;
  /**
   * URL for the banner/splash logo image. Empty string = no logo, fall
   * back to the `siteName` text. Default = `/thespire-logo.png` (SPA-
   * bundled). Custom URLs or uploads (via /admin/upload/logo, which
   * writes to /uploads/...) overwrite it.
   */
  logoUrl: string;
  /** Cap on user accounts that may share an email (1 = traditional). */
  maxAccountsPerEmail: number;
  /** Cap on user-owned rooms (system rooms exempt). */
  maxRoomsPerOwner: number;
  /** Cap on chat message body length. */
  maxMessageLength: number;
  /**
   * Author-edit / author-delete grace window in ms for flat chat
   * rooms. Mods and admins bypass the gate entirely; forum (nested)
   * rooms allow indefinite edits regardless. Default 5 minutes.
   */
  editGraceMs: number;
  /** Cap on profile bio HTML length. */
  maxBioLength: number;
  /** When false, /auth/register returns 503. */
  registrationOpen: boolean;
  /** Sanitized HTML rendered above the splash login/register form. */
  welcomeHtml: string;
  /** Sanitized HTML rendered in the Rules modal (admin-editable house rules). */
  rulesHtml: string;
  /** Sanitized HTML rendered alongside the rules - privacy/safety notice. */
  securityNoticeHtml: string;
  /** Sanitized HTML rendered above the register form. Acceptance is required. */
  registerDisclaimerHtml: string;
  /** Plain-text SEO description (meta description, og:description, twitter:description). */
  metaDescription: string;
  /** Verbatim HTML injected into <head> on the server-rendered splash (analytics scripts). */
  customHeadHtml: string;
  /** Web Push VAPID public key. Safe to ship to clients. Null until first boot generates it. */
  vapidPublicKey: string | null;
  /** Web Push VAPID private key. NEVER expose to clients. */
  vapidPrivateKey: string | null;
  /** Master toggle for surfacing live community activity. Off during cold-start so an empty community doesn't telegraph "dead place" to first-time visitors. Splash + future activity rails honor this. */
  activityFeedsEnabled: boolean;
  /** Splash page shows a randomized carousel of up to 10 open worlds when on. Off by default. */
  featuredWorldsEnabled: boolean;
  /** Sanitized HTML for the post-login welcome/announcement modal. Empty string = no welcome to show. */
  newUserWelcomeHtml: string;
  /** SHA hash of the current welcome HTML; clients compare against the user's `welcomeSeenHash` to decide whether to surface the modal. Empty when welcome HTML is empty. */
  newUserWelcomeHash: string;
  /** Timestamp the welcome text was last edited (ms epoch), or null when never set. Audience gate: `user.createdAt > newUserWelcomeUpdatedAt`. */
  newUserWelcomeUpdatedAt: number | null;
  /** Site-wide default theme style. Users who haven't picked a per-user override inherit this. */
  defaultStyleKey: string;
  /** Iteration of the DEFAULT_WORLDS seed last applied to system worlds. The boot seeder compares against SEED_VERSION in seed_worlds.ts and overwrites when this is behind. */
  worldsSeedVersion: number;
  updatedAt: number;
}

/**
 * Singleton settings cache. Reads cheap (in-memory). Writes go through
 * `updateSettings` which also reseeds the cache. The bootstrap step at
 * server start fills the cache; admin route handlers refresh it after PUT.
 */
let cached: SiteSettings | null = null;

export async function ensureSiteSettings(db: Db): Promise<SiteSettings> {
  const existing = (await db.select().from(siteSettings).where(eq(siteSettings.id, "singleton")).limit(1))[0];
  if (existing) {
    cached = rowToSettings(existing);
    return cached;
  }
  await db.insert(siteSettings).values({ id: "singleton" }).onConflictDoNothing();
  const fresh = (await db.select().from(siteSettings).where(eq(siteSettings.id, "singleton")).limit(1))[0]!;
  cached = rowToSettings(fresh);
  return cached;
}

export async function getSettings(db: Db): Promise<SiteSettings> {
  if (cached) return cached;
  return ensureSiteSettings(db);
}

export interface SettingsPatch {
  messageRetentionMs?: number;
  sessionTtlMs?: number;
  /** Pass null to clear the override; pass a Theme to set. Omit to leave as-is. */
  defaultTheme?: Theme | null;
  /** Public site name. Empty string falls back to "The Spire". */
  siteName?: string;
  /** Pass null to clear; pass a CSS background shorthand to set. */
  bannerCoverCss?: string | null;
  /** Pass null to clear; pass a #rrggbb hex to set. */
  logoColor?: string | null;
  /** Pass null to clear; pass a CSS font-family stack to set. */
  logoFont?: string | null;
  /**
   * Banner/splash logo URL. Empty string clears the override (banner
   * falls back to text title). Any non-empty string is stored verbatim
   * — typically `/thespire-logo.png` (default), an `/uploads/...` path
   * from the upload endpoint, or a remote https URL.
   */
  logoUrl?: string;
  maxCharactersPerUser?: number;
  maxAccountsPerEmail?: number;
  maxRoomsPerOwner?: number;
  maxMessageLength?: number;
  /** Author-edit/delete grace window in ms (chat rooms). */
  editGraceMs?: number;
  maxBioLength?: number;
  registrationOpen?: boolean;
  /** Pre-sanitized HTML; settings layer doesn't re-sanitize so the route handler must. */
  welcomeHtml?: string;
  /** Pre-sanitized HTML; route handler sanitizes before invoking. */
  rulesHtml?: string;
  /** Pre-sanitized HTML; route handler sanitizes before invoking. */
  securityNoticeHtml?: string;
  /** Pre-sanitized HTML; route handler sanitizes before invoking. */
  registerDisclaimerHtml?: string;
  /** Plain text. Admin route handler trims; storage is verbatim. */
  metaDescription?: string;
  /** Raw HTML, NOT sanitized (analytics scripts must remain intact). Admin-only. */
  customHeadHtml?: string;
  /** Master toggle for surfacing live activity counters. */
  activityFeedsEnabled?: boolean;
  /** Splash page featured-worlds carousel toggle. */
  featuredWorldsEnabled?: boolean;
  /** Pre-sanitized HTML; route handler sanitizes before invoking. Empty string clears it. */
  newUserWelcomeHtml?: string;
  /** Site-wide default theme style key. */
  defaultStyleKey?: string;
}

export async function updateSettings(
  db: Db,
  patch: SettingsPatch,
  byUserId: string,
): Promise<SiteSettings> {
  const update: Partial<typeof siteSettings.$inferInsert> = {
    updatedAt: new Date(),
    updatedById: byUserId,
  };
  if (patch.messageRetentionMs !== undefined) update.messageRetentionMs = patch.messageRetentionMs;
  if (patch.sessionTtlMs !== undefined) update.sessionTtlMs = patch.sessionTtlMs;
  if (patch.defaultTheme !== undefined) {
    update.defaultThemeJson = patch.defaultTheme === null ? null : JSON.stringify(patch.defaultTheme);
  }
  if (patch.siteName !== undefined) {
    const trimmed = patch.siteName.trim();
    update.siteName = trimmed === "" ? "The Spire" : trimmed;
  }
  if (patch.bannerCoverCss !== undefined) update.bannerCoverCss = patch.bannerCoverCss;
  if (patch.logoColor !== undefined) update.logoColor = patch.logoColor;
  if (patch.logoFont !== undefined) update.logoFont = patch.logoFont;
  if (patch.logoUrl !== undefined) update.logoUrl = patch.logoUrl;
  if (patch.maxCharactersPerUser !== undefined) update.maxCharactersPerUser = patch.maxCharactersPerUser;
  if (patch.maxAccountsPerEmail !== undefined) update.maxAccountsPerEmail = patch.maxAccountsPerEmail;
  if (patch.maxRoomsPerOwner !== undefined) update.maxRoomsPerOwner = patch.maxRoomsPerOwner;
  if (patch.maxMessageLength !== undefined) update.maxMessageLength = patch.maxMessageLength;
  if (patch.editGraceMs !== undefined) update.editGraceMs = patch.editGraceMs;
  if (patch.maxBioLength !== undefined) update.maxBioLength = patch.maxBioLength;
  if (patch.registrationOpen !== undefined) update.registrationOpen = patch.registrationOpen;
  if (patch.welcomeHtml !== undefined) update.welcomeHtml = patch.welcomeHtml;
  if (patch.rulesHtml !== undefined) update.rulesHtml = patch.rulesHtml;
  if (patch.securityNoticeHtml !== undefined) update.securityNoticeHtml = patch.securityNoticeHtml;
  if (patch.registerDisclaimerHtml !== undefined) update.registerDisclaimerHtml = patch.registerDisclaimerHtml;
  if (patch.metaDescription !== undefined) update.metaDescription = patch.metaDescription;
  if (patch.customHeadHtml !== undefined) update.customHeadHtml = patch.customHeadHtml;
  if (patch.activityFeedsEnabled !== undefined) update.activityFeedsEnabled = patch.activityFeedsEnabled;
  if (patch.featuredWorldsEnabled !== undefined) update.featuredWorldsEnabled = patch.featuredWorldsEnabled;
  if (patch.defaultStyleKey !== undefined) update.defaultStyleKey = patch.defaultStyleKey;
  if (patch.newUserWelcomeHtml !== undefined) {
    // Only bump the welcome's edit timestamp when the text actually changed.
    // The audience filter (`user.createdAt > newUserWelcomeUpdatedAt`)
    // depends on this being a true content-change marker - re-saving
    // unchanged settings shouldn't re-broadcast the modal to a fresh
    // cohort of "users registered after right now".
    const current = (await db.select({ html: siteSettings.newUserWelcomeHtml }).from(siteSettings).where(eq(siteSettings.id, "singleton")).limit(1))[0];
    update.newUserWelcomeHtml = patch.newUserWelcomeHtml;
    if ((current?.html ?? "") !== patch.newUserWelcomeHtml) {
      // Empty-string clear -> set the timestamp to null too, so a stale
      // user.createdAt comparison can't accidentally surface old text.
      update.newUserWelcomeUpdatedAt = patch.newUserWelcomeHtml.trim() === "" ? null : new Date();
    }
  }
  await db.update(siteSettings).set(update).where(eq(siteSettings.id, "singleton"));
  cached = null;
  return getSettings(db);
}

function rowToSettings(row: typeof siteSettings.$inferSelect): SiteSettings {
  let defaultTheme: Theme = DEFAULT_THEME;
  if (row.defaultThemeJson) {
    try { defaultTheme = normalizeTheme(JSON.parse(row.defaultThemeJson)); }
    catch { /* keep built-in default on parse failure */ }
  }
  return {
    messageRetentionMs: row.messageRetentionMs,
    sessionTtlMs: row.sessionTtlMs,
    defaultTheme,
    defaultThemeJson: row.defaultThemeJson,
    siteName: row.siteName,
    bannerCoverCss: row.bannerCoverCss,
    logoColor: row.logoColor,
    logoFont: row.logoFont,
    logoUrl: row.logoUrl,
    maxCharactersPerUser: row.maxCharactersPerUser,
    maxAccountsPerEmail: row.maxAccountsPerEmail,
    maxRoomsPerOwner: row.maxRoomsPerOwner,
    maxMessageLength: row.maxMessageLength,
    editGraceMs: row.editGraceMs,
    maxBioLength: row.maxBioLength,
    registrationOpen: row.registrationOpen,
    welcomeHtml: row.welcomeHtml,
    rulesHtml: row.rulesHtml,
    securityNoticeHtml: row.securityNoticeHtml,
    registerDisclaimerHtml: row.registerDisclaimerHtml,
    metaDescription: row.metaDescription,
    customHeadHtml: row.customHeadHtml,
    vapidPublicKey: row.vapidPublicKey,
    vapidPrivateKey: row.vapidPrivateKey,
    activityFeedsEnabled: row.activityFeedsEnabled,
    featuredWorldsEnabled: row.featuredWorldsEnabled,
    newUserWelcomeHtml: row.newUserWelcomeHtml,
    newUserWelcomeHash: hashWelcome(row.newUserWelcomeHtml),
    newUserWelcomeUpdatedAt: row.newUserWelcomeUpdatedAt ? +row.newUserWelcomeUpdatedAt : null,
    defaultStyleKey: row.defaultStyleKey,
    worldsSeedVersion: row.worldsSeedVersion,
    updatedAt: +row.updatedAt,
  };
}

/**
 * Atomically bump the stored worlds-seed-version. Called by the seeder
 * after it has successfully written the v{n} content so the next boot
 * compares against the new value and skips redundant work. Direct write
 * (not via `updateSettings`) because there's no actor user — the seed
 * is system-initiated, and we don't want it touching `updatedById`.
 */
export async function setWorldsSeedVersion(db: Db, version: number): Promise<void> {
  await db.update(siteSettings).set({ worldsSeedVersion: version }).where(eq(siteSettings.id, "singleton"));
  cached = null;
}

/**
 * Idempotently ensure VAPID keys exist on the singleton row. Generated at
 * first boot and persisted so deploys don't churn keys (which would
 * silently invalidate every existing subscription). Called from the boot
 * sequence; safe to re-call on every start.
 *
 * Returns the public key (never the private one) so callers can hand it to
 * the front-end without poking through SiteSettings.
 */
export async function ensureVapidKeys(db: Db): Promise<{ publicKey: string }> {
  const s = await ensureSiteSettings(db);
  if (s.vapidPublicKey && s.vapidPrivateKey) {
    return { publicKey: s.vapidPublicKey };
  }
  // Lazy-import web-push so the dep can stay server-only and the type
  // import doesn't pull into the shared bundle.
  const webPush = await import("web-push");
  const keys = webPush.default.generateVAPIDKeys();
  await db.update(siteSettings).set({
    vapidPublicKey: keys.publicKey,
    vapidPrivateKey: keys.privateKey,
  }).where(eq(siteSettings.id, "singleton"));
  cached = null;
  await getSettings(db);
  return { publicKey: keys.publicKey };
}
