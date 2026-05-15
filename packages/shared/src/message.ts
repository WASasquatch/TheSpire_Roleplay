export type MessageKind =
  | "say"      // normal chat: "<DisplayName>: <body>"
  | "me"       // action: "<DisplayName> <body>"  (no brackets, no colon)
  | "cmd"      // custom-command output: body is self-contained ({sender} is
               // expanded inline by the template, so the renderer does NOT
               // auto-prepend the display name like it does for "me"/"say").
               // Optional `cmdCss` styles the body.
  | "system"   // server notice (joins, kicks, topic changes)
  | "whisper"  // 1:1 private message - only sender + recipient receive
  | "roll"     // dice roll output: "<DisplayName> rolls 1d20: 17"
  | "announce" // admin broadcast
  | "scene"    // owner/mod scene-marker banner ("Scene begins: ...")
  | "npc"      // NPC voiced by a user; rendered with a "voiced by" tag
  | "ooc";     // out-of-character aside

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  characterId: string | null;
  /** snapshotted at send time so renames don't rewrite history */
  displayName: string;
  kind: MessageKind;
  body: string;
  /** Snapshot hex color (e.g. "#990000") at send time. Null/absent = default render. */
  color?: string | null;
  /** epoch ms */
  createdAt: number;
  /** present when kind === "whisper" - recipient's userId */
  toUserId?: string;
  /** present when kind === "whisper" - recipient display name snapshotted at send time */
  toDisplayName?: string;
  /** Id of the message this one replies to. Absent on non-replies. */
  replyToId?: string | null;
  /** Snapshotted display name of the parent message's author (for inline quote preview). */
  replyToDisplayName?: string | null;
  /** Truncated snapshot of the parent body, used to render the inline quote preview. */
  replyToBodySnippet?: string | null;
  /** Snapshotted mood/expression of the author at send time. Renders as a chip next to the name. */
  moodSnapshot?: string | null;
  /** For `kind === "npc"` only: the master username of the user who voiced this NPC. */
  npcVoicedBy?: string | null;
  /** Set when the author edited the message inside the grace window. Epoch ms. */
  editedAt?: number | null;
  /** Set when the author deleted the message inside the grace window. Renderer shows "[message removed]". */
  deletedAt?: number | null;
  /**
   * Thread-category anchor for top-level messages in nested-mode rooms.
   * Null/absent = "Uncategorized" (the renderer's fallback bucket).
   * Replies inherit their parent's category implicitly — this field is
   * only meaningful when `replyToId` is absent.
   */
  threadCategoryId?: string | null;
  /**
   * Forum topic title. Present only on top-level messages in nested-
   * mode (forum) rooms — those are the "topics" replies live under.
   * Absent on replies and on every message in flat-mode chat rooms.
   */
  title?: string | null;
  /**
   * Snapshot of the author's avatar URL at send time. Used by the
   * forum renderer to show an avatar beside each post; ignored by the
   * chat renderer. Null = author had no avatar configured when posting.
   */
  avatarUrl?: string | null;
  /**
   * Timestamp the topic was locked (author or moderator action). Set on
   * top-level topics in nested-mode rooms to indicate the thread is
   * closed to new replies — server rejects `chat:input` replies under
   * a locked topic, the forum UI shows a 🔒 indicator + disables the
   * reply composer. Null/absent = unlocked. Replies and flat-room
   * messages always carry this as null.
   */
  lockedAt?: number | null;
  /**
   * Most-recent-activity timestamp for top-level topics. Updated by
   * the server when a reply is inserted under the topic — the forum
   * pagination orders by this DESC so active threads surface first.
   * For replies and flat-room messages this is null/unused.
   */
  lastActivityAt?: number | null;
  /**
   * Admin-pinned flag for forum topics. When true, the topic floats
   * above all non-sticky topics in its category and is returned on
   * every page of `GET /rooms/:id/topics`. Only admins can toggle
   * this; the forum view shows a 📌 indicator. Defaults to false.
   */
  isSticky?: boolean;
  /**
   * Server-validated CSS to apply to the rendered body of a `kind: "cmd"`
   * message. Stored verbatim as a CSS declaration list ("font-weight: bold;
   * color: #4a8" etc.); the renderer parses + camel-cases the properties
   * before applying them as an inline style. Snapshotted at send time so a
   * later edit to the underlying custom command's CSS doesn't restyle
   * historical messages. Absent on every kind except `cmd`.
   */
  cmdCss?: string | null;
}

/**
 * A single result row from `GET /rooms/:id/messages/search`. The server
 * filters by privacy (whispers visible only to sender/recipient, soft-
 * deletes excluded) before ranking, so the client can render results
 * directly without secondary filtering.
 *
 * `relevance` is a unitless server-assigned score (higher = better).
 * The UI sorts by it but doesn't surface the raw number. `snippet` is
 * the raw matched body — the client renders highlight on top via the
 * same logic message rendering uses, so we don't ship pre-built HTML
 * from the server.
 */
export interface MessageSearchHit {
  id: string;
  roomId: string;
  userId: string;
  displayName: string;
  kind: MessageKind;
  snippet: string;
  createdAt: number;
  relevance: number;
  /** Top-level thread anchor when the matched message is itself a reply. Used to render "in thread: <parent>" context. */
  replyToId?: string | null;
}
