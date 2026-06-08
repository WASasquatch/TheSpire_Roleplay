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

export function ensureInjectedStyle(id: string, css: string): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(id)) return;
  const el = document.createElement("style");
  el.id = id;
  // Empty string in dev (no meta tag / no CSP); browsers ignore nonce="" so
  // this is harmless there and required in prod.
  if (CSP_NONCE) el.setAttribute("nonce", CSP_NONCE);
  el.textContent = css;
  document.head.appendChild(el);
}
