import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { AffiliateCard, type AffiliateCardSize } from "./AffiliateCard.js";
import type { PublicAffiliateCard } from "../../lib/affiliates.js";

type SortKey = "traffic" | "in" | "out" | "az";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "traffic", label: "Most active" },
  { key: "in", label: "Most sent to us" },
  { key: "out", label: "Most sent out" },
  { key: "az", label: "A to Z" },
];

/** How many listings show per page (topsite pagination). */
const PAGE_SIZE = 8;

/**
 * The Top RP Communities board: a searchable, sortable, tag-filterable, paginated
 * grid of community cards. Shared by the members' modal and the public
 * /top-communities page (the `size` prop scales the cards; "large" renders
 * full-width rows). Ranking mirrors the server default (busiest first) but the
 * viewer can re-sort or filter by tag / free text.
 *
 * All filtering is client-side over the already-fetched approved list, so it's
 * instant; pagination just windows the results so only N render at a time.
 */
export function CommunityBoard({
  cards,
  size = "large",
  emptyText = "No communities match your search.",
}: {
  cards: PublicAffiliateCard[];
  size?: AffiliateCardSize;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("traffic");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Tag cloud (counts) from the fetched cards; top 12 power the chip row.
  const topTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of cards) for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [cards]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    let rows = cards;
    if (activeTag) rows = rows.filter((c) => c.tags.includes(activeTag));
    if (q) {
      rows = rows.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.tags.some((t) => t.includes(q)),
      );
    }
    const sorted = [...rows];
    switch (sort) {
      case "az":
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "in":
        sorted.sort((a, b) => b.clicksIn - a.clicksIn);
        break;
      case "out":
        sorted.sort((a, b) => b.clicksOut - a.clicksOut);
        break;
      default:
        sorted.sort((a, b) => b.clicksIn + b.clicksOut - (a.clicksIn + a.clicksOut));
    }
    return sorted;
  }, [cards, activeTag, q, sort]);

  // Reset to the first page whenever the filter/sort changes.
  useEffect(() => { setPage(0); }, [q, sort, activeTag]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const start = current * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);

  const gridClass = size === "large" ? "grid grid-cols-1 gap-4" : "grid grid-cols-1 gap-3";

  return (
    <div className="space-y-4">
      {/* Search + sort. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-keep-muted" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or tag…"
            aria-label="Search communities by name or tag"
            className="w-full rounded-lg border border-keep-rule bg-keep-bg/70 py-2 pl-9 pr-9 text-sm shadow-inner outline-none transition focus:border-keep-action focus:ring-1 focus:ring-keep-action/30"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search text"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-keep-muted hover:text-keep-text"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-keep-muted">
          <span className="whitespace-nowrap">Sort</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort communities"
            className="rounded-lg border border-keep-rule bg-keep-bg/70 px-2.5 py-2 text-sm text-keep-text shadow-inner outline-none transition focus:border-keep-action"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Tag chips. */}
      {topTags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {topTags.map(([tag, count]) => {
            const on = activeTag === tag;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(on ? null : tag)}
                aria-pressed={on}
                className={`rounded-full border px-3 py-1 text-xs lowercase transition-colors ${
                  on
                    ? "border-keep-action bg-keep-action/20 text-keep-text shadow-sm"
                    : "border-keep-rule text-keep-muted hover:border-keep-action hover:text-keep-text"
                }`}
              >
                {tag} <span className="text-keep-muted">{count}</span>
              </button>
            );
          })}
          {activeTag ? (
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className="rounded-full px-2.5 py-1 text-xs text-keep-muted hover:text-keep-text"
            >
              Clear tag
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Grid. */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-keep-rule bg-keep-panel/30 px-4 py-10 text-center text-sm text-keep-muted">
          {emptyText}
        </div>
      ) : (
        <div className={gridClass}>
          {pageItems.map((card) => (
            <AffiliateCard key={card.id} card={card} size={size} />
          ))}
        </div>
      )}

      {/* Pagination. */}
      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-3 pt-1 text-xs text-keep-muted">
          <span>
            Showing {start + 1}&ndash;{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={current === 0}
              aria-label="Previous page"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-keep-rule text-keep-text transition hover:border-keep-action hover:text-keep-action disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="tabular-nums">Page {current + 1} of {pageCount}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={current >= pageCount - 1}
              aria-label="Next page"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-keep-rule text-keep-text transition hover:border-keep-action hover:text-keep-action disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
