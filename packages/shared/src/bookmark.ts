import type { MessageKind } from "./message.js";

/**
 * A single bookmark belonging to the caller. The server joins to `messages`
 * + `rooms` when returning a list so the client can render meaningful
 * context without a second roundtrip. `category` is a free-form
 * user-defined tag; empty string is "Uncategorized" for grouping.
 */
export interface Bookmark {
  id: string;
  /** Free-form category. Empty string is treated as "Uncategorized" client-side. */
  category: string;
  /** Optional user-authored note explaining why this was bookmarked. */
  note: string | null;
  createdAt: number;
  message: BookmarkedMessage;
}

/**
 * Trimmed message shape included with each bookmark. Mirrors the relevant
 * fields a viewer needs to recognize the bookmarked moment without
 * shipping the full ChatMessage wire (which includes display-only
 * fields like color, reply snippets, mood, etc. that the modal
 * doesn't render).
 *
 * `body` is `[message removed]` when the underlying message was soft-
 * deleted; the row stays so the user can decide to clean it up.
 */
export interface BookmarkedMessage {
  id: string;
  roomId: string;
  roomName: string;
  /** Snapshotted at bookmark-render time; the messages table has the canonical value. */
  displayName: string;
  kind: MessageKind;
  body: string;
  createdAt: number;
  /** When the bookmarked message is itself a reply, the parent's id — used to render a "[in thread]" hint. */
  replyToId: string | null;
  /** Snapshotted hex / theme:slot color from the row. Drives the body
   *  text color the same way the inline chat renderer does so a bookmarked
   *  /cmd output reads in the same palette the user saw at send time. */
  color?: string | null;
  /** Snapshotted CSS for `kind: "cmd"` rows. Applied as an inline style
   *  on the rendered body in the bookmarks viewer so the preview matches
   *  what the message looked like in chat. */
  cmdCss?: string | null;
}
