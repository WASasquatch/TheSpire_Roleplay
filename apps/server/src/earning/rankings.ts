/**
 * Earning rankings engine.
 *
 * Aggregates per-pool metrics into the nine leaderboard "boards"
 * surfaced by the dashboard's Rankings tab. Per the user-confirmed
 * scope: each pool (master + each character) is a separate ranking
 * entry, a user with three characters can show up four times on a
 * board, once per active identity.
 *
 * Boards:
 *   currency  | XP        | rank       | items
 *   messages  | borders   | styles     | topics       | reactions
 *
 * Each board returns up to TOP_N rows, sorted by metric value
 * descending. The endpoint also returns a `champions` list, the
 * #1 entry from each board, which the client uses for the
 * rotating "Spotlight" carousel at the top of the tab.
 *
 * Privacy gates:
 *   hideCurrencyCount → excluded from the currency board
 *   hideXpCount       → excluded from the XP board
 *   users.isPublic=false → excluded from EVERY board (a user who
 *     hides their master profile shouldn't have their wealth
 *     leak via leaderboard)
 *   users.disabledAt is not null → excluded everywhere
 *
 * Performance posture: one query per board (nine total), each
 * bounded to TOP_N. After the boards land, one batched fetch
 * resolves display info (name-style / border / config / rank tier
 * lookups) for the union of pools referenced. Acceptable cost
 * given the dashboard is opened a few times per session at most.
 */

import { and, asc, desc, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  characterEarning,
  characterOwnedBorders,
  characterOwnedFreeformBorders,
  characterOwnedNameStyles,
  characters,
  identityInventory,
  messages,
  messageReactions,
  rankTiers,
  ranks,
  userActiveCosmetics,
  userEarning,
  userOwnedBorders,
  userOwnedFreeformBorders,
  userOwnedNameStyles,
  users,
} from "../db/schema.js";

/** Top N rows per board. 10 fits in a comfortable scroll without
 *  paging, anything more pushes the tab into virtual-list territory. */
const TOP_N = 10;

export type RankingScope = "user" | "character";

export interface RankingPoolEntry {
  scope: RankingScope;
  /** Pool owner id, userId when scope='user', characterId when 'character'. */
  ownerId: string;
  /** Master user id. Same as ownerId for master rows; the character
   *  pool's owning user for character rows. Drives profile-modal
   *  opens regardless of identity scope. */
  userId: string;
  characterId: string | null;
  displayName: string;
  avatarUrl: string | null;
  /** Rank cosmetic context, for the avatar frame + the rank chip
   *  the card renders below the name. Nulls when unranked. */
  borderRankKey: string | null;
  freeformBorderKey: string | null;
  freeformBorderConfigJson: string | null;
  activeNameStyleKey: string | null;
  nameStyleConfigJson: string | null;
  rankKey: string | null;
  tier: number | null;
  rankName: string | null;
  tierLabel: string | null;
  sigilImageUrl: string | null;
  /** The metric value for the board this entry was returned on. */
  value: number;
}

export type RankingBoardKey =
  | "currency"
  | "xp"
  | "rank"
  | "items"
  | "messages"
  | "borders"
  | "styles"
  | "topics"
  | "reactions";

export interface RankingBoard {
  key: RankingBoardKey;
  label: string;
  metric: string;
  entries: RankingPoolEntry[];
}

export interface RankingChampion {
  boardKey: RankingBoardKey;
  boardLabel: string;
  boardMetric: string;
  entry: RankingPoolEntry;
}

export interface RankingsResponse {
  boards: RankingBoard[];
  champions: RankingChampion[];
  /** Server-side timestamp the rankings were computed. Client may
   *  display "as of X". */
  generatedAt: number;
}

const BOARD_LABELS: Record<RankingBoardKey, { label: string; metric: string }> = {
  currency:  { label: "Wealthiest",     metric: "Currency" },
  xp:        { label: "Most XP",        metric: "XP" },
  rank:      { label: "Highest Rank",   metric: "Rank" },
  items:     { label: "Most Items",     metric: "Items" },
  messages:  { label: "Most Talkative", metric: "Messages" },
  borders:   { label: "Most Borders",   metric: "Borders" },
  styles:    { label: "Most Styles",    metric: "Styles" },
  topics:    { label: "Forum Founders", metric: "Topics" },
  reactions: { label: "Reactor",        metric: "Reactions" },
};

/** Internal shape, a board entry before the display-info join. */
interface RawEntry {
  scope: RankingScope;
  ownerId: string;
  value: number;
}

/**
 * Build the full rankings response, runs all nine board queries,
 * collects the union of referenced pools, resolves display info in
 * one batched fetch, and stitches the boards + champions list.
 */
export async function buildRankings(db: Db): Promise<RankingsResponse> {
  const [
    currencyRaw,
    xpRaw,
    rankRaw,
    itemsRaw,
    messagesRaw,
    bordersRaw,
    stylesRaw,
    topicsRaw,
    reactionsRaw,
  ] = await Promise.all([
    queryCurrencyBoard(db),
    queryXpBoard(db),
    queryRankBoard(db),
    queryItemsBoard(db),
    queryMessagesBoard(db),
    queryBordersBoard(db),
    queryStylesBoard(db),
    queryTopicsBoard(db),
    queryReactionsBoard(db),
  ]);

  // Union of (scope, ownerId) referenced across all boards. The
  // display-info batch only fetches what's actually surfaced.
  const referenced = new Map<string, { scope: RankingScope; ownerId: string }>();
  const collect = (raws: RawEntry[]) => {
    for (const r of raws) {
      referenced.set(`${r.scope}::${r.ownerId}`, { scope: r.scope, ownerId: r.ownerId });
    }
  };
  collect(currencyRaw); collect(xpRaw); collect(rankRaw); collect(itemsRaw);
  collect(messagesRaw); collect(bordersRaw); collect(stylesRaw);
  collect(topicsRaw); collect(reactionsRaw);

  const displayInfo = await fetchDisplayInfo(db, [...referenced.values()]);

  function stitch(raws: RawEntry[]): RankingPoolEntry[] {
    const out: RankingPoolEntry[] = [];
    for (const r of raws) {
      const info = displayInfo.get(`${r.scope}::${r.ownerId}`);
      // Drop rows whose pool was filtered out at the display-info
      // step (disabled user, private master, deleted character).
      if (!info) continue;
      out.push({ ...info, value: r.value });
    }
    return out;
  }

  const boards: RankingBoard[] = [
    { key: "currency",  ...BOARD_LABELS.currency,  entries: stitch(currencyRaw) },
    { key: "xp",        ...BOARD_LABELS.xp,        entries: stitch(xpRaw) },
    { key: "rank",      ...BOARD_LABELS.rank,      entries: stitch(rankRaw) },
    { key: "items",     ...BOARD_LABELS.items,     entries: stitch(itemsRaw) },
    { key: "messages",  ...BOARD_LABELS.messages,  entries: stitch(messagesRaw) },
    { key: "borders",   ...BOARD_LABELS.borders,   entries: stitch(bordersRaw) },
    { key: "styles",    ...BOARD_LABELS.styles,    entries: stitch(stylesRaw) },
    { key: "topics",    ...BOARD_LABELS.topics,    entries: stitch(topicsRaw) },
    { key: "reactions", ...BOARD_LABELS.reactions, entries: stitch(reactionsRaw) },
  ];

  // Champion = the top entry of each non-empty board. The carousel
  // rotates through these so every board gets a spotlight even
  // when its own card sits below the fold.
  const champions: RankingChampion[] = [];
  for (const b of boards) {
    const top = b.entries[0];
    if (!top) continue;
    champions.push({
      boardKey: b.key,
      boardLabel: b.label,
      boardMetric: b.metric,
      entry: top,
    });
  }

  return { boards, champions, generatedAt: Date.now() };
}

/* =========================================================
 *  Per-board queries.
 *
 *  Each returns a top-TOP_N RawEntry[] for the board's metric.
 *  Privacy filters live inside each query so an aggregation can
 *  push them down past LIMIT, otherwise we'd over-fetch then
 *  prune and risk returning fewer than TOP_N rows after the prune.
 * ========================================================= */

/** Common privacy gate, joinable into the user lookup so disabled
 *  / private master accounts drop before the LIMIT applies. */
function publicUserFilter() {
  return and(isNull(users.disabledAt), eq(users.isPublic, true));
}

async function queryCurrencyBoard(db: Db): Promise<RawEntry[]> {
  // Master rows that haven't opted out + every character whose
  // master is eligible. Character rows inherit their owner's
  // privacy posture (privacy carries across identities of the
  // same account).
  const masterRows = await db
    .select({ ownerId: userEarning.userId, value: userEarning.currency })
    .from(userEarning)
    .innerJoin(users, eq(users.id, userEarning.userId))
    .where(and(publicUserFilter(), eq(userEarning.hideCurrencyCount, false)))
    .orderBy(desc(userEarning.currency))
    .limit(TOP_N);
  const charRows = await db
    .select({ ownerId: characterEarning.characterId, value: characterEarning.currency })
    .from(characterEarning)
    .innerJoin(characters, eq(characters.id, characterEarning.characterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(publicUserFilter(), isNull(characters.deletedAt), eq(userEarning.hideCurrencyCount, false)))
    .leftJoin(userEarning, eq(userEarning.userId, characters.userId))
    .orderBy(desc(characterEarning.currency))
    .limit(TOP_N);
  return mergeTop(
    masterRows.map((r) => ({ scope: "user" as const, ownerId: r.ownerId, value: r.value })),
    charRows.map((r) => ({ scope: "character" as const, ownerId: r.ownerId, value: r.value })),
  );
}

async function queryXpBoard(db: Db): Promise<RawEntry[]> {
  const masterRows = await db
    .select({ ownerId: userEarning.userId, value: userEarning.xp })
    .from(userEarning)
    .innerJoin(users, eq(users.id, userEarning.userId))
    .where(and(publicUserFilter(), eq(userEarning.hideXpCount, false)))
    .orderBy(desc(userEarning.xp))
    .limit(TOP_N);
  const charRows = await db
    .select({ ownerId: characterEarning.characterId, value: characterEarning.xp })
    .from(characterEarning)
    .innerJoin(characters, eq(characters.id, characterEarning.characterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .leftJoin(userEarning, eq(userEarning.userId, characters.userId))
    .where(and(publicUserFilter(), isNull(characters.deletedAt), eq(userEarning.hideXpCount, false)))
    .orderBy(desc(characterEarning.xp))
    .limit(TOP_N);
  return mergeTop(
    masterRows.map((r) => ({ scope: "user" as const, ownerId: r.ownerId, value: r.value })),
    charRows.map((r) => ({ scope: "character" as const, ownerId: r.ownerId, value: r.value })),
  );
}

async function queryRankBoard(db: Db): Promise<RawEntry[]> {
  // "Highest rank" = highest (rank.order, tier) lexicographic.
  // Encode as a sortable numeric: order * 100 + tier. Tier caps
  // around 6 in practice so collisions can't happen until
  // order = 1000+ ranks (we have 6). Privacy: same gate as XP.
  const masterRows = await db
    .select({
      ownerId: userEarning.userId,
      rankKey: userEarning.rankKey,
      tier: userEarning.tier,
      orderVal: ranks.order,
    })
    .from(userEarning)
    .innerJoin(users, eq(users.id, userEarning.userId))
    .leftJoin(ranks, eq(ranks.key, userEarning.rankKey))
    .where(and(publicUserFilter(), eq(userEarning.hideXpCount, false), isNotNull(userEarning.rankKey)))
    .orderBy(desc(ranks.order), desc(userEarning.tier))
    .limit(TOP_N);
  const charRows = await db
    .select({
      ownerId: characterEarning.characterId,
      rankKey: characterEarning.rankKey,
      tier: characterEarning.tier,
      orderVal: ranks.order,
    })
    .from(characterEarning)
    .innerJoin(characters, eq(characters.id, characterEarning.characterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .leftJoin(userEarning, eq(userEarning.userId, characters.userId))
    .leftJoin(ranks, eq(ranks.key, characterEarning.rankKey))
    .where(and(publicUserFilter(), isNull(characters.deletedAt), eq(userEarning.hideXpCount, false), isNotNull(characterEarning.rankKey)))
    .orderBy(desc(ranks.order), desc(characterEarning.tier))
    .limit(TOP_N);
  function encode(orderVal: number | null, tier: number | null): number {
    return (orderVal ?? 0) * 100 + (tier ?? 0);
  }
  return mergeTop(
    masterRows.map((r) => ({ scope: "user" as const, ownerId: r.ownerId, value: encode(r.orderVal, r.tier) })),
    charRows.map((r) => ({ scope: "character" as const, ownerId: r.ownerId, value: encode(r.orderVal, r.tier) })),
  );
}

async function queryItemsBoard(db: Db): Promise<RawEntry[]> {
  // SUM of `quantity` per pool, ignoring item type / stack semantics.
  // The user said "most items", a single 100-stack of bread counts
  // the same as 100 unique items. Simpler + matches the player's
  // mental model of "how full is my inventory".
  const rows = await db
    .select({
      scope: identityInventory.ownerScope,
      ownerId: identityInventory.ownerId,
      value: sql<number>`COALESCE(SUM(${identityInventory.quantity}), 0)`,
    })
    .from(identityInventory)
    // Privacy gate via JOIN: master rows resolve through users
    // directly; character rows must resolve to a non-disabled
    // public-master account. Done in JS post-fetch since drizzle
    // doesn't have a clean polymorphic-fk join helper.
    .groupBy(identityInventory.ownerScope, identityInventory.ownerId)
    .orderBy(desc(sql`COALESCE(SUM(${identityInventory.quantity}), 0)`))
    .limit(TOP_N * 3);
  // Post-filter for privacy: drop entries whose owning master is
  // disabled / private. We over-fetch by 3× to ensure TOP_N survives
  // even with a stiff filter rate.
  const eligible = await filterByPublicOwner(db, rows.map((r) => ({
    scope: r.scope as RankingScope,
    ownerId: r.ownerId,
    value: Number(r.value),
  })));
  return eligible.slice(0, TOP_N);
}

async function queryMessagesBoard(db: Db): Promise<RawEntry[]> {
  // Master OOC = messages with characterId IS NULL.
  // Character = messages with characterId IS NOT NULL.
  // System messages are excluded (kind != 'system') so the
  // "talkative" tally reflects actual roleplay, not the join /
  // leave broadcasts the user passively triggers.
  const masterRows = await db
    .select({
      ownerId: messages.userId,
      value: sql<number>`COUNT(*)`,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(and(publicUserFilter(), isNull(messages.characterId), sql`${messages.kind} != 'system'`))
    .groupBy(messages.userId)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(TOP_N);
  const charRows = await db
    .select({
      ownerId: sql<string>`${messages.characterId}`,
      value: sql<number>`COUNT(*)`,
    })
    .from(messages)
    .innerJoin(characters, eq(characters.id, messages.characterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(publicUserFilter(), isNull(characters.deletedAt), isNotNull(messages.characterId), sql`${messages.kind} != 'system'`))
    .groupBy(messages.characterId)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(TOP_N);
  return mergeTop(
    masterRows.map((r) => ({ scope: "user" as const, ownerId: r.ownerId, value: Number(r.value) })),
    charRows.map((r) => ({ scope: "character" as const, ownerId: r.ownerId, value: Number(r.value) })),
  );
}

async function queryBordersBoard(db: Db): Promise<RawEntry[]> {
  // Sum rank-tier borders + freeform borders per pool. Two queries
  // per scope, merged in JS by pool key.
  const masterRankBorders = await db
    .select({ ownerId: userOwnedBorders.userId, value: sql<number>`COUNT(*)` })
    .from(userOwnedBorders)
    .innerJoin(users, eq(users.id, userOwnedBorders.userId))
    .where(publicUserFilter())
    .groupBy(userOwnedBorders.userId);
  const masterFreeformBorders = await db
    .select({ ownerId: userOwnedFreeformBorders.userId, value: sql<number>`COUNT(*)` })
    .from(userOwnedFreeformBorders)
    .innerJoin(users, eq(users.id, userOwnedFreeformBorders.userId))
    .where(publicUserFilter())
    .groupBy(userOwnedFreeformBorders.userId);
  const charRankBorders = await db
    .select({ ownerId: characterOwnedBorders.characterId, value: sql<number>`COUNT(*)` })
    .from(characterOwnedBorders)
    .innerJoin(characters, eq(characters.id, characterOwnedBorders.characterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(publicUserFilter(), isNull(characters.deletedAt)))
    .groupBy(characterOwnedBorders.characterId);
  const charFreeformBorders = await db
    .select({ ownerId: characterOwnedFreeformBorders.characterId, value: sql<number>`COUNT(*)` })
    .from(characterOwnedFreeformBorders)
    .innerJoin(characters, eq(characters.id, characterOwnedFreeformBorders.characterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(publicUserFilter(), isNull(characters.deletedAt)))
    .groupBy(characterOwnedFreeformBorders.characterId);
  return mergeBorderLikeCounts(
    [masterRankBorders, masterFreeformBorders],
    [charRankBorders, charFreeformBorders],
  );
}

async function queryStylesBoard(db: Db): Promise<RawEntry[]> {
  const masterStyles = await db
    .select({ ownerId: userOwnedNameStyles.userId, value: sql<number>`COUNT(*)` })
    .from(userOwnedNameStyles)
    .innerJoin(users, eq(users.id, userOwnedNameStyles.userId))
    .where(publicUserFilter())
    .groupBy(userOwnedNameStyles.userId);
  const charStyles = await db
    .select({ ownerId: characterOwnedNameStyles.characterId, value: sql<number>`COUNT(*)` })
    .from(characterOwnedNameStyles)
    .innerJoin(characters, eq(characters.id, characterOwnedNameStyles.characterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(publicUserFilter(), isNull(characters.deletedAt)))
    .groupBy(characterOwnedNameStyles.characterId);
  return mergeTop(
    masterStyles.map((r) => ({ scope: "user" as const, ownerId: r.ownerId, value: Number(r.value) })),
    charStyles.map((r) => ({ scope: "character" as const, ownerId: r.ownerId, value: Number(r.value) })),
  );
}

async function queryTopicsBoard(db: Db): Promise<RawEntry[]> {
  // Forum topics = top-level messages with a non-null `title`. The
  // forum renderer treats `title IS NOT NULL` as the topic marker.
  const masterRows = await db
    .select({
      ownerId: messages.userId,
      value: sql<number>`COUNT(*)`,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(and(publicUserFilter(), isNull(messages.characterId), isNotNull(messages.title)))
    .groupBy(messages.userId)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(TOP_N);
  const charRows = await db
    .select({
      ownerId: sql<string>`${messages.characterId}`,
      value: sql<number>`COUNT(*)`,
    })
    .from(messages)
    .innerJoin(characters, eq(characters.id, messages.characterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(publicUserFilter(), isNull(characters.deletedAt), isNotNull(messages.characterId), isNotNull(messages.title)))
    .groupBy(messages.characterId)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(TOP_N);
  return mergeTop(
    masterRows.map((r) => ({ scope: "user" as const, ownerId: r.ownerId, value: Number(r.value) })),
    charRows.map((r) => ({ scope: "character" as const, ownerId: r.ownerId, value: Number(r.value) })),
  );
}

async function queryReactionsBoard(db: Db): Promise<RawEntry[]> {
  // Master = message_reactions.characterId IS NULL.
  // Character = message_reactions.characterId IS NOT NULL.
  const masterRows = await db
    .select({
      ownerId: messageReactions.userId,
      value: sql<number>`COUNT(*)`,
    })
    .from(messageReactions)
    .innerJoin(users, eq(users.id, messageReactions.userId))
    .where(and(publicUserFilter(), isNull(messageReactions.characterId)))
    .groupBy(messageReactions.userId)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(TOP_N);
  const charRows = await db
    .select({
      ownerId: sql<string>`${messageReactions.characterId}`,
      value: sql<number>`COUNT(*)`,
    })
    .from(messageReactions)
    .innerJoin(characters, eq(characters.id, messageReactions.characterId))
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(publicUserFilter(), isNull(characters.deletedAt), isNotNull(messageReactions.characterId)))
    .groupBy(messageReactions.characterId)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(TOP_N);
  return mergeTop(
    masterRows.map((r) => ({ scope: "user" as const, ownerId: r.ownerId, value: Number(r.value) })),
    charRows.map((r) => ({ scope: "character" as const, ownerId: r.ownerId, value: Number(r.value) })),
  );
}

/* =========================================================
 *  Helpers
 * ========================================================= */

/** Merge two scope-tagged top-N lists and re-truncate to TOP_N
 *  globally (so a single mega-account doesn't drown one scope). */
function mergeTop(masters: RawEntry[], chars: RawEntry[]): RawEntry[] {
  return [...masters, ...chars].sort((a, b) => b.value - a.value).slice(0, TOP_N);
}

/** Specialized merge for borders/styles where each pool gets two
 *  COUNT queries (rank-tier + freeform). Sums per pool then merges
 *  master + character lists. */
function mergeBorderLikeCounts(
  masterChunks: Array<Array<{ ownerId: string; value: number }>>,
  characterChunks: Array<Array<{ ownerId: string; value: number }>>,
): RawEntry[] {
  const masterTotals = new Map<string, number>();
  for (const chunk of masterChunks) {
    for (const r of chunk) {
      masterTotals.set(r.ownerId, (masterTotals.get(r.ownerId) ?? 0) + Number(r.value));
    }
  }
  const characterTotals = new Map<string, number>();
  for (const chunk of characterChunks) {
    for (const r of chunk) {
      characterTotals.set(r.ownerId, (characterTotals.get(r.ownerId) ?? 0) + Number(r.value));
    }
  }
  const masters: RawEntry[] = [...masterTotals.entries()].map(([ownerId, value]) => ({
    scope: "user" as const, ownerId, value,
  }));
  const chars: RawEntry[] = [...characterTotals.entries()].map(([ownerId, value]) => ({
    scope: "character" as const, ownerId, value,
  }));
  return mergeTop(masters, chars);
}

/** Items board doesn't get a privacy filter inside the aggregation
 *  (the GROUP BY would have to JOIN through both possible owner
 *  tables). Filter post-fetch instead. */
async function filterByPublicOwner(db: Db, entries: RawEntry[]): Promise<RawEntry[]> {
  const userIds = entries.filter((e) => e.scope === "user").map((e) => e.ownerId);
  const charIds = entries.filter((e) => e.scope === "character").map((e) => e.ownerId);
  const eligibleUsers = userIds.length > 0
    ? new Set((await db
        .select({ id: users.id })
        .from(users)
        .where(and(publicUserFilter(), inArray(users.id, userIds)))
      ).map((r) => r.id))
    : new Set<string>();
  const charRows = charIds.length > 0
    ? await db
        .select({ id: characters.id })
        .from(characters)
        .innerJoin(users, eq(users.id, characters.userId))
        .where(and(publicUserFilter(), isNull(characters.deletedAt), inArray(characters.id, charIds)))
    : [];
  const eligibleChars = new Set(charRows.map((r) => r.id));
  return entries.filter((e) =>
    (e.scope === "user" && eligibleUsers.has(e.ownerId))
    || (e.scope === "character" && eligibleChars.has(e.ownerId)),
  );
}

/** Display-info batch fetch. Resolves the (scope, ownerId) tuples
 *  the boards referenced into the full PoolEntry shape minus
 *  `value` (filled per-board). Keyed `${scope}::${ownerId}`. Applies
 *  the same privacy gate as the boards (disabled / non-public masters
 *  and deleted characters are omitted), so callers should treat a
 *  missing key as "drop this row." Exported so the social-game
 *  rankings (earning/gameRankings.ts) reuse the exact same cosmetic
 *  resolution + privacy posture instead of duplicating it. */
export async function fetchDisplayInfo(
  db: Db,
  pools: ReadonlyArray<{ scope: RankingScope; ownerId: string }>,
): Promise<Map<string, Omit<RankingPoolEntry, "value">>> {
  const out = new Map<string, Omit<RankingPoolEntry, "value">>();
  const userIds = pools.filter((p) => p.scope === "user").map((p) => p.ownerId);
  const charIds = pools.filter((p) => p.scope === "character").map((p) => p.ownerId);

  // Master rows, pull from users + user_earning + user_active_cosmetics.
  if (userIds.length > 0) {
    const rows = await db
      .select({
        userId: users.id,
        username: users.username,
        avatarUrl: users.avatarUrl,
        isPublic: users.isPublic,
        disabledAt: users.disabledAt,
        rankKey: userEarning.rankKey,
        tier: userEarning.tier,
        selectedBorderRankKey: userEarning.selectedBorderRankKey,
        selectedFreeformBorderKey: userEarning.selectedFreeformBorderKey,
        activeNameStyleKey: userActiveCosmetics.activeNameStyleKey,
      })
      .from(users)
      .leftJoin(userEarning, eq(userEarning.userId, users.id))
      .leftJoin(userActiveCosmetics, eq(userActiveCosmetics.userId, users.id))
      .where(inArray(users.id, userIds));
    // Rank tier display labels (rankName, tierLabel, sigil), one
    // batched lookup against ranks + rank_tiers.
    const rankTierMap = await loadRankTierDisplay(db);
    // Per-(user, style) configJson for the master scope. Same shape
    // as broadcast.ts resolution. One IN-array fetch.
    const styleKeysByUser = new Map<string, string | null>(rows.map((r) => [r.userId, r.activeNameStyleKey]));
    const nameStyleConfigByUser = await loadMasterNameStyleConfigs(db, [...styleKeysByUser.entries()].filter(([, k]) => k != null) as Array<[string, string]>);
    // Per-(user, border) freeform configJson.
    const freeformByUser = await loadMasterFreeformConfigs(db, rows
      .filter((r) => r.selectedFreeformBorderKey != null)
      .map((r) => [r.userId, r.selectedFreeformBorderKey!] as [string, string]));
    for (const r of rows) {
      if (r.disabledAt || !r.isPublic) continue;
      const rt = r.rankKey && r.tier != null ? rankTierMap.get(`${r.rankKey}::${r.tier}`) ?? null : null;
      out.set(`user::${r.userId}`, {
        scope: "user",
        ownerId: r.userId,
        userId: r.userId,
        characterId: null,
        displayName: r.username,
        avatarUrl: r.avatarUrl ?? null,
        borderRankKey: r.selectedBorderRankKey ?? null,
        freeformBorderKey: r.selectedFreeformBorderKey ?? null,
        freeformBorderConfigJson: freeformByUser.get(r.userId) ?? null,
        activeNameStyleKey: r.activeNameStyleKey ?? null,
        nameStyleConfigJson: nameStyleConfigByUser.get(r.userId) ?? null,
        rankKey: r.rankKey ?? null,
        tier: r.tier ?? null,
        rankName: rt?.rankName ?? null,
        tierLabel: rt?.tierLabel ?? null,
        sigilImageUrl: rt?.sigilImageUrl ?? null,
      });
    }
  }

  // Character rows, pull from characters + character_earning,
  // joined to users for privacy + master fallback.
  if (charIds.length > 0) {
    const rows = await db
      .select({
        characterId: characters.id,
        userId: characters.userId,
        characterName: characters.name,
        characterAvatar: characters.avatarUrl,
        deletedAt: characters.deletedAt,
        masterUsername: users.username,
        masterAvatar: users.avatarUrl,
        masterPublic: users.isPublic,
        masterDisabled: users.disabledAt,
        rankKey: characterEarning.rankKey,
        tier: characterEarning.tier,
        selectedBorderRankKey: characterEarning.selectedBorderRankKey,
        selectedFreeformBorderKey: characterEarning.selectedFreeformBorderKey,
        activeNameStyleKey: characterEarning.activeNameStyleKey,
      })
      .from(characters)
      .innerJoin(users, eq(users.id, characters.userId))
      .leftJoin(characterEarning, eq(characterEarning.characterId, characters.id))
      .where(inArray(characters.id, charIds));
    const rankTierMap = await loadRankTierDisplay(db);
    const nameStyleConfigByChar = await loadCharacterNameStyleConfigs(db, rows
      .filter((r) => r.activeNameStyleKey != null)
      .map((r) => [r.characterId, r.activeNameStyleKey!] as [string, string]));
    const freeformByChar = await loadCharacterFreeformConfigs(db, rows
      .filter((r) => r.selectedFreeformBorderKey != null)
      .map((r) => [r.characterId, r.selectedFreeformBorderKey!] as [string, string]));
    for (const r of rows) {
      if (r.deletedAt || r.masterDisabled || !r.masterPublic) continue;
      const rt = r.rankKey && r.tier != null ? rankTierMap.get(`${r.rankKey}::${r.tier}`) ?? null : null;
      out.set(`character::${r.characterId}`, {
        scope: "character",
        ownerId: r.characterId,
        userId: r.userId,
        characterId: r.characterId,
        displayName: r.characterName,
        // OOC ↔ character partition: NEVER fall back to the master
        // avatar on a character-scoped row. A character with no
        // portrait renders as initials; surfacing the master's face
        // would expose "this character belongs to that master."
        avatarUrl: r.characterAvatar ?? null,
        borderRankKey: r.selectedBorderRankKey ?? null,
        freeformBorderKey: r.selectedFreeformBorderKey ?? null,
        freeformBorderConfigJson: freeformByChar.get(r.characterId) ?? null,
        activeNameStyleKey: r.activeNameStyleKey ?? null,
        nameStyleConfigJson: nameStyleConfigByChar.get(r.characterId) ?? null,
        rankKey: r.rankKey ?? null,
        tier: r.tier ?? null,
        rankName: rt?.rankName ?? null,
        tierLabel: rt?.tierLabel ?? null,
        sigilImageUrl: rt?.sigilImageUrl ?? null,
      });
    }
  }
  return out;
}

interface RankTierDisplay {
  rankName: string;
  tierLabel: string;
  sigilImageUrl: string | null;
}

let rankTierDisplayCache: Promise<Map<string, RankTierDisplay>> | null = null;
let rankTierDisplayCacheStamp = 0;
const RANK_DISPLAY_TTL = 60_000; // 1 minute

async function loadRankTierDisplay(db: Db): Promise<Map<string, RankTierDisplay>> {
  // Cached for a minute, the rank catalog is admin-edited rarely,
  // and the rankings endpoint is hit on every dashboard open.
  // Stale-by-up-to-a-minute is acceptable for cosmetic labels.
  const now = Date.now();
  if (rankTierDisplayCache && now - rankTierDisplayCacheStamp < RANK_DISPLAY_TTL) {
    return rankTierDisplayCache;
  }
  rankTierDisplayCache = (async () => {
    const rows = await db
      .select({
        rankKey: rankTiers.rankKey,
        tier: rankTiers.tier,
        label: rankTiers.label,
        sigilImageUrl: rankTiers.sigilImageUrl,
        rankName: ranks.name,
      })
      .from(rankTiers)
      .innerJoin(ranks, eq(ranks.key, rankTiers.rankKey))
      .orderBy(asc(ranks.order), asc(rankTiers.tier));
    const out = new Map<string, RankTierDisplay>();
    for (const r of rows) {
      out.set(`${r.rankKey}::${r.tier}`, {
        rankName: r.rankName,
        tierLabel: r.label,
        sigilImageUrl: r.sigilImageUrl ?? null,
      });
    }
    return out;
  })();
  rankTierDisplayCacheStamp = now;
  return rankTierDisplayCache;
}

async function loadMasterNameStyleConfigs(
  db: Db,
  pairs: ReadonlyArray<[userId: string, styleKey: string]>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (pairs.length === 0) return out;
  const userIds = [...new Set(pairs.map(([u]) => u))];
  const rows = await db
    .select({
      userId: userOwnedNameStyles.userId,
      styleKey: userOwnedNameStyles.styleKey,
      configJson: userOwnedNameStyles.configJson,
    })
    .from(userOwnedNameStyles)
    .where(inArray(userOwnedNameStyles.userId, userIds));
  const byKey = new Map<string, string | null>();
  for (const r of rows) byKey.set(`${r.userId}::${r.styleKey}`, r.configJson);
  for (const [userId, styleKey] of pairs) {
    out.set(userId, byKey.get(`${userId}::${styleKey}`) ?? null);
  }
  return out;
}

async function loadCharacterNameStyleConfigs(
  db: Db,
  pairs: ReadonlyArray<[characterId: string, styleKey: string]>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (pairs.length === 0) return out;
  const charIds = [...new Set(pairs.map(([c]) => c))];
  const rows = await db
    .select({
      characterId: characterOwnedNameStyles.characterId,
      styleKey: characterOwnedNameStyles.styleKey,
      configJson: characterOwnedNameStyles.configJson,
    })
    .from(characterOwnedNameStyles)
    .where(inArray(characterOwnedNameStyles.characterId, charIds));
  const byKey = new Map<string, string | null>();
  for (const r of rows) byKey.set(`${r.characterId}::${r.styleKey}`, r.configJson);
  for (const [charId, styleKey] of pairs) {
    out.set(charId, byKey.get(`${charId}::${styleKey}`) ?? null);
  }
  return out;
}

async function loadMasterFreeformConfigs(
  db: Db,
  pairs: ReadonlyArray<[userId: string, borderKey: string]>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (pairs.length === 0) return out;
  const userIds = [...new Set(pairs.map(([u]) => u))];
  const rows = await db
    .select({
      userId: userOwnedFreeformBorders.userId,
      borderKey: userOwnedFreeformBorders.borderKey,
      configJson: userOwnedFreeformBorders.configJson,
    })
    .from(userOwnedFreeformBorders)
    .where(inArray(userOwnedFreeformBorders.userId, userIds));
  const byKey = new Map<string, string | null>();
  for (const r of rows) byKey.set(`${r.userId}::${r.borderKey}`, r.configJson);
  for (const [userId, borderKey] of pairs) {
    out.set(userId, byKey.get(`${userId}::${borderKey}`) ?? null);
  }
  return out;
}

async function loadCharacterFreeformConfigs(
  db: Db,
  pairs: ReadonlyArray<[characterId: string, borderKey: string]>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (pairs.length === 0) return out;
  const charIds = [...new Set(pairs.map(([c]) => c))];
  const rows = await db
    .select({
      characterId: characterOwnedFreeformBorders.characterId,
      borderKey: characterOwnedFreeformBorders.borderKey,
      configJson: characterOwnedFreeformBorders.configJson,
    })
    .from(characterOwnedFreeformBorders)
    .where(inArray(characterOwnedFreeformBorders.characterId, charIds));
  const byKey = new Map<string, string | null>();
  for (const r of rows) byKey.set(`${r.characterId}::${r.borderKey}`, r.configJson);
  for (const [charId, borderKey] of pairs) {
    out.set(charId, byKey.get(`${charId}::${borderKey}`) ?? null);
  }
  return out;
}
