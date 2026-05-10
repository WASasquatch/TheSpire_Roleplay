import type { ChatMessage } from "./message.js";
import type { RoomOccupant, RoomSummary } from "./room.js";
import type { IdentityRef, ProfileView } from "./profile.js";
import type { WatchOnlineEvent } from "./moderation.js";

/** Events emitted by the client → server. */
export interface ClientToServerEvents {
  /** Raw user input. The server tokenizes (slash commands or plain text). */
  "chat:input": (payload: { roomId: string; text: string }, ack?: AckFn<{ ok: true } | AckError>) => void;
  "room:join": (payload: { roomId: string; password?: string }, ack?: AckFn<{ ok: true } | AckError>) => void;
  "room:leave": (payload: { roomId: string }) => void;
  "presence:away": (payload: { away: boolean; reason?: string }) => void;
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
}

/** Events emitted by the server → client. */
export interface ServerToClientEvents {
  "message:new": (msg: ChatMessage) => void;
  "message:bulk": (msgs: ChatMessage[]) => void;
  /** A message was edited or soft-deleted (within its grace window). The client replaces the row with this updated version. */
  "message:update": (msg: ChatMessage) => void;
  "room:state": (payload: { room: RoomSummary; occupants: RoomOccupant[] }) => void;
  "room:list": (rooms: RoomSummary[]) => void;
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
  /**
   * Force this client to switch into the given room. Sent to a user's
   * "sibling" sockets (other tabs/devices for the same account) when one
   * of them changes rooms, so all sessions stay synchronized to the same
   * place. The client responds by emitting `room:join` for `roomId`.
   *
   * Loop-safe: the server only sends this to siblings NOT already in the
   * target room, so a sibling re-emitting room:join doesn't ping the
   * originator back.
   */
  | { kind: "force-room-join"; roomId: string }
  | { kind: "open-admin-panel" };

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
