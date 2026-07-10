/**
 * FloatingWindow — the modular in-page window every heavyweight modal can
 * opt into (the Eidolon arcade window generalized).
 *
 * Desktop (lg+): a free-floating, NON-modal window — no backdrop, no focus
 * trap — so the page behind stays fully usable (work on a world while
 * chatting). Draggable by its titlebar, resizable from the bottom-right
 * and bottom-left corners, collapsible to just the titlebar (children stay
 * MOUNTED while collapsed, so no state is lost), and clicking anywhere on
 * a window raises it above sibling windows. Position and size deliberately
 * RESET on every open (no persistence) so a window can never come back
 * stranded off-screen.
 *
 * Mobile (< lg): a tiny draggable window is unusable, so the same content
 * renders fullscreen behind a dimmed backdrop with a static titlebar —
 * the classic Modal "mobile-fullscreen" behavior (backdrop tap + Escape
 * close). Both modes render ONE tree shape through the same portal, so
 * crossing the lg breakpoint (browser zoom, tablet rotation, window snap)
 * reconciles in place and children keep their state instead of
 * remounting.
 *
 * Escape deliberately does NOT close the desktop window: it's a
 * workspace, not a dialog, and an accidental Esc mid-chat must never nuke
 * an editor full of unsaved work. (The mobile path keeps Escape.)
 *
 * Raise-on-click renumbers z-indexes through a module-level window stack
 * (Z_BASE..Z_BASE+n, always BELOW the true-modal base of 40). It must
 * never move DOM nodes: reparenting a window that contains an <iframe>
 * (the GrapesJS profile-designer canvas) would reload the iframe and
 * wipe the edit in progress. The app shell is itself a body-level
 * stacking context at level ~0, so any positive z here paints above the
 * whole page while every body-portaled true modal (40+) stays on top.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { CloseButton } from "./CloseButton.js";

/** Matches the chat shell's lg mobile/desktop boundary (see Modal). */
const MOBILE_QUERY = "(max-width: 1023px)";
const MIN_W = 420;
const MIN_H = 280;
/** Keep at least this much titlebar reachable when clamping. */
const BAR_GRAB_PX = 56;

/** Fired on window whenever a drag/resize gesture ends. Components that
 *  cache viewport offsets (GrapesJS caches its canvas offset and only
 *  invalidates on browser-window resize/scroll) listen for this to
 *  refresh — a titlebar drag moves the canvas without firing either. */
export const FLOATING_WINDOW_MOVED_EVENT = "thekeep:floating-window-moved";

/** Desktop stacking plane: windows live at 30..39, strictly below the
 *  shared Modal base (40) so any true modal opened from the still-usable
 *  page (room password, bookmarks, server info) always paints above every
 *  window. Raising reorders this stack and renumbers members' z-indexes —
 *  never grows past the plane, never touches the DOM. */
const Z_BASE = 30;
/** Hard ceiling: the plane must NEVER reach the true-modal base (40) no
 *  matter how many windows are open — 10+ concurrent windows saturate at
 *  39 and resolve ties by mount order, which beats painting over a
 *  room-password prompt. */
const Z_MAX = 39;
interface StackEntry { id: number; setZ: (z: number) => void }
let nextStackId = 0;
const stack: StackEntry[] = [];
function renumberStack() {
  stack.forEach((w, i) => w.setZ(Math.min(Z_BASE + i, Z_MAX)));
}

interface Props {
  /** Titlebar text (the drag handle's label). */
  title: ReactNode;
  onClose: () => void;
  /** MOBILE stacking plane only (the fullscreen fallback's backdrop).
   *  Desktop stacking is managed by the shared window registry (30..39,
   *  always under true modals at 40+), so nested modals/pickers opened
   *  from inside should keep using 50/60/70 as they already do. */
  zIndex?: number;
  /** Decoration for the window shell (frame, background). The shell always
   *  adds layout + shadow itself. */
  className?: string;
  /** Desktop initial size; defaults mirror the classic modal card
   *  (75vw × 90vh, capped). Clamped to the viewport either way. */
  initialWidth?: number;
  initialHeight?: number;
  /** Extra inline style for the window shell (e.g. a world's scoped theme
   *  CSS variables). Position/size styles always win over it. */
  style?: React.CSSProperties;
  /** Keydown hook for the whole window INCLUDING the titlebar chrome
   *  (Admin's Ctrl/Cmd+K find-a-setting). Attached above the bar so focus
   *  resting on the collapse/close buttons still reaches it. */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  /** Extra attributes for the OUTER wrapper (an ANCESTOR of the shell).
   *  Exists for scoped-design attributes like ProfileModal's
   *  `data-theme-style`: every `[data-theme-style] .keep-frame` rule in
   *  styles.css uses a descendant combinator, so the shell can only pick
   *  up an owner's design from an element above it. Spread first — the
   *  window's own props always win. */
  outerAttrs?: Record<string, string>;
  /** Raise the window whenever this value CHANGES. For windows whose one
   *  mounted instance swaps content in place (the profile window showing
   *  a different profile): without this, clicking person B inside another
   *  window raises THAT window at pointerdown, the profile swaps behind
   *  it, and "nothing happens". Mount already raises, so a constant key
   *  is a no-op. */
  raiseKey?: string | number;
  children: ReactNode;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

interface Box { x: number; y: number; w: number; h: number }

function initialBox(initialWidth?: number, initialHeight?: number): Box {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Default matches the classic modal card exactly (MODAL_CARD_CONTENT:
  // 75vw × 90vh, max-w 2400) so converted surfaces open at the size users
  // already know.
  const w = Math.max(MIN_W, Math.min(initialWidth ?? Math.min(vw * 0.75, 2400), vw - 16));
  const h = Math.max(MIN_H, Math.min(initialHeight ?? vh * 0.9, vh - 16));
  // Centered horizontally, biased slightly upward — the classic modal spot.
  return { x: Math.max(8, (vw - w) / 2), y: Math.max(8, (vh - h) / 2.5), w, h };
}

export function FloatingWindow({
  title,
  onClose,
  zIndex = 40,
  className = "keep-frame rounded border border-keep-border bg-keep-bg",
  initialWidth,
  initialHeight,
  style,
  onKeyDown,
  outerAttrs,
  raiseKey,
  children,
}: Props) {
  const { t } = useTranslation("common");
  const mobile = useIsMobile();
  const reduceMotion = useReducedMotion();
  const titleId = useId();
  const [box, setBox] = useState<Box>(() => initialBox(initialWidth, initialHeight));
  const [collapsed, setCollapsed] = useState(false);
  const boxRef = useRef(box);
  boxRef.current = box;
  // Per-window portal host on <body>. Appended ONCE; raising never moves
  // it (see file comment — a re-append would reload iframes inside).
  const [host] = useState(() => document.createElement("div"));
  useEffect(() => {
    document.body.appendChild(host);
    return () => { host.remove(); };
  }, [host]);

  // Desktop stack membership: register on mount (top of stack), renumber
  // everyone on any change so the plane never drifts past Z_BASE + n.
  const stackIdRef = useRef(-1);
  const [stackZ, setStackZ] = useState(Z_BASE);
  useEffect(() => {
    if (mobile) return;
    const entry: StackEntry = { id: nextStackId++, setZ: setStackZ };
    stackIdRef.current = entry.id;
    stack.push(entry);
    renumberStack();
    return () => {
      const i = stack.findIndex((w) => w.id === entry.id);
      if (i >= 0) {
        stack.splice(i, 1);
        renumberStack();
      }
    };
  }, [mobile]);
  const bringToFront = useCallback(() => {
    const i = stack.findIndex((w) => w.id === stackIdRef.current);
    if (i >= 0 && i !== stack.length - 1) {
      stack.push(...stack.splice(i, 1));
      renumberStack();
    }
  }, []);
  // Content-swap raise (see the raiseKey prop doc). Mount is already
  // top-of-stack, so the initial run is a no-op.
  useEffect(() => {
    if (mobile || raiseKey === undefined) return;
    bringToFront();
  }, [mobile, raiseKey, bringToFront]);

  // Mobile keeps the classic Modal Escape-to-close; desktop deliberately
  // does not (see file comment).
  useEffect(() => {
    if (!mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobile, onClose]);

  const clamp = useCallback((b: Box): Box => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.max(MIN_W, Math.min(b.w, vw));
    const h = Math.max(MIN_H, Math.min(b.h, vh));
    return {
      w,
      h,
      x: Math.min(Math.max(8 - w + BAR_GRAB_PX, b.x), vw - BAR_GRAB_PX),
      y: Math.min(Math.max(0, b.y), vh - BAR_GRAB_PX),
    };
  }, []);

  // Re-clamp when the viewport shrinks so the titlebar stays reachable.
  useEffect(() => {
    if (mobile) return;
    const reclamp = () => setBox((b) => clamp(b));
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [clamp, mobile]);

  /** One pointer-capture gesture, owned by a single pointerId: `apply`
   *  maps pointer position → next box. Events from other pointers are
   *  ignored so a second touch can't hijack or strand an active drag. */
  const gestureRef = useRef<{ pointerId: number; apply: (cx: number, cy: number) => Box } | null>(null);
  // A breakpoint flip mid-gesture swaps the bar to its static form and
  // unmounts the grips, so the pointerup that would end the gesture is
  // never observed; drop the gesture or its stale guard would block every
  // future drag/resize once back on desktop.
  useEffect(() => {
    gestureRef.current = null;
  }, [mobile]);
  const startGesture = (e: React.PointerEvent, apply: (dx: number, dy: number, start: Box) => Box) => {
    // Primary button only (right-drag must open the context menu, not move
    // the window), and never mid-gesture.
    if (gestureRef.current || e.button !== 0) return;
    const start = boxRef.current;
    const ox = e.clientX;
    const oy = e.clientY;
    gestureRef.current = {
      pointerId: e.pointerId,
      apply: (cx, cy) => clamp(apply(cx - ox, cy - oy, start)),
    };
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  };
  const onGestureMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    setBox(g.apply(e.clientX, e.clientY));
  };
  // Shared by pointerup, pointercancel AND lostpointercapture: a cancelled
  // capture fires NO pointerup, and without this the dead gesture would
  // keep dragging the window on mere hover.
  const endGesture = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    gestureRef.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    window.dispatchEvent(new Event(FLOATING_WINDOW_MOVED_EVENT));
  };
  const gestureHandlers = {
    onPointerMove: onGestureMove,
    onPointerUp: endGesture,
    onPointerCancel: endGesture,
    onLostPointerCapture: endGesture,
  };

  const onBarDown = (e: React.PointerEvent) => {
    // Buttons on the bar (collapse/close) must stay clickable, not draggy.
    if ((e.target as HTMLElement).closest("button")) return;
    startGesture(e, (dx, dy, s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
  };
  const onResizeRightDown = (e: React.PointerEvent) =>
    startGesture(e, (dx, dy, s) => ({ ...s, w: s.w + dx, h: s.h + dy }));
  const onResizeLeftDown = (e: React.PointerEvent) =>
    startGesture(e, (dx, dy, s) => {
      // Left edge follows the pointer; width compensates so the right edge
      // stays planted. ALL width caps live here so x can always be
      // re-derived from that planted edge — otherwise the outer clamp()
      // would cap w and x independently and the right edge would slide.
      const right = s.x + s.w;
      const vw = window.innerWidth;
      const w = Math.min(Math.max(MIN_W, right - (vw - BAR_GRAB_PX), s.w - dx), vw);
      return { ...s, x: right - w, w, h: s.h + dy };
    });

  const bar = (staticBar: boolean) => (
    <div
      className={`flex shrink-0 items-center gap-2 border-b border-keep-border bg-keep-panel px-3 py-2 ${
        staticBar ? "" : "cursor-move touch-none select-none"
      }`}
      {...(staticBar ? {} : { onPointerDown: onBarDown, ...gestureHandlers })}
    >
      <h2 id={titleId} className="min-w-0 flex-1 truncate font-action text-lg">{title}</h2>
      {!staticBar ? (
        <button
          type="button"
          onClick={() => {
            // Collapsing unmounts the resize grips; drop any gesture they
            // owned so a stranded capture can't keep resizing on hover.
            gestureRef.current = null;
            setCollapsed((c) => !c);
          }}
          title={collapsed ? t("window.expand") : t("window.collapse")}
          aria-label={collapsed ? t("window.expand") : t("window.collapse")}
          aria-expanded={!collapsed}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-keep-muted hover:bg-keep-banner hover:text-keep-text"
        >
          {collapsed ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronUp className="h-4 w-4" aria-hidden />}
        </button>
      ) : null}
      <CloseButton onClick={onClose} />
    </div>
  );

  // ONE tree for both modes — only the chrome props flip. The wrapper,
  // shell, bar and content divs keep their positions so React reconciles
  // a breakpoint crossing in place and children never remount.
  return createPortal(
    <div
      {...outerAttrs}
      role="dialog"
      aria-modal={mobile ? "true" : undefined}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onClick={mobile ? onClose : undefined}
      style={{ zIndex: mobile ? zIndex : stackZ }}
      className={
        mobile
          ? `fixed inset-0 flex items-stretch justify-stretch bg-black/40${reduceMotion ? " tk-fade-in" : ""}`
          : "pointer-events-none fixed inset-0"
      }
    >
      <div
        onClick={mobile ? (e) => e.stopPropagation() : undefined}
        onPointerDownCapture={mobile ? undefined : bringToFront}
        style={
          mobile
            ? style
            : { ...style, left: box.x, top: box.y, width: box.w, ...(collapsed ? {} : { height: box.h }) }
        }
        className={`${
          mobile ? "flex h-full w-full flex-col" : "pointer-events-auto absolute flex flex-col shadow-2xl"
        } overflow-hidden ${className}`}
      >
        {bar(mobile)}
        {/* Children stay mounted while collapsed (display:none) so editors
            keep their unsaved state; only the box shrinks to the bar.

            `container-type: inline-size` makes this content box a CSS
            container: window contents must key their layout splits
            (rails, side-by-side panes, grids) on `[@container(min-width:
            …px)]:` variants instead of viewport `lg:`/`md:` — the window
            is user-resizable, so viewport media queries lie about the
            space actually available and desktop layouts would clip
            instead of adapting. On the mobile fullscreen path the
            container equals the viewport, so container variants behave
            exactly like the media queries they replace. */}
        <div
          style={!mobile && collapsed ? { display: "none" } : undefined}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden [container-type:inline-size]"
        >
          {children}
        </div>
        {!mobile && !collapsed ? (
          <>
            {/* Corner resize grips. Generous hit areas; the visible notch is
                subtle so it doesn't fight the content. */}
            <div
              onPointerDown={onResizeRightDown}
              {...gestureHandlers}
              className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize touch-none"
              title={t("window.resize")}
              aria-hidden
            >
              <div className="absolute bottom-1 right-1 h-2.5 w-2.5 border-b-2 border-r-2 border-keep-muted/60" />
            </div>
            <div
              onPointerDown={onResizeLeftDown}
              {...gestureHandlers}
              className="absolute bottom-0 left-0 h-5 w-5 cursor-nesw-resize touch-none"
              title={t("window.resize")}
              aria-hidden
            >
              <div className="absolute bottom-1 left-1 h-2.5 w-2.5 border-b-2 border-l-2 border-keep-muted/60" />
            </div>
          </>
        ) : null}
      </div>
    </div>,
    host,
  );
}
