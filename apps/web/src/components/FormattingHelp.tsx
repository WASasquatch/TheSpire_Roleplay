import { useEffect, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { FormattingHelp as FormattingHelpEn } from "./helpFormatting/en.js";
import { loadFormattingHelp } from "./helpFormatting/loader.js";

/**
 * Formatting tab of the Help modal — locale-aware wrapper.
 *
 * Mirrors the HelpGuides per-locale module mechanism (docs/I18N_PLAN.md §6):
 * the tab's content is long-form, syntax-heavy JSX, so translations live as
 * drop-in locale modules (./helpFormatting/locales/<lng>.tsx exporting
 * `FormattingHelp`), NOT in the JSON catalogs. English (./helpFormatting/
 * en.tsx) is canonical and statically bundled; a translated module for the
 * active language lazy-loads and replaces the whole tab, and any language
 * without one falls back to English rather than rendering blank.
 */
export function FormattingHelp() {
  const { i18n } = useTranslation("help");

  // Translated tab content for the active language, when a locale module
  // exists; null = render canonical English. The result is tagged with the
  // language it was loaded FOR so flipping back to en (or a quick es→en→es)
  // never shows a stale module's content while the effect catches up.
  const [translated, setTranslated] = useState<{ lng: string; Component: ComponentType } | null>(null);
  useEffect(() => {
    const lng = i18n.language;
    let cancelled = false;
    void loadFormattingHelp(lng).then((Component) => {
      if (!cancelled) setTranslated(Component ? { lng, Component } : null);
    });
    return () => { cancelled = true; };
  }, [i18n.language]);

  const Content =
    translated !== null && translated.lng === i18n.language ? translated.Component : FormattingHelpEn;
  return <Content />;
}
