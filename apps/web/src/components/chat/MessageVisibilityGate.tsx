import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * Padding above and below the viewport within which a row stays fully rendered.
 * ~1 screen each way; large enough that normal scrolling reaches a row well
 * after it's already painted (no blank flash), small enough that a long history
 * doesn't keep painting thousands of media-heavy rows.
 */
const VIEWPORT_PADDING_PX = 1200;

/**
 * Skip layout + paint for a chat row while it's far off-screen — WITHOUT
 * unmounting it — by toggling `content-visibility: hidden` (plus an EXACT
 * reserved height via `contain-intrinsic-size`) as it leaves a padded viewport
 * zone. The row's DOM stays put, which is the whole point:
 *
 *   - Flipping visibility is a cheap style change, NOT a React remount: the row
 *     keeps its rendering state (no image re-decode, instant re-show, no
 *     placeholder flash).
 *   - Because the reserved height equals the last measured height, the feed's
 *     total height DOESN'T change when a row flips. That's what stops the
 *     scroll "seizure": the OLD gate UNMOUNTED rows, which changed the feed
 *     height → fired the bottom-pin's ResizeObserver → nudged scrollTop →
 *     re-crossed the trigger → shook. No height change ⇒ no feedback ⇒ smooth,
 *     Discord-style scrolling.
 *   - On-screen the row has NO containment, so hover toolbars, the reaction
 *     picker, and profile popovers that overflow the row are never clipped — a
 *     blanket `content-visibility: auto` (paint containment even on-screen)
 *     would have cut them off.
 *
 * SHOW is immediate; HIDE is deferred so a row parked at the boundary while the
 * reader jiggles the scroll doesn't flap on and off. Progressive enhancement:
 * where `content-visibility` is unsupported the style is simply ignored and
 * every row renders (correct, just less thrifty).
 */
export function MessageVisibilityGate({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  // Visibility tracker. SHOW immediately (clear any pending hide); HIDE after a
  // short delay so a boundary row doesn't flap during small scroll jitters.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (hideTimerRef.current != null) {
              clearTimeout(hideTimerRef.current);
              hideTimerRef.current = null;
            }
            setHidden(false);
          } else if (hideTimerRef.current == null) {
            hideTimerRef.current = window.setTimeout(() => {
              hideTimerRef.current = null;
              setHidden(true);
            }, 300);
          }
        }
      },
      { rootMargin: `${VIEWPORT_PADDING_PX}px 0px ${VIEWPORT_PADDING_PX}px 0px` },
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
      if (hideTimerRef.current != null) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, []);

  // Keep the reserved (skipped) height matched to the real rendered height so a
  // flip never changes the row's box size (the anti-seizure guarantee). Only
  // measures while shown; the last value is frozen in for the hidden state.
  useEffect(() => {
    if (hidden) return;
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h > 0) setMeasured(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hidden]);

  const style: CSSProperties | undefined = hidden
    ? {
        contentVisibility: "hidden",
        // `auto` remembers the real size too; the explicit px is our exact
        // measured height so the box doesn't resize when it flips.
        containIntrinsicSize: measured != null ? `auto ${measured}px` : "auto 3rem",
      }
    : undefined;

  return (
    <div ref={ref} style={style} aria-hidden={hidden ? true : undefined}>
      {children}
    </div>
  );
}
