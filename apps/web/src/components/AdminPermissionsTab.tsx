/**
 * Admin, Roles & Permissions matrix.
 *
 * Two sub-tabs sit inside this single AdminPanel tab:
 *
 *   By role , the canonical matrix. Roles down the left, permission
 *              keys grouped by feature area across the top. Click a
 *              cell to toggle the role grant. Masteradmin row is
 *              locked-all-on (bypass is hardcoded server-side, and
 *              writing the row would be a no-op anyway).
 *
 *   By user , per-user overrides. Search a user, then toggle each
 *              permission through three states:
 *
 *                "from role" (greyed)        → falls back to role grant
 *                "granted"   (green ✓)       → explicit grant on top of role
 *                "revoked"   (red −)         → explicit revoke against role
 *
 *              The cycle is from-role → granted → revoked → from-role.
 *              "Active overrides" panel at the top lists every user
 *              with at least one override so a masteradmin can audit
 *              what's been customized at a glance.
 *
 * Reads are gated on `view_admin_permissions`; mutations on
 * `manage_permissions`. Both default to masteradmin-only via the
 * migration seed; a senior admin can be granted the matrix without
 * being promoted to masteradmin.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  PRIVACY_SENSITIVE_KEYS,
  type PermissionGroup,
  type PermissionKey,
  type Role,
} from "@thekeep/shared";
import { readError } from "../lib/http.js";
import { useChat } from "../state/store.js";

const EDITABLE_ROLES: readonly Role[] = ["user", "trusted", "mod", "admin"] as const;
const ALL_ROLES: readonly Role[] = ["user", "trusted", "mod", "admin", "masteradmin"] as const;

const ROLE_LABEL: Record<Role, string> = {
  user: "User",
  trusted: "Trusted",
  mod: "Mod",
  admin: "Admin",
  masteradmin: "Masteradmin",
};

const GROUP_LABEL: Record<PermissionGroup, string> = {
  chat_moderation: "Chat moderation",
  room_admin: "Room admin",
  arcade: "Spire Arcade",
  cosmetics: "Cosmetics",
  user_admin: "User admin",
  site_admin: "Site admin",
  content_admin: "Content admin",
  audit_view: "Audit & reports",
  admin_panel_tabs: "Admin panel tabs",
  earning_admin: "Earning admin",
  backups: "Backups",
  permission_admin: "Permission admin",
};

interface MatrixSnapshot {
  roles: Record<string, PermissionKey[]>;
  userOverrides: Array<{
    userId: string;
    username: string;
    role: Role;
    granted: PermissionKey[];
    revoked: PermissionKey[];
  }>;
}

interface UserSearchHit {
  userId: string;
  username: string;
  role: Role;
  hasOverrides: boolean;
}

interface UserOverrideDetail {
  userId: string;
  username: string;
  role: Role;
  granted: PermissionKey[];
  revoked: PermissionKey[];
}

interface PermissionAuditEntry {
  id: string;
  action: string;
  actorUsername: string;
  actorUserId: string;
  targetUsername: string | null;
  targetUserId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/** Pre-grouped catalog so the matrix can render section headers
 *  without re-iterating PERMISSION_KEYS in every cell. Computed once
 *  at module load. */
const KEYS_BY_GROUP: ReadonlyArray<[PermissionGroup, readonly PermissionKey[]]> = (() => {
  const buckets = new Map<PermissionGroup, PermissionKey[]>();
  for (const key of PERMISSION_KEYS) {
    const group = PERMISSION_GROUPS[key];
    const arr = buckets.get(group) ?? [];
    arr.push(key);
    buckets.set(group, arr);
  }
  // Preserve catalog order across groups.
  const seen = new Set<PermissionGroup>();
  const out: Array<[PermissionGroup, readonly PermissionKey[]]> = [];
  for (const key of PERMISSION_KEYS) {
    const group = PERMISSION_GROUPS[key];
    if (seen.has(group)) continue;
    seen.add(group);
    out.push([group, buckets.get(group)!]);
  }
  return out;
})();

/** Shape passed through both matrices into their cell renderers so a
 *  "history" click anywhere in the matrix can deep-link the audit
 *  feed below. The feed lifts its own state up so we can prefill it
 *  from outside; passing `null` means "don't override, keep current". */
interface AuditDeepLink {
  setKey: (key: string) => void;
  setRole: (role: string) => void;
  /** Sets the user filter to a specific user. We pass both the
   *  internal id (the actual filter value sent to the server) AND
   *  the username so the audit panel can render the picked user as
   *  a readable chip without having to do its own id-→-username
   *  lookup. */
  setUser: (userId: string, username: string) => void;
  /** Scroll the audit feed into view + expand it. Called after a
   *  filter is set so the user sees the result immediately. */
  focusFeed: () => void;
}

export function AdminPermissionsTab() {
  const [subtab, setSubtab] = useState<"by-role" | "by-user">("by-role");
  const me = useChat((s) => s.me);
  const canEdit = me?.permissions.includes("manage_permissions") ?? false;

  // Lifted audit-feed state so the By-role + By-user matrices can
  // deep-link into a focused history view. The feed renders these as
  // controlled inputs. `auditUserId` is the actual filter value sent
  // to the server; `auditUserLabel` is the username shown in the UI
  // chip so admins don't have to read raw nanoids.
  const [auditKey, setAuditKey] = useState("");
  const [auditRole, setAuditRole] = useState("");
  const [auditUserId, setAuditUserId] = useState("");
  const [auditUserLabel, setAuditUserLabel] = useState("");
  const auditRef = useRef<HTMLDetailsElement | null>(null);
  const focusFeed = useCallback(() => {
    if (auditRef.current) {
      auditRef.current.open = true;
      auditRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);
  const setUser = useCallback((userId: string, username: string) => {
    setAuditUserId(userId);
    setAuditUserLabel(username);
  }, []);
  const deepLink: AuditDeepLink = useMemo(
    () => ({ setKey: setAuditKey, setRole: setAuditRole, setUser, focusFeed }),
    [focusFeed, setUser],
  );

  return (
    <section className="space-y-3 text-sm">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-action text-base">Roles & Permissions</h3>
          <nav className="flex gap-1 text-xs uppercase tracking-widest">
            <SubtabBtn active={subtab === "by-role"} onClick={() => setSubtab("by-role")}>
              By role
            </SubtabBtn>
            <SubtabBtn active={subtab === "by-user"} onClick={() => setSubtab("by-user")}>
              By user
            </SubtabBtn>
          </nav>
        </div>
        {!canEdit ? (
          <p className="rounded border border-keep-rule bg-keep-banner/40 p-2 text-xs italic text-keep-muted">
            Read-only, you can view the matrix but not edit it. Editing requires the
            <code className="mx-1 rounded bg-keep-bg px-1 font-mono text-[10px]">manage_permissions</code>
            key.
          </p>
        ) : null}
      </header>

      {subtab === "by-role"
        ? <ByRole canEdit={canEdit} deepLink={deepLink} />
        : <ByUser canEdit={canEdit} deepLink={deepLink} />}

      <DiagnosticsPanel />

      <SensitiveGrantsAdvisory />

      <PermissionAuditFeed
        innerRef={auditRef}
        keyFilter={auditKey}
        setKeyFilter={setAuditKey}
        roleFilter={auditRole}
        setRoleFilter={setAuditRole}
        userId={auditUserId}
        userLabel={auditUserLabel}
        setUser={setUser}
      />
    </section>
  );
}

function SubtabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border border-keep-rule px-2 py-0.5 ${
        active ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"
      }`}
    >
      {children}
    </button>
  );
}

/* =============================================================
 * BY-ROLE MATRIX
 * ============================================================= */

function ByRole({ canEdit, deepLink }: { canEdit: boolean; deepLink: AuditDeepLink }) {
  const [snapshot, setSnapshot] = useState<MatrixSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    fetch("/admin/permissions", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<MatrixSnapshot>;
      })
      .then((j) => { if (!cancelled) setSnapshot(j); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // O(1) lookup: which roles hold which key. Built once per snapshot
  // load so the cell render stays cheap.
  const grantedSets = useMemo(() => {
    const out = new Map<Role, Set<PermissionKey>>();
    if (!snapshot) return out;
    for (const role of EDITABLE_ROLES) {
      out.set(role, new Set(snapshot.roles[role] ?? []));
    }
    return out;
  }, [snapshot]);

  const filteredGroups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return KEYS_BY_GROUP;
    return KEYS_BY_GROUP
      .map(([group, keys]) => {
        const matched = keys.filter((k) => k.includes(q) || PERMISSION_DESCRIPTIONS[k].toLowerCase().includes(q));
        return [group, matched] as [PermissionGroup, readonly PermissionKey[]];
      })
      .filter(([, keys]) => keys.length > 0);
  }, [filter]);

  const toggle = useCallback(async (role: Role, key: PermissionKey, granted: boolean) => {
    setBusy(`${role}:${key}`);
    setError(null);
    // Optimistic update, flip the cell in the snapshot immediately so
    // the click feels instant. Roll back on failure.
    setSnapshot((prev) => {
      if (!prev) return prev;
      const nextList = new Set(prev.roles[role] ?? []);
      if (granted) nextList.add(key);
      else nextList.delete(key);
      return { ...prev, roles: { ...prev.roles, [role]: [...nextList] } };
    });
    try {
      const res = await fetch("/admin/permissions/roles", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, permissionKey: key, granted }),
      });
      if (!res.ok) throw new Error(await readError(res));
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
      setRefreshKey((k) => k + 1); // re-sync from server on error
    } finally {
      setBusy(null);
    }
  }, []);

  if (error && !snapshot) {
    return <p className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</p>;
  }
  if (!snapshot) {
    return <p className="italic text-keep-muted">Loading matrix…</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-keep-muted">Filter:</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="kick_user, journal, audit…"
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
          />
        </label>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          className="rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5 hover:bg-keep-banner"
        >
          Refresh
        </button>
        {error ? (
          <span className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-0.5 text-keep-accent">
            {error}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded border border-keep-rule bg-keep-bg">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-keep-rule bg-keep-banner/40">
              <th className="sticky left-0 z-10 border-r border-keep-rule bg-keep-banner/40 px-2 py-1 text-left">
                Permission
              </th>
              {ALL_ROLES.map((role) => (
                <th
                  key={role}
                  className="px-2 py-1 text-center"
                  title={role === "masteradmin" ? "Masteradmin holds every permission by definition." : undefined}
                >
                  {ROLE_LABEL[role]}
                  {role === "masteradmin" ? (
                    <span className="ml-1 text-[10px] uppercase tracking-widest text-keep-muted">(locked)</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredGroups.map(([group, keys]) => (
              <GroupRows
                key={group}
                group={group}
                keys={keys}
                grantedSets={grantedSets}
                busy={busy}
                canEdit={canEdit}
                onToggle={toggle}
                deepLink={deepLink}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] italic text-keep-muted">
        Masteradmin row is locked-on by definition, the bypass is hardcoded in the
        server. Toggling any cell takes effect immediately; affected users see the new
        permissions on their next /auth/me poll (within 60 seconds, no re-login).
        Click the <span className="not-italic">log</span> button next to a permission
        key to jump to its grant history.
      </p>
    </div>
  );
}

function GroupRows({
  group,
  keys,
  grantedSets,
  busy,
  canEdit,
  onToggle,
  deepLink,
}: {
  group: PermissionGroup;
  keys: readonly PermissionKey[];
  grantedSets: Map<Role, Set<PermissionKey>>;
  busy: string | null;
  canEdit: boolean;
  onToggle: (role: Role, key: PermissionKey, granted: boolean) => void;
  deepLink: AuditDeepLink;
}) {
  return (
    <>
      <tr className="border-y border-keep-rule bg-keep-banner/60">
        <th
          colSpan={ALL_ROLES.length + 1}
          className="px-2 py-1 text-left text-xs uppercase tracking-widest text-keep-muted"
        >
          {GROUP_LABEL[group]}
        </th>
      </tr>
      {keys.map((key) => (
        <tr key={key} className="border-b border-keep-rule/60 hover:bg-keep-banner/30">
          <td className="sticky left-0 z-10 border-r border-keep-rule bg-keep-bg px-2 py-1 align-top">
            <div className="flex items-center gap-1">
              <code className="font-mono text-[11px]">{key}</code>
              {PRIVACY_SENSITIVE_KEYS.has(key) ? (
                <span
                  title="Privacy-sensitive, granting this key reveals other users' private content."
                  className="rounded border border-keep-accent/60 bg-keep-accent/15 px-1 text-[9px] uppercase tracking-widest text-keep-accent"
                >
                  privacy
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  deepLink.setKey(key);
                  deepLink.setRole("");
                  deepLink.setUser("", "");
                  deepLink.focusFeed();
                }}
                title={`Show grant history for ${key}`}
                className="ml-auto rounded border border-keep-rule/60 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text"
                aria-label={`Show grant history for ${key}`}
              >
                log
              </button>
            </div>
            <p className="text-[10px] italic text-keep-muted">{PERMISSION_DESCRIPTIONS[key]}</p>
          </td>
          {ALL_ROLES.map((role) => (
            <td key={role} className="px-2 py-1 text-center align-top">
              <RoleCell
                role={role}
                permissionKey={key}
                checked={role === "masteradmin" ? true : grantedSets.get(role)?.has(key) ?? false}
                disabled={!canEdit || role === "masteradmin" || busy === `${role}:${key}`}
                onChange={(next) => onToggle(role, key, next)}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function RoleCell({
  role,
  permissionKey,
  checked,
  disabled,
  onChange,
}: {
  role: Role;
  permissionKey: PermissionKey;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={`${ROLE_LABEL[role]} can ${permissionKey}`}
      className="h-4 w-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

/* =============================================================
 * BY-USER OVERRIDES
 * ============================================================= */

function ByUser({ canEdit, deepLink }: { canEdit: boolean; deepLink: AuditDeepLink }) {
  const me = useChat((s) => s.me);
  const [snapshot, setSnapshot] = useState<MatrixSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<UserSearchHit[]>([]);
  const [picked, setPicked] = useState<UserOverrideDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const debounceRef = useRef<number | null>(null);

  // Load the snapshot once for the "Active overrides" summary.
  useEffect(() => {
    fetch("/admin/permissions", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<MatrixSnapshot>;
      })
      .then(setSnapshot)
      .catch((err) => setError(err instanceof Error ? err.message : "load failed"));
  }, [refreshKey]);

  // Debounced typeahead search.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length === 0) {
      setSearchResults([]);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      fetch(`/admin/permissions/users/search?q=${encodeURIComponent(q)}`, { credentials: "include" })
        .then(async (r) => {
          if (!r.ok) throw new Error(await readError(r));
          return r.json() as Promise<{ users: UserSearchHit[] }>;
        })
        .then((j) => setSearchResults(j.users))
        .catch((err) => setError(err instanceof Error ? err.message : "search failed"));
    }, 200);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query]);

  const pickUser = useCallback(async (userId: string) => {
    setError(null);
    try {
      const res = await fetch(`/admin/permissions/users/${encodeURIComponent(userId)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as UserOverrideDetail;
      setPicked(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }, []);

  // Resolve the role grants for the picked user's role (so we can render
  // the "from role" state correctly).
  const fromRoleSet = useMemo(() => {
    if (!picked || !snapshot) return new Set<PermissionKey>();
    return new Set(snapshot.roles[picked.role] ?? []);
  }, [picked, snapshot]);

  const grantedSet = useMemo(() => new Set(picked?.granted ?? []), [picked]);
  const revokedSet = useMemo(() => new Set(picked?.revoked ?? []), [picked]);

  const cycle = useCallback(async (key: PermissionKey) => {
    if (!picked) return;
    // Cycle: from-role → granted → revoked → from-role (clear)
    const isGranted = grantedSet.has(key);
    const isRevoked = revokedSet.has(key);
    let next: boolean | null;
    if (!isGranted && !isRevoked) next = true;     // from-role → granted
    else if (isGranted) next = false;              // granted → revoked
    else next = null;                              // revoked → from-role (clear)

    setBusy(key);
    setError(null);
    // Optimistic update.
    setPicked((prev) => {
      if (!prev) return prev;
      const granted = new Set(prev.granted);
      const revoked = new Set(prev.revoked);
      granted.delete(key);
      revoked.delete(key);
      if (next === true) granted.add(key);
      if (next === false) revoked.add(key);
      return { ...prev, granted: [...granted], revoked: [...revoked] };
    });

    try {
      const res = await fetch("/admin/permissions/users", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: picked.userId, permissionKey: key, granted: next }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setRefreshKey((k) => k + 1); // refresh the active-overrides panel
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
      // Reload to re-sync on failure.
      void pickUser(picked.userId);
    } finally {
      setBusy(null);
    }
  }, [picked, grantedSet, revokedSet, pickUser]);

  const isSelf = picked?.userId === me?.id;

  return (
    <div className="space-y-3">
      {/* Search lands at the top, typeahead is the primary entry
          point for the By-user tab. "Active overrides" sits below
          as a secondary affordance for browsing the customized set. */}
      <div className="rounded border border-keep-rule bg-keep-bg p-2">
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-keep-muted">Find user</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Username prefix…"
            className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
        {searchResults.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs">
            {searchResults.map((u) => (
              <li key={u.userId}>
                <button
                  type="button"
                  onClick={() => { void pickUser(u.userId); setQuery(""); setSearchResults([]); }}
                  className="flex w-full items-baseline justify-between gap-2 rounded border border-keep-rule px-2 py-1 text-left hover:bg-keep-banner/40"
                >
                  <span>
                    <span className="font-action">{u.username}</span>
                    <span className="ml-1 text-[10px] italic text-keep-muted">{ROLE_LABEL[u.role]}</span>
                  </span>
                  {u.hasOverrides ? (
                    <span className="rounded bg-keep-banner px-1 text-[9px] uppercase tracking-widest text-keep-muted">
                      has overrides
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {snapshot && snapshot.userOverrides.length > 0 ? (
        <details className="rounded border border-keep-rule bg-keep-bg p-2">
          <summary className="cursor-pointer text-xs uppercase tracking-widest text-keep-muted">
            Active overrides ({snapshot.userOverrides.length})
          </summary>
          <ul className="mt-1 space-y-1 text-xs">
            {snapshot.userOverrides.map((u) => (
              <li key={u.userId} className="flex items-baseline justify-between gap-2 border-b border-keep-rule/60 py-1 last:border-0">
                <span>
                  <button
                    type="button"
                    onClick={() => pickUser(u.userId)}
                    className="font-action underline-offset-2 hover:underline"
                  >
                    {u.username}
                  </button>
                  <span className="ml-1 text-[10px] italic text-keep-muted">{ROLE_LABEL[u.role]}</span>
                </span>
                <span className="text-[10px] text-keep-muted">
                  +{u.granted.length} grants / -{u.revoked.length} revokes
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {error ? <p className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</p> : null}

      {picked ? (
        <UserOverridesEditor
          user={picked}
          fromRoleSet={fromRoleSet}
          grantedSet={grantedSet}
          revokedSet={revokedSet}
          canEdit={canEdit && !isSelf}
          isSelf={isSelf}
          busy={busy}
          onCycle={cycle}
          deepLink={deepLink}
        />
      ) : (
        <p className="italic text-keep-muted">Pick a user above to edit their overrides.</p>
      )}
    </div>
  );
}

function UserOverridesEditor({
  user,
  fromRoleSet,
  grantedSet,
  revokedSet,
  canEdit,
  isSelf,
  busy,
  onCycle,
  deepLink,
}: {
  user: UserOverrideDetail;
  fromRoleSet: ReadonlySet<PermissionKey>;
  grantedSet: ReadonlySet<PermissionKey>;
  revokedSet: ReadonlySet<PermissionKey>;
  canEdit: boolean;
  isSelf: boolean;
  busy: string | null;
  onCycle: (key: PermissionKey) => void;
  deepLink: AuditDeepLink;
}) {
  const [filter, setFilter] = useState("");
  const filteredGroups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return KEYS_BY_GROUP;
    return KEYS_BY_GROUP
      .map(([group, keys]) => {
        const matched = keys.filter((k) => k.includes(q) || PERMISSION_DESCRIPTIONS[k].toLowerCase().includes(q));
        return [group, matched] as [PermissionGroup, readonly PermissionKey[]];
      })
      .filter(([, keys]) => keys.length > 0);
  }, [filter]);

  return (
    <div className="space-y-2 rounded border border-keep-rule bg-keep-bg p-2">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h4 className="font-action text-sm">{user.username}</h4>
          <p className="text-[11px] italic text-keep-muted">
            Role: <span className="font-action not-italic">{ROLE_LABEL[user.role]}</span>
            {" · "}
            {user.granted.length} grants / {user.revoked.length} revokes
            {" · "}
            <button
              type="button"
              onClick={() => {
                deepLink.setKey("");
                deepLink.setRole("");
                deepLink.setUser(user.userId, user.username);
                deepLink.focusFeed();
              }}
              className="underline-offset-2 hover:underline"
              title="Show grant history for this user"
            >
              history
            </button>
          </p>
        </div>
        <label className="text-xs">
          <span className="text-keep-muted">Filter:</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search keys…"
            className="ml-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5"
          />
        </label>
      </header>
      {isSelf ? (
        <p className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
          You cannot edit your own overrides. Use a different masteradmin account.
        </p>
      ) : null}
      <div className="space-y-2">
        {filteredGroups.map(([group, keys]) => (
          <details key={group} open className="rounded border border-keep-rule/60">
            <summary className="cursor-pointer bg-keep-banner/40 px-2 py-1 text-xs uppercase tracking-widest text-keep-muted">
              {GROUP_LABEL[group]}
            </summary>
            <ul className="divide-y divide-keep-rule/40">
              {keys.map((key) => {
                const isGranted = grantedSet.has(key);
                const isRevoked = revokedSet.has(key);
                const isFromRole = !isGranted && !isRevoked;
                const roleHasIt = fromRoleSet.has(key);
                const state: "granted" | "revoked" | "from-role" = isGranted
                  ? "granted"
                  : isRevoked
                    ? "revoked"
                    : "from-role";
                const effective =
                  state === "granted" ? true :
                  state === "revoked" ? false :
                  roleHasIt;
                return (
                  <li key={key} className="flex items-start gap-2 px-2 py-1">
                    <button
                      type="button"
                      onClick={() => onCycle(key)}
                      disabled={!canEdit || busy === key}
                      title={describeCycle(state, roleHasIt)}
                      className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${cellClass(state)} disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      {cellLabel(state)}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <code className="font-mono text-[11px]">{key}</code>
                        {PRIVACY_SENSITIVE_KEYS.has(key) ? (
                          <span className="rounded bg-yellow-200 px-1 text-[9px] uppercase tracking-widest text-yellow-900">
                            privacy
                          </span>
                        ) : null}
                        <span className={`ml-auto text-[10px] uppercase tracking-widest ${
                          effective ? "text-green-700" : "text-keep-muted"
                        }`}>
                          {effective ? "active" : "inactive"}
                        </span>
                      </div>
                      <p className="text-[10px] italic text-keep-muted">{PERMISSION_DESCRIPTIONS[key]}</p>
                      <p className="text-[10px] text-keep-muted">
                        {isFromRole
                          ? `Inherits from ${ROLE_LABEL[user.role]} (${roleHasIt ? "granted" : "not granted"})`
                          : isGranted
                            ? "Explicitly granted"
                            : "Explicitly revoked"}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}

function cellClass(state: "granted" | "revoked" | "from-role"): string {
  if (state === "granted") return "border-green-700 bg-green-200 text-green-900";
  if (state === "revoked") return "border-red-700 bg-red-200 text-red-900";
  return "border-keep-rule bg-keep-banner/40 text-keep-muted";
}

function cellLabel(state: "granted" | "revoked" | "from-role"): string {
  if (state === "granted") return "✓"; // check
  if (state === "revoked") return "−"; // minus
  return "·"; // middle dot
}

function describeCycle(state: "granted" | "revoked" | "from-role", roleHasIt: boolean): string {
  if (state === "from-role") {
    return roleHasIt
      ? "Currently inheriting GRANT from role. Click → explicitly grant."
      : "Currently inheriting DENY from role. Click → explicitly grant.";
  }
  if (state === "granted") return "Explicitly granted. Click → explicitly revoke.";
  return "Explicitly revoked. Click → clear (fall back to role).";
}

/* =============================================================
 * RECENT ACTIVITY
 * ============================================================= */

function PermissionAuditFeed({
  innerRef,
  keyFilter,
  setKeyFilter,
  roleFilter,
  setRoleFilter,
  userId,
  userLabel,
  setUser,
}: {
  /** Forwarded to the <details> element so the parent can scroll into
   *  view + force-open the panel when a matrix cell deep-links into a
   *  filter. */
  innerRef: React.MutableRefObject<HTMLDetailsElement | null>;
  keyFilter: string;
  setKeyFilter: (v: string) => void;
  roleFilter: string;
  setRoleFilter: (v: string) => void;
  userId: string;
  userLabel: string;
  setUser: (userId: string, username: string) => void;
}) {
  const [entries, setEntries] = useState<PermissionAuditEntry[] | null>(null);
  // Username typeahead state. Separate from the actual filter values
  // so the user can browse search results without committing one
  // until they click. The submitted filter (`userId`) stays bound to
  // the parent.
  const [userQuery, setUserQuery] = useState("");
  const [userResults, setUserResults] = useState<UserSearchHit[]>([]);
  // The audit feed is collapsed by default; only fire the fetch once
  // the user has opened the panel (or a deep-link forces it open).
  // `opened` flips on first open and stays true so filter changes
  // re-fetch afterwards without flicker.
  const [opened, setOpened] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const searchDebounceRef = useRef<number | null>(null);

  // If a deep-link came in (any filter set externally), expand and
  // mark as opened so the fetch fires.
  const externalFilterSet = !!(keyFilter || roleFilter || userId);
  useEffect(() => {
    if (externalFilterSet) setOpened(true);
  }, [externalFilterSet]);

  useEffect(() => {
    if (!opened) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: "50" });
      if (keyFilter.trim()) params.set("permissionKey", keyFilter.trim());
      if (roleFilter.trim()) params.set("role", roleFilter.trim());
      if (userId.trim()) params.set("userId", userId.trim());
      fetch(`/admin/permissions/audit?${params.toString()}`, { credentials: "include" })
        .then(async (r) => (r.ok ? (r.json() as Promise<{ entries: PermissionAuditEntry[] }>) : { entries: [] }))
        .then((j) => setEntries(j.entries))
        .catch(() => setEntries([]));
    }, 250);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [opened, keyFilter, roleFilter, userId]);

  // Debounced username typeahead. Stays inert when the input is
  // empty so a focused-but-untyped field doesn't fetch.
  useEffect(() => {
    if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current);
    const q = userQuery.trim();
    if (q.length === 0) {
      setUserResults([]);
      return;
    }
    searchDebounceRef.current = window.setTimeout(() => {
      fetch(`/admin/permissions/users/search?q=${encodeURIComponent(q)}`, { credentials: "include" })
        .then(async (r) => (r.ok ? (r.json() as Promise<{ users: UserSearchHit[] }>) : { users: [] }))
        .then((j) => setUserResults(j.users))
        .catch(() => setUserResults([]));
    }, 200);
    return () => {
      if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current);
    };
  }, [userQuery]);

  function pickUser(u: UserSearchHit) {
    setUser(u.userId, u.username);
    setUserQuery("");
    setUserResults([]);
  }

  function clearAll() {
    setKeyFilter("");
    setRoleFilter("");
    setUser("", "");
    setUserQuery("");
    setUserResults([]);
  }

  // Render the panel even when empty so the filter inputs stay
  // available, collapsing on the empty state would hide them once
  // a too-narrow filter zeroes the rows.
  const count = entries?.length ?? 0;
  const hasAnyFilter = !!(keyFilter || roleFilter || userId);

  return (
    <details
      ref={innerRef}
      onToggle={(e) => {
        // `e.currentTarget` is the <details>; its `open` property
        // reflects the post-toggle state. We only flip our own state
        // forward (to true), closing the panel doesn't reset
        // anything, so the filter values persist if the user toggles
        // it back open.
        if ((e.currentTarget as HTMLDetailsElement).open) setOpened(true);
      }}
      className="rounded border border-keep-rule bg-keep-bg p-2"
    >
      <summary className="cursor-pointer text-xs uppercase tracking-widest text-keep-muted">
        Recent permission changes ({opened ? (entries === null ? "…" : count) : "click to load"})
      </summary>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-keep-muted">Key:</span>
          <input
            value={keyFilter}
            onChange={(e) => setKeyFilter(e.target.value)}
            placeholder="kick_user"
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 font-mono text-[11px]"
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-keep-muted">Role:</span>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5"
          >
            <option value="">any</option>
            {EDITABLE_ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        </label>
        {/* Username typeahead. When a user is picked we show a chip
            with an × to clear; while no user is picked, the input
            stays available for searching. */}
        <div className="relative flex items-center gap-1">
          <span className="text-keep-muted">User:</span>
          {userId && userLabel ? (
            <span className="inline-flex items-center gap-1 rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5">
              <span className="font-action">{userLabel}</span>
              <button
                type="button"
                onClick={() => setUser("", "")}
                className="text-keep-muted hover:text-keep-text"
                title="Clear user filter"
                aria-label="Clear user filter"
              >
                ×
              </button>
            </span>
          ) : (
            <>
              <input
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="username prefix…"
                className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-0.5"
              />
              {userResults.length > 0 ? (
                <ul className="absolute left-12 top-full z-10 mt-1 max-h-48 w-48 overflow-auto rounded border border-keep-rule bg-keep-bg shadow-lg">
                  {userResults.map((u) => (
                    <li key={u.userId}>
                      <button
                        type="button"
                        onClick={() => pickUser(u)}
                        className="flex w-full items-baseline justify-between gap-2 px-2 py-1 text-left text-xs hover:bg-keep-banner/40"
                      >
                        <span className="font-action">{u.username}</span>
                        <span className="text-[10px] italic text-keep-muted">{ROLE_LABEL[u.role]}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
        {hasAnyFilter ? (
          <button
            type="button"
            onClick={clearAll}
            className="rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5 text-keep-muted hover:bg-keep-banner"
          >
            Clear
          </button>
        ) : null}
      </div>
      {entries === null ? (
        <p className="mt-2 italic text-keep-muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="mt-2 italic text-keep-muted">No matching entries.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-xs">
          {entries.map((e) => (
            <li key={e.id} className="border-b border-keep-rule/40 py-1 last:border-0">
              <span className="text-[10px] text-keep-muted">
                {new Date(e.createdAt).toLocaleString()}
              </span>
              {", "}
              <span className="font-action">{e.actorUsername}</span>
              {" "}
              <code className="font-mono text-[10px]">{e.action.replace(/_/g, " ")}</code>
              {e.targetUsername ? <> on <span className="font-action">{e.targetUsername}</span></> : null}
              {e.metadata ? (
                <span className="ml-1 text-[10px] text-keep-muted">{describeMetadata(e.metadata)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/* =============================================================
 * DIAGNOSTICS PANEL
 *
 * One-button "is the permission system healthy?" check. Calls
 * `/admin/permissions/diagnostics` (server-side runs the same engine
 * as the `scripts/check-permissions.ts` CLI) and renders the result:
 *   - All green → a single line with check count + green badge.
 *   - Anything red → red banner with failure count + collapsible
 *     details containing the per-group rollup and a list of every
 *     failure (rule, role, key, expected vs actual).
 *
 * Idle until clicked, no auto-run on mount. The endpoint is cheap
 * (in-memory walk of a small cache) but reading every time the tab
 * opens would just add noise.
 * ============================================================= */

type DiagnosticGroup = PermissionGroup | "live-state" | "meta";

interface DiagnosticFailure {
  group: DiagnosticGroup;
  rule: string;
  role?: string;
  key?: string;
  userId?: string;
  expected?: boolean;
  actual?: boolean;
  note?: string;
}

interface DiagnosticsResult {
  checksRun: number;
  ok: boolean;
  failures: DiagnosticFailure[];
  byGroup: Array<{ group: DiagnosticGroup; run: number; failed: number }>;
}

const DIAG_GROUP_LABEL: Record<DiagnosticGroup, string> = {
  ...GROUP_LABEL,
  "live-state": "Live state integrity",
  meta: "Meta (catalog coverage)",
};

function DiagnosticsPanel() {
  const [result, setResult] = useState<DiagnosticsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/admin/permissions/diagnostics", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      setResult(await r.json() as DiagnosticsResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "check failed");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section className="rounded border border-keep-rule bg-keep-banner/30 p-3 text-xs">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-action text-sm">Integrity check</h4>
          <p className="text-keep-muted">
            Runs every safety invariant (resolver precedence, masteradmin-only key leaks,
            orphan catalog keys, fallback engagement) against the live cache.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 font-action text-[11px] uppercase tracking-widest hover:bg-keep-banner disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? "Running…" : result ? "Re-run" : "Run check"}
        </button>
      </header>

      {error ? (
        <p className="mt-2 rounded border border-red-700 bg-red-950/40 p-2 text-red-200">
          {error}
        </p>
      ) : null}

      {result ? <DiagnosticsResultView result={result} /> : null}
    </section>
  );
}

function DiagnosticsResultView({ result }: { result: DiagnosticsResult }) {
  // Pre-bucket failures by group so the expanded details renders one
  // section per group rather than a flat list, easier to scan when
  // failures cluster in one feature area.
  const failuresByGroup = useMemo(() => {
    const m = new Map<DiagnosticGroup, DiagnosticFailure[]>();
    for (const f of result.failures) {
      const arr = m.get(f.group) ?? [];
      arr.push(f);
      m.set(f.group, arr);
    }
    return m;
  }, [result]);

  if (result.ok) {
    return (
      <p className="mt-2 rounded border border-emerald-700 bg-emerald-950/40 p-2 text-emerald-200">
        <span className="font-action">All passed</span>, {result.checksRun} checks across
        {" "}{result.byGroup.length} groups.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <p className="rounded border border-red-700 bg-red-950/40 p-2 text-red-200">
        <span className="font-action">{result.failures.length} failed</span>
        {", "}{result.checksRun - result.failures.length}/{result.checksRun} checks passed.
      </p>
      <details className="mt-2 rounded border border-keep-rule bg-keep-bg/60 p-2">
        <summary className="cursor-pointer font-action text-keep-muted">
          Show failures by group
        </summary>
        <div className="mt-2 space-y-3">
          {result.byGroup
            .filter((row) => row.failed > 0)
            .map((row) => (
              <div key={row.group}>
                <h5 className="font-action text-xs text-red-300">
                  {DIAG_GROUP_LABEL[row.group]}{" "}
                  <span className="text-[10px] text-keep-muted">
                    ({row.failed}/{row.run} failed)
                  </span>
                </h5>
                <ul className="mt-1 space-y-1">
                  {(failuresByGroup.get(row.group) ?? []).map((f, i) => (
                    <li key={i} className="rounded border border-keep-rule/40 bg-keep-banner/40 p-1.5">
                      <div className="text-[11px]">
                        <span className="font-action text-keep-fg">{f.rule}</span>
                        {f.expected !== undefined || f.actual !== undefined ? (
                          <span className="ml-2 text-[10px] text-keep-muted">
                            expected={String(f.expected ?? "-")} actual={String(f.actual ?? "-")}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-keep-muted">
                        {f.role ? <code className="rounded bg-keep-bg px-1 font-mono">role={f.role}</code> : null}
                        {f.key ? <code className="rounded bg-keep-bg px-1 font-mono">key={f.key}</code> : null}
                        {f.userId ? <code className="rounded bg-keep-bg px-1 font-mono">user={f.userId}</code> : null}
                      </div>
                      {f.note ? <p className="mt-1 italic text-[10px] text-keep-muted">{f.note}</p> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}

          {/* Per-group rollup (greens included) for context. */}
          <div className="border-t border-keep-rule/40 pt-2 text-[10px] text-keep-muted">
            <div className="font-action uppercase tracking-widest">Per-group rollup</div>
            <ul className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
              {result.byGroup.map((row) => (
                <li key={`r-${row.group}`}>
                  {row.failed === 0 ? (
                    <span className="text-emerald-300">✓</span>
                  ) : (
                    <span className="text-red-300">✗</span>
                  )}{" "}
                  {DIAG_GROUP_LABEL[row.group]}
                  {", "}
                  {row.run - row.failed}/{row.run}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </div>
  );
}

/* =============================================================
 * SENSITIVE GRANTS ADVISORY
 *
 * Informational catalog: who currently holds the privacy-sensitive
 * + high-impact permission keys. Not pass/fail, the matrix
 * intentionally allows a masteradmin to extend these to anyone they
 * trust. The point of this panel is to give a periodic eyeball
 * check: "yep, those are still the people I want holding these."
 *
 * Categorized into:
 *   - Privacy-sensitive  → keys that expose other users' private
 *                          content (journals, deleted bodies, …).
 *   - High-impact        → destructive / account-affecting actions
 *                          (delete user, reset password, manage
 *                          backups, manage the matrix itself, …).
 *
 * Idle until clicked, same as the diagnostics panel. Each row shows
 * the key + group + description, role badges for roles holding it,
 * and user badges for individual override grants. A key with no
 * holders renders as a muted "none", that's noteworthy on its own
 * (nobody currently has hard_delete_user is fine to know).
 * ============================================================= */

type SensitiveCategory = "privacy" | "high-impact";

interface SensitiveGrantEntry {
  key: PermissionKey;
  category: SensitiveCategory;
  group: PermissionGroup;
  description: string;
  roles: Role[];
  users: Array<{ userId: string; username: string; role: Role }>;
}

interface SensitiveGrantsResponse {
  keys: SensitiveGrantEntry[];
}

/** Buckets the by-key advisory response into a by-actor shape:
 *  for every role and every user, the set of sensitive keys they
 *  hold (split by privacy vs high-impact). This is the lens the
 *  advisory exists to provide, "what does each actor hold?",
 *  rather than the inverse "who holds this key?". */
interface ActorHolding {
  /** Keys held, partitioned by category for the per-actor display. */
  privacy: SensitiveGrantEntry[];
  highImpact: SensitiveGrantEntry[];
}

function pivotToActors(entries: SensitiveGrantEntry[]): {
  byRole: Array<{ role: Role; holding: ActorHolding }>;
  byUser: Array<{ userId: string; username: string; role: Role; holding: ActorHolding }>;
} {
  const roleMap = new Map<Role, ActorHolding>();
  const userMap = new Map<string, { username: string; role: Role; holding: ActorHolding }>();

  function bumpRole(role: Role, entry: SensitiveGrantEntry): void {
    const cur = roleMap.get(role) ?? { privacy: [], highImpact: [] };
    (entry.category === "privacy" ? cur.privacy : cur.highImpact).push(entry);
    roleMap.set(role, cur);
  }
  function bumpUser(u: { userId: string; username: string; role: Role }, entry: SensitiveGrantEntry): void {
    const cur = userMap.get(u.userId) ?? {
      username: u.username,
      role: u.role,
      holding: { privacy: [], highImpact: [] },
    };
    (entry.category === "privacy" ? cur.holding.privacy : cur.holding.highImpact).push(entry);
    userMap.set(u.userId, cur);
  }

  for (const entry of entries) {
    for (const role of entry.roles) bumpRole(role, entry);
    for (const u of entry.users) bumpUser(u, entry);
  }

  // Most-privileged role first; user list alphabetical.
  const ROLE_ORDER: Record<Role, number> = {
    masteradmin: 0, admin: 1, mod: 2, trusted: 3, user: 4,
  };
  const byRole = Array.from(roleMap.entries())
    .map(([role, holding]) => ({ role, holding }))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const byUser = Array.from(userMap.entries())
    .map(([userId, v]) => ({ userId, ...v }))
    .sort((a, b) => a.username.localeCompare(b.username));

  return { byRole, byUser };
}

function SensitiveGrantsAdvisory() {
  const [data, setData] = useState<SensitiveGrantsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/admin/permissions/sensitive-grants", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      setData(await r.json() as SensitiveGrantsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const pivot = useMemo(() => (data ? pivotToActors(data.keys) : null), [data]);

  return (
    <section className="rounded border border-keep-rule bg-keep-banner/30 p-3 text-xs">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-action text-sm">Sensitive permission holders</h4>
          <p className="text-keep-muted">
            Informational. Shows what each role and user currently holds across the
            privacy-sensitive and high-impact key sets, so you can confirm the grants still
            match your intent.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={busy}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 font-action text-[11px] uppercase tracking-widest hover:bg-keep-banner disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? "Loading…" : data ? "Refresh" : "Show holders"}
        </button>
      </header>

      {error ? (
        <p className="mt-2 rounded border border-red-700 bg-red-950/40 p-2 text-red-200">{error}</p>
      ) : null}

      {pivot ? (
        <div className="mt-3 space-y-3">
          <p className="rounded border border-keep-rule/60 bg-keep-bg/40 p-2 text-[11px] text-keep-muted">
            <span className="font-action text-keep-fg">Masteradmin</span> holds every permission by
            bypass, including all keys listed below, and is not enumerated here.
          </p>

          {pivot.byRole.length === 0 && pivot.byUser.length === 0 ? (
            <p className="italic text-keep-muted">
              No role or user currently holds any sensitive key. Only masteradmin has them.
            </p>
          ) : null}

          {pivot.byRole.length > 0 ? (
            <div>
              <h5 className="font-action text-xs uppercase tracking-widest text-keep-muted">
                By role
              </h5>
              <ul className="mt-1 space-y-2">
                {pivot.byRole.map((row) => (
                  <ActorCard
                    key={`role-${row.role}`}
                    title={ROLE_LABEL[row.role]}
                    subtitle="Role grant"
                    titleAccent={null}
                    holding={row.holding}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {pivot.byUser.length > 0 ? (
            <div>
              <h5 className="font-action text-xs uppercase tracking-widest text-keep-muted">
                By user (explicit overrides)
              </h5>
              <p className="text-[10px] italic text-keep-muted">
                Grants applied to a specific account on top of (or independent of) their role.
                A user with role-level holdings also appears in the By role section above.
              </p>
              <ul className="mt-1 space-y-2">
                {pivot.byUser.map((row) => (
                  <ActorCard
                    key={`user-${row.userId}`}
                    title={row.username}
                    subtitle={`Override grant · role: ${ROLE_LABEL[row.role]}`}
                    titleAccent="amber"
                    holding={row.holding}
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** One actor (role or user) and the sensitive keys they hold,
 *  partitioned into privacy vs high-impact sub-lists. Used in both
 *  the By-role and By-user sections so the layout stays consistent
 *  and a reader can scan either section the same way. */
function ActorCard({
  title,
  subtitle,
  titleAccent,
  holding,
}: {
  title: string;
  subtitle: string;
  titleAccent: "amber" | null;
  holding: ActorHolding;
}) {
  return (
    <li className="rounded border border-keep-rule/60 bg-keep-banner/40 p-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span
          className={
            titleAccent === "amber"
              ? "font-action text-sm text-amber-200"
              : "font-action text-sm"
          }
        >
          {title}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">
          {subtitle}
        </span>
      </div>
      <div className="mt-1.5 space-y-1.5">
        {holding.privacy.length > 0 ? (
          <ActorKeyList label="Privacy-sensitive" entries={holding.privacy} />
        ) : null}
        {holding.highImpact.length > 0 ? (
          <ActorKeyList label="High-impact actions" entries={holding.highImpact} />
        ) : null}
      </div>
    </li>
  );
}

function ActorKeyList({
  label,
  entries,
}: {
  label: string;
  entries: SensitiveGrantEntry[];
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-keep-muted">{label}</div>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {entries.map((e) => (
          <code
            key={e.key}
            title={e.description}
            className="cursor-help rounded bg-keep-bg px-1.5 py-0.5 font-mono text-[10px] text-keep-fg"
          >
            {e.key}
          </code>
        ))}
      </div>
    </div>
  );
}

function describeMetadata(metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof metadata.role === "string") parts.push(`role=${metadata.role}`);
  if (typeof metadata.permissionKey === "string") parts.push(`key=${metadata.permissionKey}`);
  if (typeof metadata.granted === "boolean") parts.push(metadata.granted ? "granted" : "revoked");
  return parts.length > 0 ? `(${parts.join(", ")})` : "";
}
