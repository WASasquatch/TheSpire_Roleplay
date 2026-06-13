import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Paintbrush2, X } from "lucide-react";

/**
 * First-run coach tour for the profile bio Designer.
 *
 * Most members don't write HTML, so the Designer is now the default editing
 * surface. This walks a first-time user through the few things they need: where
 * the blocks are, that they drop onto the page and click to edit, the
 * Designer/Source toggle, and Save. It spotlights real elements (GrapesJS's
 * blocks panel + canvas, the editor's toggle + Save button) by their bounding
 * box, with a tooltip card and Back/Next/Skip controls.
 *
 * Robust by design: every step's target is OPTIONAL. GrapesJS panels mount
 * asynchronously, so each step polls briefly for its element; if it never
 * appears (or a step has no target) the card simply centers and the tour
 * continues. Nothing here can wedge the editor — the worst case is a centered
 * card instead of a spotlight.
 *
 * Positioning uses inline `style` (CSP `style-src-attr` allows it) — no
 * injected stylesheet, no React `<style>`.
 */

interface TourStep {
  title: string;
  body: string;
  /** Candidate selectors, first match wins. Omit for a centered step. */
  targets?: string[];
}

// Copy follows the help-content voice: plain, friendly, no dev jargon.
const STEPS: TourStep[] = [
  {
    title: "Welcome to the Designer",
    body: "Build your profile by dragging pieces onto the page. No code needed. Here's a quick tour.",
  },
  {
    title: "Your building blocks",
    body: "Drag any of these onto the page. The themed templates are ready-made styled sections; the plain blocks let you build your own. Hover one to preview what it is.",
    targets: [".gjs-blocks-c", ".gjs-pn-views-container", ".profile-designer"],
  },
  {
    title: "Your profile page",
    body: "Drop blocks here, then click any text to type your own. Select a piece to move or restyle it.",
    targets: [".gjs-cv-canvas", ".profile-designer"],
  },
  {
    title: "Designer or code",
    body: "Prefer writing your own HTML and CSS? Switch to Source any time. Your work carries across both ways.",
    targets: ['[data-tour="bio-mode-toggle"]'],
  },
  {
    title: "Save when you're ready",
    body: "Happy with it? Hit Save to publish your profile. You can come back and tweak it whenever you like.",
    targets: ['[data-tour="profile-save"]'],
  },
];

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

export function DesignerTour({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, forceTick] = useState(0);

  const current = STEPS[step]!;
  const isLast = step === STEPS.length - 1;

  // Resolve + track the current step's target rect. Polls briefly for late-
  // mounting GrapesJS panels, then follows it on scroll/resize.
  useLayoutEffect(() => {
    let raf = 0;
    let tries = 0;
    const measure = () => {
      const el = findTarget(current.targets);
      if (el) {
        setRect(el.getBoundingClientRect());
        return true;
      }
      setRect(null);
      return false;
    };
    const poll = () => {
      if (measure() || tries > 40) return; // ~40 frames (~0.7s) then give up
      tries += 1;
      raf = requestAnimationFrame(poll);
    };
    poll();
    const onMove = () => measure();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [current]);

  // Reposition once more after fonts/layout settle on the very first paint.
  useEffect(() => {
    const t = setTimeout(() => forceTick((n) => n + 1), 50);
    return () => clearTimeout(t);
  }, []);

  const next = useCallback(() => {
    if (isLast) onClose();
    else setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }, [isLast, onClose]);
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

  // Card placement: below the target if it fits, else above; centered when
  // there's no target. Clamped into the viewport.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  let cardStyle: React.CSSProperties;
  if (rect) {
    const below = rect.bottom + 12;
    const placeBelow = below + 180 < vh;
    const top = placeBelow ? below : Math.max(12, rect.top - 12 - 180);
    let left = rect.left + rect.width / 2 - CARD_W / 2;
    left = Math.max(12, Math.min(left, vw - CARD_W - 12));
    cardStyle = { position: "fixed", top, left, width: CARD_W };
  } else {
    cardStyle = {
      position: "fixed",
      top: "50%",
      left: "50%",
      width: CARD_W,
      transform: "translate(-50%, -50%)",
    };
  }

  return createPortal(
    <div className="fixed inset-0 z-[200]" aria-modal role="dialog">
      {/* Click-catcher: dims the page and blocks stray interaction. When there's
          no spotlight target it provides the dim itself. */}
      <div
        className="absolute inset-0"
        style={{ background: rect ? "transparent" : "rgba(8,10,18,0.62)" }}
        onClick={onClose}
      />

      {/* Spotlight. Dim (a giant box-shadow) lives on this div; the accent ring
          is a separate outline so a theme-var hiccup can't drop the dim too. */}
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
            transition: "all .25s ease",
          }}
        />
      ) : null}

      {/* Tooltip card. */}
      <div
        style={cardStyle}
        className="max-w-[92vw] rounded-xl border border-keep-rule bg-keep-panel p-4 text-keep-text shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <Paintbrush2 className="h-4 w-4 text-keep-accent" aria-hidden />
          <h3 className="flex-1 text-sm font-semibold uppercase tracking-wider">{current.title}</h3>
          <button
            type="button"
            onClick={onClose}
            title="Skip the tour"
            aria-label="Skip the tour"
            className="rounded p-0.5 text-keep-muted hover:bg-keep-bg hover:text-keep-text"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="text-sm leading-relaxed text-keep-muted">{current.body}</p>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1" aria-hidden>
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full ${i === step ? "bg-keep-accent" : "bg-keep-rule"}`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 ? (
              <button
                type="button"
                onClick={back}
                className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs text-keep-muted hover:text-keep-text"
              >
                Back
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="rounded px-3 py-1 text-xs text-keep-muted hover:text-keep-text"
              >
                Skip
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="rounded border border-keep-accent bg-keep-accent px-4 py-1 text-xs font-semibold text-keep-bg hover:opacity-90"
            >
              {isLast ? "Got it" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
