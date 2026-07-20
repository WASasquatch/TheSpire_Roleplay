import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ProfileView, Role } from "@thekeep/shared";
import { isMasterAdminRole } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { formatDate, formatDateTime } from "../../lib/intlFormat.js";
import { useChat } from "../../state/store.js";
import { useEarning } from "../../state/earning.js";
import { AccountBanControl } from "../moderation/AccountBanControl.js";
import { ProfileModal } from "../profile/ProfileModal.js";
import { isoAgeUtc } from "../AuthGate.js";

/* =============================================================
 * USERS TAB
 * ============================================================= */

interface AdminUserRow {
  userId: string;
  username: string;
  email: string;
  role: Role;
  online: boolean;
  away: boolean;
  awayMessage: string | null;
  activeCharacterId: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  disabled: boolean;
  /** ISO YYYY-MM-DD, or null for legacy accounts registered before birth
   *  dates were collected (they attested 18+ at signup and count as
   *  adults). Only this admin directory ever carries another user's date. */
  birthdate: string | null;
  /** Server-derived from `birthdate` at read time, so it is always in
   *  sync (a 17-year-old flips to "adult" on their 18th birthday with no
   *  write anywhere). */
  ageBracket: "adult" | "minor" | "legacy";
  /** The minor's "only see members under 18 and staff" toggle. Editable
   *  here (behind `edit_user_dob`) for support cases; inert for adults. */
  isolateFromAdults: boolean;
  characters: Array<{ id: string; name: string; deleted: boolean }>;
  /** Last ~5 distinct IPs this user has been seen on, newest-first.
   *  Captured on activity (login, connect, room switch, chat, posts), not
   *  just at login, so `lastSeenAt` is a true last-activity time and the
   *  list reflects where the user actually is now. `altCount` is the number
   *  of OTHER accounts seen on the same IP, non-zero values flag ban-evasion
   *  or shared-device patterns for moderation review. */
  recentIps: Array<{ ip: string; lastSeenAt: number; altCount: number }>;
}

type UserSortKey = "username" | "role" | "state" | "chars" | "registered" | "lastSeen";
type UserSortDir = "asc" | "desc";
type RoleFilter = "any" | "user" | "trusted" | "mod" | "admin" | "masteradmin";
type StateFilter = "any" | "online" | "offline" | "disabled" | "away" | "minor";
type RegisteredFilter = "any" | "24h" | "5d" | "7d" | "30d";
type LoginFilter = "any" | "never" | "active";

export function UsersTab() {
  const { t } = useTranslation("admin");
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // IP pivot, when set, scopes the list to every user who has a
  // session row from this IP. Set by clicking an IP chip on any
  // user row; cleared by the "Showing alts on X, clear" affordance
  // that appears in the toolbar while a pivot is active. Stored
  // alongside `q` so the two filters compose at the server.
  const [ipPivot, setIpPivot] = useState("");
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  // Inline character expansion: userIds whose row is expanded to show their
  // full character roster (clicking the username toggles it). A Set so
  // several users can be expanded at once during a comparison sweep.
  const [expandedUserIds, setExpandedUserIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (userId: string) =>
    setExpandedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  // Default sort lands on newest signups so admins see fresh accounts
  // first, supports the moderation workflow of "who joined since I last
  // looked." Alphabetical is one click away on the header.
  const [sortKey, setSortKey] = useState<UserSortKey>("registered");
  const [sortDir, setSortDir] = useState<UserSortDir>("desc");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("any");
  const [stateFilter, setStateFilter] = useState<StateFilter>("any");
  const [registeredFilter, setRegisteredFilter] = useState<RegisteredFilter>("any");
  const [loginFilter, setLoginFilter] = useState<LoginFilter>("any");
  // Tier check kept for the role-grant guards that stay hardcoded
  // (only masteradmin can mint another masteradmin, see plan.md's
  // "hardcoded exceptions"). Field-level permissions migrate to
  // granular keys via `mePermissions` below.
  const isMaster = useChat((s) => isMasterAdminRole(s.me?.role ?? "user"));
  const mePermissions = useChat((s) => s.me?.permissions ?? []);
  const canDeleteUser = mePermissions.includes("hard_delete_user");

  async function reload() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      // While pivoting on an IP (alt-account check), suppress the username
      // search so alts — which have DIFFERENT usernames — aren't filtered out
      // by the name that was searched. The search text stays in the box (just
      // disabled); clearing the IP pivot restores the name search.
      if (q.trim() && !ipPivot.trim()) params.set("q", q.trim());
      if (ipPivot.trim()) params.set("ip", ipPivot.trim());
      // "disabled" and "minor" are DB-backed states, so push them
      // server-side — otherwise a matching account past the first page
      // (username-ordered, limit 100) never loads and the local filter
      // finds nothing. online/offline/away stay client-side (runtime
      // presence).
      if (stateFilter === "disabled") params.set("state", "disabled");
      if (stateFilter === "minor") params.set("state", "minor");
      // "Registered within" is DB-backed, so it must filter server-side too —
      // otherwise a recent signup whose username sorts past the first page
      // (username-ordered, limit 100) never loads and "last 5 days" finds
      // almost nobody. The registration-date / last-seen SORTS likewise order
      // server-side so the globally-newest accounts are actually fetched, not
      // just the first alphabetical page reshuffled. Other sorts stay
      // client-side over the returned page.
      if (registeredFilter !== "any") params.set("registered", registeredFilter);
      if (sortKey === "registered" || sortKey === "lastSeen") {
        params.set("sort", sortKey);
        params.set("dir", sortDir);
      }
      const qs = params.toString();
      const url = qs ? `/admin/users?${qs}` : "/admin/users";
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { users: AdminUserRow[] };
      setRows(j.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }
  // Only the DB-backed sorts (registration date / last seen) need a server
  // round-trip — those order in SQL so the globally-newest rows are fetched.
  // The other sorts (role/state/chars) reorder the returned page in memory, so
  // toggling them must NOT refetch (that would flash a needless loading state).
  const serverSortSig = (sortKey === "registered" || sortKey === "lastSeen") ? `${sortKey}:${sortDir}` : "";
  useEffect(() => {
    const t = window.setTimeout(reload, 200);
    return () => window.clearTimeout(t);
  }, [q, ipPivot, stateFilter, registeredFilter, serverSortSig]);

  async function patch(id: string, body: Record<string, unknown>) {
    const r = await fetch(`/admin/users/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await readError(r));
    setEditing(null);
    await reload();
  }

  async function destroy(u: AdminUserRow) {
    const ok = window.confirm(
      t("users.deleteConfirm", { name: u.username }),
    );
    if (!ok) return;
    try {
      const r = await fetch(`/admin/users/${u.userId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      setEditing(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("deleteFailed"));
    }
  }

  // Client-side filter + sort. The list is capped at MAX_LIMIT=200 on
  // the server, well within "scan in memory" range. Faceted filters
  // here so admins can slice by role/state/window without round-tripping.
  const filteredSorted = useMemo(() => {
    const now = Date.now();
    const dayMs = 86_400_000;
    const sinceMap: Record<RegisteredFilter, number | null> = {
      any: null,
      "24h": now - dayMs,
      "5d": now - 5 * dayMs,
      "7d": now - 7 * dayMs,
      "30d": now - 30 * dayMs,
    };
    const sinceCutoff = sinceMap[registeredFilter];

    const filtered = rows.filter((u) => {
      if (roleFilter !== "any" && u.role !== roleFilter) return false;
      if (stateFilter === "online" && !u.online) return false;
      if (stateFilter === "offline" && (u.online || u.disabled)) return false;
      if (stateFilter === "disabled" && !u.disabled) return false;
      if (stateFilter === "away" && !u.away) return false;
      if (stateFilter === "minor" && u.ageBracket !== "minor") return false;
      if (sinceCutoff != null && u.createdAt < sinceCutoff) return false;
      if (loginFilter === "never" && u.lastLoginAt != null) return false;
      if (loginFilter === "active" && u.lastLoginAt == null) return false;
      return true;
    });

    // Stable role ordering for sort: most-privileged on top in ascending.
    const roleOrder: Record<string, number> = { masteradmin: 0, admin: 1, mod: 2, trusted: 3, user: 4 };
    const stateRank = (u: AdminUserRow) => u.disabled ? 3 : u.online ? 0 : u.away ? 1 : 2;

    const sorted = filtered.slice().sort((a, b) => {
      let cmp = 0;
      if (sortKey === "username") cmp = a.username.localeCompare(b.username);
      else if (sortKey === "role") cmp = (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99);
      else if (sortKey === "state") cmp = stateRank(a) - stateRank(b);
      else if (sortKey === "chars") {
        const ac = a.characters.filter((c) => !c.deleted).length;
        const bc = b.characters.filter((c) => !c.deleted).length;
        cmp = ac - bc;
      }
      else if (sortKey === "registered") cmp = a.createdAt - b.createdAt;
      else if (sortKey === "lastSeen") cmp = (a.lastLoginAt ?? 0) - (b.lastLoginAt ?? 0);
      if (cmp === 0) cmp = a.username.localeCompare(b.username);
      return sortDir === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [rows, roleFilter, stateFilter, registeredFilter, loginFilter, sortKey, sortDir]);

  const toggleSort = (key: UserSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      // Date columns default to newest-first; categorical default ascending.
      setSortDir(key === "registered" || key === "lastSeen" || key === "chars" ? "desc" : "asc");
    }
  };
  const sortIndicator = (key: UserSortKey) => sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const clearFilters = () => {
    setRoleFilter("any");
    setStateFilter("any");
    setRegisteredFilter("any");
    setLoginFilter("any");
  };
  const filterActive = roleFilter !== "any" || stateFilter !== "any" || registeredFilter !== "any" || loginFilter !== "any";

  return (
    <div className="space-y-3">
      <p className="text-xs text-keep-muted">
        <Trans t={t} i18nKey="users.description">
          {'Every registered account, including disabled ones. Search matches username, email, and character name (so a persona name finds its owning OOC account). Editing role to "admin" grants global moderation - same as '}
          <code>/promoteadmin</code>
          {'. "masteradmin" (master-only to set) additionally unlocks settings, branding, rules, account-disable, and email changes.'}
        </Trans>
      </p>

      {/* IP pivot chip, surfaces while a click on an IP chip in the
          table has scoped the list to "every account on this IP." A
          small × clears it back to the unfiltered view. Sits above
          the filter row so it reads as a context layer on top of the
          regular search, not as another filter knob. */}
      {ipPivot ? (
        <div className="flex items-center gap-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">
          <span>
            <Trans t={t} i18nKey="users.ipPivotBanner" values={{ ip: ipPivot }}>
              {"Showing every account seen on "}
              <span className="font-mono">{"{{ip}}"}</span>
            </Trans>
          </span>
          <button
            type="button"
            onClick={() => setIpPivot("")}
            className="ml-auto rounded border border-keep-accent/40 px-1.5 py-0 hover:bg-keep-accent/15"
            title={t("users.clearIpPivot")}
            aria-label={t("users.clearIpPivot")}
          >
            {t("users.clearButton")}
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2 rounded border border-keep-rule/60 bg-keep-bg/30 p-2 text-xs">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("users.searchLabel")}</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={!!ipPivot}
            placeholder={t("users.searchPlaceholder")}
            title={ipPivot ? t("users.searchTitlePivot") : t("users.searchTitle")}
            className="min-w-[12rem] rounded border border-keep-rule bg-keep-bg px-2 py-1 disabled:opacity-50"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("users.roleLabel")}</span>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="any">{t("users.filterAny")}</option>
            <option value="user">{t("users.role.user")}</option>
            <option value="trusted">{t("users.role.trusted")}</option>
            <option value="mod">{t("users.role.mod")}</option>
            <option value="admin">{t("users.role.admin")}</option>
            <option value="masteradmin">{t("users.role.masteradmin")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("users.stateLabel")}</span>
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as StateFilter)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="any">{t("users.filterAny")}</option>
            <option value="online">{t("users.state.online")}</option>
            <option value="offline">{t("users.state.offline")}</option>
            <option value="away">{t("users.state.away")}</option>
            <option value="disabled">{t("users.state.disabled")}</option>
            <option value="minor">{t("users.stateUnder18")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("users.registeredLabel")}</span>
          <select
            value={registeredFilter}
            onChange={(e) => setRegisteredFilter(e.target.value as RegisteredFilter)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="any">{t("users.anyTime")}</option>
            <option value="24h">{t("users.last24h")}</option>
            <option value="5d">{t("users.last5d")}</option>
            <option value="7d">{t("users.last7d")}</option>
            <option value="30d">{t("users.last30d")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("users.loginLabel")}</span>
          <select
            value={loginFilter}
            onChange={(e) => setLoginFilter(e.target.value as LoginFilter)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
            title={t("users.loginTitle")}
          >
            <option value="any">{t("users.filterAny")}</option>
            <option value="never">{t("users.neverLoggedIn")}</option>
            <option value="active">{t("users.hasLoggedIn")}</option>
          </select>
        </label>
        {filterActive ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded border border-keep-rule px-2 py-1 hover:bg-keep-banner/40"
          >{t("users.clearFilters")}</button>
        ) : null}
        <span className="ml-auto text-keep-muted">
          {loading ? t("users.loadingEllipsis") : t("users.countOf", { shown: filteredSorted.length, total: rows.length })}
        </span>
      </div>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      {loading ? (
        <div className="text-keep-muted text-xs">{t("loading")}</div>
      ) : filteredSorted.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          {rows.length === 0 ? t("users.noUsers") : t("users.noFilterMatches")}
        </div>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="cursor-pointer px-2 py-1 text-left hover:text-keep-text" onClick={() => toggleSort("username")}>{t("users.colUsername")}{sortIndicator("username")}</th>
              <th className="px-2 py-1 text-left">{t("users.colEmail")}</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("role")}>{t("users.colRole")}{sortIndicator("role")}</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("state")}>{t("users.colState")}{sortIndicator("state")}</th>
              <th
                data-admin-anchor="users.colAge"
                className="px-2 py-1"
                title={t("users.colAgeTitle")}
              >{t("users.colAge")}</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("chars")}>{t("users.colChars")}{sortIndicator("chars")}</th>
              <th
                data-admin-anchor="users.colIps"
                className="px-2 py-1 text-left"
                title={t("users.colIpsTitle")}
              >{t("users.colIps")}</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("registered")}>{t("users.colRegistered")}{sortIndicator("registered")}</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("lastSeen")}>{t("users.colLastSeen")}{sortIndicator("lastSeen")}</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {filteredSorted.map((u) => {
              const isExpanded = expandedUserIds.has(u.userId);
              const liveCharCount = u.characters.filter((c) => !c.deleted).length;
              return (
              <Fragment key={u.userId}>
              <tr className="border-t border-keep-rule">
                <td className="px-2 py-1 font-semibold">
                  {/* Click the username to expand the user's full character
                      roster inline (see the colspan row below). */}
                  <button
                    type="button"
                    onClick={() => toggleExpanded(u.userId)}
                    aria-expanded={isExpanded}
                    title={isExpanded ? t("users.hideCharacters") : t("users.showCharacters")}
                    className="flex items-center gap-1.5 rounded text-left hover:text-keep-action"
                  >
                    <span aria-hidden className="text-keep-muted">{isExpanded ? "▾" : "▸"}</span>
                    <span className="truncate">{u.username}</span>
                    {liveCharCount > 0 ? (
                      <span className="rounded-full bg-keep-muted/20 px-1.5 text-[9px] font-normal tabular-nums text-keep-muted">
                        {liveCharCount}
                      </span>
                    ) : null}
                  </button>
                </td>
                <td className="px-2 py-1 font-mono">{u.email}</td>
                <td className="px-2 py-1 text-center">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                    u.role === "masteradmin"
                      ? "bg-keep-accent/30 text-keep-accent font-semibold"
                      : u.role === "admin"
                        ? "bg-keep-accent/20 text-keep-accent"
                        : u.role === "mod"
                          ? "bg-keep-action/20 text-keep-action"
                          : "bg-keep-muted/20 text-keep-muted"
                  }`}>
                    {t(`users.role.${u.role}`)}
                  </span>
                </td>
                <td className="px-2 py-1 text-center">
                  {u.disabled ? (
                    <span className="text-keep-accent">{t("users.state.disabled")}</span>
                  ) : u.online ? (
                    <span className="text-keep-action">{t("users.state.online")}</span>
                  ) : (
                    <span className="text-keep-muted">{t("users.state.offline")}</span>
                  )}
                  {u.away ? <span className="ml-1 text-keep-system">{t("users.state.away")}</span> : null}
                </td>
                <td className="px-2 py-1 text-center">
                  <AgeBracketCell
                    birthdate={u.birthdate}
                    bracket={u.ageBracket}
                    isolated={u.isolateFromAdults}
                  />
                </td>
                <td className="px-2 py-1 text-center tabular-nums" title={u.characters.map((c) => c.name).join(", ")}>
                  {u.characters.filter((c) => !c.deleted).length}
                </td>
                <td className="px-2 py-1">
                  <UserIpChips
                    recentIps={u.recentIps}
                    activeIp={ipPivot}
                    onPickIp={(ip) => setIpPivot(ip)}
                  />
                </td>
                <td className="px-2 py-1 text-center tabular-nums" title={formatDateTime(u.createdAt)}>
                  {formatDate(u.createdAt)}
                </td>
                <td className="px-2 py-1 text-center tabular-nums" title={u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t("users.neverLoggedInTitle")}>
                  {u.lastLoginAt ? formatDate(u.lastLoginAt) : <span className="text-keep-muted/70 italic">{t("users.never")}</span>}
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => setEditing(u)}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    {t("edit")}
                  </button>
                  {/* Delete is gated on the granular `hard_delete_user`
                      key. Defaults to masteradmin-only via the matrix
                      seed since hard-deleting cascades through every
                      FK and is one of the most destructive single-row
                      actions; the matrix can hand it to a delegate. */}
                  {canDeleteUser ? (
                    <button
                      type="button"
                      onClick={() => destroy(u)}
                      className="rounded border border-keep-accent/60 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
                    >
                      {t("common:delete")}
                    </button>
                  ) : null}
                </td>
              </tr>
              {isExpanded ? (
                <tr className="border-t border-keep-rule/40 bg-keep-bg/30">
                  {/* Full character roster for the user, View/Edit per
                      profile. colSpan spans all 10 header columns. */}
                  <td colSpan={10} className="px-3 pb-3">
                    <AdminCharactersSection user={u} />
                  </td>
                </tr>
              ) : null}
              </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      {editing ? (
        <UserEditForm
          user={editing}
          isMaster={isMaster}
          onCancel={() => setEditing(null)}
          onSubmit={(body) => patch(editing.userId, body)}
        />
      ) : null}
    </div>
  );
}

/**
 * Compact IP renderer for the UsersTab row. Each IP is a clickable
 * chip that sets the table's `ipPivot` so the surrounding view
 * scopes to every other account that's used the same address,
 * the canonical "spot ban evasion / alt accounts" moderation step.
 *
 * The chip's badge is the count of OTHER accounts on this IP. 0
 * means "this IP is only this user", which is the common case for
 * residential connections; ≥1 flags shared devices / proxies / alts
 * and is worth a closer look. Larger numbers (a coffee-shop or CGNAT
 * IP, say) often have benign explanations, the chip is a starting
 * point, not a verdict.
 *
 * `activeIp` highlights the chip when the pivot already matches it,
 * which is useful while reviewing alts: the row of the IP you
 * pivoted on stays visually anchored as you scroll the result list.
 */
function UserIpChips({
  recentIps,
  activeIp,
  onPickIp,
}: {
  recentIps: AdminUserRow["recentIps"];
  activeIp: string;
  onPickIp: (ip: string) => void;
}) {
  const { t } = useTranslation("admin");
  if (recentIps.length === 0) {
    return <span className="italic text-keep-muted">-</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1">
      {recentIps.map((entry) => {
        const isActive = entry.ip === activeIp;
        // Surface the alt count with a low-effort severity hint: 0
        // alts is muted (no signal), 1-2 is a neutral chip, 3+ is
        // accented because three concurrent accounts on one address
        // is the threshold most installs treat as worth reviewing.
        const altClass =
          entry.altCount === 0
            ? "bg-keep-banner/40 text-keep-muted"
            : entry.altCount <= 2
              ? "bg-keep-action/15 text-keep-action"
              : "bg-keep-accent/20 text-keep-accent";
        return (
          <li key={entry.ip}>
            <button
              type="button"
              onClick={() => onPickIp(entry.ip)}
              title={t("users.ipChipTitle", { time: formatDateTime(entry.lastSeenAt) })}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0 font-mono text-[10px] hover:bg-keep-banner ${
                isActive
                  ? "border-keep-accent bg-keep-accent/15 text-keep-accent"
                  : "border-keep-rule/60 bg-keep-bg text-keep-text"
              }`}
            >
              <span>{entry.ip}</span>
              <span
                className={`rounded-full px-1 text-[9px] uppercase tracking-widest ${altClass}`}
                title={t("users.altBadgeTitle", { count: entry.altCount })}
              >
                {t("users.altBadge", { count: entry.altCount })}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Age-bracket chip for the UsersTab row (age plan Phase 4). The bracket
 * arrives server-derived so it can't drift from the stored date; the
 * exact birth date only surfaces in the hover title (this directory is
 * the one payload allowed to carry it, and keeping it off the visible
 * grid means a shoulder-surfed screen shows brackets, not dates).
 * Minors get the accent treatment because they are the rows the age
 * gates exist for; an "isolated" tag marks minors who turned on "only
 * see members under 18 and staff".
 */
function AgeBracketCell({
  birthdate,
  bracket,
  isolated,
}: {
  birthdate: string | null;
  bracket: "adult" | "minor" | "legacy";
  isolated: boolean;
}) {
  const { t } = useTranslation("admin");
  const title = bracket === "legacy"
    ? t("users.legacyTitle")
    : t("users.bornTitle", { date: birthdate ?? t("users.unknownDate") });
  const chipClass = bracket === "minor"
    ? "bg-keep-accent/20 text-keep-accent font-semibold"
    : bracket === "adult"
      ? "bg-keep-muted/20 text-keep-muted"
      : "bg-keep-muted/10 text-keep-muted italic";
  return (
    <span title={title} className="inline-flex items-center gap-1">
      <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${chipClass}`}>
        {t(`users.bracket.${bracket}`)}
      </span>
      {isolated && bracket === "minor" ? (
        <span
          className="rounded bg-keep-action/15 px-1 text-[9px] uppercase tracking-widest text-keep-action"
          title={t("users.isolatedTitle")}
        >
          {t("users.isolatedChip")}
        </span>
      ) : null}
    </span>
  );
}

function UserEditForm({
  user,
  isMaster,
  onCancel,
  onSubmit,
}: {
  user: AdminUserRow;
  /**
   * Whether the caller is a master admin (role-tier check, not a
   * permission key). Kept because granting the masteradmin role is a
   * hardcoded exception in plan.md, no matrix toggle for that one
   * action. Per-field gates below pull from `me.permissions` so the
   * matrix can hand out e.g. `edit_user_email` without minting a
   * masteradmin.
   */
  isMaster: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation("admin");
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<Role>(user.role);
  const [disabled, setDisabled] = useState(user.disabled);
  // Age settings (age plan Phase 4). `dob` is the correction input
  // (empty string = legacy account with no date; leaving it empty sends
  // nothing — the stored NULL can't be re-written on purpose). The
  // isolation checkbox mirrors the minor's own "only see members under
  // 18 and staff" toggle for support cases.
  const [dob, setDob] = useState(user.birthdate ?? "");
  const [isolate, setIsolate] = useState(user.isolateFromAdults);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Per-field permission gates. Each one corresponds to a server-side
  // route check in apps/server/src/routes/users.ts; the UI surface
  // matches the server so we don't ship affordances that would 403.
  const mePermissions = useChat((s) => s.me?.permissions ?? []);
  const canEditEmail = mePermissions.includes("edit_user_email");
  const canDisableEnable = mePermissions.includes("disable_user") || mePermissions.includes("enable_user");
  const canResetPassword = mePermissions.includes("reset_user_password");
  const canGrantEarning = mePermissions.includes("grant_earning_award");
  const canClearCosmetic = mePermissions.includes("clear_user_cosmetic_override");
  // Account ban (timed/permanent + reason + optional post sweep) — the same
  // ban experience as the profile mod panel, replacing the bare "disabled"
  // checkbox as the primary way to lock an account here.
  const canBanAccount = mePermissions.includes("ban_account");
  // One key covers both age-settings fields (dob correction + isolation
  // set/clear); the server gates them together, see routes/users.ts.
  const canEditDob = mePermissions.includes("edit_user_dob");
  // A non-masteradmin caller can't act on a masteradmin target at all
  // (no demote, no rename, etc.), the row stays read-only so they
  // don't submit a save that would 403. The "you can't outrank
  // yourself" guard stays as a tier check per plan.md's hardcoded
  // exceptions.
  const targetIsMaster = user.role === "masteradmin";
  const locked = !isMaster && targetIsMaster;
  // Live "would this date be a minor?" read of the DOB input, drives the
  // isolation checkbox's visibility so it appears the moment a minor
  // date is typed (and for already-minor targets, whose date seeds the
  // field on open).
  const dobAge = dob ? isoAgeUtc(dob) : null;
  const dobDerivesMinor = dobAge != null && dobAge < 18;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (username !== user.username) body.username = username;
      if (email !== user.email) body.email = email;
      if (role !== user.role) body.role = role;
      if (disabled !== user.disabled) body.disabled = disabled;
      if (canEditDob && dob && dob !== (user.birthdate ?? "")) {
        // An edit that turns an adult (or legacy) account into a minor
        // signs the user out on the spot and drops the age gates over
        // their account — worth a deliberate confirm, same as delete.
        const nextAge = isoAgeUtc(dob);
        if (user.ageBracket !== "minor" && nextAge != null && nextAge < 18) {
          const ok = window.confirm(
            t("users.minorConfirm", { name: user.username }),
          );
          if (!ok) return;
        }
        body.dob = dob;
      }
      if (canEditDob && isolate !== user.isolateFromAdults) body.isolateFromAdults = isolate;
      if (Object.keys(body).length === 0) {
        onCancel();
        return;
      }
      await onSubmit(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-semibold">{t("users.editing", { name: user.username })}</div>
        <button type="button" onClick={onCancel} className="text-keep-muted hover:text-keep-text">{t("users.cancelLower")}</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.usernameLabel")}</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={40}
            className="w-full rounded border border-keep-rule px-2 py-1"
          />
        </label>
        {/* Email is gated on `edit_user_email`, it's an
            account-recovery vector and changing it amounts to identity
            reassignment. Defaults masteradmin-only via the seed but
            grantable through the matrix. */}
        {canEditEmail ? (
          <label>
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.emailLabel")}</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={200}
              className="w-full rounded border border-keep-rule px-2 py-1"
            />
          </label>
        ) : null}
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.roleLabel")}</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            disabled={locked}
            className="w-full rounded border border-keep-rule px-2 py-1 disabled:bg-keep-banner/30"
          >
            <option value="user">{t("users.roleOption.user")}</option>
            <option value="trusted">{t("users.roleOption.trusted")}</option>
            <option value="mod">{t("users.roleOption.mod")}</option>
            <option value="admin">{t("users.roleOption.admin")}</option>
            {/* `masteradmin` is master-only on both ends, only a
                master can mint another master, and only a master can
                strip an existing master's role. A plain admin sees
                the option absent (it'd 403 server-side anyway). */}
            {isMaster ? <option value="masteradmin">{t("users.roleOption.masteradmin")}</option> : null}
          </select>
        </label>
        {/* Disabled toggle is gated on `disable_user`/`enable_user`
           , disabling is an account lockout, which the seed scopes
            to masteradmin-default; the matrix can hand it out per
            user or per role. */}
        {canDisableEnable ? (
          <label className="flex items-end gap-2 pb-1">
            <input
              type="checkbox"
              checked={disabled}
              onChange={(e) => setDisabled(e.target.checked)}
            />
            <span>{t("users.disabledLabel")}</span>
          </label>
        ) : null}
        {/* Birth-date correction, gated on `edit_user_dob` (users can
            never edit their own — decision #7). Saving a date that makes
            an adult a minor confirms first (see submit), then the server
            signs them out so their session rebuilds with the age gates. */}
        {canEditDob ? (
          <label>
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.birthDateLabel")}</span>
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              className="w-full rounded border border-keep-rule px-2 py-1"
            />
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              {user.birthdate == null
                ? t("users.noDobHint")
                : t("users.dobHint")}
            </span>
          </label>
        ) : null}
        {/* Isolation set/clear for support cases. Only meaningful for
            minors (the server rejects turning it ON for adults, and the
            flag is inert once the account is 18), so the checkbox shows
            only when the date in the field is under 18 — or when the
            flag is already set, so it can still be cleared on accounts
            that aged out with it on. */}
        {canEditDob && (dobDerivesMinor || user.isolateFromAdults) ? (
          <label className="flex items-end gap-2 pb-1">
            <input
              type="checkbox"
              checked={isolate}
              onChange={(e) => setIsolate(e.target.checked)}
            />
            <span>
              {t("users.isolationLabel")}
              <span className="block text-[10px] text-keep-muted">
                {t("users.isolationHint")}
              </span>
            </span>
          </label>
        ) : null}
      </div>
      {locked ? (
        <div className="mt-2 rounded border border-keep-rule bg-keep-banner/30 p-2 text-[11px] text-keep-muted">
          {t("users.lockedNote")}
        </div>
      ) : null}

      <AdminCharactersSection user={user} />

      {error ? <div className="mt-2 text-keep-accent">{error}</div> : null}

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner"
        >
          {t("common:cancel")}
        </button>
        <button
          type="submit"
          disabled={submitting || locked}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 disabled:opacity-50 hover:bg-keep-banner/80"
        >
          {submitting ? t("common:savingDots") : t("common:save")}
        </button>
      </div>

      {/* Per-action admin tools. Each section gates on its own
          permission key so a delegate admin with (say) just
          `reset_user_password` sees only the reset section, not the
          earning or cosmetic ones. `locked` still hides the whole
          block when the target outranks the caller. */}
      {!locked && (canBanAccount || canResetPassword || canGrantEarning || canClearCosmetic) ? (
        <div className="mt-4 space-y-3 border-t border-keep-rule pt-3">
          {canBanAccount ? (
            <div data-admin-anchor="users.accountBan">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">{t("users.accountBan")}</div>
              <AccountBanControl userId={user.userId} targetName={user.username} canBan={canBanAccount} />
            </div>
          ) : null}
          {canResetPassword ? (
            <PasswordResetSection userId={user.userId} username={user.username} />
          ) : null}
          {canGrantEarning ? (
            <>
              <EarningGrantSection username={user.username} />
              <EarningResetSection username={user.username} />
            </>
          ) : null}
          {canClearCosmetic ? (
            <CosmeticGrantSection username={user.username} />
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function AdminCharactersSection({ user }: { user: AdminUserRow }) {
  const { t } = useTranslation("admin");
  const openEditor = useChat((s) => s.openEditor);
  const live = user.characters.filter((c) => !c.deleted);
  const deleted = user.characters.filter((c) => c.deleted);
  const [viewing, setViewing] = useState<ProfileView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [viewingName, setViewingName] = useState<string | null>(null);

  async function openView(name: string) {
    setViewError(null);
    setViewingName(name);
    try {
      const r = await fetch(`/profiles/${encodeURIComponent(name)}`, { credentials: "include" });
      if (!r.ok) {
        setViewError(r.status === 404 ? t("users.profileNotFound") : t("modCases.profileLoadHttpError", { status: r.status }));
        setViewingName(null);
        return;
      }
      const j = await r.json();
      if (j && "private" in j) {
        setViewError(t("users.profileRestricted"));
        setViewingName(null);
        return;
      }
      setViewing(j as ProfileView);
    } catch {
      setViewError(t("modCases.profileLoadError"));
      setViewingName(null);
    }
  }

  const editChar = (c: { id: string }) => openEditor({
    mode: "character",
    characterId: c.id,
    adminContext: { ownerUserId: user.userId, ownerUsername: user.username },
  });

  return (
    <>
      <div className="mt-3 rounded border border-keep-rule/60 bg-keep-bg/40 p-2">
        <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">
          {t("users.profiles")}
        </div>
        <ul className="space-y-1">
          <li className="flex items-center justify-between gap-2 rounded border border-keep-rule/60 bg-keep-bg px-2 py-1">
            <span className="truncate">
              <span className="mr-2 rounded bg-keep-action/15 px-1 text-[9px] uppercase tracking-widest text-keep-action">{t("common:identity.ooc")}</span>
              {user.username}
            </span>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => openView(user.username)}
                className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner"
              >
                {t("users.view")}
              </button>
            </div>
          </li>
          {live.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded border border-keep-rule/60 bg-keep-bg px-2 py-1">
              <span className="truncate">{c.name}</span>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => openView(c.name)}
                  className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner"
                >
                  {t("users.view")}
                </button>
                <button
                  type="button"
                  onClick={() => editChar(c)}
                  className="keep-button rounded border border-keep-action/60 bg-keep-bg px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/10"
                >
                  {t("edit")}
                </button>
              </div>
            </li>
          ))}
          {deleted.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded border border-keep-rule/30 bg-keep-banner/20 px-2 py-1 text-keep-muted line-through">
              <span className="truncate">{c.name}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-widest">{t("users.deletedTag")}</span>
            </li>
          ))}
        </ul>
        {viewError ? (
          <div className="mt-2 text-[11px] text-keep-accent">{viewError}</div>
        ) : null}
        {viewingName && !viewing && !viewError ? (
          <div className="mt-2 text-[11px] text-keep-muted">{t("users.loadingName", { name: viewingName })}</div>
        ) : null}
      </div>
      {viewing ? (
        <ProfileModal
          profile={viewing}
          onClose={() => { setViewing(null); setViewingName(null); }}
          bypassNsfwGate={true}
          zIndex={60}
        />
      ) : null}
    </>
  );
}

/* =========================================================
 *  Master-admin per-user tools (live inside UserEditForm)
 *
 *  Each section owns its own state + submit handler. The shared
 *  password / grant / reset endpoints all take the username (the
 *  earning grants already work that way; password reset is /admin/
 *  users/:id). Errors surface inline per section so a failed grant
 *  doesn't blow away the rest of the edit form's state.
 * ========================================================= */

function PasswordResetSection({ userId, username }: { userId: string; username: string }) {
  const { t } = useTranslation("admin");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setErr(null);
    setOk(false);
    if (next.length < 8) { setErr(t("users.passwordTooShort")); return; }
    if (next !== confirm) { setErr(t("users.passwordMismatch")); return; }
    setBusy(true);
    try {
      const r = await fetch(`/admin/users/${userId}/password`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: next }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setOk(true);
      setNext("");
      setConfirm("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("users.resetFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setErr(null); setOk(false); setCopied(false);
    const pw = generateStrongPassword(20);
    setNext(pw);
    setConfirm(pw);
    // Best-effort clipboard copy. navigator.clipboard requires
    // a secure context (https or localhost) AND a user gesture,
    // the click on this button qualifies for both. Falls back to
    // a hidden-textarea + execCommand on older browsers / non-
    // secure contexts. Either way the password is in the inputs
    // so the admin can copy manually if needed.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(pw);
        setCopied(true);
      } else {
        const ta = document.createElement("textarea");
        ta.value = pw;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          setCopied(true);
        } finally {
          document.body.removeChild(ta);
        }
      }
      window.setTimeout(() => setCopied(false), 3000);
    } catch {
      // Silent, the password is visible in the inputs; admin can
      // select + copy by hand if the clipboard API rejected.
    }
  }

  return (
    <fieldset data-admin-anchor="users.resetPassword" className="rounded border border-keep-rule p-2">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("users.resetPasswordLegend", { name: username })}</legend>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.newPassword")}</span>
          <input
            type="text"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            className="w-full rounded border border-keep-rule px-2 py-1 font-mono"
          />
        </label>
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.confirmPassword")}</span>
          <input
            type="text"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            className="w-full rounded border border-keep-rule px-2 py-1 font-mono"
          />
        </label>
      </div>
      <p className="mt-1 text-[10px] text-keep-muted">
        {t("users.resetPasswordHelp")}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void generate()}
          disabled={busy}
          className="keep-button rounded border border-keep-rule bg-keep-banner/40 px-3 py-1 text-keep-text hover:bg-keep-banner disabled:opacity-50"
        >
          {t("users.generate")}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !next || !confirm}
          className="keep-button rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
        >
          {busy ? t("users.resetting") : t("users.resetPassword")}
        </button>
        {copied ? <span className="text-keep-system">{t("users.copiedToClipboard")}</span> : null}
        {err ? <span className="text-keep-accent">{err}</span> : null}
        {ok ? <span className="text-keep-system">{t("users.passwordResetDone")}</span> : null}
      </div>
    </fieldset>
  );
}

/**
 * Generate a `length`-char password using the platform CSPRNG. The
 * alphabet drops easily-confused glyphs (0/O, 1/l/I) so a verbally
 * dictated password doesn't trip the recipient up, admins commonly
 * read these out over chat or paste into help-desk tickets where
 * font choices make those ambiguous.
 */
function generateStrongPassword(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*?";
  const bytes = new Uint8Array(length);
  (globalThis.crypto ?? (window as { crypto: Crypto }).crypto).getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

function EarningGrantSection({ username }: { username: string }) {
  const { t } = useTranslation("admin");
  const [xp, setXp] = useState("");
  const [currency, setCurrency] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function grant() {
    setErr(null); setOk(null);
    const xpDelta = parseInt(xp || "0", 10) || 0;
    const currencyDelta = parseInt(currency || "0", 10) || 0;
    if (xpDelta === 0 && currencyDelta === 0) { setErr(t("users.grantAmountError")); return; }
    setBusy(true);
    try {
      if (xpDelta !== 0) {
        const r = await fetch("/admin/earning/grant-xp", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, amount: xpDelta }),
        });
        if (!r.ok) throw new Error(await readError(r));
      }
      if (currencyDelta !== 0) {
        const r = await fetch("/admin/earning/grant-currency", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, amount: currencyDelta }),
        });
        if (!r.ok) throw new Error(await readError(r));
      }
      setOk(t("users.grantedAmounts", { xp: xpDelta, currency: currencyDelta }));
      setXp(""); setCurrency("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("users.grantFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset data-admin-anchor="users.grantLegend" className="rounded border border-keep-rule p-2">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("users.grantLegend")}</legend>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.xpLabel")}</span>
          <input
            type="number"
            value={xp}
            onChange={(e) => setXp(e.target.value)}
            placeholder="100"
            className="w-full rounded border border-keep-rule px-2 py-1 font-mono"
          />
        </label>
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.currencyLabel")}</span>
          <input
            type="number"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder="100"
            className="w-full rounded border border-keep-rule px-2 py-1 font-mono"
          />
        </label>
      </div>
      <p className="mt-1 text-[10px] text-keep-muted">
        {t("users.grantHelp")}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void grant()}
          disabled={busy}
          className="keep-button rounded border border-keep-action/60 bg-keep-action/10 px-3 py-1 text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
        >
          {busy ? t("users.granting") : t("users.grant")}
        </button>
        {err ? <span className="text-keep-accent">{err}</span> : null}
        {ok ? <span className="text-keep-system">{ok}</span> : null}
      </div>
    </fieldset>
  );
}

function CosmeticGrantSection({ username }: { username: string }) {
  const { t } = useTranslation("admin");
  const snapshot = useEarning((s) => s.snapshot);
  const [pickedStyle, setPickedStyle] = useState<string>("");
  const [pickedBorder, setPickedBorder] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  // Live snapshot of the TARGET user's ownership, refreshed after
  // every grant/revoke. We can't use the admin's own /earning/me
  // for this, we need to see what THEY own. The lightweight
  // /admin/earning/user-ownership endpoint returns key arrays.
  const [owned, setOwned] = useState<{ styles: string[]; borders: string[] }>({ styles: [], borders: [] });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/admin/earning/user-ownership?username=${encodeURIComponent(username)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        setOwned({
          styles: Array.isArray(j.ownedStyles) ? j.ownedStyles : [],
          borders: Array.isArray(j.ownedBorders) ? j.ownedBorders : [],
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [username, refreshKey]);

  async function callAction(path: string, payload: Record<string, unknown>, successMsg: string) {
    setErr(null); setOk(null); setBusy(true);
    try {
      const r = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await readError(r));
      setOk(successMsg);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  const styles = snapshot?.catalog.nameStyles ?? [];
  const borderRanks = (snapshot?.catalog.rankTiers ?? []).filter((t) => t.tier === 4 && !!t.borderImageUrl);
  const styleNameByKey = new Map(styles.map((s) => [s.key, s.name]));
  const rankNameByKey = new Map((snapshot?.catalog.ranks ?? []).map((r) => [r.key, r.name]));

  return (
    <fieldset data-admin-anchor="users.cosmeticsLegend" className="rounded border border-keep-rule p-2">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("users.cosmeticsLegend")}</legend>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.nameStyleLabel")}</span>
          <div className="flex gap-1">
            <select
              value={pickedStyle}
              onChange={(e) => setPickedStyle(e.target.value)}
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1"
            >
              <option value="">{t("users.pickOne")}</option>
              {styles.map((s) => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => pickedStyle && void callAction("/admin/earning/grant-style", { username, styleKey: pickedStyle }, t("users.grantedStyle", { key: pickedStyle }))}
              disabled={busy || !pickedStyle}
              className="shrink-0 rounded border border-keep-action/60 bg-keep-action/10 px-2 text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
            >
              {t("users.grant")}
            </button>
          </div>
        </div>
        <div>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.borderLabel")}</span>
          <div className="flex gap-1">
            <select
              value={pickedBorder}
              onChange={(e) => setPickedBorder(e.target.value)}
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1"
            >
              <option value="">{t("users.pickOne")}</option>
              {borderRanks.map((t2) => {
                const rank = snapshot?.catalog.ranks.find((r) => r.key === t2.rankKey);
                return (
                  <option key={t2.rankKey} value={t2.rankKey}>{rank?.name ?? t2.rankKey}</option>
                );
              })}
            </select>
            <button
              type="button"
              onClick={() => pickedBorder && void callAction("/admin/earning/grant-border", { username, rankKey: pickedBorder }, t("users.grantedBorder", { key: pickedBorder }))}
              disabled={busy || !pickedBorder}
              className="shrink-0 rounded border border-keep-action/60 bg-keep-action/10 px-2 text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
            >
              {t("users.grant")}
            </button>
          </div>
        </div>
      </div>

      {/* Currently-owned list with per-item Revoke. Driven off the
          live /admin/earning/user-ownership response so the panel
          reflects the actual server state, including any grants
          made via /earning purchase flows OR earlier admin grants
          in the same session. */}
      {owned.styles.length > 0 || owned.borders.length > 0 ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.ownedStyles")}</span>
            {owned.styles.length === 0 ? (
              <div className="text-keep-muted">{t("noneParen")}</div>
            ) : (
              <ul className="space-y-1">
                {owned.styles.map((k) => (
                  <li key={k} className="flex items-center justify-between gap-1 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1">
                    <span className="truncate" title={k}>{styleNameByKey.get(k) ?? k}</span>
                    <button
                      type="button"
                      onClick={() => void callAction("/admin/earning/revoke-style", { username, styleKey: k }, t("users.revokedStyle", { key: k }))}
                      disabled={busy}
                      className="shrink-0 rounded border border-keep-accent/60 bg-keep-accent/10 px-2 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
                    >
                      {t("users.revoke")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("users.ownedBorders")}</span>
            {owned.borders.length === 0 ? (
              <div className="text-keep-muted">{t("noneParen")}</div>
            ) : (
              <ul className="space-y-1">
                {owned.borders.map((k) => (
                  <li key={k} className="flex items-center justify-between gap-1 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1">
                    <span className="truncate" title={k}>{rankNameByKey.get(k) ?? k}</span>
                    <button
                      type="button"
                      onClick={() => void callAction("/admin/earning/revoke-border", { username, rankKey: k }, t("users.revokedBorder", { key: k }))}
                      disabled={busy}
                      className="shrink-0 rounded border border-keep-accent/60 bg-keep-accent/10 px-2 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
                    >
                      {t("users.revoke")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-1 text-[10px] text-keep-muted">{t("users.noCosmetics")}</p>
      )}

      <p className="mt-1 text-[10px] text-keep-muted">
        {t("users.cosmeticsHelp")}
      </p>
      <div className="mt-1 flex items-center gap-2">
        {err ? <span className="text-keep-accent">{err}</span> : null}
        {ok ? <span className="text-keep-system">{ok}</span> : null}
      </div>
    </fieldset>
  );
}

function EarningResetSection({ username }: { username: string }) {
  const { t } = useTranslation("admin");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function reset() {
    setErr(null); setOk(false);
    const confirmed = window.confirm(
      t("users.resetEarningConfirm", { name: username }),
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const r = await fetch("/admin/earning/reset-user", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setOk(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("users.resetFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset data-admin-anchor="users.resetEarningLegend" className="rounded border border-keep-accent/40 p-2">
      <legend className="px-1 uppercase tracking-widest text-keep-accent">{t("users.resetEarningLegend")}</legend>
      <p className="text-[10px] text-keep-muted">
        {t("users.resetEarningHelp")}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void reset()}
          disabled={busy}
          className="keep-button rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
        >
          {busy ? t("users.resetting") : t("users.resetEarning")}
        </button>
        {err ? <span className="text-keep-accent">{err}</span> : null}
        {ok ? <span className="text-keep-system">{t("users.earningResetDone")}</span> : null}
      </div>
    </fieldset>
  );
}
