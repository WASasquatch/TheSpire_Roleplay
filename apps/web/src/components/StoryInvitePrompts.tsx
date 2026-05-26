import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  StoryCollaboratorInvite,
  StoryCollaboratorRole,
} from "@thekeep/shared";
import { readError } from "../lib/http.js";

interface Props {
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  /** Soft-error surface (used when accept/decline fails). */
  onError?: (notice: { code: string; message: string }) => void;
}

/**
 * Stack of inline Accept | Decline cards rendered above the composer
 * for incoming Scriptorium collaboration invites. Mirrors the
 * MutualPrompts pattern so all in-app "someone wants something from
 * you" affordances live in one visual cluster.
 *
 * Cards are ephemeral local state — a page reload drops them, and the
 * recipient can act on the same invite later via the catalog's My
 * Stories tab (the Pending invites surface there is the persistent
 * counterpart).
 */
export function StoryInvitePrompts({ socket, onError }: Props) {
  const [invites, setInvites] = useState<StoryCollaboratorInvite[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    function onInvite(p: StoryCollaboratorInvite) {
      setInvites((curr) => {
        // De-dupe on storyId — re-invites from the owner replace the
        // existing card rather than stacking.
        const idx = curr.findIndex((x) => x.storyId === p.storyId);
        if (idx >= 0) {
          const next = curr.slice();
          next[idx] = p;
          return next;
        }
        return [...curr, p];
      });
    }
    socket.on("story:invite", onInvite);
    return () => { socket.off("story:invite", onInvite); };
  }, [socket]);

  async function act(invite: StoryCollaboratorInvite, kind: "accept" | "decline") {
    setBusyId(invite.storyId);
    try {
      const r = await fetch(`/me/story-invites/${invite.storyId}/${kind}`, { method: "POST" });
      if (!r.ok) {
        const msg = await readError(r);
        onError?.({ code: "INVITE_FAILED", message: msg });
        return;
      }
      setInvites((curr) => curr.filter((p) => p.storyId !== invite.storyId));
    } finally {
      setBusyId(null);
    }
  }

  if (invites.length === 0) return null;

  return (
    <div className="border-t border-keep-rule bg-keep-panel text-keep-text shadow-[0_-2px_6px_rgb(0_0_0_/_0.08)]">
      {invites.map((inv) => (
        <div
          key={inv.storyId}
          className="flex flex-wrap items-center gap-2 border-b border-keep-rule/40 px-3 py-2 text-sm last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="text-keep-muted">
                {inv.invitedByUsername ?? inv.storyAuthorUsername}
              </span>
              <span>invited you to</span>
              <b>{inv.storyTitle}</b>
              <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${roleClass(inv.role)}`}>
                {roleLabel(inv.role)}
              </span>
            </div>
            <div className="text-[10px] text-keep-muted">
              by {inv.storyAuthorUsername} · /stories/@{inv.storyAuthorUsername.toLowerCase()}/{inv.storySlug}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => act(inv, "accept")}
              disabled={busyId === inv.storyId}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => act(inv, "decline")}
              disabled={busyId === inv.storyId}
              className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs text-keep-muted hover:text-keep-text"
            >
              Decline
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function roleLabel(r: StoryCollaboratorRole): string {
  return r === "co_author" ? "Co-author" : r.charAt(0).toUpperCase() + r.slice(1);
}
function roleClass(r: StoryCollaboratorRole): string {
  switch (r) {
    case "reader":    return "bg-keep-muted/25 text-keep-muted";
    case "editor":    return "bg-sky-500/15 text-sky-300";
    case "co_author": return "bg-amber-500/15 text-amber-300";
  }
}
