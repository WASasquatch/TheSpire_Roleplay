import type { Server as IoServer, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";
import type { Db } from "../db/index.js";
import type { CommandRegistry } from "./registry.js";

import type { Role } from "@thekeep/shared";

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  activeCharacterId: string | null;
  /** display name resolved from active character or master username */
  displayName: string;
  /** hex color (e.g. "#990000") snapshotted into outgoing messages; null = default */
  chatColor: string | null;
  /** null = present; string = away with reason */
  awayMessage: string | null;
  /** Free-text mood/expression snapshotted onto outgoing messages; null = none. */
  currentMood: string | null;
}

export interface CommandContext {
  db: Db;
  io: IoServer<ClientToServerEvents, ServerToClientEvents>;
  socket: Socket<ClientToServerEvents, ServerToClientEvents>;
  user: SessionUser;
  roomId: string;
  /** raw text after the command word (untrimmed of inner whitespace) */
  argsText: string;
  /** whitespace-split args; argsText is authoritative for free-form commands like /me */
  args: string[];
  /** the alias the user actually typed (lowercased), e.g. "he" for /he - handlers can branch on this */
  invokedAs: string;
  /** The live command registry. Threaded through so downstream callers
   *  (notably `addMessage`) can run mid-message `!cmd` expansion against
   *  the current set of inline-enabled custom commands without each
   *  handler needing to import the registry directly. */
  registry: CommandRegistry;
}

export type CommandResult = void | Promise<void>;

export interface SubcommandDoc {
  /** verb keyword, e.g. "create" for `/char create` */
  verb: string;
  /** usage line including the verb */
  usage: string;
  /** human-readable summary */
  description: string;
  /** alternate verbs that map to this subcommand */
  aliases?: readonly string[];
}

export interface CommandHandler {
  /** canonical name, lowercase, no slash */
  name: string;
  /** alternate names that resolve to this same handler */
  aliases?: readonly string[];
  /** rough usage shown in /help */
  usage?: string;
  /** human-readable summary */
  description?: string;
  /** subcommand reference, surfaced by /help <name> in the modal */
  subcommands?: readonly SubcommandDoc[];
  /** restricts who can run it */
  permission?: Role;
  run(ctx: CommandContext): CommandResult;
}
