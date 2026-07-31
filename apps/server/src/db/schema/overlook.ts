import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { rooms } from "./chat.js";
import { users } from "./users.js";
import { worlds } from "./worlds.js";

/* ---------- Overlook (per-room / per-world sketch canvas) ---------- */

/**
 * An Overlook: one Excalidraw scene attached to either a room or a world.
 * Migration 0371.
 *
 * ONE table for both scopes because the payload and the grant logic are
 * identical. `roomId` / `worldId` discriminate and exactly one is non-null,
 * enforced by a table CHECK in the migration, which drizzle cannot model, so
 * the route layer must never construct a row with both or neither. Two
 * PARTIAL unique indexes (also migration-only) give each scope at most one
 * canvas; drizzle's `uniqueIndex` has no WHERE clause, and a plain unique
 * index over a nullable column would be useless here because SQLite treats
 * every NULL as distinct.
 *
 * `sceneJson` is the whole scene ({elements, appState, files}) and is opaque
 * to the server except for the two things the save route validates: the
 * element count (mirrored into `elementCount`) and the `files` map, which may
 * not carry base64 data URLs unless uploads are enabled.
 *
 * `version` is optimistic concurrency, not history. A PUT carrying a stale
 * version is refused with 409 rather than merged: the editor set is small and
 * privileged, so a "someone else saved, reload" warning beats a CRDT.
 */
export const overlooks = sqliteTable(
  "overlooks",
  {
    id: id(),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "cascade" }),
    worldId: text("world_id").references(() => worlds.id, { onDelete: "cascade" }),
    sceneJson: text("scene_json")
      .notNull()
      .default('{"elements":[],"appState":{},"files":{}}'),
    /** Denormalized `elements.length`, so "is this blank?" needs no scene read. */
    elementCount: integer("element_count").notNull().default(0),
    version: integer("version").notNull().default(0),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  // No index block on purpose. The real indexes are the two PARTIAL unique
  // ones from migration 0371 (`overlooks_room_uq` / `overlooks_world_uq`),
  // which drizzle cannot express: `uniqueIndex` has no WHERE clause, and a
  // plain unique index over these nullable columns would be useless because
  // SQLite treats every NULL as distinct. Declaring decorative extra indexes
  // here would describe a schema that does not exist; those two already serve
  // every lookup this table gets.
);

/**
 * Explicit edit grants from `/overlook add <user>`, layered on top of the
 * authority the scope already carries (room owner/mod, world owner/
 * collaborator). Keyed on the ACCOUNT: authority is per-account everywhere
 * else in the app, and `room_mods` being per-identity is a display-only
 * exception for the userlist crown.
 */
export const overlookEditors = sqliteTable(
  "overlook_editors",
  {
    overlookId: text("overlook_id")
      .notNull()
      .references(() => overlooks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedAt: ts("added_at"),
    addedByUserId: text("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.overlookId, t.userId] }),
    userIdx: index("overlook_editors_user_idx").on(t.userId),
  }),
);

export type DbOverlook = typeof overlooks.$inferSelect;
export type DbOverlookEditor = typeof overlookEditors.$inferSelect;
