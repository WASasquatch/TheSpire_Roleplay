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
 *   YOUTUBE_API_KEY      - required to call the Data API; unset = feature off
 *   YOUTUBE_API_REFERRER - optional; sent as the `Referer` header so an API key
 *                          restricted to HTTP referrers accepts server-side
 *                          calls (e.g. https://thespire.games). Unset = send
 *                          none, which is correct when the key uses NO
 *                          restriction or an IP-address restriction instead.
 */

const API_KEY = process.env.YOUTUBE_API_KEY ?? "";

/** True once a YouTube Data API key is present, so callers can branch UX. */
export const youtubeConfigured = API_KEY.length > 0;

/**
 * Optional `Referer` for Data API calls. A key locked to "HTTP referrers
 * (websites)" rejects a bare backend call ("Requests from referer <empty> are
 * blocked.") because a server-to-server fetch carries no page referrer. Set
 * this to a value that matches the key's allowed referrer list and we attach
 * it so a referrer-restricted key accepts the call. The recommended posture
 * for a server-side key is instead NO restriction or an IP restriction, in
 * which case leave this unset.
 */
const API_REFERER = process.env.YOUTUBE_API_REFERRER ?? "";

/** Exported for the feature team to build authorized Data API requests. */
export { API_KEY };

/** Data API base + outbound-fetch posture (mirrors unfurl.ts fetchHtml). */
const API_BASE = "https://www.googleapis.com/youtube/v3";
const FETCH_TIMEOUT_MS = 5_000;

/**
 * A YouTube Data API error distilled from the JSON response BODY (not just the
 * HTTP status), so callers can tell the operator the ACTUAL cause. YouTube
 * returns `{ error: { code, message, status, errors: [{ reason, domain }] } }`;
 * we keep the fields that identify the fix — the HTTP status, the API `status`
 * (e.g. PERMISSION_DENIED), the first error `reason` (forbidden / quotaExceeded
 * / keyInvalid / …), and the human `message` ("Requests from referer <empty>
 * are blocked."). Never carries the API key (the key rides only the URL).
 */
export interface YoutubeApiError {
  httpStatus: number;
  apiStatus?: string;
  reason?: string;
  message?: string;
}

interface ApiResult<T> {
  data: T | null;
  error: YoutubeApiError | null;
}

/**
 * GET a Data API endpoint, modeled on unfurl.ts fetchHtml: AbortController
 * timeout, never throws. On any non-200 it parses YouTube's error body into a
 * {@link YoutubeApiError} (and logs the raw body server-side); callers surface
 * the distilled reason. The key is appended here so callers pass only params.
 */
async function apiGet<T = any>(path: string, params: Record<string, string>): Promise<ApiResult<T>> {
  const qs = new URLSearchParams({ ...params, key: API_KEY }).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/${path}?${qs}`, {
      signal: ctrl.signal,
      // Attach the configured Referer so a key restricted to HTTP referrers
      // accepts the call (a bare backend fetch otherwise sends none → 403
      // "Requests from referer <empty> are blocked"). Node's fetch transmits a
      // manually-set Referer as-is. Omitted when YOUTUBE_API_REFERRER is unset.
      headers: {
        accept: "application/json",
        ...(API_REFERER ? { Referer: API_REFERER } : {}),
      },
    });
    if (!res.ok) {
      // Read + parse YouTube's error body for the specific machine-readable
      // reason (e.g. "forbidden" + "Requests from referer <empty> are blocked"
      // = an HTTP-referrer-restricted key; "quotaExceeded" = the daily cap;
      // the API v3 not enabled = a different reason). The key is only ever in
      // the request URL, never the body, so this is safe to surface + log.
      let body = "";
      try { body = await res.text(); } catch { /* ignore unreadable body */ }
      let e: { message?: unknown; status?: unknown; errors?: Array<{ reason?: unknown }> } | null = null;
      try { e = JSON.parse(body)?.error ?? null; } catch { /* non-JSON body */ }
      const error: YoutubeApiError = {
        httpStatus: res.status,
        ...(typeof e?.status === "string" ? { apiStatus: e.status } : {}),
        ...(typeof e?.errors?.[0]?.reason === "string" ? { reason: e.errors[0]!.reason as string } : {}),
        ...(typeof e?.message === "string"
          ? { message: e.message as string }
          : body ? { message: body.slice(0, 300) } : {}),
      };
      // eslint-disable-next-line no-console
      console.error(`[youtube] ${path} -> ${res.status} ${res.statusText} :: ${body.slice(0, 500)}`);
      return { data: null, error };
    }
    return { data: (await res.json()) as T, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[youtube] ${path} request failed:`, message);
    return { data: null, error: { httpStatus: 0, message } };
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
): Promise<{ items: { url: string; title: string }[]; error: YoutubeApiError | null }> {
  const out: { url: string; title: string }[] = [];
  let pageToken: string | undefined;
  let error: YoutubeApiError | null = null;

  for (let page = 0; page < 2; page++) {
    const params: Record<string, string> = {
      part: "snippet",
      maxResults: "50",
      playlistId,
    };
    if (pageToken) params.pageToken = pageToken;

    const { data, error: err } = await apiGet<PlaylistItemsResponse>("playlistItems", params);
    if (err) { error = err; break; }
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

  return { items: out, error };
}

type VideosResponse = {
  items?: { id?: string; snippet?: { title?: string } }[];
};

/**
 * Look up a single video's title by id, or null when unavailable.
 * Never throws — returns null on any API error, non-200, or missing item.
 */
export async function fetchVideoTitle(videoId: string): Promise<string | null> {
  const { data } = await apiGet<VideosResponse>("videos", { part: "snippet", id: videoId });
  return data?.items?.[0]?.snippet?.title ?? null;
}

/**
 * Batch-resolve video titles by id, returned as `id -> title`. The Data API's
 * `videos.list` accepts up to 50 ids for ONE unit of quota, so a retroactive
 * backfill of many legacy items is cheap. Ids that are unavailable (private /
 * deleted) simply don't appear in the map. Never throws — a failed batch is
 * skipped, leaving its ids unresolved for a later attempt.
 */
export async function fetchVideoTitles(videoIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    if (batch.length === 0) continue;
    const { data } = await apiGet<VideosResponse>("videos", { part: "snippet", id: batch.join(",") });
    for (const item of data?.items ?? []) {
      const id = item.id;
      const title = item.snippet?.title;
      if (id && title) out.set(id, title);
    }
  }
  return out;
}
