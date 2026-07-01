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

const id = () => text("id").primaryKey();
const ts = (name: string) =>
  integer(name, { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`);

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

/* ---------- users ---------- */
export const users = sqliteTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    /** the master/login username - display fallback when no character is active */
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    /**
     * When the account's email was confirmed (migration 0257). Null =
     * unverified. Only enforced when `site_settings.email_verification_enabled`
     * is on; existing accounts were grandfathered to their createdAt by the
     * migration so they're never nagged. Block-mode enforcement and the
     * nudge banner both read this.
     */
    emailVerifiedAt: integer("email_verified_at", { mode: "timestamp_ms" }),
    role: text("role", { enum: ["user", "trusted", "mod", "admin", "masteradmin"] }).notNull().default("user"),
    /** master profile body (sanitized HTML) shown when /char clear */
    bioHtml: text("bio_html").notNull().default(""),
    /**
     * Staff-card copy (migration 0250), editable by the staff member for
     * their own card on the public Staff page. `staffBio` is the short
     * one-line tagline (≤120 chars); `staffIntro` is a slightly longer
     * blurb (≤256 chars). Null until set. Only meaningful for accounts
     * whose `role` is mod/admin/masteradmin; the Staff route ignores
     * them for everyone else. Plain text, not HTML.
     */
    staffBio: text("staff_bio"),
    staffIntro: text("staff_intro"),
    avatarUrl: text("avatar_url"),
    /**
     * Avatar zoom / pan / crop (migration 0178). The avatar URL still
     * points at the full source; these three fields let the owner
     * pick which part of the source becomes the visible circle.
     *
     *   * `avatarZoom`   , 1.0 = no zoom (legacy cover-fit behavior);
     *                       higher zooms in. Clamped to [1.0, 4.0].
     *   * `avatarOffsetX`, 0..100, percent. CSS object-position X.
     *   * `avatarOffsetY`, 0..100, percent. CSS object-position Y.
     *
     * Defaults (1.0 / 50 / 50) reproduce the pre-feature centered
     * cover render exactly, so every legacy row keeps its old look.
     */
    avatarZoom: real("avatar_zoom").notNull().default(1.0),
    avatarOffsetX: real("avatar_offset_x").notNull().default(50.0),
    avatarOffsetY: real("avatar_offset_y").notNull().default(50.0),
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
     * orthogonal to palette, picking a style doesn't change which colors
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
     * Notification Center preferences (migration 0305). JSON
     * `{ mutedCategories: NotificationCategory[] }` — categories the user has
     * silenced get NO inbox row, badge, or push. Null/absent = nothing muted.
     * Distinct from `notifyPref` above, which governs the live desktop toast for
     * chat messages, not the unified bell.
     */
    notificationPrefsJson: text("notification_prefs_json"),
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
     * Per-event in-app sound toggles. All three default to on, opt out,
     * not opt in, so a fresh sign-in hears notifications. Each maps to
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
     * dedicated to whispers, previously both DM and whisper rode
     * the same `ping` event because we only had three sound assets.
     * Default on, opt-out, matching the other sound prefs.
     */
    soundWhisperEnabled: integer("sound_whisper_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    /**
     * Per-user input-behavior toggles. Both default off (= feature on).
     *   disableInputHistory, kills ArrowUp/ArrowDown command-history
     *                         recall in the composer. Some users brush
     *                         the arrows while moving the cursor and
     *                         want the recall gone.
     *   disableThesaurus   , kills the synonym popup that opens when
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
     * Viewer-side flair opt-outs (migration 0263). Account-wide, global
     * toggles that turn OFF rendering of OTHER people's cosmetic flair
     * FOR THIS VIEWER — a performance escape hatch for older hardware.
     * Purely client-render gates: the underlying cosmetics still exist
     * and everyone else still sees them; only this viewer's UI falls
     * back to the plain rendering. All default off (= flair shown).
     *   disableNameStyles    , render equipped name-style names as plain text.
     *   disableBorderStyles  , render avatars with no rank/freeform border frame.
     *   disableInlineAvatars , show the gender/rank glyph instead of the inline
     *                          avatar thumbnail in chat lines + the userlist.
     */
    disableNameStyles: integer("disable_name_styles", { mode: "boolean" })
      .notNull()
      .default(false),
    disableBorderStyles: integer("disable_border_styles", { mode: "boolean" })
      .notNull()
      .default(false),
    disableInlineAvatars: integer("disable_inline_avatars", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * Default forum (migration 0274). The forum the catalog opens to when
     * launched without an explicit deep-link; set from the Forums toolbar
     * star. NULL = no preference (falls back to the system forum). Synced
     * across devices. A stale id is ignored client-side.
     */
    defaultForumId: text("default_forum_id"),
    /**
     * Favorite / default ("home") server (migration 0277, mirrors
     * defaultForumId / 0274; index added in 0300). NULL = no preference
     * (falls back to the default/system server). Three roles:
     *   - the rail's home-server preference (the icon the shell opens on),
     *   - the home-server anchor for off-room earning credits (Phase 5b),
     *   - the PROFILE anchor: a global profile view shows the owner's
     *     per-server identity (collection / pet collection / equipped name
     *     style / banner / flair) from THIS server, not the system default
     *     (resolved via resolveProfileServerId; falls back to
     *     DEFAULT_SERVER_ID when unset or pointing at a server the owner no
     *     longer belongs to).
     * A stale id (server deleted) is harmless — the read path falls back to
     * the system server, and the server-delete path nulls any rows that
     * pointed at it. No FK (kept a plain text id, as the ALTER in 0277 adds
     * no REFERENCES — mirrors defaultForumId; the read-side fallback gives
     * the same ON DELETE SET NULL behavior).
     */
    defaultServerId: text("default_server_id"),
    /**
     * Scriptorium catalog preferences (migration 0142).
     *
     *   storyShowNsfw , opt-in for R / NC-17 cards in the catalog.
     *     Anonymous viewers never see these regardless; this gates
     *     them for signed-in viewers. Default off, readers opt in.
     *
     *   storyCwBlocklist, comma-separated content warnings the user
     *     always wants filtered OUT of the catalog. Cards tagged with
     *     ANY blocklisted warning are hidden entirely (not just blurred).
     *     Same shape as worlds.contentWarnings and stories.contentWarnings.
     */
    storyShowNsfw: integer("story_show_nsfw", { mode: "boolean" })
      .notNull()
      .default(false),
    storyCwBlocklist: text("story_cw_blocklist").notNull().default(""),
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
     *   showRankInUserlist, default true. When false, the user's
     *     userlist row drops back to the gender glyph instead of the
     *     rank gem. Broadcast.ts nulls the occupant's rankKey/tier
     *     when this is off, so the existing UserNameTag conditional
     *     ("show rank if rank exists, else gender") naturally falls
     *     through to the gender path without needing extra props.
     *   showRankInChat, default true. When false, addMessage
     *     snapshots null rank fields on outgoing messages from this
     *     author. Affects FUTURE sends only; past messages keep
     *     whatever was snapshotted at the time.
     *
     *   hideChatMessageCount / hideForumTopicCount / hideForumReplyCount
     *    , default false. When true, the corresponding counter on
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
    /**
     * Lifetime post counters. Bumped at message-insert time by
     * `bumpLifetimeForMessage`, never decremented, a soft-delete or
     * retention purge leaves the counter intact. The profile view
     * reads from these columns directly; the legacy COUNT(*) over
     * `messages` is gone (it decayed every time a row was purged).
     * Created in migration 0176 and back-filled from the surviving
     * `messages` rows in the same migration.
     *
     * Scope: a master-account counter accumulates EVERY message the
     * user authored (OOC + every character), so the master profile's
     * total reads as "all the time this person spent here." The
     * character table carries its own copies for the per-character
     * split.
     */
    lifetimeChatMessages: integer("lifetime_chat_messages")
      .notNull()
      .default(0),
    lifetimeForumTopics: integer("lifetime_forum_topics")
      .notNull()
      .default(0),
    lifetimeForumReplies: integer("lifetime_forum_replies")
      .notNull()
      .default(0),
    /** Free-text "away" reason; null means the user is present. */
    awayMessage: text("away_message"),
    awaySince: integer("away_since", { mode: "timestamp_ms" }),
    /** Free-text current mood/expression (e.g. "angry", "wounded"). Null = no mood set. Capped at 32 chars; rendered as a chip next to the user's name on outgoing messages. */
    currentMood: text("current_mood"),
    /**
     * Incognito (ghost) mode, moderator observation tool. When true,
     * the user is removed from the userlist on every room they're in,
     * room transitions don't broadcast leave/join, and any chat
     * message they send renders as a system line under their
     * `incognitoAlias` instead of their identity.
     *
     * Persisted on the user row (not per-session) so a tab refresh
     * or network blip doesn't pop them back into visibility mid-
     * investigation. Requires the `use_ghost_mode` permission to
     * toggle. Migration 0188.
     */
    incognitoMode: integer("incognito_mode", { mode: "boolean" }).notNull().default(false),
    /**
     * Display name used for chat lines posted while incognito. Null
     * → render as the literal "System" so an incognito moderator's
     * messages are visually indistinguishable from server-generated
     * system events. Customisable via `/incognito <alias>`.
     */
    incognitoAlias: text("incognito_alias"),
    /**
     * Custom leave-message broadcast at the moment the user goes
     * incognito. Null → use a default phrasing built from their
     * display name. Editable via `/incognito exit <text>`.
     */
    incognitoExitMessage: text("incognito_exit_message"),
    /**
     * Custom return-message broadcast at the moment the user leaves
     * incognito. Null → default. Editable via `/incognito return <text>`.
     */
    incognitoReturnMessage: text("incognito_return_message"),
    /** FK to characters.id - nullable means "show master profile" */
    activeCharacterId: text("active_character_id"),
    /**
     * Public visibility flag for the master profile.
     *   - true (default): /profiles/:username returns the full profile to
     *     anyone, including anonymous viewers.
     *   - false: anonymous viewers get a `private: true` stub (HTTP 200,
     *     so the splash can render a "this profile is private, sign in"
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
     * renders, the gate is per-modal-mount so closing and reopening
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
     * is declared at the DB layer in migration 0036, not modeled here in
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
     * pairs. Default "cover", most forgiving for typical landscape
     * illustrations. See migration 0117 for the full table.
     */
    publicProfileBgMode: text("public_profile_bg_mode").notNull().default("cover"),
    createdAt: ts("created_at"),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
    /**
     * Account ban (migration 0247). Distinct from the admin `disabledAt`
     * toggle: a ban is a mod action carrying a reason + issuer, and may be
     * timed. When a ban is active the route ALSO sets `disabledAt` so every
     * existing login/chat/visibility gate (`isNull(disabledAt)`) blocks the
     * account for free; unban / expiry clears both.
     *
     *   bannedAt    = when the current ban was issued (null ⇒ not banned).
     *   bannedUntil = expiry; null WITH bannedAt set ⇒ permanent. A timed
     *                 ban whose bannedUntil has passed is auto-lifted by the
     *                 ban sweep and lazily on login.
     *   banReason   = mod-supplied reason, surfaced to other mods.
     *   bannedById  = the issuing mod (for the review surface).
     */
    bannedAt: integer("banned_at", { mode: "timestamp_ms" }),
    bannedUntil: integer("banned_until", { mode: "timestamp_ms" }),
    banReason: text("ban_reason"),
    bannedById: text("banned_by_id"),
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
    /** Mirrors `users.avatarZoom / avatarOffsetX / avatarOffsetY`,
     *  per-character zoom + pan over the avatar source. Migration
     *  0178 added all six columns in lockstep so master and per-
     *  character avatars share the same focal-point UX. Defaults
     *  (1.0 / 50 / 50) reproduce the legacy centered-cover render. */
    avatarZoom: real("avatar_zoom").notNull().default(1.0),
    avatarOffsetX: real("avatar_offset_x").notNull().default(50.0),
    avatarOffsetY: real("avatar_offset_y").notNull().default(50.0),
    /** Mirrors users.includeAvatarInGallery, per-character opt-in to
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
     * Mirrors `themeJson` above, character can fully reskin the site
     * when active, design and all.
     */
    styleKey: text("style_key"),
    /** Same semantics as users.is_public - public = anonymous can view this character's profile. */
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(true),
    /** Same semantics as users.is_nsfw - forces private + adds a viewer gate splash. */
    isNsfw: integer("is_nsfw", { mode: "boolean" }).notNull().default(false),
    /** Mirrors users.publicProfileBgUrl, per-character public-profile backdrop image. NULL = use default. */
    publicProfileBgUrl: text("public_profile_bg_url"),
    /** Mirrors users.publicProfileBgMode, "cover" | "contain" | "tile" | "stretch". */
    publicProfileBgMode: text("public_profile_bg_mode").notNull().default("cover"),
    /**
     * Per-character lifetime post counters. Same semantics as the
     * triple on `users`: bumped at message-insert time, never
     * decremented. See migration 0176 for the create + backfill.
     * The master-account totals on `users` are the sum of OOC posts
     * plus every character's counter; both surfaces read directly
     * off the appropriate column.
     */
    lifetimeChatMessages: integer("lifetime_chat_messages")
      .notNull()
      .default(0),
    lifetimeForumTopics: integer("lifetime_forum_topics")
      .notNull()
      .default(0),
    lifetimeForumReplies: integer("lifetime_forum_replies")
      .notNull()
      .default(0),
    /**
     * Per-character opt-in for Direct Messenger. When false, the
     * character is hidden from:
     *   - friend-request lookups + typeahead
     *   - DM recipient pickers
     *   - new conversation creation (existing friends cannot start a
     *     new DM thread with this character; existing threads stay
     *     readable but new sends are gated, see route checks)
     *
     * Existing friendships are NOT removed when the toggle flips off,
     * the friend just can't reach this character via DM anymore. Flipping
     * it back on restores reachability with no further action needed.
     *
     * Reachability is OPT-OUT: new characters are created reachable
     * (the create routes set this explicitly) and owners turn it OFF
     * here only if they want a character uncontactable. Migration 0183
     * first added this column opt-IN (default `false`), but that left
     * every new character silently unreachable; migration 0253 flipped
     * the policy and backfilled existing disabled characters to `true`.
     */
    directMessengerEnabled: integer("direct_messenger_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    // PARTIAL: only LIVE characters reserve a name, so a soft-deleted
    // name is immediately reusable (migration 0262). Without the
    // `WHERE deleted_at IS NULL` clause, recreating a just-deleted
    // character's name collided here and surfaced as a 500.
    userNameUq: uniqueIndex("characters_user_name_uq")
      .on(t.userId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
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
 * gallery on master profiles, same shape, same per-portrait NSFW
 * gate, same sort_order semantics, so OOC profiles can show
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

/* ---------- blocks (global, MUTUAL invisibility) ----------
 * Stronger than `ignores`. `/ignore` is one-way and message-only: the
 * ignorer stops seeing the ignored user's chat lines, but the ignored user
 * still sees them everywhere. A block is MUTUAL and GLOBAL: once a row exists
 * between two accounts (in either direction), the two users and ALL their
 * characters become invisible to each other across the whole app, chat,
 * userlist, whispers, DMs, friends, profiles, search/@mentions.
 *
 * One directed row is written per initiation (`blocker_user_id` blocked
 * `blocked_user_id`); the effect is symmetric because every read consults
 * BOTH directions (see auth/blocks.ts). Only the blocker can lift their own
 * row (Profile → Privacy); the blocked user has no signal and can't undo it.
 * Keyed on the master userId like `ignores`, so it spans every character on
 * both sides. Blocking performs NO destructive changes, friendships / DM
 * threads are merely filtered out while blocked and reappear on unblock.
 */
export const blocks = sqliteTable(
  "blocks",
  {
    blockerUserId: text("blocker_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedUserId: text("blocked_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.blockerUserId, t.blockedUserId] }),
    // Reverse-direction lookups ("who has blocked me / am I blocked by")
    // hit blocked_user_id, which the PK's leading column can't serve.
    blockedIdx: index("blocks_blocked_idx").on(t.blockedUserId),
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

/* ---------- user_ip_log ----------
 * Event-time IP capture. `sessions.ip` is frozen at login, so a long-lived
 * session (TTL defaults to 30 days) keeps reporting the address the user
 * first logged in from even as they roam networks (mobile handoff, VPN
 * toggle, moving between locations). This table is upserted on real activity
 * - socket connect, room switch, chat send, authenticated HTTP posts - keyed
 * (user_id, ip) so each distinct address a user touches gets exactly one row
 * whose `last_seen_at` tracks their most recent activity from it. It feeds
 * the admin /admin/users IP / alt-detection alongside `sessions`, so the
 * "recent IPs" chips reflect where a user actually is now, not just where
 * they first logged in.
 *
 * Writes are throttled in-process (see auth/ipLog.ts) to at most one per
 * (user, ip) per minute, so chat spam can't pin SQLite. A brand-new IP for a
 * user is a different key, so it's always captured immediately.
 */
export const userIpLog = sqliteTable(
  "user_ip_log",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ip: text("ip").notNull(),
    firstSeenAt: ts("first_seen_at"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** Approximate activity volume from this IP; bumped on each (throttled) write. */
    hitCount: integer("hit_count").notNull().default(1),
    lastUserAgent: text("last_user_agent"),
    /** What surfaced this write: "connect" | "chat" | "room" | "http". */
    lastEvent: text("last_event"),
  },
  (t) => ({
    userIpUnique: uniqueIndex("user_ip_log_user_ip_idx").on(t.userId, t.ip),
    ipIdx: index("user_ip_log_ip_idx").on(t.ip),
    userSeenIdx: index("user_ip_log_user_seen_idx").on(t.userId, t.lastSeenAt),
  }),
);

/* ---------- banned_ips ----------
 * IP-level block list (migration 0304). When a global admin bans a user, their
 * recent public IPs (from user_ip_log + sessions) are mirrored here so the same
 * person can't immediately spin up burner accounts to keep harassing. Checked
 * at REGISTRATION and LOGIN; one row per address (unique ip), upserted so a
 * shared/re-banned IP keeps the latest expiry/reason. `bannedUntil` null =
 * permanent; a timed ban produces a timed IP block. Cleared on unban via
 * target_user_id. Private/loopback addresses are never inserted (see
 * auth/ipBan.ts) so dev and NAT hops don't self-block.
 */
export const bannedIps = sqliteTable(
  "banned_ips",
  {
    id: id(),
    ip: text("ip").notNull(),
    bannedAt: ts("banned_at"),
    bannedUntil: integer("banned_until", { mode: "timestamp_ms" }),
    reason: text("reason"),
    bannedById: text("banned_by_id").references(() => users.id, { onDelete: "set null" }),
    /** The banned account whose ban produced this row; lets unban clear it. */
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    ipUnique: uniqueIndex("banned_ips_ip_idx").on(t.ip),
    targetIdx: index("banned_ips_target_idx").on(t.targetUserId),
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
   * "idle" ghost before being dropped. Default 10 minutes. Overrides
   * the long sessionTtlMs for *visible presence* only, session
   * validity itself is governed by sessionTtlMs. See migration
   * 0115_idle_grace_ms for the original rationale and
   * 0256_idle_grace_default_10min for the default reduction.
   */
  idleGraceMs: integer("idle_grace_ms").notNull().default(10 * 60 * 1000),
  /** JSON-serialized Theme; null = use built-in DEFAULT_THEME */
  defaultThemeJson: text("default_theme_json"),
  /** Public site name shown in the banner, login screen, and tab title. */
  siteName: text("site_name").notNull().default("The Spire"),
  /**
   * Canonical public URL the banner logo links to. Empty string = no
   * link wrapping; the logo renders as a non-interactive element.
   * When set, the banner wraps the logo text or image in an `<a>`
   * pointing at this URL, styling stays identical to the unwrapped
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
   * Topics-per-page for the discrete pagination strip rendered under
   * each forum category. Migration 0193. Bounded (5..100) at the
   * route handler; 20 mirrors the prior cursor-paged `limit ?? 20`
   * default so existing pages don't visually shift on deploy.
   */
  forumTopicsPerPage: integer("forum_topics_per_page").notNull().default(20),
  /**
   * Author-edit / author-delete grace window in ms. After this many
   * ms since createdAt, edits and deletes are rejected for the author.
   * Mods and admins bypass the gate entirely. Forum (nested) rooms
   * ignore this and allow indefinite edits, the (edited) badge is
   * the transparency signal there. Default 300_000 (5 min).
   */
  editGraceMs: integer("edit_grace_ms").notNull().default(300_000),
  /** Hard cap on profile bio HTML length (master + character bios). */
  maxBioLength: integer("max_bio_length").notNull().default(50_000),
  /**
   * Email verification (migration 0257). When off, registration never
   * sends a verification email and nothing gates on verified status.
   * When on, new registrations get a verification email and
   * `email_verification_mode` decides enforcement.
   */
  emailVerificationEnabled: integer("email_verification_enabled", { mode: "boolean" }).notNull().default(false),
  /**
   * Enforcement when verification is enabled: "nudge" = account works
   * fully, a dismissible banner asks them to verify; "block" = the
   * account can't enter chat / post until verified. Server enforces
   * block mode; the client mirrors it. Default "nudge".
   */
  emailVerificationMode: text("email_verification_mode", { enum: ["nudge", "block"] }).notNull().default("nudge"),
  /**
   * Max emails the throttled broadcast queue will send per calendar day
   * (migration 0257). Defaults to Brevo's free-tier cap (300). The queue
   * counts the day's sends and pauses when it hits this, auto-resuming
   * the next day. Transactional account mail is not subject to it.
   */
  emailDailyCap: integer("email_daily_cap").notNull().default(300),
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
   * Sanitized HTML shown WITH an "I agree" checkbox on the "Register your own
   * Server" application form (migration 0301). Global-admin-authored in
   * Global Admin → Rules; governs every server registration. Empty = no gate.
   */
  serverRegistrationRulesHtml: text("server_registration_rules_html").notNull().default(""),
  /**
   * Same as serverRegistrationRulesHtml for the "Create your Forum" application
   * form (migration 0301). Empty = no gate.
   */
  forumRegistrationRulesHtml: text("forum_registration_rules_html").notNull().default(""),
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
   * splash. Independent of `activityFeedsEnabled`, each toggle gates
   * its own section of the splash stats row, so admins can show the
   * message count alone (just chat volume), the online/room counters
   * alone, or both together. When both are on, the splash renders
   * them in the same "· N stat" row so the cluster still reads as
   * one beat. Default off, see migration 0116 for the rationale.
   */
  splashMessages24hEnabled: integer("splash_messages_24h_enabled", { mode: "boolean" }).notNull().default(false),
  /** Visual bio "Designer" (GrapesJS) availability (migration 0241; flipped on
   *  by default in 0242). When off, the bio editor is the raw-HTML source
   *  textarea only. Admins can disable it from site settings. */
  profileDesignerEnabled: integer("profile_designer_enabled", { mode: "boolean" }).notNull().default(true),
  /** Sanitized HTML shown once to NEW users (registered after the welcome's last edit) until they dismiss it. Editing the text rotates a hash so the audience sees the new version on next load. */
  newUserWelcomeHtml: text("new_user_welcome_html").notNull().default(""),
  /** Timestamp of the most recent welcome-text edit. Null = never set. The audience filter is `users.created_at > new_user_welcome_updated_at`, so existing users at the time of the edit don't get retroactively spammed. */
  newUserWelcomeUpdatedAt: integer("new_user_welcome_updated_at", { mode: "timestamp_ms" }),
  /**
   * Site-wide default theme STYLE, orthogonal to the palette (`defaultThemeJson`).
   * Where palette decides colors, style decides visual treatment ('medieval',
   * 'modern', 'scifi', each a full design language). Users who haven't picked
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
   * versioning scheme, implicitly v1.
   */
  worldsSeedVersion: integer("worlds_seed_version").notNull().default(0),
  /**
   * Earning system configuration, every numeric input the XP /
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
  /**
   * Daily flash-sale system. Defaults at 25% off, all three categories
   * enabled, so the system starts producing daily sales without
   * further admin action. Per-category toggles let admins mute one
   * surface (e.g. cosmetics off) without disabling the whole feature.
   * Per-pick `discount_pct` on a `flash_sale_overrides` row beats the
   * default; the resolver snapshots the effective discount onto each
   * `flash_sales` row so a mid-day default tweak doesn't silently
   * re-price an active sale.
   */
  flashSaleDefaultDiscountPct: integer("flash_sale_default_discount_pct").notNull().default(25),
  flashSaleStylesEnabled: integer("flash_sale_styles_enabled", { mode: "boolean" }).notNull().default(true),
  flashSaleItemsEnabled: integer("flash_sale_items_enabled", { mode: "boolean" }).notNull().default(true),
  flashSaleCosmeticsEnabled: integer("flash_sale_cosmetics_enabled", { mode: "boolean" }).notNull().default(true),
  flashSaleFreeformBordersEnabled: integer("flash_sale_freeform_borders_enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * Servers Lift soft feature flag (migration 0275). Master-admin toggle: the
   * rail + /s/ routes stay hidden until this flips to true. Additive, default
   * off, so deploying the Phase-1 migrations changes nothing visible until the
   * owner enables servers. areServersEnabled() ANDs this with the
   * SERVERS_KILL env kill-switch.
   */
  serversEnabled: integer("servers_enabled", { mode: "boolean" }).notNull().default(false),
  updatedAt: ts("updated_at"),
  updatedById: text("updated_by_id").references(() => users.id, { onDelete: "set null" }),
});

/* ---------- flash_sales ----------
 * One row per UTC date. Holds the resolved picks for that day; the
 * resolver picks and writes in a single transaction so concurrent
 * first-readers don't race two random picks. NULL means "no row was
 * eligible at pick time" (catalog empty or category disabled when
 * the resolver ran). Each FK uses `ON DELETE SET NULL` so a later
 * catalog deletion doesn't 404 the historical sale row.
 *
 * `*_discount_pct` is snapshotted on insert: either the override's
 * per-pick discount or the global default at pick time. NULL on
 * read means "no pick for this category that day", not "use global
 * default", the resolver always materializes a number on insert.
 */
export const flashSales = sqliteTable(
  "flash_sales",
  {
    /**
     * Per-server economy partition (migration 0299). Flash sales are scheduled
     * per server; the grain is (server_id, for_date). All legacy rows home to
     * the default server.
     */
    serverId: text("server_id").notNull().default("server_spire_system"),
    /** ISO 'YYYY-MM-DD' UTC. One sale per server per day. */
    forDate: text("for_date").notNull(),
    /**
     * Picked SKU keys (migration 0299). The single-column FKs into
     * name_styles / items / cosmetics / freeform_borders were DROPPED when
     * those catalogs gained composite (server_id, key) PKs — a single-column
     * FK into a composite-PK table raises "foreign key mismatch", and the old
     * ON DELETE SET NULL can't be expressed as a composite FK (it would null
     * the NOT NULL server_id). These stay plain-text keys; the resolver
     * validates each pick against this server's live catalog when it
     * materializes the day's sale.
     */
    nameStyleKey: text("name_style_key"),
    itemKey: text("item_key"),
    cosmeticKey: text("cosmetic_key"),
    freeformBorderKey: text("freeform_border_key"),
    nameStyleDiscountPct: integer("name_style_discount_pct"),
    itemDiscountPct: integer("item_discount_pct"),
    cosmeticDiscountPct: integer("cosmetic_discount_pct"),
    freeformBorderDiscountPct: integer("freeform_border_discount_pct"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.forDate] }),
  }),
);

/* ---------- flash_sale_overrides ----------
 * Admin "queue a specific pick for date X" rows. Consumed (read,
 * not deleted) by the resolver when it materializes that date's
 * `flash_sales` row, so the audit trail of what was scheduled
 * survives. Composite primary key (category, for_date) keeps the
 * one-pick-per-category-per-day invariant cheap to enforce.
 */
export const flashSaleOverrides = sqliteTable(
  "flash_sale_overrides",
  {
    /** Per-server economy partition (migration 0299); overrides are queued per server. */
    serverId: text("server_id").notNull().default("server_spire_system"),
    /** 'name_style' | 'item' | 'cosmetic'. No CHECK constraint so future categories drop in. */
    category: text("category").notNull(),
    /** ISO 'YYYY-MM-DD' UTC. */
    forDate: text("for_date").notNull(),
    /** Catalog row key. App validates against the right table on insert. */
    targetKey: text("target_key").notNull(),
    /** Optional per-pick discount. NULL = inherit site default at resolve time. */
    discountPct: integer("discount_pct"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    // server_id joins the existing one-pick-per-category-per-day PK
    // (migration 0299). The live PK was (category, for_date) — NOT (for_date)
    // — so category is preserved to keep that invariant.
    pk: primaryKey({ columns: [t.serverId, t.category, t.forDate] }),
  }),
);

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
    /**
     * Scope discriminator (migration 0278i). NULL = platform-shared title kind;
     * a server_id scopes the kind to that server's flavor. ON DELETE SET NULL
     * so deleting a server un-scopes its title kinds rather than destroying them.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    slugUq: uniqueIndex("title_kinds_slug_uq").on(sql`lower(${t.slug})`),
    serverIdx: index("title_kinds_server_idx").on(t.serverId),
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
    pacing: text("pacing", {
      enum: ["freeform", "drop-in", "casual", "slice-of-life", "structured", "long-form"],
    }),
    /**
     * Vibe-stat axes, author-tuned 0..100 integers that describe how
     * the world FEELS along eight orthogonal dimensions. Catalog
     * filters key on these, and world cards render them as horizontal
     * bars. Null = "author hasn't tuned this axis"; the renderer
     * shows a muted "-" instead of a 0% bar so the visual difference
     * between "deliberately none of this" and "not yet set" is clear.
     *
     * The axis list is INTENTIONALLY FIXED so cross-world comparison
     * (the whole point of catalog filtering) stays meaningful. Adding
     * or removing an axis is a schema change.
     */
    statCombat: integer("stat_combat"),
    statMagic: integer("stat_magic"),
    statTechnology: integer("stat_technology"),
    statRomance: integer("stat_romance"),
    statPolitics: integer("stat_politics"),
    statMystery: integer("stat_mystery"),
    statHorror: integer("stat_horror"),
    statExploration: integer("stat_exploration"),
    /**
     * Membership join gate, orthogonal to `visibility`:
     *   - "open": anyone who can see the world can join with one click
     *   - "application": joining requires owner-approved application
     *     (see `world_applications` + `application_questions_json`)
     *   - "invite-only": only the owner can add members (no Join /
     *     Apply button surfaces in the catalog)
     * Defaults to "open" so legacy rows keep their pre-feature
     * behavior, the visibility="open" check that gated joining
     * before this column existed still applies via the route layer.
     */
    joinMode: text("join_mode", { enum: ["open", "application", "invite-only"] })
      .notNull()
      .default("open"),
    /**
     * JSON array of question prompt strings (max 5, each 1..280
     * chars). The applicant's `answers_json` lines up by position.
     * Empty array is legal, an open-question-set application just
     * captures the applicant's intent to join with no Q&A. The
     * column itself defaults to "[]" so the JSON-parse path never
     * sees null.
     */
    applicationQuestionsJson: text("application_questions_json").notNull().default("[]"),
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
 * World membership applications, created when a user clicks "Apply"
 * on a world whose `joinMode = "application"`. Row lifecycle:
 *
 *   pending → approved   (owner clicks Approve; user is auto-added
 *                         to world_members as part of the same
 *                         transaction)
 *   pending → rejected   (owner clicks Reject, optional review_note)
 *   pending → withdrawn  (applicant cancels their own pending app)
 *
 * Terminal-state rows (approved / rejected / withdrawn) stay as an
 * audit trail; a partial unique index in migration 0186 enforces "at
 * most one PENDING application per (world, applicant)" without
 * blocking a fresh re-apply after a reject or withdraw.
 *
 * Answers ride as a JSON array of strings keyed by question position
 * at the time of submission. Later edits to the world's questions
 * don't retroactively shorten or lengthen existing answers, what
 * the applicant wrote stays what the owner sees.
 */
export const worldApplications = sqliteTable(
  "world_applications",
  {
    id: id(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Identity the application was filed under: null = master OOC,
     * non-null = a specific character of `applicantUserId`. The
     * pending-uniqueness index keys on (world, applicant_user_id,
     * COALESCE(character_id, '')) so the same master can apply as
     * OOC AND as each character independently. Added in 0187.
     */
    characterId: text("character_id").references(() => characters.id, { onDelete: "cascade" }),
    answersJson: text("answers_json").notNull().default("[]"),
    status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] })
      .notNull()
      .default("pending"),
    submittedAt: ts("submitted_at"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
  },
  (t) => ({
    worldStatusIdx: index("world_applications_world_status_idx").on(t.worldId, t.status),
    applicantIdx: index("world_applications_applicant_idx").on(t.applicantUserId, t.status),
    // The "at most one pending per (world, applicant, identity)"
    // partial unique index lives in the migration only, drizzle's
    // typed builder doesn't model partial-expression indexes. The
    // runtime invariant is enforced both by that index AND by the
    // route layer (which queries for an existing pending row before
    // insert and converts UNIQUE-constraint races into 409s).
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
    /** Optional arc grouping (soft ref, route-validated). Migration 0213. */
    arcId: text("arc_id"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    treeIdx: index("world_pages_tree_idx").on(t.worldId, t.parentPageId, t.sortOrder),
    slugIdx: index("world_pages_slug_idx").on(t.worldId, sql`lower(${t.slug})`),
    arcIdx: index("world_pages_arc_idx").on(t.worldId, t.arcId),
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
 * Identity → world membership. A user (master account) can hold
 * memberships under multiple identities, their OOC face AND each
 * character, and each identity's membership is independent. Avery
 * can be in Halcyon City without dragging the master's OOC or
 * Sigrid along.
 *
 * Identity key: `character_id` distinguishes per-character rows
 * (non-null) from the OOC row (null). The unique index
 * `world_members_identity_uq` (migration 0187) uses
 * COALESCE(character_id, '') so the NULL slot still participates in
 * the "at most one per (world, user, identity)" enforcement.
 *
 * Joining is gated by world.visibility + world.joinMode at the
 * route layer; the table itself doesn't enforce those, so admin
 * tooling can still seed memberships for private/invite-only
 * worlds if needed.
 *
 * Note: the per-master "isPrimary" concept was retired in migration
 * 0187, with per-identity membership it became meaningless, and
 * the userlist's primary-world grouping was the surface that
 * actually leaked "this character's master is in X" by way of
 * grouping a character row under the master's primary world.
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
    /**
     * Null = the master's OOC face joined.
     * Non-null = a specific character joined; the FK cascade-deletes
     * the membership if the character is hard-deleted.
     */
    characterId: text("character_id").references(() => characters.id, { onDelete: "cascade" }),
    joinedAt: ts("joined_at"),
    // Identity-uniqueness lives in the migration via an expression
    // index on COALESCE(character_id, ''). Drizzle's typed builder
    // doesn't model expression-unique indexes, so the migration is
    // the source of truth.
  },
  (t) => ({
    userIdx: index("world_members_user_idx").on(t.userId),
    worldIdx: index("world_members_world_idx").on(t.worldId),
    characterIdx: index("world_members_character_idx").on(t.characterId),
  }),
);

/**
 * Per-world editing collaborators. The world's `ownerUserId` is always
 * an implicit editor; this table grants the same edit rights to
 * additional users the owner invites. Collaborators can edit world
 * metadata + pages but cannot manage the collaborator list itself,
 * transfer ownership, or delete the world. Created in migration 0174.
 *
 * Mirrors the scriptorium collaborator pattern (0144): minimal row
 * shape (no role enum yet) with the actual permission decisions
 * computed at request time in the worlds route.
 */
export const worldCollaborators = sqliteTable(
  "world_collaborators",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedAt: ts("added_at"),
    addedByUserId: text("added_by_user_id")
      .references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.worldId, t.userId] }),
    userIdx: index("world_collaborators_user_idx").on(t.userId),
  }),
);

/**
 * Typed knowledge-base entries inside a world (Locations, NPCs, Items/Codex,
 * Factions, and owner-defined custom kinds). Mirrors `storyEntities` (the
 * Scriptorium codex). The "Lore" type is NOT a row here — it stays the
 * `worldPages` tree. `arcId` is a soft reference (no DB FK; the arcs table
 * lands in a later migration and route handlers validate same-world). Migration
 * 0211.
 */
export const worldEntities = sqliteTable(
  "world_entities",
  {
    id: id(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    /** Built-in key (location|npc|item|faction) or a custom registry key. */
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    /** Free-form kv map (e.g. NPC stats). */
    statsJson: text("stats_json").notNull().default("{}"),
    /** Comma-separated tag list (parseTagList). Powers the By-Tag dashboard. */
    tags: text("tags").notNull().default(""),
    imageUrl: text("image_url"),
    isPublic: integer("is_public").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Optional arc grouping (soft ref, route-validated). Added in 0211 so the
     *  arcs migration doesn't need to ALTER this table. */
    arcId: text("arc_id"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    worldKindSlugUq: uniqueIndex("world_entities_world_kind_slug_uq").on(
      t.worldId,
      t.kind,
      sql`lower(${t.slug})`,
    ),
    orderIdx: index("world_entities_order_idx").on(t.worldId, t.kind, t.sortOrder),
    arcIdx: index("world_entities_arc_idx").on(t.worldId, t.arcId),
  }),
);
export type DbWorldEntity = typeof worldEntities.$inferSelect;

/**
 * Per-world registry of OWNER-DEFINED custom entry kinds. Built-in kinds
 * (location/npc/item/faction + synthetic lore) are constants in shared and are
 * NOT stored here. `worldEntities.kind` holds the key for both. Migration 0211.
 */
export const worldEntityKinds = sqliteTable(
  "world_entity_kinds",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    icon: text("icon"),
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
  },
  (t) => ({
    worldKeyUq: uniqueIndex("world_entity_kinds_world_key_uq").on(t.worldId, sql`lower(${t.key})`),
  }),
);
export type DbWorldEntityKind = typeof worldEntityKinds.$inferSelect;

/**
 * Arcs: storyline groupings that pages / entities / sessions can belong to,
 * with a status. Migration 0212.
 */
export const worldArcs = sqliteTable(
  "world_arcs",
  {
    id: id(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    /** planned | active | concluded | archived (Zod-enforced). */
    status: text("status").notNull().default("active"),
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    worldSlugUq: uniqueIndex("world_arcs_world_slug_uq").on(t.worldId, sql`lower(${t.slug})`),
    orderIdx: index("world_arcs_order_idx").on(t.worldId, t.sortOrder),
  }),
);
export type DbWorldArc = typeof worldArcs.$inferSelect;

/**
 * Sessions: chronological session-log entries. `arcId` is a soft reference
 * (no DB FK; routes validate same-world). Migration 0212.
 */
export const worldSessions = sqliteTable(
  "world_sessions",
  {
    id: id(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    arcId: text("arc_id"),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    /** Epoch ms of the in-fiction/real session date; drives chronological sort. */
    sessionDate: integer("session_date", { mode: "timestamp_ms" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    worldSlugUq: uniqueIndex("world_sessions_world_slug_uq").on(t.worldId, sql`lower(${t.slug})`),
    chronoIdx: index("world_sessions_chrono_idx").on(t.worldId, t.sessionDate, t.sortOrder),
    arcIdx: index("world_sessions_arc_idx").on(t.worldId, t.arcId),
  }),
);
export type DbWorldSession = typeof worldSessions.$inferSelect;

/* =========================================================
 *  Scriptorium, long-form fiction (migration 0139)
 *
 *  Stories are authored by identities (master account OR character)
 *  and inherit the same privacy posture as the rest of the app:
 *  visibility tiers gate who sees a story; the rating tier
 *  additionally gates anonymous splash viewers.
 * ========================================================= */

/**
 * Top-level story row. Catalog cards on the splash + in-app list read
 * directly from here; the editor + reader hydrate chapters from
 * `story_chapters` on demand. Counters (totalWords, totalChapters,
 * readerCount, etc.) are maintained on publish / read events.
 */
export const stories = sqliteTable(
  "stories",
  {
    id: id(),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null = published under the master identity. */
    authorCharacterId: text("author_character_id").references(() => characters.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    synopsisHtml: text("synopsis_html").notNull().default(""),
    coverImageUrl: text("cover_image_url"),
    themeJson: text("theme_json"),
    genre: text("genre").notNull().default("other"),
    rating: text("rating").notNull().default("PG"),
    status: text("status").notNull().default("draft"),
    visibility: text("visibility").notNull().default("private"),
    tags: text("tags").notNull().default(""),
    contentWarnings: text("content_warnings").notNull().default(""),
    linkedWorldId: text("linked_world_id").references(() => worlds.id, { onDelete: "set null" }),
    allowReviews: integer("allow_reviews").notNull().default(0),
    allowApplause: integer("allow_applause").notNull().default(1),
    /**
     * Author-set "Buy a Copy" price (migration 0216). NULL = inherit the
     * site default (`earningConfig.scriptorium.copyPrice`). When set, it's
     * bounded to STORY_COPY_PRICE_MIN..MAX (packages/shared) at the route
     * layer. Resolved everywhere as `copyPrice ?? configDefault`.
     */
    copyPrice: integer("copy_price"),
    /**
     * "Buy to Read" paywall (migration 0217). When 1, non-purchasers see only
     * a short faded sample of the first chapter and must buy a copy to read
     * on. Enforced server-side in the chapter-body route; bypassable with the
     * `bypass_scriptorium_paywall` permission.
     */
    buyToRead: integer("buy_to_read").notNull().default(0),
    totalWords: integer("total_words").notNull().default(0),
    totalChapters: integer("total_chapters").notNull().default(0),
    readerCount: integer("reader_count").notNull().default(0),
    applauseCount: integer("applause_count").notNull().default(0),
    reviewCount: integer("review_count").notNull().default(0),
    avgRatingX100: integer("avg_rating_x100"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    authorSlugUq: uniqueIndex("stories_author_slug_uq").on(t.authorUserId, sql`lower(${t.slug})`),
    catalogIdx: index("stories_catalog_idx").on(t.visibility, t.rating, t.status, t.updatedAt),
    linkedWorldIdx: index("stories_linked_world_idx").on(t.linkedWorldId),
    authorIdx: index("stories_author_idx").on(t.authorUserId, t.updatedAt),
  }),
);

/**
 * Ordered chapters inside a story. Chapter 1 is sort_order = 0. A
 * one-shot is a story with a single chapter.
 */
export const storyChapters = sqliteTable(
  "story_chapters",
  {
    id: id(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    title: text("title").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    authorNotesHtml: text("author_notes_html").notNull().default(""),
    contentWarnings: text("content_warnings").notNull().default(""),
    wordCount: integer("word_count").notNull().default(0),
    status: text("status").notNull().default("draft"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    /** When the one-time writing reward was paid for this chapter (stamped on
     *  first publish). Non-null = already rewarded; edits/re-publish never
     *  re-pay. Migration 0209. */
    rewardPaidAt: integer("reward_paid_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    orderIdx: index("story_chapters_order_idx").on(t.storyId, t.sortOrder),
    publishedIdx: index("story_chapters_published_idx").on(t.storyId, t.status, t.publishedAt),
  }),
);

/**
 * Per-authoring-identity weekly publishing streak for Scriptorium writing
 * rewards. Mirrors the eidolon care-streak shape but keyed on ISO week
 * (YYYY-Www) instead of UTC day: publishing a chapter in consecutive weeks
 * raises `streak_count`, which multiplies the chapter payout; a gap of two or
 * more weeks resets it. Migration 0209.
 */
export const scriptoriumWriteStreaks = sqliteTable(
  "scriptorium_write_streaks",
  {
    /** Per-server economy partition (migration 0286). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    streakCount: integer("streak_count").notNull().default(0),
    /** ISO week-key (YYYY-Www) of the last rewarded publish; null until first. */
    lastPublishWeekKey: text("last_publish_week_key"),
    bestStreak: integer("best_streak").notNull().default(0),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.ownerScope, t.ownerId] }),
  }),
);
export type DbScriptoriumWriteStreak = typeof scriptoriumWriteStreaks.$inferSelect;

/**
 * A purchased copy of a published story. "Buy a Copy" costs the buyer currency
 * (a royalty cut goes to the author); an owned copy can optionally be showcased
 * on the buyer's profile in a Library column. One copy per identity per story.
 * Migration 0210.
 */
export const storyCopies = sqliteTable(
  "story_copies",
  {
    id: id(),
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
    /** Buyer identity: "user" (master/OOC) or "character". */
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** Buyer's master account, for cascade cleanup + the self-buy guard. */
    ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    pricePaid: integer("price_paid").notNull().default(0),
    /** Profile showcase slot; null = owned but not shown, non-null = pinned. */
    showcaseSlot: integer("showcase_slot"),
    purchasedAt: ts("purchased_at"),
  },
  (t) => ({
    ownerStoryUq: uniqueIndex("story_copies_owner_story_uq").on(t.serverId, t.ownerScope, t.ownerId, t.storyId),
    showcaseIdx: index("story_copies_showcase_idx").on(t.serverId, t.ownerScope, t.ownerId, t.showcaseSlot),
    storyIdx: index("story_copies_story_idx").on(t.storyId),
  }),
);
export type DbStoryCopy = typeof storyCopies.$inferSelect;

/**
 * Immutable per-chapter version snapshots. Autosave frames are pruned
 * past a per-chapter cap (default 20, enforced in the route layer);
 * publish frames are kept indefinitely.
 */
export const storyChapterVersions = sqliteTable(
  "story_chapter_versions",
  {
    id: id(),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => storyChapters.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    bodyHtml: text("body_html").notNull().default(""),
    authorNotesHtml: text("author_notes_html").notNull().default(""),
    reason: text("reason").notNull().default("autosave"),
    savedByUserId: text("saved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    savedAt: ts("saved_at"),
  },
  (t) => ({
    chapterVersionUq: uniqueIndex("story_chapter_versions_chapter_version_uq").on(t.chapterId, t.version),
    chapterIdx: index("story_chapter_versions_chapter_idx").on(t.chapterId, t.savedAt),
  }),
);

/**
 * Per-reader "continue reading" pointer. Author cannot see WHICH
 * readers have a row, only the aggregate readerCount. Admins cannot
 * pull individual positions either.
 */
export const storyReadingPositions = sqliteTable(
  "story_reading_positions",
  {
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastChapterId: text("last_chapter_id").references(() => storyChapters.id, { onDelete: "set null" }),
    lastAnchorId: text("last_anchor_id"),
    /** Integer 0..1000 (percent * 10) so we can sort without floats. */
    percentThrough: integer("percent_through").notNull().default(0),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.storyId, t.userId] }),
    userIdx: index("story_reading_positions_user_idx").on(t.userId, t.updatedAt),
  }),
);

/* ---------- Scriptorium reviews + replies + applause (migration 0140) ---------- */

/**
 * Top-level review. One per (story, reviewer identity). Mirror of the
 * "identity = master + character" tuple: a player and one of their
 * characters each get their own review slot.
 *
 * `pinnedByAuthor` floats the review to the top of the story's review
 * list; `hiddenByAuthor` removes it from public view (the reviewer
 * still sees it on their own surface, same shape as `/ignore`).
 * `editGraceExpiresAt` is a 60-second window mirroring chat + DM grace.
 */
export const storyReviews = sqliteTable(
  "story_reviews",
  {
    id: id(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    reviewerUserId: text("reviewer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reviewerCharacterId: text("reviewer_character_id").references(() => characters.id, { onDelete: "set null" }),
    rating: integer("rating").notNull(),
    bodyHtml: text("body_html").notNull().default(""),
    pinnedByAuthor: integer("pinned_by_author").notNull().default(0),
    hiddenByAuthor: integer("hidden_by_author").notNull().default(0),
    editGraceExpiresAt: integer("edit_grace_expires_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    // Identity-tuple uniqueness, partial index expression in the
    // migration (drizzle's typed builder doesn't expose the COALESCE
    // form directly).
    storyIdx: index("story_reviews_story_idx").on(t.storyId, t.createdAt),
    reviewerIdx: index("story_reviews_reviewer_idx").on(t.reviewerUserId, t.createdAt),
  }),
);

/** Threaded one level under a review. Plain sanitized HTML. */
export const storyReviewReplies = sqliteTable(
  "story_review_replies",
  {
    id: id(),
    reviewId: text("review_id")
      .notNull()
      .references(() => storyReviews.id, { onDelete: "cascade" }),
    replyerUserId: text("replyer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    replyerCharacterId: text("replyer_character_id").references(() => characters.id, { onDelete: "set null" }),
    bodyHtml: text("body_html").notNull().default(""),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    reviewIdx: index("story_review_replies_review_idx").on(t.reviewId, t.createdAt),
  }),
);

/**
 * Applause, idempotent boolean per (reader, target). Target is either
 * the whole story (chapterId null) or a specific chapter. Author
 * cannot see WHO applauded; only the rollup count on the story row.
 */
export const storyApplause = sqliteTable(
  "story_applause",
  {
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => storyChapters.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    applaudedAt: ts("applauded_at"),
  },
  (t) => ({
    // Uniqueness is enforced by a COALESCE-expression unique index in
    // the migration, SQLite forbids expressions in PK/UNIQUE
    // constraints, so this is a UNIQUE INDEX rather than a composite
    // PK. Rowid is the implicit primary key.
    uq: uniqueIndex("story_applause_uq").on(
      t.storyId,
      sql`coalesce(${t.chapterId}, '')`,
      t.userId,
    ),
    storyIdx: index("story_applause_story_idx").on(t.storyId),
  }),
);

/* ---------- Scriptorium subscriptions (Phase 7) ---------- */

/**
 * Per-reader story subscription. On chapter publish, every row here is
 * notified (in-app via socket; optional web-push when pushEnabled).
 * Author cannot see WHO is subscribed, only the rollup count.
 */
export const storySubscriptions = sqliteTable(
  "story_subscriptions",
  {
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pushEnabled: integer("push_enabled").notNull().default(0),
    subscribedAt: ts("subscribed_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.storyId, t.userId] }),
    userIdx: index("story_subscriptions_user_idx").on(t.userId, t.subscribedAt),
    storyIdx: index("story_subscriptions_story_idx").on(t.storyId),
  }),
);

/* ---------- Scriptorium chapter locks (Phase 5, soft-lock) ---------- */

/**
 * Advisory editing lock on a single chapter. Acquired when a
 * collaborator opens the chapter editor; refreshed by client
 * heartbeat. Lease is 5 minutes since `lastRefreshAt`; the server
 * treats expired rows as available (lazy GC on the next acquire).
 *
 * "Force edit" simply bypasses the lock, the save still goes through
 * and divergence surfaces in the version history (each save is its
 * own row keyed by `savedByUserId`).
 */
export const storyChapterLocks = sqliteTable(
  "story_chapter_locks",
  {
    chapterId: text("chapter_id")
      .primaryKey()
      .references(() => storyChapters.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    acquiredAt: ts("acquired_at"),
    lastRefreshAt: ts("last_refresh_at"),
  },
  (t) => ({
    userIdx: index("story_chapter_locks_user_idx").on(t.userId),
  }),
);

/* ---------- Scriptorium collaborators (Phase 5) ---------- */

/**
 * Per-story collaborators. The owner (`stories.authorUserId`) is
 * implicit and never has a row here. Three added roles:
 *
 *   reader   , read drafts only (beta readers)
 *   editor   , edit existing chapters + manage codex
 *   co_author, edit + add chapters, publish; cannot manage
 *               collaborators or delete the story
 *
 * `acceptedAt` null = pending invite (recipient hasn't decided);
 * non-null = active. Declining deletes the row server-side, so the
 * "rejected" state never persists.
 */
export const storyCollaborators = sqliteTable(
  "story_collaborators",
  {
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    invitedAt: ts("invited_at"),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.storyId, t.userId] }),
    userIdx: index("story_collaborators_user_idx").on(t.userId, t.invitedAt),
    storyIdx: index("story_collaborators_story_idx").on(t.storyId, t.acceptedAt),
  }),
);

/* ---------- Scriptorium codex (Phase 8) ---------- */

/**
 * Per-story continuity bible. Three discriminated kinds, characters,
 * locations, plot points, share one table with a `kind` column. Each
 * entity has a per-(story, kind) unique slug so a character and a
 * location can share a name without colliding.
 *
 * `isPublic` opt-in surfaces an entity in the reader's "Cast & places"
 * appendix on the story landing page. Private by default, plot
 * outlines especially shouldn't leak by default.
 */
export const storyEntities = sqliteTable(
  "story_entities",
  {
    id: id(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    /** "character" | "location" | "plot", enforced at the Zod layer. */
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    /** Free-form kv map. Renderer / editor decide what to surface per kind. */
    statsJson: text("stats_json").notNull().default("{}"),
    imageUrl: text("image_url"),
    isPublic: integer("is_public").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    storyKindSlugUq: uniqueIndex("story_entities_story_kind_slug_uq").on(
      t.storyId,
      t.kind,
      sql`lower(${t.slug})`,
    ),
    orderIdx: index("story_entities_order_idx").on(t.storyId, t.kind, t.sortOrder),
  }),
);

/* ---------- Scriptorium reports (Phase 10) ---------- */

/**
 * User-filed report against a story, chapter, review, or review reply.
 * One unified table with a `targetKind` discriminator keeps the admin
 * queue surface uniform.
 *
 * The `snapshotJson` captures title / body / metadata at report time
 * so the queue stays useful even if the author later deletes the
 * reported content, mirror of the `bodySnapshot` pattern on the DM
 * reports column of `reports` above.
 *
 * One report per (reporter, target). Second click silently no-ops.
 */
export const storyReports = sqliteTable(
  "story_reports",
  {
    id: id(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    reporterUserId: text("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason"),
    snapshotJson: text("snapshot_json").notNull().default("{}"),
    status: text("status", { enum: ["open", "reviewed", "dismissed"] })
      .notNull()
      .default("open"),
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolutionNote: text("resolution_note"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    reporterTargetUq: uniqueIndex("story_reports_reporter_target_uq").on(
      t.reporterUserId,
      t.targetKind,
      t.targetId,
    ),
    statusIdx: index("story_reports_status_idx").on(t.status, t.createdAt),
    storyIdx: index("story_reports_story_idx").on(t.storyId),
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
    /**
     * Scope discriminator (migration 0278a). NULL = app-global / platform-owned;
     * a server_id scopes the entry to that server's Mod Log. ON DELETE SET NULL
     * so deleting a server un-scopes (never destroys) audit history.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    createdIdx: index("audit_log_created_idx").on(t.createdAt),
    actorIdx: index("audit_log_actor_idx").on(t.actorUserId, t.createdAt),
    targetIdx: index("audit_log_target_idx").on(t.targetUserId, t.createdAt),
    actionIdx: index("audit_log_action_idx").on(t.action, t.createdAt),
    serverIdx: index("audit_log_server_idx").on(t.serverId, t.createdAt),
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
     * (messageId, directMessageId) is set on a given row, enforced
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
     * reason, the admin row stands on its own.
     */
    directMessageId: text("direct_message_id").references(() => directMessages.id, { onDelete: "set null" }),
    bodySnapshot: text("body_snapshot"),
    senderUserId: text("sender_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * Scope discriminator (migration 0278c) — the SINGLE home for per-server
     * message reports (there is NO server_reports table). Message/room reports
     * route to the room's server; DM/profile reports (no room) stay NULL =
     * platform/site staff. ON DELETE SET NULL so deleting a server un-scopes
     * the reports rather than destroying them.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    statusIdx: index("reports_status_idx").on(t.status, t.createdAt),
    reporterMsgUq: uniqueIndex("reports_reporter_msg_uq").on(t.reporterUserId, t.messageId),
    serverIdx: index("reports_server_idx").on(t.serverId, t.status, t.createdAt),
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
     * the friended user hasn't responded yet, they appear in the
     * inbox but NOT in either party's friends list. `accepted` means
     * the friendship is mutual: both sides see the other in their
     * list. Decline removes the row entirely (no `'declined'` state,
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

/* ============================================================
 * Forums — user-owned message boards (plan.md "Forums Revamp").
 *
 * A forum is a CONTAINER above rooms: `rooms.forumId` set ⇒ that room
 * is a "board" inside the forum (always replyMode "nested"). Topics,
 * replies, stickies, locks, reports, and earning awards all keep
 * living on the rooms/messages tables — these tables only add the
 * container, its roles, its bans, and the two application workflows
 * (forum creation, reviewed by site staff; forum membership, reviewed
 * by the forum owner/mods when postingMode = "application").
 * ============================================================ */

export const forums = sqliteTable(
  "forums",
  {
    id: id(),
    /** Share-URL slug (`/f/<slug>`), canonical lowercase [a-z0-9_]{3,40},
     *  globally unique, immutable in v1 so share links never rot.
     *  Reserved names are rejected at the route layer (shared
     *  RESERVED_FORUM_SLUGS). */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** Short purpose line, seeded from the creation application. */
    tagline: text("tagline"),
    /** Owner-editable long description (sanitized like profile bios). */
    descriptionHtml: text("description_html"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The Spire Forums = true: site-owned, undeletable, catalog-pinned. */
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    /** `featured` is admin-curated (pins to catalog top); owners flip
     *  between active and archived. */
    status: text("status", { enum: ["active", "featured", "archived"] })
      .notNull()
      .default("active"),
    /** Reserved for a future "hidden" tier — v1 is public-only, the
     *  column exists so that becomes a flip, not a migration. */
    visibility: text("visibility", { enum: ["public"] }).notNull().default("public"),
    /** open = any signed-in non-banned user may post; application =
     *  membership application reviewed by owner/mods. */
    postingMode: text("posting_mode", { enum: ["open", "application"] })
      .notNull()
      .default("open"),
    /** Owner toggle (migration 0237): anonymous visitors on /f/<slug>
     *  may READ boards/topics/replies without an account. Posting and
     *  joining always require login. Off by default. */
    publicBrowsing: integer("public_browsing", { mode: "boolean" }).notNull().default(false),
    /** Owner toggle (migration 0268): when true, a mod holding the
     *  `create_tags` granular permission may mint a topic tag on the fly when
     *  tagging a topic. Off = the curated catalog only, offered per category. */
    allowCustomTags: integer("allow_custom_tags", { mode: "boolean" }).notNull().default(false),
    /** Owner-set prompt above the membership application's answer field
     *  (migration 0230). Null = a generic "tell the keeper why" prompt. */
    applicationPrompt: text("application_prompt"),
    /** Per-forum theme JSON (normalizeTheme on read). Scoped to the forum
     *  modal + /f/ page only — never bleeds into chat (worlds pattern). */
    themeJson: text("theme_json"),
    /** Per-forum DESIGN style (ornaments/chrome: medieval, glass, …) —
     *  orthogonal to the palette, mirrors users.style_key. Null = the
     *  viewer's own design. Scoped to the forum's card (migration 0232). */
    themeStyleKey: text("theme_style_key"),
    logoUrl: text("logo_url"),
    bannerImageUrl: text("banner_image_url"),
    /** Vertical banner focus: 0 = show the image's top band, 100 = the
     *  bottom, 50 = center (migration 0234). Cover-cropping picks the
     *  band; the keeper picks which one. */
    bannerFocusY: integer("banner_focus_y").notNull().default(50),
    /** Optional world attachment: the forum header shows the world's
     *  banner strip with view/join/apply actions. */
    linkedWorldId: text("linked_world_id").references(() => worlds.id, { onDelete: "set null" }),
    /** JSON array of roomIds giving the owner's explicit board ordering;
     *  boards missing from the list sort by createdAt after it. */
    boardOrderJson: text("board_order_json").notNull().default("[]"),
    /**
     * Server container (migration 0277). A forum belongs to a server: server is
     * the OUTER container, forum the INNER sub-container, room the leaf. ON
     * DELETE SET NULL so deleting a server un-homes its forums rather than
     * destroying them; the app treats NULL as the default server. NULL until
     * the Phase-2 backfill.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
    /** Owner-set genre/category tags for discovery search (migration 0301).
     *  JSON string[] (lowercased/normalized via shared normalizeTags); NULL =
     *  none. Mirrors servers.tagsJson for the identical forum discover UX. */
    tagsJson: text("tags_json"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    slugUq: uniqueIndex("forums_slug_uq").on(sql`lower(${t.slug})`),
    ownerIdx: index("forums_owner_idx").on(t.ownerUserId),
    statusIdx: index("forums_status_idx").on(t.status),
    serverIdx: index("forums_server_idx").on(t.serverId),
  }),
);

/**
 * Forum-creation applications — the "Create your Forum" workflow.
 * Reviewed by site staff (`review_forum_applications`), NOT forum
 * owners. Same lifecycle + audit posture as world_applications:
 * terminal rows stay; a partial unique index (migration 0224) enforces
 * at most one PENDING application per applicant.
 */
export const forumCreationApplications = sqliteTable(
  "forum_creation_applications",
  {
    id: id(),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedName: text("requested_name").notNull(),
    requestedSlug: text("requested_slug").notNull(),
    /** The application's "what is your forum for" prose (30..500 chars). */
    purpose: text("purpose").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] })
      .notNull()
      .default("pending"),
    submittedAt: ts("submitted_at"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
    /** When the applicant ticked the registration-rules agreement (migration
     *  0301). NULL = legacy / no rules in force at submit. */
    agreedAt: integer("agreed_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    statusIdx: index("forum_creation_apps_status_idx").on(t.status, t.submittedAt),
    applicantIdx: index("forum_creation_apps_applicant_idx").on(t.applicantUserId, t.status),
    // "One pending per applicant" partial unique index lives in the
    // migration (drizzle's builder doesn't model partial indexes); the
    // route layer also pre-checks and maps races to 409.
  }),
);

/**
 * Forum membership + roles. Only meaningful rows:
 *   - owner: exactly one per forum (the approved applicant; transferable
 *     by site staff later).
 *   - mod:   owner-assigned helpers (topic-level powers only).
 *   - member: approved applicants when postingMode = "application".
 * Open-posting forums don't require membership rows to post.
 */
export const forumMembers = sqliteTable(
  "forum_members",
  {
    forumId: text("forum_id")
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "mod", "member"] })
      .notNull()
      .default("member"),
    /** Granular mod permissions (migration 0264): JSON array of
     *  FORUM_MOD_PERMISSIONS keys the owner granted this mod. Empty for
     *  owners/members (owners hold all implicitly; members hold none).
     *  Parse via parseForumModPermissions; write via serializeForumModPermissions. */
    permissionsJson: text("permissions_json").notNull().default("[]"),
    joinedAt: ts("joined_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.forumId, t.userId] }),
    userIdx: index("forum_members_user_idx").on(t.userId),
  }),
);

/**
 * Per-account saved NPCs (migration 0267). Name + optional stat lines,
 * reusable in any forum subject to that forum's `use_npc` grant. Posting as
 * an NPC snapshots the stats onto the message, so this is the editable
 * "source" the user re-selects from.
 */
export const userNpcs = sqliteTable(
  "user_npcs",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** JSON array of {label,value} stat lines. */
    statsJson: text("stats_json").notNull().default("[]"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    userIdx: index("user_npcs_user_idx").on(t.userId, t.updatedAt),
  }),
);
export type DbUserNpc = typeof userNpcs.$inferSelect;

/**
 * Forum topic prefixes (migration 0266). Owner-curated labels shown as
 * colored chips on topic cards + filterable. A topic's assigned prefix is
 * `messages.prefix_id`. Curated via manage_prefixes.
 */
export const forumPrefixes = sqliteTable(
  "forum_prefixes",
  {
    id: id(),
    forumId: text("forum_id").notNull().references(() => forums.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    color: text("color").notNull().default("#888888"),
    /** Short owner-written explanation of the tag, shown on hover (migration
     *  0269). Null = none (the label stands alone). */
    tooltip: text("tooltip"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** JSON array of room_thread_category ids this tag is offered in
     *  (migration 0268). Empty `[]` = global (every topic). Non-empty =
     *  only topics filed under those categories see it in the picker. */
    categoryIdsJson: text("category_ids_json").notNull().default("[]"),
    /** When set, only a `manage_prefixes` mod/owner may attach or remove this
     *  tag on a topic — the ordinary topic author can't (migration 0273). Lets
     *  a keeper mint authoritative tags (e.g. "Announcement") members can't
     *  self-apply. Default false = any author may set it on their own topic. */
    staffOnly: integer("staff_only", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
  },
  (t) => ({
    forumIdx: index("forum_prefixes_forum_idx").on(t.forumId, t.sortOrder),
  }),
);
export type DbForumPrefix = typeof forumPrefixes.$inferSelect;

/**
 * Forum usergroups (migration 0270). Owner/admin-defined groups granting a set
 * of forum permissions (the unified registry — moderation + member features).
 * Effective perms for a member = union of the default group + every group
 * they're in + any direct mod grant (forum_members.permissions_json).
 */
export const forumUsergroups = sqliteTable(
  "forum_usergroups",
  {
    id: id(),
    forumId: text("forum_id").notNull().references(() => forums.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Optional chip color for the group's label. */
    color: text("color"),
    /** JSON array of ForumPermission keys this group grants. */
    permissionsJson: text("permissions_json").notNull().default("[]"),
    /** Exactly one per forum: the implicit baseline for every participant
     *  (no member rows). Editing it changes what ungrouped members can do. */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    /** JSON array of ForumAutoRule[] — ALL must match for an auto-join. */
    autoRulesJson: text("auto_rules_json").notNull().default("[]"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    forumIdx: index("forum_usergroups_forum_idx").on(t.forumId, t.sortOrder),
    // NOTE: a partial UNIQUE index `forum_usergroups_one_default` on (forum_id)
    // WHERE is_default = 1 (migration 0271) enforces one default group per
    // forum. Drizzle can't model partial indexes, so it lives only in the SQL.
  }),
);
export type DbForumUsergroup = typeof forumUsergroups.$inferSelect;

/**
 * Explicit (non-default) usergroup memberships. `addedBy` null + `isAuto` true
 * = an automatic membership earned via the group's auto-join rules; a manual
 * add records the acting manager with `isAuto` false.
 */
export const forumUsergroupMembers = sqliteTable(
  "forum_usergroup_members",
  {
    groupId: text("group_id").notNull().references(() => forumUsergroups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    addedAt: ts("added_at"),
    addedBy: text("added_by"),
    isAuto: integer("is_auto", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    userIdx: index("forum_usergroup_members_user_idx").on(t.userId),
  }),
);
export type DbForumUsergroupMember = typeof forumUsergroupMembers.$inferSelect;

/**
 * Forum report queue (migration 0265). A member flags a topic/post to the
 * forum's owner + mods holding `handle_reports`. Forum-scoped — never
 * reaches site moderation (that's the separate `reports` table).
 */
export const forumReports = sqliteTable(
  "forum_reports",
  {
    id: id(),
    forumId: text("forum_id").notNull().references(() => forums.id, { onDelete: "cascade" }),
    /** The reported post (topic header or reply). */
    messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    /** Snapshot of the board + top-level topic for deep-linking the queue. */
    boardRoomId: text("board_room_id").references(() => rooms.id, { onDelete: "set null" }),
    topicId: text("topic_id").references(() => messages.id, { onDelete: "set null" }),
    reporterUserId: text("reporter_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    /** open | resolved | dismissed. */
    status: text("status", { enum: ["open", "resolved", "dismissed"] }).notNull().default("open"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    resolutionNote: text("resolution_note"),
    createdAt: ts("created_at"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    forumIdx: index("forum_reports_forum_idx").on(t.forumId, t.status, t.createdAt),
    // A partial UNIQUE index `forum_reports_one_open_uq` on
    // (forum_id, message_id, reporter_user_id) WHERE status='open' lives in
    // migration 0265 — drizzle's builder doesn't model partial indexes. The
    // POST /forums/:id/reports route pre-checks AND catches the index's
    // violation on the concurrent race, so re-reporting an open post is a
    // graceful no-op either way.
  }),
);
export type DbForumReport = typeof forumReports.$inferSelect;

/**
 * Forum membership applications (postingMode = "application" forums).
 * Reviewed by the forum owner + forum mods in the forum settings page.
 * Lifecycle mirrors world_applications; partial unique index (0225)
 * enforces one PENDING per (forum, applicant).
 */
export const forumMembershipApplications = sqliteTable(
  "forum_membership_applications",
  {
    id: id(),
    forumId: text("forum_id")
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Free-text answer to the owner's prompt; null = no prompt set. */
    answer: text("answer"),
    status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] })
      .notNull()
      .default("pending"),
    submittedAt: ts("submitted_at"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
  },
  (t) => ({
    forumStatusIdx: index("forum_membership_apps_forum_idx").on(t.forumId, t.status),
    applicantIdx: index("forum_membership_apps_applicant_idx").on(t.applicantUserId, t.status),
  }),
);

/**
 * Per-user last-visit marker (migration 0231), one row per (user, forum).
 * Drives the catalog's "new since you last looked" dot: unseen when the
 * forum's lastActivityAt outruns this timestamp (or no row exists).
 * Upserted when a signed-in user selects the forum in the catalog.
 */
export const forumVisits = sqliteTable(
  "forum_visits",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    forumId: text("forum_id")
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    lastVisitAt: ts("last_visit_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.forumId] }),
  }),
);

/**
 * OpenGraph unfurl cache (migration 0238): one row per fetched URL so a
 * popular link is fetched once per TTL, not once per message. `json` is
 * the LinkPreview payload, or '{}' for negative results (nothing
 * previewable / unsafe target) so failures are cached too.
 */
export const ogUnfurlCache = sqliteTable("og_unfurl_cache", {
  url: text("url").primaryKey(),
  json: text("json").notNull().default("{}"),
  fetchedAt: ts("fetched_at"),
});

/**
 * Per-topic read markers (migration 0236): a topic shows unread while
 * its lastActivityAt outruns lastReadAt (or no row). Upserted when the
 * user opens the topic in the Forums Catalog.
 */
export const forumTopicReads = sqliteTable(
  "forum_topic_reads",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    topicId: text("topic_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    lastReadAt: ts("last_read_at"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.topicId] }) }),
);

/**
 * Topic watches (migration 0236): explicit subscriptions. Authors
 * auto-watch their topics; repliers auto-watch what they reply to.
 * Watchers get a notification for every new reply.
 */
export const forumTopicWatches = sqliteTable(
  "forum_topic_watches",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    topicId: text("topic_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.topicId] }) }),
);

/**
 * Forum notification inbox (migration 0236). Display fields are
 * SNAPSHOTS (actor name, topic title, snippet) so the inbox survives
 * renames; FKs cascade so deleted posts/topics/forums take their
 * notifications with them. kind: reply (your topic) | quote (you were
 * quoted) | watch (watched topic got a reply).
 */
export const forumNotifications = sqliteTable(
  "forum_notifications",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["reply", "quote", "watch"] }).notNull(),
    forumId: text("forum_id").notNull().references(() => forums.id, { onDelete: "cascade" }),
    boardRoomId: text("board_room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    topicId: text("topic_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    actorName: text("actor_name").notNull(),
    topicTitle: text("topic_title").notNull(),
    snippet: text("snippet").notNull().default(""),
    createdAt: ts("created_at"),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    userIdx: index("forum_notifications_user_idx").on(t.userId, t.createdAt),
    unreadIdx: index("forum_notifications_unread_idx").on(t.userId, t.readAt),
  }),
);

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

/**
 * Per-forum bans, owner-issued (site staff with manage_any_forum can
 * lift). Scoped STRICTLY to the forum's boards — a forum ban must never
 * affect the rest of the site. `until` null = permanent. Enforced at:
 * board join, topic post/reply, membership-application submit.
 */
export const forumBans = sqliteTable(
  "forum_bans",
  {
    forumId: text("forum_id")
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    until: integer("until", { mode: "timestamp_ms" }),
    reason: text("reason"),
    issuedById: text("issued_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.forumId, t.userId] }),
    userIdx: index("forum_bans_user_idx").on(t.userId),
  }),
);

/* ===========================================================================
 * Servers Lift, Phase 1 (migrations 0275-0277). A SERVER is the new top-level
 * tenant ABOVE rooms/forums — the existing single chat ("The Spire") becomes
 * the DEFAULT server every new registrant auto-joins; users may apply to
 * register their own. These are near-verbatim clones of the forum analogs
 * above (forums / forum_members / forum_usergroups / …) with the same posture.
 * ======================================================================== */

/**
 * The `servers` container (migration 0275). Mirror of `forums` (0222):
 *   - slug is globally unique (`/s/<slug>`), immutable in v1; reserved names
 *     rejected at the route layer (shared SERVER_SLUG_RE + RESERVED_SERVER_SLUGS).
 *   - isSystem = true marks the undeletable, catalog-pinned default server.
 *   - isDefault = true marks the auto-join target for new registrants (exactly
 *     one row, enforced by the partial unique index `servers_one_default`).
 *   - Branding columns RE-HOME the per-server slice of the site_settings
 *     singleton; platform identity stays on the singleton (see serverSettings).
 */
export const servers = sqliteTable(
  "servers",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline"),
    descriptionHtml: text("description_html"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The Spire = true: site-owned, undeletable, catalog-pinned, implicit-member. */
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    /** Exactly one per install: the auto-join target for new registrants. */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /** featured = admin-curated (pins catalog top); owners flip active/archived. */
    status: text("status", { enum: ["active", "featured", "archived"] })
      .notNull()
      .default("active"),
    /** public | unlisted | invite_only; v1 is public-only in practice. */
    visibility: text("visibility", { enum: ["public", "unlisted", "invite_only"] })
      .notNull()
      .default("public"),
    /** open = any signed-in non-banned user may join+chat; application = join
     *  gated by an owner/mod-reviewed membership application; invite = code-gated. */
    joinMode: text("join_mode", { enum: ["open", "application", "invite"] })
      .notNull()
      .default("open"),
    /** Anonymous visitors on /s/<slug> may READ the server's public rooms
     *  without an account (mirrors forums.publicBrowsing). Off by default. */
    publicBrowsing: integer("public_browsing", { mode: "boolean" }).notNull().default(false),
    /** Owner-set prompt above the membership application's answer field. */
    applicationPrompt: text("application_prompt"),
    /** Stable per-server landing room (server-scoped mirror of rooms.isDefault).
     *  Nullable until provisioning / the Phase-2 backfill points it. No FK
     *  (the ALTER adds none — kept a plain text id). */
    defaultRoomId: text("default_room_id"),
    /** Per-server branding (re-homed from site_settings). Scoped to this
     *  server's chat shell + /s/ page; never bleeds into another server. */
    themeJson: text("theme_json"),
    themeStyleKey: text("theme_style_key"),
    logoUrl: text("logo_url"),
    bannerImageUrl: text("banner_image_url"),
    bannerFocusY: integer("banner_focus_y").notNull().default(50),
    bannerCoverCss: text("banner_cover_css"),
    /** Monogram tint when the server has no logo image. */
    iconColor: text("icon_color"),
    /** Owner-set accent ring around the rail icon (shows even on logo tiles). */
    borderColor: text("border_color"),
    /** Wide wordmark logo that replaces the app logo in the top bar inside this
     *  server (distinct from logoUrl, the square rail icon). */
    horizontalLogoUrl: text("horizontal_logo_url"),
    /** Pan/zoom focus for the icon + banner — AvatarCrop JSON
     *  ({zoom,offsetX,offsetY}); NULL = centered, no zoom. banner_crop
     *  supersedes banner_focus_y for new positioning. */
    iconCrop: text("icon_crop"),
    bannerCrop: text("banner_crop"),
    /** Owner-set top-bar banner height in px. NULL = default responsive height. */
    bannerHeight: integer("banner_height"),
    /** JSON array of roomIds giving the owner's explicit room ordering in the rail. */
    roomOrderJson: text("room_order_json").notNull().default("[]"),
    /** Owner-set genre/category tags for discovery search (migration 0301).
     *  JSON string[] (lowercased/normalized via shared normalizeTags); NULL =
     *  none. Searched alongside name in the discover modal's search mode. */
    tagsJson: text("tags_json"),
    /** Global-admin moderation state (migration 0306). 'suspended' = indefinite
     *  "under review" hold; 'banned' = auto-expires once moderationUntil passes
     *  (lazy expiry — the row is never cleaned up). A ban past its until behaves
     *  exactly like 'none' EVERYWHERE. Only the server owner, the owner's
     *  admins/mods, and global staff (manage_any_server) may enter while active;
     *  everyone else is blocked at serverAuthority.canParticipate and hidden from
     *  discovery/catalog. The isSystem/home server can NEVER be moderated. */
    moderationState: text("moderation_state", { enum: ["none", "suspended", "banned"] })
      .notNull()
      .default("none"),
    /** When a 'banned' state auto-expires (timestamp ms; NULL = indefinite).
     *  Ignored for 'suspended' (which never expires without a manual lift).
     *  Lazy-evaluated at read time — see isServerModerationActive. */
    moderationUntil: integer("moderation_until", { mode: "timestamp_ms" }),
    /** Optional free-text note from the global admin (shown after the notice). */
    moderationNote: text("moderation_note"),
    /** FK to the global admin who issued the moderation. SET NULL on account
     *  delete so the moderation record survives the actor's removal. */
    moderationByUserId: text("moderation_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** When the moderation was issued (timestamp ms; NULL for legacy rows). */
    moderationAt: integer("moderation_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    slugUq: uniqueIndex("servers_slug_uq").on(sql`lower(${t.slug})`),
    ownerIdx: index("servers_owner_idx").on(t.ownerUserId),
    statusIdx: index("servers_status_idx").on(t.status),
    // A partial UNIQUE `servers_one_default` on (is_default) WHERE is_default=1
    // (migration 0275) enforces exactly one auto-join default server per
    // install. Drizzle can't model partial indexes, so it lives in the SQL only.
  }),
);
export type DbServer = typeof servers.$inferSelect;

/**
 * Relational membership + role per (server, user) (migration 0275). PER-ACCOUNT
 * (mirror forum_members). owner (one per server) / admin / mod (granular via
 * permissionsJson) / member. The DEFAULT (isSystem) server treats every
 * signed-in user as an implicit member with NO row — explicit rows are written
 * for management enumeration, not as the access source of truth.
 */
export const serverMembers = sqliteTable(
  "server_members",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "mod", "member"] })
      .notNull()
      .default("member"),
    /** Granular SERVER_MOD_PERMISSIONS keys this mod was granted, as
     *  serializeServerModPermissions output (JSON array). Empty for owners and
     *  members. A SEPARATE per-server registry, NOT the global PERMISSION_KEYS
     *  matrix — never mints a global mod/admin tier. */
    permissionsJson: text("permissions_json").notNull().default("[]"),
    joinedAt: ts("joined_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.userId] }),
    userIdx: index("server_members_user_idx").on(t.userId),
  }),
);
export type DbServerMember = typeof serverMembers.$inferSelect;

/**
 * Server-CREATION applications ("Register your own Server") (migration 0275).
 * Reviewed by SITE staff (`review_server_applications`), NOT server owners —
 * mirror forum_creation_applications. A partial unique index enforces at most
 * one PENDING application per applicant (lives in the SQL).
 */
export const serverCreationApplications = sqliteTable(
  "server_creation_applications",
  {
    id: id(),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedName: text("requested_name").notNull(),
    requestedSlug: text("requested_slug").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] })
      .notNull()
      .default("pending"),
    submittedAt: ts("submitted_at"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
    /** When the applicant ticked the registration-rules agreement (migration
     *  0301). NULL = legacy / no rules in force at submit. */
    agreedAt: integer("agreed_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    statusIdx: index("server_creation_apps_status_idx").on(t.status, t.submittedAt),
    applicantIdx: index("server_creation_apps_applicant_idx").on(t.applicantUserId, t.status),
    // Partial UNIQUE `server_creation_apps_one_pending_uq` on (applicant_user_id)
    // WHERE status='pending' (migration 0275) lives in the SQL only.
  }),
);
export type DbServerCreationApplication = typeof serverCreationApplications.$inferSelect;

/**
 * Per-server membership applications (joinMode='application' servers)
 * (migration 0275). Reviewed by the server owner + mods. Mirror
 * forum_membership_applications; one PENDING per (server, applicant).
 */
export const serverMembershipApplications = sqliteTable(
  "server_membership_applications",
  {
    id: id(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    applicantUserId: text("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    answer: text("answer"),
    status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] })
      .notNull()
      .default("pending"),
    submittedAt: ts("submitted_at"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
  },
  (t) => ({
    serverStatusIdx: index("server_membership_apps_server_idx").on(t.serverId, t.status),
    applicantIdx: index("server_membership_apps_applicant_idx").on(t.applicantUserId, t.status),
    // Partial UNIQUE `server_membership_apps_one_pending_uq` on
    // (server_id, applicant_user_id) WHERE status='pending' lives in the SQL.
  }),
);
export type DbServerMembershipApplication = typeof serverMembershipApplications.$inferSelect;

/**
 * Per-server usergroups (migration 0275, mirror forum_usergroups). Owner-defined
 * groups granting a set of SERVER_PERMISSIONS as serializeServerPermissions
 * output. Effective perms for a member = union of the default group + every
 * group they're in + any direct mod grant (server_members.permissionsJson).
 */
export const serverUsergroups = sqliteTable(
  "server_usergroups",
  {
    id: id(),
    serverId: text("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    permissionsJson: text("permissions_json").notNull().default("[]"),
    /** Exactly one per server: the implicit baseline for every participant. */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    autoRulesJson: text("auto_rules_json").notNull().default("[]"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    serverIdx: index("server_usergroups_server_idx").on(t.serverId, t.sortOrder),
    // Partial UNIQUE `server_usergroups_one_default` on (server_id) WHERE
    // is_default = 1 (migration 0275) lives in the SQL only.
  }),
);
export type DbServerUsergroup = typeof serverUsergroups.$inferSelect;

/**
 * Explicit (non-default) server usergroup memberships (migration 0275).
 * `addedBy` null + `isAuto` true = an automatic membership via the group's
 * auto-join rules; a manual add records the acting manager with `isAuto` false.
 */
export const serverUsergroupMembers = sqliteTable(
  "server_usergroup_members",
  {
    groupId: text("group_id").notNull().references(() => serverUsergroups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    addedAt: ts("added_at"),
    addedBy: text("added_by"),
    isAuto: integer("is_auto", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    userIdx: index("server_usergroup_members_user_idx").on(t.userId),
  }),
);
export type DbServerUsergroupMember = typeof serverUsergroupMembers.$inferSelect;

/**
 * Per-server bans (migration 0275, mirror forum_bans). Scoped STRICTLY to this
 * server's rooms — gates join/chat/apply only, NEVER the platform login.
 * `until` null = permanent. Expired rows kept (lazy-ignored) for history.
 */
export const serverBans = sqliteTable(
  "server_bans",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    until: integer("until", { mode: "timestamp_ms" }),
    reason: text("reason"),
    issuedById: text("issued_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.userId] }),
    userIdx: index("server_bans_user_idx").on(t.userId),
  }),
);
export type DbServerBan = typeof serverBans.$inferSelect;

/**
 * Per-server invite codes (migration 0275; mirror room_invites) for
 * joinMode='invite' servers. A code grants join rights until used up / expired
 * / revoked. createdByUserId is a plain nullable text (the issuer may be
 * deleted; the code stays usable until revoked).
 */
export const serverInvites = sqliteTable(
  "server_invites",
  {
    id: id(),
    serverId: text("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
    code: text("code").notNull().unique(),
    createdByUserId: text("created_by_user_id"),
    maxUses: integer("max_uses"),
    usedCount: integer("used_count").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    serverIdx: index("server_invites_server_idx").on(t.serverId),
  }),
);
export type DbServerInvite = typeof serverInvites.$inferSelect;

/**
 * Per-user last-visit marker (migration 0275, mirror forum_visits). Drives the
 * rail's "new since you last looked" dot on each round server icon.
 */
export const serverVisits = sqliteTable(
  "server_visits",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    lastVisitAt: ts("last_visit_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.serverId] }),
  }),
);
export type DbServerVisit = typeof serverVisits.$inferSelect;

/**
 * Per-server economy backfill latch (migration 0287). One row per server,
 * idempotency marker for the economy backfill / provisioning pass (Team H
 * runtime). `completedAt` is null until that server's per-server economy
 * initialization has run to completion; a non-null timestamp makes a re-run a
 * no-op. The default (is_system) server is seeded as already-complete because
 * migrations 0282-0286 + the Phase-2 backfill already homed all existing data
 * to it. No FK to `servers` on purpose: the latch may be stamped during
 * provisioning before/independently of the server row's own lifecycle, and a
 * dangling latch row is harmless.
 */
export const serverBackfillState = sqliteTable("server_backfill_state", {
  serverId: text("server_id").primaryKey(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});
export type DbServerBackfillState = typeof serverBackfillState.$inferSelect;

/**
 * Per-server settings row (migration 0276). The per-server BEHAVIOR slice split
 * out of the site_settings singleton (retention, caps, edit grace, default
 * look, welcome/rules HTML, forum caps, earning config, flash sale). NULL
 * columns mean "inherit the platform default" so an all-NULL row behaves
 * exactly like the legacy global config until the owner tunes something.
 */
export const serverSettings = sqliteTable("server_settings", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  // chat behavior (NULL = inherit platform default)
  messageRetentionMs: integer("message_retention_ms"),
  maxRoomsPerOwner: integer("max_rooms_per_owner"),
  maxMessageLength: integer("max_message_length"),
  editGraceMs: integer("edit_grace_ms"),
  // per-server default look (scoped to this server's shell; never bleeds)
  defaultThemeJson: text("default_theme_json"),
  defaultStyleKey: text("default_style_key"),
  themeDesignMap: text("theme_design_map"),
  // per-community content (re-homed rules/securityNotice/newUserWelcome)
  rulesHtml: text("rules_html"),
  securityNoticeHtml: text("security_notice_html"),
  welcomeHtml: text("welcome_html"),
  newUserWelcomeHtml: text("new_user_welcome_html"),
  // per-server forum caps
  maxForumPostLength: integer("max_forum_post_length"),
  forumTopicsPerPage: integer("forum_topics_per_page"),
  // per-server economy (full economy lands in Phase 5b; this is its home)
  earningConfigJson: text("earning_config_json"),
  flashSaleEnabled: integer("flash_sale_enabled", { mode: "boolean" }),
  // Per-server EARNING SUBSYSTEM toggles (migration 0293; NULL = inherit the
  // platform default = enabled). A server owner can turn off a whole subsystem
  // (its catalog section hides + purchases reject). "nothing stays global" —
  // each server runs the earning features it wants.
  shopEnabled: integer("shop_enabled", { mode: "boolean" }),
  ranksEnabled: integer("ranks_enabled", { mode: "boolean" }),
  nameStylesEnabled: integer("name_styles_enabled", { mode: "boolean" }),
  bordersEnabled: integer("borders_enabled", { mode: "boolean" }),
  roomTransitionsEnabled: integer("room_transitions_enabled", { mode: "boolean" }),
  cosmeticsEnabled: integer("cosmetics_enabled", { mode: "boolean" }),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
  updatedById: text("updated_by_id").references(() => users.id, { onDelete: "set null" }),
});
export type DbServerSettings = typeof serverSettings.$inferSelect;

/**
 * Per-(user, server) one-time welcome dismissal (migration 0276). The
 * singleton's per-account welcome_seen_hash can't express "seen server A's
 * welcome but not B's". Absent row = not yet seen; the hash gates re-show when
 * the owner edits the welcome copy.
 */
export const serverWelcomeSeen = sqliteTable(
  "server_welcome_seen",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    seenHash: text("seen_hash").notNull().default(""),
    seenAt: ts("seen_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.serverId] }),
  }),
);
export type DbServerWelcomeSeen = typeof serverWelcomeSeen.$inferSelect;

/**
 * Per-(user, server) last room (migration 0277, server-scoped mirror of
 * users.lastRoomId). A multi-server user needs to return to the right room in
 * EACH server on reconnect / server switch; the per-tab tabRoomId cache still
 * wins above it.
 */
export const userServerLastRoom = sqliteTable(
  "user_server_last_room",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null" }),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.serverId] }),
  }),
);
export type DbUserServerLastRoom = typeof userServerLastRoom.$inferSelect;

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
    /** Optional user-authored note for context, "why I bookmarked this". */
    note: text("note"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    userMsgUq: uniqueIndex("bookmarks_user_msg_uq").on(t.userId, t.messageId),
    userIdx: index("bookmarks_user_idx").on(t.userId),
  }),
);

/* ============================================================
 * Earning, earned-currency (XP + Currency) + Rank ladder +
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
export const ranks = sqliteTable(
  "ranks",
  {
    /**
     * Per-server catalog partition (migration 0295). Each server owns its own
     * rank ladder; the grain is (server_id, key). All legacy ranks home to the
     * default server.
     */
    serverId: text("server_id").notNull().default("server_spire_system"),
    /** Stable slug, e.g. "new_arrival". Immutable after create. */
    key: text("key").notNull(),
    /** Display name shown in chat / userlist / dashboard. Admin-editable. */
    name: text("name").notNull(),
    /** Display order, low → high (1 = lowest rank). */
    order: integer("order").notNull().default(0),
    /** Soft-close flag. 0 = skipped by the XP→rank resolver. */
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.key] }),
  }),
);

/* ---------- rank_tiers ----------
 * Sub-levels within a rank (I, II, III, IV). Tier IV is the
 * "Verified" capstone of each rank (Tier IV of rank 6 is called
 * "Eternalized"). Crossing a tier IV threshold unlocks eligibility
 * to buy that rank's border frame (`borderImageUrl`).
 *
 * Eligibility persists via `maxRankKeyEverHeld` / `maxTierEverHeld`
 * on the earning rows, once a user has ever crossed Tier IV of a
 * rank they retain the right to buy that border even if admins
 * raise the threshold later.
 */
export const rankTiers = sqliteTable(
  "rank_tiers",
  {
    id: id(),
    /** Per-server catalog partition (migration 0295). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    rankKey: text("rank_key").notNull(),
    /** 1..4 by default; admins can extend a rank with more tiers. */
    tier: integer("tier").notNull(),
    /** Display label, e.g. "I", "II", "III", "IV: Verified". */
    label: text("label").notNull(),
    /** Crossing this XP places the user at this tier of this rank. */
    xpThreshold: integer("xp_threshold").notNull().default(0),
    /** Sigil PNG URL, bundled default `/assets/ranks/...` or `/uploads/ranks/<hash>.png`. */
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
    // Composite FK into the per-server rank catalog (migration 0295).
    rankFk: foreignKey({
      columns: [t.serverId, t.rankKey],
      foreignColumns: [ranks.serverId, ranks.key],
    }).onDelete("cascade"),
    rankTierUq: uniqueIndex("rank_tiers_rank_tier_uq").on(t.serverId, t.rankKey, t.tier),
    xpIdx: index("rank_tiers_xp_idx").on(t.xpThreshold),
  }),
);

/* ---------- name_styles ----------
 * Admin-authored HTML + CSS templates with a {username} placeholder
 * users can buy and equip to style their displayed name in chat /
 * forums / userlist. No JavaScript, animations are CSS-only via
 * @keyframes, eliminating any stored-XSS surface even with
 * admin-only authoring.
 */
export const nameStyles = sqliteTable(
  "name_styles",
  {
    /** Per-server catalog partition (migration 0296); grain is (server_id, key). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    key: text("key").notNull(),
    /** Admin-facing label, e.g. "Sunset Gradient". */
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** HTML template, must include the literal `{username}` placeholder. */
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
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.key] }),
  }),
);

/* ---------- cosmetics ----------
 * Purchasable feature catalog distinct from name styles and
 * borders. Phase 4 seeds two rows: `inline_avatar` (round avatar
 * after the timestamp in chat) and `rank_border` (placeholder row
 * for the border-purchase flow, the actual per-rank prices live
 * on `rank_tiers.borderCost`).
 */
export const cosmetics = sqliteTable(
  "cosmetics",
  {
    /** Per-server catalog partition (migration 0299); grain is (server_id, key). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    /** Stable slug, e.g. "inline_avatar". Immutable after create. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Flat Currency price. For `rank_border` this is ignored; prices live on rank_tiers. */
    cost: integer("cost").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Per-cosmetic config JSON (e.g. avatar pixel size for `inline_avatar`). */
    configJson: text("config_json"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.key] }),
  }),
);

/* ---------- room_transitions ----------
 * Per-server PRICE / enabled / order for the room-switch animations. The set of
 * animations is FIXED (impls are client-side, keyed by `key`), so label +
 * description stay sourced from the shared ROOM_TRANSITIONS const by key — this
 * table only lets a server owner re-price, disable, or reorder them (migration
 * 0294, seeded for the system server from the const). Part of the "everything
 * per-server" earning build; the read paths COALESCE per-server rows over the
 * const so an unseeded server falls back to the default catalog/price.
 */
export const roomTransitions = sqliteTable(
  "room_transitions",
  {
    serverId: text("server_id").notNull().default("server_spire_system"),
    key: text("key").notNull(),
    cost: integer("cost").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.key] }),
  }),
);
export type DbRoomTransition = typeof roomTransitions.$inferSelect;

/* ---------- user_earning ----------
 * Per-master-account pool. Created on first earn (or lazily on first
 * dashboard read). `rankKey` + `tier` are denormalized, recomputed
 * by the resolver every time XP changes so callers can read the
 * current rank without re-running the resolver. `maxRankKeyEverHeld`
 * + `maxTierEverHeld` capture the user's all-time peak so border
 * eligibility persists even if admins raise thresholds later.
 */
export const userEarning = sqliteTable("user_earning", {
  /**
   * Per-server economy partition (migration 0283). XP / Currency / Rank /
   * equipped cosmetics are SEPARATE per server; the grain is (server_id,
   * user_id). Defaults to (and all legacy rows home to) the default server.
   */
  serverId: text("server_id").notNull().default("server_spire_system"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  xp: integer("xp").notNull().default(0),
  currency: integer("currency").notNull().default(0),
  /** Current rank (denormalized; null = below Rank 1). */
  rankKey: text("rank_key"),
  /** Current tier within rank (1..N; null when rankKey is null). */
  tier: integer("tier"),
  /** Highest rank ever held, never decreases. Drives "once eligible, always eligible" border purchasing. */
  maxRankKeyEverHeld: text("max_rank_key_ever_held"),
  maxTierEverHeld: integer("max_tier_ever_held"),
  /** Hides this user's Currency total from other users when set. Self always sees own. */
  hideCurrencyCount: integer("hide_currency_count", { mode: "boolean" }).notNull().default(false),
  /** Hides this user's XP total from other users when set. Self always sees own. Rank stays public regardless. */
  hideXpCount: integer("hide_xp_count", { mode: "boolean" }).notNull().default(false),
  /** Which owned border is currently equipped on the master avatar (null = none). */
  selectedBorderRankKey: text("selected_border_rank_key"),
  /**
   * Equipped FREE-FORM border key (migration 0149). When non-null
   * AND the user actually owns the row in `user_owned_freeform_borders`,
   * BorderedAvatar prefers this over `selectedBorderRankKey`. ON
   * DELETE SET NULL via the migration so an admin deleting a freeform
   * border row clears every active equip rather than orphaning them.
   */
  selectedFreeformBorderKey: text("selected_freeform_border_key"),
  /**
   * Custom typing-phrase Flair (migration 0150). Free-form text the
   * user picks after purchasing `flair_typing_phrase`. Rendered by
   * the typing indicator in place of the default "is typing…" when
   * this user is the sole typer. Null = use the default phrasing.
   * Length-capped at 60 chars by the writer; admin clear endpoint
   * resets to null for moderation.
   */
  typingPhrase: text("typing_phrase"),
  /**
   * Custom room-presence templates (migration 0161). Override the
   * default "{name} has entered the room." / "{name} has left the
   * room." system lines. Gated on this user owning
   * `flair_room_presence`. Supports `{name}` and `{room}`
   * placeholders. Null = use the default phrasing.
   */
  roomJoinTemplate: text("room_join_template"),
  roomLeaveTemplate: text("room_leave_template"),
  /**
   * Custom session-presence templates (migration 0161). Override the
   * site-level "{name} has connected." / "{name} has disconnected."
   * lines that surface in the user's first room when they log in /
   * out. Gated on this user owning `flair_session_presence`.
   * Session presence is master-only, characters are sub-identities
   * of the active session, not session participants themselves.
   * Supports `{name}` only. Null = use the default phrasing.
   */
  sessionConnectTemplate: text("session_connect_template"),
  sessionExitTemplate: text("session_exit_template"),
  /**
   * Rotating-quote marquee body (migration 0192). JSON array of
   * strings (one per quote) capped to 10 entries at the API layer.
   * Each entry is short-form markdown / basic HTML rendered with
   * the same sanitizer the announcement marquee uses. Gated on
   * ownership of `flair_profile_marquee` for the matching identity;
   * the writable surface (profile editor) checks ownership before
   * accepting an update, so a direct DB poke is the only way to
   * smuggle a quote past the purchase gate.
   */
  profileMarqueeQuotesJson: text("profile_marquee_quotes_json"),
  /**
   * Owner's "show the visitors counter on my public profile" toggle
   * (migration 0192). Independent of `flair_profile_visitors`
   * ownership: equipping the flair turns it ON by default, but the
   * owner can flip it off in settings to keep view metrics private
   * to themselves while still counting. View LOGGING is always-on
   * regardless of this toggle.
   */
  showProfileVisitorsCount: integer("show_profile_visitors_count", { mode: "boolean" }).notNull().default(false),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
}, (t) => ({
  pk: primaryKey({ columns: [t.serverId, t.userId] }),
}));

/* ---------- character_earning ----------
 * Per-character pool, mirrors user_earning. Activity performed as
 * a character credits this row (and per the "every logged-in
 * character earns full" rule, every active character of the same
 * user gets the same award).
 */
export const characterEarning = sqliteTable("character_earning", {
  /** Per-server economy partition (migration 0283); grain is (server_id, character_id). */
  serverId: text("server_id").notNull().default("server_spire_system"),
  characterId: text("character_id")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  xp: integer("xp").notNull().default(0),
  currency: integer("currency").notNull().default(0),
  rankKey: text("rank_key"),
  tier: integer("tier"),
  maxRankKeyEverHeld: text("max_rank_key_ever_held"),
  maxTierEverHeld: integer("max_tier_ever_held"),
  /** Per-character border equip choice (drawn from the owner's user_owned_borders set). */
  selectedBorderRankKey: text("selected_border_rank_key"),
  /** Per-character free-form border equip (migration 0149). Same precedence
   *  rule as the master pool: when non-null AND owned, beats the rank-tier
   *  equip. ON DELETE SET NULL clears the slot if the border row is dropped. */
  selectedFreeformBorderKey: text("selected_freeform_border_key"),
  /**
   * Per-character equipped name-style key. Distinct from
   * `user_active_cosmetics.active_name_style_key` (which now scopes
   * to master/OOC only). When the user is voicing this character
   * the renderer reads this column; when OOC, it reads the master
   * row. Null = no style equipped on this character.
   */
  activeNameStyleKey: text("active_name_style_key"),
  /**
   * Per-character equipped room-transition key (migration 0219). The catalog
   * lives in shared code (ROOM_TRANSITIONS), so no FK. Null = instant switch.
   */
  activeRoomTransitionKey: text("active_room_transition_key"),
  /**
   * Per-character inline-avatar toggle. Same partition as
   * activeNameStyleKey, character-active shows this character's
   * inline avatar choice, OOC shows the master's. Default false so
   * a new character starts with the avatar tile off.
   */
  inlineAvatarEnabled: integer("inline_avatar_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  /**
   * Per-character "Lurking Master" toggle (migration 0152). When
   * true AND this character owns `flair_lurking_master`, the typing
   * indicator omits this character from the broadcast typer set
   * for non-admin receivers. Admins still see the row regardless.
   */
  lurkingMasterEnabled: integer("lurking_master_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  /**
   * Per-character banner image URL. Same per-identity partition as
   * the cosmetics above, character-active shows this character's
   * banner on their profile, OOC shows the master's
   * (`user_active_cosmetics.profile_banner_url`). Writable only when
   * this character (not the master) owns `flair_profile_banner` in
   * the earning ledger.
   */
  profileBannerUrl: text("profile_banner_url"),
  /**
   * Per-character custom typing phrase (migration 0150). Same
   * partition rule as `profileBannerUrl` above, gated on THIS
   * character (not the master) owning `flair_typing_phrase`.
   */
  typingPhrase: text("typing_phrase"),
  /**
   * Per-character room-presence templates (migration 0161). Same
   * partition rule as `typingPhrase` above, gated on THIS character
   * (not the master) owning `flair_room_presence`. Character-active
   * rooms render this row's templates; OOC rooms render the master's.
   */
  roomJoinTemplate: text("room_join_template"),
  roomLeaveTemplate: text("room_leave_template"),
  /**
   * Per-character marquee quotes (migration 0192). Same shape +
   * gate as the master pool's column. Character-active profiles
   * read this; OOC/master reads the user_earning row.
   */
  profileMarqueeQuotesJson: text("profile_marquee_quotes_json"),
  /** Per-character visitors-counter display toggle (migration 0192). */
  showProfileVisitorsCount: integer("show_profile_visitors_count", { mode: "boolean" }).notNull().default(false),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
}, (t) => ({
  pk: primaryKey({ columns: [t.serverId, t.characterId] }),
}));

/* ---------- profile_views ----------
 *
 * Append-only log of one row per unique (viewer, profile, day).
 * Drives the `flair_profile_visitors` counter, both display + the
 * owner's stats query. Always logged regardless of whether the
 * profile owner has equipped the flair, so the moment they buy +
 * enable it the count is non-zero. Viewer dedupe key is the
 * viewer's userId for members and an opaque IP+UA hash for
 * anonymous traffic; the UNIQUE constraint over
 * (profile, viewer_key, day_bucket) makes a same-day re-view a
 * silent no-op via `INSERT OR IGNORE`.
 */
export const profileViews = sqliteTable(
  "profile_views",
  {
    id: id(),
    /** Master account that owns the profile being viewed. */
    profileUserId: text("profile_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Character whose profile is viewed; NULL = master/OOC profile. */
    profileCharacterId: text("profile_character_id")
      .references(() => characters.id, { onDelete: "set null" }),
    /** Signed-in viewer; NULL for anonymous. */
    viewerUserId: text("viewer_user_id")
      .references(() => users.id, { onDelete: "set null" }),
    /** Dedupe key, `userId` for members, ip+UA hash for anon. */
    viewerKey: text("viewer_key").notNull(),
    /** UNIX-day integer (floor(ms / 86_400_000)). */
    dayBucket: integer("day_bucket").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => ({
    profileIdx: index("profile_views_profile_idx").on(t.profileUserId, t.profileCharacterId),
    dayIdx: index("profile_views_day_idx").on(t.dayBucket),
  }),
);

/* ---------- earning_ledger ----------
 * Append-only audit of every XP / Currency delta on either scope.
 * `scope` + `ownerId` together identify the pool (the FK relation
 * cannot be modeled in Drizzle because ownerId points to different
 * tables depending on scope, same pattern as audit_log's loose
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
    /** Per-server economy discriminator (migration 0282). Legacy rows + off-flag
     *  credits home to the default server. */
    serverId: text("server_id").notNull().default("server_spire_system"),
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
    serverOwnerTimeIdx: index("earning_ledger_server_owner_time_idx").on(
      t.serverId,
      t.scope,
      t.ownerId,
      t.reason,
      t.createdAt,
    ),
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
    /** Per-server economy partition (migration 0285). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rankKey: text("rank_key").notNull(),
    acquiredAt: ts("acquired_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.userId, t.rankKey] }),
    // Composite FK into the per-server rank catalog (migration 0295).
    rankFk: foreignKey({
      columns: [t.serverId, t.rankKey],
      foreignColumns: [ranks.serverId, ranks.key],
    }).onDelete("cascade"),
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
    /** Per-server economy partition (migration 0285). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    styleKey: text("style_key").notNull(),
    /** Per-user customization JSON (color picks, glow strength, etc.). */
    configJson: text("config_json"),
    acquiredAt: ts("acquired_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.userId, t.styleKey] }),
    // Composite FK into the per-server name-style catalog (migration 0296).
    styleFk: foreignKey({
      columns: [t.serverId, t.styleKey],
      foreignColumns: [nameStyles.serverId, nameStyles.key],
    }).onDelete("cascade"),
    userIdx: index("user_owned_name_styles_user_idx").on(t.userId),
  }),
);

/* ---------- character_owned_name_styles ----------
 * Per-character ownership ledger for name styles (migration 0086).
 * Mirror of `user_owned_name_styles` keyed by character_id instead
 * of user_id. Each character carries its own owned list, purchased
 * from that character's currency pool. `configJson` holds the
 * character's color picks for THIS style, independent of any
 * other identity's config for the same styleKey.
 */
export const characterOwnedNameStyles = sqliteTable(
  "character_owned_name_styles",
  {
    /** Per-server economy partition (migration 0285). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    styleKey: text("style_key").notNull(),
    configJson: text("config_json"),
    acquiredAt: ts("acquired_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.characterId, t.styleKey] }),
    // Composite FK into the per-server name-style catalog (migration 0296).
    styleFk: foreignKey({
      columns: [t.serverId, t.styleKey],
      foreignColumns: [nameStyles.serverId, nameStyles.key],
    }).onDelete("cascade"),
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
    /** Per-server economy partition (migration 0285). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    rankKey: text("rank_key").notNull(),
    acquiredAt: ts("acquired_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.characterId, t.rankKey] }),
    // Composite FK into the per-server rank catalog (migration 0295).
    rankFk: foreignKey({
      columns: [t.serverId, t.rankKey],
      foreignColumns: [ranks.serverId, ranks.key],
    }).onDelete("cascade"),
    characterIdx: index("character_owned_borders_character_idx").on(t.characterId),
  }),
);

/* ---------- freeform_borders ----------
 * Free-form purchasable avatar borders (migration 0149). Coexists
 * with rank-tier borders; the BordersTab merges the two catalogs
 * for users. Each row ships in EITHER `imageUrl` mode (PNG / APNG
 * overlay) OR `template` + `styleCss` mode (DOM template with
 * scoped CSS, mirroring the name-style system). App-layer validator
 * enforces exactly one path on insert/update.
 *
 * `rarity` is a free-string tier slug, drives the chip-strip
 * filter and the per-card accent color in the user-facing UI.
 * Open string (no CHECK) so admins can add new tiers without a
 * schema migration; client falls back to a 'common' palette for
 * unknown values.
 */
export const freeformBorders = sqliteTable(
  "freeform_borders",
  {
    /** Per-server catalog partition (migration 0297); grain is (server_id, key). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** PNG / APNG / WebP URL. Mutually exclusive with `template`. */
    imageUrl: text("image_url"),
    /** DOM template with `{avatar}` placeholder. Mutually exclusive with `imageUrl`. */
    template: text("template"),
    /** Scoped CSS for the `.b-<key>` class chain referenced by template. */
    styleCss: text("style_css"),
    /** 'rare' | 'epic' | 'legendary' | 'mythic' | 'exotic' | 'atmospheric' | ... */
    rarity: text("rarity").notNull().default("common"),
    cost: integer("cost").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Seed-protected. Admin can edit but not delete. */
    isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
    order: integer("order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.key] }),
  }),
);

/* ---------- user_owned_freeform_borders ---------- */
export const userOwnedFreeformBorders = sqliteTable(
  "user_owned_freeform_borders",
  {
    /** Per-server economy partition (migration 0285). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    borderKey: text("border_key").notNull(),
    acquiredAt: ts("acquired_at"),
    /**
     * Per-identity color customization (migration 0158). JSON map of
     * CSS custom-property names → values keyed without the `--c-`
     * prefix (e.g. `{"ring-main":"#ff10f0"}`). The renderer prepends
     * `--c-` and injects each as an inline CSS variable on the
     * BorderedAvatar wrapper; the catalog row's CSS reads them via
     * `var(--c-ring-main, <fallback>)`. Null = use the CSS fallbacks.
     */
    configJson: text("config_json"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.userId, t.borderKey] }),
    // Composite FK into the per-server freeform-border catalog (migration 0297).
    borderFk: foreignKey({
      columns: [t.serverId, t.borderKey],
      foreignColumns: [freeformBorders.serverId, freeformBorders.key],
    }).onDelete("cascade"),
    userIdx: index("user_owned_freeform_borders_user_idx").on(t.userId),
  }),
);

/* ---------- character_owned_freeform_borders ---------- */
export const characterOwnedFreeformBorders = sqliteTable(
  "character_owned_freeform_borders",
  {
    /** Per-server economy partition (migration 0285). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    borderKey: text("border_key").notNull(),
    acquiredAt: ts("acquired_at"),
    /** Per-character color customization. Same shape as
     *  `user_owned_freeform_borders.configJson`. */
    configJson: text("config_json"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.characterId, t.borderKey] }),
    // Composite FK into the per-server freeform-border catalog (migration 0297).
    borderFk: foreignKey({
      columns: [t.serverId, t.borderKey],
      foreignColumns: [freeformBorders.serverId, freeformBorders.key],
    }).onDelete("cascade"),
    characterIdx: index("character_owned_freeform_borders_character_idx").on(t.characterId),
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
 *   enabled      , master existence. 0 hides everywhere and rejects
 *                   commands referencing the item, but EXISTING
 *                   inventory rows persist so admins can revive an
 *                   item without nuking inventories.
 *   forSale      , independent of enabled; gates shop visibility
 *                   only. enabled=1+forSale=0 keeps the item usable
 *                   in commands while pulled from the store.
 *   saleStartsAt , optional lower bound (unix ms). Shop hides the
 *                   item until this time.
 *   saleEndsAt   , optional upper bound. Shop stops accepting
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
    /** Per-server catalog partition (migration 0298); grain is (server_id, key). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    key: text("key").notNull(),
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
     * gift, toy, pet, misc); `misc` is the safety default for any row
     * that didn't get categorized. (`toy` = Eidolon Tamer play-things,
     * migration 0207.)
     */
    category: text("category").notNull().default("misc"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Independent of enabled, gates only shop visibility. */
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
    pk: primaryKey({ columns: [t.serverId, t.key] }),
    orderIdx: index("items_order_idx").on(t.order),
    enabledForSaleIdx: index("items_enabled_for_sale_idx").on(t.enabled, t.forSale),
    categoryIdx: index("items_category_idx").on(t.category),
  }),
);

/* ---------- identity_inventory ----------
 * Per-identity holdings of catalog items. Composite-keyed by
 * (ownerScope, ownerId, itemKey) so OOC master and each character
 * carry fully independent inventories, see migration 0095. Every
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
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    /** "user" (OOC master) or "character", selects which id table ownerId points at. */
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    itemKey: text("item_key").notNull(),
    quantity: integer("quantity").notNull().default(0),
    acquiredAt: ts("acquired_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.ownerScope, t.ownerId, t.itemKey] }),
    // Composite FK into the per-server item catalog (migration 0298).
    itemFk: foreignKey({
      columns: [t.serverId, t.itemKey],
      foreignColumns: [items.serverId, items.key],
    }).onDelete("cascade"),
    ownerIdx: index("identity_inventory_owner_idx").on(t.ownerScope, t.ownerId),
    itemIdx: index("identity_inventory_item_idx").on(t.itemKey),
  }),
);

/* ---------- identity_collection ----------
 * Per-identity 10-slot pinned showcase of inventory items, rendered
 * on the identity's public profile. Migration 0096. Same partition
 * model as identity_inventory, every identity owns its own
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
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** 0..9, enforced by SQL CHECK + the route validator. */
    slot: integer("slot").notNull(),
    itemKey: text("item_key").notNull(),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.ownerScope, t.ownerId, t.slot] }),
    // Composite FK into the per-server item catalog (migration 0298). The 0..9
    // slot CHECK lives in SQL (migration 0298) + the route validator.
    itemFk: foreignKey({
      columns: [t.serverId, t.itemKey],
      foreignColumns: [items.serverId, items.key],
    }).onDelete("cascade"),
    ownerIdx: index("identity_collection_owner_idx").on(t.ownerScope, t.ownerId),
  }),
);

/* ---------- identity_pet_collection ----------
 * Per-identity 5-slot pinned showcase of PET items (`items.category =
 * 'pet'`). Twin of identity_collection but with a tighter cap (pets
 * are higher-investment trophies, not common collectibles) and a
 * category guard enforced at the route layer.
 *
 * Same partitioning rules as item collection, every identity owns
 * its own pin set; OOC and each character are isolated. Slots are
 * sparse (0..4) and the slot range is enforced both by the SQL
 * CHECK constraint (migration 0105) and the route's zod validator.
 */
export const identityPetCollection = sqliteTable(
  "identity_pet_collection",
  {
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** 0..4, enforced by SQL CHECK + the route validator. */
    slot: integer("slot").notNull(),
    itemKey: text("item_key").notNull(),
    /**
     * Owner-assigned nickname for this specific pet ("Whiskers",
     * "Smaug"). The catalog `items.name` stays the breed/species label
     * the world sees ("Maine Coon"); the nickname is the personal name
     * shown alongside it on the profile. Null = no nickname set;
     * renderer falls back to the catalog name alone. Trimmed + length-
     * capped by the route validator. Migration 0175.
     */
    nickname: text("nickname"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.ownerScope, t.ownerId, t.slot] }),
    // Composite FK into the per-server item catalog (migration 0298). The 0..4
    // slot CHECK lives in SQL (migration 0298) + the route validator.
    itemFk: foreignKey({
      columns: [t.serverId, t.itemKey],
      foreignColumns: [items.serverId, items.key],
    }).onDelete("cascade"),
    ownerIdx: index("identity_pet_collection_owner_idx").on(t.ownerScope, t.ownerId),
  }),
);

/* ---------- user_active_cosmetics ----------
 * One row per user holding the currently-equipped cosmetic state.
 * Created lazily on first equip.
 */
export const userActiveCosmetics = sqliteTable("user_active_cosmetics", {
  /** Per-server economy partition (migration 0285); grain is (server_id, user_id). */
  serverId: text("server_id").notNull().default("server_spire_system"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Inline-avatar cosmetic equipped on chat lines. Requires ownership recorded in earning_ledger. */
  inlineAvatarEnabled: integer("inline_avatar_enabled", { mode: "boolean" }).notNull().default(false),
  /** Master/OOC "Lurking Master" toggle (migration 0152). When true
   *  AND the master owns `flair_lurking_master`, the typing
   *  indicator hides this user from non-admin receivers' typer sets.
   *  Admins always see the row for moderation visibility. */
  lurkingMasterEnabled: integer("lurking_master_enabled", { mode: "boolean" }).notNull().default(false),
  /**
   * Currently-active name style key. The FK into name_styles was DROPPED in
   * migration 0296 (the catalog gained a composite (server_id, key) PK, which a
   * single-column FK can't target, and the old ON DELETE SET NULL can't be a
   * composite FK because it would null the NOT NULL server_id). Plain text now;
   * the equip read path LEFT JOINs name_styles by key (stale key => no style,
   * same visible outcome SET NULL gave) and the equip write path validates it.
   */
  activeNameStyleKey: text("active_name_style_key"),
  /**
   * Master/OOC equipped room-transition key (migration 0219). Catalog is in
   * shared code (ROOM_TRANSITIONS) so no FK. Null = instant switch.
   */
  activeRoomTransitionKey: text("active_room_transition_key"),
  /**
   * Banner image URL pasted by the user on ProfileModal. Renders as a
   * 3:1 hero strip on their profile. Writable only when this user
   * owns the `flair_profile_banner` cosmetic (purchase check on the
   * PATCH route, not enforced in SQL). Null/empty = no banner.
   */
  profileBannerUrl: text("profile_banner_url"),
  updatedAt: ts("updated_at"),
}, (t) => ({
  pk: primaryKey({ columns: [t.serverId, t.userId] }),
}));

/* ---------- earning_notifications ----------
 * Persists unacknowledged rank-up and tier-up events so the chat
 * ribbon survives reloads. Cleared by POST
 * /earning/me/notifications/rankup/ack. Per the project ethos
 * memory there are no popup toasts, this table backs a quiet,
 * dismissible ribbon and a dropdown indicator dot.
 */
export const earningNotifications = sqliteTable(
  "earning_notifications",
  {
    id: id(),
    /** Per-server economy discriminator (migration 0286). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 'rankup' is the only kind in Phase 1; reserved for future expansion. */
    kind: text("kind", { enum: ["rankup"] }).notNull().default("rankup"),
    /** Scope on which the rank-up happened, master pool or one of the user's characters. */
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
    serverUserIdx: index("earning_notifications_server_user_idx").on(
      t.serverId,
      t.userId,
      t.acknowledgedAt,
    ),
  }),
);

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
export type DbProfileView = typeof profileViews.$inferSelect;
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

/* ---------- role_permission_grants ----------
 * Phase 1 of the granular permission system (migration 0179). One row per
 * (role, permission_key) pair. Holds which permissions each role tier has
 * by default. Masteradmin has no row here, its bypass is hardcoded in
 * `apps/server/src/auth/permissions.ts`. See plan.md for the catalog +
 * resolution precedence (masteradmin > user override > role grant > deny).
 */
export const rolePermissionGrants = sqliteTable(
  "role_permission_grants",
  {
    role: text("role").notNull(),
    permissionKey: text("permission_key").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.role, t.permissionKey] }),
    roleIdx: index("role_permission_grants_role_idx").on(t.role),
  }),
);

/* ---------- user_permission_overrides ----------
 * Per-user grants/revokes that layer on top of the role grants. Lets the
 * install give a specific user a single extra power (or take one away)
 * without minting a new role tier. Starts empty after migration 0179; the
 * Phase-2 matrix UI's "By user" sub-tab fills it.
 *
 * `granted = 1` → explicit grant (the user has this permission even if
 *                 their role doesn't);
 * `granted = 0` → explicit revoke (the user does NOT have this permission
 *                 even if their role grants it).
 * Absence of a row → fall back to the role grant.
 */
export const userPermissionOverrides = sqliteTable(
  "user_permission_overrides",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    granted: integer("granted", { mode: "boolean" }).notNull(),
    setByUserId: text("set_by_user_id")
      .notNull()
      .references(() => users.id),
    setAt: ts("set_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.permissionKey] }),
    userIdx: index("user_permission_overrides_user_idx").on(t.userId),
  }),
);

export type DbRolePermissionGrant = typeof rolePermissionGrants.$inferSelect;
export type DbUserPermissionOverride = typeof userPermissionOverrides.$inferSelect;
export type DbIdentityPetCollection = typeof identityPetCollection.$inferSelect;

/* ---------- announcements ---------- *
 *
 * Two surfaces share one admin tab:
 *
 *   `announcementBanners`, admin-curated rows the chat shell rotates
 *   through in a fade-marquee at the top of the viewport. Body is
 *   sanitized HTML (Markdown is converted client-side at save time
 *   and stored as HTML so the read path is one shape).
 *
 *   `scheduledAnnouncements`, cron-like rows the server's scheduler
 *   tick fires through the `/announce` code path. Each row carries
 *   either a one-shot `runAt` or a recurring `intervalMs` parsed from
 *   the admin's human-readable spec (`1d8h`, `3h`, `30m`, an ISO
 *   datetime). `lastRunAt` / `nextRunAt` are bookkeeping: the
 *   scheduler reads enabled rows with `nextRunAt <= now`, fires, then
 *   advances `nextRunAt = now + intervalMs` for recurring or disables
 *   the row entirely for one-shots.
 */
export const announcementBanners = sqliteTable(
  "announcement_banners",
  {
    id: id(),
    bodyHtml: text("body_html").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    /**
     * Scope discriminator (migration 0278d). NULL = a platform-wide broadcast;
     * a server_id scopes the banner to that server's rooms. ON DELETE SET NULL
     * so deleting a server un-scopes the banner rather than destroying it.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    enabledIdx: index("announcement_banners_enabled_idx").on(t.enabled, t.sortOrder, t.createdAt),
    serverIdx: index("announcement_banners_server_idx").on(t.serverId, t.enabled, t.sortOrder),
  }),
);

export const scheduledAnnouncements = sqliteTable(
  "scheduled_announcements",
  {
    id: id(),
    /** The raw human-readable spec the admin typed, persisted verbatim
     *  so the editor can re-show exactly what they saved without
     *  round-tripping through the parser. */
    scheduleSpec: text("schedule_spec").notNull(),
    kind: text("kind", { enum: ["interval", "oneShot"] }).notNull(),
    intervalMs: integer("interval_ms"),
    runAt: integer("run_at"),
    lastRunAt: integer("last_run_at"),
    /** Cached "when does this fire next?" so the tick loop can read
     *  enabled rows with `nextRunAt <= now` instead of recomputing on
     *  every fetch. NULL for completed one-shots and disabled rows. */
    nextRunAt: integer("next_run_at"),
    bodyHtml: text("body_html").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    /** Color override applied to the emitted `kind = 'announce'`
     *  message, either NULL, a `#rrggbb` hex literal, or a
     *  `theme:<slot>` token. Same shape custom commands use. */
    color: text("color"),
    /** NULL = sitewide (broadcasts to every room); otherwise the
     *  specific room id. */
    targetRoomId: text("target_room_id").references(() => rooms.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    /**
     * Scope discriminator (migration 0278e). NULL = a platform-wide scheduled
     * broadcast; a server_id scopes the cron to that server's rooms (the
     * NULL-targetRoomId "fan out to EVERY room" becomes "every room in this
     * server"). ON DELETE SET NULL so deleting a server un-scopes the schedule.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    nextRunIdx: index("scheduled_announcements_next_run_idx").on(t.enabled, t.nextRunAt),
    serverIdx: index("scheduled_announcements_server_idx").on(t.serverId, t.enabled, t.nextRunAt),
  }),
);

export type DbAnnouncementBanner = typeof announcementBanners.$inferSelect;
export type DbScheduledAnnouncement = typeof scheduledAnnouncements.$inferSelect;

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

/**
 * Per-identity social-game win + points ledger (migration 0195).
 *
 * One row per (identity, game_kind). Updated automatically by
 * `formatWinningsLine` in games/config.ts whenever a game ends with
 * one or more winners, so adding a new social game kind in code
 * needs no schema or routing change: the rankings page surfaces
 * any game_kind that has rows.
 *
 *   owner_scope    'user' (OOC / master account) or 'character'.
 *                  Master and each character are tracked separately,
 *                  same per-identity model used by the earning
 *                  pipeline. A user playing as a character credits
 *                  the character; an OOC user credits themselves.
 *
 *   game_kind      Lowercase tag matching the kind the registry
 *                  uses ("rps", "trivia", "storydice", "scramble",
 *                  "duel", etc.).
 *
 *   wins           Total wins; incremented by 1 per game-end.
 *
 *   points         Game-specific score sum. For binary-win games
 *                  it mirrors `wins`. For accumulating-score games
 *                  (scramble) it's the winner's actual point total
 *                  on each win.
 */
export const gameStats = sqliteTable("game_stats", {
  /** Per-server economy partition (migration 0284). */
  serverId: text("server_id").notNull().default("server_spire_system"),
  ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
  ownerId: text("owner_id").notNull(),
  gameKind: text("game_kind").notNull(),
  wins: integer("wins").notNull().default(0),
  points: integer("points").notNull().default(0),
  lastWonAt: ts("last_won_at"),
}, (t) => ({
  pk: primaryKey({ columns: [t.serverId, t.ownerScope, t.ownerId, t.gameKind] }),
  // Leaderboard indexes (server_id-leading; recreated server-scoped in
  // migration 0292 after the 0284 rebuild dropped the original 0195 indexes).
  kindWins: index("idx_game_stats_kind_wins").on(t.serverId, t.gameKind, t.wins),
  kindPoints: index("idx_game_stats_kind_points").on(t.serverId, t.gameKind, t.points),
}));
export type DbGameStats = typeof gameStats.$inferSelect;

/* ---------- eidolon_state ----------
 * Per-identity Spire Arcade "Eidolon Tamer" save. Same (ownerScope,
 * ownerId) partition as identity_inventory / game_stats so a master
 * account and each character raise independent familiars and feed from
 * their own currency + inventory. Server-authoritative: decay is a pure
 * function of (now - lastSeenMs), recomputed on every read, so no
 * per-tick writes. Absence of a row = "never hatched" (client shows the
 * egg-select). `kind='pet'` familiars render the owned pet item's
 * iconUrl; `kind='species'` uses one of the four drawn starter species.
 */
export const eidolonState = sqliteTable(
  "eidolon_state",
  {
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    // "dormant" = the chosen death model: health-0 freezes the familiar (no
    // decay, no XP) until a Potion-revive. "dead" is the legacy permanent state,
    // treated identically (frozen + revivable). No CHECK constraint, so adding
    // "dormant" is a type-only widening — no migration needed.
    stage: text("stage", { enum: ["egg", "alive", "dead", "dormant"] }).notNull().default("alive"),
    kind: text("kind", { enum: ["species", "pet"] }).notNull().default("species"),
    speciesId: text("species_id"),
    /**
     * Owned pet item rendered as this familiar (kind='pet'). The FK into items
     * was DROPPED in migration 0298 (catalog gained a composite (server_id, key)
     * PK; SET NULL can't be a composite FK without nulling the NOT NULL
     * server_id). Plain text now; the renderer shows no pet sprite for a missing
     * key, the same outcome SET NULL produced.
     */
    petItemKey: text("pet_item_key"),
    name: text("name").notNull().default(""),
    satiety: real("satiety").notNull().default(80),
    joy: real("joy").notNull().default(75),
    vigor: real("vigor").notNull().default(85),
    hygiene: real("hygiene").notNull().default(80),
    health: real("health").notNull().default(100),
    sick: integer("sick", { mode: "boolean" }).notNull().default(false),
    asleep: integer("asleep", { mode: "boolean" }).notNull().default(false),
    ageHours: real("age_hours").notNull().default(0),
    simHour: real("sim_hour").notNull().default(8),
    messCount: integer("mess_count").notNull().default(0),
    /** Lifetime XP earned passively for being kept well + happy (drives level + sale value). */
    xp: real("xp").notNull().default(0),
    /** Personality trait id (composed onto species decay traits); null = legacy/none. */
    trait: text("trait"),
    /** Rare variant (e.g. "prismatic") rolled at hatch; null = ordinary. Visual
     *  prestige + a sale-value bump; doesn't change decay. Migration 0208. */
    variant: text("variant"),
    /** Non-sellable XP head-start INHERITED from a predecessor (lineage). Counts
     *  toward level/visual but is subtracted before sale value, so a hatch->sell
     *  loop can't farm the bonus. Migration 0208. */
    bonusXp: real("bonus_xp").notNull().default(0),
    /** Daily care-streak: consecutive days tended (one-day grace before reset). */
    streakCount: integer("streak_count").notNull().default(0),
    /** UTC day-key (YYYY-MM-DD) of the last tend; null until first check-in. */
    lastCheckInDayKey: text("last_checkin_day_key"),
    /** Best streak this familiar has ever reached. */
    bestStreak: integer("best_streak").notNull().default(0),
    /** Opt-in "your familiar needs you" push nudges (ON by default once hatched). */
    nudgeOptin: integer("nudge_optin", { mode: "boolean" }).notNull().default(true),
    /** UTC day-key of the last nudge sent; bounds nudges to once per day. */
    lastNudgeDayKey: text("last_nudge_day_key"),
    /** Wall-clock (ms) of the last persisted snapshot; drives offline decay catch-up. */
    lastSeenMs: integer("last_seen_ms").notNull().default(0),
    hatchedAt: ts("hatched_at"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.ownerScope, t.ownerId] }),
  }),
);
export type DbEidolonState = typeof eidolonState.$inferSelect;

/**
 * Eidolon Tamer "visits": one row per (visitor user, target familiar identity),
 * holding the last pat time. Drives the 24h pat cooldown (a social +joy gesture
 * on another player's familiar). Keyed by the visitor's USER id (so a user's
 * many identities can't each pat the same target) — see the /arcade/eidolon/visit
 * route, which also blocks patting any familiar you own.
 */
export const eidolonVisits = sqliteTable(
  "eidolon_visits",
  {
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    visitorUserId: text("visitor_user_id").notNull(),
    targetOwnerScope: text("target_owner_scope", { enum: ["user", "character"] }).notNull(),
    targetOwnerId: text("target_owner_id").notNull(),
    /** Wall-clock (ms) of the last pat; drives the cooldown. */
    visitedAt: integer("visited_at").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.visitorUserId, t.targetOwnerScope, t.targetOwnerId] }),
  }),
);
export type DbEidolonVisit = typeof eidolonVisits.$inferSelect;

/**
 * The Hall — a memorial record per departed familiar (sold or released), so a
 * keeper can look back on everyone they've raised AND the next hatch can
 * inherit from the most recent one (lineage). Append-only history; one row per
 * departure (a keeper can have many). `peak_level` is the level at departure,
 * which equals the lifetime peak since XP only ever accrues. Migration 0208.
 */
export const eidolonHall = sqliteTable(
  "eidolon_hall",
  {
    id: text("id").primaryKey(),
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull().default(""),
    kind: text("kind", { enum: ["species", "pet"] }).notNull().default("species"),
    speciesId: text("species_id"),
    trait: text("trait"),
    variant: text("variant"),
    /** Level at departure (= lifetime peak; XP is monotonic). */
    peakLevel: integer("peak_level").notNull().default(1),
    ageHours: real("age_hours").notNull().default(0),
    /** "sold" | "released". */
    departReason: text("depart_reason").notNull().default("released"),
    /** Wall-clock (ms) of departure. */
    departedAt: integer("departed_at").notNull().default(0),
  },
  (t) => ({
    ownerIdx: index("eidolon_hall_owner_idx").on(t.serverId, t.ownerScope, t.ownerId, t.departedAt),
  }),
);
export type DbEidolonHall = typeof eidolonHall.$inferSelect;

/**
 * Urugal's Descent run sessions (Spire Arcade game #2). One row per
 * descent. The server issues `id` at /arcade/urugal/start and validates
 * every milestone event against it: floors must advance monotonically
 * (capped jump) and be paced plausibly, and each floor / boss pays at
 * most once per run. `maxFloor` is the highest PAID floor; `bossesJson`
 * is a JSON array of PAID boss floors. Reward crediting + the daily cap
 * live in the route (see routes/arcadeUrugal.ts + the @thekeep/shared
 * urugal reward curve). The game bundle is untrusted; this table is the
 * server's authoritative record of what's actually been earned.
 */
export const urugalRun = sqliteTable(
  "urugal_run",
  {
    id: text("id").primaryKey(),
    /** Per-server economy partition (migration 0286). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** Master account id (for creditPool's `notifyUserId` + socket emit). */
    userId: text("user_id").notNull(),
    startedAt: integer("started_at").notNull(),
    lastEventAt: integer("last_event_at").notNull(),
    /** Highest floor already PAID for in this run (monotonic gate). */
    maxFloor: integer("max_floor").notNull().default(1),
    /** JSON array of boss floors already PAID for (dedup). */
    bossesJson: text("bosses_json").notNull().default("[]"),
    status: text("status", { enum: ["active", "ended"] }).notNull().default("active"),
    endedAt: integer("ended_at"),
  },
  (t) => ({
    ownerIdx: index("urugal_run_owner_idx").on(t.serverId, t.ownerScope, t.ownerId, t.status),
  }),
);
export type DbUrugalRun = typeof urugalRun.$inferSelect;

/* ---------- moderation case log (migration 0254) ----------
 *
 * Mod-authored record of a complaint/dispute and how it was handled —
 * distinct from the user-filed `reports` table (which is reader-initiated).
 * Reporter and subject are freehand text by default, but if the mod typed an
 * `@id:`/`@cid:` identity token we resolve it and ALSO store the linked
 * userId/characterId + a snapshot label, so the log stays queryable ("every
 * case about user X") without losing the freehand affordance. FKs use
 * `set null` so the case survives a deleted account. */
export const modCases = sqliteTable(
  "mod_cases",
  {
    id: id(),
    /** Short category/label for the complaint, freehand (e.g. "harassment"). */
    nature: text("nature").notNull(),
    /** The freehand narrative the mod typed. */
    complaintBody: text("complaint_body").notNull(),
    /** Freehand outcome / action taken; null while the case is open. */
    resolution: text("resolution"),
    status: text("status", { enum: ["open", "in_progress", "resolved"] }).notNull().default("open"),
    /** "case" = an infraction/dispute with a workflow; "note" = a standing
     *  informational note about a user, no resolution needed (migration 0272). */
    kind: text("kind", { enum: ["case", "note"] }).notNull().default("case"),
    /** "Who complained" — freehand text and/or a resolved identity link. */
    reporterText: text("reporter_text"),
    reporterUserId: text("reporter_user_id").references(() => users.id, { onDelete: "set null" }),
    reporterCharacterId: text("reporter_character_id"),
    reporterLabel: text("reporter_label"),
    /** "About whom/what" — same shape as the reporter columns. */
    subjectText: text("subject_text"),
    subjectUserId: text("subject_user_id").references(() => users.id, { onDelete: "set null" }),
    subjectCharacterId: text("subject_character_id"),
    subjectLabel: text("subject_label"),
    /** Optional link to a user-filed report this case stems from. */
    relatedReportId: text("related_report_id").references(() => reports.id, { onDelete: "set null" }),
    /** The mod who recorded the case. */
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    /**
     * Scope discriminator (migration 0278b). NULL = app-global / platform-owned;
     * a server_id scopes the case to that server. mod_case_updates /
     * mod_case_evidence inherit scope through case_id. ON DELETE SET NULL so
     * deleting a server un-scopes (never destroys) case history.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    subjectIdx: index("mod_cases_subject_idx").on(t.subjectUserId),
    reporterIdx: index("mod_cases_reporter_idx").on(t.reporterUserId),
    statusIdx: index("mod_cases_status_idx").on(t.status, t.createdAt),
    serverIdx: index("mod_cases_server_idx").on(t.serverId, t.status, t.createdAt),
  }),
);
export type DbModCase = typeof modCases.$inferSelect;

/* Append-only update timeline on a mod case (migration 0272) — staff add
 * progress notes + status changes without rewriting the original resolution. */
export const modCaseUpdates = sqliteTable(
  "mod_case_updates",
  {
    id: id(),
    caseId: text("case_id").notNull().references(() => modCases.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    /** The status this update moved the case to, when it changed one. */
    statusChange: text("status_change", { enum: ["open", "in_progress", "resolved"] }),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    caseIdx: index("mod_case_updates_case_idx").on(t.caseId, t.createdAt),
  }),
);
export type DbModCaseUpdate = typeof modCaseUpdates.$inferSelect;

/* Snapshotted chat messages backed up as evidence on a case (migration 0272).
 * The original message id is kept for reference; body/author/room are
 * snapshotted so the record survives the janitor hard-deleting the source. */
export const modCaseEvidence = sqliteTable(
  "mod_case_evidence",
  {
    id: id(),
    caseId: text("case_id").notNull().references(() => modCases.id, { onDelete: "cascade" }),
    /** The source message id (for reference; the message itself may be gone). */
    messageId: text("message_id"),
    authorUserId: text("author_user_id"),
    authorLabel: text("author_label"),
    body: text("body"),
    kind: text("kind"),
    roomId: text("room_id"),
    roomName: text("room_name"),
    originalCreatedAt: integer("original_created_at"),
    snapshottedAt: ts("snapshotted_at"),
  },
  (t) => ({
    caseMsgIdx: uniqueIndex("mod_case_evidence_case_msg_idx").on(t.caseId, t.messageId),
    caseIdx: index("mod_case_evidence_case_idx").on(t.caseId, t.snapshottedAt),
  }),
);
export type DbModCaseEvidence = typeof modCaseEvidence.$inferSelect;

/* ---------- FAQ entries (migration 0255) ----------
 *
 * Admin-authored question/answer entries, each with a globally-unique slug so
 * a mod can paste a direct public link (`/faq/<slug>`). `answerHtml` is
 * sanitized server-side (same allow-list as bios/announcements). Mirrors the
 * announcement_banners shape (enabled/sortOrder/audit). */
export const faqs = sqliteTable(
  "faqs",
  {
    id: id(),
    slug: text("slug").notNull(),
    question: text("question").notNull(),
    /** Markdown source the editor round-trips. */
    answerMarkdown: text("answer_markdown").notNull().default(""),
    /** Rendered + sanitized HTML the public read path serves. */
    answerHtml: text("answer_html").notNull(),
    category: text("category"),
    sortOrder: integer("sort_order").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    /**
     * Scope discriminator (migration 0278f). NULL = platform FAQ; a server_id
     * scopes per-community help content. ON DELETE SET NULL so deleting a
     * server un-scopes its FAQs rather than destroying them.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
  },
  (t) => ({
    slugUq: uniqueIndex("faqs_slug_uq").on(sql`lower(${t.slug})`),
    enabledIdx: index("faqs_enabled_idx").on(t.enabled, t.sortOrder, t.createdAt),
    serverIdx: index("faqs_server_idx").on(t.serverId),
  }),
);
export type DbFaq = typeof faqs.$inferSelect;

/* ---------- email tokens (password reset + verification) ---------- */
/**
 * Single-use tokens for transactional account email (migration 0257).
 * `purpose` discriminates password-reset from email-verification. We store
 * a SHA-256 HASH of the token, never the raw value, so a DB leak can't be
 * used to reset accounts. The raw token only ever lives in the emailed
 * link. `usedAt` marks consumption (single-use); `expiresAt` bounds the
 * window (reset ~1h, verify ~24h, enforced at the call site).
 */
export const emailTokens = sqliteTable(
  "email_tokens",
  {
    id: id(),
    purpose: text("purpose", { enum: ["password_reset", "email_verify"] }).notNull(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    tokenHashIdx: index("email_tokens_hash_idx").on(t.tokenHash),
    userPurposeIdx: index("email_tokens_user_purpose_idx").on(t.userId, t.purpose),
  }),
);
export type DbEmailToken = typeof emailTokens.$inferSelect;

/* ---------- admin email campaigns (broadcast) ---------- */
/**
 * One admin-authored broadcast (migration 0257). The body is composed in
 * the admin Email tab (tiptap → sanitized HTML) and frozen here at send
 * time. The throttled queue (see email_outbox) drains recipients within
 * the daily cap; `sentCount`/`total` track progress for the admin UI.
 */
export const emailCampaigns = sqliteTable(
  "email_campaigns",
  {
    id: id(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    /** Broadcast category (see shared EMAIL_CATEGORY_KEYS). Recipients can
     *  unsubscribe per-category; this is what the footer link drops. */
    category: text("category").notNull().default("announcements"),
    /** When to START sending (ms epoch). Null = send immediately. A future
     *  value parks the campaign as `scheduled` until the queue promotes it. */
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["scheduled", "sending", "done", "canceled"] }).notNull().default("sending"),
    total: integer("total").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    statusIdx: index("email_campaigns_status_idx").on(t.status, t.createdAt),
  }),
);
export type DbEmailCampaign = typeof emailCampaigns.$inferSelect;

/* ---------- admin email outbox (throttled per-recipient queue) ---------- */
/**
 * One queued recipient of a campaign (migration 0257). The queue worker
 * sends `pending` rows up to the daily cap, marking each `sent`/`failed`;
 * `sentAt` is what the daily-cap counter sums over the current calendar
 * day. Recipients opted out of bulk mail are written as `skipped` so the
 * campaign totals still reconcile.
 */
export const emailOutbox = sqliteTable(
  "email_outbox",
  {
    id: id(),
    campaignId: text("campaign_id").notNull().references(() => emailCampaigns.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "skipped"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    statusIdx: index("email_outbox_status_idx").on(t.status),
    campaignIdx: index("email_outbox_campaign_idx").on(t.campaignId),
    sentAtIdx: index("email_outbox_sent_at_idx").on(t.sentAt),
  }),
);
export type DbEmailOutbox = typeof emailOutbox.$inferSelect;

/* ---------- per-category email unsubscribes ---------- */
/**
 * A user's opt-out of one broadcast CATEGORY (migration 0257). Presence of
 * a row = unsubscribed from that category; absence = subscribed. The
 * one-click footer link writes the row for the campaign's category, so
 * dropping "newsletter" doesn't stop "announcements". Transactional mail
 * is never a category and ignores this table entirely.
 */
export const emailUnsubscribes = sqliteTable(
  "email_unsubscribes",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => ({
    userCatUq: uniqueIndex("email_unsub_user_cat_uq").on(t.userId, t.category),
  }),
);
export type DbEmailUnsubscribe = typeof emailUnsubscribes.$inferSelect;

/**
 * Tamper-evident chat-export receipts (migration 0261). One row per
 * `/export`, recording the metadata + a SHA-256 content hash of the signed
 * canonical payload — never message bodies, so it's privacy-safe to keep
 * indefinitely and can confirm a submitted file even after its messages
 * age out of retention. `id` is the human-facing Verification ID printed
 * in the log footer; `signature` is the HMAC kept so a receipt alone can
 * re-confirm a file. See export/sign.ts + the verifier admin route.
 */
export const exportReceipts = sqliteTable(
  "export_receipts",
  {
    id: id(),
    /** SET NULL on room delete — the receipt outlives the room. */
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null" }),
    /** Snapshot of the room name at export time. */
    roomName: text("room_name").notNull(),
    exportedByUserId: text("exported_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Snapshot of the master username that ran /export. */
    exportedByUsername: text("exported_by_username").notNull(),
    generatedAt: integer("generated_at").notNull(),
    windowMs: integer("window_ms").notNull(),
    rangeStart: integer("range_start").notNull(),
    rangeEnd: integer("range_end").notNull(),
    messageCount: integer("message_count").notNull(),
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    /** SHA-256 of the canonical signed payload (hex). */
    contentHash: text("content_hash").notNull(),
    /** HMAC-SHA256 signature (hex). */
    signature: text("signature").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => ({
    hashIdx: index("export_receipts_hash_idx").on(t.contentHash),
    roomIdx: index("export_receipts_room_idx").on(t.roomId, t.generatedAt),
  }),
);
export type DbExportReceipt = typeof exportReceipts.$inferSelect;
