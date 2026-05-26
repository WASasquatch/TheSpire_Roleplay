/**
 * Emoticon system — sticker-sheet reactions for chat, DMs, and (later)
 * forum posts.
 *
 * A sheet is a single 4×4 sprite-sheet image. Cells are addressed by
 * row-major index 0..15. Cell labels live in `cells: string[]` and
 * use the empty-string OR the literal "empty" to mark hidden slots.
 *
 * Reactions are polymorphic: `targetKind` selects which entity the
 * reaction attaches to. App-layer enforces that `targetId` resolves
 * inside the right table; cleanup triggers in the migration cascade
 * orphans on source-row delete.
 */

/** Always 16. Sheets are 4×4 row-major. */
export const EMOTICON_SHEET_CELL_COUNT = 16;
export const EMOTICON_SHEET_GRID_COLS = 4;
export const EMOTICON_SHEET_GRID_ROWS = 4;
/** Display cap before the ReactionBar collapses overflow into a count.
 *  Six matches what fits comfortably on a chat row at default density. */
export const REACTION_BAR_MAX_VISIBLE = 6;

export type ReactionTargetKind = "chat_message" | "dm" | "forum_post";

/** A cell whose label is the empty string OR the literal "empty"
 *  string is hidden from the picker. Centralized so server, client,
 *  and admin all agree. */
export function isEmoticonCellEmpty(label: string | null | undefined): boolean {
  if (label == null) return true;
  const t = label.trim().toLowerCase();
  return t === "" || t === "empty";
}

/** Public catalog shape — what `GET /emoticons` returns. The picker
 *  loads this once on app boot and caches in the zustand store. */
export interface EmoticonSheet {
  id: string;
  slug: string;
  name: string;
  /** Relative URL the sprite component composes into a background-image. */
  imageUrl: string;
  /** Length always 16. Empty entries are hidden from the picker. */
  cells: string[];
  sortOrder: number;
}

/** Compact key the wire uses to refer to a specific emoticon. Renders
 *  as `<sheetSlug>:<cellIndex>`. The slug (not the id) is the stable
 *  identifier; if a sheet is replaced its id may change but slug stays. */
export type EmoticonKey = string;

export function emoticonKey(sheetSlug: string, cellIndex: number): EmoticonKey {
  return `${sheetSlug}:${cellIndex}`;
}

/** Parse an emoticon key back into its parts. Returns null when the
 *  shape is wrong — call sites should treat that as "unknown emoticon"
 *  and skip the chip rather than throwing. */
export function parseEmoticonKey(key: string): { sheetSlug: string; cellIndex: number } | null {
  const idx = key.lastIndexOf(":");
  if (idx <= 0) return null;
  const slug = key.slice(0, idx);
  const n = parseInt(key.slice(idx + 1), 10);
  if (!Number.isFinite(n) || n < 0 || n >= EMOTICON_SHEET_CELL_COUNT) return null;
  return { sheetSlug: slug, cellIndex: n };
}

/** One distinct (sheet, cell) reaction on a single target, plus the
 *  list of identities that placed it. The ReactionBar renders one
 *  chip per entry. */
export interface ReactionEntry {
  sheetSlug: string;
  cellIndex: number;
  /** Cached label so the tooltip can show "happy" without re-resolving
   *  through the sheet catalog. */
  label: string;
  /** Tooltip + expanded list source. Sorted by reactedAt asc so the
   *  "first to react" appears first — Discord's behavior. */
  reactors: Array<{
    userId: string;
    characterId: string | null;
    displayName: string;
    reactedAt: number;
  }>;
  /** True iff the viewing user is in `reactors`. Lets the chip render
   *  the active state without scanning. */
  viewerReacted: boolean;
}

/** Aggregated payload for one target. Returned by the read endpoints
 *  and embedded into message payloads so the bar renders without a
 *  per-row fetch. */
export interface ReactionSummary {
  targetKind: ReactionTargetKind;
  targetId: string;
  entries: ReactionEntry[];
}

/** Realtime push: the server emits this when a reaction is added or
 *  removed. Clients merge it into their cached `ReactionSummary` for
 *  the target without a full refetch. */
export interface ReactionEvent {
  targetKind: ReactionTargetKind;
  targetId: string;
  sheetSlug: string;
  cellIndex: number;
  label: string;
  op: "add" | "remove";
  actor: {
    userId: string;
    characterId: string | null;
    displayName: string;
    reactedAt: number;
  };
}
