/**
 * Concrete transactional email bodies, built on the branded layout +
 * Brevo mailer. Each returns the mailer's send result so callers can log.
 *
 * Recipient language (i18n plan Phase 3): every template takes the
 * recipient's locale — the saved `users.locale` when the account is known,
 * else the request's Accept-Language pick — and renders subject/heading/
 * body/CTA through the `email` catalog namespace. `null` renders English,
 * byte-identical to the former inline literals.
 */
import { escapeHtml as esc } from "@thekeep/shared";
import { getSettings } from "../settings.js";
import { sendEmail, type SendEmailResult } from "../lib/mailer.js";
import type { Db } from "../db/index.js";
import { tFor } from "../i18n.js";
import { publicBaseUrl, renderBrandedEmail } from "./layout.js";
// `esc` escapes only `& < >` (text-node context) — the shared
// `escapeHtml` default, byte-identical to the former inline copy.
// Interpolated names/siteName are esc'd BEFORE they enter t() (the server
// i18n instance interpolates with escapeValue:false), so the rendered
// HTML stays exactly what the old template literals produced.

export async function sendPasswordResetEmail(
  db: Db,
  to: string,
  username: string,
  rawToken: string,
  /** Recipient language (raw `users.locale` / Accept-Language pick; null = en). */
  locale: string | null,
): Promise<SendEmailResult> {
  const settings = await getSettings(db);
  const url = `${publicBaseUrl(settings)}/reset-password?token=${encodeURIComponent(rawToken)}`;
  const html = renderBrandedEmail(settings, {
    heading: tFor(locale, "email:passwordReset.heading"),
    bodyHtml:
      `<p style="margin:0 0 12px;">${tFor(locale, "email:passwordReset.greeting", { username: esc(username) })}</p>` +
      `<p style="margin:0;">${tFor(locale, "email:passwordReset.body", { siteName: esc(settings.siteName) })}</p>`,
    cta: { label: tFor(locale, "email:passwordReset.cta"), url },
    footnote: tFor(locale, "email:passwordReset.footnote"),
  });
  return sendEmail({
    to,
    toName: username,
    subject: tFor(locale, "email:passwordReset.subject", { siteName: settings.siteName }),
    html,
  });
}

export async function sendVerificationEmail(
  db: Db,
  to: string,
  username: string,
  rawToken: string,
  /** Recipient language (raw `users.locale` / Accept-Language pick; null = en). */
  locale: string | null,
): Promise<SendEmailResult> {
  const settings = await getSettings(db);
  const url = `${publicBaseUrl(settings)}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const html = renderBrandedEmail(settings, {
    heading: tFor(locale, "email:verify.heading"),
    bodyHtml:
      `<p style="margin:0 0 12px;">${tFor(locale, "email:verify.greeting", { username: esc(username) })}</p>` +
      `<p style="margin:0;">${tFor(locale, "email:verify.body", { siteName: esc(settings.siteName) })}</p>`,
    cta: { label: tFor(locale, "email:verify.cta"), url },
    footnote: tFor(locale, "email:verify.footnote"),
  });
  return sendEmail({
    to,
    toName: username,
    subject: tFor(locale, "email:verify.subject", { siteName: settings.siteName }),
    html,
  });
}
