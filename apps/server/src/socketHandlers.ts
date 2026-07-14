// Socket.IO per-connection event handlers. Extracted verbatim from index.ts's
// main() so the entrypoint stays a thin orchestrator. The whole
// io.on("connection", …) body — including its nested helpers
// (validateRoomForUser, checkAndExtendSession, gatePollAccess,
// broadcastPollUpdate) and every socket.on(…) handler — moves here unchanged;
// the previously closed-over dependencies (db, registry, log) are now passed in
// explicitly. Behavior and ordering are identical.
import argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { Logger } from "pino";
import {
  DEFAULT_PRESENCE_TEMPLATES,
  isAdminRole,
  renderPresenceTemplate,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@thekeep/shared";
import type { Db } from "./db/index.js";
import {
  bans,
  characters,
  messages,
  roomMembers,
  roomThreadCategories,
  rooms,
  sessions,
  userEarning,
  userNpcs,
  userServerLastRoom,
  users,
} from "./db/schema.js";
import { DEFAULT_SERVER_ID, resolveRoomServerId } from "./earning/pool.js";
import { hasPermission } from "./auth/permissions.js";
import { emailContentBlocked } from "./auth/emailGate.js";
import type { CommandRegistry } from "./commands/registry.js";
import { dispatchChatInput } from "./realtime/dispatch.js";
import {
  addSystemMessage,
  broadcastPresence,
  broadcastTheaterSync,
  persistTheaterCheckpoint,
  emitTreeChanged,
  expireIfEmpty,
  exitIncognitoOnCharSwitch,
  findCanonicalLanding,
  findLiveliestLanding,
  findServerLanding,
  isHiddenIncognitoIdentity,
  joinRoom,
  registerIdleGhost,
  sendRoomBacklogTo,
  sendRoomStateTo,
  userHasSocketInRoom,
  userIdentityHasSocketInRoom,
  userIsOnline,
} from "./realtime/broadcast.js";
import { clearAllAwayForUser } from "./realtime/awayState.js";
import { consumeInvitedLanding } from "./servers/inviteLinks.js";
import { applyControl, parsePlaylist } from "./realtime/theaterState.js";
import { anyConnectedRoomController, callerCanEditRoom } from "./auth/roomPermissions.js";
import { effectiveRoomNsfw } from "./lib/nsfwRooms.js";
import { isInfoRoom } from "./lib/postMode.js";
import { effectiveBoardNsfw } from "./forums/nsfw.js";
import { clearAllMoodForUser } from "./realtime/moodState.js";
import { clearTyperEverywhere, clearTyperFromRoom, markTyping } from "./realtime/typing.js";
import { lookupProfile } from "./commands/builtins/profile.js";
import { emitMutualSettled, respondToPrompt } from "./titles/service.js";
import { extendSession, loadSessionUser, resolveDisplayName } from "./auth/session.js";
import { recordSocketIp, extractSocketIp } from "./auth/ipLog.js";
import { slugToUsername } from "./routes/auth.js";
import { getServerSettings, getSettings, areServersEnabled } from "./settings.js";
import { tFor } from "./i18n.js";

/**
 * Wire every per-connection socket handler onto `io`. Called once at boot,
 * after the handshake middleware is installed.
 */
export function wireSocketHandlers(
  io: IoServer<ClientToServerEvents, ServerToClientEvents>,
  deps: { db: Db; registry: CommandRegistry; log: Logger },
): void {
  const { db, registry, log } = deps;
  io.on("connection", async (socket) => {
    const user = (socket.data as { user: import("./commands/types.js").SessionUser }).user;

    // Event-time IP capture. A socket's IP is fixed for the life of its TCP
    // connection, so recording it here covers every chat send / room switch on
    // this connection; a network change forces a reconnect, which re-captures
    // the new address. Cached on socket.data so per-event hooks below can keep
    // `last_seen_at` fresh without re-parsing the handshake. socket.io bypasses
    // Fastify's trustProxy, so extractSocketIp reproduces it from the headers.
    const clientIp = extractSocketIp(socket.handshake);
    (socket.data as { clientIp?: string | null }).clientIp = clientIp;
    {
      const ua = socket.handshake.headers["user-agent"];
      recordSocketIp(db, user.id, clientIp, Array.isArray(ua) ? ua[0] : ua, "connect");
    }

    // Auto-join the canonical landing room on connect for instant chat.
    // Prefers "The_Spire" by name (the seeded default); falls back to any
    // system room so installs with custom landings or pre-migration MainHall
    // still work.
    //
    // Multi-tab sync: if this user already has another live socket parked
    // in some room, the new tab should follow that room instead of the
    // landing default, otherwise opening a second tab silently drops you
    // into The_Spire while your other tab is still in (say) Tavern. Pick
    // any sibling that's currently in a room: ties are unlikely (a single
    // user usually has one focused room) and harmless (siblings are by
    // definition all in the same room post-sync).
    // Resolve a candidate room id to a join-able one, or null when it's
    // gone / private-and-not-a-member / banned / archived. Shared between
    // the per-tab cache (handshake `tabRoomId`) and the account-global
    // `users.lastRoomId` fallback so both go through the same gating.
    // `resurrect`: when this candidate is the user's OWN remembered room
    // (tab cache / lastRoomId) and it merely ARCHIVED (it emptied out while
    // they were away — e.g. last occupant dropped overnight), un-archive it
    // and place them back instead of degrading to the landing lobby. Only
    // the user's own-room tiers pass resurrect; the sibling-follow tier
    // doesn't (that room is live and a DIFFERENT location). A truly deleted
    // room (no row), a forum board, a banned room, or a private room the
    // user isn't a member of can't be resurrected and still degrade.
    async function validateRoomForUser(
      candidateId: string | null,
      opts?: { resurrect?: boolean },
    ): Promise<string | null> {
      if (!candidateId) return null;
      const room = (await db.select().from(rooms).where(eq(rooms.id, candidateId)).limit(1))[0];
      if (!room) return null;
      // Archived rooms are normally not joinable; only the resurrect path
      // (the user returning to their own last room) may bring one back.
      if (room.archivedAt && !opts?.resurrect) return null;
      // Forum boards aren't chat rooms (they live in the Forums Catalog).
      // A remembered board id — a tab cache or lastRoomId from before the
      // forums moved out of chat, or a tab that was watching a board —
      // silently degrades to the next placement tier here. Without this,
      // the boot join hit joinRoom's FORUM_BOARD refusal and greeted the
      // user with an error notice right after login/registration.
      if (room.forumId) return null;
      // Age gate (age plan, Phase 2): a remembered room that is now 18+
      // (the room flipped, or its server did, or the account's DOB was
      // corrected) silently degrades to the next tier for a minor —
      // greeting a fresh login with an AGE_RESTRICTED error would strand
      // them roomless.
      if (!user.isAdult && (await effectiveRoomNsfw(db, room))) return null;
      const ban = (await db
        .select()
        .from(bans)
        .where(and(eq(bans.roomId, room.id), eq(bans.userId, user.id)))
        .limit(1))[0];
      if (ban && (!ban.until || +ban.until > Date.now())) return null;
      const joinable = room.type === "public"
        || !!(await db
          .select({ x: roomMembers.userId })
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, user.id)))
          .limit(1))[0];
      if (!joinable) return null;
      // Passed every gate. If it was archived and we're allowed to
      // resurrect, un-archive it now so the returning occupant lands here
      // and the room reappears in everyone's rail.
      if (room.archivedAt && opts?.resurrect) {
        await db.update(rooms).set({ archivedAt: null }).where(eq(rooms.id, room.id));
        // The room row is in hand, so its serverId is free; emitTreeChanged
        // falls back to the bare global pulse when the servers flag is off.
        emitTreeChanged(io, room.serverId);
      }
      return room.id;
    }

    // Room-placement priority on (re)connect, highest wins:
    //
    //   1. This tab's per-tab cache (`socket.data.tabRoomId` from the
    //      handshake), replayed by the client from sessionStorage on
    //      every reconnect. Survives server restarts, mobile suspend,
    //      and page reloads. Account-isolated: a desktop tab in Tavern
    //      and a phone tab in Library each keep their own value.
    //      MUST run before the sibling-follow check below, otherwise a
    //      mass reconnect (server restart, network blip on a desktop
    //      with several tabs open) collapses every tab onto whichever
    //      one's handshake landed first, because that one had no
    //      siblings yet and the rest followed it. This tab's own
    //      remembered room is always the correct answer when it has
    //      one; sibling-follow is only meaningful for a tab that has
    //      no memory of its own.
    //   2. Sibling tab in this same browser, if there's another live
    //      socket for this user AND this tab had no remembered room,
    //      follow the sibling. Multi-tab UX: opening a brand-new tab
    //      silently lands you next to your existing tab instead of in
    //      the canonical landing.
    //   3. `users.lastRoomId`, account-global slot updated on every
    //      join. Useful for brand-new tabs on a new device that have
    //      no sessionStorage to replay yet AND no live siblings.
    //   4. The canonical landing (The_Spire / system-flagged default).
    //
    // Each candidate runs through validateRoomForUser so a stale id
    // (deleted room, since-archived, newly banned) silently degrades to
    // the next tier instead of dead-ending the connect.
    // Multi-server placement context (plan §7.4/§7.7). Resolved once so the
    // new per-server tiers below can share it. When the feature is OFF this
    // is a single cached boolean read and `targetServerId` stays null, so
    // every new branch keyed on `serversEnabled` is skipped and the
    // placement walk is byte-identical to today.
    const serversEnabled = areServersEnabled(await getSettings(db));
    const tabServerId = (socket.data as { tabServerId?: string }).tabServerId ?? null;
    const targetServerId = serversEnabled ? tabServerId : null;

    let initialRoomId: string | null = null;
    const tabRoomId = (socket.data as { tabRoomId?: string }).tabRoomId ?? null;
    initialRoomId = await validateRoomForUser(tabRoomId, { resurrect: true });
    if (!initialRoomId) {
      const existingSockets = await io.fetchSockets();
      for (const s of existingSockets) {
        if (s.id === socket.id) continue;
        if ((s.data as { userId?: string }).userId !== user.id) continue;
        const sib = [...s.rooms].find((r) => r.startsWith("room:"));
        if (sib) {
          initialRoomId = sib.slice(5);
          break;
        }
      }
    }
    // Per-(user, server) last-room memory. Placed AHEAD of the account-
    // global users.lastRoomId fallback so, when the user is returning to a
    // specific server, we restore the room they last held IN THAT SERVER
    // rather than whatever account-global slot another server's tab last
    // wrote. Gated on serversEnabled + a known target server, so it never
    // runs (and never reorders the walk) on the flag-off path.
    if (!initialRoomId && serversEnabled && targetServerId) {
      const last = (await db
        .select({ roomId: userServerLastRoom.roomId })
        .from(userServerLastRoom)
        .where(and(
          eq(userServerLastRoom.userId, user.id),
          eq(userServerLastRoom.serverId, targetServerId),
        ))
        .limit(1))[0];
      initialRoomId = await validateRoomForUser(last?.roomId ?? null, { resurrect: true });
    }
    // Hoisted above tier 3 so the first-ever-landing tier below can reuse the
    // same row read to detect a brand-new account.
    const userRow = !initialRoomId
      ? (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0]
      : undefined;
    if (!initialRoomId) {
      initialRoomId = await validateRoomForUser(userRow?.lastRoomId ?? null, { resurrect: true });
    }
    // INVITED signup landing (migration 0356): an account registered through
    // a server invite link (/i/<code>) lands FIRST in the invited server's
    // landing room — deliberately ahead of the liveliest-room tier below, so
    // the invite's promise wins over the default server's busiest room. One-
    // shot: consumeInvitedLanding clears users.invited_server_id whatever
    // happens, and re-checks the join gates (moderation / age / ban) so a
    // server that changed since signup degrades to the normal walk. The
    // greeter (greetNewcomerOnce, inside joinRoom) then fires in that room.
    if (!initialRoomId && serversEnabled && userRow?.invitedServerId) {
      const invited = await consumeInvitedLanding(db, user);
      if (invited) {
        if (invited.healed) emitTreeChanged(io, invited.serverId);
        initialRoomId = await validateRoomForUser(invited.roomId);
      }
    }
    // FIRST-EVER landing (migration 0353): a brand-new account — no
    // account-global last room AND no per-server last-room memory, i.e. it
    // has never landed anywhere — prefers the public default-server room
    // with the most recent human chat over the fixed canonical lobby, so a
    // newcomer's first screen shows a live conversation. Returning users
    // never reach this tier: any prior landing wrote users.lastRoomId (and,
    // flag-on, a user_server_last_room row), and even a stale/deleted
    // remembered room leaves those signals set. The winner still runs
    // through validateRoomForUser so every join gate (age / ban / private)
    // composes; a failure degrades to the canonical landing below.
    if (!initialRoomId && !userRow?.lastRoomId) {
      const everLanded = (await db
        .select({ roomId: userServerLastRoom.roomId })
        .from(userServerLastRoom)
        .where(eq(userServerLastRoom.userId, user.id))
        .limit(1))[0];
      if (!everLanded) {
        const lively = await findLiveliestLanding(db);
        if (lively) initialRoomId = await validateRoomForUser(lively.id);
      }
    }
    if (!initialRoomId) {
      // Flag-off keeps the exact canonical resolver; flag-on with a known
      // target server scopes the landing to that server, falling back to
      // the canonical landing when the server has no joinable system room.
      let landing = serversEnabled && targetServerId
        ? (await findServerLanding(db, targetServerId)) ?? (await findCanonicalLanding(db))
        : await findCanonicalLanding(db);
      // Landing selection skips 18+ rooms for minors (age plan §E, the
      // belt-and-braces behind the landing-room write rejection): a minor
      // aimed at an 18+ server's landing falls back to the canonical one,
      // which is SFW by the system-server invariant.
      if (landing && !user.isAdult && (await effectiveRoomNsfw(db, landing))) {
        const canonical = await findCanonicalLanding(db);
        landing = canonical && !(await effectiveRoomNsfw(db, canonical)) ? canonical : null;
      }
      if (landing) initialRoomId = landing.id;
    }
    if (initialRoomId) await joinRoom(io, db, socket, user, initialRoomId);

    /**
     * Validate the session is still alive AND extend its idle window. Returns
     * true when the caller can proceed; false when the socket has been
     * kicked (the handler should bail early). Called at the top of every
     * user-initiated socket event so a single helper governs both checks.
     */
    async function checkAndExtendSession(): Promise<boolean> {
      const sid = (socket.data as { sid?: string }).sid;
      if (!sid) return true;
      const row = (await db.select().from(sessions).where(eq(sessions.id, sid)).limit(1))[0];
      if (!row || +row.expiresAt < Date.now()) {
        socket.emit("auth:expired");
        socket.disconnect(true);
        return false;
      }
      // Push expiresAt forward - sliding idle expiry. extendSession reads
      // the latest sessionTtlMs from settings each call so admin changes
      // take effect on the next interaction without restart.
      await extendSession(db, sid);
      // Refresh the event-time IP log on real activity (chat send, room
      // switch, etc. all funnel through here). The connection's IP is fixed,
      // so this just bumps `last_seen_at`; the throttle inside recordSocketIp
      // keeps it to one write/min so a chat spammer can't hammer SQLite.
      const ip = (socket.data as { clientIp?: string | null }).clientIp;
      const uid = (socket.data as { userId?: string }).userId;
      recordSocketIp(db, uid, ip, null, "active");
      return true;
    }

    socket.on("chat:input", async (payload, ack) => {
      try {
        if (!(await checkAndExtendSession())) {
          ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpiredLogin") });
          return;
        }
        const fresh = await loadSessionUser(db, user.id);
        if (!fresh) {
          socket.emit("auth:expired");
          ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpired") });
          socket.disconnect(true);
          return;
        }
        Object.assign(user, fresh);
        // Email-verification block gate (defense-in-depth behind the
        // client overlay). Only queried when block mode is actually on,
        // so the common config pays nothing. An unverified account can
        // read chat but can't send until they confirm their email.
        // Staff (admin/masteradmin) are exempt so an unverified admin can
        // never be locked out of the Email settings that turn block mode
        // off. They still see the nudge banner client-side.
        if (await emailContentBlocked(user, db)) {
          ack?.({ ok: false, code: "EMAIL_UNVERIFIED", message: tFor(user.locale, "errors:server.realtime.verifyEmailToChat") });
          return;
        }
        // Identity resolution for this send, in priority order:
        //
        //   1. `payload.asCharacterId`, the client's per-send claim
        //      pulled from its React state. This is the source of
        //      truth: it's what the user's UI says they're voicing
        //      RIGHT NOW. Validated against the user's owned
        //      characters; invalid (deleted / not owned) degrades
        //      silently to (2) so a stale tab doesn't get its send
        //      rejected.
        //   2. `socket.data.tabCharId`, the socket-scoped override
        //      from the handshake / last /char on this socket. The
        //      legacy path, kept as a fallback for older clients that
        //      don't ship `asCharacterId`.
        //   3. `fresh.activeCharacterId`, the DB default, applied
        //      when neither of the above is set.
        //
        // Without (1), a multi-tab race could let the server hand
        // this tab an identity its UI hasn't agreed to: sibling tab
        // /char SwitchToA mutates the shared `users.activeCharacterId`,
        // a reconnect on this tab re-seeds tabCharId from that DB
        // value, and the next send goes out tagged as A even though
        // this tab's UI is still rendering OOC.
        let resolvedCharId: string | null = user.activeCharacterId;
        const claim = payload.asCharacterId;
        if (typeof claim === "string") {
          const c = (await db
            .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
            .from(characters)
            .where(eq(characters.id, claim))
            .limit(1))[0];
          if (c && c.userId === user.id && !c.deletedAt) {
            resolvedCharId = c.id;
          } else {
            // Invalid claim → fall through to tabCharId (legacy path).
            const tabCharId = (socket.data as { tabCharId?: string | null }).tabCharId;
            if (tabCharId !== undefined) resolvedCharId = tabCharId;
          }
        } else if (claim === null) {
          // Explicit OOC claim.
          resolvedCharId = null;
        } else {
          // No claim, legacy path (tabCharId fallback).
          const tabCharId = (socket.data as { tabCharId?: string | null }).tabCharId;
          if (tabCharId !== undefined) resolvedCharId = tabCharId;
        }
        if (resolvedCharId !== user.activeCharacterId) {
          user.activeCharacterId = resolvedCharId;
          user.displayName = await resolveDisplayName(db, user.id, resolvedCharId);
        }
        // Keep the socket's sticky tabCharId in sync with the resolved
        // identity. This way a follow-up event handler that reads
        // socket.data.tabCharId (e.g. a presence broadcast triggered
        // by this send) sees the latest authoritative value, and a
        // reconnect-replay round-trip stays consistent.
        (socket.data as { tabCharId?: string | null }).tabCharId = resolvedCharId;
        // Validate the thread-category bucket (if any) belongs to the
        // target room. Race condition: an admin can delete the category
        // between the user opening the picker and submitting. Rather
        // than reject the send, drop to null and let the message land
        // in the "Uncategorized" bucket, discarding the message would
        // be a worse failure mode.
        let threadCategoryId: string | null = null;
        if (payload.threadCategoryId) {
          const cat = (await db
            .select()
            .from(roomThreadCategories)
            .where(and(
              eq(roomThreadCategories.id, payload.threadCategoryId),
              eq(roomThreadCategories.roomId, payload.roomId),
            ))
            .limit(1))[0];
          if (cat) threadCategoryId = cat.id;
        }
        // Forum payload, title (new topic) / replyToId (reply under
        // an existing topic). dispatchChatInput validates the
        // structural constraints (reject "both", reject "neither" in
        // forum rooms); we just pass them through.
        const threadTitle = payload.threadTitle?.trim() || undefined;
        const replyToId = payload.replyToId || undefined;
        await dispatchChatInput({
          io, socket, db, registry, user,
          roomId: payload.roomId,
          text: payload.text,
          // Rich-HTML format claim (migration 0352). Anything other
          // than the literal "html" is treated as the historic
          // markdown pipeline — the value is client-supplied.
          ...(payload.format === "html" ? { format: "html" as const } : {}),
          threadCategoryId,
          ...(threadTitle ? { threadTitle } : {}),
          ...(replyToId ? { replyToId } : {}),
        });
        // Drop this user's typing-indicator entry for the room now
        // that the message landed. Without this, a re-pulse mid-send
        // could leave their "is typing…" hanging in peers' UIs for
        // the entry-ttl window after their actual message displayed.
        clearTyperFromRoom(io, db, { roomId: payload.roomId, userId: user.id });
        ack?.({ ok: true });
      } catch (err) {
        log.error({ err }, "chat:input error");
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    /**
     * Forum posting (Forums revamp, Phase 1C). Boards live ENTIRELY in
     * the Forums Catalog — they aren't joinable chat rooms — so posting
     * can't ride chat:input (dispatch rejects sends to rooms the socket
     * isn't in, and temporarily joining would flash the poster into the
     * board's presence). This handler validates the forum gates itself,
     * mirrors dispatch's topic/reply rules EXACTLY, and persists through
     * the same addMessage pipeline, so identity snapshots, colors,
     * earning awards, mentions/push, and the mute check all behave
     * identically to a chat send. Slash commands are rejected: forums
     * take prose, commands belong to chat.
     */
    socket.on("forum:post", async (payload, ack) => {
      try {
        if (!(await checkAndExtendSession())) {
          ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpiredLogin") });
          return;
        }
        const fresh = await loadSessionUser(db, user.id);
        if (!fresh) {
          socket.emit("auth:expired");
          ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpired") });
          socket.disconnect(true);
          return;
        }
        Object.assign(user, fresh);
        // Email-verification block gate — forum posting is forum access, so
        // a blocked (unverified, non-staff) user can't create/reply here
        // either. Mirrors the authed /forums HTTP guard.
        if (await emailContentBlocked(user, db)) {
          ack?.({ ok: false, code: "EMAIL_UNVERIFIED", message: tFor(user.locale, "errors:server.realtime.verifyEmailForums") });
          return;
        }
        // Per-send identity claim, same resolution order as chat:input
        // (claim → tabCharId → DB default) so the post is voiced by the
        // identity the catalog UI shows.
        let resolvedCharId: string | null = user.activeCharacterId;
        const claim = payload.asCharacterId;
        if (typeof claim === "string") {
          const c = (await db
            .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
            .from(characters)
            .where(eq(characters.id, claim))
            .limit(1))[0];
          if (c && c.userId === user.id && !c.deletedAt) {
            resolvedCharId = c.id;
          } else {
            const tabCharId = (socket.data as { tabCharId?: string | null }).tabCharId;
            if (tabCharId !== undefined) resolvedCharId = tabCharId;
          }
        } else if (claim === null) {
          resolvedCharId = null;
        } else {
          const tabCharId = (socket.data as { tabCharId?: string | null }).tabCharId;
          if (tabCharId !== undefined) resolvedCharId = tabCharId;
        }
        if (resolvedCharId !== user.activeCharacterId) {
          user.activeCharacterId = resolvedCharId;
          user.displayName = await resolveDisplayName(db, user.id, resolvedCharId);
        }

        // The target must be a live forum BOARD; the forum's own gates
        // (ban, members-only posting) decide access.
        const board = (await db.select().from(rooms).where(eq(rooms.id, payload.roomId)).limit(1))[0];
        if (!board || !board.forumId || board.archivedAt || board.replyMode !== "nested") {
          ack?.({ ok: false, code: "NO_BOARD", message: tFor(user.locale, "errors:server.messages.boardMissing") });
          return;
        }
        // HARD age gate (age plan, Phase 3): an 18+ board — by its room
        // flag, its server's, or its whole FORUM's — takes no posts from
        // minors. The read routes already hide these boards from them;
        // this covers a crafted payload or a stale client.
        if (!user.isAdult && (await effectiveBoardNsfw(db, board))) {
          ack?.({ ok: false, code: "AGE_RESTRICTED", message: tFor(user.locale, "errors:server.forums.adultsOnly") });
          return;
        }
        const { forumGateForBoard, forumCan } = await import("./forums/authority.js");
        const gate = await forumGateForBoard(db, user, board.forumId);
        if (!gate.ok) {
          ack?.({ ok: false, code: gate.code, message: gate.message });
          return;
        }

        const text = payload.text.trim();
        // Poll topics carry their content in the options, so an empty intro
        // body is fine; every other post needs prose.
        const isPollTopic = !!payload.poll && !!payload.threadTitle?.trim() && !payload.replyToId;
        if (!text && !isPollTopic) { ack?.({ ok: false, code: "EMPTY", message: tFor(user.locale, "errors:server.realtime.writeSomethingFirst") }); return; }
        if (text.startsWith("/")) {
          ack?.({
            ok: false,
            code: "NO_COMMANDS",
            message: tFor(user.locale, "errors:server.realtime.noCommandsOnForums"),
          });
          return;
        }
        // Per-server forum-post cap: the board's room→server (NULL serverId,
        // legacy board, → DEFAULT_SERVER_ID). A NULL override inherits the
        // platform default, so flag-off is byte-identical to `getSettings`.
        // `maxForumTopicTitleLength` has no per-server override (platform-
        // global), so it stays on `getSettings`.
        const { maxForumPostLength } = await getServerSettings(db, board.serverId ?? DEFAULT_SERVER_ID);
        const { maxForumTopicTitleLength } = await getSettings(db);
        if (text.length > maxForumPostLength) {
          ack?.({ ok: false, code: "TOO_LONG", message: tFor(user.locale, "errors:server.realtime.forumPostTooLong", { max: maxForumPostLength }) });
          return;
        }
        // Usergroup FEATURE gates (re-checked server-side; the client also
        // hides what you can't do). Image embeds are detected from the
        // ![alt](url) markup the composer inserts.
        if (/!\[[^\]]*\]\([^)]+\)/.test(text) && !forumCan(gate.authority, "upload_images")) {
          ack?.({ ok: false, code: "NO_IMAGES", message: tFor(user.locale, "errors:server.realtime.noEmbedImages") });
          return;
        }

        // Category: validated to belong to the board; a racing delete
        // degrades to Uncategorized rather than rejecting (chat parity).
        let threadCategoryId: string | null = null;
        if (payload.threadCategoryId) {
          const cat = (await db.select().from(roomThreadCategories)
            .where(and(
              eq(roomThreadCategories.id, payload.threadCategoryId),
              eq(roomThreadCategories.roomId, board.id),
            )).limit(1))[0];
          if (cat) {
            // A members-only category is members-only for POSTING too, not
            // just reading. The read gate (forumBoardReadGate) hides
            // members-only categories from non-members, so without this an
            // open-posting forum let a non-member create a topic here that
            // they then couldn't see — they posted into a category the read
            // gate withholds from them, while members/owner saw it. That's
            // the "the system isn't showing me my own topics" report. Reject
            // with the same code the read path uses so the poster gets a
            // clear members-only notice instead of an invisible topic.
            if (cat.membersOnly && !gate.authority.isMember) {
              ack?.({
                ok: false,
                code: "FORUM_BOARD_MEMBERS_ONLY",
                message: tFor(user.locale, "errors:server.realtime.categoryMembersOnlyJoin"),
              });
              return;
            }
            threadCategoryId = cat.id;
          }
        }

        const { addMessage } = await import("./realtime/broadcast.js");
        // Synthetic CommandContext: addMessage reads db/io/socket/user/
        // roomId (+ registry for inline-command expansion). The roomId is
        // the BOARD, regardless of which chat room this socket sits in.
        const ctx = {
          db, io, socket, user,
          roomId: board.id,
          argsText: "", args: [], invokedAs: "",
          registry,
        } as Parameters<typeof addMessage>[0];

        const threadTitle = payload.threadTitle?.trim();
        const replyToId = payload.replyToId || undefined;

        // New topic (title XOR reply — dispatch parity).
        if (threadTitle && !replyToId) {
          if (!forumCan(gate.authority, "post_topics")) {
            ack?.({ ok: false, code: "NO_TOPICS", message: tFor(user.locale, "errors:server.realtime.noStartTopics") });
            return;
          }
          // Compose-time NSFW tag (age plan, Phase 3). Not in the frozen
          // shared payload type yet, so it's read via a safe cast — old
          // bundles that never send it are unaffected. Adults only: a
          // minor can neither set nor unset any NSFW flag, whatever their
          // forum role (there is deliberately no bypass).
          const wantsNsfw = (payload as { nsfw?: unknown }).nsfw === true;
          if (wantsNsfw && !user.isAdult) {
            ack?.({ ok: false, code: "AGE_RESTRICTED", message: tFor(user.locale, "errors:server.realtime.nsfwTopicAdultsOnly") });
            return;
          }
          const cappedTitle = threadTitle.slice(0, maxForumTopicTitleLength);
          // Poll topic: the title is the question, options + settings ride
          // pollDataJson, the body is an optional intro. Same model the
          // /poll chat command builds.
          let pollDataJson: string | null = null;
          if (payload.poll) {
            if (!forumCan(gate.authority, "create_polls")) {
              ack?.({ ok: false, code: "NO_POLLS", message: tFor(user.locale, "errors:server.realtime.noCreatePolls") });
              return;
            }
            const { buildPollData } = await import("./polls.js");
            const built = buildPollData({
              optionTexts: payload.poll.optionTexts ?? [],
              allowMultiple: !!payload.poll.allowMultiple,
              showVoters: !!payload.poll.showVoters,
              closesAt: payload.poll.closesAt ?? null,
              question: cappedTitle,
              locale: user.locale,
            });
            if (!built.ok) { ack?.({ ok: false, code: "POLL_INVALID", message: built.error }); return; }
            pollDataJson = built.json;
          }
          const messageId = await addMessage(ctx, {
            kind: pollDataJson ? "poll" : "say",
            body: text,
            title: cappedTitle,
            ...(threadCategoryId ? { threadCategoryId } : {}),
            ...(pollDataJson ? { pollDataJson } : {}),
            ...(wantsNsfw ? { isNsfw: true } : {}),
          });
          if (messageId) {
            // Authors watch their own topics (reply notifications).
            const { ensureTopicWatch } = await import("./forums/notifications.js");
            void ensureTopicWatch(db, user.id, messageId).catch(() => {});
            // Re-check auto-join usergroups (post/topic count etc. just changed).
            const { evaluateAutoGroups } = await import("./forums/usergroups.js");
            void evaluateAutoGroups(db, board.forumId!, user.id).catch(() => {});
          }
          ack?.({ ok: true, messageId });
          return;
        }
        // Reply under an existing topic.
        if (replyToId && !threadTitle) {
          if (!forumCan(gate.authority, "post_replies")) {
            ack?.({ ok: false, code: "NO_REPLIES", message: tFor(user.locale, "errors:server.realtime.noReplyForum") });
            return;
          }
          const parent = (await db.select().from(messages).where(eq(messages.id, replyToId)).limit(1))[0];
          if (!parent || parent.roomId !== board.id || parent.deletedAt) {
            ack?.({ ok: false, code: "BAD_TOPIC", message: tFor(user.locale, "errors:server.realtime.badTopicBoard") });
            return;
          }
          if (parent.replyToId) {
            ack?.({ ok: false, code: "NOT_A_TOPIC", message: tFor(user.locale, "errors:server.realtime.notATopic") });
            return;
          }
          // HARD age gate (age plan, Phase 3): an NSFW-tagged topic takes
          // no replies from minors — its thread already 404s for them, so
          // this only fires from a composer left open across a re-tag.
          if (parent.isNsfw && !user.isAdult) {
            ack?.({ ok: false, code: "AGE_RESTRICTED", message: tFor(user.locale, "errors:server.realtime.topicAdultsOnly") });
            return;
          }
          if (parent.lockedAt && !(await hasPermission(user, "bypass_topic_lock", db))) {
            ack?.({ ok: false, code: "TOPIC_LOCKED", message: tFor(user.locale, "errors:server.realtime.topicLocked") });
            return;
          }
          // Rich-format parents (chat-side topics, migration 0352)
          // snapshot their VISIBLE text, never raw markup.
          const parentText = parent.format === "html" ? (parent.bodyText ?? "") : parent.body;
          const snippet = parentText.length > 120 ? `${parentText.slice(0, 120)}…` : parentText;
          // Streamlined RP format: "action" → emote (kind "me"); "npc" →
          // voice a saved NPC (kind "npc"), gated on the forum's use_npc grant
          // and a npcId the caller owns, snapshotting the NPC's name + stats.
          let fmtKind: "say" | "me" | "npc" = "say";
          let npcFields: { displayNameOverride?: string; npcVoicedBy?: string; npcStatsJson?: string | null } = {};
          if (payload.format === "action") {
            if (!forumCan(gate.authority, "post_actions")) {
              ack?.({ ok: false, code: "NO_ACTIONS", message: tFor(user.locale, "errors:server.realtime.noActionReplies") });
              return;
            }
            fmtKind = "me";
          } else if (payload.format === "npc") {
            if (!forumCan(gate.authority, "use_npc")) {
              ack?.({ ok: false, code: "NPC_FORBIDDEN", message: tFor(user.locale, "errors:server.realtime.noVoiceNpcs") });
              return;
            }
            const npc = payload.npcId
              ? (await db.select().from(userNpcs).where(and(eq(userNpcs.id, payload.npcId), eq(userNpcs.userId, user.id))).limit(1))[0]
              : undefined;
            if (!npc) { ack?.({ ok: false, code: "NPC_NOT_FOUND", message: tFor(user.locale, "errors:server.realtime.pickSavedNpc") }); return; }
            fmtKind = "npc";
            npcFields = { displayNameOverride: npc.name, npcVoicedBy: user.displayName, npcStatsJson: npc.statsJson };
          }
          const messageId = await addMessage(ctx, {
            kind: fmtKind,
            body: text,
            replyToId: parent.id,
            replyToDisplayName: parent.displayName,
            replyToBodySnippet: snippet,
            ...npcFields,
          });
          if (messageId) {
            // Repliers auto-watch the topic; then fan out the inbox rows
            // (quote > reply-to-your-topic > watch) and badge pulses.
            // Fire-and-forget: notification failures never fail the post.
            const { ensureTopicWatch, notifyForumReply } = await import("./forums/notifications.js");
            void ensureTopicWatch(db, user.id, parent.id)
              .then(() => notifyForumReply(db, io, {
                forumId: board.forumId!,
                boardRoomId: board.id,
                topic: { id: parent.id, userId: parent.userId, title: parent.title },
                messageId,
                body: text,
                actor: { id: user.id, displayName: user.displayName },
              }))
              .catch((err) => log.warn({ err }, "forum notify failed"));
            // Re-check auto-join usergroups (post count just changed).
            const { evaluateAutoGroups } = await import("./forums/usergroups.js");
            void evaluateAutoGroups(db, board.forumId!, user.id).catch(() => {});
          }
          ack?.({ ok: true, messageId });
          return;
        }
        ack?.({ ok: false, code: "FORUM_NEEDS_TOPIC", message: tFor(user.locale, "errors:server.realtime.startTopicOrReply") });
      } catch (err) {
        log.error({ err }, "forum:post error");
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    /**
     * Resolve a poll message + its room and confirm THIS user may READ it
     * (and therefore vote/close). Mirrors the forum:post / chat backlog
     * gates: forum boards consult forumAuthority + the members-only read
     * gate; private chat rooms require membership; public rooms are open.
     */
    async function gatePollAccess(messageId: string): Promise<
      | { ok: false; code: string; message: string }
      | { ok: true; msg: typeof messages.$inferSelect; room: typeof rooms.$inferSelect; data: import("@thekeep/shared").PollData }
    > {
      const msg = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0];
      if (!msg || msg.kind !== "poll" || msg.deletedAt) {
        return { ok: false, code: "NO_POLL", message: tFor(user.locale, "errors:server.realtime.pollGone") };
      }
      // HARD age gate (age plan, Phase 3): NSFW-stamped rows — an NSFW-
      // tagged poll topic, or a flipped-back room's 18+-era poll — take no
      // votes or closes from minors. Same "doesn't exist" posture as the
      // read routes so the row's existence never leaks.
      if (msg.isNsfw && !user.isAdult) {
        return { ok: false, code: "NO_POLL", message: tFor(user.locale, "errors:server.realtime.pollGone") };
      }
      const { parsePollData } = await import("./polls.js");
      const data = parsePollData(msg.pollDataJson);
      if (!data) return { ok: false, code: "NO_POLL", message: tFor(user.locale, "errors:server.realtime.pollMalformed") };
      const room = (await db.select().from(rooms).where(eq(rooms.id, msg.roomId)).limit(1))[0];
      if (!room) return { ok: false, code: "NO_ROOM", message: tFor(user.locale, "errors:server.realtime.roomGone") };
      // ...and polls living in an 18+ SPACE (room flag, server's, or the
      // whole forum's) are equally out of a minor's reach, even when the
      // row itself predates the flip and carries no stamp.
      if (!user.isAdult && (await effectiveBoardNsfw(db, room))) {
        return { ok: false, code: "NO_POLL", message: tFor(user.locale, "errors:server.realtime.pollGone") };
      }
      if (room.forumId) {
        const { forumGateForBoard, forumBoardReadGate } = await import("./forums/authority.js");
        const g = await forumGateForBoard(db, user, room.forumId);
        if (!g.ok) return { ok: false, code: g.code, message: g.message };
        const rg = await forumBoardReadGate(db, user, room.id);
        if (rg.boardLocked || (msg.threadCategoryId && rg.lockedCatIds.has(msg.threadCategoryId))) {
          return { ok: false, code: "FORUM_BOARD_MEMBERS_ONLY", message: tFor(user.locale, "errors:server.forums.membersOnlySection") };
        }
      } else if (room.type === "private") {
        const member = (await db.select().from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, user.id))).limit(1))[0];
        if (!member) return { ok: false, code: "NOT_MEMBER", message: tFor(user.locale, "errors:server.realtime.notInRoom") };
      }
      return { ok: true, msg, room, data };
    }

    /** Recompute tallies and fan a poll:update to the room + this socket. */
    async function broadcastPollUpdate(messageId: string, roomId: string, data: import("@thekeep/shared").PollData): Promise<void> {
      const { loadPollTallies } = await import("./polls.js");
      const { tallies, totalVoters } = await loadPollTallies(db, messageId, data);
      const update = { messageId, tallies, totalVoters, closedAt: data.closedAt };
      io.to(`room:${roomId}`).emit("poll:update", update);
      // Forum board viewers aren't joined to the board's room channel, so
      // reach the actor's own socket directly too (covers the voter even on
      // a board where the room broadcast doesn't reach them).
      socket.emit("poll:update", update);
    }

    socket.on("poll:vote", async (payload, ack) => {
      try {
        if (!(await checkAndExtendSession())) {
          ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpiredLogin") });
          return;
        }
        const fresh = await loadSessionUser(db, user.id);
        if (!fresh) { socket.emit("auth:expired"); ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpired") }); socket.disconnect(true); return; }
        Object.assign(user, fresh);

        if (!payload?.messageId || !Array.isArray(payload.optionIds)) {
          ack?.({ ok: false, code: "BAD_INPUT", message: tFor(user.locale, "errors:server.realtime.malformedVote") });
          return;
        }
        const gate = await gatePollAccess(payload.messageId);
        if (!gate.ok) { ack?.({ ok: false, code: gate.code, message: gate.message }); return; }
        const { msg, room, data } = gate;

        if (data.closedAt != null || (data.closesAt != null && Date.now() >= data.closesAt)) {
          ack?.({ ok: false, code: "POLL_CLOSED", message: tFor(user.locale, "errors:server.realtime.pollClosed") });
          return;
        }
        const validIds = new Set(data.options.map((o) => o.id));
        const chosen = [...new Set(payload.optionIds)].filter((id) => validIds.has(id));
        if (!data.allowMultiple && chosen.length > 1) {
          ack?.({ ok: false, code: "SINGLE_ONLY", message: tFor(user.locale, "errors:server.realtime.pollSingleChoice") });
          return;
        }
        const { pollVotes } = await import("./db/schema.js");
        // Replace the voter's prior ballot (single-choice: at most one row;
        // multiple-choice: the prior set) with the new selection. An empty
        // selection retracts the vote.
        await db.delete(pollVotes).where(and(eq(pollVotes.pollMessageId, msg.id), eq(pollVotes.userId, user.id)));
        if (chosen.length) {
          await db.insert(pollVotes).values(chosen.map((optionId) => ({ pollMessageId: msg.id, optionId, userId: user.id })));
        }
        await broadcastPollUpdate(msg.id, room.id, data);
        ack?.({ ok: true });
      } catch (err) {
        log.error({ err }, "poll:vote error");
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    socket.on("poll:close", async (payload, ack) => {
      try {
        if (!(await checkAndExtendSession())) {
          ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpiredLogin") });
          return;
        }
        const fresh = await loadSessionUser(db, user.id);
        if (!fresh) { socket.emit("auth:expired"); ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpired") }); socket.disconnect(true); return; }
        Object.assign(user, fresh);

        if (!payload?.messageId) { ack?.({ ok: false, code: "BAD_INPUT", message: tFor(user.locale, "errors:server.realtime.malformedRequest") }); return; }
        const gate = await gatePollAccess(payload.messageId);
        if (!gate.ok) { ack?.({ ok: false, code: gate.code, message: gate.message }); return; }
        const { msg, room, data } = gate;

        // Who may close: the author, a site admin, the chat room owner, or a
        // forum mod/owner on a board.
        let canClose = msg.userId === user.id || isAdminRole(user.role) || room.ownerId === user.id;
        if (!canClose && room.forumId) {
          const { forumAuthority } = await import("./forums/authority.js");
          const a = await forumAuthority(db, user, room.forumId);
          canClose = a.isMod;
        }
        if (!canClose) { ack?.({ ok: false, code: "FORBIDDEN", message: tFor(user.locale, "errors:server.realtime.pollCloseForbidden") }); return; }

        if (data.closedAt == null) {
          data.closedAt = Date.now();
          await db.update(messages).set({ pollDataJson: JSON.stringify(data) }).where(eq(messages.id, msg.id));
        }
        await broadcastPollUpdate(msg.id, room.id, data);
        ack?.({ ok: true });
      } catch (err) {
        log.error({ err }, "poll:close error");
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    /**
     * Typing pulse, see TypingTracker for the broadcast logic.
     * Authentication piggybacks on the connection's session
     * (`user` captured above); we don't gate on
     * `checkAndExtendSession` here because typing pulses fire many
     * times during normal use and shouldn't pay the session-write
     * cost of a chat send. Sessions still expire on chat:input /
     * presence:active / heartbeat, typing alone never extends them.
     *
     * Cheap rate-limit: drop pulses arriving faster than once every
     * 1.5s for the same room. The client throttles to ~2s already;
     * this guards against a misbehaving / hostile client.
     */
    let lastTypingPulseAt = 0;
    socket.on("chat:typing", async (payload) => {
      const now = Date.now();
      if (now - lastTypingPulseAt < 1_500) return;
      lastTypingPulseAt = now;
      // Reject pulses for rooms this socket isn't subscribed to,
      // typing in a room you can't see has no signal value and
      // would let a stale tab pollute another room's indicator.
      if (!socket.rooms.has(`room:${payload.roomId}`)) return;
      // Resolve the typer's identity from the per-tab claim, same
      // pattern as chat:input. Without this, the indicator pulled
      // identity off the closure-captured `user.displayName`, which
      // a sibling tab's /char-switch could rewrite mid-conversation;
      // a tab actually composing on OOC would still emit pulses
      // labeled with the user's character. The claim is validated
      // against the user's own characters; an invalid or omitted
      // claim falls back to socket.data.tabCharId, then user.activeCharacterId.
      let typingCharId: string | null = user.activeCharacterId;
      const claim = payload.asCharacterId;
      if (typeof claim === "string") {
        const c = (await db
          .select({ id: characters.id, userId: characters.userId, deletedAt: characters.deletedAt })
          .from(characters)
          .where(eq(characters.id, claim))
          .limit(1))[0];
        if (c && c.userId === user.id && !c.deletedAt) {
          typingCharId = c.id;
        } else {
          const tabCharId = (socket.data as { tabCharId?: string | null }).tabCharId;
          if (tabCharId !== undefined) typingCharId = tabCharId;
        }
      } else if (claim === null) {
        typingCharId = null;
      } else {
        const tabCharId = (socket.data as { tabCharId?: string | null }).tabCharId;
        if (tabCharId !== undefined) typingCharId = tabCharId;
      }
      // A hidden mod's identity must not leak through the "…is typing"
      // indicator. Every other presence surface (userlist, join/leave, whisper
      // attribution) hides this exact identity, so the typing pulse must too —
      // gate on the resolved identity with the byte-identical rule those
      // surfaces use. Placed before the name lookup so we skip that too.
      if (isHiddenIncognitoIdentity(user, typingCharId)) return;
      const typingDisplayName = typingCharId === user.activeCharacterId
        ? user.displayName
        : await resolveDisplayName(db, user.id, typingCharId);
      markTyping(io, db, {
        roomId: payload.roomId,
        userId: user.id,
        displayName: typingDisplayName,
        characterId: typingCharId,
      });
    });

    socket.on("room:join", async (payload, ack) => {
      try {
        if (!(await checkAndExtendSession())) {
          ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpiredLogin") });
          return;
        }
        // Brute-force guard. argon2.verify is intentionally slow (~300ms)
        // which already throttles a single attacker, but it also means each
        // failed attempt pins a CPU thread. A per-user sliding window of
        // failed password attempts caps the abuse: 5 fails / 60s lands the
        // user in a 60s cooldown, regardless of which room they target.
        const passwordCooldown = roomPwCooldown(user.id, Date.now());
        if (passwordCooldown > 0) {
          ack?.({
            ok: false,
            code: "RATE_LIMIT",
            message: tFor(user.locale, "errors:server.realtime.tooManyPasswordAttempts", { seconds: Math.ceil(passwordCooldown / 1000) }),
          });
          return;
        }
        const room = (await db.select().from(rooms).where(eq(rooms.id, payload.roomId)).limit(1))[0];
        if (!room) {
          ack?.({ ok: false, code: "NO_ROOM", message: tFor(user.locale, "errors:server.realtime.roomNotFound") });
          return;
        }
        let passwordOk = false;
        if (room.type === "private" && room.passwordHash && payload.password) {
          passwordOk = await argon2.verify(room.passwordHash, payload.password).catch(() => false);
          if (!passwordOk) {
            recordRoomPwFailure(user.id, Date.now());
            ack?.({ ok: false, code: "BAD_PASSWORD", message: tFor(user.locale, "commands:room.badPassword") });
            return;
          }
        }
        await joinRoom(io, db, socket, user, room.id, { passwordOk });

        // Multi-tab independence: each socket is its own occupant. A
        // user with two tabs can be in two different rooms, three tabs
        // in three rooms, etc. Previously this handler ran a sibling
        // sweep that emitted `force-room-join` to every other socket of
        // the same user, dragging them into the originator's new room
        // to keep "one user, one room" intact. That broke the natural
        // expectation that browser tabs are independent contexts. The
        // userlist already dedupes by userId within a room, so a user
        // with two tabs in the same room still shows as one occupant;
        // a user with tabs in different rooms shows in each, which is
        // exactly what the user opening multiple tabs wants.

        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    socket.on("room:leave", async (payload) => {
      if (!(await checkAndExtendSession())) return;
      socket.leave(`room:${payload.roomId}`);
      clearTyperFromRoom(io, db, { roomId: payload.roomId, userId: user.id });
      await broadcastPresence(io, db, payload.roomId);
    });

    /**
     * Theater (watch-party) playback control. Owner/mod-only: we re-check
     * the room-edit gate server-side so a viewer can't drive playback by
     * crafting the event in devtools. Mutates the in-memory live state and
     * fans the new `theater:sync` out to the whole room.
     */
    socket.on("theater:control", async (payload, ack) => {
      if (!(await checkAndExtendSession())) {
        ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpiredLogin") });
        return;
      }
      const { roomId, action } = payload;
      if (!socket.rooms.has(`room:${roomId}`)) {
        ack?.({ ok: false, code: "NO_ROOM", message: tFor(user.locale, "errors:server.realtime.notInRoomTheater") });
        return;
      }
      const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
      if (!room || !room.theaterMode) {
        ack?.({ ok: false, code: "NO_THEATER", message: tFor(user.locale, "errors:server.realtime.theaterNotOn") });
        return;
      }
      // `ended` / `error` are PASSIVE end-of-source signals a viewer's
      // player emits; honoring them from non-controllers is what keeps the
      // playlist advancing (and skipping dead sources) when no mod is around.
      // ACTIVE controls always require the room-edit gate.
      const isPassive = action === "ended" || action === "error";
      if (!(await callerCanEditRoom(db, user, roomId))) {
        if (!isPassive) {
          ack?.({ ok: false, code: "PERM", message: tFor(user.locale, "errors:server.realtime.theaterControlPerm") });
          return;
        }
        // A plain viewer's passive report only counts while NO controller-
        // capable user is connected to the room: when an owner/mod is here,
        // their own player reports the genuine end-of-source, and a crafted
        // `ended`/`error` was the one remaining way a non-controller could
        // still skip/restart the video for everyone. Dropped reports ack ok
        // (silent no-op) — the real client fires these blind and there is
        // nothing for a viewer to fix. The real client also always stamps
        // the source index on passive reports; requiring it keeps a crafted
        // index-less report from dodging the stale-index validation inside
        // `applyControl`.
        if (!Number.isFinite(payload.index) || (await anyConnectedRoomController(io, db, roomId, user.id))) {
          ack?.({ ok: true });
          return;
        }
      }
      const playlist = parsePlaylist(room.theaterPlaylist);
      applyControl(roomId, action, {
        positionSec: payload.positionSec,
        index: payload.index,
        len: playlist.length,
        loop: room.theaterLoop,
        now: Date.now(),
      });
      await broadcastTheaterSync(io, roomId);
      // Checkpoint the new playback state so a restart resumes from this
      // control (a fresh seek/pause survives even a crash 1s later, ahead
      // of the next 30s sweep). The `progress` heartbeat fires every ~10s,
      // though; let the periodic sweep persist those rather than writing the
      // row on every beat.
      if (action !== "progress") await persistTheaterCheckpoint(db, roomId);
      ack?.({ ok: true });
    });

    /**
     * Floating emoji reaction over the theater video. Open to any occupant
     * (it's a lightweight cheer, not a control action). Rate-limited per
     * socket so a hostile client can't flood the room. `side` alternates so
     * reactions drift up both edges.
     */
    let theaterReactTimes: number[] = [];
    let theaterReactSide: "left" | "right" = "left";
    socket.on("theater:react", async (payload) => {
      if (!(await checkAndExtendSession())) return;
      const { roomId } = payload;
      if (!socket.rooms.has(`room:${roomId}`)) return;
      const now = Date.now();
      theaterReactTimes = theaterReactTimes.filter((t) => t > now - 5_000);
      if (theaterReactTimes.length >= 12) return; // 12 reactions / 5s
      theaterReactTimes.push(now);
      const emoji = (payload.emoji ?? "").trim().slice(0, 8);
      if (!emoji) return;
      theaterReactSide = theaterReactSide === "left" ? "right" : "left";
      io.to(`room:${roomId}`).emit("theater:reaction", {
        roomId,
        userId: user.id,
        displayName: user.displayName,
        emoji,
        side: theaterReactSide,
      });
    });

    /**
     * profile:fetch rate limit. Authenticated, but each call hits the DB
     * twice (master lookup + character lookup), so spamming it is a cheap
     * scrape vector. 30 fetches / 10s comfortably covers an admin
     * interactively browsing the userlist while throttling automation.
     */
    let profileFetchTimes: number[] = [];
    socket.on("profile:fetch", async (payload, ack) => {
      if (!(await checkAndExtendSession())) {
        ack({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpired") });
        return;
      }
      const now = Date.now();
      profileFetchTimes = profileFetchTimes.filter((t) => t > now - 10_000);
      if (profileFetchTimes.length >= 30) {
        ack({ ok: false, code: "RATE_LIMIT", message: tFor(user.locale, "errors:server.realtime.profileLookupRateLimit") });
        return;
      }
      profileFetchTimes.push(now);
      // Same slug → username normalization as the HTTP /profiles/:name
      // route. Some clients (in-chat name clicks) hand us the canonical
      // NBSP form already; others (URL-derived calls) carry the slug
      // with a regular space. slugToUsername resolves both.
      // Pass the socket's authenticated userId so the owner viewing
      // their own profile bypasses the hide-count redaction.
      const viewerId = (socket.data as { userId?: string }).userId;
      const profile = await lookupProfile(db, slugToUsername(payload.username), viewerId);
      if (!profile) {
        ack({ ok: false, code: "NO_USER", message: tFor(user.locale, "errors:server.realtime.profileNotFound") });
        return;
      }
      // Server-contextual role badges: the VIEWED user's usergroups in the
      // server the VIEWER is currently standing in (socket.data.serverId is
      // stamped on every room join; before the first join, derive it from
      // the room, else the default server). Deliberately NOT the profile
      // owner's favorite server (resolveProfileServerId anchors cosmetics —
      // different concept). The HTTP deep-link path has no server context
      // and omits the field entirely. Best-effort: a lookup failure never
      // withholds the profile itself.
      let withRoles = profile;
      try {
        const sd = socket.data as { serverId?: string; roomId?: string };
        const viewerServerId = sd.serverId
          ?? (sd.roomId ? await resolveRoomServerId(db, sd.roomId) : DEFAULT_SERVER_ID);
        const { serverRolesFor } = await import("./servers/usergroups.js");
        const roles = await serverRolesFor(db, viewerServerId, profile.profile.userId);
        if (roles.length) withRoles = { ...profile, serverRoles: roles };
      } catch { /* roles are decoration; the profile still ships */ }
      ack({ ok: true, profile: withRoles });
    });

    /**
     * Activity heartbeat from the client (mouse/keyboard/touch, throttled to
     * ~30s). Sole purpose: keep the session alive while the user is at the
     * keyboard but not actively sending events. Without this, an idle reader
     * would be kicked at the idle-timeout boundary even with the tab open
     * and being scrolled.
     *
     * Server-side debounce: a hostile client could ignore the 30s throttle
     * and spam this. Each call writes to the sessions table via
     * extendSession; spamming pins SQLite. We accept at most one effective
     * heartbeat every 5 seconds per socket, dropping the rest. The session's
     * own expiresAt also advances on chat:input / room:join etc., so this
     * doesn't shorten the user's effective idle window.
     */
    let lastActiveAt = 0;
    socket.on("presence:active", async () => {
      const now = Date.now();
      if (now - lastActiveAt < 5_000) return;
      lastActiveAt = now;
      await checkAndExtendSession();
    });

    /**
     * Accept | Decline response for a mutual-title prompt (request OR
     * dissolve). The service layer authorizes by row state and the
     * authenticated socket's userId; we just route the result.
     */
    /**
     * Per-tab character switch. Mirrors what `/char switch` does in chat,
     * but is the entry point for UI buttons (ProfileEditor "Switch to
     * this character", profile-modal action chip) that previously hit
     * the HTTP `PUT /me/active-character` endpoint and synced every tab.
     *
     * Side effects on success:
     *   1. socket.data.tabCharId is set, this socket's outgoing messages
     *      now carry the new identity.
     *   2. user.activeCharacterId + user.displayName mutate in-place so
     *      any in-flight handler on this socket sees the fresh value.
     *   3. users.activeCharacterId in the DB is updated so a *fresh* tab
     *      opened later defaults to this character. Already-connected
     *      tabs are NOT touched, that's the entire point of the per-
     *      socket scope.
     *   4. Presence in the current room is rebroadcast so the userlist
     *      reflects the new name on everyone's screen.
     *   5. me:character-update is emitted to this socket so the React
     *      state in this tab can refresh activeCharacterId/Name + theme
     *      without polling /me/profile.
     */
    socket.on("me:switch-character", async (payload, ack) => {
      try {
        if (!(await checkAndExtendSession())) {
          ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpired") });
          return;
        }
        const requested = payload.characterId;
        if (requested !== null) {
          const c = (await db
            .select()
            .from(characters)
            .where(eq(characters.id, requested))
            .limit(1))[0];
          if (!c || c.deletedAt || c.userId !== user.id) {
            ack?.({ ok: false, code: "NO_CHAR", message: tFor(user.locale, "errors:server.realtime.characterNotFound") });
            return;
          }
        }
        // The identity this tab was voicing BEFORE the switch. Captured now,
        // before tabCharId is overwritten, so exitIncognitoOnCharSwitch can tell
        // whether this was the hidden tab.
        const tabCharRaw = (socket.data as { tabCharId?: string | null }).tabCharId;
        const priorCharId = tabCharRaw !== undefined ? tabCharRaw : (user.activeCharacterId ?? null);
        await db.update(users).set({ activeCharacterId: requested }).where(eq(users.id, user.id));
        (socket.data as { tabCharId?: string | null }).tabCharId = requested;
        user.activeCharacterId = requested;
        user.displayName = await resolveDisplayName(db, user.id, requested);
        // If this tab was the one hidden by /incognito, switching identity would
        // silently un-hide the mod (the new identity no longer matches the
        // incognito target, so every hide gate stops firing). Exit incognito
        // cleanly and tell them, rather than a stealth reveal. Self-guards to a
        // no-op on any tab that wasn't the hidden identity, and refreshes
        // presence in every room on an actual exit.
        await exitIncognitoOnCharSwitch(io, db, socket, user, priorCharId);
        const roomId = (socket.data as { roomId?: string }).roomId;
        if (roomId) {
          const { broadcastPresence } = await import("./realtime/broadcast.js");
          await broadcastPresence(io, db, roomId);
        }
        const name = requested === null ? null : user.displayName;
        socket.emit("me:character-update", {
          activeCharacterId: requested,
          activeCharacterName: name,
        });
        ack?.({ ok: true, activeCharacterId: requested, activeCharacterName: name });
      } catch (err) {
        log.error({ err }, "me:switch-character error");
        ack?.({ ok: false, code: "ERR", message: err instanceof Error ? err.message : "error" });
      }
    });

    socket.on("mutual:respond", async (payload, ack) => {
      if (!(await checkAndExtendSession())) {
        ack?.({ ok: false, code: "AUTH", message: tFor(user.locale, "errors:server.realtime.sessionExpired") });
        return;
      }
      const result = await respondToPrompt(db, user.id, payload.id, payload.accept, user.locale);
      if (!result.ok) {
        ack?.({ ok: false, code: result.code ?? "RESPOND_FAILED", message: result.message ?? tFor(user.locale, "errors:server.realtime.couldNotRespond") });
        return;
      }
      if (result.affectedUserIds) {
        await emitMutualSettled(io, result.affectedUserIds);
      }
      ack?.({ ok: true });
    });

    // Intentional exit: client fires this immediately before
    // disconnecting via the Exit button. The flag tells the
    // disconnect handler to emit the "X has disconnected." chat
    // broadcast, otherwise the disconnect is treated as transient
    // (mobile suspend, tab close, network drop) and stays silent.
    // No ack needed; the client doesn't wait for one (it disconnects
    // right after the emit).
    socket.on("me:exit", () => {
      (socket.data as { exitIntent?: boolean }).exitIntent = true;
    });

    // Client-driven re-sync. Fires when the Chat component mounts onto a
    // socket that was already connected by an App-level effect (e.g.
    // the deep-link standalone shell created the socket while the user
    // viewed /p/<name>, then they dismissed and Chat mounted late),
    // the initial join broadcasts went out before Chat's listeners were
    // attached, so the chat shell renders blank until we re-emit the
    // current room's state and backlog to this socket.
    socket.on("me:resync", async () => {
      const currentRoomId = [...socket.rooms]
        .filter((r) => r.startsWith("room:"))
        .map((r) => r.slice(5))[0] ?? null;
      if (!currentRoomId) return;
      await sendRoomStateTo(socket, io, db, currentRoomId);
      await sendRoomBacklogTo(socket, db, currentRoomId, user.id);
    });

    // We use `disconnecting` (not `disconnect`) because by the time
    // `disconnect` fires, socket.rooms is already empty - we'd miss the
    // room ids we need to notify and check for auto-expiry.
    socket.on("disconnecting", () => {
      const roomIds = [...socket.rooms]
        .filter((r) => r.startsWith("room:"))
        .map((r) => r.slice(5));
      // Drop any typing-indicator entries this user had. If a
      // sibling tab is still typing, its next pulse (within ~2s)
      // re-adds them. Worst case is a brief flicker in peers' UIs;
      // far less awkward than a stuck "is typing…" pinned to a
      // disconnected tab for the full TTL.
      clearTyperEverywhere(io, db, user.id);
      // Snapshot the user identity now - by the time the deferred cleanup
      // runs, the SessionUser object on this socket may already be gone.
      const userId = user.id;
      const displayName = user.displayName;
      const socketId = socket.id;
      // Resolve the identity this socket was voicing. tabCharId is the
      // per-socket override; when `undefined` (no /char issued on this
      // tab) we fall back to the user-level activeCharacterId we hold on
      // the SessionUser. Captured here, in the sync handler, so the
      // deferred cleanup doesn't see a stale value if the user object
      // mutates underneath us. `null` means OOC; a string is the active
      // character id.
      const tabCharRaw = (socket.data as { tabCharId?: string | null }).tabCharId;
      const characterId: string | null = tabCharRaw !== undefined
        ? tabCharRaw
        : (user.activeCharacterId ?? null);
      // Snapshot the intentional-exit flag too. The Exit button emits
      // `me:exit` immediately before disconnecting, which sets this on
      // socket.data, the disconnect handler reads it to decide between
      // (a) firing "X has disconnected." + immediate cleanup, vs.
      // (b) ghosting the identity into the userlist as idle so a
      // returning tab doesn't churn the rail or the chat log.
      const exitIntent = (socket.data as { exitIntent?: boolean }).exitIntent === true;
      // Phantom presence: if this socket was reading an info room, its row
      // has been displayed in the stamped anchor room. Snapshot that room
      // so the deferred cleanup can repaint it after the socket is gone —
      // otherwise the attributed (reading) row lingers there until the
      // next tree refetch. Null when not reading or anchored to the
      // landing fallback (the tree pulse covers that path).
      const presenceSd = socket.data as { presenceInfoRoomId?: string | null; presenceAnchorRoomId?: string | null };
      const readingAnchorRoomId = presenceSd.presenceInfoRoomId
        ? (presenceSd.presenceAnchorRoomId ?? null)
        : null;

      // Defer the work so the socket actually finishes leaving its rooms first;
      // otherwise expireIfEmpty would still see this socket present.
      setTimeout(() => {
        (async () => {
          // "Has this user gone offline entirely?" - true only when no
          // sibling sockets remain anywhere on the io server. Drives
          // the lastRoomId persist (so the next cold connect lands them
          // back where they were).
          const fullyOffline = !(await userIsOnline(io, userId, socketId));

          if (fullyOffline) {
            // Defensive re-write of lastRoomId on full disconnect. The
            // canonical path now writes lastRoomId on every joinRoom
            // (see realtime/broadcast.ts), so by the time we get here
            // the DB already holds the right value. We still write it
            // again as a backstop in case a future joinRoom path skips
            // the update, idempotent, costs one indexed UPDATE.
            const lastRoomId = (socket.data as { roomId?: string }).roomId ?? null;
            if (lastRoomId) {
              await db.update(users).set({ lastRoomId }).where(eq(users.id, userId));
            }
            // Drop every per-identity away + mood mark for this user — but
            // ONLY on a deliberate Exit. Both are session signals; a
            // deliberate leave should land the next login present with a
            // clean slate. On a NON-exit drop (refresh, network blip, mobile
            // backgrounding, laptop sleep — common precisely BECAUSE away
            // users are AFK and not keeping the socket warm) the identity is
            // ghosted instead, and the ghost SWEEP clears away+mood only if
            // they don't return within the grace window. Clearing here
            // unconditionally wiped /away on every transient reconnect, so a
            // user who set themselves away got "spontaneously marked
            // un-away" the moment their idle socket blipped and reconnected.
            if (exitIntent) {
              clearAllAwayForUser(userId);
              clearAllMoodForUser(userId);
            }
          }

          // Per-room decision. For each room the socket was in:
          //   - exitIntent (Exit button): fire the "has disconnected"
          //     line immediately (forum rooms suppress as before) and
          //     run the usual expireIfEmpty + broadcastPresence. No
          //     ghosting, the user explicitly left.
          //   - non-exit (tab close, refresh, network drop): if this
          //     identity has no other live socket in the room, register
          //     an idle ghost. The userlist re-broadcast that follows
          //     shows the row faded with "(idle)". The room is held
          //     open via the ghost's expireIfEmpty short-circuit until
          //     the idle window elapses with no return.
          // Master-only session-exit template lookup. Same fetch
          // shape the join path uses for the connect side. One row
          // per disconnect; null = use the default "X has
          // disconnected." phrasing.
          const sessionExitRow = (await db
            .select({ sessionExitTemplate: userEarning.sessionExitTemplate })
            .from(userEarning)
            // Disconnect spans every room this socket was in; there is no
            // single room serverId in hand here, so scope to the default
            // server (flag-off: the only pool, byte-identical to today).
            .where(and(eq(userEarning.serverId, DEFAULT_SERVER_ID), eq(userEarning.userId, userId)))
            .limit(1))[0];
          const sessionExitTemplate = sessionExitRow?.sessionExitTemplate ?? null;
          for (const id of roomIds) {
            if (exitIntent) {
              const expired = await expireIfEmpty(io, db, id);
              if (expired) continue;
              const stillThere = await userHasSocketInRoom(io, userId, id);
              if (!stillThere) {
                const r = (await db.select().from(rooms).where(eq(rooms.id, id)).limit(1))[0];
                // Forum rooms suppress regardless of intent, the topic
                // feed isn't a chat log. Info rooms suppress too: a room
                // that displays nobody never announces a departure.
                if (r?.replyMode !== "nested" && !(r && isInfoRoom(r))) {
                  await addSystemMessage(io, db, id, renderPresenceTemplate(
                    sessionExitTemplate,
                    DEFAULT_PRESENCE_TEMPLATES.sessionExit,
                    { name: displayName, room: r?.name ?? "" },
                  ));
                }
              }
              await broadcastPresence(io, db, id);
              continue;
            }
            // Non-intentional disconnect: ghost this identity if it
            // has no other live socket in this room. Same-character
            // sibling tab in the same room keeps the row live and we
            // skip the ghost. Different-character sibling means the
            // closed tab's identity still needs a ghost; the live
            // sibling shows up as its own row.
            const identityStillLive = await userIdentityHasSocketInRoom(
              io,
              userId,
              characterId,
              id,
            );
            if (!identityStillLive) {
              await registerIdleGhost(db, {
                userId,
                characterId,
                roomId: id,
                displayName,
              });
            }
            // Broadcast presence regardless, the userlist either
            // gains the idle row (just ghosted) or rebroadcasts the
            // unchanged state (sibling kept the identity live). Skip
            // expireIfEmpty: a ghost is now holding the room, and
            // even if the identity stayed live, a sibling socket is
            // still present so the room isn't empty.
            await broadcastPresence(io, db, id);
          }
          // The reader's attributed row lived in the anchor room, not in
          // any room this socket held a band for — repaint it so the
          // (reading) row drops promptly now the socket is gone.
          if (readingAnchorRoomId) {
            await broadcastPresence(io, db, readingAnchorRoomId).catch(() => {});
          }
        })().catch((err) => log.error({ err }, "disconnecting cleanup failed"));
      }, 0);
    });
  });
}

/**
 * Per-user sliding window for failed room password attempts. Prevents an
 * attacker from brute-forcing a private-room password and from pinning the
 * server's CPU on argon2.verify calls.
 *
 * Bucket: caller userId. Window: 60s. Max fails before cooldown: 5. Cooldown
 * after exceeding: 60s. Map keys are pruned implicitly by the slice + cooldown
 * logic; long-idle users naturally roll out of the window.
 */
const ROOM_PW_WINDOW_MS = 60_000;
const ROOM_PW_MAX_FAILS = 5;
const ROOM_PW_COOLDOWN_MS = 60_000;
const roomPwFailures = new Map<string, number[]>();
const roomPwCooldownUntil = new Map<string, number>();

function roomPwCooldown(userId: string, now: number): number {
  const until = roomPwCooldownUntil.get(userId) ?? 0;
  return until > now ? until - now : 0;
}

function recordRoomPwFailure(userId: string, now: number): void {
  const cutoff = now - ROOM_PW_WINDOW_MS;
  const list = (roomPwFailures.get(userId) ?? []).filter((t) => t >= cutoff);
  list.push(now);
  if (list.length >= ROOM_PW_MAX_FAILS) {
    roomPwCooldownUntil.set(userId, now + ROOM_PW_COOLDOWN_MS);
    roomPwFailures.delete(userId);
  } else {
    roomPwFailures.set(userId, list);
  }
}
