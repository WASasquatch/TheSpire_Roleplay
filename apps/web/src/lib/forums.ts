/**
 * Forums Catalog fetch helpers (Forums revamp, Phase 1). Thin wrappers over
 * the public catalog endpoints; both tolerate anonymous sessions (the
 * Phase-7 public /f/ page reuses them).
 */
import type { ChatMessage, ForumAutoRule, ForumBoardTopicsPage, ForumCreationApplicationWire, ForumDetail, ForumManagedEntry, ForumMemberEntry, ForumMembershipApplicationWire, ForumModEntry, ForumModLogEntry, ForumModPermission, ForumPermission, ForumReportWire, ForumSummary, ForumUsergroupMemberWire, ForumUsergroupWire, ForumUserSearchHit, NpcStat, ThreadCategory, UserNpcWire } from "@thekeep/shared";

export async function fetchForums(): Promise<ForumSummary[]> {
  const r = await fetch("/forums", { credentials: "include" });
  if (!r.ok) throw new Error(`Couldn't load the forums catalog (${r.status}).`);
  const j = (await r.json()) as { forums: ForumSummary[] };
  return j.forums;
}

export async function fetchForumDetail(idOrSlug: string): Promise<ForumDetail> {
  const r = await fetch(`/forums/${encodeURIComponent(idOrSlug)}`, { credentials: "include" });
  if (r.status === 404) throw new Error("That forum doesn't exist (or was archived).");
  if (!r.ok) throw new Error(`Couldn't load that forum (${r.status}).`);
  return (await r.json()) as ForumDetail;
}

/** Compact relative time for activity pulses: "just now", "5m", "3h", "2d". */
export function relTime(ms: number | null): string | null {
  if (!ms) return null;
  const delta = Date.now() - ms;
  if (delta < 90_000) return "just now";
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ============================================================
 * "Create your Forum" applications (Phase 2)
 * ============================================================ */

export type SlugCheck = { ok: true } | { ok: false; reason: "invalid" | "reserved" | "taken" | "pending" };

export async function checkForumSlug(slug: string): Promise<SlugCheck> {
  const r = await fetch(`/forums/slug-availability?slug=${encodeURIComponent(slug)}`, { credentials: "include" });
  if (!r.ok) return { ok: false, reason: "invalid" };
  return (await r.json()) as SlugCheck;
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!r.ok) throw new Error(j?.error ?? `Request failed (${r.status}).`);
  return j as T;
}

export async function submitForumApplication(input: {
  name: string; slug: string; purpose: string;
}): Promise<ForumCreationApplicationWire> {
  const r = await fetch("/forums/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  const j = await jsonOrThrow<{ application: ForumCreationApplicationWire }>(r);
  return j.application;
}

export async function fetchMyForumApplications(): Promise<ForumCreationApplicationWire[]> {
  const r = await fetch("/forums/applications/mine", { credentials: "include" });
  const j = await jsonOrThrow<{ applications: ForumCreationApplicationWire[] }>(r);
  return j.applications;
}

export async function adminFetchForumApplications(): Promise<{
  pending: ForumCreationApplicationWire[]; recent: ForumCreationApplicationWire[];
}> {
  const r = await fetch("/admin/forums/applications", { credentials: "include" });
  return jsonOrThrow(r);
}

/** Topic cards for a board (in-modal reader). `before` = lastActivityAt
 *  cursor from the previous page's oldest non-sticky topic. */
export async function fetchBoardTopics(roomId: string, before?: number): Promise<ForumBoardTopicsPage> {
  const qs = before ? `?before=${before}` : "";
  const r = await fetch(`/forums/boards/${encodeURIComponent(roomId)}/topics${qs}`, { credentials: "include" });
  return jsonOrThrow<ForumBoardTopicsPage>(r);
}

/** Full topic + reply chain. Reuses the route the jump-to-message flow
 *  already uses, so the reader and chat can never disagree on a thread. */
export async function fetchTopicThread(roomId: string, topicId: string): Promise<{ topic: ChatMessage; replies: ChatMessage[] }> {
  const r = await fetch(
    `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(topicId)}/thread`,
    { credentials: "include" },
  );
  return jsonOrThrow<{ topic: ChatMessage; replies: ChatMessage[] }>(r);
}

/* ============================================================
 * Owner console (Phase 3)
 * ============================================================ */

export async function updateForum(forumId: string, patch: {
  name?: string; tagline?: string | null; descriptionHtml?: string | null; boardOrder?: string[];
  postingMode?: "open" | "application"; applicationPrompt?: string | null;
  themeJson?: string | null; themeStyleKey?: string | null; bannerFocusY?: number;
  publicBrowsing?: boolean; allowCustomTags?: boolean; linkedWorldId?: string | null;
}): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  await jsonOrThrow(r);
}

export async function createBoard(forumId: string, input: { name: string; topic?: string }): Promise<string> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/boards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  const j = await jsonOrThrow<{ roomId: string }>(r);
  return j.roomId;
}

export async function updateBoard(forumId: string, roomId: string, patch: {
  name?: string; topic?: string | null; membersOnly?: boolean;
}): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/boards/${encodeURIComponent(roomId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  await jsonOrThrow(r);
}

export async function archiveBoard(forumId: string, roomId: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/boards/${encodeURIComponent(roomId)}/archive`, {
    method: "POST",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

/** Upload (or clear, with null) the forum's logo or banner image. Body is a
 *  base64 data URL — same pipeline as emoticon sheets (magic-byte checked,
 *  content-hashed, served from /uploads/forums/). Returns the new URL. */
export async function setForumImage(
  forumId: string,
  kind: "logo" | "banner",
  imageDataUrl: string | null,
): Promise<string | null> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(imageDataUrl ? { imageDataUrl } : { clear: true }),
  });
  const j = await jsonOrThrow<{ url: string | null }>(r);
  return j.url;
}

/** Upload (or clear) a thread-category icon on one of the forum's boards. */
export async function setCategoryIcon(
  forumId: string,
  roomId: string,
  catId: string,
  imageDataUrl: string | null,
): Promise<void> {
  const r = await fetch(
    `/forums/${encodeURIComponent(forumId)}/boards/${encodeURIComponent(roomId)}/categories/${encodeURIComponent(catId)}/icon`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(imageDataUrl ? { imageDataUrl } : { clear: true }),
    },
  );
  await jsonOrThrow(r);
}

/** The caller's own worlds (for the Appearance tab's link-a-world picker). */
export async function fetchMyWorlds(): Promise<Array<{ id: string; name: string; visibility: string }>> {
  const r = await fetch("/me/worlds", { credentials: "include" });
  const j = await jsonOrThrow<{ worlds: Array<{ id: string; name: string; visibility: string }> }>(r);
  return j.worlds;
}

/** Read a picked file as a data URL with a client-side size guard (the
 *  server re-checks; this just fails fast before shipping megabytes). */
export function readImageFile(file: File, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > maxBytes) {
      reject(new Error(`Image too large (max ${Math.round(maxBytes / 1024)}KB).`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

/** Category CRUD rides the existing room endpoints — a board IS a room and
 *  carries the forum owner as its room owner, so the gates already pass. */
export async function fetchRoomCategories(roomId: string): Promise<ThreadCategory[]> {
  const r = await fetch(`/rooms/${encodeURIComponent(roomId)}/thread-categories`, { credentials: "include" });
  const j = await jsonOrThrow<{ categories: ThreadCategory[] }>(r);
  return j.categories;
}

export async function createRoomCategory(roomId: string, name: string, sortOrder: number, subtitle?: string | null, parentId?: string | null, membersOnly?: boolean): Promise<void> {
  const r = await fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      name,
      sortOrder,
      ...(subtitle !== undefined ? { subtitle } : {}),
      ...(parentId ? { parentId } : {}),
      ...(membersOnly !== undefined ? { membersOnly } : {}),
    }),
  });
  await jsonOrThrow(r);
}

export async function patchRoomCategory(roomId: string, catId: string, patch: { name?: string; sortOrder?: number; subtitle?: string | null; parentId?: string | null; membersOnly?: boolean }): Promise<void> {
  const r = await fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories/${encodeURIComponent(catId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  await jsonOrThrow(r);
}

export async function deleteRoomCategory(roomId: string, catId: string): Promise<void> {
  const r = await fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories/${encodeURIComponent(catId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

/* ============================================================
 * Membership applications + leave (Phase 5)
 * ============================================================ */

export async function applyForumMembership(forumId: string, answer?: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/membership-applications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(answer?.trim() ? { answer: answer.trim() } : {}),
  });
  await jsonOrThrow(r);
}

export async function withdrawForumMembership(forumId: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/membership-applications/mine`, {
    method: "DELETE",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

export async function fetchForumMembershipApplications(forumId: string): Promise<{
  pending: ForumMembershipApplicationWire[]; recent: ForumMembershipApplicationWire[];
}> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/membership-applications`, { credentials: "include" });
  return jsonOrThrow(r);
}

export async function reviewForumMembershipApplication(
  forumId: string,
  appId: string,
  action: "approve" | "reject",
  reviewNote?: string,
): Promise<void> {
  const r = await fetch(
    `/forums/${encodeURIComponent(forumId)}/membership-applications/${encodeURIComponent(appId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(reviewNote ? { action, reviewNote } : { action }),
    },
  );
  await jsonOrThrow(r);
}

export async function leaveForum(forumId: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/leave`, {
    method: "POST",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

/** Instantly join an OPEN forum (no review). Used to unlock members-only
 *  sections of an open forum; application-mode forums use applyForumMembership. */
export async function joinForum(forumId: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/join`, {
    method: "POST",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

/* ============================================================
 * Roles + bans (Phase 4)
 * ============================================================ */

export interface ForumRoles {
  owner: { userId: string; username: string; avatarUrl: string | null };
  /** The acting manager's own permission set — a non-owner manager can't
   *  grant keys they don't hold (the picker disables those checkboxes). */
  managerPermissions: ForumModPermission[];
  mods: ForumModEntry[];
}

export interface ForumBanRow {
  userId: string;
  username: string;
  until: number | null;
  reason: string | null;
  createdAt: number;
  expired: boolean;
}

export async function fetchForumRoles(forumId: string): Promise<ForumRoles> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/roles`, { credentials: "include" });
  return jsonOrThrow<ForumRoles>(r);
}

export async function grantForumMod(
  forumId: string,
  target: string,
  permissions?: ForumModPermission[],
): Promise<{ username: string; permissions: ForumModPermission[] }> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/mods`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(permissions ? { target, permissions } : { target }),
  });
  return jsonOrThrow<{ username: string; permissions: ForumModPermission[] }>(r);
}

/** Replace an existing mod's granular permission set (Roles tab checkboxes). */
export async function setForumModPermissions(
  forumId: string,
  userId: string,
  permissions: ForumModPermission[],
): Promise<{ permissions: ForumModPermission[] }> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/mods/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ permissions }),
  });
  return jsonOrThrow<{ permissions: ForumModPermission[] }>(r);
}

/** The forums the signed-in viewer owns or moderates (with their permission
 *  set). Used by the profile "Ban from forum" action + its forum-picker.
 *  Briefly cached so the two profile action rows (mobile + desktop) that
 *  mount the ban control share one request; `invalidateManagedForums()`
 *  drops it after a role/ban change. */
let managedForumsCache: { at: number; promise: Promise<ForumManagedEntry[]> } | null = null;
const MANAGED_FORUMS_TTL = 30_000;
export function invalidateManagedForums(): void { managedForumsCache = null; }
export async function fetchMyManagedForums(): Promise<ForumManagedEntry[]> {
  const now = Date.now();
  if (managedForumsCache && now - managedForumsCache.at < MANAGED_FORUMS_TTL) {
    return managedForumsCache.promise;
  }
  const promise = (async () => {
    const r = await fetch("/me/forums", { credentials: "include" });
    const j = await jsonOrThrow<{ forums: ForumManagedEntry[] }>(r);
    return j.forums;
  })().catch((e) => { managedForumsCache = null; throw e; });
  managedForumsCache = { at: now, promise };
  return promise;
}

/** Typeahead for the mod/ban pickers. Matches a username or character-name
 *  prefix; each hit is annotated with the account's role/ban in this forum. */
export async function searchForumUsers(forumId: string, q: string): Promise<ForumUserSearchHit[]> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/user-search?q=${encodeURIComponent(q)}`, { credentials: "include" });
  const j = await jsonOrThrow<{ hits: ForumUserSearchHit[] }>(r);
  return j.hits;
}

export async function revokeForumMod(forumId: string, userId: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/mods/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

/* ============================================================
 * Usergroups (unified permissions + auto-join rules)
 * ============================================================ */

export interface ForumUsergroupsResponse {
  groups: ForumUsergroupWire[];
  /** Acting manager's own perms — keys they lack are greyed in the grid. */
  managerPermissions: ForumPermission[];
}

export async function fetchForumUsergroups(forumId: string): Promise<ForumUsergroupsResponse> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/usergroups`, { credentials: "include" });
  return jsonOrThrow<ForumUsergroupsResponse>(r);
}

export async function createForumUsergroup(forumId: string, input: {
  name: string; color?: string | null; permissions?: ForumPermission[]; autoRules?: ForumAutoRule[];
}): Promise<string> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/usergroups`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify(input),
  });
  const j = await jsonOrThrow<{ id: string }>(r);
  return j.id;
}

export async function updateForumUsergroup(forumId: string, groupId: string, patch: {
  name?: string; color?: string | null; permissions?: ForumPermission[]; autoRules?: ForumAutoRule[]; sortOrder?: number;
}): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/usergroups/${encodeURIComponent(groupId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify(patch),
  });
  await jsonOrThrow(r);
}

export async function deleteForumUsergroup(forumId: string, groupId: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/usergroups/${encodeURIComponent(groupId)}`, {
    method: "DELETE", credentials: "include",
  });
  await jsonOrThrow(r);
}

export async function fetchForumUsergroupMembers(forumId: string, groupId: string): Promise<ForumUsergroupMemberWire[]> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/usergroups/${encodeURIComponent(groupId)}/members`, { credentials: "include" });
  const j = await jsonOrThrow<{ members: ForumUsergroupMemberWire[] }>(r);
  return j.members;
}

export async function addForumUsergroupMember(forumId: string, groupId: string, target: string): Promise<{ username: string }> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/usergroups/${encodeURIComponent(groupId)}/members`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify({ target }),
  });
  return jsonOrThrow<{ username: string }>(r);
}

export async function removeForumUsergroupMember(forumId: string, groupId: string, userId: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/usergroups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE", credentials: "include",
  });
  await jsonOrThrow(r);
}

/* ============================================================
 * Account NPCs (Phase 6) — per-account, reusable in any forum
 * ============================================================ */

export async function fetchMyNpcs(): Promise<UserNpcWire[]> {
  const r = await fetch("/me/npcs", { credentials: "include" });
  const j = await jsonOrThrow<{ npcs: UserNpcWire[] }>(r);
  return j.npcs;
}

export async function createNpc(input: { name: string; stats: NpcStat[] }): Promise<UserNpcWire> {
  const r = await fetch("/me/npcs", {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify(input),
  });
  const j = await jsonOrThrow<{ npc: UserNpcWire }>(r);
  return j.npc;
}

export async function updateNpc(id: string, input: { name: string; stats: NpcStat[] }): Promise<UserNpcWire> {
  const r = await fetch(`/me/npcs/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify(input),
  });
  const j = await jsonOrThrow<{ npc: UserNpcWire }>(r);
  return j.npc;
}

export async function deleteNpc(id: string): Promise<void> {
  const r = await fetch(`/me/npcs/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
  await jsonOrThrow(r);
}

/* ============================================================
 * Topic prefixes (Phase 5)
 * ============================================================ */

export async function createForumPrefix(forumId: string, input: { label: string; color: string; tooltip?: string | null; categoryIds?: string[]; staffOnly?: boolean }): Promise<string> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/prefixes`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify(input),
  });
  const j = await jsonOrThrow<{ id: string }>(r);
  return j.id;
}

export async function updateForumPrefix(forumId: string, prefixId: string, patch: { label?: string; color?: string; tooltip?: string | null; sortOrder?: number; categoryIds?: string[]; staffOnly?: boolean }): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/prefixes/${encodeURIComponent(prefixId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify(patch),
  });
  await jsonOrThrow(r);
}

export async function deleteForumPrefix(forumId: string, prefixId: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/prefixes/${encodeURIComponent(prefixId)}`, {
    method: "DELETE", credentials: "include",
  });
  await jsonOrThrow(r);
}

/** Assign (or clear, with null) a topic's prefix. Author or manage_prefixes. */
export async function setTopicPrefix(messageId: string, prefixId: string | null): Promise<void> {
  const r = await fetch(`/messages/${encodeURIComponent(messageId)}/prefix`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify({ prefixId }),
  });
  await jsonOrThrow(r);
}

/** Flag a forum post to the forum's owner/mods (forum report queue). */
export async function reportForumPost(forumId: string, messageId: string, reason: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ messageId, reason }),
  });
  await jsonOrThrow(r);
}

/** The forum's report queue (handle_reports). status defaults to open. */
export async function fetchForumReports(forumId: string, status: "open" | "resolved" | "dismissed" = "open"): Promise<ForumReportWire[]> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/reports?status=${status}`, { credentials: "include" });
  const j = await jsonOrThrow<{ reports: ForumReportWire[] }>(r);
  return j.reports;
}

export async function resolveForumReport(forumId: string, reportId: string, action: "resolve" | "dismiss", note?: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/reports/${encodeURIComponent(reportId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(note ? { action, note } : { action }),
  });
  await jsonOrThrow(r);
}

/** Forum-scoped moderation history (Mod Log tab). Owner + any forum mod. */
export async function fetchForumModLog(forumId: string): Promise<ForumModLogEntry[]> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/mod-log`, { credentials: "include" });
  const j = await jsonOrThrow<{ entries: ForumModLogEntry[] }>(r);
  return j.entries;
}

/** Member directory (owner + mods + members). Needs manage_members. */
export async function fetchForumMembers(forumId: string): Promise<ForumMemberEntry[]> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/members`, { credentials: "include" });
  const j = await jsonOrThrow<{ members: ForumMemberEntry[] }>(r);
  return j.members;
}

/** Remove a plain member from the forum (mods are demoted via Roles). */
export async function removeForumMember(forumId: string, userId: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

export async function fetchForumBans(forumId: string): Promise<ForumBanRow[]> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/bans`, { credentials: "include" });
  const j = await jsonOrThrow<{ bans: ForumBanRow[] }>(r);
  return j.bans;
}

export async function banFromForum(forumId: string, input: {
  target: string; hours: number | null; reason?: string;
}): Promise<{ username: string }> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/bans`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  return jsonOrThrow<{ username: string }>(r);
}

export async function liftForumBan(forumId: string, userId: string): Promise<void> {
  const r = await fetch(`/forums/${encodeURIComponent(forumId)}/bans/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

/* ============================================================
 * In-modal composing + topic moderation (Phase 1C)
 * ============================================================ */

import { getSocket } from "./socket.js";

/**
 * Post into a board over the `forum:post` socket event — a new topic
 * (threadTitle) or a reply (replyToId). The socket needn't be in the
 * board's room; the server runs the forum gates and the full chat
 * pipeline (identity snapshots, awards, push). Resolves with the new
 * message id.
 */
export function postToBoard(input: {
  roomId: string;
  text: string;
  asCharacterId: string | null;
  threadTitle?: string;
  threadCategoryId?: string | null;
  replyToId?: string;
  /** New poll topic: the title is the question, these are the options/settings. */
  poll?: { optionTexts: string[]; allowMultiple: boolean; showVoters: boolean; closesAt: number | null };
  /** Streamlined reply format (replies only): emote ("action") or NPC. */
  format?: "say" | "action" | "npc";
  /** Saved NPC to voice when format = "npc". */
  npcId?: string;
}): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const socket = getSocket();
    if (!socket) { reject(new Error("Not connected.")); return; }
    socket.emit("forum:post", {
      roomId: input.roomId,
      text: input.text,
      asCharacterId: input.asCharacterId,
      ...(input.threadTitle ? { threadTitle: input.threadTitle } : {}),
      ...(input.threadCategoryId ? { threadCategoryId: input.threadCategoryId } : {}),
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      ...(input.poll ? { poll: input.poll } : {}),
      ...(input.format && input.format !== "say" ? { format: input.format } : {}),
      ...(input.npcId ? { npcId: input.npcId } : {}),
    }, (res) => {
      if (res && "ok" in res && res.ok) resolve(res.messageId);
      else reject(new Error(res && "message" in res ? res.message : "Post failed."));
    });
    // Belt-and-suspenders: never hang the composer on a dropped ack.
    setTimeout(() => reject(new Error("The post timed out - check your connection.")), 15_000);
  });
}

/** Topic/post moderation rides the existing HTTP message routes (the
 *  powers matrix is enforced server-side via boardModTier). */
export async function setTopicSticky(messageId: string, sticky: boolean): Promise<void> {
  const r = await fetch(`/messages/${encodeURIComponent(messageId)}/sticky`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ sticky }),
  });
  await jsonOrThrow(r);
}

export async function setTopicLock(messageId: string, locked: boolean): Promise<void> {
  const r = await fetch(`/messages/${encodeURIComponent(messageId)}/lock`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ locked }),
  });
  await jsonOrThrow(r);
}

/** Move a topic into a different category, or to Uncategorized with
 *  `categoryId: null`. Mods/admins only (enforced server-side). */
export async function setTopicCategory(messageId: string, categoryId: string | null): Promise<void> {
  const r = await fetch(`/messages/${encodeURIComponent(messageId)}/category`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ categoryId }),
  });
  await jsonOrThrow(r);
}

/** Move a whole topic (header + replies) to another board in the same forum. */
export async function moveTopicToBoard(messageId: string, boardRoomId: string, categoryId: string | null = null): Promise<void> {
  const r = await fetch(`/messages/${encodeURIComponent(messageId)}/move-to-board`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ boardRoomId, categoryId }),
  });
  await jsonOrThrow(r);
}

/** Merge this topic into another topic (non-destructive — its posts become
 *  replies of the target). Both must be in the same forum. */
export async function mergeTopicInto(messageId: string, targetTopicId: string): Promise<void> {
  const r = await fetch(`/messages/${encodeURIComponent(messageId)}/merge-into`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ targetTopicId }),
  });
  await jsonOrThrow(r);
}

export async function deleteForumPost(messageId: string): Promise<void> {
  const r = await fetch(`/messages/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

export async function editForumPost(messageId: string, body: string): Promise<void> {
  const r = await fetch(`/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ body }),
  });
  await jsonOrThrow(r);
}

/* ============================================================
 * Notification center + per-topic unread + watches
 * ============================================================ */

import type { ForumNotificationWire } from "@thekeep/shared";

/** Resolve any post/topic id to its forum coordinates (permalink nav).
 *  Anonymous callers succeed only for public-browsing forums. */
export async function locateForumTopic(messageId: string): Promise<{
  forumId: string; forumSlug: string; boardRoomId: string; topicId: string;
}> {
  const r = await fetch(`/forums/topics/${encodeURIComponent(messageId)}/locate`, { credentials: "include" });
  return jsonOrThrow(r);
}

export async function fetchForumNotifications(limit = 40): Promise<{ unread: number; notifications: ForumNotificationWire[] }> {
  const r = await fetch(`/forums/notifications?limit=${limit}`, { credentials: "include" });
  return jsonOrThrow(r);
}

export async function markForumNotificationsRead(ids: string[] | "all"): Promise<number> {
  const r = await fetch("/forums/notifications/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(ids === "all" ? { all: true } : { ids }),
  });
  const j = await jsonOrThrow<{ unread: number }>(r);
  return j.unread;
}

export async function setTopicWatch(topicId: string, watch: boolean): Promise<void> {
  const r = await fetch(`/forums/topics/${encodeURIComponent(topicId)}/watch`, {
    method: watch ? "PUT" : "DELETE",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

/** "Viewer read this topic" stamp — clears its unread dot. Never throws
 *  (cosmetic; reopening retries). Await it when a refetch follows, so
 *  the server's unread truth includes the stamp. */
export function markTopicRead(topicId: string): Promise<void> {
  return fetch(`/forums/topics/${encodeURIComponent(topicId)}/read`, {
    method: "POST",
    credentials: "include",
  }).then(() => undefined, () => undefined);
}

/* ============================================================
 * Visit markers + admin curation (Phase 8)
 * ============================================================ */

/** Fire-and-forget "I looked at this forum" stamp — clears the rail dot. */
export function markForumVisited(forumId: string): void {
  void fetch(`/forums/${encodeURIComponent(forumId)}/visit`, {
    method: "POST",
    credentials: "include",
  }).catch(() => { /* cosmetic; next visit retries */ });
}

export interface AdminForumRow {
  id: string;
  slug: string;
  name: string;
  status: "active" | "featured" | "archived";
  isSystem: boolean;
  ownerUsername: string;
  createdAt: number;
}

export async function adminFetchForums(): Promise<AdminForumRow[]> {
  const r = await fetch("/admin/forums", { credentials: "include" });
  const j = await jsonOrThrow<{ forums: AdminForumRow[] }>(r);
  return j.forums;
}

export async function adminSetForumStatus(
  forumId: string,
  status: "active" | "featured" | "archived",
): Promise<void> {
  const r = await fetch(`/admin/forums/${encodeURIComponent(forumId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status }),
  });
  await jsonOrThrow(r);
}

export async function adminReviewForumApplication(
  id: string,
  action: "approve" | "reject",
  reviewNote?: string,
): Promise<ForumCreationApplicationWire> {
  const r = await fetch(`/admin/forums/applications/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(reviewNote ? { action, reviewNote } : { action }),
  });
  const j = await jsonOrThrow<{ application: ForumCreationApplicationWire }>(r);
  return j.application;
}
