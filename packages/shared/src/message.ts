export type MessageKind =
  | "say"      // normal chat: "<DisplayName>: <body>"
  | "me"       // action: "<DisplayName> <body>"  (no brackets, no colon)
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
}
