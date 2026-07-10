/**
 * Locale → Formatting-tab content module resolution.
 *
 * The Formatting tab's copy is long-form, syntax-heavy JSX (tables of
 * markdown/HTML examples rendered through the real parser), so translations
 * live as drop-in modules (`./locales/<lng>.tsx`, e.g. `./locales/es.tsx`),
 * NOT in the JSON catalogs — the same mechanism as the Guides tab
 * (../helpGuides/loader.ts, docs/I18N_PLAN.md §6). The glob auto-discovers
 * whatever locale modules exist: adding a language means adding ONE file.
 *
 * A locale module exports a `FormattingHelp` component that fully replaces
 * the tab's content. English itself never routes through here — the
 * canonical module (./en.tsx) is statically bundled with the Help modal
 * chunk, exactly as before this split (no extra fetch for en users).
 * Translated modules load lazily, only when their locale is active.
 */
import type { ComponentType } from "react";

const LOCALE_FORMATTING_MODULES = import.meta.glob<{ FormattingHelp: ComponentType }>(
  "./locales/*.tsx",
);

/**
 * Load the translated Formatting-tab component for `lng` ("es", also
 * tolerating regional tags like "es-MX"), or resolve null when no module
 * covers it — the caller then renders the canonical English content. The dev
 * pseudo-locale ("en-XX") lands on null here by design, matching the Guides
 * tab: this content is module-based, not t()-based.
 */
export async function loadFormattingHelp(lng: string): Promise<ComponentType | null> {
  const load =
    LOCALE_FORMATTING_MODULES[`./locales/${lng}.tsx`] ??
    LOCALE_FORMATTING_MODULES[`./locales/${lng.split("-")[0]}.tsx`];
  if (!load) return null;
  const mod = await load();
  return mod.FormattingHelp;
}
