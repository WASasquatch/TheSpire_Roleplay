/**
 * Per-request CSP nonce, surfaced as a `<meta name="csp-nonce" content="...">`
 * tag by the SEO renderer at SSR time. Client code that dynamically
 * injects `<style>` / `<script>` elements (the name-style catalog
 * injector, user-bio CSS scoping pass, etc.) reads this and stamps
 * the value on the tag so the strict `style-src 'self' 'nonce-{N}'`
 * CSP doesn't reject the element.
 *
 * Captured once at module load — the nonce is stable for the life of
 * the page (it rotates per server response). Returns an empty string
 * in non-browser environments (tests, SSR-mounted compute) so callers
 * can fall through without conditional guards.
 */
export const CSP_NONCE: string = (() => {
  if (typeof document === "undefined") return "";
  const meta = document.head?.querySelector('meta[name="csp-nonce"]') as HTMLMetaElement | null;
  return meta?.content ?? "";
})();
