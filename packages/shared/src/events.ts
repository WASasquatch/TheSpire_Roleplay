import type { ChatMessage } from "./message.js";
import type { RoomOccupant, RoomSummary } from "./room.js";
import type { TheaterSync } from "./theater.js";
import type { IdentityRef, ProfileView } from "./profile.js";
import type { WatchOnlineEvent } from "./moderation.js";
import type { DirectMessage } from "./directMessage.js";

/** Events emitted by the client → server. */
export interface ClientToServerEvents {
  /** Raw user input. The server tokenizes (slash commands or plain text). */
  /**
   * Forum-mode payload extensions:
   *   `threadTitle`, non-empty when the user is starting a new topic in
   *                   a nested-mode room. Becomes the topic header.
   *                   Rejected when combined with `replyToId`.
   *   `replyToId`  , when set, the message becomes a reply under that
   *                   topic. Required in nested rooms when not creating
   *                   a new topic (forum-style: every post is either a
   *                   new topic or a reply to one).
   *   `threadCategoryId`, same as before; only honored for new
   *                   top-level posts. The server validates the id
   *                   belongs to the target room; an invalid id silently
   *                   drops to "Uncategorized" rather than rejecting
   *                   the send (composer pickers can race with admin
   *                   category deletes).
   */
  "chat:input": (
    payload: {
      roomId: string;
      text: string;
      threadCategoryId?: string | null;
      threadTitle?: string;
      replyToId?: string;
      /**
       * Authoritative per-send identity claim from the client. The tab's
       * current React state for `activeCharacterId`, string for a
       * character, `null` for OOC (master), omitted to fall back to the
       * server's stored `socket.data.tabCharId`.
       *
       * Why this exists alongside the socket-scoped tabCharId: the
       * tabCharId is seeded at handshake and can drift from the UI's
       * actual state across reconnects, multi-tab DB-default races, or
       * cross-tab /char-clear side effects. Sending the identity on
       * every chat:input collapses all those failure modes, the
       * server validates the claim against the user's owned characters
       * and uses it as the source of truth for THIS send's display
       * name + per-character pool routing.
       *
       * Invalid claims (character isn't owned or has been deleted) are
       * silently degraded to the socket's tabCharId, same safe fallback
       * the handshake middleware uses.
       */
      asCharacterId?: string | null;
    },
    ack?: AckFn<{ ok: true } | AckError>,
  ) => void;
  "room:join": (payload: { roomId: string; password?: string }, ack?: AckFn<{ ok: true } | AckError>) => void;
  "room:leave": (payload: { roomId: string }) => void;
  /**
   * Client-side activity heartbeat. Emitted (throttled to ~30s) when the
   * user moves their mouse, types, or otherwise interacts with the page.
   * Server uses it as the canonical "user is alive at the keyboard" signal
   * for sliding session-idle expiry. Carries no payload.
   */
  "presence:active": () => void;
  "profile:fetch": (payload: { username: string }, ack: AckFn<{ ok: true; profile: ProfileView } | AckError>) => void;
  /**
   * Respond to a pending mutual-title prompt (request OR dissolve). `id` is
   * the mutual_titles row id; `accept` true=>flip status, false=>delete row
   * (request) or revert to accepted (dissolve). The recipient's session is
   * authenticated server-side, so no proof-of-recipient is needed in the
   * payload beyond the row id.
   */
  "mutual:respond": (
    payload: { id: string; accept: boolean },
    ack?: AckFn<{ ok: true } | AckError>,
  ) => void;
  /**
   * Switch THIS tab's active character without affecting other tabs the
   * same user has open. `characterId` is a character the caller owns, or
   * null to drop the active character (become master / OOC).
   *
   * Why this exists alongside the HTTP `PUT /me/active-character`:
   *   - HTTP can't identify which tab made the call, so it can only
   *     toggle the user-level default. That implementation moved every
   *     tab in lockstep, surprising behavior for multi-character
   *     play where one tab is the in-character voice and another is OOC.
   *   - This socket event scopes the switch to the calling socket
   *     (`socket.data.tabCharId`). The server also updates the user-
   *     level default so a NEW tab opened later picks up the most-
   *     recent character, but already-connected tabs are untouched.
   *
   * The server replies via `me:character-update` to the calling socket
   * with the resolved identity (new id + name) so the client can
   * refresh its theme + activeCharacterName state without polling
   * `/me/profile`.
   */
  "me:switch-character": (
    payload: { characterId: string | null },
    ack?: AckFn<{ ok: true; activeCharacterId: string | null; activeCharacterName: string | null } | AckError>,
  ) => void;
  /**
   * Signal that the user is *intentionally* leaving, i.e. clicked the
   * Exit button in the banner. The server flags the socket so the
   * eventual disconnect emits a "has disconnected." chat broadcast.
   * Without this signal, a disconnect is treated as transient
   * (mobile suspend, tab close, network blip) and stays silent in
   * chat, the userlist still updates either way.
   *
   * The client emits this immediately before `disconnect()` and does
   * not wait for an ack; the server's handler is synchronous in
   * effect (it sets a flag on `socket.data` that the disconnect
   * handler reads).
   */
  "me:exit": () => void;
  /**
   * Ask the server to re-emit `room:state` + `presence:update` +
   * `message:bulk` + `room:history_meta` for whichever room this socket
   * is currently in. Fired by the client when Chat mounts onto an
   * already-connected socket, the case where the socket was created
   * by an App-level effect during the deep-link standalone shell and
   * the initial join broadcasts went out before Chat's listeners were
   * attached. No-op when the socket isn't in any room.
   */
  "me:resync": () => void;
  /**
   * "Hey, I'm typing in this room" pulse. Client emits at most once
   * every ~2s while the user is actively keystroking the Composer
   * (and not /away). Server records {userId, displayName,
   * characterId} into a per-room in-memory map with a ~5s expiry,
   * sweeps periodically, and broadcasts `chat:typing:update` to the
   * room (filtered to exclude the typer themselves and anyone in
   * their ignore list).
   *
   * No explicit "stop" event. The composer simply stops emitting
   * when the user pauses or sends; the server's expiry sweep is what
   * actually drops the entry from the typer set. Keeps the wire
   * tiny, no signal needed on the common case of "user finished a
   * sentence and walked away".
   *
   * Phase 4 of the cosmetic expansion. Phase 5 layers the custom
   * typing phrase cosmetic ("Embers smolder…" instead of "is
   * typing…") on top of this same wire.
   */
  "chat:typing": (payload: {
    roomId: string;
    /**
     * Per-tab identity claim, same shape and semantics as
     * `chat:input.asCharacterId`. Without this, the server resolves
     * the typer's name off the closure-captured `user.displayName`,
     * which reflects whichever identity any other handler (a sibling
     * tab's `me:switch-character`, the DB default at handshake) most
     * recently wrote. That leaks a user's current character into the
     * typing indicator of a tab that is actually composing on OOC.
     * String = character, null = OOC/master, omitted = legacy fallback
     * to socket.data.tabCharId.
     */
    asCharacterId?: string | null;
  }) => void;
  /**
   * Theater (watch-party) playback control.
   *
   * ACTIVE controls (play / pause / seek / next / prev / select) are
   * owner/mod-only; the server re-checks the room-edit gate and silently
   * ignores unauthorized senders.
   *
   * PASSIVE signals (ended / error) may be sent by ANY occupant so playback
   * keeps advancing autonomously when no mod is present. The server validates
   * them against the live `index` (so a stale report can't skip) and acts at
   * most once per source.
   *
   *   play / pause      , toggle playback at `positionSec`.
   *   seek              , jump to `positionSec`.
   *   next / prev       , step the playlist (honors loop on wrap).
   *   select            , jump to playlist `index`.
   *   ended             , a viewer's source finished; advance per loop mode.
   *   error             , a viewer's source failed to play (dead / removed /
   *                       unembeddable); skip past it to the next source
   *                       regardless of loop mode. `index` identifies which
   *                       source ended/errored.
   *   progress          , the CONTROLLER's actual playback position
   *                       (`positionSec`, for `index`). Owner/mod-gated. Re-
   *                       anchors the server's position to reality so wall-
   *                       clock extrapolation can't drift ahead over a long
   *                       video; does not change index / play state.
   */
  "theater:control": (
    payload: {
      roomId: string;
      action: "play" | "pause" | "seek" | "next" | "prev" | "select" | "ended" | "error" | "progress";
      positionSec?: number;
      index?: number;
    },
    ack?: AckFn<{ ok: true } | AckError>,
  ) => void;
  /**
   * Fire a floating emoji reaction over the theater video. Any occupant
   * may send. The server fans it out as `theater:reaction` to the room.
   */
  "theater:react": (payload: { roomId: string; emoji: string }) => void;
}

/** Events emitted by the server → client. */
export interface ServerToClientEvents {
  /**
   * Scriptorium, a chapter the receiver is subscribed to has been
   * published. The client surfaces a quiet one-line system message in
   * the user's current room and (when the follower opted into push)
   * the server independently fires a web-push notification.
   *
   * Payload is structured (rather than a pre-formatted string) so the
   * client can render the link to the story / chapter and choose its
   * own copy / sound effect.
   */
  "story:chapter-published": (payload: import("./story.js").StoryChapterPublishedEvent) => void;
  /**
   * Scriptorium, the recipient has been invited to collaborate on a
   * story. Surfaces as an Accept | Decline card above the chat
   * composer, same UX shape as the mutual-titles `mutual:prompt`
   * flow. Multiple tabs/devices all see the prompt; whichever one
   * acts first wins.
   */
  "story:invite": (payload: import("./story.js").StoryCollaboratorInvite) => void;
  "message:new": (msg: ChatMessage) => void;
  "message:bulk": (msgs: ChatMessage[]) => void;
  /**
   * Sent right after `message:bulk` on a fresh room join. Carries the
   * authoritative `hasMore` for the room so the client's scroll-up
   * paginator knows whether older pages exist BEYOND what the initial
   * 50-row backlog returned.
   *
   * Why a separate event instead of inferring `hasMore` from the bulk
   * length: the server's backlog query is `limit 50` then filtered for
   * ignored users + whispers-not-for-this-viewer. A viewer in a busy
   * room can legitimately receive 30-49 messages out of 50 queried
   * (some filtered), and the older-than-50 history still exists in
   * the DB. Computing `hasMore = msgs.length >= 50` on the client
   * gave false negatives ("start of history") in exactly that case.
   * The server overfetches by 1 (51 rows) and ships the truth here
   * so the paginator stops only when there really is nothing older.
   */
  "room:history_meta": (payload: { roomId: string; hasMore: boolean }) => void;
  /** A message was edited or soft-deleted (within its grace window). The client replaces the row with this updated version. */
  "message:update": (msg: ChatMessage) => void;
  /**
   * A batch of messages was hard-deleted from a room (the `/trash`
   * moderation purge). The client drops these ids from its buffer so
   * they vanish live for everyone, no per-message tombstone. `ids` are
   * the exact rows removed; unknown ids are ignored.
   */
  "message:bulk-delete": (payload: { roomId: string; ids: string[] }) => void;
  "room:state": (payload: { room: RoomSummary; occupants: RoomOccupant[] }) => void;
  "presence:update": (payload: { roomId: string; occupants: RoomOccupant[] }) => void;
  /**
   * Global "your cached rooms tree is stale" pulse. Fired by the server
   * whenever a room is created, deleted, archived, has its metadata
   * changed, or sees a presence change (someone joined/left). Sockets
   * receive it regardless of which room they're parked in, that's the
   * point: the rooms rail shows EVERY visible room, so a refresh has to
   * cross room boundaries. The client debounces refetches (a presence
   * burst from a join shouldn't fire many GETs); fast enough to feel
   * live, slow enough to coalesce. Payload-free, the client refetches
   * `/rooms` and re-renders from the response.
   */
  "rooms:tree-changed": () => void;
  /**
   * Emoticon reaction was added or removed on a chat message, DM, or
   * forum post. Clients merge the delta into the cached reaction
   * summary for that target, no full refetch. The server scopes the
   * broadcast to the right audience: chat reactions go to the room,
   * DM reactions to the two participants' sockets.
   */
  "reaction:update": (payload: import("./emoticon.js").ReactionEvent) => void;
  /**
   * The admin updated the emoticon catalog, new sheet uploaded,
   * labels edited, sheet deleted, etc. Clients refetch
   * `GET /emoticons` and re-prime the picker. No payload, the
   * refetch handles the delta and is small.
   */
  "emoticons:updated": () => void;
  /** Server-driven UI hints - open the character editor, prompt for password, etc. */
  "ui:hint": (hint: UiHint) => void;
  /** Soft errors surfaced to the user (bad command, not in room, etc.). */
  "error:notice": (payload: { code: string; message: string }) => void;
  /**
   * Sent to the recipient of a pending mutual-title request OR to the
   * non-initiating side of a dissolve request. The client renders an
   * inline Accept | Decline card in the active room. `previewText` is the
   * formatted title as it would appear on the recipient's profile if
   * accepted (so they can see what they'd be agreeing to).
   */
  "mutual:prompt": (payload: {
    id: string;
    action: "request" | "dissolve";
    kindSlug: string;
    kindLabel: string;
    /** Display name of the requesting / dissolving party. */
    fromDisplayName: string;
    /** Identity ref of the requesting party, for click-to-view. */
    from: IdentityRef;
    /** Pre-rendered title string ("Married to Kaal") - what would show on YOUR profile. */
    previewText: string;
  }) => void;
  /**
   * Tells both parties (and their other open sockets) that a title's state
   * changed - new acceptance, dissolution, decline. Clients use it to
   * refresh any open profile views. Carries no payload-level detail; the
   * client refetches as needed.
   */
  "mutual:settled": () => void;
  /**
   * Session has expired or been invalidated. Client should clear local user
   * state and return to the login splash. Sent immediately before the
   * socket is force-disconnected by the server.
   */
  "auth:expired": () => void;
  /**
   * Pushed to a watcher's sockets when one of their watched accounts comes
   * online (transitions from no-sockets to first-socket). Carries no
   * private-room/whisper info - just identity + display name.
   */
  "watch:online": (payload: WatchOnlineEvent) => void;
  /**
   * Sent ONLY to the calling socket after a successful character switch
   * (in-chat `/char switch|clear`, `me:switch-character` socket event,
   * or character deletion that cleared the active char). Carries the
   * resolved identity post-switch so the client can refresh local
   * activeCharacterId/Name + reload the active theme without polling
   * `/me/profile`. Other open tabs of the same user are deliberately
   * NOT notified, each tab keeps its own character state.
   */
  "me:character-update": (payload: {
    activeCharacterId: string | null;
    activeCharacterName: string | null;
  }) => void;
  /**
   * Sent to EVERY live socket the user owns after a `/incognito`
   * command flips the mode bit or changes the alias. Lets the menu
   * label ("Go Incognito" vs "Leave Incognito") and the "You are
   * in incognito mode" chat banner update the moment the toggle
   * lands, without the 60-second lag of waiting on the next
   * `/auth/me` poll to notice. Fanned to all tabs (not just the
   * caller) because incognito is a user-global flag, a sibling
   * tab observing the same account needs the same affordances.
   */
  "me:incognito-update": (payload: {
    incognitoMode: boolean;
    incognitoAlias: string | null;
  }) => void;
  /**
   * Marquee banner catalog changed (admin added / edited / toggled /
   * deleted a row). Carries no payload, clients refetch the public
   * `GET /announcements/banners` endpoint on receipt so any
   * permission-gated filtering happens at the source. Fanned to every
   * connected socket because banners are sitewide chrome.
   */
  "announcements:banners-changed": () => void;
  /**
   * A new DM landed in a conversation the recipient socket is part
   * of. Server emits to every live socket of BOTH participants on
   * every send so the friends rail and any open DM panels light up
   * simultaneously. Honors `/ignore` symmetric to whispers: a DM
   * from a sender the recipient has ignored is silently dropped to
   * the recipient's sockets (the sender still sees it in their own
   * scrollback).
   */
  "dm:new": (payload: { message: DirectMessage; conversationId: string }) => void;
  /**
   * Edit / soft-delete echo. The same shape as `dm:new` so the
   * client can reuse the same handler with a "replace by id"
   * branch. Sent to every live socket of both participants.
   */
  "dm:update": (payload: { message: DirectMessage; conversationId: string }) => void;
  /**
   * The OTHER party read up to this timestamp. Lets the sender's
   * client advance its "seen" indicator without polling. Sent to
   * the sender's sockets only, the reader already knows what
   * they read.
   */
  "dm:read": (payload: { conversationId: string; readerUserId: string; lastReadAt: number }) => void;
  /**
   * Friend-state changed for the receiving socket: a new request
   * landed, a previously-pending request was accepted/declined, or
   * a friendship ended. The payload identifies the OTHER party so
   * the client can refresh its inbox / friends list without a
   * full re-fetch dance, but the actual canonical state lives at
   * `/me/friends` + `/me/friend-requests`, so the client just bumps
   * a refresh key and re-polls those.
   */
  "friend:request": (payload: {
    frienderUserId: string;
    frienderUsername: string;
    frienderDisplayName: string;
  }) => void;
  /**
   * A block relationship with the receiving user changed (they blocked, were
   * blocked by, or unblocked the other party). Emitted to BOTH affected
   * users' sockets. `withUserId` is the OTHER account; `blocked` is the new
   * state (true = now blocked, false = unblocked). The client uses it to
   * make the change feel live without a reload: drop that user's messages
   * from the buffer, close an open profile / DM with them, and bump the
   * friends refresh key. Presence repaints on its own, the server re-runs
   * broadcastPresence for the affected rooms alongside this event.
   */
  "relationships:changed": (payload: { withUserId: string; blocked: boolean }) => void;
  /**
   * Broadcast to every connected socket when an admin creates / edits
   * / deletes / toggles a custom command. Carries no payload, the
   * Composer + HelpModal both refetch `/commands` on receipt so the
   * new command surfaces in autocomplete and help without forcing
   * users to reload their tab. Cheap to send (rare event, one HTTP
   * fetch per receiver).
   */
  "commands:updated": () => void;
  /**
   * Earning, XP / Currency credited. Emitted to every live socket
   * of the affected user after the ledger row + earning row update
   * land. Carries enough state for the Earning dashboard wallet
   * widget to live-update without a refetch. One event per credited
   * scope (so a single IC chat can fan out into multiple events when
   * the user has more than one logged-in character).
   *
   * `scope === 'character'` carries the character id in `ownerId`;
   * `scope === 'user'` carries the user id (same as the recipient's
   * own user id).
   */
  "earning:earned": (payload: {
    scope: "user" | "character";
    ownerId: string;
    xpDelta: number;
    currencyDelta: number;
    xpTotal: number;
    currencyTotal: number;
    rankKey: string | null;
    tier: number | null;
    reason: string;
  }) => void;
  /**
   * Earning, rank or tier crossing. Fired alongside `earning:earned`
   * when the credit moved the user across a tier boundary. Drives the
   * persistent rank-up ribbon UI and the dashboard "What's new" pin.
   * Per the project ethos memory, the client renders a quiet ribbon,
   * never a popup toast.
   *
   * `notificationId` matches the row in `earning_notifications` that
   * persists the event across reloads, the client passes it back to
   * the ack endpoint when the user dismisses the ribbon.
   */
  "earning:rankup": (payload: {
    notificationId: string;
    scope: "user" | "character";
    characterId: string | null;
    fromRankKey: string | null;
    fromTier: number | null;
    toRankKey: string;
    toTier: number;
    newlyEligibleBorderKeys: string[];
  }) => void;
  /**
   * Earning, per-identity inventory delta. Fired to every socket of
   * the affected user after an `/give` / `/throw` / `/drop` mutates
   * `identity_inventory`, and also after `/buy` deposits a fresh
   * stack. Lets the dashboard's Items tab refresh its inventory +
   * shop-cap display without the user having to reopen the modal.
   * No payload data is interpreted client-side beyond a trigger to
   * re-fetch `/earning/me`; that single fetch carries the whole
   * inventory map for every identity the user owns, so the client
   * doesn't need to reconcile per-delta.
   */
  /**
   * Chat-line side-effect. A general-purpose channel for short visual
   * effects the server triggers on a target user's client, body
   * shake when they're hit by `/throw` / `/drop`, etc. Any future
   * target-based command can plug into the same event by adding a
   * new `kind`; the client effect runner branches on `kind` and
   * each branch owns its own animation.
   *
   * Scope: fired ONLY to sockets of the target user that are currently
   * in the originating room. A user with chat open on a second tab in
   * a different room doesn't see the effect on that tab, the effect
   * is contextual to the scene it happened in.
   *
   * Effect kinds:
   *   `struck`, the target was hit by `/throw` or `/drop`. The
   *              runner shakes the document body (scaled up a hair
   *              to keep the edges off-screen) and flashes a pale-red
   *              overlay on the chat composer. Respects
   *              `prefers-reduced-motion` (no-op when set).
   */
  "chat:effect": (payload: {
    kind: "struck";
    /** Sub-flavor of the struck effect. Determines which audio cue
     *  the runner plays, `throw` (whoosh-impact) vs `drop` (thud).
     *  Visual shake + composer flash are identical for either; only
     *  the audio differs. Optional so older server builds without
     *  the field still parse; the runner falls back to the generic
     *  "tap" chat sound when omitted. */
    variant?: "throw" | "drop";
    /** Display name of whoever caused the effect, surfaced for
     *  screen-reader text / future tooltips. Optional, the runner
     *  doesn't require it to fire. */
    sourceDisplayName?: string;
    /** Free-form context the runner ignores today. Reserved for future
     *  kinds that need extra metadata (item key, intensity, etc.). */
    context?: Record<string, unknown>;
  }) => void;
  "earning:inventory_changed": (payload: {
    /** Scope of the affected pool; included for future filtered
     *  re-fetches but not currently inspected. */
    scope: "user" | "character";
    /** User id or character id depending on `scope`. */
    ownerId: string;
    /** Item key that changed, also informational for now. */
    itemKey: string;
    /** Net change in the affected stack. Positive = received,
     *  negative = sent / consumed. The client doesn't apply this
     *  optimistically; it just re-fetches for the new authoritative
     *  state, which is simpler than reconciling local maps. */
    delta: number;
    /** Hint about which command produced the change, surfaced for
     *  future UX (toasts, etc.). */
    reason:
      | "command_give"
      | "command_throw"
      | "command_drop"
      | "command_give_received"
      | "item_purchase"
      | "admin_grant";
  }) => void;
  /**
   * Authoritative "who is currently typing in this room" set. Sent
   * to every socket subscribed to the room whenever the set CHANGES
   * (new typer joins, existing typer expires). Idle ticks that don't
   * change the set are suppressed, the wire only carries deltas.
   *
   * The receiver replaces its cached set for `roomId` with `typers`
   * wholesale. Sends an empty `typers: []` array when the last
   * person in the room stops typing, the client uses that to clear
   * the indicator.
   *
   * The server filters each receiver's payload by their ignore list,
   * so a user who ignored Alice doesn't see "Alice is typing…"
   * even when she actually is. Matches how chat messages handle
   * ignore, kept silent on the receiving side.
   */
  "chat:typing:update": (payload: {
    roomId: string;
    typers: TypingEntry[];
  }) => void;
  /**
   * Live theater playback state for the room. Broadcast whenever the
   * controller changes playback (play/pause/seek/advance) and sent
   * directly to a socket that just joined / resynced so late arrivals
   * snap to the current source + position. See TheaterSync for the
   * drift-extrapolation contract.
   */
  "theater:sync": (payload: { roomId: string } & TheaterSync) => void;
  /**
   * A floating emoji reaction to render over the theater video. `side`
   * alternates so reactions drift up the left and right edges (Twitch /
   * Twitter style). Ephemeral - the client animates it once and drops it.
   */
  "theater:reaction": (payload: {
    roomId: string;
    userId: string;
    displayName: string;
    emoji: string;
    side: "left" | "right";
  }) => void;
}

/** One row in the typing-set wire payload. */
export interface TypingEntry {
  /** User id of the typer. Stable across character switches; the
   *  display name below may change. */
  userId: string;
  /** Display name to render in the indicator. Mirrors the chat-line
   *  rule: character name when the typer is voicing a character,
   *  master username when OOC. */
  displayName: string;
  /** Character id if the typer is voicing one, else null. Used by
   *  the renderer for any per-identity styling (custom typing phrase
   *  cosmetic in Phase 5, etc.). */
  characterId: string | null;
  /** Custom typing phrase (Phase 5, `flair_typing_phrase`
   *  cosmetic). When present, the indicator renders this in place
   *  of the default "is typing…" suffix, BUT only when this is
   *  the sole typer in the room. Joint forms ("Alice and Bob are
   *  typing…") read poorly with mixed custom phrases so the
   *  renderer falls back to defaults for sets of 2+. Server reads
   *  the value off `user_earning.typing_phrase` (or
   *  `character_earning.typing_phrase`) at broadcast time, so a
   *  user editing their phrase mid-session sees it land within one
   *  typing pulse. Null/absent = use the default phrasing. */
  phrase?: string | null;
}

export type UiHint =
  | { kind: "open-character-editor"; characterId: string }
  | { kind: "open-profile"; profile: ProfileView }
  /** Open the editor for the caller's currently-active identity (master if no active char). */
  | { kind: "open-my-editor"; mode: "master" | "character"; characterId: string | null }
  | { kind: "prompt-room-password"; roomId: string; roomName: string }
  /**
   * Set or clear the client's auto-refresh interval. seconds=0 disables.
   * The client schedules its own setInterval - the server only validates and signals.
   */
  | { kind: "set-refresh-interval"; seconds: number }
  /** Open the help modal, optionally focused on a specific command. */
  | { kind: "open-help"; filter?: string }
  /** Open the World Viewer modal for the given world id. */
  | { kind: "open-world"; worldId: string }
  /** Open the Worlds manager modal (the caller's own worlds). */
  | { kind: "open-worlds-list" }
  /** Open the World Catalog modal (browse open worlds). */
  | { kind: "open-world-catalog" }
  /**
   * Surface the application form for an application-gated world.
   * Emitted by `/world join <slug>` when the world's joinMode is
   * "application". Paired with an `open-world` hint so the viewer
   * mounts behind the form. Mirrors the catalog Apply path so the
   * same ApplicationFormModal hosts both entry points.
   */
  | { kind: "world-application-prompt"; worldId: string; worldName: string }
  /**
   * Open the Scriptorium catalog. Tabs:
   *   - "find" (default): browse public stories
   *   - "my":     the caller's own stories (editor entry point)
   *   - "reading": stories the reader has positions in
   */
  | { kind: "open-scriptorium"; tab?: "find" | "my" | "reading" | "following" }
  /** Open the story reader modal for a given story. */
  | { kind: "open-story"; storyId: string; chapterIndex?: number }
  /** Open the story editor. `storyId === null` opens the New Story wizard. */
  | { kind: "open-story-editor"; storyId: string | null }
  /** Open the searchable users directory. Optional `query` pre-fills the search box. */
  | { kind: "open-users"; query?: string }
  /** Clear the local message buffer for the current room (no server effect). */
  | { kind: "clear-room-messages" }
  /** Open the user's bookmarks modal (manages saved chat messages). */
  | { kind: "open-bookmarks" }
  /**
   * Open a persistent info-display modal with a server-provided title
   * and multi-line body. Used by commands that return structured
   * informational content (e.g. `/list`, `/find`), the data is too
   * long for the auto-dismissing toast and the user typically wants
   * to scan / re-scan it instead of catching it in passing.
   *
   * `body` is rendered with whitespace preserved + monospace font so
   * the server's bullet-list formatting (leading spaces, aligned
   * columns) stays intact. Caller-side, build it the same way you'd
   * build an `error:notice` message, one line per row, `\n`-joined.
   */
  | { kind: "open-info-modal"; title: string; body: string }
  /**
   * Open the Earnings dashboard. Optional `tab` lands the user on a
   * specific section (Overview, Activity, Name Styles, Borders,
   * Cosmetics, Items, Settings); optional `itemSubTab` only applies
   * when `tab === "items"` and selects which Items sub-tab to show
   * (Inventory, Shop, Collection, Pets). Used by the `/earnings`,
   * `/shop`, `/collection`, and `/pets` builtin commands.
   */
  | {
      kind: "open-earning";
      tab?: "overview" | "ledger" | "styles" | "borders" | "cosmetics" | "items" | "settings";
      itemSubTab?: "inventory" | "shop" | "collection" | "pets";
    }
  /**
   * Open the full-screen item-zoom overlay (the same component that
   * powers tap-to-zoom on profile Collection / Pet pins). Carries
   * the resolved catalog row inline so the client doesn't need a
   * separate roundtrip, the server already looked the item up by
   * name / alias before emitting this hint. Used by the `/item
   * <name>` builtin command.
   */
  | {
      kind: "open-item";
      item: {
        itemKey: string;
        name: string;
        namePlural: string | null;
        description: string;
        iconUrl: string | null;
      };
    };

/** Wire shape served by GET /commands. The help modal renders this. */
export interface CommandDoc {
  name: string;
  aliases: string[];
  usage: string;
  description: string;
  subcommands: SubcommandDocWire[];
  isCustom: boolean;
  /** True iff this is a custom command authored with the inline-use
   *  toggle on. The composer surfaces these in the `!name` palette;
   *  built-ins are always false. */
  allowInline?: boolean;
}

export interface SubcommandDocWire {
  verb: string;
  usage: string;
  description: string;
  aliases: string[];
}

export type AckFn<T> = (payload: T) => void;
export interface AckError { ok: false; code: string; message: string }
