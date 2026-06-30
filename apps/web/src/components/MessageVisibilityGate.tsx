import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Padding above and below the viewport inside which messages stay
 * mounted. Roughly 1.5 screen heights, large enough that normal
 * scrolling never reveals a placeholder gap (the content renders
 * before the user gets to it) and small enough that a long chat
 * doesn't keep thousands of image / video / emoticon DOM nodes
 * around when the user is parked at the bottom.
 *
 * Discord uses a similar buffer; if perf telemetry ever shows
 * placeholder flashes during fast scroll we can bump this, until
 * then 1500 hits the sweet spot.
 */
const VIEWPORT_PADDING_PX = 1500;

interface Props {
  children: ReactNode;
}

/**
 * Mount a message's render tree only while it's near the viewport;
 * collapse it to a height-preserving placeholder when scrolled far
 * away. Targeted at the flat chat-message stream, the biggest
 * memory and paint-cost wins are media-heavy histories (lots of
 * Show-image embeds, inline emoticon sprites, video iframes) which
 * stay anchored in the DOM otherwise.
 *
 * Behavior:
 *
 *   - Initial state is OPTIMISTIC: render the child on first paint.
 *     The IntersectionObserver flips it to "hidden" on the next tick
 *     if the message is actually off-screen. New messages arriving
 *     at the bottom (where the viewer is parked) are visible from
 *     frame one, no placeholder flash.
 *
 *   - A ResizeObserver records the rendered height of the child
 *     while visible. When the gate transitions to hidden, the
 *     placeholder div claims that exact height, preserving scroll
 *     position. Re-entering the viewport rehydrates the real
 *     children; if the content's height drifts on rehydrate
 *     (reaction count changed, edit landed), the next scroll
 *     adjusts naturally.
 *
 *   - The gate is a single host `<div>` per message. No portals, no
 *     virtualization library, no estimated-height heuristics for the
 *     scrollbar. The browser's native scroll machinery handles
 *     everything because the document height is always correct.
 *
 * Trade-off acknowledged: if a user is mid-edit on a message and
 * scrolls far enough away that the message unmounts, the in-progress
 * edit draft is lost. This is rare (edits are quick), the gate's
 * mount/unmount transition is fast, and saving every keystroke
 * across an unmount would defeat the memory-recovery goal of
 * unmounting in the first place.
 */
export function MessageVisibilityGate({ children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  // Pending "hide" timer (see the asymmetric show/hide handling below).
  const hideTimerRef = useRef<number | null>(null);

  // Visibility tracker. rootMargin extends the trigger zone above
  // AND below the viewport so messages render slightly before they
  // scroll into view, masking the placeholder→child transition.
  //
  // SHOW is immediate; HIDE is deferred ~200ms. Why asymmetric: a message
  // hovering at the rootMargin edge can be nudged across it every frame by the
  // feed's bottom re-pin (MessageList sets scrollTop = scrollHeight while parked
  // at the bottom). Hiding on each crossing swaps the real body for a
  // height-preserving placeholder — but the placeholder height can't perfectly
  // track live content (late media, reaction edits, sub-pixel rounding), so
  // each flip changes the feed height by more than the pin's 2px settle epsilon,
  // which re-fires the pin → the chat "bounces" and never settles, worst with a
  // mix of differently-sized message kinds near the boundary. Deferring the hide
  // lets a boundary message ride out the jitter mounted (stable height) so the
  // pin settles; a genuine scroll-away still releases it ~200ms later. Showing
  // must stay instant or the placeholder→child swap flashes.
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
            setVisible(true);
          } else if (hideTimerRef.current == null) {
            hideTimerRef.current = window.setTimeout(() => {
              hideTimerRef.current = null;
              setVisible(false);
            }, 200);
          }
        }
      },
      {
        rootMargin: `${VIEWPORT_PADDING_PX}px 0px ${VIEWPORT_PADDING_PX}px 0px`,
      },
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

  // Height tracker. Only runs while the child is mounted; the most
  // recently measured value is what the placeholder uses when the
  // gate transitions to hidden. ResizeObserver fires whenever the
  // child grows (image loaded, reaction added) so the stored
  // height stays current.
  useEffect(() => {
    if (!visible) return;
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      // Avoid storing zero (transient layout state during mount).
      // A zero placeholder would collapse the scroll position when
      // the message later transitions to hidden.
      if (h > 0) setMeasuredHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  // When hidden, hold the last-measured height so the scroll
  // position doesn't jump. When visible, no inline style, the
  // child's natural layout drives the box.
  const placeholderStyle =
    !visible && measuredHeight !== null
      ? { height: `${measuredHeight}px` }
      : undefined;

  return (
    <div ref={ref} style={placeholderStyle} aria-hidden={!visible ? true : undefined}>
      {visible ? children : null}
    </div>
  );
}
