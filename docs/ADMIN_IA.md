# ADMIN_IA.md, the binding information-architecture spec for the ELI5 admin build

Status: BINDING. Implementers follow this file; deviations go back through the
orchestrator. Grounded in the code as of 2026-07-09 (files cited inline).

EXECUTION STATUS (2026-07-09): built in full — including the §6 server-console
search (nothing was deferred); `serverConsoleSearchIndex.ts` ships the v1
tab-level scope with row-level entries left as the future additive pass.

Mission recap: make both admin surfaces findable by non-technical owners.
Grouped navigation with plain-language names, a one-line "what you do here"
description on every tab, a find-a-setting search, and the giant Settings tab
split into digestible subtabs. ZERO functional changes: every setting keeps its
exact behavior, permission gate, save footer, unsaved-changes nudge, and wire
contract. Navigation, organization, and copy ONLY.

Hard constraints (repeated because they are load-bearing):

- Tab ids, permission keys, `recordNav` tab keys (`admin:<tab>`,
  `server-settings:<tab>`), and `data-tour` anchors DO NOT change.
- No `apps/server` changes. No new endpoints. No payload changes.
- Every new user-facing string lands in BOTH `packages/shared/locales/en/*.json`
  and `es/*.json` (Spanish per `packages/shared/locales/es/GLOSSARY.md`: tú,
  es-419, plain words). Copy rules: no em dashes, no dev jargon, mirror the
  hand-written guide voice. Never edit `apps/web/src/lib/i18n.ts`.
- Catalog ownership: the Shell & Search agent owns ALL `admin.json` additions
  in this build (en + es); the Server Admin agent owns ALL `servers.json`
  additions. Section 9 enumerates every string so each lands in one pass.
- Runtime `<style>` injection is CSP-blocked in prod. The search flash
  highlight and any new visuals use static CSS classes in the app stylesheet
  (same place `tk-fade-in` lives), never a React `<style>` element.
- Reduce Motion (`useReducedMotion`) gates any new animation or smooth scroll.

---

## 1. Ground truth inventory

### 1.1 Global Admin (apps/web/src/components/admin/)

`AdminPanel.tsx` `TAB_ITEMS` registry: 19 live tabs. Current groups in code:
`monitor | people | content | siteconfig | system` (labels at
`admin:panel.group.*`, tab labels at `admin:panel.tab.*`).

| Tab id (STAYS) | Component | Gate | Current group |
|---|---|---|---|
| overview | AdminOverviewTab.tsx | (none) | monitor |
| analytics | AnalyticsTab.tsx | view_admin_analytics | monitor |
| audit | AdminAuditTab.tsx | (none) | monitor |
| reports | AdminReportsTab.tsx | (none) | monitor |
| mod-cases | AdminModCasesTab.tsx | view_admin_mod_cases | monitor |
| verify-logs | AdminVerifyLogTab.tsx | verify_export_logs | monitor |
| permissions | AdminPermissionsTab.tsx | view_admin_permissions | people |
| users | AdminUsersTab.tsx | (none) | people |
| scriptorium | AdminScriptoriumTab.tsx | (none) | content |
| forums | AdminForumsTab.tsx | view_admin_forums | content |
| servers | AdminServersTab.tsx | view_admin_servers | content |
| email | AdminEmailTab.tsx | view_admin_email | siteconfig |
| settings | AdminSettingsTab.tsx | view_admin_settings | siteconfig |
| branding | AdminBrandingTab.tsx | view_admin_branding | siteconfig |
| rules | AdminRulesTab.tsx | view_admin_rules | siteconfig |
| links | AdminLinksTab.tsx | (none) | siteconfig |
| affiliates | AdminAffiliatesTab.tsx | (none) | siteconfig |
| system | AdminSystemTab.tsx | view_system_metrics | system |
| backups | AdminBackupsTab.tsx | view_admin_backups | system |

ORPHANS (do NOT put in nav, do NOT index): `AdminEmoticonsTab.tsx`,
`AdminAnnouncementsTab.tsx`, `AdminFaqsTab.tsx`, `AdminEarningTab.tsx` are
exported but imported nowhere; their features moved per-server (Admin
Partition) and their live twins are `components/server-admin/*`. They explain
why the folder has 23 tab components but the registry has 19. Leave them alone.

Shell facts the build must preserve: per-tab footer via
`useAdminShell().setFooter` (adminShell.tsx), `AdminSaveFooter` with `dirty`
nudge, body render gates mirroring `tabVisible`, `HOME_SERVER_SCOPED_TABS`
note, calm-mode `key={tab}` fade, mobile `<select>` with `<optgroup>` per
group, desktop strip with group separators via `withGroupSeparators`.

### 1.2 AdminSettingsTab.tsx contents (the tab being split)

One `<form id="admin-settings-form">` (single PUT `/admin/settings`), one
`AdminSaveFooter`, one form-level `onChange` dirty nudge. Fieldsets in DOM
order, with the i18n keys that name them:

1. Message retention (`settings.retentionLegend`), duration input.
2. Idle timeout (`settings.idleTimeoutLegend`), duration input.
3. Idle ghost lifetime (`settings.idleGhostLegend`), duration input.
4. Limits & capacity (`settings.limitsLegend`), one grid of 19 rows:
   `maxCharsLabel`, `maxEmailLabel`, `maxRoomsLabel`, `maxMsgLenLabel`,
   `maxDmLenLabel`, `maxForumLenLabel`, `maxForumTitleLenLabel`,
   `forumTopicsPerPageLabel`, `editWindowLabel`, `maxBioLenLabel`,
   `registrationLabel`, `activityFeedsLabel`, `messages24hLabel`,
   `featuredWorldsLabel`, `designerLabel`, `multiServerLabel`,
   `antiSpamLabel`, `automodLabel`, `signupAgeLabel`.
5. Language filter for under-18s (`settings.minorFilterLegend`): master
   toggle + Added words + Never censor textareas.
6. Default theme (`settings.defaultThemeLegend`): ThemePicker.
7. Theme style (`settings.themeStyleLegend`): StylePicker.
8. Designs by theme (`settings.designsByThemeLegend`): per-preset pickers.

OUTSIDE the form, same tab body: the Auto-moderation rules card
(`AutomodRulesCard`, `settings.automodRulesLegend`), self-contained CRUD +
test box against `/admin/automod/*`. It must stay outside the form.

### 1.3 Server Admin console (apps/web/src/components/servers/ServerSettingsView.tsx)

21 tabs (`ServerSettingsTab` union), labels at `servers:console.tabs.*`
(currently lowercase words, no grouping, flat mobile `<select>`). Gates are
per-server permissions (`can(...)`), listed for reference; they DO NOT change:

| Tab id (STAYS) | Label key | Gate |
|---|---|---|
| overview | console.tabs.overview | manage_appearance |
| appearance | console.tabs.appearance | manage_appearance |
| rooms | console.tabs.rooms | manage_rooms |
| members | console.tabs.members | manage_members |
| users | console.tabs.users | kick/mute/ban/manage_members |
| roles | console.tabs.roles | manage_members |
| usergroups | console.tabs.usergroups | manage_usergroups |
| applications | console.tabs.applications | manage_applications |
| reports | console.tabs.reports | manage_reports |
| modcases | console.tabs.modcases | manage_mod_cases |
| bans | console.tabs.bans | ban_member or unban_member |
| modlog | console.tabs.modlog | view_mod_log |
| emoticons | console.tabs.emoticons | manage_emoticons |
| announcements | console.tabs.announcements | manage_announcements |
| events | console.tabs.events | manage_events |
| faqs | console.tabs.faqs | manage_faqs |
| commands-titles | console.tabs.commandsTitles | manage_commands or manage_titles |
| earning | console.tabs.earning | manage_earning |
| rules | console.tabs.rules | manage_appearance |
| onboarding | console.tabs.onboarding | manage_appearance |
| settings | console.tabs.settings | manage_appearance |

Default tab is `tabs[0] ?? "modlog"` (first VISIBLE tab). Keep that exact
expression; section 6 fixes the visible order so `overview` stays first for
owners.

---

## 2. Global Admin groups (the map)

Six groups. Membership changes from today: ONLY `email` and `affiliates` move
(out of siteconfig, into the new growth group). Everything else keeps its
bucket, so the site-admin tour copy (tours.json `siteAdmin.*`) stays truthful
and needs NO edits. Group ids are display-only (never persisted, never sent on
the wire), so renaming ids is safe; tab ids inside are untouched.

| Group id | en label (admin:panel.group.*) | Tabs, in strip order |
|---|---|---|
| monitor | Keeping watch | overview, analytics, audit, reports, mod-cases, verify-logs |
| people | Members & roles | permissions, users |
| content | Communities & content | scriptorium, forums, servers |
| siteconfig | Site setup | settings, branding, rules, links |
| growth (NEW) | Growth & email | email, affiliates |
| system | Backups & maintenance | system, backups |

Implementation notes:

- `TabGroup` union in AdminPanel.tsx becomes
  `"monitor" | "people" | "content" | "siteconfig" | "growth" | "system"`.
- In `TAB_ITEMS`, move the `email` entry down next to `affiliates` and stamp
  both `group: "growth"`; the growth block sits between siteconfig and system
  (destructive tabs stay last, keep that comment).
- Within-group order does not change anywhere. Default tab stays `overview`.
- The existing `panel.group.*` keys are RELABELED in en + es (section 9); only
  `panel.group.growth` is a new key. No key deletions.
- Desktop separators (`withGroupSeparators`) and the mobile `<optgroup>`s pick
  the new grouping up automatically from `TAB_ITEMS`; no other logic changes.

---

## 3. Tab display names and one-line descriptions (Global Admin)

Display names live at `admin:panel.tab.<id>`; five get plainer labels
(relabels of existing keys, en + es). Descriptions are NEW keys
`admin:panel.tabDesc.<id>`, one per tab.

Where the description renders: AdminPanel body, first element inside the
scrolling body div, above the `homeServerScope` note and the tab component:

```tsx
<p className="mb-3 text-[11px] text-keep-muted">{t(`panel.tabDesc.${tab}`)}</p>
```

Rendered by the SHELL for every tab (one code path, no per-tab edits). It
scrolls with the body. Same treatment on mobile and desktop.

| Tab id | en display name | en description (panel.tabDesc.*) |
|---|---|---|
| overview | Overview (keep) | Your site at a glance: who is online, new sign-ups, and how busy chat has been. |
| analytics | Analytics (keep) | See where visitors come from and which parts of the site people actually use. |
| audit | Staff Actions (was Audit) | A running record of every staff action, so you can always check who did what. |
| reports | Reports (keep) | Complaints members have filed. Look at each one and decide what happens. |
| mod-cases | Mod Cases (was Mod Log) | Your moderation casebook: write up incidents, add updates, and save evidence. |
| verify-logs | Log Check (was Verify Log) | Paste an exported chat log to check it is real and has not been edited. |
| permissions | Roles & Permissions (was Permissions) | Decide what each role is allowed to do, or fine-tune one person's powers. |
| users | Users (keep) | Look up any account to change its role, help with a password, or handle trouble. |
| scriptorium | Scriptorium (keep, product name) | Reports about stories in the Scriptorium. Review them and act if needed. |
| forums | Forums (keep) | Approve or decline requests for new forums, and manage the ones already open. |
| servers | Servers (keep) | Approve or decline requests for new servers, and step into any of them. |
| email | Email (keep) | Send mail to members: a single person, everyone, or a newsletter. |
| settings | Settings (keep) | The main switchboard: sign-ups, limits, safety filters, and site defaults. |
| branding | Branding (keep) | Your site's name, logo, welcome text, and how it shows up in search results. |
| rules | Rules (keep) | Write the rules and the notices people agree to when they sign up. |
| links | Banner Links (was Nav Links) | Add your own links to the top banner, like a wiki or a partner site. |
| affiliates | Top Communities (keep) | The partner cards in the Top RP Communities section, and member submissions. |
| system | System (keep) | Live server health, plus restart and cleanup tools for emergencies. |
| backups | Backups (keep) | Save a full copy of everything, and restore one if something goes wrong. |

Renames touch ONLY `panel.tab.*` catalog values (en + es). Tab ids, permission
keys, and analytics keys stay. The `mod-cases` rename to "Mod Cases" must not
be confused with the audit tab: Staff Actions = what staff DID (append-only
feed); Mod Cases = incident casebook staff WRITE.

---

## 4. The Settings subtab split

Five subtabs inside the existing Settings tab. HARD REQUIREMENTS:

- ONE `<form id="admin-settings-form">`, ONE `AdminSaveFooter`, ONE
  `touchedSinceSave` dirty nudge, ONE PUT `/admin/settings` with the same
  body. Nothing about `save()` or `load()` changes.
- Hidden subtab sections stay MOUNTED and are hidden with the HTML `hidden`
  attribute (CSS display:none). Never conditional-render them: unsaved edits
  in controlled inputs must survive subtab switches, and the form-level
  `onChange` dirty listener must keep receiving bubbled events from every
  section. (`save()` reads React state, not FormData, so display:none is
  fully safe.)
- Switching subtabs does NOT reset `touchedSinceSave` and does NOT remount
  the form. The calm-mode `key={tab}` fade keys on the OUTER tab only.
- The Auto-moderation rules card stays OUTSIDE the form exactly as today; it
  is wrapped in its own `hidden`-toggled div tied to the safety subtab.
- The one intentional reorganization inside the form: the single giant
  "Limits & capacity" fieldset (`settings.limitsLegend`) is split into five
  smaller fieldsets (new legends below). The rows are the SAME JSX elements
  bound to the SAME state hooks, just re-parented within the same form; the
  `settings.limitsLegend` key stops being rendered but is NOT deleted.
- Validation errors keep surfacing in the footer (unchanged), even when the
  failing field sits on another subtab. Do not add auto-switch-on-error.

Subtab ids (`type SettingsSubtab = "accounts" | "chat" | "safety" | "theme" |
"features"`), labels at NEW keys `admin:settings.subtab.*`:

### accounts, "Joining & accounts"
- NEW fieldset `settings.accountLimitsLegend` ("Sign-ups & account limits"):
  registration toggle, sign-up age toggle, max accounts / email,
  max characters / user, max rooms / owner, max bio length.

### chat, "Chat & forums"
- Message retention fieldset (intact).
- Idle timeout fieldset (intact).
- Idle ghost lifetime fieldset (intact).
- NEW fieldset `settings.chatLimitsLegend` ("Message limits"):
  max chat message length, max direct message length, edit / delete window.
- NEW fieldset `settings.forumLimitsLegend` ("Forum limits"):
  max forum post length, max forum topic title length, forum topics per page.

### safety, "Safety & filters"
- NEW fieldset `settings.safetyTogglesLegend` ("Automatic protection"):
  anti-spam toggle, auto-moderation toggle.
- Language filter for under-18s fieldset (intact).
- Auto-moderation rules card (intact, outside the form).

### theme, "Look & theme"
- Default theme fieldset (intact).
- Theme style fieldset (intact).
- Designs by theme fieldset (intact).

### features, "Homepage & extras"
- NEW fieldset `settings.homepageTogglesLegend` ("Homepage stats"):
  activity feeds, messages in last 24h, featured worlds carousel.
- NEW fieldset `settings.featureTogglesLegend` ("Big feature switches"):
  profile bio Designer, multi-server.

Every one of the 19 old grid rows is assigned above exactly once; the three
duration fieldsets, minor filter, three theme fieldsets, and the automod card
are assigned exactly once. Nothing is dropped.

Subtab UI: a small strip of `TabBtn`s under the `settings.description` line
(which stays), `flex-wrap` so it wraps on phones, `aria-label` =
`settings.subtabAria`. Default subtab: `accounts`. Subtab switches SHOULD
record `recordNav("tab", "admin:settings:<subtab>")`, matching the existing
choke-point pattern for section switches (flag to the verifier: this is the
single intentional telemetry addition; drop it if zero-telemetry is ruled).

SettingsTab accepts two new optional props for search (section 5):
`findRequest?: { subtab: SettingsSubtab; anchor: string } | null` and
`onFindHandled?: () => void`.

---

## 5. Find-a-setting search (Global Admin)

### 5.1 Placement

- Desktop header row: a real text input between the tab strip and the "?"
  replay button, ~14rem wide, placeholder `panel.search.placeholder`,
  `aria-label` = `panel.search.aria`. Results render in a popover list
  anchored under the input (absolute within the modal card, above the body).
- Mobile header row: a search icon button (lucide `Search`, with `title` +
  `aria-label` = `panel.search.open`) between the `<select>` and the close
  button. Tapping swaps in a full-width row: autofocus input + results as a
  block list under the header; picking a hit or pressing the X restores the
  normal row.
- Keyboard: ArrowUp/Down move the active row, Enter picks it, Esc closes.
  Listbox ARIA (`role="listbox"` / `role="option"`).

### 5.2 Index: built at RUNTIME from the loaded i18next resources

New module `apps/web/src/components/admin/adminSearchIndex.ts`:

```ts
import type { PermissionKey } from "@thekeep/shared";

/** One findable thing. `key` is an admin-namespace catalog key; its
 *  translated text is the row title AND the data-admin-anchor value. */
export interface AdminSearchEntry {
  key: string;                      // e.g. "settings.retentionLegend"
  tab: AdminTab;                    // Tab union from AdminPanel.tsx
  subtab?: SettingsSubtab;          // only when tab === "settings"
  also?: readonly string[];         // extra keys folded into the match text
}

/** Curated "not in this panel" rows. Never navigate; render label + hint. */
export interface AdminSearchRedirect {
  labelKey: string;                 // "panel.search.redirect.<name>"
  hintKey: string;                  // "panel.search.redirect.<name>Hint"
}

export const ADMIN_SEARCH_ENTRIES: readonly AdminSearchEntry[] = [ /* 5.4 */ ];
export const ADMIN_SEARCH_REDIRECTS: readonly AdminSearchRedirect[] = [ /* 5.5 */ ];
```

Runtime build (inside the search component): for each entry resolve
`t(entry.key)` plus every `t(also[i])` in the ACTIVE locale via the admin
namespace (i18next already falls back to en for untranslated keys, so Spanish
search is free and never empty). Normalize haystack and query with
lowercase + NFD diacritic stripping so "configuracion" matches
"configuración". Rank: label startsWith > label word match > hint match.
Rebuild memoized on `i18n.language` and on the viewer's permission set.

Permission awareness: filter entries through the SAME `tabVisible` predicate
AdminPanel uses (export it or pass the visible-tab id set down); a viewer
never sees a hit for a tab they cannot open. Redirect rows always show.

Result row rendering: translated label, then a muted breadcrumb assembled
from already-translated pieces: group label + "›" + tab label (+ "›" + subtab
label when present). The "›" separators are aria-hidden literals, no key.
Below the entry hits, when redirect rows match, a muted section headed by
`panel.search.elsewhereHeading`.

### 5.3 Anchors and the pick behavior

Anchor scheme: every indexed fieldset or labeled row gets
`data-admin-anchor="<catalog key>"` stamped on its `<fieldset>` (fieldset
entries) or its wrapping `<label>` (row entries). The attribute value IS the
entry `key`, verbatim (dots included).

Picking a hit:

1. `setPendingFind(entry)` in AdminPanel state
   (`{ tab, subtab?, anchor: entry.key }`), then `changeTab(entry.tab)`
   (this reuses the existing `recordNav` choke point, no new telemetry).
   Behavior on unsaved edits is EXACTLY today's tab-click behavior: edits on
   the abandoned tab drop silently. Do not add a confirm.
2. Tab-level entries (key `panel.tab.<id>`) stop here; clear pendingFind.
3. For `tab !== "settings"`: after the tab body mounts (double
   `requestAnimationFrame`), `document.querySelector` the anchor with
   `CSS.escape`, `scrollIntoView({ block: "center", behavior: reduceMotion ?
   "auto" : "smooth" })`, add the flash class, clear pendingFind. Missing
   anchor = silently just switch tabs (never throw).
4. For `tab === "settings"`: AdminPanel passes
   `findRequest={{ subtab, anchor }}` + `onFindHandled` into SettingsTab;
   SettingsTab sets its subtab state, then does the same scroll + flash on
   the anchor (which is now un-hidden), then calls `onFindHandled`.

Flash highlight: a static class (suggested `tk-find-flash`) in the app's
global stylesheet next to `tk-fade-in`: a 1.5s outline pulse in the theme
action color, with a `prefers-reduced-motion` block AND the class simply not
animating when the per-device Reduce Motion flag is on (apply a plain
non-animated outline for 1.5s instead). No inline styles, no runtime
`<style>` (CSP).

### 5.4 The v1 entry list (complete)

Tab-level entries (all 19, derived in code from `TAB_ITEMS`, do not hand-list):
`{ key: "panel.tab.<id>", tab: <id>, also: ["panel.tabDesc.<id>"] }`.

Settings row entries (subtab + anchor; `also` keys fold hint/on/off text into
the haystack):

| key (= anchor) | subtab | also |
|---|---|---|
| settings.retentionLegend | chat | retentionHelp |
| settings.idleTimeoutLegend | chat | idleTimeoutHelp |
| settings.idleGhostLegend | chat | idleGhostHelp |
| settings.maxMsgLenLabel | chat | maxMsgLenHint |
| settings.maxDmLenLabel | chat | maxDmLenHint |
| settings.editWindowLabel | chat | editWindowHint |
| settings.maxForumLenLabel | chat | maxForumLenHint |
| settings.maxForumTitleLenLabel | chat | maxForumTitleLenHint |
| settings.forumTopicsPerPageLabel | chat | forumTopicsPerPageHint |
| settings.registrationLabel | accounts | registrationHint, registrationOn, registrationOff |
| settings.signupAgeLabel | accounts | signupAgeHint, signupAgeOn, signupAgeOff |
| settings.maxEmailLabel | accounts | maxEmailHint |
| settings.maxCharsLabel | accounts | maxCharsHint |
| settings.maxRoomsLabel | accounts | maxRoomsHint |
| settings.maxBioLenLabel | accounts | maxBioLenHint |
| settings.antiSpamLabel | safety | antiSpamHint, antiSpamOn, antiSpamOff |
| settings.automodLabel | safety | automodHint, automodOn, automodOff |
| settings.automodRulesLegend | safety | automodRulesHelp |
| settings.minorFilterLegend | safety | minorFilterHelp, minorFilterOn, minorFilterOff |
| settings.minorFilterTermsLabel | safety | minorFilterTermsHint |
| settings.minorFilterAllowLabel | safety | minorFilterAllowHint |
| settings.defaultThemeLegend | theme | defaultThemeHelp |
| settings.themeStyleLegend | theme | themeStyleHelp |
| settings.designsByThemeLegend | theme | designsByThemeHelp |
| settings.activityFeedsLabel | features | activityFeedsHint, activityFeedsOn, activityFeedsOff |
| settings.messages24hLabel | features | messages24hHint, messages24hOn, messages24hOff |
| settings.featuredWorldsLabel | features | featuredWorldsHint, featuredWorldsOn, featuredWorldsOff |
| settings.designerLabel | features | designerHint, designerOn, designerOff |
| settings.multiServerLabel | features | multiServerHint, multiServerOn, multiServerOff |

(`also` values above are all within the `settings.` prefix; write them fully
qualified in the module.)

Branding fieldset entries (tab `branding`, anchor on each `<fieldset>`):
`branding.siteNameLegend`, `branding.siteUrlLegend`,
`branding.taglineLegend`, `branding.logoImageLegend`,
`branding.logoColorLegend`, `branding.logoFontLegend`,
`branding.bannerCoverLegend`, `branding.welcomeLegend`,
`branding.seoDescLegend`, `branding.seoKeywordsLegend`,
`branding.ogImageLegend`, `branding.serpLegend`,
`branding.verificationLegend`, `branding.indexingLegend`,
`branding.socialProfilesLegend`, `branding.customHeadLegend`. (Any additional
fieldset found while stamping, e.g. a new-user welcome section, gets an entry
keyed on its existing legend key; do not mint new label keys for this.)

Rules fieldset entries (tab `rules`): `rules.appRulesLegend`,
`rules.welcomeLegend`, `rules.securityLegend`, `rules.disclaimerLegend`,
`rules.serverRegLegend`, `rules.forumRegLegend`.

Other tabs are covered by their tab-level entry in v1. Extension is additive:
append entries + stamp anchors; nothing else changes.

### 5.5 Curated NOT-IN-ADMIN redirects

| labelKey | en label | hintKey | en hint |
|---|---|---|---|
| panel.search.redirect.language | Site language | panel.search.redirect.languageHint | Not in this panel. Open the Menu and look under Display. |
| panel.search.redirect.profile | Your name, avatar, and profile style | panel.search.redirect.profileHint | Not in this panel. Open Edit Profile from the menu. |
| panel.search.redirect.notifications | Notifications and alerts | panel.search.redirect.notificationsHint | Not in this panel. Open Edit Profile from the menu. |
| panel.search.redirect.serverAdmin | Settings for one community server | panel.search.redirect.serverAdminHint | Each server has its own admin. Open it from the server's gear icon. |

Redirect rows are informational only in v1 (no navigation on click), so they
cannot break any flow.

---

## 6. Server Admin mirror

Tab count (21) clearly warrants grouping. Five groups, display-only, in this
strip order (within-group order preserves today's relative order except where
noted; ids stay, gates stay):

| Group id | en label (servers:console.group.*) | Tabs, in order |
|---|---|---|
| basics | Your community | overview, appearance, rules, onboarding, settings |
| people | People | members, users, roles, usergroups, applications |
| safety | Safety | reports, modcases, bans, modlog |
| activity | Rooms & events | rooms, announcements, events, faqs |
| rewards | Fun & rewards | emoticons, commands-titles, earning |

Notes:

- `overview` stays the first VISIBLE tab for anyone with manage_appearance,
  so `tabs[0] ?? "modlog"` still lands owners on Overview. `rules`,
  `onboarding`, `settings` move up next to it (all four share the
  manage_appearance gate, so a viewer sees all or none of the basics group
  apart from what other grants add). `rooms` moves into activity.
- Build the grouped strip + mobile `<optgroup>` select by EXTRACTING
  AdminPanel's `groupVisibleTabs` + `withGroupSeparators` helpers into
  `apps/web/src/components/shared/tabGroups.ts` (pure move, generic type
  parameters) and importing them in both shells. The console's `tabs` array
  becomes a `{ id, group }` list filtered by the same `can(...)` calls it has
  today; empty groups drop out.
- Tab display relabels (existing `console.tabs.*` values, en + es):
  `usergroups` -> "member groups"; `onboarding` -> "welcome questions". All
  other labels keep. Keep the console's lowercase label style.
- Descriptions: NEW keys `servers:console.tabDesc.<id>` rendered by the
  console shell exactly like the Global Admin line (one muted line above the
  tab body, under the strip).
- The server-admin contextual tour anchors (`server-settings-tab-<id>`) are
  stamped per tab id and survive reordering; tours.json needs no edits.

Server console descriptions (en copy; keys use the camelCase tab key where
the label key does, i.e. `console.tabDesc.commandsTitles`):

| Tab | en description |
|---|---|
| overview | Your community's name, description, and how people join. |
| appearance | Logo, colors, and the design your community wears. |
| rooms | Every room in this community, in one list. |
| members | Everyone who belongs here, and the option to remove someone. |
| users | Find one member fast to mute, ban, or remove them. |
| roles | Hand out admin and mod powers, and choose exactly what each helper may do. |
| usergroups | Groups your members can be sorted into, like teams or interests. |
| applications | Requests from people who want to join. Approve or decline. |
| reports | Complaints about messages in this community. Review and act. |
| modcases | Your moderation casebook here: incidents, updates, and outcomes. |
| bans | Who is banned here, for how long, and the tools to undo it. |
| modlog | A record of every moderation action taken in this community. |
| emoticons | Upload and manage this community's own sticker sheets. |
| announcements | Banners and scheduled notices your members will see. |
| events | Plan gatherings on the community calendar, with optional reminders. |
| faqs | Questions and answers new members often need. |
| commandsTitles | Custom chat commands, and the titles members can carry. |
| earning | Rewards for being active: ranks, currency, the shop, and hand-outs. |
| rules | Write this community's rules and welcome text. |
| onboarding | Ask new members a question or two and sort them into groups. |
| settings | Limits for this community: message length, room caps, and chat history. |

Search: the console SHARES the search component. DECISION: build the search
UI as a generic component (`FindSetting.tsx`, props: `entries`, `redirects`,
`resolve: (key) => string` or an `ns` prop, `visibleTabIds`, `onPick`), with
all search CHROME strings living in the admin namespace (`panel.search.*`,
owned by the Shell agent) so both surfaces share one set. The console
instance is scoped to a `serverConsoleSearchIndex.ts` whose entries use
servers-namespace keys, tab ids from `ServerSettingsTab`, no subtabs, anchor
attribute `data-admin-anchor` (same attribute, same flash class). v1 console
index = tab-level entries only (`console.tabs.<id>` + `console.tabDesc.<id>`
as `also`); row-level console entries are a later additive pass. The console
search sits in the console header next to the "?" button (desktop) and as an
icon-toggled row on mobile, identical interaction to section 5.1. If build
time runs out, the console search is the ONE deferrable item in this spec;
groups + descriptions are not deferrable.

---

## 7. Mobile behavior (both surfaces)

- Global Admin (already `variant="mobile-fullscreen"`): keep the single-row
  header of title + `<select>` + close, ADD the search icon button before the
  close button (5.1). The `<select>` keeps `<optgroup>` labels, now the six
  new groups. The description line renders at the top of the body (scrolls).
  The Settings subtab strip wraps to two rows on narrow screens (flex-wrap);
  no nested dropdown.
- Server console: the flat mobile `<select>` gains `<optgroup>`s from the
  same grouping; desktop strip gains the hairline group separators. Search
  icon (if console search ships) sits in the header next to "?".

---

## 8. Implementation guardrails checklist

- [ ] Tab ids, `PermissionKey` gates, `masterOnly` handling, `tabVisible`,
      body render gates: byte-equivalent logic.
- [ ] `recordNav("tab", "admin:<tab>")` and `server-settings:<tab>` keys
      unchanged; subtab telemetry only as specified in section 4.
- [ ] `TAB_TOUR_ANCHOR` and all `data-tour` stamps unchanged.
- [ ] Settings: one form, one footer, one dirty flag, one PUT; hidden
      sections use the `hidden` attribute, never unmount.
- [ ] AutomodRulesCard stays outside the form.
- [ ] `HOME_SERVER_SCOPED_TABS` note still renders (after the new
      description line).
- [ ] No new dependencies. No server changes. No `<style>` elements.
- [ ] Reduce Motion: smooth scroll and flash animation gated.
- [ ] Orphan components untouched and unindexed.
- [ ] Repo lint stays exit 0; no new unwrapped literals (every string below
      goes through `t()`).
- [ ] Web typecheck green.

---

## 9. Complete new-string list

### 9.1 admin namespace (Shell & Search agent, en + es in one pass)

RELABELS (existing keys, new values):

| Key | New en value |
|---|---|
| panel.group.monitor | Keeping watch |
| panel.group.people | Members & roles |
| panel.group.content | Communities & content |
| panel.group.siteconfig | Site setup |
| panel.group.system | Backups & maintenance |
| panel.tab.audit | Staff Actions |
| panel.tab.mod-cases | Mod Cases |
| panel.tab.verify-logs | Log Check |
| panel.tab.permissions | Roles & Permissions |
| panel.tab.links | Banner Links |

NEW keys:

| Key | en value |
|---|---|
| panel.group.growth | Growth & email |
| panel.tabDesc.overview | Your site at a glance: who is online, new sign-ups, and how busy chat has been. |
| panel.tabDesc.analytics | See where visitors come from and which parts of the site people actually use. |
| panel.tabDesc.audit | A running record of every staff action, so you can always check who did what. |
| panel.tabDesc.reports | Complaints members have filed. Look at each one and decide what happens. |
| panel.tabDesc.mod-cases | Your moderation casebook: write up incidents, add updates, and save evidence. |
| panel.tabDesc.verify-logs | Paste an exported chat log to check it is real and has not been edited. |
| panel.tabDesc.permissions | Decide what each role is allowed to do, or fine-tune one person's powers. |
| panel.tabDesc.users | Look up any account to change its role, help with a password, or handle trouble. |
| panel.tabDesc.scriptorium | Reports about stories in the Scriptorium. Review them and act if needed. |
| panel.tabDesc.forums | Approve or decline requests for new forums, and manage the ones already open. |
| panel.tabDesc.servers | Approve or decline requests for new servers, and step into any of them. |
| panel.tabDesc.email | Send mail to members: a single person, everyone, or a newsletter. |
| panel.tabDesc.settings | The main switchboard: sign-ups, limits, safety filters, and site defaults. |
| panel.tabDesc.branding | Your site's name, logo, welcome text, and how it shows up in search results. |
| panel.tabDesc.rules | Write the rules and the notices people agree to when they sign up. |
| panel.tabDesc.links | Add your own links to the top banner, like a wiki or a partner site. |
| panel.tabDesc.affiliates | The partner cards in the Top RP Communities section, and member submissions. |
| panel.tabDesc.system | Live server health, plus restart and cleanup tools for emergencies. |
| panel.tabDesc.backups | Save a full copy of everything, and restore one if something goes wrong. |
| panel.search.placeholder | Find a setting... |
| panel.search.aria | Find a setting |
| panel.search.open | Find a setting |
| panel.search.noResults | Nothing found. Try a different word. |
| panel.search.elsewhereHeading | Looking for one of these? |
| panel.search.resultCount_one | {{count}} match |
| panel.search.resultCount_other | {{count}} matches |
| panel.search.redirect.language | Site language |
| panel.search.redirect.languageHint | Not in this panel. Open the Menu and look under Display. |
| panel.search.redirect.profile | Your name, avatar, and profile style |
| panel.search.redirect.profileHint | Not in this panel. Open Edit Profile from the menu. |
| panel.search.redirect.notifications | Notifications and alerts |
| panel.search.redirect.notificationsHint | Not in this panel. Open Edit Profile from the menu. |
| panel.search.redirect.serverAdmin | Settings for one community server |
| panel.search.redirect.serverAdminHint | Each server has its own admin. Open it from the server's gear icon. |
| settings.subtabAria | Settings section |
| settings.subtab.accounts | Joining & accounts |
| settings.subtab.chat | Chat & forums |
| settings.subtab.safety | Safety & filters |
| settings.subtab.theme | Look & theme |
| settings.subtab.features | Homepage & extras |
| settings.accountLimitsLegend | Sign-ups & account limits |
| settings.chatLimitsLegend | Message limits |
| settings.forumLimitsLegend | Forum limits |
| settings.safetyTogglesLegend | Automatic protection |
| settings.homepageTogglesLegend | Homepage stats |
| settings.featureTogglesLegend | Big feature switches |

`settings.limitsLegend` stops being rendered but stays in the catalog (no
deletions in this build). es values: translate per GLOSSARY.md (tú, es-419,
plain words); do not machine-mirror English word order.

### 9.2 servers namespace (Server Admin agent, en + es in one pass)

RELABELS (existing keys, new values): `console.tabs.usergroups` ->
"member groups"; `console.tabs.onboarding` -> "welcome questions".

NEW keys:

| Key | en value |
|---|---|
| console.group.basics | Your community |
| console.group.people | People |
| console.group.safety | Safety |
| console.group.activity | Rooms & events |
| console.group.rewards | Fun & rewards |
| console.tabDesc.overview | Your community's name, description, and how people join. |
| console.tabDesc.appearance | Logo, colors, and the design your community wears. |
| console.tabDesc.rooms | Every room in this community, in one list. |
| console.tabDesc.members | Everyone who belongs here, and the option to remove someone. |
| console.tabDesc.users | Find one member fast to mute, ban, or remove them. |
| console.tabDesc.roles | Hand out admin and mod powers, and choose exactly what each helper may do. |
| console.tabDesc.usergroups | Groups your members can be sorted into, like teams or interests. |
| console.tabDesc.applications | Requests from people who want to join. Approve or decline. |
| console.tabDesc.reports | Complaints about messages in this community. Review and act. |
| console.tabDesc.modcases | Your moderation casebook here: incidents, updates, and outcomes. |
| console.tabDesc.bans | Who is banned here, for how long, and the tools to undo it. |
| console.tabDesc.modlog | A record of every moderation action taken in this community. |
| console.tabDesc.emoticons | Upload and manage this community's own sticker sheets. |
| console.tabDesc.announcements | Banners and scheduled notices your members will see. |
| console.tabDesc.events | Plan gatherings on the community calendar, with optional reminders. |
| console.tabDesc.faqs | Questions and answers new members often need. |
| console.tabDesc.commandsTitles | Custom chat commands, and the titles members can carry. |
| console.tabDesc.earning | Rewards for being active: ranks, currency, the shop, and hand-outs. |
| console.tabDesc.rules | Write this community's rules and welcome text. |
| console.tabDesc.onboarding | Ask new members a question or two and sort them into groups. |
| console.tabDesc.settings | Limits for this community: message length, room caps, and chat history. |

No other catalog files are touched by this build. tours.json needs no edits
(section 2 keeps monitor-group membership intact on purpose).

---

## 10. File map (who touches what)

| File | Change |
|---|---|
| apps/web/src/components/admin/AdminPanel.tsx | growth group, email/affiliates regroup, description line, search mount, pendingFind plumbing |
| apps/web/src/components/admin/adminSearchIndex.ts | NEW, entries + redirects (section 5) |
| apps/web/src/components/admin/FindSetting.tsx (or shared/) | NEW, generic search component |
| apps/web/src/components/admin/AdminSettingsTab.tsx | subtab strip, section wrappers (hidden attr), limits-grid regroup into new fieldsets, anchors, findRequest props |
| apps/web/src/components/admin/AdminBrandingTab.tsx | data-admin-anchor stamps on fieldsets only |
| apps/web/src/components/admin/AdminRulesTab.tsx | data-admin-anchor stamps on fieldsets only |
| apps/web/src/components/shared/tabGroups.ts | NEW, extracted groupVisibleTabs + withGroupSeparators |
| apps/web/src/components/servers/ServerSettingsView.tsx | grouped strip + optgroup select, description line, relabels pickup, (optional) console search mount |
| app global stylesheet (where tk-fade-in lives) | .tk-find-flash static class |
| packages/shared/locales/en+es/admin.json | section 9.1 (Shell agent only) |
| packages/shared/locales/en+es/servers.json | section 9.2 (Server Admin agent only) |

Anything not listed here is out of scope for this build.
