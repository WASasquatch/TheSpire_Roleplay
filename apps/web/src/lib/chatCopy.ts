/**
 * Copy-handler that flattens any chat-shaped selection (chat feed,
 * DM thread, forum posts) to plain text on the clipboard.
 *
 * Without this, the browser writes BOTH `text/plain` AND `text/html`
 * to the clipboard. Pasting into a rich-text target (Word, Discord,
 * an HTML email composer) then drags along every span class, inline
 * style, name-style CSS, link decoration, color, etc. — so a
 * pasted line looks like the chat's render rather than the prose
 * the user actually meant to quote. Writing ONLY `text/plain`
 * forces every rich-text paste surface to fall back to the bare
 * text representation.
 *
 * Two pieces of metadata drive the walk:
 *
 *   - `data-display-name="…"` on an element marks it as a user-name
 *     tag. Its entire subtree is REPLACED with the attribute value
 *     in the copied text. This is what makes name-style templates
 *     copy correctly: some templates render the visible name via
 *     CSS `content` or via `dangerouslySetInnerHTML` with no real
 *     text node, so `selection.toString()` saw empty content and
 *     pasted `[] body` instead of `[Username] body`. Reading the
 *     raw display name from the attribute is independent of however
 *     the visual was painted.
 *
 *   - `data-copy-skip` on an element drops its entire subtree from
 *     the copied text. Used to strip timestamps, inline avatars,
 *     hover-revealed control buttons, and the audit / admin badges
 *     that would otherwise leak into the paste. Live `select-none`
 *     CSS still drives the browser's visible selection highlight
 *     (a parallel UX cue) but the actual clipboard text comes from
 *     this attribute, not from CSS — `textContent` doesn't honor
 *     `user-select: none`, so we can't rely on that path alone.
 *
 * Selection block-level structure (newlines between messages,
 * intra-line spacing inside a message) is preserved because we lean
 * on `textContent` which serializes block elements with their natural
 * boundaries — the same shape `selection.toString()` already
 * produced for the surrounding scaffolding.
 */

/** Build the plain-text representation of a cloned selection
 *  fragment per the rules in the file comment above. Exported so
 *  the chat / DM / forum onCopy handlers all share one
 *  implementation. */
function fragmentToPlainText(fragment: DocumentFragment | Element): string {
  // Walk the fragment in document order. For every element we
  // either: (a) skip the whole subtree, (b) emit the displayName
  // override, or (c) recurse into its children. Text nodes append
  // their `nodeValue` verbatim. Block-level elements emit a leading
  // newline so messages don't run together when the selection spans
  // multiple `<div>` chat lines.
  //
  // `Range.cloneContents()` produces a DocumentFragment whose
  // descendants are detached from the live DOM, so live computed
  // styles aren't available — we drive every decision off attribute
  // checks set at render time instead. Inputs with CSS `user-select:
  // none` are not implicitly skipped here; the renderer also tags
  // them with `data-copy-skip` so the walker drops them.
  const out: string[] = [];
  const blockTags = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV",
    "DL", "DT", "DD", "FIELDSET", "FIGCAPTION", "FIGURE",
    "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
    "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P",
    "PRE", "SECTION", "TABLE", "TR", "UL",
  ]);
  function walk(node: Node, isFirst: boolean): void {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push((node as Text).nodeValue ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.hasAttribute("data-copy-skip")) return;
    // displayName override: emit the attribute value in place of
    // whatever the subtree would produce. Skips the whole subtree
    // so a styled name-template with decorative pseudo-content
    // doesn't accidentally append extra characters after the name.
    const dn = el.getAttribute("data-display-name");
    if (dn !== null) {
      out.push(dn);
      return;
    }
    // Insert a newline before a block-level element so chat lines /
    // DM bubbles / forum posts paste as separate lines. Skipped on
    // the first node so we don't lead with a blank line.
    if (!isFirst && blockTags.has(el.tagName)) {
      // Only emit a newline if the previous chunk didn't already
      // end with one (e.g. a nested <p> right after another).
      const last = out.length > 0 ? out[out.length - 1]! : "";
      if (!last.endsWith("\n")) out.push("\n");
    }
    let first = true;
    for (let i = 0; i < el.childNodes.length; i++) {
      walk(el.childNodes[i]!, first && isFirst);
      first = false;
    }
  }
  let first = true;
  for (let i = 0; i < fragment.childNodes.length; i++) {
    walk(fragment.childNodes[i]!, first);
    first = false;
  }
  return out.join("");
}

export function handlePlainTextCopy(e: React.ClipboardEvent<HTMLElement>): void {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const fragment = range.cloneContents();
  const text = fragmentToPlainText(fragment).trim();
  if (!text) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", text);
}
