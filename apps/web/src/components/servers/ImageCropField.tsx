/**
 * ImageCropField — a reusable "upload + position" control for branded images.
 *
 * Generalizes the profile AvatarCropPicker so the same drag-to-pan + zoom UX
 * works for any image, square (the server's round icon) or wide (the server's
 * banner). Picks a file, hands the data URL up via {@link onPickFile} for the
 * caller to upload, and exposes a live {@link AvatarCrop} ({zoom,offsetX,
 * offsetY}) via {@link onCropChange} — the same shape user avatars store, so the
 * renderer (`cropStyleFor`) shows exactly what gets saved.
 *
 * The preview mirrors how the image will actually paint: `object-fit: cover`
 * fills the window, and the crop's focal point drives both `object-position` and
 * the zoom's `transform-origin`. Dragging pans the focal point; the slider
 * zooms. Both clamp through the shared `clampAvatarCrop`.
 *
 * This component owns NO persistence — the caller decides when to POST the image
 * and PATCH the crop. It's deliberately presentation-only so it drops into the
 * server console, and could later serve forums or worlds the same way.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Upload } from "lucide-react";
import { AVATAR_CROP_DEFAULTS, AVATAR_CROP_MAX_ZOOM, AVATAR_CROP_MIN_ZOOM, clampAvatarCrop, isDefaultAvatarCrop, type AvatarCrop } from "@thekeep/shared";
import { cropStyleFor } from "../../lib/avatarCrop.js";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** Read a picked file as a data URL with a fail-fast size guard. Error copy is
 *  passed in (already translated) so this helper stays render-agnostic. */
function readImageFile(file: File, maxBytes: number, messages: { tooLarge: string; readError: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > maxBytes) { reject(new Error(messages.tooLarge)); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(messages.readError));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export function ImageCropField({
  label,
  hint,
  url,
  crop,
  shape = "rect",
  aspect = 3.75,
  previewWidth,
  fullWidth = false,
  maxBytes,
  busy = false,
  onPickFile,
  onClear,
  onCropChange,
  cropDirty = false,
  savingCrop = false,
  onSaveCrop,
}: {
  label: string;
  hint?: string;
  /** Current saved image URL (null ⇒ nothing uploaded yet). */
  url: string | null;
  /** Controlled crop value. */
  crop: AvatarCrop;
  /** "circle" → round window (icon); "rect" → rectangular window (banner/logo). */
  shape?: "circle" | "rect";
  /** width/height for the rect preview window. Ignored for circle. */
  aspect?: number;
  /** Preview width in px. Defaults: 144 (circle) / 320 (rect). */
  previewWidth?: number;
  /** Rect only: make the preview fill the available width (and stack the
   *  controls beneath it) at the given `aspect` — use when the preview should
   *  mirror a wide target like the top bar so positioning is WYSIWYG. */
  fullWidth?: boolean;
  /** Client-side size guard; the server re-checks. */
  maxBytes: number;
  busy?: boolean;
  /** A file was picked + read → the caller uploads the data URL. */
  onPickFile: (dataUrl: string) => void;
  /** Remove the image. */
  onClear: () => void;
  /** Crop changed (drag/zoom/reset) → the caller updates its controlled value. */
  onCropChange: (crop: AvatarCrop) => void;
  /** True when the live crop differs from the last saved one — enables Save. */
  cropDirty?: boolean;
  /** Save in flight (disables the button + shows "Saving…"). */
  savingCrop?: boolean;
  /** Persist the current crop. When provided, an explicit Save button shows
   *  alongside the controls (no silent auto-save). */
  onSaveCrop?: () => void;
}) {
  const { t } = useTranslation("servers");
  const width = previewWidth ?? (shape === "circle" ? 144 : 320);
  const height = shape === "circle" ? width : Math.round(width / aspect);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<{ startX: number; startY: number; baseOffsetX: number; baseOffsetY: number } | null>(null);
  const [imgError, setImgError] = useState(false);
  const [pickErr, setPickErr] = useState<string | null>(null);
  useEffect(() => { setImgError(false); }, [url]);

  const showsCrop = !!url && !imgError;

  function applyClamp(next: Partial<AvatarCrop>) {
    onCropChange(clampAvatarCrop({ ...crop, ...next }));
  }
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!showsCrop) return;
    const el = containerRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    draggingRef.current = { startX: e.clientX, startY: e.clientY, baseOffsetX: crop.offsetX, baseOffsetY: crop.offsetY };
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = draggingRef.current;
    const el = containerRef.current;
    if (!drag || !el) return;
    const rect = el.getBoundingClientRect();
    // Pixel delta → percent delta on each axis, divided by zoom so the pan rate
    // stays consistent when zoomed in (mirrors AvatarCropPicker).
    const dxPct = ((e.clientX - drag.startX) / rect.width) * 100 / crop.zoom;
    const dyPct = ((e.clientY - drag.startY) / rect.height) * 100 / crop.zoom;
    applyClamp({ offsetX: drag.baseOffsetX - dxPct, offsetY: drag.baseOffsetY - dyPct });
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = null;
    const el = containerRef.current;
    if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  async function pick(file: File | null | undefined) {
    if (!file) return;
    setPickErr(null);
    try {
      onPickFile(await readImageFile(file, maxBytes, {
        tooLarge: t("imageCrop.tooLarge", { max: Math.round(maxBytes / 1024) }),
        readError: t("imageCrop.readError"),
      }));
    }
    catch (e) { setPickErr(e instanceof Error ? e.message : t("imageCrop.readError")); }
  }

  const isDefault = isDefaultAvatarCrop(crop);
  // Full-width rect: stack the preview (filling the row) above the controls so a
  // wide target like the top bar previews at true proportions via aspect-ratio.
  const stacked = fullWidth && shape !== "circle";
  const cursor = showsCrop ? (draggingRef.current ? "grabbing" : "grab") : "default";

  return (
    <div className="space-y-2">
      <span className="block text-xs uppercase tracking-widest text-keep-muted">{label}</span>
      <div className={stacked ? "space-y-2" : "flex flex-wrap items-start gap-3"}>
        {/* Preview / crop window */}
        <div
          ref={containerRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={`relative select-none overflow-hidden border border-keep-rule bg-keep-banner ${shape === "circle" ? "rounded-full" : "rounded"} ${stacked ? "w-full" : "shrink-0"}`}
          style={stacked
            ? { aspectRatio: String(aspect), touchAction: "none", cursor }
            : { width, height, touchAction: "none", cursor }}
        >
          {showsCrop ? (
            <img
              src={url!}
              alt=""
              draggable={false}
              onError={() => setImgError(true)}
              className="pointer-events-none h-full w-full object-cover"
              style={cropStyleFor(crop)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-2 text-center text-[10px] italic text-keep-muted">
              {imgError ? t("imageCrop.loadError") : t("imageCrop.noImage")}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className={stacked ? "space-y-2" : "min-w-0 flex-1 space-y-2"}>
          <div className="flex flex-wrap items-center gap-2">
            <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg ${busy ? "opacity-50" : "hover:bg-keep-action/90"}`}>
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              {url ? t("imageCrop.replace") : t("imageCrop.upload")}
              <input type="file" accept={ACCEPT} disabled={busy} className="hidden"
                onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            {url ? (
              <button type="button" disabled={busy} onClick={onClear}
                className="rounded border border-keep-rule px-2 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text disabled:opacity-50">{t("imageCrop.remove")}</button>
            ) : null}
          </div>
          {showsCrop ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted">{t("imageCrop.zoom")}</span>
                <input
                  type="range"
                  min={AVATAR_CROP_MIN_ZOOM}
                  max={AVATAR_CROP_MAX_ZOOM}
                  step={0.01}
                  value={crop.zoom}
                  onChange={(e) => applyClamp({ zoom: Number(e.target.value) })}
                  className="h-1 min-w-0 flex-1 cursor-pointer accent-keep-action"
                />
                <button
                  type="button"
                  onClick={() => onCropChange({ ...AVATAR_CROP_DEFAULTS })}
                  disabled={isDefault}
                  title={t("imageCrop.resetTitle")}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text disabled:opacity-40"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  {t("imageCrop.reset")}
                </button>
              </div>
              <p className="text-[10px] text-keep-muted">{t("imageCrop.dragHint")}</p>
              {onSaveCrop ? (
                <button
                  type="button"
                  onClick={onSaveCrop}
                  disabled={!cropDirty || savingCrop}
                  className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
                >
                  {savingCrop ? t("shared.saving") : cropDirty ? t("imageCrop.savePosition") : t("imageCrop.saved")}
                </button>
              ) : null}
            </div>
          ) : null}
          {pickErr ? <p className="text-[11px] text-keep-accent">{pickErr}</p> : null}
          {hint ? <p className="text-[10px] text-keep-muted">{hint}</p> : null}
        </div>
      </div>
    </div>
  );
}
