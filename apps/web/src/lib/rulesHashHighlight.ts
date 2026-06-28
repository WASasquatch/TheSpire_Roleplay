import { useEffect, type RefObject } from "react";

/**
 * Deep-link highlight for admin-authored Rules HTML.
 *
 * The rules render via `dangerouslySetInnerHTML` AFTER the page mounts and the
 * `/api/rules` fetch resolves. So when someone opens a deep link like
 * `/rules#3.6` the browser has already done its (empty) `:target` resolution
 * before the matching element exists — the native `:target` highlight + scroll
 * never fire on initial load (they only fire on a navigation that happens once
 * the element is present, which is why manually clicking a rule link works but
 * deep links don't).
 *
 * Admin rules CSS is written with a `.is-targeted` fallback class for exactly
 * this case. This hook applies it (and scrolls) once the content is in the DOM
 * and on every later `hashchange`, mirroring the convention the rules markup
 * uses: a hash pointing at a `.rule-anchor` highlights its closest
 * `.rule-item` / `.rule-heading`; a `.rule-item` or `<section>` highlights
 * itself / its heading.
 *
 * This replaces the inline `<script>` admins used to embed — which the
 * sanitizer strips on save and the browser wouldn't execute from innerHTML
 * anyway — with no script execution and no CSP change. `ready` should flip true
 * once the rules HTML has been injected so the effect re-runs with the content
 * present; `ref` wraps the rules container so id lookups + the `.is-targeted`
 * sweep are scoped to the rules (never other page ids).
 */
export function useRulesHashHighlight(ref: RefObject<HTMLElement | null>, ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const root = ref.current;
    if (!root) return;

    function apply() {
      // Clear any previous mark within the rules only.
      root!.querySelectorAll(".is-targeted").forEach((el) => el.classList.remove("is-targeted"));
      const raw = window.location.hash.slice(1);
      if (!raw) return;
      let id = raw;
      try { id = decodeURIComponent(raw); } catch { /* keep raw */ }

      let target: Element | null = null;
      try { target = root!.querySelector(`[id="${CSS.escape(id)}"]`); } catch { target = null; }
      if (!target) return;

      // Which element wears the highlight (the anchor's container, or itself).
      let highlight: Element | null = null;
      if (target.classList.contains("rule-anchor")) highlight = target.closest(".rule-item, .rule-heading");
      else if (target.classList.contains("rule-item")) highlight = target;
      else if (target.tagName.toLowerCase() === "section") highlight = target.querySelector(":scope > .rule-heading");
      if (highlight) highlight.classList.add("is-targeted");

      // Scroll the actual target (it carries the scroll-margin-top offset).
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // Defer one frame so the just-injected HTML is laid out before we scroll.
    const raf = requestAnimationFrame(apply);
    window.addEventListener("hashchange", apply);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("hashchange", apply); };
  }, [ref, ready]);
}
