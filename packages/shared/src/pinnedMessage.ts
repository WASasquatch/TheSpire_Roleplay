import type { MessageKind } from "./message.js";

/**
 * One pinned message as sent to the client (server `pinned_messages` table,
 * migration 0316). A mod/admin with the `pin_message` permission pins a chat
 * message to the top of a room; the pin carries display SNAPSHOTS (author,
 * body, styling) frozen at pin time so it stays readable even after the
 * underlying message is edited or deleted — the same convention bookmarks and
 * reply previews use. `messageId` goes null when the source message is
 * hard-deleted; the snapshot fields keep the card renderable.
 */
export interface PinnedMessage {
  id: string;
  roomId: string;
  /** Source message id, or null once the underlying message was hard-deleted. */
  messageId: string | null;
  /** Owning server; null on the default server. */
  serverId: string | null;
  /** Who pinned it. */
  pinnedByUserId: string | null;
  pinnedByDisplayName: string | null;
  pinnedAt: number;
  /** Manual ordering within the room's pinned strip (ascending). */
  sortOrder: number;
  /* ---- snapshot of the pinned message at pin time ---- */
  authorUserId: string | null;
  authorCharacterId: string | null;
  /** Author display name at pin time. */
  displayName: string | null;
  kind: MessageKind | null;
  body: string | null;
  /** Author chat color at pin time (hex / theme:slot). */
  color: string | null;
  /** CSS snapshot for `kind: "cmd"` rows. */
  cmdCss: string | null;
  /** Scene banner image for `kind: "scene"` rows. */
  sceneImageUrl: string | null;
  /** Trusted-HTML body (announce/scene rows), else null. */
  bodyHtml: string | null;
  /** Original message createdAt (ms) at pin time. */
  origCreatedAt: number | null;
}
