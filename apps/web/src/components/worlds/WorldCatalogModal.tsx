import { useEffect, useMemo, useState } from "react";
import type {
  WorldCatalogEntry,
  WorldCatalogPage,
  WorldGenre,
  WorldVibeAxisKey,
  WorldVibeStats,
} from "@thekeep/shared";
import { CANONICAL_TAGS, CONTENT_WARNINGS, WORLD_VIBE_AXES } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { Modal, MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";
import { ApplicationFormModal } from "./ApplicationFormModal.js";
import { useChat } from "../../state/store.js";

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
 * Cover images are best-effort, when a world doesn't have one set we
 * fall back to a text-only card the same shape so the grid stays
 * uniform. Cards are clickable to open the viewer; the secondary
 * actions (Join, Use in this room) sit in a small footer row.
 */
export function WorldCatalogModal({ currentRoomId, onClose, onOpenViewer }: Props) {
  // Viewer's own username so owner-of-this-card detection can skip
  // the join/apply button (owners are implicit members of their own
  // worlds, clicking Join would be a no-op, clicking Apply would
  // 400 with "owners don't apply to their own worlds").
  const meUsername = useChat((s) => s.me?.username ?? null);
  // Per migration 0187 the "Joined" pill must reflect the CURRENT
  // identity only: an OOC viewer doesn't see "Joined" for worlds
  // where only their character Avery has joined. Filter the
  // memberships fetch result against this id when building the set.
  const activeCharId = useChat((s) => s.activeCharacterId);
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

  // Vibe-stat range filter state. Per-axis min/max sliders; the
  // "Advanced filters" panel hides them by default to keep the
  // filter strip compact for new visitors.
  const [vibeRanges, setVibeRanges] = useState<Partial<Record<WorldVibeAxisKey, { min: number; max: number }>>>({});
  const [vibeOpen, setVibeOpen] = useState(false);

  // Worlds the viewer has already joined - drives "Join" vs "Joined" labels.
  const [memberWorldIds, setMemberWorldIds] = useState<Set<string>>(new Set());
  const [joining, setJoining] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [linkedFlash, setLinkedFlash] = useState<string | null>(null);
  // Catalog entry the user clicked "Apply" on, drives the
  // ApplicationFormModal mount. Cleared on close / submit.
  const [applyingTo, setApplyingTo] = useState<WorldCatalogEntry | null>(null);

  // Debounce the free-text search so we don't fire a fetch on every
  // keystroke. 250ms feels responsive without spamming the endpoint.
  useEffect(() => {
    const h = window.setTimeout(() => setQDebounced(q.trim()), 250);
    return () => window.clearTimeout(h);
  }, [q]);

  // Reset to page 0 whenever the filter changes, otherwise a user
  // typing into the search box on page 3 would think the corpus is
  // empty when actually the new query has fewer pages.
  // Vibe range as a stable string for the dependency array, keying
  // by the JSON makes a per-axis slider change trigger the page
  // reset + refetch without needing to track each min/max as its own
  // separate state slot.
  const vibeRangesKey = useMemo(() => JSON.stringify(vibeRanges), [vibeRanges]);

  useEffect(() => {
    setPage(0);
  }, [qDebounced, genre, tagSel, excludeSel, vibeRangesKey]);

  // Stable query-string builder so the dep array can compare strings
  // instead of arrays / objects.
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (qDebounced) params.set("q", qDebounced);
    if (genre) params.set("genre", genre);
    for (const t of tagSel) params.append("tag", t);
    for (const x of excludeSel) params.append("exclude", x);
    for (const axis of WORLD_VIBE_AXES) {
      const r = vibeRanges[axis.key];
      if (!r) continue;
      // Skip "full range" (0..100) since it's equivalent to no
      // filter at all; sending it would needlessly exclude rows
      // with NULL stats.
      if (r.min === 0 && r.max === 100) continue;
      params.set(`min_${axis.key}`, String(r.min));
      params.set(`max_${axis.key}`, String(r.max));
    }
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    return params.toString();
  }, [qDebounced, genre, tagSel, excludeSel, vibeRanges, page]);

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
          ? ((await memRes.json()) as { memberships: { worldId: string; characterId: string | null }[] }).memberships
          : [];
        if (cancelled) return;
        setEntries((prev) => (cat.page > 0 ? [...prev, ...cat.entries] : cat.entries));
        setTotal(cat.total);
        setHasMore(cat.hasMore);
        // Identity-aware Joined set: only memberships filed under the
        // viewer's CURRENT identity (active character, or OOC when
        // null) participate. Other identities of the same master are
        // independent, their Joined status doesn't bleed onto the
        // current face's catalog view.
        setMemberWorldIds(new Set(
          mem
            .filter((m) => m.characterId === activeCharId)
            .map((m) => m.worldId),
        ));
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "load failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Re-fetch on identity switch so the Joined pills retarget to
    // the new face's memberships.
  }, [queryString, activeCharId]);

  function toggleTag(t: string) {
    setTagSel((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));
  }
  function toggleExclude(c: string) {
    setExcludeSel((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  }
  function setVibeRange(axis: WorldVibeAxisKey, min: number, max: number) {
    setVibeRanges((r) => ({ ...r, [axis]: { min, max } }));
  }
  function clearVibeRange(axis: WorldVibeAxisKey) {
    setVibeRanges((r) => {
      const next = { ...r };
      delete next[axis];
      return next;
    });
  }
  function clearFilters() {
    setQ("");
    setGenre("");
    setTagSel([]);
    setExcludeSel([]);
    setVibeRanges({});
  }
  const anyVibeFilter = Object.keys(vibeRanges).length > 0;
  const anyFilter = !!q || !!genre || tagSel.length > 0 || excludeSel.length > 0 || anyVibeFilter;

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
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-parchment`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-lg">World catalog</h2>
          <CloseButton onClick={onClose} />
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
          {/* Vibe-stat range filters. Collapsed by default so the
              filter strip stays compact; expand to reveal eight
              min/max sliders. Worlds with NULL stats drop out of
              any axis the user constrains, see the server-side
              IS NOT NULL gate. */}
          <div>
            <button
              type="button"
              onClick={() => setVibeOpen((v) => !v)}
              className="text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-action"
            >
              {vibeOpen ? "▾" : "▸"} Vibe filters{anyVibeFilter ? ` (${Object.keys(vibeRanges).length})` : ""}
            </button>
            {vibeOpen ? (
              <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                {WORLD_VIBE_AXES.map((axis) => {
                  const r = vibeRanges[axis.key];
                  const active = !!r;
                  return (
                    <div
                      key={axis.key}
                      className={
                        "flex items-center gap-2 rounded border px-2 py-1 text-[11px] " +
                        (active
                          ? "border-keep-action/60 bg-keep-action/5"
                          : "border-keep-rule bg-keep-bg")
                      }
                    >
                      <span className="w-16 shrink-0 text-keep-text" title={axis.desc}>{axis.label}</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={r?.min ?? 0}
                        onChange={(e) => {
                          const min = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
                          setVibeRange(axis.key, min, r?.max ?? 100);
                        }}
                        className="w-14 rounded border border-keep-rule bg-keep-bg px-1 py-0 text-right tabular-nums"
                        aria-label={`${axis.label} minimum`}
                      />
                      <span className="text-keep-muted">–</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={r?.max ?? 100}
                        onChange={(e) => {
                          const max = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
                          setVibeRange(axis.key, r?.min ?? 0, max);
                        }}
                        className="w-14 rounded border border-keep-rule bg-keep-bg px-1 py-0 text-right tabular-nums"
                        aria-label={`${axis.label} maximum`}
                      />
                      {active ? (
                        <button
                          type="button"
                          onClick={() => clearVibeRange(axis.key)}
                          className="ml-auto rounded border border-keep-rule px-1 text-[10px] text-keep-muted hover:bg-keep-banner hover:text-keep-text"
                          title="Clear filter for this axis"
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
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
                : "No open worlds yet. Be the first, mark one of yours as “open” in its settings."}
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
                      <VibeBars stats={e.vibeStats} />
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
                        {memberWorldIds.has(e.id) || e.ownerUsername === meUsername ? (
                          // Owners are implicit members of their own
                          // worlds, so they get the same "Joined"
                          // treatment as explicit members, no
                          // separate Apply / Join button (it would
                          // either no-op or 400). The cover-image
                          // click still opens the viewer.
                          <span
                            className="rounded border border-keep-action/40 bg-keep-action/10 px-2 py-0.5 text-keep-action"
                            title="You're a member of this world. Manage from My Worlds."
                          >
                            Joined
                          </span>
                        ) : e.joinMode === "invite-only" ? (
                          <span
                            className="rounded border border-keep-rule bg-keep-bg/60 px-2 py-0.5 text-keep-muted"
                            title="The owner adds members directly, no public Join."
                          >
                            Invite only
                          </span>
                        ) : e.joinMode === "application" ? (
                          <button
                            type="button"
                            onClick={() => setApplyingTo(e)}
                            title="Submit an application to join, the owner reviews it."
                            className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-keep-action hover:bg-keep-action/20"
                          >
                            Apply
                          </button>
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
      {applyingTo ? (
        <ApplicationFormModal
          worldId={applyingTo.id}
          worldName={applyingTo.name}
          onClose={() => setApplyingTo(null)}
          onSubmitted={() => {
            // Submitted = the row exists with status=pending. We
            // don't add the world to memberWorldIds yet (member
            // status only flips on approve). Close the form so the
            // user can see the catalog again; the world's apply
            // button stays "Apply" until the catalog refetches and
            // the next /worlds/:id detail call surfaces the pending
            // viewerApplication state, which the user sees in
            // their My Worlds → Pending Applications view.
            setApplyingTo(null);
          }}
        />
      ) : null}
    </Modal>
  );
}

/**
 * Eight-bar vibe-stat strip rendered on each catalog card. Each axis
 * gets a slim bar with the value inset; null axes render as a muted
 * "-" so "unset" reads visually distinct from "0%". Mirrors the
 * advert-screenshot layout (Magic 60% / Combat 70% / etc.).
 */
function VibeBars({ stats }: { stats: WorldVibeStats }) {
  // If every axis is null, render nothing at all, a card with no
  // tuned stats shouldn't waste vertical space on eight dashes.
  const anyTuned = WORLD_VIBE_AXES.some((a) => stats[a.key] !== null);
  if (!anyTuned) return null;
  return (
    <ul className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
      {WORLD_VIBE_AXES.map((axis) => {
        const v = stats[axis.key];
        return (
          <li key={axis.key} className="flex items-center gap-1.5" title={axis.desc}>
            <span className="w-14 shrink-0 truncate text-keep-muted">{axis.label}</span>
            {v === null ? (
              <span className="text-keep-muted/60">-</span>
            ) : (
              <span className="relative h-2.5 flex-1 overflow-hidden rounded bg-keep-banner/40">
                <span
                  className="absolute inset-y-0 left-0 bg-keep-action/70"
                  style={{ width: `${v}%` }}
                />
                <span className="absolute inset-0 flex items-center justify-end pr-1 text-[9px] font-semibold tabular-nums text-keep-text mix-blend-difference">
                  {v}%
                </span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
