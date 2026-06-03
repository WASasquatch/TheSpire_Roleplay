/** Structured stat fields surfaced as labeled rows in the profile editor. */
export interface CharacterStats {
  age?: string;
  race?: string;
  gender?: string;
  height?: string;
  weight?: string;
  alignment?: string;
  occupation?: string;
  /** Free-form key/value extras, max 20 entries, each value <= 200 chars (validated server-side). */
  custom?: Record<string, string>;
  /**
   * Personality vibe — eight bipolar axes painted as "low label ◄
   * dot ► high label" bars on the profile. Each value is 0..100 or
   * null (unset, doesn't render). The axis catalog is fixed
   * server-side ({@link CHARACTER_VIBE_AXES}); unknown keys are
   * dropped on save so a future axis rename can't strand a row.
   *
   * Distinct from Worlds' {@link WorldVibeStats}: World axes are
   * MAGNITUDE (50 = "moderate amount of magic"); character axes are
   * BIPOLAR (50 = neutral between two opposing traits, 0 = fully one
   * end, 100 = fully the other). The renderer needs the dual labels
   * to read correctly.
   */
  vibe?: Partial<Record<CharacterVibeAxisKey, number | null>>;
  /**
   * Numeric attribute sheet — D&D-style ability scores ("STR 14"),
   * HP / SP, any-RPG attribute system. Each row is a user-defined
   * label plus a value clamped to a per-row min/max. Capped at 20
   * rows server-side; labels <= 40 chars; values / bounds are
   * integers in [-9999, 9999] to allow negatives (modifiers,
   * temporary debuffs) without making the input gymnastics
   * uncomfortable.
   *
   * `id` is a stable client-generated key so React can render the
   * list without thrashing on reorder; server preserves whatever the
   * client sent. Reordering / removal is purely client-side editing.
   */
  attributes?: CharacterAttribute[];
  /**
   * Per-section render gate. Lets the owner type a value once and
   * later hide it from the public profile without losing the data
   * (so "I don't want strangers seeing my weight" doesn't force
   * them to delete + re-enter on the next round). Default behavior
   * (key omitted or undefined) is SHOW. A `false` value hides that
   * section from the profile renderer; the editor still surfaces it
   * so the owner can flip it back on. Hiding takes effect at render
   * time only — admins still see the full stats via the admin user
   * detail panel.
   */
  visibility?: CharacterStatsVisibility;
}

/** One row of the {@link CharacterStats.attributes} numeric attribute sheet. */
export interface CharacterAttribute {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
}

/** Render-gate map on `CharacterStats.visibility`. Omitted / undefined keys default to "show". */
export interface CharacterStatsVisibility {
  age?: boolean;
  race?: boolean;
  gender?: boolean;
  height?: boolean;
  weight?: boolean;
  alignment?: boolean;
  occupation?: boolean;
  custom?: boolean;
  vibe?: boolean;
  attributes?: boolean;
}

/**
 * Character vibe axis catalog. Each axis is bipolar — `lowLabel` is
 * at 0, `highLabel` at 100, with the dot rendered at the stored value.
 * Order is the display order on the profile + the editor.
 *
 * Adding an axis: drop it here. Existing rows that don't have a value
 * for the new axis simply skip its bar; no migration. Removing an
 * axis: drop the key here AND clean up the data on the next stats
 * write (the server schema's `.passthrough()` is intentionally
 * absent so stale axis keys get dropped automatically).
 */
export const CHARACTER_VIBE_AXES = [
  { key: "combat",     lowLabel: "Pacifist",   highLabel: "Combat" },
  { key: "cunning",    lowLabel: "Honest",     highLabel: "Cunning" },
  { key: "warmth",     lowLabel: "Cold",       highLabel: "Warm" },
  { key: "order",      lowLabel: "Chaos",      highLabel: "Order" },
  { key: "caution",    lowLabel: "Reckless",   highLabel: "Cautious" },
  // `outlook` / `social` carry neutral storage keys because both ends
  // of the axis are descriptors (Cynical/Idealistic, Reserved/Outgoing)
  // and neither is a clear "more of X" representative the way
  // `combat` or `warmth` is.
  { key: "outlook",    lowLabel: "Cynical",    highLabel: "Idealistic" },
  { key: "social",     lowLabel: "Reserved",   highLabel: "Outgoing" },
  // `boldness` is named after the HIGH end (Risqué reads as boldness
  // in the sexual / social-provocation register). Earlier draft used
  // `modesty` here — that named the axis after the LOW end and broke
  // the high-label-as-key convention every other concrete axis above
  // follows. Storage-key change only; the rendered labels stay
  // `Modest ↔ Risqué`.
  { key: "boldness",   lowLabel: "Modest",     highLabel: "Risqué" },
] as const satisfies ReadonlyArray<{ key: string; lowLabel: string; highLabel: string }>;

export type CharacterVibeAxisKey = typeof CHARACTER_VIBE_AXES[number]["key"];

/** Server-enforced cap on the {@link CharacterStats.attributes} array length. */
export const CHARACTER_ATTRIBUTES_MAX = 20;
/** Server-enforced cap on a {@link CharacterAttribute.label} length. */
export const CHARACTER_ATTRIBUTE_LABEL_MAX = 40;
/** Server-enforced bounds on `value` / `min` / `max` of a {@link CharacterAttribute}. */
export const CHARACTER_ATTRIBUTE_VALUE_MIN = -9999;
export const CHARACTER_ATTRIBUTE_VALUE_MAX = 9999;

import type { Theme } from "./theme.js";

/**
 * A reference to a "title-bound identity" - either a master account
 * (characterId=null) or a specific character. Used to link a rendered
 * mutual title to the other party's profile so the client can route a
 * click to /whois <name>.
 */
export interface IdentityRef {
  userId: string;
  /** null = master account; non-null = character */
  characterId: string | null;
  /** The display name to show + use for /whois lookup. */
  displayName: string;
}

/**
 * One mutual title rendered on a profile - e.g. "Married to Kaal",
 * "Kaal's Partner", "Mentor of Kaal". The `text` is pre-rendered server-
 * side from the kind's format string with `{target}` replaced by
 * `other.displayName`.
 */
export interface ProfileTitle {
  /** mutual_titles.id - opaque to the client, useful for dissolve flows. */
  id: string;
  /** title_kinds.slug - used by /dissolve to identify the title kind. */
  kindSlug: string;
  /** Pre-formatted display string (e.g. "Married to Kaal"). */
  text: string;
  /** Other party's identity, so the client can link the rendered title. */
  other: IdentityRef;
}

export interface CharacterPortrait {
  id: string;
  url: string;
  label: string | null;
  /** Owner-set NSFW flag. When true, viewers see the tile blurred until they click to reveal. */
  nsfw: boolean;
}

/**
 * A solo writing entry attached to a character — backstory fragment,
 * in-world diary, world notes. Public entries are visible on the
 * character's profile to anyone; private entries are only included in
 * the response when the viewer owns the character.
 */
export interface CharacterJournalEntry {
  id: string;
  /** Optional title; null/empty means "untitled". */
  title: string | null;
  /** Sanitized HTML body. Rendered via the prose styles, never raw. */
  bodyHtml: string;
  privacy: "public" | "private";
  createdAt: number;
  updatedAt: number;
}

/**
 * A player-set link rendered as a styled chip on a profile. Capped at 6 per
 * profile server-side. Colors are optional hex (#rrggbb); null falls back to
 * theme-default styling on the client.
 */
export interface ProfileLink {
  id: string;
  title: string;
  url: string;
  borderColor: string | null;
  bgColor: string | null;
  textColor: string | null;
}

/**
 * Activity counters surfaced on profile views. Each field is a
 * lifetime aggregate computed at profile-fetch time so the numbers
 * are always fresh — no denormalized column to drift, no janitor
 * job to maintain.
 *
 * Scoped per identity:
 *   - master profile  → counts every message authored under the
 *     user account, character-attached or not.
 *   - character profile → counts only messages authored AS that
 *     specific character (characterId match).
 *
 * Each count excludes server-side soft-deleted rows so a moderation
 * hide doesn't suddenly drop a user's lifetime number, but the
 * original author still gets credit for "having posted" — the
 * post existed, the user typed it.
 */
/**
 * One pinned slot on a profile's Collection block. Surfaced in
 * profile lookup responses so the client renders the showcase
 * without a second round trip — every entry bundles the slot index
 * (0..9), the catalog key, and the visible item fields (display
 * name + description + icon URL). Slots not pinned by the identity
 * are simply absent from the array — the renderer paints them as
 * empty placeholders or collapses them per its layout.
 *
 * Item display values are snapshot from the live catalog at
 * lookup time, so if an admin renames an item the profile reflects
 * the new name on the next view (no stale denormalization).
 */
export interface ProfileCollectionEntry {
  slot: number;
  itemKey: string;
  name: string;
  namePlural: string | null;
  description: string;
  iconUrl: string | null;
  /**
   * Owner-assigned nickname for this specific pinned pet (only set on
   * entries from the pet collection; item-collection entries always
   * have this as null/undefined). Renderer convention: show the
   * nickname as the primary label with the catalog `name` as a smaller
   * secondary subtitle. Null when the owner hasn't named the pet —
   * renderer falls back to showing the catalog name alone, same as
   * the pre-nickname behavior.
   */
  nickname?: string | null;
}

/**
 * Max length for a per-pet nickname. Short enough to fit alongside the
 * breed label in a pet card without wrapping; long enough for "Captain
 * Whiskers III" style names. Server clamps on write, client mirrors
 * the cap in the rename UI.
 */
export const PET_NICKNAME_MAX_LENGTH = 40;

export interface ProfileMetrics {
  /**
   * Chat-shaped lines in flat-mode rooms (`say` / `me` / `ooc` /
   * `roll` / `scene` / `npc`). Null when the user has set
   * `hideChatMessageCount` — the renderer shows "private" in place
   * of a number.
   */
  chatMessages: number | null;
  /** Top-level forum-topic openings. Null when `hideForumTopicCount` is set. */
  forumTopics: number | null;
  /** Forum replies (any kind with a `replyToId`). Null when `hideForumReplyCount` is set. */
  forumReplies: number | null;
}

/**
 * Scriptorium passive author tier. Identity-level badge surfaced on
 * profile views once an author crosses one of the canonical
 * thresholds. Tiers are purely passive — no XP, no streaks, no daily
 * grind (per the participation ethos).
 *
 *   "author"      — first story published
 *   "storyteller" — 5 published stories
 *   "loremaster"  — 25 published stories
 *
 * Null = no stories published yet; no badge rendered.
 */
export type ScriptoriumAuthorTier = "author" | "storyteller" | "loremaster";

/** Per-tier thresholds (story counts). Owner is admin-tunable in a
 *  future iteration; this is the canonical default. */
export const SCRIPTORIUM_AUTHOR_TIERS: readonly { tier: ScriptoriumAuthorTier; minStories: number }[] = [
  { tier: "loremaster",  minStories: 25 },
  { tier: "storyteller", minStories: 5 },
  { tier: "author",      minStories: 1 },
] as const;

/** Resolve a tier (or null) from a published-story count. */
export function resolveScriptoriumAuthorTier(publishedStories: number): ScriptoriumAuthorTier | null {
  for (const t of SCRIPTORIUM_AUTHOR_TIERS) {
    if (publishedStories >= t.minStories) return t.tier;
  }
  return null;
}

/**
 * Wire shape embedded on identity profiles (master + character —
 * value is the same regardless, since stories are owned by the master
 * account). Surfaces a small "Author" / "Storyteller" / "Loremaster"
 * badge in the profile header.
 */
export interface ScriptoriumAuthorBadge {
  tier: ScriptoriumAuthorTier;
  publishedStories: number;
}

export interface CharacterProfile {
  id: string;
  userId: string;
  name: string;
  /** sanitized HTML body */
  bioHtml: string;
  stats: CharacterStats;
  avatarUrl: string | null;
  /** Per-character zoom + focal point on the avatar source. Same
   *  semantics as `MasterProfile.avatarCrop`; defaults reproduce the
   *  legacy centered-cover render. */
  avatarCrop: AvatarCrop;
  /** Additional portraits beyond the primary avatarUrl, in the order the owner set. */
  portraits: CharacterPortrait[];
  /** Owner-set external links (other profiles, world docs, refs). */
  links: ProfileLink[];
  /** Public-visibility journal entries in chronological order (oldest first). Private entries are NEVER included in this array - they only surface in the owner's editor. */
  journalEntries: CharacterJournalEntry[];
  /** Owner's chosen UI theme - applied to the profile modal when others view it. */
  theme: Theme;
  /**
   * Fully-resolved design style key (medieval / modern / scifi) for this
   * profile. Server picks the highest-priority value among
   * character.styleKey > user.styleKey > themeDesignMap[<theme preset>] >
   * site.defaultStyleKey > "medieval", so the client can stamp
   * `data-theme-style` on the modal directly without re-running the
   * resolution chain.
   */
  styleKey: string;
  /** Mutual titles (marriages, partnerships, etc.) bound to this character. */
  titles: ProfileTitle[];
  /**
   * True iff this character is visible to anonymous (logged-out) viewers.
   * Default true. NSFW characters are forced to behave as non-public to
   * anonymous regardless of this flag (server enforces).
   */
  isPublic: boolean;
  /**
   * Whole-profile NSFW flag. Authenticated viewers see a warning splash
   * before the content renders; the owner + admins skip the gate.
   * Independent of per-portrait NSFW blurring (which still applies to
   * individual gallery images even on a SFW profile).
   */
  isNsfw: boolean;
  createdAt: number;
  updatedAt: number;
  /** Lifetime activity counters scoped to this character. */
  metrics: ProfileMetrics;
  /**
   * Scriptorium passive author tier — populated from the OWNING
   * master account's published-story count, so a character profile
   * inherits the same badge as the owner's master profile. Null when
   * no story has been published yet (no badge rendered).
   */
  scriptoriumAuthor: ScriptoriumAuthorBadge | null;
  /**
   * Pinned NON-PET items from this character's Collection (up to 10).
   * Sparse — a character can pin slots 0, 3, 7 and leave the rest
   * empty. Each pin is independent of every OTHER identity's
   * Collection: this character's pins do not appear on the OOC
   * profile or on any other character's profile.
   */
  collection: ProfileCollectionEntry[];
  /**
   * Pinned PET items from this character's Pet Collection (up to 5).
   * Same partitioning model as `collection`, but a tighter cap and
   * scoped to items with `category='pet'`. Renders as a separate
   * "Pets" section on the profile, below the item collection.
   */
  petCollection: ProfileCollectionEntry[];
  /**
   * Equipped name-style key for THIS identity. Drives the rendered
   * username in the profile hero so a name style isn't just a chat
   * cosmetic — it shows wherever the user's identity is on display.
   * Each identity (master + each character) holds its own
   * equipped style; switching characters paints a different
   * profile name. Null when nothing is equipped (renders plain).
   */
  nameStyleKey: string | null;
  /**
   * Per-user config (color picks, glow strength, etc.) the style's
   * CSS template reads. Shape varies per style. Null falls back to
   * the style's default config.
   */
  nameStyleConfig: Record<string, unknown> | null;
  /**
   * Profile banner URL — wide hero strip rendered at the top of the
   * profile modal. Equipped via the `flair_profile_banner` Flair
   * purchase; this character's owner pastes any public https image
   * URL. Null when the slot is empty.
   */
  profileBannerUrl: string | null;
  /**
   * Public-profile background image URL + display mode. When the
   * profile modal renders, its backdrop (the area outside the modal
   * card) paints this image so visitors landing on /p/<character>
   * see the owner's chosen image instead of the default spire
   * splash. Null URL = no override (default backdrop). The mode
   * picks the CSS sizing strategy — see PublicProfileBgMode for
   * the table.
   */
  publicProfileBgUrl: string | null;
  publicProfileBgMode: PublicProfileBgMode;
  /**
   * Master account username of the user who owns this character —
   * surfaced ONLY when the viewer is a mod/admin/masteradmin. Lets
   * moderation staff see "this character is voiced by user X"
   * without having to skim the userlist for the correlation.
   * Omitted entirely (field absent) for non-mod viewers; the
   * server gates this on viewer role, so the field's presence is
   * itself a privileged signal — never derive `kind: "character"`
   * behavior from its absence on the client.
   */
  ownerUsername?: string;
}

/**
 * Canonical account-role union. Ordered loosely from least to most powerful;
 * `trusted` is a participation-earned auto-promotion that grants elevated
 * rate limits, `mod` / `admin` / `masteradmin` are manually granted.
 *
 * The two admin tiers exist because the historical single `admin` role
 * was god-mode — branding, settings, user disable, role escalation, every
 * destructive lever. That kept the moderator bench thin because every
 * promotion was an all-or-nothing trust transfer.
 *
 *   `mod`         — room-level moderation only (kick / mute / ban in
 *                   rooms they moderate). No global powers.
 *   `admin`       — global moderation: every `mod` power site-wide,
 *                   plus room delete / message moderation / report
 *                   triage / custom commands / world admin / title
 *                   kinds / audit read. Can promote others to `admin`
 *                   and below. CANNOT touch branding, site settings,
 *                   rules HTML, user emails / passwords / disable,
 *                   and CANNOT promote anyone to `masteradmin`.
 *   `masteradmin` — full god-mode. Everything `admin` does plus the
 *                   destructive levers listed above. The first
 *                   registered user bootstraps in as masteradmin.
 *                   New masteradmins are only mintable by other
 *                   masteradmins from the admin panel's user editor.
 *
 * Single source of truth — every server route, web component, and API
 * response that types a `role` field must import from here so the tiers
 * stay in lockstep. Adding a new tier means changing one symbol and
 * letting the compiler surface every site that needs to handle it.
 *
 * `isAdminRole` / `isMasterAdminRole` (below) wrap the two common
 * checks; please use them rather than open-coding `role === "admin"`
 * comparisons, since the right answer for "is this user privileged?"
 * is now "either admin tier" almost everywhere except destructive
 * route gates.
 */
export type Role = "user" | "trusted" | "mod" | "admin" | "masteradmin";

/** True for both admin tiers — the standard "is this user privileged?" check. */
export function isAdminRole(role: Role): boolean {
  return role === "admin" || role === "masteradmin";
}

/** True only for the top tier — guards destructive endpoints (settings, branding, user disable, masteradmin promotion). */
export function isMasterAdminRole(role: Role): boolean {
  return role === "masteradmin";
}

/**
 * Numeric rank so the moderation code can ask "does this caller
 * outrank this target?" without enumerating every tier. Higher number
 * = more authority. Used to block a lower-tier admin from kicking /
 * muting / banning a higher-tier one — e.g. a plain admin can't
 * kick a masteradmin, and a mod can't kick either admin tier.
 */
export function roleRank(role: Role): number {
  switch (role) {
    case "masteradmin": return 4;
    case "admin":       return 3;
    case "mod":         return 2;
    case "trusted":     return 1;
    case "user":        return 0;
  }
}

/**
 * Avatar zoom / pan focal point. Used by the avatar crop picker in the
 * profile editor to position which part of a larger source image
 * becomes the visible circle, without re-hosting or modifying the
 * source bytes.
 *
 *   * `zoom`    — multiplier on top of the natural cover-fit. 1.0 =
 *                 legacy centered cover render (the default for every
 *                 user pre-migration-0178); higher = zoomed in.
 *                 Clamped to [1.0, 4.0] by `clampAvatarCrop` below.
 *   * `offsetX` — 0..100, percent. Maps directly to CSS
 *                 `object-position` X axis. 0 = far left of source
 *                 visible, 100 = far right, 50 = centered.
 *   * `offsetY` — same but vertical.
 *
 * Renderer convention: `transform-origin` is set to the same
 * (offsetX, offsetY) as `object-position` so the zoom appears to zoom
 * IN ON the focal point the owner picked, not on the geometric
 * center of the image.
 */
export interface AvatarCrop {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export const AVATAR_CROP_DEFAULTS: AvatarCrop = {
  zoom: 1.0,
  offsetX: 50.0,
  offsetY: 50.0,
};

export const AVATAR_CROP_MIN_ZOOM = 1.0;
export const AVATAR_CROP_MAX_ZOOM = 4.0;

/** Clamp a partial / wild crop input to the documented ranges. NaN /
 *  missing fields fall back to the defaults so a bad client write
 *  can't put the avatar into an unrenderable state. */
export function clampAvatarCrop(input: Partial<AvatarCrop> | null | undefined): AvatarCrop {
  const z = Number(input?.zoom);
  const x = Number(input?.offsetX);
  const y = Number(input?.offsetY);
  return {
    zoom: Number.isFinite(z) ? Math.min(AVATAR_CROP_MAX_ZOOM, Math.max(AVATAR_CROP_MIN_ZOOM, z)) : AVATAR_CROP_DEFAULTS.zoom,
    offsetX: Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : AVATAR_CROP_DEFAULTS.offsetX,
    offsetY: Number.isFinite(y) ? Math.min(100, Math.max(0, y)) : AVATAR_CROP_DEFAULTS.offsetY,
  };
}

/** True when the crop is at its identity values (zoom=1, centered).
 *  Renderers can short-circuit the transform application when this is
 *  true so the legacy centered-cover code path is preserved verbatim
 *  for the vast majority of avatars. */
export function isDefaultAvatarCrop(c: AvatarCrop): boolean {
  return c.zoom === AVATAR_CROP_DEFAULTS.zoom
    && c.offsetX === AVATAR_CROP_DEFAULTS.offsetX
    && c.offsetY === AVATAR_CROP_DEFAULTS.offsetY;
}

export interface MasterProfile {
  userId: string;
  username: string;
  bioHtml: string;
  avatarUrl: string | null;
  /** Owner-picked zoom + focal point applied to the avatar source.
   *  Defaults reproduce the legacy centered-cover render. See
   *  `AvatarCrop` above. */
  avatarCrop: AvatarCrop;
  /**
   * Additional portrait gallery for the master / OOC profile. Same
   * shape as CharacterProfile.portraits — sorted by the owner's
   * chosen order. Renders as the "Gallery" section on the profile
   * modal, below the bio. Empty array when the user hasn't added
   * any extra portraits.
   */
  portraits: CharacterPortrait[];
  /** OOC gender, surfaced as the icon next to the username when no character is active. */
  gender: "male" | "female" | "nonbinary" | "other" | "undisclosed";
  /** Owner's chosen UI theme - applied to the profile modal when others view it. */
  theme: Theme;
  /** Resolved design style key — same semantics as `CharacterProfile.styleKey`. */
  styleKey: string;
  /** Mutual titles bound to this master account (separate from any character titles). */
  titles: ProfileTitle[];
  /** Owner-set external links (other profiles, OOC docs, refs). */
  links: ProfileLink[];
  /** Account-level role. Surfaced on the modal so site admins/mods are visibly marked. */
  role: Role;
  /** Same semantics as on CharacterProfile. */
  isPublic: boolean;
  isNsfw: boolean;
  createdAt: number;
  /** Lifetime activity counters scoped to this master account (every character). */
  metrics: ProfileMetrics;
  /**
   * Scriptorium passive author tier. Counted from this master account's
   * published stories. Null when none published yet.
   */
  scriptoriumAuthor: ScriptoriumAuthorBadge | null;
  /**
   * Pinned NON-PET items from this master account's Collection (up
   * to 10). Independent from every character's Collection — items
   * pinned on a character do not appear here, and vice versa.
   */
  collection: ProfileCollectionEntry[];
  /**
   * Pinned PET items from this master account's Pet Collection (up
   * to 5). Same isolation rules as `collection`.
   */
  petCollection: ProfileCollectionEntry[];
  /**
   * Master/OOC equipped name-style key + config. Painted on the
   * profile hero so the user's OOC cosmetic shows up beyond chat.
   * Null when no style is equipped (renders plain).
   */
  nameStyleKey: string | null;
  nameStyleConfig: Record<string, unknown> | null;
  /**
   * Profile banner URL — wide hero strip rendered at the top of the
   * profile modal. Equipped via the `flair_profile_banner` Flair
   * purchase; the user pastes any public https image URL. Null when
   * the slot is empty (no purchase, cleared by user, or admin
   * moderation cleared an abusive link).
   */
  profileBannerUrl: string | null;
  /**
   * Public-profile background image URL + display mode. Same
   * semantics as `CharacterProfile.publicProfileBgUrl/Mode` — each
   * identity (master + each character) holds its own backdrop, so a
   * user can paint the OOC profile differently from each
   * character's profile.
   */
  publicProfileBgUrl: string | null;
  publicProfileBgMode: PublicProfileBgMode;
}

/**
 * CSS sizing strategy for the public-profile backdrop image:
 *   "cover"    — image fills viewport, cropped to fit (default)
 *   "contain"  — image fits inside viewport, letterboxed
 *   "tile"     — image repeats to fill viewport
 *   "stretch"  — image stretched to exact viewport dimensions
 * Stored as the literal key; the client maps to `background-size`
 * + `background-repeat` pairs at render time.
 */
export type PublicProfileBgMode = "cover" | "contain" | "tile" | "stretch";

/** What `/profile` returns: either the master, or the active character. */
export type ProfileView =
  | { kind: "master"; profile: MasterProfile }
  | { kind: "character"; profile: CharacterProfile };
