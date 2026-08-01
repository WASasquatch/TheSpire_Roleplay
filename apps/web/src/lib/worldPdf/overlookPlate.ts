/**
 * Render a world's Overlook board down to a single PNG plate for the PDF.
 *
 * Excalidraw's own `exportToCanvas` does the drawing, so the plate is the
 * real board (fonts, hand-drawn strokes, images and all), not a screenshot
 * of whatever happened to be on screen. Three things have to be handled or
 * the plate comes out wrong:
 *
 *  1. Images on the board are DOWNLOADED and inlined before the export runs.
 *     Excalidraw loads a file entry with a bare `img.src`, so a cross-origin
 *     URL taints the export canvas and `toDataURL` throws, the same reason
 *     the canvas component proxies them at load time. Going one step further
 *     and inlining the bytes also means the export can't race the network:
 *     `exportToCanvas` does not wait for a slow file, it just draws the board
 *     without it.
 *  2. Dark mode is a canvas-wide invert filter, not restyled elements, and
 *     the stored background colour is the PRE-IMAGE of the one we want to
 *     see. Both are recomputed from the WORLD's palette via the same bridge
 *     the live canvas uses, so the plate matches what a reader opening the
 *     canvas would see rather than the palette of whoever last saved it.
 *  3. The export is capped at a sane pixel size. A board can be metres wide
 *     in scene units; the plate only has to be legible at a third of a page.
 *
 * Excalidraw is a large chunk, so the import is dynamic and only pays off
 * when a world actually has a board.
 */
import type { Theme } from "@thekeep/shared";
import { overlookThemeBridge } from "../overlookTheme.js";
import { loadImageAssets, proxiedMediaUrl, type ImageAsset } from "./util.js";

/** Longest edge of the rendered plate, in pixels. About 2.5x its printed
 *  size, so it stays crisp at 200 DPI without ballooning the file. */
const MAX_EDGE = 1700;

export async function renderOverlookPlate(
  sceneJson: string,
  theme: Theme,
): Promise<ImageAsset | null> {
  let parsed: { elements?: unknown; files?: unknown; appState?: unknown };
  try {
    parsed = JSON.parse(sceneJson) as typeof parsed;
  } catch {
    return null;
  }
  const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
  if (elements.length === 0) return null;

  // Resolve every remote file on the board to inline bytes. The author's
  // original URL stays in the stored scene; this only exists at render time.
  const rawFiles = (parsed.files ?? {}) as Record<string, { dataURL?: string } | undefined>;
  const remote = Object.values(rawFiles)
    .map((f) => f?.dataURL)
    .filter((u): u is string => typeof u === "string" && !u.startsWith("data:"))
    .map(proxiedMediaUrl);
  const assets = remote.length > 0 ? await loadImageAssets(remote) : new Map<string, ImageAsset>();

  const files: Record<string, unknown> = {};
  for (const [key, file] of Object.entries(rawFiles)) {
    if (!file) continue;
    const url = file.dataURL;
    if (typeof url !== "string" || url.startsWith("data:")) {
      files[key] = file;
      continue;
    }
    const asset = assets.get(proxiedMediaUrl(url));
    // A file we couldn't fetch is dropped: Excalidraw draws a placeholder
    // frame for a missing file, which is tidier than a half-loaded image.
    if (asset) files[key] = { ...file, dataURL: asset.src };
  }

  const bridge = overlookThemeBridge(theme);
  try {
    const { exportToCanvas } = await import("@excalidraw/excalidraw");
    const canvas = await exportToCanvas({
      elements: elements as never,
      files: files as never,
      appState: {
        ...(parsed.appState as Record<string, unknown> | undefined),
        viewBackgroundColor: bridge.viewBackgroundColor,
        exportBackground: true,
        exportWithDarkMode: bridge.dark,
        exportScale: 1,
      } as never,
      maxWidthOrHeight: MAX_EDGE,
      exportPadding: 24,
    });
    if (canvas.width === 0 || canvas.height === 0) return null;
    return { src: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height };
  } catch {
    // A board that refuses to render (corrupt scene, a font that never
    // resolved, a proxy refusal that still tainted the canvas) costs the
    // magazine one plate, not the whole export.
    return null;
  }
}
