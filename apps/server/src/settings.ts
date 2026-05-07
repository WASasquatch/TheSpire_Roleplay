import { eq } from "drizzle-orm";
import type { Theme } from "@thekeep/shared";
import { DEFAULT_THEME, normalizeTheme } from "@thekeep/shared";
import type { Db } from "./db/index.js";
import { siteSettings } from "./db/schema.js";

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
  /** Cap on user accounts that may share an email (1 = traditional). */
  maxAccountsPerEmail: number;
  /** Cap on user-owned rooms (system rooms exempt). */
  maxRoomsPerOwner: number;
  /** Cap on chat message body length. */
  maxMessageLength: number;
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
  maxCharactersPerUser?: number;
  maxAccountsPerEmail?: number;
  maxRoomsPerOwner?: number;
  maxMessageLength?: number;
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
  if (patch.maxCharactersPerUser !== undefined) update.maxCharactersPerUser = patch.maxCharactersPerUser;
  if (patch.maxAccountsPerEmail !== undefined) update.maxAccountsPerEmail = patch.maxAccountsPerEmail;
  if (patch.maxRoomsPerOwner !== undefined) update.maxRoomsPerOwner = patch.maxRoomsPerOwner;
  if (patch.maxMessageLength !== undefined) update.maxMessageLength = patch.maxMessageLength;
  if (patch.maxBioLength !== undefined) update.maxBioLength = patch.maxBioLength;
  if (patch.registrationOpen !== undefined) update.registrationOpen = patch.registrationOpen;
  if (patch.welcomeHtml !== undefined) update.welcomeHtml = patch.welcomeHtml;
  if (patch.rulesHtml !== undefined) update.rulesHtml = patch.rulesHtml;
  if (patch.securityNoticeHtml !== undefined) update.securityNoticeHtml = patch.securityNoticeHtml;
  if (patch.registerDisclaimerHtml !== undefined) update.registerDisclaimerHtml = patch.registerDisclaimerHtml;
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
    maxCharactersPerUser: row.maxCharactersPerUser,
    maxAccountsPerEmail: row.maxAccountsPerEmail,
    maxRoomsPerOwner: row.maxRoomsPerOwner,
    maxMessageLength: row.maxMessageLength,
    maxBioLength: row.maxBioLength,
    registrationOpen: row.registrationOpen,
    welcomeHtml: row.welcomeHtml,
    rulesHtml: row.rulesHtml,
    securityNoticeHtml: row.securityNoticeHtml,
    registerDisclaimerHtml: row.registerDisclaimerHtml,
    updatedAt: +row.updatedAt,
  };
}
