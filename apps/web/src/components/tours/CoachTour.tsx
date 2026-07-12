import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "../../lib/reducedMotion.js";

/**
 * Reusable coach-tour overlay: a spotlight + tooltip walkthrough.
 *
 * Generalized from the profile bio Designer's first-run tour so any surface
 * (the Designer, the whole-screen site tour, …) can drive one by handing over
 * its own `steps`, an `onClose`, and an optional header `icon`. The behavior is
 * unchanged from the original:
 *
 *   - Each step's target is OPTIONAL. Selectors are polled briefly (panels can
 *     mount asynchronously); if nothing matches (or a step has no target) the
 *     card simply centers and the tour continues. Nothing here can wedge the
 *     page — worst case is a centered card instead of a spotlight.
 *   - The spotlight is a giant `box-shadow` dim + an accent `outline` ring, both
 *     inline (CSP `style-src-attr` allows it) — no injected stylesheet, no React
 *     `<style>`. Splitting the dim onto the box-shadow (not the ring) means a
 *     theme-var hiccup can't drop the dim too.
 *   - Back / Next / Skip controls, progress dots, keyboard nav (Esc skips,
 *     arrows/Enter navigate), rendered through a portal at `z-[200]`.
 *
 * Reduced motion: when the viewer has calm mode on (OS `prefers-reduced-motion`
 * or the in-app toggle), the spotlight's `transition` is dropped so the ring
 * snaps between steps instead of sliding. Everything else is already static.
 */

export interface CoachStep {
  title: string;
  /** Step copy. Usually a plain t() string; a ReactNode is allowed so a
   *  step can carry parsed inline chips (the site tour's adult-channels
   *  step links the rules via a live `{rules}` chip). */
  body: ReactNode;
  /** Candidate selectors, first match wins. Omit for a centered step. */
  targets?: string[];
  /**
   * Runs when this step becomes current — BEFORE the target is measured —
   * so a step can stage the UI its target lives in (the site tour opens the
   * mobile navigation drawer for userlist/room-list steps). May return a
   * cleanup, invoked when the step is left (advance, back, or close), for
   * restoring whatever the prepare changed. Prepares should be idempotent:
   * two consecutive drawer steps each "open" it without flicker.
   */
  prepare?: () => void | (() => void);
}

const PAD = 8;
const CARD_W = 340;

function findTarget(targets: string[] | undefined): HTMLElement | null {
  if (!targets) return null;
  for (const sel of targets) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export function CoachTour({
  steps,
  onClose,
  icon,
}: {
  steps: CoachStep[];
  onClose: () => void;
  icon?: ReactNode;
}) {
  const { t } = useTranslation("tours");
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, forceTick] = useState(0);
  const reduceMotion = useReducedMotion();
  const cardRef = useRef<HTMLDivElement | null>(null);
  // The card's MEASURED size. Its width is capped by `max-w-[92vw]` and its
  // height depends on how the copy wraps, so fixed estimates can't keep it on
  // screen. Measured after each render, then used to clamp placement below.
  const [cardSize, setCardSize] = useState<{ w: number; h: number }>({ w: CARD_W, h: 200 });

  // Defensive: an empty step list would index `undefined`. Clamp so a caller
  // that builds a conditional list can't crash the overlay; nothing to show
  // means immediately hand control back.
  const safeStep = Math.min(step, Math.max(steps.length - 1, 0));
  const current = steps[safeStep];
  const isLast = safeStep === steps.length - 1;

  useEffect(() => {
    if (steps.length === 0) onClose();
  }, [steps.length, onClose]);

  // Per-step prepare/cleanup. Runs the incoming step's `prepare` (e.g. "open
  // the mobile drawer this target lives in") and invokes its returned cleanup
  // when the step is left — including on unmount, so a skipped tour restores
  // whatever the current step staged. Steps are read through a ref so a
  // re-memoized (but logically identical) steps array — a language switch —
  // doesn't re-run the prepare mid-step.
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  useEffect(() => {
    const prep = stepsRef.current[safeStep]?.prepare;
    let cleanup: (() => void) | undefined;
    if (prep) {
      const r = prep();
      if (typeof r === "function") cleanup = r;
    }
    return () => { cleanup?.(); };
  }, [safeStep]);

  // Backdrop-click nudge. An outside click must NOT dismiss the tour (that
  // used to permanently kill the first-run walkthrough via the POSTed
  // dismissal); instead the card pulses so the eye lands on the real
  // controls. Dismissal stays explicit: the ✕ / Skip buttons, Esc, or
  // finishing. The pulse is a color ring (calm-safe) plus a small scale pop
  // that is dropped under reduced motion.
  const [nudge, setNudge] = useState(false);
  const nudgeTimer = useRef<number | null>(null);
  const pulseCard = useCallback(() => {
    setNudge(true);
    if (nudgeTimer.current) window.clearTimeout(nudgeTimer.current);
    nudgeTimer.current = window.setTimeout(() => setNudge(false), 400);
  }, []);
  useEffect(() => () => {
    if (nudgeTimer.current) window.clearTimeout(nudgeTimer.current);
  }, []);

  // Resolve + track the current step's target rect. Polls briefly for late-
  // mounting panels, then follows it on scroll/resize.
  useLayoutEffect(() => {
    if (!current) return;
    let raf = 0;
    let tries = 0;
    const measure = () => {
      const el = findTarget(current.targets);
      if (el) {
        const r = el.getBoundingClientRect();
        // A target that MATCHES a selector but isn't actually VISIBLE on screen
        // must NOT be spotlighted, or the tour "points at nothing on mobile":
        //   - display:none (a rail or tab strip that's `hidden` on mobile) →
        //     getBoundingClientRect() is 0x0 at (0,0) → a tiny ring top-left.
        //   - a drawer translated off-screen (still laid out) → a real box but
        //     entirely outside the viewport → an off-screen ring + card.
        // Require a non-empty box that overlaps the viewport; otherwise treat it
        // as no target so the step centers, and keep polling in case it
        // mounts / the drawer opens.
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const onScreen =
          (r.width > 0 || r.height > 0) &&
          r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
        if (onScreen) {
          setRect(r);
          return true;
        }
      }
      setRect(null);
      return false;
    };
    let slow = 0;
    const poll = () => {
      if (measure()) return;
      if (tries > 40) {
        // ~40 frames (~0.7s) of fast polling, then drop to a slow tick
        // instead of giving up: several steps point at LATE-mounting
        // targets the copy tells the user to open themselves (the forum
        // topic composer, a settings panel). The spotlight should attach
        // the moment the element appears, not only on the next
        // scroll/resize.
        slow = window.setInterval(() => {
          if (measure() && slow) { window.clearInterval(slow); slow = 0; }
        }, 750);
        return;
      }
      tries += 1;
      raf = requestAnimationFrame(poll);
    };
    poll();
    const onMove = () => measure();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      cancelAnimationFrame(raf);
      if (slow) window.clearInterval(slow);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [current]);

  // Reposition once more after fonts/layout settle on the very first paint.
  useEffect(() => {
    const t = setTimeout(() => forceTick((n) => n + 1), 50);
    return () => clearTimeout(t);
  }, []);

  // Measure the rendered card so the placement math can clamp the WHOLE card
  // (Next button included) into the viewport. Runs after every render — a single
  // getBoundingClientRect — and only sets state when the size changed by >1px,
  // so it settles in a frame without looping. Position is `fixed` and doesn't
  // feed back into the card's own size, so there's no layout loop.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCardSize((prev) =>
      Math.abs(prev.w - r.width) > 1 || Math.abs(prev.h - r.height) > 1
        ? { w: r.width, h: r.height }
        : prev,
    );
  });

  // Re-clamp on viewport changes (rotation / resize) even for a centered card,
  // which the target-measure listener above wouldn't otherwise re-render.
  useEffect(() => {
    const onResize = () => forceTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const next = useCallback(() => {
    if (isLast) onClose();
    else setStep((s) => Math.min(s + 1, steps.length - 1));
  }, [isLast, onClose, steps.length]);
  const back = useCallback(() => setStep((s) => Math.max(s - 1, 0)), []);

  // Keyboard: Esc skips, arrows/Enter navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, onClose]);

  if (!current) return null;

  // Card placement: below the target if it fits, else above, else a clamped
  // fallback; centered when there's no target. In EVERY case the measured card
  // (cardSize) is clamped on both axes so no edge — and crucially the Next
  // button — can leave the viewport. Without this clamp a tall or edge-anchored
  // target (e.g. the full-height room list, or a modal panel on a phone) pushed
  // the card off-screen where the tour couldn't be advanced.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const GAP = 12;
  const cw = cardSize.w;
  const ch = cardSize.h;
  let left: number;
  let top: number;
  if (rect) {
    left = rect.left + rect.width / 2 - cw / 2;
    if (rect.bottom + GAP + ch <= vh - GAP) top = rect.bottom + GAP;        // fits below
    else if (rect.top - GAP - ch >= GAP) top = rect.top - GAP - ch;         // fits above
    else top = vh - ch - GAP;                                               // neither: clamp
  } else {
    left = (vw - cw) / 2;
    top = (vh - ch) / 2;
  }
  // Final safety clamp on both axes: never let any edge leave the viewport.
  left = Math.max(GAP, Math.min(left, vw - cw - GAP));
  top = Math.max(GAP, Math.min(top, vh - ch - GAP));
  const cardStyle: React.CSSProperties = { position: "fixed", top, left, width: CARD_W };

  return createPortal(
    <div className="fixed inset-0 z-[200]" aria-modal role="dialog">
      {/* Click-catcher: blocks stray interaction outside the spotlight. When
          there's no spotlight target it covers everything and provides the dim
          itself. Clicking it advances NOTHING and never dismisses — it just
          pulses the card (dismissing here permanently killed the tour for
          anyone who tapped the page). With a target, the catcher is FOUR
          strips around the spotlight hole so the spotlighted control itself
          stays clickable: several steps coach clicking the real UI (open the
          drawer, press New Topic) and later steps' targets only mount after
          that click. */}
      {rect ? (
        <>
          <div
            className="absolute"
            style={{ top: 0, left: 0, right: 0, height: Math.max(0, rect.top - PAD) }}
            onClick={pulseCard}
          />
          <div
            className="absolute"
            style={{ top: rect.bottom + PAD, left: 0, right: 0, bottom: 0 }}
            onClick={pulseCard}
          />
          <div
            className="absolute"
            style={{
              top: Math.max(0, rect.top - PAD),
              left: 0,
              width: Math.max(0, rect.left - PAD),
              height: rect.height + PAD * 2,
            }}
            onClick={pulseCard}
          />
          <div
            className="absolute"
            style={{
              top: Math.max(0, rect.top - PAD),
              left: rect.right + PAD,
              right: 0,
              height: rect.height + PAD * 2,
            }}
            onClick={pulseCard}
          />
        </>
      ) : (
        <div
          className="absolute inset-0"
          style={{ background: "rgba(8,10,18,0.62)" }}
          onClick={pulseCard}
        />
      )}

      {/* Spotlight. Dim (a giant box-shadow) lives on this div; the accent ring
          is a separate outline so a theme-var hiccup can't drop the dim too.
          The between-steps slide is dropped under reduced motion. */}
      {rect ? (
        <div
          className="pointer-events-none absolute"
          style={{
            position: "fixed",
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: 10,
            boxShadow: "0 0 0 9999px rgba(8,10,18,0.62)",
            outline: "2px solid rgb(var(--keep-accent))",
            outlineOffset: 2,
            transition: reduceMotion ? "none" : "all .25s ease",
          }}
        />
      ) : null}

      {/* Tooltip card. The nudge ring/pop fires on backdrop clicks; the
          scale transform is skipped under reduced motion (the ring alone is
          the calm-mode emphasis). */}
      <div
        ref={cardRef}
        style={{
          ...cardStyle,
          ...(reduceMotion ? {} : {
            transition: "transform .15s ease",
            transform: nudge ? "scale(1.03)" : "scale(1)",
          }),
        }}
        className={`max-h-[92vh] max-w-[92vw] overflow-y-auto rounded-xl border bg-keep-panel p-4 text-keep-text shadow-2xl ${nudge ? "border-keep-accent ring-2 ring-keep-accent" : "border-keep-rule"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          {icon ? (
            <span className="flex h-4 w-4 items-center justify-center text-keep-accent" aria-hidden>
              {icon}
            </span>
          ) : null}
          <h3 className="flex-1 text-sm font-semibold uppercase tracking-wider">{current.title}</h3>
          <button
            type="button"
            onClick={onClose}
            title={t("coach.skipTour")}
            aria-label={t("coach.skipTour")}
            className="rounded p-0.5 text-keep-muted hover:bg-keep-bg hover:text-keep-text"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="text-sm leading-relaxed text-keep-muted">{current.body}</p>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1" aria-hidden>
            {steps.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full ${i === safeStep ? "bg-keep-accent" : "bg-keep-rule"}`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {safeStep > 0 ? (
              <button
                type="button"
                onClick={back}
                className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs text-keep-muted hover:text-keep-text"
              >
                {t("coach.back")}
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="rounded px-3 py-1 text-xs text-keep-muted hover:text-keep-text"
              >
                {t("coach.skip")}
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="rounded border border-keep-accent bg-keep-accent px-4 py-1 text-xs font-semibold text-keep-bg hover:opacity-90"
            >
              {isLast ? t("coach.gotIt") : t("coach.next")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
