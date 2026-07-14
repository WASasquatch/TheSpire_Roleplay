/**
 * Dynamic UI-route chip resolution.
 *
 * Some `{token}` chips resolve their label (and sometimes their click
 * target) at render time rather than from the static catalog:
 *   - {scriptorium:latest:story} → the latest published story's title
 *   - {scriptorium:<slug>} → that specific story's title
 *   - {users:latest} / {users:character:latest} → the newest member's name
 *   - {ranking:<board>} → "<Board>: <#1 ranked member>"
 *
 * Both render surfaces (the React chip in markdown.tsx and the HTML
 * hydrator in hydrateDynamicUiRouteChips.ts) call {@link resolveDynamicChipLabel}
 * so adding a new dynamic chip is one `case` here plus one entry in the
 * shared `dynamicMarkerFor`. Fetches are TTL-cached + coalesced so a
 * page full of chips doesn't N+1 the server; the `random` member pick
 * is deliberately NOT cached so it re-rolls on every click.
 */

import type { UiRoute, UiRouteRankingBoard } from "@thekeep/shared";
import { fetchLatestPublishedStory } from "./latestStory.js";
import { fetchRankings, type RankingsResponse } from "./earning.js";
import { fetchForumDetail, fetchTopicThread, locateForumTopic } from "./forums.js";

const TTL_MS = 30_000;

/* ---------- member spotlight ---------- */

export interface SpotlightMember {
  /** Identity token for `profile:fetch` (username, or `@cid:<id>`). */
  token: string;
  displayName: string;
}

interface MemberCell {
  result: SpotlightMember | null;
  expiresAt: number;
  inFlight: Promise<SpotlightMember | null> | null;
}
// One cache cell per scope, for the `latest` picks only.
const latestMemberCache = new Map<"user" | "character", MemberCell>();

async function requestSpotlight(scope: "user" | "character", pick: "latest" | "random"): Promise<SpotlightMember | null> {
  try {
    const r = await fetch(`/members/spotlight?scope=${scope}&pick=${pick}`, { credentials: "include" });
    if (!r.ok) return null;
    const j = (await r.json()) as { member?: SpotlightMember | null };
    return j.member ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a member to spotlight. `latest` is TTL-cached + coalesced per
 * scope; `random` is never cached so each call (label render + click)
 * re-rolls a fresh pick.
 */
export async function fetchSpotlightMember(
  scope: "user" | "character",
  pick: "latest" | "random",
): Promise<SpotlightMember | null> {
  if (pick === "random") return requestSpotlight(scope, "random");
  const now = Date.now();
  const cell = latestMemberCache.get(scope);
  if (cell) {
    if (cell.result !== null && now < cell.expiresAt) return cell.result;
    if (cell.inFlight) return cell.inFlight;
  }
  const inFlight = (async () => {
    const result = await requestSpotlight(scope, "latest");
    latestMemberCache.set(scope, { result, expiresAt: Date.now() + TTL_MS, inFlight: null });
    return result;
  })();
  latestMemberCache.set(scope, { result: cell?.result ?? null, expiresAt: cell?.expiresAt ?? 0, inFlight });
  return inFlight;
}

/* ---------- top-ranked (for {ranking:<board>} labels) ---------- */

let rankingsCell: { result: RankingsResponse | null; expiresAt: number; inFlight: Promise<RankingsResponse | null> | null } = {
  result: null,
  expiresAt: 0,
  inFlight: null,
};

async function getRankingsCached(): Promise<RankingsResponse | null> {
  const now = Date.now();
  if (rankingsCell.result !== null && now < rankingsCell.expiresAt) return rankingsCell.result;
  if (rankingsCell.inFlight) return rankingsCell.inFlight;
  rankingsCell.inFlight = (async () => {
    try {
      const r = await fetchRankings();
      rankingsCell = { result: r, expiresAt: Date.now() + TTL_MS, inFlight: null };
      return r;
    } catch {
      rankingsCell.inFlight = null;
      return null;
    }
  })();
  return rankingsCell.inFlight;
}

/** Display name of the #1 entry on a board, or null when empty. */
export async function fetchTopRankedName(board: UiRouteRankingBoard): Promise<string | null> {
  const r = await getRankingsCached();
  return r?.boards.find((b) => b.key === board)?.entries[0]?.displayName ?? null;
}

/* ---------- world / room name (for {world:…} / {room:…} labels) ---------- */

interface NameCell {
  name: string | null;
  expiresAt: number;
  inFlight: Promise<string | null> | null;
}

/** Shared TTL-cache+coalesce around a per-ref name lookup. Keyed by the
 *  lowercase slug/id ref so a chat line repeating a chip hits once. */
function cachedName(
  cache: Map<string, NameCell>,
  ref: string,
  fetcher: () => Promise<string | null>,
): Promise<string | null> {
  const key = ref.toLowerCase();
  const now = Date.now();
  const cell = cache.get(key);
  if (cell) {
    if (cell.name !== null && now < cell.expiresAt) return Promise.resolve(cell.name);
    if (cell.inFlight) return cell.inFlight;
  }
  const inFlight = (async () => {
    const name = await fetcher();
    cache.set(key, { name, expiresAt: Date.now() + TTL_MS, inFlight: null });
    return name;
  })();
  cache.set(key, { name: cell?.name ?? null, expiresAt: cell?.expiresAt ?? 0, inFlight });
  return inFlight;
}

const worldNameCache = new Map<string, NameCell>();

/**
 * Resolve a world's display name from its slug/id via the same
 * `GET /worlds/:idOrSlug` the viewer uses. Visibility is enforced
 * server-side: a private world the viewer can't see returns the
 * `{private:true}` stub (or 404), both of which yield a null name so
 * the chip degrades to its literal `{world:slug}` text.
 */
export async function fetchWorldName(ref: string): Promise<string | null> {
  return cachedName(worldNameCache, ref, async () => {
    try {
      const r = await fetch(`/worlds/${encodeURIComponent(ref)}`, { credentials: "include" });
      if (!r.ok) return null;
      const j = (await r.json()) as { private?: boolean; world?: { name?: string } };
      if (j.private) return null;
      return j.world?.name ?? null;
    } catch {
      return null;
    }
  });
}

/* ---------- room brief (id + name, for {room:…} labels + join) ---------- */

export interface RoomBrief {
  id: string;
  name: string;
}

interface RoomBriefCell {
  brief: RoomBrief | null;
  expiresAt: number;
  inFlight: Promise<RoomBrief | null> | null;
}
const roomBriefCache = new Map<string, RoomBriefCell>();

/**
 * Resolve a room's `{id, name}` from its slug via
 * `GET /rooms/by-slug/:slug`. The endpoint is visibility-gated: a
 * private room the viewer isn't a member of (and isn't staff for)
 * 404s, yielding null so the chip degrades to literal text and the
 * click is a no-op. Cached so the label render + the click-time join
 * share one lookup. Both `{id, name}` are needed: the label uses the
 * name, the dispatcher uses the id to drive the existing room:join.
 */
export async function fetchRoomBrief(ref: string): Promise<RoomBrief | null> {
  const key = ref.toLowerCase();
  const now = Date.now();
  const cell = roomBriefCache.get(key);
  if (cell) {
    if (cell.brief !== null && now < cell.expiresAt) return cell.brief;
    if (cell.inFlight) return cell.inFlight;
  }
  const inFlight = (async () => {
    let brief: RoomBrief | null = null;
    try {
      const r = await fetch(`/rooms/by-slug/${encodeURIComponent(ref)}`, { credentials: "include" });
      if (r.ok) {
        const j = (await r.json()) as { room?: RoomBrief };
        brief = j.room ?? null;
      }
    } catch {
      brief = null;
    }
    roomBriefCache.set(key, { brief, expiresAt: Date.now() + TTL_MS, inFlight: null });
    return brief;
  })();
  roomBriefCache.set(key, { brief: cell?.brief ?? null, expiresAt: cell?.expiresAt ?? 0, inFlight });
  return inFlight;
}

/** Room display name for a `{room:<slug>}` chip label, or null when the
 *  room is missing / not visible to the viewer. */
export async function fetchRoomName(ref: string): Promise<string | null> {
  const brief = await fetchRoomBrief(ref);
  return brief?.name ?? null;
}

/* ---------- story brief (id + title, for {scriptorium:<slug>} labels + open) ---------- */

export interface StoryBrief {
  id: string;
  title: string;
}

interface StoryBriefCell {
  brief: StoryBrief | null;
  expiresAt: number;
  inFlight: Promise<StoryBrief | null> | null;
}
const storyBriefCache = new Map<string, StoryBriefCell>();

/**
 * Resolve a story's `{id, title}` from its slug (or id) via the same
 * visibility-gated `GET /stories/:idOrSlug` the reader uses. A private
 * story the viewer can't see returns the `{private:true}` stub (or
 * 404), both of which yield null so the chip degrades to its literal
 * `{scriptorium:slug}` text and the click is a no-op — mirroring the
 * world/room privacy posture. Cached + coalesced so the label render
 * and the click-time open share one lookup; both fields are needed
 * (the label uses the title, the dispatcher uses the id to open the
 * StoryReader).
 */
export async function fetchStoryBrief(ref: string): Promise<StoryBrief | null> {
  const key = ref.toLowerCase();
  const now = Date.now();
  const cell = storyBriefCache.get(key);
  if (cell) {
    if (cell.brief !== null && now < cell.expiresAt) return cell.brief;
    if (cell.inFlight) return cell.inFlight;
  }
  const inFlight = (async () => {
    let brief: StoryBrief | null = null;
    try {
      const r = await fetch(`/stories/${encodeURIComponent(ref)}`, { credentials: "include" });
      if (r.ok) {
        const j = (await r.json()) as { private?: boolean; story?: { id?: string; title?: string } };
        if (!j.private && j.story?.id && j.story.title) {
          brief = { id: j.story.id, title: j.story.title };
        }
      }
    } catch {
      brief = null;
    }
    storyBriefCache.set(key, { brief, expiresAt: Date.now() + TTL_MS, inFlight: null });
    return brief;
  })();
  storyBriefCache.set(key, { brief: cell?.brief ?? null, expiresAt: cell?.expiresAt ?? 0, inFlight });
  return inFlight;
}

/** Story title for a `{scriptorium:<slug>}` chip label, or null when the
 *  story is missing / not visible to the viewer. */
export async function fetchStoryName(ref: string): Promise<string | null> {
  const brief = await fetchStoryBrief(ref);
  return brief?.title ?? null;
}

/* ---------- forum name (for {forum:<slug>} labels) ---------- */

const forumNameCache = new Map<string, NameCell>();

/**
 * Resolve a forum's display name from its slug (or id) via the
 * visibility-gated `GET /forums/:idOrSlug`. A forum the viewer can't see
 * throws (404 / 403) → null, so the `{forum:<slug>}` chip degrades to its
 * literal text. Cached + coalesced like the world / room / story lookups.
 */
export async function fetchForumName(ref: string): Promise<string | null> {
  return cachedName(forumNameCache, ref, async () => {
    try {
      const d = await fetchForumDetail(ref);
      return d?.name ?? null;
    } catch {
      return null;
    }
  });
}

/* ---------- forum post coords + title (for {post:<id>} labels + jump) ---------- */

export interface ForumPostBrief {
  forumId: string;
  forumSlug: string;
  boardRoomId: string;
  topicId: string;
  /** The owning topic's title (chip label). Null when the topic has none. */
  title: string | null;
}

interface ForumPostBriefCell {
  brief: ForumPostBrief | null;
  expiresAt: number;
  inFlight: Promise<ForumPostBrief | null> | null;
}
// Keyed by the RAW post id — nanoids are case-sensitive, so (unlike the
// slug caches above) this key is NOT lowercased.
const forumPostBriefCache = new Map<string, ForumPostBriefCell>();

/**
 * Resolve a forum post id to its forum coordinates + owning topic title.
 * `locateForumTopic` is visibility-gated (throws for a post the viewer
 * can't reach) and resolves a topic id OR a reply id to the owning topic;
 * the thread fetch then supplies that topic's title for the chip label.
 * Both the chip's label render and its click-time jump share this one
 * cached lookup, so a `{post:<id>}` click reuses the render's fetch.
 */
export async function fetchForumPostBrief(ref: string): Promise<ForumPostBrief | null> {
  const now = Date.now();
  const cell = forumPostBriefCache.get(ref);
  if (cell) {
    if (cell.brief !== null && now < cell.expiresAt) return cell.brief;
    if (cell.inFlight) return cell.inFlight;
  }
  const inFlight = (async () => {
    let brief: ForumPostBrief | null = null;
    try {
      const coords = await locateForumTopic(ref);
      let title: string | null = null;
      try {
        const thread = await fetchTopicThread(coords.boardRoomId, coords.topicId);
        title = thread.topic.title ?? null;
      } catch {
        title = null; // located but the thread/title is unavailable — label falls back
      }
      brief = { ...coords, title };
    } catch {
      brief = null;
    }
    forumPostBriefCache.set(ref, { brief, expiresAt: Date.now() + TTL_MS, inFlight: null });
    return brief;
  })();
  forumPostBriefCache.set(ref, { brief: cell?.brief ?? null, expiresAt: cell?.expiresAt ?? 0, inFlight });
  return inFlight;
}

/** Owning-topic title for a `{post:<id>}` chip label, or null when the post
 *  is missing / not visible to the viewer. */
export async function fetchForumPostTitle(ref: string): Promise<string | null> {
  const brief = await fetchForumPostBrief(ref);
  return brief?.title ?? null;
}

/* ---------- unified resolver ---------- */

/**
 * Resolve the dynamic label for a chip, or null to keep the static
 * catalog label. Only called for chips `dynamicMarkerFor` flagged.
 */
export async function resolveDynamicChipLabel(entry: UiRoute): Promise<string | null> {
  const t = entry.target;
  switch (t.kind) {
    case "nav-scriptorium-latest-story": {
      const s = await fetchLatestPublishedStory();
      return s?.title ?? null;
    }
    case "open-member": {
      // Only `latest` resolves to a stable name; `random` keeps its
      // static label (it re-rolls each click).
      if (t.pick !== "latest") return null;
      const m = await fetchSpotlightMember(t.scope, t.pick);
      return m?.displayName ?? null;
    }
    case "modal-earning": {
      if (!t.board) return null;
      const top = await fetchTopRankedName(t.board);
      // Keep the board name as context: "Wealthiest: Kaal".
      return top ? `${entry.label}: ${top}` : null;
    }
    case "open-world":
      return fetchWorldName(t.ref);
    case "nav-room":
      return fetchRoomName(t.ref);
    case "open-story":
      return fetchStoryName(t.ref);
    case "nav-forum":
      return fetchForumName(t.ref);
    case "open-forum-post":
      return fetchForumPostTitle(t.ref);
    default:
      return null;
  }
}
