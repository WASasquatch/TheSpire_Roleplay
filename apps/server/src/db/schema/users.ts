import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { servers } from "./servers.js";

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
     * Persisted UI language (migration 0338). A SUPPORTED_LOCALES code
     * ("en" | "es"; whitelist enforced in PUT /me/profile, not here, so a
     * new locale is a code change only). Null = "System default": the
     * client auto-detects (localStorage → navigator.language → en) and
     * server-side rendering for this user falls back to en. Server
     * notices/emails resolve the recipient's language from this column
     * once Phase 3 lands.
     */
    locale: text("locale"),
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
     * Profile language tags (migration 0342). Comma-separated lowercase
     * keys from the shared `LANGUAGE_TAGS` catalog — the languages this
     * player knows and roleplays in, in their chosen display order.
     * Rendered as flag chips in the profile hero (characters show their
     * owner's tags). '' = none (row hidden). Same parseTagList /
     * serializeTagList round-trip as storyCwBlocklist.
     */
    languages: text("languages").notNull().default(""),
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
    incognitoCharacterId: text("incognito_character_id"),
    /**
     * Per-user server-rail ordering — a JSON array of server ids in the order
     * the viewer dragged them (Discord-style). Private to the user. Servers not
     * present fall to the end in their default order; NULL = default order.
     * Migration 0326.
     */
    railOrderJson: text("rail_order_json"),
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
     * Date of birth, ISO YYYY-MM-DD (migration 0329) — the ONLY stored age
     * signal. NULL = legacy account from before DOB collection; those all
     * attested 18+ at signup, so `auth/ageGate.ts` derives them as adult.
     * Adult vs minor is COMPUTED from this at read time (UTC, date-only;
     * adult ON the 18th birthday) — never stored, so accounts graduate
     * automatically. Set once at registration; only admins holding
     * `edit_user_dob` may correct it (audited). Never in any payload other
     * than the owner's own settings/export and the secure admin directory.
     */
    birthdate: text("birthdate"),
    /**
     * Adult soft preference "Hide 18+ content" (migration 0329). Feeds
     * `canSeeNsfw()` for the SOFT tier only (forum topic lists, searches,
     * discovery/catalog listings). Irrelevant for minors — they can never
     * see NSFW regardless. Default false so existing adults see today's
     * exact behavior.
     */
    hideNsfw: integer("hide_nsfw", { mode: "boolean" }).notNull().default(false),
    /**
     * Minor isolation mode, "only see members under 18 and staff"
     * (migration 0334). Opt-in, minor-only (rejected server-side for adult
     * accounts). While the account is under 18 this acts as a virtual
     * MUTUAL block against every adult non-staff account; site staff stay
     * visible both ways. The enforcement predicate also checks isMinor, so
     * the flag goes inert automatically at 18 without a write.
     */
    isolateFromAdults: integer("isolate_from_adults", { mode: "boolean" }).notNull().default(false),
    /**
     * Hash of the new-user welcome message this user has acknowledged.
     * Compared against the current site-settings hash on /me/profile to
     * decide whether to surface the welcome modal. Null = never seen any
     * welcome (any non-empty message will show on next load).
     */
    welcomeSeenHash: text("welcome_seen_hash"),
    /**
     * Highest site coach-tour version this user has acknowledged (migration
     * 0312). Compared against the shared `SITE_TOUR_VERSION` on /me/profile:
     * when it is lower, the response reports `showSiteTour:true` and the client
     * auto-opens the first-run screen tour once, then POST /me/tour/dismiss
     * writes `SITE_TOUR_VERSION` back here. 0 (the default) = never seen any
     * tour, so a fresh user gets version 1 on first load. Bumping the constant
     * re-shows the revised tour to everyone below it. Mirrors the welcome's
     * seen-once mechanism, but as a monotonic version rather than a copy hash
     * because the tour text is client-hard-coded, not admin-authored.
     */
    tourSeenVersion: integer("tour_seen_version").notNull().default(0),
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
    /**
     * Whether this account has a usable local password (migration 0323).
     * Normal registrations default to true; an account provisioned purely
     * through Google sign-in sets this false so the login UI / password-change
     * flow can adapt (offer "set a password" instead of "change password").
     */
    hasPassword: integer("has_password", { mode: "boolean" }).notNull().default(true),
  },
  (t) => ({
    // Email is no longer unique at the DB layer; the per-account cap is
    // configurable via site_settings.max_accounts_per_email and enforced
    // in /auth/register. Username remains uniquely indexed.
    emailIdx: index("users_email_idx").on(sql`lower(${t.email})`),
    usernameUq: uniqueIndex("users_username_uq").on(sql`lower(${t.username})`),
  }),
);

/* ---------- oauth accounts (migration 0323) ----------
 * Links a local `users` row to an external identity provider (currently just
 * Google). unique(provider, providerUserId) keeps one external identity mapped
 * to a single local; unique(userId, provider) keeps one local mapped to a
 * single identity per provider. `providerEmail` is informational (the email the
 * provider reported at link time); the local account's own email stays
 * authoritative. Cascades on user delete. Additive + env-gated — nothing reads
 * this until Google sign-in is configured and turned on. */
export const oauthAccounts = sqliteTable(
  "oauth_accounts",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Provider key, e.g. "google". */
    provider: text("provider").notNull(),
    /** The provider's stable subject id for the user (Google `sub`). */
    providerUserId: text("provider_user_id").notNull(),
    /** Email the provider reported at link time; informational only. */
    providerEmail: text("provider_email"),
    linkedAt: integer("linked_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    providerUidUq: uniqueIndex("oauth_accounts_provider_uid_uq").on(t.provider, t.providerUserId),
    userProviderUq: uniqueIndex("oauth_accounts_user_provider_uq").on(t.userId, t.provider),
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

export type DbUser = typeof users.$inferSelect;
export type DbOauthAccount = typeof oauthAccounts.$inferSelect;
export type DbCharacter = typeof characters.$inferSelect;
export type DbTitleKind = typeof titleKinds.$inferSelect;
export type DbMutualTitle = typeof mutualTitles.$inferSelect;
export type DbProfileLink = typeof profileLinks.$inferSelect;
export type DbCharacterJournalEntry = typeof characterJournalEntries.$inferSelect;
export type DbFriend = typeof friends.$inferSelect;
/** @deprecated Use DbFriend. Kept for one release for downstream callers. */
export type DbWatch = DbFriend;
export type DbPushSubscription = typeof pushSubscriptions.$inferSelect;
