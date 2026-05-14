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
  // Role changes
  | "promote_mod"
  | "demote_mod"
  | "promote_admin"
  | "demote_admin"
  | "promote_trusted"
  | "demote_trusted"
  | "auto_promote_trusted"
  // Room/site management
  | "settings_update"
  | "room_delete"
  | "custom_command_create"
  | "custom_command_update"
  | "custom_command_delete"
  | "logo_upload"
  // Account management
  | "user_disable"
  | "user_enable"
  | "character_delete_admin"
  | "title_dissolve_admin"
  // Reports
  | "report_resolve"
  | "report_dismiss";

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
