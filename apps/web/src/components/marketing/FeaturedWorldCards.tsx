import { useEffect, useRef, useState } from "react";
import type { WorldCatalogEntry, WorldGenre } from "@thekeep/shared";
import { WORLD_VIBE_AXES } from "@thekeep/shared";
import { ChevronLeft, ChevronRight, FileText, Globe, Users } from "lucide-react";
import { useChat } from "../../state/store.js";
import { SPLASH_PANEL, SPLASH_PANEL_HOVER } from "../../lib/splashPanel.js";

/**
 * Splash-page featured-worlds CARD carousel. Replaces the scrying-orb
 * canvas on the landing page with an information-forward card: cover
 * thumbnail top-left inline with the title block, description below,
 * meta counts, and the world's vibe stats rendered as compact bars.
 *
 * The orb component (FeaturedWorldsCarousel) still exists for the
 * auth pages; this one is built for the redesigned portal where the
 * goal is "tell me what this world IS", not ambiance.
 *
 * Same data source as the orb: GET /worlds/featured. Renders nothing
 * when the fetch returns zero entries (fresh-install posture). Member
 * counts stay gated behind branding.activityFeedsEnabled.
 */

const ROTATE_MS = 8000;

const GENRE_LABEL: Record<WorldGenre, string> = {
  fantasy: "Fantasy",
  scifi: "Sci-Fi",
  modern: "Modern",
  horror: "Horror",
  western: "Western",
  steampunk: "Steampunk",
  mythological: "Mythological",
  other: "Original Setting",
};

interface Props {
  onNavigate: (path: string) => void;
}

export function FeaturedWorldCards({ onNavigate }: Props) {
  const [items, setItems] = useState<WorldCatalogEntry[] | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const activityFeedsEnabled = useChat((s) => s.branding.activityFeedsEnabled);

  useEffect(() => {
    let cancelled = false;
    fetch("/worlds/featured")
      .then((r) => (r.ok ? (r.json() as Promise<{ entries: WorldCatalogEntry[] }>) : null))
      .then((j) => { if (!cancelled && j) setItems(j.entries); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Auto-rotate; manual advances bump `restart` so the visitor gets
  // a full read-window on the card they just picked.
  const restart = useRef(0);
  useEffect(() => {
    if (!items || items.length <= 1 || paused) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [items, paused, restart.current]);

  if (!items || items.length === 0) return null;
  const active = items[Math.min(index, items.length - 1)]!;

  function advance(delta: 1 | -1) {
    if (!items || items.length <= 1) return;
    setIndex((i) => (i + delta + items.length) % items.length);
    restart.current += 1;
  }

  function enter() {
    onNavigate(`/w/${encodeURIComponent(active.slug)}`);
  }

  // Only axes the author actually tuned. All-null => skip the block
  // entirely so untouched worlds don't render a wall of dashes.
  const vibes = WORLD_VIBE_AXES.filter((a) => active.vibeStats[a.key] !== null);

  return (
    <section
      aria-label="Featured worlds"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`${SPLASH_PANEL} ${SPLASH_PANEL_HOVER} p-4 sm:p-5`}
    >
      <header className="mb-3 text-center">
        <p className="text-[11px] uppercase tracking-[0.3em] text-keep-muted">
          Featured Worlds
        </p>
        <h3 className="font-action mt-1 text-xl text-keep-text">World Settings to Explore</h3>
      </header>

      <div
        role="link"
        tabIndex={0}
        aria-label={`Enter ${active.name}`}
        onClick={enter}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            enter();
          }
        }}
        className="group cursor-pointer rounded-md border border-keep-border/40 bg-keep-bg/30 p-4 transition hover:border-keep-accent/50 sm:p-5"
      >
        {/* Cover thumb inline with the title block. */}
        <div className="flex items-start gap-3">
          {active.coverImageUrl ? (
            <img
              src={active.coverImageUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              draggable={false}
              className="h-20 w-20 shrink-0 rounded-md border border-keep-border/60 object-cover"
            />
          ) : (
            <div
              aria-hidden
              className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md border border-keep-border/60"
              style={{
                background:
                  "radial-gradient(circle at 30% 25%, rgb(var(--keep-accent) / 0.3), rgb(var(--keep-panel) / 0.5) 75%)",
              }}
            >
              <Globe className="h-8 w-8 text-keep-accent" aria-hidden />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-keep-accent">
              {GENRE_LABEL[active.genre] ?? "World"}
            </p>
            <h4 className="font-action mt-0.5 truncate text-xl leading-tight text-keep-text group-hover:text-keep-action">
              {active.name}
            </h4>
            <p className="mt-1 truncate text-[13px] text-keep-muted">by {active.ownerUsername}</p>
          </div>
        </div>

        <p className="mt-3 line-clamp-3 text-[15px] leading-relaxed text-keep-text/85">
          {active.description ??
            `A world told in ${active.pageCount} ${active.pageCount === 1 ? "page" : "pages"}.`}
        </p>

        {/* Meta counts. Members stay behind the activity-feeds gate. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-keep-muted">
          <span className="inline-flex items-center gap-1">
            <FileText className="h-4 w-4" aria-hidden />
            {active.pageCount} {active.pageCount === 1 ? "page" : "pages"}
          </span>
          {activityFeedsEnabled && active.memberCount > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Users className="h-4 w-4" aria-hidden />
              {active.memberCount} {active.memberCount === 1 ? "member" : "members"}
            </span>
          ) : null}
        </div>

        {vibes.length > 0 ? (
          <div className="mt-4 border-t border-keep-rule/40 pt-3">
            <p className="mb-2 text-[11px] uppercase tracking-[0.25em] text-keep-muted">Vibe</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {vibes.map((axis) => {
                const value = active.vibeStats[axis.key]!;
                return (
                  <div key={axis.key} title={axis.desc}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-[11px] uppercase tracking-wide text-keep-text/70">
                        {axis.label}
                      </span>
                      <span className="text-[11px] tabular-nums text-keep-muted">{value}</span>
                    </div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-keep-rule/40">
                      <div
                        className="h-full rounded-full bg-keep-accent"
                        style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <p className="mt-4 text-right text-base font-semibold text-keep-action">
          Enter this world →
        </p>
      </div>

      {items.length > 1 ? (
        <div className="mt-3 flex items-center justify-center gap-3">
          <button
            type="button"
            aria-label="Previous world"
            title="Previous world"
            onClick={() => advance(-1)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-keep-border/60 bg-keep-panel/40 text-keep-muted transition hover:border-keep-accent/60 hover:text-keep-text"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <div className="flex gap-1.5" role="tablist" aria-label="Featured worlds carousel controls">
            {items.map((it, i) => (
              <button
                key={it.id}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`World ${i + 1} of ${items.length}: ${it.name}`}
                onClick={() => { setIndex(i); restart.current += 1; }}
                className={`h-1.5 w-1.5 rounded-full ${
                  i === index ? "bg-keep-action" : "bg-keep-rule/60 hover:bg-keep-muted"
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            aria-label="Next world"
            title="Next world"
            onClick={() => advance(1)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-keep-border/60 bg-keep-panel/40 text-keep-muted transition hover:border-keep-accent/60 hover:text-keep-text"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}
    </section>
  );
}
