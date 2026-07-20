import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { rooms } from "./chat.js";
import { servers } from "./servers.js";
import { users } from "./users.js";

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
  /**
   * Extra disposable/temporary email domains to block at signup (migration
   * 0367), on top of the vendored list in auth/disposableEmail.ts. Newline or
   * comma separated; empty = just the vendored list.
   */
  blockedEmailDomains: text("blocked_email_domains").notNull().default(""),
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
  /**
   * Default social-card image URL (migration 0309). When set, renderSplashHtml
   * uses it as the og:image / twitter:image fallback for every route that
   * doesn't carry its own card image. Empty = fall back to the image baked
   * into index.html. Recommended 1200x630, under 1 MB.
   */
  ogImageUrl: text("og_image_url").notNull().default(""),
  /**
   * Tagline appended after the site name in the homepage / login / register
   * `<title>` (`{siteName} - {tagline}`). Empty falls back to the built-in
   * HOMEPAGE_TAGLINE in seo.ts. Migration 0309.
   */
  homepageTagline: text("homepage_tagline").notNull().default(""),
  /**
   * Keyword shelf rendered into `<meta name="keywords">`. Ignored by Google
   * but used by Bing / DuckDuckGo / card scrapers. Empty falls back to the
   * built-in DEFAULT_KEYWORDS in seo.ts. Migration 0309.
   */
  seoKeywords: text("seo_keywords").notNull().default(""),
  /** google-site-verification content token; injected as a `<meta>` when set. Migration 0309. */
  googleSiteVerification: text("google_site_verification").notNull().default(""),
  /** Bing msvalidate.01 content token; injected as a `<meta>` when set. Migration 0309. */
  bingSiteVerification: text("bing_site_verification").notNull().default(""),
  /**
   * Master search-indexing switch (migration 0309). When false, robots.txt
   * emits `Disallow: /` and every splash response gets a `noindex,nofollow`
   * robots meta. Default true so existing installs stay indexable. Useful for
   * staging / pre-launch.
   */
  searchIndexingEnabled: integer("search_indexing_enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * Newline-separated social profile URLs mapped into the Organization JSON-LD
   * `sameAs` array (migration 0309). Empty = omit `sameAs`.
   */
  socialProfileUrls: text("social_profile_urls").notNull().default(""),
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
  /**
   * Splash "Beta" badge (migration 0357). When true, the anonymous splash
   * hero shows a small "Beta" chip plus a one-line "young and growing" note.
   * The /site payload ANDs this with a version gate (app VERSION < 1.0.0,
   * SemVer order), so the badge self-retires at 1.0.0 regardless of the
   * toggle. Default ON — the version gate is the real off-switch.
   */
  betaBadgeEnabled: integer("beta_badge_enabled", { mode: "boolean" }).notNull().default(true),
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
  /**
   * Escalating chat anti-spam (migration 0313). When true, rapid-fire message
   * floods from ordinary users hit a warn->mute ladder (see realtime/antiSpam.ts).
   * Off by default so admins opt in; the `bypass_anti_spam` permission exempts
   * trusted users, mods, and admins.
   */
  antiSpamEnabled: integer("anti_spam_enabled", { mode: "boolean" }).notNull().default(false),
  /**
   * World map image uploads (migration 0360). When true, the world-map
   * create/edit routes accept an `imageDataUrl` (PNG/JPG/WEBP/GIF, 6MB cap,
   * ≤10 stored images per world) written under /uploads/worldmaps/. Off by
   * default: the hosting volume is small and shared with the database, so
   * disk-backed member uploads are an explicit admin opt-in. External https
   * image links work regardless of this flag.
   */
  worldMapUploadsEnabled: integer("world_map_uploads_enabled", { mode: "boolean" }).notNull().default(false),
  /**
   * Denote unverified users (migration 0353). When true, accounts whose
   * `users.email_verified_at` is NULL wear a subtle "Unverified" chip in the
   * room userlist and on profiles. Off by default; the flag only rides the
   * occupant/profile payloads while it is on (no wire noise when off).
   * Legacy accounts were backfilled verified by migration 0257, so flipping
   * this on never marks pre-existing users.
   */
  denoteUnverifiedUsers: integer("denote_unverified_users", { mode: "boolean" }).notNull().default(false),
  /**
   * Registration minimum-age switch (migration 0330) — "the flip" of the
   * age-restriction plan. OFF (default) = new accounts must be 18+ (the
   * historical posture, now enforced by date of birth); ON = 13+. This is
   * the ONLY thing the flag controls: every other age gate is
   * unconditional code that no-ops until minor accounts exist. Flipping
   * back OFF stops new minor signups; existing minor accounts keep their
   * gates.
   */
  allowMinorSignups: integer("allow_minor_signups", { mode: "boolean" }).notNull().default(false),
  /**
   * Auto-moderation master switch (migration 0319). When true, the chat + forum
   * pipelines run the enabled `automod_rules` (keyword/regex/link/invite/mention
   * filters) before a message lands. Off by default so admins opt in; the
   * `bypass_automod` permission exempts trusted users, mods, and admins.
   */
  automodEnabled: integer("automod_enabled", { mode: "boolean" }).notNull().default(false),
  /**
   * Minor language filter master switch (migration 0339, age plan Phase 7).
   * When true, strong language is MASKED at read time for under-18 viewers
   * (see realtime/minorLanguageFilter.ts). Stored rows are never modified and
   * adults always see the original, so this defaults ON: protective the
   * moment minor accounts exist, invisible until then.
   */
  minorFilterEnabled: integer("minor_filter_enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * Admin-editable ADDED words for the minor language filter (JSON string
   * array, migration 0339). Folded into the matcher on top of obscenity's
   * English preset — community-specific terms and non-English gaps.
   */
  minorFilterTermsJson: text("minor_filter_terms_json").notNull().default("[]"),
  /**
   * Admin-editable NEVER-CENSOR words for the minor language filter (JSON
   * string array, migration 0339). Whitelisted in the matcher to fix
   * Scunthorpe-class false positives.
   */
  minorFilterAllowJson: text("minor_filter_allow_json").notNull().default("[]"),
  /**
   * First-party analytics master switch (migration 0310). When false the ingest
   * routes + server-side page-view recorder become no-ops. Default on; additive
   * so existing installs start collecting immediately.
   */
  analyticsEnabled: integer("analytics_enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * How many days of RAW analytics rows (page_view + event) to keep before the
   * nightly rollup sweep deletes them. Long-term data lives in the tiny
   * analytics_daily rollup, which is kept indefinitely. Default 30 (migration 0310).
   */
  analyticsRawRetentionDays: integer("analytics_raw_retention_days").notNull().default(30),
  /**
   * Honor the browser DNT / Sec-GPC signal (migration 0310). When true (default)
   * a request that opts out of tracking is not recorded. Turning it off records
   * regardless — the analytics stay first-party, cookieless, and aggregate
   * either way.
   */
  analyticsRespectDnt: integer("analytics_respect_dnt", { mode: "boolean" }).notNull().default(true),
  /** Optional MaxMind account ID for the GeoLite2-City accuracy upgrade (migration 0328). NULL = use the bundled geoip-lite snapshot. */
  maxmindAccountId: text("maxmind_account_id"),
  /** Optional MaxMind license key paired with `maxmindAccountId`. SECRET — like `vapidPrivateKey`, NEVER expose to clients (only a `maxmindConfigured` boolean leaves the server). */
  maxmindLicenseKey: text("maxmind_license_key"),
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
export type DbNavLink = typeof navLinks.$inferSelect;
export type DbSiteSettings = typeof siteSettings.$inferSelect;

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
