/**
 * Predefined profile language tags — the languages a player knows and
 * roleplays in, shown as flag chips in the profile hero and picked in the
 * profile editor. The catalog is FIXED (no free-text): a bounded, curated
 * list keeps the header professional and gives every tag a hand-drawn SVG
 * flag (the web registry in `components/flags/LangFlag.tsx` keys off
 * `flag`; emoji flags are not an option — Windows renders them as bare
 * letter pairs).
 *
 * Labels are ENDONYMS (each language named in itself: "Español", "日本語"),
 * the professional convention for language pickers, so they render
 * identically under every UI locale and need no catalog translations.
 * `short` is the compact form the profile hero uses on narrow (mobile)
 * viewports where the full label row would wrap chips across several
 * lines.
 *
 * Keys are lowercase BCP-47-ish tags and MUST stay lowercase: the column
 * round-trips through `parseTagList`/`serializeTagList` (comma list,
 * lowercased on parse), so a mixed-case key would never match its own
 * stored form.
 *
 * Catalog order is curated, not alphabetical: English variants first,
 * then Spanish (the site's two UI locales), then Latin-script languages
 * A→Z, then non-Latin scripts. The editor's picker and any tag listing
 * should present this order as-is.
 */

export interface LanguageTag {
  /** Stable lowercase key stored on `users.languages` (comma list). */
  key: string;
  /** Endonym label, rendered as-is under every UI locale. */
  label: string;
  /** Compact uppercase form for narrow viewports ("EN-GB", "ES-LA"). */
  short: string;
  /** Flag key into the web `LangFlag` SVG registry. */
  flag: string;
}

/** Most tags one profile can hold — keeps the hero row bounded and tidy. */
export const LANGUAGE_TAG_MAX = 6;

export const LANGUAGE_TAGS: readonly LanguageTag[] = [
  { key: "en-us", label: "English (US)", short: "EN-US", flag: "us" },
  { key: "en-gb", label: "English (UK)", short: "EN-GB", flag: "gb" },
  { key: "en-au", label: "English (AU)", short: "EN-AU", flag: "au" },
  { key: "en-ca", label: "English (CA)", short: "EN-CA", flag: "ca" },
  { key: "es-es", label: "Español (España)", short: "ES", flag: "es" },
  { key: "es-419", label: "Español (Latinoamérica)", short: "ES-LA", flag: "latam" },
  { key: "id", label: "Bahasa Indonesia", short: "ID", flag: "id" },
  { key: "cs", label: "Čeština", short: "CS", flag: "cz" },
  { key: "da", label: "Dansk", short: "DA", flag: "dk" },
  { key: "de", label: "Deutsch", short: "DE", flag: "de" },
  { key: "tl", label: "Filipino", short: "FIL", flag: "ph" },
  { key: "fr", label: "Français", short: "FR", flag: "fr" },
  { key: "it", label: "Italiano", short: "IT", flag: "it" },
  { key: "hu", label: "Magyar", short: "HU", flag: "hu" },
  { key: "nl", label: "Nederlands", short: "NL", flag: "nl" },
  { key: "no", label: "Norsk", short: "NO", flag: "no" },
  { key: "pl", label: "Polski", short: "PL", flag: "pl" },
  { key: "pt-br", label: "Português (Brasil)", short: "PT-BR", flag: "br" },
  { key: "pt-pt", label: "Português (Portugal)", short: "PT-PT", flag: "pt" },
  { key: "ro", label: "Română", short: "RO", flag: "ro" },
  { key: "fi", label: "Suomi", short: "FI", flag: "fi" },
  { key: "sv", label: "Svenska", short: "SV", flag: "se" },
  { key: "vi", label: "Tiếng Việt", short: "VI", flag: "vn" },
  { key: "tr", label: "Türkçe", short: "TR", flag: "tr" },
  { key: "el", label: "Ελληνικά", short: "EL", flag: "gr" },
  { key: "ru", label: "Русский", short: "RU", flag: "ru" },
  { key: "uk", label: "Українська", short: "UK", flag: "ua" },
  { key: "he", label: "עברית", short: "HE", flag: "il" },
  { key: "ar", label: "العربية", short: "AR", flag: "sa" },
  { key: "hi", label: "हिन्दी", short: "HI", flag: "in" },
  { key: "th", label: "ไทย", short: "TH", flag: "th" },
  { key: "ja", label: "日本語", short: "JA", flag: "jp" },
  { key: "zh-hans", label: "中文（简体）", short: "ZH-S", flag: "cn" },
  { key: "zh-hant", label: "中文（繁體）", short: "ZH-T", flag: "tw" },
  { key: "ko", label: "한국어", short: "KO", flag: "kr" },
];

export const languageTagByKey: ReadonlyMap<string, LanguageTag> = new Map(
  LANGUAGE_TAGS.map((t) => [t.key, t]),
);

/**
 * Normalize an arbitrary payload into a valid tag-key list: strings only,
 * trimmed + lowercased, unknown keys dropped (never a 400 — a stale client
 * with an older catalog just loses the key), de-duplicated preserving the
 * caller's order (first occurrence wins; the order is the owner's chosen
 * display order), capped at LANGUAGE_TAG_MAX. Non-array input → [].
 */
export function sanitizeLanguageTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const key = raw.trim().toLowerCase();
    if (!key || seen.has(key) || !languageTagByKey.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= LANGUAGE_TAG_MAX) break;
  }
  return out;
}
