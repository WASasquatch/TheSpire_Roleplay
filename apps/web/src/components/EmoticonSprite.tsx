import { useMemo } from "react";
import type { CSSProperties } from "react";
import {
  EMOTICON_SHEET_GRID_COLS,
  EMOTICON_SHEET_GRID_ROWS,
} from "@thekeep/shared";
import { useEmoticons } from "../state/emoticons.js";

interface Props {
  /** Stable sheet identifier. Looked up against the cached catalog. */
  sheetSlug: string;
  /** Row-major 0..15. */
  cellIndex: number;
  /** Pixel size of the rendered cell (square). 24 by default. */
  size?: number;
  /** Optional alt text — falls back to the cell label from the catalog. */
  title?: string;
  /** Extra Tailwind classes (positioning, etc.). */
  className?: string;
}

/**
 * Render a single cell from an emoticon sheet as a square sprite. The
 * sheet image is a 4×4 grid regardless of resolution: we set
 * `backgroundSize: 400% 400%` (4x in each axis) and `backgroundPosition`
 * to the negative offset of the target cell. That keeps the renderer
 * resolution-independent — a 256×256 sheet and a 2048×2048 sheet
 * crop the same cell with no code changes.
 *
 * When the slug doesn't resolve (sheet pruned between catalog fetch
 * and render), we render an empty placeholder of the same size so the
 * row layout doesn't reflow.
 */
export function EmoticonSprite({ sheetSlug, cellIndex, size = 24, title, className }: Props) {
  const sheet = useEmoticons((s) => s.getSheetBySlug(sheetSlug));

  const style: CSSProperties = useMemo(() => {
    if (!sheet) {
      return { width: size, height: size, opacity: 0.3 };
    }
    const col = cellIndex % EMOTICON_SHEET_GRID_COLS;
    const row = Math.floor(cellIndex / EMOTICON_SHEET_GRID_COLS);
    // backgroundPosition X/Y are PERCENTAGES of the area NOT covered
    // by the image — counter-intuitively `0%` is leftmost AND `100%`
    // is rightmost only when the bg is larger than the container. With
    // size 400% × 400% (image scaled to 4× container), the % range
    // for each cell becomes 0%, 33.33%, 66.66%, 100%.
    const xPct = (col / (EMOTICON_SHEET_GRID_COLS - 1)) * 100;
    const yPct = (row / (EMOTICON_SHEET_GRID_ROWS - 1)) * 100;
    return {
      width: size,
      height: size,
      backgroundImage: `url(${sheet.imageUrl})`,
      backgroundRepeat: "no-repeat",
      backgroundSize: `${EMOTICON_SHEET_GRID_COLS * 100}% ${EMOTICON_SHEET_GRID_ROWS * 100}%`,
      backgroundPosition: `${xPct}% ${yPct}%`,
      imageRendering: "auto" as const,
    };
  }, [sheet, cellIndex, size]);

  const altLabel = title ?? sheet?.cells[cellIndex] ?? "";
  return (
    <span
      role="img"
      aria-label={altLabel}
      title={altLabel}
      // `onContextMenu` blocks the right-click menu so casual users
      // can't "Save image as..." the underlying sheet, AND
      // `draggable={false}` blocks drag-to-desktop / drag-to-tab
      // (the other one-click image grab vector). Both are friction
      // only — the sheet PNG is still public at
      // `/assets/emoticons/<slug>_emoticon_sheet.png` and anyone
      // with devtools can pull the URL out of the computed
      // `background-image`. Centralizing here covers every render
      // site (reaction chips, picker grid, inline message tokens,
      // 84px stickers, sticker preview in the picker toolbar,
      // tooltip preview) without a per-callsite audit.
      onContextMenu={(e) => e.preventDefault()}
      draggable={false}
      className={`inline-block shrink-0 select-none align-middle ${className ?? ""}`}
      style={style}
    />
  );
}
