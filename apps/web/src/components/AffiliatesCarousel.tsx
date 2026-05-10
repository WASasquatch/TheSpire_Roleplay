import { useEffect, useRef, useState } from "react";

interface PublicAffiliate {
  id: string;
  /** Raw HTML, admin-trusted, NOT sanitized. Topsite networks need their own
   *  anchor + tracking-pixel snippet pasted verbatim, so the rendering uses
   *  dangerouslySetInnerHTML by design. */
  html: string;
}

const ROTATE_MS = 6000;

/**
 * Splash-page affiliate / partner / sponsor carousel. Renders one entry at
 * a time and auto-rotates every ROTATE_MS, pausing on hover or focus so a
 * visitor reading or clicking a tracking-pixel link isn't yanked away mid-
 * interaction.
 *
 * The HTML is admin-trusted by design (topsite networks like toprpsites
 * require their own snippet with a hidden tracking pixel). The same
 * trust posture applies as `customHeadHtml` in admin settings - if an
 * admin pastes hostile HTML, that's an admin-account-compromise problem,
 * not a sanitization one.
 *
 * Renders nothing when there are zero enabled affiliates, so an empty
 * install doesn't show an empty box.
 */
export function AffiliatesCarousel() {
  const [items, setItems] = useState<PublicAffiliate[] | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  // Fetch once. The list rarely changes; admins rotate items via the panel
  // and visitors get the new set on next splash hit.
  useEffect(() => {
    let cancelled = false;
    fetch("/affiliates")
      .then((r) => (r.ok ? r.json() as Promise<{ affiliates: PublicAffiliate[] }> : null))
      .then((j) => { if (!cancelled && j) setItems(j.affiliates); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Auto-rotate. Resets the timer whenever the user interacts (clicking a
  // dot or pausing via hover/focus) to avoid the "jumps the moment your
  // mouse leaves" annoyance.
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
      aria-label="Affiliates and partners"
      className="my-3 border-y border-keep-rule/40 py-3"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="mb-1 text-center text-[10px] uppercase tracking-[0.3em] text-keep-muted">
        Allies of the Spire
      </div>
      <div
        // The admin-supplied HTML lives here. Centered and capped so even
        // tall affiliate banners don't blow out the splash card.
        className="flex min-h-[60px] items-center justify-center text-center [&_a]:inline-block [&_img]:mx-auto [&_img]:max-h-20 [&_img]:max-w-full"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: active.html }}
      />
      {items.length > 1 ? (
        <div className="mt-2 flex justify-center gap-1.5" role="tablist" aria-label="Affiliate carousel controls">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Affiliate ${i + 1} of ${items.length}`}
              onClick={() => {
                setIndex(i);
                restart.current += 1; // restart the auto-rotate timer
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
