import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { characters, users } from "./users.js";

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
export type DbIdentityPetCollection = typeof identityPetCollection.$inferSelect;
