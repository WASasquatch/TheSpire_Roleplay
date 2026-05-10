import { useEffect, useRef, useState } from "react";
import type { WorldCatalogEntry } from "@thekeep/shared";

const ROTATE_MS = 7000;

/**
 * Splash-page world carousel. Fetches up to 10 randomly-chosen open worlds
 * from /worlds/featured and rotates through them on a slow cadence so the
 * splash sells "there are settings to play in" without overwhelming a
 * first-time visitor with the full catalog.
 *
 * Pauses on hover/focus; clicking a dot jumps to that world.
 *
 * Renders nothing when:
 *   - the admin toggle is off (parent gates this; we don't re-check), or
 *   - the fetch returns zero entries (so a brand-new install with no open
 *     worlds doesn't show an empty box).
 */
export function FeaturedWorldsCarousel() {
  const [items, setItems] = useState<WorldCatalogEntry[] | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/worlds/featured")
      .then((r) => (r.ok ? (r.json() as Promise<{ entries: WorldCatalogEntry[] }>) : null))
      .then((j) => { if (!cancelled && j) setItems(j.entries); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const restart = useRef(0);
  useEffect(() => {
    if (!items || items.length <= 1 || paused) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [items, paused, restart.current]);

  if (!items || items.length === 0) return null;
  const active = items[Math.min(index, items.length - 1)];
  if (!active) return null;

  return (
    <section
      aria-label="Featured worlds"
      className="my-3 rounded border border-keep-rule/40 bg-keep-bg/40 p-3"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="mb-1 text-center text-[10px] uppercase tracking-[0.3em] text-keep-muted">
        Worlds you can play in
      </div>
      <div className="min-h-[88px] text-center">
        <div className="font-action text-lg leading-tight text-keep-action">{active.name}</div>
        <div className="text-[10px] text-keep-muted">
          by {active.ownerUsername}
          <span className="mx-1">&middot;</span>/{active.slug}
          <span className="mx-1">&middot;</span>
          {active.pageCount} {active.pageCount === 1 ? "page" : "pages"}
          <span className="mx-1">&middot;</span>
          {active.memberCount} {active.memberCount === 1 ? "member" : "members"}
        </div>
        {active.description ? (
          // line-clamp-3 caps the strip height even when an admin writes a
          // sprawling description - the splash card has finite vertical room
          // and a long blurb would push the form below the fold.
          <p className="mx-auto mt-1.5 max-w-prose text-[11px] text-keep-text/80 line-clamp-3">
            {active.description}
          </p>
        ) : null}
      </div>
      {items.length > 1 ? (
        <div className="mt-2 flex justify-center gap-1.5" role="tablist" aria-label="Featured worlds carousel controls">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`World ${i + 1} of ${items.length}: ${it.name}`}
              onClick={() => {
                setIndex(i);
                restart.current += 1;
              }}
              className={`h-1.5 w-1.5 rounded-full ${
                i === index ? "bg-keep-action" : "bg-keep-rule/60 hover:bg-keep-muted"
              }`}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
