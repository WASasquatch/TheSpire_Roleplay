import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChat } from "../state/store.js";
import { GUIDES } from "./helpGuides/en.js";
import { loadGuideTranslations } from "./helpGuides/loader.js";
import type { HelpGuideTranslations } from "./helpGuides/types.js";

/**
 * TOC click handler. The Help modal scrolls within its own
 * `overflow-y-auto` pane (not the window), so a bare `<a href="#...">`
 * jump only moves the document scroll position and the modal stays put.
 * We also need to force-open the target `<details>` because everything
 * past the first guide ships collapsed, landing on a closed disclosure
 * with no visible content reads as "the link is broken."
 *
 * scrollIntoView walks up to the nearest scrollable ancestor (the
 * modal's overflow pane), so the same call works regardless of where
 * the parent puts us.
 */
function jumpToGuide(id: string) {
  const el = document.getElementById(`guide-${id}`);
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Long-form, ELI5-style walkthroughs for the major site features. Lives
 * in the Help modal alongside the Commands and Formatting tabs - the Commands
 * tab is the precise reference; this is the "what does this thing even do"
 * counterpart.
 *
 * Each Guide is a collapsible section so users can scan the table of
 * contents up top and expand only what they need. Defaults: the first guide
 * is open; the rest are closed. Anchor ids on each guide match the TOC links
 * so clicking a TOC entry jumps and opens it.
 *
 * Localization (docs/I18N_PLAN.md §6): guide CONTENT is per-locale JSX
 * modules under ./helpGuides/, not catalog JSON. English (./helpGuides/en.tsx)
 * is canonical and statically bundled; a translated module for the active
 * language lazy-loads and overrides guides ONE BY ONE, so any guide it
 * doesn't cover renders in English rather than disappearing.
 */
export function HelpGuides({ initialGuide }: { initialGuide?: string }) {
  const { t, i18n } = useTranslation("help");

  // Some guides are feature-gated: e.g. the Theater guides only make
  // sense (and only show) for users who can actually run a theater, so we
  // hide them from everyone who lacks `use_theater_mode`. Viewer-facing
  // guides have no `requiresPermission` and always show.
  const permissions = useChat((s) => s.me?.permissions);

  // Translated guide bodies for the active language, when a locale module
  // exists; null = render canonical English. The result is tagged with the
  // language it was loaded FOR so flipping back to en (or a quick es→en→es)
  // never shows a stale module's content while the effect catches up.
  const [translated, setTranslated] = useState<{ lng: string; guides: HelpGuideTranslations } | null>(null);
  useEffect(() => {
    const lng = i18n.language;
    let cancelled = false;
    void loadGuideTranslations(lng).then((guides) => {
      if (!cancelled) setTranslated(guides ? { lng, guides } : null);
    });
    return () => { cancelled = true; };
  }, [i18n.language]);
  const overrides = translated !== null && translated.lng === i18n.language ? translated.guides : null;

  const guides = GUIDES.map((g) => {
    // Per-guide fallback: a locale module only supplies title/body — the
    // id, ordering, and permission gate always stay the canonical ones.
    const tr = overrides?.[g.id];
    return tr ? { ...g, title: tr.title, body: tr.body } : g;
  }).filter((g) => !g.requiresPermission || (permissions?.includes(g.requiresPermission) ?? false));

  // Deep-link: when opened pointed at a specific guide (e.g. the theater
  // panel's "How to stream" link), open + scroll to it once mounted.
  // Deferred a tick so the <details> anchors exist before we scroll.
  useEffect(() => {
    if (!initialGuide) return;
    const timer = window.setTimeout(() => jumpToGuide(initialGuide), 50);
    return () => window.clearTimeout(timer);
  }, [initialGuide]);

  return (
    <div className="space-y-3 text-xs">
      <p className="text-keep-muted">{t("guides.intro")}</p>

      <nav className="rounded border border-keep-rule/60 bg-keep-panel/30 p-2 text-[11px]">
        <div className="mb-1 uppercase tracking-widest text-keep-muted">{t("guides.jumpTo")}</div>
        <ul className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
          {guides.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                onClick={() => jumpToGuide(g.id)}
                className="text-left text-keep-action hover:underline"
              >
                {g.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {guides.map((g, i) => (
        <details
          key={g.id}
          id={`guide-${g.id}`}
          open={i === 0}
          className="rounded border border-keep-rule/60 bg-keep-bg"
        >
          <summary className="cursor-pointer rounded bg-keep-banner/30 px-3 py-2 font-action text-sm hover:bg-keep-banner/50">
            {g.title}
          </summary>
          <div className="space-y-3 px-3 py-3 leading-relaxed text-keep-text">{g.body}</div>
        </details>
      ))}
    </div>
  );
}
