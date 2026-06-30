/**
 * Notification Center wire shapes (the unified inbox that surfaces server
 * approvals, @mentions, DMs, friend requests, earning milestones,
 * announcements, and report outcomes in one place).
 *
 * The persisted row (server `notifications` table) generalizes the forum
 * notification engine: every row carries display SNAPSHOTS (actor name, title,
 * snippet) so the inbox stays readable after renames, plus a deep-link
 * (`targetKind`/`targetId`/`url`) so a click — or a web-push tap — lands the
 * recipient on the thing the notification is about. The account-level row is
 * tagged with the recipient IDENTITY (`characterId`) when the event is scoped
 * to one character (a DM or @mention of that character), mirroring how DMs
 * already store identity; account-level events (approvals, bans) leave it null.
 */

/** Coarse grouping used by the bell's filter chips and per-server rail dots. */
export const NOTIFICATION_CATEGORIES = [
  "mention",
  "dm",
  "friend",
  "server",
  "forum",
  "earning",
  "announcement",
  "report",
  "system",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Granular event type within a category. Drives icon + copy on the client. */
export type NotificationKind =
  | "forum_reply"
  | "forum_quote"
  | "forum_watch"
  | "forum_mention"
  | "chat_mention"
  | "dm"
  | "friend_request"
  | "friend_accept"
  | "server_app_approved"
  | "server_app_rejected"
  | "forum_app_approved"
  | "forum_app_rejected"
  | "membership_approved"
  | "membership_rejected"
  | "server_ban"
  | "forum_ban"
  | "emoticon_approved"
  | "emoticon_rejected"
  | "rankup"
  | "royalty"
  | "announcement"
  | "report_resolved"
  | "system";

/** What a notification points at, so a click (or push tap) can navigate. */
export type NotificationTargetKind =
  | "none"
  | "room"
  | "message"
  | "topic"
  | "forum"
  | "dm"
  | "server"
  | "profile"
  | "earning";

/** One inbox row as sent to the client (snapshots + freshly-joined display
 *  bits like the actor's current avatar and the server's current name). */
export interface NotificationWire {
  id: string;
  category: NotificationCategory;
  kind: NotificationKind;
  /** Recipient identity this is scoped to (DM / @mention of a character), else null. */
  characterId: string | null;
  /** Originating server (for grouping + rail dots), or null for account-level. */
  serverId: string | null;
  serverName: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorAvatarUrl: string | null;
  /** Headline, e.g. "Your server was approved". */
  title: string;
  /** Body preview, e.g. the message text or a reason. */
  snippet: string;
  targetKind: NotificationTargetKind;
  targetId: string | null;
  /** Deep-link path used by the web-push notificationclick handler (e.g. "/s/ashfall"). */
  url: string | null;
  createdAt: number;
  /** When the badge was cleared (the bell was opened past this row). */
  seenAt: number | null;
  /** When the row was opened/acknowledged. */
  readAt: number | null;
}

/** Live badge pulse payload. */
export interface NotificationBadge {
  /** Total unread across all categories. */
  unread: number;
  /** Per-server unread for the server-rail unseen dots, keyed by serverId. */
  unreadByServer?: Record<string, number>;
}

/** A page of inbox rows plus the unread count, returned by GET /me/notifications. */
export interface NotificationPage {
  notifications: NotificationWire[];
  unread: number;
  /** Cursor (createdAt of the last row) for the next page, or null at the end. */
  nextCursor: number | null;
}
