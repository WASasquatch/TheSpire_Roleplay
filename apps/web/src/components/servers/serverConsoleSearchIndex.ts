/**
 * Find-a-setting index for the Server Admin console (docs/ADMIN_IA.md §6).
 *
 * This module is DATA ONLY, the per-server twin of
 * `../admin/adminSearchIndex.ts`: a curated key→place map the shared
 * FindSetting component resolves against the loaded i18next `servers`
 * catalog at runtime, so the searchable text always matches the viewer's
 * locale (with i18next's built-in en fallback — Spanish search is never
 * empty). No strings live here; every `key` / `also` value is a
 * servers-namespace catalog key. All search CHROME strings (placeholder,
 * aria, counts) stay in the admin namespace, owned by FindSetting itself.
 *
 * Anchor contract (same as the Global Admin panel): each entry's `key`
 * doubles as the jump target — the tab that owns the row stamps
 * `data-admin-anchor="<key>"` (the catalog key, verbatim, dots included)
 * on its wrapping `<label>` / `<fieldset>`. Missing anchors are harmless:
 * picking the hit still switches tabs, the scroll+flash just no-ops.
 *
 * Tab-level entries (`console.tabs.<id>`) are NOT listed here —
 * ServerSettingsView derives them from its CONSOLE_TAB_ITEMS registry so
 * they can never drift. v1 ships tab-level entries only; row-level console
 * entries are a later ADDITIVE pass: append entries below + stamp anchors
 * (the console Settings tab rows already carry theirs), nothing else
 * changes. The type-only import back into the view is erased at compile
 * time, so there is no runtime cycle.
 */
import type { FindSettingEntry, FindSettingRedirect } from "../admin/FindSetting.js";
import type { ServerSettingsTab } from "./ServerSettingsView.js";

/** One findable console row: a servers-namespace catalog key plus the
 *  console tab picking it should land on. No subtabs in v1. */
export type ServerConsoleSearchEntry = FindSettingEntry<ServerSettingsTab>;

/** Curated row-level entries (tab-level entries are derived in
 *  ServerSettingsView). Every `key` here is stamped as a data-admin-anchor
 *  by the owning tab. Candidate anchors already stamped but not yet listed:
 *  console.settings.retention / maxRooms / maxMessage / editWindow /
 *  maxForumPost. */
export const SERVER_CONSOLE_SEARCH_ENTRIES: readonly ServerConsoleSearchEntry[] = [
  // Overview tab: the community-world picker (anchor on its fieldset box).
  { key: "console.overview.world", tab: "overview", also: ["console.overview.worldHint"] },
  // Rooms tab: category strip manager + the grouped room list (manual
  // ordering arrows + per-room icon/category fields live inside it).
  { key: "console.rooms.categories.title", tab: "rooms", also: ["console.rooms.categories.hint"] },
  // Creation defaults (migration 0351): the per-category "default for new
  // rooms" toggle + role→category mappings (anchor on the category list).
  { key: "console.rooms.categories.defaultLabel", tab: "rooms", also: ["console.rooms.categories.defaultHint", "console.rooms.categories.rolesLabel", "console.rooms.categories.rolesHint", "console.rooms.categories.defaultsHint"] },
  { key: "console.rooms.orderTitle", tab: "rooms", also: ["console.rooms.iconLabel", "console.rooms.categoryLabel"] },
  // Per-room editor rows (anchors live on the RoomEditForm labels; the form
  // mounts per-room, so an unopened editor just tab-switches — harmless by
  // the anchor contract above).
  { key: "console.rooms.postModeLabel", tab: "rooms", also: ["console.rooms.postModeStaff", "console.rooms.postModeRoles", "console.rooms.postModeHint"] },
  { key: "console.rooms.accessLabel", tab: "rooms", also: ["console.rooms.accessRoles", "console.rooms.accessHint"] },
  { key: "console.rooms.lifetimeLabel", tab: "rooms", also: ["console.rooms.lifetimeNever", "console.rooms.lifetimeInherit"] },
  // Roles tab (id `usergroups`): the per-role userlist badge toggle (anchor
  // lives on the role editor's label; the editor mounts per-role, so an
  // unopened editor just tab-switches — harmless by the anchor contract
  // above).
  { key: "console.usergroups.showBadgeLabel", tab: "usergroups", also: ["console.usergroups.showBadgeHint", "console.usergroups.badgeSection"] },
  // Staff tab (id `roles`): the appoint box. Its blurbs carry the
  // "moderator"/"admin" keywords so those searches land on Staff.
  { key: "console.roles.appointStaff", tab: "roles", also: ["console.roles.moderatorBlurb", "console.roles.adminBlurb"] },
];

/** "Not in this console" redirect rows. None curated for v1. */
export const SERVER_CONSOLE_SEARCH_REDIRECTS: readonly FindSettingRedirect[] = [];
