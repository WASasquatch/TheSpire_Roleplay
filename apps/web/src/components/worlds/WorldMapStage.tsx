/**
 * Interactive world-map stage: an <img> (never inline SVG — scripts stay
 * inert) inside a translated/scaled layer, with markers positioned from
 * NATURAL-image-dimension fractions so they never drift when the window
 * or image is resized. Gestures follow the FloatingWindow lesson: the
 * stage only sees pointerdown; move/up/cancel ride window-level listeners
 * so React re-parenting can't drop a drag mid-flight. Two pointers pinch,
 * one pans (or drags a marker in edit mode), wheel zooms at the cursor,
 * double-click steps the zoom. All view changes are applied instantly —
 * no animated transitions — so Reduce Motion needs no special casing.
 */
import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Expand, ImageOff, Maximize, Minus, Plus, Shrink } from "lucide-react";
import type { WorldMap, WorldMapMarker } from "@thekeep/shared";
import { EVENT_ICONS } from "../../lib/eventIcons.js";
import { safeCssColor } from "../shared/RoleBadgeChips.js";
import { FLOATING_WINDOW_MOVED_EVENT } from "../shared/FloatingWindow.js";

/** Display metadata the parent resolves per marker kind (label localized,
 *  icon = emoji glyph or lucide slug, color = CSS color). */
export interface MarkerKindMeta {
  label: string;
  icon: string | null;
  color: string;
}

export interface MapStageHandle {
  /** Pan + zoom so the marker sits centered (the sidebar's jump-to). */
  jumpToMarker: (m: WorldMapMarker) => void;
  /** Back to fit-to-container. */
  resetView: () => void;
}

/**
 * A jump-to-marker request that survives the stage not being ready yet
 * (image still measuring): the stage flies as soon as it can, once per
 * `seq`. Used by the viewer's "Show on map" / index deep-links, where the
 * request often arrives before the map image has loaded.
 */
export interface MapFlyRequest {
  marker: WorldMapMarker;
  seq: number;
}

interface View {
  /** CSS px per natural image px. */
  scale: number;
  tx: number;
  ty: number;
}

const MARKER_SIZE_PX = { sm: 18, md: 24, lg: 32, xl: 42 } as const;
const LABEL_FONT_PX = { sm: 10, md: 12, lg: 15, xl: 19 } as const;
/** Max zoom = 8× the fitted scale. */
const MAX_ZOOM_FACTOR = 8;
/** Pixels of map that must stay inside the container when panning. */
const MIN_VISIBLE_PX = 48;
/** Pointer travel (px) below which a gesture still counts as a click. */
const CLICK_SLOP_PX = 5;

interface Gesture {
  pointers: Map<number, { x: number; y: number }>;
  mode: "pan" | "pinch" | "marker";
  marker: WorldMapMarker | null;
  /** Marker the gesture STARTED on (click detection in view mode). */
  downMarker: WorldMapMarker | null;
  moved: boolean;
  startView: View;
  start: { x: number; y: number };
  startDist: number;
  /** Natural-image point under the pinch midpoint at pinch start. */
  pinchAnchor: { x: number; y: number };
}

export const WorldMapStage = forwardRef<MapStageHandle, {
  map: WorldMap;
  markers: WorldMapMarker[];
  kindMeta: (kind: string) => MarkerKindMeta;
  /** Edit mode: click-empty places, markers drag. */
  canEdit?: boolean;
  selectedMarkerId?: string | null;
  onMarkerClick?: (m: WorldMapMarker) => void;
  /** Edit mode: tap on empty map space (fractions of natural dims). */
  onPlace?: (x: number, y: number) => void;
  /** Edit mode: marker dropped after a drag (fractions, clamped 0..1). */
  onMarkerMove?: (m: WorldMapMarker, x: number, y: number) => void;
  /** Natural dimensions measured on image load (editors PATCH them back). */
  onImageSize?: (width: number, height: number) => void;
  /** Fullscreen-within-window toggle state; the control only renders
   *  when onToggleExpand is provided. */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** Pending fly-to request; executes once per seq as soon as the stage
   *  is ready (see MapFlyRequest). */
  flyTo?: MapFlyRequest | null;
  className?: string;
}>(function WorldMapStage({
  map, markers, kindMeta, canEdit = false, selectedMarkerId = null,
  onMarkerClick, onPlace, onMarkerMove, onImageSize, expanded = false, onToggleExpand, flyTo = null, className,
}, ref) {
  const { t } = useTranslation("worlds");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [imgError, setImgError] = useState(false);
  const [container, setContainer] = useState<{ w: number; h: number } | null>(null);
  const [view, setViewState] = useState<View | null>(null);
  const viewRef = useRef<View | null>(null);
  const rafRef = useRef<number | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  /** Live fraction position of the marker being dragged (edit mode). */
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);

  // The stage lives inside FloatingWindow's container-typed content box:
  // container size comes from a ResizeObserver (window resizes) plus a
  // re-measure on the window-moved event (drag/resize-end fires it).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setContainer({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener(FLOATING_WINDOW_MOVED_EVENT, measure);
    return () => {
      ro.disconnect();
      window.removeEventListener(FLOATING_WINDOW_MOVED_EVENT, measure);
    };
  }, []);

  const fitScale = useMemo(() => {
    if (!nat || !container) return null;
    return Math.min(container.w / nat.w, container.h / nat.h);
  }, [nat, container]);

  const clampView = useCallback((v: View): View => {
    if (!nat || !container || fitScale == null) return v;
    const scale = Math.min(fitScale * MAX_ZOOM_FACTOR, Math.max(fitScale, v.scale));
    const w = nat.w * scale;
    const h = nat.h * scale;
    const tx = Math.min(container.w - MIN_VISIBLE_PX, Math.max(MIN_VISIBLE_PX - w, v.tx));
    const ty = Math.min(container.h - MIN_VISIBLE_PX, Math.max(MIN_VISIBLE_PX - h, v.ty));
    return { scale, tx, ty };
  }, [nat, container, fitScale]);

  /** Commit a view: ref immediately (gesture math), state via rAF (render). */
  const commitView = useCallback((v: View) => {
    const clamped = clampView(v);
    viewRef.current = clamped;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (viewRef.current) setViewState(viewRef.current);
      });
    }
  }, [clampView]);
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  const fitView = useCallback(() => {
    if (!nat || !container || fitScale == null) return;
    const v: View = {
      scale: fitScale,
      tx: (container.w - nat.w * fitScale) / 2,
      ty: (container.h - nat.h * fitScale) / 2,
    };
    viewRef.current = v;
    setViewState(v);
  }, [nat, container, fitScale]);

  // First fit once both natural + container sizes are known; later
  // container changes just re-clamp so the user's zoom survives resizes.
  useEffect(() => {
    if (!nat || !container) return;
    if (!viewRef.current) fitView();
    else commitView(viewRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nat, container]);

  // New image (map switched) resets everything.
  useEffect(() => {
    setNat(null);
    setImgError(false);
    setViewState(null);
    viewRef.current = null;
    setDragPos(null);
  }, [map.id, map.imageUrl]);

  const zoomAt = useCallback((clientX: number, clientY: number, nextScale: number) => {
    const el = containerRef.current;
    const v = viewRef.current;
    if (!el || !v) return;
    const r = el.getBoundingClientRect();
    const cx = clientX - r.left;
    const cy = clientY - r.top;
    // Keep the natural-image point under the cursor fixed.
    const px = (cx - v.tx) / v.scale;
    const py = (cy - v.ty) / v.scale;
    const clampedScale = fitScale == null
      ? nextScale
      : Math.min(fitScale * MAX_ZOOM_FACTOR, Math.max(fitScale, nextScale));
    commitView({ scale: clampedScale, tx: cx - px * clampedScale, ty: cy - py * clampedScale });
  }, [commitView, fitScale]);

  // Wheel zoom needs a non-passive listener (preventDefault stops the page
  // from scrolling under the stage).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (!v) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, v.scale * Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const endGesture = useCallback(() => {
    gestureRef.current = null;
    setDragPos(null);
  }, []);

  // Window-level gesture plumbing: pointermove/up/cancel are attached for
  // the life of a gesture, so a pointer that leaves the stage (or a React
  // re-parent mid-drag) can't strand it.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      const el = containerRef.current;
      const v = viewRef.current;
      if (!g || !el || !v || !g.pointers.has(e.pointerId)) return;
      const r = el.getBoundingClientRect();
      const pos = { x: e.clientX - r.left, y: e.clientY - r.top };
      g.pointers.set(e.pointerId, pos);
      if (g.mode === "pinch" && g.pointers.size >= 2) {
        const pts = [...g.pointers.values()];
        const a = pts[0];
        const b = pts[1];
        if (!a || !b) return;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (g.startDist <= 0 || dist <= 0) return;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const scale = g.startView.scale * (dist / g.startDist);
        const clamped = fitScale == null
          ? scale
          : Math.min(fitScale * MAX_ZOOM_FACTOR, Math.max(fitScale, scale));
        g.moved = true;
        commitView({
          scale: clamped,
          tx: mid.x - g.pinchAnchor.x * clamped,
          ty: mid.y - g.pinchAnchor.y * clamped,
        });
        return;
      }
      const dx = pos.x - g.start.x;
      const dy = pos.y - g.start.y;
      if (Math.hypot(dx, dy) > CLICK_SLOP_PX) g.moved = true;
      if (g.mode === "marker" && g.marker && nat) {
        if (!g.moved) return;
        const fx = Math.min(1, Math.max(0, (pos.x - v.tx) / v.scale / nat.w));
        const fy = Math.min(1, Math.max(0, (pos.y - v.ty) / v.scale / nat.h));
        setDragPos({ id: g.marker.id, x: fx, y: fy });
        return;
      }
      if (g.mode === "pan") {
        commitView({ scale: g.startView.scale, tx: g.startView.tx + dx, ty: g.startView.ty + dy });
      }
    };
    const onUp = (e: PointerEvent) => {
      const g = gestureRef.current;
      const el = containerRef.current;
      if (!g || !el || !g.pointers.has(e.pointerId)) return;
      const last = g.pointers.get(e.pointerId)!;
      g.pointers.delete(e.pointerId);
      if (g.pointers.size > 0) {
        // Pinch losing one finger: continue as a pan from the survivor.
        const survivor = [...g.pointers.values()][0];
        if (survivor) {
          g.mode = "pan";
          g.moved = true;
          g.start = survivor;
          g.startView = viewRef.current ?? g.startView;
        }
        return;
      }
      const v = viewRef.current;
      if (e.type !== "pointercancel" && v && nat) {
        if (g.mode === "marker" && g.marker) {
          if (g.moved) {
            const fx = Math.min(1, Math.max(0, (last.x - v.tx) / v.scale / nat.w));
            const fy = Math.min(1, Math.max(0, (last.y - v.ty) / v.scale / nat.h));
            onMarkerMove?.(g.marker, fx, fy);
          } else {
            onMarkerClick?.(g.marker);
          }
        } else if (!g.moved) {
          if (g.downMarker) {
            onMarkerClick?.(g.downMarker);
          } else if (canEdit && onPlace) {
            const fx = (last.x - v.tx) / v.scale / nat.w;
            const fy = (last.y - v.ty) / v.scale / nat.h;
            if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) onPlace(fx, fy);
          }
        }
      }
      endGesture();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [canEdit, commitView, endGesture, fitScale, nat, onMarkerClick, onMarkerMove, onPlace]);

  /** Overlay controls (zoom/fit/expand) handle their own clicks — a
   *  gesture must not start on them, or a stationary click would fall
   *  through to the click-to-place branch. Marker buttons still gesture. */
  function onNonMarkerButton(target: EventTarget | null): boolean {
    const btn = (target as HTMLElement | null)?.closest?.("button");
    return !!btn && !btn.hasAttribute("data-marker-id");
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (onNonMarkerButton(e.target)) return;
    const el = containerRef.current;
    const v = viewRef.current;
    if (!el || !v) return;
    const r = el.getBoundingClientRect();
    const pos = { x: e.clientX - r.left, y: e.clientY - r.top };
    const existing = gestureRef.current;
    if (existing) {
      existing.pointers.set(e.pointerId, pos);
      if (existing.pointers.size === 2 && existing.mode !== "marker") {
        const pts = [...existing.pointers.values()];
        const a = pts[0];
        const b = pts[1];
        if (!a || !b) return;
        existing.mode = "pinch";
        existing.moved = true;
        existing.startView = v;
        existing.startDist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        existing.pinchAnchor = { x: (mid.x - v.tx) / v.scale, y: (mid.y - v.ty) / v.scale };
        setDragPos(null);
      }
      return;
    }
    const markerEl = (e.target as HTMLElement).closest?.("[data-marker-id]");
    const markerId = markerEl?.getAttribute("data-marker-id") ?? null;
    const marker = markerId ? markers.find((m) => m.id === markerId) ?? null : null;
    gestureRef.current = {
      pointers: new Map([[e.pointerId, pos]]),
      mode: marker && canEdit && onMarkerMove ? "marker" : "pan",
      marker: marker && canEdit && onMarkerMove ? marker : null,
      downMarker: marker,
      moved: false,
      startView: v,
      start: pos,
      startDist: 0,
      pinchAnchor: { x: 0, y: 0 },
    };
  }

  function handleDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (onNonMarkerButton(e.target)) return;
    const v = viewRef.current;
    if (!v) return;
    zoomAt(e.clientX, e.clientY, v.scale * 2);
  }

  const flyToMarker = useCallback((m: WorldMapMarker) => {
    if (!nat || !container || fitScale == null) return;
    const scale = Math.max(viewRef.current?.scale ?? fitScale, fitScale * 2);
    const v = clampView({
      scale,
      tx: container.w / 2 - m.x * nat.w * scale,
      ty: container.h / 2 - m.y * nat.h * scale,
    });
    viewRef.current = v;
    setViewState(v);
  }, [nat, container, fitScale, clampView]);

  useImperativeHandle(ref, () => ({
    jumpToMarker: flyToMarker,
    resetView() { fitView(); },
  }), [flyToMarker, fitView]);

  // Deferred fly requests run once per seq, as soon as natural + container
  // dimensions exist (a deep-link usually lands before the image loads).
  const flownSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (!flyTo || !nat || !container || fitScale == null) return;
    if (flownSeqRef.current === flyTo.seq) return;
    flownSeqRef.current = flyTo.seq;
    flyToMarker(flyTo.marker);
  }, [flyTo, nat, container, fitScale, flyToMarker]);

  const zoomFactor = view && fitScale ? view.scale / fitScale : 1;

  const visibleMarkers = useMemo(() => markers.filter((m) => {
    // Zoom bands hide detail markers when zoomed out (and vice versa);
    // edit mode shows everything so a banded marker stays reachable.
    if (canEdit) return true;
    if (m.minZoom != null && zoomFactor < m.minZoom) return false;
    if (m.maxZoom != null && zoomFactor > m.maxZoom) return false;
    return true;
  }), [markers, zoomFactor, canEdit]);

  const controlBtn = "pointer-events-auto rounded border border-keep-rule bg-keep-bg/90 p-1 text-keep-text hover:bg-keep-banner disabled:opacity-40";

  if (imgError) {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 rounded-lg border border-keep-rule/60 bg-keep-bg/40 p-6 text-center ${className ?? ""}`}>
        <ImageOff className="h-6 w-6 text-keep-muted" aria-hidden="true" />
        <p className="text-sm text-keep-muted">{t("maps.imageUnavailable")}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative touch-none select-none overflow-hidden rounded-lg border border-keep-rule/60 bg-keep-bg/60 ${className ?? ""}`}
      style={{ cursor: canEdit ? "crosshair" : gestureRef.current?.mode === "pan" ? "grabbing" : "grab" }}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      role="application"
      aria-label={t("maps.stageRegion", { name: map.name })}
    >
      {/* Image is measured through a plain <img> so remote SVG stays
          script-inert; hidden until natural dimensions are known. */}
      <img
        src={map.imageUrl}
        alt={map.name}
        referrerPolicy="no-referrer"
        loading="lazy"
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            setNat({ w: img.naturalWidth, h: img.naturalHeight });
            onImageSize?.(img.naturalWidth, img.naturalHeight);
          } else {
            setImgError(true);
          }
        }}
        onError={() => setImgError(true)}
        className={nat && view ? "absolute left-0 top-0 max-w-none" : "invisible absolute left-0 top-0 max-w-none"}
        style={nat && view ? {
          width: nat.w,
          height: nat.h,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
          transformOrigin: "0 0",
        } : undefined}
      />
      {!nat && !imgError ? (
        <p className="absolute inset-0 flex items-center justify-center text-sm italic text-keep-muted">{t("common:loadingDots")}</p>
      ) : null}

      {/* Markers render in screen coordinates (never scaled text). */}
      {nat && view ? visibleMarkers.map((m) => {
        const pos = dragPos && dragPos.id === m.id ? dragPos : m;
        const sx = view.tx + pos.x * nat.w * view.scale;
        const sy = view.ty + pos.y * nat.h * view.scale;
        if (sx < -80 || sy < -80 || !container || sx > container.w + 80 || sy > container.h + 80) return null;
        const meta = kindMeta(m.kind);
        const color = safeCssColor(m.color) ?? safeCssColor(meta.color) ?? "var(--keep-action)";
        const iconKey = m.icon ?? meta.icon;
        const LucideIcon = iconKey ? EVENT_ICONS[iconKey] : undefined;
        const mapScaled = m.scaleMode === "map";
        const selected = selectedMarkerId === m.id;
        const ariaLabel = `${m.label} (${meta.label})`;
        if (m.kind === "label") {
          return (
            <button
              key={m.id}
              type="button"
              data-marker-id={m.id}
              title={ariaLabel}
              aria-label={ariaLabel}
              onClick={(e) => { if (e.detail === 0) onMarkerClick?.(m); }}
              className={`absolute max-w-[24ch] overflow-hidden text-ellipsis whitespace-nowrap rounded px-1 font-action tracking-wide ${m.isSecret ? "opacity-60" : ""} ${selected ? "ring-2 ring-keep-action" : ""}`}
              style={{
                left: sx,
                top: sy,
                transform: `translate(-50%, -50%)${mapScaled ? ` scale(${zoomFactor})` : ""}`,
                color,
                fontSize: LABEL_FONT_PX[m.size],
                // Same layered outline as .map-marker-label, keeping the
                // author-picked ink color legible over busy map art.
                textShadow: "0 1px 2px rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.9), 0 0 10px rgba(0,0,0,.5)",
                cursor: "pointer",
              }}
            >
              {m.label}
            </button>
          );
        }
        const px = MARKER_SIZE_PX[m.size];
        // Text-only markers render as outlined map text (no glyph pin);
        // the fixed white-ink + dark-shadow class keeps them legible over
        // any map art regardless of theme.
        if (m.labelMode === "text") {
          return (
            <button
              key={m.id}
              type="button"
              data-marker-id={m.id}
              title={ariaLabel}
              aria-label={ariaLabel}
              onClick={(e) => { if (e.detail === 0) onMarkerClick?.(m); }}
              className={`map-marker-label absolute font-action tracking-wide ${m.isSecret ? "opacity-60" : ""} ${selected ? "rounded ring-2 ring-keep-action" : ""}`}
              style={{
                left: sx,
                top: sy,
                transform: `translate(-50%, -50%)${mapScaled ? ` scale(${zoomFactor})` : ""}`,
                fontSize: LABEL_FONT_PX[m.size],
                cursor: canEdit ? "move" : "pointer",
              }}
            >
              {m.label}
            </button>
          );
        }
        return (
          <Fragment key={m.id}>
            <button
              type="button"
              data-marker-id={m.id}
              title={ariaLabel}
              aria-label={ariaLabel}
              onClick={(e) => { if (e.detail === 0) onMarkerClick?.(m); }}
              className={`absolute flex items-center justify-center rounded-full shadow-md ${m.isSecret ? "border-2 border-dashed border-white/80 opacity-60" : "border-2 border-white/80"} ${selected ? "ring-2 ring-keep-action" : ""}`}
              style={{
                left: sx,
                top: sy,
                width: px,
                height: px,
                transform: `translate(-50%, -50%)${mapScaled ? ` scale(${zoomFactor})` : ""}`,
                background: color,
                color: "#fff",
                cursor: canEdit ? "move" : "pointer",
              }}
            >
              {LucideIcon ? (
                <LucideIcon aria-hidden="true" style={{ width: px * 0.6, height: px * 0.6 }} />
              ) : iconKey ? (
                <span aria-hidden style={{ fontSize: px * 0.55, lineHeight: 1 }}>{iconKey}</span>
              ) : null}
            </button>
            {m.labelMode === "both" ? (
              // Companion text under the pin. Non-interactive (the pin is
              // the hit target and already carries the accessible label);
              // tracks the pin's map-scaled radius so it hugs the glyph at
              // every zoom.
              <span
                aria-hidden="true"
                className={`map-marker-label pointer-events-none absolute font-action tracking-wide ${m.isSecret ? "opacity-60" : ""}`}
                style={{
                  left: sx,
                  top: sy + (px / 2 + 3) * (mapScaled ? zoomFactor : 1),
                  transform: `translate(-50%, 0)${mapScaled ? ` scale(${zoomFactor})` : ""}`,
                  transformOrigin: "top center",
                  fontSize: LABEL_FONT_PX[m.size],
                }}
              >
                {m.label}
              </span>
            ) : null}
          </Fragment>
        );
      }) : null}

      {/* Zoom controls */}
      {nat && view ? (
        <div className="pointer-events-none absolute right-2 top-2 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => { const c = containerRef.current!.getBoundingClientRect(); zoomAt(c.left + c.width / 2, c.top + c.height / 2, view.scale * 1.5); }}
            className={controlBtn}
            title={t("maps.zoomIn")}
            aria-label={t("maps.zoomIn")}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => { const c = containerRef.current!.getBoundingClientRect(); zoomAt(c.left + c.width / 2, c.top + c.height / 2, view.scale / 1.5); }}
            className={controlBtn}
            title={t("maps.zoomOut")}
            aria-label={t("maps.zoomOut")}
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={fitView}
            className={controlBtn}
            title={t("maps.fitToView")}
            aria-label={t("maps.fitToView")}
          >
            <Maximize className="h-4 w-4" aria-hidden="true" />
          </button>
          {onToggleExpand ? (
            <button
              type="button"
              onClick={onToggleExpand}
              className={controlBtn}
              title={expanded ? t("maps.collapseStage") : t("maps.expandStage")}
              aria-label={expanded ? t("maps.collapseStage") : t("maps.expandStage")}
            >
              {expanded ? <Shrink className="h-4 w-4" aria-hidden="true" /> : <Expand className="h-4 w-4" aria-hidden="true" />}
            </button>
          ) : null}
          <span className="pointer-events-none rounded bg-keep-bg/80 px-1 text-center text-[10px] tabular-nums text-keep-muted">
            {`${zoomFactor.toFixed(1)}×`}
          </span>
        </div>
      ) : null}
    </div>
  );
});
