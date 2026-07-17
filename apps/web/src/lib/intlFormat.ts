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

/**
 * The user's chosen display timezone (an IANA name like "America/New_York"),
 * or undefined to use the browser's own zone (the default). Set from the
 * persisted account preference on load and whenever it changes in Settings,
 * and read on every format call so a change re-renders dates without a reload.
 * Module-level (not React state) because these formatters are plain functions
 * called from all over the app; a re-render is driven by the store update that
 * accompanies a change.
 */
let userTimeZone: string | undefined;

/** Set (or clear, with null/empty) the app-wide display timezone. */
export function setDisplayTimeZone(tz: string | null | undefined): void {
  userTimeZone = tz ? tz : undefined;
}

/** The active display timezone, or undefined for the browser default. */
export function activeTimeZone(): string | undefined {
  return userTimeZone;
}

/** Fold the user's timezone in as the DEFAULT; an explicit `options.timeZone`
 *  still wins (a caller that must pin a specific zone). */
function withTimeZone(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions | undefined {
  if (!userTimeZone) return options;
  return { timeZone: userTimeZone, ...options };
}

export function formatDate(ms: number, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleDateString(activeIntlLocale(), withTimeZone(options));
}

export function formatTime(ms: number, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleTimeString(activeIntlLocale(), withTimeZone(options));
}

export function formatDateTime(ms: number, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleString(activeIntlLocale(), withTimeZone(options));
}

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(activeIntlLocale(), options);
}
