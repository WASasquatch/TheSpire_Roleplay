/**
 * YouTube Data API v3 helpers for /theater.
 *
 * Env-gated the same way as the mailer (process.env.KEY + exported
 * `configured` boolean): when `YOUTUBE_API_KEY` is unset the whole module
 * degrades — `youtubeConfigured` is false and the /theater feature stays
 * dark. The feature team fills the stub bodies below (playlist expansion,
 * title lookup, id parsing) against this fixed contract.
 *
 * Config (via env / Fly secrets):
 *   YOUTUBE_API_KEY - required to call the Data API; unset = feature off
 */

const API_KEY = process.env.YOUTUBE_API_KEY ?? "";

/** True once a YouTube Data API key is present, so callers can branch UX. */
export const youtubeConfigured = API_KEY.length > 0;

/** Exported for the feature team to build authorized Data API requests. */
export { API_KEY };

/** Data API base + outbound-fetch posture (mirrors unfurl.ts fetchHtml). */
const API_BASE = "https://www.googleapis.com/youtube/v3";
const FETCH_TIMEOUT_MS = 5_000;

/**
 * GET a Data API endpoint and parse JSON, modeled on unfurl.ts fetchHtml:
 * AbortController timeout, never throws, returns null on any error / non-200.
 * The key is appended here so callers pass only the query params.
 */
async function apiGet<T = any>(path: string, params: Record<string, string>): Promise<T | null> {
  const qs = new URLSearchParams({ ...params, key: API_KEY }).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/${path}?${qs}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Playlist prefixes we treat as real, expandable playlists. YouTube also
 *  hands out auto-generated "RD…" (radio/mix) and "UL…" ids on watch URLs;
 *  those aren't fetchable via playlistItems, so we ignore them and only
 *  expand user/system playlists: PL (created), FL (favorites), UU (channel
 *  uploads), LL (liked). */
const EXPANDABLE_PLAYLIST_RX = /^(?:PL|FL|UU|LL)[\w-]+$/;

/**
 * Parse a YouTube URL into its video and/or playlist ids.
 *
 * Handles watch (?v=), youtu.be/<id>, /shorts/<id>, /embed/<id>, and
 * /live/<id> shapes for the video id, plus a `list=` query param for the
 * playlist id. A watch URL carrying BOTH `v` and a real `list` keeps both
 * (the caller expands the playlist). Auto-generated mix/radio lists
 * (RD…/UL…) are dropped so only genuinely expandable playlists come back.
 */
export function parseYoutubeIds(url: string): { videoId?: string; playlistId?: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return {};
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const isYouTube = host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com" || host === "youtu.be";
  if (!isYouTube) return {};

  let videoId: string | undefined;
  const path = u.pathname;

  if (host === "youtu.be") {
    // youtu.be/<id>
    videoId = path.slice(1).split("/")[0] || undefined;
  } else {
    const shorts = /^\/shorts\/([\w-]+)/.exec(path);
    const embed = /^\/embed\/([\w-]+)/.exec(path);
    const live = /^\/live\/([\w-]+)/.exec(path);
    if (shorts) videoId = shorts[1];
    else if (embed) videoId = embed[1];
    else if (live) videoId = live[1];
    else videoId = u.searchParams.get("v") ?? undefined;
  }
  // Guard against empty / obviously wrong ids (YouTube ids are [\w-]).
  if (videoId && !/^[\w-]+$/.test(videoId)) videoId = undefined;

  let playlistId: string | undefined;
  const list = u.searchParams.get("list");
  if (list && EXPANDABLE_PLAYLIST_RX.test(list)) playlistId = list;

  return {
    ...(videoId ? { videoId } : {}),
    ...(playlistId ? { playlistId } : {}),
  };
}

/** Titles YouTube uses for unavailable playlist items — drop these. */
const UNAVAILABLE_ITEM_TITLES = new Set(["Private video", "Deleted video"]);

type PlaylistItemsResponse = {
  nextPageToken?: string;
  items?: {
    snippet?: {
      title?: string;
      resourceId?: { videoId?: string };
    };
  }[];
};

/**
 * Expand a playlist id into its ordered list of watch URLs + titles.
 *
 * One page (maxResults=50) is enough for the 50-source cap; if the caller
 * needs more we follow at most ONE nextPageToken. Private/deleted items
 * (title "Private video"/"Deleted video" or a missing videoId) are dropped.
 * Never throws — returns [] on any API error, non-200, or empty result.
 */
export async function expandPlaylist(
  playlistId: string,
): Promise<{ url: string; title: string }[]> {
  const out: { url: string; title: string }[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 2; page++) {
    const params: Record<string, string> = {
      part: "snippet",
      maxResults: "50",
      playlistId,
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await apiGet<PlaylistItemsResponse>("playlistItems", params);
    if (!data?.items) break;

    for (const item of data.items) {
      const snip = item.snippet;
      const videoId = snip?.resourceId?.videoId;
      const title = snip?.title ?? "";
      if (!videoId) continue;
      if (UNAVAILABLE_ITEM_TITLES.has(title)) continue;
      out.push({ url: `https://www.youtube.com/watch?v=${videoId}`, title });
    }

    // We only ever need one page for the 50-cap; follow a second only if the
    // first came back short of 50 real items and more pages exist.
    if (!data.nextPageToken || out.length >= 50) break;
    pageToken = data.nextPageToken;
  }

  return out;
}

type VideosResponse = {
  items?: { snippet?: { title?: string } }[];
};

/**
 * Look up a single video's title by id, or null when unavailable.
 * Never throws — returns null on any API error, non-200, or missing item.
 */
export async function fetchVideoTitle(videoId: string): Promise<string | null> {
  const data = await apiGet<VideosResponse>("videos", { part: "snippet", id: videoId });
  return data?.items?.[0]?.snippet?.title ?? null;
}
