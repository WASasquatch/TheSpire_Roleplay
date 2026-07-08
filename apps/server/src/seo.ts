import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Db } from "./db/index.js";
import { characters, faqs, forums, servers, stories, users, worlds } from "./db/schema.js";
import { areServersEnabled, getSettings } from "./settings.js";
import { escapeHtml } from "@thekeep/shared";

/**
 * Site-wide keyword shelf shared across every public route. Lead with
 * the term the user-facing complaint identified: searches for
 * "The Spire Chat" should land here, not on RPG-sites unrelated to
 * the actual product. Order matters for some crawlers, most-specific
 * first, broader synonyms later.
 */
const DEFAULT_KEYWORDS =
  "host your own roleplay community, create a roleplay forum, roleplay chat server hosting, " +
  "roleplay chat, RP chat, online roleplay, play-by-post forum, community hosting, forum hosting, " +
  "Discord alternative for roleplay, character roleplay, collaborative fiction, " +
  "writing community, worldbuilding, The Spire chat, The Spire RP";

/**
 * Homepage tagline appended after the admin-configured siteName. Keeps
 * the `<title>` keyword-rich without forcing admins to bake search
 * keywords into the brand name itself, the bare brand still gets to
 * own the `og:site_name` slot. Mirrors the static default in
 * `apps/web/index.html` so the rewritten and bare-GET copies of the
 * page tell the same story to indexers.
 */
const HOMEPAGE_TAGLINE = "Roleplay Chat, Communities & Forums";

/**
 * Generate a fresh nonce for a single HTTP response. Base64 of 16 random
 * bytes, 128 bits is well above the CSP3 floor (the spec asks for ≥
 * 128 bits because the policy directly trusts anything that quotes the
 * nonce). Url-safe so it survives being dropped into an HTML attribute
 * without escaping.
 */
export function generateCspNonce(): string {
  return randomBytes(16).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Tag every inline `<script>` and `<style>` in the HTML with the given
 * CSP nonce so they pass the policy. We touch only tags that don't
 * already carry a `nonce` attribute (idempotent if the source HTML was
 * pre-noncedand catches three different injection sites in one pass:
 *
 *   1. The JSON-LD block in apps/web/index.html.
 *   2. Vite's prod-built `<script type="module" src="/assets/...">` tag.
 *   3. The admin-configured analytics scripts spliced into HEAD_EXTRA.
 *
 * The regex is intentionally simple, we only care about the tag-open
 * sequence and don't try to parse attributes. Anything looking like
 * `<script foo` becomes `<script nonce="…" foo` (and same for `<style`).
 */
function applyNonceToInlineTags(html: string, nonce: string): string {
  return html
    .replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
    .replace(/<style(?![^>]*\bnonce=)/g, `<style nonce="${nonce}"`);
}

/**
 * Server-side SEO rendering for the splash page.
 *
 * The web bundle's index.html ships static meta defaults. On every GET to
 * the splash we read it from disk, swap in the admin-configured siteName,
 * metaDescription, and customHeadHtml, fix up canonical/og:url to the
 * actual request origin, and serve the result. This way crawlers without
 * JavaScript (most non-Google bots, Discord/Slack/Twitter card scrapers,
 * etc.) see live, accurate values.
 *
 * Cost: a single ~3KB file read + a handful of regex replaces per splash
 * GET. With Fastify's filesystem cache and the OS page cache, this is
 * sub-millisecond. Settings are already cached in memory via getSettings.
 */

/**
 * HTML-escape text destined for an attribute value or element body. We
 * also collapse internal newlines to spaces because `meta` tags are
 * single-line and a multi-line description silently truncates in some
 * crawlers.
 */
export function escapeHtmlAttr(text: string): string {
  // Thin wrapper over the shared escaper: collapse whitespace to a single
  // line *before* escaping the full attribute set (`& < > " '`), because
  // `<meta>` tags are single-line and a multi-line value silently truncates
  // in some crawlers. Byte-identical to the former inline copy.
  return escapeHtml(text, { collapseWhitespace: true, doubleQuote: true, singleQuote: true });
}

/**
 * Strip HTML tags and collapse whitespace, returning a plain-text
 * fallback. Used when an admin hasn't set metaDescription explicitly -
 * we derive one from welcomeHtml so crawlers still see something
 * meaningful instead of an empty meta description.
 *
 * Truncates at the nearest word boundary <= maxChars (rough match for
 * the 155-char rule of thumb Google honors).
 */
function stripToText(html: string, maxChars = 155): string {
  // FIRST pass: drop entire tag bodies for tags whose CONTENT is NOT
  // user-visible prose. `<style>` is the load-bearing case, bio
  // sanitization keeps custom CSS for theming, so without this step
  // a 2000-char `.section { … }` block in a user's bio leaked into
  // the og:description verbatim and Discord/Slack cards showed raw
  // CSS in place of a bio excerpt. `<script>` would normally be
  // dropped by the bio sanitizer entirely, but we belt-and-suspenders
  // it here in case any pre-sanitizer data still carries one. The
  // `<iframe>` rule is for the YouTube embed shortcut sanitizeBio
  // allows, its `src` URL would otherwise blob into the snippet.
  // SECOND pass: drop all remaining tag MARKERS so attributes and
  // intentional prose markup don't leak. The body text of `<p>`,
  // `<span>`, etc. survives this pass.
  const stripped = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= maxChars) return stripped;
  const slice = stripped.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim() + "…";
}

/**
 * Format a join date for the statistical profile OG snippet ("…since
 * March 2025"). Month-precision so the snippet stays compact and we
 * don't seed a precise account-creation timestamp into search-result
 * link previews. Returns "" if the input isn't a usable date, the
 * caller falls back to a date-less variant of the description.
 */
function formatJoinDate(input: Date | number | null | undefined): string {
  if (input == null) return "";
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

/**
 * Resolve the absolute request origin (protocol + host) so canonical /
 * og:url can be rewritten correctly behind Fly's proxy. We honor the
 * X-Forwarded-Proto / X-Forwarded-Host headers Fly sets, falling back to
 * the raw req.protocol/req.host for direct connections.
 */
export function originFromRequest(req: FastifyRequest): string {
  const headers = req.headers;
  const proto =
    (headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ||
    req.protocol;
  const host =
    (headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ||
    (headers.host as string | undefined) ||
    "";
  return `${proto}://${host}`;
}

/**
 * Apply the admin-configured SEO + analytics overrides to a copy of
 * index.html and return the rewritten string. Caller is responsible for
 * caching the source HTML across requests (it doesn't change at runtime;
 * a fresh deploy means a fresh process which re-reads on first hit).
 */
export async function renderSplashHtml(
  db: Db,
  origin: string,
  pathname: string,
  sourceHtml: string,
  /**
   * Optional CSP nonce. When provided, every inline `<script>` /
   * `<style>` in the rendered HTML (the JSON-LD block, Vite's main
   * bundle tag, and any analytics scripts the admin spliced via
   * customHeadHtml) gets `nonce="…"` so a strict `script-src 'nonce-…'`
   * CSP can permit them while still rejecting injected scripts.
   */
  nonce?: string,
): Promise<string> {
  let html = sourceHtml;

  const s = await getSettings(db);

  const siteName = s.siteName?.trim() || "The Spire";
  const siteDescription =
    s.metaDescription?.trim() ||
    (s.welcomeHtml ? stripToText(s.welcomeHtml) : "") ||
    "Host your own roleplay chat community or forum, or dive into live RP chat, character profiles, worlds, and collaborative writing.";
  // Admin overrides fall back to the built-in defaults when blank.
  const tagline = s.homepageTagline?.trim() || HOMEPAGE_TAGLINE;
  const defaultKeywords = s.seoKeywords?.trim() || DEFAULT_KEYWORDS;

  // Per-route SEO. Every public bookmarkable page gets its own title,
  // description, canonical URL, and keyword shelf, otherwise crawlers
  // see N identical pages and duplicate-content rules collapse them,
  // costing us the targeted keyword space. Routes serving real data
  // (profiles, worlds, stories) do a tiny scoped DB read to pull the
  // record's name + bio/summary; private / NSFW / nonexistent rows fall
  // through to site defaults so we never leak the existence of a
  // hidden entity in OG metadata.
  let title: string;
  let description: string;
  let keywords: string;
  let canonicalUrl: string;
  const perRoute = await resolveRouteMeta(db, pathname, origin, siteName, siteDescription, tagline, defaultKeywords);
  ({ title, description, keywords, canonicalUrl } = perRoute);

  const titleAttr = escapeHtmlAttr(title);
  const descAttr = escapeHtmlAttr(description);
  const urlAttr = escapeHtmlAttr(canonicalUrl);
  const keywordsAttr = escapeHtmlAttr(keywords);
  // OG object type: "website" for landing/index pages, "article" for a single
  // authored work (a story, a profile). Static default in index.html is
  // "website", so we only need to rewrite when the route asked for something else.
  const ogType = perRoute.ogType || "website";
  // og:site_name owns the BARE brand across every page (not the tagged
  // per-page title) — that's what the OG spec wants in that slot.
  const siteNameAttr = escapeHtmlAttr(siteName);
  // Social-card image, resolved in priority order: a per-route image (a
  // forum/server banner), then the admin's default og:image, then null (the
  // og:image replace below falls back to absolutizing the card baked into
  // index.html). Root-relative values are absolutized to the request origin.
  const absolutize = (u: string): string =>
    /^https?:\/\//i.test(u) ? u : `${origin}${u.startsWith("/") ? "" : "/"}${u}`;
  const socialImage = perRoute.imageUrl?.trim() || s.ogImageUrl?.trim() || "";
  const routeOgImage = socialImage ? absolutize(socialImage) : null;

  // Replace tags by exact-attribute match. Each replace is targeted to a
  // specific tag name + attribute so they don't trip over each other.
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${titleAttr}</title>`)
    .replace(
      /<meta name="description" content="[^"]*"\s*\/?>/,
      `<meta name="description" content="${descAttr}" />`,
    )
    .replace(
      // Per-route keyword shelf. Google ignores `<meta name="keywords">`
      // but Bing, DuckDuckGo, and a long tail of niche crawlers still
      // index it, and Discord / Slack card scrapers pass it through to
      // their previews. Cheap inclusion, measurable upside.
      /<meta name="keywords" content="[^"]*"\s*\/?>/,
      `<meta name="keywords" content="${keywordsAttr}" />`,
    )
    .replace(
      /<link rel="canonical" href="[^"]*"\s*\/?>/,
      `<link rel="canonical" href="${urlAttr}" />`,
    )
    .replace(
      /<meta property="og:title" content="[^"]*"\s*\/?>/,
      `<meta property="og:title" content="${titleAttr}" />`,
    )
    .replace(
      /<meta property="og:description" content="[^"]*"\s*\/?>/,
      `<meta property="og:description" content="${descAttr}" />`,
    )
    .replace(
      /<meta property="og:url" content="[^"]*"\s*\/?>/,
      `<meta property="og:url" content="${urlAttr}" />`,
    )
    .replace(
      /<meta property="og:site_name" content="[^"]*"\s*\/?>/,
      `<meta property="og:site_name" content="${siteNameAttr}" />`,
    )
    .replace(
      /<meta property="og:type" content="[^"]*"\s*\/?>/,
      `<meta property="og:type" content="${escapeHtmlAttr(ogType)}" />`,
    )
    .replace(
      /<meta name="twitter:title" content="[^"]*"\s*\/?>/,
      `<meta name="twitter:title" content="${titleAttr}" />`,
    )
    .replace(
      /<meta name="twitter:description" content="[^"]*"\s*\/?>/,
      `<meta name="twitter:description" content="${descAttr}" />`,
    )
    // Absolutize the social-card image: some scrapers (older Facebook /
    // LinkedIn, some Slack paths) reject a root-relative og:image. Prepend
    // the live request origin to whatever root-relative path index.html ships.
    .replace(
      /<meta property="og:image" content="(\/[^"]*)"\s*\/?>/,
      (_m, p: string) => `<meta property="og:image" content="${escapeHtmlAttr(routeOgImage ?? (origin + p))}" />`,
    )
    .replace(
      /<meta name="twitter:image" content="(\/[^"]*)"\s*\/?>/,
      (_m, p: string) => `<meta name="twitter:image" content="${escapeHtmlAttr(routeOgImage ?? (origin + p))}" />`,
    );

  // Auth / transactional pages: inject a robots noindex,follow meta so
  // they aren't indexed as near-duplicates of the homepage (and so single-
  // use tokens in /reset-password + /verify-email URLs never enter an
  // index). `follow` keeps their outbound links crawlable. index.html
  // ships no robots meta by default, so a bare insert into <head> is safe;
  // we splice right after the opening <head> tag.
  if (!s.searchIndexingEnabled) {
    // Master indexing switch is off (staging / pre-launch): tell every crawler
    // to drop the WHOLE site, site-wide, regardless of route. Stronger than the
    // per-route noindex,follow below, so it wins and we skip that branch.
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>\n  <meta name="robots" content="noindex,nofollow" />`,
    );
  } else if (perRoute.noindex) {
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>\n  <meta name="robots" content="noindex,follow" />`,
    );
  }

  // Search-engine ownership-verification tokens. Admins paste only the content
  // token from Google Search Console / Bing Webmaster Tools; we build the
  // escaped `<meta>` and splice it into <head>. Empty = no tag (the common
  // case once verification is done, since the DNS/file method can replace it).
  if (s.googleSiteVerification?.trim()) {
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>\n  <meta name="google-site-verification" content="${escapeHtmlAttr(s.googleSiteVerification.trim())}" />`,
    );
  }
  if (s.bingSiteVerification?.trim()) {
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>\n  <meta name="msvalidate.01" content="${escapeHtmlAttr(s.bingSiteVerification.trim())}" />`,
    );
  }

  // JSON-LD: replace the whole script block. We rebuild it rather than
  // surgically edit fields because the Schema.org payload is short and
  // the alternative (multiple regex substitutions inside a JSON literal)
  // would be more fragile than a one-shot rewrite.
  // A small entity @graph rather than a lone WebApplication: Organization +
  // WebSite establish the brand/site entity (helps Google's knowledge panel +
  // sitelinks), WebApplication describes the running app, and on the homepage a
  // Service node maps the new "host your own community/forum" offering. Nodes
  // are cross-linked by @id. No SearchAction — there's no public GET search
  // endpoint to point it at, and a dangling one is worse than none.
  const orgId = `${origin}/#organization`;
  const siteId = `${origin}/#website`;
  // Organization logo: prefer the admin's logo image, then the default og:image,
  // then the hardcoded favicon. Absolutize any root-relative value so the
  // JSON-LD carries a fully-qualified URL (Google requires an absolute logo).
  const orgLogo = s.logoUrl?.trim()
    ? absolutize(s.logoUrl.trim())
    : s.ogImageUrl?.trim()
      ? absolutize(s.ogImageUrl.trim())
      : `${origin}/favicon-196x196.png`;
  // Social profiles -> Organization.sameAs. One URL per line in settings;
  // filter to http(s) so a stray note line can't pollute the array.
  const sameAs = (s.socialProfileUrls || "")
    .split(/[\r\n]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
  const organization: Record<string, unknown> = {
    "@type": "Organization",
    "@id": orgId,
    name: siteName,
    url: `${origin}/`,
    logo: orgLogo,
  };
  if (sameAs.length > 0) organization.sameAs = sameAs;
  const graph: Array<Record<string, unknown>> = [
    organization,
    {
      "@type": "WebSite",
      "@id": siteId,
      name: siteName,
      url: `${origin}/`,
      publisher: { "@id": orgId },
    },
    {
      // SoftwareApplication + WebApplication: names the running product as a
      // free social app so Google can surface a rich product/app result. The
      // free `offers` node is what unlocks the price/offer rendering; keeping
      // it at 0 USD is honest (the app is free to use) and satisfies the
      // structured-data validator, which flags a SoftwareApplication with no
      // price/rating/review.
      "@type": ["SoftwareApplication", "WebApplication"],
      name: title,
      description,
      applicationCategory: "SocialNetworkingApplication",
      operatingSystem: "Web",
      url: canonicalUrl,
      isPartOf: { "@id": siteId },
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
  ];
  if (pathname === "/") {
    graph.push({
      "@type": "Service",
      name: `Community & forum hosting on ${siteName}`,
      serviceType: "Online community and forum hosting",
      description: `Create and run your own roleplay chat community or forum on ${siteName}, with rooms, members, roles, moderation, and a shareable public page.`,
      provider: { "@id": orgId },
      areaServed: "Worldwide",
      url: `${origin}/`,
    });
  }
  const ldJson = JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">${ldJson}</script>`,
  );

  // Splice the admin-configured custom head HTML (analytics scripts) in
  // place of the marker. If there's no marker (e.g. someone edited
  // index.html and removed it) we fall through silently rather than
  // hard-failing - SEO defaults still ship.
  if (s.customHeadHtml && s.customHeadHtml.trim()) {
    html = html.replace(
      /<!-- HEAD_EXTRA[^>]*-->/,
      // Note: customHeadHtml is admin-trusted RAW HTML for analytics
      // tags. We deliberately do NOT escape - the entire point is to let
      // <script> tags through.
      s.customHeadHtml,
    );
  }

  // Crawlable homepage body: the SPA boots into an empty `<div id="root">`, so a
  // crawler that doesn't execute JS (some Bing paths + a long tail of niche /
  // non-rendering agents) sees no headings, prose, or internal links on `/`.
  // Inject a <noscript> hero with the positioning copy + the key public links so
  // those agents get real indexable content and link equity flows to /register,
  // /f/spire, and /scriptorium. JS clients never render <noscript> (no FOUC),
  // and Google renders the full app. Homepage only — deep routes carry their own
  // content and their own per-route <head> meta.
  if (pathname === "/") {
    const nameText = escapeHtmlAttr(siteName);
    const noscript =
      `<noscript>` +
      `<main>` +
      `<h1>${nameText}</h1>` +
      `<p>${nameText} is a home for live, text-based roleplay, and a platform where anyone can host their own community. Join the roleplay, or create your own chat community and forums with your own rooms, members, roles, and moderation.</p>` +
      `<p>Step into live roleplay chat rooms, build characters, explore shared worlds, write collaborative stories in the Scriptorium, or host your own community or forum.</p>` +
      `<ul>` +
      `<li><a href="/register">Create your free account</a></li>` +
      `<li><a href="/login">Log in</a></li>` +
      `<li><a href="/f/spire">Browse the ${nameText} forums</a></li>` +
      `<li><a href="/scriptorium">Read stories in the Scriptorium</a></li>` +
      `</ul>` +
      `<p>This page needs JavaScript enabled for the full experience.</p>` +
      `</main></noscript>`;
    html = html.replace('<div id="root"></div>', `<div id="root"></div>\n    ${noscript}`);
  }

  // Surface the CSP nonce to runtime JS via a `<meta>` tag so client
  // code that dynamically creates `<style>` / `<script>` elements
  // (the name-style catalog injector + per-user CSS-var stamper)
  // can stamp the nonce on them, otherwise the strict
  // `style-src 'self' 'nonce-…'` CSP blocks every dynamic stylesheet
  // and name-style classes simply don't apply (chat names render
  // as plain text on prod even though local dev works). We splice
  // this before the nonce-stamp pass below so the meta tag itself
  // doesn't need a nonce (it isn't a script/style).
  if (nonce) {
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>\n  <meta name="csp-nonce" content="${escapeHtmlAttr(nonce)}" />`,
    );
  }

  // Final pass: stamp every script/style with the nonce so the strict
  // CSP we ship in the response header doesn't reject them. Must run
  // AFTER the HEAD_EXTRA splice above so admin-injected scripts are
  // covered too.
  if (nonce) html = applyNonceToInlineTags(html, nonce);

  return html;
}

/** Robots.txt body. Allows everything (auth wall handles privacy) and
 *  points crawlers at our sitemap.
 *
 *  Explicit AI-crawler stanzas: we WANT discovery via LLM search + answer
 *  engines, so we name the major training / retrieval agents and allow them
 *  outright. Without a named stanza some of these ignore the `User-agent: *`
 *  wildcard (or a publisher's absence of an explicit allow reads as a soft
 *  opt-out to their tooling). Covers OpenAI (GPTBot training, OAI-SearchBot +
 *  ChatGPT-User retrieval), Perplexity, Anthropic's ClaudeBot, and Google's
 *  Google-Extended (Gemini / Vertex training control, separate from Googlebot). */
export async function renderRobotsTxt(db: Db, origin: string): Promise<string> {
  // Master indexing switch. When an admin turns indexing off (staging /
  // pre-launch), we serve a blanket disallow so compliant crawlers drop the
  // site from their index. renderSplashHtml separately injects a noindex meta
  // for the JS-rendering crawlers that ignore robots.txt for indexing.
  const s = await getSettings(db);
  if (!s.searchIndexingEnabled) {
    return ["User-agent: *", "Disallow: /", ""].join("\n");
  }
  const aiAgents = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "PerplexityBot",
    "ClaudeBot",
    "Google-Extended",
  ];
  const lines: string[] = ["User-agent: *", "Allow: /", ""];
  for (const agent of aiAgents) {
    lines.push(`User-agent: ${agent}`, "Allow: /", "");
  }
  lines.push(`Sitemap: ${origin}/sitemap.xml`, "");
  return lines.join("\n");
}

/** Sitemap.xml. Exposes the public entrance URLs plus deep links for
 *  every published SFW story, public profile, and public world. Caps
 *  each category at 1000 to keep the sitemap small and snappy.
 *
 *  Privacy fence (matches the per-route SEO rules in `resolveRouteMeta`):
 *    - Stories: only `visibility = "public"`, `status` not draft/abandoned,
 *      rating in `G | PG | PG-13`. R / NC-17 are NEVER listed regardless of
 *      catalog visibility.
 *    - Profiles: only `users.isPublic = true && !isNsfw`. Characters are
 *      reachable via the same `/p/:name` route the SPA exposes but listing
 *      characters in addition to master usernames could double up the same
 *      person, we stick to master accounts here for cleaner crawl shape.
 *    - Worlds: any non-private world (public OR open).
 */
export async function renderSitemapXml(db: Db, origin: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  // /s/ community pages only exist when the servers feature is on; skip them in
  // the sitemap otherwise so we never advertise URLs that 404. Forums (/f/) are
  // always available.
  const serversOn = areServersEnabled(await getSettings(db));
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    `  <url>`,
    `    <loc>${origin}/</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>weekly</changefreq>`,
    `    <priority>1.0</priority>`,
    `  </url>`,
    `  <url>`,
    `    <loc>${origin}/register</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>monthly</changefreq>`,
    `    <priority>0.9</priority>`,
    `  </url>`,
    `  <url>`,
    `    <loc>${origin}/login</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>monthly</changefreq>`,
    `    <priority>0.6</priority>`,
    `  </url>`,
    `  <url>`,
    `    <loc>${origin}/scriptorium</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>daily</changefreq>`,
    `    <priority>0.8</priority>`,
    `  </url>`,
    `  <url>`,
    `    <loc>${origin}/faqs</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>monthly</changefreq>`,
    `    <priority>0.5</priority>`,
    `  </url>`,
    `  <url>`,
    `    <loc>${origin}/top-communities</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>daily</changefreq>`,
    `    <priority>0.7</priority>`,
    `  </url>`,
  ];

  // Public + SFW (G/PG/PG-13) published stories. The previous version
  // pointed at `/stories/@…`, those URLs 404 because the actual
  // route is `/scriptorium/@…` (see index.ts:1396). Fixed here so
  // crawlers don't blacklist us for serving a sitemap full of 404s.
  try {
    const rows = await db
      .select({
        slug: stories.slug,
        updatedAt: stories.updatedAt,
        handle: users.username,
      })
      .from(stories)
      .innerJoin(users, eq(users.id, stories.authorUserId))
      .where(and(
        eq(stories.visibility, "public"),
        ne(stories.status, "draft"),
        ne(stories.status, "abandoned"),
        or(
          eq(stories.rating, "G"),
          eq(stories.rating, "PG"),
          eq(stories.rating, "PG-13"),
        ),
      ))
      .orderBy(desc(stories.updatedAt))
      .limit(1000);
    for (const r of rows) {
      const day = new Date(+r.updatedAt).toISOString().slice(0, 10);
      const loc = `${origin}/scriptorium/@${encodeURIComponent(r.handle.toLowerCase())}/${encodeURIComponent(r.slug)}`;
      lines.push(
        `  <url>`,
        `    <loc>${loc}</loc>`,
        `    <lastmod>${day}</lastmod>`,
        `    <changefreq>weekly</changefreq>`,
        `    <priority>0.5</priority>`,
        `  </url>`,
      );
    }
  } catch { /* swallow, the sitemap still serves the entrance URLs */ }

  // Public, non-NSFW user profiles. Master accounts only (characters
  // share the same /p/:name space, adding them too would double-list
  // the same person from a search-results perspective).
  try {
    const rows = await db
      .select({
        username: users.username,
      })
      .from(users)
      .where(and(
        eq(users.isPublic, true),
        eq(users.isNsfw, false),
      ))
      .orderBy(desc(users.createdAt))
      .limit(1000);
    for (const r of rows) {
      const loc = `${origin}/p/${encodeURIComponent(r.username.toLowerCase())}`;
      lines.push(
        `  <url>`,
        `    <loc>${loc}</loc>`,
        `    <changefreq>weekly</changefreq>`,
        `    <priority>0.4</priority>`,
        `  </url>`,
      );
    }
  } catch { /* swallow */ }

  // Non-private worlds (public + open). World owners explicitly chose
  // a non-private visibility, so listing them here matches their
  // intent that the world be discoverable.
  try {
    const rows = await db
      .select({
        slug: worlds.slug,
        updatedAt: worlds.updatedAt,
      })
      .from(worlds)
      .where(ne(worlds.visibility, "private"))
      .orderBy(desc(worlds.updatedAt))
      .limit(1000);
    for (const r of rows) {
      const day = new Date(+r.updatedAt).toISOString().slice(0, 10);
      const loc = `${origin}/w/${encodeURIComponent(r.slug)}`;
      lines.push(
        `  <url>`,
        `    <loc>${loc}</loc>`,
        `    <lastmod>${day}</lastmod>`,
        `    <changefreq>weekly</changefreq>`,
        `    <priority>0.4</priority>`,
        `  </url>`,
      );
    }
  } catch { /* swallow */ }

  // Public community forums: owner opted into public browsing, or the system
  // forum. These are the "host your own" landing pages we most want indexed.
  try {
    const rows = await db
      .select({ slug: forums.slug })
      .from(forums)
      .where(and(
        ne(forums.status, "archived"),
        or(eq(forums.publicBrowsing, true), eq(forums.isSystem, true)),
      ))
      .orderBy(desc(forums.createdAt))
      .limit(1000);
    for (const r of rows) {
      lines.push(
        `  <url>`,
        `    <loc>${origin}/f/${encodeURIComponent(r.slug.toLowerCase())}</loc>`,
        `    <changefreq>daily</changefreq>`,
        `    <priority>0.6</priority>`,
        `  </url>`,
      );
    }
  } catch { /* swallow */ }

  // Public, non-archived, non-moderated community servers (mirrors the discover
  // filter; suspended / banned-unexpired hidden via lazy expiry). Flag-gated.
  if (serversOn) {
    try {
      const rows = await db
        .select({ slug: servers.slug })
        .from(servers)
        .where(and(
          eq(servers.visibility, "public"),
          sql`${servers.status} != 'archived'`,
          sql`${servers.moderationState} != 'suspended'`,
          sql`not (${servers.moderationState} = 'banned' and (${servers.moderationUntil} is null or ${servers.moderationUntil} > ${Date.now()}))`,
        ))
        .orderBy(desc(servers.createdAt))
        .limit(1000);
      for (const r of rows) {
        lines.push(
          `  <url>`,
          `    <loc>${origin}/s/${encodeURIComponent(r.slug.toLowerCase())}</loc>`,
          `    <changefreq>daily</changefreq>`,
          `    <priority>0.6</priority>`,
          `  </url>`,
        );
      }
    } catch { /* swallow */ }
  }

  lines.push(`</urlset>`, "");
  return lines.join("\n");
}

/** Resolve the path to the built web bundle's index.html. Mirrors the
 *  path math fastify-static uses elsewhere in index.ts. */
export function resolveIndexHtmlPath(serverDir: string): string {
  return resolve(serverDir, "..", "..", "web", "dist", "index.html");
}

interface RouteMeta {
  title: string;
  description: string;
  keywords: string;
  canonicalUrl: string;
  /** Optional per-route social-card image (e.g. a forum/server banner). Root-
   *  relative or absolute; absolutized to the request origin before use. When
   *  omitted, the default card baked into index.html is used. */
  imageUrl?: string | null;
  /** OpenGraph object type. Defaults to "website"; content routes that
   *  represent a single authored work (a story, a profile) set "article" so
   *  scrapers treat them as first-class content rather than a site landing
   *  page. Driven into `og:type` by renderSplashHtml. */
  ogType?: string;
  /** When true, renderSplashHtml injects `<meta name="robots"
   *  content="noindex,follow">`. Used for auth/transactional pages
   *  (login/register/password reset/verify) so they don't get indexed as
   *  near-duplicates of the homepage while still letting crawlers follow the
   *  links out of them. */
  noindex?: boolean;
}

/**
 * Per-route SEO resolver. Dispatches on `pathname` to a route-specific
 * meta block, doing a single small DB read when the route serves real
 * data (profile / world / story). Privacy fence: only public,
 * non-NSFW, non-draft rows produce route-specific meta. Anything else
 * (private, NSFW, missing) falls through to a generic block with a
 * canonical URL pointing back at `/` so we don't leak the existence of
 * a hidden entity and don't fragment crawler dedup across broken
 * deep-links.
 *
 * Title format: `{Specific thing} · {SiteName}`, pipe-delimited
 * variants sometimes show up in tweaked SEO advice, but the middle dot
 * matches what `apps/web/src/lib/scriptoriumUrl.ts` and similar use
 * for in-app breadcrumbs, so the format stays consistent across
 * server-rendered and client-rendered views.
 */
async function resolveRouteMeta(
  db: Db,
  pathname: string,
  origin: string,
  siteName: string,
  siteDescription: string,
  /** Admin-configured tagline (or the built-in HOMEPAGE_TAGLINE default). */
  tagline: string,
  /** Admin-configured keyword shelf (or the built-in DEFAULT_KEYWORDS default). */
  defaultKeywords: string,
): Promise<RouteMeta> {
  // ---- bookmarkable form pages ----
  // Auth + transactional pages get a noindex,follow marker: they're
  // thin near-duplicates of the homepage (same splash chrome, a form on
  // top) and, for password-reset / verify-email, carry single-use tokens
  // in the URL that should never land in a search index. `follow` keeps
  // the outbound links (to /register, the homepage) crawlable so link
  // equity still flows. Canonical stays self-referential for the ones we
  // keep in the sitemap (login/register) so nothing collapses onto `/`.
  if (pathname === "/login") {
    return {
      title: `Log in · ${siteName} - ${tagline}`,
      description: `Sign in to ${siteName} to continue your stories, manage characters, and rejoin your roleplay rooms.`,
      keywords: `${defaultKeywords}, login, sign in`,
      canonicalUrl: `${origin}/login`,
      noindex: true,
    };
  }
  if (pathname === "/register") {
    return {
      title: `Create your character · ${siteName} - ${tagline}`,
      description: `Join ${siteName}. Build a character, step into the worlds, and find your roleplay circle. Free to sign up.`,
      keywords: `${defaultKeywords}, sign up, create account, character creation`,
      canonicalUrl: `${origin}/register`,
      noindex: true,
    };
  }
  if (pathname === "/forgot-password" || pathname === "/reset-password" || pathname === "/verify-email") {
    return {
      title: `Account access · ${siteName}`,
      description: siteDescription,
      keywords: defaultKeywords,
      canonicalUrl: `${origin}/`,
      noindex: true,
    };
  }

  // ---- Scriptorium catalog ----
  if (pathname === "/scriptorium") {
    return {
      title: `Scriptorium - Collaborative Stories · ${siteName}`,
      description: `Read and write collaborative roleplay fiction on ${siteName}. The Scriptorium hosts open-invite stories, one-shots, and long-form serials from the community.`,
      keywords: `${defaultKeywords}, scriptorium, collaborative stories, story catalog, fanfiction, serial fiction, one-shots`,
      canonicalUrl: `${origin}/scriptorium`,
    };
  }

  // ---- Individual story permalink: /scriptorium/@handle/slug ----
  const storyMatch = pathname.match(/^\/scriptorium\/@([^/]+)\/([^/]+)\/?$/);
  if (storyMatch) {
    const handle = decodeURIComponent(storyMatch[1]!);
    const slug = decodeURIComponent(storyMatch[2]!);
    try {
      const row = (await db
        .select({
          title: stories.title,
          summary: stories.summary,
          synopsisHtml: stories.synopsisHtml,
          tags: stories.tags,
          authorUsername: users.username,
        })
        .from(stories)
        .innerJoin(users, eq(users.id, stories.authorUserId))
        .where(and(
          eq(stories.slug, slug),
          sql`lower(${users.username}) = lower(${handle})`,
          eq(stories.visibility, "public"),
          ne(stories.status, "draft"),
          ne(stories.status, "abandoned"),
          or(
            eq(stories.rating, "G"),
            eq(stories.rating, "PG"),
            eq(stories.rating, "PG-13"),
          ),
        ))
        .limit(1))[0];
      if (row) {
        // Prefer summary; fall back to a synopsis snippet if the
        // author left summary blank.
        const desc = row.summary?.trim()
          || (row.synopsisHtml ? stripToText(row.synopsisHtml) : "")
          || `A story by @${row.authorUsername} on ${siteName}.`;
        const tagKeywords = (row.tags || "")
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .slice(0, 8)
          .join(", ");
        const keywords = [tagKeywords, "story", "scriptorium", defaultKeywords]
          .filter(Boolean)
          .join(", ");
        return {
          title: `${row.title} by @${row.authorUsername} · Scriptorium · ${siteName}`,
          description: desc,
          keywords,
          canonicalUrl: `${origin}/scriptorium/@${encodeURIComponent(row.authorUsername.toLowerCase())}/${encodeURIComponent(slug)}`,
          ogType: "article",
        };
      }
    } catch { /* fall through */ }
    // Private / no match, generic Scriptorium meta, canonical at the catalog.
    return {
      title: `Scriptorium - Collaborative Stories · ${siteName}`,
      description: siteDescription,
      keywords: defaultKeywords,
      canonicalUrl: `${origin}/scriptorium`,
    };
  }

  // ---- FAQ index: /faqs ----
  // A strong long-tail surface (people search exact questions). Self-
  // canonicalizes so it ranks as its own page instead of dedup'ing onto `/`.
  if (pathname === "/faqs") {
    return {
      title: `Help & FAQ · ${siteName}`,
      description: `Answers to common questions about ${siteName}: getting started, roleplay chat, characters, communities, forums, and account help.`,
      keywords: `${defaultKeywords}, faq, help, questions, getting started, how to`,
      canonicalUrl: `${origin}/faqs`,
    };
  }

  // ---- Individual FAQ permalink: /faq/:slug ----
  // Scoped DB read like the story branch: only an enabled, PLATFORM-scoped
  // (serverId IS NULL) FAQ produces route-specific meta. Server-scoped or
  // disabled entries, and unknown slugs, fall through to the /faqs index
  // canonical so a share/crawl of a stale link doesn't self-canonicalize to `/`.
  const faqMatch = pathname.match(/^\/faq\/([^/]+)\/?$/);
  if (faqMatch) {
    const slug = decodeURIComponent(faqMatch[1]!);
    try {
      const row = (await db
        .select({
          question: faqs.question,
          answerHtml: faqs.answerHtml,
          slug: faqs.slug,
        })
        .from(faqs)
        .where(and(
          sql`lower(${faqs.slug}) = lower(${slug})`,
          eq(faqs.enabled, true),
          isNull(faqs.serverId),
        ))
        .limit(1))[0];
      if (row) {
        const desc = (row.answerHtml ? stripToText(row.answerHtml) : "")
          || `An answer to "${row.question}" on ${siteName}.`;
        return {
          title: `${row.question} · Help & FAQ · ${siteName}`,
          description: desc,
          keywords: `${row.question}, faq, help, ${defaultKeywords}`,
          canonicalUrl: `${origin}/faq/${encodeURIComponent(row.slug.toLowerCase())}`,
        };
      }
    } catch { /* fall through */ }
    return {
      title: `Help & FAQ · ${siteName}`,
      description: siteDescription,
      keywords: defaultKeywords,
      canonicalUrl: `${origin}/faqs`,
    };
  }

  // ---- Top Communities webring: /top-communities ----
  // The public topsite board mirrored to the open web. Self-canonicalizes so
  // the webring ranks as its own discovery surface rather than collapsing onto `/`.
  if (pathname === "/top-communities") {
    return {
      title: `Top Communities · ${siteName}`,
      description: `Discover the top roleplay communities, chat servers, and forums featured on ${siteName}. Browse the webring and find your next home for RP.`,
      keywords: `${defaultKeywords}, top communities, roleplay communities, community directory, webring, discover`,
      canonicalUrl: `${origin}/top-communities`,
    };
  }

  // ---- Profile: /p/:name or /u/:name ----
  // Try master account first; fall back to character lookup so
  // `/p/<characterName>` resolves too. Both gates require isPublic &&
  // !isNsfw before the name escapes into OG.
  //
  // Description is deliberately STATISTICAL (join date for users, a
  // canned line for characters) rather than bio-derived: even on
  // isPublic+!isNsfw rows, the bio is free-form user-authored content
  // that can carry adult subject matter, slurs, or doxxing material the
  // owner is fine showing in-app but didn't intend to seed into Discord
  // / Slack / Twitter / search-result link previews. Keeping the OG
  // snippet to facts the system itself owns means a profile share
  // surfaces "<name> joined on <date>" rather than potentially leaking
  // a sensitive bio excerpt.
  const profileMatch = pathname.match(/^\/(?:p|u)\/([^/]+)\/?$/);
  if (profileMatch) {
    const name = decodeURIComponent(profileMatch[1]!);
    try {
      const userRow = (await db
        .select({
          username: users.username,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(and(
          sql`lower(${users.username}) = lower(${name})`,
          eq(users.isPublic, true),
          eq(users.isNsfw, false),
        ))
        .limit(1))[0];
      if (userRow) {
        const joined = formatJoinDate(userRow.createdAt);
        const description = joined
          ? `${userRow.username} has been roleplaying on ${siteName} since ${joined}.`
          : `${userRow.username} is a roleplayer on ${siteName}.`;
        return {
          title: `${userRow.username} - Roleplay Profile · ${siteName}`,
          description,
          keywords: `${userRow.username}, roleplay profile, character, ${defaultKeywords}`,
          canonicalUrl: `${origin}/p/${encodeURIComponent(userRow.username.toLowerCase())}`,
          ogType: "article",
        };
      }
      const charRow = (await db
        .select({
          name: characters.name,
        })
        .from(characters)
        .where(and(
          sql`lower(${characters.name}) = lower(${name})`,
          eq(characters.isPublic, true),
          eq(characters.isNsfw, false),
          isNull(characters.deletedAt),
        ))
        .limit(1))[0];
      if (charRow) {
        return {
          title: `${charRow.name} - Roleplay Character · ${siteName}`,
          description: `${charRow.name} is a roleplay character on ${siteName}. Find them in chat to start a scene.`,
          keywords: `${charRow.name}, roleplay character, ${defaultKeywords}`,
          canonicalUrl: `${origin}/p/${encodeURIComponent(charRow.name.toLowerCase())}`,
          ogType: "article",
        };
      }
    } catch { /* fall through */ }
    return {
      title: `${siteName} - ${tagline}`,
      description: siteDescription,
      keywords: defaultKeywords,
      canonicalUrl: `${origin}/`,
    };
  }

  // ---- World: /w/:slug ----
  const worldMatch = pathname.match(/^\/w\/([^/]+)\/?$/);
  if (worldMatch) {
    const slug = decodeURIComponent(worldMatch[1]!);
    try {
      const row = (await db
        .select({
          name: worlds.name,
          description: worlds.description,
        })
        .from(worlds)
        .where(and(
          eq(worlds.slug, slug),
          ne(worlds.visibility, "private"),
        ))
        .limit(1))[0];
      if (row) {
        const desc = (row.description ? stripToText(row.description) : "")
          || `${row.name} is a roleplay world on ${siteName}. Lore, places, and characters in one wiki.`;
        return {
          title: `${row.name} - Roleplay World · ${siteName}`,
          description: desc,
          keywords: `${row.name}, roleplay world, worldbuilding, lore, ${defaultKeywords}`,
          canonicalUrl: `${origin}/w/${encodeURIComponent(slug)}`,
        };
      }
    } catch { /* fall through */ }
    return {
      title: `${siteName} - ${tagline}`,
      description: siteDescription,
      keywords: defaultKeywords,
      canonicalUrl: `${origin}/`,
    };
  }

  // ---- Forum: /f/:slug (and topic permalinks /f/:slug/t/:topicId) ----
  // A shared forum link is a core "host your own" surface, so it earns its own
  // card. Only forums the OWNER opted into public browsing (plus the system
  // forum) produce route-specific meta; application/private forums fall through
  // so their name/tagline never leaks into a share preview. A topic permalink
  // canonicalizes to the parent forum (don't index every topic as a near-dup).
  const forumMatch = pathname.match(/^\/f\/([^/]+)(?:\/t\/[^/]+)?\/?$/);
  if (forumMatch) {
    const slug = decodeURIComponent(forumMatch[1]!);
    try {
      const row = (await db
        .select({
          name: forums.name,
          tagline: forums.tagline,
          descriptionHtml: forums.descriptionHtml,
          bannerImageUrl: forums.bannerImageUrl,
          logoUrl: forums.logoUrl,
          publicBrowsing: forums.publicBrowsing,
          isSystem: forums.isSystem,
        })
        .from(forums)
        .where(and(
          sql`lower(${forums.slug}) = lower(${slug})`,
          ne(forums.status, "archived"),
        ))
        .limit(1))[0];
      if (row && (row.publicBrowsing || row.isSystem)) {
        const desc = row.tagline?.trim()
          || (row.descriptionHtml ? stripToText(row.descriptionHtml) : "")
          || `${row.name} is a community forum on ${siteName}, with boards for play-by-post and discussion.`;
        return {
          title: `${row.name} - Forum · ${siteName}`,
          description: desc,
          keywords: `${row.name}, forum, play-by-post, community, ${defaultKeywords}`,
          canonicalUrl: `${origin}/f/${encodeURIComponent(slug.toLowerCase())}`,
          imageUrl: row.bannerImageUrl || row.logoUrl || null,
        };
      }
    } catch { /* fall through */ }
    return {
      title: `${siteName} - ${tagline}`,
      description: siteDescription,
      keywords: defaultKeywords,
      canonicalUrl: `${origin}/`,
    };
  }

  // ---- Community server: /s/:slug ----
  // The other flagship "host your own" surface. Only PUBLIC, non-archived,
  // non-moderated servers get a card; suspended/banned (unexpired) or unlisted/
  // invite-only servers fall through, mirroring the discover/rail hiding rules
  // so a moderated or private community's existence isn't leaked in a preview.
  const serverMatch = pathname.match(/^\/s\/([^/]+)\/?$/);
  if (serverMatch) {
    const slug = decodeURIComponent(serverMatch[1]!);
    try {
      const row = (await db
        .select({
          name: servers.name,
          tagline: servers.tagline,
          descriptionHtml: servers.descriptionHtml,
          bannerImageUrl: servers.bannerImageUrl,
          logoUrl: servers.logoUrl,
          visibility: servers.visibility,
          status: servers.status,
          moderationState: servers.moderationState,
          moderationUntil: servers.moderationUntil,
        })
        .from(servers)
        .where(sql`lower(${servers.slug}) = lower(${slug})`)
        .limit(1))[0];
      const moderated = !!row && (row.moderationState === "suspended"
        || (row.moderationState === "banned"
            && (!row.moderationUntil || +row.moderationUntil > Date.now())));
      if (row && row.visibility === "public" && row.status !== "archived" && !moderated) {
        const desc = row.tagline?.trim()
          || (row.descriptionHtml ? stripToText(row.descriptionHtml) : "")
          || `${row.name} is a roleplay community on ${siteName}, with its own chat rooms and forums.`;
        return {
          title: `${row.name} - Community · ${siteName}`,
          description: desc,
          keywords: `${row.name}, roleplay community, roleplay chat, ${defaultKeywords}`,
          canonicalUrl: `${origin}/s/${encodeURIComponent(slug.toLowerCase())}`,
          imageUrl: row.bannerImageUrl || row.logoUrl || null,
        };
      }
    } catch { /* fall through */ }
    return {
      title: `${siteName} - ${tagline}`,
      description: siteDescription,
      keywords: defaultKeywords,
      canonicalUrl: `${origin}/`,
    };
  }

  // ---- Homepage / anything else ----
  return {
    title: `${siteName} - ${tagline}`,
    description: siteDescription,
    keywords: defaultKeywords,
    canonicalUrl: `${origin}/`,
  };
}

/**
 * Themed 404 page rendered for unknown non-API GETs. Carries the same
 * stylesheet + favicon as the splash so it doesn't look like a stranded
 * server error page; offers a single link back to the chat.
 *
 * Note: this is a one-off HTML string rather than a React render, keeping
 * the 404 path simple (no SPA boot) matters for crawlers and for the
 * pathological case where the bundle itself fails to load.
 */
export async function render404Html(db: Db, origin: string, nonce?: string): Promise<string> {
  const s = await getSettings(db);
  const title = escapeHtmlAttr(s.siteName?.trim() || "The Spire");
  const home = escapeHtmlAttr(`${origin}/`);
  // Nonce attribute on the inline <style> below so the strict CSP
  // ships allow it. Empty string when no nonce was passed (e.g. unit
  // tests, dev-mode call paths), browsers ignore `nonce=""`, which
  // matches the pre-CSP behavior.
  const styleNonce = nonce ? ` nonce="${nonce}"` : "";
  // Inline minimal CSS so the page looks themed even if the main bundle is
  // stale or unreachable. Colors mirror the parchment default theme.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex" />
<link rel="icon" href="/favicon.ico" />
<link rel="canonical" href="${home}" />
<title>404, ${title}</title>
<style${styleNonce}>
  :root { color-scheme: light; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #f4efe2;
    color: #1a1a1a;
  }
  .card {
    max-width: 28rem;
    padding: 2.5rem 2rem;
    text-align: center;
    background: #fff8;
    border: 1px solid #a89572;
    border-radius: 6px;
    box-shadow: 0 20px 60px -15px rgba(0,0,0,0.25);
  }
  h1 { font-family: Georgia, Cambria, serif; font-size: 2rem; margin: 0 0 0.5rem; }
  p { margin: 0.5rem 0; color: #6b6256; }
  a {
    display: inline-block;
    margin-top: 1.25rem;
    padding: 0.5rem 1rem;
    border: 1px solid #a89572;
    border-radius: 4px;
    background: #e2d6b8;
    color: #1a1a1a;
    text-decoration: none;
  }
  a:hover { background: #d6c8a4; }
</style>
</head>
<body>
  <main class="card">
    <h1>Lost the path</h1>
    <p>That URL isn't part of ${title}. The chat lives at the entrance.</p>
    <a href="${home}">Back to ${title}</a>
  </main>
</body>
</html>
`;
}
