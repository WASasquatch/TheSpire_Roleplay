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

export interface ActiveCosmetics {
  inlineAvatarEnabled: boolean;
  activeNameStyleKey: string | null;
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

export interface EarningMeResponse {
  master: PoolView;
  characters: PoolView[];
  catalog: { ranks: RankRow[]; rankTiers: RankTierRow[]; nameStyles: NameStyleCatalogRow[] };
  ownedStyles: OwnedStyle[];
  ownedBorders: OwnedBorder[];
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

export async function purchaseCosmetic(key: string): Promise<void> {
  const r = await fetch(`/earning/me/cosmetics/${encodeURIComponent(key)}/purchase`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function equipCosmetic(key: string, enabled: boolean): Promise<void> {
  const r = await fetch(`/earning/me/cosmetics/${encodeURIComponent(key)}/equip`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function purchaseBorder(rankKey: string): Promise<void> {
  const r = await fetch(`/earning/me/borders/${encodeURIComponent(rankKey)}/purchase`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(await readError(r));
}

/* ---------- Self — name-style purchase / config / equip ---------- */

export async function purchaseNameStyle(styleKey: string): Promise<void> {
  const r = await fetch(`/earning/me/name-styles/${encodeURIComponent(styleKey)}/purchase`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function patchNameStyleConfig(styleKey: string, config: Record<string, unknown> | null): Promise<void> {
  const r = await fetch(`/earning/me/name-styles/${encodeURIComponent(styleKey)}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ config }),
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function setActiveNameStyle(styleKey: string | null): Promise<void> {
  const r = await fetch("/earning/me/active-name-style", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ styleKey }),
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
      return reason;
  }
}
