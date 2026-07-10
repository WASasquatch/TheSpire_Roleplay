/**
 * Locale registry for the localization build-out (docs/I18N_PLAN.md).
 *
 * ONE place declares which locales ship and which catalog namespaces exist;
 * the web init (apps/web/src/lib/i18n.ts), the server init
 * (apps/server/src/i18n.ts), and the /me/profile locale validation all read
 * from here. Catalog files live at `packages/shared/locales/<lng>/<ns>.json`
 * (exported as `@thekeep/shared/locales/*`) so `en` is a single source of
 * truth for both apps.
 *
 * Adding a locale = append it here + add `locales/<lng>/` files; adding a
 * namespace = append it to I18N_NAMESPACES + create `locales/en/<ns>.json`.
 * Neither init file needs edits (both auto-load whatever files exist).
 */

/** Locales the product ships. Wave 1 = English (source) + Spanish. */
export const SUPPORTED_LOCALES = ["en", "es"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";

/**
 * Dev pseudo-locale: `en` strings accent-folded + padded ~40% so un-wrapped
 * literals and layout overflow jump out at a glance. Never persisted to
 * `users.locale` (the PUT whitelist is SUPPORTED_LOCALES) and never offered
 * in the switcher UI; selectable only by hand via localStorage (see
 * apps/web/src/lib/i18n.ts).
 */
export const PSEUDO_LOCALE = "en-XX";

/**
 * Full catalog namespace list (plan §2), pre-registered up front so
 * parallel domain agents only ever touch their OWN `<ns>.json` + their own
 * components — never a shared init file.
 */
export const I18N_NAMESPACES = [
  "common",
  "errors",
  "chat",
  "forums",
  "worlds",
  "scriptorium",
  "servers",
  "admin",
  "profile",
  "earning",
  "help",
  "email",
  "commands",
  "arcade",
  "tours",
  "moderation",
  "marketing",
  "notifications",
] as const;
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

/** Namespace `t()` resolves against when none is specified. */
export const I18N_DEFAULT_NAMESPACE: I18nNamespace = "common";

export function isSupportedLocale(v: unknown): v is SupportedLocale {
  return typeof v === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

/**
 * Map a BCP-47 language tag ("es-MX", "en_GB", "ES") to a supported locale,
 * matching exact first, then the base language. Used for `navigator.language`
 * on the client and `Accept-Language` entries on the server. Returns null
 * when nothing matches (callers fall through to the next detection step).
 */
export function matchSupportedLocale(tag: string | null | undefined): SupportedLocale | null {
  if (typeof tag !== "string" || tag === "") return null;
  const norm = tag.trim().toLowerCase().replace(/_/g, "-");
  if (norm === "") return null;
  if (isSupportedLocale(norm)) return norm;
  const base = norm.split("-")[0] ?? "";
  return isSupportedLocale(base) ? base : null;
}
