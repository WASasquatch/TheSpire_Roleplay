/**
 * Hosts the Eidolon Tamer.
 *
 * On desktop (lg+) it's a free-floating, NON-modal window — no backdrop, no
 * focus trap — so the player can keep their familiar up while chatting.
 * Draggable by its titlebar (pointer events, clamped to the viewport), position
 * persisted to localStorage, with an X to close. Sits above chat but below true
 * modals. (This desktop path is the original, unchanged.)
 *
 * On mobile (< lg) a tiny draggable window is unusable, so the same content
 * fills the screen as a fullscreen modal instead. The mobile path reuses the
 * shared Modal (variant="mobile-fullscreen"), which portals to <body> and so
 * escapes the chat shell's `backdrop-filter`/`transform` frames — those make an
 * ancestor the containing block for `position: fixed`, which is what clipped the
 * inline window to a blurred frame and produced the "blank page" on phones.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../Modal";
import { EidolonTamer } from "./EidolonTamer";
import { ensureInjectedStyle } from "../../lib/injectStyle";

const POS_KEY = "tk:eidolonWindow:v1";
const WIDTH = 452;
// Matches the chat shell's lg mobile/desktop boundary (see Modal's variants).
const MOBILE_QUERY = "(max-width: 1023px)";

interface Pos { x: number; y: number }

/** Track the mobile/desktop boundary so the host swaps between the fullscreen
 *  modal (phone) and the floating window (desktop) live — on rotation, or a
 *  desktop window resize across the breakpoint. */
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

function defaultPos(): Pos {
  const w = typeof window !== "undefined" ? window.innerWidth : 1024;
  return { x: Math.max(8, w - WIDTH - 20), y: 72 };
}
function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Pos>;
      if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
    }
  } catch { /* ignore */ }
  return defaultPos();
}

export function EidolonWindow({ characterId, onClose }: { characterId: string | null; onClose: () => void }): React.JSX.Element {
  // Inject the window chrome stylesheet with the CSP nonce stamped. A plain
  // <style>{WINDOW_CSS}</style> is blocked by the strict prod CSP, so the
  // window lost its `position:fixed`/sizing/background in prod and rendered as
  // an unstyled in-flow blob (the "blank page / no window" report); dev has no
  // CSP so it looked fine.
  useEffect(() => { ensureInjectedStyle("eidolon-window-css", WINDOW_CSS); }, []);
  const mobile = useIsMobile();
  const [pos, setPos] = useState<Pos>(loadPos);
  const posRef = useRef(pos); posRef.current = pos;
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const winRef = useRef<HTMLDivElement>(null);

  const clampPos = useCallback((x: number, y: number): Pos => {
    const w = winRef.current?.offsetWidth ?? WIDTH;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - 56); // keep the titlebar grabbable
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, []);

  // Re-clamp on mount + whenever the viewport changes. Desktop only — the
  // mobile layout is the fullscreen Modal, so there's nothing to clamp.
  useEffect(() => {
    if (mobile) return;
    const reclamp = () => setPos((p) => clampPos(p.x, p.y));
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [clampPos, mobile]);

  const onDown = (e: React.PointerEvent) => {
    dragRef.current = { dx: e.clientX - posRef.current.x, dy: e.clientY - posRef.current.y };
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPos(clampPos(e.clientX - dragRef.current.dx, e.clientY - dragRef.current.dy));
  };
  const onUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    try { localStorage.setItem(POS_KEY, JSON.stringify(posRef.current)); } catch { /* ignore */ }
  };

  // Mobile: fullscreen modal. Modal owns the body portal + backdrop + Escape.
  if (mobile) {
    return (
      <Modal onClose={onClose} variant="mobile-fullscreen" zIndex={50}>
        <div className="ei-window-m" onClick={(e) => e.stopPropagation()}>
          <div className="ei-window-bar ei-window-bar--static">
            <span className="ei-window-title">🥚 Eidolon Tamer</span>
            <button className="ei-window-x" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <div className="ei-window-body">
            <EidolonTamer characterId={characterId} />
          </div>
        </div>
      </Modal>
    );
  }

  // Desktop: original free-floating, draggable window (unchanged).
  return (
    <div ref={winRef} className="ei-window" style={{ left: pos.x, top: pos.y }}>
      <div className="ei-window-bar" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <span className="ei-window-title">🥚 Eidolon Tamer</span>
        <button className="ei-window-x" onClick={onClose} aria-label="Close" onPointerDown={(e) => e.stopPropagation()}>✕</button>
      </div>
      <div className="ei-window-body">
        <EidolonTamer characterId={characterId} />
      </div>
    </div>
  );
}

const WINDOW_CSS = `
.ei-window{position:fixed; z-index:41; width:${WIDTH}px; max-width:calc(100vw - 16px); border-radius:16px; overflow:hidden;
  background:rgb(var(--keep-panel) / 1); border:1px solid rgb(var(--keep-border) / .8);
  box-shadow:0 18px 50px rgba(0,0,0,.5), 0 0 0 1px rgb(var(--keep-border) / .3);}
.ei-window-bar{display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:grab; touch-action:none; user-select:none;
  background:rgb(var(--keep-bg) / 1); border-bottom:1px solid rgb(var(--keep-border) / .6);}
.ei-window-bar:active{cursor:grabbing;}
.ei-window-title{flex:1; font-size:13px; font-weight:600; letter-spacing:.5px; color:rgb(var(--keep-text) / 1);}
.ei-window-x{flex:none; width:26px; height:26px; border-radius:8px; cursor:pointer; line-height:1; font-size:13px;
  background:rgb(var(--keep-panel) / 1); border:1px solid rgb(var(--keep-border) / .7); color:rgb(var(--keep-muted) / 1);}
.ei-window-x:hover{color:rgb(var(--keep-text) / 1); border-color:rgb(var(--keep-action) / 1);}
.ei-window-body{padding:12px;}

/* Mobile fullscreen panel — laid out by the Modal's flex backdrop (not fixed),
   so it just fills the cell. Titlebar pinned; only the body scrolls so a tall
   familiar device stays fully reachable. */
.ei-window-m{display:flex; flex-direction:column; width:100%; height:100%; overflow:hidden;
  background:rgb(var(--keep-panel) / 1);}
.ei-window-m .ei-window-bar--static{cursor:default; touch-action:auto;}
.ei-window-m .ei-window-body{flex:1 1 auto; min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch;}
`;
