/**
 * Branded HTML wrapper for outgoing email.
 *
 * Transactional and broadcast mail both render through `renderBrandedEmail`
 * so every message shares one consistent, deliverability-safe shell:
 * table-based layout, inline styles, a light background (avoids dark-mode
 * inversion surprises across clients), the site name/logo as the header,
 * and an optional accent CTA button. The caller supplies already-safe
 * inner HTML (transactional bodies are built from our own strings; the
 * admin emailer sanitizes tiptap output before it reaches here).
 */
import type { SiteSettings } from "../settings.js";
import { escapeHtml } from "@thekeep/shared";

const ACCENT = "#7c5cff"; // Spire accent for buttons/links in email
const DEFAULT_BASE_URL = "https://thespire.games";

/**
 * Absolute base URL for links in email. Prefers an explicit
 * PUBLIC_BASE_URL env (a Fly secret if the site URL ever differs from the
 * branding link), then the admin-set `siteUrl`, then the known domain.
 * Always returned without a trailing slash.
 */
export function publicBaseUrl(settings: SiteSettings): string {
  const raw = (process.env.PUBLIC_BASE_URL || settings.siteUrl || DEFAULT_BASE_URL).trim();
  return raw.replace(/\/+$/, "");
}

/** Resolve a possibly-relative asset path (e.g. "/logo.png") to absolute. */
function absoluteUrl(base: string, maybeRelative: string): string {
  if (!maybeRelative) return "";
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  return `${base}/${maybeRelative.replace(/^\/+/, "")}`;
}

export interface BrandedEmailOpts {
  /** Heading shown at the top of the message body. */
  heading: string;
  /** Main content HTML (already safe/sanitized). */
  bodyHtml: string;
  /** Optional accent call-to-action button. */
  cta?: { label: string; url: string };
  /** Small print under the CTA (e.g. "This link expires in 1 hour."). */
  footnote?: string;
  /** Bulk only: appends a one-click unsubscribe line in the footer. */
  unsubscribeUrl?: string;
  /** Category label for the unsubscribe line (e.g. "Newsletter"). */
  unsubscribeLabel?: string;
}

export function renderBrandedEmail(settings: SiteSettings, opts: BrandedEmailOpts): string {
  const base = publicBaseUrl(settings);
  const siteName = settings.siteName || "The Spire";
  const logo = absoluteUrl(base, settings.logoUrl || "");
  const header = logo
    ? `<img src="${esc(logo)}" alt="${esc(siteName)}" height="44" style="height:44px;max-height:44px;border:0;display:inline-block;" />`
    : `<span style="font-size:22px;font-weight:700;color:#1a1726;letter-spacing:0.5px;">${esc(siteName)}</span>`;

  const ctaBlock = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
         <tr><td style="border-radius:8px;background:${ACCENT};">
           <a href="${esc(opts.cta.url)}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${esc(opts.cta.label)}</a>
         </td></tr>
       </table>`
    : "";

  const footnoteBlock = opts.footnote
    ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#6b6678;">${esc(opts.footnote)}</p>`
    : "";

  const unsubBlock = opts.unsubscribeUrl
    ? `<p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#9a96a6;">
         Don't want ${opts.unsubscribeLabel ? esc(opts.unsubscribeLabel) + " emails" : "these emails"}? <a href="${esc(opts.unsubscribeUrl)}" style="color:#9a96a6;">Unsubscribe</a>. This won't affect your other emails.
       </p>`
    : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light only" />
<title>${esc(opts.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f1f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1f7;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e3ee;">
      <tr><td style="padding:24px 32px;border-bottom:1px solid #efedf4;text-align:center;">${header}</td></tr>
      <tr><td style="padding:32px;">
        <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#1a1726;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">${esc(opts.heading)}</h1>
        <div style="font-size:15px;line-height:1.6;color:#2c2838;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">${opts.bodyHtml}</div>
        ${ctaBlock}
        ${footnoteBlock}
      </td></tr>
      <tr><td style="padding:20px 32px;border-top:1px solid #efedf4;text-align:center;">
        <p style="margin:0;font-size:12px;line-height:1.5;color:#9a96a6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
          ${esc(siteName)} &middot; <a href="${esc(base)}" style="color:#9a96a6;">${esc(base.replace(/^https?:\/\//, ""))}</a>
        </p>
        ${unsubBlock}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Minimal HTML-escape for interpolated text (not for the trusted bodyHtml).
 *  Escapes `& < > "` (text + double-quoted attribute context) — the shared
 *  `escapeHtml` with `doubleQuote`, byte-identical to the former inline copy. */
function esc(s: string): string {
  return escapeHtml(s, { doubleQuote: true });
}
