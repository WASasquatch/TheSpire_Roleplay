import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";

type Prompt = {
  id: string;
  action: "request" | "dissolve";
  kindSlug: string;
  kindLabel: string;
  fromDisplayName: string;
  previewText: string;
};

interface Props {
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  /** Surface a soft error if accept/decline fails (auth expired, etc.). */
  onError?: (notice: { code: string; message: string }) => void;
}

/**
 * Stack of inline Accept | Decline cards rendered above the composer.
 *
 * Each card represents an in-flight mutual-title prompt addressed to this
 * user (a `request` someone sent them, or a `dissolve` someone initiated
 * on a title they share). Multiple prompts can stack - they're rare in
 * practice and we don't want to silently drop one if two land in quick
 * succession.
 *
 * The card is dismissed locally once the user clicks Accept/Decline and
 * the server acks ok - or if a `mutual:settled` event arrives (which can
 * happen when the OTHER party's response settles the row first, or when
 * the requester withdraws via reload/disconnect).
 *
 * Cards are deliberately ephemeral: they live only in component state.
 * If the user reloads the page, pending prompts are gone from their UI
 * (the underlying `mutual_titles` row is still there - the requester can
 * cancel by /dissolve flow, or the recipient can wait for the next
 * /request from the same person to re-trigger). Persisting prompts
 * across reloads would require a fetch endpoint and is left for later.
 */
export function MutualPrompts({ socket, onError }: Props) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);

  useEffect(() => {
    function onPrompt(p: Prompt) {
      setPrompts((curr) => {
        // Replace if a prompt with the same id is already showing (e.g.
        // duplicate event across reconnects). Otherwise append.
        const idx = curr.findIndex((x) => x.id === p.id);
        if (idx >= 0) {
          const next = curr.slice();
          next[idx] = p;
          return next;
        }
        return [...curr, p];
      });
    }
    function onSettled() {
      // We don't know WHICH prompt settled (the event is intentionally
      // payload-less to keep the wire small). The pragmatic approach: any
      // open prompts are likely no longer authoritative once the server
      // tells us "things changed", so clear them. The user can re-trigger
      // by asking the requester to retry if needed.
      setPrompts([]);
    }
    socket.on("mutual:prompt", onPrompt);
    socket.on("mutual:settled", onSettled);
    return () => {
      socket.off("mutual:prompt", onPrompt);
      socket.off("mutual:settled", onSettled);
    };
  }, [socket]);

  function respond(id: string, accept: boolean) {
    socket.emit("mutual:respond", { id, accept }, (res) => {
      if (res && !res.ok) {
        onError?.({ code: res.code, message: res.message });
        // Leave the card up so the user can retry.
        return;
      }
      setPrompts((curr) => curr.filter((p) => p.id !== id));
    });
  }

  if (prompts.length === 0) return null;

  // Buttons use the keep-* theme tokens (which read from CSS vars set by
  // applyTheme) rather than fixed Tailwind colors, so the prompt picks up
  // whichever theme is active - the viewer's master theme, or the active
  // character's theme on character themes. Accept = solid keep-action
  // (the affirmative accent); Decline = bordered neutral matching the
  // app's other Cancel buttons. Both have explicit text colors so the
  // contrast holds across light and dark themes.
  return (
    <div className="border-t border-keep-rule bg-keep-panel text-keep-text shadow-[0_-2px_6px_rgb(0_0_0_/_0.08)]">
      {prompts.map((p) => (
        <div
          key={p.id}
          className="flex flex-wrap items-center gap-2 border-b border-keep-rule/40 px-3 py-2 text-sm last:border-b-0"
        >
          <span aria-hidden className="text-base text-keep-action">
            {p.action === "request" ? "♥" : "✕"}
          </span>
          <span className="flex-1 min-w-[180px] leading-snug">
            <span className="font-semibold text-keep-text">{p.fromDisplayName}</span>
            {p.action === "request" ? (
              <>
                <span className="text-keep-muted"> wants to share the title </span>
                <span className="font-medium italic text-keep-action">{p.kindLabel}</span>
                <span className="text-keep-muted"> with you. Your profile would show: </span>
              </>
            ) : (
              <>
                <span className="text-keep-muted"> wants to remove your shared </span>
                <span className="font-medium italic text-keep-action">{p.kindLabel}</span>
                <span className="text-keep-muted"> title. Currently shows: </span>
              </>
            )}
            <span className="font-medium text-keep-text">&ldquo;{p.previewText}&rdquo;</span>
          </span>
          <span className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => respond(p.id, true)}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg shadow-sm hover:bg-keep-action/90"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => respond(p.id, false)}
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
