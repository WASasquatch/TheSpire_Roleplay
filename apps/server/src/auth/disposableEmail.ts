/**
 * Disposable / temporary email blocking (registration guard).
 *
 * Throwaway inboxes (temp-mail, 10minutemail, mailinator, guerrillamail, …)
 * let a banned or abusive person spin up endless burner accounts, and they
 * never see a verification or password-reset mail, so they're pure liability
 * at signup. This module holds a curated set of well-known providers and the
 * matcher the register route uses; an admin can extend it at runtime via the
 * `blockedEmailDomains` site setting (merged in by the caller).
 *
 * Matching is by registrable domain AND every parent up to (but not including)
 * the bare TLD, so a subdomain address like `x@inbox.mailinator.com` is caught
 * by the `mailinator.com` entry. It is a suffix list, not a regex, so a real
 * provider whose name merely CONTAINS a blocked word (e.g. a company called
 * "tempo-mail-marketing.com") is unaffected.
 *
 * This is necessarily incomplete — the big providers rotate through hundreds of
 * throwaway domains — so it's a strong first line, not a guarantee; the admin
 * list is the escape hatch for new ones as they surface.
 */

/**
 * Well-known disposable / temporary email domains, lowercased. Grouped by
 * provider family for maintenance. Add new ones here (permanent) or via the
 * admin `blockedEmailDomains` setting (no deploy).
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // temp-mail.org family
  "temp-mail.org", "temp-mail.io", "temp-mail.ru", "tempmail.com", "tempmail.net",
  "tempmailo.com", "tempmail.plus", "tempmail.dev", "tempmailer.com", "tempmailer.de",
  "tmpmail.org", "tmpmail.net", "tmpeml.com", "tempr.email", "tempmail.email",
  "temp-mails.com", "tempmailbox.com", "tmail.com", "tmails.net",
  // 10minutemail family
  "10minutemail.com", "10minutemail.net", "10minutemail.org", "10minutemail.co.uk",
  "10minutemail.de", "10minutemail.info", "10minmail.com", "10minmail.de",
  "10minutemailbox.com", "10minutesmail.com", "10minutesmail.net", "tenminutemail.com",
  "tempemail.co", "temp-mail.com",
  // Guerrilla Mail family
  "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz",
  "guerrillamail.de", "guerrillamail.info", "guerrillamailblock.com", "grr.la",
  "sharklasers.com", "pokemail.net", "spam4.me",
  // Mailinator family
  "mailinator.com", "mailinator.net", "mailinator.org", "mailinator2.com",
  "mailinator.gq", "reallymymail.com", "notmailinator.com", "sendspamhere.com",
  "suremail.info", "mailinater.com", "binkmail.com", "bobmail.info", "chammy.info",
  // YOPmail family
  "yopmail.com", "yopmail.net", "yopmail.fr", "cool.fr.nf", "jetable.fr.nf",
  "courriel.fr.nf", "moncourrier.fr.nf", "monemail.fr.nf", "monmail.fr.nf",
  // throwaway family
  "throwawaymail.com", "throwaway.email", "throwam.com", "throwmail.com",
  // trashmail family
  "trashmail.com", "trashmail.net", "trashmail.org", "trashmail.de", "trashmail.io",
  "trash-mail.com", "trash-mail.de", "trash-mail.at", "trbvm.com", "kurzepost.de",
  "objectmail.com", "proxymail.eu", "rcpt.at", "wegwerfmail.de", "wegwerfmail.net",
  "wegwerfmail.org", "trashymail.com", "mytrashmail.com",
  // fake mail generator family
  "fakemail.net", "fakemailgenerator.com", "fakeinbox.com", "fakemailbox.com",
  "fake-mail.ml", "fake-box.com", "fakermail.com",
  // burner / discard / one-off
  "burnermail.io", "discard.email", "discardmail.com", "discardmail.de",
  "getairmail.com", "getnada.com", "nada.email", "maildrop.cc", "mailnesia.com",
  "mailcatch.com", "mohmal.com", "mohmal.im", "mohmal.tech", "dispostable.com",
  "emailondeck.com", "emailtemporanea.com", "emailtemporanea.net", "email-temp.com",
  "mintemail.com", "spambog.com", "spambog.ru", "spambog.de",
  "moakt.com", "moakt.cc", "moakt.ws", "tempinbox.com", "tempsky.com",
  "tmailor.com", "luxusmail.org", "byom.de", "instantemailaddress.com",
  "spam.la",
  "dropmail.me", "10mail.org", "harakirimail.com", "mail-temp.com", "temporary-mail.net",
  "tempmailaddress.com", "mailpoof.com", "inboxkitten.com", "1secmail.com",
  "1secmail.net", "1secmail.org", "emltmp.com", "vjuum.com", "laafd.com",
  "txcct.com", "esiix.com", "wwjmp.com", "yoggm.com", "cazlfansi.info",
  "minuteinbox.com", "linshiyou.com", "tempemails.net", "tempemailco.com",
  "emailfake.com", "emailfake.net", "generator.email", "clipmail.eu",
  "guerillamail.com", "guerillamail.net", "spambox.us", "mailtemporaire.fr",
  "yepmail.net", "vomoto.com", "mailboxy.fun", "tafmail.com", "gettempmail.com",
]);

/** Extract the lowercased domain from an email address, or null if malformed. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, "");
  return domain || null;
}

/**
 * Parse an admin-entered domain list (newline / comma / semicolon / space
 * separated) into a normalized Set. Tolerates a leading `@`, a trailing dot, a
 * pasted full email, or a URL-ish token; keeps only things that look like a
 * domain (contain a dot).
 */
export function parseBlockedEmailDomains(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const raw of text.split(/[\s,;]+/)) {
    let d = raw.trim().toLowerCase();
    if (!d) continue;
    // Reduce a pasted URL or full email to its bare host: drop a scheme
    // (https://), then any userinfo before an '@', then any path/query/frag,
    // then a trailing dot.
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    const at = d.lastIndexOf("@");
    if (at >= 0) d = d.slice(at + 1);
    d = d.replace(/^@+/, "").replace(/[/?#].*$/, "").replace(/\.+$/, "");
    if (d.includes(".")) out.add(d);
  }
  return out;
}

/**
 * True when `email`'s domain (or any parent domain down to the 2-label suffix)
 * is in the vendored list or the caller-supplied `extra` set. `extra` is the
 * admin's `blockedEmailDomains`, already parsed via {@link parseBlockedEmailDomains}.
 */
export function isBlockedEmailDomain(email: string, extra?: ReadonlySet<string>): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  const labels = domain.split(".");
  // Check the full domain and each parent suffix, stopping before the bare TLD
  // (i + 1 < length ⇒ shortest suffix has 2 labels, e.g. "mailinator.com").
  for (let i = 0; i + 1 < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    if (DISPOSABLE_EMAIL_DOMAINS.has(suffix)) return true;
    if (extra && extra.has(suffix)) return true;
  }
  return false;
}
