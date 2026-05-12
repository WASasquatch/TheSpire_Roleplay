/**
 * Admin-defined bucket for organizing top-level threads in a nested-mode
 * room. Categories are per-room; users pick one when starting a new
 * top-level message. Replies inherit their parent's category through
 * the thread relationship — they never carry a category id themselves.
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
}
