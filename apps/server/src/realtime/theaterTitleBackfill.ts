/**
 * Retroactive backfill of YouTube titles onto legacy /theater playlist items.
 *
 * Auto-titling only ever ran for NEW `/theater add`s (theater.ts fetches a
 * plain video's title on add). Items queued before that feature — or while the
 * Data API was unconfigured / rate-limited / erroring — kept a bare watch URL
 * and no title, so the playlist reads as a wall of indistinguishable URLs. This
 * sweeps every room's persisted playlist once at boot and fills in the missing
 * titles from the API, then rebroadcasts room state so any open theater panel
 * relabels live.
 *
 * Gated on `youtubeConfigured`. Idempotent: only YouTube items with a
 * resolvable video id AND no real title (missing, blank, or the "title" is just
 * a URL) are looked up, so a run after everything is titled is a cheap DB scan
 * with zero API calls. Batched (50 ids per unit of quota) and best-effort — a
 * failed lookup just leaves those items for the next boot. Runs in the
 * background; never throws into the boot sequence.
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents, TheaterSource } from "@thekeep/shared";

import type { Db } from "../db/index.js";
import { rooms } from "../db/schema.js";
import { fetchVideoTitles, parseYoutubeIds, youtubeConfigured } from "../lib/youtube.js";
import { broadcastRoomState } from "./broadcast.js";
import { parsePlaylist, serializePlaylist } from "./theaterState.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** A YouTube item "needs a title" when its label is missing, blank, or itself a URL. */
export function needsTitle(s: TheaterSource): boolean {
  if (s.kind !== "youtube") return false;
  const t = (s.title ?? "").trim();
  return t === "" || t === s.url || /^https?:\/\//i.test(t);
}

/** The distinct resolvable YouTube video ids in a playlist that still need a title. */
export function videoIdsNeedingTitle(list: TheaterSource[]): string[] {
  const ids = new Set<string>();
  for (const s of list) {
    if (!needsTitle(s)) continue;
    const { videoId } = parseYoutubeIds(s.url);
    if (videoId) ids.add(videoId);
  }
  return [...ids];
}

/**
 * Apply resolved `videoId -> title` labels onto the items that need them,
 * mutating `list` in place. Returns how many items were renamed (0 = no
 * change). Only touches items still failing {@link needsTitle}, so it can't
 * clobber an operator-supplied title.
 */
export function applyTitles(list: TheaterSource[], titles: Map<string, string>): number {
  let renamed = 0;
  for (const s of list) {
    if (!needsTitle(s)) continue;
    const { videoId } = parseYoutubeIds(s.url);
    const title = videoId ? titles.get(videoId) : undefined;
    if (title) {
      s.title = title;
      renamed++;
    }
  }
  return renamed;
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
    // need a title, keeping the parsed list so we can write titles back later.
    const parsedByRoom = new Map<string, TheaterSource[]>();
    const idsToFetch = new Set<string>();
    for (const row of rows) {
      const list = parsePlaylist(row.theaterPlaylist);
      const ids = videoIdsNeedingTitle(list);
      if (ids.length === 0) continue;
      parsedByRoom.set(row.id, list);
      for (const id of ids) idsToFetch.add(id);
    }
    if (idsToFetch.size === 0) return;

    const titles = await fetchVideoTitles([...idsToFetch]);
    if (titles.size === 0) return; // API down / quota / all unavailable — retry next boot.

    // Second pass: apply resolved titles and persist only the rooms that changed.
    let itemsRenamed = 0;
    const changedRooms: string[] = [];
    for (const [roomId, list] of parsedByRoom) {
      const renamed = applyTitles(list, titles);
      if (renamed > 0) {
        itemsRenamed += renamed;
        await db
          .update(rooms)
          .set({ theaterPlaylist: serializePlaylist(list) })
          .where(eq(rooms.id, roomId));
        changedRooms.push(roomId);
      }
    }

    // Push the relabeled playlists to any open theater panels.
    for (const roomId of changedRooms) {
      await broadcastRoomState(io, db, roomId);
    }
    if (itemsRenamed > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[theater] backfilled ${itemsRenamed} YouTube title${itemsRenamed === 1 ? "" : "s"} across ${changedRooms.length} room${changedRooms.length === 1 ? "" : "s"}.`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[theater] title backfill failed:", err instanceof Error ? err.message : err);
  }
}
