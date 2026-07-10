/**
 * Phase 3 moderation/discovery wire types - audit log, reports, watches.
 * The privacy contract: none of these surfaces ever expose private chat
 * content. Whisper bodies and private-room messages remain inaccessible to
 * admins by design.
 */

export type AuditAction =
  // Mod actions
  | "kick"
  | "mute"
  | "unmute"
  | "ban"
  | "unban"
  | "announce"
  // Pinned messages (a room message pinned/unpinned — migration 0316)
  | "message_pin"
  | "message_unpin"
  // Auto-moderation (create/edit/delete an automod_rules row, or an
  // automatic warn/delete/mute the filters applied) — migration 0319
  | "automod"
  // Role changes
  | "promote_mod"
  | "demote_mod"
  | "promote_admin"
  | "demote_admin"
  | "promote_masteradmin"
  | "demote_masteradmin"
  | "promote_trusted"
  | "demote_trusted"
  | "auto_promote_trusted"
  // Room/site management
  | "settings_update"
  | "room_delete"
  | "custom_command_create"
  | "custom_command_update"
  | "custom_command_delete"
  | "builtin_command_config_update"
  | "logo_upload"
  // Backup / restore (admin Backups tab)
  | "backup_create"
  | "backup_import"
  | "backup_delete"
  // Account management
  | "user_disable"
  | "user_enable"
  | "account_ban"
  | "account_unban"
  | "user_bio_edit_admin"
  | "password_reset"
  | "earning_reset"
  | "character_delete_admin"
  | "title_dissolve_admin"
  // Age restriction (plan.md 2026-07-08). DOB corrections are admin-only
  // (`edit_user_dob`); the isolation toggle is auditable when staff set or
  // clear it on a minor's behalf.
  | "user_dob_update"
  | "user_isolation_update"
  // Reports
  | "report_resolve"
  | "report_dismiss"
  // Moderation case log (mod-authored complaint/resolution records)
  | "mod_case_create"
  | "mod_case_update"
  | "mod_case_delete"
  // FAQ entries (admin-authored public Q&A)
  | "faq_create"
  | "faq_update"
  | "faq_delete"
  // Admin emailer (single send + broadcast)
  | "admin_email_send"
  | "admin_email_broadcast"
  // Scriptorium moderation (Phase 10)
  | "story_force_rate"
  | "story_admin_hide"
  | "story_admin_delete"
  // Emoticon catalog management
  | "emoticon_sheet_create"
  | "emoticon_sheet_update"
  | "emoticon_sheet_delete"
  // Emoticon-sheet user submissions (Phase 3)
  | "emoticon_sheet_submit"
  | "emoticon_sheet_approve"
  | "emoticon_sheet_reject"
  // Flair / cosmetics moderation
  | "profile_banner_clear"
  | "typing_phrase_clear"
  | "room_presence_clear"
  | "session_presence_clear"
  // Permission-system moderation (Phase 1, granular roles)
  | "role_permission_grant"     // a permission was granted to a role in the matrix
  | "role_permission_revoke"    // a permission was revoked from a role in the matrix
  | "user_permission_override_set"   // a per-user override was set (grant or revoke)
  | "user_permission_override_clear" // a per-user override was removed (falls back to role grant)
  // Incognito ("ghost") mode toggles (Phase 11, staff observation)
  | "incognito_enter"
  | "incognito_exit"
  // Announcements (banner marquee + scheduled /announce cronjobs)
  | "announcement_banner_create"
  | "announcement_banner_update"
  | "announcement_banner_delete"
  | "scheduled_announcement_create"
  | "scheduled_announcement_update"
  | "scheduled_announcement_delete"
  // Profile-customization flairs (migration 0192)
  | "profile_marquee_update"
  | "profile_visitors_visibility_update"
  // Forums (community message boards) — owner-issued actions are audited
  // so staff can adjudicate owner disputes from the Audit tab.
  | "forum_mod_grant"
  | "forum_mod_revoke"
  | "forum_mod_perms"
  | "forum_ban"
  | "forum_unban"
  | "forum_board_create"
  | "forum_board_archive"
  | "forum_topic_lock"
  | "forum_topic_sticky"
  | "forum_topic_move"
  | "forum_post_delete"
  | "forum_member_remove"
  | "forum_report_resolve"
  | "forum_usergroup_change"   // create/edit/delete a usergroup, or change its membership
  // 18+ labeling (age-restriction plan): a room / forum topic / server /
  // whole forum was marked or unmarked 18+. Metadata carries the new state.
  | "room_nsfw_update"
  | "topic_nsfw_update"
  | "server_nsfw_update"
  | "forum_nsfw_update"
  // Server moderation (Global Admin suspend/ban/delete of a whole server)
  | "server_moderation_suspend" // indefinite "under review" hold placed on a server
  | "server_moderation_ban"     // timed (auto-expiring) or permanent ban placed on a server
  | "server_moderation_lift"    // suspension/ban cleared (state → 'none')
  | "server_delete"             // hard cascade delete of a server + all its data
  // System tab (live-ops maintenance)
  | "system_restart"           // admin restarted the server process
  | "system_purge_messages";   // admin purged ALL chat messages site-wide

/**
 * Preset action groups for the AuditTab's category dropdown. Each
 * key is a stable identifier; the value lists the AuditAction strings
 * the preset bundles. "all" is the empty list (no server filter).
 *
 * Adding a category: drop an entry here and the AuditTab dropdown
 * picks it up via `Object.entries`. Adding a new AuditAction: thread
 * it into whichever group it semantically belongs to.
 */
export const AUDIT_ACTION_GROUPS: Record<string, { label: string; actions: readonly AuditAction[] }> = {
  all: { label: "All actions", actions: [] },
  permissions: {
    label: "Permission changes",
    actions: [
      "role_permission_grant",
      "role_permission_revoke",
      "user_permission_override_set",
      "user_permission_override_clear",
    ],
  },
  moderation: {
    label: "Moderation",
    actions: [
      "kick", "mute", "unmute", "ban", "unban", "announce", "incognito_enter", "incognito_exit",
      "mod_case_create", "mod_case_update", "mod_case_delete", "automod",
      "message_pin", "message_unpin",
      // 18+ labeling of rooms and whole servers (age-restriction plan).
      "room_nsfw_update", "server_nsfw_update",
    ],
  },
  forums: {
    label: "Forums",
    actions: [
      "forum_mod_grant",
      "forum_mod_revoke",
      "forum_mod_perms",
      "forum_ban",
      "forum_unban",
      "forum_board_create",
      "forum_board_archive",
      "forum_topic_lock",
      "forum_topic_sticky",
      "forum_topic_move",
      "forum_post_delete",
      "forum_member_remove",
      "forum_report_resolve",
      "forum_usergroup_change",
      // 18+ labeling of forum topics and whole forums (age-restriction plan).
      "topic_nsfw_update", "forum_nsfw_update",
    ],
  },
  role_changes: {
    label: "Role changes",
    actions: [
      "promote_mod",
      "demote_mod",
      "promote_admin",
      "demote_admin",
      "promote_masteradmin",
      "demote_masteradmin",
      "promote_trusted",
      "demote_trusted",
      "auto_promote_trusted",
    ],
  },
  site_config: {
    label: "Site config",
    actions: [
      "settings_update",
      "custom_command_create",
      "custom_command_update",
      "custom_command_delete",
      "builtin_command_config_update",
      "logo_upload",
      "faq_create",
      "faq_update",
      "faq_delete",
    ],
  },
  user_admin: {
    label: "User admin",
    actions: [
      "user_disable",
      "user_enable",
      "account_ban",
      "account_unban",
      "user_bio_edit_admin",
      "password_reset",
      "earning_reset",
      "character_delete_admin",
      "title_dissolve_admin",
      // Age restriction: DOB corrections + staff-set isolation toggles.
      "user_dob_update", "user_isolation_update",
    ],
  },
  reports: {
    label: "Reports",
    actions: ["report_resolve", "report_dismiss"],
  },
  scriptorium: {
    label: "Scriptorium",
    actions: ["story_force_rate", "story_admin_hide", "story_admin_delete"],
  },
  emoticons: {
    label: "Emoticons",
    actions: [
      "emoticon_sheet_create",
      "emoticon_sheet_update",
      "emoticon_sheet_delete",
      "emoticon_sheet_submit",
      "emoticon_sheet_approve",
      "emoticon_sheet_reject",
    ],
  },
  cosmetic_mod: {
    label: "Cosmetic moderation",
    actions: [
      "profile_banner_clear",
      "typing_phrase_clear",
      "room_presence_clear",
      "session_presence_clear",
    ],
  },
  backups: {
    label: "Backups",
    actions: ["backup_create", "backup_import", "backup_delete"],
  },
};


export interface AuditEntry {
  id: string;
  actorUserId: string;
  /** Display name resolved server-side at fetch time so deleted users still render legibly. */
  actorDisplayName: string;
  action: AuditAction;
  targetUserId?: string | null;
  targetDisplayName?: string | null;
  targetRoomId?: string | null;
  targetRoomName?: string | null;
  targetMessageId?: string | null;
  reason?: string | null;
  /** Action-specific extras (duration ms, prior/next role, etc.) - JSON-encoded server-side. */
  metadata?: Record<string, unknown> | null;
  createdAt: number;
}

export type ReportStatus = "open" | "reviewed" | "dismissed";

export interface ReportEntry {
  id: string;
  reporterUserId: string;
  reporterDisplayName: string;
  messageId: string;
  /** Snapshot of the reported message body at time of fetch (or "[removed]" if since deleted). */
  messageBody: string;
  messageDisplayName: string;
  /** The reported message's author userId, so a moderator can open their
   *  profile to verify a report. Null when the message/author is gone. */
  messageUserId?: string | null;
  messageCreatedAt: number;
  roomId: string;
  roomName: string;
  reason?: string | null;
  status: ReportStatus;
  resolvedById?: string | null;
  resolvedByDisplayName?: string | null;
  resolvedAt?: number | null;
  resolutionNote?: string | null;
  createdAt: number;
}

export interface WatchEntry {
  /** Master username of the watched account. */
  username: string;
  /** Resolved display name (active char or master) at the time of the call. */
  displayName: string;
  /** True iff the watched account currently has any live socket. */
  online: boolean;
  createdAt: number;
}

/** Server → watcher push when a watched account goes from offline to fully-online. */
export interface WatchOnlineEvent {
  /** The watched user's id. */
  userId: string;
  /** Master username (so the client can resolve and display consistently). */
  username: string;
  /** Display name resolved at announce time (active char or master). */
  displayName: string;
}
