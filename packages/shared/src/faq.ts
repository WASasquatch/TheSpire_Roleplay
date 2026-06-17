/**
 * FAQ — admin-authored question/answer entries with per-entry URL slugs.
 *
 * Each entry has a globally-unique slug so a mod can paste a direct link
 * (`/faq/<slug>`) — including to logged-out visitors. The public index lives
 * at `/faqs`. Mirrors the slug/validation pattern of forums (see forum.ts).
 *
 * Wire types here are shared by the public read routes, the public pages,
 * and the admin CRUD tab.
 */

/** Slug shape: lowercase letters, digits, underscore. `/faq/how_worlds_work`. */
export const FAQ_SLUG_RE = /^[a-z0-9_]{3,40}$/;

/** Slugs reserved against route collisions / future surfaces (case-insensitive). */
export const RESERVED_FAQ_SLUGS: ReadonlySet<string> = new Set([
  "faq", "faqs", "api", "admin", "new", "edit", "create",
  "slug_availability", "slug-availability", "all", "index",
]);

export const FAQ_QUESTION_MAX = 200;
export const FAQ_ANSWER_MAX = 8000;
export const FAQ_CATEGORY_MAX = 60;

/**
 * Normalize + validate a candidate slug. Lowercases and trims, then checks the
 * shape and the reserved set. Returns the clean slug or null if invalid.
 */
export function normalizeFaqSlug(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!FAQ_SLUG_RE.test(s)) return null;
  if (RESERVED_FAQ_SLUGS.has(s)) return null;
  return s;
}

/** Public FAQ entry shape (enabled rows). `answerHtml` is sanitized server-side. */
export interface FaqEntry {
  id: string;
  slug: string;
  question: string;
  answerHtml: string;
  category: string | null;
  sortOrder: number;
}

/** Admin FAQ row (adds the draft/audit fields + the markdown source the
 *  editor round-trips, so re-editing doesn't double-wrap the stored HTML). */
export interface FaqAdminEntry extends FaqEntry {
  answerMarkdown: string;
  enabled: boolean;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}
