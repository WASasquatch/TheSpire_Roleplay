/**
 * Affiliates v2 — "Roleplay Communities" mini top-sites / webring.
 *
 * Wire types shared by the public card section, the self-service submission
 * portal, and the Global Admin approval queue. Legacy raw-HTML carousel rows
 * survive as `kind='html'`; the new structured cards are `kind='card'`.
 *
 * URLs are partner-supplied (icon / banner / target) and rendered only as
 * `<img>` / `<a>`, never as raw HTML, so cards carry no XSS surface. Every URL
 * is server-validated with `isValidAffiliateUrl` (http/https, length-bounded).
 */

export type AffiliateKind = "card" | "html";
export type AffiliateStatus = "pending" | "approved" | "rejected" | "disabled";
export type AffiliateClickDirection = "in" | "out";

export const AFFILIATE_LIMITS = {
  title: 80,
  description: 300,
  url: 2048,
  maxPerUser: 10, // total entries a member may own
  maxPendingPerUser: 3, // simultaneous un-reviewed
  clickThrottleMs: 12 * 60 * 60 * 1000, // one counted hit per IP/direction per 12h
} as const;

/** Public card shape (no owner/PII). Shown in the Top RP Communities board. */
export interface PublicAffiliateCard {
  id: string;
  title: string;
  description: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  clicksIn: number;
  clicksOut: number;
  /** Normalized discovery tags (genre/category), lowercased. See tags.ts. */
  tags: string[];
}

/**
 * Legacy raw-HTML affiliate badge (the pre-v2 `kind='html'` rows, e.g. a topsite
 * badge with its own tracking pixel). Rendered verbatim as admin-trusted HTML on
 * the splash, same trust posture as `customHeadHtml` — never sanitized. Kept so
 * existing partners (Top RP Sites, etc.) keep showing alongside the new cards.
 */
export interface LegacyAffiliateBadge {
  id: string;
  html: string;
}

/** Public `/affiliates` payload: structured cards + legacy raw-HTML badges. */
export interface PublicAffiliatesResult {
  cards: PublicAffiliateCard[];
  legacy: LegacyAffiliateBadge[];
}

/** A submitter's own entry (adds status + link-back). */
export interface MyAffiliate extends PublicAffiliateCard {
  status: AffiliateStatus;
  targetUrl: string;
  reviewNote: string | null;
  hash: string | null;
  linkBackUrl: string | null; // absolute, present once approved
  createdAt: number;
}

/** Full admin row. */
export interface AdminAffiliate extends MyAffiliate {
  kind: AffiliateKind;
  label: string;
  html: string | null;
  enabled: boolean;
  sortOrder: number;
  ownerUserId: string | null;
  ownerName: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  updatedAt: number;
}

export interface AffiliateSubmitInput {
  title: string;
  description: string;
  iconUrl?: string;
  bannerUrl?: string;
  targetUrl: string;
  /** Discovery tags (genre/category). Normalized + capped server-side. */
  tags?: string[];
}

/** http/https only, length-bounded, rejects javascript:/data:. */
export function isValidAffiliateUrl(u: string): boolean {
  const trimmed = u.trim();
  if (!trimmed || trimmed.length > AFFILIATE_LIMITS.url) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export function affiliateLinkBackUrl(origin: string, hash: string): string {
  return `${origin.replace(/\/$/, "")}/a/${hash}`;
}
