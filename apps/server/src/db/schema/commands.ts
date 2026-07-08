import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { messages } from "./chat.js";
import { items } from "./earning.js";
import { servers } from "./servers.js";
import { users } from "./users.js";

/* ---------- custom_commands ----------
 * Admin-authored commands beyond the built-in registry.
 * Two flavors:
 *   kind="action" → behaves like /me, body template renders "Name <text>".
 *                   Authors typically use this for /blush, /grin, etc.
 *   kind="say"    → emits a normal say message with the rendered template.
 *                   E.g. /tea → "Name pours a cup of tea."
 *
 * Templates support:
 *   {name}    - sender's display name
 *   {target}  - first arg (when present)
 *   {args}    - full remaining text after the command word
 */
export const customCommands = sqliteTable(
  "custom_commands",
  {
    id: id(),
    /** primary command name, lowercased on insert */
    name: text("name").notNull(),
    kind: text("kind", { enum: ["action", "say"] }).notNull().default("action"),
    template: text("template").notNull(),
    description: text("description"),
    /** Optional hex color override applied to messages from this command.
     *  Null = inherit the sender's chat color (existing behavior). */
    color: text("color"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** When true, users can splice this command mid-message via `!name`
     *  (e.g. "...and !random..."). The standalone `/name` path is
     *  unaffected. Defaults to false so existing commands aren't
     *  silently exposed to a new trigger surface. */
    allowInline: integer("allow_inline", { mode: "boolean" }).notNull().default(false),
    /** Optional alternate template used only when invoked inline. NULL
     *  falls back to `template`. Lets authors phrase the standalone
     *  output ("Alice flips heads") differently from the embedded
     *  form ("flips heads"). */
    inlineTemplate: text("inline_template"),
    /** Optional CSS declaration list applied to the rendered command
     *  body (e.g. `font-weight: bold; color: #4a8;`). Validated against
     *  the typography/color allow-list in
     *  packages/shared/src/customCmdCss.ts before storage. Null = use
     *  the default chat styling.
     */
    css: text("css"),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    /**
     * Scope discriminator (migration 0278h). NULL = platform-shared command; a
     * server_id scopes the command to that server's flavor. ON DELETE SET NULL
     * so deleting a server un-scopes its commands rather than destroying them.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    nameUq: uniqueIndex("custom_commands_name_uq").on(sql`lower(${t.name})`),
    serverIdx: index("custom_commands_server_idx").on(t.serverId),
  }),
);

/* ---------- custom_command_aliases ----------
 * Many-to-one - one canonical command, many aliases. Aliases share the global
 * command namespace with built-ins, so collisions are rejected on insert.
 */
export const customCommandAliases = sqliteTable(
  "custom_command_aliases",
  {
    alias: text("alias").primaryKey(),
    commandId: text("command_id")
      .notNull()
      .references(() => customCommands.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
);
export type DbCustomCommand = typeof customCommands.$inferSelect;

/* ---------- builtin_command_config ----------
 * Per-builtin command admin overrides for the social-game family.
 * Migration 0194. One row per command name (lowercase, no slash);
 * absent rows mean "use the code-default duration, mint no
 * rewards." The admin Commands tab's "Built-ins" panel writes here;
 * each game module reads via `getBuiltinCommandConfig` at
 * game-start (duration) and game-end (rewards).
 *
 * Reward shape is shared across every social command, XP +
 * Currency + optional item-from-shop, so a future game just adds
 * its name to the registry side and immediately picks up the same
 * reward pipeline. Raffles are deliberately excluded from reward
 * minting (their prize IS the host's stake; adding bonus mint on
 * top would dilute the gift). Raffles can still set `duration_ms`
 * to retune the room / sitewide window.
 */
export const builtinCommandConfig = sqliteTable("builtin_command_config", {
  commandName: text("command_name").primaryKey(),
  rewardXp: integer("reward_xp").notNull().default(0),
  rewardCurrency: integer("reward_currency").notNull().default(0),
  /**
   * Reward item key. The FK into items was DROPPED in migration 0298: this is a
   * GLOBAL singleton-per-command table with no server_id, so it cannot compose
   * an FK into the per-server (server_id, key) item catalog. Plain text now;
   * the route validates the key and game-end mints tolerate a missing item.
   */
  rewardItemKey: text("reward_item_key"),
  rewardItemCount: integer("reward_item_count").notNull().default(0),
  /** Null = use code default for this command. Bounded at the route
   *  handler (1s..30min), the column itself is just the value. */
  durationMs: integer("duration_ms"),
  updatedAt: ts("updated_at"),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
});
export type DbBuiltinCommandConfig = typeof builtinCommandConfig.$inferSelect;

/* ---------- server_builtin_command_config (Admin Partition) ----------
 * Per-server override of the social-game config above, keyed by
 * (server_id, command_name). Runtime read order: this server's row →
 * the global default above → the code default. Each server's owner/mod
 * tunes its own games in Server Admin → Commands & Titles. Migration 0291.
 */
export const serverBuiltinCommandConfig = sqliteTable("server_builtin_command_config", {
  serverId: text("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  commandName: text("command_name").notNull(),
  rewardXp: integer("reward_xp").notNull().default(0),
  rewardCurrency: integer("reward_currency").notNull().default(0),
  /**
   * Reward item key. The FK into items was DROPPED in migration 0298: the FK was
   * ON DELETE SET NULL, which can't be a composite FK into the per-server
   * (server_id, key) item catalog without nulling the NOT NULL server_id. Plain
   * text now; the route validates the key against this server's catalog.
   */
  rewardItemKey: text("reward_item_key"),
  rewardItemCount: integer("reward_item_count").notNull().default(0),
  durationMs: integer("duration_ms"),
  updatedAt: ts("updated_at"),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.serverId, t.commandName] }),
}));
export type DbServerBuiltinCommandConfig = typeof serverBuiltinCommandConfig.$inferSelect;
