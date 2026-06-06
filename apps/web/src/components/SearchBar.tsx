import { useEffect, useRef, useState } from "react";
import type { MessageSearchHit } from "@thekeep/shared";
import { readError } from "../lib/http.js";

interface Props {
  /** Current room. Search is scoped to this room only; null disables. */
  roomId: string | null;
  /** Called with the messageId of the clicked hit. Caller handles scroll + buffer-swap. */
  onJump: (messageId: string) => void;
  /** Optional close hook so the parent drawer can dismiss after a jump. */
  onClose?: () => void;
}

const DEBOUNCE_MS = 250;
const MAX_HITS = 8;

/**
 * Live message-search input. Renders inline at the bottom of its host (the
 * tools drawer); the results popup floats above the input with most-
 * relevant hit nearest the bar, that's the spatial-proximity-to-action
 * convention requested in the spec, so the user's finger/cursor doesn't
 * have to travel for the most likely target.
 *
 * The popup only renders when there's a non-empty query AND at least one
 * hit; an empty query collapses everything. Esc clears the input.
 */
export function SearchBar({ roomId, onJump, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounced fetch. Each keystroke restarts the timer; in-flight requests
  // from prior keystrokes are dropped via the `cancelled` flag so we don't
  // race responses back into stale state.
  useEffect(() => {
    if (!roomId) {
      setHits([]);
      setError(null);
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await fetch(
          `/rooms/${encodeURIComponent(roomId)}/messages/search?q=${encodeURIComponent(trimmed)}&limit=${MAX_HITS}`,
          { credentials: "include" },
        );
        if (!r.ok) {
          if (!cancelled) {
            setError(await readError(r));
            setHits([]);
          }
          return;
        }
        const j = (await r.json()) as { hits: MessageSearchHit[] };
        if (!cancelled) {
          setHits(j.hits);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "search failed");
          setHits([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, roomId]);

  function clear() {
    setQuery("");
    setHits([]);
    setError(null);
    inputRef.current?.focus();
  }

  function pick(hit: MessageSearchHit) {
    onJump(hit.id);
    clear();
    onClose?.();
  }

  // Reverse-relevance ordering: server returns most-relevant first, but
  // the popup renders ascending so the top entry is least relevant and
  // the bottom (closest to the input) is most relevant. See plan.md
  // Phase 1 design, the spatial proximity to the input matches the
  // user's intent: "the most likely thing I want is one tap away".
  const ordered = hits.slice().reverse();

  const showPopup = query.trim().length > 0 && (loading || error !== null || ordered.length > 0);

  return (
    <div className="relative">
      {showPopup ? (
        <div className="absolute inset-x-0 bottom-full mb-1 max-h-80 overflow-y-auto rounded border border-keep-rule bg-keep-bg shadow-lg">
          {loading && ordered.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] italic text-keep-muted">searching…</div>
          ) : null}
          {error ? (
            <div className="px-2 py-1.5 text-[11px] text-keep-accent">{error}</div>
          ) : null}
          {ordered.length === 0 && !loading && !error ? (
            <div className="px-2 py-1.5 text-[11px] italic text-keep-muted">no matches</div>
          ) : null}
          {ordered.length > 0 ? (
            <ul>
              {ordered.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => pick(h)}
                    className="block w-full border-t border-keep-rule/40 px-2 py-1.5 text-left text-xs first:border-t-0 hover:bg-keep-banner"
                    title={new Date(h.createdAt).toLocaleString()}
                  >
                    <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
                      <span className="truncate">{h.displayName}</span>
                      <span className="shrink-0 tabular-nums">
                        {new Date(h.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <Snippet body={h.snippet} query={query.trim()} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") clear(); }}
        placeholder={roomId ? "Search messages in this room…" : "Join a room to search"}
        disabled={!roomId}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-xs outline-none focus:border-keep-action disabled:opacity-50 md:py-1"
      />
    </div>
  );
}

/**
 * Trim the message body to a window around the first match (case-insensitive)
 * and bold the matched substring. Pure render, server already filtered the
 * row to one we can see, so we just style what's there.
 */
function Snippet({ body, query }: { body: string; query: string }) {
  if (!query) return <span className="line-clamp-2 break-words text-keep-text/90">{body}</span>;
  const lower = body.toLowerCase();
  const needle = query.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) {
    return <span className="line-clamp-2 break-words text-keep-text/90">{body}</span>;
  }
  const before = body.slice(Math.max(0, idx - 30), idx);
  const match = body.slice(idx, idx + needle.length);
  const after = body.slice(idx + needle.length, idx + needle.length + 80);
  return (
    <span className="line-clamp-2 break-words text-keep-text/90">
      {idx > 30 ? "…" : ""}
      {before}
      <b className="bg-keep-action/30 text-keep-text">{match}</b>
      {after}
      {idx + needle.length + 80 < body.length ? "…" : ""}
    </span>
  );
}
