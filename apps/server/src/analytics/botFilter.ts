/**
 * Built-in user-agent bot classifier (plan_ext.md §2d).
 *
 * Deliberately dependency-free: a compact regex over the common self-identifying
 * crawler / monitor / library tokens rather than pulling in the `isbot` package.
 * This is the cheapest layer and catches the traffic that matters for keeping
 * bot hits out of the human-facing counts. `is_bot` is recorded as a COLUMN
 * (flag, don't drop) so read-time queries can `WHERE is_bot = 0` by default and
 * still audit filter accuracy.
 *
 * This is intentionally a broad-strokes filter, not an arms race. New crawlers
 * can be added to the token list; a datacenter-IP heuristic is a possible later
 * layer (see plan_ext.md §2d step 3) but is out of scope here.
 */

/**
 * Common bot / crawler / automation UA tokens. Case-insensitive. Grouped for
 * readability; any single match flags the request as a bot.
 */
const BOT_UA_RE = new RegExp(
  [
    // Generic self-identifiers
    "bot", "crawl", "spider", "slurp",
    // Search engines / SEO
    "googlebot", "bingbot", "yandex", "baiduspider", "duckduckbot",
    "sogou", "exabot", "facebot", "ia_archiver", "ahrefs", "semrush",
    "mj12bot", "dotbot", "petalbot", "bytespider", "seznambot",
    // Social / preview / unfurl fetchers
    "facebookexternalhit", "twitterbot", "discordbot", "slackbot",
    "telegrambot", "whatsapp", "linkedinbot", "pinterest", "redditbot",
    "embedly", "quora link preview", "skypeuripreview", "vkshare",
    // AI crawlers
    "gptbot", "oai-searchbot", "chatgpt-user", "ccbot", "claudebot",
    "anthropic-ai", "claude-web", "perplexitybot", "google-extended",
    "amazonbot", "applebot",
    // Monitors / libraries / headless
    "monitor", "uptime", "pingdom", "statuscake", "headlesschrome",
    "phantomjs", "python-requests", "python-urllib", "go-http-client",
    "java/", "okhttp", "libwww-perl", "curl/", "wget", "httpclient",
    "axios", "node-fetch", "scrapy", "http_request",
    // Feed readers
    "feedfetcher", "feedburner", "feedly", "rss",
  ].join("|"),
  "i",
);

/**
 * Returns true when the user-agent self-identifies as a bot/crawler/automation.
 * A missing or empty UA is treated as a bot: real browsers always send one, so
 * an absent UA on a document/beacon request is far more likely a scripted hit.
 */
export function isBotUA(userAgent: string | null | undefined): boolean {
  if (!userAgent || !userAgent.trim()) return true;
  return BOT_UA_RE.test(userAgent);
}
