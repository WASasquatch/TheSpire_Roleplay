/**
 * Anonymous landing for `/f/<slug>` (Forums revamp, Phase 7).
 *
 * The shareable face of a forum for visitors without a session: the
 * forum's banner/logo/name/tagline, its description, the board list as a
 * read-only teaser (topic content requires an account), and the classic
 * forum entrance — log in / register — with context copy that's explicit
 * about what they're signing up for:
 *
 *   open forums:        "you're signing up for <Site> — home of this
 *                        public forum"
 *   application forums: "registering lets you APPLY for access to a
 *                        forum hosted within <Site>'s public forums"
 *
 * The chosen destination is remembered in localStorage; after the
 * login/registration round-trip the authed boot (App) reads the key and
 * opens the Forums Catalog on this forum, so the visitor lands where the
 * link promised. The forum's own theme applies to this card only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CalendarDays, Landmark, Lock, LogIn, MessagesSquare, Repeat, UserPlus, Users } from "lucide-react";
import { normalizeTheme, parseEventRecurrence } from "@thekeep/shared";
import type { ChatMessage, ForumDetail, ThreadCategory } from "@thekeep/shared";
import { fetchForumDetail, fetchRoomCategories, locateForumTopic, relTime } from "../../lib/forums.js";
import { formatDate, formatDateTime, formatNumber } from "../../lib/intlFormat.js";
import { EventIcon } from "../../lib/eventIcons.js";
import { DEFAULT_STYLE_KEY } from "../../lib/ornaments/index.js";
import { forumBannerInk, inkClass, isDarkSurface, themeStyle, useActiveTheme, useImageAverageColor, useScopedRootDesign } from "../../lib/theme.js";
import { sanitizeUserHtml, USER_HTML_SCOPE_CLASS } from "../../lib/userHtml.js";
import { MessageList } from "../chat/MessageList.js";
import { useChat } from "../../state/store.js";
import { createPendingDestination } from "../../lib/pendingDestination.js";

const returnForum = createPendingDestination("spire:return-forum");

/** localStorage key the authed boot consumes to land on the forum after
 *  the login/registration round-trip. */
export const RETURN_FORUM_STORAGE_KEY = returnForum.storageKey;

/**
 * Read the pending forum destination. The landing stores JSON
 * `{slug, name}` (the name feeds AuthGate's "you're registering to
 * access <Forum>" banner); a legacy plain-slug value still parses so
 * in-flight round-trips across a deploy don't break.
 */
export const readReturnForum = returnForum.read;

/** Bucket shape MessageList's forum view consumes (kept local — the
 *  landing builds these from anonymous fetches, no store involved). */
interface AnonBucket {
  topics: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  pending: ChatMessage[];
  currentPage: number;
  totalPages: number;
  totalCount: number;
  perPage: number;
}

const NOOP = () => { /* anonymous reader: no-op */ };

/** One read-only upcoming-event card from `GET /forums/:slug/events` (an
 *  occurrence of a possibly-recurring event; RSVP lives in the member panel). */
interface StripEvent {
  event: {
    id: string;
    title: string;
    icon: string | null;
    startsAt: number;
    endsAt: number | null;
    status: string;
    recurrenceJson: string | null;
  };
  occurrenceStartsAt: number;
  occurrenceEndsAt: number | null;
  counts: { going: number };
}

/**
 * "Upcoming events" strip on the public landing: the forum's linked community
 * events, read-only (title/when/repeats/going count). Anon-safe by
 * construction — the route composes the forum's own visibility gates and
 * returns an empty list rather than teasing withheld content, and the whole
 * section renders nothing when there's nothing to show.
 */
function UpcomingEventsStrip({ slug }: { slug: string }) {
  const { t } = useTranslation("forums");
  const [events, setEvents] = useState<StripEvent[]>([]);

  useEffect(() => {
    let alive = true;
    fetch(`/forums/${encodeURIComponent(slug)}/events`, { credentials: "include" })
      .then(async (r) => (r.ok ? ((await r.json()) as { events?: StripEvent[] }).events ?? [] : []))
      .then((list) => { if (alive) setEvents(list); })
      .catch(() => { /* strip stays hidden */ });
    return () => { alive = false; };
  }, [slug]);

  if (events.length === 0) return null;
  return (
    <section className="border-b border-keep-rule px-5 py-5 md:px-8">
      <h2 className="mb-3 flex items-center gap-1.5 text-xs uppercase tracking-widest text-keep-muted">
        <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
        {t("landing.upcomingEvents")}
      </h2>
      <ul className="space-y-2">
        {events.map((row) => {
          const repeats = !!parseEventRecurrence(row.event.recurrenceJson);
          return (
            <li
              key={`${row.event.id}:${row.occurrenceStartsAt}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-keep-rule bg-keep-panel/30 px-4 py-2.5"
            >
              <EventIcon name={row.event.icon} className="h-4 w-4 shrink-0 text-keep-muted" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-keep-text">{row.event.title}</span>
              {row.event.status === "live" ? (
                <span className="shrink-0 rounded bg-keep-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-keep-bg">{t("landing.eventLive")}</span>
              ) : null}
              {repeats ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted">
                  <Repeat className="h-3 w-3" aria-hidden="true" />
                  {t("landing.eventRepeats")}
                </span>
              ) : null}
              <span className="shrink-0 text-[11px] tabular-nums text-keep-muted">
                {formatDateTime(row.occurrenceStartsAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </span>
              {row.counts.going > 0 ? (
                <span className="shrink-0 text-[11px] text-keep-muted">{t("landing.eventGoing", { count: row.counts.going })}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] italic text-keep-muted">{t("landing.eventsRsvpHint")}</p>
    </section>
  );
}

/**
 * Read-only board browser for PUBLIC-BROWSING forums — the same
 * MessageList nested renderer the catalog uses, fed by anonymous
 * fetches. Every write affordance is hidden (readOnly) and the
 * "+ New Topic" buttons route to the login CTA instead.
 */
function PublicBoardReader({ detail, slug, initialTopicId, initialPostId, onRequireLogin }: {
  detail: ForumDetail;
  slug: string;
  initialTopicId: string | null;
  initialPostId: string | null;
  onRequireLogin: () => void;
}) {
  const { t } = useTranslation("forums");
  const [boardId, setBoardId] = useState<string>(detail.boards[0]?.roomId ?? "");
  const [cats, setCats] = useState<ThreadCategory[] | null>(null);
  const [buckets, setBuckets] = useState<Record<string, AnonBucket>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const loadPage = useCallback(async (key: string, page: number) => {
    setBuckets((cur) => ({
      ...cur,
      [key]: { ...(cur[key] ?? { topics: [], hasMore: false, pending: [], currentPage: 1, totalPages: 1, totalCount: 0, perPage: 20 }), loading: true },
    }));
    try {
      const categoryParam = key === "_uncat" ? "" : key;
      const r = await fetch(
        `/rooms/${encodeURIComponent(boardId)}/topics?category=${encodeURIComponent(categoryParam)}&page=${page}`,
        { credentials: "include" },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as {
        topics: ChatMessage[]; page: number | null; perPage: number; totalPages: number; totalCount: number; hasMore: boolean;
      };
      setBuckets((cur) => ({
        ...cur,
        [key]: {
          topics: j.topics,
          hasMore: j.hasMore,
          loading: false,
          pending: [],
          currentPage: j.page ?? page,
          totalPages: j.totalPages || 1,
          totalCount: j.totalCount || 0,
          perPage: j.perPage || 20,
        },
      }));
    } catch {
      setBuckets((cur) => cur[key] ? { ...cur, [key]: { ...cur[key]!, loading: false } } : cur);
    }
  }, [boardId]);

  // Board switch: fresh categories + first pages.
  useEffect(() => {
    if (!boardId) return;
    let alive = true;
    setCats(null); setBuckets({}); setMessages([]); setActiveTopicId(null);
    fetchRoomCategories(boardId)
      .then((c) => { if (alive) setCats(c); })
      .catch(() => { if (alive) setCats([]); });
    return () => { alive = false; };
  }, [boardId]);
  useEffect(() => {
    if (!cats) return;
    for (const k of [...cats.map((c) => c.id), "_uncat"]) void loadPage(k, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cats]);

  /** Mirror navigation into the address bar: the URL IS the permalink.
   *  pushState (not replace) so the browser back button walks out of a
   *  topic naturally. */
  const reflectUrl = useCallback((topicId: string | null) => {
    const url = topicId ? `/f/${slug}/t/${topicId}` : `/f/${slug}`;
    if (window.location.pathname !== url) window.history.pushState(null, "", url);
  }, [slug]);

  const hydrate = useCallback(async (topicId: string) => {
    try {
      const r = await fetch(
        `/rooms/${encodeURIComponent(boardId)}/messages/${encodeURIComponent(topicId)}/thread`,
        { credentials: "include" },
      );
      if (!r.ok) return;
      const j = (await r.json()) as { topic: ChatMessage; replies: ChatMessage[] };
      setMessages((cur) => {
        const fresh = new Map<string, ChatMessage>();
        for (const m of [j.topic, ...j.replies]) fresh.set(m.id, m);
        return [...cur.filter((m) => !fresh.has(m.id)), ...fresh.values()].sort((a, b) => a.createdAt - b.createdAt);
      });
    } catch { /* gone */ }
  }, [boardId]);

  // Permalink entry: resolve the topic's board, open it, flash the post.
  useEffect(() => {
    if (!initialTopicId) return;
    let alive = true;
    locateForumTopic(initialTopicId)
      .then((loc) => {
        if (!alive || loc.forumId !== detail.id) return;
        setBoardId(loc.boardRoomId);
        setActiveTopicId(loc.topicId);
        void hydrate(loc.topicId).then(() => {
          if (!alive || !initialPostId) return;
          requestAnimationFrame(() => requestAnimationFrame(() => setHighlightId(initialPostId)));
        });
      })
      .catch(() => { /* not found / not public: stay on the front page */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTopicId, initialPostId, detail.id]);

  // Quote-reference chips ([wrote:](msg:<id>)) work for guests too:
  // jump within the loaded thread when the quoted post is present.
  useEffect(() => {
    const onRef = (ev: Event) => {
      const messageId = (ev as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if (!messageId) return;
      const row = messages.find((m) => m.id === messageId);
      if (!row) return;
      const topicId = row.replyToId ?? row.id;
      setActiveTopicId(topicId);
      reflectUrl(topicId);
      requestAnimationFrame(() => requestAnimationFrame(() => setHighlightId(messageId)));
    };
    window.addEventListener("spire:quote-ref", onRef);
    return () => window.removeEventListener("spire:quote-ref", onRef);
  }, [messages]);

  if (detail.boards.length === 0) {
    return <p className="px-3 text-sm italic text-keep-muted">{t("landing.noBoards")}</p>;
  }
  const active = detail.boards.find((b) => b.roomId === boardId) ?? detail.boards[0]!;

  return (
    <div className="flex h-[78vh] min-h-[30rem] flex-col overflow-hidden rounded border border-keep-rule bg-keep-bg/60">
      {detail.boards.length > 1 ? (
        <div className="flex flex-wrap gap-1 border-b border-keep-rule bg-keep-banner/20 px-3 py-1.5">
          {detail.boards.map((b) => (
            <button
              key={b.roomId}
              type="button"
              onClick={() => setBoardId(b.roomId)}
              title={b.locked ? t("shared.boardMembersOnlyTitle", { name: b.name }) : b.name}
              className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs ${
                b.roomId === active.roomId
                  ? "border-keep-action text-keep-action"
                  : "border-keep-rule text-keep-muted hover:text-keep-text"
              }`}
            >
              {b.locked ? <Lock className="h-3 w-3 shrink-0" aria-label={t("shared.membersOnly")} /> : null}
              {b.name}
              <span className="ml-0.5 text-[10px] text-keep-rule">{b.topicCount}</span>
            </button>
          ))}
        </div>
      ) : null}
      {active.locked ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          <div aria-hidden className="flex h-14 w-14 items-center justify-center rounded-full border border-keep-accent/40 bg-keep-accent/10">
            <Lock className="h-6 w-6 text-keep-accent" aria-hidden="true" />
          </div>
          <p className="text-sm font-semibold text-keep-text">{t("landing.lockedBoardTitle")}</p>
          <p className="max-w-sm text-xs text-keep-muted">
            {t("landing.lockedBoardHint")}
          </p>
          <button
            type="button"
            onClick={onRequireLogin}
            className="inline-flex items-center gap-1.5 rounded border border-keep-action bg-keep-action/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
          >
            <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
            {t("landing.signIn")}
          </button>
        </div>
      ) : (
      <MessageList
        messages={messages}
        occupants={[]}
        selfUserId={null}
        selfNames={[]}
        roomType="public"
        replyMode="nested"
        roomId={active.roomId}
        threadCategories={cats ?? []}
        activeTopicId={activeTopicId}
        onSetActiveTopic={(id) => {
          setActiveTopicId(id);
          if (id) void hydrate(id);
          reflectUrl(id);
        }}
        forumBuckets={buckets}
        onGoToForumPage={(key, page) => void loadPage(key, page)}
        onFlushPendingTopics={NOOP}
        onActivateCategory={NOOP}
        onStartTopicInCategory={onRequireLogin}
        onIconClick={onRequireLogin}
        onNameClick={onRequireLogin}
        onMentionClick={NOOP}
        onWorldClick={NOOP}
        onTimeClick={NOOP}
        fontStep={1}
        readOnly
        highlightMessageId={highlightId}
        onHighlightDone={() => setHighlightId(null)}
      />
      )}
    </div>
  );
}

export function ForumPublicLanding({ slug, initialTopicId = null, initialPostId = null, onNavigate }: {
  slug: string;
  /** Topic permalink (/f/<slug>/t/<topicId>): open the reader on it. */
  initialTopicId?: string | null;
  /** #p-<postId> hash: flash that post once the thread renders. */
  initialPostId?: string | null;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation("forums");
  const branding = useChat((s) => s.branding);
  const siteName = branding.siteName || t("common:appName");
  const [detail, setDetail] = useState<ForumDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchForumDetail(slug)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : t("shared.loadFailed")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const forumTheme = useMemo(() => {
    if (!detail?.themeJson) return null;
    try { return normalizeTheme(JSON.parse(detail.themeJson)); } catch { return null; }
  }, [detail?.themeJson]);
  // Forum's design style (glass, medieval, …) applied at the ROOT while
  // this page is up (designs can't be subtree-scoped — their CSS keys
  // off html[data-theme-style]). Falls back to the site-default design
  // key when the forum hasn't picked one: anonymous visitors have no
  // personal design, so the page still gets the full treatment.
  const activeTheme = useActiveTheme();
  useScopedRootDesign(
    forumTheme ?? activeTheme,
    detail ? detail.themeStyleKey ?? DEFAULT_STYLE_KEY : null,
    !!detail,
    activeTheme,
  );

  const descriptionHtml = useMemo(
    () => (detail?.descriptionHtml ? sanitizeUserHtml(detail.descriptionHtml) : null),
    [detail?.descriptionHtml],
  );

  // Sample the banner's average color for legible hero ink. MUST run on
  // every render (before the err/!detail early returns below) or the hook
  // order changes the moment the forum finishes loading — Rules of Hooks.
  const bannerColor = useImageAverageColor(detail?.bannerImageUrl ?? null);

  function go(path: "/login" | "/register") {
    returnForum.write(slug, detail?.name ?? null);
    onNavigate(path);
  }

  if (err) {
    return (
      <div className="relative z-10 mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-3 px-4 text-center">
        <Landmark className="h-8 w-8 text-keep-muted" aria-hidden="true" />
        <p className="text-sm text-keep-text">{err}</p>
        <a href="/" className="text-xs uppercase tracking-widest text-keep-action hover:underline">
          {t("landing.toSite", { siteName })}
        </a>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="relative z-10 flex min-h-screen items-center justify-center">
        <p className="text-sm italic text-keep-muted">{t("landing.opening")}</p>
      </div>
    );
  }

  const gateCopy = detail.postingMode === "application"
    ? t("landing.gateApplication", { siteName })
    : t("landing.gateOpen", { siteName });

  const stats = detail.stats;
  const onlineTotal = stats ? stats.online.publicNames.length + stats.online.hiddenCount : 0;
  // Hero ink follows the surface (site-wide pattern): with no banner the
  // forum's palette luminance decides via inkClass. Over a banner IMAGE,
  // shown AS-IS (no scrim overlay), we SAMPLE its average color and lift
  // the forum's OWN palette ink to legibility against it (legibleAgainstBg
  // preserves hue) + a tight text-shadow. Applied INLINE so it beats the
  // design's `[data-theme-style] h1 { color: rgb(var(--keep-text)) }` rule,
  // the cause of the dark-on-dark title. CORS-tainted sample → white.
  const hasBanner = !!detail.bannerImageUrl;
  const heroPalette = forumTheme ?? activeTheme;
  const heroDark = isDarkSurface(heroPalette, { imageOverlay: hasBanner });
  const bannerInk = hasBanner ? forumBannerInk(heroPalette, bannerColor) : null;

  return (
    // Sizing contract (per user): FULLSCREEN on mobile (edge-to-edge, no
    // gutters), and on desktop ~82vw with a 1280px floor — clamped to
    // the viewport so a 1280-wide screen never scrolls sideways.
    <div className="relative z-10 mx-auto min-h-screen w-full px-0 py-0 md:px-6 md:py-8 lg:w-[min(100%,max(82vw,80rem))]">
      <article
        // text-keep-text re-anchors inherited text to the forum's scoped
        // palette (the splash shell's color is computed from the SPLASH
        // theme and would wash white over a light forum).
        className="keep-frame overflow-hidden border-y border-keep-rule bg-keep-bg text-keep-text shadow-2xl md:rounded-lg md:border"
        style={forumTheme ? themeStyle(forumTheme) : undefined}
      >
        {/* HERO — the forum's marquee. Banner image (or banner tint)
            behind a big identity block; this is the first impression a
            share link makes, so it gets real presence on desktop. */}
        <header
          className="relative border-b border-keep-rule bg-keep-banner/40 px-5 py-8 md:px-10 md:py-14"
          style={detail.bannerImageUrl ? {
            backgroundImage: `url(${detail.bannerImageUrl})`,
            backgroundSize: "cover",
            backgroundPosition: `center ${detail.bannerFocusY ?? 50}%`,
          } : undefined}
        >
          <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:gap-6">
            {detail.logoUrl ? (
              <img src={detail.logoUrl} alt="" className="h-16 w-16 shrink-0 object-contain drop-shadow-lg md:h-24 md:w-24" />
            ) : (
              <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded border border-keep-rule bg-keep-bg/60 shadow-lg md:h-24 md:w-24">
                <MessagesSquare className="h-8 w-8 text-keep-accent md:h-12 md:w-12" aria-hidden="true" />
              </span>
            )}
            <div className="min-w-0">
              {/* Ink follows the surface: over a banner IMAGE we sample it
                  and force light ink inline (beats the design heading rule);
                  with no banner the palette luminance decides via inkClass. */}
              <h1
                className={`break-words font-action text-3xl md:text-5xl ${bannerInk ? "" : inkClass.title(heroDark)}`}
                style={bannerInk?.title}
              >{detail.name}</h1>
              {detail.tagline ? (
                <p
                  className={`mt-1 text-sm md:text-lg ${bannerInk ? "" : inkClass.sub(heroDark)}`}
                  style={bannerInk?.sub}
                >{detail.tagline}</p>
              ) : null}
              <p
                className={`mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] md:text-xs ${bannerInk ? "" : inkClass.meta(heroDark)}`}
                style={bannerInk?.meta}
              >
                <span><Trans t={t} i18nKey="shared.keptBy" values={{ name: detail.ownerUsername }} components={{ v: <span className={bannerInk ? "" : inkClass.strong(heroDark)} style={bannerInk?.strong} /> }} /></span>
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3 w-3" aria-hidden="true" />
                  {detail.memberCount > 0 ? t("shared.memberCount", { count: detail.memberCount }) : t("shared.openToAll")}
                </span>
                {detail.lastActivityAt ? <span>{t("landing.activeAgo", { time: relTime(detail.lastActivityAt) })}</span> : null}
                <span>{t("shared.foundedDate", { date: formatDate(detail.createdAt, { year: "numeric", month: "long", day: "numeric" }) })}</span>
              </p>
            </div>
          </div>
        </header>

        {/* CALL TO ACTION — the entrance, loud and clear. */}
        <div className="border-b border-keep-rule bg-keep-action/10 px-5 py-5 md:px-10">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="font-action text-lg text-keep-text md:text-xl">
                {detail.postingMode === "application" ? t("landing.applyHeadline") : t("landing.joinHeadline")}
              </p>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-keep-muted md:text-sm">{gateCopy}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => go("/register")}
                className="flex items-center gap-2 rounded border border-keep-action bg-keep-action px-5 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-bg shadow-lg transition-transform hover:scale-[1.03]"
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                {detail.postingMode === "application" ? t("landing.registerToApply") : t("landing.createAccount")}
              </button>
              <button
                type="button"
                onClick={() => go("/login")}
                className="flex items-center gap-2 rounded border border-keep-action bg-keep-action/15 px-4 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/25"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                {t("landing.logIn")}
              </button>
            </div>
          </div>
        </div>

        {/* BODY — full-width boards (the footer below carries the
            statistics, classic phpBB/vBulletin layout). */}
        <div>
          <div className="min-w-0">
            {descriptionHtml ? (
              <div
                className={`border-b border-keep-rule px-5 py-5 text-sm leading-relaxed md:px-8 ${USER_HTML_SCOPE_CLASS}`}
                dangerouslySetInnerHTML={{ __html: descriptionHtml }}
              />
            ) : null}

            {/* Upcoming community events linked to this forum (read-only;
                RSVP lives inside the community). Renders nothing when there
                are none, so event-less landings are unchanged. */}
            <UpcomingEventsStrip slug={slug} />

            {detail.publicBrowsing ? (
              /* PUBLIC BROWSING: the real forum renderer, read-only.
                 Anonymous visitors browse boards, topics, and replies;
                 every write affordance routes through the login CTA. */
              <section className="px-2 py-4 md:px-4">
                <PublicBoardReader
                  detail={detail}
                  slug={slug}
                  initialTopicId={initialTopicId}
                  initialPostId={initialPostId}
                  onRequireLogin={() => go("/login")}
                />
                <p className="mt-3 px-3 text-[11px] italic text-keep-muted">
                  <Trans
                    t={t}
                    i18nKey={detail.postingMode === "application" ? "landing.guestStripApplication" : "landing.guestStripOpen"}
                    components={{
                      login: <button type="button" onClick={() => go("/login")} className="text-keep-action underline hover:text-keep-action/80" />,
                      register: <button type="button" onClick={() => go("/register")} className="text-keep-action underline hover:text-keep-action/80" />,
                    }}
                  />
                </p>
              </section>
            ) : (
              /* Boards index (teaser). Reading needs an account, which
                 keeps the landing light AND gives registration a reason. */
              <section className="px-5 py-5 md:px-8">
                <h2 className="mb-3 text-xs uppercase tracking-widest text-keep-muted">{t("landing.boardsHeading")}</h2>
                {detail.boards.length === 0 ? (
                  <p className="text-sm italic text-keep-muted">{t("landing.noBoards")}</p>
                ) : (
                  <ul className="space-y-2">
                    {detail.boards.map((b) => (
                      <li
                        key={b.roomId}
                        className="flex items-center justify-between gap-3 rounded border border-keep-rule bg-keep-panel/30 px-4 py-3"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-base font-semibold text-keep-text">{b.name}</span>
                          {b.topic ? <span className="block truncate text-xs text-keep-muted">{b.topic}</span> : null}
                        </span>
                        <span className="shrink-0 text-right text-[11px] tabular-nums text-keep-muted">
                          <span className="flex items-center justify-end gap-1">
                            <Lock className="h-3 w-3" aria-hidden="true" />
                            {t("landing.topicCount", { count: b.topicCount })}
                          </span>
                          {b.lastActivityAt ? <span className="block">{t("landing.activeAgo", { time: relTime(b.lastActivityAt) })}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-4 text-[11px] italic text-keep-muted">
                  {detail.postingMode === "application" ? t("landing.teaserApplication") : t("landing.teaserOpen")}
                </p>
              </section>
            )}
          </div>

        </div>

        {/* FOOTER — the traditional forum footer (phpBB / vBulletin
            style): who's online, then board statistics, then the
            forum's vitals + host line. */}
        <footer className="border-t border-keep-rule bg-keep-banner/30 px-5 py-3 text-[11px] text-keep-muted md:px-8">
          <div className="border-b border-keep-rule/50 pb-2">
            <h2 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {t("footer.whosOnline")}
            </h2>
            {!stats || onlineTotal === 0 ? (
              <p className="italic">{t("footer.quietSpark")}</p>
            ) : (
              <p>
                {stats.online.publicNames.length > 0 ? (
                  <span className="text-keep-text">{stats.online.publicNames.join(", ")}</span>
                ) : null}
                {stats.online.hiddenCount > 0
                  ? t(stats.online.publicNames.length > 0 ? "footer.hiddenAfterNames" : "footer.hidden", { count: stats.online.hiddenCount })
                  : ""}
                {stats.online.browsingRecently > 0
                  ? t("footer.browsing", { count: stats.online.browsingRecently })
                  : ""}
              </p>
            )}
          </div>
          {stats ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-b border-keep-rule/50 py-2">
              <span className="font-semibold uppercase tracking-widest">{t("footer.boardStatistics")}</span>
              <span><Trans t={t} i18nKey="footer.statTopics" values={{ value: formatNumber(stats.topics) }} components={{ n: <b className="tabular-nums text-keep-text" /> }} /></span>
              <span><Trans t={t} i18nKey="footer.statReplies" values={{ value: formatNumber(stats.replies) }} components={{ n: <b className="tabular-nums text-keep-text" /> }} /></span>
              <span><Trans t={t} i18nKey="footer.statWriters" values={{ value: formatNumber(stats.writers) }} components={{ n: <b className="tabular-nums text-keep-text" /> }} /></span>
              <span>
                <Trans
                  t={t}
                  i18nKey={detail.memberCount > 0 ? "footer.statMembers" : "footer.statOpenToAll"}
                  values={{ value: detail.memberCount > 0 ? formatNumber(detail.memberCount) : "-" }}
                  components={{ n: <b className="tabular-nums text-keep-text" /> }}
                />
              </span>
              <span><Trans t={t} i18nKey="footer.statOnline" values={{ value: formatNumber(onlineTotal) }} components={{ n: <b className="tabular-nums text-keep-text" /> }} /></span>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 pt-2">
            <span>{t("footer.posting")} <span className="text-keep-text">{detail.postingMode === "application" ? t("footer.byApplication") : t("shared.openToAll")}</span></span>
            <span>{t("footer.keeperLabel")} <span className="text-keep-text">{detail.ownerUsername}</span></span>
            {detail.linkedWorld ? (
              <span>{t("footer.worldLabel")} <span className="text-keep-text">{detail.linkedWorld.name}</span></span>
            ) : null}
            <span>{t("footer.foundedLabel")} <span className="text-keep-text">{formatDate(detail.createdAt)}</span></span>
            <span className="ml-auto"><Trans t={t} i18nKey="footer.hostedBy" values={{ siteName }} components={{ v: <span className="text-keep-text" /> }} /></span>
          </div>
        </footer>
      </article>
    </div>
  );
}
