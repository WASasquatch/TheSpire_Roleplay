/**
 * SplashLanguagePicker — the public pages' language switch (home, login,
 * register). Public-facing proof the site speaks more than English.
 *
 * The browser's language already auto-selects Spanish on first visit
 * (lib/i18n detectAutoLocale); this is the explicit override, persisted
 * per-device via changeLocale (and onto the account once they sign in and
 * pick again). Native <select> so it stays keyboard/screen-reader friendly
 * with zero extra UI. Absolutely positioned into the shell's top-right —
 * callers just render it inside any `relative` public-page container.
 */

import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import { LOCALE_CHOICES, changeLocale } from "../../lib/i18n.js";

export function SplashLanguagePicker() {
  const { t, i18n: i18nLive } = useTranslation("marketing");
  // The picker's shown value: the language actually on screen. Falls back
  // to en for the pseudo-locale (dev-only) or anything unmatched.
  const activeLocale = LOCALE_CHOICES.some((c) => c.value === i18nLive.language)
    ? i18nLive.language
    : "en";
  return (
    <div className="absolute right-4 top-4 z-20 flex items-center gap-1.5 rounded-full border border-white/25 bg-black/35 px-2.5 py-1.5 shadow-lg backdrop-blur-sm">
      <Globe className="h-3.5 w-3.5 text-white/85" aria-hidden />
      <select
        value={activeLocale}
        onChange={(e) => void changeLocale(e.target.value as (typeof LOCALE_CHOICES)[number]["value"])}
        aria-label={t("landing.languagePicker")}
        title={t("landing.languagePicker")}
        className="cursor-pointer appearance-none bg-transparent pr-0.5 text-xs font-semibold tracking-widest text-white outline-none [&>option]:text-black"
      >
        {LOCALE_CHOICES.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>
    </div>
  );
}
