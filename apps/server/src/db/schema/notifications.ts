import {
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { servers } from "./servers.js";
import { characters, users } from "./users.js";

/**
 * Notification Center (migration 0303). The unified inbox that generalizes
 * forumNotifications above: server approvals, @mentions (chat + forum), DMs,
 * friend requests, earning milestones, announcements, and report outcomes all
 * land here. Display fields are SNAPSHOTS (actorName, title, snippet) so the
 * inbox survives renames; FKs SET NULL (not cascade) on actor/character/server
 * so a deleted actor or server leaves the historical row readable. A click
 * navigates via targetKind/targetId; web-push taps use `url`.
 *   - characterId: recipient identity for DM/@mention scoping; null = account-level.
 *   - serverId: originating server for grouping + rail dots; null = global.
 *   - seenAt: badge cleared (bell opened); readAt: row opened/acknowledged.
 *   - dedupeKey: collapses repeats from noisy sources within a short window.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    characterId: text("character_id").references(() => characters.id, { onDelete: "set null" }),
    category: text("category").notNull(),
    kind: text("kind").notNull(),
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name"),
    title: text("title").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    targetKind: text("target_kind").notNull().default("none"),
    targetId: text("target_id"),
    url: text("url"),
    metadataJson: text("metadata_json"),
    dedupeKey: text("dedupe_key"),
    createdAt: ts("created_at"),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    userIdx: index("notifications_user_idx").on(t.userId, t.createdAt),
    unreadIdx: index("notifications_unread_idx").on(t.userId, t.readAt),
    serverUnreadIdx: index("notifications_server_unread_idx").on(t.userId, t.serverId, t.readAt),
    dedupeIdx: index("notifications_dedupe_idx").on(t.userId, t.dedupeKey),
  }),
);
