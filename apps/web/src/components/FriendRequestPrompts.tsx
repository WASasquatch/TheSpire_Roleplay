import { Trans, useTranslation } from "react-i18next";
import { useChat } from "../state/store.js";

/**
 * Stack of accept | decline cards for incoming friend requests.
 *
 * Mounted right above the composer (next to MutualPrompts) so a new
 * request can't be missed mid-roleplay. Each card lists who asked,
 * with two buttons that POST directly to the identity-keyed
 * accept/decline endpoints.
 *
 * Source of truth is `pendingFriendRequests` in the Zustand store;
 * the App-level socket handler re-polls `/me/friend-requests` on
 * every `friend:request` event so both this card stack and the DM
 * pinned banner stay aligned without each refetching independently.
 *
 * Why endpoints instead of slash commands: `/accept <name>` /
 * `/decline <name>` resolve the sender by name, and the server's
 * `resolveIdentityByName` checks master usernames first, so when a
 * request was sent FROM a character whose name happens to collide
 * with a master account, the slash-command path never matched the
 * row, left it pending, and the banner re-popped every refresh.
 * The identity endpoints operate on the exact
 * (frienderUserId, frienderCharacterId, friendedCharacterId) tuple
 * carried in the inbox payload, so there's nothing to disambiguate.
 *
 * Optimistic removal on click, we yank the row from the store
 * immediately so the card doesn't stick around waiting for the
 * server echo. The next live event resyncs canonical state.
 */
export function FriendRequestPrompts() {
  const { t } = useTranslation("notifications");
  const pending = useChat((s) => s.pendingFriendRequests);
  const removePendingFriendRequest = useChat((s) => s.removePendingFriendRequest);

  if (pending.length === 0) return null;

  function decide(r: typeof pending[number], accept: boolean) {
    removePendingFriendRequest(r.userId);
    const verb = accept ? "accept" : "decline";
    void fetch(`/me/friend-requests/${encodeURIComponent(r.userId)}/${verb}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frienderCharacterId: r.frienderCharacterId ?? undefined,
        characterId: r.friendedCharacterId ?? undefined,
      }),
    }).catch(() => { /* friend:request echo will resync */ });
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
            <Trans t={t} i18nKey="friendRequest.wantsToBeFriends" values={{ name: r.displayName }}>
              <span className="font-semibold text-keep-text">{r.displayName}</span>
              <span className="text-keep-muted"> wants to be friends.</span>
            </Trans>
          </span>
          <span className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => decide(r, true)}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg shadow-sm hover:bg-keep-action/90"
            >
              {t("friendRequest.accept")}
            </button>
            <button
              type="button"
              onClick={() => decide(r, false)}
              className="rounded border border-keep-border bg-keep-bg px-3 py-1 text-xs uppercase tracking-widest text-keep-muted hover:bg-keep-panel hover:text-keep-text"
            >
              {t("friendRequest.decline")}
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
