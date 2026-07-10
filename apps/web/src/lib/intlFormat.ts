/**
 * Locale-aware date/number formatting keyed on the ACTIVE i18next language
 * (docs/I18N_PLAN.md §4).
 *
 * The one non-obvious rule: while English is active we pass `undefined` to
 * the Intl machinery — the browser's own regional default — NOT the literal
 * "en". Every pre-i18n call site did `toLocaleString(undefined, …)`, which
 * lets an en-GB browser render "21:21" where en-US shows "9:21 PM"; forcing
 * "en" would flatten that to US conventions and violate Phase 0's
 * byte-identical-English constraint. Non-English locales get their own
 * conventions the moment the language flips.
 */
import { DEFAULT_LOCALE, PSEUDO_LOCALE } from "@thekeep/shared";
import { i18n } from "./i18n.js";

/**
 * Locale argument for `Intl.*` / `toLocale*` calls: `undefined` (browser
 * regional default) while English — or the en-based pseudo-locale — is
 * active, the active locale otherwise.
 */
export function activeIntlLocale(): string | undefined {
  const lng = i18n.language;
  if (!lng || lng === DEFAULT_LOCALE || lng === PSEUDO_LOCALE) return undefined;
  return lng;
}

export function formatDate(ms: number, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleDateString(activeIntlLocale(), options);
}

export function formatTime(ms: number, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleTimeString(activeIntlLocale(), options);
}

export function formatDateTime(ms: number, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleString(activeIntlLocale(), options);
}

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(activeIntlLocale(), options);
}
