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
import { useEffect, useMemo, useState } from "react";
import { Settings as SettingsIcon, X } from "lucide-react";
import {
  DEFAULT_THEME,
  SERVER_MOD_PERMISSIONS,
  SERVER_MOD_PERMISSION_META,
  SERVER_MOD_DEFAULT_PERMISSIONS,
  SERVER_PERMISSIONS,
  SERVER_PERMISSION_META,
  SERVER_FEATURE_PERMISSIONS,
  serverPermissionCategory,
  normalizeTheme,
  type Theme,
  type ServerModPermission,
  type ServerPermission,
  type ServerRole,
  type ServerJoinMode,
  type ServerViewerState,
} from "@thekeep/shared";
import { Modal } from "./Modal.js";
import { StylePicker } from "./AdminPanel.js";
import { ThemePicker } from "./ThemePicker.js";
import { useActiveTheme, useScopedRootDesign } from "../lib/theme.js";

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
  logoUrl: string | null;
  iconColor: string | null;
  themeJson: string | null;
  themeStyleKey: string | null;
  isSystem: boolean;
  isDefault: boolean;
  status: string;
  visibility: string;
  joinMode: ServerJoinMode;
  publicBrowsing: boolean;
  applicationPrompt: string | null;
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
  permissions: ServerPermission[];
  isDefault: boolean;
  sortOrder: number;
  memberCount: number;
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
}

/** A room row off GET /rooms (the only rooms list available to the web). */
interface RoomListRow {
  id: string;
  name: string;
  serverId?: string | null;
  type?: string;
  occupants?: unknown[];
}

/* ============================================================
 * Inline fetch helpers (do NOT widen lib/servers.ts).
 * ============================================================ */

async function jsonOrThrow<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!r.ok) throw new Error(j?.error ?? `Request failed (${r.status}).`);
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
async function apiGetModLog(id: string): Promise<ServerModLogWire[]> {
  const j = await jsonOrThrow<{ entries: ServerModLogWire[] }>(await fetch(`/servers/${sid(id)}/mod-log`, { credentials: "include" }));
  return j.entries;
}
async function apiTransfer(id: string, target: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(id)}/transfer`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ target }),
  }));
}
async function apiGetRooms(serverId: string): Promise<RoomListRow[]> {
  // NOTE: /rooms ignores ?serverId today and omits serverId on rows, so we
  // pass the hint and filter client-side where the field is present. A
  // server-scoped rooms endpoint is a Track-A followup (see report).
  const j = await jsonOrThrow<{ rooms: RoomListRow[] }>(await fetch(`/rooms?serverId=${sid(serverId)}`, { credentials: "include" }));
  return j.rooms;
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
        placeholder={placeholder ?? "Search a username or character…"}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
      />
      {open && hits ? (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded border border-keep-rule bg-keep-panel shadow-lg">
          {hits.length === 0 ? (
            <li className="px-2 py-1.5 text-xs italic text-keep-muted">No matches.</li>
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
  const has = new Set(value);
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
      {SERVER_MOD_PERMISSIONS.map((key) => {
        const meta = SERVER_MOD_PERMISSION_META[key];
        const canGrant = grantable.has(key);
        return (
          <label
            key={key}
            title={canGrant ? meta.description : "You don't hold this permission yourself, so you can't grant it."}
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

/** Full-registry grid (member features + moderation), grouped, for usergroups. */
function ServerPermissionCheckboxes({ value, onChange, grantable, disabled }: {
  value: ServerPermission[];
  onChange: (next: ServerPermission[]) => void;
  grantable: Set<ServerPermission>;
  disabled?: boolean;
}) {
  const has = new Set(value);
  const sections: { title: string; keys: ServerPermission[] }[] = [
    { title: "Member features", keys: SERVER_PERMISSIONS.filter((k) => serverPermissionCategory(k) === "feature") },
    { title: "Moderation", keys: SERVER_PERMISSIONS.filter((k) => serverPermissionCategory(k) === "moderation") },
  ];
  function toggle(key: ServerPermission, on: boolean) {
    const next = new Set(value);
    if (on) next.add(key); else next.delete(key);
    onChange([...next]);
  }
  return (
    <div className="space-y-2">
      {sections.map((sec) => (
        <div key={sec.title}>
          <p className="mb-0.5 text-[10px] uppercase tracking-widest text-keep-muted">{sec.title}</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {sec.keys.map((key) => {
              const meta = SERVER_PERMISSION_META[key];
              const canGrant = grantable.has(key);
              return (
                <label
                  key={key}
                  title={canGrant ? meta.description : "You don't hold this permission yourself, so you can't grant it."}
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
        </div>
      ))}
    </div>
  );
}

/* ============================================================
 * Tab: Overview
 * ============================================================ */

function OverviewTab({ detail, busy, run, onSaved }: TabProps) {
  const [name, setName] = useState(detail.name);
  const [tagline, setTagline] = useState(detail.tagline ?? "");
  const [description, setDescription] = useState(detail.descriptionHtml ?? "");
  const [joinMode, setJoinMode] = useState<ServerJoinMode>(detail.joinMode);
  const [prompt, setPrompt] = useState(detail.applicationPrompt ?? "");
  const [publicBrowsing, setPublicBrowsing] = useState(detail.publicBrowsing);

  const dirty = name !== detail.name
    || tagline !== (detail.tagline ?? "")
    || description !== (detail.descriptionHtml ?? "")
    || joinMode !== detail.joinMode
    || prompt !== (detail.applicationPrompt ?? "")
    || publicBrowsing !== detail.publicBrowsing;

  return (
    <div className="max-w-xl space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Tagline</span>
        <input value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={200}
          placeholder="One line under the server's name."
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} maxLength={5000}
          placeholder="The long-form welcome. Same HTML rules as profile bios; shown on the server's page."
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      </label>

      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">How people join</span>
        {detail.isSystem ? (
          <p className="text-xs text-keep-muted">This is the home server — everyone is a member, so it can't be gated.</p>
        ) : (
          <>
            {(["open", "application", "invite"] as const).map((mode) => (
              <label key={mode} className="mt-1.5 flex items-start gap-2 text-sm">
                <input type="radio" name="joinMode" checked={joinMode === mode} onChange={() => setJoinMode(mode)} className="mt-0.5" />
                <span>
                  <span className="font-semibold capitalize text-keep-text">{mode}</span>
                  <span className="block text-xs text-keep-muted">
                    {mode === "open" ? "Anyone signed in can join instantly."
                      : mode === "application" ? "People apply; you (or your mods) approve them."
                      : "Hidden — entered only with an invite code."}
                  </span>
                </span>
              </label>
            ))}
            {joinMode === "application" ? (
              <label className="mt-2 block text-sm">
                <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Application prompt</span>
                <input value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={300}
                  placeholder="Tell the owner why you'd like to join."
                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
              </label>
            ) : null}
          </>
        )}
      </div>

      <div className="rounded border border-keep-rule bg-keep-panel/20 p-2.5">
        <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Public browsing</span>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={publicBrowsing} onChange={(e) => setPublicBrowsing(e.target.checked)} className="mt-0.5" />
          <span>
            <span className="font-semibold text-keep-text">Let anyone read this server</span>
            <span className="block text-xs text-keep-muted">
              Visitors on /s/{detail.slug} can browse without an account. Posting and joining always require signing in.
            </span>
          </span>
        </label>
      </div>

      <p className="text-[11px] text-keep-muted">The address (/s/{detail.slug}) is permanent so shared links never break.</p>

      <button
        type="button"
        disabled={!dirty || busy || name.trim().length < 3}
        onClick={() => void run(async () => {
          await apiPatchServer(detail.id, {
            name: name.trim(),
            tagline: tagline.trim() ? tagline.trim() : null,
            descriptionHtml: description.trim() ? description : null,
            ...(detail.isSystem ? {} : { joinMode }),
            applicationPrompt: prompt.trim() ? prompt.trim() : null,
            publicBrowsing,
          });
          onSaved();
        })}
        className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
      >
        Save
      </button>
    </div>
  );
}

/* ============================================================
 * Tab: Appearance (logo / icon color / palette + design)
 * ============================================================ */

function AppearanceTab({ detail, busy, run, onSaved }: TabProps) {
  const initialTheme = useMemo<Theme | null>(() => {
    if (!detail.themeJson) return null;
    try { return normalizeTheme(JSON.parse(detail.themeJson)); } catch { return null; }
  }, [detail.themeJson]);
  const [theme, setTheme] = useState<Theme | null>(initialTheme);
  const [styleKey, setStyleKey] = useState<string | null>(detail.themeStyleKey);
  const [logoUrl, setLogoUrl] = useState(detail.logoUrl ?? "");
  const [iconColor, setIconColor] = useState(detail.iconColor ?? "");

  const themeDirty = JSON.stringify(theme) !== JSON.stringify(initialTheme);
  const styleDirty = styleKey !== detail.themeStyleKey;
  const logoDirty = logoUrl !== (detail.logoUrl ?? "");
  const colorDirty = iconColor !== (detail.iconColor ?? "");

  return (
    <div className="max-w-xl space-y-4">
      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Icon</p>
        <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
          <div className="flex items-center gap-3">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="h-12 w-12 rounded-2xl border border-keep-rule object-cover" />
            ) : (
              <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-2xl border border-keep-rule text-lg font-semibold uppercase text-keep-text"
                style={iconColor ? { backgroundColor: iconColor, color: "#fff" } : undefined}>
                {(detail.name.trim()[0] ?? "?").toUpperCase()}
              </span>
            )}
            <div className="min-w-0 flex-1 space-y-2">
              <label className="block text-xs">
                <span className="mb-0.5 block uppercase tracking-widest text-keep-muted">Logo URL</span>
                <input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…/icon.png"
                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action" />
              </label>
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-widest text-keep-muted">Fallback color</span>
                <input type="color" value={iconColor || "#8a66cc"} onChange={(e) => setIconColor(e.target.value)}
                  title="Lettered-tile color" className="h-7 w-9 shrink-0 cursor-pointer rounded border border-keep-rule bg-transparent" />
                {iconColor ? (
                  <button type="button" onClick={() => setIconColor("")}
                    className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">Clear</button>
                ) : null}
              </div>
            </div>
          </div>
          {logoDirty || colorDirty ? (
            <button type="button" disabled={busy}
              onClick={() => void run(async () => {
                await apiPatchServer(detail.id, { logoUrl: logoUrl.trim() || null, iconColor: iconColor.trim() || null });
                onSaved();
              })}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
              Save icon
            </button>
          ) : null}
          <p className="text-[10px] text-keep-muted">Square image works best; the rail crops to a rounded tile.</p>
        </div>
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Theme</p>
        <p className="mb-2 text-[11px] text-keep-muted">A palette for this server's pages only — chat and the userlist are untouched.</p>
        {theme === null ? (
          <button type="button" onClick={() => setTheme(DEFAULT_THEME)}
            className="rounded border border-keep-rule bg-keep-banner px-2 py-1 text-xs hover:bg-keep-banner/80">Add a custom theme</button>
        ) : (
          <>
            <ThemePicker theme={theme} onChange={(t) => setTheme(t)} onReset={() => setTheme(DEFAULT_THEME)} />
            <button type="button" onClick={() => setTheme(null)}
              className="mt-2 rounded border border-keep-accent/40 bg-keep-bg px-2 py-1 text-[11px] text-keep-accent hover:bg-keep-accent/10">Remove custom theme</button>
          </>
        )}
        {themeDirty ? (
          <button type="button" disabled={busy}
            onClick={() => void run(async () => { await apiPatchServer(detail.id, { themeJson: theme ? JSON.stringify(theme) : null }); onSaved(); })}
            className="ml-2 mt-2 rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">Save theme</button>
        ) : null}
      </section>

      <section>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Design style</p>
        <p className="mb-2 text-[11px] text-keep-muted">
          The visual treatment — ornaments, borders, textures. Applies to this server's pages for every visitor.
          "Use default" follows each visitor's own design.
        </p>
        <StylePicker value={styleKey} onChange={setStyleKey} allowInherit />
        {styleDirty ? (
          <button type="button" disabled={busy}
            onClick={() => void run(async () => { await apiPatchServer(detail.id, { themeStyleKey: styleKey }); onSaved(); })}
            className="mt-2 rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">Save style</button>
        ) : null}
      </section>
    </div>
  );
}

/* ============================================================
 * Tab: Rooms (read-only list)
 * ============================================================ */

function RoomsTab({ detail }: { detail: ServerConsoleDetail }) {
  const [rooms, setRooms] = useState<RoomListRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    apiGetRooms(detail.id)
      .then((rs) => {
        if (!alive) return;
        // Only keep rows tagged with this server when the field is present;
        // otherwise (today's /rooms) show the lot rather than nothing.
        const tagged = rs.filter((r) => r.serverId != null);
        setRooms(tagged.length ? tagged.filter((r) => r.serverId === detail.id) : rs);
      })
      .catch(() => { if (alive) setRooms([]); });
    return () => { alive = false; };
  }, [detail.id]);

  return (
    <div className="max-w-xl space-y-2">
      <p className="text-[11px] text-keep-muted">
        This server has {detail.roomCount} room{detail.roomCount === 1 ? "" : "s"}. Rooms are created and managed
        from the chat itself; this list is for reference.
      </p>
      {!rooms ? (
        <p className="text-sm italic text-keep-muted">Loading…</p>
      ) : rooms.length === 0 ? (
        <p className="text-xs italic text-keep-muted">No rooms to show.</p>
      ) : (
        <ul className="space-y-1">
          {rooms.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-keep-text">{r.name}</span>
              {Array.isArray(r.occupants) ? (
                <span className="shrink-0 text-[10px] text-keep-muted">{r.occupants.length} here</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
 * Tab: Members
 * ============================================================ */

function MembersTab({ detail, busy, run }: TabProps) {
  const [data, setData] = useState<{ managerPermissions: ServerPermission[]; members: ServerMemberWire[] } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    apiGetMembers(detail.id).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  const roleLabel = (m: ServerMemberWire) =>
    m.role === "owner" ? "Owner"
      : m.role === "admin" ? "Admin (lieutenant)"
      : m.role === "mod" ? `Moderator · ${m.permissions.length} ${m.permissions.length === 1 ? "power" : "powers"}`
      : "Member";

  if (!data) return <p className="text-sm italic text-keep-muted">Loading…</p>;

  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-xs uppercase tracking-widest text-keep-muted">Members ({data.members.length})</p>
      <ul className="space-y-1">
        {data.members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
            <Avatar url={m.avatarUrl} name={m.username} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-keep-text">{m.username}</span>
              <span className="block text-[10px] text-keep-muted">{roleLabel(m)} · joined {new Date(m.joinedAt).toLocaleDateString()}</span>
            </span>
            {m.role === "member" ? (
              <>
                <button type="button" disabled={busy}
                  onClick={() => void run(async () => { await apiSetRole(detail.id, m.userId, "mod"); setTick((t) => t + 1); })}
                  title="Promote to moderator with the default power set (tune it in Roles)"
                  className="shrink-0 rounded border border-keep-action/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-action hover:bg-keep-action/10">Make mod</button>
                <button type="button" disabled={busy}
                  onClick={() => { if (window.confirm(`Remove ${m.username} from ${detail.name}?`)) void run(async () => { await apiRemoveMember(detail.id, m.userId); setTick((t) => t + 1); }); }}
                  className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">Remove</button>
              </>
            ) : m.role === "mod" ? (
              <button type="button" disabled={busy}
                onClick={() => { if (window.confirm(`Remove ${m.username} from ${detail.name}?`)) void run(async () => { await apiRemoveMember(detail.id, m.userId); setTick((t) => t + 1); }); }}
                className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">Remove</button>
            ) : null}
          </li>
        ))}
      </ul>
      {data.members.length === 1 ? (
        <p className="text-xs italic text-keep-muted">No members yet beyond you. Approved applicants and people who join appear here.</p>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Tab: Roles (owner line, appoint admin/mod, edit grants)
 * ============================================================ */

function RolesTab({ detail, viewer, busy, run }: TabProps) {
  const [data, setData] = useState<{ managerPermissions: ServerPermission[]; members: ServerMemberWire[] } | null>(null);
  const [tick, setTick] = useState(0);
  const [pendingHit, setPendingHit] = useState<ServerUserHit | null>(null);
  const [pendingPerms, setPendingPerms] = useState<ServerModPermission[]>(SERVER_MOD_DEFAULT_PERMISSIONS);
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
        <p className="text-sm italic text-keep-muted">Loading…</p>
      ) : (
        <>
          <p className="text-sm text-keep-text">
            <span className="text-xs uppercase tracking-widest text-keep-muted">Owner</span>{" "}
            <span className="font-semibold">{detail.ownerUsername}</span>
            <span className="ml-1 text-[10px] text-keep-muted">(every power)</span>
          </p>

          <div>
            <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Moderators &amp; admins ({mods.length})</p>
            {mods.length === 0 ? (
              <p className="text-xs italic text-keep-muted">
                None yet. Appoint a helper below and pick exactly which powers they get.
                Mods can never touch the owner's content.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {mods.map((m) => (
                  <li key={m.userId} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-keep-text">
                        {m.username}
                        {m.role === "admin" ? <span className="ml-1 rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted">admin</span> : null}
                      </span>
                      <span className="shrink-0 text-[10px] text-keep-muted">
                        {m.role === "admin" ? "every power" : `${m.permissions.length} ${m.permissions.length === 1 ? "power" : "powers"}`}
                      </span>
                      {m.role === "mod" ? (
                        <button type="button" disabled={busy}
                          onClick={() => setEditingUserId((id) => (id === m.userId ? null : m.userId))}
                          className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action">
                          {editingUserId === m.userId ? "Done" : "Edit"}</button>
                      ) : null}
                      {/* Removing the admin lieutenant is owner-only (matches appointing). */}
                      {m.role === "mod" || viewer.isOwner ? (
                        <button type="button" disabled={busy}
                          onClick={() => { if (window.confirm(`Remove ${m.username}'s ${m.role} role?`)) void run(async () => { await apiRemoveMember(detail.id, m.userId); setTick((t) => t + 1); }); }}
                          className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">Remove</button>
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

          {/* Appoint flow */}
          <div className="rounded border border-keep-rule p-3">
            <p className="mb-2 text-xs uppercase tracking-widest text-keep-muted">Appoint a moderator</p>
            {!pendingHit ? (
              <ServerUserPicker
                serverId={detail.id}
                placeholder="Search a username or character…"
                disabledReason={(hit) =>
                  hit.serverRole === "owner" ? "the owner"
                    : hit.serverRole === "mod" ? "already a mod"
                    : hit.serverRole === "admin" ? "already admin"
                    : hit.banned ? "banned — lift first"
                    : null}
                onSelect={(hit) => { setPendingHit(hit); setPendingPerms(SERVER_MOD_DEFAULT_PERMISSIONS.filter((p) => grantable.has(p))); }}
              />
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-keep-text">Appoint <span className="font-semibold">{pendingHit.username}</span></p>
                <ModPermissionCheckboxes value={pendingPerms} grantable={grantable} disabled={busy} onChange={setPendingPerms} />
                <div className="flex justify-end gap-2">
                  <button type="button" disabled={busy} onClick={() => setPendingHit(null)}
                    className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">Cancel</button>
                  {/* Appointing the admin lieutenant tier is owner-only (§6.2). */}
                  {viewer.isOwner ? (
                    <button type="button" disabled={busy}
                      onClick={() => void run(async () => { await apiSetRole(detail.id, pendingHit.userId, "admin"); setPendingHit(null); setTick((t) => t + 1); })}
                      className="rounded border border-keep-rule px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action disabled:opacity-50">
                      Make admin</button>
                  ) : null}
                  <button type="button" disabled={busy}
                    onClick={() => void run(async () => { await apiSetRole(detail.id, pendingHit.userId, "mod", pendingPerms); setPendingHit(null); setTick((t) => t + 1); })}
                    className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
                    Appoint mod</button>
                </div>
                {viewer.isOwner ? (
                  <p className="text-[10px] text-keep-muted">"Make admin" grants the lieutenant tier (every moderation power, owner-only to assign).</p>
                ) : null}
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
  const [target, setTarget] = useState<ServerUserHit | null>(null);
  return (
    <div className="rounded border border-keep-system/50 bg-keep-system/5 p-3">
      <p className="mb-1 text-xs uppercase tracking-widest text-keep-system">Transfer ownership</p>
      <p className="mb-2 text-[11px] text-keep-muted">
        Hand this server to another member. You step down to admin (you keep moderation reach, but lose owner-only acts).
        This can't be undone by you afterward.
      </p>
      {!target ? (
        <ServerUserPicker
          serverId={detail.id}
          placeholder="Search the new owner…"
          disabledReason={(hit) => (hit.serverRole === "owner" ? "already owner" : hit.banned ? "banned" : null)}
          onSelect={setTarget}
        />
      ) : (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm text-keep-text">{target.username}</span>
          <button type="button" onClick={() => setTarget(null)}
            className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">Change</button>
          <button type="button" disabled={busy}
            onClick={() => { if (window.confirm(`Transfer ${detail.name} to ${target.username}? You will step down to admin.`)) void run(async () => { await apiTransfer(detail.id, `@id:${target.userId}`); setTarget(null); }); }}
            className="shrink-0 rounded border border-keep-system/70 bg-keep-system/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-system disabled:opacity-50">Transfer</button>
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * Tab: Usergroups
 * ============================================================ */

function UsergroupMembersPanel({ detail, group, busy, run }: { detail: ServerConsoleDetail; group: ServerUsergroupWire; busy: boolean; run: (fn: () => Promise<void>) => Promise<void> }) {
  const [members, setMembers] = useState<ServerUsergroupMemberWire[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    apiGetUsergroupMembers(detail.id, group.id).then((m) => { if (alive) setMembers(m); }).catch(() => { if (alive) setMembers([]); });
    return () => { alive = false; };
  }, [detail.id, group.id, tick]);
  return (
    <div className="border-t border-keep-rule/60 pt-3">
      <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Members ({members?.length ?? "…"})</p>
      <div className="mb-2">
        <ServerUserPicker serverId={detail.id} placeholder="Add a member…"
          onSelect={(hit) => void run(async () => { await apiAddUsergroupMember(detail.id, group.id, `@id:${hit.userId}`); setTick((t) => t + 1); })} />
      </div>
      {members && members.length > 0 ? (
        <ul className="space-y-1">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-2 rounded border border-keep-rule/60 px-2 py-1 text-xs">
              <span className="min-w-0 flex-1 truncate text-keep-text">{m.username}</span>
              {m.isAuto ? <span className="shrink-0 rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted">auto</span> : null}
              <button type="button" disabled={busy}
                onClick={() => void run(async () => { await apiRemoveUsergroupMember(detail.id, group.id, m.userId); setTick((t) => t + 1); })}
                className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">Remove</button>
            </li>
          ))}
        </ul>
      ) : members ? <p className="text-[11px] italic text-keep-muted">No members yet.</p> : null}
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
  const isDefault = !!group?.isDefault;
  const [name, setName] = useState(group?.name ?? "");
  const [color, setColor] = useState(group?.color ?? "");
  const [perms, setPerms] = useState<ServerPermission[]>(group?.permissions ?? [...SERVER_FEATURE_PERMISSIONS]);

  function save() {
    void run(async () => {
      const payload = { name: name.trim(), color: color.trim() || null, permissions: perms };
      if (group) await apiPatchUsergroup(detail.id, group.id, payload);
      else await apiCreateUsergroup(detail.id, payload);
      onSaved();
    });
  }

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">← Back</button>
        <h3 className="text-sm font-semibold text-keep-text">{group ? (isDefault ? "Default group" : `Edit "${group.name}"`) : "New usergroup"}</h3>
      </div>
      {isDefault ? (
        <p className="text-[11px] text-keep-muted">The default group applies to every participant. Editing its permissions changes what ungrouped members can do — leave the feature boxes on to keep the server fully open.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input type="color" value={color || "#8a66cc"} onChange={(e) => setColor(e.target.value)} title="Group color" className="h-7 w-9 shrink-0 cursor-pointer rounded border border-keep-rule bg-transparent" />
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Group name (e.g. Veterans)" className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
        </div>
      )}
      <div>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Permissions</p>
        <ServerPermissionCheckboxes value={perms} grantable={grantable} disabled={busy} onChange={setPerms} />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">Cancel</button>
        <button type="button" disabled={busy || (!isDefault && !name.trim())} onClick={save}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{group ? "Save" : "Create"}</button>
      </div>
      {group && !isDefault ? <UsergroupMembersPanel detail={detail} group={group} busy={busy} run={run} /> : null}
    </div>
  );
}

function UsergroupsTab({ detail, busy, run }: TabProps) {
  const [data, setData] = useState<{ managerPermissions: ServerPermission[]; groups: ServerUsergroupWire[] } | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<ServerUsergroupWire | "new" | null>(null);

  useEffect(() => {
    let alive = true;
    apiGetUsergroups(detail.id).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [detail.id, tick]);

  const grantable = useMemo(() => new Set(data?.managerPermissions ?? []), [data?.managerPermissions]);

  if (!data) return <p className="text-sm italic text-keep-muted">Loading…</p>;

  if (editing) {
    return (
      <UsergroupEditor detail={detail} group={editing === "new" ? null : editing} grantable={grantable} busy={busy} run={run}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setTick((t) => t + 1); }} />
    );
  }

  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-[11px] text-keep-muted">
        Usergroups bundle server permissions — moderation powers and member features (posting, images) — and
        apply them to people. Everyone is in the default group; add more and fill them by hand.
      </p>
      <ul className="space-y-1.5">
        {data.groups.map((g) => (
          <li key={g.id} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                {g.color ? <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.color }} /> : null}
                <span className="truncate text-sm font-semibold text-keep-text">{g.name}</span>
                {g.isDefault ? <span className="shrink-0 rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted">default</span> : null}
              </span>
              <span className="shrink-0 text-[10px] text-keep-muted">
                {g.permissions.length} perm{g.permissions.length === 1 ? "" : "s"}
                {g.isDefault ? " · everyone" : ` · ${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`}
              </span>
              <button type="button" disabled={busy} onClick={() => setEditing(g)}
                className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action">Edit</button>
              {!g.isDefault ? (
                <button type="button" disabled={busy}
                  onClick={() => { if (window.confirm(`Delete the "${g.name}" usergroup? Members lose its permissions.`)) void run(async () => { await apiDeleteUsergroup(detail.id, g.id); setTick((t) => t + 1); }); }}
                  className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10">Delete</button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <button type="button" disabled={busy} onClick={() => setEditing("new")}
        className="rounded border border-keep-action bg-keep-action/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50">+ New group</button>
    </div>
  );
}

/* ============================================================
 * Tab: Applications
 * ============================================================ */

function ApplicationsTab({ detail, busy, run }: TabProps) {
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
          This server isn't in application mode right now. The queue below only fills while "How people join" is set to
          "application" (Overview tab).
        </p>
      ) : null}
      <div>
        <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Pending {pending ? `(${pending.length})` : ""}</p>
        {!pending ? (
          <p className="text-sm italic text-keep-muted">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="text-xs italic text-keep-muted">No one is waiting at the gate.</p>
        ) : (
          <ul className="space-y-1.5">
            {pending.map((a) => (
              <li key={a.id} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-keep-text">{a.applicantUsername}</span>
                  <span className="text-[10px] text-keep-muted">{new Date(a.submittedAt).toLocaleString()}</span>
                </div>
                {a.answer ? <p className="mt-1 whitespace-pre-wrap text-xs text-keep-text/90">{a.answer}</p> : <p className="mt-1 text-xs italic text-keep-muted">(no answer given)</p>}
                <div className="mt-1.5 flex gap-2">
                  <button type="button" disabled={busy}
                    onClick={() => void run(async () => { await apiReviewApplication(detail.id, a.id, "approve"); setTick((t) => t + 1); })}
                    className="rounded border border-keep-action bg-keep-action/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50">Approve</button>
                  <button type="button" disabled={busy}
                    onClick={() => { const v = window.prompt(`Decline ${a.applicantUsername}? Optional note shown to them:`, ""); if (v === null) return; void run(async () => { await apiReviewApplication(detail.id, a.id, "reject", v.trim() || undefined); setTick((t) => t + 1); }); }}
                    className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-accent disabled:opacity-50">Decline</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {recent.length > 0 ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-keep-muted">Recent decisions</p>
          <ul className="space-y-0.5">
            {recent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 rounded border border-keep-rule/50 px-2 py-0.5 text-[11px] text-keep-muted">
                <span className={a.status === "approved" ? "font-semibold uppercase text-keep-action" : "font-semibold uppercase text-keep-accent"}>{a.status}</span>
                <span className="text-keep-text">{a.applicantUsername}</span>
                {a.reviewedByUsername ? <span>by {a.reviewedByUsername}</span> : null}
                {a.reviewedAt ? <span>· {new Date(a.reviewedAt).toLocaleDateString()}</span> : null}
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
  const [bans, setBans] = useState<ServerBanWire[] | null>(null);
  const [targetHit, setTargetHit] = useState<ServerUserHit | null>(null);
  const [hours, setHours] = useState<string>("168");
  const [reason, setReason] = useState("");
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
        A server ban blocks this server's rooms only — the rest of the Spire is untouched. Banning strips any role the
        user held here and evicts them from its rooms.
      </p>
      {!bans ? (
        <p className="text-sm italic text-keep-muted">Loading…</p>
      ) : bans.length === 0 ? (
        <p className="text-xs italic text-keep-muted">No bans. May it stay that way.</p>
      ) : (
        <ul className="space-y-1">
          {bans.map((b) => (
            <li key={b.userId} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1 text-sm">
              <span className="font-semibold text-keep-text">{b.username}</span>
              <span className={`text-[11px] ${b.expired ? "text-keep-muted line-through" : "text-keep-muted"}`}>
                {b.until ? `until ${new Date(b.until).toLocaleDateString()}` : "permanent"}{b.expired ? " (expired)" : ""}
              </span>
              {b.reason ? <span className="min-w-0 flex-1 truncate text-[11px] italic text-keep-muted">"{b.reason}"</span> : <span className="flex-1" />}
              {canUnban ? (
                <button type="button" disabled={busy}
                  onClick={() => void run(async () => { await apiLiftBan(detail.id, b.userId); setTick((t) => t + 1); })}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">Lift</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canBan ? (
        <div className="space-y-2 rounded border border-keep-rule bg-keep-panel/20 p-2.5">
          {!targetHit ? (
            <ServerUserPicker serverId={detail.id} placeholder="Search the user to ban…"
              disabledReason={(hit) => (hit.serverRole === "owner" ? "the owner" : hit.banned ? "already banned" : null)}
              onSelect={setTargetHit} />
          ) : (
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-keep-text">{targetHit.username}</span>
              <button type="button" onClick={() => setTargetHit(null)}
                className="shrink-0 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text">Change</button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <select value={hours} onChange={(e) => setHours(e.target.value)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action">
              <option value="24">1 day</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
              <option value="perm">Permanent</option>
            </select>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Reason (shown to them)"
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
            <button type="button" disabled={busy || !targetHit}
              onClick={() => {
                if (!targetHit) return;
                const label = hours === "perm" ? "permanently" : `for ${hours === "24" ? "1 day" : hours === "168" ? "7 days" : "30 days"}`;
                if (!window.confirm(`Ban ${targetHit.username} from ${detail.name} ${label}?`)) return;
                void run(async () => {
                  await apiBan(detail.id, { target: `@id:${targetHit.userId}`, hours: hours === "perm" ? null : parseInt(hours, 10), ...(reason.trim() ? { reason: reason.trim() } : {}) });
                  setTargetHit(null); setReason(""); setTick((t) => t + 1);
                });
              }}
              className="rounded border border-keep-system/70 bg-keep-system/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-system disabled:opacity-50">Ban</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Tab: Mod Log
 * ============================================================ */

function modLogLabel(action: string, meta: Record<string, unknown> | null): { text: string; tone: string } {
  const m = meta ?? {};
  switch (action) {
    case "server_appearance_update": return { text: "Updated appearance", tone: "text-keep-muted" };
    case "server_settings_update": return { text: "Changed settings", tone: "text-keep-muted" };
    case "server_role_set": return { text: `Set role${m.role ? ` → ${String(m.role)}` : ""}`, tone: "text-keep-action" };
    case "server_mod_perms": return { text: "Changed mod powers", tone: "text-keep-muted" };
    case "server_member_remove": return { text: "Removed member", tone: "text-keep-muted" };
    case "server_usergroup_change": return { text: `Usergroup ${m.op ? String(m.op) : "change"}`, tone: "text-keep-muted" };
    case "server_ban": return { text: "Banned user", tone: "text-keep-system" };
    case "server_unban": return { text: "Lifted ban", tone: "text-keep-muted" };
    case "server_transfer": return { text: "Transferred ownership", tone: "text-keep-system" };
    default: return { text: action.replace(/^server_/, "").replace(/_/g, " "), tone: "text-keep-muted" };
  }
}

function ModLogTab({ detail }: { detail: ServerConsoleDetail }) {
  const [entries, setEntries] = useState<ServerModLogWire[] | null>(null);
  useEffect(() => {
    let alive = true;
    apiGetModLog(detail.id).then((e) => { if (alive) setEntries(e); }).catch(() => { if (alive) setEntries([]); });
    return () => { alive = false; };
  }, [detail.id]);
  return (
    <div className="max-w-2xl space-y-2">
      <p className="text-[11px] text-keep-muted">Every moderation action taken on this server, newest first. Shown to the owner and all moderators.</p>
      {!entries ? (
        <p className="text-sm italic text-keep-muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-xs italic text-keep-muted">Nothing logged yet.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => {
            const { text, tone } = modLogLabel(e.action, e.metadata);
            return (
              <li key={e.id} className="rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1.5 text-xs">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={`font-semibold ${tone}`}>{text}</span>
                  {e.targetUsername ? <span className="text-keep-muted">→ {e.targetUsername}</span> : null}
                  <span className="ml-auto text-[10px] text-keep-muted">{new Date(e.createdAt).toLocaleString()}</span>
                </div>
                <div className="text-[10px] text-keep-muted">by {e.actorUsername}{e.reason ? <span> · {e.reason}</span> : null}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
 * Tab: Settings (welcome/rules/caps)
 * ============================================================ */

/** One number-or-inherit field over the per-server settings row. */
function NumberSetting({ label, hint, value, onChange, min }: {
  label: string; hint: string; value: string; onChange: (v: string) => void; min?: number;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">{label}</span>
      <input type="number" inputMode="numeric" min={min} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="(inherit platform default)"
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
      <span className="mt-0.5 block text-[10px] text-keep-muted">{hint}</span>
    </label>
  );
}

function SettingsTab({ detail, busy, run, onSaved }: TabProps) {
  const [loaded, setLoaded] = useState<ServerSettingsWire | null>(null);
  // Local string copies (empty = inherit / clear the override).
  const [welcome, setWelcome] = useState("");
  const [newUserWelcome, setNewUserWelcome] = useState("");
  const [rules, setRules] = useState("");
  const [security, setSecurity] = useState("");
  const [retentionMs, setRetentionMs] = useState("");
  const [maxRooms, setMaxRooms] = useState("");
  const [maxMsg, setMaxMsg] = useState("");
  const [editGrace, setEditGrace] = useState("");
  const [maxForumPost, setMaxForumPost] = useState("");

  useEffect(() => {
    let alive = true;
    apiGetSettings(detail.id).then((s) => {
      if (!alive) return;
      setLoaded(s);
      const str = (n: number | null) => (n == null ? "" : String(n));
      setWelcome(s.welcomeHtml ?? "");
      setNewUserWelcome(s.newUserWelcomeHtml ?? "");
      setRules(s.rulesHtml ?? "");
      setSecurity(s.securityNoticeHtml ?? "");
      setRetentionMs(str(s.messageRetentionMs));
      setMaxRooms(str(s.maxRoomsPerOwner));
      setMaxMsg(str(s.maxMessageLength));
      setEditGrace(str(s.editGraceMs));
      setMaxForumPost(str(s.maxForumPostLength));
    }).catch(() => { if (alive) setLoaded(null); });
    return () => { alive = false; };
  }, [detail.id]);

  if (!loaded) return <p className="text-sm italic text-keep-muted">Loading…</p>;

  // Build the partial PATCH: a number field maps to null when blank (clear the
  // override) or its parsed value; an HTML field to null when blank or its text.
  const numOrNull = (s: string): number | null => {
    const t = s.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  const htmlOrNull = (s: string): string | null => (s.trim() ? s : null);

  function save() {
    void run(async () => {
      await apiPatchSettings(detail.id, {
        welcomeHtml: htmlOrNull(welcome),
        newUserWelcomeHtml: htmlOrNull(newUserWelcome),
        rulesHtml: htmlOrNull(rules),
        securityNoticeHtml: htmlOrNull(security),
        messageRetentionMs: numOrNull(retentionMs),
        maxRoomsPerOwner: numOrNull(maxRooms),
        maxMessageLength: numOrNull(maxMsg),
        editGraceMs: numOrNull(editGrace),
        maxForumPostLength: numOrNull(maxForumPost),
      });
      onSaved();
    });
  }

  return (
    <div className="max-w-xl space-y-4">
      <p className="text-[11px] text-keep-muted">
        Leave any field blank to inherit the platform default. HTML copy follows the same rules as profile bios.
      </p>

      <section className="space-y-3">
        <p className="text-xs uppercase tracking-widest text-keep-muted">Welcome &amp; rules</p>
        <label className="block text-sm">
          <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">Welcome</span>
          <textarea value={welcome} onChange={(e) => setWelcome(e.target.value)} rows={4} maxLength={200_000}
            placeholder="Shown to members when they enter the server."
            className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
        </label>
        <label className="block text-sm">
          <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">New-user welcome</span>
          <textarea value={newUserWelcome} onChange={(e) => setNewUserWelcome(e.target.value)} rows={4} maxLength={200_000}
            placeholder="Shown the first time someone joins."
            className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
        </label>
        <label className="block text-sm">
          <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">House rules</span>
          <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={6} maxLength={200_000}
            placeholder="The server's rules."
            className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
        </label>
        <label className="block text-sm">
          <span className="mb-0.5 block text-xs uppercase tracking-widest text-keep-muted">Security notice</span>
          <textarea value={security} onChange={(e) => setSecurity(e.target.value)} rows={3} maxLength={200_000}
            placeholder="An optional safety / privacy notice."
            className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action" />
        </label>
      </section>

      <section className="space-y-3">
        <p className="text-xs uppercase tracking-widest text-keep-muted">Limits</p>
        <NumberSetting label="Message retention (ms)" hint="How long messages are kept before pruning." value={retentionMs} onChange={setRetentionMs} min={1} />
        <NumberSetting label="Max rooms per owner" hint="Cap on rooms a member may open here." value={maxRooms} onChange={setMaxRooms} min={1} />
        <NumberSetting label="Max message length" hint="Character cap for a chat message." value={maxMsg} onChange={setMaxMsg} min={1} />
        <NumberSetting label="Edit grace (ms)" hint="Window in which a message can still be edited." value={editGrace} onChange={setEditGrace} min={0} />
        <NumberSetting label="Max forum post length" hint="Character cap for a forum post." value={maxForumPost} onChange={setMaxForumPost} min={1} />
      </section>

      <button type="button" disabled={busy} onClick={save}
        className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">Save settings</button>
    </div>
  );
}

/* ============================================================
 * The console shell + tab router
 * ============================================================ */

type ServerSettingsTab = "overview" | "appearance" | "rooms" | "members" | "roles" | "usergroups" | "applications" | "bans" | "modlog" | "settings";

interface TabProps {
  detail: ServerConsoleDetail;
  viewer: ServerViewerState;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}

const TAB_LABEL: Record<ServerSettingsTab, string> = {
  overview: "overview", appearance: "appearance", rooms: "rooms", members: "members",
  roles: "roles", usergroups: "usergroups", applications: "applications", bans: "bans",
  modlog: "mod log", settings: "settings",
};

/**
 * The owner-console body once the server detail has loaded. Tabs are gated on
 * the viewer's mirrored permission set exactly as ForumSettingsView gates on
 * forum perms; the routes re-check every action.
 */
function ServerSettingsBody({ detail, viewer, onSaved }: { detail: ServerConsoleDetail; viewer: ServerViewerState; onSaved: () => void }) {
  const perms = new Set(viewer.permissions);
  const can = (k: ServerModPermission) => viewer.isOwner || perms.has(k);

  const tabs: ServerSettingsTab[] = [
    ...(can("manage_appearance") ? (["overview", "appearance"] as const) : []),
    ...(can("manage_rooms") ? (["rooms"] as const) : []),
    ...(can("manage_members") ? (["members", "roles"] as const) : []),
    ...(can("manage_usergroups") ? (["usergroups"] as const) : []),
    ...(can("manage_applications") ? (["applications"] as const) : []),
    ...(can("ban_member") || can("unban_member") ? (["bans"] as const) : []),
    ...(can("view_mod_log") ? (["modlog"] as const) : []),
    ...(can("manage_appearance") ? (["settings"] as const) : []),
  ];
  const [tab, setTab] = useState<ServerSettingsTab>(tabs[0] ?? "modlog");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); }
    catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
    finally { setBusy(false); }
  }

  const props: TabProps = { detail, viewer, busy, run, onSaved };

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`rounded border px-2.5 py-1 text-xs uppercase tracking-widest ${tab === t ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"}`}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {err ? <p className="mb-2 text-xs text-keep-accent">{err}</p> : null}
      {tab === "overview" ? <OverviewTab {...props} />
        : tab === "appearance" ? <AppearanceTab {...props} />
        : tab === "rooms" ? <RoomsTab detail={detail} />
        : tab === "members" ? <MembersTab {...props} />
        : tab === "roles" ? <RolesTab {...props} />
        : tab === "usergroups" ? <UsergroupsTab {...props} />
        : tab === "applications" ? <ApplicationsTab {...props} />
        : tab === "bans" ? <BansTab {...props} />
        : tab === "modlog" ? <ModLogTab detail={detail} />
        : <SettingsTab {...props} />}
    </div>
  );
}

/**
 * ServerSettingsView — the modal entry point App mounts when the rail's gear is
 * pressed on a server the viewer owns/moderates. Fetches GET /servers/:id for
 * the detail + viewer state, applies the server's scoped theme/design while
 * open (CSP-nonce path), and renders the tabbed body.
 */
export function ServerSettingsView({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [state, setState] = useState<{ detail: ServerConsoleDetail; viewer: ServerViewerState } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setState(null); setErr(null);
    apiGetServer(serverId)
      .then((r) => { if (!alive) return; if (!r.viewer) { setErr("You don't manage this server."); return; } setState({ detail: r.server, viewer: r.viewer }); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Couldn't load that server."); });
    return () => { alive = false; };
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

  return (
    <Modal onClose={onClose} variant="mobile-fullscreen">
      <div className="flex h-full w-full flex-col overflow-hidden bg-keep-bg text-keep-text lg:h-[90vh] lg:max-h-[90vh] lg:w-[75vw] lg:max-w-5xl lg:rounded-lg lg:border lg:border-keep-rule lg:shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-keep-rule px-4 py-3">
          <SettingsIcon className="h-5 w-5 text-keep-action" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-keep-text">
            {state ? state.detail.name : "Server settings"}
            <span className="ml-2 text-xs font-normal text-keep-muted">Server settings</span>
          </h2>
          <button type="button" onClick={onClose} title="Close" aria-label="Close"
            className="shrink-0 rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {err ? (
            <p className="m-4 rounded border border-keep-accent/50 bg-keep-accent/10 px-3 py-2 text-sm text-keep-accent">{err}</p>
          ) : !state ? (
            <p className="m-4 text-sm italic text-keep-muted">Loading…</p>
          ) : !allowed ? (
            <p className="m-4 text-sm italic text-keep-muted">You don't have any management powers on this server.</p>
          ) : (
            <ServerSettingsBody detail={state.detail} viewer={state.viewer} onSaved={() => setTick((t) => t + 1)} />
          )}
        </div>
      </div>
    </Modal>
  );
}
