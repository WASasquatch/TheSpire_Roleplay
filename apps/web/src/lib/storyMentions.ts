/**
 * Scriptorium prose decorator. Walks rendered chapter HTML and turns
 * `@world:slug` and `@char:slug` text fragments into clickable chips
 * styled by `.story-chip` CSS.
 *
 * Two-step pipeline:
 *   1. `decorateMentionsIn(root)` mutates the DOM in place, replacing
 *      qualifying text nodes with anchor spans that carry the chip
 *      target as data attributes. Skips text inside existing anchors,
 *      <code> blocks, and <style>/<script> (paranoia, sanitizer
 *      should have dropped script already).
 *   2. The caller wires a click handler on the article element that
 *      reads `dataset.chipKind` + `dataset.chipSlug` and dispatches
 *      the appropriate action. For "world" chips we raise a DOM
 *      CustomEvent so App.tsx can open the viewer; for "char" chips
 *      we scroll to + flash the codex appendix entry with that slug.
 */

/** Supported chip kinds in prose. Mirrors the spec's @world: / @char: tokens. */
export type StoryChipKind = "world" | "char";

/**
 * Patterns we match in text nodes. Same shape as the existing chat
 * mention regex (kebab slugs, 1-60 chars). Leading boundary is either
 * start-of-text or a non-word char so we don't match "email@world:foo"
 * mid-word.
 */
const STORY_MENTION_RE = /(^|[^\w@])@(world|char):([a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)/g;

/** Tags we never descend into. Their text contents are off-limits. */
const SKIP_TAG_NAMES = new Set([
  "A", "CODE", "PRE", "STYLE", "SCRIPT", "TEXTAREA", "BUTTON",
]);

/**
 * Walk every text descendant of `root` and replace mention patterns
 * with anchor spans. Idempotent, re-running on already-decorated HTML
 * is a no-op (the `<a class="story-chip">` is in SKIP_TAG_NAMES).
 */
export function decorateMentionsIn(root: HTMLElement): void {
  // collectTextNodes first, then mutate, mutating during a tree walk
  // breaks the iterator on some browsers.
  const nodes: Text[] = [];
  collectTextNodes(root, nodes);
  for (const node of nodes) {
    decorateTextNode(node);
  }
}

function collectTextNodes(el: Node, out: Text[]): void {
  for (let child = el.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(child as Text);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).tagName;
      if (SKIP_TAG_NAMES.has(tag)) continue;
      collectTextNodes(child, out);
    }
  }
}

function decorateTextNode(node: Text): void {
  const text = node.nodeValue ?? "";
  STORY_MENTION_RE.lastIndex = 0;
  if (!STORY_MENTION_RE.test(text)) return;
  STORY_MENTION_RE.lastIndex = 0;

  const parent = node.parentNode;
  if (!parent) return;
  const doc = node.ownerDocument ?? document;
  const frag = doc.createDocumentFragment();
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STORY_MENTION_RE.exec(text)) !== null) {
    const [, lead, kindRaw, slug] = match;
    // `match.index` points at the leading boundary char (or 0 at
    // start of text). The mention itself begins at index + lead.length.
    const mentionStart = match.index + (lead ?? "").length;
    if (mentionStart > lastIndex) {
      frag.appendChild(doc.createTextNode(text.slice(lastIndex, mentionStart)));
    }
    const kind = kindRaw ?? "";
    const sl = slug ?? "";
    if ((kind === "world" || kind === "char") && sl) {
      const chip = doc.createElement("a");
      chip.className = "story-chip";
      chip.setAttribute("href", chipHrefFor(kind, sl));
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
 * Best-effort href for the chip. We use the URL form the rest of the
 * app recognizes for deep-links so middle-click / open-in-new-tab does
 * something sensible. The actual in-app click is intercepted by the
 * delegated handler below.
 */
function chipHrefFor(kind: StoryChipKind, slug: string): string {
  if (kind === "world") return `/w/${encodeURIComponent(slug)}`;
  // For story-scoped char chips, the href is just a hash anchor into
  // the codex appendix block. Hash routing is local to the open story
  //, the chip's click handler does the smooth-scroll.
  return `#codex-character-${encodeURIComponent(slug)}`;
}

/**
 * Click handler factory. Attach to the article element; intercepts
 * clicks on `.story-chip` and dispatches:
 *   - `world` chips → a `scriptorium:open-world-by-slug` CustomEvent
 *     on `window` (App.tsx listens, fetches world detail, opens viewer).
 *   - `char` chips → scrolls to the codex appendix entry with that
 *     slug and briefly flashes it.
 *
 * Returns the handler so the caller can `removeEventListener` on
 * unmount.
 */
export function makeChipClickHandler(): (e: MouseEvent) => void {
  return (e: MouseEvent) => {
    // Honor cmd/ctrl/middle/shift, let the browser handle "open in
    // new tab" with the natural href fallback.
    if (e.metaKey || e.ctrlKey || e.shiftKey || (e instanceof MouseEvent && e.button !== 0)) return;
    const target = (e.target as Element | null)?.closest<HTMLAnchorElement>("a.story-chip");
    if (!target) return;
    const kind = target.dataset.chipKind as StoryChipKind | undefined;
    const slug = target.dataset.chipSlug;
    if (!kind || !slug) return;
    e.preventDefault();
    if (kind === "world") {
      window.dispatchEvent(new CustomEvent("scriptorium:open-world-by-slug", { detail: { slug } }));
      return;
    }
    if (kind === "char") {
      // Scroll to the codex appendix entry. The appendix renders each
      // entry with an `id="codex-character-{slug}"` anchor below.
      const id = `codex-character-${slug}`;
      // Search in the document, the appendix lives outside the
      // chapter's article element in pageless mode and inside it in
      // book mode, so a document-wide lookup covers both.
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.add("story-chip-flash");
        window.setTimeout(() => el.classList.remove("story-chip-flash"), 1400);
      }
    }
  };
}
