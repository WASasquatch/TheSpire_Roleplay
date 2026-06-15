/**
 * Hosts "Urugal's Descent" (Spire Arcade game #2).
 *
 * The game is a self-contained, vendored static bundle served from
 * `/games/urugal/index.html` (see apps/web/public/games/urugal). It is
 * NOT under the `/arcade` path on purpose: Vite proxies all of `/arcade`
 * to the backend in dev, which would shadow a static bundle there.
 * It runs inside a sandboxed same-origin iframe; a tiny additive bridge
 * inside that bundle posts milestone events (`ready`, `floor`, `boss`,
 * `xp`, `levelup`, `death`) up to this parent via postMessage.
 *
 * This component owns the server-authoritative run session:
 *   - on open it calls /arcade/urugal/start to get a runId, then hands
 *     that runId to the game via the `init` handshake;
 *   - `floor` / `boss` events are forwarded to /arcade/urugal/event for
 *     validation + scoring;
 *   - `death` and closing the window call /arcade/urugal/end.
 *
 * PHASE 3: events are validated + scored server-side but rewards are not
 * credited yet (the server logs the intended award). The titlebar shows
 * the latest milestone for visibility while we wire things up.
 */
import React, { useEffect, useRef, useState } from "react";
import { Modal, MODAL_CARD_CONTENT } from "../Modal";
import { endUrugalRun, reportUrugalEvent, startUrugalRun } from "../../lib/urugal";

const GAME_SRC = "/games/urugal/index.html";

/** Events the vendored bridge emits (kept loose until a schema is pinned). */
interface UrugalEvent {
  source: "urugal";
  v: number;
  type: "ready" | "floor" | "boss" | "xp" | "levelup" | "death";
  runId: string | null;
  tMs: number;
  floor?: number;
  level?: number;
  xp?: number;
  gold?: number;
  cls?: string | null;
}

export function UrugalWindow({ characterId, onClose }: { characterId: string | null; onClose: () => void }): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const runIdRef = useRef<string | null>(null);
  const frameLoadedRef = useRef(false);
  const endedRef = useRef(false);
  const [last, setLast] = useState<UrugalEvent | null>(null);

  // Hand the server-issued runId to the game once BOTH the frame has
  // loaded and the run has started. Safe to call repeatedly (idempotent
  // on the bridge side — it just (re)sets runId + restarts its clock).
  const sendInit = () => {
    if (!frameLoadedRef.current || !runIdRef.current) return;
    iframeRef.current?.contentWindow?.postMessage(
      { source: "spire", type: "init", runId: runIdRef.current },
      window.location.origin,
    );
  };

  // Start the run when the window opens; end it when the window closes.
  useEffect(() => {
    let cancelled = false;
    startUrugalRun(characterId)
      .then((id) => { if (!cancelled) { runIdRef.current = id; sendInit(); } })
      .catch(() => { /* rewards just won't be tracked this session */ });
    return () => {
      cancelled = true;
      const id = runIdRef.current;
      if (id && !endedRef.current) {
        endedRef.current = true;
        void endUrugalRun(id, characterId).catch(() => { /* best-effort */ });
      }
    };
    // characterId is fixed for the lifetime of an open window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for the game's milestone events and forward them to the server.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const d = ev.data as Partial<UrugalEvent> | null;
      if (!d || d.source !== "urugal") return;
      const evt = d as UrugalEvent;
      setLast(evt);

      const runId = runIdRef.current;
      switch (evt.type) {
        case "ready":
          // Bridge announced itself — (re)send the init in case the run
          // started before the frame finished loading.
          sendInit();
          break;
        case "floor":
        case "boss":
          if (runId && typeof evt.floor === "number") {
            void reportUrugalEvent(runId, characterId, evt.type, evt.floor).catch(() => { /* ignore */ });
          }
          break;
        case "death":
          if (runId && !endedRef.current) {
            endedRef.current = true;
            void endUrugalRun(runId, characterId).catch(() => { /* ignore */ });
          }
          break;
        default:
          break; // xp / levelup: not scored server-side
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

  return (
    <Modal onClose={onClose} variant="mobile-fullscreen" zIndex={50}>
      <div
        className={`${MODAL_CARD_CONTENT} bg-keep-bg`}
        style={{ borderRadius: 0, border: "1px solid rgb(var(--keep-border) / .6)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ background: "rgb(var(--keep-panel) / 1)", borderBottom: "1px solid rgb(var(--keep-border) / .6)" }}
        >
          <span className="flex-1 truncate" style={{ fontSize: 13, fontWeight: 600, letterSpacing: 0.5 }}>
            🗡 Urugal&apos;s Descent
          </span>
          {last ? (
            <span className="hidden sm:inline" style={{ fontSize: 11, opacity: 0.5 }}>
              {last.type}{typeof last.floor === "number" ? ` · floor ${last.floor}` : ""}
            </span>
          ) : null}
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 28, height: 28, borderRadius: 8, lineHeight: 1, fontSize: 13, cursor: "pointer",
              background: "rgb(var(--keep-panel) / 1)", border: "1px solid rgb(var(--keep-border) / .7)",
              color: "rgb(var(--keep-muted) / 1)",
            }}
          >
            ✕
          </button>
        </div>
        <iframe
          ref={iframeRef}
          title="Urugal's Descent"
          src={GAME_SRC}
          onLoad={onFrameLoad}
          sandbox="allow-scripts allow-same-origin"
          allow="autoplay"
          style={{ flex: "1 1 auto", minHeight: 0, width: "100%", border: "none", display: "block", background: "#0b0b10" }}
        />
      </div>
    </Modal>
  );
}
