import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle, Search } from "lucide-react";
import type { PermissionKey } from "@thekeep/shared";
import { isMasterAdminRole } from "@thekeep/shared";
import { recordNav } from "../../lib/nav-metrics.js";
import { TabBtn } from "../shared/TabBtn.js";
import { groupVisibleTabs, withGroupSeparators } from "../shared/tabGroups.js";
import { ContextualTour } from "../tours/ContextualTour.js";
import { useChat } from "../../state/store.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { FloatingWindow } from "../shared/FloatingWindow.js";
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
import { FindSetting, flashAnchor } from "./FindSetting.js";
import { ADMIN_SEARCH_ENTRIES, ADMIN_SEARCH_REDIRECTS, type AdminSearchEntry, type AnalyticsSubtab, type SettingsSubtab } from "./adminSearchIndex.js";

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

/** The panel's tab ids. Exported (as a type only) for the find-a-setting
 *  index (adminSearchIndex.ts), which maps catalog keys onto tabs. The id
 *  VALUES are load-bearing (permission gates, `recordNav` keys, tours) and
 *  never change. */
export type AdminTab = "overview" | "analytics" | "settings" | "branding" | "rules" | "links" | "affiliates" | "users" | "reports" | "mod-cases" | "verify-logs" | "scriptorium" | "forums" | "servers" | "audit" | "system" | "backups" | "permissions" | "email";
type Tab = AdminTab;

/** Tab grouping for the strip's section dividers. Each tab carries
 *  the id of the group it belongs to; the render walks the list
 *  inserting visual separators wherever the group changes. Groups
 *  also drive the mobile dropdown's `<optgroup>` labels so the
 *  same mental model surfaces on both layouts. Group ids are
 *  display-only (never persisted, never sent on the wire). */
type TabGroup = "monitor" | "people" | "content" | "siteconfig" | "growth" | "system";

/** i18n keys for the group labels (admin ns). The English values live in
 *  `packages/shared/locales/en/admin.json` under `panel.group.*`. */
const TAB_GROUP_LABEL_KEY: Record<TabGroup, string> = {
  monitor: "panel.group.monitor",
  people: "panel.group.people",
  content: "panel.group.content",
  siteconfig: "panel.group.siteconfig",
  growth: "panel.group.growth",
  system: "panel.group.system",
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
  group: TabGroup;
  masterOnly?: boolean;
  permission?: PermissionKey;
}> = [
  // ----- Monitor: surfaces for the moderation-queue workflow -----
  // Tab display labels come from the admin catalog (`panel.tab.<id>`),
  // rendered via t() at the two picker call sites below.
  { id: "overview", group: "monitor" },
  { id: "analytics", group: "monitor", permission: "view_admin_analytics" },
  { id: "audit", group: "monitor" },
  { id: "reports", group: "monitor" },
  { id: "mod-cases", group: "monitor", permission: "view_admin_mod_cases" },
  { id: "verify-logs", group: "monitor", permission: "verify_export_logs" },

  // ----- People & access: who can do what -----
  // Permissions ships first because the workflow is "set policy then
  // apply it", admins typically pick a role's grant set before
  // touching individual user rows.
  { id: "permissions", group: "people", permission: "view_admin_permissions" },
  { id: "users", group: "people" },

  // ----- Content & community: catalogs the community engages with -----
  // Rooms, Commands, Titles, Emoticons, Announcements, FAQs, AND EARNING are now
  // PER-SERVER (Admin Partition — plan_ext.md; "nothing stays global"): every
  // server (incl. The Spire) manages its own ranks/cosmetics/items/grants in its
  // Server Admin → Earning tab. Global staff reach any server's via the Servers
  // tab → "Open admin". Reports keeps the DM/profile queue here (message reports
  // are per-server). Scriptorium stays (a platform writing feature, not chat).
  { id: "scriptorium", group: "content" },
  { id: "forums", group: "content", permission: "view_admin_forums" },
  { id: "servers", group: "content", permission: "view_admin_servers" },

  // ----- Site configuration: install-level chrome -----
  { id: "settings", group: "siteconfig", permission: "view_admin_settings" },
  { id: "branding", group: "siteconfig", permission: "view_admin_branding" },
  { id: "rules", group: "siteconfig", permission: "view_admin_rules" },
  { id: "links", group: "siteconfig" },

  // ----- Growth & email: reaching members and bringing new ones in -----
  { id: "email", group: "growth", permission: "view_admin_email" },
  { id: "affiliates", group: "growth" },

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
  { id: "system", group: "system", permission: "view_system_metrics" },
  { id: "backups", group: "system", permission: "view_admin_backups" },
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

/** Tab id → group id, for the search hits' breadcrumb line. Derived from
 *  TAB_ITEMS so it can never drift from the registry. */
const TAB_GROUP_BY_ID = Object.fromEntries(
  TAB_ITEMS.map((item) => [item.id, item.group]),
) as Record<Tab, TabGroup>;

/** The full find-a-setting index: one tab-level entry per registered tab
 *  (derived, never hand-listed — docs/ADMIN_IA.md §5.4) plus the curated
 *  row-level entries from adminSearchIndex.ts. */
const ALL_SEARCH_ENTRIES: readonly AdminSearchEntry[] = [
  ...TAB_ITEMS.map((item) => ({
    key: `panel.tab.${item.id}`,
    tab: item.id,
    also: [`panel.tabDesc.${item.id}`],
  })),
  ...ADMIN_SEARCH_ENTRIES,
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

// groupVisibleTabs / withGroupSeparators moved to ../shared/tabGroups.ts
// (docs/ADMIN_IA.md §6) so the Server Admin console shares the same
// grouped-strip + optgroup helpers. Pure move; behaviour unchanged.

export function AdminPanel({ onClose, onLinksChanged, onOpenServerConsole, onEnterServer }: Props) {
  const { t } = useTranslation("admin");
  const [tab, setTab] = useState<Tab>("overview");
  // Analytics choke point 4 (plan_ext.md §3): sub-tab switches. Route both the
  // desktop tab strip and the mobile <select> through one helper so the "which
  // admin section do people actually use" signal is captured in a single place
  // (the tab id is a stable enum, never free text).
  const changeTab = (next: Tab) => {
    if (next !== tab) recordNav("tab", `admin:${next}`);
    // A plain tab hop abandons any armed find-a-setting jump so a stale
    // anchor can't scroll/flash the next time that tab renders. pickFind
    // re-arms AFTER calling this (same batch), so search jumps still land.
    setPendingFind(null);
    setSettingsFind(null);
    setAnalyticsFind(null);
    setTab(next);
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

  // ----- Find-a-setting search (docs/ADMIN_IA.md §5) -----
  // The visible-tab list is computed once per render and shared by the two
  // pickers below and the search filter, so a viewer never sees a hit for
  // a tab they cannot open (same `tabVisible` predicate everywhere).
  const visibleTabs = TAB_ITEMS.filter((item) => tabVisible(item, isMaster, mePermissions));
  const visibleTabIds = useMemo(
    () => new Set<string>(TAB_ITEMS.filter((item) => tabVisible(item, isMaster, mePermissions)).map((item) => item.id)),
    [isMaster, mePermissions],
  );
  // Mobile: the header swaps to a full-width search row while open.
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  // Armed jump for non-settings tabs: after the picked tab's body mounts,
  // scroll to its data-admin-anchor and flash it, then disarm. Settings
  // jumps ride a prop into SettingsTab instead (it owns the subtab state).
  const [pendingFind, setPendingFind] = useState<{ tab: Tab; anchor: string } | null>(null);
  const [settingsFind, setSettingsFind] = useState<{ subtab: SettingsSubtab; anchor: string } | null>(null);
  // Analytics jumps ride a prop into AnalyticsTab the same way Settings
  // jumps do — that tab owns its subtab state (mounted-hidden sections).
  const [analyticsFind, setAnalyticsFind] = useState<{ subtab: AnalyticsSubtab; anchor: string } | null>(null);
  const desktopSearchRef = useRef<HTMLInputElement>(null);
  // Breadcrumb pieces for a search hit: group › tab (› settings subtab).
  // All already-translated; FindSetting adds the aria-hidden separators.
  const searchBreadcrumb = useCallback(
    (entry: AdminSearchEntry): readonly string[] => {
      const pieces = [t(TAB_GROUP_LABEL_KEY[TAB_GROUP_BY_ID[entry.tab]]), t(`panel.tab.${entry.tab}`)];
      if (entry.subtab) pieces.push(t(`settings.subtab.${entry.subtab}`));
      if (entry.analyticsSubtab) pieces.push(t(`analytics.subtab.${entry.analyticsSubtab}`));
      return pieces;
    },
    [t],
  );
  // Picking a hit reuses the existing changeTab choke point (same
  // recordNav key, same silent-drop of unsaved edits as a plain tab
  // click). Tab-level hits stop at the switch; row hits arm the jump.
  const pickFind = (entry: AdminSearchEntry) => {
    changeTab(entry.tab);
    if (entry.key.startsWith("panel.tab.")) return;
    if (entry.tab === "settings") {
      setSettingsFind({ subtab: entry.subtab ?? "accounts", anchor: entry.key });
    } else if (entry.tab === "analytics") {
      setAnalyticsFind({ subtab: entry.analyticsSubtab ?? "overview", anchor: entry.key });
    } else {
      setPendingFind({ tab: entry.tab, anchor: entry.key });
    }
  };
  // Generic (non-settings) jump: most tab bodies render a loading
  // placeholder until their first fetch resolves, so the anchor usually
  // does NOT exist two frames after the switch — a one-shot flash missed
  // under real latency and the pick degraded to a bare tab change. Poll
  // once per frame until flashAnchor lands (returns true) or the deadline
  // passes, then disarm. Navigating away mid-poll disarms too (the
  // mismatch branch), so a stale anchor can never flash on a later visit.
  // A permanently missing anchor is still silently fine — the user lands
  // on the right tab, just without the flash.
  useEffect(() => {
    if (!pendingFind) return;
    if (pendingFind.tab !== tab) {
      setPendingFind(null);
      return;
    }
    const deadline = Date.now() + 2500;
    let raf = 0;
    const tick = () => {
      if (flashAnchor(pendingFind.anchor, reduceMotion) || Date.now() > deadline) {
        setPendingFind(null);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pendingFind, tab, reduceMotion]);
  const onSettingsFindHandled = useCallback(() => setSettingsFind(null), []);
  const onAnalyticsFindHandled = useCallback(() => setAnalyticsFind(null), []);
  // Keyboard path: Ctrl/Cmd+K anywhere inside the panel focuses the
  // search (desktop) or opens the mobile search row, which autofocuses.
  const onShellKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
      zIndex={50}
      title={t("panel.title")}
      onKeyDown={onShellKeyDown}
      className="keep-frame rounded border border-keep-border bg-keep-parchment"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
              The dropdown groups visible tabs into `<optgroup>`s keyed
              on the tab's `group` field so the same six-group mental
              model (docs/ADMIN_IA.md §2: Keeping watch / Members & roles
              / Communities & content / Site setup / Growth & email /
              Backups & maintenance) surfaces on both layouts. */}
          <div className="flex items-center gap-2 px-2 py-2 [@container(min-width:768px)]:hidden">
            {mobileSearchOpen ? (
              /* Find-a-setting, mobile: the search row swaps in over the
                 normal title + dropdown row; picking a hit or tapping the
                 X swaps the normal row back. The input autofocuses. */
              <FindSetting
                layout="mobile"
                entries={ALL_SEARCH_ENTRIES}
                redirects={ADMIN_SEARCH_REDIRECTS}
                resolve={t}
                breadcrumb={searchBreadcrumb}
                visibleTabIds={visibleTabIds}
                onPick={pickFind}
                onClose={() => setMobileSearchOpen(false)}
              />
            ) : (
              <>
                <select
                  value={tab}
                  onChange={(e) => changeTab(e.target.value as Tab)}
                  aria-label={t("panel.sectionAria")}
                  className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
                >
                  {groupVisibleTabs(visibleTabs).map(
                    ([group, items]) => (
                      <optgroup key={group} label={t(TAB_GROUP_LABEL_KEY[group])}>
                        {items.map((item) => (
                          <option key={item.id} value={item.id}>{t(`panel.tab.${item.id}`)}</option>
                        ))}
                      </optgroup>
                    ),
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => setMobileSearchOpen(true)}
                  title={t("panel.search.open")}
                  aria-label={t("panel.search.open")}
                  className="keep-button shrink-0 rounded border border-keep-rule bg-keep-banner/40 p-1 text-keep-muted hover:bg-keep-banner hover:text-keep-text"
                >
                  <Search className="h-4 w-4" aria-hidden />
                </button>
              </>
            )}
          </div>

          {/* Desktop: WRAPPING tab strip + find-a-setting. The panel lives
              in a resizable floating window now, so a fixed one-row strip
              clips its tail behind a hidden scrollbar at narrow widths;
              wrapping keeps every tab reachable at any window size. A
              hairline vertical separator renders between groups so the
              eye can pick out the five clusters without reading every
              label first. The walk threads the visible-tab list through
              `withGroupSeparators` so a hidden tab (gated out by a
              missing permission) doesn't leave an orphaned divider. */}
          <div className="hidden items-center gap-2 px-4 py-2 [@container(min-width:768px)]:flex">
            <nav data-tour="admin-tab-strip" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs uppercase tracking-widest">
              {withGroupSeparators(visibleTabs).map(
                (entry) =>
                  entry.kind === "separator" ? (
                    <span
                      key={`sep:${entry.afterGroup}`}
                      aria-hidden
                      className="mx-1 h-4 w-px shrink-0 self-center bg-keep-rule/60"
                      title={t(TAB_GROUP_LABEL_KEY[entry.afterGroup])}
                    />
                  ) : (
                    <TabBtn
                      key={entry.tab.id}
                      includeShrink
                      active={tab === entry.tab.id}
                      onClick={() => changeTab(entry.tab.id)}
                      {...(TAB_TOUR_ANCHOR[entry.tab.id] ? { tourAnchor: TAB_TOUR_ANCHOR[entry.tab.id] } : {})}
                    >
                      {t(`panel.tab.${entry.tab.id}`)}
                    </TabBtn>
                  ),
              )}
            </nav>
            {/* Find-a-setting, desktop: type what you're looking for and
                jump straight to the tab (and row) that owns it. Results
                pop over the body, anchored under the input. Ctrl/Cmd+K
                focuses it from anywhere in the panel. */}
            <FindSetting
              layout="desktop"
              entries={ALL_SEARCH_ENTRIES}
              redirects={ADMIN_SEARCH_REDIRECTS}
              resolve={t}
              breadcrumb={searchBreadcrumb}
              visibleTabIds={visibleTabIds}
              onPick={pickFind}
              inputRef={desktopSearchRef}
            />
            {/* Replay the first-run walkthrough. Sits between the strip and
                the close button so a keeper can re-run the tour any time. */}
            <button
              type="button"
              onClick={() => setForcedTourId("site-admin")}
              title={t("panel.replayTour")}
              aria-label={t("panel.replayTour")}
              className="keep-button shrink-0 rounded border border-keep-rule bg-keep-banner/40 p-1 text-keep-muted hover:bg-keep-banner hover:text-keep-text"
            >
              <HelpCircle className="h-4 w-4" aria-hidden />
            </button>
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
            {/* One-line "what you do here" for the active tab, rendered by
                the shell for every tab (one code path, no per-tab edits).
                Scrolls with the body; same treatment on mobile + desktop. */}
            <p className="mb-3 text-[11px] text-keep-muted">{t(`panel.tabDesc.${tab}`)}</p>
            {/* Home-server scope note. With multi-server ON these tabs manage
                the HOME server only — their per-server twins live in each
                server's own console — so flag a clear scope rather than let
                staff assume a tab spans every server. Suppressed when the
                feature is off (there's only one server then). */}
            {serversEnabled && HOME_SERVER_SCOPED_TABS.has(tab) ? (
              <p className="mb-3 rounded border border-keep-rule bg-keep-panel/40 px-3 py-1.5 text-[11px] text-keep-muted">
                {t("panel.homeServerScope")}
              </p>
            ) : null}
            {/* Body render gates mirror the tab-strip visibility
                helper so a user with a deep-linked stale tab id
                can't render a panel they don't have access to. */}
            {tab === "overview" ? <OverviewTab /> : null}
            {tab === "analytics" && canSeeTab("view_admin_analytics") ? <AnalyticsTab findRequest={analyticsFind} onFindHandled={onAnalyticsFindHandled} /> : null}
            {tab === "settings" && canSeeTab("view_admin_settings") ? <SettingsTab findRequest={settingsFind} onFindHandled={onSettingsFindHandled} /> : null}
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
                {t("common:close")}
              </button>
            </>
          )}
        </div>
      </div>
    </FloatingWindow>
  );
}
