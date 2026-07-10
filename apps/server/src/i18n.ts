/**
 * Server-side i18n (docs/I18N_PLAN.md Phase 0).
 *
 * A standalone i18next instance (no React) over the SAME shared catalog the
 * client bundles, so command notices / system messages / emails can resolve
 * to the RECIPIENT's language once Phase 3 moves those strings into keys.
 * Phase 0 wires the machinery only — no server string goes through here yet.
 *
 * Everything loads from disk once at boot (module import, synchronous):
 * every `<ns>.json` present under `packages/shared/locales/<lng>/` for each
 * supported locale. Adding a namespace file or filling a locale needs no
 * edit here — the loader picks up whatever exists, and missing es keys fall
 * back to en at lookup time.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import i18next from "i18next";
import {
  DEFAULT_LOCALE,
  I18N_DEFAULT_NAMESPACE,
  I18N_NAMESPACES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  matchSupportedLocale,
  type SupportedLocale,
} from "@thekeep/shared";

// Resolve the catalog directory THROUGH the shared package's `./locales/*`
// exports entry (same import surface the web bundler uses) rather than a
// relative walk out of this file, so the loader survives workspace-layout
// refactors and works from the Docker image's copied tree alike.
const nodeRequire = createRequire(import.meta.url);
const localesRoot = dirname(
  dirname(nodeRequire.resolve("@thekeep/shared/locales/en/common.json")),
);

type LocaleBundle = Record<string, unknown>;

function loadResources(): Record<string, Record<string, LocaleBundle>> {
  const resources: Record<string, Record<string, LocaleBundle>> = {};
  for (const locale of SUPPORTED_LOCALES) {
    const dir = join(localesRoot, locale);
    if (!existsSync(dir)) continue;
    const bundles: Record<string, LocaleBundle> = {};
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        bundles[basename(file, ".json")] = JSON.parse(
          readFileSync(join(dir, file), "utf8"),
        ) as LocaleBundle;
      } catch (err) {
        // A malformed catalog file must not take the whole server down —
        // skipping it just means those keys resolve through the en
        // fallback. The coverage script (scripts/i18n-coverage.mjs) is the
        // loud guardrail for catalog integrity.
        console.error(`[i18n] skipping unparseable catalog file ${locale}/${file}:`, err);
      }
    }
    resources[locale] = bundles;
  }
  return resources;
}

export const i18n = i18next.createInstance();

// initAsync:false + fully-preloaded resources = synchronous init; tFor is
// safe from the first line of code that runs after this module loads.
void i18n.init({
  resources: loadResources(),
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  ns: [...I18N_NAMESPACES],
  defaultNS: I18N_DEFAULT_NAMESPACE,
  // Server strings land in plain-text notices / emails, not HTML — nothing
  // to escape (and escaping would corrupt names with apostrophes).
  interpolation: { escapeValue: false },
  initAsync: false,
});

/**
 * Translate `key` into `locale` (defaulting to en for null/undefined/unknown
 * values, so a raw `users.locale` column value can be passed straight in).
 * `params` are interpolation values (`{{name}}` etc.).
 */
export function tFor(
  locale: string | null | undefined,
  key: string,
  params?: Record<string, unknown>,
): string {
  const lng: SupportedLocale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  return i18n.t(key, { lng, ...(params ?? {}) });
}

/**
 * The locale server-generated text for this user should render in:
 * their saved preference, else en. Accepts any row/session shape that
 * carries the `users.locale` column.
 */
export function localeForUser(
  row: { locale?: string | null } | null | undefined,
): SupportedLocale {
  const saved = row?.locale;
  return isSupportedLocale(saved) ? saved : DEFAULT_LOCALE;
}

/**
 * Best supported locale for an `Accept-Language` header — the recipient
 * signal for logged-out flows (registration errors, public emails) where no
 * users.locale exists. Honors q-weights; a region tag matches its base
 * language ("es-MX" → "es"); anything unmatched falls back to en.
 */
export function parseAcceptLanguage(header: string | null | undefined): SupportedLocale {
  if (typeof header !== "string" || header.trim() === "") return DEFAULT_LOCALE;
  const candidates = header
    .split(",")
    .map((part) => {
      const [tag = "", ...opts] = part.trim().split(";");
      let q = 1;
      for (const opt of opts) {
        const m = /^\s*q=([0-9.]+)\s*$/i.exec(opt);
        if (m) {
          const parsed = Number(m[1]);
          if (Number.isFinite(parsed)) q = parsed;
        }
      }
      return { tag: tag.trim(), q };
    })
    .filter((c) => c.tag !== "" && c.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const c of candidates) {
    const matched = matchSupportedLocale(c.tag);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
}
