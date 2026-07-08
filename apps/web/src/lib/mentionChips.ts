/**
 * Shared `@kind:slug` prose chip decorator.
 *
 * Backs BOTH prose-decoration pipelines, which render byte-identical
 * `.story-chip` anchors and differ only in three axes:
 *   - the match pattern (which kinds/slugs qualify),
 *   - the kind-validity predicate (chip vs literal text), and
 *   - the `href` scheme.
 *
 * Callers:
 *   - Scriptorium `storyMentions.ts` — `@world:` / `@char:` chips.
 *   - World knowledge-base `worldMentions.ts` — `@<any-kind>:` chips.
 *
 * The DOM tree walker, document-fragment builder, `story-chip` class +
 * `data-chip-kind`/`data-chip-slug` attributes, `@kind:slug` text
 * content, unknown-kind literal fallback, `lastIndex` advance, and the
 * 1400ms flash are all shared here so the two pipelines can never drift.
 *
 * Each caller keeps its OWN module-level singleton `RegExp` (global
 * flag, stateful `.lastIndex`) and passes it in — the walker resets
 * `.lastIndex` before use, matching the prior per-file behavior.
 */

export interface MentionChipOptions {
  /** Module-level singleton `RegExp` (global flag). Capture groups are
   *  `(lead, kind, slug)`; `.lastIndex` is reset by the walker. */
  pattern: RegExp;
  /** True → render a chip for this kind; false → keep as literal text. */
  isValidKind: (kind: string) => boolean;
  /** `href` attribute for the chip anchor. */
  hrefFor: (kind: string, slug: string) => string;
}

/** Tags we never descend into. Their text contents are off-limits. The
 *  decorated `<a class="story-chip">` is an "A", so re-running is a no-op. */
const SKIP_TAG_NAMES = new Set([
  "A", "CODE", "PRE", "STYLE", "SCRIPT", "TEXTAREA", "BUTTON",
]);

/** Walk every text descendant of `root` and replace mention patterns
 *  with chip anchors, per `opts`. */
export function decorateMentionChipsIn(root: HTMLElement, opts: MentionChipOptions): void {
  // collectTextNodes first, then mutate; mutating during a tree walk
  // breaks the iterator on some browsers.
  const nodes: Text[] = [];
  collectTextNodes(root, nodes);
  for (const node of nodes) {
    decorateTextNode(node, opts);
  }
}

function collectTextNodes(el: Node, out: Text[]): void {
  for (let child = el.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(child as Text);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (SKIP_TAG_NAMES.has((child as Element).tagName)) continue;
      collectTextNodes(child, out);
    }
  }
}

function decorateTextNode(node: Text, opts: MentionChipOptions): void {
  const { pattern, isValidKind, hrefFor } = opts;
  const text = node.nodeValue ?? "";
  pattern.lastIndex = 0;
  if (!pattern.test(text)) return;
  pattern.lastIndex = 0;

  const parent = node.parentNode;
  if (!parent) return;
  const doc = node.ownerDocument ?? document;
  const frag = doc.createDocumentFragment();
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const [, lead, kindRaw, slug] = match;
    // `match.index` points at the leading boundary char (or 0 at start
    // of text). The mention itself begins at index + lead.length.
    const mentionStart = match.index + (lead ?? "").length;
    if (mentionStart > lastIndex) {
      frag.appendChild(doc.createTextNode(text.slice(lastIndex, mentionStart)));
    }
    const kind = kindRaw ?? "";
    const sl = slug ?? "";
    if (isValidKind(kind) && sl) {
      const chip = doc.createElement("a");
      chip.className = "story-chip";
      chip.setAttribute("href", hrefFor(kind, sl));
      chip.dataset.chipKind = kind;
      chip.dataset.chipSlug = sl;
      chip.textContent = `@${kind}:${sl}`;
      frag.appendChild(chip);
    } else {
      // Unknown kind, preserve as literal text.
      frag.appendChild(doc.createTextNode(`@${kind}:${sl}`));
    }
    lastIndex = mentionStart + 1 + kind.length + 1 + sl.length;
  }
  if (lastIndex < text.length) {
    frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
  }
  parent.replaceChild(frag, node);
}

/**
 * Click-handler factory for `.story-chip` anchors. Honors
 * cmd/ctrl/shift/middle-click (lets the natural `href` fallback run),
 * otherwise `preventDefault()`s and calls `onActivate(kind, slug)`.
 * Returns the handler so callers can `removeEventListener` on unmount.
 */
export function makeMentionChipClickHandler(
  onActivate: (kind: string, slug: string) => void,
): (e: MouseEvent) => void {
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const target = (e.target as Element | null)?.closest<HTMLAnchorElement>("a.story-chip");
    if (!target) return;
    const kind = target.dataset.chipKind;
    const slug = target.dataset.chipSlug;
    if (!kind || !slug) return;
    e.preventDefault();
    onActivate(kind, slug);
  };
}

/** Smooth-scroll an element into view and briefly flash it (1400ms). */
export function scrollToAndFlashChipTarget(el: Element): void {
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("story-chip-flash");
  window.setTimeout(() => el.classList.remove("story-chip-flash"), 1400);
}
