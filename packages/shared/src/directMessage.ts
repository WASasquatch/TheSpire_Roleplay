/**
 * Direct messages: persistent two-party chat, distinct from the
 * in-room `/whisper` family.
 *
 * Wire shape is intentionally close to `ChatMessage` (same body,
 * displayName, avatar pattern) so the client can reuse markdown
 * rendering, edit/delete affordances, etc., without a separate
 * code path. The interfaces diverge where the data model does:
 * conversations have an `otherUserId` instead of `roomId`, and
 * unread state is per-user-per-conversation.
 */

export interface DirectMessage {
  id: string;
  conversationId: string;
  senderId: string;
  /** Snapshot at send time; renames / character switches don't rewrite history. */
  displayName: string;
  avatarUrl: string | null;
  /** Empty string when `deletedAt` is set (server blanks the body on soft-delete). */
  body: string;
  editedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
}

/**
 * Row shape for the friends rail and the DM-list panel. Pre-resolves
 * the "other party" (so the client doesn't have to figure out which
 * column to read from `direct_conversations`) and folds in unread
 * count + online state so a single fetch backs both surfaces.
 */
export interface DirectConversationSummary {
  id: string;
  otherUserId: string;
  otherUsername: string;
  otherDisplayName: string;
  otherAvatarUrl: string | null;
  otherOnline: boolean;
  lastMessageAt: number;
  /** Server-side truncated preview (~120 chars). Null when no messages yet. */
  lastMessagePreview: string | null;
  unreadCount: number;
}

/**
 * Paged history response. Mirrors the room-message `around` endpoint's
 * shape so the client can reuse the "load more" pattern. `hasMore`
 * tells the client whether to render the load-older trigger.
 */
export interface DirectMessageHistoryPage {
  messages: DirectMessage[];
  hasMore: boolean;
}
