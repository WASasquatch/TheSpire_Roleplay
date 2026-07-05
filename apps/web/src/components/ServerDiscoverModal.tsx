/**
 * Server Discover (Multi-Server Lift).
 *
 * The surface behind the server rail's bottom "+" (and `onDiscover`): a
 * browsable catalog of the chat servers a viewer can join, plus — for members
 * who hold the global `apply_create_server` permission — the "create your own
 * server" application form. It is the server-level analog of the Forums
 * catalog's discover + CreateForum flow (ForumsCatalogModal), trimmed because a
 * server is entered by switching the chat shell into its rooms (the rail's
 * onSelect path) rather than hosting content inline.
 *
 * Two sections: YOUR SERVERS (the ones the viewer already belongs to, for quick
 * switching) and DISCOVER (public servers they haven't joined). Each discover
 * card's primary action adapts to the server's join mode — instant Join for
 * open servers, an inline invite-code box for invite servers, an inline apply
 * form for application servers. Unlisted / invite-only servers never appear in
 * Discover (they're reached by direct link or invite), matching their
 * visibility contract.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import {
  ArrowRight,
  Clock,
  Compass,
  Crown,
  Flame,
  Globe,
  HelpCircle,
  Landmark,
  Mail,
  Plus,
  RotateCcw,
  ScrollText,
  Search,
  Sparkles,
  Star,
  User,
  X,
} from "lucide-react";
import {
  SERVER_NAME_MAX,
  SERVER_NAME_MIN,
  SERVER_PURPOSE_MAX,
  SERVER_PURPOSE_MIN,
} from "@thekeep/shared";
import {
  applyForServer,
  applyToJoinServer,
  checkServerSlug,
  clearServerDefault,
  fetchMyServerApplicationStatus,
  fetchMyServerApplications,
  fetchServerDiscover,
  fetchServerRegistrationRules,
  fetchServerTags,
  joinServer,
  listServers,
  searchServers,
  setServerDefault,
  type ServerApplicationStatus,
  type ServerCreationApplicationWire,
  type ServerDiscover,
  type ServerSlugCheck,
  type ServerSummary,
  type ServerTagCount,
} from "../lib/servers.js";
import { Modal } from "./Modal.js";
import { useChat } from "../state/store.js";
import { CloseButton } from "./CloseButton.js";
import { ContextualTour } from "./ContextualTour.js";
import { cropStyleFor } from "../lib/avatarCrop.js";
import { isDarkSurface, useActiveTheme } from "../lib/theme.js";
import { getSocket } from "../lib/socket.js";

/** A server is "mine" (top group) when the viewer holds any role OR it's the
 *  implicit-membership system/home server. Mirrors ServerRail.isMine. */
function isMine(s: ServerSummary): boolean {
  return s.viewerRole != null || s.isSystem;
}

interface Props {
  /** Shows the "Create your server" affordance + lands on it when
   *  {@link initialCreate} is set. Global `apply_create_server`. */
  canApply: boolean;
  /** Open straight onto the create-a-server form (the rail "+" for an
   *  apply-eligible viewer). Ignored when {@link canApply} is false. */
  initialCreate?: boolean;
  /** Enter a server: resolves its landing room and joins it through the rail's
   *  existing onSelect path. The modal closes after a successful entry. */
  onSelect: (server: ServerSummary) => void;
  onClose: () => void;
}

export function ServerDiscoverModal({ canApply, initialCreate, onSelect, onClose }: Props) {
  const [list, setList] = useState<ServerSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(!!initialCreate && canApply);
  // The viewer's own create-a-server application status (pending / most-recent
  // rejection), surfaced as a banner near the top so it's visible without
  // opening the form. `undefined` while loading, `null` when nothing's in
  // flight. Only fetched for apply-eligible viewers.
  const [appStatus, setAppStatus] = useState<ServerApplicationStatus | null | undefined>(
    canApply ? undefined : null,
  );

  const refresh = useCallback(() => {
    listServers()
      .then((l) => { setList(l); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : "Couldn't load servers."));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Keep the CTA banner honest: load on open and after the form submits/closes.
  const refreshAppStatus = useCallback(() => {
    if (!canApply) return;
    fetchMyServerApplicationStatus()
      .then(setAppStatus)
      .catch(() => setAppStatus(null));
  }, [canApply]);
  useEffect(() => { refreshAppStatus(); }, [refreshAppStatus]);

  const mine = useMemo(() => (list ?? []).filter(isMine), [list]);
  // The set of server ids the viewer already belongs to — used to keep the
  // discover/search lists honest (a server can surface in Popular/New right
  // after the viewer joins it, before the catalog refetches).
  const mineIds = useMemo(() => new Set(mine.map((s) => s.id)), [mine]);

  function enter(server: ServerSummary) {
    onSelect(server);
    onClose();
  }

  return (
    <Modal onClose={onClose} variant="mobile-fullscreen">
      {/* Sized like the app's other content modals: edge-to-edge on phones,
          a large centred card on desktop (was a cramped max-w-2xl box). */}
      <div
        className="keep-frame flex h-full w-full flex-col overflow-hidden rounded border border-keep-rule bg-keep-bg lg:h-[88vh] lg:w-[80vw] lg:max-w-[1100px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner/30 px-4 py-2.5">
          <h3 className="flex items-center gap-2 font-action text-lg text-keep-text">
            <Compass className="h-5 w-5 text-keep-accent" aria-hidden="true" />
            Discover servers
          </h3>
          <CloseButton onClick={onClose} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {err ? (
            <p className="rounded border border-keep-rule bg-keep-panel/40 px-3 py-2 text-sm text-keep-accent">{err}</p>
          ) : !list ? (
            <p className="py-6 text-center text-sm italic text-keep-muted">Gathering the servers…</p>
          ) : (
            <div className="space-y-5">
              {/* Prominent create-a-server call-to-action / application status.
                  Sits at the top so the "raise your own server" path is the
                  first thing an eligible viewer sees, and so a pending review
                  is unmissable. */}
              {canApply ? (
                <CreateServerCta
                  status={appStatus}
                  onCreate={() => setCreateOpen(true)}
                />
              ) : null}

              {mine.length > 0 ? (
                <section>
                  <SectionLabel icon={<Star className="h-3.5 w-3.5" aria-hidden="true" />} text="Your servers" count={mine.length} />
                  <ul className="space-y-2">
                    {mine.map((s) => (
                      <ServerCard key={s.id} server={s} onEnter={() => enter(s)} onJoined={refresh} />
                    ))}
                  </ul>
                </section>
              ) : null}

              <DiscoverBrowse
                mineIds={mineIds}
                canApply={canApply}
                onEnter={enter}
                onJoined={refresh}
              />
            </div>
          )}
        </div>

      </div>

      {createOpen ? (
        <CreateServerForm
          onClose={() => { setCreateOpen(false); refreshAppStatus(); }}
        />
      ) : null}

      {/* First-run walkthrough of the create-a-server form. Mounted always;
          fires only while the form is actually up (and unseen), and is
          replayable from the form's "?" button. */}
      <ContextualTour tourId="server-create" active={createOpen} />
    </Modal>
  );
}

/**
 * The search-aware browse area beneath "Your servers". Two modes:
 *   - DEFAULT (empty query AND no active tag): two side-by-side columns,
 *     "Popular" and "New", from GET /servers/discover.
 *   - SEARCH (query non-empty OR a tag active): a single "Results" list from
 *     GET /servers/discover/search, with a count, an empty state, and a clear
 *     affordance back to browse.
 * A search bar and a tag-chip row sit at the top of both modes. Servers the
 * viewer already belongs to are filtered out so the lists stay "discover only".
 * Mirrors the forum discover UX so the two surfaces match.
 */
function DiscoverBrowse({ mineIds, canApply, onEnter, onJoined }: {
  mineIds: Set<string>;
  canApply: boolean;
  onEnter: (server: ServerSummary) => void;
  onJoined: () => void;
}) {
  const [discover, setDiscover] = useState<ServerDiscover | null>(null);
  const [tags, setTags] = useState<ServerTagCount[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [results, setResults] = useState<ServerSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  // The curated lists + the tag cloud load once on open. Both degrade to empty
  // on failure (helpers swallow transport errors), so the area never wedges.
  useEffect(() => {
    let alive = true;
    fetchServerDiscover().then((d) => { if (alive) setDiscover(d); }).catch(() => { if (alive) setDiscover({ popular: [], new: [] }); });
    fetchServerTags().then((t) => { if (alive) setTags(t); }).catch(() => { if (alive) setTags([]); });
    return () => { alive = false; };
  }, []);

  // Debounce the free-text query (~250ms) into `debouncedQuery`; the tag filter
  // applies immediately (it's a discrete click, nothing to debounce).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const searchMode = debouncedQuery.length > 0 || activeTag !== null;

  // Run the search whenever the debounced query or active tag changes (in search
  // mode only). A stale-guard ignores out-of-order responses.
  useEffect(() => {
    if (!searchMode) { setResults(null); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    searchServers(debouncedQuery, activeTag)
      .then((items) => { if (alive) { setResults(items); setSearching(false); } })
      .catch(() => { if (alive) { setResults([]); setSearching(false); } });
    return () => { alive = false; };
  }, [searchMode, debouncedQuery, activeTag]);

  // Never surface a server the viewer already belongs to in a discover list.
  const notMine = useCallback((rows: ServerSummary[]) => rows.filter((s) => !mineIds.has(s.id)), [mineIds]);
  const popular = useMemo(() => notMine(discover?.popular ?? []), [discover, notMine]);
  const fresh = useMemo(() => notMine(discover?.new ?? []), [discover, notMine]);
  const resultRows = useMemo(() => (results ? notMine(results) : null), [results, notMine]);

  function clearSearch() {
    setQuery("");
    setDebouncedQuery("");
    setActiveTag(null);
  }

  // Top ~12 tags by count power the chip row.
  const topTags = tags.slice(0, 12);

  return (
    <section className="space-y-3">
      <SectionLabel icon={<Globe className="h-3.5 w-3.5" aria-hidden="true" />} text="Discover" count={searchMode ? (resultRows?.length ?? 0) : popular.length + fresh.length} />

      {/* Search bar */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-keep-muted" aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or tag…"
          aria-label="Search servers by name or tag"
          className="w-full rounded border border-keep-rule bg-keep-bg py-2 pl-8 pr-8 text-sm outline-none focus:border-keep-action"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search text"
            title="Clear"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-keep-muted hover:text-keep-text"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* Tag chips */}
      {topTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {topTags.map((t) => {
            const on = activeTag === t.tag;
            return (
              <button
                key={t.tag}
                type="button"
                onClick={() => setActiveTag(on ? null : t.tag)}
                aria-pressed={on}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  on
                    ? "border-keep-action bg-keep-action/15 text-keep-action"
                    : "border-keep-rule text-keep-muted hover:border-keep-action hover:text-keep-action"
                }`}
              >
                {t.tag}
                {on ? <X className="h-3 w-3" aria-hidden="true" /> : <span className="text-keep-rule">{t.count}</span>}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Active-tag pill + clear/back affordance (search mode only) */}
      {searchMode ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-keep-muted">
          {activeTag ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-keep-action bg-keep-action/10 px-2 py-0.5 text-keep-action">
              Tag: {activeTag}
              <button type="button" onClick={() => setActiveTag(null)} aria-label={`Remove ${activeTag} filter`} title="Remove tag filter"
                className="hover:text-keep-text">
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ) : null}
          <button
            type="button"
            onClick={clearSearch}
            className="inline-flex items-center gap-1 rounded border border-keep-rule px-2 py-0.5 uppercase tracking-widest text-keep-muted hover:border-keep-action hover:text-keep-action"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Back to browse
          </button>
        </div>
      ) : null}

      {/* Body: Results (search) OR Popular/New columns (default). */}
      {searchMode ? (
        <div className="space-y-2">
          {!resultRows || searching ? (
            <p className="py-4 text-center text-sm italic text-keep-muted">Searching…</p>
          ) : resultRows.length === 0 ? (
            <p className="rounded border border-dashed border-keep-rule px-3 py-4 text-center text-sm italic text-keep-muted">
              No servers match your search.
            </p>
          ) : (
            <>
              <p className="text-[11px] text-keep-muted">{resultRows.length} {resultRows.length === 1 ? "result" : "results"}</p>
              <ul className="space-y-2">
                {resultRows.map((s) => (
                  <ServerCard key={s.id} server={s} onEnter={() => onEnter(s)} onJoined={onJoined} />
                ))}
              </ul>
            </>
          )}
        </div>
      ) : !discover ? (
        <p className="py-4 text-center text-sm italic text-keep-muted">Gathering the catalog…</p>
      ) : popular.length === 0 && fresh.length === 0 ? (
        <p className="rounded border border-dashed border-keep-rule px-3 py-4 text-center text-sm italic text-keep-muted">
          No other servers to explore yet.
          {canApply ? " Be the first to raise one." : ""}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <DiscoverColumn
            icon={<Flame className="h-3.5 w-3.5" aria-hidden="true" />}
            label="Popular"
            rows={popular}
            emptyText="No popular servers yet."
            onEnter={onEnter}
            onJoined={onJoined}
          />
          <DiscoverColumn
            icon={<Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
            label="New"
            rows={fresh}
            emptyText="No new servers yet."
            onEnter={onEnter}
            onJoined={onJoined}
          />
        </div>
      )}
    </section>
  );
}

/** One labelled column (Popular / New) in the default browse grid. */
function DiscoverColumn({ icon, label, rows, emptyText, onEnter, onJoined }: {
  icon: ReactNode;
  label: string;
  rows: ServerSummary[];
  emptyText: string;
  onEnter: (server: ServerSummary) => void;
  onJoined: () => void;
}) {
  return (
    <div>
      <SectionLabel icon={icon} text={label} count={rows.length} />
      {rows.length === 0 ? (
        <p className="rounded border border-dashed border-keep-rule px-3 py-3 text-center text-xs italic text-keep-muted">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => (
            <ServerCard key={s.id} server={s} onEnter={() => onEnter(s)} onJoined={onJoined} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The create-a-server call-to-action that opens the discover modal's body.
 * Three states, driven by the viewer's application status:
 *   - PENDING — a status panel ("…is pending review"); the create button is
 *     suppressed entirely (the backend allows one application at a time).
 *   - REJECTED (most recent, nothing pending) — the reviewer's note plus a
 *     "Try again" button that reopens the form.
 *   - clear (or still loading) — a prominent banner inviting them to raise a
 *     server. We render the banner optimistically while status loads so the
 *     primary path never flickers in as an afterthought.
 */
function CreateServerCta({
  status,
  onCreate,
}: {
  status: ServerApplicationStatus | null | undefined;
  onCreate: () => void;
}) {
  const pending = status?.pending ?? null;
  const rejected = status?.rejected ?? null;

  if (pending) {
    return (
      <section className="rounded border border-keep-action/40 bg-keep-action/5 p-3.5">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-keep-action">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Application under review
        </div>
        <p className="mt-1.5 text-sm text-keep-text">
          Your server <strong>{pending.requestedName}</strong>
          <span className="text-keep-muted"> (/s/{pending.requestedSlug})</span> is awaiting a moderator's decision.
        </p>
        <p className="mt-1 text-xs text-keep-muted">
          We'll notify you here and in chat once it's reviewed. You can raise another server after this one is decided.
        </p>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded border border-keep-action/50 bg-gradient-to-br from-keep-action/15 to-keep-action/5">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-keep-action/50 bg-keep-action/10 text-keep-action">
            <Crown className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h4 className="flex items-center gap-1.5 font-action text-base text-keep-text">
              <Sparkles className="h-4 w-4 text-keep-action" aria-hidden="true" />
              Raise your own server
            </h4>
            <p className="mt-0.5 text-xs text-keep-muted">
              Gather your own community with its own rooms, address, and economy. Submit a short application and our moderators take it from there.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="group flex shrink-0 items-center justify-center gap-1.5 self-start rounded border border-keep-action bg-keep-action px-4 py-2 text-xs font-semibold uppercase tracking-widest text-keep-bg transition-colors hover:bg-keep-action/90 sm:self-auto"
        >
          {rejected ? <RotateCcw className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
          {rejected ? "Try again" : "Create your server"}
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </button>
      </div>
      {rejected?.reviewNote ? (
        <p className="border-t border-keep-action/30 bg-keep-bg/40 px-4 py-2 text-xs text-keep-muted">
          Your last application for <strong className="text-keep-text">{rejected.requestedName}</strong> wasn't approved: "{rejected.reviewNote}". You're welcome to revise it and apply again.
        </p>
      ) : null}
    </section>
  );
}

function SectionLabel({ icon, text, count }: { icon: ReactNode; text: string; count: number }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">
      {icon}
      <span>{text}</span>
      <span className="text-keep-rule">({count})</span>
    </div>
  );
}

/** One catalog row: identity (logo/letter + name + tagline + join-mode badge)
 *  and a primary action that adapts to the viewer's relationship and the
 *  server's join mode. Invite/apply expand inline rather than navigating. */
function ServerCard({ server, onEnter, onJoined }: {
  server: ServerSummary;
  onEnter: () => void;
  /** Refetch the catalog after a join/apply so this card's state is honest. */
  onJoined: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Inline expand for invite-code entry / application prose.
  const [expand, setExpand] = useState<null | "invite" | "apply">(null);
  const [code, setCode] = useState("");
  const [answer, setAnswer] = useState("");
  const [applied, setApplied] = useState(false);

  const member = server.viewerRole != null || server.isSystem;
  // Global staff who hold `manage_any_server` can step into ANY server to
  // moderate without joining or an invite code — the SAME key the server's
  // authority check treats as owner-equivalent, so room entry already lets
  // them in (broadcast.ts canParticipate). We just surface the affordance.
  const isGlobalStaff = useChat((s) => (s.me?.permissions ?? []).includes("manage_any_server"));
  const setOpenProfile = useChat((s) => s.setOpenProfile);
  const letter = (server.name.trim()[0] ?? "?").toUpperCase();
  const tint = server.iconColor ?? undefined;

  // Banner-as-background: when the server has a header banner we paint it
  // behind the card content and lay a legibility scrim over it. The card's
  // own ink (keep-text/keep-muted) is theme-driven and won't reliably read on
  // arbitrary art, so the scrim is always DARK (and the ink is forced
  // light over it) — what shifts with the viewer's theme is its STRENGTH:
  // a light theme reads the scrim as a hard cut from its surroundings, so a
  // lighter scrim still keeps text readable while letting more art through;
  // a dark theme blends into the scrim, so we lean a touch darker to keep
  // the same separation. Either way the text column gets a stronger gradient
  // edge so the right-hand actions stay crisp.
  const viewerTheme = useActiveTheme();
  const hasBanner = !!server.bannerImageUrl;
  const viewerDark = isDarkSurface(viewerTheme);
  const scrimClass = viewerDark ? "bg-black/60" : "bg-black/45";

  async function openJoin() {
    setBusy(true); setErr(null);
    try {
      await joinServer(server.id);
      onJoined();
      onEnter();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't join.");
    } finally {
      setBusy(false);
    }
  }

  async function inviteJoin() {
    if (!code.trim()) return;
    setBusy(true); setErr(null);
    try {
      await joinServer(server.id, code.trim());
      onJoined();
      onEnter();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That invite didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function sendApplication() {
    setBusy(true); setErr(null);
    try {
      await applyToJoinServer(server.id, answer);
      setApplied(true);
      setExpand(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't send your application.");
    } finally {
      setBusy(false);
    }
  }

  // Toggle this server as the viewer's favorite/default — the server whose
  // per-server identity (rank, border, name style, collection) a global
  // profile view of the viewer renders. Set when off, clear when already on.
  async function toggleDefault() {
    setBusy(true); setErr(null);
    try {
      if (server.isMyDefault) await clearServerDefault(server.id);
      else await setServerDefault(server.id);
      onJoined();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't update your default server.");
    } finally {
      setBusy(false);
    }
  }

  // Open the server owner's profile so the viewer can read it and message them
  // (e.g. to ask for an invite to an invite-only/application server). Mirrors
  // the chat username-click path: an `@id:` token fetch, then the global
  // ProfileModal (App renders it off `openProfile`, with its Message / whisper
  // actions wired) stacks over this modal.
  function openOwner() {
    const ownerId = server.ownerUserId;
    if (!ownerId) return;
    getSocket().emit("profile:fetch", { username: `@id:${ownerId}` }, (res) => {
      if (res.ok) setOpenProfile(res.profile);
      else setErr(res.message ?? "Couldn't open that profile.");
    });
  }

  // Show the owner link on real (human-owned) servers only — never the
  // system/home server, and only once the owner name resolved.
  const owner = !server.isSystem && server.ownerUserId && server.ownerName
    ? { id: server.ownerUserId, name: server.ownerName }
    : null;

  return (
    <li
      className={`relative overflow-hidden rounded border border-keep-rule p-3 ${hasBanner ? "" : "bg-keep-panel/30"}`}
    >
      {/* Banner-as-background (behind the content) + legibility scrim. Cards
          without a banner keep the plain keep-panel/30 surface above. */}
      {hasBanner ? (
        <>
          <img
            src={server.bannerImageUrl!}
            className="absolute inset-0 h-full w-full object-cover"
            style={cropStyleFor(server.bannerCrop)}
            aria-hidden="true"
            draggable={false}
          />
          {/* Even dark scrim for overall legibility, plus a left-anchored
              gradient so the identity/text column reads firmly while the
              right-hand actions sit over lighter art. */}
          <div className={`absolute inset-0 ${scrimClass}`} aria-hidden="true" />
          <div
            className="absolute inset-0 bg-gradient-to-r from-black/55 via-black/25 to-transparent"
            aria-hidden="true"
          />
        </>
      ) : null}

      {/* Content layer — sits ABOVE the banner + scrim. Over the scrim the
          card's theme ink (keep-text/keep-muted) is forced light, with a
          soft drop-shadow, so it reads on any art; the keep-action / keep-rule
          accents on the buttons stay as-is (they read fine over a dark scrim). */}
      <div className={`relative ${hasBanner ? "text-white [text-shadow:0_1px_2px_rgba(0,0,0,.7)]" : ""}`}>
      <div className="flex items-center gap-3">
        {/* Logo or lettered fallback (matches the rail tile). */}
        {server.logoUrl ? (
          <img src={server.logoUrl} alt="" className="h-11 w-11 shrink-0 rounded-full object-cover" draggable={false} />
        ) : (
          <span
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-keep-rule text-base font-semibold uppercase ${hasBanner ? "" : "text-keep-text"}`}
            style={tint ? { backgroundColor: tint, color: "#fff" } : undefined}
          >
            {letter}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`truncate font-semibold ${hasBanner ? "" : "text-keep-text"}`}>{server.name}</span>
            {server.isSystem ? (
              <Landmark className="h-3.5 w-3.5 shrink-0 text-keep-accent" aria-label="Home server" />
            ) : server.status === "featured" ? (
              <Star className="h-3.5 w-3.5 shrink-0 text-keep-accent" aria-label="Featured" />
            ) : null}
          </div>
          {server.tagline ? (
            <p className={`truncate text-xs ${hasBanner ? "text-white/85" : "text-keep-muted"}`}>{server.tagline}</p>
          ) : null}
          {!member ? <JoinModeBadge mode={server.joinMode} onBanner={hasBanner} /> : null}
          {/* Owner link — opens the owner's profile (with its Message action)
              so a viewer can ask about joining a closed server. */}
          {owner ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openOwner(); }}
              title={`View ${owner.name}'s profile — message them to ask about joining`}
              aria-label={`View ${owner.name}'s profile`}
              className={`mt-1 flex max-w-full items-center gap-1 text-[11px] ${hasBanner ? "text-white/85 hover:text-white" : "text-keep-muted hover:text-keep-action"}`}
            >
              <User className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">
                by <span className="font-medium underline decoration-dotted underline-offset-2">{owner.name}</span>
              </span>
            </button>
          ) : null}
        </div>

        {/* Primary action — adapts to the viewer's relationship + join mode. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Global-staff bypass: enter to moderate without joining / a code.
              Shown alongside the normal join path so staff can still join
              properly if they want a chair here. */}
          {!member && isGlobalStaff ? (
            <button
              type="button"
              onClick={onEnter}
              title="Global staff: enter to moderate without joining"
              aria-label={`Enter ${server.name} as global staff`}
              className={`group flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-widest ${
                hasBanner
                  ? "border-white/50 text-white hover:bg-white/10"
                  : "border-keep-accent/60 bg-keep-accent/10 text-keep-accent hover:bg-keep-accent/20"
              }`}
            >
              <Crown className="h-3.5 w-3.5" aria-hidden="true" />
              Enter
            </button>
          ) : null}
          {member ? (
            <>
              {/* Favorite/default toggle — the server a global profile view of
                  you reflects (your rank, border, name style, collection). Only
                  on servers you belong to. */}
              <button
                type="button"
                onClick={() => void toggleDefault()}
                disabled={busy}
                aria-pressed={!!server.isMyDefault}
                title={server.isMyDefault ? "Your default server: your profile shows this server's identity. Click to clear." : "Set as my default: your profile will show this server's rank, border, and name style."}
                aria-label={server.isMyDefault ? `${server.name} is your default server, click to clear` : `Set ${server.name} as your default server`}
                className={`flex h-8 w-8 items-center justify-center rounded border transition-colors disabled:opacity-50 ${
                  server.isMyDefault
                    ? "border-keep-accent bg-keep-accent/15 text-keep-accent"
                    : hasBanner
                      ? "border-white/40 text-white hover:border-keep-accent hover:text-keep-accent"
                      : "border-keep-rule text-keep-muted hover:border-keep-accent hover:text-keep-accent"
                }`}
              >
                <Star className={`h-4 w-4 ${server.isMyDefault ? "fill-current" : ""}`} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={onEnter}
                className="group flex items-center gap-1.5 rounded border border-keep-action/60 bg-keep-action/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
              >
                Enter
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </button>
            </>
          ) : applied ? (
            <span className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-widest ${hasBanner ? "border-white/40 text-white/90" : "border-keep-rule text-keep-muted"}`}>
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              Applied
            </span>
          ) : server.joinMode === "open" ? (
            <button
              type="button"
              onClick={() => void openJoin()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
            >
              {busy ? "…" : "Join"}
            </button>
          ) : server.joinMode === "invite" ? (
            <button
              type="button"
              onClick={() => setExpand(expand === "invite" ? null : "invite")}
              aria-expanded={expand === "invite"}
              className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-widest hover:border-keep-action hover:text-keep-action ${expand === "invite" ? "border-keep-action text-keep-action" : hasBanner ? "border-white/40 text-white" : "border-keep-rule text-keep-text"}`}
            >
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
              Enter code
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setExpand(expand === "apply" ? null : "apply")}
              aria-expanded={expand === "apply"}
              className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold uppercase tracking-widest hover:border-keep-action hover:text-keep-action ${expand === "apply" ? "border-keep-action text-keep-action" : hasBanner ? "border-white/40 text-white" : "border-keep-rule text-keep-text"}`}
            >
              <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
              Apply
            </button>
          )}
        </div>
      </div>

      {/* Inline invite-code entry */}
      {expand === "invite" ? (
        <div className="mt-2.5 space-y-1.5 border-t border-keep-rule/60 pt-2.5">
          <p className={`text-xs ${hasBanner ? "text-white/85" : "text-keep-muted"}`}>This server is invite-only. Enter the code you were given to join and enter.</p>
          <div className="flex items-center gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Invite code"
              autoFocus
              className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 font-mono text-sm outline-none focus:border-keep-action"
              onKeyDown={(e) => { if (e.key === "Enter") void inviteJoin(); }}
            />
            <button
              type="button"
              onClick={() => void inviteJoin()}
              disabled={busy || !code.trim()}
              className="shrink-0 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
            >
              {busy ? "…" : "Join"}
            </button>
          </div>
        </div>
      ) : null}

      {/* Inline application prose */}
      {expand === "apply" ? (
        <div className="mt-2.5 space-y-2 border-t border-keep-rule/60 pt-2.5">
          <p className={`text-xs ${hasBanner ? "text-white/85" : "text-keep-muted"}`}>Joining is by application. The owner reviews each request before letting you in.</p>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            maxLength={500}
            rows={3}
            autoFocus
            placeholder="Tell this server's owner why you'd like to join (optional)."
            className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          />
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[11px] ${hasBanner ? "text-white/80" : "text-keep-muted"}`}>You'll get a notice once it's decided.</span>
            <button
              type="button"
              onClick={() => void sendApplication()}
              disabled={busy}
              className="shrink-0 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
            >
              {busy ? "…" : "Send application"}
            </button>
          </div>
        </div>
      ) : null}

      {err ? <p className="mt-2 text-xs text-keep-accent">{err}</p> : null}
      </div>
    </li>
  );
}

function JoinModeBadge({ mode, onBanner }: { mode: ServerSummary["joinMode"]; onBanner?: boolean }) {
  const meta = mode === "open"
    ? { icon: <Globe className="h-3 w-3" aria-hidden="true" />, text: "Open to all" }
    : mode === "invite"
      ? { icon: <Mail className="h-3 w-3" aria-hidden="true" />, text: "Invite only" }
      : { icon: <ScrollText className="h-3 w-3" aria-hidden="true" />, text: "By application" };
  return (
    <span
      className={`mt-1 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
        onBanner
          ? "border-white/30 bg-black/30 text-white/90"
          : "border-keep-rule bg-keep-bg/60 text-keep-muted"
      }`}
    >
      {meta.icon}
      {meta.text}
    </span>
  );
}

/**
 * "Create your server" application form. Stacks above the discover modal
 * (z 50, like CreateForumModal over the forums catalog). Three fields: display
 * name, address slug (auto-suggested from the name until hand-edited, with a
 * debounced live availability check), and the purpose prose the site's
 * reviewers read. A pending application replaces the form with its status; a
 * recent rejection shows the review note.
 */
function CreateServerForm({ onClose }: { onClose: () => void }) {
  const [mine, setMine] = useState<ServerCreationApplicationWire[] | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugCheck, setSlugCheck] = useState<ServerSlugCheck | null>(null);
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // Admin-authored registration rules (empty string ⇒ none set). `undefined`
  // while loading so the form doesn't flash a missing rules block. When rules
  // ARE set, the applicant must tick the agreement box before Submit enables.
  const [rulesHtml, setRulesHtml] = useState<string | undefined>(undefined);
  const [agreed, setAgreed] = useState(false);
  // Replays the create-a-server walkthrough while this form is open.
  const setForcedTourId = useChat((s) => s.setForcedTourId);

  useEffect(() => {
    let alive = true;
    fetchMyServerApplications()
      .then((a) => { if (alive) setMine(a); })
      .catch(() => { if (alive) setMine([]); });
    fetchServerRegistrationRules()
      .then((html) => { if (alive) setRulesHtml(html); })
      .catch(() => { if (alive) setRulesHtml(""); });
    return () => { alive = false; };
  }, []);

  // Auto-suggest the slug from the name until the user edits it directly.
  useEffect(() => {
    if (slugTouched) return;
    const suggested = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    setSlug(suggested);
  }, [name, slugTouched]);

  // Debounced live availability check.
  useEffect(() => {
    if (slug.length < 3) { setSlugCheck(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      checkServerSlug(slug).then((c) => { if (alive) setSlugCheck(c); }).catch(() => {});
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [slug]);

  const pending = mine?.find((a) => a.status === "pending") ?? null;
  const lastRejected = mine?.find((a) => a.status === "rejected") ?? null;

  // Rules apply only once loaded and non-empty; until then the checkbox doesn't
  // gate (so an empty/loading ruleset behaves exactly as before).
  const hasRules = !!rulesHtml && rulesHtml.trim().length > 0;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await applyForServer({
        requestedName: name.trim(),
        requestedSlug: slug,
        purpose: purpose.trim(),
        // Only meaningful when rules are set; sending true is harmless otherwise.
        ...(hasRules ? { agreedToRules: true } : {}),
      });
      setSubmitted(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Submit failed.");
    } finally {
      setBusy(false);
    }
  }

  const slugNote = !slugCheck || slug.length < 3
    ? null
    : slugCheck.ok
      ? { text: "available", tone: "text-keep-action" }
      : {
          text: slugCheck.reason === "taken" ? "already a server"
            : slugCheck.reason === "pending" ? "claimed by a pending application"
            : slugCheck.reason === "reserved" ? "reserved word"
            : "lowercase letters, numbers, hyphens (3-40)",
          tone: "text-keep-accent",
        };
  const purposeLen = purpose.trim().length;
  const canSubmit = !busy
    && name.trim().length >= SERVER_NAME_MIN && name.trim().length <= SERVER_NAME_MAX
    && slugCheck?.ok === true
    && purposeLen >= SERVER_PURPOSE_MIN && purposeLen <= SERVER_PURPOSE_MAX
    // When registration rules are set, the agreement box must be ticked.
    && (!hasRules || agreed);

  return (
    <Modal onClose={onClose} zIndex={50}>
      <div
        className="keep-frame max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded border border-keep-rule bg-keep-bg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-action text-lg text-keep-text">Create your server</h3>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setForcedTourId("server-create")}
              title="Show me around"
              aria-label="Show me around this form"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-keep-rule text-keep-muted transition-colors hover:border-keep-action hover:text-keep-action"
            >
              <HelpCircle className="h-4 w-4" aria-hidden="true" />
            </button>
            <CloseButton onClick={onClose} />
          </div>
        </div>

        {mine === null ? (
          <p className="text-sm italic text-keep-muted">Checking your applications…</p>
        ) : submitted ? (
          <div className="space-y-2 text-sm text-keep-text">
            <p><strong>Application sent.</strong> The site's moderators will review it; you'll get a notice here and in chat when it's decided.</p>
            <button type="button" onClick={onClose} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-panel">Close</button>
          </div>
        ) : pending ? (
          <div className="space-y-2 text-sm text-keep-text">
            <p>
              Your application for <strong>{pending.requestedName}</strong>
              <span className="text-keep-muted"> (/s/{pending.requestedSlug})</span> is
              <span className="text-keep-action"> pending review</span>.
            </p>
            <p className="text-xs text-keep-muted">One application at a time. You can apply again once it's decided.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {lastRejected?.reviewNote ? (
              <p className="rounded border border-keep-rule bg-keep-panel/40 px-2 py-1.5 text-xs text-keep-muted">
                Your last application was declined: "{lastRejected.reviewNote}"
              </p>
            ) : null}
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">Server name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={SERVER_NAME_MAX}
                placeholder="The Obsidian Court"
                data-tour="server-create-name"
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">
                Address <span className="normal-case text-keep-rule">/s/</span>
                {slugNote ? <span className={`ml-2 normal-case ${slugNote.tone}`}>{slugNote.text}</span> : null}
              </span>
              <input
                value={slug}
                onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }}
                maxLength={40}
                placeholder="obsidian-court"
                data-tour="server-create-slug"
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 font-mono text-sm outline-none focus:border-keep-action"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-widest text-keep-muted">
                What is your server for?
                <span className={`ml-2 normal-case tabular-nums ${purposeLen > 0 && purposeLen < SERVER_PURPOSE_MIN ? "text-keep-accent" : "text-keep-rule"}`}>
                  {purposeLen}/{SERVER_PURPOSE_MAX}{purposeLen < SERVER_PURPOSE_MIN ? ` (min ${SERVER_PURPOSE_MIN})` : ""}
                </span>
              </span>
              <textarea
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                maxLength={SERVER_PURPOSE_MAX}
                rows={4}
                placeholder="Tell the reviewers what community this server gathers and what its rooms will hold."
                data-tour="server-create-purpose"
                className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
              />
            </label>

            {/* Admin-authored registration rules + agreement gate. Rendered only
                when rules are set; sanitized (defense-in-depth) before display. */}
            {hasRules ? (
              <div className="space-y-2">
                <span className="block text-xs uppercase tracking-widest text-keep-muted">Before you apply</span>
                <div
                  className="prose prose-sm max-h-72 max-w-none overflow-y-auto break-words rounded border border-keep-rule bg-keep-panel/30 px-3 py-2 text-keep-text sm:max-h-96"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(rulesHtml!) }}
                />
                <label className="flex items-start gap-2 text-sm text-keep-text">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>I agree to these rules</span>
                </label>
              </div>
            ) : null}

            {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-keep-muted">Reviewed by the site's moderators. Approved servers appear in the catalog with you as owner.</p>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                data-tour="server-create-submit"
                className="shrink-0 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
              >
                {busy ? "…" : "Apply"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
