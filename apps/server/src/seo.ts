import { resolve } from "node:path";
import type { FastifyRequest } from "fastify";
import type { Db } from "./db/index.js";
import { getSettings } from "./settings.js";

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
): Promise<string> {
  let html = sourceHtml;

  const s = await getSettings(db);

  // Title falls back to "The Spire" if siteName was cleared. metaDescription
  // falls back to a stripped welcomeHtml summary if admin hasn't written
  // one - either is better than an empty description.
  const title = s.siteName?.trim() || "The Spire";
  const description =
    s.metaDescription?.trim() ||
    (s.welcomeHtml ? stripToText(s.welcomeHtml) : "") ||
    "A roleplay-focused chat sanctuary.";
  const canonicalUrl = `${origin}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;

  const titleAttr = escapeHtmlAttr(title);
  const descAttr = escapeHtmlAttr(description);
  const urlAttr = escapeHtmlAttr(canonicalUrl);

  // Replace tags by exact-attribute match. Each replace is targeted to a
  // specific tag name + attribute so they don't trip over each other.
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${titleAttr}</title>`)
    .replace(
      /<meta name="description" content="[^"]*"\s*\/?>/,
      `<meta name="description" content="${descAttr}" />`,
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

/** Minimal sitemap.xml. Only the splash URL is exposed - everything past
 *  login is auth-walled and shouldn't be indexed. */
export function renderSitemapXml(origin: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    `  <url>`,
    `    <loc>${origin}/</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>weekly</changefreq>`,
    `    <priority>1.0</priority>`,
    `  </url>`,
    `</urlset>`,
    "",
  ].join("\n");
}

/** Resolve the path to the built web bundle's index.html. Mirrors the
 *  path math fastify-static uses elsewhere in index.ts. */
export function resolveIndexHtmlPath(serverDir: string): string {
  return resolve(serverDir, "..", "..", "web", "dist", "index.html");
}
