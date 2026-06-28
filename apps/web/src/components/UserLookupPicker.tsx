import { useEffect, useId, useRef, useState } from "react";
import type { ForumUserSearchHit } from "@thekeep/shared";
import { searchForumUsers } from "../lib/forums.js";

/**
 * Typeahead user picker for forum management (appoint a mod, ban a user).
 * Searches the forum's user-search endpoint by username OR character-name
 * prefix and shows avatar + names + a status annotation (already a mod,
 * owner, or banned) so the manager picks the right account without pasting
 * an @id: token. Selecting a hit calls `onSelect`; the input clears.
 *
 * Server re-resolves the chosen userId on the action call, so this is
 * purely an affordance — a stale/odd hit can't grant anything by itself.
 */
export function UserLookupPicker({
  forumId,
  onSelect,
  placeholder = "Search by name…",
  /** Annotate (and disable) a hit, e.g. "already a mod". Return a string to
   *  disable the row with that reason, or null to leave it selectable. */
  disabledReason,
  autoFocus,
}: {
  forumId: string;
  onSelect: (hit: ForumUserSearchHit) => void;
  placeholder?: string;
  disabledReason?: (hit: ForumUserSearchHit) => string | null;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ForumUserSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  // Debounced search. A fresh keystroke supersedes the in-flight request via
  // the `live` latch so out-of-order responses can't clobber newer results.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); setLoading(false); return; }
    let live = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      searchForumUsers(forumId, term)
        .then((rows) => { if (live) { setHits(rows); setOpen(true); } })
        .catch(() => { if (live) setHits([]); })
        .finally(() => { if (live) setLoading(false); });
    }, 220);
    return () => { live = false; window.clearTimeout(t); };
  }, [q, forumId]);

  // Close the dropdown on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(hit: ForumUserSearchHit) {
    if (disabledReason?.(hit)) return;
    onSelect(hit);
    setQ("");
    setHits([]);
    setOpen(false);
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        type="text"
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => { if (hits.length > 0) setOpen(true); }}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
      />
      {open && (loading || hits.length > 0 || q.trim().length >= 2) ? (
        <ul
          id={listId}
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded border border-keep-rule bg-keep-bg shadow-lg"
        >
          {loading && hits.length === 0 ? (
            <li className="px-2 py-2 text-xs text-keep-muted">Searching…</li>
          ) : hits.length === 0 ? (
            <li className="px-2 py-2 text-xs text-keep-muted">No matches.</li>
          ) : (
            hits.map((hit) => {
              const reason = disabledReason?.(hit) ?? null;
              const annotation = reason
                ?? (hit.forumRole === "owner" ? "owner"
                  : hit.forumRole === "mod" ? "already a mod"
                  : hit.banned ? "banned" : null);
              return (
                <li key={hit.userId}>
                  <button
                    type="button"
                    disabled={!!reason}
                    onClick={() => pick(hit)}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-keep-banner/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {hit.avatarUrl ? (
                      <img
                        src={hit.avatarUrl}
                        alt=""
                        className="h-6 w-6 shrink-0 rounded-full border border-keep-rule object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-keep-rule bg-keep-banner text-[9px] font-semibold uppercase text-keep-muted">
                        {hit.username.slice(0, 2)}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-keep-text">{hit.username}</span>
                      {hit.characterNames.length > 0 ? (
                        <span className="block truncate text-[10px] text-keep-muted">
                          {hit.characterNames.join(", ")}
                        </span>
                      ) : null}
                    </span>
                    {annotation ? (
                      <span className="shrink-0 rounded-full border border-keep-rule px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-keep-muted">
                        {annotation}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
