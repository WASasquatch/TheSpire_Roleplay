import type { ChatMessage } from "./message.js";
import type { RoomOccupant, RoomSummary } from "./room.js";
import type { IdentityRef, ProfileView } from "./profile.js";
import type { WatchOnlineEvent } from "./moderation.js";
import type { DirectMessage } from "./directMessage.js";

/** Events emitted by the client → server. */
export interface ClientToServerEvents {
  /** Raw user input. The server tokenizes (slash commands or plain text). */
  /**
   * Forum-mode payload extensions:
   *   `threadTitle` — non-empty when the user is starting a new topic in
   *                   a nested-mode room. Becomes the topic header.
   *                   Rejected when combined with `replyToId`.
   *   `replyToId`   — when set, the message becomes a reply under that
   *                   topic. Required in nested rooms when not creating
   *                   a new topic (forum-style: every post is either a
   *                   new topic or a reply to one).
   *   `threadCategoryId` — same as before; only honored for new
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
       * current React state for `activeCharacterId` — string for a
       * character, `null` for OOC (master), omitted to fall back to the
       * server's stored `socket.data.tabCharId`.
       *
       * Why this exists alongside the socket-scoped tabCharId: the
       * tabCharId is seeded at handshake and can drift from the UI's
       * actual state across reconnects, multi-tab DB-default races, or
       * cross-tab /char-clear side effects. Sending the identity on
       * every chat:input collapses all those failure modes — the
       * server validates the claim against the user's owned characters
       * and uses it as the source of truth for THIS send's display
       * name + per-character pool routing.
       *
       * Invalid claims (character isn't owned or has been deleted) are
       * silently degraded to the socket's tabCharId — same safe fallback
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
   *     tab in lockstep — surprising behavior for multi-character
   *     play where one tab is the in-character voice and another is OOC.
   *   - This socket event scopes the switch to the calling socket
   *     (`socket.data.tabCharId`). The server also updates the user-
   *     level default so a NEW tab opened later picks up the most-
   *     recent character — but already-connected tabs are untouched.
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
   * Signal that the user is *intentionally* leaving — i.e. clicked the
   * Exit button in the banner. The server flags the socket so the
   * eventual disconnect emits a "has disconnected." chat broadcast.
   * Without this signal, a disconnect is treated as transient
   * (mobile suspend, tab close, network blip) and stays silent in
   * chat — the userlist still updates either way.
   *
   * The client emits this immediately before `disconnect()` and does
   * not wait for an ack; the server's handler is synchronous in
   * effect (it sets a flag on `socket.data` that the disconnect
   * handler reads).
   */
  "me:exit": () => void;
}

/** Events emitted by the server → client. */
export interface ServerToClientEvents {
  "message:new": (msg: ChatMessage) => void;
  "message:bulk": (msgs: ChatMessage[]) => void;
  /** A message was edited or soft-deleted (within its grace window). The client replaces the row with this updated version. */
  "message:update": (msg: ChatMessage) => void;
  "room:state": (payload: { room: RoomSummary; occupants: RoomOccupant[] }) => void;
  "presence:update": (payload: { roomId: string; occupants: RoomOccupant[] }) => void;
  /**
   * Global "your cached rooms tree is stale" pulse. Fired by the server
   * whenever a room is created, deleted, archived, has its metadata
   * changed, or sees a presence change (someone joined/left). Sockets
   * receive it regardless of which room they're parked in — that's the
   * point: the rooms rail shows EVERY visible room, so a refresh has to
   * cross room boundaries. The client debounces refetches (a presence
   * burst from a join shouldn't fire many GETs); fast enough to feel
   * live, slow enough to coalesce. Payload-free — the client refetches
   * `/rooms` and re-renders from the response.
   */
  "rooms:tree-changed": () => void;
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
   * NOT notified — each tab keeps its own character state.
   */
  "me:character-update": (payload: {
    activeCharacterId: string | null;
    activeCharacterName: string | null;
  }) => void;
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
   * the sender's sockets only — the reader already knows what
   * they read.
   */
  "dm:read": (payload: { conversationId: string; readerUserId: string; lastReadAt: number }) => void;
  /**
   * Friend-state changed for the receiving socket: a new request
   * landed, a previously-pending request was accepted/declined, or
   * a friendship ended. The payload identifies the OTHER party so
   * the client can refresh its inbox / friends list without a
   * full re-fetch dance — but the actual canonical state lives at
   * `/me/friends` + `/me/friend-requests`, so the client just bumps
   * a refresh key and re-polls those.
   */
  "friend:request": (payload: {
    frienderUserId: string;
    frienderUsername: string;
    frienderDisplayName: string;
  }) => void;
  /**
   * Broadcast to every connected socket when an admin creates / edits
   * / deletes / toggles a custom command. Carries no payload — the
   * Composer + HelpModal both refetch `/commands` on receipt so the
   * new command surfaces in autocomplete and help without forcing
   * users to reload their tab. Cheap to send (rare event, one HTTP
   * fetch per receiver).
   */
  "commands:updated": () => void;
  /**
   * Earning — XP / Currency credited. Emitted to every live socket
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
   * Earning — rank or tier crossing. Fired alongside `earning:earned`
   * when the credit moved the user across a tier boundary. Drives the
   * persistent rank-up ribbon UI and the dashboard "What's new" pin.
   * Per the project ethos memory, the client renders a quiet ribbon,
   * never a popup toast.
   *
   * `notificationId` matches the row in `earning_notifications` that
   * persists the event across reloads — the client passes it back to
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
  /** Open the searchable users directory. Optional `query` pre-fills the search box. */
  | { kind: "open-users"; query?: string }
  /** Clear the local message buffer for the current room (no server effect). */
  | { kind: "clear-room-messages" }
  /** Open the user's bookmarks modal (manages saved chat messages). */
  | { kind: "open-bookmarks" };

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
