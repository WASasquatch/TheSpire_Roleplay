import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { TheaterLoop, TheaterSource, TheaterSourceKind } from "@thekeep/shared";
import { rooms } from "../../db/schema.js";
import { callerCanEditRoom } from "../../auth/roomPermissions.js";
import { hasPermission } from "../../auth/permissions.js";
import { applyControl, clearTheater, getTheater, parsePlaylist, serializePlaylist, setTheater } from "../../realtime/theaterState.js";
import { expandPlaylist, fetchVideoTitle, parseYoutubeIds, youtubeConfigured } from "../../lib/youtube.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/** Classify a media URL so the client picks the right player backend. */
function sniffKind(url: string): TheaterSourceKind {
  const u = url.toLowerCase();
  if (/(?:youtube\.com|youtu\.be)/.test(u)) return "youtube";
  if (/vimeo\.com/.test(u)) return "vimeo";
  if (/\.(?:mp4|webm|ogg|ogv|mov|m4v|m3u8)(?:[?#]|$)/.test(u)) return "video";
  return "embed";
}

/**
 * Drop the playlist-related query params (`list`, `index`, …) from a YouTube
 * WATCH/video URL, keeping the actual video. The client's player (ReactPlayer)
 * rejects a `watch?v=<id>&list=<playlist>` URL as an "Invalid video id", so any
 * single video we queue must carry only its own id. Non-YouTube URLs and pure
 * playlist URLs (no video to keep) pass through untouched.
 */
function stripYoutubeListParams(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const isYt = host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com" || host === "youtu.be";
    if (!isYt) return url;
    // Only strip when a concrete video remains (a watch `v`, youtu.be/<id>, or
    // a /live//shorts//embed/ path). A bare playlist URL has nothing to fall
    // back to, so leave it as-is.
    const hasVideo = u.searchParams.has("v")
      || host === "youtu.be"
      || /^\/(?:live|shorts|embed)\/[\w-]+/.test(u.pathname);
    if (!hasVideo) return url;
    let changed = false;
    for (const p of ["list", "index", "start_radio", "pp"]) {
      if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

/** Human label for a source kind, in the recipient's language. The keys
 *  mirror the old KIND_LABEL map (en values byte-identical). */
function kindLabel(locale: string | null, kind: TheaterSourceKind): string {
  return tFor(locale, `commands:theater.kind.${kind}`);
}

/**
 * /theater - configure a room's synchronized watch-party panel.
 *
 *   /theater on | off              toggle the video panel above chat
 *   /theater add <url> [title]     append a source to the playlist
 *   /theater live <url> [title]    append a LIVE stream (no rewind; live edge)
 *   /theater remove <n>            drop playlist item #n (1-based)
 *   /theater clear                 empty the playlist
 *   /theater loop off | one | all  end-of-source behavior (all = default)
 *   /theater list | (no args)      show the current playlist + settings
 *
 * Owner/mod/admin only to change (same gate as /topic, /replymode). Each
 * mutation persists to the room and rebroadcasts room state so every
 * client's panel updates live; live playback rides `theater:sync`.
 */
export const theaterCommand: CommandHandler = {
  name: "theater",
  // NB: "watch" is taken by the friends follow command; avoid it.
  aliases: ["cinema", "theatre", "movie"],
  usage: "/theater on|off | add <url> [title] | live <url> [title] | remove <n> | clear | loop off|one|all | list",
  description: "Set up a synchronized video watch-party panel for this room (owner/mod only to change).",
  subcommands: [
    { verb: "(no args)", usage: "/theater", description: "Show the current playlist and theater settings." },
    { verb: "on", usage: "/theater on", description: "Turn theater mode on - shows the video panel above chat. Requires theater access (an admin grants it)." },
    { verb: "off", usage: "/theater off", description: "Turn theater mode off and reset playback." },
    { verb: "add", usage: "/theater add <url> [title]", description: "Append a video to the playlist (direct file/HLS, YouTube, or Vimeo)." },
    { verb: "live", usage: "/theater live <https-stream-url>", description: "Append a live stream (e.g. your VLC/OBS broadcast over https). No rewind; everyone watches the live edge. See the Theater streaming guide in Help.", aliases: ["stream"] },
    { verb: "remove", usage: "/theater remove 2", description: "Remove playlist item #2 (1-based).", aliases: ["rm", "del"] },
    { verb: "clear", usage: "/theater clear", description: "Empty the playlist." },
    { verb: "loop", usage: "/theater loop all", description: "End-of-source behavior: off (stop) | one (repeat) | all (advance + loop, default).", aliases: ["repeat"] },
    { verb: "list", usage: "/theater list", description: "Show the current playlist and theater settings." },
  ],
  async run(ctx) {
    const room = (await ctx.db.select().from(rooms).where(eq(rooms.id, ctx.roomId)).limit(1))[0];
    if (!room) return notice(ctx, "NO_ROOM", tFor(ctx.user.locale, "commands:shared.roomNotFound"));

    const verb = (ctx.args[0] ?? "").toLowerCase();
    // Raw text after the verb (preserves spaces/case for URLs + titles).
    const rest = ctx.argsText.replace(/^\s*\S+\s*/, "").trim();
    const playlist = parsePlaylist(room.theaterPlaylist);

    // ---- read-only: show current config (no permission needed) ----------
    if (!verb || verb === "list" || verb === "ls") {
      const head = room.theaterMode
        ? tFor(ctx.user.locale, "commands:theater.statusOn", { loop: room.theaterLoop })
        : tFor(ctx.user.locale, "commands:theater.statusOff");
      if (playlist.length === 0) return notice(ctx, "THEATER", `${head} ${tFor(ctx.user.locale, "commands:theater.playlistEmpty")}`);
      const lines = playlist
        .map((s, i) => `${i + 1}. ${s.title ? `${s.title} - ` : ""}${s.url} [${kindLabel(ctx.user.locale, s.kind)}]`)
        .join("\n");
      return notice(ctx, "THEATER", `${head}\n${lines}`);
    }

    // ---- everything below mutates: gate to owner/mod/admin ---------------
    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      return notice(ctx, "PERM", tFor(ctx.user.locale, "commands:theater.permChange"));
    }

    const { addMessage, broadcastRoomState, broadcastTheaterSync, persistTheaterCheckpoint } = await import(
      "../../realtime/broadcast.js"
    );

    // Shared append used by both `add` (kind sniffed from the URL) and
    // `live` (kind forced to "live"). Parses `<url> [title]` from `rest`,
    // validates, appends, and confirms PRIVATELY to the operator (queuing
    // shouldn't spam the room); the playlist itself still syncs to
    // everyone via broadcastRoomState.
    const appendSource = async (kindOverride?: TheaterSourceKind) => {
      const m = rest.match(/^(\S+)\s*(.*)$/);
      const url = m?.[1] ?? "";
      const title = (m?.[2] ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return notice(ctx, "BAD_URL", tFor(ctx.user.locale, "commands:theater.badUrl"));
      }
      if (kindOverride === "live" && !/^https:\/\//i.test(url)) {
        return notice(ctx, "BAD_URL", tFor(ctx.user.locale, "commands:theater.badLiveUrl"));
      }
      if (playlist.length >= 50) {
        return notice(ctx, "PLAYLIST_FULL", tFor(ctx.user.locale, "commands:theater.playlistFull"));
      }

      // ---- YouTube enrichment (only when a Data API key is configured) -----
      // A `/theater add` of a YouTube link can carry a playlist id (?list=…)
      // or benefit from an auto-fetched title. `/theater live` is a single
      // broadcast, so skip enrichment for it. When the key is unset, or the
      // API returns nothing, we fall through to the plain single-URL append
      // below — identical to the pre-YouTube behavior.
      if (youtubeConfigured && kindOverride !== "live") {
        const { playlistId, videoId } = parseYoutubeIds(url);

        // A real playlist id → expand it into queued sources. A watch URL
        // carrying both `v` and `list` still expands the playlist.
        if (playlistId) {
          const { items, error } = await expandPlaylist(playlistId);
          if (items.length > 0) {
            const remaining = 50 - playlist.length; // >0 (guarded above)
            const queued = items.slice(0, remaining);
            const skipped = items.length - queued.length;
            const additions: TheaterSource[] = queued.map((it) => ({
              id: nanoid(),
              url: it.url,
              kind: "youtube",
              ...(it.title ? { title: it.title } : {}),
            }));
            const wasEmpty = playlist.length === 0;
            const next = [...playlist, ...additions];
            await ctx.db.update(rooms).set({ theaterPlaylist: serializePlaylist(next) }).where(eq(rooms.id, ctx.roomId));
            notice(
              ctx,
              "THEATER",
              skipped > 0
                ? tFor(ctx.user.locale, "commands:theater.queuedSkipped", { count: queued.length, skipped })
                : tFor(ctx.user.locale, "commands:theater.queued", { count: queued.length }),
            );
            await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
            if (wasEmpty) {
              applyControl(ctx.roomId, "play", { len: next.length, loop: room.theaterLoop, now: Date.now() });
              await broadcastTheaterSync(ctx.io, ctx.roomId);
              await persistTheaterCheckpoint(ctx.db, ctx.roomId);
            }
            return;
          }
          // Expansion came back empty: a private/unavailable playlist, or the
          // Data API rejected the call (commonly an HTTP-referrer-restricted
          // key, or the YouTube Data API v3 not enabled — the [youtube] server
          // log shows which). Don't no-op silently: tell the operator, and if
          // the link also carried a single video, queue that (appendSingle
          // strips the &list= so it actually plays) instead of a dead link.
          // Surface the SPECIFIC reason from the API payload (also logged
          // server-side + echoed to the browser console) rather than a vague
          // guess: a 403 "(forbidden): Requests from referer <empty> are
          // blocked" = an HTTP-referrer-restricted key; "quotaExceeded" = the
          // daily cap; no error at all = a private/empty playlist.
          const detail = error
            ? `YouTube API ${error.httpStatus}${error.apiStatus ? ` ${error.apiStatus}` : ""}${error.reason ? ` (${error.reason})` : ""}${error.message ? `: ${error.message}` : ""}`
            : tFor(ctx.user.locale, "commands:theater.playlistPrivateOrEmpty");
          if (videoId) {
            notice(ctx, "THEATER", tFor(ctx.user.locale, "commands:theater.expandFailedQueuedSingle", { detail }));
            return appendSingle(url, title, kindOverride);
          }
          return notice(ctx, "THEATER", tFor(ctx.user.locale, "commands:theater.expandFailed", { detail }));
        } else if (videoId && sniffKind(url) === "youtube" && !title) {
          // Plain YouTube video with no operator-supplied title → try to
          // fetch the real title so the playlist reads nicely. null → append
          // titleless, exactly as before.
          const fetched = await fetchVideoTitle(videoId);
          return appendSingle(url, fetched ?? "", kindOverride);
        }
      }

      return appendSingle(url, title, kindOverride);
    };

    // Append exactly one source (the classic path): sniff kind, resolve the
    // live flag, persist, confirm, broadcast, and auto-start an empty room.
    const appendSingle = async (rawUrl: string, title: string, kindOverride?: TheaterSourceKind) => {
      // Queue a clean video URL. A YouTube watch link can arrive with a
      // `&list=` (e.g. the playlist-expansion fallback above, or a mix/radio
      // link), which makes the client player reject it as an "Invalid video
      // id". Non-YouTube URLs pass through unchanged.
      const url = stripYoutubeListParams(rawUrl);
      // `/theater live` declares a live broadcast. A YouTube/Vimeo live still
      // plays through its iframe API (NOT hls.js), so keep the sniffed kind and
      // mark it live via the `live` flag; only a raw stream gets kind:"live"
      // (the HLS backend). This is why a YouTube live added with `/theater add`
      // (no flag) misbehaves — it runs the VOD position-sync path.
      let kind: TheaterSourceKind = kindOverride ?? sniffKind(url);
      let live = false;
      if (kindOverride === "live") {
        const sniffed = sniffKind(url);
        if (sniffed === "youtube" || sniffed === "vimeo") {
          kind = sniffed;
          live = true;
        } else {
          kind = "live";
        }
      } else if (kind === "youtube" && /youtube\.com\/live\//i.test(url)) {
        // Auto-detect: `youtube.com/live/<id>` is YouTube's canonical
        // live-broadcast URL, so flag it live even on a plain `/theater add`.
        // Without the flag the client treats it as a VOD and runs the
        // position-sync loop, which yanks a live stream around the timeline
        // (the "live keeps jumping" report). A live opened via a plain
        // `watch?v=` URL can't be detected from the URL alone — that one
        // still needs `/theater live`.
        live = true;
      }
      const source: TheaterSource = { id: nanoid(), url, kind, ...(title ? { title } : {}), ...(live ? { live: true } : {}) };
      const next = [...playlist, source];
      await ctx.db.update(rooms).set({ theaterPlaylist: serializePlaylist(next) }).where(eq(rooms.id, ctx.roomId));
      const kindText = source.live
        ? tFor(ctx.user.locale, "commands:theater.kindLive", { kind: kindLabel(ctx.user.locale, source.kind) })
        : kindLabel(ctx.user.locale, source.kind);
      notice(ctx, "THEATER", tFor(ctx.user.locale, "commands:theater.added", {
        position: next.length,
        kind: kindText,
        source: title || url,
      }));
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      // First source of an empty playlist: AUTO-START playback (not just snap
      // viewers onto a paused source). The live state otherwise begins
      // isPlaying:false and only an owner/mod can press play, so a host who
      // queues a playlist and leaves — or any room joined while no mod is
      // present — would sit idle with non-mods unable to start it. Starting it
      // here means the room is genuinely playing for everyone who joins later.
      if (playlist.length === 0) {
        applyControl(ctx.roomId, "play", { len: next.length, loop: room.theaterLoop, now: Date.now() });
        await broadcastTheaterSync(ctx.io, ctx.roomId);
        await persistTheaterCheckpoint(ctx.db, ctx.roomId);
      }
    };

    if (verb === "on") {
      // Enabling theater is gated behind a granular permission ON TOP of
      // the owner/mod check above. Managing the playlist / playback once
      // it's on is NOT gated by this key (see /theater add, loop, etc.).
      // Admins can hand `use_theater_mode` to the `trusted` role or to an
      // individual via the Roles & Permissions matrix.
      if (!(await hasPermission(ctx.user, "use_theater_mode", ctx.db))) {
        return notice(
          ctx,
          "PERM",
          tFor(ctx.user.locale, "commands:theater.permStart"),
        );
      }
      if (room.theaterMode) return notice(ctx, "THEATER", tFor(ctx.user.locale, "commands:theater.alreadyOn"));
      await ctx.db.update(rooms).set({ theaterMode: true }).where(eq(rooms.id, ctx.roomId));
      await addMessage(ctx, { kind: "system", body: "Theater mode on - a synchronized video panel now sits above the chat." });
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      return;
    }

    if (verb === "off") {
      if (!room.theaterMode) return notice(ctx, "THEATER", tFor(ctx.user.locale, "commands:theater.alreadyOff"));
      await ctx.db.update(rooms).set({ theaterMode: false }).where(eq(rooms.id, ctx.roomId));
      clearTheater(ctx.roomId);
      await persistTheaterCheckpoint(ctx.db, ctx.roomId); // clears the persisted checkpoint
      await addMessage(ctx, { kind: "system", body: "Theater mode off." });
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      return;
    }

    if (verb === "loop" || verb === "repeat") {
      const mode = rest.toLowerCase() as TheaterLoop;
      if (mode !== "off" && mode !== "one" && mode !== "all") {
        return notice(ctx, "BAD_LOOP", tFor(ctx.user.locale, "commands:theater.badLoop"));
      }
      if (room.theaterLoop === mode) return notice(ctx, "THEATER", tFor(ctx.user.locale, "commands:theater.loopAlready", { mode }));
      await ctx.db.update(rooms).set({ theaterLoop: mode }).where(eq(rooms.id, ctx.roomId));
      await addMessage(ctx, {
        kind: "system",
        body:
          mode === "off"
            ? "Theater loop off - playback stops at the end of the last video."
            : mode === "one"
              ? "Theater loop set to one - the current video repeats."
              : "Theater loop set to all - the playlist advances and loops continuously.",
      });
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      return;
    }

    if (verb === "add") {
      await appendSource();
      return;
    }

    if (verb === "live" || verb === "stream") {
      await appendSource("live");
      return;
    }

    if (verb === "remove" || verb === "rm" || verb === "del") {
      const n = parseInt(rest, 10);
      if (!Number.isFinite(n) || n < 1 || n > playlist.length) {
        return notice(ctx, "BAD_INDEX", tFor(ctx.user.locale, "commands:theater.badIndex", { max: playlist.length }));
      }
      const removedIdx = n - 1;
      const removed = playlist[removedIdx];
      const next = playlist.filter((_, i) => i !== removedIdx);
      await ctx.db.update(rooms).set({ theaterPlaylist: serializePlaylist(next) }).where(eq(rooms.id, ctx.roomId));
      // Reconcile live playback so removing a queued item doesn't jump the
      // currently-playing one: shift the live index down when an EARLIER
      // item was removed; reset if the playlist emptied or the index fell
      // out of range.
      const st = getTheater(ctx.roomId);
      if (st) {
        if (next.length === 0) {
          clearTheater(ctx.roomId);
        } else {
          let idx = st.index;
          if (removedIdx < idx) idx -= 1;
          if (idx > next.length - 1) idx = next.length - 1;
          const reset = idx !== st.index || removedIdx === st.index;
          setTheater(ctx.roomId, {
            ...st,
            index: idx,
            ...(removedIdx === st.index ? { positionSec: 0, updatedAtMs: Date.now(), lastIndexChangeAt: Date.now() } : {}),
          });
          if (reset) await broadcastTheaterSync(ctx.io, ctx.roomId);
        }
        // Persist the reconciled (or cleared) checkpoint so a restart
        // doesn't restore a stale index pointing past the edited playlist.
        await persistTheaterCheckpoint(ctx.db, ctx.roomId);
      }
      notice(ctx, "THEATER", tFor(ctx.user.locale, "commands:theater.removed", { source: removed?.title || removed?.url }));
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      return;
    }

    if (verb === "clear") {
      if (playlist.length === 0) return notice(ctx, "THEATER", tFor(ctx.user.locale, "commands:theater.alreadyEmpty"));
      await ctx.db.update(rooms).set({ theaterPlaylist: "[]" }).where(eq(rooms.id, ctx.roomId));
      clearTheater(ctx.roomId);
      await persistTheaterCheckpoint(ctx.db, ctx.roomId); // clears the persisted checkpoint
      notice(ctx, "THEATER", tFor(ctx.user.locale, "commands:theater.cleared"));
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      return;
    }

    return notice(ctx, "USAGE", tFor(ctx.user.locale, "commands:theater.usage"));
  },
};
