import { useChat } from "../state/store.js";

/**
 * Stack of accept | decline cards for incoming friend requests.
 *
 * Mounted right above the composer (next to MutualPrompts) so a new
 * request can't be missed mid-roleplay. Each card lists who asked,
 * with two buttons that dispatch the matching `/accept` or `/decline`
 * slash command through the parent's `onCommand` callback.
 *
 * Source of truth is `pendingFriendRequests` in the Zustand store;
 * the App-level socket handler re-polls `/me/friend-requests` on
 * every `friend:request` event so both this card stack and the DM
 * pinned banner stay aligned without each refetching independently.
 *
 * Optimistic removal on click — once the user picks accept/decline,
 * we yank the row from the store immediately so the card doesn't
 * stick around waiting for the server echo. The next live event
 * resyncs the canonical state, and if the slash command failed for
 * some reason (rate limit, server-side race), it'll reappear.
 */
export function FriendRequestPrompts({
  onCommand,
}: {
  onCommand: (text: string) => void;
}) {
  const pending = useChat((s) => s.pendingFriendRequests);
  const removePendingFriendRequest = useChat((s) => s.removePendingFriendRequest);

  if (pending.length === 0) return null;

  function decide(username: string, userId: string, accept: boolean) {
    onCommand(`/${accept ? "accept" : "decline"} ${username}`);
    removePendingFriendRequest(userId);
  }

  return (
    <div className="border-t border-keep-rule bg-keep-panel text-keep-text shadow-[0_-2px_6px_rgb(0_0_0_/_0.08)]">
      {pending.map((r) => (
        <div
          key={r.userId}
          className="flex flex-wrap items-center gap-2 border-b border-keep-rule/40 px-3 py-2 text-sm last:border-b-0"
        >
          <span aria-hidden className="text-base text-keep-action">+</span>
          <span className="min-w-[180px] flex-1 leading-snug">
            <span className="font-semibold text-keep-text">{r.displayName}</span>
            <span className="text-keep-muted"> wants to be friends.</span>
          </span>
          <span className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => decide(r.username, r.userId, true)}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg shadow-sm hover:bg-keep-action/90"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => decide(r.username, r.userId, false)}
              className="rounded border border-keep-border bg-keep-bg px-3 py-1 text-xs uppercase tracking-widest text-keep-muted hover:bg-keep-panel hover:text-keep-text"
            >
              Decline
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
