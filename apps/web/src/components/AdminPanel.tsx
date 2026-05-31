import { createContext, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import DOMPurify from "dompurify";
import type { AuditEntry, PermissionKey, ProfileView, ReportEntry, Role, Theme, ThemeableTextSlot, ThreadCategory } from "@thekeep/shared";
import { AUDIT_ACTION_GROUPS, THEME_PRESETS } from "@thekeep/shared";
import {
  DEFAULT_THEME,
  CUSTOM_CMD_CSS_MAX_LEN,
  customCmdCssToStyle,
  isMasterAdminRole,
  normalizeTheme,
  resolveMessageColor,
  sanitizeCustomCmdCss,
  THEMEABLE_TEXT_SLOTS,
} from "@thekeep/shared";
import { useActiveTheme } from "../lib/theme.js";
import { readError } from "../lib/http.js";
import { parseInline } from "../lib/markdown.js";
import { listStyles } from "../lib/ornaments/index.js";
import { AdminEarningTab } from "./AdminEarningTab.js";
import { AdminBackupsTab } from "./AdminBackupsTab.js";
import { AdminScriptoriumTab } from "./AdminScriptoriumTab.js";
import { AdminEmoticonsTab } from "./AdminEmoticonsTab.js";
import { AdminPermissionsTab } from "./AdminPermissionsTab.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { ProfileModal } from "./ProfileModal.js";
import { ThemePicker } from "./ThemePicker.js";
import { useChat } from "../state/store.js";
import { useEarning } from "../state/earning.js";
import { CloseButton } from "./CloseButton.js";

interface Props {
  onClose: () => void;
  /** Bumped after any change so the banner re-fetches. */
  onLinksChanged: () => void;
}

type Tab = "overview" | "settings" | "branding" | "rules" | "links" | "affiliates" | "rooms" | "commands" | "titles" | "earning" | "users" | "reports" | "scriptorium" | "emoticons" | "audit" | "backups" | "permissions";

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

  // ----- People & access: who can do what -----
  // Permissions ships first because the workflow is "set policy then
  // apply it" — admins typically pick a role's grant set before
  // touching individual user rows.
  { id: "permissions", label: "Permissions", group: "people", permission: "view_admin_permissions" },
  { id: "users", label: "Users", group: "people" },
  { id: "rooms", label: "Rooms", group: "people" },

  // ----- Content & community: catalogs the community engages with -----
  { id: "earning", label: "Earning", group: "content" },
  { id: "emoticons", label: "Emoticons", group: "content" },
  { id: "scriptorium", label: "Scriptorium", group: "content" },
  { id: "commands", label: "Commands", group: "content" },
  { id: "titles", label: "Titles", group: "content" },

  // ----- Site configuration: install-level chrome -----
  { id: "settings", label: "Settings", group: "siteconfig", permission: "view_admin_settings" },
  { id: "branding", label: "Branding", group: "siteconfig", permission: "view_admin_branding" },
  { id: "rules", label: "Rules", group: "siteconfig", permission: "view_admin_rules" },
  { id: "links", label: "Nav Links", group: "siteconfig" },
  { id: "affiliates", label: "Affiliates", group: "siteconfig" },

  // ----- System: destructive paths land last so a misclick on the
  //       strip can't take you here by accident. -----
  // Backups carries the destructive Restore / Import paths that can
  // blow away the whole DB. The matrix seed pins
  // `view_admin_backups` to masteradmin-only; the granular key gives
  // the option of granting it to a delegate without elevating the
  // delegate to full masteradmin.
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
 *  rejected at the type level via the discriminated-union shape — a
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
 *  desktop strip. Empty groups drop out entirely — a viewer whose
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
 * back to the default footer — a lone Close button on the right.
 */
interface AdminShellAPI {
  setFooter: (node: ReactNode | null) => void;
  close: () => void;
}
const AdminShellContext = createContext<AdminShellAPI | null>(null);

/**
 * Hook for tabs to register footer content. Returns null when called
 * outside the AdminPanel shell (tabs can render in isolation in
 * tests / Storybook without crashing) — callers should defensive-
 * check before using `setFooter` / `close`.
 */
export function useAdminShell(): AdminShellAPI | null {
  return useContext(AdminShellContext);
}

/**
 * Standard footer cluster for the three save-form tabs (Settings,
 * Branding, Rules). They all share the same shape — status text on
 * the left, Cancel + Save on the right — so the helper keeps the
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
          ? (readOnlyHint ?? "Read-only — you don't have permission to save changes here.")
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

export function AdminPanel({ onClose, onLinksChanged }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  // Master-admin gating for the destructive-control tabs. A plain
  // `admin` keeps moderation tools (rooms, users, reports, audit,
  // titles, commands, nav links, affiliates) but loses Settings,
  // Branding, and Rules — the three surfaces that let an attacker
  // materially damage the public face of the site, change caps that
  // affect every user, or rewrite legal/policy text. The two
  // `masterOnly*` references below are also used downstream by
  // UsersTab to hide email / disable / masteradmin-role controls.
  const isMaster = useChat((s) => isMasterAdminRole(s.me?.role ?? "user"));
  // Resolved permission set for the viewer. Drives the
  // `permission`-keyed tab visibility filter in `tabVisible`. Read
  // from the store via the AuthMe payload — refreshes on the /auth/me
  // poll, same as the rest of `me`.
  const mePermissions = useChat((s) => s.me?.permissions ?? []);
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
  // changes — which means tabs' useEffects don't re-fire on every
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
            with the close button glued to its right edge — earlier
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
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto p-3 sm:p-4">
            {/* Body render gates mirror the tab-strip visibility
                helper so a user with a deep-linked stale tab id
                can't render a panel they don't have access to. */}
            {tab === "overview" ? <OverviewTab /> : null}
            {tab === "settings" && canSeeTab("view_admin_settings") ? <SettingsTab /> : null}
            {tab === "branding" && canSeeTab("view_admin_branding") ? <BrandingTab /> : null}
            {tab === "rules" && canSeeTab("view_admin_rules") ? <RulesTab /> : null}
            {tab === "links" ? <LinksTab onLinksChanged={onLinksChanged} /> : null}
            {tab === "affiliates" ? <AffiliatesTab /> : null}
            {tab === "commands" ? <CommandsTab /> : null}
            {tab === "titles" ? <TitleKindsTab /> : null}
            {tab === "earning" ? <AdminEarningTab /> : null}
            {tab === "rooms" ? <RoomsTab /> : null}
            {tab === "users" ? <UsersTab /> : null}
            {tab === "reports" ? <ReportsTab /> : null}
            {tab === "scriptorium" ? <AdminScriptoriumTab /> : null}
            {tab === "emoticons" ? <AdminEmoticonsTab /> : null}
            {tab === "audit" ? <AuditTab /> : null}
            {tab === "backups" && canSeeTab("view_admin_backups") ? <AdminBackupsTab /> : null}
            {tab === "permissions" && canSeeTab("view_admin_permissions") ? <AdminPermissionsTab /> : null}
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
      // size inside the scrolling nav — without these, tabs would
      // squish to single letters before the strip would start scrolling.
      className={`shrink-0 whitespace-nowrap rounded border border-keep-rule px-2 py-0.5 ${active ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
    >
      {children}
    </button>
  );
}

/**
 * Shared style-key picker. Reads available styles from the ornaments
 * registry so the catalog stays single-sourced — adding a style file
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
  /** Author edit/delete grace window in ms for chat + DM messages. */
  editGraceMs: number;
  maxBioLength: number;
  registrationOpen: boolean;
  welcomeHtml: string;
  rulesHtml: string;
  securityNoticeHtml: string;
  registerDisclaimerHtml: string;
  metaDescription: string;
  customHeadHtml: string;
  activityFeedsEnabled: boolean;
  featuredWorldsEnabled: boolean;
  splashMessages24hEnabled: boolean;
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
 * /stats endpoint — this one carries DAU/WAU/MAU, moderation volume,
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
 * viewer's local time zone — registration timestamps are absolute, but
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
                  <div className="text-xs text-keep-muted/60 italic">—</div>
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
 * regardless of its peak — otherwise quiet rows shrink and busy rows grow
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
  // `view_admin_settings` reads the form but can't submit changes —
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
      setEditGrace(formatMs(j.editGraceMs));
      setMaxBioLen(String(j.maxBioLength));
      setRegOpen(j.registrationOpen);
      setActivityFeedsEnabled(j.activityFeedsEnabled);
      setFeaturedWorldsEnabled(j.featuredWorldsEnabled);
      setSplashMessages24hEnabled(j.splashMessages24hEnabled);
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
        editGraceMs,
        maxBioLength: intOrThrow("Max bio length", maxBioLen, 1000, 200_000),
        registrationOpen: regOpen,
        activityFeedsEnabled,
        featuredWorldsEnabled,
        splashMessages24hEnabled,
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
        readOnlyHint="Read-only — needs edit_site_settings to save."
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
              Surfaces a rolling 24h chat-message count on the splash. Independent of Activity feeds — flip it on alone to show the message volume by itself, or pair with Activity feeds so it sits in the same row as the online/registered/room counters.
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
          the palette — picking a style doesn't change which colors are
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
          this component. No inline save row — keeps the form
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
  // — both let the patch through, and the server is the source of
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
  // SettingsTab — the inline save row used to sit at the bottom of
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
        readOnlyHint="Read-only — needs edit_site_settings to save."
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
          unstyled link pointing here — useful for sending visitors back to a
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
          maxLength={50_000}
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
 * Logo image picker — URL input + Upload button + live preview.
 *
 * Two paths admins can take:
 *   1. Type/paste a URL (built-in `/thespire-logo.png`, an
 *      `/uploads/...` path that was uploaded earlier, or a remote
 *      https URL). Save commits via the standard /admin/settings PUT
 *      flow alongside the rest of the branding form.
 *   2. Click Upload, pick a local file. We read it via FileReader as
 *      a base64 data URL, POST to /admin/upload/logo, and the server
 *      writes it under /uploads + immediately persists the URL onto
 *      site_settings.logo_url. That bypass the parent form save —
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
   *  button hides — the URL input stays editable since pasting a
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
          title="Clear — banner falls back to the text site name."
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
  // SettingsTab / BrandingTab — see those for the full rationale.
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
        readOnlyHint="Read-only — needs edit_site_settings to save."
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
        Rules and the privacy notice shown when users click the Rules button.
        Both fields accept the same HTML allow-list as profile bios - formatting
        tags, links, lists, and headings (h3-h6).
      </p>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">House rules</legend>
        <textarea
          value={rulesHtml}
          onChange={(e) => setRulesHtml(e.target.value)}
          rows={14}
          maxLength={50_000}
          placeholder="<h3>House Rules</h3><ol><li>...</li></ol>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Free-form RP house rules. Defaults seed an 8-point baseline covering
          consent, godmodding, OOC/IC separation, and reporting.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Privacy &amp; safety notice</legend>
        <textarea
          value={securityHtml}
          onChange={(e) => setSecurityHtml(e.target.value)}
          rows={8}
          maxLength={10_000}
          placeholder="<h3>Privacy &amp; Safety</h3><p>...</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Shown alongside the rules. Defaults explain the privacy contract:
          admins cannot read private/whispered messages, so users should
          self-govern and report problems with screenshots.
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">Registration disclaimer</legend>
        <textarea
          value={disclaimerHtml}
          onChange={(e) => setDisclaimerHtml(e.target.value)}
          rows={10}
          maxLength={20_000}
          placeholder="<p>This is a free-form roleplay chat...</p>"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
        />
        <p className="mt-1 text-keep-muted">
          Rendered above the registration form on the splash. Users must tick
          an "I agree" checkbox before <code>/auth/register</code> succeeds.
          Empty disclaimer = no checkbox shown (registration unblocked).
        </p>
      </fieldset>

      <fieldset className="rounded border border-keep-rule p-3 text-xs">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">New-user welcome (post-login)</legend>
        <textarea
          value={welcomeHtml}
          onChange={(e) => setWelcomeHtml(e.target.value)}
          rows={10}
          maxLength={50_000}
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
              className="prose prose-sm max-w-none rounded border border-keep-action/40 bg-keep-action/5 p-2"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(securityHtml) }}
            />
          ) : null}
          {rulesHtml.trim() ? (
            <div
              className="prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(rulesHtml) }}
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
 * CUSTOM COMMANDS TAB
 * ============================================================= */

interface CustomCmdRow {
  id: string;
  name: string;
  kind: "action" | "say";
  template: string;
  description: string | null;
  enabled: boolean;
  aliases: string[];
  /** Hex color override; null = inherit sender's chatColor. */
  color: string | null;
  /** When true, users can splice this command mid-message via `!name`. */
  allowInline: boolean;
  /** Alternate template for the inline path. Null falls back to `template`. */
  inlineTemplate: string | null;
  /** Optional CSS declaration list applied to the rendered body. Validated
   *  against the typography/color allow-list server-side. */
  css: string | null;
}

interface CustomCmdInput {
  name: string;
  kind: "action" | "say";
  template: string;
  description?: string;
  aliases?: string[];
  enabled?: boolean;
  /** Pass null to clear; pass a #rrggbb hex to set. */
  color?: string | null;
  allowInline?: boolean;
  /** Pass null to clear the override (fall back to `template`). */
  inlineTemplate?: string | null;
  /** Pass null to clear the CSS, or a declaration list to set. */
  css?: string | null;
}

function CommandsTab() {
  const [cmds, setCmds] = useState<CustomCmdRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CustomCmdRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/admin/custom-commands", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { commands: CustomCmdRow[] };
      setCmds(j.commands);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function create(input: CustomCmdInput) {
    const r = await fetch("/admin/custom-commands", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    setAdding(false);
    await reload();
  }

  async function update(id: string, input: Partial<CustomCmdInput>) {
    const r = await fetch(`/admin/custom-commands/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    setEditing(null);
    await reload();
  }

  async function destroy(id: string) {
    if (!window.confirm("Delete this command?")) return;
    setError(null);
    try {
      const r = await fetch(`/admin/custom-commands/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      // Optimistic remove + close the edit form. The reload below
      // confirms against the server, but doing it eagerly fixes the
      // "deleted row stays visible until I refresh the whole app"
      // bug — previously the edit form stayed open with the now-
      // deleted command shown, and any subsequent re-add of the
      // same name looked like the old row had necroed back.
      setEditing(null);
      setAdding(false);
      setCmds((prev) => prev.filter((c) => c.id !== id));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="text-xs text-keep-muted sm:max-w-[60%]">
          User-authored slash commands beyond the built-ins. Built-in names
          (<code>/me</code>, <code>/char</code>, etc.) are protected and can't be shadowed.
        </div>
        <button
          type="button"
          onClick={() => { setAdding(true); setEditing(null); }}
          className="self-end rounded border border-keep-rule bg-keep-banner px-3 py-1 text-xs hover:bg-keep-banner/80 sm:self-auto"
        >
          + New command
        </button>
      </div>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      {adding ? (
        <CommandForm
          mode="create"
          onCancel={() => setAdding(false)}
          onSubmit={create}
        />
      ) : null}

      {editing ? (
        <CommandForm
          mode="edit"
          initial={editing}
          onCancel={() => setEditing(null)}
          onSubmit={(input) => update(editing.id, input)}
          onDelete={() => destroy(editing.id)}
        />
      ) : null}

      {loading ? (
        <div className="text-keep-muted text-xs">loading...</div>
      ) : cmds.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          No custom commands yet.
        </div>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[560px] text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 text-left">Name</th>
              <th className="px-2 py-1 text-left">Kind</th>
              <th className="px-2 py-1 text-left">Aliases</th>
              <th className="px-2 py-1 text-left">Template</th>
              <th className="px-2 py-1">On</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {cmds.map((c) => (
              <tr key={c.id} className="border-t border-keep-rule">
                <td className="px-2 py-1 font-mono">/{c.name}</td>
                <td className="px-2 py-1">{c.kind}</td>
                <td className="px-2 py-1 font-mono">
                  {c.aliases.length ? c.aliases.map((a) => `/${a}`).join(" ") : "-"}
                </td>
                <td className="px-2 py-1 truncate max-w-xs" title={c.template}>{c.template}</td>
                <td className="px-2 py-1 text-center">
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    onChange={() => update(c.id, { enabled: !c.enabled })}
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => { setEditing(c); setAdding(false); }}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

function CommandForm({
  mode,
  initial,
  onSubmit,
  onCancel,
  onDelete,
}: {
  mode: "create" | "edit";
  initial?: CustomCmdRow;
  onSubmit: (input: CustomCmdInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKindRaw] = useState<"action" | "say">(initial?.kind ?? "action");
  // Kind picker acts as a "preset loader" in create mode: switching to
  // action vs say also seeds the template, CSS, and color to match what
  // each legacy chat shape used to render as — `{sender} <body>` in
  // italic + theme:action for action, `[{sender}] <body>` with default
  // styling for say. The presets give a one-click starting point that
  // mirrors how a baseline /me or /say would have looked, so a fresh
  // command immediately reads "right" before the admin tweaks it. We
  // only auto-fill when the field is still on the OTHER kind's preset
  // (or empty) — once the admin has authored their own value, the
  // toggle stops clobbering it.
  const KIND_PRESETS = {
    action: {
      template: "{sender} ",
      css: "font-style: italic",
      color: "theme:action" as string | null,
    },
    say: {
      template: "[{sender}] ",
      css: "",
      color: null as string | null,
    },
  } as const;
  const [template, setTemplate] = useState(
    initial?.template ?? KIND_PRESETS[initial?.kind ?? "action"].template,
  );
  const [aliases, setAliases] = useState((initial?.aliases ?? []).join(" "));
  const [description, setDescription] = useState(initial?.description ?? "");
  // null = inherit sender's chat color (default). A hex string overrides.
  const [color, setColor] = useState<string | null>(
    initial?.color ?? KIND_PRESETS[initial?.kind ?? "action"].color,
  );
  // Inline-use toggle. Off by default for new commands and for existing
  // rows pre-feature (the migration sets allow_inline = 0).
  const [allowInline, setAllowInline] = useState<boolean>(initial?.allowInline ?? false);
  // Inline template. Persisted separately so the standalone wording can
  // stay as "{sender} flips heads" while the inline form reads "flips
  // heads" without the leading name.
  const [inlineTemplate, setInlineTemplate] = useState<string>(
    initial?.inlineTemplate ?? initial?.template ?? "",
  );
  // Raw CSS declaration list. Empty string = no override; non-empty
  // gets validated against the typography/color allow-list on save.
  // Preview applies a client-side parse of the same input so an admin
  // sees exactly which declarations survived.
  const [css, setCss] = useState<string>(
    initial?.css ?? KIND_PRESETS[initial?.kind ?? "action"].css,
  );

  /**
   * Kind setter that also threads the preset through template / css /
   * color when the admin is creating a new command and the relevant
   * fields are still on the OLD kind's preset (or empty). Edit-mode
   * picks update only the kind; the admin owns the other fields and
   * we don't want a stray click to clobber a customized template.
   */
  function setKind(next: "action" | "say") {
    const prev = kind;
    setKindRaw(next);
    if (mode === "edit" || prev === next) return;
    const prevPreset = KIND_PRESETS[prev];
    const nextPreset = KIND_PRESETS[next];
    if (template.trim() === "" || template === prevPreset.template) {
      setTemplate(nextPreset.template);
    }
    if (css.trim() === "" || css === prevPreset.css) {
      setCss(nextPreset.css);
    }
    if (color === prevPreset.color) {
      setColor(nextPreset.color);
    }
  }
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Preview reads against the operator's current theme bg so the
  // contrast adjustment applied at message-render time also shows up
  // in the live preview.
  const themeBg = useActiveTheme().bg;
  const previewColor = resolveMessageColor(color, themeBg);
  // Run the same sanitizer the server uses on save so the preview
  // reflects exactly which declarations will survive. Anything dropped
  // here (e.g. an unsupported property like `position`) just won't
  // show up in the rendered preview — surprises the author *before*
  // they hit save.
  const sanitizedCss = useMemo(() => sanitizeCustomCmdCss(css), [css]);
  // Pass `themeBg` so a color value in the CSS gets the same legibility
  // nudge against the operator's current palette that the chat renderer
  // applies — keeps the preview honest about what the command will look
  // like to viewers on different themes.
  const previewCssStyle = useMemo(
    () => customCmdCssToStyle(sanitizedCss, themeBg),
    [sanitizedCss, themeBg],
  );

  // First-enable hint: when the user flips Allow Inline on with nothing
  // authored yet for the inline body, seed it with the current main
  // template so they have a working starting point rather than an empty
  // box. We only seed on the toggle transition (not on every keystroke
  // in the main template) so we don't clobber later author edits.
  function onToggleAllowInline(next: boolean) {
    if (next && !inlineTemplate.trim()) {
      setInlineTemplate(template);
    }
    setAllowInline(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: CustomCmdInput = {
        name: name.trim().toLowerCase(),
        kind,
        template,
      };
      if (description.trim()) body.description = description.trim();
      const aliasList = aliases.split(/[\s,]+/).map((a) => a.replace(/^\//, "").trim().toLowerCase()).filter(Boolean);
      if (mode === "create" || aliasList.length || (initial?.aliases.length ?? 0) > 0) {
        body.aliases = aliasList;
      }
      // Send color when changed from the loaded value (including clearing).
      if (mode === "create") {
        if (color) body.color = color;
      } else if (color !== (initial?.color ?? null)) {
        body.color = color;
      }
      // Inline fields. Toggling Allow-Inline off DOESN'T clear the
      // stored inline_template — the server gates the lookup on
      // allow_inline, so a stored body is harmless. Preserving it
      // means an admin who toggles off then back on doesn't lose
      // their authored override.
      if (mode === "create") {
        if (allowInline) {
          body.allowInline = true;
          if (inlineTemplate.trim()) body.inlineTemplate = inlineTemplate;
        }
      } else {
        if (allowInline !== (initial?.allowInline ?? false)) {
          body.allowInline = allowInline;
        }
        // Only send inlineTemplate changes while the toggle is on; when
        // off, leave the stored value alone (see comment above).
        if (allowInline) {
          const initialInline = initial?.inlineTemplate ?? null;
          const nextInline = inlineTemplate.trim() ? inlineTemplate : null;
          if (nextInline !== initialInline) {
            body.inlineTemplate = nextInline;
          }
        }
      }
      // CSS field. Send as null when the textarea is empty so the
      // server clears the column; otherwise send the trimmed raw input
      // (the server re-runs sanitizeCustomCmdCss before persisting).
      if (mode === "create") {
        if (css.trim()) body.css = css.trim();
      } else {
        const initialCss = initial?.css ?? null;
        const nextCss = css.trim() ? css.trim() : null;
        if (nextCss !== initialCss) body.css = nextCss;
      }
      await onSubmit(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Live preview using the same substitution rules as the server. {sender}
  // and {name} are synonyms - both resolve to the sender's display name.
  const preview = renderTemplatePreview(template, {
    name: "Sigrid",
    sender: "Sigrid",
    target: "Bran",
    args: "Bran tightly",
    rest: "tightly",
    time: "14:30",
    date: new Date().toISOString().slice(0, 10),
  });

  return (
    <form onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-semibold truncate">{mode === "create" ? "New command" : `Edit /${initial?.name}`}</div>
        <button type="button" onClick={onCancel} className="shrink-0 text-keep-muted hover:text-keep-text">cancel</button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="hug"
            maxLength={32}
            pattern="[a-zA-Z][a-zA-Z0-9_-]*"
            className="w-full rounded border border-keep-rule px-2 py-1"
          />
          {mode === "edit" ? (
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Rename to fix typos. Aliases and history follow the new name.
            </span>
          ) : null}
        </label>
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "action" | "say")}
            className="w-full rounded border border-keep-rule px-2 py-1"
          >
            <option value="action">action - renders like /me (no brackets)</option>
            <option value="say">say - renders as a normal message</option>
          </select>
        </label>
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Template</span>
          <textarea
            required
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder="hugs {target} tightly."
            rows={2}
            className="w-full rounded border border-keep-rule px-2 py-1 font-mono"
          />
        </label>
        <div className="col-span-2 flex items-start gap-2">
          <input
            id={`allow-inline-${initial?.id ?? "new"}`}
            type="checkbox"
            checked={allowInline}
            onChange={(e) => onToggleAllowInline(e.target.checked)}
            className="mt-0.5"
          />
          <label htmlFor={`allow-inline-${initial?.id ?? "new"}`} className="flex-1">
            <span className="block uppercase tracking-widest text-keep-muted">Allow inline use</span>
            <span className="block text-[10px] text-keep-muted">
              Lets users splice this command into a sentence with <code>!{name || "name"}</code>.
              The standalone <code>/{name || "name"}</code> form keeps working either way.
            </span>
          </label>
        </div>
        {allowInline ? (
          <label className="col-span-2">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">
              Inline template
            </span>
            <textarea
              value={inlineTemplate}
              onChange={(e) => setInlineTemplate(e.target.value)}
              placeholder="flips heads"
              rows={2}
              className="w-full rounded border border-keep-rule px-2 py-1 font-mono"
            />
            <span className="mt-0.5 block text-[10px] text-keep-muted">
              Rendered when invoked inline (no <code>{"{target}"}</code> / <code>{"{args}"}</code> —
              inline mode has no slot for them). Leave blank to reuse the main template.
            </span>
          </label>
        ) : null}
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Aliases</span>
          <input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="hugs embrace"
            className="w-full rounded border border-keep-rule px-2 py-1 font-mono"
          />
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            space-separated, no leading slash. Conflicts with built-ins are rejected.
          </span>
        </label>
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
            placeholder="Hug someone."
            className="w-full rounded border border-keep-rule px-2 py-1"
          />
        </label>
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Color</span>
          {/* Theme-slot chips — pick one of these to follow whatever
              palette the reader is running with. Useful for "system"
              flavor commands that should look like server notices to
              everyone regardless of their theme choice. */}
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setColor(null)}
              className={
                "rounded border px-2 py-0.5 text-[11px] " +
                (color === null
                  ? "border-keep-action bg-keep-action/15 text-keep-action"
                  : "border-keep-rule bg-keep-bg hover:bg-keep-banner")
              }
              title="Sender's /color flows through"
            >
              Sender color
            </button>
            {THEMEABLE_TEXT_SLOTS.map((slot: ThemeableTextSlot) => {
              const token = `theme:${slot}`;
              const active = color === token;
              return (
                <button
                  key={slot}
                  type="button"
                  onClick={() => setColor(token)}
                  className={
                    "rounded border px-2 py-0.5 text-[11px] capitalize " +
                    (active
                      ? "border-keep-action bg-keep-action/15"
                      : "border-keep-rule bg-keep-bg hover:bg-keep-banner")
                  }
                  style={{ color: `rgb(var(--keep-${slot}))` }}
                  title={`Use the viewer's theme "${slot}" color`}
                >
                  {slot}
                </button>
              );
            })}
          </div>
          {/* Literal hex fallback. Useful when an admin wants an
              exact brand color that doesn't track the theme. Picking
              a hex automatically deselects the theme chip above. */}
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color && color.startsWith("#") ? color : "#990000"}
              onChange={(e) => setColor(e.target.value)}
              className="h-7 w-10 cursor-pointer rounded border border-keep-rule"
              aria-label="Command color (custom hex)"
            />
            <input
              type="text"
              value={color && color.startsWith("#") ? color : ""}
              onChange={(e) => setColor(e.target.value || null)}
              placeholder={
                color && color.startsWith("theme:")
                  ? `(using ${color})`
                  : "(none - sender's chat color flows through)"
              }
              maxLength={7}
              pattern="^#[0-9a-fA-F]{6}$"
              className="flex-1 rounded border border-keep-rule px-2 py-1 font-mono"
            />
          </div>
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            Optional. A theme color tracks the reader's palette; a hex locks every message to that literal color.
          </span>
        </label>
      </div>

      {/* Custom CSS — admin-authored declaration list applied to the
          rendered body. The textarea is intentionally small (most
          authors only want a property or two — bold, italic, a glow
          via text-shadow); the hard cap matches the server's
          CUSTOM_CMD_CSS_MAX_LEN. Sanitization runs locally on every
          keystroke so the preview reflects exactly what survives the
          allow-list. */}
      <label className="mt-2 block text-[11px]">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">
          Custom CSS (optional)
        </span>
        <textarea
          value={css}
          onChange={(e) => setCss(e.target.value)}
          rows={2}
          maxLength={CUSTOM_CMD_CSS_MAX_LEN}
          placeholder="font-weight: bold; text-shadow: 0 0 4px #4a8;"
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px]"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          Allowed: <code>color</code>, <code>background-color</code>, <code>font-weight</code>,
          <code> font-style</code>, <code>font-family</code>, <code>font-size</code>,
          <code> line-height</code>, <code>letter-spacing</code>, <code>text-decoration</code>,
          <code> text-align</code>, <code>text-transform</code>, <code>text-shadow</code>,
          <code> opacity</code>, <code>font-variant</code>. Anything else is dropped on save.
        </span>
        {css.trim() && sanitizedCss !== css.trim().replace(/;\s*$/, "") ? (
          <span className="mt-0.5 block text-[10px] italic text-keep-accent">
            Some declarations were filtered: <code>{sanitizedCss || "(all dropped)"}</code>
          </span>
        ) : null}
      </label>

      <details className="mt-3 text-[11px]">
        <summary className="cursor-pointer text-keep-muted">Template syntax</summary>
        <div className="mt-1 space-y-2">
          <div>
            <div className="mb-0.5 uppercase tracking-widest text-keep-muted">Formatting (markdown)</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono">
              <div><b>{"**bold**"}</b> - <b>bold</b></div>
              <div><b>{"*italic*"}</b> - <em>italic</em></div>
              <div><b>{"~~strike~~"}</b> - <s>strike</s></div>
              <div><b>{"`code`"}</b> - <code>code</code></div>
              <div><b>{"||spoiler||"}</b> - hidden until clicked</div>
              <div><b>{"[text](url)"}</b> - inline link</div>
            </div>
          </div>
          <div>
            <div className="mb-0.5 uppercase tracking-widest text-keep-muted">Variables</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono">
              <div><b>{"{sender}"}</b> / <b>{"{name}"}</b> - sender</div>
              <div><b>{"{target}"}</b> - first arg</div>
              <div><b>{"{args}"}</b> - full args</div>
              <div><b>{"{rest}"}</b> - args without first</div>
              <div><b>{"{time}"}</b> - HH:MM</div>
              <div><b>{"{date}"}</b> - YYYY-MM-DD</div>
              <div><b>{"{room}"}</b> - current room id</div>
            </div>
          </div>
          <div>
            <div className="mb-0.5 uppercase tracking-widest text-keep-muted">Functions</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono">
              <div><b>{"{roll:1d20}"}</b> - dice roll</div>
              <div><b>{"{choose:a|b|c}"}</b> - random pick</div>
              <div><b>{"{upper:text}"}</b> - uppercase</div>
              <div><b>{"{lower:text}"}</b> - lowercase</div>
              <div className="col-span-2"><b>{"{if:cond|then|else}"}</b> - truthy if cond is non-empty &amp; not 0/false</div>
            </div>
          </div>
          <div>
            <div className="mb-0.5 uppercase tracking-widest text-keep-muted">Sugar</div>
            <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 font-mono">
              <div><b>{"{a|b|c}"}</b> - bare-pipe random pick (sugar for choose)</div>
              <div><b>{"{=expr}"}</b> - safe arithmetic, <code>+ - * / % ( )</code> only</div>
            </div>
          </div>
          <div>
            <div className="mb-0.5 uppercase tracking-widest text-keep-muted">Nesting</div>
            <div className="font-mono">
              <div>{"{if:{target}|hugs {target}|waves}"}</div>
              <div>{"{=10+{roll:1d20}}"}</div>
            </div>
          </div>
        </div>
      </details>

      {/* Live preview. Renders inline markdown the same way chat
          messages will at delivery time (see `lib/markdown.tsx`), so
          `**bold**`, `*italic*`, links, etc. show up exactly as
          they'll appear to readers — not as their raw `**` source. */}
      <div className="mt-2 rounded border border-keep-rule bg-keep-banner/30 p-2">
        <div className="mb-0.5 text-[10px] uppercase tracking-widest text-keep-muted">
          Preview (Sigrid runs /{name || "..."} Bran tightly)
        </div>
        <div
          style={{
            ...(previewColor ? { color: previewColor } : {}),
            ...(previewCssStyle ?? {}),
          }}
        >
          {/* Custom commands now emit kind="cmd" — the chat renderer
              doesn't auto-prepend the display name, so the preview
              mirrors that contract: whatever the template expanded to
              IS the entire visible line. Authors who want the name
              still showing must include `{sender}` in the template
              (legacy commands had `{sender} ` prefixed by migration
              0061). */}
          {parseInline(preview)}
        </div>
      </div>

      {error ? <div className="mt-2 text-keep-accent">{error}</div> : null}

      <div className="mt-3 flex items-center justify-between">
        <div>
          {mode === "edit" && onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              className="keep-button rounded border border-keep-accent/60 bg-keep-bg px-3 py-1 text-keep-accent hover:bg-keep-accent/10"
            >
              Delete
            </button>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 disabled:opacity-50 hover:bg-keep-banner/80"
          >
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * Mirror of server-side renderTemplate (registry.ts) so the preview pane
 * faithfully shows what users will see at command time. Keep these in sync.
 */
function renderTemplatePreview(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (let i = 0; i < 16; i++) {
    let changed = false;
    out = out.replace(/\{([^{}]*)\}/g, (m, raw: string) => {
      const replaced = evalNode(raw, vars);
      if (replaced === null) return m;
      changed = true;
      return replaced;
    });
    if (!changed) break;
  }
  return out;
}

function evalNode(raw: string, vars: Record<string, string>): string | null {
  const body = raw.trim();
  if (!body) return null;
  if (body.startsWith("=")) return safeEvalMath(body.slice(1));
  const colon = body.indexOf(":");
  if (colon > 0 && /^[a-zA-Z]+$/.test(body.slice(0, colon))) {
    return evalFn(body.slice(0, colon).toLowerCase(), body.slice(colon + 1));
  }
  if (body.includes("|")) {
    const opts = body.split("|").map((s) => s.trim()).filter(Boolean);
    return opts.length ? opts[Math.floor(Math.random() * opts.length)]! : "";
  }
  return vars[body.toLowerCase()] ?? null;
}

function evalFn(fn: string, arg: string): string | null {
  switch (fn) {
    case "roll": {
      const m = /^(\d*)d(\d+)$/i.exec(arg.trim());
      if (!m) return null;
      const count = Math.min(20, parseInt(m[1] || "1", 10) || 1);
      const sides = Math.min(1000, parseInt(m[2] ?? "0", 10) || 0);
      if (sides < 2) return null;
      let total = 0;
      for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
      return String(total);
    }
    case "choose": {
      const opts = arg.split("|").map((s) => s.trim()).filter(Boolean);
      return opts.length ? opts[Math.floor(Math.random() * opts.length)]! : "";
    }
    case "upper": return arg.toUpperCase();
    case "lower": return arg.toLowerCase();
    case "if": {
      const parts = arg.split("|");
      if (parts.length < 2) return null;
      const cond = (parts[0] ?? "").trim();
      const truthy = cond !== "" && cond !== "0" && cond.toLowerCase() !== "false";
      return truthy ? (parts[1] ?? "") : parts.slice(2).join("|");
    }
    default: return null;
  }
}

function safeEvalMath(expr: string): string | null {
  const s = expr.replace(/\s+/g, "");
  if (!s || !/^[\d.+\-*/%()]+$/.test(s)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const result = Function(`"use strict"; return (${s});`)();
    if (typeof result === "number" && Number.isFinite(result)) {
      return Number.isInteger(result) ? String(result) : String(+result.toFixed(6));
    }
  } catch { /* ignore */ }
  return null;
}

/* =============================================================
 * ROOMS TAB
 * ============================================================= */

interface AdminRoom {
  id: string;
  name: string;
  type: "public" | "private";
  topic: string | null;
  description: string | null;
  ownerId: string | null;
  isSystem: boolean;
  isDefault: boolean;
  replyMode: "flat" | "nested";
  hasPassword: boolean;
  memberCount: number;
  /**
   * Per-room message-expiry override in minutes. Null = no override;
   * the room inherits the global `messageRetentionMs` site setting.
   * Forum/nested rooms (replyMode='nested') are exempt from the
   * sweep entirely — their messages persist regardless of this
   * value; the expiry panel renders them as "never expires (forum)".
   */
  messageExpiryMinutes: number | null;
}

interface RoomDraft {
  name: string;
  type: "public" | "private";
  topic: string;
  description: string;
  isSystem: boolean;
  isDefault: boolean;
  /**
   * "flat" = chronological chat; "nested" = forum-style threads with
   * persistent top-level posts and grouped replies. Choosing "nested"
   * unlocks the thread-categories panel for organizing those threads.
   */
  replyMode: "flat" | "nested";
  /** Empty string keeps existing password (edit) or means "no password" (create + public). */
  password: string;
  /** True iff editing AND admin clicked "clear password" - sends null. */
  clearPassword: boolean;
}

function emptyDraft(): RoomDraft {
  return {
    name: "",
    type: "public",
    topic: "",
    description: "",
    isSystem: true,
    isDefault: false,
    replyMode: "flat",
    password: "",
    clearPassword: false,
  };
}

function draftFromRoom(r: AdminRoom): RoomDraft {
  return {
    name: r.name,
    type: r.type,
    topic: r.topic ?? "",
    description: r.description ?? "",
    isSystem: r.isSystem,
    isDefault: r.isDefault,
    replyMode: r.replyMode,
    password: "",
    clearPassword: false,
  };
}

/* ============================================================================
 * TITLE KINDS TAB
 *
 * CRUD over the catalog of mutual-title kinds (marriage, partner, mentor, etc.).
 * Slug = the user-facing keyword in /request <slug> <name>. Format strings
 * use {target} as the substitution point for the other party's display name.
 * Symmetric kinds use formatA on both sides; asymmetric kinds let the
 * requester (A side) and recipient (B side) carry different labels.
 * ========================================================================== */

interface TitleKindRow {
  id: string;
  slug: string;
  label: string;
  symmetric: boolean;
  formatA: string;
  formatB: string;
  exclusive: boolean;
  enabled: boolean;
  usageCount: number;
}

interface TitleKindInput {
  slug: string;
  label: string;
  symmetric: boolean;
  formatA: string;
  formatB: string;
  exclusive: boolean;
  enabled: boolean;
}

function TitleKindsTab() {
  const [kinds, setKinds] = useState<TitleKindRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TitleKindRow | null>(null);
  const [adding, setAdding] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/admin/title-kinds", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { kinds: TitleKindRow[] };
      setKinds(j.kinds);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function create(input: TitleKindInput) {
    const r = await fetch("/admin/title-kinds", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    setAdding(false);
    await reload();
  }

  async function update(id: string, input: TitleKindInput) {
    const r = await fetch(`/admin/title-kinds/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(await readError(r));
    setEditing(null);
    await reload();
  }

  async function destroy(id: string, usageCount: number) {
    const msg = usageCount > 0
      ? `Delete this kind? ${usageCount} active or pending title(s) of this kind will also be removed.`
      : "Delete this kind?";
    if (!window.confirm(msg)) return;
    const r = await fetch(`/admin/title-kinds/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!r.ok) throw new Error(await readError(r));
    await reload();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="text-xs text-keep-muted sm:max-w-[60%]">
          Catalog of mutual-title kinds. Users invoke these via{" "}
          <code>/request &lt;slug&gt; &lt;user&gt;</code>. <code>{"{target}"}</code> in the
          format string is replaced with the other party's display name.
          Symmetric kinds use the same label on both sides; asymmetric kinds
          (e.g. mentor / apprentice) let you set distinct A and B labels.
          Exclusive kinds limit each identity to one accepted title of that kind at a time.
        </div>
        <button
          type="button"
          onClick={() => { setAdding(true); setEditing(null); }}
          className="self-end rounded border border-keep-rule bg-keep-banner px-3 py-1 text-xs hover:bg-keep-banner/80 sm:self-auto"
        >
          + New title kind
        </button>
      </div>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      {adding ? (
        <TitleKindForm
          mode="create"
          onCancel={() => setAdding(false)}
          onSubmit={create}
        />
      ) : null}

      {editing ? (
        <TitleKindForm
          mode="edit"
          initial={editing}
          onCancel={() => setEditing(null)}
          onSubmit={(input) => update(editing.id, input)}
          onDelete={() => destroy(editing.id, editing.usageCount)}
        />
      ) : null}

      {loading ? (
        <div className="text-keep-muted text-xs">loading...</div>
      ) : kinds.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          No title kinds yet.
        </div>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 text-left">Slug</th>
              <th className="px-2 py-1 text-left">Label</th>
              <th className="px-2 py-1 text-left">A side</th>
              <th className="px-2 py-1 text-left">B side</th>
              <th className="px-2 py-1">Excl.</th>
              <th className="px-2 py-1">In use</th>
              <th className="px-2 py-1">On</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((k) => (
              <tr key={k.id} className="border-t border-keep-rule">
                <td className="px-2 py-1 font-mono">{k.slug}</td>
                <td className="px-2 py-1">{k.label}</td>
                <td className="px-2 py-1 truncate max-w-[180px]" title={k.formatA}>{k.formatA}</td>
                <td className="px-2 py-1 truncate max-w-[180px]" title={k.formatB}>
                  {k.symmetric ? <span className="italic text-keep-muted">(same)</span> : k.formatB}
                </td>
                <td className="px-2 py-1 text-center">{k.exclusive ? "✓" : ""}</td>
                <td className="px-2 py-1 text-center tabular-nums">{k.usageCount}</td>
                <td className="px-2 py-1 text-center">{k.enabled ? "✓" : ""}</td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => { setEditing(k); setAdding(false); }}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

function TitleKindForm({
  mode,
  initial,
  onSubmit,
  onCancel,
  onDelete,
}: {
  mode: "create" | "edit";
  initial?: TitleKindRow;
  onSubmit: (input: TitleKindInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [symmetric, setSymmetric] = useState(initial?.symmetric ?? true);
  const [formatA, setFormatA] = useState(initial?.formatA ?? "Married to {target}");
  const [formatB, setFormatB] = useState(initial?.formatB ?? "Married to {target}");
  const [exclusive, setExclusive] = useState(initial?.exclusive ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit({
        slug: slug.trim().toLowerCase(),
        label: label.trim(),
        symmetric,
        formatA: formatA.trim(),
        formatB: symmetric ? formatA.trim() : formatB.trim(),
        exclusive,
        enabled,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <div className="text-keep-muted uppercase tracking-widest">Slug</div>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="marriage"
            className="w-full rounded border border-keep-rule bg-keep-parchment px-2 py-1 font-mono"
            required
          />
        </label>
        <label className="space-y-1">
          <div className="text-keep-muted uppercase tracking-widest">Label</div>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Marriage"
            className="w-full rounded border border-keep-rule bg-keep-parchment px-2 py-1"
            required
          />
        </label>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={symmetric}
          onChange={(e) => setSymmetric(e.target.checked)}
        />
        <span>Symmetric (same label on both sides)</span>
      </label>

      <label className="space-y-1 block">
        <div className="text-keep-muted uppercase tracking-widest">
          {symmetric ? "Display format" : "A side (requester)"}
        </div>
        <input
          type="text"
          value={formatA}
          onChange={(e) => setFormatA(e.target.value)}
          placeholder="Married to {target}"
          className="w-full rounded border border-keep-rule bg-keep-parchment px-2 py-1 font-mono"
          required
        />
        <div className="text-[10px] text-keep-muted">
          <p>{"{target} is replaced with the other party's display name."}</p>
          <p className="mt-0.5">
            {"{gender:Male|Female|Neutral} picks based on the subject's gender — e.g."}
            {' "{gender:Father|Mother|Parent} of {target}"'}
            {" renders as Father / Mother / Parent depending on whose profile the chip is on."}
          </p>
        </div>
      </label>

      {!symmetric ? (
        <label className="space-y-1 block">
          <div className="text-keep-muted uppercase tracking-widest">B side (recipient)</div>
          <input
            type="text"
            value={formatB}
            onChange={(e) => setFormatB(e.target.value)}
            placeholder="{gender:Son|Daughter|Child} of {target}"
            className="w-full rounded border border-keep-rule bg-keep-parchment px-2 py-1 font-mono"
            required
          />
        </label>
      ) : null}

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={exclusive}
            onChange={(e) => setExclusive(e.target.checked)}
          />
          <span>Exclusive (one accepted per identity)</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enabled</span>
        </label>
      </div>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{error}</div>
      ) : null}

      <div className="flex justify-between pt-1">
        <div>
          {mode === "edit" && onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              className="keep-button rounded border border-keep-accent/60 bg-keep-bg px-3 py-1 text-keep-accent hover:bg-keep-accent/10"
            >
              Delete
            </button>
          ) : null}
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-keep-muted hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}

function RoomsTab() {
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminRoom | null>(null);
  const [occupants, setOccupants] = useState<Array<{ userId: string; username: string; role: string }>>([]);
  /** Open form: { mode: "create" } | { mode: "edit", room: AdminRoom } | null */
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "edit"; room: AdminRoom } | null>(null);
  // Scroll the form into view whenever `editing` flips to a non-null
  // value. Without this the form mounts above the rooms table (where
  // it logically belongs in the markup) and a mobile user who clicked
  // "Edit" on a row near the bottom of the table sees no visible
  // change — the form is offscreen above the current scroll position.
  const formRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!editing) return;
    // Defer one frame so the form has actually rendered before we try
    // to scroll to it; scrollIntoView on a not-yet-mounted ref is a
    // no-op.
    const id = window.requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [editing]);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/admin/rooms", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { rooms: AdminRoom[] };
      setRooms(j.rooms);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function loadOccupants(room: AdminRoom) {
    setSelected(room);
    setOccupants([]);
    try {
      const r = await fetch(`/admin/rooms/${room.id}/occupants`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { occupants: typeof occupants };
      setOccupants(j.occupants);
    } catch (err) {
      setError(err instanceof Error ? err.message : "occupants load failed");
    }
  }

  async function deleteRoom(room: AdminRoom) {
    if (room.isSystem) return; // server refuses, but disable in UI too
    const ok = window.confirm(
      `Delete the room "${room.name}"?\n\nAll messages will be removed and any occupants will be moved to the landing room. This cannot be undone.`,
    );
    if (!ok) return;
    try {
      const r = await fetch(`/admin/rooms/${room.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      setSelected(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  async function submitCreate(draft: RoomDraft) {
    if (draft.type === "private" && !draft.password) {
      throw new Error("Private rooms require a password.");
    }
    const body: Record<string, unknown> = {
      name: draft.name.trim(),
      type: draft.type,
      isSystem: draft.isSystem,
      isDefault: draft.isDefault,
      replyMode: draft.replyMode,
    };
    if (draft.topic.trim()) body.topic = draft.topic.trim();
    if (draft.description.trim()) body.description = draft.description.trim();
    if (draft.type === "private" && draft.password) body.password = draft.password;
    const r = await fetch("/admin/rooms", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await readError(r));
    setEditing(null);
    await reload();
  }

  async function submitEdit(room: AdminRoom, draft: RoomDraft) {
    const body: Record<string, unknown> = {};
    if (draft.name.trim() !== room.name) body.name = draft.name.trim();
    // null clears, "" leaves unchanged (since we use ?? "" in draftFromRoom)
    if (draft.topic !== (room.topic ?? "")) {
      body.topic = draft.topic.trim() === "" ? null : draft.topic.trim();
    }
    if (draft.description !== (room.description ?? "")) {
      body.description = draft.description.trim() === "" ? null : draft.description.trim();
    }
    if (draft.isSystem !== room.isSystem) body.isSystem = draft.isSystem;
    if (draft.isDefault !== room.isDefault) body.isDefault = draft.isDefault;
    if (draft.replyMode !== room.replyMode) body.replyMode = draft.replyMode;
    if (draft.type !== room.type) {
      body.type = draft.type;
      if (draft.type === "private" && draft.password) body.password = draft.password;
      else if (draft.type === "private" && !draft.password && !room.hasPassword) {
        throw new Error("Switching to private requires a password.");
      }
    } else if (draft.password) {
      body.password = draft.password;
    } else if (draft.clearPassword) {
      body.password = null;
    }
    if (Object.keys(body).length === 0) {
      setEditing(null);
      return;
    }
    const r = await fetch(`/admin/rooms/${room.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await readError(r));
    setEditing(null);
    await reload();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-xs text-keep-muted sm:max-w-[60%]">
          Every room with member count and metadata. Admin-created rooms can
          be flagged as <b>system</b> rooms - they're permanent (don't auto-expire
          when empty) and protected from deletion. Private room message logs
          remain unviewable even to admins.
        </p>
        <button
          type="button"
          onClick={() => setEditing({ mode: "create" })}
          className="self-end rounded border border-keep-rule bg-keep-banner px-3 py-1 text-xs hover:bg-keep-banner/80 sm:self-auto"
        >
          + New room
        </button>
      </div>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}

      {editing ? (
        <div ref={formRef}>
          <RoomForm
            mode={editing.mode}
            {...(editing.mode === "edit" ? { initial: draftFromRoom(editing.room), original: editing.room } : {})}
            onCancel={() => setEditing(null)}
            onSubmit={editing.mode === "create"
              ? submitCreate
              : (draft: RoomDraft) => submitEdit(editing.room, draft)}
          />
        </div>
      ) : null}

      {loading ? (
        <div className="text-keep-muted text-xs">loading...</div>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[640px] text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 text-left">Name</th>
              <th className="px-2 py-1 text-left">Type</th>
              <th className="px-2 py-1">Members</th>
              <th className="px-2 py-1 text-left">Topic</th>
              <th className="px-2 py-1">System</th>
              <th className="px-2 py-1">Default</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id} className="border-t border-keep-rule">
                <td className="px-2 py-1 font-semibold" title={r.description ?? ""}>{r.name}</td>
                <td className="px-2 py-1">
                  {/*
                    Type badge - derives its tint from the active theme so it
                    stays legible on light and dark palettes alike. Public uses
                    the "action" slot (green on default, accent on dark themes);
                    private uses the "accent" slot to read as "restricted".
                  */}
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${
                      r.type === "public"
                        ? "bg-keep-action/20 text-keep-action"
                        : "bg-keep-accent/20 text-keep-accent"
                    }`}
                  >
                    {r.type}
                  </span>
                </td>
                <td className="px-2 py-1 text-center tabular-nums">{r.memberCount}</td>
                <td className="px-2 py-1 truncate max-w-xs" title={r.topic ?? ""}>{r.topic ?? "-"}</td>
                <td className="px-2 py-1 text-center">{r.isSystem ? "✓" : ""}</td>
                <td className="px-2 py-1 text-center" title={r.isDefault ? "Default landing room" : ""}>
                  {r.isDefault ? "★" : ""}
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => loadOccupants(r)}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                  >
                    Occupants
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing({ mode: "edit", room: r })}
                    className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                    title="Edit room metadata (name, topic, description, type, system flag)."
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteRoom(r)}
                    disabled={r.isSystem}
                    title={r.isSystem ? "System rooms cannot be deleted. Toggle the System flag off via Edit first." : "Delete this room (occupants are moved to the landing room)."}
                    className="rounded border border-keep-accent/60 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {selected ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-3 text-xs">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="truncate"><b>{selected.name}</b> - members</div>
            <CloseButton onClick={() => setSelected(null)} />
          </div>
          {occupants.length === 0 ? (
            <div className="text-keep-muted">(empty)</div>
          ) : (
            <ul>
              {occupants.map((o) => (
                <li key={o.userId} className="flex justify-between border-t border-keep-rule/50 py-0.5 first:border-t-0">
                  <span>{o.username}</span>
                  <span className="text-keep-muted">{o.role}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {/* Message-expiry management. Sits below the main room table so
          the existing edit surface (name/topic/type/etc.) stays
          uncluttered while admins still get a dedicated view for the
          sweep schedule. Each row shows the effective expiry — per-
          room override or "global (Xd)" fallback — and exposes
          inline + bulk controls. Forum/nested rooms are exempt from
          the sweep so they surface as "never expires" read-only. */}
      {!loading ? <RoomExpiryPanel rooms={rooms} onReload={reload} /> : null}
    </div>
  );
}

/**
 * Convert minutes to a short human label ("60m", "5h", "5d") for
 * tabular display. Picks the largest unit that divides cleanly so
 * 1440 reads as "1d" instead of "24h" or "1440m". Falls back to
 * minutes when no clean division works.
 */
function formatMinutes(min: number): string {
  if (min <= 0) return "0";
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

/**
 * Parse a duration like "60m", "5h", "5d", or a bare number (read
 * as minutes). Returns null when the input is empty / unparseable
 * so callers can fall through to a "clear" code path instead of
 * sending garbage.
 */
function parseExpiryMinutes(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  const m = /^(\d+)\s*([mhd]?)$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  const unit = m[2];
  const minutes = unit === "h" ? n * 60 : unit === "d" ? n * 1440 : n;
  if (minutes < 1 || minutes > 43_200) return null;
  return minutes;
}

function RoomExpiryPanel({
  rooms,
  onReload,
}: {
  rooms: AdminRoom[];
  onReload: () => Promise<void>;
}) {
  // Global retention from the branding store — already populated from
  // /site on first paint, so no extra fetch here. Drives the "(global)"
  // fallback label rendered for rooms whose per-room override is null.
  const globalMs = useChat((s) => s.branding.messageRetentionMs);
  const globalMinutes = globalMs > 0 ? Math.round(globalMs / 60_000) : 0;
  const globalLabel = globalMs > 0 ? formatMinutes(globalMinutes) : "never";

  // Per-row draft input. Lazy-initialized when the row is first edited
  // so existing values stay rendered as their canonical label until
  // the admin actually types into the input.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Bulk-select state — checkbox column. Forum rooms can be selected
  // but the bulk-apply just no-ops on them server-side (the column
  // updates but the sweep ignores forum rooms anyway).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkDraft, setBulkDraft] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  function showFlash(msg: string) {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 2000);
  }

  async function savePerRoom(room: AdminRoom, raw: string) {
    setError(null);
    setBusy(true);
    try {
      const minutes = parseExpiryMinutes(raw);
      if (raw.trim() !== "" && minutes === null) {
        throw new Error("Expiry must be a duration like 60m, 5h, 5d (1m–30d).");
      }
      const r = await fetch(`/admin/rooms/${room.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageExpiryMinutes: minutes }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setDrafts((d) => {
        const next = { ...d };
        delete next[room.id];
        return next;
      });
      await onReload();
      showFlash(minutes === null ? `Cleared override on ${room.name}` : `${room.name}: expiry set to ${formatMinutes(minutes)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearPerRoom(room: AdminRoom) {
    await savePerRoom(room, "");
  }

  async function applyBulk(action: "set" | "clear") {
    setError(null);
    setBusy(true);
    try {
      let minutes: number | null;
      if (action === "clear") {
        minutes = null;
      } else {
        minutes = parseExpiryMinutes(bulkDraft);
        if (minutes === null) throw new Error("Enter a duration like 60m, 5h, 5d (1m–30d).");
      }
      const ids = [...selectedIds];
      if (ids.length === 0) throw new Error("Select at least one room.");
      const r = await fetch("/admin/rooms/expiry/bulk", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomIds: ids, minutes }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { updated: number };
      setSelectedIds(new Set());
      setBulkDraft("");
      await onReload();
      showFlash(
        minutes === null
          ? `Cleared override on ${j.updated} room(s)`
          : `Applied ${formatMinutes(minutes)} to ${j.updated} room(s)`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "bulk apply failed");
    } finally {
      setBusy(false);
    }
  }

  // Selectable rooms = everything except forum/nested (server accepts
  // the value but the sweep ignores them, so including them in bulk
  // ops is confusing). "Select all" only checks selectable rows.
  const selectableRooms = rooms.filter((r) => r.replyMode !== "nested");
  const allSelected = selectableRooms.length > 0 && selectableRooms.every((r) => selectedIds.has(r.id));
  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableRooms.map((r) => r.id)));
    }
  }

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Message expiry</legend>
      <p className="mb-2 text-keep-muted">
        Global retention is <b className="text-keep-text">{globalLabel}</b> — every flat-chat room without an
        override below inherits it live. Per-room overrides take precedence
        when set; forum (nested) rooms keep messages forever regardless.
        Change the global value in <span className="text-keep-text">Settings → Message retention</span>.
      </p>

      {selectedIds.size > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded border border-keep-action/40 bg-keep-action/10 p-2">
          <span className="text-keep-text">
            <b className="tabular-nums">{selectedIds.size}</b> room(s) selected
          </span>
          <span className="mx-1 text-keep-muted">·</span>
          <input
            type="text"
            value={bulkDraft}
            onChange={(e) => setBulkDraft(e.target.value)}
            placeholder="60m, 5h, 5d"
            className="w-28 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 font-mono"
          />
          <button
            type="button"
            onClick={() => void applyBulk("set")}
            disabled={busy}
            className="rounded border border-keep-action bg-keep-action/20 px-2 py-0.5 text-keep-action hover:bg-keep-action/30 disabled:opacity-50"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => void applyBulk("clear")}
            disabled={busy}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
            title="Clear the override on the selected rooms — they fall back to global retention."
          >
            Clear override
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
          >
            Deselect all
          </button>
        </div>
      ) : null}

      {error ? <div className="mb-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{error}</div> : null}
      {flash ? <div className="mb-2 rounded border border-keep-system/40 bg-keep-system/10 p-2 text-keep-system">{flash}</div> : null}

      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[640px] text-xs">
          <thead className="bg-keep-banner/50 text-keep-muted uppercase tracking-widest">
            <tr>
              <th className="px-2 py-1 w-8 text-center">
                <input
                  type="checkbox"
                  aria-label="Select all flat-chat rooms"
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </th>
              <th className="px-2 py-1 text-left">Room</th>
              <th className="px-2 py-1 text-left">Mode</th>
              <th className="px-2 py-1 text-left">Effective expiry</th>
              <th className="px-2 py-1 text-left">Override</th>
              <th className="px-2 py-1 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => {
              const isForum = r.replyMode === "nested";
              const draftValue = drafts[r.id] ?? (r.messageExpiryMinutes != null ? formatMinutes(r.messageExpiryMinutes) : "");
              const dirty = (drafts[r.id] ?? null) !== null;
              const effectiveLabel = isForum
                ? "never (forum)"
                : r.messageExpiryMinutes != null
                  ? `${formatMinutes(r.messageExpiryMinutes)} (per-room)`
                  : globalMs > 0
                    ? `${globalLabel} (global)`
                    : "never (global)";
              return (
                <tr key={r.id} className="border-t border-keep-rule">
                  <td className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(r.id)}
                      disabled={isForum}
                      aria-label={`Select ${r.name}`}
                      onChange={(e) => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td className="px-2 py-1 font-semibold">{r.name}</td>
                  <td className="px-2 py-1 text-keep-muted">{isForum ? "forum" : "chat"}</td>
                  <td className="px-2 py-1">
                    <span className={isForum ? "text-keep-muted" : r.messageExpiryMinutes != null ? "text-keep-text" : "text-keep-muted"}>
                      {effectiveLabel}
                    </span>
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="text"
                      value={draftValue}
                      placeholder={isForum ? "—" : "inherit"}
                      disabled={isForum}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [r.id]: e.target.value }))
                      }
                      className="w-28 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 font-mono disabled:opacity-40"
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      onClick={() => void savePerRoom(r, drafts[r.id] ?? "")}
                      disabled={busy || isForum || !dirty}
                      className="mr-1 rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-keep-action hover:bg-keep-action/20 disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => void clearPerRoom(r)}
                      disabled={busy || isForum || r.messageExpiryMinutes == null}
                      title={r.messageExpiryMinutes == null ? "No override to clear — already inheriting global." : "Clear override; room falls back to global retention."}
                      className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner disabled:opacity-40"
                    >
                      Clear
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </fieldset>
  );
}

function RoomForm({
  mode,
  initial,
  original,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  initial?: RoomDraft;
  /** When editing, the original AdminRoom is needed for hasPassword display logic. */
  original?: AdminRoom;
  onSubmit: (draft: RoomDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RoomDraft>(initial ?? emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-semibold truncate">
          {mode === "create" ? "New room" : `Edit ${original?.name ?? ""}`}
        </div>
        <button type="button" onClick={onCancel} className="shrink-0 text-keep-muted hover:text-keep-text">cancel</button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="col-span-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Name</span>
          <input
            required
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={40}
            placeholder="Tavern"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
        <label className="col-span-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Type</span>
          <select
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as "public" | "private" })}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="public">public - anyone can join</option>
            <option value="private">private - password required</option>
          </select>
        </label>
        {draft.type === "private" ? (
          <label className="col-span-2">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">
              Password{" "}
              {mode === "edit" && original?.hasPassword ? (
                <span className="normal-case tracking-normal text-keep-muted/80">
                  (leave blank to keep existing)
                </span>
              ) : null}
            </span>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value, clearPassword: false })}
                placeholder={mode === "edit" && original?.hasPassword ? "(unchanged)" : "Required"}
                maxLength={100}
                className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1"
              />
              {mode === "edit" && original?.hasPassword ? (
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, password: "", clearPassword: !draft.clearPassword })}
                  className={`rounded border px-2 py-1 ${
                    draft.clearPassword
                      ? "border-keep-accent/60 bg-keep-accent/10 text-keep-accent"
                      : "border-keep-rule bg-keep-bg text-keep-muted hover:text-keep-text"
                  }`}
                  title="Clear the password - the room becomes private with no password (membership/invite-only)."
                >
                  {draft.clearPassword ? "Clearing" : "Clear"}
                </button>
              ) : null}
            </div>
          </label>
        ) : null}
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Topic</span>
          <input
            value={draft.topic}
            onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
            maxLength={200}
            placeholder="Short headline shown above the chat"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description</span>
          <textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            rows={4}
            maxLength={5000}
            placeholder="Long-form world/setting description shown to users on join. Newlines preserved."
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
        <label className="col-span-2 flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            checked={draft.isSystem}
            onChange={(e) => setDraft({ ...draft, isSystem: e.target.checked })}
          />
          <span>
            <b>System room</b> - permanent, exempt from auto-expire, protected from deletion until this flag is cleared.
          </span>
        </label>
        <label className="col-span-2 flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            checked={draft.isDefault}
            onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
          />
          <span>
            <b>Default landing room</b> - new users and reconnecting users with no remembered room land here. Flipping this on automatically clears the flag off whichever room currently holds it.
          </span>
        </label>

        {/* Reply / thread mode. Flat = ephemeral chronological chat;
            nested = forum-style with persistent threads and the
            thread-categories panel below. Toggling here saves on form
            submit and re-broadcasts room state so anyone currently in
            the room flips renderers without a refresh. */}
        <label className="col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Reply mode</span>
          <select
            value={draft.replyMode}
            onChange={(e) => setDraft({ ...draft, replyMode: e.target.value as "flat" | "nested" })}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="flat">flat — chronological chat (messages may auto-expire per retention)</option>
            <option value="nested">nested — forum-style threads (persistent topics, replies group under their parent, supports categories)</option>
          </select>
          <span className="mt-1 block text-[10px] text-keep-muted">
            {draft.replyMode === "nested"
              ? "Threads in this room read like a forum: top-level posts persist, replies group under their parent, and admins can add categories to organize them."
              : "Standard chat timeline. /replymode in chat is the equivalent toggle for room owners and mods."}
          </span>
        </label>
      </div>

      {/* Thread categories — only meaningful for nested-mode rooms.
          We branch on the DRAFT replyMode (not the saved value) so
          flipping the select above immediately reveals the panel; the
          panel itself hits the API directly, independent of the
          room-form save. New rooms have no id yet, so we hint that
          categories can be added after the first save. */}
      {mode === "edit" && original && draft.replyMode === "nested" ? (
        <ThreadCategoriesEditor roomId={original.id} />
      ) : null}
      {mode === "create" && draft.replyMode === "nested" ? (
        <div className="mt-3 rounded border border-keep-action/40 bg-keep-action/10 p-2 text-[10px] uppercase tracking-widest text-keep-action">
          Thread categories can be added after the room is created — save this form, then re-open the room's Edit panel and the categories editor will appear here.
        </div>
      ) : null}

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
          disabled={submitting}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 disabled:opacity-50 hover:bg-keep-banner/80"
        >
          {submitting ? "Saving..." : mode === "create" ? "Create room" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

/**
 * Inline editor for a nested-mode room's thread categories. Lives inside
 * the room-edit form so admins manage everything for a room in one
 * place. CRUD hits `/admin/rooms/:id/thread-categories`; the list refresh
 * happens locally without round-tripping the whole room edit form so the
 * admin doesn't lose draft state on unrelated changes.
 */
function ThreadCategoriesEditor({ roomId }: { roomId: string }) {
  const [cats, setCats] = useState<ThreadCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/rooms/${encodeURIComponent(roomId)}/thread-categories`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { categories: ThreadCategory[] };
      setCats(j.categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }
  useEffect(() => { load(); }, [roomId]);

  async function add() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, sortOrder: (cats?.length ?? 0) }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setNewName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveRename(catId: string) {
    const trimmed = editName.trim();
    if (!trimmed) { setEditingId(null); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories/${encodeURIComponent(catId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "rename failed");
    } finally {
      setBusy(false);
    }
  }

  async function move(catId: string, direction: -1 | 1) {
    if (!cats) return;
    const idx = cats.findIndex((c) => c.id === catId);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= cats.length) return;
    const a = cats[idx]!;
    const b = cats[swapIdx]!;
    setBusy(true);
    setError(null);
    try {
      // Two PATCHes: swap the sortOrder of the adjacent rows. We only
      // touch two records per move so a long category list doesn't
      // require a full re-shuffle on every reorder click.
      await Promise.all([
        fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories/${encodeURIComponent(a.id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sortOrder: b.sortOrder }),
        }),
        fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories/${encodeURIComponent(b.id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sortOrder: a.sortOrder }),
        }),
      ]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "reorder failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(catId: string) {
    if (!window.confirm("Delete this category? Existing threads in it fall back to Uncategorized.")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/admin/rooms/${encodeURIComponent(roomId)}/thread-categories/${encodeURIComponent(catId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded border border-keep-rule bg-keep-banner/20 p-2 text-xs">
      <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">Thread categories</div>
      {error ? <div className="mb-1 text-keep-accent">{error}</div> : null}
      {cats === null ? <div className="italic text-keep-muted">loading…</div> : null}
      {cats && cats.length === 0 ? (
        <div className="italic text-keep-muted">No categories yet. Threads will all land in "Uncategorized" until you add one.</div>
      ) : null}
      {cats && cats.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {cats.map((c, idx) => (
            <li key={c.id} className="flex items-center gap-1 rounded border border-keep-rule/60 bg-keep-bg px-2 py-1">
              {editingId === c.id ? (
                <>
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") setEditingId(null); }}
                    maxLength={40}
                    className="flex-1 rounded border border-keep-rule px-1 py-0.5"
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                  />
                  <button type="button" onClick={() => saveRename(c.id)} disabled={busy} className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-keep-action hover:bg-keep-action/20 disabled:opacity-50">Save</button>
                  <button type="button" onClick={() => setEditingId(null)} className="rounded border border-keep-rule px-2 py-0.5 hover:bg-keep-banner">Cancel</button>
                </>
              ) : (
                <>
                  <span className="flex-1 truncate">{c.name}</span>
                  <button type="button" onClick={() => move(c.id, -1)} disabled={busy || idx === 0} className="rounded border border-keep-rule px-1 py-0.5 hover:bg-keep-banner disabled:opacity-40" title="Move up">▲</button>
                  <button type="button" onClick={() => move(c.id, 1)} disabled={busy || idx === cats.length - 1} className="rounded border border-keep-rule px-1 py-0.5 hover:bg-keep-banner disabled:opacity-40" title="Move down">▼</button>
                  <button type="button" onClick={() => { setEditingId(c.id); setEditName(c.name); }} className="rounded border border-keep-rule px-2 py-0.5 hover:bg-keep-banner">Rename</button>
                  <button type="button" onClick={() => remove(c.id)} disabled={busy} className="rounded border border-keep-accent/60 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50">Delete</button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-1">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={40}
          placeholder="New category name"
          className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <button
          type="button"
          onClick={add}
          disabled={busy || !newName.trim()}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-1 hover:bg-keep-banner/80 disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
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
  /** Last ~5 distinct IPs this user has logged in from, newest-first.
   *  `altCount` is the number of OTHER accounts that have logged in
   *  from the same IP — non-zero values flag ban-evasion or
   *  shared-device patterns for moderation review. */
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
  // IP pivot — when set, scopes the list to every user who has a
  // session row from this IP. Set by clicking an IP chip on any
  // user row; cleared by the "Showing alts on X — clear" affordance
  // that appears in the toolbar while a pivot is active. Stored
  // alongside `q` so the two filters compose at the server.
  const [ipPivot, setIpPivot] = useState("");
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  // Default sort lands on newest signups so admins see fresh accounts
  // first — supports the moderation workflow of "who joined since I last
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
  }, [q, ipPivot]);

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
          username and email. Editing role to "admin" grants global
          moderation - same as <code>/promoteadmin</code>. "masteradmin"
          (master-only to set) additionally unlocks settings, branding,
          rules, account-disable, and email changes.
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search username/email"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs sm:w-auto sm:shrink-0"
        />
      </div>

      {/* IP pivot chip — surfaces while a click on an IP chip in the
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
                title="Up to 5 most-recent distinct IPs the user has logged in from. Click an IP to pivot the list to every account that shares it. Numeric badge = count of OTHER accounts that have used the same IP — flag for ban evasion or shared-device review."
              >IPs &amp; alts</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("registered")}>Registered{sortIndicator("registered")}</th>
              <th className="cursor-pointer px-2 py-1 hover:text-keep-text" onClick={() => toggleSort("lastSeen")}>Last seen{sortIndicator("lastSeen")}</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {filteredSorted.map((u) => (
              <tr key={u.userId} className="border-t border-keep-rule">
                <td className="px-2 py-1 font-semibold">{u.username}</td>
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
            ))}
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
 * scopes to every other account that's used the same address —
 * the canonical "spot ban evasion / alt accounts" moderation step.
 *
 * The chip's badge is the count of OTHER accounts on this IP. 0
 * means "this IP is only this user", which is the common case for
 * residential connections; ≥1 flags shared devices / proxies / alts
 * and is worth a closer look. Larger numbers (a coffee-shop or CGNAT
 * IP, say) often have benign explanations — the chip is a starting
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
    return <span className="italic text-keep-muted">—</span>;
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
                title={`${entry.altCount} other account${entry.altCount === 1 ? "" : "s"} have logged in from this IP`}
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
   * hardcoded exception in plan.md — no matrix toggle for that one
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
  // A non-masteradmin caller can't act on a masteradmin target at all
  // (no demote, no rename, etc.) — the row stays read-only so they
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
        {/* Email is gated on `edit_user_email` — it's an
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
            {/* `masteradmin` is master-only on both ends — only a
                master can mint another master, and only a master can
                strip an existing master's role. A plain admin sees
                the option absent (it'd 403 server-side anyway). */}
            {isMaster ? <option value="masteradmin">masteradmin</option> : null}
          </select>
        </label>
        {/* Disabled toggle is gated on `disable_user`/`enable_user`
            — disabling is an account lockout, which the seed scopes
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
          This user is a master admin. Only another master admin can edit their profile or change their role.
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
      {!locked && (canResetPassword || canGrantEarning || canClearCosmetic) ? (
        <div className="mt-4 space-y-3 border-t border-keep-rule pt-3">
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
    // a secure context (https or localhost) AND a user gesture —
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
      // Silent — the password is visible in the inputs; admin can
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
 * dictated password doesn't trip the recipient up — admins commonly
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
        Goes through the live earning engine — rank recomputes, the user's wallet updates live, the ledger gets an audit row. Negative values revoke.
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
  // for this — we need to see what THEY own. The lightweight
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
              <option value="">— pick —</option>
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
              <option value="">— pick —</option>
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
          reflects the actual server state — including any grants
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
        Destructive test affordance — clears the user's XP / Currency / rank / peak, drops every character pool to zero, and removes all owned styles + borders. Useful for testing earning flows from a clean slate.
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
 *  Reports tab — triage queue for user-filed public reports
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
                  {new Date(r.messageCreatedAt).toLocaleTimeString()} — <span className="font-semibold">{r.messageDisplayName}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">{r.messageBody}</div>
              </div>
              {r.reason ? (
                <div className="mt-1 text-xs italic">Reporter note: {r.reason}</div>
              ) : null}
              {r.resolvedAt && r.resolvedByDisplayName ? (
                <div className="mt-1 text-[11px] text-keep-muted">
                  Resolved by {r.resolvedByDisplayName}
                  {r.resolutionNote ? ` — ${r.resolutionNote}` : ""}
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
 *  Audit tab — append-only feed of admin/mod actions
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
 *  Affiliates tab — partners / sponsors carousel manager
 * =========================================================
 *
 * Each row is admin-trusted raw HTML (topsite networks like toprpsites
 * require a specific anchor + tracking-pixel snippet). The HTML is rendered
 * verbatim on the splash via dangerouslySetInnerHTML; sanitizing it would
 * strip the very tracking pixels these networks are validating against.
 *
 * Same trust posture as customHeadHtml in Settings - if an admin pastes
 * hostile HTML, that's an admin-account-compromise problem.
 */
interface AffiliateRow {
  id: string;
  label: string;
  html: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

function AffiliatesTab() {
  const [rows, setRows] = useState<AffiliateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/affiliates", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { affiliates: AffiliateRow[] };
      setRows(j.affiliates);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }
  useEffect(() => { load(); }, []);

  async function remove(id: string) {
    if (!window.confirm("Delete this affiliate entry?")) return;
    try {
      const r = await fetch(`/admin/affiliates/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  async function patch(id: string, body: Partial<{ label: string; html: string; enabled: boolean; sortOrder: number }>) {
    try {
      const r = await fetch(`/admin/affiliates/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    }
  }

  return (
    <section className="space-y-3 text-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-action text-base">Affiliates / Partners / Sponsors</h3>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-xs hover:bg-keep-banner/80"
        >
          + Add
        </button>
      </header>
      <p className="text-[11px] text-keep-muted">
        Each entry is rendered as raw HTML in the splash carousel. Topsite networks (toprpsites etc.) require their
        own anchor and tracking-pixel snippet, so the HTML you paste is NOT sanitized. Treat the field the same as
        analytics scripts in Settings: only paste HTML you trust.
      </p>
      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}
      {creating ? (
        <AffiliateForm
          mode="create"
          onCancel={() => setCreating(false)}
          onSaved={async () => { setCreating(false); await load(); }}
        />
      ) : null}
      {rows === null ? (
        <p className="italic text-keep-muted">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="italic text-keep-muted">No affiliates yet. Add one to surface it on the splash.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <AffiliateListItem
              key={r.id}
              row={r}
              onPatch={(body) => patch(r.id, body)}
              onDelete={() => remove(r.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function AffiliateListItem({
  row,
  onPatch,
  onDelete,
}: {
  row: AffiliateRow;
  onPatch: (body: Partial<{ label: string; html: string; enabled: boolean; sortOrder: number }>) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li>
        <AffiliateForm
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
          <span className="ml-2 text-[10px] text-keep-muted">order: {row.sortOrder}</span>
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
          dangerouslySetInnerHTML={{ __html: row.html }}
        />
        <pre className="mt-1 overflow-x-auto rounded bg-keep-panel/30 p-2 text-[10px] text-keep-muted">{row.html}</pre>
      </details>
    </li>
  );
}

function AffiliateForm({
  mode,
  initial,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: AffiliateRow;
  onCancel: () => void;
  onSaved: (body: { label: string; html: string; enabled: boolean; sortOrder: number }) => Promise<void>;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [html, setHtml] = useState(initial?.html ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [sortOrder, setSortOrder] = useState(initial?.sortOrder ?? 0);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim() || !html.trim()) return;
    setBusy(true);
    try {
      if (mode === "create") {
        const r = await fetch("/admin/affiliates", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: label.trim(), html, enabled, sortOrder }),
        });
        if (!r.ok) throw new Error(await readError(r));
        await onSaved({ label: label.trim(), html, enabled, sortOrder });
      } else {
        await onSaved({ label: label.trim(), html, enabled, sortOrder });
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg p-2 text-xs">
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
        <label className="flex items-center gap-1">
          <span className="text-keep-muted">Sort order:</span>
          <input
            type="number"
            min={0}
            max={1000}
            value={sortOrder}
            onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
            className="w-16 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 outline-none focus:border-keep-action"
          />
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
