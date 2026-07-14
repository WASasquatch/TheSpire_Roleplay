/**
 * Server Settings (per-server owner console — Multi-Server Lift, Track 1).
 *
 * The server-level analog of ForumSettingsView (ForumsCatalogModal.tsx). A
 * tabbed console the server OWNER (and mods, scoped to the granular grant they
 * hold) reach from the Server Rail's gear affordance, mounted as a modal by
 * App. Tabs gate exactly like the forum console: each tab is shown only when
 * the viewer holds the matching {@link ServerModPermission} (mirrored onto
 * {@link ServerViewerState.permissions}; the routes re-check every action).
 *
 * Tabs:
 *   - Overview     — name/tagline/join mode/public browsing (PATCH /servers/:id)
 *   - Appearance   — logo / icon color / palette + design (manage_appearance)
 *   - Rooms        — read-only list of the server's rooms (manage_rooms)
 *   - Members      — directory + promote/remove (manage_members)
 *   - Roles        — owner line, appoint admin (owner) / mod + grant grid
 *   - Usergroups   — CRUD + manual roster (manage_usergroups)
 *   - Applications — membership queue (manage_applications)
 *   - Bans         — ban/lift with duration (ban_member / unban_member)
 *   - Mod Log      — read-only audit feed (view_mod_log)
 *   - Settings     — welcome/rules/caps (GET/PATCH /servers/:id/settings)
 *
 * THEMING: while this modal is open, the server's palette/design is asserted
 * through the same scopedRootDesign / CSP-nonce path the forum catalog uses
 * (useScopedRootDesign) so it never bleeds into the viewer's own profile theme.
 *
 * This file is FLAG-OFF inert: it is only ever mounted by App when
 * branding.serversEnabled is true, from a rail that is itself flag-gated. With
 * the flag off the chat shell is byte-identical to today.
 *
 * Note: lib/servers.ts is shared with sibling tracks, so this file inlines its
 * own fetch helpers against the documented /servers endpoints rather than
 * widening that module.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowDown, ArrowUp, GripVertical, HelpCircle, Search } from "lucide-react";
import {
  DEFAULT_THEME,
  SERVER_MOD_PERMISSIONS,
  SERVER_GRANTABLE_MOD_PERMISSIONS,
  SERVER_MOD_PERMISSION_META,
  SERVER_MOD_DEFAULT_PERMISSIONS,
  SERVER_ADMIN_DEFAULT_PERMISSIONS,
  SERVER_FEATURE_PERMISSIONS,
  SERVER_FEATURE_PERMISSION_META,
  SERVER_AUTO_RULE_META,
  SERVER_MAX_AUTO_RULES,
  normalizeTheme,
  normalizeTag,
  MAX_TAGS_PER_ENTITY,
  AVATAR_CROP_DEFAULTS,
  type AvatarCrop,
  type Theme,
  type ServerModPermission,
  type ServerFeaturePermission,
  type ServerPermission,
  type ServerAutoRule,
  type ServerAutoRuleKind,
  type ServerRole,
  type ServerJoinMode,
  type ServerViewerState,
  type OnboardingConfig,
  type OnboardingPrompt,
  type OnboardingOption,
  type ProfileView,
  type RoomCategorySummary,
} from "@thekeep/shared";
import { FloatingWindow } from "../shared/FloatingWindow.js";
import { safeCssColor } from "../shared/RoleBadgeChips.js";
import { ContextualTour } from "../tours/ContextualTour.js";
import { BanModal } from "../moderation/BanModal.js";
import { ProfileModal } from "../profile/ProfileModal.js";
// Per-server admin tabs (Admin Partition — plan_ext.md). Self-contained tabs
// taking { serverId, viewer, busy, run, onSaved }.
import ReportsTab from "../server-admin/ReportsTab.js";
import ModCasesTab from "../server-admin/ModCasesTab.js";
import EmoticonsTab from "../server-admin/EmoticonsTab.js";
import AnnouncementsTab from "../server-admin/AnnouncementsTab.js";
import EventsTab from "../server-admin/EventsTab.js";
import FaqsTab from "../server-admin/FaqsTab.js";
import CommandsTitlesTab from "../server-admin/CommandsTitlesTab.js";
import EarningTab from "../server-admin/EarningTab.js";
import { StylePicker } from "../admin/AdminPanel.js";
// Find-a-setting (docs/ADMIN_IA.md §6): the console shares the Global Admin
// search component (chrome strings live in the admin namespace inside it)
// and the grouped-tab-strip helpers, so both surfaces read the same way.
import { FindSetting, afterNextPaint, flashAnchor } from "../admin/FindSetting.js";
import { groupVisibleTabs, withGroupSeparators } from "../shared/tabGroups.js";
import { ThemePicker } from "../cosmetics/ThemePicker.js";
import { useActiveTheme, useScopedRootDesign } from "../../lib/theme.js";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { recordNav } from "../../lib/nav-metrics.js";
import { parseDurationMs } from "../../lib/duration.js";
import { formatDate, formatDateTime } from "../../lib/intlFormat.js";
import { useChat } from "../../state/store.js";
import { i18n } from "../../lib/i18n.js";
import { ImageCropField } from "./ImageCropField.js";
import {
  SERVER_CONSOLE_SEARCH_ENTRIES,
  SERVER_CONSOLE_SEARCH_REDIRECTS,
  type ServerConsoleSearchEntry,
} from "./serverConsoleSearchIndex.js";

/* ============================================================
 * Wire shapes (consumed read-only from the documented endpoints).
 * Kept local because lib/servers.ts is a shared, do-not-touch module.
 * ============================================================ */

/** GET /servers/:id → server (the appearance/overview slice the console edits). */
interface ServerConsoleDetail {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  descriptionHtml: string | null;
  /** Owner-set genre/category tags for Discover search (normalizeTags). The
   *  backend always returns this (`[]` when none); the Overview tab edits it. */
  tags: string[];
  logoUrl: string | null;
  iconColor: string | null;
  borderColor: string | null;
  horizontalLogoUrl: string | null;
  iconCrop: AvatarCrop | null;
  bannerCrop: AvatarCrop | null;
  bannerImageUrl: string | null;
  bannerFocusY: number | null;
  bannerHeight: number | null;
  themeJson: string | null;
  themeStyleKey: string | null;
  isSystem: boolean;
  isDefault: boolean;
  status: string;
  visibility: string;
  joinMode: ServerJoinMode;
  publicBrowsing: boolean;
  applicationPrompt: string | null;
  /** Who may mint invite links (migration 0356). Absent (older backend) =
   *  staff-only, the historical behavior. */
  inviteCreateMode?: "staff" | "roles" | "all";
  /** Usergroup ids allowed to mint invites under the 'roles' mode. */
  inviteCreateGroupIds?: string[];
  /** Owner-set "18+ community" flag (age-restriction plan, Phase 2).
   *  Optional: absent until the backend populates it = all-ages. */
  isNsfw?: boolean;
  /** Public-safe banner variant for an 18+ server (shown to viewers who
   *  can't see NSFW on discovery/share surfaces). Null/absent = none. */
  sfwBannerUrl?: string | null;
  /** Community world link (migration 0346), resolved through the world's
   *  own visibility gates for the viewer. Null/absent = none — or a world
   *  this viewer can't open (fails toward "none" rather than leaking). */
  world?: { id: string; slug: string; name: string } | null;
  ownerUserId: string;
  ownerUsername: string;
  roomCount: number;
  memberCount: number;
  createdAt: number;
}

interface ServerMemberWire {
  userId: string;
  username: string;
  avatarUrl: string | null;
  role: ServerRole;
  permissions: ServerModPermission[];
  joinedAt: number;
}

interface ServerUserHit {
  userId: string;
  username: string;
  avatarUrl: string | null;
  serverRole: ServerRole | null;
  banned: boolean;
}

interface ServerUsergroupWire {
  id: string;
  name: string;
  color: string | null;
  /** Member-FEATURE perms only — moderation comes from the role tier. */
  permissions: ServerFeaturePermission[];
  isDefault: boolean;
  sortOrder: number;
  autoRules: ServerAutoRule[];
  memberCount: number;
  /** Self-role toggle (migration 0320): members may add/remove themselves. */
  memberSelectable: boolean;
  /** Member-facing blurb shown next to the self-role toggle / onboarding option. */
  description: string | null;
  /** Userlist badge opt-in (migration 0348): members wear the group's
   *  name/color as a chip in the server userlist. */
  showBadge: boolean;
}

interface ServerUsergroupMemberWire {
  userId: string;
  username: string;
  avatarUrl: string | null;
  isAuto: boolean;
  addedAt: number;
}

interface ServerMembershipApplicationWire {
  id: string;
  applicantUserId: string;
  applicantUsername: string;
  answer: string | null;
  status: string;
  submittedAt: number;
  reviewedAt: number | null;
  reviewedByUsername: string | null;
  reviewNote: string | null;
}

interface ServerBanWire {
  userId: string;
  username: string;
  until: number | null;
  reason: string | null;
  createdAt: number;
  expired: boolean;
}

/** GET /servers/:id/mutes → active server-wide mutes (account_mutes, scope="server"). */
interface ServerMuteWire {
  userId: string;
  username: string;
  until: number;
  reason: string | null;
  createdAt: number;
}

interface ServerModLogWire {
  id: string;
  action: string;
  actorUsername: string;
  targetUsername: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

interface ServerSettingsWire {
  messageRetentionMs: number | null;
  maxRoomsPerOwner: number | null;
  maxMessageLength: number | null;
  editGraceMs: number | null;
  rulesHtml: string | null;
  securityNoticeHtml: string | null;
  welcomeHtml: string | null;
  newUserWelcomeHtml: string | null;
  maxForumPostLength: number | null;
  /** Onboarding flow (migration 0320): stored OnboardingConfig JSON + master switch. */
  onboardingConfigJson: string | null;
  onboardingEnabled: boolean;
}

/** A room row off GET /rooms (the only rooms list available to the web). */
interface RoomListRow {
  id: string;
  name: string;
  serverId?: string | null;
  type?: string;
  topic?: string | null;
  messageExpiryMinutes?: number | null;
  /** When true the channel is exempt from the empty-room archival sweep. */
  persistent?: boolean;
  /** Effective 18+ rating (age-restriction plan, Phase 2); absent = all-ages. */
  isNsfw?: boolean;
  /** Set on forum BOARD rooms — managed by the forums system, not this tab. */
  forumId?: string | null;
  /** 18+ channel plumbing (lib/adultChannel.ts): a room whose
   *  `linkedSfwRoomId` is set IS a hidden 18+ channel (never listed here);
   *  a room with `linkedNsfwRoomId` HAS one (the editor's checkbox). */
  linkedSfwRoomId?: string | null;
  linkedNsfwRoomId?: string | null;
  /** Room icon: http(s) image URL or a short emoji glyph (dual form). */
  icon?: string | null;
  /** Rail section (migration 0344); null = the uncategorized bucket. */
  categoryId?: string | null;
  /** Who can post (migration 0345/0349); absent = "everyone". */
  postMode?: "everyone" | "staff" | "roles";
  /** "Never expire" opt-out (migration 0347); absent = false. */
  retentionExempt?: boolean;
  /** Per-room rich-text toggle (migration 0354); absent = full rich text. */
  richTextDisabled?: boolean;
  occupants?: unknown[];
}

/* ============================================================
 * Inline fetch helpers (do NOT widen lib/servers.ts).
 * ============================================================ */

async function jsonOrThrow<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as ({ error?: string } & T) | null;
  // Module-level fallback (no component t in scope): read the active language's
  // catalog through the shared i18n instance so the copy still localizes.
  if (!r.ok) throw new Error(j?.error ?? i18n.t("servers:console.requestFailed", { status: r.status }));
  return j as T;
}

const sid = (id: string) => encodeURIComponent(id);

async function apiGetServer(id: string): Promise<{ server: ServerConsoleDetail; viewer: ServerViewerState }> {
  return jsonOrThrow(await fetch(`/servers/${sid(id)}`, { credentials: "include" }));
}
async function apiPatchServer(id: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
/** Upload (or clear) the server's round icon / header banner / wordmark logo /
 *  public-safe banner. Mirrors the forum image endpoints;
 *  POST /servers/:id/logo|banner|horizontal-logo|sfw-banner. */
async function apiSetServerImage(id: string, kind: "logo" | "banner" | "horizontal-logo" | "sfw-banner", imageDataUrl: string | null): Promise<string | null> {
  const j = await jsonOrThrow<{ url: string | null }>(await fetch(`/servers/${sid(id)}/${kind}`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify(imageDataUrl ? { imageDataUrl } : { clear: true }),
  }));
  return j.url;
}
/** One option in the Overview tab's community-world picker. */
interface MyWorldOption {
  id: string;
  name: string;
  visibility: "private" | "public" | "open";
}
/** Worlds the caller owns or collaborates on (GET /me/worlds?collab=1) —
 *  the eligible set for the community-world picker; the route re-checks. */
async function apiGetMyWorlds(): Promise<MyWorldOption[]> {
  const j = await jsonOrThrow<{ worlds: MyWorldOption[] }>(await fetch("/me/worlds?collab=1", { credentials: "include" }));
  return j.worlds;
}
async function apiGetSettings(id: string): Promise<ServerSettingsWire> {
  const j = await jsonOrThrow<{ settings: ServerSettingsWire }>(await fetch(`/servers/${sid(id)}/settings`, { credentials: "include" }));
  return j.settings;
}
async function apiPatchSettings(id: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/settings`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiGetMembers(id: string): Promise<{ managerPermissions: ServerPermission[]; members: ServerMemberWire[] }> {
  return jsonOrThrow(await fetch(`/servers/${sid(id)}/members`, { credentials: "include" }));
}
async function apiSetRole(id: string, userId: string, role: ServerRole, permissions?: ServerModPermission[]): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/members/${sid(userId)}/role`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify({ role, ...(permissions ? { permissions } : {}) }),
  }));
}
async function apiSetModPermissions(id: string, userId: string, permissions: ServerModPermission[]): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/members/${sid(userId)}/permissions`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ permissions }),
  }));
}
async function apiRemoveMember(id: string, userId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/members/${sid(userId)}`, { method: "DELETE", credentials: "include" }));
}
async function apiUserSearch(id: string, q: string): Promise<ServerUserHit[]> {
  const j = await jsonOrThrow<{ hits: ServerUserHit[] }>(await fetch(`/servers/${sid(id)}/user-search?q=${encodeURIComponent(q)}`, { credentials: "include" }));
  return j.hits;
}
async function apiGetUsergroups(id: string): Promise<{ managerPermissions: ServerPermission[]; groups: ServerUsergroupWire[] }> {
  return jsonOrThrow(await fetch(`/servers/${sid(id)}/usergroups`, { credentials: "include" }));
}
async function apiCreateUsergroup(id: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/usergroups`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiPatchUsergroup(id: string, gid: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/usergroups/${sid(gid)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiDeleteUsergroup(id: string, gid: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/usergroups/${sid(gid)}`, { method: "DELETE", credentials: "include" }));
}
async function apiGetUsergroupMembers(id: string, gid: string): Promise<ServerUsergroupMemberWire[]> {
  const j = await jsonOrThrow<{ members: ServerUsergroupMemberWire[] }>(await fetch(`/servers/${sid(id)}/usergroups/${sid(gid)}/members`, { credentials: "include" }));
  return j.members;
}
async function apiAddUsergroupMember(id: string, gid: string, target: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/usergroups/${sid(gid)}/members`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ target }),
  }));
}
async function apiRemoveUsergroupMember(id: string, gid: string, userId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/usergroups/${sid(gid)}/members/${sid(userId)}`, { method: "DELETE", credentials: "include" }));
}
/** One invite link off GET /servers/:id/invites (live rows only). */
interface ServerInviteRow {
  code: string;
  /** Full shareable URL (origin + /i/<code>); null when the server couldn't
   *  resolve its origin — the row falls back to the browser's own origin. */
  link: string | null;
  maxUses: number | null;
  usedCount: number;
  expiresAt: number | null;
  createdAt: number;
  createdByUserId: string | null;
  createdByUsername: string | null;
}
async function apiGetInvites(id: string): Promise<ServerInviteRow[]> {
  const j = await jsonOrThrow<{ invites: ServerInviteRow[] }>(await fetch(`/servers/${sid(id)}/invites`, { credentials: "include" }));
  return j.invites;
}
async function apiCreateInvite(id: string, body: { maxUses?: number | null; expiresInHours?: number | null }): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/invites`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiRevokeInvite(id: string, code: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/invites/${sid(code)}`, { method: "DELETE", credentials: "include" }));
}
async function apiGetApplications(id: string): Promise<{ pending: ServerMembershipApplicationWire[]; recent: ServerMembershipApplicationWire[] }> {
  return jsonOrThrow(await fetch(`/servers/${sid(id)}/membership-applications`, { credentials: "include" }));
}
async function apiReviewApplication(id: string, appId: string, action: "approve" | "reject", reviewNote?: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/membership-applications/${sid(appId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify({ action, ...(reviewNote ? { reviewNote } : {}) }),
  }));
}
async function apiGetBans(id: string): Promise<ServerBanWire[]> {
  const j = await jsonOrThrow<{ bans: ServerBanWire[] }>(await fetch(`/servers/${sid(id)}/bans`, { credentials: "include" }));
  return j.bans;
}
async function apiBan(id: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/bans`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiLiftBan(id: string, userId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/bans/${sid(userId)}`, { method: "DELETE", credentials: "include" }));
}
async function apiGetMutes(id: string): Promise<ServerMuteWire[]> {
  const j = await jsonOrThrow<{ mutes: ServerMuteWire[] }>(await fetch(`/servers/${sid(id)}/mutes`, { credentials: "include" }));
  return j.mutes;
}
async function apiMute(id: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/mutes`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiUnmute(id: string, userId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/mutes/${sid(userId)}`, { method: "DELETE", credentials: "include" }));
}
async function apiGetModLog(id: string): Promise<ServerModLogWire[]> {
  const j = await jsonOrThrow<{ entries: ServerModLogWire[] }>(await fetch(`/servers/${sid(id)}/mod-log`, { credentials: "include" }));
  return j.entries;
}
async function apiTransfer(id: string, target: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/transfer`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ target }),
  }));
}
async function apiGetRooms(serverId: string): Promise<{ rooms: RoomListRow[]; categories: RoomCategorySummary[] }> {
  // /rooms?serverId returns this server's rooms (NULL-tolerant for the default
  // server) plus its rail sections (categories block, migration 0344); rows
  // carry serverId so the tab filters precisely.
  const j = await jsonOrThrow<{ rooms: RoomListRow[]; categories?: RoomCategorySummary[] }>(await fetch(`/rooms?serverId=${sid(serverId)}`, { credentials: "include" }));
  return { rooms: j.rooms, categories: j.categories ?? [] };
}
/** Per-server room admin (manage_rooms) — POST/PATCH/DELETE /servers/:id/rooms. */
async function apiCreateServerRoom(serverId: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/rooms`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiPatchServerRoom(serverId: string, roomId: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/rooms/${sid(roomId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
/** One usergroup option for the room editor's role pickers. */
interface RoomRoleGateGroup { id: string; name: string; color: string | null }
/** The room's current role gates (room_role_gates, migration 0349) plus the
 *  server's named usergroups to pick from. manage_rooms route. */
async function apiGetRoomRoleGates(serverId: string, roomId: string): Promise<{ groups: RoomRoleGateGroup[]; access: string[]; post: string[] }> {
  return jsonOrThrow(await fetch(`/servers/${sid(serverId)}/rooms/${sid(roomId)}/role-gates`, { credentials: "include" }));
}
async function apiDeleteServerRoom(serverId: string, roomId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/rooms/${sid(roomId)}`, { method: "DELETE", credentials: "include" }));
}
/** Room categories (rail sections, migration 0344) — manage_rooms routes. */
async function apiCreateRoomCategory(serverId: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/room-categories`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiPatchRoomCategory(serverId: string, catId: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/room-categories/${sid(catId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiDeleteRoomCategory(serverId: string, catId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/room-categories/${sid(catId)}`, { method: "DELETE", credentials: "include" }));
}
async function apiOrderRoomCategories(serverId: string, categoryIds: string[]): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/room-categories/order`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ categoryIds }),
  }));
}
/** Creation defaults (migration 0351): the per-category default flag, the
 *  role→category mappings, and the server's named usergroups for the picker. */
interface RoomCategoryDefaultsWire {
  categories: Array<{ id: string; isDefault: boolean }>;
  roleDefaults: Array<{ usergroupId: string; categoryId: string }>;
  groups: RoomRoleGateGroup[];
}
async function apiGetRoomCategoryDefaults(serverId: string): Promise<RoomCategoryDefaultsWire> {
  return jsonOrThrow<RoomCategoryDefaultsWire>(await fetch(`/servers/${sid(serverId)}/room-categories`, { credentials: "include" }));
}
async function apiSetRoomCategoryRoleDefaults(serverId: string, catId: string, usergroupIds: string[]): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/room-categories/${sid(catId)}/role-defaults`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ usergroupIds }),
  }));
}
async function apiOrderServerRooms(serverId: string, roomIds: string[]): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/rooms/order`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ roomIds }),
  }));
}

/* ============================================================
 * Shared small components
 * ============================================================ */

/** Avatar bubble (initials fallback) reused by member/applicant rows. */
function Avatar({ url, name }: { url: string | null; name: string }) {
  return url ? (
    <img src={url} alt="" className="h-7 w-7 shrink-0 rounded-full border border-keep-rule object-cover" referrerPolicy="no-referrer" />
  ) : (
    <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-keep-rule bg-keep-banner text-[9px] uppercase text-keep-muted">{name.slice(0, 2)}</span>
  );
}

/** Debounced user-search typeahead against /servers/:id/user-search. */
function ServerUserPicker({ serverId, placeholder, disabledReason, onSelect }: {
  serverId: string;
  placeholder?: string;
  disabledReason?: (hit: ServerUserHit) => string | null;
  onSelect: (hit: ServerUserHit) => void;
}) {
  const { t } = useTranslation("servers");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ServerUserHit[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const v = q.trim();
    if (v.length < 2) { setHits(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      apiUserSearch(serverId, v).then((h) => { if (alive) { setHits(h); setOpen(true); } }).catch(() => { if (alive) setHits([]); });
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q, serverId]);
  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => { if (hits) setOpen(true); }}
        placeholder={placeholder ?? t("console.userPicker.placeholder")}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
      />
      {open && hits ? (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded border border-keep-rule bg-keep-panel shadow-lg">
          {hits.length === 0 ? (
            <li className="px-2 py-1.5 text-xs italic text-keep-muted">{t("console.userPicker.noMatches")}</li>
          ) : hits.map((h) => {
            const reason = disabledReason?.(h) ?? null;
            return (
              <li key={h.userId}>
                <button
                  type="button"
                  disabled={!!reason}
                  onClick={() => { onSelect(h); setQ(""); setHits(null); setOpen(false); }}
                  className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm ${reason ? "cursor-not-allowed opacity-50" : "hover:bg-keep-banner"}`}
                >
                  <Avatar url={h.avatarUrl} name={h.username} />
                  <span className="min-w-0 flex-1 truncate text-keep-text">{h.username}</span>
                  {reason ? <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted">{reason}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Granular mod-permission checkbox grid (roles tab). Keys the acting manager
 *  doesn't hold are greyed out — the route clamps grants regardless. */
function ModPermissionCheckboxes({ value, onChange, grantable, disabled }: {
  value: ServerModPermission[];
  onChange: (next: ServerModPermission[]) => void;
  grantable: Set<ServerPermission>;
  disabled?: boolean;
}) {
  const { t } = useTranslation("servers");
  const has = new Set(value);
  return (
    <div className="grid grid-cols-1 gap-1 [@container(min-width:640px)]:grid-cols-2">
      {SERVER_GRANTABLE_MOD_PERMISSIONS.map((key) => {
        const meta = SERVER_MOD_PERMISSION_META[key];
        const canGrant = grantable.has(key);
        return (
          <label
            key={key}
            title={canGrant ? meta.description : t("console.perms.cantGrant")}
            className={`flex items-start gap-2 rounded border border-keep-rule/60 px-2 py-1 text-xs ${canGrant ? "" : "opacity-50"}`}
          >
            <input
              type="checkbox" className="mt-0.5" checked={has.has(key)} disabled={disabled || !canGrant}
              onChange={(e) => {
                const next = new Set(value);
                if (e.target.checked) next.add(key); else next.delete(key);
                onChange([...next]);
              }}
            />
            <span className="min-w-0">
              <span className="block text-keep-text">{meta.label}</span>
              <span className="block text-[10px] text-keep-muted">{meta.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Member-FEATURE checkbox grid for usergroups (the user-facing "Roles" tab).
 *  Usergroups grant member features only — moderation power comes from the
 *  staff tier (the Staff tab, id `roles`), never from a group, so a group
 *  can't silently mint a moderator. */
function ServerFeatureCheckboxes({ value, onChange, grantable, disabled }: {
  value: ServerFeaturePermission[];
  onChange: (next: ServerFeaturePermission[]) => void;
  grantable: Set<ServerPermission>;
  disabled?: boolean;
}) {
  const { t } = useTranslation("servers");
  const has = new Set(value);
  function toggle(key: ServerFeaturePermission, on: boolean) {
    const next = new Set(value);
    if (on) next.add(key); else next.delete(key);
    onChange([...next]);
  }
  return (
    <div className="grid grid-cols-1 gap-1 [@container(min-width:640px)]:grid-cols-2">
      {SERVER_FEATURE_PERMISSIONS.map((key) => {
        const meta = SERVER_FEATURE_PERMISSION_META[key];
        const canGrant = grantable.has(key);
        return (
          <label
            key={key}
            title={canGrant ? meta.description : t("console.perms.cantGrant")}
            className={`flex items-start gap-2 rounded border border-keep-rule/60 px-2 py-1 text-xs ${canGrant ? "" : "opacity-50"}`}
          >
            <input type="checkbox" className="mt-0.5" checked={has.has(key)} disabled={disabled || !canGrant}
              onChange={(e) => toggle(key, e.target.checked)} />
            <span className="min-w-0">
              <span className="block text-keep-text">{meta.label}</span>
              <span className="block text-[10px] text-keep-muted">{meta.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Auto-join rules editor (non-default usergroups). A member joins the group
 *  when they satisfy EVERY rule. Mirrors the forum AutoRulesEditor, with the
 *  server rule kinds (message count, posted-in-room, account/member age). */
function ServerAutoRulesEditor({ rules, onChange, rooms, disabled }: {
  rules: ServerAutoRule[];
  onChange: (next: ServerAutoRule[]) => void;
  rooms: RoomListRow[];
  disabled?: boolean;
}) {
  const { t } = useTranslation("servers");
  const KINDS: ServerAutoRuleKind[] = ["message_count", "posted_in_room", "account_age_days", "member_age_days"];
  function defaultFor(kind: ServerAutoRuleKind): ServerAutoRule {
    if (kind === "posted_in_room") return { kind, roomId: rooms[0]?.id ?? "" };
    return { kind, min: kind === "message_count" ? 10 : 7 };
  }
  function setRule(i: number, rule: ServerAutoRule) { const next = rules.slice(); next[i] = rule; onChange(next); }
  return (
    <div className="space-y-1.5">
      {rules.length === 0 ? (
        <p className="text-[11px] italic text-keep-muted">{t("console.autoRules.none")}</p>
      ) : null}
      {rules.map((rule, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5 rounded border border-keep-rule/60 px-2 py-1.5">
          <select
            value={rule.kind} disabled={disabled}
            onChange={(e) => setRule(i, defaultFor(e.target.value as ServerAutoRuleKind))}
            className="rounded border border-keep-rule bg-keep-bg px-1.5 py-1 text-xs outline-none focus:border-keep-action"
          >
            {KINDS.map((k) => <option key={k} value={k}>{SERVER_AUTO_RULE_META[k].label}</option>)}
          </select>
          {rule.kind === "posted_in_room" ? (
            <select
              value={rule.roomId} disabled={disabled}
              onChange={(e) => setRule(i, { kind: "posted_in_room", roomId: e.target.value })}
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-1.5 py-1 text-xs outline-none focus:border-keep-action"
            >
              {rooms.length === 0 ? <option value="">{t("console.autoRules.noRooms")}</option> : null}
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          ) : (
            <>
              <input
                type="number" min={1} value={rule.min} disabled={disabled}
                onChange={(e) => setRule(i, { kind: rule.kind, min: Math.max(1, Number(e.target.value) || 1) })}
                className="w-20 rounded border border-keep-rule bg-keep-bg px-1.5 py-1 text-xs outline-none focus:border-keep-action"
              />
              <span className="text-[11px] text-keep-muted">{SERVER_AUTO_RULE_META[rule.kind].unit}</span>
            </>
          )}
          <button type="button" disabled={disabled} onClick={() => onChange(rules.filter((_, j) => j !== i))}
            className="ml-auto shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("shared.remove")}</button>
        </div>
      ))}
      {rules.length < SERVER_MAX_AUTO_RULES ? (
        <button type="button" disabled={disabled} onClick={() => onChange([...rules, defaultFor("message_count")])}
          className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action">{t("console.autoRules.add")}</button>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Shared: Tags chip-input
 * ============================================================ */

/** Discovery-tag chip input: type a tag and Enter/comma to add a chip, click ×
 *  to remove. Each entry is cleaned through {@link normalizeTag} (empties and
 *  case-insensitive dupes are ignored) and the list is capped at
 *  {@link MAX_TAGS_PER_ENTITY}. The same control the forum settings use, so the
 *  two consoles match. */
function TagsInput({ value, onChange, disabled }: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("servers");
  const [draft, setDraft] = useState("");
  const atCap = value.length >= MAX_TAGS_PER_ENTITY;

  function add(raw: string) {
    const t = normalizeTag(raw);
    if (!t || atCap) return;
    if (value.includes(t)) { setDraft(""); return; }
    onChange([...value, t]);
    setDraft("");
  }
  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      // Backspace on an empty field pops the last chip (familiar chip-input UX).
      const last = value[value.length - 1];
      if (last) remove(last);
    }
  }

  return (
    <div className={`rounded border border-keep-rule bg-keep-bg px-2 py-1.5 ${disabled ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded border border-keep-rule bg-keep-panel/40 px-1.5 py-0.5 text-xs text-keep-text">
            {tag}
            <button type="button" disabled={disabled} onClick={() => remove(tag)}
              aria-label={t("console.tags.removeTag", { tag })} title={t("console.tags.removeTag", { tag })}
              className="text-keep-muted hover:text-keep-accent disabled:opacity-50">×</button>
          </span>
        ))}
        <input
          value={draft}
          disabled={disabled || atCap}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(draft)}
          maxLength={32}
          placeholder={atCap ? t("console.tags.limitReached") : value.length ? t("console.tags.addAnother") : t("console.tags.examples")}
          className="min-w-[8rem] flex-1 bg-transparent px-0.5 py-0.5 text-sm outline-none placeholder:text-keep-muted/70 disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
}

/* ============================================================
 * Tab: Overview
 * ============================================================ */

function OverviewTab({ detail, busy, run, onSaved }: TabProps) {
  const { t } = useTranslation("servers");
  const [name, setName] = useState(detail.name);
  const [tagline, setTagline] = useState(detail.tagline ?? "");
  const [description, setDescription] = useState(detail.descriptionHtml ?? "");
  const [tags, setTags] = useState<string[]>(detail.tags ?? []);
  const [joinMode, setJoinMode] = useState<ServerJoinMode>(detail.joinMode);
  const [prompt, setPrompt] = useState(detail.applicationPrompt ?? "");
  const [publicBrowsing, setPublicBrowsing] = useState(detail.publicBrowsing);
  const [isNsfw, setIsNsfw] = useState(detail.isNsfw ?? false);
  // Community world picker (migration 0346). Options = worlds the viewer
  // owns or collaborates on; the current link is seeded from the detail
  // (already resolved through the world's visibility gates server-side).
  const [worldId, setWorldId] = useState<string | null>(detail.world?.id ?? null);
  const [myWorlds, setMyWorlds] = useState<MyWorldOption[] | null>(null);
  // A failed fetch must not read as "you have no worlds": keep myWorlds null
  // (the select stays rendered-but-disabled, current link preserved) and
  // show a distinct load-error line instead of the empty-state copy.
  const [myWorldsError, setMyWorldsError] = useState(false);
  // Retry tick (the RoomEditForm gatesTick pattern): an inline "Try again"
  // re-runs the fetch without closing settings, which would drop unsaved
  // Overview edits.
  const [myWorldsTick, setMyWorldsTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setMyWorldsError(false);
    apiGetMyWorlds()
      .then((w) => { if (alive) setMyWorlds(w); })
      .catch(() => { if (alive) setMyWorldsError(true); });
    return () => { alive = false; };
  }, [myWorldsTick]);
  // Under-18 accounts never see the 18+ toggle at all (no dead control); the
  // server rejects the write regardless. Cosmetic mirror of the server gate.
  const isAdultViewer = useChat((s) => s.viewerAge.isAdult);

  const initialTags = detail.tags ?? [];
  const tagsDirty = tags.length !== initialTags.length || tags.some((t, i) => t !== initialTags[i]);
  const nsfwDirty = isNsfw !== (detail.isNsfw ?? false);
  const worldDirty = worldId !== (detail.world?.id ?? null);
  const dirty = name !== detail.name
    || tagline !== (detail.tagline ?? "")
    || description !== (detail.descriptionHtml ?? "")
    || tagsDirty
    || joinMode !== detail.joinMode
    || prompt !== (detail.applicationPrompt ?? "")
    || publicBrowsing !== detail.publicBrowsing
    || nsfwDirty
    || worldDirty;

  return (
    <div className="max-w-xl space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("console.overview.name")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("console.overview.tagline")}</span>
        <input value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={200}
          placeholder={t("console.overview.taglinePlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("console.overview.description")}</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} maxLength={5000}
          placeholder={t("console.overview.descriptionPlaceholder")}
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      </label>
      <div className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("console.overview.tags")}</span>
        <TagsInput value={tags} onChange={setTags} disabled={busy} />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          {t("console.overview.tagsHint")}
        </span>
      </div>

      {/* Community world (migration 0346): feature one of the viewer's own
          (or collaborated) worlds as the server's lore. The route re-checks
          ownership; a private pick simply won't show to people who can't
          open the world. data-admin-anchor = Find-a-setting jump target. */}
      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5" data-admin-anchor="console.overview.world">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("console.overview.world")}</span>
        {myWorldsError && !detail.world ? (
          <p className="text-xs text-keep-muted">
            {t("console.overview.worldLoadError")}{" "}
            <button type="button" onClick={() => setMyWorldsTick((n) => n + 1)}
              className="underline hover:text-keep-text">{t("console.rooms.roleGates.retry")}</button>
          </p>
        ) : myWorlds !== null && myWorlds.length === 0 && !detail.world ? (
          <p className="text-xs text-keep-muted">{t("console.overview.worldEmpty")}</p>
        ) : (
          <>
            <select
              value={worldId ?? ""}
              onChange={(e) => setWorldId(e.target.value || null)}
              disabled={busy || myWorlds === null}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
            >
              <option value="">{t("console.overview.worldNone")}</option>
              {/* Keep the CURRENT link selectable even when it isn't in the
                  picker set (e.g. staff-set), so opening the tab never
                  silently clears it. */}
              {detail.world && !(myWorlds ?? []).some((w) => w.id === detail.world!.id) ? (
                <option value={detail.world.id}>{detail.world.name}</option>
              ) : null}
              {(myWorlds ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {t(`worlds:visibilityValue.${w.visibility}`)}
                </option>
              ))}
            </select>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              {t("console.overview.worldHint")}
            </span>
          </>
        )}
      </div>

      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("console.overview.howPeopleJoin")}</span>
        {detail.isSystem ? (
          <p className="text-xs text-keep-muted">{t("console.overview.systemJoinNote")}</p>
        ) : (
          <>
            {(["open", "application", "invite"] as const).map((mode) => (
              <label key={mode} className="mt-1.5 flex items-start gap-2 text-sm">
                <input type="radio" name="joinMode" checked={joinMode === mode} onChange={() => setJoinMode(mode)} className="mt-0.5" />
                <span>
                  <span className="font-semibold capitalize text-keep-text">{t(`console.overview.mode.${mode}`)}</span>
                  <span className="block text-xs text-keep-muted">
                    {mode === "open" ? t("console.overview.modeOpenHint")
                      : mode === "application" ? t("console.overview.modeApplicationHint")
                      : t("console.overview.modeInviteHint")}
                  </span>
                </span>
              </label>
            ))}
            {joinMode === "application" ? (
              <label className="mt-2 block text-sm">
                <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("console.overview.applicationPrompt")}</span>
                <input value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={300}
                  placeholder={t("console.overview.applicationPromptPlaceholder")}
                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
              </label>
            ) : null}
          </>
        )}
      </div>

      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("console.overview.publicBrowsing")}</span>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={publicBrowsing} onChange={(e) => setPublicBrowsing(e.target.checked)} className="mt-0.5" />
          <span>
            <span className="font-semibold text-keep-text">{t("console.overview.publicBrowsingLabel")}</span>
            <span className="block text-xs text-keep-muted">
              {t("console.overview.publicBrowsingHint", { slug: detail.slug })}
            </span>
          </span>
        </label>
      </div>

      {/* 18+ community (age-restriction plan, Phase 2). Hidden entirely from
          under-18 viewers (never a dead toggle); the home/system server can't
          be 18+ by invariant, so it shows the explainer instead. The route
          re-checks adult + rights and rejects the system server regardless. */}
      {isAdultViewer ? (
        <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
          <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("console.overview.ageRating")}</span>
          {detail.isSystem ? (
            <p className="text-xs text-keep-muted">{t("console.overview.systemNsfwNote")}</p>
          ) : (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={isNsfw} onChange={(e) => setIsNsfw(e.target.checked)} className="mt-0.5" />
                <span>
                  <span className="font-semibold text-keep-text">{t("console.overview.nsfwLabel")}</span>
                  <span className="block text-xs text-keep-muted">
                    {t("console.overview.nsfwHint")}
                  </span>
                </span>
              </label>
              {isNsfw ? (
                <p className="mt-1.5 text-[10px] text-keep-muted">
                  {t("console.overview.nsfwTip")}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <p className="text-[11px] text-keep-muted">{t("console.overview.permanentAddress", { slug: detail.slug })}</p>

      <button
        type="button"
        disabled={!dirty || busy || name.trim().length < 3}
        onClick={() => {
          // Flipping a live community 18+ evicts its under-18 members on the
          // spot (server-side), so make the owner say it out loud first.
          if (nsfwDirty && isNsfw && !window.confirm(
            t("console.overview.nsfwConfirm", { name: detail.name }),
          )) return;
          void run(async () => {
            await apiPatchServer(detail.id, {
              name: name.trim(),
              tagline: tagline.trim() ? tagline.trim() : null,
              descriptionHtml: description.trim() ? description : null,
              tags,
              ...(detail.isSystem ? {} : { joinMode }),
              applicationPrompt: prompt.trim() ? prompt.trim() : null,
              publicBrowsing,
              // Only on change (and the toggle only renders for adults on
              // non-system servers), so an untouched save can never trip the
              // route's adult/system-server rejections.
              ...(nsfwDirty ? { isNsfw } : {}),
              // Only on change, so an untouched save never trips the route's
              // owns-or-collaborates world check on a staff-set link.
              ...(worldDirty ? { worldId } : {}),
            });
            onSaved();
          });
        }}
        className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
      >
        {t("shared.save")}
      </button>
    </div>
  );
}

/* ============================================================
 * Tab: Appearance (logo / icon color / palette + design)
 * ============================================================ */

function AppearanceTab({ detail, busy, run, onSaved }: TabProps) {
  const { t } = useTranslation("servers");
  // The public-safe banner slot only matters for an 18+ community (a SFW
  // server's normal banner must already be safe for everyone), and under-18
  // viewers never see 18+ controls. Cosmetic mirror; the route re-checks.
  const isAdultViewer = useChat((s) => s.viewerAge.isAdult);
  const initialTheme = useMemo<Theme | null>(() => {
    if (!detail.themeJson) return null;
    try { return normalizeTheme(JSON.parse(detail.themeJson)); } catch { return null; }
  }, [detail.themeJson]);
  const [theme, setTheme] = useState<Theme | null>(initialTheme);
  const [styleKey, setStyleKey] = useState<string | null>(detail.themeStyleKey);
  const [iconColor, setIconColor] = useState(detail.iconColor ?? "");
  const [borderColor, setBorderColor] = useState(detail.borderColor ?? "");

  // Crop state is seeded from the saved detail; ImageCropField is controlled by
  // these. onCropChange updates local state immediately (so dragging feels live);
  // the explicit Save button below persists it.
  const [iconCrop, setIconCrop] = useState<AvatarCrop>(detail.iconCrop ?? AVATAR_CROP_DEFAULTS);
  const [bannerCrop, setBannerCrop] = useState<AvatarCrop>(detail.bannerCrop ?? AVATAR_CROP_DEFAULTS);
  // Top-bar banner height (px); null = the default responsive height.
  const [bannerHeight, setBannerHeight] = useState<number | null>(detail.bannerHeight);
  const bannerHeightDirty = bannerHeight !== detail.bannerHeight;
  // The banner preview mirrors the ACTUAL top bar: same aspect = full window
  // width (the bar spans it) ÷ the banner height. So `object-cover` crops the
  // same slice the top bar will, making positioning WYSIWYG. Clamped so an
  // extreme width:height never collapses the preview to an unusable sliver.
  const topBarAspect = Math.max(5, Math.min(22,
    (typeof window !== "undefined" ? window.innerWidth : 1280) / (bannerHeight ?? 96)));

  const themeDirty = JSON.stringify(theme) !== JSON.stringify(initialTheme);
  const styleDirty = styleKey !== detail.themeStyleKey;
  const colorDirty = iconColor !== (detail.iconColor ?? "");
  const borderDirty = borderColor !== (detail.borderColor ?? "");

  /** Upload an icon/banner/wordmark/public-banner image (read → POST → refetch); errors via run. */
  function uploadImage(kind: "logo" | "banner" | "horizontal-logo" | "sfw-banner", dataUrl: string) {
    void run(async () => { await apiSetServerImage(detail.id, kind, dataUrl); onSaved(); });
  }
  function clearImage(kind: "logo" | "banner" | "horizontal-logo" | "sfw-banner") {
    void run(async () => { await apiSetServerImage(detail.id, kind, null); onSaved(); });
  }

  // Explicit crop save (NO silent auto-save): dirtiness compares the live crop to
  // the saved detail (or the identity default when unset), and an in-field "Save
  // position" button writes it. This gives the owner clear control + a visible
  // error if the save fails, and survives the close/reopen the old debounce
  // silently lost.
  const cropEq = (a: AvatarCrop, b: AvatarCrop) =>
    a.zoom === b.zoom && a.offsetX === b.offsetX && a.offsetY === b.offsetY;
  const iconCropDirty = !cropEq(iconCrop, detail.iconCrop ?? AVATAR_CROP_DEFAULTS);
  const bannerCropDirty = !cropEq(bannerCrop, detail.bannerCrop ?? AVATAR_CROP_DEFAULTS);
  function saveCrop(which: "icon" | "banner") {
    void run(async () => {
      await apiPatchServer(detail.id, which === "icon" ? { iconCrop } : { bannerCrop });
      onSaved();
    });
  }

  return (
    <div className="max-w-xl space-y-4">
      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.appearance.icon")}</p>
        <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
          <ImageCropField
            shape="circle"
            label={t("console.appearance.icon")}
            url={detail.logoUrl}
            crop={iconCrop}
            maxBytes={512 * 1024}
            busy={busy}
            onPickFile={(dataUrl) => uploadImage("logo", dataUrl)}
            onClear={() => clearImage("logo")}
            onCropChange={setIconCrop}
            cropDirty={iconCropDirty}
            savingCrop={busy}
            onSaveCrop={() => saveCrop("icon")}
            hint={t("console.appearance.iconHint")}
          />
          <div className="flex flex-wrap items-center gap-3 border-t border-keep-rule/60 pt-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("console.appearance.fallbackColor")}</span>
              <input type="color" value={iconColor || "#8a66cc"} onChange={(e) => setIconColor(e.target.value)}
                title={t("console.appearance.fallbackColorTitle")} className="h-7 w-9 shrink-0 cursor-pointer rounded border border-keep-rule bg-transparent" />
              {iconColor ? (
                <button type="button" onClick={() => setIconColor("")}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("console.appearance.clear")}</button>
              ) : null}
              {colorDirty ? (
                <button type="button" disabled={busy}
                  onClick={() => void run(async () => { await apiPatchServer(detail.id, { iconColor: iconColor.trim() || null }); onSaved(); })}
                  className="rounded border border-keep-action bg-keep-action px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("console.appearance.saveColor")}</button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("console.appearance.borderColor")}</span>
              <input type="color" value={borderColor || "#8a66cc"} onChange={(e) => setBorderColor(e.target.value)}
                title={t("console.appearance.borderColorTitle")} className="h-7 w-9 shrink-0 cursor-pointer rounded border border-keep-rule bg-transparent" />
              {borderColor ? (
                <button type="button" onClick={() => setBorderColor("")}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("console.appearance.clear")}</button>
              ) : null}
              {borderDirty ? (
                <button type="button" disabled={busy}
                  onClick={() => void run(async () => { await apiPatchServer(detail.id, { borderColor: borderColor.trim() || null }); onSaved(); })}
                  className="rounded border border-keep-action bg-keep-action px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("console.appearance.saveBorder")}</button>
              ) : null}
            </div>
          </div>
          <p className="text-[10px] text-keep-muted">{t("console.appearance.colorsHint")}</p>
        </div>
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.appearance.banner")}</p>
        <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
          <ImageCropField
            shape="rect"
            fullWidth
            aspect={topBarAspect}
            label={t("console.appearance.banner")}
            url={detail.bannerImageUrl}
            crop={bannerCrop}
            maxBytes={2 * 1024 * 1024}
            busy={busy}
            onPickFile={(dataUrl) => uploadImage("banner", dataUrl)}
            onClear={() => clearImage("banner")}
            onCropChange={setBannerCrop}
            cropDirty={bannerCropDirty}
            savingCrop={busy}
            onSaveCrop={() => saveCrop("banner")}
            hint={t("console.appearance.bannerHint")}
          />
          {/* Top-bar banner height: tune the band's height in the top bar when
              the default doesn't suit the art. Off = the default responsive height. */}
          <div className="space-y-1 border-t border-keep-rule/60 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted">{t("console.appearance.topBarHeight")}</span>
              <input
                type="range"
                min={48}
                max={240}
                step={4}
                value={bannerHeight ?? 96}
                onChange={(e) => setBannerHeight(Number(e.target.value))}
                disabled={busy}
                className="h-1 min-w-0 flex-1 cursor-pointer accent-keep-action"
              />
              <span className="shrink-0 tabular-nums text-[10px] text-keep-muted">{bannerHeight == null ? t("console.appearance.auto") : t("console.appearance.px", { n: bannerHeight })}</span>
              {bannerHeight != null ? (
                <button type="button" onClick={() => setBannerHeight(null)}
                  className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("console.appearance.default")}</button>
              ) : null}
              {bannerHeightDirty ? (
                <button type="button" disabled={busy}
                  onClick={() => void run(async () => { await apiPatchServer(detail.id, { bannerHeight }); onSaved(); })}
                  className="shrink-0 rounded border border-keep-action bg-keep-action px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("console.appearance.saveHeight")}</button>
              ) : null}
            </div>
            <p className="text-[10px] text-keep-muted">{t("console.appearance.topBarHeightHint")}</p>
          </div>
        </div>
      </section>

      {/* Public-safe banner (age-restriction plan, Phase 2, decision #10):
          only offered on an 18+ community — a SFW server's regular banner
          must already be safe for everyone — and never shown to under-18
          viewers. No crop is persisted (mirrors the wordmark slot). */}
      {isAdultViewer && (detail.isNsfw ?? false) ? (
        <section>
          <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.appearance.publicBannerSection")}</p>
          <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
            <ImageCropField
              shape="rect"
              fullWidth
              aspect={topBarAspect}
              label={t("console.appearance.publicBanner")}
              url={detail.sfwBannerUrl ?? null}
              crop={AVATAR_CROP_DEFAULTS}
              maxBytes={2 * 1024 * 1024}
              busy={busy}
              onPickFile={(dataUrl) => uploadImage("sfw-banner", dataUrl)}
              onClear={() => clearImage("sfw-banner")}
              onCropChange={() => { /* no crop persisted for the public banner */ }}
              hint={t("console.appearance.publicBannerHint")}
            />
          </div>
        </section>
      ) : null}

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.appearance.wordmark")}</p>
        <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
          <ImageCropField
            shape="rect"
            aspect={5}
            label={t("console.appearance.wordmark")}
            url={detail.horizontalLogoUrl}
            crop={AVATAR_CROP_DEFAULTS}
            previewWidth={280}
            maxBytes={1024 * 1024}
            busy={busy}
            onPickFile={(dataUrl) => uploadImage("horizontal-logo", dataUrl)}
            onClear={() => clearImage("horizontal-logo")}
            onCropChange={() => { /* no crop persisted for the wordmark */ }}
            hint={t("console.appearance.wordmarkHint")}
          />
        </div>
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.appearance.theme")}</p>
        <p className="mb-2 text-[11px] text-keep-muted">{t("console.appearance.themeHint")}</p>
        {theme === null ? (
          <button type="button" onClick={() => setTheme(DEFAULT_THEME)}
            className="rounded border border-keep-rule bg-keep-banner px-2 py-1 text-xs hover:bg-keep-banner/80">{t("console.appearance.addTheme")}</button>
        ) : (
          <>
            <ThemePicker theme={theme} onChange={(next) => setTheme(next)} onReset={() => setTheme(DEFAULT_THEME)} />
            <button type="button" onClick={() => setTheme(null)}
              className="mt-2 rounded border border-keep-accent/40 bg-keep-bg px-2 py-1 text-[11px] text-keep-accent hover:bg-keep-accent/10">{t("console.appearance.removeTheme")}</button>
          </>
        )}
        {themeDirty ? (
          <button type="button" disabled={busy}
            onClick={() => void run(async () => { await apiPatchServer(detail.id, { themeJson: theme ? JSON.stringify(theme) : null }); onSaved(); })}
            className="ml-2 mt-2 rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("console.appearance.saveTheme")}</button>
        ) : null}
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.appearance.designStyle")}</p>
        <p className="mb-2 text-[11px] text-keep-muted">
          {t("console.appearance.designStyleHint")}
        </p>
        <StylePicker value={styleKey} onChange={setStyleKey} allowInherit />
        {styleDirty ? (
          <button type="button" disabled={busy}
            onClick={() => void run(async () => { await apiPatchServer(detail.id, { themeStyleKey: styleKey }); onSaved(); })}
            className="mt-2 rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("console.appearance.saveStyle")}</button>
        ) : null}
      </section>
    </div>
  );
}

/* ============================================================
 * Tab: Rooms (read-only list)
 * ============================================================ */

/** Small up/down arrow pair used by the category strip and the per-room
 *  reorder controls. Icon-only, so each button carries title + aria-label. */
function MoveArrows({ busy, canUp, canDown, onMove, upLabel, downLabel }: {
  busy: boolean; canUp: boolean; canDown: boolean; onMove: (dir: -1 | 1) => void; upLabel: string; downLabel: string;
}) {
  const cls = "shrink-0 rounded border border-keep-rule p-0.5 text-keep-muted hover:border-keep-action hover:text-keep-action disabled:opacity-40 disabled:hover:border-keep-rule disabled:hover:text-keep-muted";
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <button type="button" disabled={busy || !canUp} onClick={() => onMove(-1)} title={upLabel} aria-label={upLabel} className={cls}>
        <ArrowUp className="h-3 w-3" aria-hidden="true" />
      </button>
      <button type="button" disabled={busy || !canDown} onClick={() => onMove(1)} title={downLabel} aria-label={downLabel} className={cls}>
        <ArrowDown className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
}

/** Nearest scrollable ancestor — the container edge-scrolled mid-drag so a
 *  long list can be traversed in one gesture. */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el; n; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === "auto" || oy === "scroll") return n;
    }
  }
  return null;
}

/**
 * Pointer-drag reordering for the category strip and the room buckets — the
 * desktop upgrade over MoveArrows (which stay: they are the keyboard /
 * mobile / screen-reader path). One gesture owned by a single pointerId,
 * driven by WINDOW-level move/up/cancel listeners rather than pointer
 * capture: the drag reorders the keyed row list in place, so React moves
 * the dragged row's DOM node mid-gesture, and a moved node loses pointer
 * capture (the spec clears capture on removal) — element-level handlers
 * would strand the drag. The listeners detach when the gesture ends (any
 * outcome) and on unmount, so a lost gesture can't linger. While dragging,
 * the list reorders in place immediately (no animation, so it's calm under
 * Reduce Motion by construction) and the new order persists ONCE on drop,
 * through the same PUT route the arrows use. Gestures are hit-tested per
 * `scope` (one per bucket) so a drag can never cross from one bucket into
 * another.
 */
function useDragReorder({ disabled, onDrop }: {
  disabled: boolean;
  onDrop: (scope: string, ids: string[]) => void;
}) {
  // The optimistic display order for the bucket that owns it. Kept after the
  // drop until the parent's refetch lands (see reset) so the list doesn't
  // snap back to the stale order while the PUT + refetch are in flight.
  const [preview, setPreview] = useState<{ scope: string; order: string[] } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const gestureRef = useRef<{ pointerId: number; scope: string; id: string; order: string[]; base: string; moved: boolean; scroller: HTMLElement | null; detach: () => void } | null>(null);
  // The window listeners outlive the render that attached them; route the
  // drop through a ref so it never fires a stale closure.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  /** Adopt a refetch: the server order now includes the drop, so the
   *  optimistic preview is redundant. No-op while a gesture is live. */
  const reset = useCallback(() => {
    if (!gestureRef.current) { setPreview(null); setDraggingId(null); }
  }, []);

  // Unmount mid-drag must not leave window listeners behind.
  useEffect(() => () => { gestureRef.current?.detach(); gestureRef.current = null; }, []);

  const finish = useCallback((e: PointerEvent, commit: boolean) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    gestureRef.current = null;
    g.detach();
    setDraggingId(null);
    if (commit && g.moved && g.order.join("\n") !== g.base) onDropRef.current(g.scope, g.order);
    else setPreview(null);
  }, []);

  const onWindowMove = useCallback((e: PointerEvent) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    // Edge auto-scroll: browsers only auto-scroll native HTML5 drags, so
    // nudge the scrollable ancestor while the pointer rides its edges to
    // let long-distance drags finish in one gesture.
    if (g.scroller) {
      const r = g.scroller.getBoundingClientRect();
      if (e.clientY < r.top + 24) g.scroller.scrollTop -= 8;
      else if (e.clientY > r.bottom - 24) g.scroller.scrollTop += 8;
    }
    // elementFromPoint sees the row under the cursor; matching on this
    // gesture's scope keeps the reorder inside its own bucket.
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(`[data-drag-scope="${g.scope}"]`);
    const overId = over?.getAttribute("data-drag-id");
    if (!overId || overId === g.id) return;
    const from = g.order.indexOf(g.id);
    const to = g.order.indexOf(overId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...g.order];
    next.splice(from, 1);
    next.splice(to, 0, g.id);
    g.order = next;
    g.moved = true;
    setPreview({ scope: g.scope, order: next });
  }, []);
  const onWindowUp = useCallback((e: PointerEvent) => finish(e, true), [finish]);
  const onWindowCancel = useCallback((e: PointerEvent) => finish(e, false), [finish]);

  return {
    draggingId,
    reset,
    /** The bucket's display order: the live/optimistic preview when this
     *  scope owns it, else the server order the caller passed. */
    orderFor: (scope: string, ids: string[]) => (preview && preview.scope === scope ? preview.order : ids),
    /** Hit-test markers; stamp on every row of the bucket. */
    rowProps: (scope: string, id: string) => ({ "data-drag-scope": scope, "data-drag-id": id }),
    gripProps: (scope: string, ids: string[], id: string) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        // Primary button only, never mid-gesture (a second pointer can't
        // hijack or strand an active drag).
        if (disabled || gestureRef.current || e.button !== 0) return;
        const detach = () => {
          window.removeEventListener("pointermove", onWindowMove);
          window.removeEventListener("pointerup", onWindowUp);
          window.removeEventListener("pointercancel", onWindowCancel);
        };
        gestureRef.current = {
          pointerId: e.pointerId, scope, id, order: [...ids], base: ids.join("\n"), moved: false,
          scroller: findScrollParent(e.currentTarget as HTMLElement), detach,
        };
        window.addEventListener("pointermove", onWindowMove);
        window.addEventListener("pointerup", onWindowUp);
        window.addEventListener("pointercancel", onWindowCancel);
        setDraggingId(id);
        setPreview({ scope, order: [...ids] });
        e.preventDefault();
      },
    }),
  };
}

/** The drag affordance: a subtle grip glyph. A span, not a button —
 *  keyboard users reorder with the MoveArrows beside it — and desktop-only
 *  (hidden below sm) since touch keeps the arrows. touch-none stops a
 *  stray touch-drag from scrolling mid-gesture. */
function DragGrip({ title, active, handlers }: {
  title: string;
  active: boolean;
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  };
}) {
  // aria-hidden, not aria-label: the span is unfocusable and role-less, so a
  // label is invalid ARIA — assistive tech reorders via the MoveArrows.
  return (
    <span
      {...handlers}
      title={title}
      aria-hidden="true"
      className={`hidden shrink-0 touch-none select-none rounded p-0.5 sm:inline-flex ${active ? "cursor-grabbing text-keep-action" : "cursor-grab text-keep-muted/60 hover:text-keep-action"}`}
    >
      <GripVertical className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

/** Room/category icon preview — the same URL-vs-glyph duality the rail and
 *  Room Info bar apply to `rooms.icon`. */
function RoomIconGlyph({ icon }: { icon: string | null | undefined }) {
  if (!icon) return null;
  return /^https?:\/\//i.test(icon) ? (
    <img src={icon} alt="" className="h-4 w-4 shrink-0 rounded object-cover" referrerPolicy="no-referrer" />
  ) : (
    <span aria-hidden className="shrink-0 text-sm leading-none">{icon}</span>
  );
}

/** One editable category row: rename + icon + save/delete. Reordering is
 *  handled by the parent (it owns the strip order). */
function RoomCategoryRow({ detail, cat, busy, run, onChanged }: {
  detail: ServerConsoleDetail; cat: RoomCategorySummary; busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>; onChanged: () => void;
}) {
  const { t } = useTranslation("servers");
  const [name, setName] = useState(cat.name);
  const [icon, setIcon] = useState(cat.icon ?? "");
  // Resync after a parent refetch replaces the row (the key is cat.id, so a
  // rename saved elsewhere must land in these fields too).
  useEffect(() => { setName(cat.name); setIcon(cat.icon ?? ""); }, [cat.name, cat.icon]);
  const dirty = name.trim() !== cat.name || (icon.trim() || null) !== (cat.icon ?? null);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <RoomIconGlyph icon={cat.icon} />
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
        aria-label={t("console.rooms.categories.nameLabel")}
        className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action" />
      <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={500}
        aria-label={t("console.rooms.iconLabel")} title={t("console.rooms.iconHint")}
        placeholder={t("console.rooms.iconPlaceholder")}
        className="w-28 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs outline-none focus:border-keep-action" />
      <button type="button" disabled={busy || !dirty || !name.trim()}
        onClick={() => void run(async () => {
          await apiPatchRoomCategory(detail.id, cat.id, { name: name.trim(), icon: icon.trim() ? icon.trim() : null });
          onChanged();
        })}
        className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action disabled:opacity-40">
        {t("shared.save")}
      </button>
      <button type="button" disabled={busy}
        onClick={() => { if (window.confirm(t("console.rooms.categories.deleteConfirm", { name: cat.name }))) void run(async () => { await apiDeleteRoomCategory(detail.id, cat.id); onChanged(); }); }}
        className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">
        {t("shared.delete")}
      </button>
    </div>
  );
}

/** Category strip manager: create / rename / re-icon / delete / reorder the
 *  rail sections (room_categories, migration 0344), plus the creation
 *  defaults (migration 0351): the single server-wide default category and
 *  the per-role mappings. manage_rooms routes. */
function RoomCategoriesManager({ detail, categories, busy, run, onChanged }: {
  detail: ServerConsoleDetail; categories: RoomCategorySummary[]; busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>; onChanged: () => void;
}) {
  const { t } = useTranslation("servers");
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState("");
  // Creation defaults ride a separate manage_rooms feed (GET /room-categories).
  // `categories` is a fresh array on every parent refetch, so keying the
  // effect on it keeps the defaults in step with strip edits and saves.
  const [defaults, setDefaults] = useState<RoomCategoryDefaultsWire | null>(null);
  useEffect(() => {
    let alive = true;
    apiGetRoomCategoryDefaults(detail.id)
      .then((d) => { if (alive) setDefaults(d); })
      .catch(() => { if (alive) setDefaults(null); });
    return () => { alive = false; };
  }, [detail.id, categories]);
  const isDefaultCat = (catId: string) => !!defaults?.categories.find((c) => c.id === catId)?.isDefault;
  const roleIdsFor = (catId: string) =>
    new Set((defaults?.roleDefaults ?? []).filter((m) => m.categoryId === catId).map((m) => m.usergroupId));
  // Single-winner default: promoting one category demotes the previous
  // holder optimistically (the route does the same in one request). The
  // refetch runs on failure too (run() swallows the rejection into the error
  // banner) so a rejected write snaps the optimistic state back to server
  // truth.
  const setDefaultCategory = (catId: string, next: boolean) => {
    setDefaults((d) => d ? {
      ...d,
      categories: d.categories.map((c) => ({ ...c, isDefault: next ? c.id === catId : (c.id === catId ? false : c.isDefault) })),
    } : d);
    void run(async () => { await apiPatchRoomCategory(detail.id, catId, { isDefault: next }); }).finally(() => onChanged());
  };
  // One category per role: ticking a role here steals it from whichever
  // category held it (PK upsert server-side; mirrored optimistically). Same
  // failure-resync `.finally` as above.
  const toggleRoleDefault = (catId: string, groupId: string) => {
    const next = roleIdsFor(catId);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setDefaults((d) => d ? {
      ...d,
      roleDefaults: [
        ...d.roleDefaults.filter((m) => m.usergroupId !== groupId),
        ...(next.has(groupId) ? [{ usergroupId: groupId, categoryId: catId }] : []),
      ],
    } : d);
    void run(async () => { await apiSetRoomCategoryRoleDefaults(detail.id, catId, [...next]); }).finally(() => onChanged());
  };
  // Drag-to-reorder (desktop) alongside the arrows (keyboard/mobile). Both
  // persist through the same PUT /room-categories/order route. The refetch
  // runs on failure too (run() swallows the rejection into the error banner)
  // so a rejected PUT snaps the optimistic preview back to server order.
  const drag = useDragReorder({
    disabled: busy,
    onDrop: (_scope, ids) => { void run(async () => { await apiOrderRoomCategories(detail.id, ids); }).finally(() => onChanged()); },
  });
  const dragReset = drag.reset;
  useEffect(() => { dragReset(); }, [categories, dragReset]);
  const catScope = `cats:${detail.id}`;
  const catById = new Map(categories.map((c) => [c.id, c]));
  const ordered = drag.orderFor(catScope, categories.map((c) => c.id))
    .map((id) => catById.get(id))
    .filter((c): c is RoomCategorySummary => !!c);
  const moveCategory = (index: number, dir: -1 | 1) => {
    const ids = ordered.map((c) => c.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + dir, 0, id!);
    void run(async () => { await apiOrderRoomCategories(detail.id, ids); onChanged(); });
  };
  return (
    <div data-admin-anchor="console.rooms.categories.title" className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-keep-muted">{t("console.rooms.categories.title")}</p>
      <p className="text-[10px] text-keep-muted">{t("console.rooms.categories.hint")}</p>
      {ordered.length > 0 && defaults ? (
        <p className="text-[10px] text-keep-muted">{t("console.rooms.categories.defaultsHint")}</p>
      ) : null}
      {ordered.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{t("console.rooms.categories.none")}</p>
      ) : (
        <ul data-admin-anchor="console.rooms.categories.defaultLabel" className="space-y-1.5">
          {ordered.map((c, i) => (
            <li key={c.id} {...drag.rowProps(catScope, c.id)}
              className={`rounded ${drag.draggingId === c.id ? "bg-keep-action/10" : ""}`}>
              <div className="flex items-center gap-1.5">
                <DragGrip title={t("console.rooms.dragToReorder")} active={drag.draggingId === c.id}
                  handlers={drag.gripProps(catScope, ordered.map((x) => x.id), c.id)} />
                <MoveArrows busy={busy} canUp={i > 0} canDown={i < ordered.length - 1}
                  onMove={(dir) => moveCategory(i, dir)}
                  upLabel={t("console.rooms.categories.moveUp")} downLabel={t("console.rooms.categories.moveDown")} />
                {isDefaultCat(c.id) ? (
                  <span className="shrink-0 rounded border border-keep-action/60 px-1 text-[9px] uppercase tracking-widest text-keep-action">
                    {t("console.rooms.categories.defaultChip")}
                  </span>
                ) : null}
                <RoomCategoryRow detail={detail} cat={c} busy={busy} run={run} onChanged={onChanged} />
              </div>
              {defaults ? (
                <div className="mb-1 mt-1 space-y-1 pl-12">
                  <label className="flex w-fit cursor-pointer items-center gap-1.5 text-[10px] text-keep-muted"
                    title={t("console.rooms.categories.defaultHint")}>
                    <input type="checkbox" className="h-3 w-3" disabled={busy}
                      checked={isDefaultCat(c.id)}
                      onChange={(e) => setDefaultCategory(c.id, e.target.checked)} />
                    {t("console.rooms.categories.defaultLabel")}
                  </label>
                  {defaults.groups.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-keep-muted"
                      role="group" aria-label={t("console.rooms.categories.rolesLabel")}
                      title={t("console.rooms.categories.rolesHint")}>
                      <span>{t("console.rooms.categories.rolesLabel")}</span>
                      {defaults.groups.map((g) => {
                        const color = safeCssColor(g.color);
                        const on = roleIdsFor(c.id).has(g.id);
                        return (
                          <label key={g.id}
                            className={`inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 ${
                              on
                                ? "border-keep-action bg-keep-action/10 text-keep-text"
                                : "border-keep-rule bg-keep-bg text-keep-muted hover:border-keep-action/60 hover:text-keep-text"
                            }`}>
                            <input type="checkbox" className="h-3 w-3" disabled={busy}
                              checked={on} onChange={() => toggleRoleDefault(c.id, g.id)} />
                            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-keep-muted/60"
                              style={color ? { background: color } : undefined} />
                            {g.name}
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5 border-t border-keep-rule/60 pt-2">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40}
          placeholder={t("console.rooms.categories.namePlaceholder")}
          aria-label={t("console.rooms.categories.nameLabel")}
          className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action" />
        <input value={newIcon} onChange={(e) => setNewIcon(e.target.value)} maxLength={500}
          placeholder={t("console.rooms.iconPlaceholder")}
          aria-label={t("console.rooms.iconLabel")} title={t("console.rooms.iconHint")}
          className="w-28 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs outline-none focus:border-keep-action" />
        <button type="button" disabled={busy || !newName.trim()}
          onClick={() => void run(async () => {
            await apiCreateRoomCategory(detail.id, { name: newName.trim(), ...(newIcon.trim() ? { icon: newIcon.trim() } : {}) });
            setNewName(""); setNewIcon("");
            onChanged();
          })}
          className="shrink-0 rounded border border-keep-action bg-keep-action px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
          {t("console.rooms.categories.add")}
        </button>
      </div>
    </div>
  );
}

function RoomsTab({ detail, busy, run }: TabProps) {
  const { t } = useTranslation("servers");
  const [rooms, setRooms] = useState<RoomListRow[] | null>(null);
  const [categories, setCategories] = useState<RoomCategorySummary[]>([]);
  const [tick, setTick] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    apiGetRooms(detail.id)
      .then(({ rooms: rs, categories: cats }) => {
        if (!alive) return;
        // Two partitions stay OUT of this tab: forum BOARDS (rooms with a
        // forumId — the forums system manages those, and deleting one here
        // would maim a forum) and hidden 18+ CHANNELS (linkedSfwRoomId —
        // they're a facet of their base room, toggled via its editor).
        const managed = rs.filter((r) => !r.forumId && !r.linkedSfwRoomId);
        const tagged = managed.filter((r) => r.serverId != null);
        setRooms(tagged.length ? tagged.filter((r) => r.serverId === detail.id) : managed);
        setCategories(cats);
      })
      .catch(() => { if (alive) { setRooms([]); setCategories([]); } });
    return () => { alive = false; };
  }, [detail.id, tick]);

  const refresh = () => setTick((t) => t + 1);

  // Group the list the way the rail does: each category in strip order, then
  // the uncategorized bucket LAST. /rooms already delivers rows sorted by
  // (category, manual order, name), so each bucket keeps the server's order.
  const buckets = useMemo(() => {
    const catIds = new Set(categories.map((c) => c.id));
    const by = new Map<string, RoomListRow[]>();
    for (const r of rooms ?? []) {
      const key = r.categoryId && catIds.has(r.categoryId) ? r.categoryId : "";
      const arr = by.get(key);
      if (arr) arr.push(r);
      else by.set(key, [r]);
    }
    return by;
  }, [rooms, categories]);

  // Move a room one slot within its bucket by re-stamping the whole bucket's
  // manual order (sortOrder = index) in one request.
  const moveRoom = (bucket: RoomListRow[], index: number, dir: -1 | 1) => {
    const ids = bucket.map((r) => r.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + dir, 0, id!);
    void run(async () => { await apiOrderServerRooms(detail.id, ids); refresh(); });
  };

  // Drag-to-reorder within a bucket (desktop) alongside the arrows; persists
  // through the same PUT /rooms/order route (sortOrder = index). The refetch
  // runs on failure too (run() swallows the rejection into the error banner)
  // so a rejected PUT snaps the optimistic preview back to server order.
  const drag = useDragReorder({
    disabled: busy,
    onDrop: (_scope, ids) => { void run(async () => { await apiOrderServerRooms(detail.id, ids); }).finally(() => refresh()); },
  });
  const dragReset = drag.reset;
  useEffect(() => { dragReset(); }, [rooms, dragReset]);
  const bucketScope = (categoryId: string) => `bucket:${detail.id}:${categoryId}`;
  const orderedBucket = (scope: string, bucket: RoomListRow[]) => {
    const byId = new Map(bucket.map((r) => [r.id, r]));
    return drag.orderFor(scope, bucket.map((r) => r.id))
      .map((id) => byId.get(id))
      .filter((r): r is RoomListRow => !!r);
  };

  const roomRow = (r: RoomListRow, bucket: RoomListRow[], i: number, scope: string) => (
    <li key={r.id} {...drag.rowProps(scope, r.id)}
      className={`rounded border bg-keep-panel/30 px-2.5 py-1.5 ${drag.draggingId === r.id ? "border-keep-action" : "border-keep-rule"}`}>
      <div className="flex items-center gap-2">
        <DragGrip title={t("console.rooms.dragToReorder")} active={drag.draggingId === r.id}
          handlers={drag.gripProps(scope, bucket.map((x) => x.id), r.id)} />
        <MoveArrows busy={busy} canUp={i > 0} canDown={i < bucket.length - 1}
          onMove={(dir) => moveRoom(bucket, i, dir)}
          upLabel={t("console.rooms.moveUp")} downLabel={t("console.rooms.moveDown")} />
        <RoomIconGlyph icon={r.icon} />
        <span className="min-w-0 flex-1 truncate text-sm text-keep-text">
          {r.name}
          {r.type === "private" ? <span className="ml-1.5 rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted">{t("console.rooms.privateChip")}</span> : null}
          {/* 18+ marker (age-restriction plan, Phase 2) so a flip is
              visible in this list the moment it saves. Mirrors the
              admin Banned badge red — a warning on every palette. */}
          {r.isNsfw ? <span className="ml-1.5 rounded border border-[#e06070] px-1 text-[9px] font-semibold uppercase tracking-widest text-[#e06070]">{t("console.rooms.nsfwChip")}</span> : null}
          {/* The room carries a hidden 18+ channel behind its
              SFW/18+ toggle (managed via the editor's checkbox). */}
          {r.linkedNsfwRoomId ? <span className="ml-1.5 rounded border border-[#e06070]/60 px-1 text-[9px] font-semibold uppercase tracking-widest text-[#e06070]/80">{t("console.rooms.adultChannelChip")}</span> : null}
        </span>
        {Array.isArray(r.occupants) ? <span className="shrink-0 text-[10px] text-keep-muted">{t("console.rooms.occupantsHere", { count: r.occupants.length })}</span> : null}
        <button type="button" disabled={busy} onClick={() => { setEditingId((id) => (id === r.id ? null : r.id)); setCreating(false); }}
          className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action">
          {editingId === r.id ? t("console.rooms.done") : t("shared.edit")}</button>
        <button type="button" disabled={busy}
          onClick={() => { if (window.confirm(t("console.rooms.deleteConfirm", { name: r.name }))) void run(async () => { await apiDeleteServerRoom(detail.id, r.id); refresh(); }); }}
          className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("shared.delete")}</button>
      </div>
      {editingId === r.id ? (
        <RoomEditForm detail={detail} room={r} categories={categories} busy={busy} run={run}
          onSaved={() => { setEditingId(null); refresh(); }} />
      ) : null}
    </li>
  );

  const uncategorized = buckets.get("") ?? [];

  return (
    <div className="max-w-xl space-y-3">
      <p className="text-[11px] text-keep-muted">
        <Trans t={t} i18nKey="console.rooms.blurb" components={{ cmd: <span className="text-keep-text" /> }} />
      </p>

      <RoomCategoriesManager detail={detail} categories={categories} busy={busy} run={run} onChanged={refresh} />

      {/* The find-a-setting anchor lives on this always-mounted wrapper (not
          the loaded list) so the search jump's scroll+flash has a target even
          while the room fetch is in flight or comes back empty — and the
          heading gives the search hit a visible on-page counterpart. */}
      <div data-admin-anchor="console.rooms.orderTitle" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-keep-muted">{t("console.rooms.orderTitle")}</p>
          <button type="button" data-tour="server-settings-rooms-create" onClick={() => { setCreating((c) => !c); setEditingId(null); }}
            className="shrink-0 rounded border border-keep-action bg-keep-action px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg">
            {creating ? t("shared.cancel") : t("console.rooms.newRoom")}
          </button>
        </div>
      {creating ? (
        <RoomCreateForm detail={detail} categories={categories} busy={busy} run={run}
          onCreated={() => { setCreating(false); refresh(); }} />
      ) : null}
      {!rooms ? (
        <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>
      ) : rooms.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{t("console.rooms.none")}</p>
      ) : (
        <div className="space-y-3">
          {/* Each category in strip order, then the uncategorized bucket
              last (labeled in the rail too whenever categories render) —
              the exact grouping members see. */}
          {categories.map((c) => {
            const scope = bucketScope(c.id);
            const bucket = orderedBucket(scope, buckets.get(c.id) ?? []);
            return (
              <div key={c.id} className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-keep-muted">
                  <RoomIconGlyph icon={c.icon} />
                  <span className="min-w-0 truncate">{c.name}</span>
                </p>
                {bucket.length === 0 ? (
                  <p className="text-[10px] italic text-keep-muted">{t("console.rooms.categories.emptyBucket")}</p>
                ) : (
                  <ul className="space-y-1.5">{bucket.map((r, i) => roomRow(r, bucket, i, scope))}</ul>
                )}
              </div>
            );
          })}
          {uncategorized.length > 0 ? (
            <div className="space-y-1.5">
              {categories.length > 0 ? (
                <p className="text-[10px] uppercase tracking-widest text-keep-muted">{t("console.rooms.categories.uncategorizedHeading")}</p>
              ) : null}
              {(() => {
                const scope = bucketScope("");
                const bucket = orderedBucket(scope, uncategorized);
                return <ul className="space-y-1.5">{bucket.map((r, i) => roomRow(r, bucket, i, scope))}</ul>;
              })()}
            </div>
          ) : null}
        </div>
      )}
      </div>
    </div>
  );
}

/** Inline "new room" form for the Rooms tab. */
function RoomCreateForm({ detail, categories, busy, run, onCreated }: { detail: ServerConsoleDetail; categories: RoomCategorySummary[]; busy: boolean; run: (fn: () => Promise<void>) => Promise<void>; onCreated: () => void }) {
  const { t } = useTranslation("servers");
  const [name, setName] = useState("");
  const [type, setType] = useState<"public" | "private">("public");
  const [password, setPassword] = useState("");
  const [topic, setTopic] = useState("");
  const [icon, setIcon] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [persistent, setPersistent] = useState(true);
  const [nsfw, setNsfw] = useState(false);
  const [adultChannel, setAdultChannel] = useState(false);
  // Who can post (migration 0345): "staff" creates an announcements-style
  // info room where only staff post and everyone else reads + reacts.
  const [postMode, setPostMode] = useState<"everyone" | "staff">("everyone");
  // Text formatting (migration 0354): "simple" hides the composer's
  // rich-only controls (headings, alignment) in this room.
  const [richText, setRichText] = useState<"full" | "simple">("full");
  // 18+ room checkbox (age-restriction plan, Phase 2): hidden from under-18
  // viewers entirely (the route rejects the write regardless), and moot
  // inside an 18+ community, where every room is 18+ by the server flag.
  const isAdultViewer = useChat((s) => s.viewerAge.isAdult);
  const serverIsNsfw = detail.isNsfw ?? false;
  const canSave = name.trim().length >= 1 && (type === "public" || password.length >= 1);
  return (
    <div className="space-y-2 rounded border border-keep-action/40 bg-keep-panel/20 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={t("console.rooms.namePlaceholder")}
          className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
        <select value={type} onChange={(e) => setType(e.target.value as "public" | "private")}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm">
          <option value="public">{t("console.rooms.public")}</option>
          <option value="private">{t("console.rooms.private")}</option>
        </select>
      </div>
      {type === "private" ? (
        <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} placeholder={t("console.rooms.passwordPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      ) : null}
      <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} placeholder={t("console.rooms.topicPlaceholder")}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      <div className="flex flex-wrap items-center gap-2">
        <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={500}
          placeholder={t("console.rooms.iconPlaceholder")} title={t("console.rooms.iconHint")}
          aria-label={t("console.rooms.iconLabel")}
          className="w-40 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
        {categories.length > 0 ? (
          /* "" = automatic (field omitted → the server applies the role /
             server creation defaults, migration 0351); "none" = an explicit
             null, which beats every default. */
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
            aria-label={t("console.rooms.categoryLabel")} title={t("console.rooms.categoryCreateHint")}
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm">
            <option value="">{t("console.rooms.categories.autoOption")}</option>
            <option value="none">{t("console.rooms.categories.uncategorized")}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        ) : null}
      </div>
      <label className="block text-xs">
        <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.rooms.postModeLabel")}</span>
        <select value={postMode} onChange={(e) => setPostMode(e.target.value as "everyone" | "staff")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm">
          <option value="everyone">{t("console.rooms.postModeEveryone")}</option>
          <option value="staff">{t("console.rooms.postModeStaff")}</option>
        </select>
        {/* Hint shown unconditionally, matching the room editor's rendering
            of the same setting. */}
        <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.postModeHint")}</span>
      </label>
      <label className="block text-xs">
        <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.rooms.richTextLabel")}</span>
        <select value={richText} onChange={(e) => setRichText(e.target.value as "full" | "simple")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm">
          <option value="full">{t("console.rooms.richTextFull")}</option>
          <option value="simple">{t("console.rooms.richTextSimple")}</option>
        </select>
        <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.richTextHint")}</span>
      </label>
      <label className="flex items-start gap-2 text-xs text-keep-text">
        <input type="checkbox" className="mt-0.5" checked={persistent} onChange={(e) => setPersistent(e.target.checked)} />
        <span>
          <span className="block">{t("console.rooms.keepWhenEmpty")}</span>
          <span className="block text-[10px] text-keep-muted">{t("console.rooms.keepWhenEmptyCreateHint")}</span>
        </span>
      </label>
      {isAdultViewer && !serverIsNsfw ? (
        <label className="flex items-start gap-2 text-xs text-keep-text">
          <input type="checkbox" className="mt-0.5" checked={nsfw} onChange={(e) => setNsfw(e.target.checked)} />
          <span>
            <span className="block">{t("console.rooms.nsfwRoom")}</span>
            <span className="block text-[10px] text-keep-muted">{t("console.rooms.nsfwCreateHint")}</span>
          </span>
        </label>
      ) : isAdultViewer && serverIsNsfw ? (
        <p className="text-[10px] text-keep-muted">{t("console.rooms.allNsfwNote")}</p>
      ) : null}
      {/* 18+ CHANNEL at create time — same visibility rules as the editor's
          checkbox (adults, all-ages community, room itself not 18+, public). */}
      {isAdultViewer && !serverIsNsfw && !nsfw && type === "public" ? (
        <label className="flex items-start gap-2 text-xs text-keep-text">
          <input type="checkbox" className="mt-0.5" checked={adultChannel} onChange={(e) => setAdultChannel(e.target.checked)} />
          <span>
            <span className="block">{t("console.rooms.adultChannel")}</span>
            <span className="block text-[10px] text-keep-muted">{t("console.rooms.adultChannelHint")}</span>
          </span>
        </label>
      ) : null}
      <div className="flex justify-end">
        <button type="button" disabled={busy || !canSave}
          onClick={() => void run(async () => {
            await apiCreateServerRoom(detail.id, { name: name.trim(), type, persistent, ...(postMode === "staff" ? { postMode } : {}), ...(richText === "simple" ? { richTextDisabled: true } : {}), ...(nsfw ? { isNsfw: true } : {}), ...(adultChannel && !nsfw && type === "public" ? { adultChannel: true } : {}), ...(type === "private" ? { password } : {}), ...(topic.trim() ? { topic: topic.trim() } : {}), ...(icon.trim() ? { icon: icon.trim() } : {}), ...(categoryId === "none" ? { categoryId: null } : categoryId ? { categoryId } : {}) });
            onCreated();
          })}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("console.rooms.createRoom")}</button>
      </div>
    </div>
  );
}

/** Checkbox strip of the server's named usergroups, shared by the room
 *  editor's two role pickers (who-can-see / who-can-post). Each chip shows
 *  the group's color dot; empty servers get a pointer to the Usergroups
 *  tab instead of a dead control. */
function RoleGateCheckList({ groups, selected, onToggle, ariaLabel }: {
  groups: RoomRoleGateGroup[]; selected: Set<string>; onToggle: (id: string) => void; ariaLabel: string;
}) {
  const { t } = useTranslation("servers");
  if (groups.length === 0) {
    return <p className="mt-1 text-[10px] italic text-keep-muted">{t("console.rooms.roleGates.noGroups")}</p>;
  }
  return (
    <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label={ariaLabel}>
      {groups.map((g) => {
        const color = safeCssColor(g.color);
        return (
          <label
            key={g.id}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-xs ${
              selected.has(g.id)
                ? "border-keep-action bg-keep-action/10 text-keep-text"
                : "border-keep-rule bg-keep-bg text-keep-muted hover:border-keep-action/60 hover:text-keep-text"
            }`}
          >
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={selected.has(g.id)}
              onChange={() => onToggle(g.id)}
            />
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full bg-keep-muted/60"
              style={color ? { background: color } : undefined}
            />
            {g.name}
          </label>
        );
      })}
    </div>
  );
}

/** Inline per-room editor (name / topic / icon / category / who-can-see /
 *  who-can-post / message lifetime). */
function RoomEditForm({ detail, room, categories, busy, run, onSaved }: { detail: ServerConsoleDetail; room: RoomListRow; categories: RoomCategorySummary[]; busy: boolean; run: (fn: () => Promise<void>) => Promise<void>; onSaved: () => void }) {
  const { t } = useTranslation("servers");
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic ?? "");
  const [icon, setIcon] = useState(room.icon ?? "");
  const [categoryId, setCategoryId] = useState(room.categoryId ?? "");
  // Message lifetime is a 3-way policy (migration 0347): inherit the server
  // retention window / a custom per-room minutes value / never expire. The
  // minutes input only applies to the custom mode.
  const initialLifetime: "inherit" | "custom" | "never" = room.retentionExempt
    ? "never"
    : room.messageExpiryMinutes != null && room.messageExpiryMinutes > 0
      ? "custom"
      : "inherit";
  const [lifetime, setLifetime] = useState<"inherit" | "custom" | "never">(initialLifetime);
  const [expiry, setExpiry] = useState<string>(
    room.messageExpiryMinutes != null && room.messageExpiryMinutes > 0 ? String(room.messageExpiryMinutes) : "",
  );
  // Who can post (migrations 0345/0349).
  const [postMode, setPostMode] = useState<"everyone" | "staff" | "roles">(room.postMode ?? "everyone");
  // Text formatting (migration 0354): "simple" hides the composer's
  // rich-only controls (headings, alignment) in this room.
  const [richText, setRichText] = useState<"full" | "simple">(room.richTextDisabled ? "simple" : "full");
  // Per-role room gates (room_role_gates, migration 0349), lazily fetched
  // with the editor: the server's named usergroups + this room's current
  // access/post rows. `gates` null = still loading (role controls hidden).
  const [gates, setGates] = useState<{ groups: RoomRoleGateGroup[]; access: string[]; post: string[] } | null>(null);
  const [gatesFailed, setGatesFailed] = useState(false);
  const [gatesTick, setGatesTick] = useState(0);
  const [accessMode, setAccessMode] = useState<"everyone" | "roles">("everyone");
  const [accessIds, setAccessIds] = useState<Set<string>>(new Set());
  const [postIds, setPostIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    setGatesFailed(false);
    apiGetRoomRoleGates(detail.id, room.id)
      .then((g) => {
        if (!alive) return;
        setGates(g);
        setAccessIds(new Set(g.access));
        setPostIds(new Set(g.post));
        setAccessMode(g.access.length > 0 ? "roles" : "everyone");
      })
      // Surface the failure instead of silently hiding the role controls —
      // the rest of the editor still works.
      .catch(() => { if (alive) setGatesFailed(true); });
    return () => { alive = false; };
  }, [detail.id, room.id, gatesTick]);
  const toggleIn = (set: (fn: (cur: Set<string>) => Set<string>) => void) => (id: string) =>
    set((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const sameIds = (a: Set<string>, b: string[]) => a.size === b.length && b.every((x) => a.has(x));
  const effectiveAccessIds = accessMode === "roles" ? accessIds : new Set<string>();
  const accessDirty = !!gates && !sameIds(effectiveAccessIds, gates.access);
  const postRolesDirty = !!gates && !sameIds(postIds, gates.post);
  // "Specific roles" with nothing picked would silently save a public room —
  // block Save and say so instead.
  const accessInvalid = accessMode === "roles" && accessIds.size === 0;
  // Same for posting: "Specific roles" with zero roles checked is effectively
  // staff-only while the editor claims roles can post. Only enforced once the
  // gate fetch has seeded postIds, so a load failure can't dead-lock Save on
  // an already-roles room.
  const postRolesInvalid = !!gates && postMode === "roles" && postIds.size === 0;
  const [persistent, setPersistent] = useState(room.persistent ?? true);
  const [nsfw, setNsfw] = useState(room.isNsfw ?? false);
  // 18+ CHANNEL: an adults-only side feed behind a SFW/18+ toggle on the
  // room's rail row. One checkbox — enabling creates (or revives, history
  // intact) the hidden channel; disabling parks it.
  const [adultChannel, setAdultChannel] = useState(!!room.linkedNsfwRoomId);
  // Same gating as the create form: no 18+ control for under-18 viewers,
  // and none inside an 18+ community (the server flag already covers it).
  const isAdultViewer = useChat((s) => s.viewerAge.isAdult);
  const serverIsNsfw = detail.isNsfw ?? false;
  const nsfwDirty = nsfw !== (room.isNsfw ?? false);
  const channelDirty = adultChannel !== !!room.linkedNsfwRoomId;
  const iconDirty = (icon.trim() || null) !== (room.icon ?? null);
  const categoryDirty = (categoryId || null) !== (room.categoryId ?? null);
  const postModeDirty = postMode !== (room.postMode ?? "everyone");
  const richTextDirty = (richText === "simple") !== (room.richTextDisabled ?? false);
  const lifetimeDirty = lifetime !== initialLifetime
    || (lifetime === "custom" && expiry !== String(room.messageExpiryMinutes ?? ""));
  // Custom mode needs an actual minutes value before Save makes sense.
  const lifetimeInvalid = lifetime === "custom" && !(Number(expiry) >= 1);
  const dirty = name !== room.name || topic !== (room.topic ?? "") || lifetimeDirty || persistent !== (room.persistent ?? true) || nsfwDirty || channelDirty || iconDirty || categoryDirty || postModeDirty || richTextDirty || accessDirty || postRolesDirty;
  return (
    <div className="mt-2 space-y-2 border-t border-keep-rule/60 pt-2">
      <label className="block text-xs">
        <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.rooms.name")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action" />
      </label>
      <label className="block text-xs">
        <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.rooms.topic")}</span>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} placeholder={t("console.rooms.noTopicPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action" />
      </label>
      <label className="block text-xs">
        <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.rooms.iconLabel")}</span>
        <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={500} placeholder={t("console.rooms.iconPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action" />
        <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.iconHint")}</span>
      </label>
      {categories.length > 0 ? (
        <label className="block text-xs">
          <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.rooms.categoryLabel")}</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm">
            <option value="">{t("console.rooms.categories.uncategorized")}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.categoryHint")}</span>
        </label>
      ) : null}
      {/* Who can SEE the room (room_role_gates kind='access'). Rendered once
          the gate fetch lands so the picker never lies about current state;
          a failed fetch says so (with a retry) instead of vanishing. */}
      {!gates && gatesFailed ? (
        <p className="text-[10px] text-keep-accent/90">
          {t("console.rooms.roleGates.loadFailed")}{" "}
          <button type="button" onClick={() => setGatesTick((n) => n + 1)}
            className="underline hover:text-keep-text">{t("console.rooms.roleGates.retry")}</button>
        </p>
      ) : null}
      {gates ? (
        <label className="block text-xs" data-admin-anchor="console.rooms.accessLabel">
          <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.rooms.accessLabel")}</span>
          <select value={accessMode} onChange={(e) => setAccessMode(e.target.value as "everyone" | "roles")}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm">
            <option value="everyone">{t("console.rooms.accessEveryone")}</option>
            <option value="roles">{t("console.rooms.accessRoles")}</option>
          </select>
          {accessMode === "roles" ? (
            <>
              <RoleGateCheckList groups={gates.groups} selected={accessIds}
                onToggle={toggleIn(setAccessIds)} ariaLabel={t("console.rooms.accessLabel")} />
              {accessInvalid ? (
                <span className="mt-0.5 block text-[10px] text-keep-accent/90">{t("console.rooms.accessNeedsRole")}</span>
              ) : null}
              <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.accessHint")}</span>
              {/* Deleting a role deletes its gate rows — the room can turn
                  public again without anyone touching this editor. */}
              <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.accessDeleteWarn")}</span>
              {room.linkedNsfwRoomId ? (
                <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.accessAdultChannelNote")}</span>
              ) : null}
            </>
          ) : null}
        </label>
      ) : null}
      <label className="block text-xs" data-admin-anchor="console.rooms.postModeLabel">
        <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.rooms.postModeLabel")}</span>
        <select value={postMode} onChange={(e) => setPostMode(e.target.value as "everyone" | "staff" | "roles")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm">
          <option value="everyone">{t("console.rooms.postModeEveryone")}</option>
          <option value="staff">{t("console.rooms.postModeStaff")}</option>
          {/* Always rendered so a room already saved as "roles" never
              displays as "Everyone" while the gate fetch is pending or has
              failed; picking it just waits for the checklist below. */}
          <option value="roles" disabled={!gates}>{t("console.rooms.postModeRoles")}</option>
        </select>
        <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.postModeHint")}</span>
        {gates && postMode === "roles" ? (
          <>
            <RoleGateCheckList groups={gates.groups} selected={postIds}
              onToggle={toggleIn(setPostIds)} ariaLabel={t("console.rooms.postModeRoles")} />
            {postRolesInvalid ? (
              <span className="mt-0.5 block text-[10px] text-keep-accent/90">{t("console.rooms.postNeedsRole")}</span>
            ) : null}
            <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.postRolesHint")}</span>
          </>
        ) : null}
      </label>
      <label className="block text-xs" data-admin-anchor="console.rooms.richTextLabel">
        <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.rooms.richTextLabel")}</span>
        <select value={richText} onChange={(e) => setRichText(e.target.value as "full" | "simple")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm">
          <option value="full">{t("console.rooms.richTextFull")}</option>
          <option value="simple">{t("console.rooms.richTextSimple")}</option>
        </select>
        <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.richTextHint")}</span>
      </label>
      <label className="block text-xs" data-admin-anchor="console.rooms.lifetimeLabel">
        <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.rooms.lifetimeLabel")}</span>
        <select value={lifetime} onChange={(e) => setLifetime(e.target.value as "inherit" | "custom" | "never")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm">
          <option value="inherit">{t("console.rooms.lifetimeInherit")}</option>
          <option value="custom">{t("console.rooms.lifetimeCustom")}</option>
          <option value="never">{t("console.rooms.lifetimeNever")}</option>
        </select>
        {lifetime === "custom" ? (
          <>
            <input type="number" min={1} value={expiry} onChange={(e) => setExpiry(e.target.value)}
              placeholder={t("console.rooms.lifetimeMinutesPlaceholder")}
              aria-label={t("console.rooms.lifetimeCustom")}
              className={`mt-1 w-32 rounded border bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action ${lifetimeInvalid ? "border-keep-accent" : "border-keep-rule"}`} />
            {/* A blank/zero minutes value disables Save; say so inline instead
                of leaving a dead button with no marked blocker. */}
            {lifetimeInvalid ? (
              <span className="mt-0.5 block text-[10px] text-keep-accent/90">{t("console.rooms.lifetimeMinutesRequired")}</span>
            ) : null}
            <span className="mt-0.5 block text-[10px] text-keep-muted">{t("console.rooms.lifetimeCustomHint")}</span>
          </>
        ) : null}
        {/* Storage guardrail: an exempt room's history grows forever —
            curating it is the owner's job (Discord posture). */}
        {lifetime === "never" ? (
          <span className="mt-0.5 block text-[10px] text-keep-accent/90">{t("console.rooms.lifetimeNeverWarn")}</span>
        ) : null}
      </label>
      <label className="flex items-start gap-2 text-xs text-keep-text">
        <input type="checkbox" className="mt-0.5" checked={persistent} onChange={(e) => setPersistent(e.target.checked)} />
        <span>
          <span className="block">{t("console.rooms.keepWhenEmpty")}</span>
          <span className="block text-[10px] text-keep-muted">{t("console.rooms.keepWhenEmptyEditHint")}</span>
        </span>
      </label>
      {isAdultViewer && !serverIsNsfw ? (
        <label className="flex items-start gap-2 text-xs text-keep-text">
          <input type="checkbox" className="mt-0.5" checked={nsfw} onChange={(e) => setNsfw(e.target.checked)} />
          <span>
            <span className="block">{t("console.rooms.nsfwRoom")}</span>
            <span className="block text-[10px] text-keep-muted">{t("console.rooms.nsfwEditHint")}</span>
          </span>
        </label>
      ) : isAdultViewer && serverIsNsfw ? (
        <p className="text-[10px] text-keep-muted">{t("console.rooms.allNsfwNote")}</p>
      ) : null}
      {/* 18+ CHANNEL — hidden when the whole room is 18+ (nothing to split)
          and inside an 18+ community (every room is already adults-only). */}
      {isAdultViewer && !serverIsNsfw && !nsfw ? (
        <label className="flex items-start gap-2 text-xs text-keep-text">
          <input type="checkbox" className="mt-0.5" checked={adultChannel} onChange={(e) => setAdultChannel(e.target.checked)} />
          <span>
            <span className="block">{t("console.rooms.adultChannel")}</span>
            <span className="block text-[10px] text-keep-muted">{t("console.rooms.adultChannelHint")}</span>
          </span>
        </label>
      ) : null}
      <div className="flex justify-end">
        <button type="button" disabled={busy || !dirty || lifetimeInvalid || accessInvalid || postRolesInvalid}
          onClick={() => void run(async () => {
            await apiPatchServerRoom(detail.id, room.id, {
              name: name.trim(),
              topic: topic.trim() ? topic.trim() : null,
              // The 3-way lifetime select maps onto TWO columns: custom →
              // minutes, never → retention_exempt, inherit → neither. Both
              // are always sent so the pair can never contradict.
              messageExpiryMinutes: lifetime === "custom" ? Math.max(1, Number(expiry)) : null,
              retentionExempt: lifetime === "never",
              persistent,
              ...(postModeDirty ? { postMode } : {}),
              ...(richTextDirty ? { richTextDisabled: richText === "simple" } : {}),
              // Role gates: full-replace lists, sent only when touched
              // ("Everyone" saves as an empty list = clear the lock).
              ...(accessDirty ? { accessRoleIds: [...effectiveAccessIds] } : {}),
              ...(postRolesDirty ? { postRoleIds: [...postIds] } : {}),
              ...(iconDirty ? { icon: icon.trim() ? icon.trim() : null } : {}),
              ...(categoryDirty ? { categoryId: categoryId || null } : {}),
              // Only on change, and the control only renders for adults, so a
              // plain rename can never trip the route's adult-only rejection.
              ...(nsfwDirty ? { isNsfw: nsfw } : {}),
              ...(channelDirty ? { adultChannel } : {}),
            });
            onSaved();
          })}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("console.rooms.saveRoom")}</button>
      </div>
    </div>
  );
}

/* ============================================================
 * Tab: Invites — invite links (manage_invites)
 *
 * Every live invite link (with creator attribution + revoke), a create
 * form, and — for the OWNER — the "who can create invite links" policy
 * (servers.invite_create_mode, migration 0356), which rides the
 * manage_appearance PATCH like every other servers-table setting.
 * ============================================================ */

const INVITE_EXPIRY_CHOICES = [
  { key: "day", hours: 24 },
  { key: "week", hours: 24 * 7 },
  { key: "month", hours: 24 * 30 },
  { key: "never", hours: null },
] as const;

/** Copy-the-full-URL button for one invite row (origin + /i/<code>). */
function InviteCopyButton({ link, code }: { link: string | null; code: string }) {
  const { t } = useTranslation("servers");
  const { copied, copy } = useCopyToClipboard({
    onError: (text) => window.prompt(t("console.invites.copyManual"), text),
  });
  const url = link ?? `${window.location.origin}/i/${code}`;
  return (
    <button type="button" onClick={() => void copy(url)}
      title={copied ? t("console.invites.copied") : t("console.invites.copyLink")}
      aria-label={copied ? t("console.invites.copied") : t("console.invites.copyLink")}
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${copied ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:border-keep-action hover:text-keep-action"}`}>
      {copied ? t("console.invites.copied") : t("console.invites.copyLink")}
    </button>
  );
}

function InvitesTab({ detail, viewer, busy, run, onSaved }: TabProps) {
  const { t } = useTranslation("servers");
  const [invites, setInvites] = useState<ServerInviteRow[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    apiGetInvites(detail.id).then((rows) => { if (alive) setInvites(rows); }).catch(() => { if (alive) setInvites([]); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  // Create form. Defaults: 7-day expiry, unlimited uses.
  const [expiry, setExpiry] = useState<(typeof INVITE_EXPIRY_CHOICES)[number]["key"]>("week");
  const [maxUses, setMaxUses] = useState("");
  const maxUsesInvalid = maxUses.trim() !== "" && (!Number.isInteger(Number(maxUses)) || Number(maxUses) < 1);

  // Who-can-create policy (owner only; the group list excludes the default
  // group — everyone holds it, so it would just mean "all members").
  const savedMode = detail.inviteCreateMode ?? "staff";
  const savedGroupIds = useMemo(() => detail.inviteCreateGroupIds ?? [], [detail.inviteCreateGroupIds]);
  const [mode, setMode] = useState<"staff" | "roles" | "all">(savedMode);
  const [groupIds, setGroupIds] = useState<string[]>(savedGroupIds);
  const [groups, setGroups] = useState<ServerUsergroupWire[] | null>(null);
  useEffect(() => {
    if (!viewer.isOwner) return;
    let alive = true;
    apiGetUsergroups(detail.id)
      .then((d) => { if (alive) setGroups(d.groups.filter((g) => !g.isDefault)); })
      .catch(() => { if (alive) setGroups([]); });
    return () => { alive = false; };
  }, [detail.id, viewer.isOwner]);
  // Re-sync local policy state after a save refetch.
  useEffect(() => { setMode(savedMode); setGroupIds(savedGroupIds); }, [savedMode, savedGroupIds]);
  const policyDirty = mode !== savedMode
    || [...groupIds].sort().join(",") !== [...savedGroupIds].sort().join(",");
  const rolesEmpty = mode === "roles" && groupIds.length === 0;

  return (
    <div className="max-w-2xl space-y-4">
      {/* Owner-only: who may create invite links. */}
      {viewer.isOwner ? (
        <fieldset className="rounded border border-keep-rule bg-keep-panel/30 p-3" data-admin-anchor="console.invites.whoLabel">
          <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.invites.whoLabel")}</legend>
          <div className="space-y-1.5 text-xs text-keep-text">
            {(["staff", "roles", "all"] as const).map((m) => (
              <label key={m} className="flex items-start gap-2">
                <input type="radio" name="invite-create-mode" className="mt-0.5" checked={mode === m} onChange={() => setMode(m)} />
                <span>
                  <span className="block">{t(`console.invites.who.${m}`)}</span>
                  <span className="block text-[10px] text-keep-muted">{t(`console.invites.whoHint.${m}`)}</span>
                </span>
              </label>
            ))}
          </div>
          {mode === "roles" ? (
            groups === null ? (
              <p className="mt-2 text-[10px] italic text-keep-muted">{t("shared.loading")}</p>
            ) : groups.length === 0 ? (
              <p className="mt-2 text-[10px] text-keep-muted">{t("console.invites.noRoles")}</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("console.invites.who.roles")}>
                {groups.map((g) => {
                  const on = groupIds.includes(g.id);
                  return (
                    <button key={g.id} type="button" aria-pressed={on}
                      onClick={() => setGroupIds((cur) => (on ? cur.filter((x) => x !== g.id) : [...cur, g.id]))}
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-keep-action bg-keep-action/15 text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"}`}
                      style={g.color && on ? { borderColor: safeCssColor(g.color) ?? undefined } : undefined}>
                      {g.name}
                    </button>
                  );
                })}
              </div>
            )
          ) : null}
          {rolesEmpty ? (
            <p className="mt-1.5 text-[10px] text-keep-accent/90">{t("console.invites.rolesEmptyWarn")}</p>
          ) : null}
          <div className="mt-2 flex justify-end">
            <button type="button" disabled={busy || !policyDirty}
              onClick={() => void run(async () => {
                await apiPatchServer(detail.id, { inviteCreateMode: mode, inviteCreateGroupIds: mode === "roles" ? groupIds : [] });
                onSaved();
              })}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
              {t("console.invites.savePolicy")}
            </button>
          </div>
        </fieldset>
      ) : null}

      {/* Create a fresh link. */}
      <div className="rounded border border-keep-rule bg-keep-panel/30 p-3" data-admin-anchor="console.invites.createTitle">
        <p className="mb-2 text-xs uppercase tracking-widest text-keep-muted">{t("console.invites.createTitle")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-xs">
            <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.invites.expiresLabel")}</span>
            <select value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm">
              {INVITE_EXPIRY_CHOICES.map((c) => (
                <option key={c.key} value={c.key}>{t(`console.invites.expiry.${c.key}`)}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">{t("console.invites.maxUsesLabel")}</span>
            <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)}
              placeholder={t("console.invites.maxUsesPlaceholder")}
              aria-invalid={maxUsesInvalid || undefined}
              className={`w-32 rounded border bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action ${maxUsesInvalid ? "border-keep-accent" : "border-keep-rule"}`} />
          </label>
          <button type="button" disabled={busy || maxUsesInvalid}
            onClick={() => void run(async () => {
              const hours = INVITE_EXPIRY_CHOICES.find((c) => c.key === expiry)?.hours ?? null;
              await apiCreateInvite(detail.id, {
                expiresInHours: hours,
                maxUses: maxUses.trim() ? Number(maxUses) : null,
              });
              setTick((n) => n + 1);
            })}
            className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
            {t("console.invites.create")}
          </button>
        </div>
        {maxUsesInvalid ? (
          <p className="mt-1 text-[10px] text-keep-accent">{t("console.invites.maxUsesInvalid")}</p>
        ) : null}
        <p className="mt-1.5 text-[10px] text-keep-muted">{t("console.invites.createHint")}</p>
      </div>

      {/* Every live link, newest first, with creator attribution. */}
      <div>
        <p className="mb-1.5 text-xs uppercase tracking-widest text-keep-muted">
          {t("console.invites.listTitle", { n: invites?.length ?? 0 })}
        </p>
        {!invites ? (
          <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>
        ) : invites.length === 0 ? (
          <p className="rounded border border-dashed border-keep-rule px-3 py-4 text-center text-xs italic text-keep-muted">{t("console.invites.empty")}</p>
        ) : (
          <ul className="space-y-1.5">
            {invites.map((inv) => (
              <li key={inv.code} className="flex items-center gap-2 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-keep-text">{inv.link ?? `${window.location.origin}/i/${inv.code}`}</span>
                  <span className="block text-[10px] text-keep-muted">
                    {t("console.invites.byLine", { name: inv.createdByUsername ?? t("console.invites.unknownCreator") })}
                    {" · "}
                    {inv.maxUses != null
                      ? t("console.invites.usesOf", { used: inv.usedCount, max: inv.maxUses })
                      : t("console.invites.uses", { count: inv.usedCount })}
                    {" · "}
                    {inv.expiresAt ? t("console.invites.expires", { date: formatDate(inv.expiresAt) }) : t("console.invites.neverExpires")}
                  </span>
                </span>
                <InviteCopyButton link={inv.link} code={inv.code} />
                <button type="button" disabled={busy}
                  onClick={() => { if (window.confirm(t("console.invites.revokeConfirm"))) void run(async () => { await apiRevokeInvite(detail.id, inv.code); setTick((n) => n + 1); }); }}
                  className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50">
                  {t("console.invites.revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ============================================================
 * Tab: Members
 * ============================================================ */

function MembersTab({ detail, busy, run }: TabProps) {
  const { t } = useTranslation("servers");
  const [data, setData] = useState<{ managerPermissions: ServerPermission[]; members: ServerMemberWire[] } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    apiGetMembers(detail.id).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  const roleLabel = (m: ServerMemberWire) =>
    m.role === "owner" ? t("console.members.roleOwner")
      : m.role === "admin" ? t("console.members.roleAdminLieutenant")
      : m.role === "mod" ? t("console.members.roleModeratorPowers", { count: m.permissions.length })
      : t("console.members.roleMember");

  if (!data) return <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>;

  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-xs uppercase tracking-widest text-keep-muted">{t("console.members.heading", { n: data.members.length })}</p>
      <ul className="space-y-1">
        {data.members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
            <Avatar url={m.avatarUrl} name={m.username} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-keep-text">{m.username}</span>
              <span className="block text-[10px] text-keep-muted">{t("console.members.roleJoined", { role: roleLabel(m), date: formatDate(m.joinedAt) })}</span>
            </span>
            {m.role === "member" ? (
              <>
                <button type="button" disabled={busy}
                  onClick={() => void run(async () => { await apiSetRole(detail.id, m.userId, "mod"); setTick((t2) => t2 + 1); })}
                  title={t("console.members.makeModTitle")}
                  className="shrink-0 rounded border border-keep-action/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-action hover:bg-keep-action/10">{t("console.members.makeMod")}</button>
                <button type="button" disabled={busy}
                  onClick={() => { if (window.confirm(t("console.members.removeConfirm", { name: m.username, server: detail.name }))) void run(async () => { await apiRemoveMember(detail.id, m.userId); setTick((t2) => t2 + 1); }); }}
                  className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("shared.remove")}</button>
              </>
            ) : m.role === "mod" ? (
              <button type="button" disabled={busy}
                onClick={() => { if (window.confirm(t("console.members.removeConfirm", { name: m.username, server: detail.name }))) void run(async () => { await apiRemoveMember(detail.id, m.userId); setTick((t2) => t2 + 1); }); }}
                className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("shared.remove")}</button>
            ) : null}
          </li>
        ))}
      </ul>
      {data.members.length === 1 ? (
        <p className="text-xs italic text-keep-muted">{t("console.members.onlyYou")}</p>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Tab: Users — moderation user finder
 *
 * The moderation twin of the Members tab: search any member and act on them —
 * mute (server-wide), ban, remove, or open their profile — without having to
 * catch them present in a room. Each action is gated on the matching granular
 * grant (the routes re-check every one; the client gate is only an affordance).
 * Mute rows land in account_mutes (scope="server") which the chat dispatcher
 * already enforces; ban/remove reuse the existing routes.
 * ============================================================ */

/** Format a bare hours count as a friendly "2d" / "6h" label for the row copy. */
function muteRemainingLabel(t: TFunction<"servers">, untilMs: number): string {
  const ms = Math.max(0, untilMs - Date.now());
  if (ms >= 86_400_000) return t("console.users.durationDays", { n: Math.round(ms / 86_400_000) });
  if (ms >= 3_600_000) return t("console.users.durationHours", { n: Math.round(ms / 3_600_000) });
  return t("console.users.durationMinutes", { n: Math.max(1, Math.round(ms / 60_000)) });
}

function UsersTab({ detail, viewer, busy, run }: TabProps) {
  const { t } = useTranslation("servers");
  // The signed-in account (for the never-act-on-yourself guard). Read-only
  // selector; `me.id` is the canonical viewer identity the routes also key on.
  const me = useChat((s) => s.me);
  const [data, setData] = useState<{ members: ServerMemberWire[] } | null>(null);
  const [mutes, setMutes] = useState<ServerMuteWire[]>([]);
  const [bans, setBans] = useState<ServerBanWire[]>([]);
  const [q, setQ] = useState("");
  const [hours, setHours] = useState<Record<string, string>>({});
  const [banTarget, setBanTarget] = useState<ServerMemberWire | null>(null);
  const [viewing, setViewing] = useState<ProfileView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const perms = new Set(viewer.permissions);
  const canMute = viewer.isOwner || perms.has("mute_member");
  const canUnmute = viewer.isOwner || perms.has("unmute_member");
  const canBan = viewer.isOwner || perms.has("ban_member");
  const canRemove = viewer.isOwner || perms.has("manage_members");

  useEffect(() => {
    let alive = true;
    // Members are the roster we act on; mutes/bans decorate each row with its
    // current state. mute/ban reads are gated server-side — a viewer without
    // that grant just gets an empty list (the .catch), which is fine.
    apiGetMembers(detail.id).then((d) => { if (alive) setData({ members: d.members }); }).catch(() => { if (alive) setData({ members: [] }); });
    if (canMute) apiGetMutes(detail.id).then((m) => { if (alive) setMutes(m); }).catch(() => { if (alive) setMutes([]); });
    if (canBan) apiGetBans(detail.id).then((b) => { if (alive) setBans(b); }).catch(() => { if (alive) setBans([]); });
    return () => { alive = false; };
  }, [detail.id, tick, canMute, canBan]);

  async function openProfile(userId: string) {
    setViewError(null);
    try {
      const r = await fetch(`/profiles/${encodeURIComponent(`@id:${userId}`)}`, { credentials: "include" });
      if (!r.ok) { setViewError(r.status === 404 ? t("console.users.accountGone") : t("console.users.profileLoadHttp", { status: r.status })); return; }
      const j = await r.json();
      if (j && "private" in j) { setViewError(t("console.users.profileRestricted")); return; }
      setViewing(j as ProfileView);
    } catch {
      setViewError(t("console.users.profileLoadError"));
    }
  }

  if (!data) return <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>;

  const mutedUntil = new Map(mutes.map((m) => [m.userId, m.until]));
  const bannedActive = new Map(bans.filter((b) => !b.expired).map((b) => [b.userId, b] as const));

  const needle = q.trim().toLowerCase();
  const shown = needle ? data.members.filter((m) => m.username.toLowerCase().includes(needle)) : data.members;

  const roleLabel = (m: ServerMemberWire) =>
    m.role === "owner" ? t("console.members.roleOwner")
      : m.role === "admin" ? t("console.users.roleAdmin")
      : m.role === "mod" ? t("console.users.roleModerator")
      : t("console.members.roleMember");

  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-[11px] text-keep-muted">
        {t("console.users.blurb")}
      </p>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("console.users.searchPlaceholder")}
        aria-label={t("console.users.searchAria")}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
      />

      {viewError ? <p className="text-xs text-keep-accent">{viewError}</p> : null}

      {shown.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{needle ? t("console.users.noSearchMatches") : t("console.users.noMembers")}</p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((m) => {
            const isSelf = !!me && m.userId === me.id;
            const isOwner = m.role === "owner";
            const protectedRow = isSelf || isOwner; // never mute/ban/remove yourself or the owner
            const muteUntil = mutedUntil.get(m.userId);
            const isMuted = muteUntil !== undefined && muteUntil > Date.now();
            const ban = bannedActive.get(m.userId);
            const hoursStr = hours[m.userId] ?? "24";
            const hoursNum = Math.max(1, Math.min(8760, Math.round(Number(hoursStr) || 0)));
            return (
              <li key={m.userId} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                <Avatar url={m.avatarUrl} name={m.username} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-keep-text">{m.username}</span>
                  <span className="block text-[10px] text-keep-muted">
                    {roleLabel(m)}
                    {isMuted ? <span className="text-keep-system">{t("console.users.mutedSuffix", { remaining: muteRemainingLabel(t, muteUntil!) })}</span> : null}
                    {ban ? <span className="text-keep-system">{t("console.users.bannedSuffix")}{ban.until ? t("console.users.bannedUntilSuffix", { date: formatDate(ban.until) }) : ""}</span> : null}
                  </span>
                </span>

                {/* View profile — always available so a mod can verify who they're acting on. */}
                <button type="button" disabled={busy}
                  onClick={() => void openProfile(m.userId)}
                  title={t("console.users.viewProfile", { name: m.username })} aria-label={t("console.users.viewProfile", { name: m.username })}
                  className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text disabled:opacity-50">{t("console.users.profile")}</button>

                {protectedRow ? null : (
                  <>
                    {/* Mute / Unmute (server-wide). */}
                    {isMuted && canUnmute ? (
                      <button type="button" disabled={busy}
                        onClick={() => void run(async () => { await apiUnmute(detail.id, m.userId); setTick((t2) => t2 + 1); })}
                        className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text disabled:opacity-50">{t("console.users.unmute")}</button>
                    ) : !isMuted && canMute ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <input type="number" inputMode="numeric" min={1} max={8760} value={hoursStr} disabled={busy}
                          onChange={(e) => setHours((h) => ({ ...h, [m.userId]: e.target.value }))}
                          aria-label={t("console.users.muteHoursAria", { name: m.username })} title={t("console.users.muteHoursTitle")}
                          className="w-14 rounded border border-keep-rule bg-keep-bg px-1 py-0.5 text-[11px] outline-none focus:border-keep-action" />
                        <span className="text-[10px] text-keep-muted">{t("console.users.hoursUnit")}</span>
                        <button type="button" disabled={busy}
                          onClick={() => void run(async () => { await apiMute(detail.id, { target: `@id:${m.userId}`, hours: hoursNum }); setTick((t2) => t2 + 1); })}
                          title={t("console.users.muteTitle", { name: m.username, hours: hoursNum })}
                          className="rounded border border-keep-system/70 bg-keep-system/15 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-system hover:bg-keep-system/25 disabled:opacity-50">{t("console.users.mute")}</button>
                      </span>
                    ) : null}

                    {/* Ban — reuses the shared BanModal + existing ban route. */}
                    {canBan ? (
                      ban ? (
                        <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted" title={t("console.users.bannedChipTitle")}>{t("console.users.bannedChip")}</span>
                      ) : (
                        <button type="button" disabled={busy}
                          onClick={() => setBanTarget(m)}
                          className="shrink-0 rounded border border-keep-system/70 bg-keep-system/15 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-system hover:bg-keep-system/25 disabled:opacity-50">{t("console.users.banEllipsis")}</button>
                      )
                    ) : null}

                    {/* Remove from server (the admin-panel "kick"). */}
                    {canRemove ? (
                      <button type="button" disabled={busy}
                        onClick={() => { if (window.confirm(t("console.members.removeConfirm", { name: m.username, server: detail.name }))) void run(async () => { await apiRemoveMember(detail.id, m.userId); setTick((t2) => t2 + 1); }); }}
                        className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50">{t("shared.remove")}</button>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {banTarget ? (
        <BanModal
          targetName={banTarget.username}
          description={t("console.banModal.description", { server: detail.name })}
          reasonRequired={false}
          reasonPlaceholder={t("console.banModal.reasonPlaceholder")}
          reasonMaxLength={300}
          purgeScopeLabel={t("console.banModal.purgeScope")}
          confirmLabel={t("console.banModal.confirm")}
          onClose={() => setBanTarget(null)}
          onConfirm={async (durationMs, reason, purge) => {
            const banHours = durationMs == null ? null : Math.max(1, Math.round(durationMs / 3_600_000));
            await run(async () => {
              await apiBan(detail.id, {
                target: `@id:${banTarget.userId}`,
                hours: banHours,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
                ...(purge != null ? { purgePosts: purge } : {}),
              });
              setBanTarget(null); setTick((t2) => t2 + 1);
            });
          }}
        />
      ) : null}

      {viewing ? (
        <ProfileModal profile={viewing} onClose={() => setViewing(null)} bypassNsfwGate={true} zIndex={60} />
      ) : null}
    </div>
  );
}

/* ============================================================
 * Tab: Roles (owner line, appoint admin/mod, edit grants)
 * ============================================================ */

/** Muted wayfinding line linking to a sibling console tab (Staff ↔ Roles,
 *  which owners kept confusing before the rename). Rendered only when the
 *  viewer's permission set can actually open the target tab — switching to
 *  a hidden tab would mount a body whose loads 403. */
function TabPointer({ i18nKey, target, viewer, switchTab }: {
  i18nKey: string;
  target: ServerSettingsTab;
  viewer: ServerViewerState;
  switchTab: ((tab: ServerSettingsTab) => void) | undefined;
}) {
  const { t } = useTranslation("servers");
  if (!switchTab || !visibleConsoleTabs(viewer).some((item) => item.id === target)) return null;
  return (
    <p className="text-[11px] text-keep-muted">
      <Trans t={t} i18nKey={i18nKey} components={{ link: <button type="button" onClick={() => switchTab(target)} className="underline decoration-dotted underline-offset-2 hover:text-keep-action" /> }} />
    </p>
  );
}

function RolesTab({ detail, viewer, busy, run, switchTab }: TabProps) {
  const { t } = useTranslation("servers");
  const [data, setData] = useState<{ managerPermissions: ServerPermission[]; members: ServerMemberWire[] } | null>(null);
  const [tick, setTick] = useState(0);
  const [pendingHit, setPendingHit] = useState<ServerUserHit | null>(null);
  const [pendingTier, setPendingTier] = useState<"mod" | "admin">("mod");
  const [pendingPerms, setPendingPerms] = useState<ServerModPermission[]>(SERVER_MOD_DEFAULT_PERMISSIONS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiGetMembers(detail.id).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  const grantable = useMemo(() => new Set(data?.managerPermissions ?? []), [data?.managerPermissions]);
  const mods = (data?.members ?? []).filter((m) => m.role === "mod" || m.role === "admin");

  return (
    <div className="max-w-2xl space-y-4">
      {!data ? (
        <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>
      ) : (
        <>
          <TabPointer i18nKey="console.roles.rolesPointer" target="usergroups" viewer={viewer} switchTab={switchTab} />
          <p className="text-sm text-keep-text">
            <span className="text-xs uppercase tracking-widest text-keep-muted">{t("console.roles.owner")}</span>{" "}
            <span className="font-semibold">{detail.ownerUsername}</span>
            <span className="ml-1 text-[10px] text-keep-muted">{t("console.roles.everyPower")}</span>
          </p>

          <div>
            <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.roles.modsHeading", { n: mods.length })}</p>
            {mods.length === 0 ? (
              <p className="text-xs italic text-keep-muted">
                {t("console.roles.noneYet")}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {mods.map((m) => (
                  <li key={m.userId} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-keep-text">
                        {m.username}
                        {m.role === "admin" ? <span className="ml-1 rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted">{t("console.roles.adminChip")}</span> : null}
                      </span>
                      <span className="shrink-0 text-[10px] text-keep-muted">
                        {m.role === "admin" ? t("console.roles.allButAppearance") : t("console.roles.powers", { count: m.permissions.length })}
                      </span>
                      {m.role === "mod" ? (
                        <button type="button" disabled={busy}
                          onClick={() => setEditingUserId((id) => (id === m.userId ? null : m.userId))}
                          className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action">
                          {editingUserId === m.userId ? t("console.rooms.done") : t("shared.edit")}</button>
                      ) : null}
                      {/* Removing the admin lieutenant is owner-only (matches appointing). */}
                      {m.role === "mod" || viewer.isOwner ? (
                        <button type="button" disabled={busy}
                          onClick={() => { if (window.confirm(t("console.roles.removeRoleConfirm", { name: m.username, role: m.role }))) void run(async () => { await apiRemoveMember(detail.id, m.userId); setTick((t2) => t2 + 1); }); }}
                          className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("shared.remove")}</button>
                      ) : null}
                    </div>
                    {m.role === "mod" && editingUserId === m.userId ? (
                      <div className="mt-2 border-t border-keep-rule/60 pt-2">
                        <ModPermissionCheckboxes
                          value={m.permissions} grantable={grantable} disabled={busy}
                          onChange={(next) => void run(async () => { await apiSetModPermissions(detail.id, m.userId, next); setTick((t) => t + 1); })}
                        />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Appoint flow — pick a person, then a tier (preset), not a blank grid.
              Anchor for find-a-setting; the key doubles as the search entry in
              serverConsoleSearchIndex. */}
          <div data-tour="server-settings-roles-appoint" data-admin-anchor="console.roles.appointStaff" className="rounded border border-keep-rule p-3">
            <p className="mb-2 text-xs uppercase tracking-widest text-keep-muted">{t("console.roles.appointStaff")}</p>
            {!pendingHit ? (
              <ServerUserPicker
                serverId={detail.id}
                placeholder={t("console.userPicker.placeholder")}
                disabledReason={(hit) =>
                  hit.serverRole === "owner" ? t("console.roles.reasonOwner")
                    : hit.serverRole === "mod" ? t("console.roles.reasonAlreadyMod")
                    : hit.serverRole === "admin" ? t("console.roles.reasonAlreadyAdmin")
                    : hit.banned ? t("console.roles.reasonBanned")
                    : null}
                onSelect={(hit) => {
                  setPendingHit(hit);
                  setPendingTier("mod");
                  setShowAdvanced(false);
                  setPendingPerms(SERVER_MOD_DEFAULT_PERMISSIONS.filter((p) => grantable.has(p)));
                }}
              />
            ) : (
              <div className="space-y-2.5">
                <p className="text-sm text-keep-text"><Trans t={t} i18nKey="console.roles.appointAs" values={{ name: pendingHit.username }} components={{ user: <span className="font-semibold" /> }} /></p>

                {/* Tier cards */}
                <div className="grid grid-cols-1 gap-2 [@container(min-width:640px)]:grid-cols-2">
                  <button
                    type="button" disabled={busy}
                    onClick={() => { setPendingTier("mod"); setShowAdvanced(false); setPendingPerms(SERVER_MOD_DEFAULT_PERMISSIONS.filter((p) => grantable.has(p))); }}
                    className={`rounded border px-2.5 py-2 text-left ${pendingTier === "mod" ? "border-keep-action bg-keep-action/10" : "border-keep-rule hover:border-keep-action/60"}`}
                  >
                    <span className="block text-sm font-semibold text-keep-text">{t("console.roles.moderator")}</span>
                    <span className="mt-0.5 block text-[11px] text-keep-muted">{t("console.roles.moderatorBlurb")}</span>
                  </button>
                  <button
                    type="button" disabled={busy || !viewer.isOwner}
                    title={viewer.isOwner ? undefined : t("console.roles.adminOwnerOnly")}
                    onClick={() => { setPendingTier("admin"); setShowAdvanced(false); }}
                    className={`rounded border px-2.5 py-2 text-left ${!viewer.isOwner ? "opacity-50" : pendingTier === "admin" ? "border-keep-action bg-keep-action/10" : "border-keep-rule hover:border-keep-action/60"}`}
                  >
                    <span className="block text-sm font-semibold text-keep-text">{t("console.roles.admin")}</span>
                    <span className="mt-0.5 block text-[11px] text-keep-muted">{t("console.roles.adminBlurb")}{viewer.isOwner ? "" : t("console.roles.adminBlurbOwnerOnlySuffix")}</span>
                  </button>
                </div>

                {/* Moderator tier → optional advanced per-power customization. */}
                {pendingTier === "mod" ? (
                  <div>
                    <button type="button" onClick={() => setShowAdvanced((v) => !v)}
                      className="text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-action">
                      {showAdvanced ? t("console.roles.hidePowers") : t("console.roles.customizePowers")}</button>
                    {showAdvanced ? (
                      <div className="mt-1.5">
                        <ModPermissionCheckboxes value={pendingPerms} grantable={grantable} disabled={busy} onChange={setPendingPerms} />
                      </div>
                    ) : (
                      <p className="mt-1 text-[10px] text-keep-muted">{t("console.roles.presetNote", { count: pendingPerms.length })}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-[10px] text-keep-muted"><Trans t={t} i18nKey="console.roles.adminPowersNote" values={{ n: SERVER_ADMIN_DEFAULT_PERMISSIONS.length }} components={{ perm: <span className="text-keep-text" /> }} /></p>
                )}

                <div className="flex justify-end gap-2">
                  <button type="button" disabled={busy} onClick={() => setPendingHit(null)}
                    className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">{t("shared.cancel")}</button>
                  {pendingTier === "admin" ? (
                    <button type="button" disabled={busy || !viewer.isOwner}
                      onClick={() => void run(async () => { await apiSetRole(detail.id, pendingHit.userId, "admin"); setPendingHit(null); setTick((t2) => t2 + 1); })}
                      className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
                      {t("console.roles.appointAsAdmin")}</button>
                  ) : (
                    <button type="button" disabled={busy}
                      onClick={() => void run(async () => { await apiSetRole(detail.id, pendingHit.userId, "mod", pendingPerms); setPendingHit(null); setTick((t2) => t2 + 1); })}
                      className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
                      {t("console.roles.appointAsModerator")}</button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Owner-only: transfer ownership. */}
          {viewer.isOwner && !detail.isSystem ? <TransferOwnership detail={detail} busy={busy} run={run} /> : null}
        </>
      )}
    </div>
  );
}

/** Owner-only ownership transfer (§6.2 most-sensitive act). */
function TransferOwnership({ detail, busy, run }: { detail: ServerConsoleDetail; busy: boolean; run: (fn: () => Promise<void>) => Promise<void> }) {
  const { t } = useTranslation("servers");
  const [target, setTarget] = useState<ServerUserHit | null>(null);
  return (
    <div className="rounded border border-keep-system/50 bg-keep-system/5 p-3">
      <p className="mb-1 text-xs uppercase tracking-widest text-keep-system">{t("console.transfer.title")}</p>
      <p className="mb-2 text-[11px] text-keep-muted">
        {t("console.transfer.blurb")}
      </p>
      {!target ? (
        <ServerUserPicker
          serverId={detail.id}
          placeholder={t("console.transfer.searchPlaceholder")}
          disabledReason={(hit) => (hit.serverRole === "owner" ? t("console.transfer.reasonAlreadyOwner") : hit.banned ? t("console.transfer.reasonBanned") : null)}
          onSelect={setTarget}
        />
      ) : (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm text-keep-text">{target.username}</span>
          <button type="button" onClick={() => setTarget(null)}
            className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("console.transfer.change")}</button>
          <button type="button" disabled={busy}
            onClick={() => { if (window.confirm(t("console.transfer.confirm", { server: detail.name, name: target.username }))) void run(async () => { await apiTransfer(detail.id, `@id:${target.userId}`); setTarget(null); }); }}
            className="shrink-0 rounded border border-keep-system/70 bg-keep-system/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-system disabled:opacity-50">{t("console.transfer.transfer")}</button>
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * Tab: Usergroups
 * ============================================================ */

function UsergroupMembersPanel({ detail, group, busy, run }: { detail: ServerConsoleDetail; group: ServerUsergroupWire; busy: boolean; run: (fn: () => Promise<void>) => Promise<void> }) {
  const { t } = useTranslation("servers");
  const [members, setMembers] = useState<ServerUsergroupMemberWire[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    apiGetUsergroupMembers(detail.id, group.id).then((m) => { if (alive) setMembers(m); }).catch(() => { if (alive) setMembers([]); });
    return () => { alive = false; };
  }, [detail.id, group.id, tick]);
  return (
    <div className="border-t border-keep-rule/60 pt-3">
      <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.usergroups.membersHeading", { n: members?.length ?? "…" })}</p>
      <div className="mb-2">
        <ServerUserPicker serverId={detail.id} placeholder={t("console.usergroups.addMemberPlaceholder")}
          onSelect={(hit) => void run(async () => { await apiAddUsergroupMember(detail.id, group.id, `@id:${hit.userId}`); setTick((t2) => t2 + 1); })} />
      </div>
      {members && members.length > 0 ? (
        <ul className="space-y-1">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-2 rounded border border-keep-rule/60 px-2 py-1 text-xs">
              <span className="min-w-0 flex-1 truncate text-keep-text">{m.username}</span>
              {m.isAuto ? <span className="shrink-0 rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted">{t("console.usergroups.autoChip")}</span> : null}
              <button type="button" disabled={busy}
                onClick={() => void run(async () => { await apiRemoveUsergroupMember(detail.id, group.id, m.userId); setTick((t2) => t2 + 1); })}
                className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("shared.remove")}</button>
            </li>
          ))}
        </ul>
      ) : members ? <p className="text-[11px] italic text-keep-muted">{t("console.usergroups.noMembers")}</p> : null}
    </div>
  );
}

function UsergroupEditor({ detail, group, grantable, busy, run, onClose, onSaved }: {
  detail: ServerConsoleDetail;
  group: ServerUsergroupWire | null;
  grantable: Set<ServerPermission>;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("servers");
  const isDefault = !!group?.isDefault;
  const [name, setName] = useState(group?.name ?? "");
  const [color, setColor] = useState(group?.color ?? "");
  const [perms, setPerms] = useState<ServerFeaturePermission[]>(group?.permissions ?? [...SERVER_FEATURE_PERMISSIONS]);
  const [autoRules, setAutoRules] = useState<ServerAutoRule[]>(group?.autoRules ?? []);
  // Self-role fields (migration 0320): let members pick this group + a blurb.
  // The default group applies to everyone, so it can't be self-selectable.
  const [memberSelectable, setMemberSelectable] = useState(group?.memberSelectable ?? false);
  const [description, setDescription] = useState(group?.description ?? "");
  // Userlist badge opt-in (migration 0348) — named groups only.
  const [showBadge, setShowBadge] = useState(group?.showBadge ?? false);
  const [rooms, setRooms] = useState<RoomListRow[]>([]);

  // Rooms power the `posted_in_room` auto-rule selector (non-default only).
  useEffect(() => {
    if (isDefault) return;
    let alive = true;
    apiGetRooms(detail.id).then(({ rooms: r }) => { if (alive) setRooms(r); }).catch(() => { if (alive) setRooms([]); });
    return () => { alive = false; };
  }, [detail.id, isDefault]);

  function save() {
    void run(async () => {
      const payload: Record<string, unknown> = { name: name.trim(), color: color.trim() || null, permissions: perms };
      if (!isDefault) {
        payload.autoRules = autoRules;
        // Self-role fields only apply to named groups (the default group applies
        // to everyone, so it can't be member-selectable).
        payload.memberSelectable = memberSelectable;
        payload.description = description.trim() ? description.trim() : null;
        // Userlist badge only applies to named groups too (a badge on
        // everyone says nothing; the server forces it off on the default).
        payload.showBadge = showBadge;
      }
      if (group) await apiPatchUsergroup(detail.id, group.id, payload);
      else await apiCreateUsergroup(detail.id, payload);
      onSaved();
    });
  }

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("console.usergroups.back")}</button>
        <h3 className="text-sm font-semibold text-keep-text">{group ? (isDefault ? t("console.usergroups.defaultGroup") : t("console.usergroups.editGroup", { name: group.name })) : t("console.usergroups.newGroup")}</h3>
      </div>
      {isDefault ? (
        <p className="text-[11px] text-keep-muted">{t("console.usergroups.defaultBlurb")}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input type="color" value={color || "#8a66cc"} onChange={(e) => setColor(e.target.value)} title={t("console.usergroups.groupColor")} className="h-7 w-9 shrink-0 cursor-pointer rounded border border-keep-rule bg-transparent" />
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t("console.usergroups.namePlaceholder")} className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
        </div>
      )}
      <div>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.usergroups.memberFeatures")}</p>
        <ServerFeatureCheckboxes value={perms} grantable={grantable} disabled={busy} onChange={setPerms} />
      </div>
      {!isDefault ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.usergroups.selfService")}</p>
          <label className="flex items-start gap-2 rounded border border-keep-rule/60 px-2 py-1.5 text-sm">
            <input type="checkbox" className="mt-0.5" checked={memberSelectable} disabled={busy}
              onChange={(e) => setMemberSelectable(e.target.checked)} />
            <span className="min-w-0">
              <span className="block text-keep-text">{t("console.usergroups.selectableLabel")}</span>
              <span className="block text-[11px] text-keep-muted">{t("console.usergroups.selectableHint")}</span>
            </span>
          </label>
          <label className="mt-2 block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">{t("console.usergroups.description")}</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} disabled={busy}
              placeholder={t("console.usergroups.descriptionPlaceholder")}
              className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
          </label>
        </div>
      ) : null}
      {!isDefault ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.usergroups.badgeSection")}</p>
          {/* Userlist badge opt-in (migration 0348). Anchor for find-a-setting;
              the key doubles as the search entry in serverConsoleSearchIndex. */}
          <label data-admin-anchor="console.usergroups.showBadgeLabel" className="flex items-start gap-2 rounded border border-keep-rule/60 px-2 py-1.5 text-sm">
            <input type="checkbox" className="mt-0.5" checked={showBadge} disabled={busy}
              onChange={(e) => setShowBadge(e.target.checked)} />
            <span className="min-w-0">
              <span className="block text-keep-text">{t("console.usergroups.showBadgeLabel")}</span>
              <span className="block text-[11px] text-keep-muted">{t("console.usergroups.showBadgeHint")}</span>
            </span>
          </label>
        </div>
      ) : null}
      {!isDefault ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.usergroups.autoJoinRules")}</p>
          <p className="mb-1.5 text-[11px] text-keep-muted">{t("console.usergroups.autoJoinHint")}</p>
          <ServerAutoRulesEditor rules={autoRules} onChange={setAutoRules} rooms={rooms} disabled={busy} />
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">{t("shared.cancel")}</button>
        <button type="button" disabled={busy || (!isDefault && !name.trim())} onClick={save}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{group ? t("shared.save") : t("console.usergroups.create")}</button>
      </div>
      {group && !isDefault ? <UsergroupMembersPanel detail={detail} group={group} busy={busy} run={run} /> : null}
    </div>
  );
}

function UsergroupsTab({ detail, viewer, busy, run, switchTab }: TabProps) {
  const { t } = useTranslation("servers");
  const [data, setData] = useState<{ managerPermissions: ServerPermission[]; groups: ServerUsergroupWire[] } | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<ServerUsergroupWire | "new" | null>(null);

  useEffect(() => {
    let alive = true;
    apiGetUsergroups(detail.id).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  const grantable = useMemo(() => new Set(data?.managerPermissions ?? []), [data?.managerPermissions]);

  // Named groups in display order (sortOrder asc; the default group always
  // sorts first and never moves). Order is user-meaningful: the userlist
  // badge pick takes the member's badge group LOWEST in this list, so the
  // arrows below let owners control the winner.
  const named = useMemo(() => (data?.groups ?? []).filter((g) => !g.isDefault), [data?.groups]);
  const moveGroup = (index: number, dir: -1 | 1) => {
    const ids = named.map((g) => g.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + dir, 0, id!);
    void run(async () => {
      // Re-stamp each named group's slot (sortOrder = index) through the
      // existing PATCH route; rows already in place are skipped so a simple
      // swap stays two requests.
      const byId = new Map(named.map((g) => [g.id, g]));
      for (let i = 0; i < ids.length; i++) {
        const g = byId.get(ids[i]!)!;
        if (g.sortOrder !== i) await apiPatchUsergroup(detail.id, g.id, { sortOrder: i });
      }
      setTick((t2) => t2 + 1);
    });
  };

  if (!data) return <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>;

  if (editing) {
    return (
      <UsergroupEditor detail={detail} group={editing === "new" ? null : editing} grantable={grantable} busy={busy} run={run}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setTick((t) => t + 1); }} />
    );
  }

  return (
    <div className="max-w-2xl space-y-3">
      <TabPointer i18nKey="console.usergroups.staffPointer" target="roles" viewer={viewer} switchTab={switchTab} />
      <p className="text-[11px] text-keep-muted">
        {t("console.usergroups.blurb")}
      </p>
      <ul className="space-y-1.5">
        {data.groups.map((g) => {
          const ni = named.findIndex((n) => n.id === g.id);
          return (
          <li key={g.id} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              {!g.isDefault ? (
                <MoveArrows busy={busy} canUp={ni > 0} canDown={ni >= 0 && ni < named.length - 1}
                  onMove={(dir) => moveGroup(ni, dir)}
                  upLabel={t("console.usergroups.moveUp")} downLabel={t("console.usergroups.moveDown")} />
              ) : null}
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                {g.color ? <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.color }} /> : null}
                <span className="truncate text-sm font-semibold text-keep-text">{g.name}</span>
                {g.isDefault ? <span className="shrink-0 rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted">{t("console.usergroups.defaultChip")}</span> : null}
                {g.showBadge ? <span className="shrink-0 rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted" title={t("console.usergroups.showBadgeLabel")}>{t("console.usergroups.badgeChip")}</span> : null}
              </span>
              <span className="shrink-0 text-[10px] text-keep-muted">
                {t("console.usergroups.features", { count: g.permissions.length })}
                {g.isDefault
                  ? t("console.usergroups.everyoneSuffix")
                  : `${t("console.usergroups.membersSuffix", { count: g.memberCount })}${g.autoRules.length ? t("console.usergroups.rulesSuffix", { count: g.autoRules.length }) : ""}`}
              </span>
              <button type="button" disabled={busy} onClick={() => setEditing(g)}
                className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action">{t("shared.edit")}</button>
              {!g.isDefault ? (
                <button type="button" disabled={busy}
                  onClick={() => { if (window.confirm(t("console.usergroups.deleteConfirm", { name: g.name }))) void run(async () => { await apiDeleteUsergroup(detail.id, g.id); setTick((t2) => t2 + 1); }); }}
                  className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("shared.delete")}</button>
              ) : null}
            </div>
          </li>
          );
        })}
      </ul>
      <button type="button" disabled={busy} onClick={() => setEditing("new")}
        className="rounded border border-keep-action bg-keep-action/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50">{t("console.usergroups.newGroupButton")}</button>
    </div>
  );
}

/* ============================================================
 * Tab: Applications
 * ============================================================ */

function ApplicationsTab({ detail, busy, run }: TabProps) {
  const { t } = useTranslation("servers");
  const [data, setData] = useState<{ pending: ServerMembershipApplicationWire[]; recent: ServerMembershipApplicationWire[] } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    apiGetApplications(detail.id).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData({ pending: [], recent: [] }); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  const pending = data?.pending ?? null;
  const recent = data?.recent ?? [];

  return (
    <div className="max-w-xl space-y-3">
      {detail.joinMode !== "application" ? (
        <p className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5 text-xs text-keep-muted">
          {t("console.applications.notInApplicationMode")}
        </p>
      ) : null}
      <div>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.applications.pendingLabel")}{pending ? `(${pending.length})` : ""}</p>
        {!pending ? (
          <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>
        ) : pending.length === 0 ? (
          <p className="text-xs italic text-keep-muted">{t("console.applications.noneWaiting")}</p>
        ) : (
          <ul className="space-y-1.5">
            {pending.map((a) => (
              <li key={a.id} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-keep-text">{a.applicantUsername}</span>
                  <span className="text-[10px] text-keep-muted">{formatDateTime(a.submittedAt)}</span>
                </div>
                {a.answer ? <p className="mt-1 whitespace-pre-wrap text-xs text-keep-text/90">{a.answer}</p> : <p className="mt-1 text-xs italic text-keep-muted">{t("console.applications.noAnswer")}</p>}
                <div className="mt-1.5 flex gap-2">
                  <button type="button" disabled={busy}
                    onClick={() => void run(async () => { await apiReviewApplication(detail.id, a.id, "approve"); setTick((t2) => t2 + 1); })}
                    className="rounded border border-keep-action bg-keep-action/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50">{t("console.applications.approve")}</button>
                  <button type="button" disabled={busy}
                    onClick={() => { const v = window.prompt(t("console.applications.declinePrompt", { name: a.applicantUsername }), ""); if (v === null) return; void run(async () => { await apiReviewApplication(detail.id, a.id, "reject", v.trim() || undefined); setTick((t2) => t2 + 1); }); }}
                    className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-accent disabled:opacity-50">{t("console.applications.decline")}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {recent.length > 0 ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{t("console.applications.recentDecisions")}</p>
          <ul className="space-y-0.5">
            {recent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 rounded border border-keep-rule/50 px-2 py-0.5 text-[11px] text-keep-muted">
                <span className={a.status === "approved" ? "font-semibold uppercase text-keep-action" : "font-semibold uppercase text-keep-accent"}>{a.status}</span>
                <span className="text-keep-text">{a.applicantUsername}</span>
                {a.reviewedByUsername ? <span>{t("console.applications.byReviewer", { name: a.reviewedByUsername })}</span> : null}
                {a.reviewedAt ? <span>{t("console.applications.dateSuffix", { date: formatDate(a.reviewedAt) })}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Tab: Bans
 * ============================================================ */

function BansTab({ detail, viewer, busy, run }: TabProps) {
  const { t } = useTranslation("servers");
  const [bans, setBans] = useState<ServerBanWire[] | null>(null);
  const [targetHit, setTargetHit] = useState<ServerUserHit | null>(null);
  const [banOpen, setBanOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const perms = new Set(viewer.permissions);
  const canBan = viewer.isOwner || perms.has("ban_member");
  const canUnban = viewer.isOwner || perms.has("unban_member");

  useEffect(() => {
    let alive = true;
    apiGetBans(detail.id).then((b) => { if (alive) setBans(b); }).catch(() => { if (alive) setBans([]); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  return (
    <div className="max-w-xl space-y-3">
      <p className="text-[11px] text-keep-muted">
        {t("console.bans.blurb")}
      </p>
      {!bans ? (
        <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>
      ) : bans.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{t("console.bans.none")}</p>
      ) : (
        <ul className="space-y-1">
          {bans.map((b) => (
            <li key={b.userId} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1 text-sm">
              <span className="font-semibold text-keep-text">{b.username}</span>
              <span className={`text-[11px] ${b.expired ? "text-keep-muted line-through" : "text-keep-muted"}`}>
                {b.until ? t("console.bans.until", { date: formatDate(b.until) }) : t("console.bans.permanent")}{b.expired ? t("console.bans.expiredSuffix") : ""}
              </span>
              {b.reason ? <span className="min-w-0 flex-1 truncate text-[11px] italic text-keep-muted">"{b.reason}"</span> : <span className="flex-1" />}
              {canUnban ? (
                <button type="button" disabled={busy}
                  onClick={() => void run(async () => { await apiLiftBan(detail.id, b.userId); setTick((t2) => t2 + 1); })}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("console.bans.lift")}</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canBan ? (
        <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
          {!targetHit ? (
            <ServerUserPicker serverId={detail.id} placeholder={t("console.bans.searchPlaceholder")}
              disabledReason={(hit) => (hit.serverRole === "owner" ? t("console.roles.reasonOwner") : hit.banned ? t("console.bans.reasonAlreadyBanned") : null)}
              onSelect={setTargetHit} />
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-keep-text">{targetHit.username}</span>
                <button type="button" onClick={() => setTargetHit(null)}
                  className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">{t("console.transfer.change")}</button>
              </div>
              <button type="button" disabled={busy} onClick={() => setBanOpen(true)}
                className="shrink-0 rounded border border-keep-system/70 bg-keep-system/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-system disabled:opacity-50">{t("console.users.banEllipsis")}</button>
            </div>
          )}
        </div>
      ) : null}

      {banOpen && targetHit ? (
        <BanModal
          targetName={targetHit.username}
          description={t("console.banModal.description", { server: detail.name })}
          reasonRequired={false}
          reasonPlaceholder={t("console.banModal.reasonPlaceholder")}
          reasonMaxLength={300}
          purgeScopeLabel={t("console.banModal.purgeScope")}
          confirmLabel={t("console.banModal.confirm")}
          onClose={() => setBanOpen(false)}
          onConfirm={async (durationMs, reason, purge) => {
            const hours = durationMs == null ? null : Math.max(1, Math.round(durationMs / 3_600_000));
            await run(async () => {
              await apiBan(detail.id, {
                target: `@id:${targetHit.userId}`,
                hours,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
                ...(purge != null ? { purgePosts: purge } : {}),
              });
              // success only — on failure `run` surfaces the error + the modal stays open
              setBanOpen(false); setTargetHit(null); setTick((t) => t + 1);
            });
          }}
        />
      ) : null}
    </div>
  );
}

/* ============================================================
 * Tab: Mod Log
 * ============================================================ */

function modLogLabel(t: TFunction<"servers">, action: string, meta: Record<string, unknown> | null): { text: string; tone: string } {
  const m = meta ?? {};
  switch (action) {
    case "server_appearance_update": return { text: t("console.modLog.appearanceUpdate"), tone: "text-keep-muted" };
    case "server_settings_update": return { text: t("console.modLog.settingsUpdate"), tone: "text-keep-muted" };
    case "server_role_set": return { text: `${t("console.modLog.roleSet")}${m.role ? ` → ${String(m.role)}` : ""}`, tone: "text-keep-action" };
    case "server_mod_perms": return { text: t("console.modLog.modPerms"), tone: "text-keep-muted" };
    case "server_member_remove": return { text: t("console.modLog.memberRemove"), tone: "text-keep-muted" };
    case "server_usergroup_change": return { text: t("console.modLog.usergroupChange", { op: m.op ? String(m.op) : t("console.modLog.usergroupChangeFallback") }), tone: "text-keep-muted" };
    case "server_ban": return { text: t("console.modLog.ban"), tone: "text-keep-system" };
    case "server_unban": return { text: t("console.modLog.unban"), tone: "text-keep-muted" };
    case "server_mute": return { text: `${t("console.modLog.mute")}${typeof m.hours === "number" ? t("console.modLog.muteForSuffix", { hours: m.hours }) : ""}`, tone: "text-keep-system" };
    case "server_unmute": return { text: t("console.modLog.unmute"), tone: "text-keep-muted" };
    case "server_transfer": return { text: t("console.modLog.transfer"), tone: "text-keep-system" };
    case "server_invite_create": return { text: t("console.modLog.inviteCreate"), tone: "text-keep-muted" };
    // One revoke action covers manual revocations AND the automatic
    // invites-die-with-membership sweep (metadata.reason=membership_ended).
    case "server_invite_revoke": return {
      text: m.reason === "membership_ended" ? t("console.modLog.inviteRevokeMembership") : t("console.modLog.inviteRevoke"),
      tone: "text-keep-muted",
    };
    case "server_command_rule_set": {
      // The /name is protocol and stays literal; the metadata's mode token
      // maps onto the same localized labels the console's select shows.
      const cmd = typeof m.command === "string" ? ` → /${m.command}` : "";
      const modeLabel = m.mode === "disabled" ? t("commandsTab.availability.off")
        : m.mode === "roles" ? t("commandsTab.availability.roles")
        : m.mode === "everyone" ? t("commandsTab.availability.everyone")
        : "";
      return { text: `${t("console.modLog.commandRule")}${cmd}${modeLabel ? ` (${modeLabel})` : ""}`, tone: "text-keep-muted" };
    }
    default: return { text: action.replace(/^server_/, "").replace(/_/g, " "), tone: "text-keep-muted" };
  }
}

function ModLogTab({ detail }: { detail: ServerConsoleDetail }) {
  const { t } = useTranslation("servers");
  const [entries, setEntries] = useState<ServerModLogWire[] | null>(null);
  useEffect(() => {
    let alive = true;
    apiGetModLog(detail.id).then((e) => { if (alive) setEntries(e); }).catch(() => { if (alive) setEntries([]); });
    return () => { alive = false; };
  }, [detail.id]);
  return (
    <div className="max-w-2xl space-y-2">
      <p className="text-[11px] text-keep-muted">{t("console.modLog.blurb")}</p>
      {!entries ? (
        <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>
      ) : entries.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{t("console.modLog.empty")}</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => {
            const { text, tone } = modLogLabel(t, e.action, e.metadata);
            return (
              <li key={e.id} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5 text-xs">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={`font-semibold ${tone}`}>{text}</span>
                  {e.targetUsername ? <span className="text-keep-muted">→ {e.targetUsername}</span> : null}
                  <span className="ml-auto text-[10px] text-keep-muted">{formatDateTime(e.createdAt)}</span>
                </div>
                <div className="text-[10px] text-keep-muted">{t("console.modLog.byActor", { name: e.actorUsername })}{e.reason ? <span> · {e.reason}</span> : null}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
 * Tabs: Rules (welcome/rules copy) + Settings (caps & durations)
 * ============================================================ */

/**
 * Format ms as the most natural unit ("5d", "2h", "30m", "45s") so durations
 * read like the Global Admin console instead of a raw millisecond count.
 * `0` means "disabled" (only meaningful for the edit window). Mirrors the
 * helper in AdminPanel; kept local per this file's inline-helper convention.
 */
function formatMs(ms: number): string {
  if (ms === 0) return "0";
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Inverse of {@link formatMs}. Accepts "5m", "1h30m", "30d", or a bare ms
 *  number; returns null when the (non-blank) text parses to nothing. The caller
 *  treats a blank field as "inherit", so blank is handled before this. */
/** One number-or-inherit field over the per-server settings row. `anchor`
 *  stamps the find-a-setting jump target (data-admin-anchor = the row's
 *  label catalog key, verbatim) on the wrapping label; purely inert until a
 *  search entry references it (docs/ADMIN_IA.md §6). */
function NumberSetting({ label, hint, value, onChange, min, anchor }: {
  label: string; hint: string; value: string; onChange: (v: string) => void; min?: number; anchor?: string;
}) {
  const { t } = useTranslation("servers");
  return (
    <label {...(anchor ? { "data-admin-anchor": anchor } : {})} className="block text-sm">
      <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">{label}</span>
      <input type="number" inputMode="numeric" min={min} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={t("console.settings.inheritPlaceholder")}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      <span className="mt-0.5 block text-[10px] text-keep-muted">{hint}</span>
    </label>
  );
}

/** One duration-or-inherit field (friendly text like "30d" / "5m"), the
 *  per-server analog of the Global Admin duration inputs. Stored as ms on the
 *  wire; blank = inherit the platform default. */
function DurationSetting({ label, hint, value, onChange, placeholder, anchor }: {
  label: string; hint: string; value: string; onChange: (v: string) => void; placeholder?: string; anchor?: string;
}) {
  const { t } = useTranslation("servers");
  return (
    <label {...(anchor ? { "data-admin-anchor": anchor } : {})} className="block text-sm">
      <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t("console.settings.inheritPlaceholder")}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 font-mono text-sm outline-none focus:border-keep-action" />
      <span className="mt-0.5 block text-[10px] text-keep-muted">{hint}</span>
    </label>
  );
}

/* ------------------------------------------------------------
 * Tab: Rules — the server's welcome / rules HTML copy. Split out of the old
 * combined Settings tab so copy and numeric caps live on their own screens
 * (mirrors the Global Admin Rules vs Settings split). Saves only the HTML
 * fields; the PATCH route is partial so the Settings tab's caps are untouched.
 * ------------------------------------------------------------ */
function RulesTab({ detail, busy, run, onSaved }: TabProps) {
  const { t } = useTranslation("servers");
  const [loaded, setLoaded] = useState<ServerSettingsWire | null>(null);
  const [welcome, setWelcome] = useState("");
  const [newUserWelcome, setNewUserWelcome] = useState("");
  const [rules, setRules] = useState("");
  const [security, setSecurity] = useState("");

  useEffect(() => {
    let alive = true;
    apiGetSettings(detail.id).then((s) => {
      if (!alive) return;
      setLoaded(s);
      setWelcome(s.welcomeHtml ?? "");
      setNewUserWelcome(s.newUserWelcomeHtml ?? "");
      setRules(s.rulesHtml ?? "");
      setSecurity(s.securityNoticeHtml ?? "");
    }).catch(() => { if (alive) setLoaded(null); });
    return () => { alive = false; };
  }, [detail.id]);

  if (!loaded) return <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>;

  const htmlOrNull = (s: string): string | null => (s.trim() ? s : null);

  function save() {
    void run(async () => {
      await apiPatchSettings(detail.id, {
        welcomeHtml: htmlOrNull(welcome),
        newUserWelcomeHtml: htmlOrNull(newUserWelcome),
        rulesHtml: htmlOrNull(rules),
        securityNoticeHtml: htmlOrNull(security),
      });
      onSaved();
    });
  }

  return (
    <div className="max-w-xl space-y-4">
      <p className="text-[11px] text-keep-muted">
        {t("console.rulesTab.blurb")}
      </p>
      <label className="block text-sm">
        <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">{t("console.rulesTab.welcome")}</span>
        <textarea value={welcome} onChange={(e) => setWelcome(e.target.value)} rows={4} maxLength={200_000}
          placeholder={t("console.rulesTab.welcomePlaceholder")}
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      </label>
      <label className="block text-sm">
        <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">{t("console.rulesTab.newUserWelcome")}</span>
        <textarea value={newUserWelcome} onChange={(e) => setNewUserWelcome(e.target.value)} rows={4} maxLength={200_000}
          placeholder={t("console.rulesTab.newUserWelcomePlaceholder")}
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      </label>
      <label className="block text-sm">
        <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">{t("console.rulesTab.houseRules")}</span>
        <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={6} maxLength={200_000}
          placeholder={t("console.rulesTab.houseRulesPlaceholder")}
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      </label>
      <label className="block text-sm">
        <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">{t("console.rulesTab.securityNotice")}</span>
        <textarea value={security} onChange={(e) => setSecurity(e.target.value)} rows={3} maxLength={200_000}
          placeholder={t("console.rulesTab.securityNoticePlaceholder")}
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      </label>
      <button type="button" disabled={busy} onClick={save}
        className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("console.rulesTab.saveRules")}</button>
    </div>
  );
}

/* ------------------------------------------------------------
 * Tab: Settings — the numeric caps + durations. Durations (retention, edit
 * window) are entered friendly ("30d" / "5m") and stored as ms, matching the
 * Global Admin console; blank inherits the platform default. Saves only these
 * fields, leaving the Rules tab's copy untouched (partial PATCH).
 * ------------------------------------------------------------ */
function SettingsTab({ detail, busy, run, onSaved }: TabProps) {
  const { t } = useTranslation("servers");
  const [loaded, setLoaded] = useState<ServerSettingsWire | null>(null);
  // Local string copies (empty = inherit / clear the override).
  const [retention, setRetention] = useState("");
  const [maxRooms, setMaxRooms] = useState("");
  const [maxMsg, setMaxMsg] = useState("");
  const [editGrace, setEditGrace] = useState("");
  const [maxForumPost, setMaxForumPost] = useState("");

  useEffect(() => {
    let alive = true;
    apiGetSettings(detail.id).then((s) => {
      if (!alive) return;
      setLoaded(s);
      const dur = (n: number | null) => (n == null ? "" : formatMs(n));
      const num = (n: number | null) => (n == null ? "" : String(n));
      setRetention(dur(s.messageRetentionMs));
      setMaxRooms(num(s.maxRoomsPerOwner));
      setMaxMsg(num(s.maxMessageLength));
      setEditGrace(dur(s.editGraceMs));
      setMaxForumPost(num(s.maxForumPostLength));
    }).catch(() => { if (alive) setLoaded(null); });
    return () => { alive = false; };
  }, [detail.id]);

  if (!loaded) return <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>;

  // A number field maps to null when blank (clear the override) or its int value.
  const numOrNull = (s: string): number | null => {
    const t = s.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  function save() {
    void run(async () => {
      // Durations are entered friendly and sent as ms; blank clears the
      // override (inherit), so validation runs only on a non-blank value.
      let messageRetentionMs: number | null = null;
      if (retention.trim()) {
        const ms = parseDurationMs(retention);
        if (ms === null || ms <= 0) throw new Error(t("console.settings.retentionError"));
        messageRetentionMs = ms;
      }
      let editGraceMs: number | null = null;
      if (editGrace.trim()) {
        const ms = parseDurationMs(editGrace);
        if (ms === null || ms < 0) throw new Error(t("console.settings.editWindowError"));
        if (ms > 7 * 24 * 60 * 60 * 1000) throw new Error(t("console.settings.editWindowMaxError"));
        editGraceMs = ms;
      }
      await apiPatchSettings(detail.id, {
        messageRetentionMs,
        maxRoomsPerOwner: numOrNull(maxRooms),
        maxMessageLength: numOrNull(maxMsg),
        editGraceMs,
        maxForumPostLength: numOrNull(maxForumPost),
      });
      onSaved();
    });
  }

  return (
    <div className="max-w-xl space-y-4">
      <p className="text-[11px] text-keep-muted">
        <Trans t={t} i18nKey="console.settings.blurb" components={{ v: <span className="text-keep-text" /> }} />
      </p>

      <section className="space-y-3">
        <DurationSetting label={t("console.settings.retention")} value={retention} onChange={setRetention}
          placeholder={t("console.settings.retentionPlaceholder")}
          hint={t("console.settings.retentionHint")} anchor="console.settings.retention" />
        <NumberSetting label={t("console.settings.maxRooms")} hint={t("console.settings.maxRoomsHint")} value={maxRooms} onChange={setMaxRooms} min={1} anchor="console.settings.maxRooms" />
        <NumberSetting label={t("console.settings.maxMessage")} hint={t("console.settings.maxMessageHint")} value={maxMsg} onChange={setMaxMsg} min={1} anchor="console.settings.maxMessage" />
        <DurationSetting label={t("console.settings.editWindow")} value={editGrace} onChange={setEditGrace}
          placeholder={t("console.settings.editWindowPlaceholder")}
          hint={t("console.settings.editWindowHint")} anchor="console.settings.editWindow" />
        <NumberSetting label={t("console.settings.maxForumPost")} hint={t("console.settings.maxForumPostHint")} value={maxForumPost} onChange={setMaxForumPost} min={1} anchor="console.settings.maxForumPost" />
      </section>

      <button type="button" disabled={busy} onClick={save}
        className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("console.settings.saveSettings")}</button>
    </div>
  );
}

/* ------------------------------------------------------------
 * Tab: Onboarding — the ordered new-member prompt flow (migration 0320). Each
 * prompt maps its options to a member-selectable usergroup, so answering the
 * flow grants self-roles. Reads/writes onboarding_config_json +
 * onboarding_enabled through the shared GET/PATCH /servers/:id/settings; the
 * member-facing flow consumes them via the self-roles onboarding endpoints.
 * Folded under manage_appearance (same chair as Rules/Settings).
 * ------------------------------------------------------------ */

/** Short client-side id for a new prompt/option (stable across a single edit
 *  session; the server hashes the whole config, not these ids). */
function onbId(): string {
  return `ob_${Math.random().toString(36).slice(2, 10)}`;
}

function OnboardingTab({ detail, busy, run, onSaved }: TabProps) {
  const { t } = useTranslation("servers");
  const [loaded, setLoaded] = useState<ServerSettingsWire | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [prompts, setPrompts] = useState<OnboardingPrompt[]>([]);
  // The member-selectable usergroups an option may map to (the ONLY valid
  // targets; the server re-validates on completion).
  const [groups, setGroups] = useState<ServerUsergroupWire[] | null>(null);

  useEffect(() => {
    let alive = true;
    apiGetSettings(detail.id).then((s) => {
      if (!alive) return;
      setLoaded(s);
      setEnabled(s.onboardingEnabled);
      let cfg: OnboardingConfig = { prompts: [] };
      if (s.onboardingConfigJson) {
        try { cfg = JSON.parse(s.onboardingConfigJson) as OnboardingConfig; } catch { cfg = { prompts: [] }; }
      }
      setPrompts(Array.isArray(cfg.prompts) ? cfg.prompts : []);
    }).catch(() => { if (alive) setLoaded(null); });
    return () => { alive = false; };
  }, [detail.id]);

  useEffect(() => {
    let alive = true;
    apiGetUsergroups(detail.id)
      .then((d) => { if (alive) setGroups(d.groups.filter((g) => g.memberSelectable && !g.isDefault)); })
      .catch(() => { if (alive) setGroups([]); });
    return () => { alive = false; };
  }, [detail.id]);

  if (!loaded) return <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>;

  const selectable = groups ?? [];

  function setPrompt(i: number, next: OnboardingPrompt) {
    setPrompts((ps) => ps.map((p, j) => (j === i ? next : p)));
  }
  function movePrompt(i: number, dir: -1 | 1) {
    setPrompts((ps) => {
      const j = i + dir;
      if (j < 0 || j >= ps.length) return ps;
      const next = ps.slice();
      const tmp = next[i]!; next[i] = next[j]!; next[j] = tmp;
      return next;
    });
  }
  function addPrompt() {
    setPrompts((ps) => [...ps, { id: onbId(), label: "", kind: "single", options: [] }]);
  }
  function setOption(pi: number, oi: number, next: OnboardingOption) {
    setPrompts((ps) => ps.map((p, j) => (j === pi ? { ...p, options: p.options.map((o, k) => (k === oi ? next : o)) } : p)));
  }
  function addOption(pi: number) {
    const firstGid = selectable[0]?.id ?? "";
    setPrompts((ps) => ps.map((p, j) => (j === pi ? { ...p, options: [...p.options, { label: "", usergroupId: firstGid }] } : p)));
  }
  function removeOption(pi: number, oi: number) {
    setPrompts((ps) => ps.map((p, j) => (j === pi ? { ...p, options: p.options.filter((_, k) => k !== oi) } : p)));
  }

  function save() {
    void run(async () => {
      // Drop empty prompts/options so a half-filled row never persists; keep
      // only options that point at a still-selectable group.
      const validGids = new Set(selectable.map((g) => g.id));
      const clean: OnboardingPrompt[] = prompts
        .map((p) => {
          const help = p.help?.trim();
          return {
            id: p.id,
            kind: p.kind,
            label: p.label.trim(),
            ...(help ? { help } : {}),
            options: p.options
              .filter((o) => o.label.trim() && validGids.has(o.usergroupId))
              .map((o) => ({ label: o.label.trim(), usergroupId: o.usergroupId })),
          };
        })
        .filter((p) => p.label && p.options.length > 0);
      const config: OnboardingConfig = { prompts: clean };
      await apiPatchSettings(detail.id, {
        onboardingEnabled: enabled,
        onboardingConfigJson: clean.length ? JSON.stringify(config) : null,
      });
      onSaved();
    });
  }

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-[11px] text-keep-muted">
        {t("console.onboarding.blurb")}
      </p>

      <label className="flex items-start gap-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5 text-sm">
        <input type="checkbox" className="mt-0.5" checked={enabled} disabled={busy}
          onChange={(e) => setEnabled(e.target.checked)} />
        <span>
          <span className="font-semibold text-keep-text">{t("console.onboarding.showOnJoin")}</span>
          <span className="block text-xs text-keep-muted">{t("console.onboarding.showOnJoinHint")}</span>
        </span>
      </label>

      {selectable.length === 0 ? (
        <p className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2.5 py-2 text-[11px] text-keep-accent">
          {t("console.onboarding.noSelfRoleGroups")}
        </p>
      ) : null}

      <div className="space-y-3">
        {prompts.map((p, pi) => (
          <div key={p.id} className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("console.onboarding.promptN", { n: pi + 1 })}</span>
              <span className="ml-auto flex items-center gap-1">
                <button type="button" disabled={busy || pi === 0} onClick={() => movePrompt(pi, -1)}
                  aria-label={t("console.onboarding.movePromptUp")} title={t("console.onboarding.moveUp")}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] text-keep-muted hover:text-keep-text disabled:opacity-40">↑</button>
                <button type="button" disabled={busy || pi === prompts.length - 1} onClick={() => movePrompt(pi, 1)}
                  aria-label={t("console.onboarding.movePromptDown")} title={t("console.onboarding.moveDown")}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] text-keep-muted hover:text-keep-text disabled:opacity-40">↓</button>
                <button type="button" disabled={busy} onClick={() => setPrompts((ps) => ps.filter((_, j) => j !== pi))}
                  className="rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">{t("shared.remove")}</button>
              </span>
            </div>
            <input value={p.label} maxLength={200} disabled={busy}
              onChange={(e) => setPrompt(pi, { ...p, label: e.target.value })}
              placeholder={t("console.onboarding.questionPlaceholder")}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
            <input value={p.help ?? ""} maxLength={300} disabled={busy}
              onChange={(e) => setPrompt(pi, { ...p, help: e.target.value })}
              placeholder={t("console.onboarding.helperPlaceholder")}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-xs outline-none focus:border-keep-action" />
            <label className="flex items-center gap-2 text-xs text-keep-muted">
              <span className="uppercase tracking-widest">{t("console.onboarding.answerType")}</span>
              <select value={p.kind} disabled={busy}
                onChange={(e) => setPrompt(pi, { ...p, kind: e.target.value === "multi" ? "multi" : "single" })}
                className="rounded border border-keep-rule bg-keep-bg px-1.5 py-1 text-xs outline-none focus:border-keep-action">
                <option value="single">{t("console.onboarding.pickOne")}</option>
                <option value="multi">{t("console.onboarding.pickAny")}</option>
              </select>
            </label>
            <div className="space-y-1.5 border-t border-keep-rule/60 pt-2">
              <p className="text-[10px] uppercase tracking-widest text-keep-muted">{t("console.onboarding.optionsHeading")}</p>
              {p.options.length === 0 ? (
                <p className="text-[11px] italic text-keep-muted">{t("console.onboarding.noOptions")}</p>
              ) : null}
              {p.options.map((o, oi) => (
                <div key={oi} className="flex flex-wrap items-center gap-1.5">
                  <input value={o.label} maxLength={120} disabled={busy}
                    onChange={(e) => setOption(pi, oi, { ...o, label: e.target.value })}
                    placeholder={t("console.onboarding.optionLabelPlaceholder")}
                    className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-1.5 py-1 text-xs outline-none focus:border-keep-action" />
                  <select value={o.usergroupId} disabled={busy || selectable.length === 0}
                    onChange={(e) => setOption(pi, oi, { ...o, usergroupId: e.target.value })}
                    className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-1.5 py-1 text-xs outline-none focus:border-keep-action">
                    {selectable.length === 0 ? <option value="">{t("console.onboarding.noSelfRoleOption")}</option> : null}
                    {selectable.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <button type="button" disabled={busy} onClick={() => removeOption(pi, oi)}
                    aria-label={t("console.onboarding.removeOption")} title={t("console.onboarding.removeOption")}
                    className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">×</button>
                </div>
              ))}
              <button type="button" disabled={busy || selectable.length === 0} onClick={() => addOption(pi)}
                className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action disabled:opacity-40">{t("console.onboarding.addOption")}</button>
            </div>
          </div>
        ))}
      </div>

      <button type="button" disabled={busy} onClick={addPrompt}
        className="rounded border border-keep-action bg-keep-action/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50">{t("console.onboarding.addPrompt")}</button>

      <div>
        <button type="button" disabled={busy} onClick={save}
          className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("console.onboarding.saveOnboarding")}</button>
      </div>
    </div>
  );
}

/* ============================================================
 * The console shell + tab router
 * ============================================================ */

export type ServerSettingsTab = "overview" | "appearance" | "rooms" | "members" | "users" | "roles" | "usergroups" | "applications" | "invites" | "reports" | "modcases" | "bans" | "modlog" | "emoticons" | "announcements" | "events" | "faqs" | "commands-titles" | "earning" | "rules" | "onboarding" | "settings";

interface TabProps {
  detail: ServerConsoleDetail;
  viewer: ServerViewerState;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
  /** Console tab switcher (the shell's changeTab), for the Staff ↔ Roles
   *  wayfinding links. Optional: tabs render fine without it. */
  switchTab?: (tab: ServerSettingsTab) => void;
}

/** Tab label keys in the servers namespace (labels resolve at render time so a
 *  live language flip re-labels the strip). */
const TAB_LABEL_KEY: Record<ServerSettingsTab, string> = {
  overview: "console.tabs.overview", appearance: "console.tabs.appearance", rooms: "console.tabs.rooms", members: "console.tabs.members",
  users: "console.tabs.users",
  roles: "console.tabs.roles", usergroups: "console.tabs.usergroups", applications: "console.tabs.applications", invites: "console.tabs.invites", reports: "console.tabs.reports",
  modcases: "console.tabs.modcases",
  bans: "console.tabs.bans", modlog: "console.tabs.modlog", emoticons: "console.tabs.emoticons", announcements: "console.tabs.announcements",
  events: "console.tabs.events",
  faqs: "console.tabs.faqs", "commands-titles": "console.tabs.commandsTitles", earning: "console.tabs.earning", rules: "console.tabs.rules", onboarding: "console.tabs.onboarding", settings: "console.tabs.settings",
};

/** One-line "what you do here" description keys (docs/ADMIN_IA.md §6),
 *  rendered by the console shell for EVERY tab — per-tab components never
 *  add their own duplicate line. Key style follows {@link TAB_LABEL_KEY}
 *  (camelCase where the label key uses it). */
const TAB_DESC_KEY: Record<ServerSettingsTab, string> = {
  overview: "console.tabDesc.overview", appearance: "console.tabDesc.appearance", rooms: "console.tabDesc.rooms", members: "console.tabDesc.members",
  users: "console.tabDesc.users",
  roles: "console.tabDesc.roles", usergroups: "console.tabDesc.usergroups", applications: "console.tabDesc.applications", invites: "console.tabDesc.invites", reports: "console.tabDesc.reports",
  modcases: "console.tabDesc.modcases",
  bans: "console.tabDesc.bans", modlog: "console.tabDesc.modlog", emoticons: "console.tabDesc.emoticons", announcements: "console.tabDesc.announcements",
  events: "console.tabDesc.events",
  faqs: "console.tabDesc.faqs", "commands-titles": "console.tabDesc.commandsTitles", earning: "console.tabDesc.earning", rules: "console.tabDesc.rules", onboarding: "console.tabDesc.onboarding", settings: "console.tabDesc.settings",
};

/** The five plain-language tab groups (docs/ADMIN_IA.md §6). Display-only:
 *  group ids are never persisted and never sent on the wire; tab ids,
 *  permission gates, and recordNav keys are untouched by grouping. */
type ConsoleTabGroup = "basics" | "people" | "safety" | "activity" | "rewards";

const GROUP_LABEL_KEY: Record<ConsoleTabGroup, string> = {
  basics: "console.group.basics",
  people: "console.group.people",
  safety: "console.group.safety",
  activity: "console.group.activity",
  rewards: "console.group.rewards",
};

interface ConsoleTabItem {
  id: ServerSettingsTab;
  group: ConsoleTabGroup;
}

/** Full tab registry in strip order (docs/ADMIN_IA.md §6). `overview` stays
 *  the first VISIBLE tab for anyone with manage_appearance, so the
 *  `tabs[0] ?? "modlog"` default still lands owners on Overview. */
const CONSOLE_TAB_ITEMS: readonly ConsoleTabItem[] = [
  // ----- Your community: identity, look, and the copy new members meet -----
  { id: "overview", group: "basics" },
  { id: "appearance", group: "basics" },
  { id: "rules", group: "basics" },
  { id: "onboarding", group: "basics" },
  { id: "settings", group: "basics" },
  // ----- People: who belongs here and what they may do -----
  { id: "members", group: "people" },
  { id: "users", group: "people" },
  { id: "roles", group: "people" },
  { id: "usergroups", group: "people" },
  { id: "applications", group: "people" },
  { id: "invites", group: "people" },
  // ----- Safety: reports, cases, bans, and the paper trail -----
  { id: "reports", group: "safety" },
  { id: "modcases", group: "safety" },
  { id: "bans", group: "safety" },
  { id: "modlog", group: "safety" },
  // ----- Rooms & events: the spaces and the calendar -----
  { id: "rooms", group: "activity" },
  { id: "announcements", group: "activity" },
  { id: "events", group: "activity" },
  { id: "faqs", group: "activity" },
  // ----- Fun & rewards: the extras members play with -----
  { id: "emoticons", group: "rewards" },
  { id: "commands-titles", group: "rewards" },
  { id: "earning", group: "rewards" },
];

/** Per-tab visibility. The gates are byte-equivalent to the pre-grouping
 *  inline list; only the strip ORDER changed (docs/ADMIN_IA.md §6). */
function consoleTabVisible(id: ServerSettingsTab, can: (k: ServerModPermission) => boolean): boolean {
  switch (id) {
    case "overview":
    case "appearance":
    // Onboarding writes onboarding_config_json on server_settings, which the
    // route gates on manage_appearance (same chair as rules/settings), so gate
    // the tab identically. The option→usergroup targets come from the Roles
    // tab's (id `usergroups`) "Members can pick this" toggle (manage_usergroups).
    case "rules":
    case "onboarding":
    case "settings":
      return can("manage_appearance");
    case "members":
    case "roles":
      return can("manage_members");
    // A moderation-focused user finder: search any member and mute/ban/remove
    // them (or open their profile) without having to catch them in a room.
    // Shown to anyone holding any one of the moderation grants it exposes.
    case "users":
      return can("kick_member") || can("mute_member") || can("ban_member") || can("manage_members");
    case "usergroups":
      return can("manage_usergroups");
    case "applications":
      return can("manage_applications");
    case "invites":
      return can("manage_invites");
    case "reports":
      return can("manage_reports");
    case "modcases":
      return can("manage_mod_cases");
    case "bans":
      return can("ban_member") || can("unban_member");
    case "modlog":
      return can("view_mod_log");
    case "rooms":
      return can("manage_rooms");
    case "announcements":
      return can("manage_announcements");
    case "events":
      return can("manage_events");
    case "faqs":
      return can("manage_faqs");
    case "emoticons":
      return can("manage_emoticons");
    case "commands-titles":
      return can("manage_commands") || can("manage_titles");
    case "earning":
      return can("manage_earning");
  }
}

/** The viewer's visible `{ id, group }` tab list, in strip order. Tabs are
 *  gated on the mirrored permission set exactly as before (the routes
 *  re-check every action); empty groups simply drop out of the strip. */
function visibleConsoleTabs(viewer: ServerViewerState): ConsoleTabItem[] {
  const perms = new Set(viewer.permissions);
  const can = (k: ServerModPermission) => viewer.isOwner || perms.has(k);
  return CONSOLE_TAB_ITEMS.filter((item) => consoleTabVisible(item.id, can));
}

/** Tab id → group id, for the search hits' breadcrumb line. Derived from
 *  the registry so it can never drift. */
const TAB_GROUP_BY_ID = Object.fromEntries(
  CONSOLE_TAB_ITEMS.map((item) => [item.id, item.group]),
) as Record<ServerSettingsTab, ConsoleTabGroup>;

/** The console find-a-setting index: one tab-level entry per registered tab
 *  (derived, never hand-listed — docs/ADMIN_IA.md §6) plus the curated
 *  row-level entries from serverConsoleSearchIndex.ts (empty in v1). */
const CONSOLE_SEARCH_ENTRIES: readonly ServerConsoleSearchEntry[] = [
  ...CONSOLE_TAB_ITEMS.map((item) => ({
    key: TAB_LABEL_KEY[item.id],
    tab: item.id,
    also: [TAB_DESC_KEY[item.id]],
  })),
  ...SERVER_CONSOLE_SEARCH_ENTRIES,
];

/**
 * The owner-console body once the server detail has loaded. Tabs are gated on
 * the viewer's mirrored permission set exactly as ForumSettingsView gates on
 * forum perms; the routes re-check every action.
 */
function ServerSettingsBody({ detail, viewer, onSaved, findRequest, onFindHandled }: {
  detail: ServerConsoleDetail;
  viewer: ServerViewerState;
  onSaved: () => void;
  /** Armed find-a-setting pick from the header search (the view owns the
   *  input, this body owns the tab state — docs/ADMIN_IA.md §6). */
  findRequest?: { tab: ServerSettingsTab; anchor: string } | null;
  onFindHandled?: () => void;
}) {
  const { t } = useTranslation("servers");
  // Visible tabs in the grouped strip order; gates unchanged (the routes
  // re-check every action regardless).
  const tabs = visibleConsoleTabs(viewer);
  const [tab, setTab] = useState<ServerSettingsTab>(tabs[0]?.id ?? "modlog");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Calm mode: ease the active tab's body in with a soft fade on each tab
  // change. Key + class applied ONLY when Reduce Motion is on; off-path is
  // unchanged.
  const reduceMotion = useReducedMotion();
  // Armed find-a-setting jump: after the picked tab's body mounts, scroll to
  // its data-admin-anchor and pulse the flash class, then disarm. Tab-level
  // hits never arm this (they stop at the tab switch).
  const [pendingFind, setPendingFind] = useState<{ tab: ServerSettingsTab; anchor: string } | null>(null);

  // Both nav pickers (and search picks) route through one helper so the
  // recordNav choke point stays single: same `server-settings:<tab>` key,
  // recorded only on an actual change, exactly as before.
  const changeTab = (next: ServerSettingsTab) => {
    if (next !== tab) recordNav("tab", `server-settings:${next}`);
    // A plain tab hop abandons any armed jump so a stale anchor can't
    // scroll/flash the next time that tab renders. The findRequest effect
    // re-arms AFTER calling this (same batch), so search jumps still land.
    setPendingFind(null);
    setTab(next);
  };

  // Apply a header-search pick. Reuses changeTab (same recordNav key, same
  // silent-drop of unsaved edits as a plain tab click). Tab-level hits
  // (console.tabs.*) stop at the switch; row-level hits arm the jump.
  useEffect(() => {
    if (!findRequest) return;
    changeTab(findRequest.tab);
    if (!findRequest.anchor.startsWith("console.tabs.")) {
      setPendingFind({ tab: findRequest.tab, anchor: findRequest.anchor });
    }
    onFindHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findRequest]);
  // Wait two frames so the freshly-switched tab body has mounted, then
  // scroll + flash. A missing anchor is silently fine — the user still
  // lands on the right tab.
  useEffect(() => {
    if (!pendingFind || pendingFind.tab !== tab) return;
    return afterNextPaint(() => {
      flashAnchor(pendingFind.anchor, reduceMotion);
      setPendingFind(null);
    });
  }, [pendingFind, tab, reduceMotion]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); }
    catch (e) { setErr(e instanceof Error ? e.message : t("shared.saveFailed")); }
    finally { setBusy(false); }
  }

  const props: TabProps = { detail, viewer, busy, run, onSaved, switchTab: changeTab };

  return (
    <div className="px-4 py-3">
      {/* Tab nav: a WRAPPING strip on desktop — the console lives in a
          resizable floating window now, so a fixed one-row strip clips its
          tail behind a hidden scrollbar at narrow widths; wrapping keeps
          every tab reachable at any window size. Collapsed to a dropdown
          on mobile. Both feed the same changeTab; the desktop strip
          carries the tour anchors. Tabs cluster into the five plain-language
          groups from docs/ADMIN_IA.md §6 — <optgroup>s on the dropdown,
          hairline separators on the strip — so an owner scans five buckets
          instead of twenty-one labels. */}
      <div className="mb-3">
        <select
          value={tab}
          onChange={(e) => changeTab(e.target.value as ServerSettingsTab)}
          aria-label={t("console.shell.sectionAria")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm [@container(min-width:768px)]:hidden"
        >
          {groupVisibleTabs(tabs).map(([group, items]) => (
            <optgroup key={group} label={t(GROUP_LABEL_KEY[group])}>
              {items.map((item) => <option key={item.id} value={item.id}>{t(TAB_LABEL_KEY[item.id])}</option>)}
            </optgroup>
          ))}
        </select>
        <div data-tour="server-settings-tab-strip" className="hidden min-w-0 flex-wrap items-center gap-1 [@container(min-width:768px)]:flex">
          {withGroupSeparators(tabs).map((entry) =>
            entry.kind === "separator" ? (
              <span
                key={`sep:${entry.afterGroup}`}
                aria-hidden
                className="mx-1 h-4 w-px shrink-0 self-center bg-keep-rule/60"
                title={t(GROUP_LABEL_KEY[entry.afterGroup])}
              />
            ) : (
              <button key={entry.tab.id} type="button" data-tour={`server-settings-tab-${entry.tab.id}`} onClick={() => changeTab(entry.tab.id)}
                className={`shrink-0 rounded border px-2.5 py-1 text-xs uppercase tracking-widest ${tab === entry.tab.id ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"}`}>
                {t(TAB_LABEL_KEY[entry.tab.id])}
              </button>
            ),
          )}
        </div>
      </div>
      {/* One-line "what you do here" for the active tab, rendered by the
          shell for every tab (one code path, no per-tab edits). Same
          treatment on mobile and desktop. */}
      <p className="mb-3 text-[11px] text-keep-muted">{t(TAB_DESC_KEY[tab])}</p>
      {err ? <p className="mb-2 text-xs text-keep-accent">{err}</p> : null}
      {(() => {
        const body = tab === "overview" ? <OverviewTab {...props} />
          : tab === "appearance" ? <AppearanceTab {...props} />
          : tab === "rooms" ? <RoomsTab {...props} />
          : tab === "members" ? <MembersTab {...props} />
          : tab === "users" ? <UsersTab {...props} />
          : tab === "roles" ? <RolesTab {...props} />
          : tab === "usergroups" ? <UsergroupsTab {...props} />
          : tab === "applications" ? <ApplicationsTab {...props} />
          : tab === "invites" ? <InvitesTab {...props} />
          : tab === "reports" ? <ReportsTab serverId={detail.id} viewer={viewer} busy={busy} run={run} onSaved={onSaved} />
          : tab === "modcases" ? <ModCasesTab serverId={detail.id} viewer={viewer} busy={busy} run={run} onSaved={onSaved} />
          : tab === "bans" ? <BansTab {...props} />
          : tab === "modlog" ? <ModLogTab detail={detail} />
          : tab === "emoticons" ? <EmoticonsTab serverId={detail.id} viewer={viewer} busy={busy} run={run} onSaved={onSaved} />
          : tab === "announcements" ? <AnnouncementsTab serverId={detail.id} viewer={viewer} busy={busy} run={run} onSaved={onSaved} />
          : tab === "events" ? <EventsTab serverId={detail.id} viewer={viewer} busy={busy} run={run} onSaved={onSaved} />
          : tab === "faqs" ? <FaqsTab serverId={detail.id} viewer={viewer} busy={busy} run={run} onSaved={onSaved} />
          : tab === "commands-titles" ? <CommandsTitlesTab serverId={detail.id} viewer={viewer} busy={busy} run={run} onSaved={onSaved} />
          : tab === "earning" ? <EarningTab serverId={detail.id} viewer={viewer} busy={busy} run={run} onSaved={onSaved} />
          : tab === "rules" ? <RulesTab {...props} />
          : tab === "onboarding" ? <OnboardingTab {...props} />
          : <SettingsTab {...props} />;
        // Calm mode only: wrap the body in a remount-on-tab-change (key) div
        // carrying `tk-fade-in` so the new tab eases in. When Reduce Motion is
        // off we render the body bare — no extra wrapper, no class — so the
        // DOM is byte-identical to before.
        return reduceMotion ? <div key={tab} className="tk-fade-in">{body}</div> : body;
      })()}
    </div>
  );
}

/**
 * ServerSettingsView — the modal entry point App mounts when the rail's gear is
 * pressed on a server the viewer owns/moderates. Fetches GET /servers/:id for
 * the detail + viewer state, applies the server's scoped theme/design while
 * open (CSP-nonce path), and renders the tabbed body.
 */
export function ServerSettingsView({ serverId, onClose, onChanged }: { serverId: string; onClose: () => void; onChanged?: () => void }) {
  const { t } = useTranslation("servers");
  // Search CHROME strings (icon title etc.) live in the admin namespace so
  // both admin surfaces share one set (docs/ADMIN_IA.md §6).
  const { t: tAdmin } = useTranslation("admin");
  const [state, setState] = useState<{ detail: ServerConsoleDetail; viewer: ServerViewerState } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Replay the server-admin walkthrough on demand (the "?" in the header).
  const setForcedTourId = useChat((s) => s.setForcedTourId);

  // Clear to the loading state ONLY when the target server changes — never on a
  // post-save refetch. Nulling `state` on every `tick` unmounted the tabbed
  // body (the render falls back to "Loading…"), which reset the open tab to the
  // default on every save. Keeping the old detail mounted while the refetch is
  // in flight preserves the active tab (and avoids a loading flash).
  useEffect(() => { setState(null); setErr(null); }, [serverId]);
  useEffect(() => {
    let alive = true;
    apiGetServer(serverId)
      .then((r) => { if (!alive) return; if (!r.viewer) { setErr(t("console.shell.notManager")); return; } setState({ detail: r.server, viewer: r.viewer }); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : t("console.shell.loadError")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, tick]);

  // Per-server theme/design while the console is open — routed through the
  // shared scopedRootDesign path so it never bleeds into the user's own theme.
  const forumTheme = useMemo<Theme | null>(() => {
    if (!state?.detail.themeJson) return null;
    try { return normalizeTheme(JSON.parse(state.detail.themeJson)); } catch { return null; }
  }, [state?.detail.themeJson]);
  const activeTheme = useActiveTheme();
  useScopedRootDesign(forumTheme ?? activeTheme, state?.detail.themeStyleKey ?? null, !!state, activeTheme);

  // Whether the viewer holds ANY console-relevant power; if not, deny.
  const allowed = useMemo(() => {
    const v = state?.viewer;
    if (!v) return false;
    if (v.isOwner) return true;
    const perms = new Set(v.permissions);
    return SERVER_MOD_PERMISSIONS.some((k) => perms.has(k));
  }, [state?.viewer]);

  // ----- Find-a-setting search (docs/ADMIN_IA.md §6) -----
  // The view owns the header-mounted input; the tabbed body owns the tab
  // state, so a pick travels down as `findRequest` and is cleared through
  // onFindHandled once the body has switched (and, for future row-level
  // entries, scrolled + flashed the data-admin-anchor).
  const searchReady = !!state && !err && allowed;
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [findRequest, setFindRequest] = useState<{ tab: ServerSettingsTab; anchor: string } | null>(null);
  const desktopSearchRef = useRef<HTMLInputElement>(null);
  // Permission-visible tab ids: hits on tabs the viewer can't open never
  // surface (same visibleConsoleTabs gates the strip uses).
  const searchTabIds = useMemo(
    () => new Set<string>(state && allowed ? visibleConsoleTabs(state.viewer).map((item) => item.id) : []),
    [state, allowed],
  );
  // Breadcrumb pieces for a hit: group › tab. All already-translated;
  // FindSetting adds the aria-hidden separators.
  const searchBreadcrumb = useCallback(
    (entry: ServerConsoleSearchEntry): readonly string[] => [
      t(GROUP_LABEL_KEY[TAB_GROUP_BY_ID[entry.tab]]),
      t(TAB_LABEL_KEY[entry.tab]),
    ],
    [t],
  );
  const pickFind = useCallback((entry: ServerConsoleSearchEntry) => {
    setFindRequest({ tab: entry.tab, anchor: entry.key });
  }, []);
  const onFindHandled = useCallback(() => setFindRequest(null), []);
  // Ctrl/Cmd+K anywhere inside the console focuses the search (desktop) or
  // opens the mobile search row, which autofocuses. Same hook as the
  // Global Admin shell.
  const onShellKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!searchReady) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const el = desktopSearchRef.current;
      if (el && el.offsetParent !== null) el.focus();
      else setMobileSearchOpen(true);
    }
  };

  return (
    <FloatingWindow
      onClose={onClose}
      onKeyDown={onShellKeyDown}
      title={
        state ? (
          <>
            {state.detail.name}
            <span className="ml-2 text-xs font-normal text-keep-muted">{t("console.shell.title")}</span>
          </>
        ) : (
          t("console.shell.title")
        )
      }
      className="rounded-lg border border-keep-rule bg-keep-bg text-keep-text"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Toolbar row (search + tour). The window title lives on the
            FloatingWindow bar now; hide the row entirely when it has
            nothing to show so loading doesn't paint an empty strip. */}
        <header className={`${searchReady || (state && state.viewer.isOwner) ? "flex" : "hidden"} shrink-0 items-center gap-2 border-b border-keep-rule px-4 py-2`}>
          {searchReady && mobileSearchOpen ? (
            /* Find-a-setting, mobile: the search row swaps in over the
               normal header content; picking a hit or tapping the X swaps
               it back. The input autofocuses. Container-hidden ≥768px so a
               WINDOW grown to desktop width falls back to the normal row
               (inline search). */
            <div className="min-w-0 flex-1 [@container(min-width:768px)]:hidden">
              <FindSetting
                layout="mobile"
                entries={CONSOLE_SEARCH_ENTRIES}
                redirects={SERVER_CONSOLE_SEARCH_REDIRECTS}
                resolve={t}
                breadcrumb={searchBreadcrumb}
                visibleTabIds={searchTabIds}
                onPick={pickFind}
                onClose={() => setMobileSearchOpen(false)}
              />
            </div>
          ) : null}
          <div className={`${searchReady && mobileSearchOpen ? "hidden [@container(min-width:768px)]:flex" : "flex"} min-w-0 flex-1 items-center justify-end gap-2`}>
            {searchReady ? (
              <>
                {/* Find-a-setting, desktop: type what you're looking for and
                    jump straight to the tab that owns it. Results pop over
                    the body, anchored under the input. Ctrl/Cmd+K focuses
                    it from anywhere in the console. */}
                <div className="hidden [@container(min-width:768px)]:block">
                  <FindSetting
                    layout="desktop"
                    entries={CONSOLE_SEARCH_ENTRIES}
                    redirects={SERVER_CONSOLE_SEARCH_REDIRECTS}
                    resolve={t}
                    breadcrumb={searchBreadcrumb}
                    visibleTabIds={searchTabIds}
                    onPick={pickFind}
                    inputRef={desktopSearchRef}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setMobileSearchOpen(true)}
                  title={tAdmin("panel.search.open")}
                  aria-label={tAdmin("panel.search.open")}
                  className="shrink-0 rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text [@container(min-width:768px)]:hidden"
                >
                  <Search className="h-4 w-4" aria-hidden="true" />
                </button>
              </>
            ) : null}
            {state && state.viewer.isOwner ? (
              <button type="button" onClick={() => setForcedTourId("server-admin")} title={t("discover.form.tourTitle")} aria-label={t("discover.form.tourTitle")}
                className="shrink-0 rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text">
                <HelpCircle className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {err ? (
            <p className="m-4 rounded border border-keep-accent/50 bg-keep-accent/10 px-3 py-2 text-sm text-keep-accent">{err}</p>
          ) : !state ? (
            <p className="m-4 text-sm italic text-keep-muted">{t("shared.loading")}</p>
          ) : !allowed ? (
            <p className="m-4 text-sm italic text-keep-muted">{t("console.shell.noPowers")}</p>
          ) : (
            <ServerSettingsBody detail={state.detail} viewer={state.viewer} onSaved={() => { setTick((t) => t + 1); onChanged?.(); }} findRequest={findRequest} onFindHandled={onFindHandled} />
          )}
        </div>
        {/* First-run walkthrough of the console — OWNER-only. Its steps tour the
            Overview/Appearance/Members/Staff tabs, which are owner-gated
            (manage_appearance is owner-only), so firing it for a mod/admin with a
            narrower tab set would narrate tabs they can't see. Mounted
            unconditionally, driven by `active` once the body (with its anchors)
            is on screen; self-fires when unseen and replays from the header "?". */}
        <ContextualTour tourId="server-admin" active={!!state && !!state.viewer.isOwner} />
      </div>
    </FloatingWindow>
  );
}
