/**
 * Chat-message deep links — the `?m=<roomId>:<messageId>` marker produced by
 * the "Copy message link" row action and consumed on boot (routed through the
 * jump-to-message flow, whose server-side permission checks are the only
 * authorization boundary). The bare `<roomId>:<messageId>` token is also the
 * storage shape of server_events.linked_message_id, so the event console's
 * paste-a-link field and the server validator share this parser.
 */

/** nanoid alphabet segment — ids never contain `:` so the pair splits safely. */
const ID_RX = /^[A-Za-z0-9_-]{4,64}$/;

export interface MessageLinkRef {
  roomId: string;
  messageId: string;
}

/** The bare storage/marker token for a message link. */
export function buildMessageLinkToken(roomId: string, messageId: string): string {
  return `${roomId}:${messageId}`;
}

/** The shareable URL for a message link on `origin`. */
export function buildMessageLinkUrl(origin: string, roomId: string, messageId: string): string {
  return `${origin}/?m=${buildMessageLinkToken(roomId, messageId)}`;
}

/**
 * Parse a message link out of user input: a bare `<roomId>:<messageId>`
 * token, or any URL carrying it as the `?m=` query param. Null on anything
 * malformed — callers surface their own "not a message link" copy.
 */
export function parseMessageLink(raw: string): MessageLinkRef | null {
  const input = raw.trim();
  if (!input) return null;
  let token = input;
  if (/^https?:\/\//i.test(input)) {
    try {
      const m = new URL(input).searchParams.get("m");
      if (!m) return null;
      token = m;
    } catch {
      return null;
    }
  }
  const sep = token.indexOf(":");
  if (sep < 0) return null;
  const roomId = token.slice(0, sep);
  const messageId = token.slice(sep + 1);
  if (!ID_RX.test(roomId) || !ID_RX.test(messageId)) return null;
  return { roomId, messageId };
}
