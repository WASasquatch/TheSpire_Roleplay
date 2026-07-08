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
 *
 * The shared DOM walk, fragment build, chip markup, click guard, and
 * flash live in the `mentionChips` module; this file supplies the
 * Scriptorium-specific `@world:`/`@char:` pattern, href scheme, and
 * click dispatch.
 */

import { MENTION_WORLD_SLUG_CHARS } from "@thekeep/shared";
import {
  decorateMentionChipsIn,
  makeMentionChipClickHandler,
  scrollToAndFlashChipTarget,
} from "./mentionChips.js";

/** Supported chip kinds in prose. Mirrors the spec's @world: / @char: tokens. */
export type StoryChipKind = "world" | "char";

/**
 * Patterns we match in text nodes. Same shape as the existing chat
 * mention regex (kebab slugs, 1-60 chars). Leading boundary is either
 * start-of-text or a non-word char so we don't match "email@world:foo"
 * mid-word. Module-level singleton (stateful `.lastIndex`); the shared
 * walker resets it.
 */
const STORY_MENTION_RE = new RegExp(
  `(^|[^\\w@])@(world|char):(${MENTION_WORLD_SLUG_CHARS})`,
  "g",
);

/**
 * Walk every text descendant of `root` and replace mention patterns
 * with anchor spans. Idempotent, re-running on already-decorated HTML
 * is a no-op (the `<a class="story-chip">` is skipped).
 */
export function decorateMentionsIn(root: HTMLElement): void {
  decorateMentionChipsIn(root, {
    pattern: STORY_MENTION_RE,
    isValidKind: (kind) => kind === "world" || kind === "char",
    hrefFor: (kind, slug) => chipHrefFor(kind as StoryChipKind, slug),
  });
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
  return makeMentionChipClickHandler((kindRaw, slug) => {
    const kind = kindRaw as StoryChipKind;
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
        scrollToAndFlashChipTarget(el);
      }
    }
  });
}
