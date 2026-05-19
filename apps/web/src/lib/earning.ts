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

export interface IdentityCosmetics {
  inlineAvatarEnabled: boolean;
  activeNameStyleKey: string | null;
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
  | "magic" | "treasure" | "building" | "gift" | "pet" | "misc";

/** Stable ordering for shop category chips. `misc` is last as the
 *  fallback bucket; `pet` is intentionally LAST among the "real"
 *  categories so casual visitors don't land on the pet bucket
 *  before browsing common items. */
export const ITEM_CATEGORIES: readonly ItemCategory[] = [
  "food", "drink", "joke", "tool", "weapon", "armor",
  "magic", "treasure", "building", "gift", "pet", "misc",
] as const;

/** Human-readable label for each category — used for shop-tab text. */
export const ITEM_CATEGORY_LABELS: Record<ItemCategory, string> = {
  food: "Food", drink: "Drinks", joke: "Joke", tool: "Tools",
  weapon: "Weapons", armor: "Armor", magic: "Magic", treasure: "Treasure",
  building: "Buildings", gift: "Gifts", pet: "Pets", misc: "Misc",
};

/**
 * Public-facing item catalog row. `purchasable` is server-derived
 * from `enabled && forSale && now ∈ [saleStartsAt, saleEndsAt)`. The
 * raw fields are also exposed so the UI can render the reason
 * something isn't purchasable (sale starts at X, sale ended at Y).
 * `availableCommands` mirrors which of give/throw/drop have non-empty
 * message arrays — the dashboard's command help uses it.
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
 * One pinned slot in an identity's Collection (Phase 3). Sparse —
 * a slot index in 0..9 with the chosen item key. The Collection
 * tab in the dashboard renders 10 slots and overlays the entries
 * indexed by `slot`.
 */
export interface CollectionEntry {
  slot: number;
  itemKey: string;
}

export interface EarningMeResponse {
  master: PoolView;
  characters: PoolView[];
  catalog: {
    ranks: RankRow[];
    rankTiers: RankTierRow[];
    nameStyles: NameStyleCatalogRow[];
    items: ItemCatalogRow[];
  };
  /** Master/OOC's owned styles (since migration 0086). Characters
   *  carry their own owned lists in `ownedStylesByCharacter`. */
  ownedStyles: OwnedStyle[];
  ownedBorders: OwnedBorder[];
  /** Per-character owned styles, keyed by character id. Empty entry
   *  / missing key means the character hasn't bought anything yet. */
  ownedStylesByCharacter: Record<string, OwnedStyle[]>;
  ownedBordersByCharacter: Record<string, OwnedBorder[]>;
  /** Master/OOC inventory — items owned on the OOC pool. Independent
   *  of every character's inventory (`inventoryByCharacter`). */
  inventory: InventoryEntry[];
  /** Per-character inventory keyed by character id. Each entry is
   *  fully isolated; nothing implicitly mirrors across identities. */
  inventoryByCharacter: Record<string, InventoryEntry[]>;
  /** Master/OOC Collection pins (Phase 3, 10-slot showcase). Sparse.
   *  Independent of every character's Collection — pins do not
   *  carry across identities. Items pinned here have category !=
   *  'pet'; pets live in `petCollection`. */
  collection: CollectionEntry[];
  /** Per-character Collection pins keyed by character id. */
  collectionByCharacter: Record<string, CollectionEntry[]>;
  /** Master/OOC Pet Collection pins (5-slot showcase). Only items
   *  with category='pet' are pinnable here — server enforces. */
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

export interface EarningConfig {
  enabled: boolean;
  awards: {
    message: { say: AwardAmount; action: AwardAmount; whisper: AwardAmount };
    forum: { topic: AwardAmount; reply: AwardAmount };
    presence: { perBlock: AwardAmount };
  };
  bodyFloorChars: number;
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
  /** Per-identity scope for border equip (selectedBorderRankKey).
   *  Hide flags ignore characterId — they're master-only privacy
   *  preferences. Null/omitted = master pool. */
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

export async function fetchPublicEarning(userId: string): Promise<PublicEarningResponse> {
  return jsonOrThrow<PublicEarningResponse>(await fetch(`/earning/users/${encodeURIComponent(userId)}`, { credentials: "include" }));
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

/* ---------- Self — cosmetic + border purchase / equip ---------- */

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

/* ---------- Self — name-style purchase / config / equip ---------- */

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

/* ---------- Admin — name styles CRUD ---------- */

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

/* ---------- Admin — test grants (masteradmin only) ----------
 *
 * Direct grants used for QA / asset preview. They write through
 * the same engine the live earn/purchase paths use (ledger + rank
 * resolver + socket events), so the dashboard wallet of the
 * recipient updates immediately. Username is the lookup key —
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

/* ---------- Admin — cosmetics CRUD ---------- */

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

/* ---------- Items — buy + admin CRUD + grants ---------- */

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
 * The server treats each slot in `slots` independently — slots
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
      if (reason.startsWith("purchase_")) return `Purchase: ${reason.slice("purchase_".length)}`;
      if (reason.startsWith("border_purchase_")) return `Border purchase: ${reason.slice("border_purchase_".length)}`;
      if (reason.startsWith("item_purchase_")) return `Item purchase: ${reason.slice("item_purchase_".length)}`;
      return reason;
  }
}
