/**
 * Broadcast email categories. Each admin broadcast is tagged with one of
 * these, and recipients can unsubscribe per-category (the footer link drops
 * only that class). Transactional account mail (password reset, email
 * verification) is NOT a category and always sends regardless of opt-outs.
 */
export const EMAIL_CATEGORY_KEYS = [
  "announcements",
  "newsletter",
  "events",
  "promotions",
] as const;

export type EmailCategory = (typeof EMAIL_CATEGORY_KEYS)[number];

export const EMAIL_CATEGORY_LABELS: Record<EmailCategory, string> = {
  announcements: "Announcements",
  newsletter: "Newsletter",
  events: "Events",
  promotions: "Offers & promotions",
};

/** Short blurb shown next to each category in the admin picker. */
export const EMAIL_CATEGORY_HINTS: Record<EmailCategory, string> = {
  announcements: "Site news, updates, and important notices.",
  newsletter: "Periodic digests and community highlights.",
  events: "Upcoming events and happenings.",
  promotions: "Offers, sales, and promotional messages.",
};

export const DEFAULT_EMAIL_CATEGORY: EmailCategory = "announcements";

export function isEmailCategory(v: unknown): v is EmailCategory {
  return typeof v === "string" && (EMAIL_CATEGORY_KEYS as readonly string[]).includes(v);
}

export function emailCategoryLabel(v: string): string {
  return isEmailCategory(v) ? EMAIL_CATEGORY_LABELS[v] : v;
}
