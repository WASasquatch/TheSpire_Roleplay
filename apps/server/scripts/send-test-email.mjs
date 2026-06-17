// Standalone deliverability check for the Brevo email pipeline.
//
// Sends one test email so you can confirm the API key + verified domain
// (DKIM/DMARC) all line up BEFORE wiring email into app flows. Self-
// contained (no app imports, no tsx) so it runs anywhere the key is set.
//
// Usage:
//   BREVO_API_KEY=xkeysib-... node scripts/send-test-email.mjs you@example.com
// or, against the live machine:
//   fly ssh console -C "node scripts/send-test-email.mjs you@example.com"
//   (BREVO_API_KEY is already in the machine's secrets)
import "dotenv/config";

const to = process.argv[2];
if (!to) {
  console.error("usage: node scripts/send-test-email.mjs <recipient@example.com>");
  process.exit(1);
}

const apiKey = process.env.BREVO_API_KEY ?? "";
if (!apiKey) {
  console.error("BREVO_API_KEY is not set in the environment.");
  process.exit(1);
}

const fromEmail = process.env.MAIL_FROM ?? "noreply@thespire.games";
const fromName = process.env.MAIL_FROM_NAME ?? "The Spire Roleplay Chat";

const res = await fetch("https://api.brevo.com/v3/smtp/email", {
  method: "POST",
  headers: {
    "api-key": apiKey,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify({
    sender: { email: fromEmail, name: fromName },
    to: [{ email: to }],
    subject: "The Spire — email pipeline test",
    htmlContent:
      "<p>This is a test from The Spire's email pipeline.</p>" +
      "<p>If you're reading this in your inbox (not spam), Brevo, the API key, and your DNS (DKIM/DMARC) are all working.</p>",
    textContent:
      "This is a test from The Spire's email pipeline.\n\n" +
      "If you're reading this in your inbox (not spam), Brevo, the API key, and your DNS (DKIM/DMARC) are all working.",
  }),
});

if (!res.ok) {
  const body = await res.text().catch(() => "");
  console.error(`FAILED ${res.status}: ${body}`);
  process.exit(1);
}
const json = await res.json().catch(() => ({}));
console.log(`OK — Brevo accepted the message (messageId: ${json.messageId ?? "?"}). Check ${to} (and its spam folder).`);
