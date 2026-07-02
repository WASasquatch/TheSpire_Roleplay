/**
 * Referrer + UTM classification for analytics (plan_ext.md §2b).
 *
 * Dependency-free: a compact built-in host→source map covering the major
 * search / social / AI referrers instead of vendoring the Snowplow
 * `referers.json` dataset. Classification precedence:
 *
 *   1. A recognized UTM medium → map to a bucket (utm_source names the source).
 *   2. Else the referrer host matches the built-in map → that source + medium.
 *   3. Else a non-empty referrer host → generic "referral".
 *   4. Else → "direct".
 *
 * The referrer is reduced to a bare hostname before matching; path + query are
 * dropped entirely so we never ingest another site's capability URLs / PII.
 */

export type RefMedium = "search" | "social" | "email" | "referral" | "paid" | "direct";

export interface ReferrerClassification {
  /** Named source when known (e.g. "google", "reddit", "chatgpt"), else null. */
  source: string | null;
  /** search | social | email | referral | paid | direct. */
  medium: RefMedium;
}

/** UTM values a beacon may carry (already lowercased/length-capped upstream). */
export interface Utm {
  source?: string | null;
  medium?: string | null;
}

/**
 * Built-in host→{source, medium} map. Keys are matched as a suffix of the
 * referrer hostname so subdomains (e.g. "www.google.com", "m.facebook.com",
 * "l.instagram.com") resolve to the same source. Ordered conceptually by group;
 * lookup is a linear suffix scan (tiny list, runs off the hot request path via
 * the fire-and-forget ingest).
 */
const HOST_SOURCE: Array<[hostSuffix: string, source: string, medium: RefMedium]> = [
  // Search
  ["google.", "google", "search"],
  ["bing.com", "bing", "search"],
  ["duckduckgo.com", "duckduckgo", "search"],
  ["yahoo.com", "yahoo", "search"],
  ["search.yahoo.com", "yahoo", "search"],
  ["ecosia.org", "ecosia", "search"],
  // Social
  ["twitter.com", "twitter", "social"],
  ["x.com", "twitter", "social"],
  ["t.co", "twitter", "social"],
  ["facebook.com", "facebook", "social"],
  ["fb.com", "facebook", "social"],
  ["reddit.com", "reddit", "social"],
  ["instagram.com", "instagram", "social"],
  ["tiktok.com", "tiktok", "social"],
  ["youtube.com", "youtube", "social"],
  ["youtu.be", "youtube", "social"],
  ["discord.com", "discord", "social"],
  ["discord.gg", "discord", "social"],
  ["discordapp.com", "discord", "social"],
  ["tumblr.com", "tumblr", "social"],
  // AI chatbots
  ["chatgpt.com", "chatgpt", "referral"],
  ["chat.openai.com", "chatgpt", "referral"],
  ["perplexity.ai", "perplexity", "referral"],
  ["gemini.google.com", "gemini", "referral"],
];

/**
 * Map a raw `utm_medium` to a normalized bucket. Recognizes the conventional
 * medium vocabulary; anything unrecognized but present falls back to
 * "referral" so an explicit campaign tag is never silently classed as direct.
 */
function mediumFromUtm(utmMedium: string): RefMedium | null {
  const m = utmMedium.toLowerCase();
  if (!m) return null;
  if (m === "cpc" || m === "ppc" || m === "paid" || m === "paidsearch" || m === "paid-search") return "paid";
  if (m === "email" || m === "newsletter") return "email";
  if (m === "social" || m === "social-network" || m === "social-media" || m === "sm") return "social";
  if (m === "organic" || m === "search") return "search";
  if (m === "referral") return "referral";
  return "referral";
}

/**
 * Classify a referrer. `refHost` MUST already be a bare hostname (no scheme /
 * path / query) — see `hostnameOnly` below. `utm` carries the beacon-supplied
 * UTM source/medium (server-side document GETs have none).
 */
export function classifyReferrer(
  refHost: string | null | undefined,
  utm?: Utm,
): ReferrerClassification {
  // 1. Explicit UTM medium wins — it's the site owner's own tagging.
  const utmMedium = utm?.medium?.trim();
  if (utmMedium) {
    const medium = mediumFromUtm(utmMedium);
    if (medium) {
      const source = utm?.source?.trim().toLowerCase() || null;
      return { source, medium };
    }
  }

  const host = (refHost ?? "").trim().toLowerCase();
  // 4. No referrer at all → direct.
  if (!host) return { source: null, medium: "direct" };

  // 2. Known host → mapped source + medium.
  for (const [suffix, source, medium] of HOST_SOURCE) {
    if (host === suffix || host.endsWith("." + suffix) || host.endsWith(suffix)) {
      return { source, medium };
    }
  }

  // 3. Unknown but present host → generic referral.
  return { source: host, medium: "referral" };
}

/**
 * Reduce a raw referrer / URL string to its bare hostname, dropping scheme,
 * path, query, and fragment. Returns null for empty / unparseable input. This
 * is the ONLY form of a referrer that is ever stored — no path or query string
 * enters the analytics tables (plan_ext.md §2b, §7).
 */
export function hostnameOnly(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    // Tolerate a bare host with no scheme by prefixing one for the parser.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : "http://" + trimmed;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}
