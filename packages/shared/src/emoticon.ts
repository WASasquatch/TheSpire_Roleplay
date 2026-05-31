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

/** Per-use coin cost for community emoticons. Hardcoded for v1; can
 *  promote to a per-sheet column later if we want admin-tunable
 *  pricing. The buyer's active identity pays; the sheet creator's
 *  master pool receives. System sheets (createdByUserId IS NULL) are
 *  always free. */
export const COMMUNITY_EMOTICON_USE_COST = 1;

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
  /** "system" = admin-seeded, free to use. "community" = approved
   *  user submission; each use MAY cost `COMMUNITY_EMOTICON_USE_COST`
   *  and routes to the creator's master pool — `commerceEnabled`
   *  decides whether the toll applies. The picker tab UX branches on
   *  this. */
  kind: "system" | "community";
  /** Creator's user id (master account). Null for system sheets.
   *  The pay-to-use endpoint credits this user's master pool. */
  creatorUserId: string | null;
  /** Creator's master username for display ("by @<handle>"). Null
   *  for system sheets. Snapshotted on read; if the creator renames
   *  later the picker refreshes on next sheet broadcast. */
  creatorUsername: string | null;
  /** Owner-controlled commerce switch for COMMUNITY sheets. True =
   *  each use costs the standard fee (paid to the creator); false =
   *  free-to-use, the picker skips the debit entirely. The picker
   *  surfaces a coin badge only when this is true. System sheets
   *  hard-code this to false (they're always free). */
  commerceEnabled: boolean;
  /** Lifetime usage tally for the sheet — every successful pick of
   *  any cell bumps this server-side. Powers the "Top used" sort in
   *  the community tab. System sheets currently leave this at 0
   *  since the community-use endpoint is the only writer. */
  useCount: number;
  /** Epoch ms of the row's creation. Powers the "Newest" / "Oldest"
   *  sorts in the picker's community tab. */
  createdAt: number;
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

/** Reaction reference — what kind of emoji a reaction points at.
 *  Discriminated by `kind` so consumers can branch with full
 *  type-safety. `sheet` is the legacy shape (sticker-sheet cell);
 *  `unicode` is the new shape that holds a raw Unicode codepoint
 *  string (browser-native rendering, no catalog lookup needed).
 *
 *  Exactly one of the two variants is set on every reaction —
 *  enforced at the wire level and at the DB level via the COALESCE
 *  unique index added in migration 0181. */
export type ReactionRef =
  | { kind: "sheet"; sheetSlug: string; cellIndex: number }
  | { kind: "unicode"; char: string };

/** Stable string key for a ReactionRef. Used as a Map key when
 *  client-side code dedupes reactions and as the audit token in
 *  socket events. Mirror the format the server's COALESCE-based
 *  unique index uses so both layers see the same identifier.
 *
 *  Defensive: returns a sentinel when `ref` is missing or malformed.
 *  This guards the entire reaction-rendering pipeline against an
 *  in-flight legacy payload (the wire format added `ref` in 0181 —
 *  any cached/stale entry serialized before that ships without it).
 *  Crashing the picker / message list for the whole user because one
 *  reaction is shaped wrong is not worth it; a "?" entry that just
 *  doesn't merge with anything else is the right failure mode. */
export function reactionRefKey(ref: ReactionRef | null | undefined): string {
  if (!ref || typeof ref !== "object") return "?:invalid";
  if (ref.kind === "sheet") return `${ref.sheetSlug}:${ref.cellIndex}`;
  if (ref.kind === "unicode") return ref.char;
  return "?:invalid";
}

/** Convenience predicate so call sites can write
 *  `if (isUnicodeReaction(entry.ref))` and TypeScript narrows.
 *  Same defensive null-tolerance as `reactionRefKey` — returns false
 *  for a missing/malformed ref so call sites don't have to add their
 *  own pre-check. */
export function isUnicodeReaction(
  ref: ReactionRef | null | undefined,
): ref is Extract<ReactionRef, { kind: "unicode" }> {
  return !!ref && typeof ref === "object" && ref.kind === "unicode";
}

/** One distinct emoji reaction on a single target, plus the list of
 *  identities that placed it. The ReactionBar renders one chip per
 *  entry. The `ref` field carries the discriminator + ref data; the
 *  legacy `sheetSlug`/`cellIndex` flat fields are gone — call sites
 *  branch on `entry.ref.kind`. */
export interface ReactionEntry {
  ref: ReactionRef;
  /** Cached label so the tooltip can show "happy" without re-resolving
   *  through the sheet catalog. For Unicode reactions this is the
   *  best-effort emoji name (e.g. "smile", "heart") used for the
   *  hover tooltip; falls back to the raw glyph when no name is
   *  available. */
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
  ref: ReactionRef;
  label: string;
  op: "add" | "remove";
  actor: {
    userId: string;
    characterId: string | null;
    displayName: string;
    reactedAt: number;
  };
}
