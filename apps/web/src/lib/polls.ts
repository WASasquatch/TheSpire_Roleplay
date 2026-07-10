/**
 * Client poll actions — cast/retract a vote and close a poll over the socket.
 * Both resolve on the server ack; the live tally arrives separately via the
 * `poll:update` event (handled in App.tsx → store.applyPollUpdate).
 */
import { i18n } from "./i18n.js";
import { getSocket } from "./socket.js";

function emitWithAck(
  event: "poll:vote" | "poll:close",
  payload: { messageId: string; optionIds?: string[] },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = getSocket();
    if (!socket) { reject(new Error(i18n.t("errors:notConnected"))); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (socket.emit as any)(event, payload, (res: { ok: true } | { ok: false; message?: string } | undefined) => {
      if (res && "ok" in res && res.ok) resolve();
      else reject(new Error(res && "message" in res && res.message ? res.message : i18n.t("errors:polls.failed")));
    });
    setTimeout(() => reject(new Error(i18n.t("errors:polls.timeout"))), 12_000);
  });
}

/** Cast (or change) a vote. Pass an empty array to retract. */
export function votePoll(messageId: string, optionIds: string[]): Promise<void> {
  return emitWithAck("poll:vote", { messageId, optionIds });
}

/** Close a poll early (author / moderator only — server re-checks). */
export function closePoll(messageId: string): Promise<void> {
  return emitWithAck("poll:close", { messageId });
}
