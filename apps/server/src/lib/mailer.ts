/**
 * Transactional email via Brevo's HTTP API.
 *
 * We POST to Brevo's REST endpoint rather than speaking SMTP: it rides
 * ordinary HTTPS (443), so it sidesteps the outbound-SMTP-port blocking
 * that cloud hosts (Fly included) apply, and it needs no extra dependency
 * (Node's global `fetch`). Sender identity, DKIM, and DMARC are handled by
 * the verified `thespire.games` domain configured in Brevo + DNS, so all
 * this module does is hand Brevo a recipient + body.
 *
 * Mirrors the push.ts posture: callers fire-and-forget (or await the
 * boolean), failures are logged not thrown, and when the API key is unset
 * the whole thing degrades to a no-op log so local dev and an
 * unconfigured prod can exercise email flows without credentials.
 *
 * Config (all via env / Fly secrets):
 *   BREVO_API_KEY   - required to actually send; unset = log-only no-op
 *   MAIL_FROM       - sender address (default noreply@thespire.games, the
 *                     verified Brevo sender)
 *   MAIL_FROM_NAME  - sender display name (default "The Spire Roleplay Chat")
 */

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const SEND_TIMEOUT_MS = 10_000;

const apiKey = process.env.BREVO_API_KEY ?? "";
const fromEmail = process.env.MAIL_FROM ?? "noreply@thespire.games";
const fromName = process.env.MAIL_FROM_NAME ?? "The Spire Roleplay Chat";

/** True once a Brevo API key is present, so callers can branch UX/messaging. */
export const mailerConfigured = apiKey.length > 0;

export interface SendEmailInput {
  /** Recipient email address. */
  to: string;
  /** Optional recipient display name. */
  toName?: string;
  subject: string;
  /** HTML body. */
  html: string;
  /** Plaintext fallback. Derived from `html` when omitted. */
  text?: string;
  /** Optional Reply-To (e.g. a real support inbox); defaults to the sender. */
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  /** True when skipped because no API key is configured (not a failure). */
  skipped?: boolean;
  error?: string;
}

/**
 * Send one transactional email. Never throws — returns a result the caller
 * can log or ignore. A non-`ok` result with `skipped: true` means the
 * mailer isn't configured (no key); any other non-`ok` is a real failure.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!mailerConfigured) {
    console.warn(
      `[mailer] BREVO_API_KEY unset — not sending. to=${input.to} subject=${JSON.stringify(input.subject)}`,
    );
    return { ok: false, skipped: true };
  }

  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: fromEmail, name: fromName },
        to: [{ email: input.to, ...(input.toName ? { name: input.toName } : {}) }],
        subject: input.subject,
        htmlContent: input.html,
        textContent: input.text ?? htmlToText(input.html),
        ...(input.replyTo ? { replyTo: { email: input.replyTo } } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[mailer] Brevo send failed ${res.status}: ${body.slice(0, 500)}`);
      return { ok: false, error: `brevo_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("[mailer] send threw", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Crude HTML→text fallback for the plaintext part when a caller only
 * provides HTML. Strips tags and collapses whitespace; good enough for the
 * short transactional bodies we send (a real text part should be passed in
 * for anything elaborate).
 */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
