import type { ChatMessage } from "./message.js";
import type { RoomOccupant, RoomSummary } from "./room.js";
import type { IdentityRef, ProfileView } from "./profile.js";
import type { WatchOnlineEvent } from "./moderation.js";

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
}

/** Events emitted by the server → client. */
export interface ServerToClientEvents {
  "message:new": (msg: ChatMessage) => void;
  "message:bulk": (msgs: ChatMessage[]) => void;
  /** A message was edited or soft-deleted (within its grace window). The client replaces the row with this updated version. */
  "message:update": (msg: ChatMessage) => void;
  "room:state": (payload: { room: RoomSummary; occupants: RoomOccupant[] }) => void;
  "presence:update": (payload: { roomId: string; occupants: RoomOccupant[] }) => void;
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
}

export interface SubcommandDocWire {
  verb: string;
  usage: string;
  description: string;
  aliases: string[];
}

export type AckFn<T> = (payload: T) => void;
export interface AckError { ok: false; code: string; message: string }
