import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { characters, users } from "./users.js";

/* ---------- direct messages (Phase 3) ---------- */
/**
 * Two-party persistent conversations, distinct from in-room whispers.
 * The canonical-pair invariant, `user_a_id < user_b_id`, combined
 * with the unique index guarantees one conversation row per pair
 * regardless of who started it. The route layer enforces the
 * ordering on insert; once recorded the row never moves.
 *
 * Why a separate table family rather than reusing `rooms` + `messages`:
 *   - DMs are always 2-party. The room model carries replyMode, world
 *     links, thread categories, passwords, membership, expiry, every
 *     one of which would be a meaningless column on a DM "room."
 *   - Privacy: admins must never read DMs. Keeping the storage out of
 *     `messages` makes "admin queries can't touch DM bodies" enforceable
 *     at the table level (no `/admin/*` route queries
 *     `direct_messages`) rather than as a runtime filter.
 */
export const directConversations = sqliteTable(
  "direct_conversations",
  {
    id: id(),
    /** Lexicographically smaller user id. Enforced at the route layer. */
    userAId: text("user_a_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** Lexicographically larger user id. */
    userBId: text("user_b_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /**
     * Per-identity partitioning (migration 0054). NULL means "this side
     * is the master OOC handle"; a character id pins the conversation
     * to that character. Two characters of the same player can hold
     * entirely separate threads with the same other party. ON DELETE
     * SET NULL keeps the conversation alive (and visible to the OTHER
     * party) when a character is later deleted; the row falls back to
     * master attribution rather than vanishing the history.
     */
    userACharacterId: text("user_a_character_id")
      .references(() => characters.id, { onDelete: "set null" }),
    userBCharacterId: text("user_b_character_id")
      .references(() => characters.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    /**
     * Touched on every successful send so the conversation list can sort
     * by recency without scanning `direct_messages`. Defaults to
     * `created_at` so a never-used row still surfaces in a friend's
     * "recent" tab.
     */
    lastMessageAt: ts("last_message_at"),
  },
  (t) => ({
    // Pair uniqueness includes the character ids (migration 0054). The
    // SQL index uses COALESCE-to-empty so SQLite's NULLs-are-distinct
    // behavior doesn't permit duplicate master-master rows.
    aRecentIdx: index("direct_conversations_a_idx").on(t.userAId, t.lastMessageAt),
    bRecentIdx: index("direct_conversations_b_idx").on(t.userBId, t.lastMessageAt),
  }),
);

export const directMessages = sqliteTable(
  "direct_messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => directConversations.id, { onDelete: "cascade" }),
    senderUserId: text("sender_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Send-time snapshot of which character the sender was voicing.
     * NULL means "sent OOC under the master handle." Pairs with the
     * displayName / avatarUrl snapshots so a later /char clear or
     * character delete doesn't rewrite past lines. ON DELETE SET NULL
     * preserves message history past a character deletion.
     */
    senderCharacterId: text("sender_character_id")
      .references(() => characters.id, { onDelete: "set null" }),
    /** Display name snapshot at send time. Same posture as messages.displayName. */
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    body: text("body").notNull(),
    /** Set when the sender edits within the grace window. */
    editedAt: integer("edited_at", { mode: "timestamp_ms" }),
    /** Set when the sender soft-deletes. Body blanks to '' at render time. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    convTimeIdx: index("direct_messages_conv_time_idx").on(t.conversationId, t.createdAt),
  }),
);

/**
 * Per-user read marker. Keyed on (conversation, user) so the friends
 * rail can compute unread counts as
 * `count(messages where created_at > my last_read_at)` without a
 * full table scan per render.
 */
export const directConversationReads = sqliteTable(
  "direct_conversation_reads",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => directConversations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: integer("last_read_at", { mode: "timestamp_ms" }).notNull().default(new Date(0)),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId] }),
  }),
);
