import { useEffect, useRef, useState } from "react";
import type { WorldCatalogEntry } from "@thekeep/shared";
import { useChat } from "../state/store.js";

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
  // Member count is community-activity signal - same family as "X users
  // online" - so it's gated behind the activityFeeds toggle. With the
  // toggle off (cold-start posture), we show only content metrics like
  // page count, which says how built-out a world is without revealing
  // whether anyone's actually using the site.
  const activityFeedsEnabled = useChat((s) => s.branding.activityFeedsEnabled);
  // Pointer-driven swipe gesture state. Tracks the down-x and provides
  // a threshold past which a horizontal drag advances or rewinds the
  // carousel. Works for touch and mouse alike via the pointer events API.
  const SWIPE_THRESHOLD_PX = 40;
  const swipeStartX = useRef<number | null>(null);

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

  function advance(delta: 1 | -1) {
    if (!items || items.length <= 1) return;
    setIndex((i) => (i + delta + items.length) % items.length);
    restart.current += 1;
  }

  return (
    <section
      aria-label="Featured worlds"
      className="my-3 select-none rounded border border-keep-rule/40 bg-keep-bg/40 p-3"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      // Pointer events unify touch + mouse drag. We intentionally don't
      // capture the pointer (no setPointerCapture) so a stray drag that
      // crosses out of the carousel doesn't get held hostage.
      onPointerDown={(e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        swipeStartX.current = e.clientX;
      }}
      onPointerUp={(e) => {
        const start = swipeStartX.current;
        swipeStartX.current = null;
        if (start === null) return;
        const dx = e.clientX - start;
        if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
        // Right-swipe (positive dx) = previous; left-swipe = next. Matches
        // every native carousel: dragging the content to the right reveals
        // what's to its left.
        advance(dx > 0 ? -1 : 1);
      }}
      onPointerCancel={() => { swipeStartX.current = null; }}
      // touch-action: pan-y so the browser still vertical-scrolls the
      // splash but reserves horizontal gestures for the carousel.
      style={{ touchAction: "pan-y" }}
    >
      <div className="mb-1 text-center text-[10px] uppercase tracking-[0.3em] text-keep-muted">
        Worlds you can play in
      </div>
      {/* Cover image hero. When the world has one we render a short
          banner above the text. The banner stays out of the way when
          there's no image — the strip still reads as a quick text-card
          like before. `referrerPolicy="no-referrer"` matches the
          inline image policy elsewhere (don't leak the chat URL to
          whoever hosts the image). */}
      {active.coverImageUrl ? (
        <div className="mb-2 overflow-hidden rounded border border-keep-rule/40 bg-keep-banner/30">
          <img
            src={active.coverImageUrl}
            alt={`${active.name} cover`}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="block max-h-32 w-full object-cover"
          />
        </div>
      ) : null}
      <div className="min-h-[88px] text-center">
        <div className="font-action text-lg leading-tight text-keep-action">{active.name}</div>
        <div className="text-[10px] text-keep-muted">
          by {active.ownerUsername}
          <span className="mx-1">&middot;</span>/{active.slug}
          <span className="mx-1">&middot;</span>
          {active.pageCount} {active.pageCount === 1 ? "page" : "pages"}
          {/* Member count is community-activity data; only surface it when
              the admin has flipped activity feeds on. With cold-start
              posture we hide the count so a thin community doesn't
              broadcast "dead site" on the splash. */}
          {activityFeedsEnabled ? (
            <>
              <span className="mx-1">&middot;</span>
              {active.memberCount} {active.memberCount === 1 ? "member" : "members"}
            </>
          ) : null}
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
        // Larger dots than the affiliate carousel uses (those are 1.5px).
        // Comfortable thumb / mouse target on both platforms while still
        // staying compact in the splash.
        <div className="mt-3 flex justify-center gap-2" role="tablist" aria-label="Featured worlds carousel controls">
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
              className={`h-3 w-3 rounded-full border transition ${
                i === index
                  ? "border-keep-action bg-keep-action"
                  : "border-keep-rule bg-keep-bg hover:bg-keep-muted"
              }`}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
