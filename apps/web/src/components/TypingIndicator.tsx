/**
 * Phase 4 typing indicator strip.
 *
 * Sits between the message stream and the Composer; renders only
 * when at least one other user is currently typing in the current
 * room. The store slice (`useChat.typersByRoom`) is driven by the
 * server's `chat:typing:update` events — see the docstring on
 * `apps/server/src/realtime/typing.ts` for the broadcast logic.
 *
 * Filtering already happens server-side:
 *   - the viewer themselves is excluded
 *   - anyone the viewer has ignored is excluded
 * So this component can render every entry verbatim.
 *
 * Phrasing rule (built into `formatTyperLabel` below):
 *   0   → render nothing
 *   1   → "Alice is typing…"
 *   2   → "Alice and Bob are typing…"
 *   3   → "Alice, Bob, and Carol are typing…"
 *   4+  → "Several people are typing…"
 *
 * Phase 5 lays the per-identity "custom typing phrase" cosmetic on
 * top of this same component. When that ships, the renderer will
 * read the typer's equipped phrase out of the catalog and splice it
 * into the label in place of the literal "is typing…" — the wire
 * shape (`TypingEntry.characterId`) already carries enough to drive
 * the per-identity lookup.
 */

import { useChat } from "../state/store.js";
import type { TypingEntry } from "@thekeep/shared";

interface Props {
  roomId: string | null | undefined;
}

export function TypingIndicator({ roomId }: Props) {
  const typers = useChat((s) => (roomId ? s.typersByRoom[roomId] : undefined));
  if (!typers || typers.length === 0) return null;
  return (
    // `aria-live="polite"` lets screen readers announce a new typer
    // joining without interrupting the reader; tablet/phone keep
    // the row visually subdued so it doesn't compete with the
    // message stream above it. Height is fixed-ish so the
    // composer's vertical position doesn't jitter when the row
    // appears / disappears between renders.
    <div
      aria-live="polite"
      className="px-3 py-1 text-xs italic text-keep-muted"
    >
      {formatTyperLabel(typers)}
    </div>
  );
}

function formatTyperLabel(typers: readonly TypingEntry[]): string {
  switch (typers.length) {
    case 0:
      return "";
    case 1: {
      // Phase 5 — custom typing phrase. Only honored when this is
      // the sole typer; joint forms below stay on the default
      // suffix because splicing custom phrases into "Alice and
      // Bob are <phrase>…" reads incoherently. The phrase already
      // ships server-cleaned (control chars stripped, length-
      // capped, trimmed), so we render it verbatim — but always
      // as a text node, never as HTML.
      const phrase = typers[0]!.phrase;
      if (phrase) return `${typers[0]!.displayName} ${phrase}`;
      return `${typers[0]!.displayName} is typing…`;
    }
    case 2:
      return `${typers[0]!.displayName} and ${typers[1]!.displayName} are typing…`;
    case 3:
      return `${typers[0]!.displayName}, ${typers[1]!.displayName}, and ${typers[2]!.displayName} are typing…`;
    default:
      return "Several people are typing…";
  }
}
