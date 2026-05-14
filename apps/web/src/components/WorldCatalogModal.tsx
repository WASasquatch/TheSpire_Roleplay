import { useEffect, useMemo, useState } from "react";
import type {
  WorldCatalogEntry,
  WorldCatalogPage,
  WorldGenre,
} from "@thekeep/shared";
import { CANONICAL_TAGS, CONTENT_WARNINGS } from "@thekeep/shared";
import { readError } from "../lib/http.js";
import { Modal } from "./Modal.js";

interface Props {
  /** Current room id for "Use in this room". If null, the link button is hidden. */
  currentRoomId: string | null;
  onClose: () => void;
  onOpenViewer: (worldId: string) => void;
}

/**
 * Genre presentation labels. Kept in sync with shared `WorldGenre`; the
 * underscore between definition and display is fine here because the
 * filter chips and dropdowns share the same source of truth.
 */
const GENRE_LABEL: Record<WorldGenre, string> = {
  fantasy: "Fantasy",
  modern: "Modern",
  scifi: "Sci-Fi",
  horror: "Horror",
  western: "Western",
  steampunk: "Steampunk",
  mythological: "Mythological",
  other: "Other",
};
const GENRE_ORDER: WorldGenre[] = [
  "fantasy", "modern", "scifi", "horror",
  "western", "steampunk", "mythological", "other",
];

const PAGE_SIZE = 24;

/**
 * Filter-capable world catalog. Replaces the older text-only list. The
 * server-side `/worlds/catalog` endpoint takes query params for genre,
 * tag (AND), exclude (content-warning NOT), and a free-text search;
 * this component owns the local filter state and re-fetches whenever
 * any of those change.
 *
 * Cover images are best-effort — when a world doesn't have one set we
 * fall back to a text-only card the same shape so the grid stays
 * uniform. Cards are clickable to open the viewer; the secondary
 * actions (Join, Use in this room) sit in a small footer row.
 */
export function WorldCatalogModal({ currentRoomId, onClose, onOpenViewer }: Props) {
  const [entries, setEntries] = useState<WorldCatalogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state. Each control updates exactly one of these and the
  // effect below re-fetches with the combined query.
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [genre, setGenre] = useState<WorldGenre | "">("");
  const [tagSel, setTagSel] = useState<string[]>([]);
  const [excludeSel, setExcludeSel] = useState<string[]>([]);

  // Worlds the viewer has already joined - drives "Join" vs "Joined" labels.
  const [memberWorldIds, setMemberWorldIds] = useState<Set<string>>(new Set());
  const [joining, setJoining] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [linkedFlash, setLinkedFlash] = useState<string | null>(null);

  // Debounce the free-text search so we don't fire a fetch on every
  // keystroke. 250ms feels responsive without spamming the endpoint.
  useEffect(() => {
    const h = window.setTimeout(() => setQDebounced(q.trim()), 250);
    return () => window.clearTimeout(h);
  }, [q]);

  // Reset to page 0 whenever the filter changes — otherwise a user
  // typing into the search box on page 3 would think the corpus is
  // empty when actually the new query has fewer pages.
  useEffect(() => {
    setPage(0);
  }, [qDebounced, genre, tagSel, excludeSel]);

  // Stable query-string builder so the dep array can compare strings
  // instead of arrays / objects.
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (qDebounced) params.set("q", qDebounced);
    if (genre) params.set("genre", genre);
    for (const t of tagSel) params.append("tag", t);
    for (const x of excludeSel) params.append("exclude", x);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    return params.toString();
  }, [qDebounced, genre, tagSel, excludeSel, page]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/worlds/catalog?${queryString}`, { credentials: "include" }),
      fetch("/me/worlds/memberships", { credentials: "include" }),
    ])
      .then(async ([catRes, memRes]) => {
        if (!catRes.ok) throw new Error(await readError(catRes));
        const cat = (await catRes.json()) as WorldCatalogPage;
        // Memberships fetch requires auth; 401 → treat as "no memberships".
        const mem = memRes.ok
          ? ((await memRes.json()) as { memberships: { worldId: string }[] }).memberships
          : [];
        if (cancelled) return;
        // Append on `page > 0` (Load more), replace otherwise (fresh
        // filter / first load). The server returns just the requested
        // page; the client owns the concatenation so "Load more" can
        // grow the grid in place.
        setEntries((prev) => (cat.page > 0 ? [...prev, ...cat.entries] : cat.entries));
        setTotal(cat.total);
        setHasMore(cat.hasMore);
        setMemberWorldIds(new Set(mem.map((m) => m.worldId)));
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "load failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [queryString]);

  function toggleTag(t: string) {
    setTagSel((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));
  }
  function toggleExclude(c: string) {
    setExcludeSel((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  }
  function clearFilters() {
    setQ("");
    setGenre("");
    setTagSel([]);
    setExcludeSel([]);
  }
  const anyFilter = !!q || !!genre || tagSel.length > 0 || excludeSel.length > 0;

  async function joinWorld(worldId: string) {
    setJoining(worldId);
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}/members`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      setMemberWorldIds((s) => new Set(s).add(worldId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "join failed");
    } finally {
      setJoining(null);
    }
  }

  async function linkToRoom(worldId: string) {
    if (!currentRoomId) return;
    setLinking(worldId);
    setError(null);
    try {
      const r = await fetch(`/rooms/${currentRoomId}/world`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worldId }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setLinkedFlash(worldId);
      window.setTimeout(() => setLinkedFlash(null), 2400);
    } catch (e) {
      setError(e instanceof Error ? e.message : "link failed");
    } finally {
      setLinking(null);
    }
  }

  return (
    <Modal onClose={onClose} zIndex={50}>
      <div
        className="flex max-h-[88vh] w-full flex-col overflow-hidden rounded border border-keep-rule bg-keep-parchment shadow-xl md:w-[78vw] md:max-w-[1100px]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-lg">World catalog</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-keep-muted hover:text-keep-text"
          >
            close
          </button>
        </header>

        {/* Filter strip. Search + genre on the first row; tags + CWs as
            wrappable chip lists on the rows below so the strip degrades
            cleanly to mobile width. */}
        <div className="shrink-0 space-y-2 border-b border-keep-rule/60 bg-keep-bg/50 px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search name, description, tags..."
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
            />
            <select
              value={genre}
              onChange={(e) => setGenre(e.target.value as WorldGenre | "")}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
            >
              <option value="">All genres</option>
              {GENRE_ORDER.map((g) => (
                <option key={g} value={g}>{GENRE_LABEL[g]}</option>
              ))}
            </select>
            {anyFilter ? (
              <button
                type="button"
                onClick={clearFilters}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted hover:bg-keep-banner hover:text-keep-text"
              >
                clear filters
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-widest text-keep-muted">Tags:</span>
            {CANONICAL_TAGS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggleTag(t)}
                className={
                  "rounded border px-1.5 py-0 text-[11px] " +
                  (tagSel.includes(t)
                    ? "border-keep-action bg-keep-action/15 text-keep-action"
                    : "border-keep-rule bg-keep-bg text-keep-muted hover:border-keep-action hover:text-keep-action")
                }
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-widest text-keep-muted">Hide:</span>
            {CONTENT_WARNINGS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => toggleExclude(c)}
                title={`Exclude worlds tagged "${c}"`}
                className={
                  "rounded border px-1.5 py-0 text-[11px] " +
                  (excludeSel.includes(c)
                    ? "border-keep-accent bg-keep-accent/15 text-keep-accent"
                    : "border-keep-rule bg-keep-bg text-keep-muted hover:border-keep-accent hover:text-keep-accent")
                }
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Body: grid of cover-image cards. Falls back to a friendly
            empty state when the filter has nothing to show. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <div className="mb-3 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
              {error}
            </div>
          ) : null}
          {loading && entries.length === 0 ? (
            <p className="italic text-keep-muted">Loading...</p>
          ) : entries.length === 0 ? (
            <p className="italic text-keep-muted">
              {anyFilter
                ? "No worlds match the current filters."
                : "No open worlds yet. Be the first — mark one of yours as “open” in its settings."}
            </p>
          ) : (
            <>
              <div className="mb-3 text-[10px] uppercase tracking-widest text-keep-muted">
                {total} {total === 1 ? "world" : "worlds"}
              </div>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {entries.map((e) => (
                  <li
                    key={e.id}
                    className="flex flex-col overflow-hidden rounded border border-keep-rule/60 bg-keep-bg"
                  >
                    {/* Cover area: 3:2 aspect, image or text fallback. */}
                    <button
                      type="button"
                      onClick={() => onOpenViewer(e.id)}
                      className="relative block aspect-[3/2] w-full overflow-hidden bg-keep-banner/40 text-left hover:opacity-90"
                      title="Open in viewer"
                    >
                      {e.coverImageUrl ? (
                        <img
                          src={e.coverImageUrl}
                          alt={`${e.name} cover`}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-keep-panel/40 to-keep-banner/60 p-4">
                          <span className="text-center font-action text-lg text-keep-muted">{e.name}</span>
                        </div>
                      )}
                      {e.status === "featured" ? (
                        <span className="absolute right-1 top-1 rounded bg-keep-action/90 px-1.5 py-0 text-[10px] uppercase tracking-widest text-keep-bg">
                          featured
                        </span>
                      ) : null}
                    </button>

                    <div className="flex flex-1 flex-col gap-1 p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-semibold">{e.name}</span>
                        <span className="shrink-0 rounded border border-keep-rule bg-keep-banner/60 px-1.5 py-0 text-[10px] text-keep-muted">
                          {GENRE_LABEL[e.genre]}
                        </span>
                      </div>
                      <div className="text-[10px] text-keep-muted">
                        by <span className="text-keep-text/80">{e.ownerUsername}</span>
                        <span className="mx-1">·</span>
                        {e.memberCount} {e.memberCount === 1 ? "member" : "members"}
                        <span className="mx-1">·</span>
                        {e.pageCount} {e.pageCount === 1 ? "page" : "pages"}
                      </div>
                      {e.description ? (
                        <p className="line-clamp-3 text-xs text-keep-text/80">{e.description}</p>
                      ) : null}
                      {e.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {e.tags.slice(0, 3).map((t) => (
                            <span
                              key={t}
                              className="rounded border border-keep-rule bg-keep-bg/60 px-1 text-[10px] text-keep-muted"
                            >
                              {t}
                            </span>
                          ))}
                          {e.tags.length > 3 ? (
                            <span className="text-[10px] text-keep-muted">+{e.tags.length - 3}</span>
                          ) : null}
                        </div>
                      ) : null}
                      {e.contentWarnings.length > 0 ? (
                        <div
                          className="flex flex-wrap gap-1"
                          title="Content warnings"
                        >
                          <span className="text-[10px] uppercase tracking-widest text-keep-accent">CW:</span>
                          {e.contentWarnings.map((c) => (
                            <span
                              key={c}
                              className="rounded border border-keep-accent/40 bg-keep-accent/10 px-1 text-[10px] text-keep-accent"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-auto flex flex-wrap items-center justify-end gap-1 pt-2 text-xs">
                        {linkedFlash === e.id ? (
                          <span className="text-[11px] text-keep-action">linked</span>
                        ) : null}
                        {memberWorldIds.has(e.id) ? (
                          <span
                            className="rounded border border-keep-action/40 bg-keep-action/10 px-2 py-0.5 text-keep-action"
                            title="You're a member of this world. Manage from My Worlds."
                          >
                            Joined
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => joinWorld(e.id)}
                            disabled={joining === e.id}
                            title="Join this world to declare an affiliation. Doesn't affect room access."
                            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
                          >
                            {joining === e.id ? "Joining..." : "Join"}
                          </button>
                        )}
                        {currentRoomId ? (
                          <button
                            type="button"
                            onClick={() => linkToRoom(e.id)}
                            disabled={linking === e.id}
                            className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
                            title="Attach this world to the room you're currently in (owner/mod only)"
                          >
                            {linking === e.id ? "..." : "Use in this room"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {hasMore ? (
                <div className="mt-3 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={loading}
                    className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs hover:bg-keep-banner disabled:opacity-50"
                  >
                    {loading ? "Loading..." : "Load more"}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
