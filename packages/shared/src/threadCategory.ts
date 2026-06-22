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
  /** Private (members-only) category for FORUM boards (migration 0239):
   *  only the forum's owner/mods/members may read topics filed here. The
   *  chip still renders for everyone (shown-but-locked). Standalone nested
   *  rooms never set it. */
  membersOnly?: boolean;
  /** This category is members-only AND the requesting viewer isn't a member —
   *  i.e. locked FOR THEM specifically. Server-computed per request. The UI
   *  uses it to withhold the "+ New Topic" action (and keep the picker from
   *  selecting into it): you can't post where you can't read. Absent/false for
   *  members, owners/mods/staff, the default-forum implicit members, and every
   *  category in a non-board (standalone) room. */
  locked?: boolean;
}

/** Cap for the category subtitle (UI input + server validation). */
export const THREAD_CATEGORY_SUBTITLE_MAX = 140;
