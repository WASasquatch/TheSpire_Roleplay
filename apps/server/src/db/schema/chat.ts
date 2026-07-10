import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { forumPrefixes, forums } from "./forums.js";
import { servers } from "./servers.js";
import { characters, users } from "./users.js";

/**
 * Presence snapshot (migration 0221). A single row (id = "current") holding the
 * in-memory away / mood / idle-ghost state as JSON, written on graceful
 * shutdown and restored on the next boot so a deploy doesn't reset everyone's
 * idle/away status. One-shot: deleted on restore. `savedAt` (ms) gates a stale
 * restore so a real outage isn't replayed. See realtime/presenceSnapshot.ts.
 */
export const presenceSnapshots = sqliteTable("presence_snapshots", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
  savedAt: integer("saved_at").notNull(),
});

/* ---------- rooms ---------- */
export const rooms = sqliteTable(
  "rooms",
  {
    id: id(),
    name: text("name").notNull(),
    /**
     * "public" - anyone can join.
     * "private" - password required (set via /private). The /invite command
     *             whitelists a user so they can skip the password prompt.
     */
    type: text("type", { enum: ["public", "private"] })
      .notNull()
      .default("public"),
    /** Set whenever type === "private". */
    passwordHash: text("password_hash"),
    /** owner of user-created rooms; null for system rooms */
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * The user who FIRST created this room. Never changes after
     * creation (even when the room is archived + resurrected by a
     * different caller, or ownership is transferred). Null for
     * system rooms and for rows backfilled from before migration
     * 0196 where the current ownerId had also been wiped.
     */
    originalOwnerUserId: text("original_owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * The user who held ownership immediately before the current
     * `ownerId`. Updated each time `ownerId` changes (transfer,
     * resurrection of an archived room by a different caller).
     * When a fresh room is created this equals the creator;
     * subsequent transfers shift it to the prior owner. Null when
     * unknown (backfill couldn't determine).
     */
    lastOwnerUserId: text("last_owner_user_id").references(() => users.id, { onDelete: "set null" }),
    topic: text("topic"),
    /**
     * Long-form world/setting description shown to a user ONCE when they
     * enter the room. Distinct from `topic` (always visible). Plain text,
     * may include newlines. Null = no description sent on join.
     */
    description: text("description"),
    /** system-rooms (The_Spire and any admin-flagged landings) survive owner deletion and admin sweeps */
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    /**
     * Persistent room (migration 0302). EXEMPT from the empty-room archival
     * sweep just like isSystem, but grants NO other powers — the room stays
     * owner-deletable and is not a landing. A server's CHANNELS are created
     * persistent so the server's structure doesn't vanish when a channel
     * empties (Discord-like); the owner can opt a channel back to auto-archive
     * from the Rooms console. Ad-hoc user rooms stay non-persistent (false), so
     * they still park when the last occupant leaves.
     */
    persistent: integer("persistent", { mode: "boolean" }).notNull().default(false),
    /**
     * Owner-set 18+ flag (migration 0331, age-restriction plan). When true,
     * minors cannot list, join, read, export, or be notified from this room
     * (HARD isAdult tier, server-enforced); adults always can, hide
     * preference or not. The EFFECTIVE rating a gate consults is
     * `server.is_nsfw OR room.is_nsfw`. Messages are stamped with the
     * effective state at insert (see messages.isNsfw), so a later flip back
     * to all-ages keeps the 18+-era history minor-hidden. Toggled via
     * `/nsfw` (callerCanEditRoom), the servers console, and admin routes —
     * all adult-only writes.
     */
    isNsfw: integer("is_nsfw", { mode: "boolean" }).notNull().default(false),
    /**
     * Admin-flagged default landing room. Exactly one row in the table is
     * expected to carry isDefault=true (enforced by partial unique index in
     * the migration). All "where should we put this user?" flows resolve
     * via findCanonicalLanding which prefers this flag; the legacy
     * `name === "The_Spire"` lookup is a fallback for installs that
     * haven't flipped the flag yet.
     */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /** When true, /npc is rejected in this room - useful for themed games where everyone must speak as their own character. Owners and mods toggle via the room editor. */
    npcDisabled: integer("npc_disabled", { mode: "boolean" }).notNull().default(false),
    /**
     * Per-room message lifetime in minutes. Null = honor only the global
     * retention setting. When set, the hourly retention sweep deletes
     * messages older than this window IN THIS ROOM regardless of the
     * global value. Use case: LFG / bulletin rooms that should auto-clear
     * stale posts. Owners/mods set via /expiry.
     */
    messageExpiryMinutes: integer("message_expiry_minutes"),
    /**
     * Difficulty Class for dice mechanics (migration 0246). When set,
     * `/roll` and `/initiative` report pass/fail against this threshold
     * (a roll must MEET OR BEAT it). Owners/mods/admins set it via
     * `/roll dc <n>`; null = no difficulty configured (rolls just report
     * their total). Independent of the per-block `<roll:NdM:DC>` target,
     * which carries its own inline difficulty.
     */
    difficultyClass: integer("difficulty_class"),
    /**
     * "flat" (default) - replies render at the chronological end of chat.
     * "nested" - replies render under their parent in a collapsible thread
     * with a "View More" expander past the latest 5. Owner/mod toggleable.
     */
    replyMode: text("reply_mode", { enum: ["flat", "nested"] })
      .notNull()
      .default("flat"),
    /**
     * Forum container (migration 0223). Non-null ⇒ this room is a BOARD
     * inside that forum: it leaves the chat room list (the client filters
     * on forumId, NOT replyMode, so standalone nested rooms stay listed),
     * renders inside the Forums Catalog, and its access consults
     * `forumAuthority` (forum bans / membership) BEFORE the room-level
     * checks. Boards are always replyMode "nested"; /replymode is blocked
     * on them. ON DELETE SET NULL: forum deletion archives its boards
     * first, so a row that loses its forum is already archived and never
     * resurfaces in the chat list.
     */
    forumId: text("forum_id").references(() => forums.id, { onDelete: "set null" }),
    /**
     * Linked SFW/18+ room pair (migration 0343). Set ONLY on the 18+
     * "annex" side, pointing at its SFW base room. A linked annex is
     * hidden from the room rail; the base room's row grows a SFW/18+
     * toggle (adults only) that switches between the two, so an 18+
     * variant no longer doubles the room list. Exactly one direction is
     * ever stored (annex → base); the base's pointer to its annex is
     * computed at read time in `buildRoomSummary`. ON DELETE SET NULL:
     * deleting the base dissolves the pair and the annex becomes an
     * ordinary standalone 18+ room again.
     */
    linkedRoomId: text("linked_room_id").references((): AnySQLiteColumn => rooms.id, { onDelete: "set null" }),
    /**
     * Board-level "members only" gate (migration 0239). Only meaningful
     * when `forumId` is set: when true, this board is PRIVATE — only the
     * forum's owner, mods, and members may read it. Logged-out guests AND
     * logged-in non-members are blocked even when the forum has
     * `publicBrowsing` on. The board still LISTS (shown-but-locked); its
     * contents are withheld. Resolved through `forumAuthority(...).isMember`.
     */
    forumMembersOnly: integer("forum_members_only", { mode: "boolean" }).notNull().default(false),
    /**
     * Theater (synchronized watch-party) CONFIG. Orthogonal to `type`
     * (a theater can be a public OR private room) - mirrors replyMode as
     * a presentation mode rather than an access mode.
     *
     *   theaterMode      , on/off. When on, the chat renders a video
     *                      panel above the message list.
     *   theaterLoop      , end-of-source behavior: "off" stop | "one"
     *                      repeat current | "all" advance + loop (default).
     *   theaterPlaylist  , JSON array of TheaterSource ({ id, url, kind,
     *                      title? }) in play order. Default "[]".
     *
     * The LIVE playback position is intentionally absent here - it lives
     * in realtime/theaterState.ts (in-memory) and ships via `theater:sync`.
     * Owners/mods edit these via `/theater`.
     */
    theaterMode: integer("theater_mode", { mode: "boolean" }).notNull().default(false),
    theaterLoop: text("theater_loop", { enum: ["off", "one", "all"] })
      .notNull()
      .default("all"),
    theaterPlaylist: text("theater_playlist").notNull().default("[]"),
    /**
     * Persisted live-playback CHECKPOINT (JSON: { index, positionSec,
     * isPlaying, updatedAtMs }) so a server restart resumes near where
     * viewers were instead of snapping to the start of the playlist.
     * Null when theater is off / nothing has played yet. Written on each
     * control + a periodic sweep (NOT per-tick); rehydrated + re-anchored
     * to boot time on startup. See realtime/theaterState.ts.
     */
    theaterPlayback: text("theater_playback"),
    /**
     * Set when the last live socket leaves a user-created room. The
     * row is kept (settings + name reservation) so a future create
     * with the same lowercased name can resurrect the room with the
     * new caller as owner. Excluded from rooms-tree / search / join
     * queries, archived rows are effectively invisible until
     * resurrected. Null for active rooms; null for system rooms
     * permanently (they're never archived).
     */
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    /**
     * Room icon for the Room Info bar (migration 0258). Holds EITHER an
     * http(s) image URL or a short emoji/text glyph; the client picks the
     * render path. Set via `/icon` (owner/mod/admin). Null = no icon.
     * Persists across archive/resurrect like topic/description.
     */
    icon: text("icon"),
    /**
     * Cumulative count of visible chat messages this room has EVER received
     * (say/me/ooc/roll/scene/npc — the same kinds the lifetime post-counter
     * counts). Only ever incremented in `addMessage`; NEVER decremented by
     * retention/expiry sweeps, so it reflects lifetime activity rather than
     * the live buffer size. Deliberately NOT reset on resurrect. (0258)
     */
    messageCount: integer("message_count").notNull().default(0),
    /**
     * The room's currently-open scene, mirrored from the latest `/scene`
     * (set on open, cleared on `/scene end`). Distinct from the per-message
     * scene banner — this is the live "what beat are we in" state surfaced in
     * the Room Info pullout. Null when no scene is open. (0258)
     */
    currentSceneTitle: text("current_scene_title"),
    currentSceneImageUrl: text("current_scene_image_url"),
    /**
     * JSON array of distinct NPC display names ever voiced in this room, in
     * first-seen order. Unioned in by `/npc`. Survives message truncation and
     * archive/resurrect so the Room Info pullout can list the cast even after
     * the originating messages have been swept. Null/absent = none yet. (0258)
     */
    npcList: text("npc_list"),
    /**
     * Owner dismissed this ARCHIVED room from their "My Rooms" list (e.g. a
     * typo room they never meant to make). Set when the owner clicks the "X"
     * in the Tools-menu list; it only hides the row from `/myrooms` + the My
     * Rooms section, the archived row itself is untouched and the room can
     * still be recreated with `/go <name>` (which clears this on resurrect).
     * Null = visible in the list. (migration 0259)
     */
    archiveHiddenAt: integer("archive_hidden_at", { mode: "timestamp_ms" }),
    /**
     * Short, URL-safe handle (e.g. "the-tavern") for deep-linking the room
     * from chat / announcements via the `{room:<slug>}` UI-route chip, and
     * a stable id-independent reference generally. Derived from the name at
     * create time (lib/roomSlug.deriveUniqueRoomSlug) and owner-editable in
     * room settings; globally unique (case-insensitive). Nullable only for
     * the window between migration 0260's ADD COLUMN and the one-shot boot
     * backfill — every live row carries one. (migration 0260)
     */
    slug: text("slug"),
    /**
     * Server container (migration 0277). The partition seam: every chat room
     * belongs to exactly one server; the rail filters by serverId and
     * join/presence consult serverAuthority (membership/ban) BEFORE the
     * room-level checks. ON DELETE SET NULL — a server delete un-homes its
     * rooms rather than destroying them; the app treats NULL as ADOPTED BY THE
     * DEFAULT (is_system) server so a room is never presence-homeless. NULL
     * until the Phase-2 backfill points existing rooms at the default server.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    nameUq: uniqueIndex("rooms_name_uq").on(sql`lower(${t.name})`),
    forumIdx: index("rooms_forum_idx").on(t.forumId),
    serverIdx: index("rooms_server_idx").on(t.serverId),
    // The single-default invariant moved to PER-SERVER in migration 0277:
    // a partial UNIQUE `rooms_one_default_per_server` on (server_id) WHERE
    // is_default = 1 AND server_id IS NOT NULL (replacing the old install-global
    // rooms_is_default_uq). Drizzle can't model partial indexes, so it lives in
    // the SQL only.
    // Partial unique index (WHERE slug IS NOT NULL) lives in migration 0260;
    // drizzle can't express the partial predicate, so it's declared in SQL
    // only and omitted here (mirrors the difficultyClass/isDefault posture).
  }),
);

/* ---------- room_clears ---------- */
/**
 * Per-user, per-room "cleared my scrollback at" marker. Set by `/clear`
 * (which is a PER-VIEWER action, not a delete). Every backlog source
 * (sendRoomBacklogTo + the scroll-up /rooms/:id/messages page) filters to
 * `messages.created_at > cleared_at` for the viewer, so a clear is
 * DURABLE across reconnects / resyncs / new messages instead of snapping
 * back the moment the socket re-sends history. Monotonic: each /clear
 * bumps the timestamp forward; a row's absence means "never cleared."
 */
export const roomClears = sqliteTable(
  "room_clears",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    clearedAt: integer("cleared_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.roomId] }),
    roomIdx: index("room_clears_room_idx").on(t.roomId),
  }),
);

/* ---------- room_members ---------- */
export const roomMembers = sqliteTable(
  "room_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "mod", "member"] })
      .notNull()
      .default("member"),
    joinedAt: ts("joined_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roomId, t.userId] }),
    userIdx: index("room_members_user_idx").on(t.userId),
  }),
);

/* ---------- room_mods ----------
 * Per-IDENTITY room-moderator attribution, used ONLY for the userlist
 * crown. Moderation AUTHORITY stays per-account on `room_members.role`
 * (a /promote still sets that, so switching characters never drops your
 * mod power and none of the room-authority checks change). This table
 * additionally records WHICH identity each /promote was aimed at, so
 * the mod crown shows on that identity alone instead of on every
 * character the account voices. A user can be listed under more than
 * one identity (master + several characters), the "list of ID/CID."
 *
 * `characterId` is the empty string for the OOC/master identity (a
 * NOT NULL sentinel keeps the composite primary key clean, SQLite
 * treats NULLs in a PK as distinct, which would let duplicate OOC rows
 * slip in). Callers map `null` (the wire/`RoomOccupant` shape) to `''`
 * at this boundary. Room OWNER is NOT stored here, it derives from
 * `rooms.ownerId` and surfaces only on that account's OOC row. */
export const roomMods = sqliteTable(
  "room_mods",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    characterId: text("character_id").notNull().default(""),
    grantedAt: ts("granted_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roomId, t.userId, t.characterId] }),
    roomIdx: index("room_mods_room_idx").on(t.roomId),
  }),
);

/* ---------- room_invites ---------- */
export const roomInvites = sqliteTable(
  "room_invites",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    invitedUserId: text("invited_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    invitedById: text("invited_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roomId, t.invitedUserId] }),
  }),
);

/* ---------- messages ---------- */
export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** snapshot - character may be deleted later but history must remain stable */
    characterId: text("character_id"),
    /** snapshot - display name at send time (so renames don't rewrite history) */
    displayName: text("display_name").notNull(),
    kind: text("kind", {
      enum: ["say", "me", "cmd", "system", "whisper", "roll", "announce", "scene", "npc", "ooc", "poll"],
    })
      .notNull()
      .default("say"),
    body: text("body").notNull(),
    /** Snapshot of the author's chat color at send time (e.g. "#990000"). Null = default. */
    color: text("color"),
    /** populated only for whispers */
    toUserId: text("to_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * Per-identity whisper pin, the recipient's character id at send
     * time. Set when the resolution pointed at a specific character
     * (`@cid:` token or character-name lookup); null when the whisper
     * was addressed at the master / OOC handle. Added in migration
     * 0189 to close a per-identity click-leak: without this snapshot
     * the FE could only fill the continuation `/whisper` with the
     * master id, re-routing a thread that was opened to a character
     * back to the master account.
     *
     * NOT a FK, same rationale as `toUserId` not being a hard FK on
     * users in the strict sense: a soft-deleted character shouldn't
     * cascade-mangle the whisper row. Kept as plain text.
     */
    toCharacterId: text("to_character_id"),
    /** Snapshot of the recipient's display name at send time (whispers only). */
    toDisplayName: text("to_display_name"),
    /**
     * Per-user visibility scope for `system`-kind notifications
     * (migration 0252). NULL = visible to everyone in the room (the
     * default for presence / announce / game lines). When set, the row
     * is a TARGETED notification — "a watched friend came online", "you
     * have a friend request", a followed story's publish, the per-room
     * "[Description]:" line — and the backlog filter
     * (`roomVisibilityWhere`) shows it ONLY to this user. Distinct from
     * `toUserId`, which is the whisper recipient (whispers overlay across
     * rooms; targeted system rows stay room-scoped). FK cascade-deletes
     * a user's targeted lines with the account.
     */
    targetUserId: text("target_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    /** Id of the message this one is a reply to. Not a FK - if the parent is deleted we still keep the dangling id and render gracefully. */
    replyToId: text("reply_to_id"),
    /** Snapshot of parent author's display name (so renames/deletes don't blank the preview). */
    replyToDisplayName: text("reply_to_display_name"),
    /** Truncated snapshot of parent body for the inline quote preview. */
    replyToBodySnippet: text("reply_to_body_snippet"),
    /** Snapshot of the author's mood/expression at send time (or null). */
    moodSnapshot: text("mood_snapshot"),
    /** For /npc messages, the display name of the author's ACTIVE identity (character, or OOC name when OOC) that voiced this NPC, rendered as a "voiced by" tag next to the NPC name. NOT the master account — that stays recoverable via this row's userId/characterId for moderation. */
    npcVoicedBy: text("npc_voiced_by"),
    /** For NPC posts voiced from a saved NPC: JSON snapshot of its stat
     *  lines at post time (migration 0267). Null = no stats. */
    npcStatsJson: text("npc_stats_json"),
    /**
     * Optional hero image for `/scene <title> | <url>` banners.
     * Frozen at send time so a later edit to whatever the URL points
     * at doesn't restyle history. Validated server-side as an
     * http(s) URL with a 500-char cap (same posture as the avatar
     * validator). NULL on every non-scene row and on legacy scene
     * rows that predate migration 0190.
     */
    sceneImageUrl: text("scene_image_url"),
    /**
     * Trusted-HTML body for scheduled-/announce lines (migration 0191).
     * The chat markdown pipeline still owns regular chat, when this
     * column is non-null, the announce-kind renderer paints it via
     * `dangerouslySetInnerHTML` (after the same sanitizer the bio
     * pipeline uses) so an admin who scheduled a banner with links /
     * lists / bold spans gets formatting fidelity. Manual in-chat
     * `/announce` keeps this NULL and falls through to the inline-
     * markdown render path.
     */
    bodyHtml: text("body_html"),
    /**
     * Thread category bucket, only meaningful for top-level messages in
     * a nested-mode room. Replies inherit their parent's bucket
     * implicitly via the thread the client groups. FK is SET NULL so
     * deleting a category preserves the thread history; the client
     * renders null as "Uncategorized".
     */
    threadCategoryId: text("thread_category_id"),
    /**
     * Forum topic title. Non-null on top-level "topic" messages in
     * nested-mode rooms; null on replies (they inherit their parent's
     * thread) and on every message in flat rooms. The forum renderer
     * uses this as the collapsible thread header.
     */
    title: text("title"),
    /**
     * Snapshot of the author's avatar URL at send time so renames /
     * character deletes don't blank out past forum posts. Pulled from
     * the active character when set, else the master account's
     * avatarUrl. Null = author had no avatar configured.
     */
    avatarUrl: text("avatar_url"),
    /** Set when the author edits the message inside the grace window (epoch ms). */
    editedAt: integer("edited_at", { mode: "timestamp_ms" }),
    /** Set when the author deletes the message inside the grace window (epoch ms). The row is retained so reply snippets and snapshots stay coherent; renderer shows "[message removed]". */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    /**
     * Audit snapshot: the user id of whoever performed the delete.
     * Null when the message isn't deleted, or when the delete predates
     * migration 0084 (existing rows have no recorded actor). Compare
     * against `userId` at render time to tell self-delete from
     * mod/admin moderation.
     */
    deletedByUserId: text("deleted_by_user_id"),
    /**
     * Snapshot of the actor's display name at delete time. Mirrors
     * the existing `displayName` snapshot pattern for the author,
     * keeps the audit coherent if the actor later renames or has
     * their account deleted.
     */
    deletedByDisplayName: text("deleted_by_display_name"),
    /**
     * 18+ stamp (migration 0332, age-restriction plan). Two readers, one
     * column:
     *   * CHAT rows snapshot the room's EFFECTIVE 18+ state (server OR
     *     room) at insert — same frozen-at-send posture as rankKey/color —
     *     so 18+-era history stays hidden from minors after a room flips
     *     back to all-ages.
     *   * FORUM TOPIC rows (title set, nested rooms) use it as the mutable
     *     NSFW tag; replies inherit the topic's value at insert and a
     *     re-tag retro-updates the children.
     * Read gates: `roomVisibilityWhere`'s viewer parameter + the search
     * routes filter on it for viewers who can't see NSFW.
     */
    isNsfw: integer("is_nsfw", { mode: "boolean" }).notNull().default(false),
    /**
     * Set when the topic has been locked (author or moderator action).
     * Only meaningful for top-level topics in nested-mode rooms, the
     * server rejects new replies under a locked topic. Stored as a
     * timestamp (ms) instead of a boolean so future audit surfaces can
     * show "locked at..."; the client only reads the truthiness.
     */
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    /**
     * Timestamp of the most recent reply under this row (or its own
     * createdAt when no replies exist). Only meaningful for top-level
     * topics in nested-mode rooms, the forum-topics endpoint orders
     * by this DESC so the most-recently-active threads surface first.
     * `addMessage` updates the parent's value on every reply insert.
     */
    lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }),
    /**
     * Admin-pinned flag for forum topics. Stickies always sort above
     * non-stickies in their category and are returned on every page
     * of the topics endpoint so they stay visible no matter how far
     * back the user paginates. Toggle-able only by site admins via
     * `PATCH /messages/:id/sticky`.
     */
    isSticky: integer("is_sticky", { mode: "boolean" }).notNull().default(false),
    /** Forum topic prefix (migration 0266). Top-level forum topics only;
     *  null = no prefix. SET NULL when the prefix is deleted. */
    prefixId: text("prefix_id").references(() => forumPrefixes.id, { onDelete: "set null" }),
    /**
     * Server-validated CSS snapshot for `kind: "cmd"` rows. Frozen on the
     * row at send time so a later edit to the underlying custom command's
     * CSS doesn't restyle historical messages, same snapshot pattern used
     * for `display_name`, `color`, etc. Null on every other kind.
     */
    cmdCss: text("cmd_css"),
    /**
     * OpenGraph unfurl for the body's first http(s) link (migration
     * 0238): JSON {url,title,description,imageUrl,siteName}, or
     * {"hidden":true} after the author removes the card. Filled
     * fire-and-forget after the post lands; null = no link / nothing
     * unfurlable / not processed.
     */
    linkPreviewJson: text("link_preview_json"),
    /**
     * Poll definition + close-state for `kind: "poll"` rows (migration
     * 0240). JSON: { options:[{id,text}], allowMultiple, showVoters,
     * closesAt:ms|null, closedAt:ms|null }. The poll QUESTION rides `body`
     * (chat) / `title` (forum topic); votes live in `poll_votes`, not here,
     * so concurrent voting never races on this column. Null on every other
     * kind. Mirrors the linkPreviewJson / cmdCss JSON-snapshot pattern.
     */
    pollDataJson: text("poll_data_json"),
    /**
     * Resolved @mention snapshot for this message (migration 0243). JSON array
     * of { name, userId, characterId } - one per `@id:`/`@cid:` identity token
     * the composer inserted. Set at send time after the body is rewritten to
     * plain `@<displayName>`; lets the renderer open the exact mentioned
     * identity on click and highlight self-mentions by id rather than by a
     * name two identities might share. Null when a message has no token
     * mentions (plain typed `@name` still resolves by name as before).
     */
    mentionsJson: text("mentions_json"),
    /**
     * Earning rank snapshot at send time, drives the chat-line sigil.
     * Same snapshot posture as displayName / color: a later rank-up or
     * a rank-disable doesn't rewrite history. Scope follows the IC/OOC
     * routing rule (character pool for IC, master pool for OOC).
     * Null = sender was unranked at send time.
     */
    rankKey: text("rank_key"),
    tier: integer("tier"),
    /**
     * Snapshot of whether the author had the inline-avatar cosmetic
     * enabled at send time. Without this snapshot the chat renderer
     * has to rely on the LIVE occupant row, so backlog from authors
     * who have logged out renders without their inline avatar even
     * though the avatarUrl snapshot above is present. Mirrors the
     * rankKey / tier snapshot posture, a later toggle (or the
     * author logging out) doesn't rewrite history.
     */
    senderInlineAvatarEnabled: integer("sender_inline_avatar_enabled", { mode: "boolean" }).notNull().default(false),
    /**
     * Snapshot of the author's equipped border-rank key at send time.
     * Paired with `senderInlineAvatarEnabled` so a backlog message's
     * inline avatar still shows the correct frame even when the
     * sender is offline (or has since switched borders).
     */
    senderSelectedBorderRankKey: text("sender_selected_border_rank_key"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    roomTimeIdx: index("messages_room_time_idx").on(t.roomId, t.createdAt),
  }),
);

/* ---------- poll votes ---------- */
/**
 * One ballot for a `kind: "poll"` message (migration 0240). A row per
 * (poll, voter, option): single-choice polls keep exactly one row per voter
 * (the vote route deletes the voter's prior rows before inserting); multiple-
 * choice polls keep one row per selected option. The poll DEFINITION lives in
 * messages.pollDataJson; this table is the mutable tally so concurrent votes
 * never read-modify-write a JSON array.
 */
export const pollVotes = sqliteTable(
  "poll_votes",
  {
    pollMessageId: text("poll_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** Matches an option id inside the poll message's pollDataJson. */
    optionId: text("option_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.pollMessageId, t.userId, t.optionId] }),
    pollIdx: index("poll_votes_poll_idx").on(t.pollMessageId),
  }),
);

/* ---------- room thread categories ---------- */
/**
 * Per-room admin-defined buckets for organizing top-level threads in
 * nested-mode rooms. The unique (room_id, lower(name)) index in the
 * migration enforces case-insensitive uniqueness within a room, no two
 * "Active Scenes" / "active scenes" categories side by side. Replies
 * inherit their parent's category implicitly; only top-level messages
 * carry a `thread_category_id` reference.
 */
export const roomThreadCategories = sqliteTable(
  "room_thread_categories",
  {
    id: id(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Admin-set ordering within a room; ties broken by createdAt for stability. */
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Optional custom category icon (migration 0227). Uploaded by the
     * FORUM owner (content-hashed, small square, same pipeline as
     * emoticons) for boards inside a forum; null = the default glyph.
     * Standalone nested rooms keep null (no upload surface for them).
     */
    iconUrl: text("icon_url"),
    /** Optional one-line subtitle under the category name in the board's
     *  section header — "what belongs in here" (migration 0233). */
    subtitle: text("subtitle"),
    /** ONE level of nesting (migration 0235): set ⇒ this category renders
     *  as a sub-section under its top-level parent. Parents can't
     *  themselves be children (enforced at the route layer). Deleting a
     *  parent promotes children to top level (SET NULL). */
    parentId: text("parent_id"),
    /** Category-level "members only" gate (migration 0239): when true,
     *  only the forum's owner/mods/members may read topics filed under this
     *  category. The chip still renders (shown-but-locked); its topics are
     *  filtered out for non-members. Mirrors rooms.forumMembersOnly one level
     *  down. Only meaningful for categories inside a forum board. */
    membersOnly: integer("members_only", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
  },
  (t) => ({
    roomIdx: index("room_thread_categories_room_idx").on(t.roomId),
  }),
);

/* ---------- bookmarks ---------- */
export const bookmarks = sqliteTable(
  "bookmarks",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * FK is SET NULL (not CASCADE) as of migration 0314: a bookmark must
     * OUTLIVE the message it points at (that's what the snapshot_* columns
     * below are for). When the underlying message is hard-deleted, the id
     * goes null and the client renders the frozen snapshot instead of the
     * live join.
     */
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Free-form user-defined category; empty string is treated as "Uncategorized". */
    category: text("category").notNull().default(""),
    /** Optional user-authored note for context, "why I bookmarked this". */
    note: text("note"),
    createdAt: ts("created_at"),
    /* ---- display snapshots (migration 0314) ----
     * Mirror the message reply-snapshot convention
     * (messages.replyToDisplayName / replyToBodySnippet): frozen at save
     * time so a soft-/hard-deleted or renamed message still reads in the
     * bookmarks viewer. All nullable; legacy rows fall back to the live join. */
    /** Author display name at save time. */
    snapshotDisplayName: text("snapshot_display_name"),
    /** Message body at save time. */
    snapshotBody: text("snapshot_body"),
    /** Trusted-HTML body snapshot (announce/scene rows), else null. */
    snapshotBodyHtml: text("snapshot_body_html"),
    /** Author chat color at save time (hex / theme:slot). */
    snapshotColor: text("snapshot_color"),
    /** CSS snapshot for `kind: "cmd"` rows. */
    snapshotCmdCss: text("snapshot_cmd_css"),
    /** Scene banner image URL for `kind: "scene"` rows. */
    snapshotSceneImageUrl: text("snapshot_scene_image_url"),
    /** Author inline-avatar URL at save time. */
    snapshotAvatarUrl: text("snapshot_avatar_url"),
    /** Message kind at save time. */
    snapshotKind: text("snapshot_kind"),
    /** Room name at save time. */
    snapshotRoomName: text("snapshot_room_name"),
    /** Parent message id when the bookmarked message was itself a reply. */
    snapshotReplyToId: text("snapshot_reply_to_id"),
    /** Author character id at save time (null when OOC). */
    snapshotCharacterId: text("snapshot_character_id"),
    /** Original message createdAt (ms) at save time. */
    snapshotMsgCreatedAt: integer("snapshot_msg_created_at"),
    /** Author user id at save time (moderation trace after a delete). */
    snapshotAuthorUserId: text("snapshot_author_user_id"),
    /**
     * 18+ stamp of the source message (migration 0341, age-restriction
     * plan). Written by the retention janitor at ARCHIVE time — not save
     * time, so a forum topic's mutable NSFW re-tag lands at its final
     * value — from the live row's `messages.isNsfw`. The GET route's
     * archived-snapshot branch reads it so a frozen 18+-era body never
     * serves to a minor viewer (an admin DOB correction can flip an
     * account minor AFTER it bookmarked as an adult). Rows archived
     * before 0341 with the source already expired stay 0 (unrecoverable;
     * see the migration comment).
     */
    snapshotIsNsfw: integer("snapshot_is_nsfw", { mode: "boolean" }).notNull().default(false),
    /** When the user archived this bookmark (soft-hide from the main list). Null = active. */
    archivedAt: integer("archived_at"),
  },
  (t) => ({
    userMsgUq: uniqueIndex("bookmarks_user_msg_uq").on(t.userId, t.messageId),
    userIdx: index("bookmarks_user_idx").on(t.userId),
  }),
);

/* ---------- pinned messages (migration 0316) ----------
 * One row per pin. The room FK cascades (a deleted room drops its pins); the
 * message FK is SET NULL so a pin OUTLIVES the message it points at — the
 * snapshot_* columns freeze the author/body/styling at pin time so a
 * soft-/hard-deleted message still reads as a pinned card (same convention as
 * bookmarks + reply snapshots). `sortOrder` drives the strip's manual order;
 * `serverId` is null on the default server, carried for per-server scoping.
 * unique(roomId, messageId) blocks double-pinning. Gated by the `pin_message`
 * global permission (seeded to mod + admin). */
export const pinnedMessages = sqliteTable(
  "pinned_messages",
  {
    id: id(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /** SET NULL so the pin survives the message; the snapshot columns render it. */
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Owning server; null on the default server. Carried for per-server queries. */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
    pinnedByUserId: text("pinned_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Snapshot of who pinned it (survives that account's deletion). */
    pinnedByDisplayName: text("pinned_by_display_name"),
    pinnedAt: integer("pinned_at", { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`),
    /** Manual ordering within a room's pinned strip. */
    sortOrder: integer("sort_order").notNull().default(0),
    /* ---- snapshot of the pinned message at pin time ---- */
    authorUserId: text("author_user_id"),
    authorCharacterId: text("author_character_id"),
    displayName: text("display_name"),
    kind: text("kind"),
    body: text("body"),
    color: text("color"),
    cmdCss: text("cmd_css"),
    sceneImageUrl: text("scene_image_url"),
    bodyHtml: text("body_html"),
    /** Original message createdAt (ms) at pin time. */
    origCreatedAt: integer("orig_created_at"),
    /**
     * 18+ stamp of the source message frozen at pin time (migration 0340,
     * age-restriction plan). Live pins keep filtering for minors via the
     * live `messages.isNsfw` join (which also catches a later forum
     * re-tag); this frozen copy is what filters a SNAPSHOT-ONLY pin
     * (source hard-deleted/retention-expired, messageId NULL) out of
     * minor reads. Pins whose source expired before 0340 stay 0
     * (unrecoverable; see the migration comment).
     */
    isNsfw: integer("is_nsfw", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    roomMsgUq: uniqueIndex("pinned_messages_room_msg_uq").on(t.roomId, t.messageId),
    roomSortIdx: index("pinned_messages_room_sort_idx").on(t.roomId, t.sortOrder),
  }),
);

/* ---------- per-channel reads + notify prefs (migration 0318) ----------
 * Per-(user, room) unread tracking + per-room mute. Both mirror the
 * (user, room) composite-PK / cascade-FK shape of `mutes` + `room_members`.
 *
 * `room_reads` is the high-water mark: `lastReadAt` (ms) is how far the user
 * has read, `lastReadMessageId` snapshots the exact anchor so a retention
 * sweep can't lose the position. Absent row = never read.
 *
 * `per_room_notify_prefs` is the per-room mute: `muted` suppresses the unread
 * badge + per-room ping; `mutedUntil` (ms, nullable) is a timed mute that
 * lazily expires (null = indefinite while `muted`). The `room:unread` socket
 * event carries the live delta. */
export const roomReads = sqliteTable(
  "room_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /** ms high-water mark: the user has read this room up to here. */
    lastReadAt: integer("last_read_at").notNull().default(0),
    /** Exact message the mark points at (survives a retention re-anchor); null = by timestamp only. */
    lastReadMessageId: text("last_read_message_id"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.roomId] }),
    roomIdx: index("room_reads_room_idx").on(t.roomId),
  }),
);
export type DbRoomRead = typeof roomReads.$inferSelect;

export const perRoomNotifyPrefs = sqliteTable(
  "per_room_notify_prefs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /** When true, no unread badge + no per-room ping for this room. */
    muted: integer("muted", { mode: "boolean" }).notNull().default(false),
    /** Timed mute expiry (ms); null = indefinite while `muted`. Lazily expired. */
    mutedUntil: integer("muted_until", { mode: "timestamp_ms" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.roomId] }),
    roomIdx: index("per_room_notify_prefs_room_idx").on(t.roomId),
  }),
);
export type DbPerRoomNotifyPref = typeof perRoomNotifyPrefs.$inferSelect;

/* =====================================================================
 *  Emoticon reactions
 * =====================================================================
 *
 * Discord-style sticker reactions. Sheets are 4×4 sprite-sheet images
 * uploaded by admins (or seeded at boot for the defaults). Each cell
 * carries a label; cells with an empty / "empty" label are hidden from
 * the picker but still occupy their grid slot so admins can fill them
 * in later without renumbering existing reactions.
 *
 * Polymorphic target: a reaction attaches to a chat message, a DM, or
 * (reserved) a forum post. SQLite can't enforce a discriminated FK so
 * the app validates the target; cleanup triggers in migration 0146
 * cascade orphan reactions when the source row is deleted.
 */
export const emoticonSheets = sqliteTable(
  "emoticon_sheets",
  {
    id: id(),
    /** Stable client-facing identifier (URL-safe, unique). The picker
     *  uses it instead of the opaque row id. */
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    /** Relative URL to the sprite-sheet image. Defaults point at
     *  /assets/emoticons/<file>.png (bundled); uploads point at
     *  /uploads/emoticons/<id>.png. */
    imageUrl: text("image_url").notNull(),
    /** JSON array of EXACTLY 16 labels (4×4 row-major). Empty string
     *  or the literal "empty" hides the cell from the picker. */
    cells: text("cells")
      .notNull()
      .default('["","","","","","","","","","","","","","","",""]'),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * Moderation lifecycle (migration 0151).
     *   'approved', admin-created OR admin-approved user submission.
     *                Only these surface in the user-facing picker.
     *   'pending' , user submission awaiting review.
     *   'rejected', submission denied; Currency was refunded; the
     *                image file has been deleted from disk but the
     *                row is retained for the moderation audit trail.
     * Open string (no DB CHECK) so future states ('flagged', etc.)
     * don't need a migration.
     */
    status: text("status").notNull().default("approved"),
    /** Scope of the paying identity on submission. 'user' = master
     *  pool, 'character' = that character's pool. Null for admin-
     *  created rows (no payment flow). */
    submitterScope: text("submitter_scope"),
    /** Matching ownerId for the refund debit-reverse. user.id when
     *  scope='user', characters.id when scope='character'. */
    submitterPoolId: text("submitter_pool_id"),
    /** Snapshot of the cost paid at submission time. Used by the
     *  reject path so an admin can't accidentally refund a different
     *  amount after retuning the catalog price. */
    costPaid: integer("cost_paid"),
    /** Moderation timestamp / actor / reason. All null on pending or
     *  never-reviewed (admin-created) rows. */
    reviewedAt: integer("reviewed_at"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    rejectionReason: text("rejection_reason"),
    /**
     * Community-commerce toggle (migration 0177). When 1 (default), a
     * community sheet's emoticons cost `COMMUNITY_EMOTICON_USE_COST`
     * Currency per use, paid to the creator. When 0, uses are free
     * (the sheet still appears in the Community tab; the picker just
     * skips the debit/credit transaction). System sheets ignore this
     * flag, they're always free.
     */
    commerceEnabled: integer("commerce_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    /**
     * Denormalized usage counter (migration 0177). Bumped on every
     * successful community-use call regardless of whether commerce is
     * enabled. Powers the "Top used" sort in the picker's Community
     * tab without forcing a COUNT(*) over the earning ledger on every
     * picker open.
     */
    useCount: integer("use_count").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    /**
     * Scope discriminator (migration 0278g). NULL = platform-shared sheet; a
     * server_id scopes the sheet to that server's flavor/content. ON DELETE
     * SET NULL so deleting a server un-scopes its sheets rather than destroying
     * them.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    serverIdx: index("emoticon_sheets_server_idx").on(t.serverId),
  }),
);

export const messageReactions = sqliteTable(
  "message_reactions",
  {
    id: id(),
    /** 'chat_message' → messages.id ; 'dm' → direct_messages.id ;
     *  'forum_post' reserved for when the forum lands. */
    targetKind: text("target_kind", {
      enum: ["chat_message", "dm", "forum_post"],
    }).notNull(),
    targetId: text("target_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Identity snapshot at reaction time. Null = master handle. */
    characterId: text("character_id").references(() => characters.id, {
      onDelete: "set null",
    }),
    /** Display name snapshot, survives renames the same way
     *  messages.displayName does. */
    displayName: text("display_name").notNull(),
    /** Legacy sheet ref. Nullable since migration 0181, set when the
     *  reaction came from a sheet pick. Mutually exclusive with
     *  `unicodeChar`. App layer polices the "exactly one" rule. */
    sheetId: text("sheet_id")
      .references(() => emoticonSheets.id, { onDelete: "cascade" }),
    /** 0..15 row-major. Null when `unicodeChar` is set. */
    cellIndex: integer("cell_index"),
    /** Raw Unicode codepoint(s) for emoji-style reactions added via
     *  the Unicode tab in the picker. Mutually exclusive with the
     *  sheet ref above. Capped at 16 chars to cover even the longest
     *  compound RGI sequences (ZWJ families etc.) without leaving the
     *  column open to arbitrary string dumping. */
    unicodeChar: text("unicode_char"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    /** Discord rule: one user, one emoji, one target. Across both ref
     *  shapes, the index is keyed on a normalized COALESCE expression
     *  per migration 0181. Drizzle doesn't model expression indexes
     *  natively; we still declare the column tuple here so the
     *  migration runner picks up the index by name and the application
     *  doesn't drift from the DB-level constraint. */
    uniq: uniqueIndex("message_reactions_uniq")
      .on(t.targetKind, t.targetId, t.userId, t.sheetId, t.cellIndex, t.unicodeChar),
    /** Hot read path: render the ReactionBar for visible rows. */
    targetIdx: index("message_reactions_target_idx").on(t.targetKind, t.targetId),
    /** Defense-in-depth: user reaction history lookups. */
    userIdx: index("message_reactions_user_idx").on(t.userId),
  }),
);

export type DbEmoticonSheet = typeof emoticonSheets.$inferSelect;
export type DbMessageReaction = typeof messageReactions.$inferSelect;
export type DbRoom = typeof rooms.$inferSelect;
export type DbRoomMember = typeof roomMembers.$inferSelect;
export type DbMessage = typeof messages.$inferSelect;
export type DbBookmark = typeof bookmarks.$inferSelect;
export type DbPinnedMessage = typeof pinnedMessages.$inferSelect;
export type DbRoomThreadCategory = typeof roomThreadCategories.$inferSelect;
