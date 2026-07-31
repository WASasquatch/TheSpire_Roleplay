/**
 * The Excalidraw instance itself.
 *
 * Split out from OverlookWindow so the (large, ESM-only) Excalidraw chunk
 * sits behind its own lazy boundary and the window's chrome (titlebar,
 * loading and error states) paints while it downloads.
 *
 * Four things here are load-bearing and easy to break:
 *
 *  1. `ensureExcalidrawAssetPath()` runs at MODULE scope, before the library
 *     initializes its font loader. Move it into an effect and the loader has
 *     already resolved its URLs against the CDN, which the production CSP
 *     blocks (see lib/overlookAssets.ts).
 *
 *  2. `api.refresh()` on every window move/resize. Excalidraw caches its
 *     container offset and only invalidates on browser resize/scroll, so a
 *     FloatingWindow titlebar drag silently desynchronizes pointer
 *     coordinates from the canvas: you click one place and draw in another.
 *     This is the same fix GrapesJS needed in the profile designer.
 *
 *  3. Remote images are rewritten through our same-origin proxy. Excalidraw
 *     will happily render a cross-origin URL, but the canvas is then tainted
 *     and PNG export / copy-to-clipboard throw.
 *
 *  4. Dark mode comes from the `theme` prop and its canvas-wide invert
 *     filter, NOT from restyling elements. The background is stored
 *     pre-inverted so the filter lands on our palette. See lib/overlookTheme.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Excalidraw, convertToExcalidrawElements, getSceneVersion } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { ImagePlus, Link2, Sparkles } from "lucide-react";
import type { WorldEntityLight } from "@thekeep/shared";
import { FLOATING_WINDOW_MOVED_EVENT } from "../shared/FloatingWindow.js";
import { ensureExcalidrawAssetPath } from "../../lib/overlookAssets.js";
import { overlookThemeBridge } from "../../lib/overlookTheme.js";
import { useActiveTheme } from "../../lib/theme.js";
import { looksLikeImageUrl, proxiedImageUrl } from "../../lib/overlook.js";
import { openUiRoute } from "../../lib/uiRouteOpen.js";
import { i18n } from "../../lib/i18n.js";

// Module scope on purpose: see note 1 in the file header.
ensureExcalidrawAssetPath();

/** The Excalidraw document as we store it. Structurally the library's own. */
export interface OverlookScene {
  elements: readonly OrderedExcalidrawElement[];
  appState: Record<string, unknown>;
  files: BinaryFiles;
}

interface Props {
  /** Serialized scene from the server. */
  sceneJson: string;
  /** False renders the canvas read-only (pan, zoom and links still work). */
  canEdit: boolean;
  /** Whether the admin allowed embedded image files. Chrome only. */
  uploadsEnabled: boolean;
  /**
   * Called on every Excalidraw change with the current scene AND a signature
   * of just its PERSISTED content.
   *
   * The signature matters: Excalidraw's `onChange` fires on every appState
   * change, which includes panning, zooming and selecting. Treating that as
   * "edited" would light up "Unsaved changes" the instant someone scrolled,
   * and would arm the beforeunload guard for read-only visitors who cannot
   * edit at all. The window compares this signature against the last saved
   * one instead of trusting the callback's existence.
   */
  onSceneChange: (scene: OverlookScene, signature: string) => void;
  /**
   * World entries available for one-click seeding. Present only for world
   * canvases whose viewer can edit; absent hides the tool entirely.
   */
  seedEntities?: readonly WorldEntityLight[];
}

/**
 * Tint per built-in entry kind, so a seeded world reads at a glance instead
 * of arriving as a wall of identical boxes. Unknown (owner-defined) kinds
 * fall through to the neutral default, which is correct: we have no idea
 * what a custom kind means.
 *
 * These are Excalidraw's own palette values rather than our theme colours on
 * purpose. They are stored on the elements as explicit colours, so they
 * survive the dark-mode filter with their hue intact and stay legible on both
 * backgrounds; a theme colour baked in here would look wrong the moment the
 * viewer switched palettes.
 */
const SEED_TINTS: Record<string, string> = {
  location: "#b2f2bb",
  npc: "#a5d8ff",
  item: "#ffec99",
  faction: "#ffc9c9",
};

/**
 * Excalidraw's own theme values. Typed locally rather than imported so a
 * library reshuffle of the THEME const can't break the build over two
 * strings.
 */
type ExcalidrawTheme = "light" | "dark";

/** Parse the stored document, tolerating anything unparseable as "empty". */
function parseScene(sceneJson: string): {
  elements: OrderedExcalidrawElement[];
  files: BinaryFiles;
  appState: Record<string, unknown>;
} {
  try {
    const raw: unknown = JSON.parse(sceneJson);
    if (raw && typeof raw === "object") {
      const s = raw as Partial<OverlookScene>;
      return {
        elements: Array.isArray(s.elements) ? [...s.elements] : [],
        files: (s.files ?? {}) as BinaryFiles,
        appState: (s.appState ?? {}) as Record<string, unknown>,
      };
    }
  } catch {
    // A corrupt scene should open as a blank canvas the owner can rebuild,
    // never as a hard error that locks them out of their own room.
  }
  return { elements: [], files: {}, appState: {} };
}

/**
 * Rewrite every remote image reference through the proxy.
 *
 * Applied on LOAD rather than on save, so the stored scene keeps the author's
 * original URL. That matters: the proxy path is an implementation detail, and
 * baking it into saved data would strand every image the day the route moves.
 */
function proxyFiles(files: BinaryFiles): BinaryFiles {
  const out: BinaryFiles = {};
  for (const [key, file] of Object.entries(files)) {
    const url = file?.dataURL;
    out[key] =
      typeof url === "string" && !url.startsWith("data:")
        ? ({ ...file, dataURL: proxiedImageUrl(url) } as BinaryFileData)
        : file;
  }
  return out;
}

/**
 * Best-effort image mime from a URL's extension, defaulting to PNG.
 * Metadata only; the proxy is what actually enforces the type allowlist.
 */
function mimeFromUrl(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    default:
      return "image/png";
  }
}

/** Undo `proxyFiles` so saved scenes hold the author's URL, not ours. */
function unproxyFiles(files: BinaryFiles): BinaryFiles {
  const out: BinaryFiles = {};
  for (const [key, file] of Object.entries(files)) {
    const url = file?.dataURL;
    if (typeof url === "string" && url.startsWith("/overlook/image?u=")) {
      const original = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("u");
      out[key] = original ? ({ ...file, dataURL: original } as BinaryFileData) : file;
    } else {
      out[key] = file;
    }
  }
  return out;
}

export function OverlookCanvas({
  sceneJson,
  canEdit,
  uploadsEnabled,
  onSceneChange,
  seedEntities,
}: Props) {
  const { t } = useTranslation("common");
  const activeTheme = useActiveTheme();
  const bridge = overlookThemeBridge(activeTheme);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  // Parsed once per server payload. Re-parsing on every render would reset
  // the canvas mid-draw.
  const initialData = useMemo(() => {
    const parsed = parseScene(sceneJson);
    return {
      elements: parsed.elements,
      files: proxyFiles(parsed.files),
      appState: {
        ...parsed.appState,
        viewBackgroundColor: bridge.viewBackgroundColor,
        // The canvas lives in a window, not a browser tab, so its own
        // scroll-detection heuristics would fight the window manager.
        theme: bridge.theme as ExcalidrawTheme,
      },
    };
    // Intentionally NOT keyed on the theme: a palette change is pushed
    // through `updateScene` below so it doesn't remount the canvas and
    // discard in-progress work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneJson]);

  // Note 2 in the header: keep Excalidraw's cached container offset honest.
  // Both signals are needed: the custom event covers titlebar drags and
  // corner resizes, the observer covers everything else that changes our box
  // (window collapse, the app shell's own layout, browser zoom).
  useEffect(() => {
    if (!api) return;
    const refresh = () => api.refresh();
    window.addEventListener(FLOATING_WINDOW_MOVED_EVENT, refresh);
    const host = hostRef.current;
    let ro: ResizeObserver | null = null;
    if (host && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(refresh);
      ro.observe(host);
    }
    return () => {
      window.removeEventListener(FLOATING_WINDOW_MOVED_EVENT, refresh);
      ro?.disconnect();
    };
  }, [api]);

  // Follow the site palette live (theme switch, character swap) without
  // remounting. `updateScene` only touches appState, so elements and the
  // undo stack survive.
  useEffect(() => {
    if (!api) return;
    // Only the background: `theme` is a controlled PROP, so Excalidraw
    // re-forces appState.theme from it on every render and setting it here
    // would be immediately overwritten.
    api.updateScene({ appState: { viewBackgroundColor: bridge.viewBackgroundColor } });
  }, [api, bridge.viewBackgroundColor]);

  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: unknown, files: BinaryFiles) => {
      const state = appState as Record<string, unknown>;
      const persistedFiles = unproxyFiles(files);
      // Signature of the CONTENT only. `getSceneVersion` hashes each element's
      // own version counter, which bumps on real edits and not on viewport
      // changes; the file ids catch an image swap that somehow left the
      // elements untouched. Everything Excalidraw calls onChange for that
      // isn't in here (scroll, zoom, selection, active tool, cursor) is
      // correctly ignored.
      const signature = `${getSceneVersion(elements)}:${Object.keys(persistedFiles).sort().join(",")}`;
      onSceneChange(
        {
          elements,
          files: persistedFiles,
          // Only the handful of appState keys worth persisting. Excalidraw's
          // full appState carries per-viewer junk (cursor, selection, the
          // collaborator map) that would leak one person's UI state onto
          // everyone else's canvas.
          appState: {
            gridSize: state.gridSize ?? null,
            // Stored pre-inverted for dark mode; see lib/overlookTheme.
            viewBackgroundColor: state.viewBackgroundColor ?? bridge.viewBackgroundColor,
          },
        },
        signature,
      );
    },
    [onSceneChange, bridge.viewBackgroundColor],
  );

  /**
   * Follow an element's hyperlink.
   *
   * Our own `{room:slug}` / `{world:slug}` chip tokens route through the
   * in-app modal bus instead of navigating, which is what makes a node on the
   * canvas a jump-to-the-thing button rather than a bookmark. Anything else
   * is left to Excalidraw's default handling.
   */
  const handleLinkOpen = useCallback(
    (element: { link?: string | null }, event: CustomEvent<{ nativeEvent: unknown }>) => {
      const link = element.link?.trim();
      if (!link) return;
      const token = /^\{[a-z]+:[^}]+\}$/i.test(link) ? link : null;
      if (token && openUiRoute(token)) {
        // Excalidraw reads `defaultPrevented` to decide whether to navigate.
        event.preventDefault();
      }
    },
    [],
  );

  /**
   * Insert an image by URL.
   *
   * Excalidraw has no built-in "add image by link" affordance; its picker is
   * file-only. We add the file entry ourselves with the URL in the `dataURL`
   * slot (the loader does a bare `img.src`, no `data:` validation) and then
   * place an element referencing it. Natural dimensions come from a probe
   * load, so the image lands at its real aspect ratio instead of a square.
   */
  const insertImage = useCallback(
    async (raw: string) => {
      if (!api) return;
      const url = raw.trim();
      if (!looksLikeImageUrl(url)) {
        setImageError(t("overlook.addImageBad"));
        return;
      }
      const proxied = proxiedImageUrl(url);
      const probe = new Image();
      const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
        probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
        probe.onerror = () => resolve(null);
        probe.src = proxied;
      });
      if (!dims || dims.w === 0) {
        setImageError(t("overlook.addImageFailed"));
        return;
      }
      // Fit inside a sane box so a 4000px photo doesn't land the size of a
      // city; the author can scale it up afterwards.
      const scale = Math.min(1, 400 / Math.max(dims.w, dims.h));
      const fileId = `overlook-${Date.now().toString(36)}-${Math.floor(
        // Not security-sensitive: this only has to be unique within one scene.
        Math.random() * 1e6,
      ).toString(36)}`;

      api.addFiles([
        {
          id: fileId,
          // The URL rides in the dataURL slot deliberately; see the doc above.
          dataURL: proxied,
          // Metadata only: rendering goes through `img.src`, so this never
          // decides how the image loads. It does ride along into SVG export,
          // so a best-effort guess from the extension beats always claiming
          // PNG. The proxy independently enforces the real allowlist.
          mimeType: mimeFromUrl(url),
          created: Date.now(),
        } as unknown as BinaryFileData,
      ]);
      const { scrollX, scrollY, width, height, zoom } = api.getAppState();
      const centerX = -scrollX + width / 2 / zoom.value;
      const centerY = -scrollY + height / 2 / zoom.value;
      const next = convertToExcalidrawElements([
        {
          type: "image",
          x: centerX - (dims.w * scale) / 2,
          y: centerY - (dims.h * scale) / 2,
          width: dims.w * scale,
          height: dims.h * scale,
          fileId: fileId as never,
        },
      ]);
      api.updateScene({ elements: [...api.getSceneElements(), ...next] });
      setImageUrl(null);
      setImageError(null);
    },
    [api, t],
  );

  /**
   * Drop this world's entries onto the canvas as labelled nodes, grouped by
   * kind and tinted per kind.
   *
   * Deliberately NOT linked: the only per-world chip token we have is
   * `{world:<slug>}`, so linking every node would give forty boxes that all
   * open the same modal. Hand-authored links on individual nodes still work
   * (see handleLinkOpen). This tool is about getting the pieces onto the
   * board so you can arrange and connect them, which is the slow part.
   *
   * Entries already on the canvas are skipped, so the button is safe to press
   * twice after adding a couple of NPCs.
   */
  const seedFromWorld = useCallback(() => {
    if (!api || !seedEntities?.length) return;
    const present = new Set(
      api
        .getSceneElements()
        .map((el) => (el.type === "text" ? el.text : null))
        .filter((v): v is string => !!v),
    );
    const fresh = seedEntities.filter((e) => !present.has(e.name));
    if (fresh.length === 0) return;

    // Lay out in columns per kind so related entries arrive together.
    const byKind = new Map<string, WorldEntityLight[]>();
    for (const e of fresh) {
      const list = byKind.get(e.kind) ?? [];
      list.push(e);
      byKind.set(e.kind, list);
    }
    const CARD_W = 200;
    const CARD_H = 72;
    const GAP_X = 48;
    const GAP_Y = 28;
    // Anchor just inside the current viewport's top-left so the new nodes
    // land where the author is looking, not at the scene's absolute origin.
    const { scrollX, scrollY, zoom } = api.getAppState();
    const originX = -scrollX + 40 / zoom.value;
    const originY = -scrollY + 40 / zoom.value;

    const skeletons = [];
    let col = 0;
    for (const [kind, list] of byKind) {
      for (const [row, entry] of list.entries()) {
        skeletons.push({
          type: "rectangle" as const,
          x: originX + col * (CARD_W + GAP_X),
          y: originY + row * (CARD_H + GAP_Y),
          width: CARD_W,
          height: CARD_H,
          backgroundColor: SEED_TINTS[kind] ?? "transparent",
          fillStyle: "solid" as const,
          roundness: { type: 3 as const },
          label: { text: entry.name, fontSize: 16 },
        });
      }
      col++;
    }
    const next = convertToExcalidrawElements(skeletons);
    api.updateScene({ elements: [...api.getSceneElements(), ...next] });
    api.scrollToContent(next, { fitToContent: true });
  }, [api, seedEntities]);

  const topRight = useCallback(() => {
    if (!canEdit) return null;
    return (
      <div className="flex items-center gap-1">
        {seedEntities?.length ? (
          <button
            type="button"
            onClick={seedFromWorld}
            title={t("overlook.seedFromWorldHint")}
            aria-label={t("overlook.seedFromWorld")}
            className="flex h-9 items-center gap-1 rounded border border-keep-rule bg-keep-panel px-2 text-xs text-keep-text hover:border-keep-action hover:text-keep-action"
          >
            <Sparkles size={14} aria-hidden />
            <span className="hidden [@container(min-width:640px)]:inline">
              {t("overlook.seedFromWorld")}
            </span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => { setImageUrl((v) => (v === null ? "" : null)); setImageError(null); }}
          title={t("overlook.addImage")}
          aria-label={t("overlook.addImage")}
          className="flex h-9 items-center gap-1 rounded border border-keep-rule bg-keep-panel px-2 text-xs text-keep-text hover:border-keep-action hover:text-keep-action"
        >
          <ImagePlus size={14} aria-hidden />
          <span className="hidden [@container(min-width:640px)]:inline">{t("overlook.addImage")}</span>
        </button>
      </div>
    );
  }, [canEdit, seedEntities, seedFromWorld, t]);

  return (
    /* `absolute inset-0`, NOT `flex-1`. Excalidraw sizes itself to 100% of
       its containing block, so that block needs a definite height or the
       whole canvas silently renders at zero height: a window with working
       chrome and nothing inside it, no error anywhere. `flex-1` can't
       provide that here: the parent in OverlookWindow is a plain block, so
       the flex shorthand is inert and the host collapses to auto height.
       Pinning to the (already position:relative, definitely-sized) parent
       sidesteps the whole question. */
    <div ref={hostRef} className="absolute inset-0">
      {/* Add-image-by-link popover. Deliberately our own chrome rather than an
          Excalidraw dialog: the library has no URL entry point to extend, and
          this keeps the affordance consistent with the rest of the app. */}
      {imageUrl !== null ? (
        <div className="absolute right-2 top-12 z-10 w-[min(22rem,calc(100%-1rem))] rounded border border-keep-rule bg-keep-panel p-2 shadow-lg">
          <label className="block text-[10px] font-action uppercase tracking-widest text-keep-muted">
            {t("overlook.addImagePrompt")}
          </label>
          <div className="mt-1 flex gap-1">
            <input
              type="url"
              autoFocus
              value={imageUrl}
              onChange={(e) => { setImageUrl(e.target.value); setImageError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void insertImage(imageUrl); }
                if (e.key === "Escape") { e.preventDefault(); setImageUrl(null); }
              }}
              placeholder={t("overlook.addImagePlaceholder")}
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm text-keep-text"
            />
            <button
              type="button"
              onClick={() => void insertImage(imageUrl)}
              className="shrink-0 rounded border border-keep-action bg-keep-action/15 px-2 py-1 text-sm text-keep-action hover:bg-keep-action/30"
            >
              <Link2 size={14} aria-hidden />
              <span className="sr-only">{t("overlook.addImage")}</span>
            </button>
          </div>
          {imageError ? <p className="mt-1 text-xs text-keep-accent">{imageError}</p> : null}
          {!uploadsEnabled ? (
            <p className="mt-1 text-[11px] leading-snug text-keep-muted">{t("overlook.uploadsOff")}</p>
          ) : null}
        </div>
      ) : null}

      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={handleChange}
        onLinkOpen={handleLinkOpen as never}
        viewModeEnabled={!canEdit}
        theme={bridge.theme}
        // Match the app's language so the toolbar and menus aren't stranded
        // in English for Spanish players. Excalidraw ships es-ES; anything
        // it doesn't know falls back to English on its own.
        langCode={i18n.language?.startsWith("es") ? "es-ES" : "en"}
        renderTopRightUI={topRight}
        // The canvas is inside a window, so global key handling would steal
        // shortcuts from chat behind it.
        handleKeyboardGlobally={false}
        UIOptions={{
          canvasActions: {
            // No "load from file" / "save to disk": the canvas belongs to the
            // room or world, not to a local file, and a stray import would
            // silently replace everyone else's work.
            loadScene: false,
            saveToActiveFile: false,
            export: { saveFileToDisk: true },
            toggleTheme: false,
          },
        }}
      />
    </div>
  );
}

export default OverlookCanvas;
