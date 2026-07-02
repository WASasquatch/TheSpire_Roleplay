import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import DOMPurify from "dompurify";
import { sanitizeUserHtml, USER_HTML_SCOPE_CLASS } from "../lib/userHtml.js";
import type { AuditEntry, PermissionKey, ProfileView, ReportEntry, Role, Theme, ThemeableTextSlot } from "@thekeep/shared";
import { AUDIT_ACTION_GROUPS, THEME_PRESETS } from "@thekeep/shared";
import {
  DEFAULT_THEME,
  isMasterAdminRole,
  normalizeTheme,
  THEMEABLE_TEXT_SLOTS,
} from "@thekeep/shared";
import { useActiveTheme } from "../lib/theme.js";
import { readError } from "../lib/http.js";
import { listStyles } from "../lib/ornaments/index.js";
import { AdminBackupsTab } from "./AdminBackupsTab.js";
import { AdminSystemTab } from "./AdminSystemTab.js";
import { AdminVerifyLogTab } from "./AdminVerifyLogTab.js";
import { AdminScriptoriumTab } from "./AdminScriptoriumTab.js";
import { AdminForumsTab } from "./AdminForumsTab.js";
import { AdminServersTab } from "./AdminServersTab.js";
import { AdminPermissionsTab } from "./AdminPermissionsTab.js";
import { AdminModCasesTab } from "./AdminModCasesTab.js";
import { AdminEmailTab } from "./AdminEmailTab.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { AccountBanControl } from "./AccountBanControl.js";
import { ProfileModal } from "./ProfileModal.js";
import { ThemePicker } from "./ThemePicker.js";
import { useChat } from "../state/store.js";
import { useEarning } from "../state/earning.js";
import { useReducedMotion } from "../lib/reducedMotion.js";
import { CloseButton } from "./CloseButton.js";
import { AffiliateCard } from "./AffiliateCard.js";
import { TagInput } from "./TagInput.js";
import {
  AFFILIATE_LIMITS,
  adminCreateAffiliate,
  adminDeleteAffiliate,
  adminUpdateAffiliate,
  fetchAdminAffiliates,
  isValidAffiliateUrl,
  linkBackUrl,
  type AdminAffiliate,
  type PublicAffiliateCard,
} from "../lib/affiliates.js";

interface Props {
  onClose: () => void;
  /** Bumped after any change so the banner re-fetches. */
  onLinksChanged: () => void;
  /** Open a server's per-server admin console (Servers tab oversight drill-in). */
  onOpenServerConsole?: (serverId: string) => void;
  /** Step into a server's chat rooms to moderate (Servers tab; global staff). */
  onEnterServer?: (serverId: string, name: string) => void;
}

type Tab = "overview" | "settings" | "branding" | "rules" | "links" | "affiliates" | "users" | "reports" | "mod-cases" | "verify-logs" | "scriptorium" | "forums" | "servers" | "audit" | "system" | "backups" | "permissions" | "email";

/** Tab grouping for the strip's section dividers. Each tab carries
 *  the id of the group it belongs to; the render walks the list
 *  inserting visual separators wherever the group changes. Groups
 *  also drive the mobile dropdown's `<optgroup>` labels so the
 *  same mental model surfaces on both layouts. */
type TabGroup = "monitor" | "people" | "content" | "siteconfig" | "system";

const TAB_GROUP_LABEL: Record<TabGroup, string> = {
  monitor: "Monitor",
  people: "People & access",
  content: "Content & community",
  siteconfig: "Site configuration",
  system: "System",
};

/** Single source of truth for tabs. Order here = order in both the
 *  desktop strip and the mobile dropdown. Grouped by feature axis:
 *  monitor → people → content → site config → system. Within each
 *  group, ordering follows typical workflow (e.g. Permissions sets
 *  policy before Users applies it; Reports surfaces what needs
 *  attention before Audit shows the broader log).
 *
 *  - `masterOnly` tabs are gated to masteradmin role for legacy tabs
 *    that haven't been ported to permission-key gates yet.
 *  - `permission` tabs are gated on the granular Phase-2 key; the tab
 *    appears for any user whose resolved `me.permissions` includes
 *    the listed key. Lets a masteradmin grant the matrix to a senior
 *    admin without minting them as full masteradmin. New tabs should
 *    prefer this form over `masterOnly`. */
const TAB_ITEMS: ReadonlyArray<{
  id: Tab;
  label: string;
  group: TabGroup;
  masterOnly?: boolean;
  permission?: PermissionKey;
}> = [
  // ----- Monitor: surfaces for the moderation-queue workflow -----
  { id: "overview", label: "Overview", group: "monitor" },
  { id: "audit", label: "Audit", group: "monitor" },
  { id: "reports", label: "Reports", group: "monitor" },
  { id: "mod-cases", label: "Mod Log", group: "monitor", permission: "view_admin_mod_cases" },
  { id: "verify-logs", label: "Verify Log", group: "monitor", permission: "verify_export_logs" },

  // ----- People & access: who can do what -----
  // Permissions ships first because the workflow is "set policy then
  // apply it", admins typically pick a role's grant set before
  // touching individual user rows.
  { id: "permissions", label: "Permissions", group: "people", permission: "view_admin_permissions" },
  { id: "users", label: "Users", group: "people" },

  // ----- Content & community: catalogs the community engages with -----
  // Rooms, Commands, Titles, Emoticons, Announcements, FAQs, AND EARNING are now
  // PER-SERVER (Admin Partition — plan_ext.md; "nothing stays global"): every
  // server (incl. The Spire) manages its own ranks/cosmetics/items/grants in its
  // Server Admin → Earning tab. Global staff reach any server's via the Servers
  // tab → "Open admin". Reports keeps the DM/profile queue here (message reports
  // are per-server). Scriptorium stays (a platform writing feature, not chat).
  { id: "scriptorium", label: "Scriptorium", group: "content" },
  { id: "forums", label: "Forums", group: "content", permission: "view_admin_forums" },
  { id: "servers", label: "Servers", group: "content", permission: "view_admin_servers" },
  { id: "email", label: "Email", group: "siteconfig", permission: "view_admin_email" },

  // ----- Site configuration: install-level chrome -----
  { id: "settings", label: "Settings", group: "siteconfig", permission: "view_admin_settings" },
  { id: "branding", label: "Branding", group: "siteconfig", permission: "view_admin_branding" },
  { id: "rules", label: "Rules", group: "siteconfig", permission: "view_admin_rules" },
  { id: "links", label: "Nav Links", group: "siteconfig" },
  { id: "affiliates", label: "Top Communities", group: "siteconfig" },

  // ----- System: destructive paths land last so a misclick on the
  //       strip can't take you here by accident. -----
  // Backups carries the destructive Restore / Import paths that can
  // blow away the whole DB. The matrix seed pins
  // `view_admin_backups` to masteradmin-only; the granular key gives
  // the option of granting it to a delegate without elevating the
  // delegate to full masteradmin.
  // System tab: live server metrics + masteradmin-only maintenance tools
  // (restart, purge messages). Sits left of Backups; both are the
  // destructive "system" group that lands last on the strip.
  { id: "system", label: "System", group: "system", permission: "view_system_metrics" },
  { id: "backups", label: "Backups", group: "system", permission: "view_admin_backups" },
];

/** Tab-visibility predicate. Masteradmin sees every tab unconditionally
 *  (matches the server-side bypass). Otherwise:
 *   - A tab with no gate fields is visible to everyone reaching the
 *     panel.
 *   - A tab with `permission` is visible iff the viewer holds that
 *     key in their resolved permission set.
 *   - A tab with `masterOnly: true` is visible only to masteradmin.
 *
 *  The compound case (`masterOnly` AND `permission`) is intentionally
 *  rejected at the type level via the discriminated-union shape, a
 *  tab carrying both fields would be ambiguous about which gate
 *  wins. Stick to one or the other. */
function tabVisible(
  tab: { masterOnly?: boolean; permission?: PermissionKey },
  isMaster: boolean,
  permissions: readonly PermissionKey[],
): boolean {
  if (isMaster) return true;
  if (tab.permission) return permissions.includes(tab.permission);
  if (tab.masterOnly) return false;
  return true;
}

/** Bucket a list of (already-filtered-for-visibility) tabs by their
 *  `group` field. Returns the buckets in TAB_ITEMS order so the
 *  mobile dropdown preserves the same vertical sequence as the
 *  desktop strip. Empty groups drop out entirely, a viewer whose
 *  permission set hides every tab in a category doesn't see that
 *  category's optgroup label. */
function groupVisibleTabs<T extends { group: TabGroup }>(
  tabs: readonly T[],
): Array<[TabGroup, T[]]> {
  const buckets = new Map<TabGroup, T[]>();
  for (const t of tabs) {
    const arr = buckets.get(t.group) ?? [];
    arr.push(t);
    buckets.set(t.group, arr);
  }
  return Array.from(buckets.entries());
}

/** Walk the visible-tab list and yield a flat sequence of tab buttons
 *  interspersed with separator markers whenever the group changes.
 *  Returns a discriminated union so the renderer can pattern-match
 *  on `kind` and pick the right element type. The separator carries
 *  the group it's transitioning AWAY from so the title hover shows
 *  which section just ended. */
type StripEntry<T> =
  | { kind: "tab"; tab: T }
  | { kind: "separator"; afterGroup: TabGroup };

function withGroupSeparators<T extends { group: TabGroup }>(
  tabs: readonly T[],
): StripEntry<T>[] {
  const out: StripEntry<T>[] = [];
  let prevGroup: TabGroup | null = null;
  for (const t of tabs) {
    if (prevGroup !== null && t.group !== prevGroup) {
      out.push({ kind: "separator", afterGroup: prevGroup });
    }
    out.push({ kind: "tab", tab: t });
    prevGroup = t.group;
  }
  return out;
}

/**
 * Per-tab access to the AdminPanel modal shell. Tabs use `setFooter`
 * to project save/cancel/status controls into the persistent modal
 * footer, instead of rendering them inline at the bottom of the
 * scrolling form (which previously made for an awkward gap at the
 * bottom of the modal). `close` is the same callback the X button
 * uses, exposed here so a tab's Cancel button can wire up to it
 * without prop-drilling.
 *
 * `setFooter(null)` (or letting the tab unmount on tab-switch) drops
 * back to the default footer, a lone Close button on the right.
 */
interface AdminShellAPI {
  setFooter: (node: ReactNode | null) => void;
  close: () => void;
}
const AdminShellContext = createContext<AdminShellAPI | null>(null);

/**
 * Hook for tabs to register footer content. Returns null when called
 * outside the AdminPanel shell (tabs can render in isolation in
 * tests / Storybook without crashing), callers should defensive-
 * check before using `setFooter` / `close`.
 */
export function useAdminShell(): AdminShellAPI | null {
  return useContext(AdminShellContext);
}

/**
 * Standard footer cluster for the three save-form tabs (Settings,
 * Branding, Rules). They all share the same shape, status text on
 * the left, Cancel + Save on the right, so the helper keeps the
 * three tabs' useEffects from drifting apart visually.
 *
 * The Save button submits the tab's `<form id={formId}>` via the
 * HTML5 `form` attribute. The form lives inside the body's scroll
 * area; the button lives outside it, in the modal footer. Browser
 * still routes the submit to the right form. No React plumbing
 * (lift state up, render-prop, etc.) needed.
 */
export function AdminSaveFooter({
  formId,
  saving,
  savedFlash,
  lastUpdatedAt,
  error,
  saveLabel,
  canEdit = true,
  readOnlyHint,
}: {
  formId: string;
  saving: boolean;
  savedFlash: boolean;
  lastUpdatedAt: number | null;
  error: string | null;
  /** e.g. "Save settings". The button shows "Saving..." while saving. */
  saveLabel: string;
  /** Whether the viewer holds the permission to save this form.
   *  Defaults true for backwards compatibility with tabs that haven't
   *  threaded the gate through yet. When false the Save button is
   *  hidden and the left-side status text surfaces `readOnlyHint`
   *  instead so the tab reads as read-only at a glance. */
  canEdit?: boolean;
  /** Short hint shown in the footer when `canEdit` is false. */
  readOnlyHint?: string;
}): JSX.Element {
  const shell = useAdminShell();
  return (
    <>
      <span
        className={`min-w-0 truncate text-xs ${
          !canEdit
            ? "italic text-keep-muted"
            : error
              ? "text-keep-accent"
              : savedFlash
                ? "text-keep-system"
                : "text-keep-muted"
        }`}
      >
        {!canEdit
          ? (readOnlyHint ?? "Read-only, you don't have permission to save changes here.")
          : error
            ? error
            : savedFlash
              ? "Saved."
              : lastUpdatedAt
                ? `Last updated ${new Date(lastUpdatedAt).toLocaleString()}`
                : ""}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => shell?.close()}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs hover:bg-keep-banner/60"
        >
          {canEdit ? "Cancel" : "Close"}
        </button>
        {canEdit ? (
          <button
            form={formId}
            type="submit"
            disabled={saving}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-4 py-1 text-xs disabled:opacity-50 hover:bg-keep-banner/80"
          >
            {saving ? "Saving..." : saveLabel}
          </button>
        ) : null}
      </div>
    </>
  );
}

export function AdminPanel({ onClose, onLinksChanged, onOpenServerConsole, onEnterServer }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  // Calm mode: ease each tab's body in with a soft opacity fade instead of an
  // instant snap. Only when Reduce Motion is on do we add the class + `key`
  // (the `key` remounts the wrapper on tab change so the CSS fade replays);
  // when off the wrapper is byte-identical to before — no class, no key.
  const reduceMotion = useReducedMotion();
  // Master-admin gating for the destructive-control tabs. A plain
  // `admin` keeps moderation tools (rooms, users, reports, audit,
  // titles, commands, nav links, affiliates) but loses Settings,
  // Branding, and Rules, the three surfaces that let an attacker
  // materially damage the public face of the site, change caps that
  // affect every user, or rewrite legal/policy text. The two
  // `masterOnly*` references below are also used downstream by
  // UsersTab to hide email / disable / masteradmin-role controls.
  const isMaster = useChat((s) => isMasterAdminRole(s.me?.role ?? "user"));
  // Resolved permission set for the viewer. Drives the
  // `permission`-keyed tab visibility filter in `tabVisible`. Read
  // from the store via the AuthMe payload, refreshes on the /auth/me
  // poll, same as the rest of `me`.
  const mePermissions = useChat((s) => s.me?.permissions ?? []);
  // Multi-Server Lift flag. When ON, several "Content & community" tabs
  // here operate on the HOME server only (their per-server twins live in
  // each server's own console): the Earning admin pins every read/write to
  // DEFAULT_SERVER_ID, the Mod Log filters to platform cases
  // (`server_id IS NULL`), and the Emoticons catalog manages the
  // home/site-scoped sheets (server-stamped sheets are owned per server).
  // The note below makes that scope explicit so staff don't expect a tab
  // to span every server. When the flag is OFF there is only one server,
  // so the note is suppressed and these tabs read exactly as today.
  const serversEnabled = useChat((s) => s.branding.serversEnabled === true);
  // Tabs whose data is home-server-scoped once multi-server is live: Earning
  // (every read/write pinned to DEFAULT_SERVER_ID), Mod Log (platform cases,
  // `server_id IS NULL`), and Emoticons (the home/site catalog; server-stamped
  // sheets are owned per server). Rooms and Audit deliberately stay
  // cross-server site-oversight surfaces; Announcements has a NULL-server
  // (platform-rooms) fan-out scope that isn't cleanly "the home server", so
  // neither is flagged here.
  const HOME_SERVER_SCOPED_TABS: ReadonlySet<Tab> = new Set<Tab>([
    "mod-cases",
  ]);
  // Inline tab-render gate that mirrors `tabVisible` for a single key.
  // Used on the body-render side so a stale `tab` id can't render a
  // panel the user no longer has access to.
  const canSeeTab = (key: PermissionKey) =>
    tabVisible({ permission: key }, isMaster, mePermissions);

  // Per-tab footer slot. Tabs register save/status controls here via
  // `useAdminShell().setFooter(...)` so the previously-empty area
  // below the modal body does useful work. Resets to `null` (default
  // Close-only footer) on tab switch via the tabs' useEffect cleanup.
  const [footerNode, setFooterNode] = useState<ReactNode | null>(null);
  // Memoize the shell API. setFooter from useState is reference-stable
  // across renders, so the object identity only changes when `onClose`
  // changes, which means tabs' useEffects don't re-fire on every
  // render of AdminPanel.
  const shellApi = useMemo<AdminShellAPI>(
    () => ({ setFooter: setFooterNode, close: onClose }),
    [onClose],
  );

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-parchment`}
      >
        {/* Header. On mobile (< md) we collapse the tab strip to a
            full-width <select> dropdown showing the active section,
            with the close button glued to its right edge, earlier
            iterations had a horizontally-scrolling tab strip that
            visually overlapped the close button and made it hard to
            tap. Desktop keeps the scrollable strip since there's room
            for it. Both pickers feed the same `setTab` setter and read
            from the shared TAB_ITEMS array so they can't drift apart. */}
        <div className="shrink-0 border-b border-keep-rule bg-keep-banner">
          {/* Mobile: title + dropdown + close, single row, no scroll.
              The dropdown groups visible tabs into `<optgroup>`s
              keyed on the tab's `group` field so the same five-bucket
              mental model (Monitor / People & access / Content & community
              / Site configuration / System) surfaces on both layouts. */}
          <div className="flex items-center gap-2 px-2 py-2 md:hidden">
            <h2 className="shrink-0 font-action text-base">Admin</h2>
            <select
              value={tab}
              onChange={(e) => setTab(e.target.value as Tab)}
              aria-label="Admin section"
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
            >
              {groupVisibleTabs(TAB_ITEMS.filter((t) => tabVisible(t, isMaster, mePermissions))).map(
                ([group, items]) => (
                  <optgroup key={group} label={TAB_GROUP_LABEL[group]}>
                    {items.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
            <CloseButton onClick={onClose} />
          </div>

          {/* Desktop: title + horizontally-scrollable tab strip + close.
              A hairline vertical separator renders between groups so the
              eye can pick out the five clusters without reading every
              label first. The walk threads the visible-tab list through
              `withGroupSeparators` so a hidden tab (gated out by a
              missing permission) doesn't leave an orphaned divider. */}
          <div className="hidden items-center gap-2 px-4 py-2 md:flex">
            <h2 className="shrink-0 font-action text-lg">Admin</h2>
            {/* `keep-scroll-strip` hides the scrollbar on touch and
                swaps in a thin themed scrollbar on md+ so it never
                underlines the tab labels. */}
            <nav className="keep-scroll-strip flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs uppercase tracking-widest">
              {withGroupSeparators(TAB_ITEMS.filter((t) => tabVisible(t, isMaster, mePermissions))).map(
                (entry) =>
                  entry.kind === "separator" ? (
                    <span
                      key={`sep:${entry.afterGroup}`}
                      aria-hidden
                      className="mx-1 h-4 w-px shrink-0 self-center bg-keep-rule/60"
                      title={TAB_GROUP_LABEL[entry.afterGroup]}
                    />
                  ) : (
                    <TabBtn key={entry.tab.id} active={tab === entry.tab.id} onClick={() => setTab(entry.tab.id)}>
                      {entry.tab.label}
                    </TabBtn>
                  ),
              )}
            </nav>
            <CloseButton onClick={onClose} />
          </div>
        </div>

        {/* Body fills the space between header and footer. `flex-1
            min-h-0` plus inner `overflow-y-auto` keeps the scroll
            confined to this region so the footer below stays
            pinned. `overflow-x-auto` lets wide tables scroll
            horizontally within the body instead of being clipped by
            the frame's `overflow-hidden`. */}
        <AdminShellContext.Provider value={shellApi}>
          <div
            // Calm-mode fade: remount on tab change (key) so `tk-fade-in`
            // replays. Both the key and the class are applied ONLY when
            // Reduce Motion is on, so the off-path render is unchanged.
            {...(reduceMotion ? { key: tab } : {})}
            className={`min-h-0 flex-1 overflow-y-auto overflow-x-auto p-3 sm:p-4${reduceMotion ? " tk-fade-in" : ""}`}
          >
            {/* Home-server scope note. With multi-server ON these tabs manage
                the HOME server only — their per-server twins live in each
                server's own console — so flag a clear scope rather than let
                staff assume a tab spans every server. Suppressed when the
                feature is off (there's only one server then). */}
            {serversEnabled && HOME_SERVER_SCOPED_TABS.has(tab) ? (
              <p className="mb-3 rounded border border-keep-rule bg-keep-panel/40 px-3 py-1.5 text-[11px] text-keep-muted">
                Manages the home server. Each community server keeps its own in its server console.
              </p>
            ) : null}
            {/* Body render gates mirror the tab-strip visibility
                helper so a user with a deep-linked stale tab id
                can't render a panel they don't have access to. */}
            {tab === "overview" ? <OverviewTab /> : null}
            {tab === "settings" && canSeeTab("view_admin_settings") ? <SettingsTab /> : null}
            {tab === "branding" && canSeeTab("view_admin_branding") ? <BrandingTab /> : null}
            {tab === "rules" && canSeeTab("view_admin_rules") ? <RulesTab /> : null}
            {tab === "links" ? <LinksTab onLinksChanged={onLinksChanged} /> : null}
            {tab === "affiliates" ? <AffiliatesTab /> : null}
            {tab === "users" ? <UsersTab /> : null}
            {tab === "reports" ? <ReportsTab /> : null}
            {tab === "mod-cases" && canSeeTab("view_admin_mod_cases") ? <AdminModCasesTab /> : null}
            {tab === "verify-logs" && canSeeTab("verify_export_logs") ? <AdminVerifyLogTab /> : null}
            {tab === "scriptorium" ? <AdminScriptoriumTab /> : null}
            {tab === "forums" && canSeeTab("view_admin_forums") ? <AdminForumsTab /> : null}
            {tab === "servers" && canSeeTab("view_admin_servers") ? <AdminServersTab {...(onOpenServerConsole ? { onOpenConsole: onOpenServerConsole } : {})} {...(onEnterServer ? { onEnterServer } : {})} /> : null}
            {tab === "audit" ? <AuditTab /> : null}
            {tab === "system" && canSeeTab("view_system_metrics") ? <AdminSystemTab /> : null}
            {tab === "backups" && canSeeTab("view_admin_backups") ? <AdminBackupsTab /> : null}
            {tab === "permissions" && canSeeTab("view_admin_permissions") ? <AdminPermissionsTab /> : null}
            {tab === "email" && canSeeTab("view_admin_email") ? <AdminEmailTab /> : null}
          </div>
        </AdminShellContext.Provider>

        {/* Persistent footer. Form tabs (Settings/Branding/Rules)
            register save+status controls here via `setFooter`; other
            tabs fall back to a lone Close button on the right so the
            modal still has anchored chrome instead of dead space. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-keep-rule bg-keep-banner px-3 py-2 sm:px-4">
          {footerNode ?? (
            <>
              <span aria-hidden />
              <button
                type="button"
                onClick={onClose}
                className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs hover:bg-keep-banner/60"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // `shrink-0 whitespace-nowrap` keeps each tab at its intrinsic
      // size inside the scrolling nav, without these, tabs would
      // squish to single letters before the strip would start scrolling.
      className={`shrink-0 whitespace-nowrap rounded border border-keep-rule px-2 py-0.5 ${active ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
    >
      {children}
    </button>
  );
}

/**
 * Shared style-key picker. Reads available styles from the ornaments
 * registry so the catalog stays single-sourced, adding a style file
 * automatically surfaces it here without UI changes.
 *
 * Caller controls value semantics:
 *  - Admin: required, defaults to "medieval"
 *  - Profile: nullable; null means "follow site default", represented
 *    by the empty-string sentinel in the <select>.
 */
export function StylePicker({
  value,
  onChange,
  allowInherit = false,
}: {
  value: string | null;
  onChange: (key: string | null) => void;
  /** When true, prepend a "(use site default)" option whose value is null. */
  allowInherit?: boolean;
}) {
  const styles = listStyles();
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
    >
      {allowInherit ? (
        <option value="">(use site default)</option>
      ) : null}
      {styles.map((s) => (
        <option key={s.key} value={s.key}>{s.label}</option>
      ))}
    </select>
  );
}

/* =============================================================
 * NAV LINKS TAB
 * ============================================================= */

interface NavLinkRow {
  id: string;
  label: string;
  href: string;
  target: "_self" | "_blank";
  position: number;
  enabled: boolean;
}

interface NavLinkInput {
  label: string;
  href: string;
  position?: number;
  enabled?: boolean;
  target?: "_self" | "_blank";
}

/* =============================================================
 * SETTINGS TAB
 * ============================================================= */

interface SettingsRow {
  messageRetentionMs: number;
  sessionTtlMs: number;
  idleGraceMs: number;
  defaultThemeJson: string | null;
  defaultTheme: Theme;
  siteName: string;
  /** Canonical site URL the banner logo links to. Empty = no wrapping. */
  siteUrl: string;
  bannerCoverCss: string | null;
  logoColor: string | null;
  logoFont: string | null;
  /** Banner/splash logo URL. Empty string = no logo. */
  logoUrl: string;
  maxCharactersPerUser: number;
  maxAccountsPerEmail: number;
  maxRoomsPerOwner: number;
  maxMessageLength: number;
  maxDirectMessageLength: number;
  maxForumPostLength: number;
  maxForumTopicTitleLength: number;
  forumTopicsPerPage: number;
  /** Author edit/delete grace window in ms for chat + DM messages. */
  editGraceMs: number;
  maxBioLength: number;
  registrationOpen: boolean;
  welcomeHtml: string;
  rulesHtml: string;
  securityNoticeHtml: string;
  registerDisclaimerHtml: string;
  serverRegistrationRulesHtml: string;
  forumRegistrationRulesHtml: string;
  metaDescription: string;
  customHeadHtml: string;
  activityFeedsEnabled: boolean;
  featuredWorldsEnabled: boolean;
  splashMessages24hEnabled: boolean;
  profileDesignerEnabled: boolean;
  serversEnabled: boolean;
  /** Sanitized HTML for the post-login welcome modal. "" = no welcome shown. */
  newUserWelcomeHtml: string;
  /** Site-wide default theme style key. Users without an override inherit this. */
  defaultStyleKey: string;
  /**
   * Per-preset design map (`{ "Parchment": "medieval", "Twilight":
   * "scifi", ... }`). Pins a default design to each named palette so
   * users picking a preset get a coherent paired look without having
   * to pick the design themselves. Resolution chain documented in
   * App.tsx's apply effect.
   */
  themeDesignMap: Record<string, string>;
  updatedAt: number;
}

/**
 * Format ms as the most natural unit for display ("30d", "2h", "5m").
 * 0 means "forever / disabled" depending on context.
 */
function formatMs(ms: number): string {
  if (ms === 0) return "0";
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Inverse of formatMs. Accepts "5m", "1h20m", "30d", or a bare number = ms. */
function parseDurationMs(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "0") return 0;
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  let total = 0;
  let any = false;
  const re = /(\d+)\s*([smhd])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    any = true;
    const n = parseInt(m[1] ?? "0", 10);
    const unit = (m[2] ?? "").toLowerCase();
    const ms = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
    total += n * ms;
  }
  return any ? total : null;
}

/* =============================================================
 * OVERVIEW TAB
 * =============================================================
 *
 * Admin dashboard. Polls /admin/overview every 30s and renders a card
 * grid of headline counters plus a 7-day daily-series block covering
 * messages, topics, logins, and registrations. Distinct from the public
 * /stats endpoint, this one carries DAU/WAU/MAU, moderation volume,
 * and per-day login/registration counts that aren't appropriate for
 * the anonymous splash view.
 */

interface OverviewDayPoint {
  day: string;
  count: number;
}

interface AdminOverviewRecentReg {
  userId: string;
  username: string;
  role: Role;
  createdAt: number;
  lastLoginAt: number | null;
}

interface AdminOverview {
  online: number;
  users: {
    total: number;
    newLast7d: number;
    newLast30d: number;
    dau: number;
    wau: number;
    mau: number;
    recentRegistrations: AdminOverviewRecentReg[];
  };
  rooms: { public: number; private: number; total: number };
  messages: { last24h: number; last7d: number; last30d: number };
  forum: { topics: number; replies: number; topicsLast7d: number; repliesLast7d: number };
  content: { characters: number; worlds: number };
  moderation: { reportsLast7d: number; auditLast7d: number };
  series: {
    messages: OverviewDayPoint[];
    topics: OverviewDayPoint[];
    logins: OverviewDayPoint[];
    registrations: OverviewDayPoint[];
  };
}

function OverviewTab() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Pass the viewer's timezone offset so the server's day-bucket
        // SQL aligns with the panel's local-time grouping. Without
        // this the two widgets disagreed on which side of midnight a
        // signup belonged to. `getTimezoneOffset` returns minutes
        // west of UTC (positive for the Americas, negative for Asia).
        const tzOffsetMin = new Date().getTimezoneOffset();
        const r = await fetch(`/admin/overview?tzOffsetMin=${tzOffsetMin}`, { credentials: "include" });
        if (!r.ok) throw new Error(await readError(r));
        const j = (await r.json()) as AdminOverview;
        if (!cancelled) { setData(j); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
      }
    }
    load();
    const id = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  if (!data) {
    return <div className="text-keep-muted text-xs">{error ?? "loading..."}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-keep-muted">
        Live snapshot of activity across the site. Auto-refreshes every 30 seconds.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <OverviewCard title="Online now" hint="Connected sockets, deduped per user.">
          <BigStat value={data.online} accent={data.online > 0} />
        </OverviewCard>

        <OverviewCard title="Registered users" hint="Total accounts, excluding the system sentinel.">
          <BigStat value={data.users.total} />
          <SubStats items={[
            { label: "new 7d", value: data.users.newLast7d },
            { label: "new 30d", value: data.users.newLast30d },
          ]} />
        </OverviewCard>

        <OverviewCard title="Active users" hint="Distinct logins inside each window. Older buckets undercount if session TTL is shorter than the window.">
          <SubStats items={[
            { label: "DAU", value: data.users.dau },
            { label: "WAU", value: data.users.wau },
            { label: "MAU", value: data.users.mau },
          ]} />
        </OverviewCard>

        <OverviewCard title="Rooms" hint="Public chambers + private rooms.">
          <BigStat value={data.rooms.total} />
          <SubStats items={[
            { label: "public", value: data.rooms.public },
            { label: "private", value: data.rooms.private },
          ]} />
        </OverviewCard>

        <OverviewCard title="Chat messages" hint="Chat volume, excludes presence/system rows and soft-deleted messages.">
          <SubStats items={[
            { label: "24h", value: data.messages.last24h },
            { label: "7d", value: data.messages.last7d },
            { label: "30d", value: data.messages.last30d },
          ]} />
        </OverviewCard>

        <OverviewCard title="Forum activity" hint="Topics and replies across all nested-mode rooms.">
          <SubStats items={[
            { label: "topics", value: data.forum.topics },
            { label: "replies", value: data.forum.replies },
            { label: "topics 7d", value: data.forum.topicsLast7d },
            { label: "replies 7d", value: data.forum.repliesLast7d },
          ]} />
        </OverviewCard>

        <OverviewCard title="Content" hint="User-authored material across the site.">
          <SubStats items={[
            { label: "characters", value: data.content.characters },
            { label: "worlds", value: data.content.worlds },
          ]} />
        </OverviewCard>

        <OverviewCard title="Moderation (7d)" hint="Reports filed and audit-log actions in the last week.">
          <SubStats items={[
            { label: "reports", value: data.moderation.reportsLast7d },
            { label: "audit", value: data.moderation.auditLast7d },
          ]} />
        </OverviewCard>
      </div>

      <RecentRegistrationsPanel rows={data.users.recentRegistrations} />

      <fieldset className="rounded border border-keep-rule p-3">
        <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">This week</legend>
        <div className="space-y-2">
          <SparklineRow label="Messages" series={data.series.messages} colorClass="bg-keep-action/70" />
          <SparklineRow label="Topics" series={data.series.topics} colorClass="bg-keep-accent/70" />
          <SparklineRow label="Logins" series={data.series.logins} colorClass="bg-keep-action/70" />
          <SparklineRow label="Registrations" series={data.series.registrations} colorClass="bg-keep-accent/70" />
          <SparklineAxis days={data.series.messages.map((d) => d.day)} />
        </div>
      </fieldset>

      {error ? <div className="text-xs text-keep-accent">{error}</div> : null}
    </div>
  );
}

function OverviewCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded border border-keep-rule p-3" title={hint}>
      <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">{title}</legend>
      <div className="space-y-2">{children}</div>
    </fieldset>
  );
}

/**
 * Per-day buckets of the last 5 days of registrations. Newest day first,
 * empty days included so the panel always shows the rolling window
 * (an empty day is a useful signal too). Grouped by date in the
 * viewer's local time zone, registration timestamps are absolute, but
 * "did anyone sign up yesterday" reads in local time.
 */
function RecentRegistrationsPanel({ rows }: { rows: AdminOverviewRecentReg[] }) {
  const dayKeys: { key: string; label: string; date: Date }[] = [];
  const now = new Date();
  for (let i = 0; i < 5; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    dayKeys.push({ key, label, date: d });
  }
  const buckets = new Map<string, AdminOverviewRecentReg[]>();
  for (const { key } of dayKeys) buckets.set(key, []);
  for (const u of rows) {
    const d = new Date(u.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (buckets.has(key)) buckets.get(key)!.push(u);
  }
  const total = rows.length;

  return (
    <fieldset className="rounded border border-keep-rule p-3">
      <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
        Recent registrations · last 5 days · {total} {total === 1 ? "account" : "accounts"}
      </legend>
      {total === 0 ? (
        <p className="text-xs text-keep-muted">No new accounts in the last 5 days.</p>
      ) : (
        <div className="space-y-2">
          {dayKeys.map(({ key, label }) => {
            const dayRows = buckets.get(key) ?? [];
            return (
              <div key={key}>
                <div className="flex items-baseline gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
                  <span className="font-semibold text-keep-text/80">{label}</span>
                  <span className="tabular-nums">{dayRows.length} {dayRows.length === 1 ? "signup" : "signups"}</span>
                </div>
                {dayRows.length === 0 ? (
                  <div className="text-xs text-keep-muted/60 italic">-</div>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {dayRows.map((u) => {
                      const time = new Date(u.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
                      const neverLoggedIn = u.lastLoginAt == null;
                      const roleTag = u.role !== "user" ? u.role : null;
                      return (
                        <span
                          key={u.userId}
                          className="inline-flex items-center gap-1 rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-xs"
                          title={`Registered ${new Date(u.createdAt).toLocaleString()}${u.lastLoginAt ? `\nLast login: ${new Date(u.lastLoginAt).toLocaleString()}` : "\nHasn't logged in since"}`}
                        >
                          <span className="font-semibold">{u.username}</span>
                          {roleTag ? (
                            <span className="rounded bg-keep-accent/20 px-1 text-[9px] uppercase tracking-widest text-keep-accent">
                              {roleTag === "masteradmin" ? "master" : roleTag}
                            </span>
                          ) : null}
                          {neverLoggedIn ? (
                            <span className="text-[10px] text-keep-muted">· never logged in</span>
                          ) : null}
                          <span className="text-[10px] text-keep-muted/70 tabular-nums">· {time}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function BigStat({ value, accent }: { value: number; accent?: boolean }) {
  return (
    <div className={`text-2xl font-semibold tabular-nums ${accent ? "text-keep-action" : "text-keep-text"}`}>
      {value.toLocaleString()}
    </div>
  );
}

function SubStats({ items }: { items: { label: string; value: number }[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5">
          <span className="font-semibold tabular-nums text-keep-text">{it.value.toLocaleString()}</span>
          <span className="text-keep-muted">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * One labeled sparkline row in the "This week" panel. The plot area is a
 * fixed-height (`h-8`) box so every row occupies the same vertical extent
 * regardless of its peak, otherwise quiet rows shrink and busy rows grow
 * and the panel gets a ragged baseline. Per-day date labels live once at
 * the bottom in `SparklineAxis` rather than under every row.
 */
function SparklineRow({ label, series, colorClass }: { label: string; series: OverviewDayPoint[]; colorClass: string }) {
  if (series.length === 0) return null;
  const max = Math.max(1, ...series.map((d) => d.count));
  const total = series.reduce((s, d) => s + d.count, 0);
  return (
    <div
      className="grid items-center gap-2 text-xs sm:grid-cols-[110px_1fr_64px]"
      title={`${total.toLocaleString()} this week`}
    >
      <span className="uppercase tracking-widest text-keep-muted">{label}</span>
      <div className="flex h-8 items-end gap-1">
        {series.map((d) => {
          // Floor each bar at 2px so a zero-day still reads as a visible
          // "no traffic" baseline instead of vanishing into the row.
          const h = Math.max(2, Math.round((d.count / max) * 28));
          return (
            <div
              key={d.day}
              className="flex flex-1 items-end"
              title={`${d.day}: ${d.count.toLocaleString()}`}
            >
              <div className={`${colorClass} w-full rounded-sm`} style={{ height: `${h}px` }} />
            </div>
          );
        })}
      </div>
      <span className="text-right font-semibold tabular-nums text-keep-text">
        {total.toLocaleString()}
      </span>
    </div>
  );
}

function SparklineAxis({ days }: { days: string[] }) {
  return (
    <div className="grid gap-2 text-[9px] sm:grid-cols-[110px_1fr_64px]">
      <span aria-hidden />
      <div className="flex gap-1">
        {days.map((d) => (
          <span key={d} className="flex-1 text-center tabular-nums text-keep-muted">
            {d.slice(5)}
          </span>
        ))}
      </div>
      <span aria-hidden />
    </div>
  );
}

function SettingsTab() {
  const setBranding = useChat((s) => s.setBranding);
  // Edit permission gates the Save button. A delegate granted only
  // `view_admin_settings` reads the form but can't submit changes,
  // the server's PUT /admin/settings would 403 anyway, but hiding
  // Save up front spares the user the wasted round-trip.
  const canEditSiteSettings = useChat((s) => s.me?.permissions.includes("edit_site_settings") ?? false);
  const [data, setData] = useState<SettingsRow | null>(null);
  const [retention, setRetention] = useState("");
  const [sessionTtl, setSessionTtl] = useState("");
  const [idleGrace, setIdleGrace] = useState("");
  const [theme, setTheme] = useState<Theme | null>(null);
  const [maxChars, setMaxChars] = useState("");
  const [maxEmail, setMaxEmail] = useState("");
  const [maxRooms, setMaxRooms] = useState("");
  const [maxMsgLen, setMaxMsgLen] = useState("");
  const [maxDmLen, setMaxDmLen] = useState("");
  const [maxForumLen, setMaxForumLen] = useState("");
  const [maxForumTitleLen, setMaxForumTitleLen] = useState("");
  const [forumTopicsPerPage, setForumTopicsPerPage] = useState("");
  // Edit-grace window stored as a duration string (e.g. "5m", "30s",
  // "1h") so admins can pick the right unit for the room's pace.
  // Persisted as ms via parseDurationMs. "0" disables editing entirely
  // (still leaves mods/admins able to delete via moderation tools).
  const [editGrace, setEditGrace] = useState("");
  const [maxBioLen, setMaxBioLen] = useState("");
  const [regOpen, setRegOpen] = useState(true);
  const [activityFeedsEnabled, setActivityFeedsEnabled] = useState(false);
  const [featuredWorldsEnabled, setFeaturedWorldsEnabled] = useState(false);
  const [splashMessages24hEnabled, setSplashMessages24hEnabled] = useState(false);
  const [profileDesignerEnabled, setProfileDesignerEnabled] = useState(false);
  const [serversEnabled, setServersEnabled] = useState(false);
  const [defaultStyleKey, setDefaultStyleKey] = useState<string>("medieval");
  // Per-preset design pinning. Keyed by THEME_PRESETS name. Empty
  // entry on a preset means "fall through to defaultStyleKey for
  // that palette." Edited in the Theme designs section below.
  const [themeDesignMap, setThemeDesignMap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/settings", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      setRetention(formatMs(j.messageRetentionMs));
      setSessionTtl(formatMs(j.sessionTtlMs));
      setIdleGrace(formatMs(j.idleGraceMs));
      setTheme(j.defaultThemeJson ? normalizeTheme(JSON.parse(j.defaultThemeJson)) : null);
      setMaxChars(String(j.maxCharactersPerUser));
      setMaxEmail(String(j.maxAccountsPerEmail));
      setMaxRooms(String(j.maxRoomsPerOwner));
      setMaxMsgLen(String(j.maxMessageLength));
      setMaxDmLen(String(j.maxDirectMessageLength));
      setMaxForumLen(String(j.maxForumPostLength));
      setMaxForumTitleLen(String(j.maxForumTopicTitleLength));
      setForumTopicsPerPage(String(j.forumTopicsPerPage));
      setEditGrace(formatMs(j.editGraceMs));
      setMaxBioLen(String(j.maxBioLength));
      setRegOpen(j.registrationOpen);
      setActivityFeedsEnabled(j.activityFeedsEnabled);
      setFeaturedWorldsEnabled(j.featuredWorldsEnabled);
      setSplashMessages24hEnabled(j.splashMessages24hEnabled);
      setProfileDesignerEnabled(j.profileDesignerEnabled);
      setServersEnabled(j.serversEnabled);
      setDefaultStyleKey(j.defaultStyleKey || "medieval");
      setThemeDesignMap(j.themeDesignMap ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }
  useEffect(() => { load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const retentionMs = parseDurationMs(retention);
      const ttlMs = parseDurationMs(sessionTtl);
      const idleGraceMs = parseDurationMs(idleGrace);
      const editGraceMs = parseDurationMs(editGrace);
      if (retentionMs === null) throw new Error("retention must be a duration like 30d (or 0 for never)");
      if (ttlMs === null || ttlMs < 5 * 60 * 1000) throw new Error("session TTL must be at least 5m");
      if (idleGraceMs === null || idleGraceMs < 30 * 1000) throw new Error("idle grace must be at least 30s");
      if (idleGraceMs > 24 * 60 * 60 * 1000) throw new Error("idle grace must be 24h or less");
      if (editGraceMs === null) throw new Error("edit window must be a duration like 5m (or 0 to disable edits)");
      // Server caps at 7d; same here so the input error is friendlier
      // than an opaque 400 from the route.
      if (editGraceMs > 7 * 24 * 60 * 60 * 1000) throw new Error("edit window must be 7 days or less");
      const intOrThrow = (label: string, raw: string, min: number, max: number): number => {
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n < min || n > max) {
          throw new Error(`${label} must be an integer ${min}-${max}`);
        }
        return n;
      };
      const body: Record<string, unknown> = {
        messageRetentionMs: retentionMs,
        sessionTtlMs: ttlMs,
        idleGraceMs,
        maxCharactersPerUser: intOrThrow("Max characters/user", maxChars, 1, 1000),
        maxAccountsPerEmail: intOrThrow("Max accounts/email", maxEmail, 1, 50),
        maxRoomsPerOwner: intOrThrow("Max rooms/owner", maxRooms, 0, 1000),
        maxMessageLength: intOrThrow("Max chat message length", maxMsgLen, 100, 50_000),
        maxDirectMessageLength: intOrThrow("Max DM length", maxDmLen, 100, 50_000),
        maxForumPostLength: intOrThrow("Max forum post length", maxForumLen, 100, 50_000),
        maxForumTopicTitleLength: intOrThrow("Max forum topic title length", maxForumTitleLen, 10, 500),
        forumTopicsPerPage: intOrThrow("Forum topics per page", forumTopicsPerPage, 5, 100),
        editGraceMs,
        maxBioLength: intOrThrow("Max bio length", maxBioLen, 1000, 200_000),
        registrationOpen: regOpen,
        activityFeedsEnabled,
        featuredWorldsEnabled,
        splashMessages24hEnabled,
        profileDesignerEnabled,
        serversEnabled,
        defaultStyleKey,
        themeDesignMap,
      };
      // Send theme only when admin actually changed it from the loaded value.
      if (theme === null && data?.defaultThemeJson) body.defaultTheme = null;
      else if (theme !== null) body.defaultTheme = theme;

      const r = await fetch("/admin/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      // Push the branding-relevant fields into the store so the splash
      // theme updates immediately if the admin changed defaultTheme or
      // toggled registration. The Settings tab can change defaultTheme,
      // which the splash uses to scope its palette.
      setBranding({
        siteName: j.siteName,
        siteUrl: j.siteUrl ?? "",
        bannerCoverCss: j.bannerCoverCss,
        logoColor: j.logoColor,
        logoFont: j.logoFont,
        logoUrl: j.logoUrl,
        registrationOpen: j.registrationOpen,
        welcomeHtml: j.welcomeHtml,
        registerDisclaimerHtml: j.registerDisclaimerHtml,
        messageRetentionMs: j.messageRetentionMs,
        sessionTtlMs: j.sessionTtlMs,
        editGraceMs: j.editGraceMs,
        defaultTheme: j.defaultTheme,
        activityFeedsEnabled: j.activityFeedsEnabled,
        featuredWorldsEnabled: j.featuredWorldsEnabled,
        splashMessages24hEnabled: j.splashMessages24hEnabled,
        profileDesignerEnabled: j.profileDesignerEnabled,
        serversEnabled: j.serversEnabled,
        defaultStyleKey: j.defaultStyleKey,
        themeDesignMap: j.themeDesignMap ?? {},
        // Null = admin hasn't set an explicit override → splash falls
        // back to prefers-color-scheme + cached last-active theme.
        defaultThemeJson: j.defaultThemeJson ?? null,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  // Project save controls into the modal footer so the previously-
  // empty area below the body becomes anchored chrome. The footer
  // renders our Save (which submits this form via the HTML5 `form`
  // attribute → see the `id` on `<form>` below) + Cancel + status.
  // Cleanup on unmount drops back to the default Close-only footer
  // when the user switches tabs.
  const shell = useAdminShell();
  useEffect(() => {
    if (!shell) return;
    shell.setFooter(
      <AdminSaveFooter
        formId="admin-settings-form"
        saving={saving}
        savedFlash={savedFlash}
        lastUpdatedAt={data?.updatedAt ?? null}
        error={error}
        saveLabel="Save settings"
        canEdit={canEditSiteSettings}
        readOnlyHint="Read-only, needs edit_site_settings to save."
      />,
    );
    return () => shell.setFooter(null);
  }, [shell, saving, savedFlash, error, data?.updatedAt, canEditSiteSettings]);

  if (!data) {
    return <div className="text-keep-muted text-xs">{error ?? "loading..."}</div>;
  }

  return (
    <form id="admin-settings-form" onSubmit={save} className="space-y-4">
      <p className="text-xs text-keep-muted">
        Sitewide configuration. Changes apply immediately for new sessions and the next hourly retention sweep.
      </p>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Message retention</legend>
        <div className="flex items-baseline gap-2">
          <input
            type="text"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            placeholder="30d, 90d, 0 = forever"
            className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <span className="text-keep-muted">
            Messages older than this are purged hourly. <code>0</code> retains forever.
          </span>
        </div>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Idle timeout</legend>
        <div className="flex items-baseline gap-2">
          <input
            type="text"
            value={sessionTtl}
            onChange={(e) => setSessionTtl(e.target.value)}
            placeholder="30m, 1h, 1d"
            className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <span className="text-keep-muted">
            How long a user can be idle before they get bounced back to the login splash. Sliding: any keypress, mousemove, message, or room switch resets the clock. Min 5m.
          </span>
        </div>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Idle ghost lifetime</legend>
        <div className="flex items-baseline gap-2">
          <input
            type="text"
            value={idleGrace}
            onChange={(e) => setIdleGrace(e.target.value)}
            placeholder="30m, 1h"
            className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <span className="text-keep-muted">
            When someone closes their tab or refreshes, they stay in the userlist faded out as "(idle)" for this long instead of vanishing. Inside the window, no connect/disconnect chat lines fire. The room they were in is also held open against archival. Min 30s, max 24h.
          </span>
        </div>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Limits & capacity</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <LimitField
            label="Max characters / user"
            hint="Per-account ceiling on character profiles."
            value={maxChars}
            onChange={setMaxChars}
            min={1}
            max={1000}
          />
          <LimitField
            label="Max accounts / email"
            hint="1 = traditional. Raise to allow shared/family accounts."
            value={maxEmail}
            onChange={setMaxEmail}
            min={1}
            max={50}
          />
          <LimitField
            label="Max rooms / owner"
            hint="Cap on user-created rooms a single user may own. 0 disables user-created rooms."
            value={maxRooms}
            onChange={setMaxRooms}
            min={0}
            max={1000}
          />
          <LimitField
            label="Max chat message length"
            hint="Hard cap on flat-chat body length (chars)."
            value={maxMsgLen}
            onChange={setMaxMsgLen}
            min={100}
            max={50_000}
          />
          <LimitField
            label="Max direct message length"
            hint="Hard cap on DM body length (chars). Independent from chat so private long-form conversations can have more room."
            value={maxDmLen}
            onChange={setMaxDmLen}
            min={100}
            max={50_000}
          />
          <LimitField
            label="Max forum post length"
            hint="Hard cap on forum topic + reply body length (chars) in nested rooms. Typically larger than chat to allow long-form posts."
            value={maxForumLen}
            onChange={setMaxForumLen}
            min={100}
            max={50_000}
          />
          <LimitField
            label="Max forum topic title length"
            hint="Hard cap on a forum topic title (chars). Kept short so titles stay list-renderable in the topic picker."
            value={maxForumTitleLen}
            onChange={setMaxForumTitleLen}
            min={10}
            max={500}
          />
          <LimitField
            label="Forum topics per page"
            hint="How many non-sticky topics appear on each page of a forum category's numbered pagination strip. Stickies stay on page 1 only and don't count against this. Default 20."
            value={forumTopicsPerPage}
            onChange={setForumTopicsPerPage}
            min={5}
            max={100}
          />
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">
              Edit / delete window
            </span>
            <input
              type="text"
              value={editGrace}
              onChange={(e) => setEditGrace(e.target.value)}
              placeholder="5m"
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
            />
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              How long after sending an author can edit / delete their own chat or DM message. Duration like 30s / 5m / 1h. 0 disables author edits entirely. Mods + admins always bypass this; forum posts are exempt and stay editable indefinitely.
            </span>
          </label>
          <LimitField
            label="Max bio length"
            hint="Hard cap on profile bio HTML (chars)."
            value={maxBioLen}
            onChange={setMaxBioLen}
            min={1000}
            max={200_000}
          />
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Registration</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={regOpen}
                onChange={(e) => setRegOpen(e.target.checked)}
              />
              <span>{regOpen ? "Open - anyone can register" : "Closed - login only"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              When closed, /auth/register returns 503 and the login screen hides the Register tab.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Activity feeds</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={activityFeedsEnabled}
                onChange={(e) => setActivityFeedsEnabled(e.target.checked)}
              />
              <span>{activityFeedsEnabled ? "On - splash shows live counters" : "Off - cold-start posture"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              When off, the splash hides the "X users online" / room counters so an empty community doesn't telegraph "dead site" to first visitors. Flip on once there's a real pulse to surface.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Messages in last 24h</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={splashMessages24hEnabled}
                onChange={(e) => setSplashMessages24hEnabled(e.target.checked)}
              />
              <span>{splashMessages24hEnabled ? "On - splash shows rolling 24h message count" : "Off - splash hides the 24h message stat"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Surfaces a rolling 24h chat-message count on the splash. Independent of Activity feeds, flip it on alone to show the message volume by itself, or pair with Activity feeds so it sits in the same row as the online/registered/room counters.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Featured worlds carousel</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={featuredWorldsEnabled}
                onChange={(e) => setFeaturedWorldsEnabled(e.target.checked)}
              />
              <span>{featuredWorldsEnabled ? "On - splash rotates open worlds" : "Off - splash hides the carousel"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Splash page picks up to 10 random open worlds and rotates them as a "settings you can play in" strip. Off by default; the seeded defaults plus any community open worlds will fill the rotation once enabled.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Profile bio Designer</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={profileDesignerEnabled}
                onChange={(e) => setProfileDesignerEnabled(e.target.checked)}
              />
              <span>{profileDesignerEnabled ? "On - bio tab offers a visual Designer (desktop)" : "Off - bio editor is raw HTML source only"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Adds a visual drag-and-drop Designer alongside the raw-HTML Source on the profile bio tab (desktop only). Off by default. Try it on your own profile before enabling site-wide; the Source view remains available either way.
            </span>
          </label>
          <label className="text-xs">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Multi-server</span>
            <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
              <input
                type="checkbox"
                checked={serversEnabled}
                onChange={(e) => setServersEnabled(e.target.checked)}
              />
              <span>{serversEnabled ? "On - server rail + join/create your own servers" : "Off - single-server chat (today's experience)"}</span>
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Master switch for the multi-server feature: the round server-icon rail beside the userlist, the discover/create-a-server flow, and all per-server scoping. Off keeps the chat exactly as a single server. The SERVERS_KILL env var overrides this to off.
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Default theme</legend>
        <p className="mb-2 text-keep-muted">
          Used when a user has no custom theme and no active character with a theme.
          Cleared (no override) means the built-in Parchment palette.
        </p>
        <ThemePicker
          theme={theme ?? DEFAULT_THEME}
          onChange={setTheme}
          onReset={() => setTheme(null)}
        />
        {!theme ? (
          <div className="mt-1 italic text-keep-muted">No site default - using built-in Parchment.</div>
        ) : null}
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Theme style</legend>
        <p className="mb-2 text-keep-muted">
          The fallback visual treatment (ornaments, borders, textures) for
          palettes that don't have a design pinned below. Orthogonal to
          the palette, picking a style doesn't change which colors are
          used, just how they're rendered. Users can override this on
          their master or character profile.
        </p>
        <StylePicker
          value={defaultStyleKey}
          // Admin requires a non-null value; if the user manages to
          // pick "(use site default)" (only shown with allowInherit)
          // fall through to the launch flagship.
          onChange={(k) => setDefaultStyleKey(k ?? "medieval")}
        />
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Designs by theme</legend>
        <p className="mb-2 text-keep-muted">
          Pin a design to each named palette. When a user (or character)
          picks one of these themes, they get the paired design unless
          they've explicitly overridden it on their profile. "Use site
          default" means that theme falls through to the Theme style
          above. Custom palettes (anything not matching one of these
          presets) always fall through.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {THEME_PRESETS.map((p) => (
            <label key={p.name} className="flex items-center gap-2">
              <span
                aria-hidden
                title={`Preview of ${p.name}'s palette`}
                className="flex shrink-0 rounded border"
                style={{ borderColor: p.theme.border }}
              >
                {(["panel", "action", "accent"] as const).map((slot) => (
                  <span
                    key={slot}
                    className="inline-block h-4 w-4"
                    style={{ backgroundColor: p.theme[slot] }}
                  />
                ))}
              </span>
              <span className="min-w-[6rem] truncate font-semibold">{p.name}</span>
              <StylePicker
                value={themeDesignMap[p.name] ?? null}
                allowInherit
                onChange={(k) => {
                  setThemeDesignMap((prev) => {
                    const next = { ...prev };
                    if (k === null) delete next[p.name];
                    else next[p.name] = k;
                    return next;
                  });
                }}
              />
            </label>
          ))}
        </div>
      </fieldset>

      {/* Save controls + status (incl. error) live in the modal
          footer via `useAdminShell().setFooter(...)` near the top of
          this component. No inline save row, keeps the form
          scrolling area focused on field editing. */}
    </form>
  );
}

/* =============================================================
 * BRANDING TAB
 * =============================================================
 *
 * Site name, banner cover CSS, logo color, logo font. Reads/writes
 * /admin/settings (the same row that the Settings tab edits) but only
 * touches the branding-related fields. Saves push the updated branding
 * directly into the zustand store so the banner reflects changes
 * immediately without waiting for a /site refetch.
 */

interface BrandingDraft {
  siteName: string;
  /** Optional canonical site URL the banner logo links to. Empty = no
   *  wrapping (logo renders bare). When set, banner adds an unstyled
   *  `<a>` around the logo. */
  siteUrl: string;
  bannerCoverCss: string;
  logoColor: string;
  logoFont: string;
  /** Logo URL. Empty string = no logo image, banner falls back to the text title. */
  logoUrl: string;
  welcomeHtml: string;
  metaDescription: string;
  customHeadHtml: string;
}

function BrandingTab() {
  const setBranding = useChat((s) => s.setBranding);
  // Edit gate. Branding submits through PUT /admin/settings, which
  // now does per-field gating: a patch that only touches branding
  // fields (site name, logos, banner CSS, welcome HTML, theme-design
  // map, …) requires `edit_branding`. So we hold the form open for
  // anyone with EITHER edit_branding OR the broader edit_site_settings
  //, both let the patch through, and the server is the source of
  // truth on what counts as "branding-only."
  //
  // The Upload-logo affordance below is independently gated on
  // `upload_logo` because the server pins that to a separate route.
  const canEditSiteSettings = useChat(
    (s) => (s.me?.permissions.includes("edit_branding") ?? false)
      || (s.me?.permissions.includes("edit_site_settings") ?? false),
  );
  const canUploadLogo = useChat((s) => s.me?.permissions.includes("upload_logo") ?? false);
  const [data, setData] = useState<SettingsRow | null>(null);
  const [draft, setDraft] = useState<BrandingDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/settings", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      setDraft({
        siteName: j.siteName,
        siteUrl: j.siteUrl ?? "",
        bannerCoverCss: j.bannerCoverCss ?? "",
        logoColor: j.logoColor ?? "",
        logoFont: j.logoFont ?? "",
        logoUrl: j.logoUrl ?? "",
        welcomeHtml: j.welcomeHtml ?? "",
        metaDescription: j.metaDescription ?? "",
        customHeadHtml: j.customHeadHtml ?? "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }
  useEffect(() => { load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        siteName: draft.siteName,
        // Empty string clears the link wrapping; trim runs before
        // the server's URL-shape validation so a stray newline can't
        // sneak past.
        siteUrl: draft.siteUrl.trim(),
        // Empty strings clear the override (sent as null).
        bannerCoverCss: draft.bannerCoverCss.trim() === "" ? null : draft.bannerCoverCss.trim(),
        logoColor: draft.logoColor.trim() === "" ? null : draft.logoColor.trim(),
        logoFont: draft.logoFont.trim() === "" ? null : draft.logoFont.trim(),
        // Logo URL is stored verbatim. Empty string is the explicit
        // "no logo, show text" clear; non-empty stays as the path /
        // URL the banner uses for <img src>.
        logoUrl: draft.logoUrl.trim(),
        // welcomeHtml is sanitized server-side; empty stays empty (no rendering).
        welcomeHtml: draft.welcomeHtml,
        // metaDescription is plain text; server collapses internal whitespace.
        metaDescription: draft.metaDescription,
        // customHeadHtml is admin-trusted raw HTML (analytics scripts) - the
        // server stores it verbatim without sanitization.
        customHeadHtml: draft.customHeadHtml,
      };
      if (body.logoColor && !/^#[0-9a-fA-F]{6}$/.test(body.logoColor as string)) {
        throw new Error("Logo color must be a 6-digit hex like #2c5d2c (or empty to clear).");
      }
      const r = await fetch("/admin/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      // Push directly into the store so Banner/AuthGate/BootSplash see it
      // without waiting for the next /site fetch on reload.
      setBranding({
        siteName: j.siteName,
        siteUrl: j.siteUrl ?? "",
        bannerCoverCss: j.bannerCoverCss,
        logoColor: j.logoColor,
        logoFont: j.logoFont,
        logoUrl: j.logoUrl,
        registrationOpen: j.registrationOpen,
        welcomeHtml: j.welcomeHtml,
        registerDisclaimerHtml: j.registerDisclaimerHtml,
        messageRetentionMs: j.messageRetentionMs,
        sessionTtlMs: j.sessionTtlMs,
        editGraceMs: j.editGraceMs,
        defaultTheme: j.defaultTheme,
        activityFeedsEnabled: j.activityFeedsEnabled,
        featuredWorldsEnabled: j.featuredWorldsEnabled,
        splashMessages24hEnabled: j.splashMessages24hEnabled,
        profileDesignerEnabled: j.profileDesignerEnabled,
        serversEnabled: j.serversEnabled,
        defaultStyleKey: j.defaultStyleKey,
        themeDesignMap: j.themeDesignMap ?? {},
        // Null = admin hasn't set an explicit override → splash falls
        // back to prefers-color-scheme + cached last-active theme.
        defaultThemeJson: j.defaultThemeJson ?? null,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  // Project save controls into the modal footer. Same pattern as
  // SettingsTab, the inline save row used to sit at the bottom of
  // the scrolling form; now it's anchored in the persistent footer
  // so it's always reachable and the modal's bottom chrome isn't
  // empty space.
  const shell = useAdminShell();
  useEffect(() => {
    if (!shell) return;
    shell.setFooter(
      <AdminSaveFooter
        formId="admin-branding-form"
        saving={saving}
        savedFlash={savedFlash}
        lastUpdatedAt={data?.updatedAt ?? null}
        error={error}
        saveLabel="Save branding"
        canEdit={canEditSiteSettings}
        readOnlyHint="Read-only, needs edit_site_settings to save."
      />,
    );
    return () => shell.setFooter(null);
  }, [shell, saving, savedFlash, error, data?.updatedAt, canEditSiteSettings]);

  if (!data || !draft) {
    return <div className="text-keep-muted text-xs">{error ?? "loading..."}</div>;
  }

  return (
    <form id="admin-branding-form" onSubmit={save} className="space-y-4">
      <p className="text-xs text-keep-muted">
        Public branding shown to every user (including the login screen).
        Changes apply immediately for everyone after save.
      </p>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Site name</legend>
        <input
          type="text"
          value={draft.siteName}
          onChange={(e) => setDraft({ ...draft, siteName: e.target.value })}
          maxLength={60}
          placeholder="The Spire"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
        <p className="mt-1 text-keep-muted">
          Shown in the banner, login screen, BootSplash, and tab title.
          Empty falls back to <code>The Spire</code>.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Site URL</legend>
        <input
          type="url"
          value={draft.siteUrl}
          onChange={(e) => setDraft({ ...draft, siteUrl: e.target.value })}
          maxLength={500}
          placeholder="https://thespire.games"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          When set, the banner wraps the site name / logo image in an{" "}
          unstyled link pointing here, useful for sending visitors back to a
          marketing landing page or the main domain when the chat lives at a
          subdomain. The wrapping is invisible (no underline, no color change);
          the logo still reads as a logo, it just becomes clickable. Must
          start with <code>http://</code> or <code>https://</code>; leave empty
          to disable.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Banner cover</legend>
        <textarea
          value={draft.bannerCoverCss}
          onChange={(e) => setDraft({ ...draft, bannerCoverCss: e.target.value })}
          rows={2}
          maxLength={1000}
          placeholder='e.g. url("https://example.com/banner.jpg") center/cover no-repeat'
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Full CSS <code>background</code> shorthand applied behind the logo
          text. Accepts <code>url()</code>, <code>linear-gradient(...)</code>,
          a solid color, etc. Leave empty to use the theme's panel color.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Logo image</legend>
        <p className="mb-2 text-keep-muted">
          Shown in the banner and on the splash in place of the site name. Leave empty to use the text title instead. The default install ships <code>/thespire-logo.png</code>; uploading replaces it with your own image stored on the server (no external host required).
        </p>
        <LogoImageRow
          value={draft.logoUrl}
          canUpload={canUploadLogo}
          onChange={(next) => setDraft({ ...draft, logoUrl: next })}
          onUploaded={(j) => {
            // The upload endpoint returns the full freshly-saved
            // settings row. Mirror it straight into the store so the
            // banner refreshes without waiting for the form save.
            setData(j.settings);
            setDraft((d) => (d ? { ...d, logoUrl: j.url } : d));
            setBranding({
              siteName: j.settings.siteName,
              siteUrl: j.settings.siteUrl ?? "",
              bannerCoverCss: j.settings.bannerCoverCss,
              logoColor: j.settings.logoColor,
              logoFont: j.settings.logoFont,
              logoUrl: j.settings.logoUrl,
              registrationOpen: j.settings.registrationOpen,
              welcomeHtml: j.settings.welcomeHtml,
              registerDisclaimerHtml: j.settings.registerDisclaimerHtml,
              messageRetentionMs: j.settings.messageRetentionMs,
              sessionTtlMs: j.settings.sessionTtlMs,
              editGraceMs: j.settings.editGraceMs,
              defaultTheme: j.settings.defaultTheme,
              activityFeedsEnabled: j.settings.activityFeedsEnabled,
              featuredWorldsEnabled: j.settings.featuredWorldsEnabled,
              splashMessages24hEnabled: j.settings.splashMessages24hEnabled,
              profileDesignerEnabled: j.settings.profileDesignerEnabled,
              defaultStyleKey: j.settings.defaultStyleKey,
              themeDesignMap: j.settings.themeDesignMap ?? {},
              defaultThemeJson: j.settings.defaultThemeJson ?? null,
            });
          }}
        />
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Logo color</legend>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={draft.logoColor || "#1a1a1a"}
            onChange={(e) => setDraft({ ...draft, logoColor: e.target.value })}
            className="h-8 w-10 cursor-pointer rounded border border-keep-rule"
            aria-label="Logo color"
          />
          <input
            type="text"
            value={draft.logoColor}
            onChange={(e) => setDraft({ ...draft, logoColor: e.target.value })}
            placeholder="(empty = inherit theme text color)"
            maxLength={7}
            pattern="^#[0-9a-fA-F]{6}$|^$"
            className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
          <button
            type="button"
            onClick={() => setDraft({ ...draft, logoColor: "" })}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted hover:text-keep-text"
            title="Clear - logo follows the active theme."
          >
            Clear
          </button>
        </div>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Logo font</legend>
        <input
          type="text"
          value={draft.logoFont}
          onChange={(e) => setDraft({ ...draft, logoFont: e.target.value })}
          maxLength={200}
          placeholder='e.g. "Cinzel", "Georgia", serif'
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          A CSS <code>font-family</code> stack. Web fonts must be self-hosted
          or loaded via <code>@import</code> in your stylesheet - this field
          only changes the family name, not the loading. Empty to use the
          built-in serif stack.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Welcome message</legend>
        <textarea
          value={draft.welcomeHtml}
          onChange={(e) => setDraft({ ...draft, welcomeHtml: e.target.value })}
          rows={6}
          maxLength={500_000}
          placeholder="<p>Welcome to <b>The Spire</b> - a roleplay-focused chat sanctuary.</p>&#10;<p>Sign in to enter, or register a new account.</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          HTML rendered above the splash login/register form. Sanitized
          server-side using the same allow-list as profile bios - basic
          formatting tags, links, lists, and headings (h3-h6) are accepted.
          Empty hides the welcome block entirely.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">SEO description</legend>
        <textarea
          value={draft.metaDescription}
          onChange={(e) => setDraft({ ...draft, metaDescription: e.target.value })}
          rows={3}
          maxLength={500}
          placeholder="A roleplay-focused chat sanctuary. Build characters, share scenes, and tell collaborative stories with other writers."
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
        <p className="mt-1 text-keep-muted">
          Plain-text description used in <code>&lt;meta name="description"&gt;</code>
          and the OG / Twitter card. Search engines typically display the
          first ~155 characters. Empty falls back to the welcome message
          stripped to text.
          <span className="ml-1 tabular-nums">
            ({draft.metaDescription.length}/500)
          </span>
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-accent/40 bg-keep-accent/5 p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-accent">
          Custom head HTML (analytics)
        </legend>
        <textarea
          value={draft.customHeadHtml}
          onChange={(e) => setDraft({ ...draft, customHeadHtml: e.target.value })}
          rows={6}
          maxLength={20_000}
          spellCheck={false}
          placeholder={`<!-- Plausible -->\n<script defer data-domain="example.com" src="https://plausible.io/js/script.js"></script>\n\n<!-- or Google Analytics, Cloudflare Web Analytics, Umami, etc. -->`}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-accent/80">
          <b>Raw HTML, not sanitized.</b> Pasted verbatim into <code>&lt;head&gt;</code>
          on every splash response so analytics fire before React mounts.
          Anything you put here ships to every visitor on first paint -
          double-check the snippet from your provider's dashboard before saving.
        </p>
      </fieldset>

      {/* Live preview */}
      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Preview</legend>
        <div
          className="flex items-center justify-between rounded border border-keep-rule px-4 py-2"
          style={{
            background: draft.bannerCoverCss.trim() || "rgb(var(--keep-panel) / 1)",
          }}
        >
          <span
            className="font-action text-xl tracking-wide"
            style={{
              ...(draft.logoColor ? { color: draft.logoColor } : {}),
              ...(draft.logoFont ? { fontFamily: draft.logoFont } : {}),
            }}
          >
            {draft.siteName || "The Spire"}
          </span>
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">
            preview
          </span>
        </div>
      </fieldset>

      {/* Save controls + status (incl. error) live in the modal
          footer via `useAdminShell().setFooter(...)` near the top of
          this component. */}
    </form>
  );
}

/**
 * Logo image picker, URL input + Upload button + live preview.
 *
 * Two paths admins can take:
 *   1. Type/paste a URL (built-in `/thespire-logo.png`, an
 *      `/uploads/...` path that was uploaded earlier, or a remote
 *      https URL). Save commits via the standard /admin/settings PUT
 *      flow alongside the rest of the branding form.
 *   2. Click Upload, pick a local file. We read it via FileReader as
 *      a base64 data URL, POST to /admin/upload/logo, and the server
 *      writes it under /uploads + immediately persists the URL onto
 *      site_settings.logo_url. That bypass the parent form save,
 *      the upload is its own atomic operation since admins typically
 *      want the new logo live as soon as they pick it. The parent
 *      callback then syncs the local draft + branding store.
 */
function LogoImageRow({
  value,
  onChange,
  onUploaded,
  canUpload,
}: {
  value: string;
  onChange: (next: string) => void;
  onUploaded: (j: { url: string; settings: SettingsRow }) => void;
  /** Whether the viewer holds `upload_logo`. When false the Upload
   *  button hides, the URL input stays editable since pasting a
   *  URL only requires `edit_site_settings`, which the parent gates
   *  independently. */
  canUpload: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
      setError("Only PNG, JPEG, WebP, and GIF are accepted.");
      return;
    }
    if (f.size > 8 * 1024 * 1024) {
      setError("Image is over 8MB. Resize or recompress before uploading.");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? ""));
        r.onerror = () => reject(new Error("file read failed"));
        r.readAsDataURL(f);
      });
      const res = await fetch("/admin/upload/logo", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { ok: true; url: string; settings: SettingsRow };
      onUploaded(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="(empty = no logo, show text title)"
          className="min-w-[14rem] flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={onPick}
          className="hidden"
        />
        {canUpload ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="rounded border border-keep-rule bg-keep-banner px-3 py-1 hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {uploading ? "Uploading…" : "Upload…"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onChange("")}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted hover:text-keep-text"
          title="Clear, banner falls back to the text site name."
        >
          Clear
        </button>
      </div>
      {error ? (
        <div className="text-[11px] text-keep-accent">{error}</div>
      ) : null}
      {value ? (
        <div className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg p-2">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">Preview:</span>
          <img
            src={value}
            alt="logo preview"
            className="max-h-10 w-auto"
            // Surface a broken URL without breaking the form layout.
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
          />
        </div>
      ) : null}
    </div>
  );
}

/* =============================================================
 * RULES TAB
 * =============================================================
 *
 * Edits the two HTML bodies rendered by the Rules modal:
 *   - rulesHtml          - admin-authored house rules
 *   - securityNoticeHtml - privacy/safety notice (defaults to the canonical
 *                          "private rooms aren't readable by admins" text)
 *
 * Both go through the same sanitizeBio() allow-list as profile bios on save.
 */
function RulesTab() {
  const setBranding = useChat((s) => s.setBranding);
  // Rules saves through PUT /admin/settings (the same endpoint that
  // backs Settings + Branding), so the gate is `edit_site_settings`.
  const canEditSiteSettings = useChat((s) => s.me?.permissions.includes("edit_site_settings") ?? false);
  const [data, setData] = useState<SettingsRow | null>(null);
  const [rulesHtml, setRulesHtml] = useState("");
  const [securityHtml, setSecurityHtml] = useState("");
  const [disclaimerHtml, setDisclaimerHtml] = useState("");
  const [serverRegRulesHtml, setServerRegRulesHtml] = useState("");
  const [forumRegRulesHtml, setForumRegRulesHtml] = useState("");
  const [welcomeHtml, setWelcomeHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/settings", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      setRulesHtml(j.rulesHtml ?? "");
      setSecurityHtml(j.securityNoticeHtml ?? "");
      setDisclaimerHtml(j.registerDisclaimerHtml ?? "");
      setServerRegRulesHtml(j.serverRegistrationRulesHtml ?? "");
      setForumRegRulesHtml(j.forumRegistrationRulesHtml ?? "");
      setWelcomeHtml(j.newUserWelcomeHtml ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }
  useEffect(() => { load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/admin/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rulesHtml,
          securityNoticeHtml: securityHtml,
          registerDisclaimerHtml: disclaimerHtml,
          serverRegistrationRulesHtml: serverRegRulesHtml,
          forumRegistrationRulesHtml: forumRegRulesHtml,
          newUserWelcomeHtml: welcomeHtml,
        }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as SettingsRow;
      setData(j);
      // Re-sync from server: sanitize may have stripped tags or transformed
      // attributes, so the textarea should reflect what's actually stored.
      setRulesHtml(j.rulesHtml ?? "");
      setSecurityHtml(j.securityNoticeHtml ?? "");
      setDisclaimerHtml(j.registerDisclaimerHtml ?? "");
      setServerRegRulesHtml(j.serverRegistrationRulesHtml ?? "");
      setForumRegRulesHtml(j.forumRegistrationRulesHtml ?? "");
      setWelcomeHtml(j.newUserWelcomeHtml ?? "");
      // The disclaimer is part of public branding (consumed by AuthGate); push
      // the new copy into the store so other open tabs / the splash see it
      // without waiting for the next /site fetch.
      setBranding({
        siteName: j.siteName,
        siteUrl: j.siteUrl ?? "",
        bannerCoverCss: j.bannerCoverCss,
        logoColor: j.logoColor,
        logoFont: j.logoFont,
        logoUrl: j.logoUrl,
        registrationOpen: j.registrationOpen,
        welcomeHtml: j.welcomeHtml,
        registerDisclaimerHtml: j.registerDisclaimerHtml,
        messageRetentionMs: j.messageRetentionMs,
        sessionTtlMs: j.sessionTtlMs,
        editGraceMs: j.editGraceMs,
        defaultTheme: j.defaultTheme,
        activityFeedsEnabled: j.activityFeedsEnabled,
        featuredWorldsEnabled: j.featuredWorldsEnabled,
        splashMessages24hEnabled: j.splashMessages24hEnabled,
        profileDesignerEnabled: j.profileDesignerEnabled,
        serversEnabled: j.serversEnabled,
        defaultStyleKey: j.defaultStyleKey,
        themeDesignMap: j.themeDesignMap ?? {},
        // Null = admin hasn't set an explicit override → splash falls
        // back to prefers-color-scheme + cached last-active theme.
        defaultThemeJson: j.defaultThemeJson ?? null,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  // Project save controls into the modal footer. Same pattern as
  // SettingsTab / BrandingTab, see those for the full rationale.
  const shell = useAdminShell();
  useEffect(() => {
    if (!shell) return;
    shell.setFooter(
      <AdminSaveFooter
        formId="admin-rules-form"
        saving={saving}
        savedFlash={savedFlash}
        lastUpdatedAt={data?.updatedAt ?? null}
        error={error}
        saveLabel="Save rules"
        canEdit={canEditSiteSettings}
        readOnlyHint="Read-only, needs edit_site_settings to save."
      />,
    );
    return () => shell.setFooter(null);
  }, [shell, saving, savedFlash, error, data?.updatedAt, canEditSiteSettings]);

  if (!data) {
    return <div className="text-keep-muted text-xs">{error ?? "loading..."}</div>;
  }

  return (
    <form id="admin-rules-form" onSubmit={save} className="space-y-4">
      <p className="text-xs text-keep-muted">
        The app-wide governing rules and the privacy notice shown when users
        click the Rules button. The rules here apply everywhere and show on
        every server and on the site. Each server can also post its own
        Server Rules in Server Admin, Settings. Both fields accept the same
        HTML allow-list as profile bios: formatting tags, links, lists, and
        headings (h3 to h6).
      </p>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">App rules (governing, shown everywhere)</legend>
        <textarea
          value={rulesHtml}
          onChange={(e) => setRulesHtml(e.target.value)}
          rows={14}
          maxLength={1_000_000}
          placeholder="<h3>App Rules</h3><ol><li>...</li></ol>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          The app-wide governing rules. They apply on every server and on the
          site, and always appear under the App Rules tab. A server's own
          Server Rules are written separately in Server Admin, Settings, and
          sit beside these in their own tab. Defaults seed an 8-point baseline
          covering consent, godmodding, OOC and IC separation, and reporting.
          Cap is 1MB of HTML, enough for a fully comprehensive multi-section
          ruleset.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Privacy &amp; safety notice</legend>
        <textarea
          value={securityHtml}
          onChange={(e) => setSecurityHtml(e.target.value)}
          rows={8}
          maxLength={500_000}
          placeholder="<h3>Privacy &amp; Safety</h3><p>...</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Shown alongside the rules. Defaults explain the privacy contract:
          admins cannot read private/whispered messages, so users should
          self-govern and report problems with screenshots. 500KB cap fits a
          full privacy disclosure with ample headroom.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Registration disclaimer</legend>
        <textarea
          value={disclaimerHtml}
          onChange={(e) => setDisclaimerHtml(e.target.value)}
          rows={10}
          maxLength={500_000}
          placeholder="<p>This is a free-form roleplay chat...</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Rendered above the registration form on the splash. Users must tick
          an "I agree" checkbox before <code>/auth/register</code> succeeds.
          Empty disclaimer = no checkbox shown (registration unblocked).
          500KB cap fits a full Terms-of-Service document.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Server registration rules</legend>
        <textarea
          value={serverRegRulesHtml}
          onChange={(e) => setServerRegRulesHtml(e.target.value)}
          rows={10}
          maxLength={500_000}
          placeholder="<h3>Before you register a server</h3><ol><li>...</li></ol>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Shown with an "I agree" checkbox when someone applies to register a
          server. Empty = no agreement gate shown.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Forum registration rules</legend>
        <textarea
          value={forumRegRulesHtml}
          onChange={(e) => setForumRegRulesHtml(e.target.value)}
          rows={10}
          maxLength={500_000}
          placeholder="<h3>Before you create a forum</h3><ol><li>...</li></ol>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Shown with an "I agree" checkbox when someone applies to create a
          forum. Empty = no agreement gate shown.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">New-user welcome (post-login)</legend>
        <textarea
          value={welcomeHtml}
          onChange={(e) => setWelcomeHtml(e.target.value)}
          rows={10}
          maxLength={500_000}
          placeholder="<h3>Welcome to The Spire</h3><p>Quick orientation...</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Onboarding modal shown once to users who register <b>after</b> the most
          recent save here. Existing users (registered before the welcome was
          set or last edited) never see it - this is for fresh accounts only,
          not a broadcast channel. Re-saving with the same text doesn't
          re-shift the audience cutoff; only changing the text does. Empty
          text = no welcome shown.
        </p>
      </fieldset>

      {/* Live preview */}
      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Preview</legend>
        <div className="space-y-3 rounded border border-keep-rule bg-keep-bg p-3">
          {securityHtml.trim() ? (
            <div
              className={`prose prose-sm max-w-none rounded border border-keep-action/40 bg-keep-action/5 p-2 ${USER_HTML_SCOPE_CLASS}`}
              dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(securityHtml) }}
            />
          ) : null}
          {rulesHtml.trim() ? (
            <div
              className={`prose prose-sm max-w-none ${USER_HTML_SCOPE_CLASS}`}
              dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(rulesHtml) }}
            />
          ) : (
            <p className="italic text-keep-muted">(no rules set)</p>
          )}
          {disclaimerHtml.trim() ? (
            <div className="rounded border border-keep-border/60 bg-keep-bg/50 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.25em] text-keep-muted">
                register disclaimer (shown on the splash)
              </div>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(disclaimerHtml) }}
              />
              <label className="mt-1 flex items-start gap-2 text-[11px] text-keep-muted">
                <input type="checkbox" disabled checked className="mt-0.5" />
                <span>I have read and accept the disclaimer above and the house rules.</span>
              </label>
            </div>
          ) : null}
          {welcomeHtml.trim() ? (
            <div className="rounded border border-keep-action/40 bg-keep-action/5 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.25em] text-keep-muted">
                new-user welcome modal (shown only to accounts registered after this is saved)
              </div>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(welcomeHtml) }}
              />
            </div>
          ) : null}
        </div>
        <p className="mt-1 text-[10px] text-keep-muted">
          Preview is run through DOMPurify, but tags outside the server's
          allow-list will still disappear on save (server uses sanitize-html
          with a stricter list than DOMPurify's default).
        </p>
      </fieldset>

      {/* Save controls + status (incl. error) live in the modal
          footer via `useAdminShell().setFooter(...)` near the top of
          this component. */}
    </form>
  );
}

function LinksTab({ onLinksChanged }: { onLinksChanged: () => void }) {
  const [links, setLinks] = useState<NavLinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/admin/nav-links", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { links: NavLinkRow[] };
      setLinks(j.links);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function create(input: NavLinkInput) {
    const r = await fetch("/admin/nav-links", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    onLinksChanged();
    await reload();
  }

  async function patch(id: string, input: Partial<NavLinkInput>) {
    const r = await fetch(`/admin/nav-links/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    onLinksChanged();
    await reload();
  }

  async function destroy(id: string) {
    if (!window.confirm("Delete this link?")) return;
    const r = await fetch(`/admin/nav-links/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!r.ok) throw new Error(await readError(r));
    onLinksChanged();
    await reload();
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-keep-muted">
        Banner links shown to all users. The Exit/logout link is built-in.
      </p>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}

      <NewLinkForm onCreate={create} />

      {loading ? (
        <div className="text-keep-muted">loading...</div>
      ) : links.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          No links yet. Add one above.
        </div>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[560px] text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 text-left">Pos</th>
              <th className="px-2 py-1 text-left">Label</th>
              <th className="px-2 py-1 text-left">URL</th>
              <th className="px-2 py-1">Target</th>
              <th className="px-2 py-1">On</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <LinkRow key={l.id} link={l} onPatch={patch} onDelete={destroy} />
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

function NewLinkForm({ onCreate }: { onCreate: (i: NavLinkInput) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [href, setHref] = useState("");
  const [position, setPosition] = useState("0");
  const [target, setTarget] = useState<"_self" | "_blank">("_blank");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        label: label.trim(),
        href: href.trim(),
        position: parseInt(position, 10) || 0,
        target,
      });
      setLabel("");
      setHref("");
      setPosition("0");
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-2 text-xs">
      <div className="mb-1 font-semibold">Add a link</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-12">
        <input
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Rules)"
          maxLength={40}
          className="col-span-2 rounded border border-keep-rule px-2 py-1 sm:col-span-3"
        />
        <input
          required
          value={href}
          onChange={(e) => setHref(e.target.value)}
          placeholder="https://example.com or /path"
          maxLength={500}
          className="col-span-2 rounded border border-keep-rule px-2 py-1 sm:col-span-5"
        />
        <input
          type="number"
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          min={0}
          max={9999}
          title="Sort order - lower renders first"
          className="col-span-1 rounded border border-keep-rule px-2 py-1"
        />
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as "_self" | "_blank")}
          className="col-span-1 rounded border border-keep-rule px-2 py-1 sm:col-span-2"
        >
          <option value="_blank">new tab</option>
          <option value="_self">same tab</option>
        </select>
        <button
          type="submit"
          disabled={submitting}
          className="keep-button col-span-2 rounded border border-keep-rule bg-keep-banner px-2 py-1 disabled:opacity-50 hover:bg-keep-banner/80 sm:col-span-1"
        >
          {submitting ? "..." : "Add"}
        </button>
      </div>
      {error ? <div className="mt-1 text-keep-accent">{error}</div> : null}
    </form>
  );
}

function LinkRow({
  link,
  onPatch,
  onDelete,
}: {
  link: NavLinkRow;
  onPatch: (id: string, p: Partial<NavLinkInput>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(link);
  const dirty =
    draft.label !== link.label ||
    draft.href !== link.href ||
    draft.position !== link.position ||
    draft.target !== link.target;

  async function commit() {
    await onPatch(link.id, {
      label: draft.label,
      href: draft.href,
      position: draft.position,
      target: draft.target,
    });
  }

  async function toggleEnabled() {
    await onPatch(link.id, { enabled: !link.enabled });
  }

  return (
    <tr className="border-t border-keep-rule">
      <td className="px-2 py-1">
        <input
          type="number"
          min={0}
          max={9999}
          value={draft.position}
          onChange={(e) => setDraft({ ...draft, position: parseInt(e.target.value, 10) || 0 })}
          className="w-14 rounded border border-keep-rule px-1 py-0.5"
        />
      </td>
      <td className="px-2 py-1">
        <input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          maxLength={40}
          className="w-full rounded border border-keep-rule px-1 py-0.5"
        />
      </td>
      <td className="px-2 py-1">
        <input
          value={draft.href}
          onChange={(e) => setDraft({ ...draft, href: e.target.value })}
          maxLength={500}
          className="w-full rounded border border-keep-rule px-1 py-0.5"
        />
      </td>
      <td className="px-2 py-1">
        <select
          value={draft.target}
          onChange={(e) => setDraft({ ...draft, target: e.target.value as "_self" | "_blank" })}
          className="rounded border border-keep-rule px-1 py-0.5"
        >
          <option value="_blank">new</option>
          <option value="_self">same</option>
        </select>
      </td>
      <td className="px-2 py-1 text-center">
        <input type="checkbox" checked={link.enabled} onChange={toggleEnabled} />
      </td>
      <td className="px-2 py-1 text-right">
        {dirty ? (
          <button
            type="button"
            onClick={commit}
            className="keep-button mr-1 rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80"
          >
            Save
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onDelete(link.id)}
          className="rounded border border-keep-accent/60 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

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
type StateFilter = "any" | "online" | "offline" | "disabled" | "away";
type RegisteredFilter = "any" | "24h" | "5d" | "7d" | "30d";
type LoginFilter = "any" | "never" | "active";

function UsersTab() {
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
      if (q.trim()) params.set("q", q.trim());
      if (ipPivot.trim()) params.set("ip", ipPivot.trim());
      // "disabled" is a DB-backed state, so push it server-side — otherwise
      // a disabled account past the first page (username-ordered, limit 100)
      // never loads and the local filter finds nothing. online/offline/away
      // stay client-side (runtime presence).
      if (stateFilter === "disabled") params.set("state", "disabled");
      const qs = params.toString();
      const url = qs ? `/admin/users?${qs}` : "/admin/users";
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { users: AdminUserRow[] };
      setRows(j.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const t = window.setTimeout(reload, 200);
    return () => window.clearTimeout(t);
  }, [q, ipPivot, stateFilter]);

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
      `DELETE user "${u.username}"?\n\nThis cascades through their characters, room memberships, sessions, and bans. Their messages keep the snapshotted display name in history but their account is gone permanently. This cannot be undone.`,
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
      setError(err instanceof Error ? err.message : "delete failed");
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-xs text-keep-muted sm:max-w-[60%]">
          Every registered account, including disabled ones. Search matches
          username, email, and character name (so a persona name finds its
          owning OOC account). Editing role to "admin" grants global
          moderation - same as <code>/promoteadmin</code>. "masteradmin"
          (master-only to set) additionally unlocks settings, branding,
          rules, account-disable, and email changes.
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search username/email/character"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs sm:w-auto sm:shrink-0"
        />
      </div>

      {/* IP pivot chip, surfaces while a click on an IP chip in the
          table has scoped the list to "every account on this IP." A
          small × clears it back to the unfiltered view. Sits above
          the filter row so it reads as a context layer on top of the
          regular search, not as another filter knob. */}
      {ipPivot ? (
        <div className="flex items-center gap-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">
          <span>
            Showing every account seen on <span className="font-mono">{ipPivot}</span>
          </span>
          <button
            type="button"
            onClick={() => setIpPivot("")}
            className="ml-auto rounded border border-keep-accent/40 px-1.5 py-0 hover:bg-keep-accent/15"
            title="Clear IP pivot"
            aria-label="Clear IP pivot"
          >
            × Clear
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2 rounded border border-keep-rule/60 bg-keep-bg/30 p-2 text-xs">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">Role</span>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="any">any</option>
            <option value="user">user</option>
            <option value="trusted">trusted</option>
            <option value="mod">mod</option>
            <option value="admin">admin</option>
            <option value="masteradmin">master</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">State</span>
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as StateFilter)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="any">any</option>
            <option value="online">online</option>
            <option value="offline">offline</option>
            <option value="away">away</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">Registered</span>
          <select
            value={registeredFilter}
            onChange={(e) => setRegisteredFilter(e.target.value as RegisteredFilter)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="any">any time</option>
            <option value="24h">last 24h</option>
            <option value="5d">last 5 days</option>
            <option value="7d">last 7 days</option>
            <option value="30d">last 30 days</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">Login</span>
          <select
            value={loginFilter}
            onChange={(e) => setLoginFilter(e.target.value as LoginFilter)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
            title="Never = registered but no login session ever; active = has at least one login."
          >
            <option value="any">any</option>
            <option value="never">never logged in</option>
            <option value="active">has logged in</option>
          </select>
        </label>
        {filterActive ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded border border-keep-rule px-2 py-1 hover:bg-keep-banner/40"
          >Clear filters</button>
        ) : null}
        <span className="ml-auto text-keep-muted">
          {loading ? "loading…" : `${filteredSorted.length} of ${rows.length}`}
        </span>
      </div>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      {loading ? (
        <div className="text-keep-muted text-xs">loading...</div>
      ) : filteredSorted.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          {rows.length === 0 ? "No users match." : "No users match the current filters."}
        </div>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="cursor-pointer px-2 py-1 text-left hover:text-keep-text" onClick={() => toggleSort("username")}>Username{sortIndicator("username")}</th>
              <th className="px-2 py-1 text-left">Email</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("role")}>Role{sortIndicator("role")}</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("state")}>State{sortIndicator("state")}</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("chars")}>Chars{sortIndicator("chars")}</th>
              <th
                className="px-2 py-1 text-left"
                title="Up to 5 most-recent distinct IPs the user has been seen on. Captured on activity (login, connect, room switch, chat, posts), so this stays current as a user roams networks instead of showing only their original login IP. Click an IP to pivot the list to every account that shares it. Numeric badge = count of OTHER accounts seen on the same IP, flag for ban evasion or shared-device review."
              >IPs &amp; alts</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("registered")}>Registered{sortIndicator("registered")}</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("lastSeen")}>Last seen{sortIndicator("lastSeen")}</th>
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
                    title={isExpanded ? "Hide characters" : "Show all characters"}
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
                    {u.role === "masteradmin" ? "master" : u.role}
                  </span>
                </td>
                <td className="px-2 py-1 text-center">
                  {u.disabled ? (
                    <span className="text-keep-accent">disabled</span>
                  ) : u.online ? (
                    <span className="text-keep-action">online</span>
                  ) : (
                    <span className="text-keep-muted">offline</span>
                  )}
                  {u.away ? <span className="ml-1 text-keep-system">away</span> : null}
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
                <td className="px-2 py-1 text-center tabular-nums" title={new Date(u.createdAt).toLocaleString()}>
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
                <td className="px-2 py-1 text-center tabular-nums" title={u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never logged in"}>
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : <span className="text-keep-muted/70 italic">never</span>}
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => setEditing(u)}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    Edit
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
                      Delete
                    </button>
                  ) : null}
                </td>
              </tr>
              {isExpanded ? (
                <tr className="border-t border-keep-rule/40 bg-keep-bg/30">
                  {/* Full character roster for the user, View/Edit per
                      profile. colSpan spans all 9 header columns. */}
                  <td colSpan={9} className="px-3 pb-3">
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
              title={`Last seen ${new Date(entry.lastSeenAt).toLocaleString()}. Click to show every other account that has used this IP.`}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0 font-mono text-[10px] hover:bg-keep-banner ${
                isActive
                  ? "border-keep-accent bg-keep-accent/15 text-keep-accent"
                  : "border-keep-rule/60 bg-keep-bg text-keep-text"
              }`}
            >
              <span>{entry.ip}</span>
              <span
                className={`rounded-full px-1 text-[9px] uppercase tracking-widest ${altClass}`}
                title={`${entry.altCount} other account${entry.altCount === 1 ? "" : "s"} seen on this IP`}
              >
                {entry.altCount} alt{entry.altCount === 1 ? "" : "s"}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
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
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<Role>(user.role);
  const [disabled, setDisabled] = useState(user.disabled);
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
  // A non-masteradmin caller can't act on a masteradmin target at all
  // (no demote, no rename, etc.), the row stays read-only so they
  // don't submit a save that would 403. The "you can't outrank
  // yourself" guard stays as a tier check per plan.md's hardcoded
  // exceptions.
  const targetIsMaster = user.role === "masteradmin";
  const locked = !isMaster && targetIsMaster;

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
      if (Object.keys(body).length === 0) {
        onCancel();
        return;
      }
      await onSubmit(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-semibold">Editing {user.username}</div>
        <button type="button" onClick={onCancel} className="text-keep-muted hover:text-keep-text">cancel</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Username</span>
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
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Email</span>
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
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            disabled={locked}
            className="w-full rounded border border-keep-rule px-2 py-1 disabled:bg-keep-banner/30"
          >
            <option value="user">user</option>
            <option value="trusted">trusted</option>
            <option value="mod">mod</option>
            <option value="admin">admin</option>
            {/* `masteradmin` is master-only on both ends, only a
                master can mint another master, and only a master can
                strip an existing master's role. A plain admin sees
                the option absent (it'd 403 server-side anyway). */}
            {isMaster ? <option value="masteradmin">masteradmin</option> : null}
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
            <span>Disabled (account cannot log in)</span>
          </label>
        ) : null}
      </div>
      {locked ? (
        <div className="mt-2 rounded border border-keep-rule bg-keep-banner/30 p-2 text-[11px] text-keep-muted">
          This user is an owner. Only another owner can edit their profile or change their role.
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
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || locked}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 disabled:opacity-50 hover:bg-keep-banner/80"
        >
          {submitting ? "Saving..." : "Save"}
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
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">Account ban</div>
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
        setViewError(r.status === 404 ? "Profile not found." : `Couldn't load profile (HTTP ${r.status}).`);
        setViewingName(null);
        return;
      }
      const j = await r.json();
      if (j && "private" in j) {
        setViewError("Profile is restricted.");
        setViewingName(null);
        return;
      }
      setViewing(j as ProfileView);
    } catch {
      setViewError("Couldn't load profile.");
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
          Profiles
        </div>
        <ul className="space-y-1">
          <li className="flex items-center justify-between gap-2 rounded border border-keep-rule/60 bg-keep-bg px-2 py-1">
            <span className="truncate">
              <span className="mr-2 rounded bg-keep-action/15 px-1 text-[9px] uppercase tracking-widest text-keep-action">OOC</span>
              {user.username}
            </span>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => openView(user.username)}
                className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner"
              >
                View
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
                  View
                </button>
                <button
                  type="button"
                  onClick={() => editChar(c)}
                  className="keep-button rounded border border-keep-action/60 bg-keep-bg px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/10"
                >
                  Edit
                </button>
              </div>
            </li>
          ))}
          {deleted.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded border border-keep-rule/30 bg-keep-banner/20 px-2 py-1 text-keep-muted line-through">
              <span className="truncate">{c.name}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-widest">deleted</span>
            </li>
          ))}
        </ul>
        {viewError ? (
          <div className="mt-2 text-[11px] text-keep-accent">{viewError}</div>
        ) : null}
        {viewingName && !viewing && !viewError ? (
          <div className="mt-2 text-[11px] text-keep-muted">Loading {viewingName}...</div>
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
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setErr(null);
    setOk(false);
    if (next.length < 8) { setErr("Password must be at least 8 chars."); return; }
    if (next !== confirm) { setErr("Passwords don't match."); return; }
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
      setErr(e instanceof Error ? e.message : "reset failed");
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
    <fieldset className="rounded border border-keep-rule p-2">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Reset password for {username}</legend>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">New password</span>
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
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Confirm</span>
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
        The user's active sessions are dropped on reset; they'll have to log in again with the new password. Generate fills both fields with a 20-char password and copies it to the clipboard so you can paste it into whatever channel you're using to hand it back.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void generate()}
          disabled={busy}
          className="keep-button rounded border border-keep-rule bg-keep-banner/40 px-3 py-1 text-keep-text hover:bg-keep-banner disabled:opacity-50"
        >
          Generate
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !next || !confirm}
          className="keep-button rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
        >
          {busy ? "Resetting…" : "Reset password"}
        </button>
        {copied ? <span className="text-keep-system">Copied to clipboard.</span> : null}
        {err ? <span className="text-keep-accent">{err}</span> : null}
        {ok ? <span className="text-keep-system">Password reset.</span> : null}
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
  const [xp, setXp] = useState("");
  const [currency, setCurrency] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function grant() {
    setErr(null); setOk(null);
    const xpDelta = parseInt(xp || "0", 10) || 0;
    const currencyDelta = parseInt(currency || "0", 10) || 0;
    if (xpDelta === 0 && currencyDelta === 0) { setErr("Enter an XP or Currency amount (positive to grant, negative to revoke)."); return; }
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
      setOk(`Granted ${xpDelta} XP, ${currencyDelta} Currency.`);
      setXp(""); setCurrency("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "grant failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="rounded border border-keep-rule p-2">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Grant XP / Currency</legend>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">XP (+ / -)</span>
          <input
            type="number"
            value={xp}
            onChange={(e) => setXp(e.target.value)}
            placeholder="100"
            className="w-full rounded border border-keep-rule px-2 py-1 font-mono"
          />
        </label>
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Currency (+ / -)</span>
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
        Goes through the live earning engine, rank recomputes, the user's wallet updates live, the ledger gets an audit row. Negative values revoke.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void grant()}
          disabled={busy}
          className="keep-button rounded border border-keep-action/60 bg-keep-action/10 px-3 py-1 text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
        >
          {busy ? "Granting…" : "Grant"}
        </button>
        {err ? <span className="text-keep-accent">{err}</span> : null}
        {ok ? <span className="text-keep-system">{ok}</span> : null}
      </div>
    </fieldset>
  );
}

function CosmeticGrantSection({ username }: { username: string }) {
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
      setErr(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  const styles = snapshot?.catalog.nameStyles ?? [];
  const borderRanks = (snapshot?.catalog.rankTiers ?? []).filter((t) => t.tier === 4 && !!t.borderImageUrl);
  const styleNameByKey = new Map(styles.map((s) => [s.key, s.name]));
  const rankNameByKey = new Map((snapshot?.catalog.ranks ?? []).map((r) => [r.key, r.name]));

  return (
    <fieldset className="rounded border border-keep-rule p-2">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Cosmetics: grant / revoke</legend>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Name style</span>
          <div className="flex gap-1">
            <select
              value={pickedStyle}
              onChange={(e) => setPickedStyle(e.target.value)}
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1"
            >
              <option value="">pick one</option>
              {styles.map((s) => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => pickedStyle && void callAction("/admin/earning/grant-style", { username, styleKey: pickedStyle }, `Granted style "${pickedStyle}".`)}
              disabled={busy || !pickedStyle}
              className="shrink-0 rounded border border-keep-action/60 bg-keep-action/10 px-2 text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
            >
              Grant
            </button>
          </div>
        </div>
        <div>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Border (tier-IV rank)</span>
          <div className="flex gap-1">
            <select
              value={pickedBorder}
              onChange={(e) => setPickedBorder(e.target.value)}
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1"
            >
              <option value="">pick one</option>
              {borderRanks.map((t) => {
                const rank = snapshot?.catalog.ranks.find((r) => r.key === t.rankKey);
                return (
                  <option key={t.rankKey} value={t.rankKey}>{rank?.name ?? t.rankKey}</option>
                );
              })}
            </select>
            <button
              type="button"
              onClick={() => pickedBorder && void callAction("/admin/earning/grant-border", { username, rankKey: pickedBorder }, `Granted border for rank "${pickedBorder}".`)}
              disabled={busy || !pickedBorder}
              className="shrink-0 rounded border border-keep-action/60 bg-keep-action/10 px-2 text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
            >
              Grant
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
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Owned styles</span>
            {owned.styles.length === 0 ? (
              <div className="text-keep-muted">(none)</div>
            ) : (
              <ul className="space-y-1">
                {owned.styles.map((k) => (
                  <li key={k} className="flex items-center justify-between gap-1 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1">
                    <span className="truncate" title={k}>{styleNameByKey.get(k) ?? k}</span>
                    <button
                      type="button"
                      onClick={() => void callAction("/admin/earning/revoke-style", { username, styleKey: k }, `Revoked style "${k}".`)}
                      disabled={busy}
                      className="shrink-0 rounded border border-keep-accent/60 bg-keep-accent/10 px-2 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Owned borders</span>
            {owned.borders.length === 0 ? (
              <div className="text-keep-muted">(none)</div>
            ) : (
              <ul className="space-y-1">
                {owned.borders.map((k) => (
                  <li key={k} className="flex items-center justify-between gap-1 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1">
                    <span className="truncate" title={k}>{rankNameByKey.get(k) ?? k}</span>
                    <button
                      type="button"
                      onClick={() => void callAction("/admin/earning/revoke-border", { username, rankKey: k }, `Revoked border "${k}".`)}
                      disabled={busy}
                      className="shrink-0 rounded border border-keep-accent/60 bg-keep-accent/10 px-2 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-1 text-[10px] text-keep-muted">(User owns no cosmetics yet.)</p>
      )}

      <p className="mt-1 text-[10px] text-keep-muted">
        Grants bypass normal Currency / rank gates. Revokes also clear the equipped slot if the item was active. Both are idempotent.
      </p>
      <div className="mt-1 flex items-center gap-2">
        {err ? <span className="text-keep-accent">{err}</span> : null}
        {ok ? <span className="text-keep-system">{ok}</span> : null}
      </div>
    </fieldset>
  );
}

function EarningResetSection({ username }: { username: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function reset() {
    setErr(null); setOk(false);
    const confirmed = window.confirm(
      `Hard-reset ${username}'s earning state?\n\nThis wipes:\n` +
      "  • Master XP, Currency, rank, tier, and peak\n" +
      "  • Every character pool (XP / Currency / rank)\n" +
      "  • Owned name styles\n" +
      "  • Owned rank borders\n" +
      "  • Equipped cosmetics\n\n" +
      "Cannot be undone. Use for testing earning flows from scratch."
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
      setErr(e instanceof Error ? e.message : "reset failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="rounded border border-keep-accent/40 p-2">
      <legend className="px-1 uppercase tracking-widest text-keep-accent">Reset earning state</legend>
      <p className="text-[10px] text-keep-muted">
        Destructive test affordance, clears the user's XP / Currency / rank / peak, drops every character pool to zero, and removes all owned styles + borders. Useful for testing earning flows from a clean slate.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void reset()}
          disabled={busy}
          className="keep-button rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
        >
          {busy ? "Resetting…" : "Reset earning"}
        </button>
        {err ? <span className="text-keep-accent">{err}</span> : null}
        {ok ? <span className="text-keep-system">Earning reset.</span> : null}
      </div>
    </fieldset>
  );
}

function LimitField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
}) {
  return (
    <label className="text-xs">
      <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        max={max}
        step={1}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
      />
      <span className="mt-0.5 block text-[10px] text-keep-muted">{hint}</span>
    </label>
  );
}

/* =========================================================
 *  Reports tab, triage queue for user-filed public reports
 * ========================================================= */
function ReportsTab() {
  const [statusFilter, setStatusFilter] = useState<"open" | "reviewed" | "dismissed" | "all">("open");
  const [reports, setReports] = useState<ReportEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setReports(null);
    setError(null);
    const qs = statusFilter === "all" ? "" : `?status=${statusFilter}`;
    fetch(`/admin/reports${qs}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ reports: ReportEntry[] }>;
      })
      .then((j) => { if (!cancelled) setReports(j.reports); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, [statusFilter, refreshKey]);

  async function resolve(id: string, status: "reviewed" | "dismissed") {
    const note = window.prompt(
      status === "reviewed"
        ? "Mark report as reviewed (acted on). Optional note for the audit log:"
        : "Dismiss report (no action). Optional note for the audit log:",
      "",
    );
    if (note === null) return;
    try {
      const res = await fetch(`/admin/reports/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setRefreshKey((k) => k + 1);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "resolve failed");
    }
  }

  return (
    <section className="space-y-2 text-sm">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="font-action text-base">Reports queue</h3>
        <div className="flex flex-wrap gap-2 text-xs">
          {(["open", "reviewed", "dismissed", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded border border-keep-rule px-2 py-0.5 ${
                statusFilter === s ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"
              }`}
            >
              {s}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5 hover:bg-keep-banner"
          >
            Refresh
          </button>
        </div>
      </header>
      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}
      {reports === null ? (
        <p className="italic text-keep-muted">Loading reports...</p>
      ) : reports.length === 0 ? (
        <p className="italic text-keep-muted">No reports.</p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded border border-keep-rule bg-keep-bg p-2">
              <div className="flex items-baseline justify-between gap-2 text-xs text-keep-muted">
                <span>
                  <span className="font-semibold text-keep-text">{r.reporterDisplayName}</span> reported a message in{" "}
                  <span className="font-semibold text-keep-text">{r.roomName}</span>
                  {" · "}
                  <span title={new Date(r.createdAt).toLocaleString()}>{new Date(r.createdAt).toLocaleString()}</span>
                </span>
                <span
                  className={`rounded px-1 ${
                    r.status === "open"
                      ? "bg-keep-accent/15 text-keep-accent"
                      : "bg-keep-action/15 text-keep-action"
                  }`}
                >
                  {r.status}
                </span>
              </div>
              <div className="mt-1 rounded border border-keep-rule/50 bg-keep-panel/30 p-2 text-xs">
                <div className="text-keep-muted">
                  {new Date(r.messageCreatedAt).toLocaleTimeString()}, <span className="font-semibold">{r.messageDisplayName}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">{r.messageBody}</div>
              </div>
              {r.reason ? (
                <div className="mt-1 text-xs italic">Reporter note: {r.reason}</div>
              ) : null}
              {r.resolvedAt && r.resolvedByDisplayName ? (
                <div className="mt-1 text-[11px] text-keep-muted">
                  Resolved by {r.resolvedByDisplayName}
                  {r.resolutionNote ? `, ${r.resolutionNote}` : ""}
                </div>
              ) : null}
              {r.status === "open" ? (
                <div className="mt-2 flex gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => resolve(r.id, "reviewed")}
                    className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-keep-action hover:bg-keep-action/20"
                  >
                    Reviewed (acted on)
                  </button>
                  <button
                    type="button"
                    onClick={() => resolve(r.id, "dismissed")}
                    className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    Dismiss
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* =========================================================
 *  Audit tab, append-only feed of admin/mod actions
 * ========================================================= */
function AuditTab() {
  const [actionFilter, setActionFilter] = useState("");
  // Category preset bundles multiple action strings into a single
  // ?actions= query so the feed can render e.g. "all permission
  // changes" without pasting four names into the text filter.
  // "all" / "" means no preset; the text input still works alongside.
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    const params = new URLSearchParams();
    if (actionFilter) params.set("action", actionFilter);
    const groupActions = AUDIT_ACTION_GROUPS[groupFilter]?.actions ?? [];
    if (groupActions.length > 0) params.set("actions", groupActions.join(","));
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetch(`/admin/audit${qs}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ entries: AuditEntry[] }>;
      })
      .then((j) => { if (!cancelled) setEntries(j.entries); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, [actionFilter, groupFilter, refreshKey]);

  return (
    <section className="space-y-2 text-sm">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="font-action text-base">Audit log</h3>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            aria-label="Audit category"
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5"
          >
            {Object.entries(AUDIT_ACTION_GROUPS).map(([key, group]) => (
              <option key={key} value={key}>{group.label}</option>
            ))}
          </select>
          <input
            type="text"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value.trim())}
            placeholder="Filter by action (e.g. ban)"
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 sm:flex-none"
          />
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="shrink-0 rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5 hover:bg-keep-banner"
          >
            Refresh
          </button>
        </div>
      </header>
      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}
      {entries === null ? (
        <p className="italic text-keep-muted">Loading audit entries...</p>
      ) : entries.length === 0 ? (
        <p className="italic text-keep-muted">No matching entries.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.id} className="rounded border border-keep-rule/60 bg-keep-bg p-2 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span>
                  <span className="font-mono uppercase text-keep-action">{e.action}</span>
                  {" · "}
                  <span className="font-semibold">{e.actorDisplayName}</span>
                  {e.targetDisplayName ? (
                    <>
                      {" → "}
                      <span className="font-semibold">{e.targetDisplayName}</span>
                    </>
                  ) : null}
                  {e.targetRoomName ? (
                    <>
                      {" in "}
                      <span className="italic">{e.targetRoomName}</span>
                    </>
                  ) : null}
                </span>
                <span className="text-keep-muted" title={new Date(e.createdAt).toLocaleString()}>
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
              {e.reason ? <div className="mt-1 italic">"{e.reason}"</div> : null}
              {e.metadata && Object.keys(e.metadata).length > 0 ? (
                <div className="mt-1 font-mono text-[10px] text-keep-muted">
                  {JSON.stringify(e.metadata)}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* =========================================================
 *  Affiliates tab, "Roleplay Communities" card manager (Affiliates v2)
 * =========================================================
 *
 * Card-first manager backed by GET/POST/PATCH/DELETE /admin/affiliates
 * (via the admin lib in lib/affiliates.ts, so every write is audited
 * server-side). Three sections:
 *
 *   1. Pending approvals  — member submissions (status='pending'). Card
 *      preview + owner + submitted URLs, Approve / Reject-with-note.
 *   2. Live cards         — kind='card' structured entries (the ones that
 *      render in the public section). Editable fields, enable/disable,
 *      sort order, delete, read-only in/out click stats + copyable
 *      link-back, plus an "Add card" form for admin-authored entries.
 *   3. Legacy (HTML)      — collapsed section for the old raw-HTML rows
 *      (kind='html'). Admin-trusted verbatim HTML for topsite networks
 *      (toprpsites etc.) whose anchor + tracking-pixel snippet must NOT be
 *      sanitized. Same trust posture as customHeadHtml in Settings. These
 *      render as legacy badges, not cards.
 */

/** Status chip colouring + label, matching the house copy in plan_ext §10. */
function affiliateStatusChip(status: AdminAffiliate["status"]): { label: string; className: string } {
  switch (status) {
    case "pending":
      return { label: "Pending review", className: "border-keep-action/50 bg-keep-action/10 text-keep-action" };
    case "approved":
      return { label: "Live", className: "border-emerald-500/50 bg-emerald-500/10 text-emerald-500" };
    case "rejected":
      return { label: "Needs changes", className: "border-keep-accent/50 bg-keep-accent/10 text-keep-accent" };
    case "disabled":
    default:
      return { label: "Hidden", className: "border-keep-rule bg-keep-panel/40 text-keep-muted" };
  }
}

/** Map an admin row to the public card shape so we can reuse `AffiliateCard`
 *  for a faithful preview (same banner-as-bg + scrim treatment the splash uses). */
function toCardPreview(row: AdminAffiliate): PublicAffiliateCard {
  return {
    id: row.id,
    title: row.title || row.label || "(untitled)",
    description: row.description ?? "",
    iconUrl: row.iconUrl,
    bannerUrl: row.bannerUrl,
    clicksIn: row.clicksIn,
    clicksOut: row.clicksOut,
    tags: row.tags ?? [],
  };
}

function AffiliatesTab() {
  const [rows, setRows] = useState<AdminAffiliate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingCard, setCreatingCard] = useState(false);
  const [creatingLegacy, setCreatingLegacy] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);

  async function load() {
    setError(null);
    try {
      setRows(await fetchAdminAffiliates());
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }
  useEffect(() => { load(); }, []);

  /** Route every write through the admin lib (PATCH/DELETE/POST) so the
   *  server records the audit entry, then refresh. Surfaces failures in the
   *  shared error banner rather than swallowing them. */
  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await adminUpdateAffiliate(id, body);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    }
  }

  async function remove(id: string, prompt: string) {
    if (!window.confirm(prompt)) return;
    try {
      await adminDeleteAffiliate(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  const pending = rows?.filter((r) => r.kind === "card" && r.status === "pending") ?? [];
  const liveCards = rows?.filter((r) => r.kind === "card" && r.status !== "pending") ?? [];
  const legacy = rows?.filter((r) => r.kind === "html") ?? [];

  return (
    <section className="space-y-5 text-sm">
      <header>
        <h3 className="font-action text-base">Top RP Communities</h3>
        <p className="mt-1 text-[11px] text-keep-muted">
          Partner community cards for the splash, ranked by traffic (busiest first). Members submit their own entries
          here for review; approved cards go live in the Top RP Communities section and each one carries a link-back the
          partner puts on their site.
        </p>
      </header>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      {rows === null ? (
        <p className="italic text-keep-muted">Loading...</p>
      ) : (
        <>
          {/* ---- 1. Pending approvals (hidden when the queue is empty) ---- */}
          {pending.length > 0 ? (
            <div className="space-y-2">
              <h4 className="font-action text-sm">
                Pending approvals
                <span className="ml-2 rounded-full border border-keep-action/50 bg-keep-action/10 px-1.5 py-0.5 text-[10px] text-keep-action">
                  {pending.length}
                </span>
              </h4>
              <ul className="space-y-3">
                {pending.map((row) => (
                  <AffiliatePendingItem
                    key={row.id}
                    row={row}
                    onApprove={() => patch(row.id, { status: "approved" })}
                    onReject={(note) => patch(row.id, { status: "rejected", reviewNote: note })}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {/* ---- 2. Live cards + admin "Add card" ---- */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-action text-sm">Live cards</h4>
              <button
                type="button"
                onClick={() => setCreatingCard(true)}
                className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-xs hover:bg-keep-banner/80"
              >
                + Add card
              </button>
            </div>
            {creatingCard ? (
              <AffiliateCardForm
                mode="create"
                onCancel={() => setCreatingCard(false)}
                onSaved={async () => { setCreatingCard(false); await load(); }}
              />
            ) : null}
            {liveCards.length === 0 && !creatingCard ? (
              <p className="italic text-keep-muted">
                No cards yet. Add one, or approve a member submission to surface it in the Top RP Communities section.
              </p>
            ) : (
              <ul className="space-y-3">
                {liveCards.map((row) => (
                  <AffiliateCardItem
                    key={row.id}
                    row={row}
                    onPatch={(body) => patch(row.id, body)}
                    onDelete={() => remove(row.id, "Delete this card? Its click stats and link-back go with it.")}
                  />
                ))}
              </ul>
            )}
          </div>

          {/* ---- 3. Legacy raw-HTML badges (collapsed) ---- */}
          <div className="space-y-2 border-t border-keep-rule/40 pt-4">
            <button
              type="button"
              onClick={() => setLegacyOpen((o) => !o)}
              className="flex w-full items-center gap-2 text-left font-action text-sm"
              aria-expanded={legacyOpen}
            >
              {legacyOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>Legacy badges (HTML)</span>
              <span className="rounded-full border border-keep-rule bg-keep-panel/40 px-1.5 py-0.5 text-[10px] text-keep-muted">
                {legacy.length}
              </span>
            </button>
            {legacyOpen ? (
              <div className="space-y-2 pl-6">
                <p className="text-[11px] text-keep-muted">
                  Old raw-HTML entries from topsite networks (toprpsites etc.). These render as verbatim badges, not
                  cards, and are NOT sanitized so their tracking pixels pass through. Only paste HTML you trust. New
                  partners should use cards instead.
                </p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setCreatingLegacy(true)}
                    className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-xs hover:bg-keep-banner/80"
                  >
                    + Add legacy badge
                  </button>
                </div>
                {creatingLegacy ? (
                  <AffiliateLegacyForm
                    mode="create"
                    onCancel={() => setCreatingLegacy(false)}
                    onSaved={async () => { setCreatingLegacy(false); await load(); }}
                  />
                ) : null}
                {legacy.length === 0 && !creatingLegacy ? (
                  <p className="italic text-keep-muted">No legacy badges.</p>
                ) : (
                  <ul className="space-y-2">
                    {legacy.map((row) => (
                      <AffiliateLegacyItem
                        key={row.id}
                        row={row}
                        onPatch={(body) => patch(row.id, body)}
                        onDelete={() => remove(row.id, "Delete this legacy badge?")}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

/** A copyable read-only field (link-back / submitted URL). Mirrors the
 *  password-copy pattern already in this file: best-effort clipboard with a
 *  brief "Copied" confirmation, falling back to selecting the text. */
function CopyableUrl({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the input is still selectable to copy by hand */
    }
  }
  return (
    <label className="block">
      <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
      <div className="flex gap-1">
        <input
          type="text"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-panel/30 px-2 py-1 text-[11px] outline-none focus:border-keep-action"
        />
        <button
          type="button"
          onClick={copy}
          title="Copy to clipboard"
          aria-label="Copy to clipboard"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
    </label>
  );
}

/** One row in the pending-approvals queue: live card preview + owner +
 *  submitted URLs, with Approve and Reject (reject reveals a note field). */
function AffiliatePendingItem({
  row,
  onApprove,
  onReject,
}: {
  row: AdminAffiliate;
  onApprove: () => Promise<void>;
  onReject: (note: string) => Promise<void>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  }

  return (
    <li className="rounded border border-keep-action/40 bg-keep-bg p-2 text-xs">
      <div className="flex flex-col gap-3 sm:flex-row">
        {/* Card preview — the exact splash treatment. */}
        <div className="w-full shrink-0 sm:w-56">
          <AffiliateCard card={toCardPreview(row)} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="text-[11px] text-keep-muted">
            Submitted by <span className="font-semibold text-keep-text">{row.ownerName ?? "unknown"}</span>
          </div>
          <div className="space-y-1">
            <div className="break-all">
              <span className="text-keep-muted">Target:</span> {row.targetUrl || "(none)"}
            </div>
            {row.iconUrl ? (
              <div className="break-all"><span className="text-keep-muted">Icon:</span> {row.iconUrl}</div>
            ) : null}
            {row.bannerUrl ? (
              <div className="break-all"><span className="text-keep-muted">Banner:</span> {row.bannerUrl}</div>
            ) : null}
          </div>
          {rejecting ? (
            <div className="space-y-1">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="What needs changing? (shown to the submitter)"
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setRejecting(false); setNote(""); }}
                  className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-0.5 hover:bg-keep-banner"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || !note.trim()}
                  onClick={() => run(async () => { await onReject(note.trim()); })}
                  className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-3 py-0.5 text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
                >
                  {busy ? "Rejecting..." : "Confirm reject"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => run(onApprove)}
                className="keep-button rounded border border-emerald-500/50 bg-keep-bg px-3 py-0.5 text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-50"
              >
                {busy ? "Approving..." : "Approve"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setRejecting(true)}
                className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-3 py-0.5 text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** A live structured card row: preview + status chip + owner + read-only
 *  in/out stats + copyable link-back, with enable/disable, edit, delete. */
function AffiliateCardItem({
  row,
  onPatch,
  onDelete,
}: {
  row: AdminAffiliate;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const chip = affiliateStatusChip(row.status);
  // Prefer the server-approved absolute link-back; fall back to composing one
  // from the hash so the field is copyable the moment a hash exists.
  const backUrl = row.linkBackUrl ?? (row.hash ? linkBackUrl(row.hash) : null);

  if (editing) {
    return (
      <li>
        <AffiliateCardForm
          mode="edit"
          initial={row}
          onCancel={() => setEditing(false)}
          onSaved={async (body) => { await onPatch(body); setEditing(false); }}
        />
      </li>
    );
  }

  return (
    <li className="rounded border border-keep-rule/60 bg-keep-bg p-2 text-xs">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="w-full shrink-0 sm:w-56">
          <AffiliateCard card={toCardPreview(row)} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{row.title || row.label || "(untitled)"}</span>
            <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${chip.className}`}>{chip.label}</span>
            <span className="text-[10px] text-keep-muted">
              {row.ownerName ? `by ${row.ownerName}` : "admin-authored"}
            </span>
          </div>

          {/* Read-only traffic counters (both directions). */}
          <div className="flex gap-4 text-[11px] text-keep-muted">
            <span title="Visits sent to us">in: <span className="text-keep-text">{row.clicksIn.toLocaleString()}</span></span>
            <span title="Visits we sent them">out: <span className="text-keep-text">{row.clicksOut.toLocaleString()}</span></span>
          </div>

          {row.reviewNote ? (
            <div className="text-[11px] text-keep-muted">Last note: {row.reviewNote}</div>
          ) : null}

          {backUrl ? (
            <CopyableUrl label="Link-back (partner puts this on their site)" url={backUrl} />
          ) : (
            <p className="text-[11px] italic text-keep-muted">No link-back yet (assigned on approval).</p>
          )}

          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => onPatch({ status: row.status === "disabled" ? "approved" : "disabled" })}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
            >
              {row.status === "disabled" ? "Enable" : "Disable"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

/** Create / edit a structured card. On create, posts an admin-authored card
 *  (server auto-approves it, ownerUserId=null); on edit, hands the changed
 *  fields up to the parent's PATCH. */
function AffiliateCardForm({
  mode,
  initial,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: AdminAffiliate;
  onCancel: () => void;
  onSaved: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [iconUrl, setIconUrl] = useState(initial?.iconUrl ?? "");
  const [bannerUrl, setBannerUrl] = useState(initial?.bannerUrl ?? "");
  const [targetUrl, setTargetUrl] = useState(initial?.targetUrl ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Optional URLs may be blank; when present they must be safe http/https.
  const targetOk = isValidAffiliateUrl(targetUrl);
  const iconOk = !iconUrl.trim() || isValidAffiliateUrl(iconUrl);
  const bannerOk = !bannerUrl.trim() || isValidAffiliateUrl(bannerUrl);
  const canSubmit = !!title.trim() && !!description.trim() && targetOk && iconOk && bannerOk;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    // Blank optionals go up as null so an admin can clear an existing icon/banner.
    const body: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim(),
      iconUrl: iconUrl.trim() || null,
      bannerUrl: bannerUrl.trim() || null,
      targetUrl: targetUrl.trim(),
      tags,
    };
    try {
      if (mode === "create") {
        await adminCreateAffiliate({ kind: "card", ...body });
        await onSaved(body);
      } else {
        await onSaved(body);
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg p-2 text-xs">
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{err}</div>
      ) : null}
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={AFFILIATE_LIMITS.title}
          placeholder="e.g. The Sunken Court"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={AFFILIATE_LIMITS.description}
          rows={2}
          placeholder="A short blurb shown on the card."
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Target URL</span>
        <input
          type="url"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          maxLength={AFFILIATE_LIMITS.url}
          placeholder="https://partner.example"
          className={`w-full rounded border bg-keep-bg px-2 py-1 outline-none focus:border-keep-action ${
            targetUrl && !targetOk ? "border-keep-accent" : "border-keep-rule"
          }`}
        />
        {targetUrl && !targetOk ? (
          <span className="mt-0.5 block text-[10px] text-keep-accent">Must be a http(s) link.</span>
        ) : null}
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Icon URL (optional)</span>
          <input
            type="url"
            value={iconUrl}
            onChange={(e) => setIconUrl(e.target.value)}
            maxLength={AFFILIATE_LIMITS.url}
            placeholder="https://.../icon.png"
            className={`w-full rounded border bg-keep-bg px-2 py-1 outline-none focus:border-keep-action ${
              iconUrl && !iconOk ? "border-keep-accent" : "border-keep-rule"
            }`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Banner URL (optional)</span>
          <input
            type="url"
            value={bannerUrl}
            onChange={(e) => setBannerUrl(e.target.value)}
            maxLength={AFFILIATE_LIMITS.url}
            placeholder="https://.../banner.jpg"
            className={`w-full rounded border bg-keep-bg px-2 py-1 outline-none focus:border-keep-action ${
              bannerUrl && !bannerOk ? "border-keep-accent" : "border-keep-rule"
            }`}
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Tags</span>
        <TagInput tags={tags} onChange={setTags} />
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-0.5 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !canSubmit}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
        >
          {busy ? "Saving..." : mode === "create" ? "Create" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** One legacy raw-HTML badge row. Preserves the original enable/disable +
 *  delete behaviour and the verbatim HTML preview (admin-trusted, unsanitized). */
function AffiliateLegacyItem({
  row,
  onPatch,
  onDelete,
}: {
  row: AdminAffiliate;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li>
        <AffiliateLegacyForm
          mode="edit"
          initial={row}
          onCancel={() => setEditing(false)}
          onSaved={async (body) => { await onPatch(body); setEditing(false); }}
        />
      </li>
    );
  }
  return (
    <li className="rounded border border-keep-rule/60 bg-keep-bg p-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <span className={`mr-2 inline-block h-2 w-2 rounded-full ${row.enabled ? "bg-keep-action" : "bg-keep-rule"}`} />
          <span className="font-semibold">{row.label}</span>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onPatch({ enabled: !row.enabled })}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
          >
            {row.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
          >
            Delete
          </button>
        </div>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-keep-muted">HTML preview</summary>
        <div
          className="mt-1 rounded border border-keep-rule/40 bg-keep-panel/30 p-2 [&_img]:max-h-12"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: row.html ?? "" }}
        />
        <pre className="mt-1 overflow-x-auto rounded bg-keep-panel/30 p-2 text-[10px] text-keep-muted">{row.html ?? ""}</pre>
      </details>
    </li>
  );
}

/** Create / edit a legacy raw-HTML badge (label + verbatim HTML snippet). */
function AffiliateLegacyForm({
  mode,
  initial,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: AdminAffiliate;
  onCancel: () => void;
  onSaved: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [html, setHtml] = useState(initial?.html ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim() || !html.trim()) return;
    setBusy(true);
    setErr(null);
    const body: Record<string, unknown> = { label: label.trim(), html, enabled };
    try {
      if (mode === "create") {
        await adminCreateAffiliate({ kind: "html", ...body });
        await onSaved(body);
      } else {
        await onSaved(body);
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg p-2 text-xs">
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{err}</div>
      ) : null}
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Label (admin-only)</span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
          placeholder="e.g. Top RP Sites"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">HTML snippet</span>
        <textarea
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          rows={6}
          placeholder='<a href="..."><img src="..." alt="..." /></a>'
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-keep-action"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          Paste verbatim from the affiliate's provided code. Tracking pixels and similar pass through unchanged.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Enabled</span>
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-0.5 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !label.trim() || !html.trim()}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
        >
          {busy ? "Saving..." : mode === "create" ? "Create" : "Save"}
        </button>
      </div>
    </form>
  );
}
