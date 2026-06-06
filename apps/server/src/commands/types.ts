import type { Server as IoServer, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";
import type { Db } from "../db/index.js";
import type { CommandRegistry } from "./registry.js";

import type { PermissionKey, Role } from "@thekeep/shared";

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
  /**
   * Incognito (ghost) mode flag, when true, the user is hidden from
   * userlists, room transitions don't broadcast, and any chat
   * message they send renders as a system line under
   * `incognitoAlias` instead of their identity. Persisted on the
   * `users` row; the /incognito command toggles it. See
   * `apps/server/src/commands/builtins/incognito.ts`.
   */
  incognitoMode: boolean;
  /** Alias used on system-line message attribution when incognito.
   *  Null → use the literal "System". */
  incognitoAlias: string | null;
  /** Custom leave / return message templates. Null → server-default phrasing. */
  incognitoExitMessage: string | null;
  incognitoReturnMessage: string | null;
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
  /**
   * Forum-thread context the dispatcher hydrated from the chat:input
   * payload. Set ONLY when:
   *   - the room is in nested (forum) mode
   *   - the payload carried a `replyToId`
   *   - the referenced parent is a valid, undeleted top-level topic in
   *     the same room that the user is allowed to reply to
   *
   * When present, `addMessage` automatically attaches the reply tuple
   * to any non-system message it persists, so `/me`, `/roll`,
   * `/scene`, etc. all land as replies under the topic the composer
   * was bound to instead of leaking out as new top-level posts.
   *
   * Undefined for flat rooms, plain top-level sends, and sends that
   * failed the parent-validity check (the dispatcher logs but drops
   * silently in that case).
   */
  replyContext?: {
    replyToId: string;
    replyToDisplayName: string;
    replyToBodySnippet: string;
  };
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
  /** Restricts who can run it. Checked via the new
   *  `hasPermission(user, key)` resolver in `auth/permissions.ts`,
   *  which respects per-role grants AND per-user overrides AND the
   *  masteradmin bypass. The dispatcher calls this for the gate at
   *  `dispatch.ts:321`; handlers can also call `hasPermission`
   *  directly for finer-grained checks inside their `run`. */
  permission?: PermissionKey;
  run(ctx: CommandContext): CommandResult;
  /**
   * Opt-in inline expansion. When set, the registry includes this
   * builtin in the `!name` mid-message pool. The function receives any
   * `:arg` payload the user supplied (`!roll:3d6` → `"3d6"`; bare
   * `!roll` → `""`), the calling user, and the host room id, and
   * returns either the rendered substitute string OR `null` to leave
   * the `!name` token literal (e.g. malformed args). The returned text
   * is wrapped in the shared verification marker by the dispatcher so
   * the client renderer can paint a ✓ tooltip distinguishing real
   * server expansions from a user typing the same text into chat.
   */
  inline?: (args: string, user: SessionUser, roomId: string) => string | null;
}
