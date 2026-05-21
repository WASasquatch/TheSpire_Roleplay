import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const ts = (name: string) =>
  integer(name, { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`);

/* ---------- users ---------- */
export const users = sqliteTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    /** the master/login username - display fallback when no character is active */
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["user", "trusted", "mod", "admin", "masteradmin"] }).notNull().default("user"),
    /** master profile body (sanitized HTML) shown when /char clear */
    bioHtml: text("bio_html").notNull().default(""),
    avatarUrl: text("avatar_url"),
    /**
     * Owner opt-in to surface the avatar as the first tile in the
     * portrait gallery on this profile. When true and avatarUrl is
     * set, profile-lookup prepends a synthetic gallery entry
     * (id="avatar") so viewers see the avatar alongside the rest of
     * the gallery without the user having to duplicate the URL into
     * a real user_portraits row (which would dangle a stale copy on
     * the next avatar change). Default false; the editor's
     * "Include in Gallery" checkbox in the Avatar section flips it.
     */
    includeAvatarInGallery: integer("include_avatar_in_gallery", { mode: "boolean" }).notNull().default(false),
    /** OOC gender - used for the icon next to the master username when no character is active. */
    gender: text("gender", {
      enum: ["male", "female", "nonbinary", "other", "undisclosed"],
    }).notNull().default("undisclosed"),
    /** Hex color (e.g. "#990000") applied to this user's messages and actions. Null = default. */
    chatColor: text("chat_color"),
    /** Master account UI theme - JSON-serialized Theme. Null = default. */
    themeJson: text("theme_json"),
    /**
     * Per-user override for the theme style axis ('medieval', 'modern',
     * 'scifi'). Null = follow `site_settings.default_style_key`. Style is
     * orthogonal to palette — picking a style doesn't change which colors
     * the user sees, just how the ornaments are drawn.
     */
    styleKey: text("style_key"),
    /**
     * Free-form CSS font-family stack applied to the entire signed-in UI
     * via the `--keep-font-family` CSS variable. Null = use the default
     * chat font stack. Accessibility feature for users who need a
     * different typeface (e.g. dyslexia-friendly fonts, larger x-height
     * sans-serifs). Whatever CSS rejects silently falls back to the next
     * declared font in the stack, so a bad value degrades gracefully.
     */
    uiFontFamily: text("ui_font_family"),
    /**
     * Discrete font-size tier: 'small' | 'medium' | 'large' | 'xl'.
     * Null = 'medium' (default 16px base). The client maps the enum to a
     * px value and sets the document font-size, which scales every
     * rem-based Tailwind utility uniformly. Kept as a tier rather than a
     * free numeric to constrain the choice and keep the UI readable at
     * every step.
     */
    uiFontScale: text("ui_font_scale"),
    /**
     * Desktop notification preference:
     *   "off"      - never show toasts
     *   "mentions" - only whispers + announcements
     *   "all"      - every message in rooms you're in
     */
    notifyPref: text("notify_pref", { enum: ["off", "mentions", "all"] })
      .notNull()
      .default("mentions"),
    /**
     * Per-user DM opt-out. `true` (default) lets other users start a
     * direct message thread; `false` makes /me/dms/with/:target return
     * 403 with `error: "dms_disabled"` so the client can render a
     * "this user has DMs turned off" affordance instead of a generic
     * failure. Stored as INTEGER 0/1 in SQLite via Drizzle's boolean
     * mode (matches isPublic / isNsfw posture nearby).
     */
    dmsEnabled: integer("dms_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    /**
     * Per-event in-app sound toggles. All three default to on — opt out,
     * not opt in — so a fresh sign-in hears notifications. Each maps to
     * one bundled mp3 in apps/web/public/audio:
     *   soundDmEnabled    → ping.mp3  (inbound DMs)
     *   soundChatEnabled  → tap.mp3   (inbound chat messages + actions)
     *   soundAlertEnabled → alert.mp3 (announcements / system events)
     */
    soundDmEnabled: integer("sound_dm_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    soundChatEnabled: integer("sound_chat_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    soundAlertEnabled: integer("sound_alert_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    /**
     * Per-event whisper sound (whisper.mp3). Split out from
     * `soundDmEnabled` once the project shipped a fourth audio file
     * dedicated to whispers — previously both DM and whisper rode
     * the same `ping` event because we only had three sound assets.
     * Default on, opt-out, matching the other sound prefs.
     */
    soundWhisperEnabled: integer("sound_whisper_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    /**
     * Per-user input-behavior toggles. Both default off (= feature on).
     *   disableInputHistory — kills ArrowUp/ArrowDown command-history
     *                         recall in the composer. Some users brush
     *                         the arrows while moving the cursor and
     *                         want the recall gone.
     *   disableThesaurus    — kills the synonym popup that opens when
     *                         a word is highlighted. Annoying to users
     *                         who highlight just to copy.
     */
    disableInputHistory: integer("disable_input_history", { mode: "boolean" })
      .notNull()
      .default(false),
    disableThesaurus: integer("disable_thesaurus", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * Userlist display preference. When true AND the user has a
     * resolved rank, the rooms-tree row renders the rank sigil in
     * place of the gender glyph (saves horizontal space and makes
     * the rank itself the profile click target). When false (default)
     * or when no rank is resolved, the gender glyph renders as
     * before and no rank sigil is shown next to the name.
     */
    useRankAsUserlistIcon: integer("use_rank_as_userlist_icon", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * Display + privacy prefs (migration 0077).
     *
     *   showRankInUserlist — default true. When false, the user's
     *     userlist row drops back to the gender glyph instead of the
     *     rank gem. Broadcast.ts nulls the occupant's rankKey/tier
     *     when this is off, so the existing UserNameTag conditional
     *     ("show rank if rank exists, else gender") naturally falls
     *     through to the gender path without needing extra props.
     *   showRankInChat — default true. When false, addMessage
     *     snapshots null rank fields on outgoing messages from this
     *     author. Affects FUTURE sends only; past messages keep
     *     whatever was snapshotted at the time.
     *
     *   hideChatMessageCount / hideForumTopicCount / hideForumReplyCount
     *     — default false. When true, the corresponding counter on
     *     `ProfileMetrics` returns null instead of the real number,
     *     and the ProfileModal renders "private" in its place. The
     *     three counters are independent so users can hide just the
     *     one they're shy about.
     */
    showRankInUserlist: integer("show_rank_in_userlist", { mode: "boolean" })
      .notNull()
      .default(true),
    showRankInChat: integer("show_rank_in_chat", { mode: "boolean" })
      .notNull()
      .default(true),
    hideChatMessageCount: integer("hide_chat_message_count", { mode: "boolean" })
      .notNull()
      .default(false),
    hideForumTopicCount: integer("hide_forum_topic_count", { mode: "boolean" })
      .notNull()
      .default(false),
    hideForumReplyCount: integer("hide_forum_reply_count", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Free-text "away" reason; null means the user is present. */
    awayMessage: text("away_message"),
    awaySince: integer("away_since", { mode: "timestamp_ms" }),
    /** Free-text current mood/expression (e.g. "angry", "wounded"). Null = no mood set. Capped at 32 chars; rendered as a chip next to the user's name on outgoing messages. */
    currentMood: text("current_mood"),
    /** FK to characters.id - nullable means "show master profile" */
    activeCharacterId: text("active_character_id"),
    /**
     * Public visibility flag for the master profile.
     *   - true (default): /profiles/:username returns the full profile to
     *     anyone, including anonymous viewers.
     *   - false: anonymous viewers get a `private: true` stub (HTTP 200,
     *     so the splash can render a "this profile is private — sign in"
     *     hint without confusing fetch() error handling); logged-in
     *     viewers always see the full profile (private == "members can
     *     view"); the owner and admins always see the full profile.
     */
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(true),
    /**
     * Whole-profile NSFW flag. Independent of per-portrait nsfw blurring.
     * Anonymous viewers of an NSFW profile get the same `private: true`
     * stub as a non-public profile. Logged-in viewers see the full
     * profile but with a "View Profile" warning gate before the body
     * renders — the gate is per-modal-mount so closing and reopening
     * re-prompts. The owner and admins always see the content with no
     * gate.
     */
    isNsfw: integer("is_nsfw", { mode: "boolean" }).notNull().default(false),
    /**
     * Hash of the new-user welcome message this user has acknowledged.
     * Compared against the current site-settings hash on /me/profile to
     * decide whether to surface the welcome modal. Null = never seen any
     * welcome (any non-empty message will show on next load).
     */
    welcomeSeenHash: text("welcome_seen_hash"),
    /**
     * Last room the user occupied when their previous session disconnected
     * or idled out. Set on disconnect / room switch; consumed on the next
     * connect to drop them back where they were. Null = first connect, or
     * the previous room has since been deleted.
     *
     * FK enforcement: the `REFERENCES rooms(id) ON DELETE SET NULL` clause
     * is declared at the DB layer in migration 0036 — not modeled here in
     * Drizzle's TS schema because pairing it with `rooms.ownerId → users.id`
     * forms a mutual-reference cycle that collapses both tables' inferred
     * types to `any`. The runtime constraint is unchanged; only the type-
     * level FK metadata is omitted, and no `relations()` API consumers
     * depend on it in this codebase.
     */
    lastRoomId: text("last_room_id"),
    /**
     * Public-profile background image URL. When set, the profile modal
     * paints this on its backdrop (the area outside the modal card) so
     * visitors landing on /p/<username> see the owner's chosen image
     * instead of the default spire splash. NULL = use default.
     */
    publicProfileBgUrl: text("public_profile_bg_url"),
    /**
     * CSS sizing strategy for `publicProfileBgUrl`. Stored as the
     * literal mode key ("cover" | "contain" | "tile" | "stretch")
     * that the client maps to `background-size`/`background-repeat`
     * pairs. Default "cover" — most forgiving for typical landscape
     * illustrations. See migration 0117 for the full table.
     */
    publicProfileBgMode: text("public_profile_bg_mode").notNull().default("cover"),
    createdAt: ts("created_at"),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    // Email is no longer unique at the DB layer; the per-account cap is
    // configurable via site_settings.max_accounts_per_email and enforced
    // in /auth/register. Username remains uniquely indexed.
    emailIdx: index("users_email_idx").on(sql`lower(${t.email})`),
    usernameUq: uniqueIndex("users_username_uq").on(sql`lower(${t.username})`),
  }),
);

/* ---------- characters ---------- */
export const characters = sqliteTable(
  "characters",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    bioHtml: text("bio_html").notNull().default(""),
    /** structured stats serialized as JSON; see CharacterStats in @thekeep/shared */
    statsJson: text("stats_json").notNull().default("{}"),
    avatarUrl: text("avatar_url"),
    /** Mirrors users.includeAvatarInGallery — per-character opt-in to
     *  surface the avatar as the first tile in this character's
     *  portrait gallery. See the comment on users.includeAvatarInGallery
     *  for the rationale; the editor flag is the same checkbox. */
    includeAvatarInGallery: integer("include_avatar_in_gallery", { mode: "boolean" }).notNull().default(false),
    /** Per-character chat color (hex, e.g. "#990000"). Null = inherit the master's color. */
    chatColor: text("chat_color"),
    /** Per-character UI theme - JSON-serialized Theme. Null = inherit master/default. */
    themeJson: text("theme_json"),
    /**
     * Per-character override for the theme STYLE axis ('medieval',
     * 'modern', 'scifi'). Null = fall through the resolution chain:
     * users.style_key → theme-pinned design (from
     * site_settings.theme_design_map) → site_settings.default_style_key.
     * Mirrors `themeJson` above — character can fully reskin the site
     * when active, design and all.
     */
    styleKey: text("style_key"),
    /** Same semantics as users.is_public - public = anonymous can view this character's profile. */
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(true),
    /** Same semantics as users.is_nsfw - forces private + adds a viewer gate splash. */
    isNsfw: integer("is_nsfw", { mode: "boolean" }).notNull().default(false),
    /** Mirrors users.publicProfileBgUrl — per-character public-profile backdrop image. NULL = use default. */
    publicProfileBgUrl: text("public_profile_bg_url"),
    /** Mirrors users.publicProfileBgMode — "cover" | "contain" | "tile" | "stretch". */
    publicProfileBgMode: text("public_profile_bg_mode").notNull().default("cover"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    userNameUq: uniqueIndex("characters_user_name_uq")
      .on(t.userId, sql`lower(${t.name})`),
    userIdx: index("characters_user_idx").on(t.userId),
  }),
);

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
     * "flat" (default) - replies render at the chronological end of chat.
     * "nested" - replies render under their parent in a collapsible thread
     * with a "View More" expander past the latest 5. Owner/mod toggleable.
     */
    replyMode: text("reply_mode", { enum: ["flat", "nested"] })
      .notNull()
      .default("flat"),
    /**
     * Set when the last live socket leaves a user-created room. The
     * row is kept (settings + name reservation) so a future create
     * with the same lowercased name can resurrect the room with the
     * new caller as owner. Excluded from rooms-tree / search / join
     * queries — archived rows are effectively invisible until
     * resurrected. Null for active rooms; null for system rooms
     * permanently (they're never archived).
     */
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    nameUq: uniqueIndex("rooms_name_uq").on(sql`lower(${t.name})`),
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
      enum: ["say", "me", "cmd", "system", "whisper", "roll", "announce", "scene", "npc", "ooc"],
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
    /** Snapshot of the recipient's display name at send time (whispers only). */
    toDisplayName: text("to_display_name"),
    /** Id of the message this one is a reply to. Not a FK - if the parent is deleted we still keep the dangling id and render gracefully. */
    replyToId: text("reply_to_id"),
    /** Snapshot of parent author's display name (so renames/deletes don't blank the preview). */
    replyToDisplayName: text("reply_to_display_name"),
    /** Truncated snapshot of parent body for the inline quote preview. */
    replyToBodySnippet: text("reply_to_body_snippet"),
    /** Snapshot of the author's mood/expression at send time (or null). */
    moodSnapshot: text("mood_snapshot"),
    /** For /npc messages, the master username of the user who voiced this NPC (accountability tag rendered next to the NPC name). */
    npcVoicedBy: text("npc_voiced_by"),
    /**
     * Thread category bucket — only meaningful for top-level messages in
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
     * the existing `displayName` snapshot pattern for the author —
     * keeps the audit coherent if the actor later renames or has
     * their account deleted.
     */
    deletedByDisplayName: text("deleted_by_display_name"),
    /**
     * Set when the topic has been locked (author or moderator action).
     * Only meaningful for top-level topics in nested-mode rooms — the
     * server rejects new replies under a locked topic. Stored as a
     * timestamp (ms) instead of a boolean so future audit surfaces can
     * show "locked at..."; the client only reads the truthiness.
     */
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    /**
     * Timestamp of the most recent reply under this row (or its own
     * createdAt when no replies exist). Only meaningful for top-level
     * topics in nested-mode rooms — the forum-topics endpoint orders
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
    /**
     * Server-validated CSS snapshot for `kind: "cmd"` rows. Frozen on the
     * row at send time so a later edit to the underlying custom command's
     * CSS doesn't restyle historical messages — same snapshot pattern used
     * for `display_name`, `color`, etc. Null on every other kind.
     */
    cmdCss: text("cmd_css"),
    /**
     * Earning rank snapshot at send time — drives the chat-line sigil.
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
     * rankKey / tier snapshot posture — a later toggle (or the
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

/* ---------- character journal entries ---------- */
/**
 * Solo writing the owner attaches to a character: backstory fragments,
 * in-world diary entries, world notes, scenes too quiet for chat. Public
 * entries surface on the character's profile chronologically (oldest
 * first - reads like a diary). Private entries are owner-only.
 *
 * `bodyHtml` is run through `sanitizeBio` on save (same allow-list as
 * the bio). Rendered as React via the prose styles, never via
 * dangerouslySetInnerHTML.
 */
export const characterJournalEntries = sqliteTable(
  "character_journal_entries",
  {
    id: id(),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    title: text("title"),
    bodyHtml: text("body_html").notNull(),
    privacy: text("privacy", { enum: ["public", "private"] })
      .notNull()
      .default("public"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    charIdx: index("character_journal_char_idx").on(t.characterId, t.createdAt),
  }),
);

/* ---------- character portraits ---------- */
export const characterPortraits = sqliteTable(
  "character_portraits",
  {
    id: id(),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    label: text("label"),
    /** Manual ordering for the gallery. Lower values render first. */
    sortOrder: integer("sort_order").notNull().default(0),
    /** Owner-set NSFW flag - viewers see a blurred tile with a click-to-reveal overlay. */
    nsfw: integer("nsfw", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
  },
  (t) => ({
    charIdx: index("character_portraits_char_idx").on(t.characterId, t.sortOrder),
  }),
);

/* ---------- user (OOC / master) portraits ----------
 * Parallel to character_portraits but keyed on userId. Powers the
 * gallery on master profiles — same shape, same per-portrait NSFW
 * gate, same sort_order semantics — so OOC profiles can show
 * additional images alongside the hero avatar the way character
 * profiles do.
 */
export const userPortraits = sqliteTable(
  "user_portraits",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    label: text("label"),
    sortOrder: integer("sort_order").notNull().default(0),
    nsfw: integer("nsfw", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
  },
  (t) => ({
    userIdx: index("user_portraits_user_idx").on(t.userId, t.sortOrder),
  }),
);

/* ---------- bans ---------- */
export const bans = sqliteTable(
  "bans",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    until: integer("until", { mode: "timestamp_ms" }),
    reason: text("reason"),
    issuedById: text("issued_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roomId, t.userId] }),
  }),
);

/* ---------- mutes (per-room timed silence) ----------
 * A muted user remains *in* the room (they can read) but cannot send
 * chat:input for that room until `until`. Set by /mute, cleared by
 * /unmute or by expiry. Distinct from `bans`, which prevents joining.
 */
export const mutes = sqliteTable(
  "mutes",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    until: integer("until", { mode: "timestamp_ms" }).notNull(),
    reason: text("reason"),
    issuedById: text("issued_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roomId, t.userId] }),
  }),
);

/* ---------- ignores (per-user mute list) ---------- */
export const ignores = sqliteTable(
  "ignores",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ignoredUserId: text("ignored_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.ignoredUserId] }),
  }),
);

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
  },
  (t) => ({
    nameUq: uniqueIndex("custom_commands_name_uq").on(sql`lower(${t.name})`),
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

/* ---------- sessions ----------
 * Server-side session store. We use httpOnly cookies referencing a row here,
 * not JWTs - easier to revoke (e.g. on /banish or password reset).
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: ts("created_at"),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
  }),
);

/* ---------- nav_links ----------
 * Banner links rendered next to the user's session controls. Admins manage
 * these; everyone reads them. The Exit link is hard-coded in the client and
 * is NOT modeled here - admins shouldn't be able to remove the logout path.
 */
export const navLinks = sqliteTable("nav_links", {
  id: id(),
  label: text("label").notNull(),
  href: text("href").notNull(),
  /** Lower numbers render first; ties broken by createdAt. */
  position: integer("position").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** "_self" stays in this tab; "_blank" opens a new one. */
  target: text("target", { enum: ["_self", "_blank"] }).notNull().default("_blank"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

/* ---------- site_settings ----------
 * Single-row table holding sitewide admin-managed configuration:
 *   - message retention (older messages are swept by a periodic job)
 *   - session/idle TTL (max session lifetime in ms)
 *   - default theme (used when a user has no custom theme + no active char
 *     theme; null falls back to the built-in DEFAULT_THEME)
 *
 * The single row is identified by id="singleton" - the seed step ensures
 * it always exists. PK enforces uniqueness.
 */
export const siteSettings = sqliteTable("site_settings", {
  id: text("id").primaryKey().default("singleton"),
  /** ms; 0 = retain messages forever */
  messageRetentionMs: integer("message_retention_ms").notNull().default(0),
  /** ms; controls expiresAt for new sessions issued after the change */
  sessionTtlMs: integer("session_ttl_ms").notNull().default(30 * 24 * 60 * 60 * 1000),
  /**
   * ms; how long a disconnected user lingers in the userlist as an
   * "idle" ghost before being dropped. Default 30 minutes. Overrides
   * the long sessionTtlMs for *visible presence* only — session
   * validity itself is governed by sessionTtlMs. See migration
   * 0115_idle_grace_ms for the full rationale.
   */
  idleGraceMs: integer("idle_grace_ms").notNull().default(30 * 60 * 1000),
  /** JSON-serialized Theme; null = use built-in DEFAULT_THEME */
  defaultThemeJson: text("default_theme_json"),
  /** Public site name shown in the banner, login screen, and tab title. */
  siteName: text("site_name").notNull().default("The Spire"),
  /**
   * Canonical public URL the banner logo links to. Empty string = no
   * link wrapping; the logo renders as a non-interactive element.
   * When set, the banner wraps the logo text or image in an `<a>`
   * pointing at this URL — styling stays identical to the unwrapped
   * version (no underline, no color change). Useful for pointing at a
   * marketing landing page, the project README, or just the site's
   * own home page when the chat lives at a different subdomain.
   */
  siteUrl: text("site_url").notNull().default(""),
  /**
   * Optional CSS background applied to the banner behind the logo. Stored as a
   * full CSS background shorthand so admins can use a url(), gradient, or
   * solid color (e.g. "url(/uploads/banner.jpg) center/cover no-repeat").
   * Null = no override; the banner uses the theme's panel color.
   */
  bannerCoverCss: text("banner_cover_css"),
  /** Hex color override for the logo text. Null = inherit theme text color. */
  logoColor: text("logo_color"),
  /**
   * CSS font-family override for the logo text. Should be a safe stack like
   * `"Cinzel", "Georgia", serif`. Null = use the theme's `font-action` stack.
   */
  logoFont: text("logo_font"),
  /**
   * URL for the logo image rendered in place of the `siteName` text in the
   * banner + splash. Defaults to the SPA-bundled `/thespire-logo.png`; can
   * be overridden via /admin/settings (any URL) or replaced via
   * /admin/upload/logo (writes under /uploads and updates this column).
   * Empty string = no logo, fall back to the text title.
   */
  logoUrl: text("logo_url").notNull().default("/thespire-logo.png"),
  /** Hard cap on characters per user account. */
  maxCharactersPerUser: integer("max_characters_per_user").notNull().default(100),
  /**
   * Cap on how many user accounts may share the same (case-insensitive)
   * email. 1 = traditional one-account-per-email; raise for shared/family
   * accounts or demo flows. The unique email index was dropped in 0012 so
   * this is enforced in code rather than by the DB.
   */
  maxAccountsPerEmail: integer("max_accounts_per_email").notNull().default(1),
  /** Cap on user-created rooms with one user as owner (system rooms exempt). */
  maxRoomsPerOwner: integer("max_rooms_per_owner").notNull().default(25),
  /** Hard cap on chat message body length (matches dispatch.ts MAX_BODY default). */
  maxMessageLength: integer("max_message_length").notNull().default(4000),
  /**
   * Hard cap on direct-message body length. Independent of chat so admins
   * can give DMs a longer write surface (long-form back-and-forth between
   * two people often needs more room than public chat); defaults to the
   * same value as chat so behavior is unchanged unless explicitly tuned.
   */
  maxDirectMessageLength: integer("max_direct_message_length").notNull().default(4000),
  /**
   * Hard cap on forum post body length (topics + replies in nested-mode
   * rooms). Separate from chat because forum bodies are typically
   * longer-form (worldbuilding posts, lore drops, multi-paragraph
   * replies) and admins often want a larger ceiling than for chat.
   */
  maxForumPostLength: integer("max_forum_post_length").notNull().default(8000),
  /**
   * Hard cap on the topic title at the top of a forum thread. Capped
   * because titles are list-rendered in the topic-picker UI and a
   * runaway title would push other rows off-screen.
   */
  maxForumTopicTitleLength: integer("max_forum_topic_title_length").notNull().default(120),
  /**
   * Author-edit / author-delete grace window in ms. After this many
   * ms since createdAt, edits and deletes are rejected for the author.
   * Mods and admins bypass the gate entirely. Forum (nested) rooms
   * ignore this and allow indefinite edits — the (edited) badge is
   * the transparency signal there. Default 300_000 (5 min).
   */
  editGraceMs: integer("edit_grace_ms").notNull().default(300_000),
  /** Hard cap on profile bio HTML length (master + character bios). */
  maxBioLength: integer("max_bio_length").notNull().default(50_000),
  /** Master switch - when false, /auth/register returns 503. */
  registrationOpen: integer("registration_open", { mode: "boolean" }).notNull().default(true),
  /**
   * Sanitized welcome HTML rendered above the login/register form on the
   * splash screen. Empty string = the splash shows just the form.
   */
  welcomeHtml: text("welcome_html").notNull().default(""),
  /**
   * Sanitized HTML rendered in the Rules modal. Migration 0015 seeds a
   * baseline 8-point code of conduct; admins customize freely. The schema
   * default is empty here - the SQL DEFAULT in the migration is what
   * actually populates new rows, so drizzle keeps this column out of
   * inserts and lets SQLite apply the seeded default.
   */
  rulesHtml: text("rules_html").notNull().default(""),
  /**
   * Sanitized HTML rendered in the Rules modal as the privacy/safety
   * notice. Same default-source story as rulesHtml: migration 0015 seeds
   * the canonical "admins cannot read private/whisper content" text.
   */
  securityNoticeHtml: text("security_notice_html").notNull().default(""),
  /**
   * Sanitized HTML rendered above the register form on the splash. Migration
   * 0016 seeds a default disclaimer covering: free-form RP, views not those
   * of operators/software, potentially offensive themes, be respectful OOC.
   * Users must tick an "I agree" checkbox before /auth/register will succeed.
   */
  registerDisclaimerHtml: text("register_disclaimer_html").notNull().default(""),
  /**
   * Plain-text description used by search engines and social previews
   * (rendered into <meta name="description">, og:description, and
   * twitter:description on the splash). Admins write the ~150-character SEO
   * summary they want crawlers to see.
   */
  metaDescription: text("meta_description").notNull().default(""),
  /**
   * Verbatim HTML injected into <head> on the server-rendered splash for
   * analytics scripts (Plausible / GA4 / Cloudflare / Umami / etc.). NOT
   * sanitized - admins paste from their provider's dashboard. Admin-only
   * surface; non-admin write paths don't exist for this column.
   */
  customHeadHtml: text("custom_head_html").notNull().default(""),
  /** Web Push VAPID keys. Generated at first server boot and persisted so deploys don't churn keys (which would invalidate every existing subscription). NEVER expose `vapidPrivateKey` to clients. */
  vapidPublicKey: text("vapid_public_key"),
  vapidPrivateKey: text("vapid_private_key"),
  /** Master toggle for surfacing live community activity (splash counters, future rails). Default off so cold-start installs don't telegraph "dead community" to first visitors. */
  activityFeedsEnabled: integer("activity_feeds_enabled", { mode: "boolean" }).notNull().default(false),
  /** Splash page renders a randomized carousel of up to 10 open worlds when enabled. Off by default so brand-new installs with a thin catalog don't show empty rotation. */
  featuredWorldsEnabled: integer("featured_worlds_enabled", { mode: "boolean" }).notNull().default(false),
  /**
   * Splash stat: surface the rolling 24h chat message count on the
   * splash. Independent of `activityFeedsEnabled` — each toggle gates
   * its own section of the splash stats row, so admins can show the
   * message count alone (just chat volume), the online/room counters
   * alone, or both together. When both are on, the splash renders
   * them in the same "· N stat" row so the cluster still reads as
   * one beat. Default off — see migration 0116 for the rationale.
   */
  splashMessages24hEnabled: integer("splash_messages_24h_enabled", { mode: "boolean" }).notNull().default(false),
  /** Sanitized HTML shown once to NEW users (registered after the welcome's last edit) until they dismiss it. Editing the text rotates a hash so the audience sees the new version on next load. */
  newUserWelcomeHtml: text("new_user_welcome_html").notNull().default(""),
  /** Timestamp of the most recent welcome-text edit. Null = never set. The audience filter is `users.created_at > new_user_welcome_updated_at`, so existing users at the time of the edit don't get retroactively spammed. */
  newUserWelcomeUpdatedAt: integer("new_user_welcome_updated_at", { mode: "timestamp_ms" }),
  /**
   * Site-wide default theme STYLE — orthogonal to the palette (`defaultThemeJson`).
   * Where palette decides colors, style decides visual treatment ('medieval',
   * 'modern', 'scifi' — each a full design language). Users who haven't picked
   * a per-user override (users.style_key IS NULL) inherit this. Migrations
   * seed 'medieval' as the launch flagship.
   */
  defaultStyleKey: text("default_style_key").notNull().default("medieval"),
  /**
   * JSON map of THEME PRESET NAME → design key (medieval/modern/scifi).
   * Lets admins pin a design to each named palette so picking "Twilight"
   * defaults to "scifi", "Parchment" to "medieval", etc. Resolution chain
   * sits between user/character explicit overrides and the site default:
   *   character.style_key > user.style_key > themeDesignMap[<preset>] >
   *   default_style_key > "medieval".
   * Null/missing = empty map (fall straight through to default_style_key).
   * Stored as JSON text rather than a relational table because the
   * preset list is fixed in code (THEME_PRESETS); admins only edit
   * the mapping, not the presets themselves.
   */
  themeDesignMap: text("theme_design_map"),
  /**
   * Tracks the iteration of DEFAULT_WORLDS content the system worlds were
   * last seeded from. `seed_worlds.ts` exports a SEED_VERSION constant; on
   * boot the seeder compares the two and overwrites all system-owned
   * worlds (name, description, pages) when the constant is higher. Lets
   * us ship richer content to the bundled worlds without forcing a
   * manual admin step on each deploy. 0 = never seeded under the
   * versioning scheme — implicitly v1.
   */
  worldsSeedVersion: integer("worlds_seed_version").notNull().default(0),
  /**
   * Earning system configuration — every numeric input the XP /
   * Currency / Rank engine touches. Stored as a single JSON blob
   * (versus 30+ flat columns) because the shape is deeply nested
   * (per-source × per-pool award amounts, transfer caps, backfill
   * settings, etc.) and admin edits replace the whole object via
   * the structured Awards-tab form. Null = engine reads the
   * DEFAULT_EARNING_CONFIG bundled in code; migration 0065 seeds
   * the same defaults into this column so the admin UI has a
   * concrete document to edit from day one.
   *
   * Shape: see EarningConfig in apps/server/src/earning/config.ts.
   */
  earningConfigJson: text("earning_config_json"),
  updatedAt: ts("updated_at"),
  updatedById: text("updated_by_id").references(() => users.id, { onDelete: "set null" }),
});

/* ---------- push subscriptions (Phase 4) ---------- */
/**
 * One row per browser/device a user has opted into push notifications from.
 * The Push API gives us an `endpoint` URL plus two encryption keys; the
 * server uses these to encrypt+sign payloads with `web-push`. Subscriptions
 * become invalid when the user revokes permission or the browser tosses the
 * registration; we GC by pruning on 410 responses from the push service.
 */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dhKey: text("p256dh_key").notNull(),
    authKey: text("auth_key").notNull(),
    createdAt: ts("created_at"),
    lastSeenAt: ts("last_seen_at"),
  },
  (t) => ({
    userIdx: index("push_subscriptions_user_idx").on(t.userId),
    endpointUq: uniqueIndex("push_subscriptions_endpoint_uq").on(t.userId, t.endpoint),
  }),
);

/* ---------- title_kinds ----------
 * Catalog of mutual-title types (marriage, partner, mentor, etc.). Admin-
 * managed. Each kind carries display formats for the A side (requester)
 * and B side (recipient); for symmetric kinds the two formats match.
 * `{target}` in either format is replaced with the other party's display
 * name when rendered into a profile.
 */
export const titleKinds = sqliteTable(
  "title_kinds",
  {
    id: id(),
    /** lowercased keyword used in /request <slug> <user>; unique. */
    slug: text("slug").notNull(),
    /** Human-readable name for admin UI ("Marriage", "Mentor / Apprentice"). */
    label: text("label").notNull(),
    /** When false, A and B sides render with different formats (mentor/apprentice). */
    symmetric: integer("symmetric", { mode: "boolean" }).notNull().default(true),
    /** Display string for the requester side. {target} = other party's name. */
    formatA: text("format_a").notNull(),
    /** Display string for the recipient side. Equal to formatA when symmetric. */
    formatB: text("format_b").notNull(),
    /** When true, an identity may hold at most one accepted title of this kind. */
    exclusive: integer("exclusive", { mode: "boolean" }).notNull().default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    slugUq: uniqueIndex("title_kinds_slug_uq").on(sql`lower(${t.slug})`),
  }),
);

/* ---------- mutual_titles ----------
 * In-flight or accepted relationship between two identities (an identity =
 * userId + nullable characterId; null = master account). The "A" side is
 * always the requester / dissolve initiator, the "B" side is the responder.
 *
 * Lifecycle:
 *   pending     - request created, recipient hasn't responded
 *   accepted    - both parties confirmed, title shows on each profile
 *   dissolving  - one party has asked to remove an accepted title; the
 *                 other side gets an Accept | Decline prompt. On Accept the
 *                 row is deleted; on Decline the status reverts to accepted.
 *
 * `dissolve_initiator` records which side asked to dissolve ("a" or "b")
 * so the prompt can be shown to the *other* side - it is null for any
 * status other than `dissolving`.
 *
 * Decline (whether on initial request or on a dissolve request) deletes
 * the row outright rather than retaining a record - declines are private.
 */
export const mutualTitles = sqliteTable(
  "mutual_titles",
  {
    id: id(),
    kindId: text("kind_id")
      .notNull()
      .references(() => titleKinds.id, { onDelete: "cascade" }),
    aUserId: text("a_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    aCharacterId: text("a_character_id").references(() => characters.id, { onDelete: "cascade" }),
    bUserId: text("b_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bCharacterId: text("b_character_id").references(() => characters.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "accepted", "dissolving"] })
      .notNull()
      .default("pending"),
    dissolveInitiator: text("dissolve_initiator", { enum: ["a", "b"] }),
    createdAt: ts("created_at"),
    respondedAt: integer("responded_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    aIdx: index("mutual_titles_a_idx").on(t.aUserId, t.aCharacterId),
    bIdx: index("mutual_titles_b_idx").on(t.bUserId, t.bCharacterId),
    kindIdx: index("mutual_titles_kind_idx").on(t.kindId),
  }),
);

/* ---------- affiliates / partners / sponsors ---------- */
/**
 * Splash-page carousel entries pointing at affiliate / partner / sponsor
 * sites. Stores raw HTML rather than a structured (url, image, alt) shape
 * because topsite networks like toprpsites require their own anchor +
 * tracking-pixel snippet that has to be pasted verbatim.
 *
 * `html` is admin-trusted and NOT sanitized server-side - admins paste from
 * the affiliate's own provided code. Same trust posture as customHeadHtml.
 * `label` is an admin-only nickname for sorting/identification; never rendered.
 */
export const affiliates = sqliteTable(
  "affiliates",
  {
    id: id(),
    label: text("label").notNull(),
    html: text("html").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    sortIdx: index("affiliates_sort_idx").on(t.enabled, t.sortOrder, t.createdAt),
  }),
);

/* ---------- profile links ---------- */
/**
 * Player-set links surfaced as styled chips on a profile. Each row is owned
 * by a user; `characterId` discriminates scope:
 *   - characterId IS NULL → link belongs to the user's master/OOC profile
 *   - characterId = <id>  → link belongs to that specific character
 *
 * Per-profile cap (6) is enforced in the route handler, not at the DB layer.
 */
export const profileLinks = sqliteTable(
  "profile_links",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    characterId: text("character_id").references(() => characters.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    /** Optional hex color (#rrggbb). Null = render with theme defaults. */
    borderColor: text("border_color"),
    bgColor: text("bg_color"),
    textColor: text("text_color"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
  },
  (t) => ({
    userIdx: index("profile_links_user_idx").on(t.userId, t.characterId, t.sortOrder),
  }),
);

/* ---------- worldbuilding (worlds + pages + room links) ---------- */
/**
 * Top-level world container owned by a user. Visibility tiers:
 *   - private: owner only
 *   - public:  anyone with the URL or who sees it linked from a room
 *   - open:    public + listed in the world catalog + non-owners can link
 *              it to rooms they own/mod
 *
 * Slug is unique per owner; routes use slug for friendly URLs and walk
 * back to id for joins. Cascade deletes the pages and any room links.
 */
export const worlds = sqliteTable(
  "worlds",
  {
    id: id(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    visibility: text("visibility", { enum: ["private", "public", "open"] })
      .notNull()
      .default("private"),
    /**
     * Per-world theme JSON. Applied only when rendering the world's editor /
     * viewer modals - never bleeds into chat or the userlist. Null = use the
     * viewer's chat theme as a fallback.
     */
    theme: text("theme"),
    /**
     * Catalog metadata. Validated as closed enums at the Zod layer (mirrors
     * `rooms.replyMode`); the DB column itself is plain TEXT so a missed
     * Zod entry doesn't crash existing rows. Defaults pick the "most
     * conservative" choice so legacy rows render sanely in the catalog
     * until their owners get around to setting real values.
     */
    genre: text("genre", {
      enum: [
        "fantasy", "modern", "scifi", "horror",
        "western", "steampunk", "mythological", "other",
      ],
    }).notNull().default("other"),
    /** Comma-separated lowercased tag list. Parsed via shared `parseTagList`. */
    tags: text("tags").notNull().default(""),
    /** Comma-separated lowercased content-warning list from the closed CONTENT_WARNINGS set. */
    contentWarnings: text("content_warnings").notNull().default(""),
    /** Admin-curated only for `"featured"`; owners can flip between `active` and `archived`. */
    status: text("status", { enum: ["active", "featured", "archived"] })
      .notNull()
      .default("active"),
    /** Public URL to the catalog cover image (uploaded via /worlds/:id/cover). Null = render text-only fallback. */
    coverImageUrl: text("cover_image_url"),
    /** Soft cadence signal for would-be members. Null = unspecified. */
    pacing: text("pacing", { enum: ["casual", "structured", "long-form"] }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    ownerSlugUq: uniqueIndex("worlds_owner_slug_uq").on(t.ownerUserId, sql`lower(${t.slug})`),
    visibilityIdx: index("worlds_visibility_idx").on(t.visibility, t.updatedAt),
    genreIdx: index("worlds_genre_idx").on(t.genre),
    statusIdx: index("worlds_status_idx").on(t.status),
  }),
);

/**
 * Tree-structured pages inside a world. parent_page_id NULL = top-level.
 * Cascade deletes children when a parent is removed (matches the "delete
 * cascades with confirmation" decision). Depth cap of 10 enforced in code.
 */
export const worldPages = sqliteTable(
  "world_pages",
  {
    id: id(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    parentPageId: text("parent_page_id"),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    bodyHtml: text("body_html").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    treeIdx: index("world_pages_tree_idx").on(t.worldId, t.parentPageId, t.sortOrder),
    slugIdx: index("world_pages_slug_idx").on(t.worldId, sql`lower(${t.slug})`),
  }),
);

/**
 * Room → world link. One-world-per-room (PK on roomId). Surfaces a banner
 * above the chat topic so participants can open the linked wiki.
 */
export const roomWorldLinks = sqliteTable(
  "room_world_links",
  {
    roomId: text("room_id")
      .primaryKey()
      .references(() => rooms.id, { onDelete: "cascade" }),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    linkedByUserId: text("linked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    linkedAt: ts("linked_at"),
  },
  (t) => ({
    worldIdx: index("room_world_links_world_idx").on(t.worldId),
  }),
);

/**
 * User → world membership. A user can belong to many worlds, and at most
 * one membership per user is `isPrimary`. Primary membership drives the
 * userlist grouping (everyone with the same primary world bands together).
 *
 * Joining is gated by world.visibility = "open" in the route layer; the
 * table itself doesn't enforce that, so admin tooling can still seed
 * memberships for private/public worlds if needed.
 */
export const worldMembers = sqliteTable(
  "world_members",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: ts("joined_at"),
    /** stored as 0/1 in SQLite. */
    isPrimary: integer("is_primary").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.worldId, t.userId] }),
    userIdx: index("world_members_user_idx").on(t.userId),
    // The actual "at most one primary per user" is enforced via a partial
    // unique index in the migration (drizzle's typed builder doesn't expose
    // partial indexes, so the migration is the source of truth).
  }),
);

/* ---------- audit log (Phase 3) ---------- */
/**
 * Append-only log of admin/mod actions. Stores enough metadata to reconstruct
 * "who did what to whom, when, and why" without ever capturing private chat
 * content. Free-text fields (`reason`, `metadata_json`) are admin-authored
 * descriptions, never user-authored bodies.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** e.g. "kick", "mute", "ban", "promote_mod", "settings_update", "report_resolve". */
    action: text("action").notNull(),
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetRoomId: text("target_room_id").references(() => rooms.id, { onDelete: "set null" }),
    targetMessageId: text("target_message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Admin-authored note (e.g. "spamming links"). Optional. */
    reason: text("reason"),
    /** JSON blob for action-specific extras (duration ms, prior/next role, etc.). */
    metadataJson: text("metadata_json"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    createdIdx: index("audit_log_created_idx").on(t.createdAt),
    actorIdx: index("audit_log_actor_idx").on(t.actorUserId, t.createdAt),
    targetIdx: index("audit_log_target_idx").on(t.targetUserId, t.createdAt),
    actionIdx: index("audit_log_action_idx").on(t.action, t.createdAt),
  }),
);

/* ---------- reports (Phase 3) ---------- */
/**
 * User-filed reports against PUBLIC chat messages. Whispers and private-room
 * messages are intentionally NOT reportable (admins can't see them anyway,
 * by design). Status flow: open → reviewed | dismissed.
 */
export const reports = sqliteTable(
  "reports",
  {
    id: id(),
    reporterUserId: text("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Room-message id when this is a room-content report; null for
     * DM reports (which use `directMessageId` below). Exactly one of
     * (messageId, directMessageId) is set on a given row — enforced
     * at the route layer because SQLite has no native XOR check.
     */
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "cascade" }),
    /** Free-text reason from the reporter. Optional; many UIs leave it blank. */
    reason: text("reason"),
    status: text("status", { enum: ["open", "reviewed", "dismissed"] })
      .notNull()
      .default("open"),
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    /** Admin's note added on resolve/dismiss; surfaced in the audit entry. */
    resolutionNote: text("resolution_note"),
    createdAt: ts("created_at"),
    /**
     * DM report fields (Phase 5). `directMessageId` references the
     * reported DM; `bodySnapshot` captures the body at report-time
     * so the admin queue can show it WITHOUT the admin route ever
     * querying `direct_messages` directly (preserves the "admin
     * queries cannot reach DM tables" invariant). `senderUserId` is
     * denormalized from `direct_messages.senderUserId` for the same
     * reason — the admin row stands on its own.
     */
    directMessageId: text("direct_message_id").references(() => directMessages.id, { onDelete: "set null" }),
    bodySnapshot: text("body_snapshot"),
    senderUserId: text("sender_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    statusIdx: index("reports_status_idx").on(t.status, t.createdAt),
    reporterMsgUq: uniqueIndex("reports_reporter_msg_uq").on(t.reporterUserId, t.messageId),
  }),
);

/* ---------- friends (formerly `watches`) ---------- */
/**
 * Asymmetric "friend" list - "tell me when this user comes online". The
 * friended user can't enumerate who's friended them. Mutuality (two-way
 * accept/reject) stays a possible v2 question; the current semantics
 * are unchanged from the prior `watches` table.
 *
 * The /watch family of slash commands remains as aliases for /friend
 * so existing tutorials and muscle memory still work.
 */
export const friends = sqliteTable(
  "friends",
  {
    frienderUserId: text("friender_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    friendedUserId: text("friended_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Per-identity partitioning (migration 0054). NULL means "this side
     * is the master OOC handle"; a character id pins the friendship to
     * that character. Two characters of the same player can keep
     * entirely separate friends lists, and the friended party only
     * ever sees the character that initiated the request.
     */
    frienderCharacterId: text("friender_character_id")
      .references(() => characters.id, { onDelete: "cascade" }),
    friendedCharacterId: text("friended_character_id")
      .references(() => characters.id, { onDelete: "cascade" }),
    /**
     * Friendship state. `pending` means the friender sent a request and
     * the friended user hasn't responded yet — they appear in the
     * inbox but NOT in either party's friends list. `accepted` means
     * the friendship is mutual: both sides see the other in their
     * list. Decline removes the row entirely (no `'declined'` state —
     * we don't want a permanent "you've been declined" record sitting
     * in the DB).
     */
    status: text("status", { enum: ["pending", "accepted"] })
      .notNull()
      .default("accepted"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    // Unique pair across BOTH sides' identities. Migration 0054 builds
    // the index with COALESCE-to-empty so SQLite's NULLs-are-distinct
    // behavior doesn't allow duplicate rows for master pairs.
    friendedIdx: index("friends_friended_idx").on(t.friendedUserId),
    statusIdx: index("friends_status_idx").on(t.friendedUserId, t.status),
  }),
);

/* ---------- direct messages (Phase 3) ---------- */
/**
 * Two-party persistent conversations, distinct from in-room whispers.
 * The canonical-pair invariant — `user_a_id < user_b_id` — combined
 * with the unique index guarantees one conversation row per pair
 * regardless of who started it. The route layer enforces the
 * ordering on insert; once recorded the row never moves.
 *
 * Why a separate table family rather than reusing `rooms` + `messages`:
 *   - DMs are always 2-party. The room model carries replyMode, world
 *     links, thread categories, passwords, membership, expiry — every
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

/* ---------- room thread categories ---------- */
/**
 * Per-room admin-defined buckets for organizing top-level threads in
 * nested-mode rooms. The unique (room_id, lower(name)) index in the
 * migration enforces case-insensitive uniqueness within a room — no two
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
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** Free-form user-defined category; empty string is treated as "Uncategorized". */
    category: text("category").notNull().default(""),
    /** Optional user-authored note for context — "why I bookmarked this". */
    note: text("note"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    userMsgUq: uniqueIndex("bookmarks_user_msg_uq").on(t.userId, t.messageId),
    userIdx: index("bookmarks_user_idx").on(t.userId),
  }),
);

/* ============================================================
 * Earning — earned-currency (XP + Currency) + Rank ladder +
 * cosmetics catalog. Drives the participation system described in
 * plan.md. All numeric values + asset paths in the catalog tables
 * are admin-managed from the Earning area of the admin panel; the
 * engine itself reads them every award so there is no in-code
 * hardcoding of thresholds, rates, or asset URLs.
 *
 * Two scopes are tracked in parallel:
 *   user_earning      one row per user (master / OOC pool)
 *   character_earning one row per character (IC pool)
 * IC chat credits character scope; OOC chat / forum credits master
 * scope. See apps/server/src/earning/routing.ts for the rule set.
 * ============================================================ */

/* ---------- ranks ----------
 * The named identity ladder ("New Arrival", "Active", ...). Six
 * rows are seeded by migration 0065; admins can rename, reorder,
 * disable, or add brand-new ranks from the admin panel.
 *
 * `enabled = 0` is a soft close: existing rank-holders keep their
 * rank, but the XP→rank resolver skips disabled rows when placing
 * new earners. Used for time-limited founding tiers like
 * "Legacy Member" which is enabled during beta then disabled after
 * GA so no future user can earn into it.
 */
export const ranks = sqliteTable("ranks", {
  /** Stable slug, e.g. "new_arrival". Immutable after create. */
  key: text("key").primaryKey(),
  /** Display name shown in chat / userlist / dashboard. Admin-editable. */
  name: text("name").notNull(),
  /** Display order, low → high (1 = lowest rank). */
  order: integer("order").notNull().default(0),
  /** Soft-close flag. 0 = skipped by the XP→rank resolver. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

/* ---------- rank_tiers ----------
 * Sub-levels within a rank (I, II, III, IV). Tier IV is the
 * "Verified" capstone of each rank (Tier IV of rank 6 is called
 * "Eternalized"). Crossing a tier IV threshold unlocks eligibility
 * to buy that rank's border frame (`borderImageUrl`).
 *
 * Eligibility persists via `maxRankKeyEverHeld` / `maxTierEverHeld`
 * on the earning rows — once a user has ever crossed Tier IV of a
 * rank they retain the right to buy that border even if admins
 * raise the threshold later.
 */
export const rankTiers = sqliteTable(
  "rank_tiers",
  {
    id: id(),
    rankKey: text("rank_key")
      .notNull()
      .references(() => ranks.key, { onDelete: "cascade" }),
    /** 1..4 by default; admins can extend a rank with more tiers. */
    tier: integer("tier").notNull(),
    /** Display label, e.g. "I", "II", "III", "IV: Verified". */
    label: text("label").notNull(),
    /** Crossing this XP places the user at this tier of this rank. */
    xpThreshold: integer("xp_threshold").notNull().default(0),
    /** Sigil PNG URL — bundled default `/assets/ranks/...` or `/uploads/ranks/<hash>.png`. */
    sigilImageUrl: text("sigil_image_url").notNull().default(""),
    /** Avatar border PNG URL. Set only for Tier IV (the capstone). */
    borderImageUrl: text("border_image_url"),
    /** Currency cost to purchase this rank's border. Tier IV only. */
    borderCost: integer("border_cost"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    rankTierUq: uniqueIndex("rank_tiers_rank_tier_uq").on(t.rankKey, t.tier),
    xpIdx: index("rank_tiers_xp_idx").on(t.xpThreshold),
  }),
);

/* ---------- name_styles ----------
 * Admin-authored HTML + CSS templates with a {username} placeholder
 * users can buy and equip to style their displayed name in chat /
 * forums / userlist. No JavaScript — animations are CSS-only via
 * @keyframes, eliminating any stored-XSS surface even with
 * admin-only authoring.
 */
export const nameStyles = sqliteTable("name_styles", {
  key: text("key").primaryKey(),
  /** Admin-facing label, e.g. "Sunset Gradient". */
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** HTML template — must include the literal `{username}` placeholder. */
  template: text("template").notNull(),
  /** Scoped CSS (animations via @keyframes). */
  styleCss: text("style_css").notNull().default(""),
  /** Currency cost to purchase this style. 0 = free. */
  cost: integer("cost").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Seed-protected styles cannot be deleted, only edited. */
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  order: integer("order").notNull().default(0),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

/* ---------- cosmetics ----------
 * Purchasable feature catalog distinct from name styles and
 * borders. Phase 4 seeds two rows: `inline_avatar` (round avatar
 * after the timestamp in chat) and `rank_border` (placeholder row
 * for the border-purchase flow — the actual per-rank prices live
 * on `rank_tiers.borderCost`).
 */
export const cosmetics = sqliteTable("cosmetics", {
  /** Stable slug, e.g. "inline_avatar". Immutable after create. */
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** Flat Currency price. For `rank_border` this is ignored; prices live on rank_tiers. */
  cost: integer("cost").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Per-cosmetic config JSON (e.g. avatar pixel size for `inline_avatar`). */
  configJson: text("config_json"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

/* ---------- user_earning ----------
 * Per-master-account pool. Created on first earn (or lazily on first
 * dashboard read). `rankKey` + `tier` are denormalized — recomputed
 * by the resolver every time XP changes so callers can read the
 * current rank without re-running the resolver. `maxRankKeyEverHeld`
 * + `maxTierEverHeld` capture the user's all-time peak so border
 * eligibility persists even if admins raise thresholds later.
 */
export const userEarning = sqliteTable("user_earning", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  xp: integer("xp").notNull().default(0),
  currency: integer("currency").notNull().default(0),
  /** Current rank (denormalized; null = below Rank 1). */
  rankKey: text("rank_key"),
  /** Current tier within rank (1..N; null when rankKey is null). */
  tier: integer("tier"),
  /** Highest rank ever held — never decreases. Drives "once eligible, always eligible" border purchasing. */
  maxRankKeyEverHeld: text("max_rank_key_ever_held"),
  maxTierEverHeld: integer("max_tier_ever_held"),
  /** Hides this user's Currency total from other users when set. Self always sees own. */
  hideCurrencyCount: integer("hide_currency_count", { mode: "boolean" }).notNull().default(false),
  /** Hides this user's XP total from other users when set. Self always sees own. Rank stays public regardless. */
  hideXpCount: integer("hide_xp_count", { mode: "boolean" }).notNull().default(false),
  /** Which owned border is currently equipped on the master avatar (null = none). */
  selectedBorderRankKey: text("selected_border_rank_key"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

/* ---------- character_earning ----------
 * Per-character pool, mirrors user_earning. Activity performed as
 * a character credits this row (and per the "every logged-in
 * character earns full" rule, every active character of the same
 * user gets the same award).
 */
export const characterEarning = sqliteTable("character_earning", {
  characterId: text("character_id")
    .primaryKey()
    .references(() => characters.id, { onDelete: "cascade" }),
  xp: integer("xp").notNull().default(0),
  currency: integer("currency").notNull().default(0),
  rankKey: text("rank_key"),
  tier: integer("tier"),
  maxRankKeyEverHeld: text("max_rank_key_ever_held"),
  maxTierEverHeld: integer("max_tier_ever_held"),
  /** Per-character border equip choice (drawn from the owner's user_owned_borders set). */
  selectedBorderRankKey: text("selected_border_rank_key"),
  /**
   * Per-character equipped name-style key. Distinct from
   * `user_active_cosmetics.active_name_style_key` (which now scopes
   * to master/OOC only). When the user is voicing this character
   * the renderer reads this column; when OOC, it reads the master
   * row. Null = no style equipped on this character.
   */
  activeNameStyleKey: text("active_name_style_key"),
  /**
   * Per-character inline-avatar toggle. Same partition as
   * activeNameStyleKey — character-active shows this character's
   * inline avatar choice, OOC shows the master's. Default false so
   * a new character starts with the avatar tile off.
   */
  inlineAvatarEnabled: integer("inline_avatar_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

/* ---------- earning_ledger ----------
 * Append-only audit of every XP / Currency delta on either scope.
 * `scope` + `ownerId` together identify the pool (the FK relation
 * cannot be modeled in Drizzle because ownerId points to different
 * tables depending on scope — same pattern as audit_log's loose
 * target columns).
 *
 * Reason vocabulary lives in apps/server/src/earning/ledger.ts.
 * Common values: message_ic, message_ooc, forum_topic, forum_reply,
 * presence_ic, presence_ooc, purchase_<cosmetic_key>,
 * border_purchase_<rank_key>, currency_send_out, currency_send_in,
 * character_deleted_currency_rollover, admin_grant, admin_revoke,
 * backfill_message_xp.
 */
export const earningLedger = sqliteTable(
  "earning_ledger",
  {
    id: id(),
    scope: text("scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    xpDelta: integer("xp_delta").notNull().default(0),
    currencyDelta: integer("currency_delta").notNull().default(0),
    reason: text("reason").notNull(),
    /** Optional JSON blob for source-specific context (room id, recipient id, etc.). */
    metadataJson: text("metadata_json"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    ownerTimeIdx: index("earning_ledger_owner_time_idx").on(t.scope, t.ownerId, t.createdAt),
    reasonIdx: index("earning_ledger_reason_idx").on(t.reason, t.createdAt),
  }),
);

/* ---------- user_owned_borders ----------
 * Borders are user-owned (not per-character). Each owned border can
 * be equipped independently on the master pool and on each of the
 * user's characters via the matching `selectedBorderRankKey` columns.
 */
export const userOwnedBorders = sqliteTable(
  "user_owned_borders",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rankKey: text("rank_key")
      .notNull()
      .references(() => ranks.key, { onDelete: "cascade" }),
    acquiredAt: ts("acquired_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.rankKey] }),
    userIdx: index("user_owned_borders_user_idx").on(t.userId),
  }),
);

/* ---------- user_owned_name_styles ----------
 * Records ownership + per-user customization. `configJson` stores
 * the user's color picks etc. as `{ color1, color2, glow, ... }`;
 * the StyledName renderer materializes these into CSS custom
 * properties before mounting the template.
 */
export const userOwnedNameStyles = sqliteTable(
  "user_owned_name_styles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    styleKey: text("style_key")
      .notNull()
      .references(() => nameStyles.key, { onDelete: "cascade" }),
    /** Per-user customization JSON (color picks, glow strength, etc.). */
    configJson: text("config_json"),
    acquiredAt: ts("acquired_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.styleKey] }),
    userIdx: index("user_owned_name_styles_user_idx").on(t.userId),
  }),
);

/* ---------- character_owned_name_styles ----------
 * Per-character ownership ledger for name styles (migration 0086).
 * Mirror of `user_owned_name_styles` keyed by character_id instead
 * of user_id. Each character carries its own owned list, purchased
 * from that character's currency pool. `configJson` holds the
 * character's color picks for THIS style — independent of any
 * other identity's config for the same styleKey.
 */
export const characterOwnedNameStyles = sqliteTable(
  "character_owned_name_styles",
  {
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    styleKey: text("style_key")
      .notNull()
      .references(() => nameStyles.key, { onDelete: "cascade" }),
    configJson: text("config_json"),
    acquiredAt: ts("acquired_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.characterId, t.styleKey] }),
    characterIdx: index("character_owned_name_styles_character_idx").on(t.characterId),
  }),
);

/* ---------- character_owned_borders ----------
 * Per-character border ownership (migration 0086). Mirror of
 * `user_owned_borders` keyed by character_id. Characters purchase
 * borders from their own currency pool and equip them via the
 * existing `character_earning.selected_border_rank_key` column.
 */
export const characterOwnedBorders = sqliteTable(
  "character_owned_borders",
  {
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    rankKey: text("rank_key")
      .notNull()
      .references(() => ranks.key, { onDelete: "cascade" }),
    acquiredAt: ts("acquired_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.characterId, t.rankKey] }),
    characterIdx: index("character_owned_borders_character_idx").on(t.characterId),
  }),
);

/* ---------- items ----------
 * Admin-managed catalog of collectible items users buy with Currency,
 * hold in their per-identity inventory, and exchange via /give, /throw,
 * /drop. Every column except `key` is editable from the admin UI;
 * built-in seed rows (migration 0094) are delete-protected via
 * `isBuiltin = true`.
 *
 * Availability is a layered switch:
 *   enabled       — master existence. 0 hides everywhere and rejects
 *                   commands referencing the item, but EXISTING
 *                   inventory rows persist so admins can revive an
 *                   item without nuking inventories.
 *   forSale       — independent of enabled; gates shop visibility
 *                   only. enabled=1+forSale=0 keeps the item usable
 *                   in commands while pulled from the store.
 *   saleStartsAt  — optional lower bound (unix ms). Shop hides the
 *                   item until this time.
 *   saleEndsAt    — optional upper bound. Shop stops accepting
 *                   purchases at/after this time.
 *
 * Per-command message tables are stored as JSON arrays. An empty
 * array (or invalid JSON) disables that command for the item.
 * Placeholders supported in any template: {sender} {target} {num}
 * {item_name} {item_icon}.
 */
export const items = sqliteTable(
  "items",
  {
    key: text("key").primaryKey(),
    name: text("name").notNull(),
    /** Plural display form. Falls back to `${name}s` when null. */
    namePlural: text("name_plural"),
    description: text("description").notNull().default(""),
    /** Uploaded asset URL; null/empty renders a default placeholder tile. */
    iconUrl: text("icon_url"),
    /** Currency cost per unit. */
    price: integer("price").notNull().default(0),
    /** Max units one identity may hold. */
    stackLimit: integer("stack_limit").notNull().default(99),
    /** JSON array of /give templates. Empty array disables /give. */
    giveMessagesJson: text("give_messages_json").notNull().default("[]"),
    /** JSON array of /throw templates. Empty array disables /throw. */
    throwMessagesJson: text("throw_messages_json").notNull().default("[]"),
    /** JSON array of /drop templates. Empty array disables /drop. */
    dropMessagesJson: text("drop_messages_json").notNull().default("[]"),
    /**
     * JSON array of casual-name aliases. `findItem` matches any
     * lowercase string in this array against the user-typed item
     * query, in addition to key / name / namePlural. Lets users
     * type "drink" or "tankard" for `ale`, "knife" or "blade" for
     * `dagger`, etc. Admins edit this from the Items sub-tab.
     */
    aliasesJson: text("aliases_json").notNull().default("[]"),
    /**
     * Shop / pin bucket. Drives the dashboard's shop category
     * filter and the pin-collection routing: items with
     * `category='pet'` can only be pinned to identity_pet_collection
     * (5 slots), every other category routes to identity_collection
     * (10 slots). The category set is intentionally small (food,
     * drink, joke, tool, weapon, armor, magic, treasure, building,
     * gift, pet, misc); `misc` is the safety default for any row
     * that didn't get categorized.
     */
    category: text("category").notNull().default("misc"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Independent of enabled — gates only shop visibility. */
    forSale: integer("for_sale", { mode: "boolean" }).notNull().default(true),
    /** Optional lower bound on shop visibility (unix ms). */
    saleStartsAt: integer("sale_starts_at", { mode: "timestamp_ms" }),
    /** Optional upper bound on shop visibility (unix ms). */
    saleEndsAt: integer("sale_ends_at", { mode: "timestamp_ms" }),
    order: integer("order").notNull().default(0),
    /** Seeded by migration 0094; admins can edit but not delete. */
    isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    orderIdx: index("items_order_idx").on(t.order),
    enabledForSaleIdx: index("items_enabled_for_sale_idx").on(t.enabled, t.forSale),
    categoryIdx: index("items_category_idx").on(t.category),
  }),
);

/* ---------- identity_inventory ----------
 * Per-identity holdings of catalog items. Composite-keyed by
 * (ownerScope, ownerId, itemKey) so OOC master and each character
 * carry fully independent inventories — see migration 0095. Every
 * read MUST scope by (ownerScope, ownerId); a query that omits them
 * crosses the partition and is a bug.
 *
 * Rows are deleted when quantity drops to 0 instead of left at zero,
 * so a `LEFT JOIN identity_inventory` always reflects the current
 * stack without filtering on quantity.
 */
export const identityInventory = sqliteTable(
  "identity_inventory",
  {
    /** "user" (OOC master) or "character" — selects which id table ownerId points at. */
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    itemKey: text("item_key")
      .notNull()
      .references(() => items.key, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(0),
    acquiredAt: ts("acquired_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerScope, t.ownerId, t.itemKey] }),
    ownerIdx: index("identity_inventory_owner_idx").on(t.ownerScope, t.ownerId),
    itemIdx: index("identity_inventory_item_idx").on(t.itemKey),
  }),
);

/* ---------- identity_collection ----------
 * Per-identity 10-slot pinned showcase of inventory items, rendered
 * on the identity's public profile. Migration 0096. Same partition
 * model as identity_inventory — every identity owns its own
 * Collection; nothing mirrors across identities. Slots are sparse:
 * a user can pin to 0, 3, and 7 and leave the rest empty. Reads
 * MUST scope by (ownerScope, ownerId), same as inventory.
 *
 * Drizzle's `sqliteTable` doesn't model CHECK constraints directly,
 * so the 0..9 slot range is enforced at the SQL layer (migration
 * 0096) AND at the route validator. The composite PK below covers
 * the uniqueness side.
 */
export const identityCollection = sqliteTable(
  "identity_collection",
  {
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** 0..9 — enforced by SQL CHECK + the route validator. */
    slot: integer("slot").notNull(),
    itemKey: text("item_key")
      .notNull()
      .references(() => items.key, { onDelete: "cascade" }),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerScope, t.ownerId, t.slot] }),
    ownerIdx: index("identity_collection_owner_idx").on(t.ownerScope, t.ownerId),
  }),
);

/* ---------- identity_pet_collection ----------
 * Per-identity 5-slot pinned showcase of PET items (`items.category =
 * 'pet'`). Twin of identity_collection but with a tighter cap (pets
 * are higher-investment trophies, not common collectibles) and a
 * category guard enforced at the route layer.
 *
 * Same partitioning rules as item collection — every identity owns
 * its own pin set; OOC and each character are isolated. Slots are
 * sparse (0..4) and the slot range is enforced both by the SQL
 * CHECK constraint (migration 0105) and the route's zod validator.
 */
export const identityPetCollection = sqliteTable(
  "identity_pet_collection",
  {
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** 0..4 — enforced by SQL CHECK + the route validator. */
    slot: integer("slot").notNull(),
    itemKey: text("item_key")
      .notNull()
      .references(() => items.key, { onDelete: "cascade" }),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerScope, t.ownerId, t.slot] }),
    ownerIdx: index("identity_pet_collection_owner_idx").on(t.ownerScope, t.ownerId),
  }),
);

/* ---------- user_active_cosmetics ----------
 * One row per user holding the currently-equipped cosmetic state.
 * Created lazily on first equip.
 */
export const userActiveCosmetics = sqliteTable("user_active_cosmetics", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Inline-avatar cosmetic equipped on chat lines. Requires ownership recorded in earning_ledger. */
  inlineAvatarEnabled: integer("inline_avatar_enabled", { mode: "boolean" }).notNull().default(false),
  /** Currently-active name style (FK; set null on style delete). */
  activeNameStyleKey: text("active_name_style_key")
    .references(() => nameStyles.key, { onDelete: "set null" }),
  updatedAt: ts("updated_at"),
});

/* ---------- earning_notifications ----------
 * Persists unacknowledged rank-up and tier-up events so the chat
 * ribbon survives reloads. Cleared by POST
 * /earning/me/notifications/rankup/ack. Per the project ethos
 * memory there are no popup toasts — this table backs a quiet,
 * dismissible ribbon and a dropdown indicator dot.
 */
export const earningNotifications = sqliteTable(
  "earning_notifications",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 'rankup' is the only kind in Phase 1; reserved for future expansion. */
    kind: text("kind", { enum: ["rankup"] }).notNull().default("rankup"),
    /** Scope on which the rank-up happened — master pool or one of the user's characters. */
    scope: text("scope", { enum: ["user", "character"] }).notNull(),
    /** characterId when scope = 'character'; null for scope = 'user'. */
    characterId: text("character_id"),
    fromRankKey: text("from_rank_key"),
    fromTier: integer("from_tier"),
    toRankKey: text("to_rank_key").notNull(),
    toTier: integer("to_tier").notNull(),
    /** Comma-joined rank keys whose borders the user just became eligible to buy (capstone crossings). */
    newlyEligibleBorderKeys: text("newly_eligible_border_keys").notNull().default(""),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    userUnreadIdx: index("earning_notifications_user_unread_idx").on(t.userId, t.acknowledgedAt),
  }),
);

export type DbUser = typeof users.$inferSelect;
export type DbCharacter = typeof characters.$inferSelect;
export type DbRoom = typeof rooms.$inferSelect;
export type DbRoomMember = typeof roomMembers.$inferSelect;
export type DbMessage = typeof messages.$inferSelect;
export type DbCustomCommand = typeof customCommands.$inferSelect;
export type DbNavLink = typeof navLinks.$inferSelect;
export type DbSiteSettings = typeof siteSettings.$inferSelect;
export type DbTitleKind = typeof titleKinds.$inferSelect;
export type DbMutualTitle = typeof mutualTitles.$inferSelect;
export type DbProfileLink = typeof profileLinks.$inferSelect;
export type DbAffiliate = typeof affiliates.$inferSelect;
export type DbCharacterJournalEntry = typeof characterJournalEntries.$inferSelect;
export type DbWorld = typeof worlds.$inferSelect;
export type DbWorldPage = typeof worldPages.$inferSelect;
export type DbRoomWorldLink = typeof roomWorldLinks.$inferSelect;
export type DbWorldMember = typeof worldMembers.$inferSelect;
export type DbAuditEntry = typeof auditLog.$inferSelect;
export type DbReport = typeof reports.$inferSelect;
export type DbFriend = typeof friends.$inferSelect;
/** @deprecated Use DbFriend. Kept for one release for downstream callers. */
export type DbWatch = DbFriend;
export type DbPushSubscription = typeof pushSubscriptions.$inferSelect;
export type DbBookmark = typeof bookmarks.$inferSelect;
export type DbRoomThreadCategory = typeof roomThreadCategories.$inferSelect;
export type DbRank = typeof ranks.$inferSelect;
export type DbRankTier = typeof rankTiers.$inferSelect;
export type DbNameStyle = typeof nameStyles.$inferSelect;
export type DbCosmetic = typeof cosmetics.$inferSelect;
export type DbUserEarning = typeof userEarning.$inferSelect;
export type DbCharacterEarning = typeof characterEarning.$inferSelect;
export type DbEarningLedger = typeof earningLedger.$inferSelect;
export type DbUserOwnedBorder = typeof userOwnedBorders.$inferSelect;
export type DbUserOwnedNameStyle = typeof userOwnedNameStyles.$inferSelect;
export type DbCharacterOwnedBorder = typeof characterOwnedBorders.$inferSelect;
export type DbCharacterOwnedNameStyle = typeof characterOwnedNameStyles.$inferSelect;
export type DbUserActiveCosmetics = typeof userActiveCosmetics.$inferSelect;
export type DbEarningNotification = typeof earningNotifications.$inferSelect;
export type DbItem = typeof items.$inferSelect;
export type DbIdentityInventory = typeof identityInventory.$inferSelect;
export type DbIdentityCollection = typeof identityCollection.$inferSelect;
export type DbIdentityPetCollection = typeof identityPetCollection.$inferSelect;
