/**
 * Client-side Earning types + fetch helpers.
 *
 * Mirrors the wire shapes returned by `/earning/me`, `/earning/users/:id`,
 * `/earning/me/ledger`, `/earning/me/notifications`, and `/earning/catalog`.
 * Kept in lib (not state) so non-store callers (the rank-up ribbon, the
 * admin Awards tab) can import the types without bringing in Zustand.
 */

import { readError } from "./http.js";

export interface PoolView {
  scope: "user" | "character";
  ownerId: string;
  displayName: string;
  xp: number;
  currency: number;
  rankKey: string | null;
  tier: number | null;
  rankName: string | null;
  tierLabel: string | null;
  sigilImageUrl: string | null;
  maxRankKeyEverHeld: string | null;
  maxTierEverHeld: number | null;
  selectedBorderRankKey: string | null;
  /** Free-form border equip slot, independent of the rank-tier
   *  slot. BorderedAvatar resolves freeform first, falling back to
   *  the rank slot if unset. Null = no freeform border equipped. */
  selectedFreeformBorderKey: string | null;
  /** Only set on the master pool; characters cascade off the master flag. */
  hideCurrencyCount?: boolean;
  hideXpCount?: boolean;
}

export interface RankRow {
  key: string;
  name: string;
  order: number;
  enabled: boolean;
}

export interface RankTierRow {
  id: string;
  rankKey: string;
  tier: number;
  label: string;
  xpThreshold: number;
  sigilImageUrl: string;
  borderImageUrl: string | null;
  borderCost: number | null;
  enabled: boolean;
}

export interface OwnedStyle {
  styleKey: string;
  configJson: string | null;
  acquiredAt: number;
}

export interface OwnedBorder {
  rankKey: string;
  acquiredAt: number;
}

/** Free-form border ownership row. Distinct from `OwnedBorder`,
 *  the keys point at `freeform_borders.key`, not a `ranks.key`, and
 *  the two ledgers are independent. */
export interface OwnedFreeformBorder {
  borderKey: string;
  /** Per-identity color customization (migration 0158). JSON string
   *  keyed by var-name without the `--c-` prefix (e.g.
   *  `{"ring-main":"#ff10f0"}`). Null = use the catalog row's CSS
   *  fallbacks for every slot. */
  configJson: string | null;
  acquiredAt: number;
}

/** Free-form border catalog row. Either `imageUrl` is set (overlay
 *  PNG / APNG path) OR `template` + `styleCss` are set (DOM-template
 *  path that mirrors the name-style system). Server enforces the
 *  XOR. `rarity` is an open string so admins can introduce new
 *  tiers without a schema migration; the BordersTab falls back to
 *  the 'common' palette for unknown values. */
export interface FreeformBorderRow {
  key: string;
  name: string;
  description: string;
  imageUrl: string | null;
  template: string | null;
  styleCss: string | null;
  rarity: string;
  cost: number;
  isBuiltin: boolean;
  order: number;
}

export interface IdentityCosmetics {
  inlineAvatarEnabled: boolean;
  activeNameStyleKey: string | null;
  /**
   * Profile banner image URL pasted by the user. Null when the slot
   * is empty (either no `flair_profile_banner` purchase yet, the
   * user cleared the URL, or admin moderation cleared an abusive
   * link). Renders as a 3:1 hero strip at the top of the profile
   * modal, see ProfileModal.
   */
  profileBannerUrl: string | null;
  /**
   * Whether this identity has purchased `flair_profile_banner` (the
   * Flair unlock for the banner URL slot). Separate from
   * `profileBannerUrl` because the user can own the cosmetic but
   * have cleared their URL, the Flair tab needs to know to show
   * "Set / clear URL" instead of "Buy" in that state.
   */
  profileBannerOwned: boolean;
  /** Free-form border equip slot for THIS identity. Mirrors the
   *  rank-tier `selectedBorderRankKey` field shape on PoolView; we
   *  surface it here too so character entries can carry it without
   *  needing a separate PoolView lookup on the consumer side. */
  selectedFreeformBorderKey?: string | null;
  /** Phase 5 custom typing phrase. When non-null and the typer is
   *  alone in the indicator strip, replaces "is typing…" with this
   *  string. Server clamps to 60 chars and strips control chars
   *  before writing, so the client can render verbatim (still text-
   *  escaped, never as HTML). */
  typingPhrase?: string | null;
  /** Whether this identity has purchased `flair_typing_phrase`. Same
   *  pattern as `profileBannerOwned`, separates "owns the unlock"
   *  from "has currently set a phrase" so the Flair tab can show
   *  "Buy" vs "Set phrase" cleanly. */
  typingPhraseOwned?: boolean;
  /** Phase 6, Lurking Master toggle state. When true (and owned),
   *  the typing indicator hides this user from non-admin receivers.
   *  Admins always see the typing pulse for moderation visibility. */
  lurkingMasterEnabled?: boolean;
  /** Whether this identity has purchased `flair_lurking_master`. */
  lurkingMasterOwned?: boolean;
  /** Phase 7 (migration 0161), custom room join template. When
   *  set AND `roomPresenceOwned` is true, the join broadcast in
   *  every non-forum room substitutes this text (with `{name}` and
   *  `{room}` placeholders) for the default phrasing. Null = use
   *  the default. */
  roomJoinTemplate?: string | null;
  /** Twin of `roomJoinTemplate` for the room-leave broadcast. */
  roomLeaveTemplate?: string | null;
  /** Whether this identity has purchased `flair_room_presence`. */
  roomPresenceOwned?: boolean;
  /** Master-only: custom session-connect broadcast template. Only
   *  meaningful on the top-level `ActiveCosmetics` shape (the
   *  byCharacter map omits this since session presence isn't
   *  per-character). */
  sessionConnectTemplate?: string | null;
  /** Master-only: custom session-exit broadcast template. */
  sessionExitTemplate?: string | null;
  /** Whether the master has purchased `flair_session_presence`. */
  sessionPresenceOwned?: boolean;
  /** Migration 0192, `flair_profile_visitors` ownership. Gates the
   *  CosmeticsTab Buy/Equip CTA and the editor's stats panel. The
   *  actual visibility toggle + view counts live behind
   *  `/me/profile-flair` (not on the snapshot) so the editor's
   *  fetched state stays decoupled from the catalog snapshot. */
  profileVisitorsOwned?: boolean;
  /** Migration 0192, `flair_profile_marquee` ownership. Gates the
   *  CosmeticsTab Buy CTA + the editor's quotes grid. Quote bodies
   *  live behind `/me/profile-flair`, not on the snapshot, since
   *  they can be edited frequently and we don't want the snapshot
   *  payload to bloat with rotating-quote content. */
  profileMarqueeOwned?: boolean;
}

export interface ActiveCosmetics extends IdentityCosmetics {
  /**
   * Per-character active cosmetics, keyed by character id. Each
   * entry mirrors the master shape (`inlineAvatarEnabled` +
   * `activeNameStyleKey`). The top-level fields above remain the
   * master/OOC slot for backwards compatibility with existing
   * consumers; characters read from this map indexed by their id.
   */
  byCharacter: Record<string, IdentityCosmetics>;
}

export interface RankUpRecord {
  id: string;
  scope: "user" | "character";
  characterId: string | null;
  fromRankKey: string | null;
  fromTier: number | null;
  toRankKey: string;
  toTier: number;
  newlyEligibleBorderKeys: string[];
  createdAt: number;
}

export interface NameStyleCatalogRow {
  key: string;
  name: string;
  description: string;
  template: string;
  styleCss: string;
  cost: number;
  isBuiltin: boolean;
  order: number;
}

/** Closed enum of item categories. Mirrors the server-side zod
 *  enum + migration 0103's documented set. Use the union for prop
 *  types; use `ITEM_CATEGORIES` for shop-tab iteration. */
export type ItemCategory =
  | "food" | "drink" | "joke" | "tool" | "weapon" | "armor"
  | "magic" | "treasure" | "building" | "gift" | "toy" | "pet" | "misc";

/** Stable ordering for shop category chips. `misc` is last as the
 *  fallback bucket; `pet` is intentionally LAST among the "real"
 *  categories so casual visitors don't land on the pet bucket
 *  before browsing common items. */
export const ITEM_CATEGORIES: readonly ItemCategory[] = [
  "food", "drink", "joke", "tool", "weapon", "armor",
  "magic", "treasure", "building", "gift", "toy", "pet", "misc",
] as const;

/** Human-readable label for each category, used for shop-tab text. */
export const ITEM_CATEGORY_LABELS: Record<ItemCategory, string> = {
  food: "Food", drink: "Drinks", joke: "Joke", tool: "Tools",
  weapon: "Weapons", armor: "Armor", magic: "Magic", treasure: "Treasure",
  building: "Buildings", gift: "Gifts", toy: "Toys", pet: "Pets", misc: "Misc",
};

/**
 * Public-facing item catalog row. `purchasable` is server-derived
 * from `enabled && forSale && now ∈ [saleStartsAt, saleEndsAt)`. The
 * raw fields are also exposed so the UI can render the reason
 * something isn't purchasable (sale starts at X, sale ended at Y).
 * `availableCommands` mirrors which of give/throw/drop have non-empty
 * message arrays, the dashboard's command help uses it.
 */
export interface ItemCatalogRow {
  key: string;
  name: string;
  namePlural: string | null;
  description: string;
  iconUrl: string | null;
  price: number;
  stackLimit: number;
  enabled: boolean;
  forSale: boolean;
  saleStartsAt: number | null;
  saleEndsAt: number | null;
  order: number;
  isBuiltin: boolean;
  /** Shop bucket + pin-collection routing. */
  category: ItemCategory;
  purchasable: boolean;
  availableCommands: { give: boolean; throw: boolean; drop: boolean };
}

export interface InventoryEntry {
  itemKey: string;
  quantity: number;
  acquiredAt: number;
}

/**
 * One pinned slot in an identity's Collection (Phase 3). Sparse,
 * a slot index in 0..9 with the chosen item key. The Collection
 * tab in the dashboard renders 10 slots and overlays the entries
 * indexed by `slot`.
 */
export interface CollectionEntry {
  slot: number;
  itemKey: string;
  /** Owner-assigned pet nickname. Only present on entries from the
   *  pet-collection arrays; the general item-collection ignores it.
   *  Null when no nickname is set (renderer falls back to the catalog
   *  item name). */
  nickname?: string | null;
}

export interface EarningMeResponse {
  master: PoolView;
  characters: PoolView[];
  catalog: {
    ranks: RankRow[];
    rankTiers: RankTierRow[];
    nameStyles: NameStyleCatalogRow[];
    /** Free-form (non-rank-tied) border catalog. Shipped on every
     *  /earning/me response so the dashboard can inject the
     *  template+CSS rows once on open. Independent of `rankTiers`. */
    freeformBorders: FreeformBorderRow[];
    items: ItemCatalogRow[];
  };
  /** Master/OOC's owned styles (since migration 0086). Characters
   *  carry their own owned lists in `ownedStylesByCharacter`. */
  ownedStyles: OwnedStyle[];
  ownedBorders: OwnedBorder[];
  /** Master/OOC's owned free-form borders, parallel to
   *  `ownedBorders` but distinct, since the two catalogs are
   *  independent. */
  ownedFreeformBorders: OwnedFreeformBorder[];
  /** Per-character owned styles, keyed by character id. Empty entry
   *  / missing key means the character hasn't bought anything yet. */
  ownedStylesByCharacter: Record<string, OwnedStyle[]>;
  ownedBordersByCharacter: Record<string, OwnedBorder[]>;
  ownedFreeformBordersByCharacter: Record<string, OwnedFreeformBorder[]>;
  /** Master/OOC inventory, items owned on the OOC pool. Independent
   *  of every character's inventory (`inventoryByCharacter`). */
  inventory: InventoryEntry[];
  /** Per-character inventory keyed by character id. Each entry is
   *  fully isolated; nothing implicitly mirrors across identities. */
  inventoryByCharacter: Record<string, InventoryEntry[]>;
  /** Master/OOC Collection pins (Phase 3, 10-slot showcase). Sparse.
   *  Independent of every character's Collection, pins do not
   *  carry across identities. Items pinned here have category !=
   *  'pet'; pets live in `petCollection`. */
  collection: CollectionEntry[];
  /** Per-character Collection pins keyed by character id. */
  collectionByCharacter: Record<string, CollectionEntry[]>;
  /** Master/OOC Pet Collection pins (5-slot showcase). Only items
   *  with category='pet' are pinnable here, server enforces. */
  petCollection: CollectionEntry[];
  /** Per-character Pet Collection pins keyed by character id. */
  petCollectionByCharacter: Record<string, CollectionEntry[]>;
  activeCosmetics: ActiveCosmetics;
  notifications: RankUpRecord[];
}

export interface LedgerEntry {
  id: string;
  scope: "user" | "character";
  ownerId: string;
  xpDelta: number;
  currencyDelta: number;
  reason: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  nextCursor: number | null;
}

export interface PublicEarningResponse {
  userId: string;
  username: string;
  /** Present only when the response is scoped to a CHARACTER pool,
   *  echoed back from the `?characterId=` query the caller sent.
   *  Lets the client confirm it's reading the right pool before
   *  painting numbers (defensive against a stale state race). */
  characterId?: string;
  /** null when the user has `hideXpCount` set and the caller isn't them. */
  xp: number | null;
  /** null when the user has `hideCurrencyCount` set and the caller isn't them. */
  currency: number | null;
  rankKey: string | null;
  tier: number | null;
  rankName: string | null;
  tierLabel: string | null;
  sigilImageUrl: string | null;
  selectedBorderRankKey: string | null;
  selectedFreeformBorderKey: string | null;
  /** Raw JSON string of the master pool's freeform-border color
   *  customization (migration 0158). Null when no freeform border is
   *  equipped or no customization saved. Parsed client-side via
   *  parseFreeformBorderConfig before being passed to BorderedAvatar. */
  freeformBorderConfigJson: string | null;
}

export interface CatalogResponse {
  nameStyles: Array<{
    key: string;
    name: string;
    description: string;
    template: string;
    styleCss: string;
    cost: number;
    isBuiltin: boolean;
    order: number;
  }>;
  cosmetics: Array<{
    key: string;
    name: string;
    description: string;
    cost: number;
    config: unknown;
  }>;
  items: ItemCatalogRow[];
}

/* ---------- EarningConfig (admin Awards tab) ---------- */

export interface AwardAmount { xp: number; currency: number }
export interface SourceEnableFlags { xp: boolean; currency: boolean }

/** Length-bonus curve for a single message kind. The award engine
 *  multiplies the per-kind XP/Currency by a linearly-interpolated
 *  factor from 1.0x at `floorChars` up to `maxMultiplier` at
 *  `ceilChars` (clamped above). `enabled=false` or `maxMultiplier<=1`
 *  = always 1.0x. */
export interface LengthBonusSpec {
  enabled: boolean;
  floorChars: number;
  ceilChars: number;
  maxMultiplier: number;
}

export interface EarningConfig {
  enabled: boolean;
  awards: {
    message: { say: AwardAmount; action: AwardAmount; whisper: AwardAmount };
    forum: { topic: AwardAmount; reply: AwardAmount };
    presence: { perBlock: AwardAmount };
  };
  bodyFloorChars: number;
  /** Length-bonus + spam-detection knobs. Length bonus rewards
   *  effort on action/RP posts; spam detection drops the award to
   *  zero on flagged messages (keysmash, repeated tokens, echo). */
  messageQuality: {
    lengthBonus: {
      say: LengthBonusSpec;
      action: LengthBonusSpec;
      whisper: LengthBonusSpec;
    };
    spam: {
      enabled: boolean;
      minLengthToCheck: number;
      uniqueCharRatioFloor: number;
      dominantTokenRatioCap: number;
      echoLookback: number;
    };
  };
  presenceBlockMinutes: number;
  presenceDailyBlockCap: number;
  enabledSources: {
    message: SourceEnableFlags;
    forum: SourceEnableFlags;
    presence: SourceEnableFlags;
  };
  multiCharacterEarnDivisor: number;
  currencyTransfer: {
    enabled: boolean;
    dailySendCap: number;
    dailyReceiveCap: number;
    minSenderAccountAgeDays: number;
    minRecipientAccountAgeDays: number;
    minTransferAmount: number;
    maxTransferAmount: number;
  };
  backfill: {
    xpPerHistoricalMessage: number;
    completedAt: number | null;
  };
  /** Scriptorium writing rewards + buy-a-copy economy. */
  scriptorium: {
    enabled: boolean;
    xpPerWord: number;
    currencyPerWord: number;
    wordFloor: number;
    dailyXpCap: number;
    dailyCurrencyCap: number;
    streak: { perWeekBonus: number; maxMultiplier: number };
    spam: {
      enabled: boolean;
      minWords: number;
      dominantTokenRatioCap: number;
      uniqueWordRatioFloor: number;
    };
    copyPrice: number;
    royaltyRate: number;
    dailyRoyaltyCap: number;
  };
}

export interface AdminAwardsResponse {
  config: EarningConfig;
  defaults: EarningConfig;
}

/* ---------- fetch helpers ---------- */

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as T;
}

export async function fetchEarningMe(): Promise<EarningMeResponse> {
  return jsonOrThrow<EarningMeResponse>(await fetch("/earning/me", { credentials: "include" }));
}

export async function fetchEarningLedger(opts: {
  scope?: "user" | "character";
  characterId?: string | null;
  cursor?: number | null;
  limit?: number;
}): Promise<LedgerPage> {
  const params = new URLSearchParams();
  if (opts.scope) params.set("scope", opts.scope);
  if (opts.characterId) params.set("characterId", opts.characterId);
  if (opts.cursor) params.set("cursor", String(opts.cursor));
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return jsonOrThrow<LedgerPage>(await fetch(`/earning/me/ledger${qs ? `?${qs}` : ""}`, { credentials: "include" }));
}

export async function patchEarningSettings(body: {
  hideCurrencyCount?: boolean;
  hideXpCount?: boolean;
  selectedBorderRankKey?: string | null;
  /** Free-form border equip, independent of the rank-tier slot.
   *  Pass null to unequip the freeform border (the rank border, if
   *  any, then takes over). */
  selectedFreeformBorderKey?: string | null;
  /** Per-identity scope for border equip (selectedBorderRankKey /
   *  selectedFreeformBorderKey). Hide flags ignore characterId,
   *  they're master-only privacy preferences. Null/omitted = master
   *  pool. */
  characterId?: string | null;
}): Promise<void> {
  const r = await fetch("/earning/me/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function ackRankUpNotification(notificationId?: string): Promise<void> {
  const r = await fetch("/earning/me/notifications/rankup/ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(notificationId ? { notificationId } : {}),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function fetchEarningCatalog(): Promise<CatalogResponse> {
  return jsonOrThrow<CatalogResponse>(await fetch("/earning/catalog", { credentials: "include" }));
}

/* ---------- flash sale ---------- */

/** One row of a flash-sale pick. `basePrice` is the catalog row's cost;
 *  `salePrice` is what `basePrice` becomes after the discount %. Both
 *  echoed back so the client doesn't have to do percentage math (and so
 *  the server's rounding rule stays authoritative). */
export interface FlashSalePick {
  key: string;
  name: string;
  iconUrl?: string | null;
  basePrice: number;
  salePrice: number;
  discountPct: number | null;
}

export interface FlashSaleResponse {
  forDate: string;            // 'YYYY-MM-DD' UTC
  nameStyle: FlashSalePick | null;
  item: FlashSalePick | null;
  cosmetic: FlashSalePick | null;
  /** Free-form border pick (migration 0160). Same shape as the other
   *  picks; the Overview / catalog renderers preview with
   *  BorderedAvatar instead of an icon. */
  freeformBorder: FlashSalePick | null;
}

export async function fetchFlashSale(): Promise<FlashSaleResponse> {
  return jsonOrThrow<FlashSaleResponse>(await fetch("/earning/flash-sale", { credentials: "include" }));
}

/* ---------- rankings ---------- */

export type RankingBoardKey =
  | "currency" | "xp" | "rank" | "items" | "messages"
  | "borders" | "styles" | "topics" | "reactions";

/**
 * A single leaderboard entry. Cosmetic context (border / freeform
 * config / name-style / rank tier) is carried so the Rankings tab
 * can paint the entry's avatar + name in the user's actual
 * equipped look, same fidelity as the userlist.
 */
export interface RankingPoolEntry {
  scope: "user" | "character";
  ownerId: string;
  userId: string;
  characterId: string | null;
  displayName: string;
  avatarUrl: string | null;
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
  value: number;
}

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
  generatedAt: number;
}

export async function fetchRankings(): Promise<RankingsResponse> {
  return jsonOrThrow<RankingsResponse>(await fetch("/earning/rankings", { credentials: "include" }));
}

/**
 * The minimal cosmetic subset the row renderers (ProfileLinkAvatar +
 * StyledEntryName) actually read. Both RankingPoolEntry and the
 * social-game rows below satisfy it, so the same components paint both
 * the pool boards and the game boards.
 */
export type RankingDisplayEntry = Pick<
  RankingPoolEntry,
  | "displayName"
  | "avatarUrl"
  | "borderRankKey"
  | "freeformBorderKey"
  | "freeformBorderConfigJson"
  | "activeNameStyleKey"
  | "nameStyleConfigJson"
>;

/* ---------- social-game rankings ---------- */

/** Cosmetic context shared by both game-row shapes - mirrors the server
 *  (everything from a RankingPoolEntry except the per-board `value` and
 *  the scope/ownerId re-exposed below as ownerScope/ownerId). */
type GameRankingCosmetics = Omit<RankingPoolEntry, "value" | "scope" | "ownerId">;

export interface GameRankingRow extends GameRankingCosmetics {
  ownerScope: "user" | "character";
  ownerId: string;
  wins: number;
  points: number;
  lastWonAt: number;
}

export interface OverallRankingRow extends GameRankingCosmetics {
  ownerScope: "user" | "character";
  ownerId: string;
  totalWins: number;
  totalPoints: number;
}

export interface GameRankingsResponse {
  games: Array<{
    gameKind: string;
    label: string;
    leaderboard: GameRankingRow[];
  }>;
  overall: OverallRankingRow[];
}

export async function fetchGameRankings(): Promise<GameRankingsResponse> {
  return jsonOrThrow<GameRankingsResponse>(await fetch("/earning/game-rankings", { credentials: "include" }));
}

/** Eidolon Tamer familiar leaderboards (level / age / streak / best-kept). */
export interface FamiliarRankingRow extends GameRankingCosmetics {
  ownerScope: "user" | "character";
  ownerId: string;
  familiarName: string;
  kind: "species" | "pet";
  speciesId: string | null;
  dead: boolean;
  level: number;
  ageHours: number;
  bestStreak: number;
  health: number;
  /** Metric value for the board this row was returned on. */
  value: number;
}
export interface FamiliarRankingsResponse {
  byLevel: FamiliarRankingRow[];
  byAge: FamiliarRankingRow[];
  byStreak: FamiliarRankingRow[];
  byHealth: FamiliarRankingRow[];
}
export async function fetchFamiliarRankings(): Promise<FamiliarRankingsResponse> {
  return jsonOrThrow<FamiliarRankingsResponse>(await fetch("/earning/familiar-rankings", { credentials: "include" }));
}

/* ---------- Scriptorium rankings ---------- */

/** Author byline for a book-board row (mirrors shared StoryAuthor). */
export interface ScriptoriumAuthor {
  userId: string;
  masterUsername: string;
  characterId: string | null;
  characterName: string | null;
  characterAvatarUrl: string | null;
  masterAvatarUrl: string | null;
}

/** A book-board row (the book itself, not an identity). */
export interface ScriptoriumBookRow {
  storyId: string;
  slug: string;
  title: string;
  coverImageUrl: string | null;
  rating: string;
  author: ScriptoriumAuthor;
  applauseCount: number;
  avgRating: number | null;
  reviewCount: number;
  totalWords: number;
}

/** Author boards rank identities (reuse RankingPoolEntry); book boards rank
 *  books (ScriptoriumBookRow). */
export interface ScriptoriumAuthorBoard {
  key: "publishers" | "words";
  label: string;
  metric: string;
  entries: RankingPoolEntry[];
}
export interface ScriptoriumBookBoard {
  key: "applause" | "rated";
  label: string;
  metric: string;
  entries: ScriptoriumBookRow[];
}
export interface ScriptoriumRankingsResponse {
  authorBoards: ScriptoriumAuthorBoard[];
  bookBoards: ScriptoriumBookBoard[];
  generatedAt: number;
}

export async function fetchScriptoriumRankings(): Promise<ScriptoriumRankingsResponse> {
  return jsonOrThrow<ScriptoriumRankingsResponse>(await fetch("/earning/scriptorium-rankings", { credentials: "include" }));
}

/* ---------- admin flash-sale + transfer ---------- */

export interface AdminFlashSaleOverride {
  category: "name_style" | "item" | "cosmetic" | "freeform_border";
  forDate: string;
  targetKey: string;
  discountPct: number | null;
}

export interface AdminFlashSaleResponse {
  today: {
    forDate: string;
    nameStyleKey: string | null;
    itemKey: string | null;
    cosmeticKey: string | null;
    freeformBorderKey: string | null;
    nameStyleDiscountPct: number | null;
    itemDiscountPct: number | null;
    cosmeticDiscountPct: number | null;
    freeformBorderDiscountPct: number | null;
  };
  tomorrow: string;
  overrides: AdminFlashSaleOverride[];
  settings: {
    defaultDiscountPct: number;
    stylesEnabled: boolean;
    itemsEnabled: boolean;
    cosmeticsEnabled: boolean;
    freeformBordersEnabled: boolean;
  };
}

export async function fetchAdminFlashSale(): Promise<AdminFlashSaleResponse> {
  return jsonOrThrow<AdminFlashSaleResponse>(
    await fetch("/admin/earning/flash-sale", { credentials: "include" }),
  );
}

export async function patchAdminFlashSaleSettings(body: {
  defaultDiscountPct?: number;
  stylesEnabled?: boolean;
  itemsEnabled?: boolean;
  cosmeticsEnabled?: boolean;
  freeformBordersEnabled?: boolean;
}): Promise<void> {
  const r = await fetch("/admin/earning/flash-sale/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function putAdminFlashSaleOverride(body: {
  category: "name_style" | "item" | "cosmetic" | "freeform_border";
  forDate: string;
  targetKey: string | null;
  discountPct?: number | null;
}): Promise<void> {
  const r = await fetch("/admin/earning/flash-sale/overrides", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/** Catalog kinds that have ZIP export/import. */
export type EarningTransferKind = "name-styles" | "items" | "borders" | "ranks" | "freeform-borders";

/** Trigger a browser file download of the catalog's export ZIP. */
export async function downloadCatalogExport(kind: EarningTransferKind): Promise<void> {
  const r = await fetch(`/admin/earning/transfer/${kind}/export`, { credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
  const blob = await r.blob();
  // Pull the filename out of Content-Disposition so the download
  // matches what the server proposed (`<kind>-export-YYYYMMDD.zip`)
  // instead of a UUID blob name.
  const disposition = r.headers.get("Content-Disposition") ?? "";
  const m = /filename="([^"]+)"/.exec(disposition);
  const filename = m?.[1] ?? `${kind}-export.zip`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface CatalogImportResult {
  ok: boolean;
  inserted: number;
  updated: number;
  skippedAssets: number;
  writtenAssets: string[];
  warnings: string[];
}

/** Upload a catalog import ZIP. `file` is a `File` from an `<input type="file">`. */
export async function uploadCatalogImport(
  kind: EarningTransferKind,
  file: File,
): Promise<CatalogImportResult> {
  // Same base64-in-JSON wire shape the existing logo upload uses,
  // no multipart plugin needed server-side.
  const buf = await file.arrayBuffer();
  const zipBase64 = bufferToBase64(new Uint8Array(buf));
  const r = await fetch(`/admin/earning/transfer/${kind}/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ zipBase64 }),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as CatalogImportResult;
}

function bufferToBase64(bytes: Uint8Array): string {
  // Chunked encoding so a many-MB zip doesn't blow the call stack
  // on `String.fromCharCode(...bytes)` (max arg count is platform-
  // dependent, typically ~120k on V8).
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function fetchPublicEarning(
  userId: string,
  characterId?: string | null,
): Promise<PublicEarningResponse> {
  // characterId routes the response to the CHARACTER pool, required
  // for character profiles, since the master pool's XP / currency /
  // rank / border belong to a different identity. Omitted (or null)
  // for master/OOC profiles, which keep the legacy behavior.
  const qs = characterId ? `?characterId=${encodeURIComponent(characterId)}` : "";
  return jsonOrThrow<PublicEarningResponse>(
    await fetch(`/earning/users/${encodeURIComponent(userId)}${qs}`, { credentials: "include" }),
  );
}

export async function fetchAdminAwards(): Promise<AdminAwardsResponse> {
  return jsonOrThrow<AdminAwardsResponse>(await fetch("/admin/earning/awards", { credentials: "include" }));
}

/* ---------- Admin Ranks tab ---------- */

export interface AdminRankRow {
  key: string;
  name: string;
  order: number;
  enabled: boolean;
  users: number;
  characters: number;
}

export interface AdminTierRow {
  id: string;
  rankKey: string;
  tier: number;
  label: string;
  xpThreshold: number;
  sigilImageUrl: string;
  borderImageUrl: string | null;
  borderCost: number | null;
  enabled: boolean;
}

export interface AdminRanksResponse {
  ranks: AdminRankRow[];
  tiers: AdminTierRow[];
}

export async function fetchAdminRanks(): Promise<AdminRanksResponse> {
  return jsonOrThrow<AdminRanksResponse>(await fetch("/admin/earning/ranks", { credentials: "include" }));
}

export async function createAdminRank(body: {
  key: string;
  name: string;
  order?: number;
  enabled?: boolean;
}): Promise<void> {
  const r = await fetch("/admin/earning/ranks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function patchAdminRank(key: string, body: { name?: string; order?: number; enabled?: boolean }): Promise<void> {
  const r = await fetch(`/admin/earning/ranks/${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function deleteAdminRank(key: string): Promise<void> {
  const r = await fetch(`/admin/earning/ranks/${encodeURIComponent(key)}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
}

export async function patchAdminTier(id: string, body: {
  label?: string;
  xpThreshold?: number;
  sigilImageUrl?: string;
  borderImageUrl?: string | null;
  borderCost?: number | null;
  enabled?: boolean;
}): Promise<void> {
  const r = await fetch(`/admin/earning/rank-tiers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function deleteAdminTier(id: string): Promise<void> {
  const r = await fetch(`/admin/earning/rank-tiers/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
}

/* ---------- Self, cosmetic + border purchase / equip ---------- */

export async function purchaseCosmetic(
  key: string,
  /** Per-identity scope. Null = master pool drains; character id =
   *  that character pays from their own pool. */
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch(`/earning/me/cosmetics/${encodeURIComponent(key)}/purchase`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function equipCosmetic(
  key: string,
  enabled: boolean,
  /** Per-identity scope. Null/undefined targets master/OOC;
   *  pass a character id to write that character's slot. */
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch(`/earning/me/cosmetics/${encodeURIComponent(key)}/equip`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ enabled, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Set or clear the profile-banner URL for the current identity.
 * Pass null/empty to clear the slot. Throws on server validation
 * failure (non-http URL, content-type sniff says it's not an image,
 * missing `flair_profile_banner` purchase). Returns the
 * server-normalized URL the slot now holds so the caller can
 * update local state without re-fetching the snapshot.
 */
export async function patchProfileBannerUrl(
  url: string | null,
  /** Per-identity scope. Null = master/OOC, character id = character. */
  characterId: string | null = null,
): Promise<{ url: string | null }> {
  const r = await fetch("/earning/me/banner", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ url, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as { url: string | null };
}

/**
 * Set or clear the custom typing phrase for the current identity.
 * Pass null/empty to clear the slot. Server normalizes the input
 * (trim, collapse whitespace, strip control chars) and returns the
 * post-write phrase so the caller can sync local state without a
 * full snapshot refresh. Throws on server validation failure
 * (missing `flair_typing_phrase` purchase, over the 60-char cap).
 */
export async function patchTypingPhrase(
  phrase: string | null,
  /** Per-identity scope. Null = master/OOC, character id = character. */
  characterId: string | null = null,
): Promise<{ phrase: string | null }> {
  const r = await fetch("/earning/me/typing-phrase", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ phrase, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as { phrase: string | null };
}

/**
 * Set or clear the room-presence broadcast templates (migration 0161).
 * Each field is optional, omit to leave the slot unchanged, pass
 * null to clear it, pass a string to set. Per-identity scope mirrors
 * the typing-phrase endpoint. Server validates length + strips
 * control / angle-bracket characters and returns the post-write
 * values so the caller can sync local state without a refetch.
 */
export async function patchRoomPresenceTemplates(
  body: {
    joinTemplate?: string | null;
    leaveTemplate?: string | null;
    characterId?: string | null;
  },
): Promise<{ joinTemplate: string | null; leaveTemplate: string | null }> {
  const r = await fetch("/earning/me/room-presence", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as { joinTemplate: string | null; leaveTemplate: string | null };
}

/**
 * Set or clear the session-presence templates (migration 0161).
 * Master-only, no characterId field, no per-character partition.
 * Same omit/null/string semantics as the room-presence twin.
 */
export async function patchSessionPresenceTemplates(
  body: {
    connectTemplate?: string | null;
    exitTemplate?: string | null;
  },
): Promise<{ connectTemplate: string | null; exitTemplate: string | null }> {
  const r = await fetch("/earning/me/session-presence", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as { connectTemplate: string | null; exitTemplate: string | null };
}

export async function purchaseBorder(
  rankKey: string,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch(`/earning/me/borders/${encodeURIComponent(rankKey)}/purchase`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Purchase a free-form (non-rank-tied) border for the active
 * identity. Mirrors `purchaseBorder` but routes to the parallel
 * `freeform_borders` catalog. Auto-equips on first purchase when the
 * identity has no border currently equipped (rank or freeform).
 */
export async function purchaseFreeformBorder(
  borderKey: string,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch(`/earning/me/freeform-borders/${encodeURIComponent(borderKey)}/purchase`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Set or clear per-identity color customization for an owned
 * free-form border. Map keys are CSS-var names WITHOUT the `--c-`
 * prefix (e.g. `{ "ring-main": "#ff10f0" }`); the server prepends
 * `--c-` and the renderer inlines them on the BorderedAvatar
 * wrapper. Pass `null` to clear all overrides. Server drops any
 * keys not in the catalog row's `extractFreeformBorderVars()` set,
 * so a stale client can't smuggle arbitrary CSS variables.
 */
export async function patchFreeformBorderConfig(
  borderKey: string,
  config: Record<string, string> | null,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch(`/earning/me/freeform-borders/${encodeURIComponent(borderKey)}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ config, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/* ---------- Self, name-style purchase / config / equip ---------- */

export async function purchaseNameStyle(
  styleKey: string,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch(`/earning/me/name-styles/${encodeURIComponent(styleKey)}/purchase`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function patchNameStyleConfig(
  styleKey: string,
  config: Record<string, unknown> | null,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch(`/earning/me/name-styles/${encodeURIComponent(styleKey)}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ config, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function setActiveNameStyle(
  styleKey: string | null,
  /** Per-identity scope. Null/undefined targets the master/OOC
   *  slot; pass a character id to write that character's slot. */
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch("/earning/me/active-name-style", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ styleKey, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function setInlineAvatarEnabled(
  enabled: boolean,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch("/earning/me/cosmetics/inline_avatar/equip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ enabled, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/* ---------- Admin, name styles CRUD ---------- */

export interface AdminNameStyleRow {
  key: string;
  name: string;
  description: string;
  template: string;
  styleCss: string;
  cost: number;
  enabled: boolean;
  isBuiltin: boolean;
  order: number;
  owners: number;
  equipped: number;
}

export async function fetchAdminNameStyles(): Promise<{ styles: AdminNameStyleRow[] }> {
  return jsonOrThrow(await fetch("/admin/earning/name-styles", { credentials: "include" }));
}

export async function createAdminNameStyle(body: {
  key: string;
  name: string;
  description?: string;
  template: string;
  styleCss?: string;
  cost?: number;
  enabled?: boolean;
  order?: number;
}): Promise<void> {
  const r = await fetch("/admin/earning/name-styles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function patchAdminNameStyle(key: string, body: {
  name?: string;
  description?: string;
  template?: string;
  styleCss?: string;
  cost?: number;
  enabled?: boolean;
  order?: number;
}): Promise<void> {
  const r = await fetch(`/admin/earning/name-styles/${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function deleteAdminNameStyle(key: string): Promise<void> {
  const r = await fetch(`/admin/earning/name-styles/${encodeURIComponent(key)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok) throw new Error(await readError(r));
}

/* ---------- Admin, free-form borders CRUD ---------- */

export interface AdminFreeformBorderRow {
  key: string;
  name: string;
  description: string;
  imageUrl: string | null;
  template: string | null;
  styleCss: string | null;
  rarity: string;
  cost: number;
  enabled: boolean;
  isBuiltin: boolean;
  order: number;
  owners: number;
  equipped: number;
}

export async function fetchAdminFreeformBorders(): Promise<{ borders: AdminFreeformBorderRow[] }> {
  return jsonOrThrow(await fetch("/admin/earning/freeform-borders", { credentials: "include" }));
}

export async function createAdminFreeformBorder(body: {
  key: string;
  name: string;
  description?: string;
  imageUrl?: string | null;
  template?: string | null;
  styleCss?: string | null;
  rarity?: string;
  cost?: number;
  enabled?: boolean;
  order?: number;
}): Promise<void> {
  const r = await fetch("/admin/earning/freeform-borders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function patchAdminFreeformBorder(key: string, body: {
  name?: string;
  description?: string;
  imageUrl?: string | null;
  template?: string | null;
  styleCss?: string | null;
  rarity?: string;
  cost?: number;
  enabled?: boolean;
  order?: number;
}): Promise<void> {
  const r = await fetch(`/admin/earning/freeform-borders/${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function deleteAdminFreeformBorder(key: string): Promise<void> {
  const r = await fetch(`/admin/earning/freeform-borders/${encodeURIComponent(key)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok) throw new Error(await readError(r));
}

/* ---------- Admin, test grants (masteradmin only) ----------
 *
 * Direct grants used for QA / asset preview. They write through
 * the same engine the live earn/purchase paths use (ledger + rank
 * resolver + socket events), so the dashboard wallet of the
 * recipient updates immediately. Username is the lookup key,
 * admins don't need to dig up the internal user id.
 */

export async function adminGrantXp(username: string, amount: number): Promise<void> {
  const r = await fetch("/admin/earning/grant-xp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, amount }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function adminGrantCurrency(username: string, amount: number): Promise<void> {
  const r = await fetch("/admin/earning/grant-currency", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, amount }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function adminSetRank(
  username: string,
  rankKey: string | null,
  tier: number | null,
): Promise<void> {
  const r = await fetch("/admin/earning/set-rank", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, rankKey, tier }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function adminGrantBorder(username: string, rankKey: string): Promise<void> {
  const r = await fetch("/admin/earning/grant-border", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, rankKey }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function adminGrantStyle(username: string, styleKey: string): Promise<void> {
  const r = await fetch("/admin/earning/grant-style", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, styleKey }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/** Remove ownership of a rank-tier border from the target user.
 *  If the user had it equipped, the equip slot clears too.
 *  Idempotent on unowned. Master-pool only, the server endpoint
 *  doesn't model per-character rank-border ownership today. */
export async function adminRevokeBorder(username: string, rankKey: string): Promise<void> {
  const r = await fetch("/admin/earning/revoke-border", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, rankKey }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/** Remove a name-style ownership row from the target user. If the
 *  style was equipped on the master active-cosmetics row it clears
 *  too. Idempotent on unowned. */
export async function adminRevokeStyle(username: string, styleKey: string): Promise<void> {
  const r = await fetch("/admin/earning/revoke-style", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, styleKey }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Insert ownership of a free-form (non-rank-tied) border on a
 * target identity. `characterId` null/omitted = master/OOC pool;
 * a character id grants to that character's ownership ledger.
 * Auto-equips on first acquisition if the identity has no
 * freeform border equipped.
 */
export async function adminGrantFreeformBorder(
  username: string,
  borderKey: string,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch("/admin/earning/grant-freeform-border", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, borderKey, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/** Remove a free-form border from a target identity. If equipped,
 *  the equip slot clears too. Idempotent. */
export async function adminRevokeFreeformBorder(
  username: string,
  borderKey: string,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch("/admin/earning/revoke-freeform-border", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, borderKey, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Admin moderation lever for the Phase 2 profile-banner Flair.
 * Wipes the banner URL on the target identity. Ownership of the
 * cosmetic is retained, the user can paste a new URL afterwards.
 * Passing `characterId` scopes to that character; null/omitted
 * clears the master/OOC banner.
 */
export async function adminClearProfileBanner(opts: {
  username: string;
  characterId?: string | null;
  reason?: string;
}): Promise<void> {
  const r = await fetch("/admin/earning/clear-banner", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      username: opts.username,
      ...(opts.characterId !== undefined ? { characterId: opts.characterId } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Admin moderation lever for the Phase 5 typing-phrase Flair.
 * Twin of `adminClearProfileBanner`; wipes the `typing_phrase`
 * column on the target identity. Ownership of the cosmetic is
 * retained.
 */
export async function adminClearTypingPhrase(opts: {
  username: string;
  characterId?: string | null;
  reason?: string;
}): Promise<void> {
  const r = await fetch("/admin/earning/clear-typing-phrase", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      username: opts.username,
      ...(opts.characterId !== undefined ? { characterId: opts.characterId } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Admin moderation lever for the migration 0161 room-presence Flair.
 * Clears BOTH the join and leave templates on the target identity in
 * a single call. Ownership of the cosmetic is retained.
 */
export async function adminClearRoomPresence(opts: {
  username: string;
  characterId?: string | null;
  reason?: string;
}): Promise<void> {
  const r = await fetch("/admin/earning/clear-room-presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      username: opts.username,
      ...(opts.characterId !== undefined ? { characterId: opts.characterId } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Admin moderation lever for the migration 0161 session-presence
 * Flair. Master-only, no characterId. Clears BOTH connect and
 * exit templates in a single call.
 */
export async function adminClearSessionPresence(opts: {
  username: string;
  reason?: string;
}): Promise<void> {
  const r = await fetch("/admin/earning/clear-session-presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      username: opts.username,
      ...(opts.reason ? { reason: opts.reason } : {}),
    }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/* ---------- Admin, cosmetics CRUD ---------- */

export interface AdminCosmeticRow {
  key: string;
  name: string;
  description: string;
  cost: number;
  enabled: boolean;
  configJson: string | null;
}

export async function fetchAdminCosmetics(): Promise<{ cosmetics: AdminCosmeticRow[] }> {
  return jsonOrThrow(await fetch("/admin/earning/cosmetics", { credentials: "include" }));
}

export async function patchAdminCosmetic(key: string, body: {
  name?: string;
  description?: string;
  cost?: number;
  enabled?: boolean;
  configJson?: string | null;
}): Promise<void> {
  const r = await fetch(`/admin/earning/cosmetics/${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function uploadRankAsset(dataUrl: string): Promise<string> {
  const r = await fetch("/admin/earning/assets/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ dataUrl }),
  });
  if (!r.ok) throw new Error(await readError(r));
  const j = (await r.json()) as { url: string };
  return j.url;
}

export async function putAdminAwards(config: EarningConfig): Promise<{ config: EarningConfig }> {
  const r = await fetch("/admin/earning/awards", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(config),
  });
  if (!r.ok) {
    // Special-case the masteradmin-only field-gated rejection so the
    // form can highlight the offending input.
    let body: { error?: string; fields?: string[] } = {};
    try { body = (await r.json()) as typeof body; } catch { /* fall back to text */ }
    const err = new Error(body.error ?? `${r.status} ${r.statusText}`) as Error & { fields?: string[] };
    if (body.fields) err.fields = body.fields;
    throw err;
  }
  return (await r.json()) as { config: EarningConfig };
}

/* ---------- Items, buy + admin CRUD + grants ---------- */

/**
 * Purchase `quantity` units of an item for the active identity.
 * `characterId` null / omitted = buy on the OOC master pool;
 * a character id buys on that character's pool. Server validates
 * partition ownership and stack cap.
 */
export async function buyItem(
  itemKey: string,
  quantity: number,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch(`/earning/me/items/${encodeURIComponent(itemKey)}/buy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ quantity, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export interface AdminItemRow {
  key: string;
  name: string;
  namePlural: string | null;
  description: string;
  iconUrl: string | null;
  price: number;
  stackLimit: number;
  giveMessages: string[];
  throwMessages: string[];
  dropMessages: string[];
  /** Casual-name aliases. Matched server-side in `findItem` so users
   *  can type "drink" / "tankard" for ale, "knife" for dagger, etc.
   *  Edited as comma-separated text in the admin UI. */
  aliases: string[];
  /** Shop bucket + pin-collection routing. */
  category: ItemCategory;
  enabled: boolean;
  forSale: boolean;
  saleStartsAt: number | null;
  saleEndsAt: number | null;
  order: number;
  isBuiltin: boolean;
  owners: number;
}

export async function fetchAdminItems(): Promise<{ items: AdminItemRow[] }> {
  return jsonOrThrow(await fetch("/admin/earning/items", { credentials: "include" }));
}

export async function createAdminItem(body: {
  key: string;
  name: string;
  namePlural?: string | null;
  description?: string;
  iconUrl?: string | null;
  price?: number;
  stackLimit?: number;
  giveMessages?: string[];
  throwMessages?: string[];
  dropMessages?: string[];
  aliases?: string[];
  category?: ItemCategory;
  enabled?: boolean;
  forSale?: boolean;
  saleStartsAt?: number | null;
  saleEndsAt?: number | null;
  order?: number;
}): Promise<void> {
  const r = await fetch("/admin/earning/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function patchAdminItem(key: string, body: {
  name?: string;
  namePlural?: string | null;
  description?: string;
  iconUrl?: string | null;
  price?: number;
  stackLimit?: number;
  giveMessages?: string[];
  throwMessages?: string[];
  dropMessages?: string[];
  aliases?: string[];
  category?: ItemCategory;
  enabled?: boolean;
  forSale?: boolean;
  saleStartsAt?: number | null;
  saleEndsAt?: number | null;
  order?: number;
}): Promise<void> {
  const r = await fetch(`/admin/earning/items/${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function deleteAdminItem(key: string): Promise<void> {
  const r = await fetch(`/admin/earning/items/${encodeURIComponent(key)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Masteradmin-only direct item grant. Positive quantity deposits,
 * negative revokes. `characterId` null/omitted = the target user's
 * OOC master inventory; otherwise the character must belong to the
 * target user. Bypasses the shop's enabled / forSale / sale-window
 * checks, so admins can pre-seed testers with items that aren't yet
 * on sale.
 */
export async function adminGrantItem(
  username: string,
  itemKey: string,
  quantity: number,
  characterId: string | null = null,
): Promise<{ ok: true; newQuantity: number }> {
  const r = await fetch("/admin/earning/grant-item", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, itemKey, quantity, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as { ok: true; newQuantity: number };
}

/**
 * Persist a diff-style update to the active identity's Collection.
 * The server treats each slot in `slots` independently, slots
 * not listed are left untouched. Pass `itemKey: null` to clear a
 * slot. Pinned items must still be held in the same identity's
 * inventory; the server rejects cross-identity pins.
 */
export async function setCollectionSlots(
  slots: Array<{ slot: number; itemKey: string | null }>,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch("/earning/me/collection", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ slots, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Twin of `setCollectionSlots` for the 5-slot Pet Collection. Pinned
 * items must have `category='pet'`; the server rejects mismatches.
 * `slot` is 0..4 here (vs 0..9 for the item collection).
 */
export async function setPetCollectionSlots(
  slots: Array<{ slot: number; itemKey: string | null }>,
  characterId: string | null = null,
): Promise<void> {
  const r = await fetch("/earning/me/pet-collection", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ slots, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/**
 * Set or clear the owner's nickname for the pet pinned in `slot`. Pass
 * `null` (or an empty string, server normalizes) to remove. Returns
 * the post-normalization nickname so the caller can sync local state
 * without re-fetching the whole earning snapshot.
 */
export async function setPetNickname(
  slot: number,
  nickname: string | null,
  characterId: string | null = null,
): Promise<{ slot: number; nickname: string | null }> {
  const r = await fetch(`/earning/me/pet-collection/${slot}/nickname`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ nickname, characterId }),
  });
  if (!r.ok) throw new Error(await readError(r));
  const j = (await r.json()) as { ok: true; slot: number; nickname: string | null };
  return { slot: j.slot, nickname: j.nickname };
}

/**
 * Render an item's display name with quantity-aware pluralization.
 * Falls back to `${name}s` when the row has no explicit plural form,
 * matching the server-side rule used by command rendering.
 */
export function formatItemName(item: { name: string; namePlural: string | null }, quantity: number): string {
  if (quantity === 1) return item.name;
  return item.namePlural ?? `${item.name}s`;
}

/**
 * Format a reason key from the ledger into something a human reads.
 * Used by the dashboard's ledger section + any other surface that
 * needs to render the audit row to the user.
 */
export function formatLedgerReason(reason: string): string {
  switch (reason) {
    case "message_say": return "Chat message";
    case "message_action": return "Action / scene / NPC";
    case "message_whisper": return "Whisper";
    case "forum_topic": return "Forum topic";
    case "forum_reply": return "Forum reply";
    case "presence_ic": return "Presence (in-character)";
    case "presence_ooc": return "Presence (OOC)";
    case "currency_send_out": return "Sent Currency";
    case "currency_send_in": return "Received Currency";
    case "backfill_message_xp": return "Historical backfill";
    case "admin_grant": return "Admin grant";
    case "admin_revoke": return "Admin revoke";
    case "character_deleted_currency_rollover": return "Rolled over from deleted character";
    default:
      // Friendlier labels for the Flair purchase keys before the
      // generic `purchase_` fallback catches them. Flair keys ship
      // with `flair_` prefixes that read poorly in raw form
      // ("Purchase: flair_typing_phrase").
      if (reason === "purchase_flair_profile_banner") return "Purchase: Custom Profile Banner";
      if (reason === "purchase_flair_typing_phrase") return "Purchase: Custom Typing Phrase";
      if (reason === "purchase_flair_profile_visitors") return "Purchase: Profile Visitor Counter";
      if (reason === "purchase_flair_profile_marquee") return "Purchase: Profile Quote Marquee";
      if (reason === "purchase_flair_reaction_sheet") return "Reaction sheet submission";
      // Reaction submission refund (Phase 3). Two parallel reasons:
      // the debit at submission time, the credit-back on rejection.
      // The submission id is part of the suffix but not interesting
      // to the user, surface a clean label.
      if (reason.startsWith("emoticon_submission_refund_")) return "Reaction sheet refund";
      if (reason.startsWith("emoticon_submission_")) return "Reaction sheet submission";
      if (reason.startsWith("purchase_")) return `Purchase: ${reason.slice("purchase_".length)}`;
      if (reason.startsWith("freeform_border_purchase_")) return `Border purchase: ${reason.slice("freeform_border_purchase_".length)}`;
      if (reason.startsWith("border_purchase_")) return `Border purchase: ${reason.slice("border_purchase_".length)}`;
      if (reason.startsWith("item_purchase_")) return `Item purchase: ${reason.slice("item_purchase_".length)}`;
      return reason;
  }
}

/**
 * Metadata-aware ledger label. Falls back to `formatLedgerReason`
 * for entries whose reason has no expected metadata shape; for the
 * item-command reasons it expands "command_give_received" into
 * "Received 2 × Cookie from WAS" so the recipient can tell at a
 * glance who gave them what (the bare reason string was opaque on
 * its own, which led to "who gave me this cookie?" support
 * questions). The metadata fields come from items.ts's INSERT
 * payloads (`fromDisplayName`, `targetDisplayName`, `itemKey`,
 * `quantity`).
 */
export function formatLedgerEntry(entry: LedgerEntry, itemCatalog?: ReadonlyMap<string, { name: string; namePlural: string | null }>): string {
  const meta = (entry.metadata ?? {}) as {
    itemKey?: string;
    quantity?: number;
    fromDisplayName?: string;
    targetDisplayName?: string;
  };
  const qty = typeof meta.quantity === "number" ? meta.quantity : null;
  const catRow = meta.itemKey ? itemCatalog?.get(meta.itemKey) : undefined;
  // Prefer catalog display name; fall back to the raw slug so an
  // item the admin renamed or deleted still surfaces something
  // legible. Pluralization mirrors items.ts: namePlural if set,
  // else "<name>s".
  const itemLabel = catRow
    ? (qty === 1 ? catRow.name : (catRow.namePlural ?? `${catRow.name}s`))
    : meta.itemKey ?? "(unknown item)";
  const qtyPrefix = qty != null ? `${qty} × ` : "";

  switch (entry.reason) {
    case "command_give":
      return meta.targetDisplayName
        ? `Gave ${qtyPrefix}${itemLabel} to ${meta.targetDisplayName}`
        : `Gave ${qtyPrefix}${itemLabel}`;
    case "command_give_received":
      return meta.fromDisplayName
        ? `Received ${qtyPrefix}${itemLabel} from ${meta.fromDisplayName}`
        : `Received ${qtyPrefix}${itemLabel}`;
    case "command_throw":
      return meta.targetDisplayName
        ? `Threw ${qtyPrefix}${itemLabel} at ${meta.targetDisplayName}`
        : `Threw ${qtyPrefix}${itemLabel}`;
    case "command_drop":
      return meta.targetDisplayName
        ? `Dropped ${qtyPrefix}${itemLabel} on ${meta.targetDisplayName}`
        : `Dropped ${qtyPrefix}${itemLabel}`;
    default:
      return formatLedgerReason(entry.reason);
  }
}
