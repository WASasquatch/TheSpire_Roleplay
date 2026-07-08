import { useMemo, useState, type ReactNode } from "react";
import { HelpCircle } from "lucide-react";
import type { PermissionKey } from "@thekeep/shared";
import { isMasterAdminRole } from "@thekeep/shared";
import { recordNav } from "../../lib/nav-metrics.js";
import { TabBtn } from "../shared/TabBtn.js";
import { AdminBackupsTab } from "./AdminBackupsTab.js";
import { AdminSystemTab } from "./AdminSystemTab.js";
import { AdminVerifyLogTab } from "./AdminVerifyLogTab.js";
import { AdminScriptoriumTab } from "./AdminScriptoriumTab.js";
import { AdminForumsTab } from "./AdminForumsTab.js";
import { AdminServersTab } from "./AdminServersTab.js";
import { AdminPermissionsTab } from "./AdminPermissionsTab.js";
import { AdminModCasesTab } from "./AdminModCasesTab.js";
import { AdminEmailTab } from "./AdminEmailTab.js";
import { AnalyticsTab } from "./AnalyticsTab.js";
import { ContextualTour } from "../tours/ContextualTour.js";
import { Modal, MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { useChat } from "../../state/store.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { CloseButton } from "../shared/CloseButton.js";
import { AdminShellContext, type AdminShellAPI } from "./adminShell.js";
import { OverviewTab } from "./AdminOverviewTab.js";
import { SettingsTab } from "./AdminSettingsTab.js";
import { BrandingTab } from "./AdminBrandingTab.js";
import { RulesTab } from "./AdminRulesTab.js";
import { LinksTab } from "./AdminLinksTab.js";
import { UsersTab } from "./AdminUsersTab.js";
import { ReportsTab } from "./AdminReportsTab.js";
import { AuditTab } from "./AdminAuditTab.js";
import { AffiliatesTab } from "./AdminAffiliatesTab.js";

// Re-export the shared admin-shell primitives + the style picker on their
// original import path so existing importers of "./AdminPanel.js" keep working
// after the god-file split (move-only relocation; see Phase 3 §4.3).
export { useAdminShell, AdminSaveFooter } from "./adminShell.js";
export { StylePicker } from "../StylePicker.js";

interface Props {
  onClose: () => void;
  /** Bumped after any change so the banner re-fetches. */
  onLinksChanged: () => void;
  /** Open a server's per-server admin console (Servers tab oversight drill-in). */
  onOpenServerConsole?: (serverId: string) => void;
  /** Step into a server's chat rooms to moderate (Servers tab; global staff). */
  onEnterServer?: (serverId: string, name: string) => void;
}

type Tab = "overview" | "analytics" | "settings" | "branding" | "rules" | "links" | "affiliates" | "users" | "reports" | "mod-cases" | "verify-logs" | "scriptorium" | "forums" | "servers" | "audit" | "system" | "backups" | "permissions" | "email";

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
  { id: "analytics", label: "Analytics", group: "monitor", permission: "view_admin_analytics" },
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

/** Site-admin contextual-tour anchors. Maps a tab id to the
 *  `data-tour` value the tour's step targets. Only the tabs the tour
 *  actually spotlights are listed; every other tab renders without an
 *  anchor. The strip walk stamps `data-tour={TAB_TOUR_ANCHOR[id]}` onto
 *  the matching tab button so the tour lands on a persistent element
 *  (the whole strip stays mounted regardless of which tab is active). */
const TAB_TOUR_ANCHOR: Partial<Record<Tab, string>> = {
  overview: "admin-tab-overview",
  users: "admin-tab-users",
  servers: "admin-tab-servers",
  forums: "admin-tab-forums",
  settings: "admin-tab-settings",
};

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

export function AdminPanel({ onClose, onLinksChanged, onOpenServerConsole, onEnterServer }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  // Analytics choke point 4 (plan_ext.md §3): sub-tab switches. Route both the
  // desktop tab strip and the mobile <select> through one helper so the "which
  // admin section do people actually use" signal is captured in a single place
  // (the tab id is a stable enum, never free text).
  const changeTab = (t: Tab) => {
    if (t !== tab) recordNav("tab", `admin:${t}`);
    setTab(t);
  };
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
  // Replay hook for the site-admin contextual tour. The "?" button in the
  // desktop tab strip calls this to re-run the walkthrough while the panel
  // is open; <ContextualTour> below drives the actual overlay.
  const setForcedTourId = useChat((s) => s.setForcedTourId);
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
              onChange={(e) => changeTab(e.target.value as Tab)}
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
            <nav data-tour="admin-tab-strip" className="keep-scroll-strip flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs uppercase tracking-widest">
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
                    <TabBtn
                      key={entry.tab.id}
                      includeShrink
                      active={tab === entry.tab.id}
                      onClick={() => changeTab(entry.tab.id)}
                      {...(TAB_TOUR_ANCHOR[entry.tab.id] ? { tourAnchor: TAB_TOUR_ANCHOR[entry.tab.id] } : {})}
                    >
                      {entry.tab.label}
                    </TabBtn>
                  ),
              )}
            </nav>
            {/* Replay the first-run walkthrough. Sits between the strip and
                the close button so a keeper can re-run the tour any time. */}
            <button
              type="button"
              onClick={() => setForcedTourId("site-admin")}
              title="Replay the admin tour"
              aria-label="Replay the admin tour"
              className="keep-button shrink-0 rounded border border-keep-rule bg-keep-banner/40 p-1 text-keep-muted hover:bg-keep-banner hover:text-keep-text"
            >
              <HelpCircle className="h-4 w-4" aria-hidden />
            </button>
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
            {tab === "analytics" && canSeeTab("view_admin_analytics") ? <AnalyticsTab /> : null}
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

        {/* First-run contextual tour for the whole panel. Mounted
            unconditionally with `active` true because AdminPanel only
            renders while the panel is open, so "on screen" and "mounted"
            coincide. Self-fires when unseen, no-ops otherwise, and re-runs
            when the strip's "?" button sets the forced tour id. */}
        <ContextualTour tourId="site-admin" active />

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
