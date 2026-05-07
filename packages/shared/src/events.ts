import type { ChatMessage } from "./message.js";
import type { RoomOccupant, RoomSummary } from "./room.js";
import type { ProfileView } from "./profile.js";

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
}

/** Events emitted by the server → client. */
export interface ServerToClientEvents {
  "message:new": (msg: ChatMessage) => void;
  "message:bulk": (msgs: ChatMessage[]) => void;
  "room:state": (payload: { room: RoomSummary; occupants: RoomOccupant[] }) => void;
  "room:list": (rooms: RoomSummary[]) => void;
  "presence:update": (payload: { roomId: string; occupants: RoomOccupant[] }) => void;
  /** Server-driven UI hints - open the character editor, prompt for password, etc. */
  "ui:hint": (hint: UiHint) => void;
  /** Soft errors surfaced to the user (bad command, not in room, etc.). */
  "error:notice": (payload: { code: string; message: string }) => void;
  /**
   * Session has expired or been invalidated. Client should clear local user
   * state and return to the login splash. Sent immediately before the
   * socket is force-disconnected by the server.
   */
  "auth:expired": () => void;
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
