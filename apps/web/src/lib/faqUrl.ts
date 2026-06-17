/**
 * URL shape helpers for the public FAQ pages.
 *
 *   /faqs          , the index of all FAQ entries.
 *   /faq/<slug>    , a single entry, the shareable direct link.
 *
 * Both mount BEFORE auth (like /rules) so a mod can hand the link to someone
 * who isn't signed in. The server serves the SPA shell on these paths; the
 * JSON content lives under `/api/faqs*` so the two don't shadow each other.
 *
 * Mirrors the parse/sync pattern of rulesUrl.ts.
 */

const FAQ_INDEX_RX = /^\/faqs\/?$/i;
const FAQ_ENTRY_RX = /^\/faq\/([a-z0-9_]{3,40})\/?$/i;

export type FaqRoute = { kind: "index" } | { kind: "entry"; slug: string };

/** Classify the current URL as a FAQ page, or null if it isn't one. */
export function faqRoute(): FaqRoute | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname;
  if (FAQ_INDEX_RX.test(path)) return { kind: "index" };
  const m = FAQ_ENTRY_RX.exec(path);
  if (m) return { kind: "entry", slug: m[1]!.toLowerCase() };
  return null;
}

/** Push `/faqs` (the index) without a full reload. */
export function navigateToFaqIndex(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname.toLowerCase() === "/faqs") return;
  window.history.pushState({}, "", "/faqs");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Pop a FAQ page back to the splash / chat shell. */
export function navigateAwayFromFaq(): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}
