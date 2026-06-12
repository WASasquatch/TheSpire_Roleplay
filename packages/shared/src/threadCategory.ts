/**
 * Admin-defined bucket for organizing top-level threads in a nested-mode
 * room. Categories are per-room; users pick one when starting a new
 * top-level message. Replies inherit their parent's category through
 * the thread relationship, they never carry a category id themselves.
 *
 * Server returns these ordered by `sortOrder` ascending, then
 * `createdAt` for stable tiebreaking.
 */
export interface ThreadCategory {
  id: string;
  roomId: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  /** Custom icon for FORUM boards (migration 0227, uploaded by the forum
   *  owner). Null/absent = the default glyph. Standalone nested rooms
   *  never carry one. */
  iconUrl?: string | null;
  /** One-line "what belongs in here" shown under the category name in
   *  the board's section header (migration 0233). Null/absent = none. */
  subtitle?: string | null;
  /** Parent category id (migration 0235). Set ⇒ this is a SUBCATEGORY
   *  rendered under its parent's section. One level only. */
  parentId?: string | null;
}

/** Cap for the category subtitle (UI input + server validation). */
export const THREAD_CATEGORY_SUBTITLE_MAX = 140;
