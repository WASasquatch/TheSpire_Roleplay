/**
 * Phase 4 typing indicator strip.
 *
 * Sits between the message stream and the Composer; renders only
 * when at least one other user is currently typing in the current
 * room. The store slice (`useChat.typersByRoom`) is driven by the
 * server's `chat:typing:update` events, see the docstring on
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
 * into the label in place of the literal "is typing…", the wire
 * shape (`TypingEntry.characterId`) already carries enough to drive
 * the per-identity lookup.
 */

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TypingEntry } from "@thekeep/shared";
import { useChat } from "../../state/store.js";

interface Props {
  roomId: string | null | undefined;
}

export function TypingIndicator({ roomId }: Props) {
  const { t } = useTranslation("chat");
  const typers = useChat((s) => (roomId ? s.typersByRoom[roomId] : undefined));
  if (!typers || typers.length === 0) return null;
  return (
    // Discord-style overlay: the strip floats absolutely over the
    // bottom of the message stream (whose container is `relative`
    // and reserves `pb-6` clearance so the last message never sits
    // beneath this text). Floating instead of inline means no layout
    // shift when typing starts/stops, the composer never jumps and
    // the chat area never gives up vertical space.
    //   - `pointer-events-none` so clicks on messages behind the
    //     strip's transparent fade area still register.
    //   - `bg-gradient-to-t from-keep-bg via-keep-bg/90 to-transparent`
    //     paints a soft fade beneath the text so messages scrolled
    //     up under the strip dissolve cleanly rather than colliding
    //     with overlapping glyphs. The text itself sits in the solid
    //     portion (`pb-1 pt-3`).
    //   - `aria-live="polite"` lets screen readers announce a new
    //     typer without interrupting the active reader.
    <div
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-keep-bg via-keep-bg/90 to-transparent px-3 pb-1 pt-3 text-xs italic text-keep-muted"
    >
      {formatTyperLabel(t, typers)}
    </div>
  );
}

function formatTyperLabel(t: TFunction<"chat">, typers: readonly TypingEntry[]): string {
  switch (typers.length) {
    case 0:
      return "";
    case 1: {
      // Phase 5, custom typing phrase. Only honored when this is
      // the sole typer; joint forms below stay on the default
      // suffix because splicing custom phrases into "Alice and
      // Bob are <phrase>…" reads incoherently. The phrase already
      // ships server-cleaned (control chars stripped, length-
      // capped, trimmed), so we render it verbatim, but always
      // as a text node, never as HTML.
      const phrase = typers[0]!.phrase;
      if (phrase) return t("typing.withPhrase", { name: typers[0]!.displayName, phrase });
      return t("typing.one", { name: typers[0]!.displayName });
    }
    case 2:
      return t("typing.two", { a: typers[0]!.displayName, b: typers[1]!.displayName });
    case 3:
      return t("typing.three", { a: typers[0]!.displayName, b: typers[1]!.displayName, c: typers[2]!.displayName });
    default:
      return t("typing.several");
  }
}
