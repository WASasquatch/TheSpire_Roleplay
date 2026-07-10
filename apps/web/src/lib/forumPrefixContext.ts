import { createContext } from "react";
import type { ForumPrefixWire } from "@thekeep/shared";

/**
 * Makes a forum's tag (prefix) catalog + assign affordance reachable by the
 * topic cards deep in MessageList without prop-drilling. The Forums Catalog
 * provides it; null means "not in a forum" so cards render no chip.
 *
 * Tags can be category-scoped (each prefix carries `categoryIds`; empty =
 * global), so cards filter `all` against their own category. The tag system
 * hides entirely on a topic when there are no applicable curated tags AND the
 * viewer can't mint a custom one — `canCreateCustom` (the forum allows custom
 * tags AND the viewer holds create_tags / owner) decides the latter.
 */
export interface ForumPrefixCtx {
  /** Resolve an assigned prefixId → chip (covers tags now out of scope too). */
  byId: Map<string, ForumPrefixWire>;
  /** Full catalog, for filtering the offer list by a topic's category. */
  all: ForumPrefixWire[];
  /** Viewer holds manage_prefixes (or is owner/staff) — can (re)assign + curate. */
  canManagePrefixes: boolean;
  /** Forum allows custom tags AND the viewer may mint one on the fly. */
  canCreateCustom: boolean;
  /**
   * Open the tag picker for one topic. `nsfw` carries what the picker's
   * NSFW re-tag section (age-restriction plan Phase 3) needs: the topic's
   * current tag state and its author (the author may re-tag their own
   * topic, adults only — the picker mirrors the server's gate with these).
   */
  onAssign: (
    topicId: string,
    currentPrefixId: string | null,
    topicCategoryId: string | null,
    nsfw: { current: boolean; authorUserId: string },
  ) => void;
}

export const ForumPrefixContext = createContext<ForumPrefixCtx | null>(null);
