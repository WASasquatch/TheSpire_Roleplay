/**
 * Retroactive backfill of YouTube METADATA (title + length) onto persisted
 * /theater playlist items.
 *
 * Two purposes, both filled from one Data API pass:
 *   TITLE    - auto-titling only ever ran for NEW `/theater add`s. Items queued
 *              before that feature (or while the Data API was down) kept a bare
 *              watch URL and no title, so the playlist read as a wall of
 *              indistinguishable URLs.
 *   DURATION - the server advances an EMPTY room's playlist using each source's
 *              cached length (see theaterScheduler.ts). Legacy items, and any
 *              queued before duration-caching existed, have no length, so an
 *              empty room can't loop past them. Learning it here lets every
 *              YouTube source loop an empty room from the next boot on, without
 *              waiting for a viewer to report it.
 *
 * Sweeps every room's persisted playlist once at boot, fills what's missing
 * from the API, persists, rebroadcasts room state so any open theater panel
 * relabels live, and reconciles each changed room's advance timer so a newly-
 * learned duration arms playback immediately.
 *
 * Gated on `youtubeConfigured`. Idempotent: only YouTube items still missing a
 * real title OR a length are looked up, so a run after everything is resolved
 * is a cheap DB scan with zero API calls. Batched (50 ids per unit of quota)
 * and best-effort - a failed lookup just leaves those items for the next boot.
 * Runs in the background; never throws into the boot sequence.
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents, TheaterSource } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { rooms } from "../db/schema.js";
import { fetchVideoMetas, parseYoutubeIds, youtubeConfigured, type VideoMeta } from "../lib/youtube.js";
import { broadcastRoomState } from "./broadcast.js";
import { reconcileTheaterTimer } from "./theaterScheduler.js";
import { parsePlaylist, serializePlaylist } from "./theaterState.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** A YouTube item "needs a title" when its label is missing, blank, or itself a URL. */
export function needsTitle(s: TheaterSource): boolean {
  if (s.kind !== "youtube") return false;
  const t = (s.title ?? "").trim();
  return t === "" || t === s.url || /^https?:\/\//i.test(t);
}

/** A YouTube item "needs a length" when it isn't live and has no cached
 *  positive `durationSec`. Live sources have no fixed length, so never. */
export function needsDuration(s: TheaterSource): boolean {
  if (s.kind !== "youtube" || s.live) return false;
  return !(typeof s.durationSec === "number" && s.durationSec > 0);
}

/** Distinct resolvable YouTube video ids in a playlist that still need title or length. */
export function videoIdsNeedingMeta(list: TheaterSource[]): string[] {
  const ids = new Set<string>();
  for (const s of list) {
    if (!needsTitle(s) && !needsDuration(s)) continue;
    const { videoId } = parseYoutubeIds(s.url);
    if (videoId) ids.add(videoId);
  }
  return [...ids];
}

/**
 * Apply resolved `videoId -> meta` onto items still missing a title/length,
 * mutating `list` in place. Only touches items still failing needsTitle /
 * needsDuration, so it can't clobber an operator-supplied title or a length a
 * controller already reported. Returns how many titles + lengths were filled.
 */
export function applyMetas(list: TheaterSource[], metas: Map<string, VideoMeta>): { renamed: number; timed: number } {
  let renamed = 0;
  let timed = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    const wantsTitle = needsTitle(s);
    const wantsDuration = needsDuration(s);
    if (!wantsTitle && !wantsDuration) continue;
    const { videoId } = parseYoutubeIds(s.url);
    const meta = videoId ? metas.get(videoId) : undefined;
    if (!meta) continue;
    if (wantsTitle && meta.title) {
      s.title = meta.title;
      renamed++;
    }
    if (wantsDuration && meta.durationSec) {
      s.durationSec = meta.durationSec;
      timed++;
    }
  }
  return { renamed, timed };
}

export async function backfillTheaterTitles(io: Io, db: Db): Promise<void> {
  if (!youtubeConfigured) return;
  try {
    // Rooms that actually carry a playlist (skip the null/empty common case).
    const rows = await db
      .select({ id: rooms.id, theaterPlaylist: rooms.theaterPlaylist })
      .from(rooms)
      .where(and(isNotNull(rooms.theaterPlaylist), ne(rooms.theaterPlaylist, "[]")));

    // First pass: parse each playlist and collect the video ids that still
    // need title/length, keeping the parsed list so we can write back later.
    const parsedByRoom = new Map<string, TheaterSource[]>();
    const idsToFetch = new Set<string>();
    for (const row of rows) {
      const list = parsePlaylist(row.theaterPlaylist);
      const ids = videoIdsNeedingMeta(list);
      if (ids.length === 0) continue;
      parsedByRoom.set(row.id, list);
      for (const id of ids) idsToFetch.add(id);
    }
    if (idsToFetch.size === 0) return;

    const metas = await fetchVideoMetas([...idsToFetch]);
    if (metas.size === 0) return; // API down / quota / all unavailable — retry next boot.

    // Second pass: apply resolved metadata and persist only the rooms that changed.
    let itemsRenamed = 0;
    let itemsTimed = 0;
    const changedRooms: string[] = [];
    for (const [roomId, list] of parsedByRoom) {
      const { renamed, timed } = applyMetas(list, metas);
      if (renamed > 0 || timed > 0) {
        itemsRenamed += renamed;
        itemsTimed += timed;
        await db
          .update(rooms)
          .set({ theaterPlaylist: serializePlaylist(list) })
          .where(eq(rooms.id, roomId));
        changedRooms.push(roomId);
      }
    }

    // Push relabeled playlists to open panels and arm the advance timer for any
    // room whose current source just learned its length.
    for (const roomId of changedRooms) {
      await broadcastRoomState(io, db, roomId);
      await reconcileTheaterTimer(io, db, roomId);
    }
    if (itemsRenamed > 0 || itemsTimed > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[theater] backfilled ${itemsRenamed} title${itemsRenamed === 1 ? "" : "s"} + ${itemsTimed} length${itemsTimed === 1 ? "" : "s"} across ${changedRooms.length} room${changedRooms.length === 1 ? "" : "s"}.`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[theater] metadata backfill failed:", err instanceof Error ? err.message : err);
  }
}
