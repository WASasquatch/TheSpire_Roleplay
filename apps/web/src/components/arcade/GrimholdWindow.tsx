/**
 * Hosts the Grimhold cabinet (Spire Arcade game #3) — six small score
 * games in a self-contained, vendored static bundle served from
 * `/games/grimhold/index.html` (apps/web/public/games/grimhold).
 *
 * Like the Eidolon Tamer, this is a FREE-FLOATING, NON-modal window on
 * desktop (lg+): no backdrop, no focus trap, draggable by its titlebar,
 * position persisted to localStorage, with an X to close, so the player
 * can keep a game up while reading/posting. On mobile (< lg) a tiny
 * draggable window is unusable, so it falls back to a fullscreen modal.
 *
 * The bundle is untrusted; a tiny additive bridge posts events up via
 * postMessage. This component owns the server-authoritative run session:
 *   - on open it calls /arcade/grimhold/start for a runId, handed to the
 *     bundle via the `init` handshake;
 *   - each `score` event (a finished game) is forwarded to
 *     /arcade/grimhold/score for validation + crediting;
 *   - closing the window calls /arcade/grimhold/end.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Modal } from "../cosmetics/Modal";
import { ensureInjectedStyle } from "../../lib/injectStyle";
import { endGrimholdRun, reportGrimholdScore, startGrimholdRun } from "../../lib/grimhold";

const GAME_SRC = "/games/grimhold/index.html";
const POS_KEY = "tk:grimholdWindow:v1";
const WIDTH = 520;
const MOBILE_QUERY = "(max-width: 1023px)";

interface Pos { x: number; y: number }

/** Events the vendored bridge emits. */
interface GrimholdEvent {
  source: "grimhold";
  type: "ready" | "score" | "resize";
  game?: string;
  score?: number;
  elapsedMs?: number;
  height?: number;
}

/** Fallback body height before the bundle reports its own (the cabinet's
 *  height is aspect-driven by WIDTH; see the bundle's reportHeight). */
const DEFAULT_BODY_H = 760;

/** Track the mobile/desktop boundary so the host swaps between fullscreen
 *  modal (phone) and floating window (desktop) live. */
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
  return { x: Math.max(8, w - WIDTH - 20), y: 64 };
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

export function GrimholdWindow({ characterId, onClose }: { characterId: string | null; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation("arcade");
  // Inject the window chrome with the CSP nonce stamped (a plain <style> is
  // blocked by the strict prod CSP, same gotcha EidolonWindow documents).
  useEffect(() => { ensureInjectedStyle("grimhold-window-css", WINDOW_CSS); }, []);

  const mobile = useIsMobile();
  const [pos, setPos] = useState<Pos>(loadPos);
  const posRef = useRef(pos); posRef.current = pos;
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const winRef = useRef<HTMLDivElement>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const runIdRef = useRef<string | null>(null);
  const frameLoadedRef = useRef(false);
  const endedRef = useRef(false);
  const [lastAward, setLastAward] = useState<{ currency: number; xp: number } | null>(null);
  // Body height, driven by the bundle's reported content height so the
  // on-screen controls are never clipped. Clamped to the viewport.
  const [bodyH, setBodyH] = useState<number>(DEFAULT_BODY_H);

  /* ---- draggable titlebar (desktop) ---- */
  const clampPos = useCallback((x: number, y: number): Pos => {
    const w = winRef.current?.offsetWidth ?? WIDTH;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - 56);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, []);
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

  /* ---- run session + bridge ---- */
  const sendInit = () => {
    if (!frameLoadedRef.current || !runIdRef.current) return;
    iframeRef.current?.contentWindow?.postMessage(
      { source: "spire", type: "init", runId: runIdRef.current },
      window.location.origin,
    );
  };

  useEffect(() => {
    let cancelled = false;
    startGrimholdRun(characterId)
      .then((id) => { if (!cancelled) { runIdRef.current = id; sendInit(); } })
      .catch(() => { /* rewards just won't be tracked this session */ });
    return () => {
      cancelled = true;
      const id = runIdRef.current;
      if (id && !endedRef.current) {
        endedRef.current = true;
        void endGrimholdRun(id, characterId);
      }
    };
    // characterId is fixed for the lifetime of an open window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const d = ev.data as Partial<GrimholdEvent> | null;
      if (!d || d.source !== "grimhold") return;
      const evt = d as GrimholdEvent;
      const runId = runIdRef.current;
      switch (evt.type) {
        case "ready":
          sendInit();
          break;
        case "resize":
          if (typeof evt.height === "number" && evt.height > 0) {
            // Clamp so a tall game never runs off a short screen; the
            // bundle's canvas scales to whatever height it gets.
            const max = Math.max(320, window.innerHeight - 96);
            setBodyH(Math.min(Math.round(evt.height), max));
          }
          break;
        case "score":
          if (runId && typeof evt.game === "string" && typeof evt.score === "number" && typeof evt.elapsedMs === "number") {
            void reportGrimholdScore(runId, characterId, evt.game, evt.score, evt.elapsedMs)
              .then((res) => {
                if (res.credited && (res.award.currency > 0 || res.award.xp > 0)) setLastAward(res.award);
              })
              .catch(() => { /* ignore */ });
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFrameLoad = () => {
    frameLoadedRef.current = true;
    sendInit();
  };

  // The iframe is shared by both layouts. Crossing the breakpoint mid-game
  // remounts it (a rare reload), same trade-off EidolonWindow accepts.
  const frame = (
    <iframe
      ref={iframeRef}
      title={t("arcade.games.grimhold")}
      src={GAME_SRC}
      onLoad={onFrameLoad}
      sandbox="allow-scripts allow-same-origin"
      allow="autoplay"
    />
  );
  const awardChip = lastAward ? (
    <span className="gh-window-award">{t("arcade.grimhold.award", { currency: lastAward.currency, xp: lastAward.xp })}</span>
  ) : null;

  // Mobile: fullscreen modal (a tiny draggable window is unusable).
  if (mobile) {
    return (
      <Modal onClose={onClose} variant="mobile-fullscreen" zIndex={50}>
        <div className="gh-window-m" onClick={(e) => e.stopPropagation()}>
          <div className="gh-window-bar gh-window-bar--static">
            <span className="gh-window-title">{t("arcade.grimhold.windowTitle")}</span>
            {awardChip}
            <button className="gh-window-x" onClick={onClose} aria-label={t("common:close")}>✕</button>
          </div>
          <div className="gh-window-body">{frame}</div>
        </div>
      </Modal>
    );
  }

  // Desktop: free-floating, draggable, non-modal window. Portaled to
  // <body> so its z-index:39 applies at body level — the TOP of the
  // FloatingWindow plane (30..39), strictly below true modals (40+) —
  // instead of being trapped under every floating window inside the
  // shell's stacking context. Portaled from the FIRST render, so the
  // game iframe is never reparented (a move would reload it).
  return createPortal(
    <div ref={winRef} className="gh-window" style={{ left: pos.x, top: pos.y }}>
      <div className="gh-window-bar" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <span className="gh-window-title">{t("arcade.grimhold.windowTitle")}</span>
        {awardChip}
        <button className="gh-window-x" onClick={onClose} aria-label={t("common:close")} onPointerDown={(e) => e.stopPropagation()}>✕</button>
      </div>
      <div className="gh-window-body" style={{ height: bodyH }}>{frame}</div>
    </div>,
    document.body,
  );
}

const WINDOW_CSS = `
.gh-window{position:fixed; z-index:39; width:${WIDTH}px; max-width:calc(100vw - 16px); border-radius:14px; overflow:hidden;
  background:rgb(var(--keep-panel) / 1); border:1px solid rgb(var(--keep-border) / .8);
  box-shadow:0 18px 50px rgba(0,0,0,.5), 0 0 0 1px rgb(var(--keep-border) / .3);}
.gh-window-bar{display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:grab; touch-action:none; user-select:none;
  background:rgb(var(--keep-bg) / 1); border-bottom:1px solid rgb(var(--keep-border) / .6);}
.gh-window-bar:active{cursor:grabbing;}
.gh-window-title{flex:1; font-size:13px; font-weight:600; letter-spacing:.5px; color:rgb(var(--keep-text) / 1);}
.gh-window-award{flex:none; font-size:11px; opacity:.6; color:rgb(var(--keep-text) / 1);}
.gh-window-x{flex:none; width:26px; height:26px; border-radius:8px; cursor:pointer; line-height:1; font-size:13px;
  background:rgb(var(--keep-panel) / 1); border:1px solid rgb(var(--keep-border) / .7); color:rgb(var(--keep-muted) / 1);}
.gh-window-x:hover{color:rgb(var(--keep-text) / 1); border-color:rgb(var(--keep-action) / 1);}
/* The body holds the game iframe. Its height is set inline from the
   bundle's reported content height (the cabinet is aspect-driven by width,
   so a fixed height clipped the on-screen controls). */
.gh-window-body{background:#0a0613;}
.gh-window-body iframe{display:block; width:100%; height:100%; border:0; background:#0a0613;}

/* Mobile fullscreen panel — laid out by the Modal's flex backdrop. */
.gh-window-m{display:flex; flex-direction:column; width:100%; height:100%; overflow:hidden; background:rgb(var(--keep-panel) / 1);}
.gh-window-m .gh-window-bar--static{cursor:default; touch-action:auto;}
.gh-window-m .gh-window-body{flex:1 1 auto; min-height:0; height:auto; max-height:none;}
`;
