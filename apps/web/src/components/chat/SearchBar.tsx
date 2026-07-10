import { useEffect, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { MessageSquare, Search, Server } from "lucide-react";
import type { MessageSearchHit } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { formatDate, formatDateTime } from "../../lib/intlFormat.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";

type Scope = "room" | "server";

interface Props {
  /** Current room. Drives the "This room" scope; null disables that scope. */
  roomId: string | null;
  /**
   * The active server's id, powering the "This server" scope. Null / omitted ⇒
   * the default (system) server, which the server-side route resolves to
   * "everything the viewer can see" — so the toggle still works site-wide.
   */
  currentServerId?: string | null;
  /** Called with the clicked hit's messageId AND its roomId, so a cross-room
   *  (server-scope) hit lands in the right room. Caller handles scroll + buffer-swap. */
  onJump: (messageId: string, roomId: string) => void;
  /** Optional close hook so the parent drawer can dismiss after a jump. */
  onClose?: () => void;
  /** Initial scope. Defaults to "room" (the classic in-room search). */
  defaultScope?: Scope;
}

const DEBOUNCE_MS = 250;
const MAX_HITS = 8;

/**
 * Live message-search input with a scope toggle: "This room" (the classic
 * per-room search) or "This server" (a cross-room hunt across every room the
 * viewer may see in the active server). Self-contained + prop-driven so its
 * host can mount it anywhere — it reads its own state, fetches its own results,
 * and calls `onJump(messageId)` on pick; the host owns scroll + buffer swap.
 *
 * The results popup floats ABOVE the input (bottom-full) with the most-relevant
 * hit nearest the bar — the spatial-proximity-to-action convention: the most
 * likely target is one tap away. The popup only renders on a non-empty query.
 * Esc clears the input.
 *
 * Server-scope hits carry room + server context (`roomName` / `serverName`),
 * rendered as a breadcrumb above the snippet so a cross-room result is legible
 * ("in <room> · on <server>"); room-scope hits omit that line.
 */
export function SearchBar({ roomId, currentServerId, onJump, onClose, defaultScope }: Props) {
  const { t } = useTranslation("chat");
  const [scope, setScope] = useState<Scope>(defaultScope ?? "room");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Calm-mode ease: results float ABOVE the input (bottom-full) → slide up.
  // Pure CSS positioning, so the slide transform is safe.
  const reduceMotion = useReducedMotion();

  // If the current room disappears (leave/navigate) while on room-scope, fall
  // back to server-scope so the bar stays useful instead of going inert.
  const effectiveScope: Scope = scope === "room" && !roomId ? "server" : scope;

  // Debounced fetch. Each keystroke restarts the timer; in-flight requests from
  // prior keystrokes are dropped via the `cancelled` flag so we don't race stale
  // responses back into state. Re-runs when the scope, room, or server changes.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setError(null);
      setLoading(false);
      return;
    }
    // Room-scope with no room ⇒ nothing to search (the effectiveScope guard
    // above already redirects to server, so this only trips mid-transition).
    if (effectiveScope === "room" && !roomId) {
      setHits([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const url =
          effectiveScope === "room"
            ? `/rooms/${encodeURIComponent(roomId as string)}/messages/search?q=${encodeURIComponent(trimmed)}&limit=${MAX_HITS}`
            : `/search/messages?q=${encodeURIComponent(trimmed)}${
                currentServerId ? `&serverId=${encodeURIComponent(currentServerId)}` : ""
              }&limit=${MAX_HITS}`;
        const r = await fetch(url, { credentials: "include" });
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
          setError(err instanceof Error ? err.message : t("search.failed"));
          setHits([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, effectiveScope, roomId, currentServerId, t]);

  function clear() {
    setQuery("");
    setHits([]);
    setError(null);
    inputRef.current?.focus();
  }

  function pick(hit: MessageSearchHit) {
    onJump(hit.id, hit.roomId);
    clear();
    onClose?.();
  }

  // Reverse-relevance ordering: server returns most-relevant first, but the
  // popup renders ascending so the top entry is least relevant and the bottom
  // (closest to the input) is most relevant — spatial proximity to the input
  // matches "the most likely thing I want is one tap away".
  const ordered = hits.slice().reverse();

  const showPopup = query.trim().length > 0 && (loading || error !== null || ordered.length > 0);

  const placeholder =
    effectiveScope === "server"
      ? t("search.placeholderServer")
      : roomId
        ? t("search.placeholderRoom")
        : t("search.placeholderNoRoom");

  return (
    <div className="relative">
      {showPopup ? (
        <div className={`absolute inset-x-0 bottom-full mb-1 max-h-80 overflow-y-auto rounded border border-keep-rule bg-keep-bg shadow-lg${reduceMotion ? " tk-slide-up-in" : ""}`}>
          {loading && ordered.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] italic text-keep-muted">{t("search.searching")}</div>
          ) : null}
          {error ? (
            <div className="px-2 py-1.5 text-[11px] text-keep-accent">{error}</div>
          ) : null}
          {ordered.length === 0 && !loading && !error ? (
            <div className="px-2 py-1.5 text-[11px] italic text-keep-muted">{t("search.noMatches")}</div>
          ) : null}
          {ordered.length > 0 ? (
            <ul>
              {ordered.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => pick(h)}
                    className="block w-full border-t border-keep-rule/40 px-2 py-1.5 text-left text-xs first:border-t-0 hover:bg-keep-banner"
                    title={formatDateTime(h.createdAt)}
                  >
                    <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
                      <span className="truncate">{h.displayName}</span>
                      <span className="shrink-0 tabular-nums">
                        {formatDate(h.createdAt)}
                      </span>
                    </div>
                    {effectiveScope === "server" ? <HitContext hit={h} /> : null}
                    <Snippet body={h.snippet} query={query.trim()} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {/* Input + inline scope toggle in one row. The scope is two compact icon
          buttons (room vs server) instead of a second row of text buttons, to
          conserve vertical space; tooltips carry the labels. "This room"
          disables when there's no current room so the choice can't strand the
          search. */}
      <div className="flex items-center gap-1 rounded border border-keep-rule bg-keep-bg pl-2 pr-1 focus-within:border-keep-action">
        <Search className="h-3.5 w-3.5 shrink-0 text-keep-muted" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") clear(); }}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-xs outline-none md:py-1"
        />
        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={t("search.scopeAria")}>
          <ScopeIcon
            icon={<MessageSquare className="h-3.5 w-3.5" aria-hidden />}
            label={t("search.scopeRoom")}
            active={effectiveScope === "room"}
            disabled={!roomId}
            onClick={() => setScope("room")}
          />
          <ScopeIcon
            icon={<Server className="h-3.5 w-3.5" aria-hidden />}
            label={t("search.scopeServer")}
            active={effectiveScope === "server"}
            onClick={() => setScope("server")}
          />
        </div>
      </div>
    </div>
  );
}

function ScopeIcon({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={label}
      aria-label={label}
      className={`rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-keep-action/20 text-keep-action"
          : "text-keep-muted hover:bg-keep-banner hover:text-keep-text"
      }`}
    >
      {icon}
    </button>
  );
}

/**
 * The "in <room> · on <server>" breadcrumb for a server-scope hit. Uses the
 * extended MessageSearchHit context fields; renders nothing when a hit carries
 * no room name (defensive — the server route always sets it for this route).
 */
function HitContext({ hit }: { hit: MessageSearchHit }) {
  const { t } = useTranslation("chat");
  if (!hit.roomName && !hit.title) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[10px] text-keep-muted/90">
      {hit.title ? <span className="truncate font-medium text-keep-text/80">{hit.title}</span> : null}
      {hit.roomName ? (
        <span className="truncate">
          <Trans
            t={t}
            i18nKey="search.hitInRoom"
            values={{ name: hit.roomName }}
            components={{ 1: <span className="text-keep-text/70" /> }}
          />
        </span>
      ) : null}
      {hit.serverName ? (
        <span className="truncate">
          <Trans
            t={t}
            i18nKey="search.hitOnServer"
            values={{ name: hit.serverName }}
            components={{ 1: <span className="text-keep-text/70" /> }}
          />
        </span>
      ) : null}
    </div>
  );
}

/**
 * Trim the message body to a window around the first match (case-insensitive)
 * and bold the matched substring. Pure render — the server already filtered the
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
