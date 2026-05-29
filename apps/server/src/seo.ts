import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Db } from "./db/index.js";
import { characters, stories, users, worlds } from "./db/schema.js";
import { getSettings } from "./settings.js";

/**
 * Site-wide keyword shelf shared across every public route. Lead with
 * the term the user-facing complaint identified: searches for
 * "The Spire Chat" should land here, not on RPG-sites unrelated to
 * the actual product. Order matters for some crawlers — most-specific
 * first, broader synonyms later.
 */
const DEFAULT_KEYWORDS =
  "roleplay chat, online roleplay, RP chat, writing community, " +
  "collaborative fiction, story writing, character roleplay, " +
  "forum roleplay, The Spire chat, The Spire RP";

/**
 * Homepage tagline appended after the admin-configured siteName. Keeps
 * the `<title>` keyword-rich without forcing admins to bake search
 * keywords into the brand name itself — the bare brand still gets to
 * own the `og:site_name` slot. Mirrors the static default in
 * `apps/web/index.html` so the rewritten and bare-GET copies of the
 * page tell the same story to indexers.
 */
const HOMEPAGE_TAGLINE = "Roleplay Chat & Collaborative Writing";

/**
 * Generate a fresh nonce for a single HTTP response. Base64 of 16 random
 * bytes — 128 bits is well above the CSP3 floor (the spec asks for ≥
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
 * The regex is intentionally simple — we only care about the tag-open
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
  return text
    .replace(/\s+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  const stripped = html
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
    "A roleplay-focused chat sanctuary.";

  // Per-route SEO. Every public bookmarkable page gets its own title,
  // description, canonical URL, and keyword shelf — otherwise crawlers
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
  const perRoute = await resolveRouteMeta(db, pathname, origin, siteName, siteDescription);
  ({ title, description, keywords, canonicalUrl } = perRoute);

  const titleAttr = escapeHtmlAttr(title);
  const descAttr = escapeHtmlAttr(description);
  const urlAttr = escapeHtmlAttr(canonicalUrl);
  const keywordsAttr = escapeHtmlAttr(keywords);

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
      // index it — and Discord / Slack card scrapers pass it through to
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
      `<meta property="og:site_name" content="${titleAttr}" />`,
    )
    .replace(
      /<meta name="twitter:title" content="[^"]*"\s*\/?>/,
      `<meta name="twitter:title" content="${titleAttr}" />`,
    )
    .replace(
      /<meta name="twitter:description" content="[^"]*"\s*\/?>/,
      `<meta name="twitter:description" content="${descAttr}" />`,
    );

  // JSON-LD: replace the whole script block. We rebuild it rather than
  // surgically edit fields because the Schema.org payload is short and
  // the alternative (multiple regex substitutions inside a JSON literal)
  // would be more fragile than a one-shot rewrite.
  const ldJson = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: title,
    description,
    applicationCategory: "SocialNetworkingApplication",
    operatingSystem: "Web",
    url: canonicalUrl,
  });
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

  // Surface the CSP nonce to runtime JS via a `<meta>` tag so client
  // code that dynamically creates `<style>` / `<script>` elements
  // (the name-style catalog injector + per-user CSS-var stamper)
  // can stamp the nonce on them — otherwise the strict
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
 *  points crawlers at our sitemap. */
export function renderRobotsTxt(origin: string): string {
  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
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
 *      person — we stick to master accounts here for cleaner crawl shape.
 *    - Worlds: any non-private world (public OR open).
 */
export async function renderSitemapXml(db: Db, origin: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
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
  ];

  // Public + SFW (G/PG/PG-13) published stories. The previous version
  // pointed at `/stories/@…` — those URLs 404 because the actual
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
  } catch { /* swallow — the sitemap still serves the entrance URLs */ }

  // Public, non-NSFW user profiles. Master accounts only (characters
  // share the same /p/:name space — adding them too would double-list
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
 * Title format: `{Specific thing} · {SiteName}` — pipe-delimited
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
): Promise<RouteMeta> {
  // ---- bookmarkable form pages ----
  if (pathname === "/login") {
    return {
      title: `Log in · ${siteName} - Roleplay Chat`,
      description: `Sign in to ${siteName} to continue your stories, manage characters, and rejoin your roleplay rooms.`,
      keywords: `${DEFAULT_KEYWORDS}, login, sign in`,
      canonicalUrl: `${origin}/login`,
    };
  }
  if (pathname === "/register") {
    return {
      title: `Create your character · ${siteName} - Roleplay Chat`,
      description: `Join ${siteName}. Build a character, step into the worlds, and find your roleplay circle. Free to sign up.`,
      keywords: `${DEFAULT_KEYWORDS}, sign up, create account, character creation`,
      canonicalUrl: `${origin}/register`,
    };
  }

  // ---- Scriptorium catalog ----
  if (pathname === "/scriptorium") {
    return {
      title: `Scriptorium - Collaborative Stories · ${siteName}`,
      description: `Read and write collaborative roleplay fiction on ${siteName}. The Scriptorium hosts open-invite stories, one-shots, and long-form serials from the community.`,
      keywords: `${DEFAULT_KEYWORDS}, scriptorium, collaborative stories, story catalog, fanfiction, serial fiction, one-shots`,
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
        const keywords = [tagKeywords, "story", "scriptorium", DEFAULT_KEYWORDS]
          .filter(Boolean)
          .join(", ");
        return {
          title: `${row.title} by @${row.authorUsername} · Scriptorium · ${siteName}`,
          description: desc,
          keywords,
          canonicalUrl: `${origin}/scriptorium/@${encodeURIComponent(row.authorUsername.toLowerCase())}/${encodeURIComponent(slug)}`,
        };
      }
    } catch { /* fall through */ }
    // Private / no match — generic Scriptorium meta, canonical at the catalog.
    return {
      title: `Scriptorium - Collaborative Stories · ${siteName}`,
      description: siteDescription,
      keywords: DEFAULT_KEYWORDS,
      canonicalUrl: `${origin}/scriptorium`,
    };
  }

  // ---- Profile: /p/:name or /u/:name ----
  // Try master account first; fall back to character lookup so
  // `/p/<characterName>` resolves too. Both gates require isPublic &&
  // !isNsfw before any name or bio escapes into OG.
  const profileMatch = pathname.match(/^\/(?:p|u)\/([^/]+)\/?$/);
  if (profileMatch) {
    const name = decodeURIComponent(profileMatch[1]!);
    try {
      const userRow = (await db
        .select({
          username: users.username,
          bioHtml: users.bioHtml,
        })
        .from(users)
        .where(and(
          sql`lower(${users.username}) = lower(${name})`,
          eq(users.isPublic, true),
          eq(users.isNsfw, false),
        ))
        .limit(1))[0];
      if (userRow) {
        const bio = stripToText(userRow.bioHtml);
        return {
          title: `${userRow.username} - Roleplay Profile · ${siteName}`,
          description: bio || `${userRow.username}'s roleplay profile on ${siteName}. Read their bio, browse characters, and start a scene.`,
          keywords: `${userRow.username}, roleplay profile, character, ${DEFAULT_KEYWORDS}`,
          canonicalUrl: `${origin}/p/${encodeURIComponent(userRow.username.toLowerCase())}`,
        };
      }
      const charRow = (await db
        .select({
          name: characters.name,
          bioHtml: characters.bioHtml,
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
        const bio = stripToText(charRow.bioHtml);
        return {
          title: `${charRow.name} - Roleplay Character · ${siteName}`,
          description: bio || `${charRow.name} is a roleplay character on ${siteName}. Read their bio and find them in chat.`,
          keywords: `${charRow.name}, roleplay character, ${DEFAULT_KEYWORDS}`,
          canonicalUrl: `${origin}/p/${encodeURIComponent(charRow.name.toLowerCase())}`,
        };
      }
    } catch { /* fall through */ }
    return {
      title: `${siteName} - ${HOMEPAGE_TAGLINE}`,
      description: siteDescription,
      keywords: DEFAULT_KEYWORDS,
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
          keywords: `${row.name}, roleplay world, worldbuilding, lore, ${DEFAULT_KEYWORDS}`,
          canonicalUrl: `${origin}/w/${encodeURIComponent(slug)}`,
        };
      }
    } catch { /* fall through */ }
    return {
      title: `${siteName} - ${HOMEPAGE_TAGLINE}`,
      description: siteDescription,
      keywords: DEFAULT_KEYWORDS,
      canonicalUrl: `${origin}/`,
    };
  }

  // ---- Homepage / anything else ----
  return {
    title: `${siteName} - ${HOMEPAGE_TAGLINE}`,
    description: siteDescription,
    keywords: DEFAULT_KEYWORDS,
    canonicalUrl: `${origin}/`,
  };
}

/**
 * Themed 404 page rendered for unknown non-API GETs. Carries the same
 * stylesheet + favicon as the splash so it doesn't look like a stranded
 * server error page; offers a single link back to the chat.
 *
 * Note: this is a one-off HTML string rather than a React render — keeping
 * the 404 path simple (no SPA boot) matters for crawlers and for the
 * pathological case where the bundle itself fails to load.
 */
export async function render404Html(db: Db, origin: string, nonce?: string): Promise<string> {
  const s = await getSettings(db);
  const title = escapeHtmlAttr(s.siteName?.trim() || "The Spire");
  const home = escapeHtmlAttr(`${origin}/`);
  // Nonce attribute on the inline <style> below so the strict CSP
  // ships allow it. Empty string when no nonce was passed (e.g. unit
  // tests, dev-mode call paths) — browsers ignore `nonce=""`, which
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
<title>404 — ${title}</title>
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
