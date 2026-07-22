import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * Padding above and below the viewport within which a row stays fully rendered.
 * ~1 screen each way; large enough that normal scrolling reaches a row well
 * after it's already painted (no blank flash), small enough that a long history
 * doesn't keep painting thousands of media-heavy rows.
 */
const VIEWPORT_PADDING_PX = 1200;

/** How long a row must stay out of the padded zone before it's hidden. Keeps a
 *  row parked at the boundary from flapping on/off while the reader jiggles
 *  the scroll. */
const HIDE_DELAY_MS = 300;

/* =============================================================
 * Shared observers.
 *
 * Every gate used to own an IntersectionObserver + a ResizeObserver +
 * a per-row hide setTimeout. With the buffer at several hundred rows
 * that's hundreds of observer instances the browser services on every
 * scroll frame, and after a history prepend the off-zone rows' hide
 * timers fired one by one — each a separate React commit + style
 * recalc landing mid-scroll (part of the mobile jank).
 *
 * Instead: ONE IntersectionObserver and ONE ResizeObserver for all
 * gates (both APIs are built to watch many targets), and hides are
 * coalesced into a single deadline-sweep timeout, so a wave of rows
 * leaving the zone flips in ONE batched React commit (React 18
 * auto-batches inside timeouts) instead of ~90 staggered ones. Shows
 * stay immediate, applied inside the IO callback — also one batch.
 * ============================================================= */

interface GateHandle {
  setHidden: (hidden: boolean) => void;
  /** performance.now() deadline for a pending hide; null = not pending. */
  hideAt: number | null;
}

const gates = new Map<Element, GateHandle>();
let sharedIO: IntersectionObserver | null = null;
let sharedRO: ResizeObserver | null = null;
const sizeCallbacks = new Map<Element, (h: number) => void>();
let hideSweepTimer: number | null = null;

function runHideSweep(): void {
  hideSweepTimer = null;
  const now = performance.now();
  for (const handle of gates.values()) {
    if (handle.hideAt != null && handle.hideAt <= now) {
      handle.hideAt = null;
      handle.setHidden(true);
    }
  }
  scheduleHideSweep();
}

/** (Re)arm the sweep timer for the earliest pending hide, if any. */
function scheduleHideSweep(): void {
  if (hideSweepTimer != null) return;
  let earliest = Infinity;
  for (const handle of gates.values()) {
    if (handle.hideAt != null && handle.hideAt < earliest) earliest = handle.hideAt;
  }
  if (earliest === Infinity) return;
  hideSweepTimer = window.setTimeout(runHideSweep, Math.max(0, earliest - performance.now()));
}

function ensureSharedIO(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!sharedIO) {
    sharedIO = new IntersectionObserver(
      (entries) => {
        const now = performance.now();
        for (const entry of entries) {
          const handle = gates.get(entry.target);
          if (!handle) continue;
          if (entry.isIntersecting) {
            handle.hideAt = null;
            handle.setHidden(false);
          } else {
            handle.hideAt = now + HIDE_DELAY_MS;
          }
        }
        scheduleHideSweep();
      },
      { rootMargin: `${VIEWPORT_PADDING_PX}px 0px ${VIEWPORT_PADDING_PX}px 0px` },
    );
  }
  return sharedIO;
}

/** Register a gate element. Returns the unobserve cleanup. */
function observeGate(el: Element, setHidden: (hidden: boolean) => void): (() => void) | null {
  const io = ensureSharedIO();
  if (!io) return null;
  gates.set(el, { setHidden, hideAt: null });
  io.observe(el);
  return () => {
    gates.delete(el);
    io.unobserve(el);
    // A pending sweep that finds nothing due simply doesn't re-arm.
  };
}

/** Watch an element's size via the shared ResizeObserver. */
function observeSize(el: Element, onHeight: (h: number) => void): (() => void) | null {
  if (typeof ResizeObserver === "undefined") return null;
  if (!sharedRO) {
    sharedRO = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cb = sizeCallbacks.get(entry.target);
        if (!cb) continue;
        const h = (entry.target as HTMLElement).offsetHeight;
        if (h > 0) cb(h);
      }
    });
  }
  sizeCallbacks.set(el, onHeight);
  sharedRO.observe(el);
  return () => {
    sizeCallbacks.delete(el);
    sharedRO?.unobserve(el);
  };
}

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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeGate(el, setHidden) ?? undefined;
  }, []);

  // Keep the reserved (skipped) height matched to the real rendered height so a
  // flip never changes the row's box size (the anti-seizure guarantee). Only
  // measures while shown; the last value is frozen in for the hidden state.
  useEffect(() => {
    if (hidden) return;
    const el = ref.current;
    if (!el) return;
    return observeSize(el, setMeasured) ?? undefined;
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
