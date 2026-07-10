/**
 * Locale → guide-content module resolution.
 *
 * Guide copy is long-form JSX, so translations live as drop-in modules
 * (`./locales/<lng>.tsx`, e.g. `./locales/es.tsx`), NOT in the JSON
 * catalogs (docs/I18N_PLAN.md §6). The glob auto-discovers whatever locale
 * modules exist, mirroring the catalog globs in lib/i18n.ts: adding a
 * language means adding ONE file — no loader or init edits.
 *
 * A locale module exports `guides: HelpGuideTranslations` covering any
 * subset of the canonical guide ids in ./en.tsx; HelpGuides falls back to
 * the English body PER GUIDE, so a partially-translated locale renders
 * mixed rather than blank. English itself never routes through here — the
 * canonical module is statically bundled with the Help modal chunk, exactly
 * as before this split (no extra fetch for en users). Translated modules
 * load lazily, only when their locale is active.
 */
import type { HelpGuideTranslations } from "./types.js";

const LOCALE_GUIDE_MODULES = import.meta.glob<{ guides: HelpGuideTranslations }>("./locales/*.tsx");

/**
 * Load the translated guides for `lng` ("es", also tolerating regional tags
 * like "es-MX"), or resolve null when no module covers it — the caller then
 * renders the canonical English guides. The dev pseudo-locale ("en-XX")
 * lands on null here by design: guides are module-based, not t()-based, so
 * the pseudo sweep only exercises the Help modal's chrome.
 */
export async function loadGuideTranslations(lng: string): Promise<HelpGuideTranslations | null> {
  const load =
    LOCALE_GUIDE_MODULES[`./locales/${lng}.tsx`] ??
    LOCALE_GUIDE_MODULES[`./locales/${lng.split("-")[0]}.tsx`];
  if (!load) return null;
  const mod = await load();
  return mod.guides;
}
