/**
 * The profile hero's language-tag row: one bordered chip per tag, flag
 * first, endonym label after. On narrow (mobile) viewports the label
 * swaps to the compact code ("EN-GB") so a polyglot's row stays a tidy
 * single line instead of wrapping chips across the hero; the full name
 * stays reachable via the title tooltip. Unknown keys (an older client
 * meeting a newer catalog) are skipped silently. Renders nothing when the
 * list is empty.
 *
 * Chip chrome copies the hero's XP/Currency chips (border-keep-rule +
 * bg-keep-bg/60) so the row reads as part of the same family and stays
 * legible over banner-image hero backgrounds.
 */

import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { languageTagByKey } from "@thekeep/shared";
import { LangFlag } from "./LangFlag.js";

export function LanguageTagChips({ keys }: { keys: string[] }) {
  const { t } = useTranslation("profile");
  const tags = keys.map((k) => languageTagByKey.get(k)).filter((tag) => tag !== undefined);
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" role="list" aria-label={t("modal.languages.aria")}>
      {/* Leading glyph so the flag row reads as "spoken languages" at a
          glance (a bare flag could be nationality). Decorative — the row's
          aria-label carries the meaning; the title covers sighted hover. */}
      <span title={t("modal.languages.aria")} className="text-keep-muted">
        <Languages className="h-3.5 w-3.5" aria-hidden />
      </span>
      {tags.map((tag) => (
        <span
          key={tag.key}
          role="listitem"
          title={tag.label}
          className="inline-flex items-center gap-1.5 rounded border border-keep-rule bg-keep-bg/60 px-1.5 py-0.5 text-[11px] leading-none text-keep-text"
        >
          <LangFlag code={tag.flag} className="h-2.5 w-[15px] shrink-0 overflow-hidden rounded-[2px] ring-1 ring-black/25" />
          <span className="hidden sm:inline">{tag.label}</span>
          <span className="font-medium tracking-wide sm:hidden">{tag.short}</span>
        </span>
      ))}
    </div>
  );
}
