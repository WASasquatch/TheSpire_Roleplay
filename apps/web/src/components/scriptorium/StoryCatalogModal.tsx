import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  StoryCard,
  StoryCatalogPage,
  StoryCollaboratorInvite,
  StoryCollaboratorRole,
  StoryGenre,
  StoryRating,
  StoryStatus,
} from "@thekeep/shared";
import {
  SFW_RATINGS,
  STORY_CANONICAL_TAGS,
  STORY_CONTENT_WARNINGS,
  STORY_GENRES,
  STORY_RATINGS,
  STORY_STATUSES,
} from "@thekeep/shared";
import { useChat } from "../../state/store.js";
import { readError } from "../../lib/http.js";
import { formatNumber } from "../../lib/intlFormat.js";
import { buyStoryCopy } from "../../lib/storyCopies.js";
import { Modal, MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";

type CatalogTab = "find" | "my" | "reading" | "following";

interface Props {
  initialTab?: CatalogTab;
  onClose: () => void;
  /** Card is forwarded so callers that want to build a canonical
   *  permalink (anonymous splash → reader) have the slug + author
   *  handle without an extra fetch. Authed callers can ignore it
   *  and just use the id. */
  onOpenStory: (storyId: string, card?: StoryCard) => void;
  /** storyId === null → New Story wizard; otherwise edit that story. */
  onOpenEditor: (storyId: string | null) => void;
}

/**
 * Three-tab Scriptorium catalog: Find / My / Reading.
 * Modeled after WorldCatalogModal but flat (no inline room-link button).
 */
export function StoryCatalogModal({ initialTab = "find", onClose, onOpenStory, onOpenEditor }: Props) {
  const { t } = useTranslation("scriptorium");
  const me = useChat((s) => s.me);
  const [tab, setTab] = useState<CatalogTab>(initialTab);

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-bg text-keep-text`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-lg">{t("catalog.title")}</h2>
          <CloseButton onClick={onClose} />
        </header>

        <nav className="flex shrink-0 items-center gap-1 border-b border-keep-rule bg-keep-panel/30 px-3 py-1.5 text-sm">
          <TabButton active={tab === "find"} onClick={() => setTab("find")}>{t("catalog.tabs.find")}</TabButton>
          {me ? (
            <>
              <TabButton active={tab === "my"} onClick={() => setTab("my")}>{t("catalog.tabs.my")}</TabButton>
              <TabButton active={tab === "reading"} onClick={() => setTab("reading")}>{t("catalog.tabs.reading")}</TabButton>
              <TabButton active={tab === "following"} onClick={() => setTab("following")}>{t("catalog.tabs.following")}</TabButton>
            </>
          ) : null}
          <span className="flex-1" />
          {me ? (
            <button
              type="button"
              onClick={() => onOpenEditor(null)}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg hover:brightness-110"
            >
              {t("catalog.newStory")}
            </button>
          ) : null}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "find" ? (
            <FindStoriesTab onOpenStory={onOpenStory} authed={!!me} />
          ) : tab === "my" ? (
            <MyStoriesTab onOpenStory={onOpenStory} onOpenEditor={onOpenEditor} />
          ) : tab === "reading" ? (
            <ReadingTab onOpenStory={onOpenStory} />
          ) : (
            <FollowingTab onOpenStory={onOpenStory} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-t border-b-2 px-3 py-1 text-xs uppercase tracking-widest transition ${
        active
          ? "border-keep-action bg-keep-bg text-keep-action"
          : "border-transparent text-keep-muted hover:text-keep-text"
      }`}
    >
      {children}
    </button>
  );
}

/* =============================================================
 *  Find Stories tab, server-paged public catalog with filters.
 * ============================================================= */

interface FindFilters {
  q: string;
  genre: StoryGenre | "";
  rating: StoryRating | "";
  status: StoryStatus | "";
  tags: string[];
  exclude: string[];
  sort: "updated" | "published" | "most_read" | "applause";
}

const DEFAULT_FIND_FILTERS: FindFilters = {
  q: "",
  genre: "",
  rating: "",
  status: "",
  tags: [],
  exclude: [],
  sort: "updated",
};

function FindStoriesTab({ onOpenStory, authed }: { onOpenStory: (id: string, card?: StoryCard) => void; authed: boolean }) {
  const { t } = useTranslation("scriptorium");
  const [filters, setFilters] = useState<FindFilters>(DEFAULT_FIND_FILTERS);
  const [page, setPage] = useState(0);
  const [entries, setEntries] = useState<StoryCard[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Buy-a-Copy state for the card tiles. Price is per-card (each card's
  // resolved `copyPrice`); the shop on/off flag + owned set are page-level.
  const [copyEnabled, setCopyEnabled] = useState(false);
  const [ownedIds, setOwnedIds] = useState<Set<string>>(() => new Set());

  const qRef = useRef(filters.q);
  qRef.current = filters.q;

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      void load(page);
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page]);

  async function load(p: number) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.q.trim()) params.set("q", filters.q.trim());
      if (filters.genre) params.set("genre", filters.genre);
      if (filters.rating) params.set("rating", filters.rating);
      if (filters.status) params.set("status", filters.status);
      for (const t of filters.tags) params.append("tag", t);
      for (const c of filters.exclude) params.append("exclude", c);
      params.set("sort", filters.sort);
      params.set("page", String(p));
      const r = await fetch(`/stories/catalog?${params.toString()}`);
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as StoryCatalogPage;
      setEntries(j.entries);
      setTotal(j.total);
      setHasMore(j.hasMore);
      setCopyEnabled(j.copyEnabled);
      setOwnedIds(new Set(j.ownedStoryIds));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  function reset() { setPage(0); setFilters(DEFAULT_FIND_FILTERS); }

  return (
    <div className="flex flex-col gap-3 p-3 md:flex-row md:items-start">
      <aside className="md:sticky md:top-0 md:w-64 md:shrink-0 md:border-r md:border-keep-rule md:pr-3">
        <FilterRail
          filters={filters}
          onChange={(next) => { setPage(0); setFilters(next); }}
          onReset={() => { setPage(0); reset(); }}
          authed={authed}
        />
      </aside>

      <section className="relative min-w-0 flex-1 pb-12">
        {/* Bottom padding above leaves room for the sticky pagination
            footer so the last row of cards isn't covered by it. */}
        {error ? (
          <div className="mb-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}

        {!loading && entries.length === 0 ? (
          <p className="p-4 italic text-keep-muted">
            {total === 0 ? t("catalog.noMatches") : t("catalog.emptyPage")}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {entries.map((s) => (
              <StoryCardTile
                key={s.id}
                card={s}
                onOpen={() => onOpenStory(s.id, s)}
                buy={{ price: s.copyPrice, enabled: copyEnabled, owned: ownedIds.has(s.id) }}
              />
            ))}
          </div>
        )}

        {/* Sticky pagination, anchors to the bottom of the scrollable
            tab body so it stays visible regardless of how many cards
            are on screen. With one or two stories the bar no longer
            floats awkwardly mid-page; with a full grid it pins the
            page nav at the foot where readers expect it. */}
        <div className="sticky bottom-0 -mx-3 -mb-3 mt-4 flex items-center justify-between border-t border-keep-rule bg-keep-bg/95 px-3 py-2 text-xs text-keep-muted backdrop-blur">
          <span>
            {loading
              ? t("common:loadingDots")
              : t("catalog.storyCount", { count: total, formatted: formatNumber(total) })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page === 0 || loading}
              onClick={() => setPage(Math.max(0, page - 1))}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 disabled:opacity-40"
            >
              {t("catalog.prev")}
            </button>
            <span className="tabular-nums">{t("catalog.pageN", { page: page + 1 })}</span>
            <button
              type="button"
              disabled={!hasMore || loading}
              onClick={() => setPage(page + 1)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 disabled:opacity-40"
            >
              {t("catalog.next")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function FilterRail({
  filters,
  onChange,
  onReset,
  authed,
}: {
  filters: FindFilters;
  onChange: (next: FindFilters) => void;
  onReset: () => void;
  authed: boolean;
}) {
  const { t } = useTranslation("scriptorium");
  const [tagDraft, setTagDraft] = useState("");
  const viewerIsAdult = useChat((s) => s.viewerAge.isAdult);
  // Mirror of the server catalog clamp (age plan Phase 4): under-18
  // viewers only ever receive G / PG / PG-13 cards, so the adult
  // rating filters would always come back empty — drop the options.
  const ratingOptions = viewerIsAdult
    ? STORY_RATINGS
    : STORY_RATINGS.filter((r) => (SFW_RATINGS as readonly string[]).includes(r));
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("catalog.search")}</label>
        <input
          value={filters.q}
          onChange={(e) => onChange({ ...filters, q: e.target.value })}
          placeholder={t("catalog.searchPlaceholder")}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        />
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("catalog.sortBy")}</label>
        <select
          value={filters.sort}
          onChange={(e) => onChange({ ...filters, sort: e.target.value as FindFilters["sort"] })}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        >
          <option value="updated">{t("catalog.sort.updated")}</option>
          <option value="published">{t("catalog.sort.published")}</option>
          <option value="most_read">{t("catalog.sort.mostRead")}</option>
          <option value="applause">{t("catalog.sort.applause")}</option>
        </select>
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("genre")}</label>
        <select
          value={filters.genre}
          onChange={(e) => onChange({ ...filters, genre: e.target.value as StoryGenre | "" })}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        >
          <option value="">{t("catalog.allGenres")}</option>
          {STORY_GENRES.map((g) => (
            <option key={g} value={g}>{labelForGenre(t, g)}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("rating.legend")}</label>
        <select
          value={filters.rating}
          onChange={(e) => onChange({ ...filters, rating: e.target.value as StoryRating | "" })}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        >
          <option value="">{t("catalog.allRatings")}</option>
          {ratingOptions.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        {!authed ? (
          <p className="mt-1 text-[10px] italic text-keep-muted">{t("catalog.signInNc17")}</p>
        ) : null}
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("statusLabel")}</label>
        <select
          value={filters.status}
          onChange={(e) => onChange({ ...filters, status: e.target.value as StoryStatus | "" })}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        >
          <option value="">{t("catalog.anyStatus")}</option>
          {STORY_STATUSES.filter((s) => s !== "draft").map((s) => (
            <option key={s} value={s}>{labelForStatus(t, s)}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("catalog.tags")}</label>
        <div className="mt-1 flex flex-wrap gap-1">
          {filters.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onChange({ ...filters, tags: filters.tags.filter((x) => x !== tag) })}
              className="rounded-full border border-keep-action bg-keep-action/15 px-2 py-0.5 text-[11px] text-keep-action"
              title={t("remove")}
            >
              {tag} ×
            </button>
          ))}
        </div>
        <div className="mt-1 flex items-center gap-1">
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const tag = tagDraft.trim().toLowerCase();
                if (tag && !filters.tags.includes(tag)) onChange({ ...filters, tags: [...filters.tags, tag] });
                setTagDraft("");
              }
            }}
            placeholder={t("catalog.addTagPlaceholder")}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
          />
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {STORY_CANONICAL_TAGS.filter((tag) => !filters.tags.includes(tag)).slice(0, 8).map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onChange({ ...filters, tags: [...filters.tags, tag] })}
              className="rounded-full border border-keep-rule bg-keep-bg px-2 py-0.5 text-[10px] text-keep-muted hover:text-keep-text"
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("catalog.hideTagged")}</label>
        <div className="mt-1 flex flex-wrap gap-1">
          {STORY_CONTENT_WARNINGS.map((c) => {
            const on = filters.exclude.includes(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => onChange({
                  ...filters,
                  exclude: on ? filters.exclude.filter((x) => x !== c) : [...filters.exclude, c],
                })}
                className={`rounded-full border px-2 py-0.5 text-[10px] ${
                  on
                    ? "border-keep-accent bg-keep-accent/15 text-keep-accent"
                    : "border-keep-rule bg-keep-bg text-keep-muted hover:text-keep-text"
                }`}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        onClick={onReset}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs text-keep-muted hover:text-keep-text"
      >
        {t("catalog.resetFilters")}
      </button>
    </div>
  );
}

/* =============================================================
 *  My Stories tab
 * ============================================================= */

function MyStoriesTab({
  onOpenStory,
  onOpenEditor,
}: {
  onOpenStory: (id: string) => void;
  onOpenEditor: (id: string | null) => void;
}) {
  const { t } = useTranslation("scriptorium");
  const [stories, setStories] = useState<StoryCard[] | null>(null);
  const [invites, setInvites] = useState<StoryCollaboratorInvite[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      // Load own stories + pending collaboration invites in parallel.
      const [r1, r2] = await Promise.all([
        fetch("/me/stories"),
        fetch("/me/story-invites"),
      ]);
      if (!r1.ok) throw new Error(await readError(r1));
      const j = (await r1.json()) as { stories: StoryCard[] };
      setStories(j.stories);
      if (r2.ok) {
        const j2 = (await r2.json()) as { invites: StoryCollaboratorInvite[] };
        setInvites(j2.invites);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.loadFailed"));
    }
  }

  useEffect(() => { void load(); }, []);

  if (error) {
    return <p className="p-3 text-xs text-keep-accent">{error}</p>;
  }
  if (stories === null) {
    return <p className="p-3 italic text-keep-muted">{t("common:loadingDots")}</p>;
  }
  return (
    <div className="p-3">
      {invites.length > 0 ? <PendingInvites invites={invites} onChanged={load} /> : null}
      {stories.length === 0 && invites.length === 0 ? (
        <div className="p-6 text-center text-sm text-keep-muted">
          {t("catalog.noStoriesYet")}{" "}
          <button
            type="button"
            onClick={() => onOpenEditor(null)}
            className="ml-1 text-keep-action underline-offset-4 hover:underline"
          >
            {t("catalog.writeFirst")}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {stories.map((s) => (
            <StoryCardTile
              key={s.id}
              card={s}
              onOpen={() => onOpenStory(s.id)}
              edit={{ onClick: () => onOpenEditor(s.id) }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pending collaboration invites surface at the top of My Stories. One
 * row per invite with Accept / Decline. Accepting flips the row to
 * active server-side and the story appears in the in-app catalog for
 * the user; declining deletes the row.
 */
function PendingInvites({
  invites,
  onChanged,
}: {
  invites: StoryCollaboratorInvite[];
  onChanged: () => void;
}) {
  const { t } = useTranslation("scriptorium");
  return (
    <section className="mb-4 rounded border border-keep-accent/40 bg-keep-accent/5 p-3">
      <h3 className="mb-2 font-action text-base text-keep-accent">
        {t("catalog.pendingInvites", { count: invites.length })}
      </h3>
      <ul className="space-y-2">
        {invites.map((inv) => (
          <InviteRow key={inv.storyId} invite={inv} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function InviteRow({
  invite,
  onChanged,
}: {
  invite: StoryCollaboratorInvite;
  onChanged: () => void;
}) {
  const { t } = useTranslation("scriptorium");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function act(kind: "accept" | "decline") {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/me/story-invites/${invite.storyId}/${kind}`, { method: "POST" });
      if (!r.ok) throw new Error(await readError(r));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : (kind === "accept" ? t("errors.acceptFailed") : t("errors.declineFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 rounded border border-keep-rule/40 bg-keep-panel/30 p-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <b>{invite.storyTitle}</b>
          <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${inviteRoleClass(invite.role)}`}>
            {t(`roles.${invite.role}`)}
          </span>
        </div>
        <div className="text-[11px] text-keep-muted">
          {t("byAuthor", { name: invite.storyAuthorUsername })}
          {invite.invitedByUsername && invite.invitedByUsername !== invite.storyAuthorUsername ? (
            <> · {t("catalog.invitedByFrag", { name: invite.invitedByUsername })}</>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => act("accept")}
          disabled={busy}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {t("invites.accept")}
        </button>
        <button
          type="button"
          onClick={() => act("decline")}
          disabled={busy}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs text-keep-muted hover:text-keep-text"
        >
          {t("invites.decline")}
        </button>
      </div>
      {err ? <p className="w-full text-xs text-keep-accent">{err}</p> : null}
    </li>
  );
}

function inviteRoleClass(r: StoryCollaboratorRole): string {
  switch (r) {
    case "reader":    return "bg-keep-muted/25 text-keep-muted";
    case "editor":    return "bg-sky-500/15 text-sky-300";
    case "co_author": return "bg-amber-500/15 text-amber-300";
  }
}

/* =============================================================
 *  Reading tab, continue-reading list
 * ============================================================= */

function ReadingTab({ onOpenStory }: { onOpenStory: (id: string) => void }) {
  const { t } = useTranslation("scriptorium");
  return (
    <SimpleStoryList
      endpoint="/me/stories/reading"
      emptyMessage={t("catalog.readingEmpty")}
      onOpenStory={onOpenStory}
    />
  );
}

function FollowingTab({ onOpenStory }: { onOpenStory: (id: string) => void }) {
  const { t } = useTranslation("scriptorium");
  return (
    <SimpleStoryList
      endpoint="/me/stories/following"
      emptyMessage={t("catalog.followingEmpty")}
      onOpenStory={onOpenStory}
    />
  );
}

/**
 * Shared list shape for Reading / Following, both endpoints return
 * `{ stories: StoryCard[] }`. Keeps the two tabs from duplicating
 * load/loading/empty state.
 */
function SimpleStoryList({
  endpoint,
  emptyMessage,
  onOpenStory,
}: {
  endpoint: string;
  emptyMessage: string;
  onOpenStory: (id: string) => void;
}) {
  const { t } = useTranslation("scriptorium");
  const [stories, setStories] = useState<StoryCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(endpoint)
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return (await r.json()) as { stories: StoryCard[] };
      })
      .then((j) => { if (!cancelled) setStories(j.stories); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t("errors.loadFailed")); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  if (error) return <p className="p-3 text-xs text-keep-accent">{error}</p>;
  if (stories === null) return <p className="p-3 italic text-keep-muted">{t("common:loadingDots")}</p>;
  if (stories.length === 0) {
    return <p className="p-6 text-center text-sm text-keep-muted">{emptyMessage}</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
      {stories.map((s) => (
        <StoryCardTile key={s.id} card={s} onOpen={() => onOpenStory(s.id)} />
      ))}
    </div>
  );
}

/* =============================================================
 *  Card
 * ============================================================= */

function StoryCardTile({
  card,
  onOpen,
  edit,
  buy,
}: {
  card: StoryCard;
  onOpen: () => void;
  edit?: { onClick: () => void };
  /** Buy-a-Copy CTA shown on browsable catalog cards. Omitted on the
   *  "My Stories" tab (you can't buy your own book). */
  buy?: { price: number; enabled: boolean; owned: boolean };
}) {
  const { t } = useTranslation("scriptorium");
  const authorName = card.author.characterName ?? card.author.masterUsername;
  // OOC ↔ character partition: a story attributed to a character
  // voice never falls back to the master's avatar. Initials of the
  // character's display name render when no character portrait is
  // set; the master's face is only shown when the story itself is
  // attributed to the master (no characterName on the card).
  const authorAvatar = card.author.characterName
    ? (card.author.characterAvatarUrl ?? null)
    : (card.author.masterAvatarUrl ?? null);
  // NC-17 cards in the anonymous catalog get a lock overlay + a
  // hover tooltip explaining why; clicking still fires `onOpen` so
  // the parent can route to the login prompt. `useChat.me` is the
  // canonical signal here, when the viewer is signed in, the
  // server-side opt-in already filtered out NSFW unless they asked
  // for it, so we trust the card's presence and skip the gate.
  const me = useChat((s) => s.me);
  const lockedForAnon = !me && card.rating === "NC-17";
  return (
    <article className="group relative flex flex-col overflow-hidden rounded border border-keep-rule bg-keep-panel/30 transition hover:border-keep-action/60 hover:bg-keep-panel/60">
      <button
        type="button"
        onClick={onOpen}
        // 3:2 landscape FRAME paired with `object-contain` (below):
        //   - Portrait cover uploads (book-cover standard) display
        //     as portrait inside the landscape frame, letterboxed
        //     left/right against the bg-keep-bg tint. The image
        //     STILL READS as portrait at its natural aspect, the
        //     frame just doesn't grow to match.
        //   - Landscape covers fit the frame nearly edge to edge
        //     with a small top/bottom letterbox if the aspect
        //     doesn't quite match.
        // A previous attempt used a 2:3 portrait frame, but when
        // the grid drops to one or two columns the cell width is
        // wide, and 2:3 made the cover ~1.5× column-width tall,
        // the card's title + meta fell off the bottom of the
        // modal and forced scrolling per card. 3:2 keeps the card
        // compact and the title visible.
        className="relative block aspect-[3/2] w-full overflow-hidden bg-keep-bg/60 text-left"
        title={lockedForAnon ? t("catalog.nc17CardTitle") : undefined}
      >
        {card.coverImageUrl ? (
          <img
            src={card.coverImageUrl}
            alt={card.title}
            // `object-contain` (not `object-cover`), never crop
            // user-uploaded cover art. Aspect mismatch with the
            // landscape frame letterboxes against bg-keep-bg,
            // which reads as intentional framing rather than as
            // truncation.
            className={`h-full w-full object-contain transition group-hover:scale-[1.02] ${lockedForAnon ? "blur-sm" : ""}`}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-keep-bg via-keep-panel to-keep-banner/50 px-4 text-center font-action text-base text-keep-text/70">
            {card.title}
          </div>
        )}
        {lockedForAnon ? (
          // Hover-revealed lock overlay. At rest the cover stays blurred
          // (signal that something's gated) but the title/meta below
          // remain readable; the overlay only fills in on hover so the
          // user understands what to do.
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-rose-950/60 px-4 text-center opacity-0 transition group-hover:opacity-100">
            <span className="text-2xl" aria-hidden>🔒</span>
            <span className="text-xs font-semibold uppercase tracking-widest text-rose-100">
              {t("catalog.nc17Explicit")}
            </span>
            <span className="text-[11px] text-rose-100/85">
              {t("loginToRead")}
            </span>
          </div>
        ) : null}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
        <button type="button" onClick={onOpen} className="text-left">
          <h3 className="line-clamp-2 font-action text-base leading-tight text-keep-text group-hover:text-keep-action">
            {card.title}
          </h3>
        </button>

        <div className="flex items-center gap-1.5 text-xs text-keep-muted">
          {authorAvatar ? (
            <img src={authorAvatar} alt="" className="h-4 w-4 rounded-full object-cover" referrerPolicy="no-referrer" />
          ) : null}
          <span>{t("byAuthor", { name: authorName })}</span>
          {card.author.characterId ? <span className="italic">{t("asCharacter")}</span> : null}
        </div>

        <div className="flex flex-wrap items-center gap-1 text-[10px] uppercase tracking-widest">
          <span className={`rounded border px-1.5 py-0.5 ${ratingBadgeClass(card.rating)}`}>{card.rating}</span>
          <span className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-keep-muted">
            {labelForGenre(t, card.genre)}
          </span>
          <span className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-keep-muted">
            {labelForStatus(t, card.status)}
          </span>
          {card.visibility !== "public" ? (
            <span className="rounded border border-keep-accent/40 bg-keep-accent/10 px-1.5 py-0.5 text-keep-accent">
              {card.visibility}
            </span>
          ) : null}
          {card.buyToRead ? (
            <span className="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-amber-300" title={t("catalog.buyToReadChipTitle")}>
              {t("catalog.buyToReadChip")}
            </span>
          ) : null}
        </div>

        {card.summary ? (
          <p className="line-clamp-3 text-xs leading-snug text-keep-text/85">{card.summary}</p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-keep-muted">
          <span><b className="text-keep-text">{card.totalChapters}</b> {t("catalog.chAbbrev")}</span>
          <span><b className="text-keep-text">{formatNumber(card.totalWords)}</b> {t("catalog.wAbbrev")}</span>
          {card.readerCount > 0 ? <span><b className="text-keep-text">{card.readerCount}</b> {t("catalog.readersLabel")}</span> : null}
          {card.applauseCount > 0 ? <span>👏 {card.applauseCount}</span> : null}
          {card.avgRating != null ? <span>★ {card.avgRating.toFixed(1)}</span> : null}
        </div>

        {edit ? (
          <button
            type="button"
            onClick={edit.onClick}
            className="mt-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-[11px] text-keep-muted hover:text-keep-text"
          >
            {t("edit")}
          </button>
        ) : null}

        {/* Buy-a-Copy, only on browsable cards (not your own books) when
            signed in. Buying adds the book to your profile Library; the
            "show on profile" toggle then lives in the reader. */}
        {buy && me && card.author.userId !== me.id && card.status !== "draft" ? (
          <CatalogBuyButton
            storyId={card.id}
            price={buy.price}
            enabled={buy.enabled}
            initialOwned={buy.owned}
          />
        ) : null}
      </div>
    </article>
  );
}

/** Buy / Owned control on a catalog card. Self-contained: tracks its own
 *  owned state so it flips to "In your Library" right after a purchase
 *  without a catalog reload. Buys under the active identity (character or
 *  master), mirroring the reader's Buy a Copy. */
function CatalogBuyButton({
  storyId,
  price,
  enabled,
  initialOwned,
}: {
  storyId: string;
  price: number;
  enabled: boolean;
  initialOwned: boolean;
}) {
  const { t } = useTranslation("scriptorium");
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  const setNotice = useChat((s) => s.setNotice);
  const [owned, setOwned] = useState(initialOwned);
  const [busy, setBusy] = useState(false);

  if (owned) {
    return (
      <span className="mt-1 inline-flex items-center justify-center gap-1 self-start rounded border border-keep-action/40 bg-keep-action/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-keep-action">
        <span aria-hidden>📚</span> {t("buy.inLibrary")}
      </span>
    );
  }
  if (!enabled) return null;

  async function buy(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const res = await buyStoryCopy(storyId, activeCharacterId);
      setOwned(true);
      setNotice({
        code: "scriptorium_copy",
        message: t("buy.copyAddedProfile", { price: res.price }),
      });
    } catch (err) {
      setNotice({ code: "scriptorium_copy_err", message: err instanceof Error ? err.message : t("errors.purchaseFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={buy}
      disabled={busy}
      title={t("buy.buyTitle", { price })}
      className="mt-1 inline-flex items-center justify-center gap-1 self-start rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-keep-action transition hover:bg-keep-action/25 disabled:opacity-50"
    >
      <span aria-hidden>📖</span> {t("buy.buyLabel", { price })}
    </button>
  );
}

function labelForGenre(t: TFunction<"scriptorium">, g: StoryGenre): string {
  return t(`genres.${g}`);
}

function labelForStatus(t: TFunction<"scriptorium">, s: StoryStatus): string {
  return t(`statuses.${s}`);
}

function ratingBadgeClass(r: StoryRating): string {
  switch (r) {
    case "G":      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
    case "PG":     return "border-sky-500/40 bg-sky-500/10 text-sky-300";
    case "PG-13":  return "border-amber-500/40 bg-amber-500/10 text-amber-300";
    case "R":      return "border-orange-500/50 bg-orange-500/10 text-orange-300";
    case "NC-17":  return "border-rose-500/60 bg-rose-500/10 text-rose-300";
  }
}
