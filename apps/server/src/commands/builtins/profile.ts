import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { characterEarning, characterJournalEntries, characterOwnedNameStyles, characterPortraits, characters, identityCollection, identityPetCollection, items, profileLinks, stories, storyCopies, userActiveCosmetics, userOwnedNameStyles, userPortraits, users } from "../../db/schema.js";
import type { CharacterJournalEntry, CharacterPortrait, CharacterStats, ProfileCollectionEntry, ProfileLibraryEntry, ProfileLink, ProfileMetrics, ProfileView, StoryRating, Theme } from "@thekeep/shared";
import { matchThemePreset, resolveScriptoriumAuthorTier, roleRank } from "@thekeep/shared";
import { getSettings, parseUserThemeJson } from "../../settings.js";
import { listTitlesForIdentity } from "../../titles/service.js";
import { emitAmbiguousIdentityModal, resolveIdentityArg } from "../identityArg.js";
import { isBlockedBetween } from "../../auth/blocks.js";
import { DEFAULT_SERVER_ID } from "../../earning/pool.js";
import type { CommandHandler } from "../types.js";

/**
 * Resolve the design style key (medieval / modern / scifi) a profile
 * should render with. Mirrors the client-side chain in App.tsx so a
 * viewer sees the owner's intended design even when their own active
 * style differs. Highest priority wins:
 *   1. character.styleKey
 *   2. user.styleKey
 *   3. themeDesignMap[<matched preset name>]
 *   4. site.defaultStyleKey
 *   5. "medieval" (hardcoded final fallback)
 */
async function resolveProfileStyleKey(
  db: import("../../db/index.js").Db,
  theme: Theme,
  charStyleKey: string | null,
  userStyleKey: string | null,
): Promise<string> {
  if (charStyleKey) return charStyleKey;
  if (userStyleKey) return userStyleKey;
  const settings = await getSettings(db);
  const presetName = matchThemePreset(theme);
  if (presetName && settings.themeDesignMap[presetName]) return settings.themeDesignMap[presetName]!;
  return settings.defaultStyleKey || "medieval";
}

/**
 * Resolve the identity's equipped name-style key + per-user config so
 * a profile view can paint the username with the user's chosen
 * cosmetic, name styles are show-off cosmetics, not chat-only
 * decoration. Master uses user_active_cosmetics + user_owned_name_styles;
 * a character uses character_earning + character_owned_name_styles
 * (per-identity store, migration 0086). Returns nulls when no style is
 * equipped OR the user has the row but no per-user config snapshot.
 */
async function getEquippedNameStyle(
  db: import("../../db/index.js").Db,
  scope: "user" | "character",
  ownerId: string,
): Promise<{ key: string | null; config: Record<string, unknown> | null }> {
  if (scope === "user") {
    const active = (await db
      .select({ key: userActiveCosmetics.activeNameStyleKey })
      .from(userActiveCosmetics)
      .where(eq(userActiveCosmetics.userId, ownerId))
      .limit(1))[0];
    const key = active?.key ?? null;
    if (!key) return { key: null, config: null };
    const owned = (await db
      .select({ configJson: userOwnedNameStyles.configJson })
      .from(userOwnedNameStyles)
      .where(and(eq(userOwnedNameStyles.userId, ownerId), eq(userOwnedNameStyles.styleKey, key)))
      .limit(1))[0];
    return { key, config: parseNameStyleConfig(owned?.configJson ?? null) };
  }
  const active = (await db
    .select({ key: characterEarning.activeNameStyleKey })
    .from(characterEarning)
    // Profile display reads the equipped cosmetic; with no per-server
    // viewer context here, scope to the default server (flag-off: the
    // only pool, byte-identical to today).
    .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, ownerId)))
    .limit(1))[0];
  const key = active?.key ?? null;
  if (!key) return { key: null, config: null };
  const owned = (await db
    .select({ configJson: characterOwnedNameStyles.configJson })
    .from(characterOwnedNameStyles)
    .where(and(eq(characterOwnedNameStyles.characterId, ownerId), eq(characterOwnedNameStyles.styleKey, key)))
    .limit(1))[0];
  return { key, config: parseNameStyleConfig(owned?.configJson ?? null) };
}

function parseNameStyleConfig(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try { return JSON.parse(json) as Record<string, unknown>; }
  catch { return null; }
}

/**
 * Pull the equipped profile-banner URL for a master/OOC pool or a
 * character. Returns null when nothing is equipped OR the identity
 * doesn't have an active-cosmetics row yet. The URL is server-truth
 * for what ProfileModal renders as the hero strip on this profile;
 * write-side validation lives on PATCH /earning/me/banner.
 */
async function getEquippedProfileBannerUrl(
  db: import("../../db/index.js").Db,
  scope: "user" | "character",
  ownerId: string,
): Promise<string | null> {
  if (scope === "user") {
    const row = (await db
      .select({ url: userActiveCosmetics.profileBannerUrl })
      .from(userActiveCosmetics)
      .where(eq(userActiveCosmetics.userId, ownerId))
      .limit(1))[0];
    return row?.url ?? null;
  }
  const row = (await db
    .select({ url: characterEarning.profileBannerUrl })
    .from(characterEarning)
    .where(and(eq(characterEarning.serverId, DEFAULT_SERVER_ID), eq(characterEarning.characterId, ownerId)))
    .limit(1))[0];
  return row?.url ?? null;
}

/**
 * Resolve whether the viewer has moderator-tier authority. Used to
 * gate the mod-only `ownerUsername` field on character profiles, a
 * site mod (or admin / masteradmin) sees who voices each character;
 * regular users don't. Returns false for anonymous viewers and for
 * users whose row vanished (shouldn't happen, but a safe default).
 */
async function viewerIsModerator(
  db: import("../../db/index.js").Db,
  viewerId: string | undefined,
): Promise<boolean> {
  if (!viewerId) return false;
  const row = (await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, viewerId))
    .limit(1))[0];
  if (!row) return false;
  return roleRank(row.role) >= roleRank("mod");
}

/**
 * Read the identity's Collection pins joined to the live items
 * catalog. Each entry carries the visible item fields snapshot at
 * lookup time so the client renders without a second round trip.
 * Ordered by slot ascending so the renderer can paint left-to-right
 * in slot order. Returns an empty array when nothing is pinned.
 */
async function listProfileCollection(
  db: import("../../db/index.js").Db,
  ownerScope: "user" | "character",
  ownerId: string,
): Promise<ProfileCollectionEntry[]> {
  const rows = await db
    .select({
      slot: identityCollection.slot,
      itemKey: identityCollection.itemKey,
      name: items.name,
      namePlural: items.namePlural,
      description: items.description,
      iconUrl: items.iconUrl,
    })
    .from(identityCollection)
    .innerJoin(items, eq(items.key, identityCollection.itemKey))
    .where(and(
      eq(identityCollection.ownerScope, ownerScope),
      eq(identityCollection.ownerId, ownerId),
    ))
    .orderBy(asc(identityCollection.slot));
  return rows;
}

/**
 * Twin of listProfileCollection but for the 5-slot Pet Collection.
 * Joins identity_pet_collection against items the same way; the
 * server's PUT /earning/me/pet-collection endpoint already enforces
 * `items.category = 'pet'` at write time, so we don't re-check here.
 */
async function listProfilePetCollection(
  db: import("../../db/index.js").Db,
  ownerScope: "user" | "character",
  ownerId: string,
): Promise<ProfileCollectionEntry[]> {
  const rows = await db
    .select({
      slot: identityPetCollection.slot,
      itemKey: identityPetCollection.itemKey,
      name: items.name,
      namePlural: items.namePlural,
      description: items.description,
      iconUrl: items.iconUrl,
      nickname: identityPetCollection.nickname,
    })
    .from(identityPetCollection)
    .innerJoin(items, eq(items.key, identityPetCollection.itemKey))
    .where(and(
      eq(identityPetCollection.ownerScope, ownerScope),
      eq(identityPetCollection.ownerId, ownerId),
    ))
    .orderBy(asc(identityPetCollection.slot));
  return rows.map((r) => ({ ...r, nickname: r.nickname ?? null }));
}

/**
 * Read the identity's showcased Library — Scriptorium copies the owner bought
 * and pinned (showcase_slot non-null), joined to the live story + author
 * byline. Ordered by slot. Empty when nothing is pinned (the section hides).
 */
async function listProfileLibrary(
  db: import("../../db/index.js").Db,
  ownerScope: "user" | "character",
  ownerId: string,
): Promise<ProfileLibraryEntry[]> {
  const rows = await db
    .select({
      slot: storyCopies.showcaseSlot,
      storyId: stories.id,
      slug: stories.slug,
      title: stories.title,
      coverImageUrl: stories.coverImageUrl,
      rating: stories.rating,
      authorCharacterId: stories.authorCharacterId,
      authorMasterUsername: users.username,
      authorCharacterName: characters.name,
    })
    .from(storyCopies)
    .innerJoin(stories, eq(stories.id, storyCopies.storyId))
    .innerJoin(users, eq(users.id, stories.authorUserId))
    .leftJoin(characters, eq(characters.id, stories.authorCharacterId))
    .where(and(
      eq(storyCopies.ownerScope, ownerScope),
      eq(storyCopies.ownerId, ownerId),
      isNotNull(storyCopies.showcaseSlot),
    ))
    .orderBy(asc(storyCopies.showcaseSlot));
  return rows.map((r) => {
    const masterName = r.authorMasterUsername ?? "(deleted user)";
    return {
      slot: r.slot ?? 0,
      storyId: r.storyId,
      slug: r.slug,
      title: r.title,
      coverImageUrl: r.coverImageUrl ?? null,
      rating: (r.rating ?? "PG") as StoryRating,
      authorMasterUsername: masterName,
      authorName: r.authorCharacterId ? (r.authorCharacterName ?? masterName) : masterName,
    };
  });
}

/**
 * Fetch the additional portrait gallery for a character, ordered by the
 * sortOrder column then created_at. Empty array when the character has no
 * extra portraits beyond their primary avatarUrl.
 */
async function listPortraits(
  db: import("../../db/index.js").Db,
  characterId: string,
): Promise<CharacterPortrait[]> {
  const rows = await db
    .select()
    .from(characterPortraits)
    .where(eq(characterPortraits.characterId, characterId))
    .orderBy(asc(characterPortraits.sortOrder), asc(characterPortraits.createdAt));
  return rows.map((r) => ({ id: r.id, url: r.url, label: r.label, nsfw: r.nsfw }));
}

/**
 * Twin of listPortraits but for the master/OOC profile gallery
 * (user_portraits table, added in migration 0113). Same wire shape
 *, the client renders both kinds with the same PortraitGallery
 * component, so the masters get gallery parity with characters
 * without a parallel rendering path.
 */
async function listMasterPortraits(
  db: import("../../db/index.js").Db,
  userId: string,
): Promise<CharacterPortrait[]> {
  const rows = await db
    .select()
    .from(userPortraits)
    .where(eq(userPortraits.userId, userId))
    .orderBy(asc(userPortraits.sortOrder), asc(userPortraits.createdAt));
  return rows.map((r) => ({ id: r.id, url: r.url, label: r.label, nsfw: r.nsfw }));
}

/**
 * Prepend the avatar to the portrait list as a synthetic gallery
 * entry when the owner ticked "Include in Gallery" on the avatar
 * field. We don't store this as a real portrait row, that would
 * dangle a stale copy of the URL whenever the user changes the
 * avatar later. Instead we synthesize one at read time with a
 * stable id ("avatar") so the renderer can deduplicate against
 * the same URL appearing as a real portrait too (a paranoid user
 * who added their avatar URL to the gallery manually + then
 * ticked the box). NSFW carries forward from the surrounding
 * profile, the synthetic tile inherits the profile-level NSFW
 * flag the same way the hero portrait already does.
 */
function maybePrependAvatarPortrait(
  portraits: CharacterPortrait[],
  avatarUrl: string | null,
  includeAvatarInGallery: boolean,
  profileIsNsfw: boolean,
): CharacterPortrait[] {
  if (!includeAvatarInGallery || !avatarUrl) return portraits;
  // Deduplicate: if the avatar URL already appears as a real
  // portrait row, skip the synthetic one rather than render the
  // same image twice.
  if (portraits.some((p) => p.url === avatarUrl)) return portraits;
  const synthetic: CharacterPortrait = {
    id: "avatar",
    url: avatarUrl,
    label: null,
    nsfw: profileIsNsfw,
  };
  return [synthetic, ...portraits];
}

/**
 * Fetch the owner-set links for a profile, ordered by sortOrder then created.
 *   - master/OOC profile: characterId IS NULL.
 *   - character profile : characterId = the given id.
 */
async function listLinks(
  db: import("../../db/index.js").Db,
  userId: string,
  characterId: string | null,
): Promise<ProfileLink[]> {
  const where = characterId === null
    ? and(eq(profileLinks.userId, userId), isNull(profileLinks.characterId))
    : and(eq(profileLinks.userId, userId), eq(profileLinks.characterId, characterId));
  const rows = await db
    .select()
    .from(profileLinks)
    .where(where)
    .orderBy(asc(profileLinks.sortOrder), asc(profileLinks.createdAt));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    borderColor: r.borderColor,
    bgColor: r.bgColor,
    textColor: r.textColor,
  }));
}

/**
 * Public journal entries for a character, oldest first (reads like a diary).
 * Private entries are deliberately filtered here - those only show in the
 * owner's editor view, never in lookupProfile responses.
 */
async function listPublicJournal(
  db: import("../../db/index.js").Db,
  characterId: string,
): Promise<CharacterJournalEntry[]> {
  const rows = await db
    .select()
    .from(characterJournalEntries)
    .where(and(
      eq(characterJournalEntries.characterId, characterId),
      eq(characterJournalEntries.privacy, "public"),
    ))
    .orderBy(asc(characterJournalEntries.createdAt));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    bodyHtml: r.bodyHtml,
    privacy: r.privacy as "public" | "private",
    createdAt: +r.createdAt,
    updatedAt: +r.updatedAt,
  }));
}

/**
 * Compute lifetime activity counters for a profile view. Scoping:
 *   - Master profile  → every message authored under the user account
 *     (every character + master OOC), so the count reflects "all the
 *     time you've spent here". `characterId` is null.
 *   - Character profile → only messages where `messages.characterId`
 *     matches that character's id.
 *
 * Three counters in a single query each (no joins per row):
 *   - chatMessages : kind in the chat-shaped set, in flat-mode rooms.
 *                    Excludes whispers (private, not a "look at me
 *                    posting" signal), system/announce/cmd (server
 *                    chrome, not the user's voice), and forum kinds
 *                    (covered separately below).
 *   - forumTopics  : the top-level post that opens a topic, `title`
 *                    is set AND `replyToId` is null (and we filter on
 *                    nested rooms so a stray legacy title on a flat
 *                    row doesn't inflate the count).
 *   - forumReplies : any non-deleted message with `replyToId` set in
 *                    a nested room. Replies to flat-room messages
 *                    (rare; quote-replies in flat chats) don't count.
 *
 * Soft-deleted messages are EXCLUDED so a moderation hide reduces the
 * counter, the user no longer "has" that post in any meaningful
 * sense. The author's hard counters survive their own re-publishes
 * since the message id is the row identity.
 */
async function computeProfileMetrics(
  db: import("../../db/index.js").Db,
  userId: string,
  characterId: string | null,
  /**
   * Authenticated viewer's user id, when available. Used to bypass
   * the privacy hide flags for the owner viewing their own profile,
   * otherwise a user who toggled nothing still saw "private" on their
   * own counts (the flags applied unconditionally on the server).
   * Anonymous viewers, admins, and any other user pass through the
   * normal hide-flag redaction.
   */
  viewerId?: string,
): Promise<ProfileMetrics> {
  // Privacy flags live on the user row regardless of which character
  // is being profiled, they're per-account preferences, not per
  // identity. One query, three booleans; defaults to "show" if the
  // row is somehow missing.
  const u = (await db
    .select({
      hideChatMessageCount: users.hideChatMessageCount,
      hideForumTopicCount: users.hideForumTopicCount,
      hideForumReplyCount: users.hideForumReplyCount,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0];
  // Owner self-view bypasses every hide flag, the owner is who SET
  // the flag in the first place; redacting their own readout would
  // give them no way to confirm what other users see vs hide their
  // numbers from themselves. (Admin tools surface the actual counts
  // through other channels regardless of this flag.)
  const isSelfView = viewerId !== undefined && viewerId === userId;
  const hideChat = isSelfView ? false : (u?.hideChatMessageCount ?? false);
  const hideTopics = isSelfView ? false : (u?.hideForumTopicCount ?? false);
  const hideReplies = isSelfView ? false : (u?.hideForumReplyCount ?? false);
  // Short-circuit each branch when its hide flag is set, saves the
  // COUNT(*) query and returns null directly. Useful both for the
  // tiny perf win and so a "private" metric can't accidentally leak
  // via a server log of the underlying SQL.

  // Read from the lifetime counter columns (migration 0176) instead
  // of COUNT(*) on `messages`. The old query decayed every time a row
  // was retention-purged, soft-deleted, or cascade-removed with its
  // room; the counter columns are bumped at insert time and never
  // decremented, so the displayed number stays a true lifetime stat.
  //
  // Scope: a master-account profile reads from `users.lifetime_*`
  // (which accumulates EVERY identity the user has posted under),
  // and a character profile reads from `characters.lifetime_*`
  // (per-character only).
  const counterRow = characterId === null
    ? (await db
        .select({
          chat: users.lifetimeChatMessages,
          topics: users.lifetimeForumTopics,
          replies: users.lifetimeForumReplies,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1))[0]
    : (await db
        .select({
          chat: characters.lifetimeChatMessages,
          topics: characters.lifetimeForumTopics,
          replies: characters.lifetimeForumReplies,
        })
        .from(characters)
        .where(eq(characters.id, characterId))
        .limit(1))[0];

  return {
    chatMessages: hideChat ? null : Number(counterRow?.chat ?? 0),
    forumTopics: hideTopics ? null : Number(counterRow?.topics ?? 0),
    forumReplies: hideReplies ? null : Number(counterRow?.replies ?? 0),
  };
}

/**
 * Resolve a master account's Scriptorium author tier. Counts the
 * user's PUBLISHED stories (publishedAt non-null) and maps to a
 * passive tier via the shared `resolveScriptoriumAuthorTier` helper.
 * Returns null for accounts that haven't published anything yet.
 *
 * Called from both the master + character profile builders, character
 * profiles inherit the same badge as their owner's master profile.
 */
async function computeScriptoriumAuthorBadge(
  db: import("../../db/index.js").Db,
  userId: string,
): Promise<import("@thekeep/shared").ScriptoriumAuthorBadge | null> {
  const row = (await db
    .select({ n: sql<number>`count(*)` })
    .from(stories)
    .where(and(
      eq(stories.authorUserId, userId),
      sql`${stories.publishedAt} IS NOT NULL`,
    )))[0];
  const publishedStories = Number(row?.n ?? 0);
  const tier = resolveScriptoriumAuthorTier(publishedStories);
  if (!tier) return null;
  return { tier, publishedStories };
}

/**
 * Build a ProfileView for an already-fetched master row. Used by the
 * token shortcut path in `lookupProfile` so a `@id:<userId>` query
 * skips name-disambiguation entirely. The legacy name-keyed master
 * branch in `lookupProfile` duplicates this logic inline, a future
 * cleanup pass can collapse the two; for now they stay parallel.
 */
async function buildMasterProfileView(
  db: import("../../db/index.js").Db,
  u: typeof users.$inferSelect,
  viewerId?: string,
): Promise<ProfileView> {
  const ns = await getEquippedNameStyle(db, "user", u.id);
  const portraits = maybePrependAvatarPortrait(
    await listMasterPortraits(db, u.id),
    u.avatarUrl,
    u.includeAvatarInGallery,
    u.isNsfw,
  );
  const theme = await parseUserThemeJson(db, u.themeJson);
  const styleKey = await resolveProfileStyleKey(db, theme, null, u.styleKey);
  return {
    kind: "master",
    profile: {
      userId: u.id,
      username: u.username,
      bioHtml: u.bioHtml,
      avatarUrl: u.avatarUrl,
      avatarCrop: {
        zoom: u.avatarZoom,
        offsetX: u.avatarOffsetX,
        offsetY: u.avatarOffsetY,
      },
      portraits,
      gender: u.gender,
      theme,
      styleKey,
      titles: await listTitlesForIdentity(db, { userId: u.id, characterId: null, displayName: u.username }),
      links: await listLinks(db, u.id, null),
      role: u.role,
      isPublic: u.isPublic,
      isNsfw: u.isNsfw,
      createdAt: +u.createdAt,
      metrics: await computeProfileMetrics(db, u.id, null, viewerId),
      scriptoriumAuthor: await computeScriptoriumAuthorBadge(db, u.id),
      collection: await listProfileCollection(db, "user", u.id),
      petCollection: await listProfilePetCollection(db, "user", u.id),
      library: await listProfileLibrary(db, "user", u.id),
      nameStyleKey: ns.key,
      nameStyleConfig: ns.config,
      profileBannerUrl: await getEquippedProfileBannerUrl(db, "user", u.id),
      publicProfileBgUrl: u.publicProfileBgUrl,
      publicProfileBgMode: u.publicProfileBgMode as "cover" | "contain" | "tile" | "stretch",
    },
  };
}

/**
 * Build a ProfileView for an already-fetched character row + owner.
 * Parallel to `buildMasterProfileView`. Used by the `@cid:<id>` token
 * shortcut path.
 */
async function buildCharacterProfileView(
  db: import("../../db/index.js").Db,
  c: typeof characters.$inferSelect,
  owner: typeof users.$inferSelect,
  viewerId?: string,
): Promise<ProfileView> {
  const theme = await parseUserThemeJson(db, c.themeJson ?? owner.themeJson);
  const styleKey = await resolveProfileStyleKey(db, theme, c.styleKey, owner.styleKey);
  const showOwner = await viewerIsModerator(db, viewerId);
  const ns = await getEquippedNameStyle(db, "character", c.id);
  const charPortraits = maybePrependAvatarPortrait(
    await listPortraits(db, c.id),
    c.avatarUrl,
    c.includeAvatarInGallery,
    c.isNsfw,
  );
  return {
    kind: "character",
    profile: {
      id: c.id,
      userId: c.userId,
      name: c.name,
      bioHtml: c.bioHtml,
      stats: parseStats(c.statsJson),
      avatarUrl: c.avatarUrl,
      avatarCrop: {
        zoom: c.avatarZoom,
        offsetX: c.avatarOffsetX,
        offsetY: c.avatarOffsetY,
      },
      portraits: charPortraits,
      links: await listLinks(db, c.userId, c.id),
      journalEntries: await listPublicJournal(db, c.id),
      theme,
      styleKey,
      titles: await listTitlesForIdentity(db, { userId: c.userId, characterId: c.id, displayName: c.name }),
      isPublic: c.isPublic,
      isNsfw: c.isNsfw,
      createdAt: +c.createdAt,
      updatedAt: +c.updatedAt,
      metrics: await computeProfileMetrics(db, c.userId, c.id, viewerId),
      scriptoriumAuthor: await computeScriptoriumAuthorBadge(db, c.userId),
      collection: await listProfileCollection(db, "character", c.id),
      petCollection: await listProfilePetCollection(db, "character", c.id),
      library: await listProfileLibrary(db, "character", c.id),
      nameStyleKey: ns.key,
      nameStyleConfig: ns.config,
      profileBannerUrl: await getEquippedProfileBannerUrl(db, "character", c.id),
      publicProfileBgUrl: c.publicProfileBgUrl,
      publicProfileBgMode: c.publicProfileBgMode as "cover" | "contain" | "tile" | "stretch",
      ...(showOwner ? { ownerUsername: owner.username } : {}),
    },
  };
}

/**
 * lookupProfile + global-block gate. A blocked user's profile is invisible
 * (mutual), so any viewer who is blocked with the resolved profile's owner
 * gets `null` (not found), exactly as if the name didn't resolve. Centralizing
 * the gate here covers every caller, the HTTP /profiles/:name route, the
 * userlist click-to-view handler, and the /whois command, so none can leak a
 * blocked identity. Anonymous viewers (no `viewerId`) can't have blocks, so
 * they skip the check.
 */
export async function lookupProfile(
  db: import("../../db/index.js").Db,
  name: string,
  viewerId?: string,
): Promise<ProfileView | null> {
  const view = await resolveProfileView(db, name, viewerId);
  if (view && viewerId && view.profile.userId !== viewerId
      && await isBlockedBetween(db, viewerId, view.profile.userId)) {
    return null;
  }
  return view;
}

/**
 * Resolve a name (master username OR character name) or an identity
 * token (`@id:<userId>` / `@cid:<characterId>`) to a ProfileView.
 * Used by /whois, the HTTP profile endpoint, and the click-to-view
 * flow on the userlist.
 *
 * Tokens shortcut the name-resolution path entirely so the
 * "/whois @cid:abc" caller gets back exactly that character, not
 * some other identity that happens to share its display name. Bare
 * names take the legacy NBSP-variant flow.
 */
async function resolveProfileView(
  db: import("../../db/index.js").Db,
  name: string,
  /** Authenticated viewer id, when available. Threaded through to
   *  metrics computation so the owner self-viewing sees their real
   *  counts even when their hide flags are on. */
  viewerId?: string,
): Promise<ProfileView | null> {
  // Token shortcut. We hand-roll the parse here (rather than importing
  // identityArg) to avoid a circular-import risk between profile.ts
  // and identityArg.ts during bootstrap, the token format is two
  // string-prefix checks, cheap to inline.
  if (name.startsWith("@id:")) {
    const userId = name.slice(4).trim();
    if (userId && !/\s/.test(userId)) {
      const u = (await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1))[0];
      if (u && !u.disabledAt) return buildMasterProfileView(db, u, viewerId);
    }
    return null;
  }
  if (name.startsWith("@cid:")) {
    const charId = name.slice(5).trim();
    if (charId && !/\s/.test(charId)) {
      const c = (await db
        .select()
        .from(characters)
        .where(eq(characters.id, charId))
        .limit(1))[0];
      if (c && !c.deletedAt) {
        const owner = (await db.select().from(users).where(eq(users.id, c.userId)).limit(1))[0];
        if (owner && !owner.disabledAt) {
          return buildCharacterProfileView(db, c, owner, viewerId);
        }
      }
    }
    return null;
  }
  /**
   * Build the set of name variants to try.
   *
   * Master usernames allow NBSP (U+00A0) as an invisible "fake space"
   * separator. Shareable URLs present those NBSPs as regular spaces
   * for readability, so callers coming from a URL hand us a regular-
   * space form, while callers coming from chat (clicking a sender
   * name) hand us the canonical NBSP form. AND character names can
   * legally contain regular spaces ("Some Char") that should NOT be
   * NBSP-substituted, those rows store the regular space in the DB.
   *
   * Earlier the URL/chat callers pre-substituted via slugToUsername
   * before calling lookupProfile, which broke character lookups: a
   * click on "Some Char" became "Some[NBSP]Char" before the query
   * and missed the real character row.
   *
   * The robust fix: try every plausible form against both tables.
   * Three variants cover every caller:
   *   - the input as given
   *   - regular-space → NBSP (for masters arriving via slug)
   *   - NBSP → regular-space (for characters arriving with the
   *     master-style normalization already applied)
   * Deduped via Set so identical forms collapse.
   */
  const variants = Array.from(new Set([
    name,
    name.replace(/ /g, " "),
    name.replace(/ /g, " "),
  ])).map((v) => v.toLowerCase());

  // Master username takes precedence - it's globally unique, while character
  // names are only unique per-owner, so collisions between a master "Kaal"
  // and someone else's character "Kaal" resolve to the master.
  //
  // We deliberately return the master profile here even if the user has an
  // active character: /whois WAS should show WAS's master profile, not their
  // current character's. To view a specific character, use its name (e.g.
  // /whois Kaal) - looked up below.
  const u = (await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) IN (${sql.join(variants.map((v) => sql`${v}`), sql`, `)})`)
    .limit(1))[0];
  if (u && !u.disabledAt) {
    const ns = await getEquippedNameStyle(db, "user", u.id);
    const portraits = maybePrependAvatarPortrait(
      await listMasterPortraits(db, u.id),
      u.avatarUrl,
      u.includeAvatarInGallery,
      u.isNsfw,
    );
    const theme = await parseUserThemeJson(db, u.themeJson);
    const styleKey = await resolveProfileStyleKey(db, theme, null, u.styleKey);
    return {
      kind: "master",
      profile: {
        userId: u.id,
        username: u.username,
        bioHtml: u.bioHtml,
        avatarUrl: u.avatarUrl,
        avatarCrop: {
          zoom: u.avatarZoom,
          offsetX: u.avatarOffsetX,
          offsetY: u.avatarOffsetY,
        },
        portraits,
        gender: u.gender,
        theme,
        styleKey,
        titles: await listTitlesForIdentity(db, { userId: u.id, characterId: null, displayName: u.username }),
        links: await listLinks(db, u.id, null),
        role: u.role,
        isPublic: u.isPublic,
        isNsfw: u.isNsfw,
        createdAt: +u.createdAt,
        metrics: await computeProfileMetrics(db, u.id, null, viewerId),
        scriptoriumAuthor: await computeScriptoriumAuthorBadge(db, u.id),
        collection: await listProfileCollection(db, "user", u.id),
        petCollection: await listProfilePetCollection(db, "user", u.id),
        library: await listProfileLibrary(db, "user", u.id),
        nameStyleKey: ns.key,
        nameStyleConfig: ns.config,
        profileBannerUrl: await getEquippedProfileBannerUrl(db, "user", u.id),
        publicProfileBgUrl: u.publicProfileBgUrl,
        publicProfileBgMode: u.publicProfileBgMode as "cover" | "contain" | "tile" | "stretch",
      },
    };
  }

  // Character lookup - by name, regardless of whether the owner is currently
  // switched to it. Soft-deleted characters and characters whose owner is
  // disabled are filtered out (the data still exists for message history but
  // shouldn't surface in profile lookups). Uses the same name variants the
  // master lookup did so a name that arrived NBSP-substituted (because the
  // caller pre-ran slugToUsername for the master case) still resolves the
  // character row that stores the regular-space form.
  const c = (await db
    .select()
    .from(characters)
    .where(sql`lower(${characters.name}) IN (${sql.join(variants.map((v) => sql`${v}`), sql`, `)})`)
    .limit(1))[0];
  if (!c || c.deletedAt) return null;

  const owner = (await db.select().from(users).where(eq(users.id, c.userId)).limit(1))[0];
  if (!owner || owner.disabledAt) return null;

  const theme = await parseUserThemeJson(db, c.themeJson ?? owner.themeJson);
  const styleKey = await resolveProfileStyleKey(db, theme, c.styleKey, owner.styleKey);
  // Mod-only OOC owner badge. The character row already exposes
  // `userId` on the wire (so the master is technically discoverable
  // by chained API calls), but mods on the modal need the friendly
  // username inline, this query is the one that resolves it.
  const showOwner = await viewerIsModerator(db, viewerId);
  const ns = await getEquippedNameStyle(db, "character", c.id);
  const charPortraits = maybePrependAvatarPortrait(
    await listPortraits(db, c.id),
    c.avatarUrl,
    c.includeAvatarInGallery,
    c.isNsfw,
  );
  return {
    kind: "character",
    profile: {
      id: c.id,
      userId: c.userId,
      name: c.name,
      bioHtml: c.bioHtml,
      stats: parseStats(c.statsJson),
      avatarUrl: c.avatarUrl,
      avatarCrop: {
        zoom: c.avatarZoom,
        offsetX: c.avatarOffsetX,
        offsetY: c.avatarOffsetY,
      },
      portraits: charPortraits,
      links: await listLinks(db, c.userId, c.id),
      journalEntries: await listPublicJournal(db, c.id),
      theme,
      styleKey,
      titles: await listTitlesForIdentity(db, { userId: c.userId, characterId: c.id, displayName: c.name }),
      isPublic: c.isPublic,
      isNsfw: c.isNsfw,
      createdAt: +c.createdAt,
      updatedAt: +c.updatedAt,
      metrics: await computeProfileMetrics(db, c.userId, c.id, viewerId),
      scriptoriumAuthor: await computeScriptoriumAuthorBadge(db, c.userId),
      collection: await listProfileCollection(db, "character", c.id),
      petCollection: await listProfilePetCollection(db, "character", c.id),
      library: await listProfileLibrary(db, "character", c.id),
      nameStyleKey: ns.key,
      nameStyleConfig: ns.config,
      profileBannerUrl: await getEquippedProfileBannerUrl(db, "character", c.id),
      publicProfileBgUrl: c.publicProfileBgUrl,
      publicProfileBgMode: c.publicProfileBgMode as "cover" | "contain" | "tile" | "stretch",
      ...(showOwner ? { ownerUsername: owner.username } : {}),
    },
  };
}

/**
 * Pick a uniformly-random profile from the union of (active master accounts) and
 * (non-deleted characters whose owner is active). We count both pools, draw an
 * index across the combined total, and OFFSET into whichever pool the index
 * lands in - so every visible profile has equal probability regardless of how
 * lopsided the user/character ratio is.
 */
async function lookupRandomProfile(
  db: import("../../db/index.js").Db,
  viewerId?: string,
): Promise<ProfileView | null> {
  // Random discovery deliberately filters out non-public and NSFW profiles:
  // non-public means the owner explicitly opted out of the open index, and
  // NSFW is too jarring to surface without explicit intent. Use /whois <name>
  // to bypass these filters when you know who you're looking for.
  const masterCountRow = (await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(and(isNull(users.disabledAt), eq(users.isPublic, true), eq(users.isNsfw, false))))[0];
  const masterCount = masterCountRow?.n ?? 0;

  const charCountRow = (await db
    .select({ n: sql<number>`count(*)` })
    .from(characters)
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(
      isNull(characters.deletedAt),
      isNull(users.disabledAt),
      eq(characters.isPublic, true),
      eq(characters.isNsfw, false),
    )))[0];
  const charCount = charCountRow?.n ?? 0;

  const total = masterCount + charCount;
  if (total === 0) return null;

  const idx = Math.floor(Math.random() * total);
  if (idx < masterCount) {
    const u = (await db
      .select()
      .from(users)
      .where(and(isNull(users.disabledAt), eq(users.isPublic, true), eq(users.isNsfw, false)))
      .orderBy(users.id)
      .limit(1)
      .offset(idx))[0];
    if (!u) return null;
    const ns = await getEquippedNameStyle(db, "user", u.id);
    const portraits = maybePrependAvatarPortrait(
      await listMasterPortraits(db, u.id),
      u.avatarUrl,
      u.includeAvatarInGallery,
      u.isNsfw,
    );
    const theme = await parseUserThemeJson(db, u.themeJson);
    const styleKey = await resolveProfileStyleKey(db, theme, null, u.styleKey);
    return {
      kind: "master",
      profile: {
        userId: u.id,
        username: u.username,
        bioHtml: u.bioHtml,
        avatarUrl: u.avatarUrl,
        avatarCrop: {
          zoom: u.avatarZoom,
          offsetX: u.avatarOffsetX,
          offsetY: u.avatarOffsetY,
        },
        portraits,
        gender: u.gender,
        theme,
        styleKey,
        titles: await listTitlesForIdentity(db, { userId: u.id, characterId: null, displayName: u.username }),
        links: await listLinks(db, u.id, null),
        role: u.role,
        isPublic: u.isPublic,
        isNsfw: u.isNsfw,
        createdAt: +u.createdAt,
        metrics: await computeProfileMetrics(db, u.id, null),
        scriptoriumAuthor: await computeScriptoriumAuthorBadge(db, u.id),
        collection: await listProfileCollection(db, "user", u.id),
        petCollection: await listProfilePetCollection(db, "user", u.id),
        library: await listProfileLibrary(db, "user", u.id),
        nameStyleKey: ns.key,
        nameStyleConfig: ns.config,
        profileBannerUrl: await getEquippedProfileBannerUrl(db, "user", u.id),
        publicProfileBgUrl: u.publicProfileBgUrl,
        publicProfileBgMode: u.publicProfileBgMode as "cover" | "contain" | "tile" | "stretch",
      },
    };
  }

  const row = (await db
    .select({ char: characters, ownerThemeJson: users.themeJson, ownerStyleKey: users.styleKey, ownerUsername: users.username })
    .from(characters)
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(
      isNull(characters.deletedAt),
      isNull(users.disabledAt),
      eq(characters.isPublic, true),
      eq(characters.isNsfw, false),
    ))
    .orderBy(characters.id)
    .limit(1)
    .offset(idx - masterCount))[0];
  if (!row) return null;
  const c = row.char;
  const showOwner = await viewerIsModerator(db, viewerId);
  const ns = await getEquippedNameStyle(db, "character", c.id);
  const portraits = maybePrependAvatarPortrait(
    await listPortraits(db, c.id),
    c.avatarUrl,
    c.includeAvatarInGallery,
    c.isNsfw,
  );
  const theme = await parseUserThemeJson(db, c.themeJson ?? row.ownerThemeJson);
  const styleKey = await resolveProfileStyleKey(db, theme, c.styleKey, row.ownerStyleKey);
  return {
    kind: "character",
    profile: {
      id: c.id,
      userId: c.userId,
      name: c.name,
      bioHtml: c.bioHtml,
      stats: parseStats(c.statsJson),
      avatarUrl: c.avatarUrl,
      avatarCrop: {
        zoom: c.avatarZoom,
        offsetX: c.avatarOffsetX,
        offsetY: c.avatarOffsetY,
      },
      portraits,
      links: await listLinks(db, c.userId, c.id),
      journalEntries: await listPublicJournal(db, c.id),
      theme,
      styleKey,
      titles: await listTitlesForIdentity(db, { userId: c.userId, characterId: c.id, displayName: c.name }),
      isPublic: c.isPublic,
      isNsfw: c.isNsfw,
      createdAt: +c.createdAt,
      updatedAt: +c.updatedAt,
      metrics: await computeProfileMetrics(db, c.userId, c.id),
      scriptoriumAuthor: await computeScriptoriumAuthorBadge(db, c.userId),
      collection: await listProfileCollection(db, "character", c.id),
      petCollection: await listProfilePetCollection(db, "character", c.id),
      library: await listProfileLibrary(db, "character", c.id),
      nameStyleKey: ns.key,
      nameStyleConfig: ns.config,
      profileBannerUrl: await getEquippedProfileBannerUrl(db, "character", c.id),
      publicProfileBgUrl: c.publicProfileBgUrl,
      publicProfileBgMode: c.publicProfileBgMode as "cover" | "contain" | "tile" | "stretch",
      ...(showOwner ? { ownerUsername: row.ownerUsername } : {}),
    },
  };
}

function parseStats(json: string): CharacterStats {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object") return parsed as CharacterStats;
  } catch { /* fall through */ }
  return {};
}

/**
 * /profile - opens YOUR editor for the active identity.
 *   - If you have an active character, edits that character.
 *   - Otherwise, edits your master profile.
 *
 * Args are rejected: viewing other users uses /whois.
 */
export const profileCommand: CommandHandler = {
  name: "profile",
  aliases: ["editprofile", "myprofile"],
  usage: "/profile",
  description: "Open the editor for your active profile (master or current character).",
  run(ctx) {
    if (ctx.argsText.trim()) {
      ctx.socket.emit("error:notice", {
        code: "NO_ARGS",
        message: "/profile takes no arguments. Use /whois <name> to view someone else.",
      });
      return;
    }
    if (ctx.user.activeCharacterId) {
      ctx.socket.emit("ui:hint", {
        kind: "open-my-editor",
        mode: "character",
        characterId: ctx.user.activeCharacterId,
      });
    } else {
      ctx.socket.emit("ui:hint", {
        kind: "open-my-editor",
        mode: "master",
        characterId: null,
      });
    }
  },
};

/**
 * /whois [name] - view a user's active profile (master fallback).
 * With no name, picks a random profile (any master or character) - a quick way
 * to stumble across someone's bio.
 * Aliases: /who (phpMyChat shorthand), /viewprofile.
 */
export const whoisCommand: CommandHandler = {
  name: "whois",
  aliases: ["who", "viewprofile"],
  usage: "/whois [username]",
  description:
    "View someone's profile (their active character, or master if none). With no name, opens a random profile.",
  subcommands: [
    {
      verb: "<name>",
      usage: "/whois <name>",
      description: "View this user's profile. Master usernames win over character names if both exist.",
    },
    {
      verb: "(no args)",
      usage: "/whois",
      description: "Open a uniformly-random profile from all active masters and characters.",
    },
  ],
  async run(ctx) {
    const target = ctx.argsText.trim();
    if (!target) {
      const view = await lookupRandomProfile(ctx.db);
      if (!view) {
        ctx.socket.emit("error:notice", {
          code: "NO_PROFILES",
          message: "No profiles found.",
        });
        return;
      }
      ctx.socket.emit("ui:hint", { kind: "open-profile", profile: view });
      return;
    }
    // Token shortcut. Pass directly to lookupProfile so the response
    // matches exactly what the caller asked for (no master-takes-
    // precedence fall-through that would skip past the requested
    // character).
    if (target.startsWith("@id:") || target.startsWith("@cid:")) {
      const view = await lookupProfile(ctx.db, target, ctx.user.id);
      if (!view) {
        ctx.socket.emit("error:notice", {
          code: "NO_USER",
          message: `No identity matches "${target}".`,
        });
        return;
      }
      ctx.socket.emit("ui:hint", { kind: "open-profile", profile: view });
      return;
    }
    // Bare-name path: run the disambiguating resolver first so
    // multi-match names get a friendly tokens-to-paste notice
    // instead of silently snapping to the first hit.
    const resolution = await resolveIdentityArg(ctx.db, target);
    if (resolution.kind === "none") {
      ctx.socket.emit("error:notice", {
        code: "NO_USER",
        message: `No user or character named "${target}".`,
      });
      return;
    }
    if (resolution.kind === "ambiguous") {
      emitAmbiguousIdentityModal(ctx, target, resolution.matches);
      return;
    }
    // Unique: fetch the profile through the same id-keyed path the
    // token shortcut uses so the view matches the resolved identity
    // exactly (no master-precedence quirk).
    const tokenName = resolution.target.characterId
      ? `@cid:${resolution.target.characterId}`
      : `@id:${resolution.target.userId}`;
    const view = await lookupProfile(ctx.db, tokenName, ctx.user.id);
    if (!view) {
      ctx.socket.emit("error:notice", {
        code: "NO_USER",
        message: `No user or active character named "${target}".`,
      });
      return;
    }
    ctx.socket.emit("ui:hint", { kind: "open-profile", profile: view });
  },
};
