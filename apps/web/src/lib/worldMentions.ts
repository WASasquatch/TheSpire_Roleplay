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
 *
 * The DOM walk, fragment build, chip markup, click guard, and flash live in
 * the shared `mentionChips` module; this file supplies the KB-specific match
 * pattern (any kind key) and `#kbentry-<kind>-<slug>` href scheme.
 */

import { MENTION_WORLD_SLUG_CHARS } from "@thekeep/shared";
import {
  decorateMentionChipsIn,
  makeMentionChipClickHandler,
  scrollToAndFlashChipTarget,
} from "./mentionChips.js";

/** kind = a slug-ish key (built-in or custom); slug = the entry slug.
 *  Module-level singleton (stateful `.lastIndex`); the shared walker resets it. */
const WORLD_MENTION_RE = new RegExp(
  `(^|[^\\w@])@([a-z0-9][a-z0-9-]{0,38}):(${MENTION_WORLD_SLUG_CHARS})`,
  "g",
);

export function anchorIdFor(kind: string, slug: string): string {
  return `kbentry-${kind}-${slug}`;
}

/** Walk text descendants of `root` and replace `@kind:slug` with chips. */
export function decorateWorldMentionsIn(root: HTMLElement): void {
  decorateMentionChipsIn(root, {
    pattern: WORLD_MENTION_RE,
    isValidKind: (kind) => !!kind,
    hrefFor: (kind, slug) => `#${anchorIdFor(kind, slug)}`,
  });
}

/** Click handler factory. Intercepts `.story-chip` clicks and calls
 *  `onOpenEntry(kind, slug)`. Honors modifier/middle clicks (lets the href
 *  hash fallback run). Returns the handler for removeEventListener. */
export function makeWorldChipClickHandler(onOpenEntry: (kind: string, slug: string) => void): (e: MouseEvent) => void {
  return makeMentionChipClickHandler(onOpenEntry);
}

/** Scroll to + flash a KB entry anchor (used by the viewer's onOpenEntry once
 *  it has switched to the right tab and rendered the card). */
export function flashKbEntry(kind: string, slug: string): void {
  const el = document.getElementById(anchorIdFor(kind, slug));
  if (!el) return;
  scrollToAndFlashChipTarget(el);
}
