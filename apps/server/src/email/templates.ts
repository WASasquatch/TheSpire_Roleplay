/**
 * Concrete transactional email bodies, built on the branded layout +
 * Brevo mailer. Each returns the mailer's send result so callers can log.
 */
import { getSettings } from "../settings.js";
import { sendEmail, type SendEmailResult } from "../lib/mailer.js";
import { publicBaseUrl, renderBrandedEmail } from "./layout.js";
import type { Db } from "../db/index.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendPasswordResetEmail(
  db: Db,
  to: string,
  username: string,
  rawToken: string,
): Promise<SendEmailResult> {
  const settings = await getSettings(db);
  const url = `${publicBaseUrl(settings)}/reset-password?token=${encodeURIComponent(rawToken)}`;
  const html = renderBrandedEmail(settings, {
    heading: "Reset your password",
    bodyHtml:
      `<p style="margin:0 0 12px;">Hi ${esc(username)},</p>` +
      `<p style="margin:0;">We got a request to reset the password on your ${esc(settings.siteName)} account. Choose a new one with the button below.</p>`,
    cta: { label: "Reset password", url },
    footnote: "This link expires in 1 hour. If you didn't ask for this, you can ignore this email — your password won't change.",
  });
  return sendEmail({ to, toName: username, subject: `Reset your ${settings.siteName} password`, html });
}

export async function sendVerificationEmail(
  db: Db,
  to: string,
  username: string,
  rawToken: string,
): Promise<SendEmailResult> {
  const settings = await getSettings(db);
  const url = `${publicBaseUrl(settings)}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const html = renderBrandedEmail(settings, {
    heading: "Confirm your email",
    bodyHtml:
      `<p style="margin:0 0 12px;">Welcome, ${esc(username)}!</p>` +
      `<p style="margin:0;">Confirm this email address to finish setting up your ${esc(settings.siteName)} account.</p>`,
    cta: { label: "Confirm email", url },
    footnote: "This link expires in 24 hours.",
  });
  return sendEmail({ to, toName: username, subject: `Confirm your email for ${settings.siteName}`, html });
}
