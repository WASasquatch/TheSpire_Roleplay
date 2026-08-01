/**
 * Inject a static stylesheet into <head> exactly once, CSP-nonce stamped so
 * the strict production policy (`style-src 'self' 'nonce-…'`, see buildCsp in
 * apps/server/src/index.ts) accepts it.
 *
 * Why this exists: a plain React `<style>{css}</style>` renders an inline
 * <style> block with NO nonce. In dev there's no CSP so it works, but on the
 * Fly prod build the browser refuses to apply it and the surface renders
 * completely unstyled — which is how the Eidolon Tamer's window + device CSS
 * silently vanished in prod (positioning, sizing, backgrounds all gone) while
 * working locally. Mirrors the same nonce-stamping the name-style / freeform-
 * border injectors already do.
 *
 * Keyed by `id`: repeat calls (multiple instances, re-opens, re-renders) are
 * no-ops. The sheet is left in <head> for the life of the page since the CSS
 * is a static constant shared by every instance.
 */
import { CSP_NONCE } from "./cspNonce.js";

/**
 * Create a fresh `<style>` element, CSP-nonce stamped, and return it
 * UNATTACHED. The caller owns keying/attributes/textContent, where it
 * gets appended (document head, a shadow root, …), and any rewrite /
 * cleanup lifecycle.
 *
 * The nonce is required in prod: the strict `style-src 'self' 'nonce-…'`
 * policy drops any `<style>` that doesn't carry the request nonce. In dev
 * there's no meta tag / no CSP, so `CSP_NONCE` is `""` and browsers ignore
 * `nonce=""` — harmless there, required on remote. This is the single place
 * every dynamic-`<style>` injector shares that stamping.
 */
export function createNonceStyleTag(): HTMLStyleElement {
  const el = document.createElement("style");
  if (CSP_NONCE) el.setAttribute("nonce", CSP_NONCE);
  return el;
}

/**
 * Write the real nonce back onto a live `<style>`'s CONTENT attribute.
 *
 * Needed only when a stylesheet has to survive being moved into another
 * document, which today means html2canvas: it adopts the whole
 * `documentElement` into an iframe before reading computed styles.
 *
 * The trap is in the CSP spec. When a `<style nonce="X">` first becomes
 * browsing-context connected the browser moves X into an internal slot and
 * blanks the content attribute (nonce hiding, so injected script can't read
 * it back). `adoptNode` then re-connects the element in the iframe, which
 * re-runs that same step, and this time it reads the BLANK attribute and
 * clobbers the internal nonce to "". Under a strict `style-src 'self'
 * 'nonce-…'` the sheet is dropped, so the capture comes out with no styling
 * at all: correct in dev, where there is no CSP, and broken in production.
 *
 * Re-asserting the attribute is what makes the value present at adoption
 * time. It re-exposes the nonce in the DOM, which is what hiding exists to
 * prevent, but the value is already readable by any script on the page from
 * the `csp-nonce` meta tag, so nothing is given away.
 */
export function reassertStyleNonce(el: HTMLStyleElement): void {
  if (!CSP_NONCE) return;
  el.setAttribute("nonce", CSP_NONCE);
}

export function ensureInjectedStyle(id: string, css: string): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(id)) return;
  const el = createNonceStyleTag();
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}
