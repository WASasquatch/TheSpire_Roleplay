/**
 * World knowledge-base prose decorator. Turns `@kind:slug` text fragments
 * (e.g. `@npc:captain-vane`, `@location:bazaar`, `@lore:cosmology`, or a custom
 * kind like `@deity:nox`) into clickable `.story-chip` anchors. Mirrors the
 * Scriptorium storyMentions pipeline, generalized to any kind key.
 *
 * The KB viewer is a tabbed modal, so the click handler delegates to an
 * `onOpenEntry(kind, slug)` callback the viewer supplies — it switches to the
 * right tab THEN scrolls to + flashes the target card (`id="kbentry-<kind>-
 * <slug>"`), or selects the Lore page for `@lore:`.
 */

/** kind = a slug-ish key (built-in or custom); slug = the entry slug. */
const WORLD_MENTION_RE = /(^|[^\w@])@([a-z0-9][a-z0-9-]{0,38}):([a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)/g;

const SKIP_TAG_NAMES = new Set(["A", "CODE", "PRE", "STYLE", "SCRIPT", "TEXTAREA", "BUTTON"]);

export function anchorIdFor(kind: string, slug: string): string {
  return `kbentry-${kind}-${slug}`;
}

/** Walk text descendants of `root` and replace `@kind:slug` with chips. */
export function decorateWorldMentionsIn(root: HTMLElement): void {
  const nodes: Text[] = [];
  collectTextNodes(root, nodes);
  for (const node of nodes) decorateTextNode(node);
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

function decorateTextNode(node: Text): void {
  const text = node.nodeValue ?? "";
  WORLD_MENTION_RE.lastIndex = 0;
  if (!WORLD_MENTION_RE.test(text)) return;
  WORLD_MENTION_RE.lastIndex = 0;

  const parent = node.parentNode;
  if (!parent) return;
  const doc = node.ownerDocument ?? document;
  const frag = doc.createDocumentFragment();
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORLD_MENTION_RE.exec(text)) !== null) {
    const [, lead, kindRaw, slug] = match;
    const mentionStart = match.index + (lead ?? "").length;
    if (mentionStart > lastIndex) {
      frag.appendChild(doc.createTextNode(text.slice(lastIndex, mentionStart)));
    }
    const kind = kindRaw ?? "";
    const sl = slug ?? "";
    if (kind && sl) {
      const chip = doc.createElement("a");
      chip.className = "story-chip";
      chip.setAttribute("href", `#${anchorIdFor(kind, sl)}`);
      chip.dataset.chipKind = kind;
      chip.dataset.chipSlug = sl;
      chip.textContent = `@${kind}:${sl}`;
      frag.appendChild(chip);
    } else {
      frag.appendChild(doc.createTextNode(`@${kind}:${sl}`));
    }
    lastIndex = mentionStart + 1 + kind.length + 1 + sl.length;
  }
  if (lastIndex < text.length) frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
  parent.replaceChild(frag, node);
}

/** Click handler factory. Intercepts `.story-chip` clicks and calls
 *  `onOpenEntry(kind, slug)`. Honors modifier/middle clicks (lets the href
 *  hash fallback run). Returns the handler for removeEventListener. */
export function makeWorldChipClickHandler(onOpenEntry: (kind: string, slug: string) => void): (e: MouseEvent) => void {
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const target = (e.target as Element | null)?.closest<HTMLAnchorElement>("a.story-chip");
    if (!target) return;
    const kind = target.dataset.chipKind;
    const slug = target.dataset.chipSlug;
    if (!kind || !slug) return;
    e.preventDefault();
    onOpenEntry(kind, slug);
  };
}

/** Scroll to + flash a KB entry anchor (used by the viewer's onOpenEntry once
 *  it has switched to the right tab and rendered the card). */
export function flashKbEntry(kind: string, slug: string): void {
  const el = document.getElementById(anchorIdFor(kind, slug));
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("story-chip-flash");
  window.setTimeout(() => el.classList.remove("story-chip-flash"), 1400);
}
