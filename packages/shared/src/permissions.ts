/**
 * Permission catalog for the granular role-permission system (Phase 1).
 *
 * Each entry below is a code-side gate that previously checked
 * `isAdminRole(role)` / `isMasterAdminRole(role)` / `roleRank(role) >=
 * N` directly. After Phase 1 the catalog is the single source of
 * truth: the server's `hasPermission(user, key)` helper resolves a
 * permission key against the per-role and per-user grant tables, the
 * Phase-2 matrix UI lets a masteradmin redistribute keys, and the
 * client's `me.permissions` array (Phase 2) mirrors the resolved set
 * for UI gating.
 *
 * **Adding a permission:** add it to `PERMISSION_KEYS` (a tuple, the
 * `as const` is what gives `PermissionKey` its precise type), then to
 * `PERMISSION_DESCRIPTIONS` (the matrix tooltip copy), then call
 * `hasPermission(user, "<new_key>")` from the code site, then update
 * the seed defaults in `apps/server/drizzle/0179_permission_grants.sql`
 * (or a follow-up migration). The compiler will surface every
 * missing piece, there's no string-typed back door.
 *
 * **Masteradmin bypass** is hardcoded in `hasPermission`; the master-
 * admin tier has no row in `role_permission_grants` and the matrix
 * locks their row as "all-on, uneditable" so an accidental misclick
 * can't strand the install with no one able to grant permissions.
 */

export const PERMISSION_KEYS = [
  // ---- chat_moderation ----
  "kick_user",
  "ban_user",
  "unban_user",
  "mute_user",
  "unmute_user",
  "delete_others_message",
  "edit_others_message",
  "view_deleted_message_body",
  "lock_forum_topic",
  "unlock_forum_topic",
  "bypass_topic_lock",
  "pin_forum_topic",
  "announce_room",
  "announce_sitewide",
  "use_ghost_mode",
  "manage_mod_cases",

  // ---- room_admin ----
  "bypass_room_cap",
  "edit_any_room_metadata",
  "create_system_room",
  "bulk_edit_rooms",
  "delete_room",
  "use_theater_mode",

  // ---- arcade ----
  "use_arcade",
  "use_eidolon_tamer",
  "use_urugal_descent",
  "use_grimhold",

  // ---- cosmetics ----
  "use_room_transitions",

  // ---- user_admin ----
  "grant_admin_role",
  "revoke_admin_role",
  "view_user_directory_secure",
  "edit_user_basic",
  "edit_user_email",
  "disable_user",
  "enable_user",
  "reset_user_password",
  "hard_delete_user",
  "edit_others_character",
  "edit_others_user",
  "ban_account",
  "unban_account",
  "view_others_journal",
  "edit_others_journal",

  // ---- site_admin ----
  "edit_site_settings",
  "upload_logo",
  "manage_custom_commands",
  "manage_title_kinds",
  "manage_nav_links",
  "manage_affiliates",
  "edit_branding",

  // ---- content_admin ----
  "manage_emoticon_catalog",
  "review_emoticon_submissions",
  "feature_worlds",
  "edit_others_world",
  "delete_others_world",
  "admin_delete_story",
  "admin_hide_story",
  "admin_force_story_rating",
  "edit_others_scriptorium_content",
  "view_others_scriptorium_drafts",
  "bypass_scriptorium_paywall",
  "apply_create_forum",
  "review_forum_applications",
  "manage_any_forum",
  "manage_faqs",
  "send_admin_email",

  // ---- audit_view (non-tab read permissions) ----
  "view_room_messages_as_admin",
  "view_report_queue",
  "resolve_reports",

  // ---- admin_panel_tabs (visibility for each AdminPanel tab) ----
  "view_admin_overview",
  "view_admin_users",
  "view_admin_rooms",
  "view_admin_audit",
  "view_admin_reports",
  "view_admin_earning",
  "view_admin_emoticons",
  "view_admin_settings",
  "view_admin_branding",
  "view_admin_rules",
  "view_admin_affiliates",
  "view_admin_scriptorium",
  "view_admin_forums",
  "view_admin_backups",
  "view_admin_custom_commands",
  "view_admin_title_kinds",
  "view_admin_nav_links",
  "view_admin_permissions",
  "view_admin_announcements",
  "view_admin_mod_cases",
  "view_admin_faqs",
  "view_admin_email",
  "view_system_metrics",
  "verify_export_logs",

  // ---- system (live metrics + destructive maintenance tools) ----
  "restart_application",
  "purge_all_messages",

  // ---- announcements ----
  // Two independently-grantable manage keys feed the same Announcements
  // admin tab. A site lead might delegate marquee curation to a
  // community manager while keeping the scheduler (which actually
  // runs `/announce` cronjobs server-wide) for senior admins only.
  "manage_banner_announcements",
  "manage_scheduled_announcements",

  // ---- earning_admin ----
  "view_earning_config",
  "edit_earning_awards",
  "edit_earning_sensitive",
  "grant_earning_award",
  "manage_ranks",
  "manage_name_styles",
  "manage_borders",
  "manage_cosmetics",
  "clear_user_cosmetic_override",
  "manage_flash_sale",

  // ---- backups ----
  "manage_backups",

  // ---- permission_admin (the matrix itself) ----
  "manage_permissions",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * Short human-readable description for each key. The matrix tooltip
 * pulls from here; admins see this when hovering a column header. Keep
 * them ≤ ~100 chars so the tooltip stays compact, and write them in
 * present tense ("Kick a user…", not "Lets you kick…") since they
 * answer "what does this permission let me do?".
 *
 * Adding a key without a description here is a compile error (the
 * `Record<PermissionKey, string>` signature forces full coverage).
 */
export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  // chat_moderation
  kick_user: "Boot a user out of the current room. Same as the /kick command.",
  ban_user: "Ban a user from a room (with optional duration). Persists in the bans table.",
  unban_user: "Lift a ban on a user in the current room.",
  mute_user: "Silence a user in a room for a duration. Same as /mute.",
  unmute_user: "Lift a mute on a user in the current room.",
  delete_others_message: "Soft-delete chat messages authored by someone else, regardless of the grace window.",
  edit_others_message: "Edit chat messages authored by someone else, regardless of the grace window.",
  view_deleted_message_body: "Read the original body of soft-deleted messages (the `originalBody` audit reveal).",
  lock_forum_topic: "Close a forum topic to further replies.",
  unlock_forum_topic: "Re-open a previously locked forum topic.",
  bypass_topic_lock: "Post a reply in a topic that's already locked (used for moderator verdicts).",
  pin_forum_topic: "Sticky a forum topic to the top of the topic list.",
  announce_room: "Send `/announce` in the current room (high-visibility broadcast).",
  announce_sitewide: "Send `/announce all` to every room. Use sparingly.",
  use_ghost_mode: "Use /incognito (or /ghost) to disappear from the userlist and observe rooms unnoticed.",
  manage_mod_cases: "Create, edit, and resolve entries in the moderation case log.",

  // room_admin
  bypass_room_cap: "Skip the per-user max-rooms-owned ceiling on /go and /private.",
  edit_any_room_metadata: "Edit topic / description / expiry / replyMode of any room, not just ones you own.",
  create_system_room: "Create a permanent public (system) room via the admin tab.",
  bulk_edit_rooms: "Bulk-edit room message-expiry settings across many rooms at once.",
  delete_room: "Delete a non-system room via the admin tab.",
  use_theater_mode: "Turn on theater (watch-party) mode for a room you own or moderate.",

  // arcade
  use_arcade: "Open the Spire Arcade and its games. (Each game may also require its own unlock to be purchased.)",
  use_eidolon_tamer: "Play the Eidolon Tamer arcade game (after unlocking it in the shop).",
  use_urugal_descent: "Play the Urugal's Descent arcade game (after unlocking it in the shop).",
  use_grimhold: "Play the Grimhold cabinet (six arcade games) (after unlocking it in the shop).",

  // cosmetics
  use_room_transitions: "Buy and equip room-transition cosmetics (each transition is also purchased with currency).",

  // user_admin
  grant_admin_role: "Promote another account to the admin tier. Same as /promoteadmin.",
  revoke_admin_role: "Demote an admin account back to user. Same as /demoteadmin.",
  view_user_directory_secure: "View the admin user list (exposes email, IP, last-login).",
  edit_user_basic: "Edit another user's username and assign role (user / trusted / mod).",
  edit_user_email: "Change another user's email address.",
  disable_user: "Soft-disable a user account (blocks login + chat).",
  enable_user: "Re-enable a previously disabled account.",
  reset_user_password: "Generate a password reset link for another user.",
  hard_delete_user: "Permanently delete a user account. Irreversible.",
  edit_others_character: "Edit characters owned by other users (fix names, clear avatars, etc.).",
  edit_others_user: "Edit another user's master (OOC) profile - bio and gallery NSFW flags - while viewing it.",
  ban_account: "Ban a user account (timed or permanent, with a reason). Blocks login + chat.",
  unban_account: "Lift an account ban early.",
  view_others_journal: "Read private journal entries belonging to other users' characters. PRIVACY SENSITIVE.",
  edit_others_journal: "Modify or delete other users' journal entries.",

  // site_admin
  edit_site_settings: "Edit retention, session TTL, content limits, HTML rules, and other site config.",
  upload_logo: "Upload a replacement banner / logo image.",
  manage_custom_commands: "Create, edit, or delete admin-authored `!cmd` commands.",
  manage_title_kinds: "Manage the mutual-title catalog (marriage, partner, etc.).",
  manage_nav_links: "Manage the banner-navigation link rows.",
  manage_affiliates: "Create, edit, or delete partner / sponsor / affiliate entries on the splash.",
  edit_branding: "Edit branding fields: site name + URL, banner cover CSS, logo color/font/URL, splash welcome HTML, SEO meta description, custom head HTML, and the theme-design map.",

  // content_admin
  manage_emoticon_catalog: "Create, edit, or delete admin emoticon sheets.",
  review_emoticon_submissions: "Approve or reject community emoticon submissions.",
  feature_worlds: "Mark a world as `featured` in the catalog.",
  edit_others_world: "Admin override to edit world metadata + collaborators on worlds you don't own.",
  delete_others_world: "Admin override to soft-delete worlds you don't own.",
  admin_delete_story: "Remove a story from the Scriptorium catalog (admin moderation).",
  admin_hide_story: "Hide a story from public view without deleting it.",
  admin_force_story_rating: "Override an author's content-rating choice on a story.",
  edit_others_scriptorium_content: "Admin override on others' stories, chapters, reviews, and replies.",
  view_others_scriptorium_drafts: "Read other authors' unpublished drafts in the admin queue.",
  bypass_scriptorium_paywall: "Read books marked 'Buy to Read' without buying a copy (shows a moderator warning).",
  apply_create_forum: "Submit an application to create a community forum (one pending application at a time).",
  review_forum_applications: "Approve or reject forum-creation applications in the admin Forums tab.",
  manage_any_forum: "Admin override on any community forum: edit, archive, transfer, delete, and lift forum bans.",
  manage_faqs: "Create, edit, and delete public FAQ entries (question/answer with a shareable slug).",
  send_admin_email: "Send email from the admin Email tab — to a single user or a throttled broadcast to all users.",

  // audit_view
  view_room_messages_as_admin: "Open the admin message scroll-through for a public room.",
  view_report_queue: "Browse user-filed moderation reports.",
  resolve_reports: "Mark a report resolved (records to audit log).",

  // admin_panel_tabs (visibility)
  view_admin_overview: "See the admin Overview tab (counters + sparklines).",
  view_admin_users: "See the admin Users tab.",
  view_admin_rooms: "See the admin Rooms tab.",
  view_admin_audit: "See the admin Audit tab.",
  view_admin_reports: "See the admin Reports tab.",
  view_admin_earning: "See the admin Earning tab.",
  view_admin_emoticons: "See the admin Emoticons tab.",
  view_admin_settings: "See the admin Site Settings tab.",
  view_admin_branding: "See the admin Branding tab.",
  view_admin_rules: "See the admin Rules tab.",
  view_admin_affiliates: "See the admin Affiliates tab.",
  view_admin_scriptorium: "See the admin Scriptorium tab.",
  view_admin_forums: "See the admin Forums tab (forum-creation queue + forum oversight).",
  view_admin_backups: "See the admin Backups tab.",
  view_admin_custom_commands: "See the admin Custom Commands tab.",
  view_admin_title_kinds: "See the admin Title Kinds tab.",
  view_admin_nav_links: "See the admin Nav Links tab.",
  view_admin_permissions: "See the Roles & Permissions tab (the matrix). Editing requires manage_permissions.",
  view_admin_announcements: "See the admin Announcements tab. Editing requires manage_banner_announcements and/or manage_scheduled_announcements.",
  view_admin_mod_cases: "See the admin Mod Log tab (the moderation case log). Editing requires manage_mod_cases.",
  view_admin_faqs: "See the admin FAQ tab. Editing requires manage_faqs.",
  view_admin_email: "See the admin Email tab (verification settings + the emailer). Sending requires send_admin_email.",
  view_system_metrics: "See the admin System tab: live server metrics (CPU, memory, connections, database size, uptime, host info).",
  verify_export_logs: "Use the admin Verify Log tool: check whether a submitted /export chat log is authentic and unaltered, and read its signed contents.",

  // system (destructive maintenance — masteradmin-only by default)
  restart_application: "Restart the server process from the System tab. The machine comes back up on its own; live connections briefly drop.",
  purge_all_messages: "Permanently delete EVERY chat message site-wide from the System tab. Irreversible; rooms and accounts are untouched.",

  // announcements
  manage_banner_announcements: "Create, edit, or delete the rotating chat-top banner announcements (HTML/Markdown).",
  manage_scheduled_announcements: "Schedule one-shot or recurring `/announce` cronjobs (HTML/Markdown, custom color).",

  // earning_admin
  view_earning_config: "Read-only access to the earning awards + ranks configuration.",
  edit_earning_awards: "Edit per-source XP / Currency award amounts and toggles.",
  edit_earning_sensitive: "Edit the multi-character earn divisor and backfill knobs (sensitive).",
  grant_earning_award: "Hand out XP or Currency to a target identity via the admin tab.",
  manage_ranks: "Manage the rank catalog and per-tier definitions.",
  manage_name_styles: "Manage the equippable name-style catalog.",
  manage_borders: "Manage rank-tier and freeform border catalogs.",
  manage_cosmetics: "Manage flair / banner / typing-phrase catalog rows.",
  clear_user_cosmetic_override: "Force-revert a user's profile banner, typing phrase, or presence templates.",
  manage_flash_sale: "Configure and run the rotating flash sale.",

  // backups
  manage_backups: "Create, restore, and delete site backup snapshots.",

  // permission_admin
  manage_permissions: "Edit the role-permission matrix and per-user overrides (this very system).",
};

/**
 * Friendly group label for each permission, used by the matrix UI to
 * draw the column-header section bars. Mirrors the grouping in
 * `PERMISSION_KEYS` above.
 */
export const PERMISSION_GROUPS: Record<PermissionKey, PermissionGroup> = {
  // chat_moderation
  kick_user: "chat_moderation",
  ban_user: "chat_moderation",
  unban_user: "chat_moderation",
  mute_user: "chat_moderation",
  unmute_user: "chat_moderation",
  delete_others_message: "chat_moderation",
  edit_others_message: "chat_moderation",
  view_deleted_message_body: "chat_moderation",
  lock_forum_topic: "chat_moderation",
  unlock_forum_topic: "chat_moderation",
  bypass_topic_lock: "chat_moderation",
  pin_forum_topic: "chat_moderation",
  announce_room: "chat_moderation",
  announce_sitewide: "chat_moderation",
  use_ghost_mode: "chat_moderation",
  manage_mod_cases: "chat_moderation",

  // room_admin
  bypass_room_cap: "room_admin",
  edit_any_room_metadata: "room_admin",
  create_system_room: "room_admin",
  bulk_edit_rooms: "room_admin",
  delete_room: "room_admin",
  use_theater_mode: "room_admin",

  // arcade
  use_arcade: "arcade",
  use_eidolon_tamer: "arcade",
  use_urugal_descent: "arcade",
  use_grimhold: "arcade",

  // cosmetics
  use_room_transitions: "cosmetics",

  // user_admin
  grant_admin_role: "user_admin",
  revoke_admin_role: "user_admin",
  view_user_directory_secure: "user_admin",
  edit_user_basic: "user_admin",
  edit_user_email: "user_admin",
  disable_user: "user_admin",
  enable_user: "user_admin",
  reset_user_password: "user_admin",
  hard_delete_user: "user_admin",
  edit_others_character: "user_admin",
  edit_others_user: "user_admin",
  ban_account: "user_admin",
  unban_account: "user_admin",
  view_others_journal: "user_admin",
  edit_others_journal: "user_admin",

  // site_admin
  edit_site_settings: "site_admin",
  upload_logo: "site_admin",
  manage_custom_commands: "site_admin",
  manage_title_kinds: "site_admin",
  manage_nav_links: "site_admin",
  manage_affiliates: "site_admin",
  edit_branding: "site_admin",

  // content_admin
  manage_emoticon_catalog: "content_admin",
  review_emoticon_submissions: "content_admin",
  feature_worlds: "content_admin",
  edit_others_world: "content_admin",
  delete_others_world: "content_admin",
  admin_delete_story: "content_admin",
  admin_hide_story: "content_admin",
  admin_force_story_rating: "content_admin",
  edit_others_scriptorium_content: "content_admin",
  view_others_scriptorium_drafts: "content_admin",
  bypass_scriptorium_paywall: "content_admin",
  apply_create_forum: "content_admin",
  review_forum_applications: "content_admin",
  manage_any_forum: "content_admin",
  manage_faqs: "content_admin",
  send_admin_email: "content_admin",

  // audit_view
  view_room_messages_as_admin: "audit_view",
  view_report_queue: "audit_view",
  resolve_reports: "audit_view",

  // admin_panel_tabs
  view_admin_overview: "admin_panel_tabs",
  view_admin_users: "admin_panel_tabs",
  view_admin_rooms: "admin_panel_tabs",
  view_admin_audit: "admin_panel_tabs",
  view_admin_reports: "admin_panel_tabs",
  view_admin_earning: "admin_panel_tabs",
  view_admin_emoticons: "admin_panel_tabs",
  view_admin_settings: "admin_panel_tabs",
  view_admin_branding: "admin_panel_tabs",
  view_admin_rules: "admin_panel_tabs",
  view_admin_affiliates: "admin_panel_tabs",
  view_admin_scriptorium: "admin_panel_tabs",
  view_admin_forums: "admin_panel_tabs",
  view_admin_backups: "admin_panel_tabs",
  view_admin_custom_commands: "admin_panel_tabs",
  view_admin_title_kinds: "admin_panel_tabs",
  view_admin_nav_links: "admin_panel_tabs",
  view_admin_permissions: "admin_panel_tabs",
  view_admin_announcements: "admin_panel_tabs",
  view_admin_mod_cases: "admin_panel_tabs",
  view_admin_faqs: "admin_panel_tabs",
  view_admin_email: "admin_panel_tabs",
  view_system_metrics: "admin_panel_tabs",
  verify_export_logs: "admin_panel_tabs",

  // system (destructive maintenance tools)
  restart_application: "system",
  purge_all_messages: "system",

  // announcements
  manage_banner_announcements: "site_admin",
  manage_scheduled_announcements: "site_admin",

  // earning_admin
  view_earning_config: "earning_admin",
  edit_earning_awards: "earning_admin",
  edit_earning_sensitive: "earning_admin",
  grant_earning_award: "earning_admin",
  manage_ranks: "earning_admin",
  manage_name_styles: "earning_admin",
  manage_borders: "earning_admin",
  manage_cosmetics: "earning_admin",
  clear_user_cosmetic_override: "earning_admin",
  manage_flash_sale: "earning_admin",

  // backups
  manage_backups: "backups",

  // permission_admin
  manage_permissions: "permission_admin",
};

export type PermissionGroup =
  | "chat_moderation"
  | "room_admin"
  | "arcade"
  | "cosmetics"
  | "user_admin"
  | "site_admin"
  | "content_admin"
  | "audit_view"
  | "admin_panel_tabs"
  | "earning_admin"
  | "backups"
  | "system"
  | "permission_admin";

/**
 * Keys flagged in the matrix UI with a yellow "privacy-sensitive"
 * chip. Toggling them on should be a deliberate decision, not a
 * casual click. The set is intentionally small, broad flags would
 * desensitize the warning.
 */
export const PRIVACY_SENSITIVE_KEYS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  "view_user_directory_secure",
  "view_others_journal",
  "view_deleted_message_body",
  "view_others_scriptorium_drafts",
]);

/**
 * Type-guard: is `s` a recognized permission key? Useful at server
 * boundaries (the matrix PATCH endpoint, audit-log filter parsing)
 * so unknown strings don't sneak into the cache as if they were
 * canonical.
 */
export function isPermissionKey(s: string): s is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(s);
}
