import { useEffect, useState, type MouseEvent } from "react";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { useReducedMotion } from "../lib/reducedMotion.js";

/**
 * A splash tab is either an in-page ANCHOR (smooth-scrolls to a section by id and
 * flashes it) or a ROUTE (SPA-navigates to another page like /rules or
 * /top-communities). The bar mixes both.
 */
export type SplashTab =
  | { label: string; kind: "anchor"; id: string }
  | { label: string; kind: "route"; href: string };

/**
 * Sticky anchor/route tab bar pinned to the top of the splash card. Desktop shows
 * the tabs inline (horizontally scrollable if they overflow); mobile collapses to
 * a top-right hamburger dropdown. Anchor tabs scroll to their section and pulse a
 * highlight on it (so a long mobile page makes clear where you landed); route tabs
 * hand off to `onNavigate`. A light scroll-spy marks the anchor currently in view.
 */
export function SplashNav({
  tabs,
  onNavigate,
}: {
  tabs: SplashTab[];
  onNavigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const reduce = useReducedMotion();

  // Scroll-spy: highlight the anchor tab whose section is nearest the center of
  // the viewport. Degrades to no active tab if IO is unavailable.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids = tabs.filter((t) => t.kind === "anchor").map((t) => (t as { id: string }).id);
    const els = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (!els.length) return;
    const ratios = new Map<string, number>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratios.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        let best: string | null = null;
        let bestRatio = 0;
        for (const [id, r] of ratios) if (r > bestRatio) { bestRatio = r; best = id; }
        setActive(bestRatio > 0 ? best : null);
      },
      { rootMargin: "-40% 0px -40% 0px", threshold: [0, 0.25, 0.5, 1] },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [tabs]);

  function activate(t: SplashTab, e?: MouseEvent) {
    setOpen(false);
    if (t.kind === "route") {
      if (e) e.preventDefault();
      onNavigate(t.href);
      return;
    }
    const el = document.getElementById(t.id);
    if (!el) return;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    setActive(t.id);
    // Re-trigger the flash even on a repeat click: drop the class, force a reflow,
    // re-add it. CSS handles the animated (or, under reduce-motion, static) glow.
    el.classList.remove("splash-flash");
    void el.offsetWidth;
    el.classList.add("splash-flash");
    window.setTimeout(() => el.classList.remove("splash-flash"), 1700);
  }

  return (
    <nav
      aria-label="Page sections"
      className="sticky top-0 z-20 border-b border-keep-border/60 bg-keep-bg/85 backdrop-blur-md"
    >
      <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
        <ul className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto md:flex [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((t) => (
            <li key={t.label}>
              <TabButton t={t} active={t.kind === "anchor" && active === t.id} onClick={(e) => activate(t, e)} />
            </li>
          ))}
        </ul>

        <span className="text-[11px] font-semibold uppercase tracking-[0.3em] text-keep-muted md:hidden">
          Explore
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Close section menu" : "Open section menu"}
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded border border-keep-border/60 text-keep-text transition hover:border-keep-action hover:text-keep-action md:hidden"
        >
          {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
        </button>
      </div>

      {open ? (
        <div className="absolute right-2 top-full z-30 mt-1 w-56 overflow-hidden rounded-md border border-keep-border/70 bg-keep-bg/95 shadow-xl backdrop-blur-md md:hidden">
          <ul className="flex flex-col py-1">
            {tabs.map((t) => (
              <li key={t.label}>
                <button
                  type="button"
                  onClick={(e) => activate(t, e)}
                  className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors hover:bg-keep-panel/60 ${
                    t.kind === "anchor" && active === t.id ? "text-keep-action" : "text-keep-text"
                  }`}
                >
                  <span className="flex-1">{t.label}</span>
                  {t.kind === "route" ? <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-keep-muted" aria-hidden /> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}

function TabButton({
  t,
  active,
  onClick,
}: {
  t: SplashTab;
  active: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  const base =
    "inline-flex items-center gap-1 whitespace-nowrap rounded px-3 py-1.5 text-xs font-semibold uppercase tracking-widest transition-colors";
  if (t.kind === "route") {
    return (
      <a href={t.href} onClick={onClick} className={`${base} text-keep-muted hover:bg-keep-panel/50 hover:text-keep-text`}>
        {t.label}
        <ArrowUpRight className="h-3 w-3 opacity-70" aria-hidden />
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`${base} ${
        active ? "bg-keep-action/15 text-keep-action" : "text-keep-muted hover:bg-keep-panel/50 hover:text-keep-text"
      }`}
    >
      {t.label}
    </button>
  );
}
