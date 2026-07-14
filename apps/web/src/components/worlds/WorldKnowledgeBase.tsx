/**
 * The world knowledge-base body, rendered inside WorldViewerModal. Two top-
 * level views: an **Overview** (description, join card, world facts/vibe, and
 * summary cards) and the **Wiki** (a control panel that sorts world content By
 * Type / By Tag / By Arc / By Session). "Lore" is the existing page tree; the
 * other types are world_entities. Bodies render `@kind:slug` cross-link chips.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, MapPin, X } from "lucide-react";
import type {
  WorldDetail, WorldEntity, WorldEntityKindDef, WorldEntityLight, WorldEntityMapRef, WorldMapMarker, WorldMapMarkerEvent, WorldMemberRef, WorldPage, WorldSession,
} from "@thekeep/shared";
import { BUILTIN_WORLD_ENTITY_KINDS, WORLD_VIBE_AXES } from "@thekeep/shared";
import { legibleHtmlColors, sanitizeUserHtml, USER_HTML_SCOPE_CLASS } from "../../lib/userHtml.js";
import { useActiveTheme } from "../../lib/theme.js";
import { cropStyleFor } from "../../lib/avatarCrop.js";
import { formatDateTime } from "../../lib/intlFormat.js";
import { buildWorldTree, type WorldTreeNode } from "../../lib/worlds.js";
import { fetchWorldEntity, fetchWorldSession } from "../../lib/worldEntities.js";
import { fetchWorldEntityMapRefs, fetchWorldMap, type WorldMapPayload } from "../../lib/worldMaps.js";
import { makeMarkerKindMeta, readMapLayerPrefs, writeMapLayerPrefs } from "../../lib/worldMapKinds.js";
import { anchorIdFor, decorateWorldMentionsIn, flashKbEntry, makeWorldChipClickHandler } from "../../lib/worldMentions.js";
import { REQUEST_OPEN_SERVER_EVENT, type RequestOpenServerEventDetail } from "../servers/ServerEventsPanel.js";
import { WorldMapStage, type MapFlyRequest, type MapStageHandle } from "./WorldMapStage.js";

/** A "Show on map" jump: which map to select and which marker to fly to.
 *  `seq` makes every request unique so repeat clicks re-fly. */
interface MapFocus {
  mapId: string;
  markerId: string;
  seq: number;
}

type WikiLens = "type" | "tag" | "arc" | "session";

/** Membership state + actions threaded from WorldViewerModal so the Overview
 *  can render a join card. */
export interface KbMembership {
  isAuthenticated: boolean;
  busy: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onApply: () => void;
}

export function WorldKnowledgeBase({ worldId, detail, membership }: { worldId: string; detail: WorldDetail; membership?: KbMembership }) {
  const { t } = useTranslation("worlds");
  const [view, setView] = useState<"overview" | "wiki" | "map">("overview");
  const [lens, setLens] = useState<WikiLens>("type");
  const [search, setSearch] = useState("");
  const [activeKind, setActiveKind] = useState<string>("lore");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeArc, setActiveArc] = useState<string | null>(null);
  const [openEntityId, setOpenEntityId] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(() => {
    const first = detail.pages.filter((p) => p.parentPageId === null).sort((a, b) => a.sortOrder - b.sortOrder)[0];
    return first?.id ?? null;
  });

  const kindDefs: WorldEntityKindDef[] = useMemo(() => {
    // A custom kind registered before its key became a builtin (poi/town)
    // would duplicate the builtin's card and React key; the builtin wins.
    const builtinKeys = new Set<string>(BUILTIN_WORLD_ENTITY_KINDS.map((k) => k.key));
    const custom = detail.entityKinds
      .filter((k) => !builtinKeys.has(k.key.toLowerCase()))
      .map((k) => ({
        key: k.key, label: k.label, description: k.description,
        icon: k.icon ?? "✦", color: k.color ?? "#8a8a8a", sortOrder: k.sortOrder, builtIn: false,
      }));
    // Built-in kind labels/descriptions localize; custom kinds are the
    // author's own text and render as written.
    const builtIn: WorldEntityKindDef[] = BUILTIN_WORLD_ENTITY_KINDS.map((k) => ({
      ...k,
      label: t(`kinds.${k.key}.label`),
      description: t(`kinds.${k.key}.description`),
    }));
    return [...builtIn, ...custom];
  }, [detail.entityKinds, t]);
  const labelFor = (k: string) => kindDefs.find((d) => d.key === k)?.label ?? k;
  const countFor = (key: string) => key === "lore" ? detail.pages.length : detail.entities.filter((e) => e.kind === key).length;

  // Jump to an entry from a cross-link chip: go to the Wiki, switch to the
  // right lens, open + flash the target.
  function openEntry(kind: string, slug: string) {
    if (kind === "lore") {
      const page = detail.pages.find((p) => p.slug === slug);
      if (!page) return;
      setView("wiki"); setLens("type"); setActiveKind("lore"); setSelectedPageId(page.id); setOpenEntityId(null);
      return;
    }
    const ent = detail.entities.find((e) => e.kind === kind && e.slug === slug);
    if (!ent) return;
    setView("wiki"); setLens("type"); setActiveKind(kind); setOpenEntityId(ent.id);
    window.setTimeout(() => flashKbEntry(kind, slug), 80);
  }

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    type Hit = { label: string; sub: string; onClick: () => void };
    const hits: Hit[] = [];
    for (const e of detail.entities) if (e.name.toLowerCase().includes(q)) {
      hits.push({ label: e.name, sub: labelFor(e.kind), onClick: () => openEntry(e.kind, e.slug) });
    }
    for (const p of detail.pages) if (p.title.toLowerCase().includes(q)) {
      hits.push({ label: p.title, sub: t("kb.lore"), onClick: () => openEntry("lore", p.slug) });
    }
    for (const s of detail.sessions) if (s.title.toLowerCase().includes(q)) {
      hits.push({ label: s.title, sub: t("kb.session"), onClick: () => { setView("wiki"); setLens("session"); setOpenSessionId(s.id); } });
    }
    return hits.slice(0, 40);
  }, [search, detail, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const lenses: Array<[WikiLens, string]> = [["type", t("kb.lensType")], ["tag", t("kb.lensTag")], ["arc", t("kb.lensArc")], ["session", t("kb.lensSession")]];

  // The Map tab only exists when the world has maps, so map-less worlds
  // render byte-identically to before the feature existed.
  const hasMaps = (detail.maps?.length ?? 0) > 0;

  // Entry → marker reverse lookup for the "Show on map" chip (secret
  // markers pre-stripped server-side for non-editors). Only fetched when
  // the world actually has maps — map-less worlds make zero extra calls.
  const [mapRefs, setMapRefs] = useState<WorldEntityMapRef[]>([]);
  useEffect(() => {
    if (!hasMaps) { setMapRefs([]); return; }
    let alive = true;
    fetchWorldEntityMapRefs(worldId)
      .then((refs) => { if (alive) setMapRefs(refs); })
      .catch(() => { /* chip is an extra — a failed lookup just hides it */ });
    return () => { alive = false; };
  }, [worldId, hasMaps]);
  const mapRefIndex = useMemo(() => {
    const m = new Map<string, WorldEntityMapRef>();
    // First ref (map order, then marker order) wins for entries placed
    // on several maps.
    for (const r of mapRefs) {
      const key = `${r.entryKind}:${r.entrySlug}`;
      if (!m.has(key)) m.set(key, r);
    }
    return m;
  }, [mapRefs]);
  const mapRefFor = (kind: string, slug: string) => mapRefIndex.get(`${kind}:${slug}`) ?? null;

  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  const focusSeqRef = useRef(0);
  function showOnMap(ref: WorldEntityMapRef) {
    focusSeqRef.current += 1;
    setMapFocus({ mapId: ref.mapId, markerId: ref.markerId, seq: focusSeqRef.current });
    setView("map");
  }
  const tabs: Array<["overview" | "wiki" | "map", string]> = [
    ["overview", t("kb.tabOverview")],
    ["wiki", t("kb.tabWiki")],
    ...(hasMaps ? [["map", t("kb.tabMap")] as ["map", string]] : []),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top nav: Overview | Wiki (+ Map when the world has maps) + search */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-keep-rule bg-keep-banner/30 px-3 py-1.5">
        <nav className="flex gap-1">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              // Manual tab navigation is not a deep-link: drop any pending
              // "Show on map" focus so re-opening the Map tab doesn't re-fly.
              onClick={() => { setView(key); setSearch(""); setMapFocus(null); }}
              className={`rounded px-3 py-1 text-xs font-semibold uppercase tracking-widest ${
                view === key && !search ? "bg-keep-action/15 text-keep-action" : "text-keep-muted hover:bg-keep-muted/25"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("kb.searchPlaceholder")}
          className="ml-auto w-44 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
        />
      </div>

      {searchResults ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ResultList title={t("kb.results", { count: searchResults.length })} rows={searchResults} />
        </div>
      ) : view === "map" && hasMaps ? (
        <MapPanel worldId={worldId} detail={detail} kindDefs={kindDefs} onOpenEntry={openEntry} focus={mapFocus} />
      ) : view === "overview" || view === "map" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <OverviewPanel
            detail={detail} kindDefs={kindDefs} countFor={countFor} labelFor={labelFor} membership={membership}
            onPickType={(k) => { setView("wiki"); setLens("type"); setActiveKind(k); setOpenEntityId(null); }}
            onPickTag={(t) => { setView("wiki"); setLens("tag"); setActiveTag(t); }}
            onPickArc={(a) => { setView("wiki"); setLens("arc"); setActiveArc(a); }}
            onGoWiki={() => setView("wiki")}
            onOpen={openEntry}
          />
        </div>
      ) : (
        <>
          {/* Wiki control panel: sort world content by lens */}
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-keep-rule/60 bg-keep-bg/40 px-3 py-1.5">
            <span className="mr-1 text-[10px] uppercase tracking-widest text-keep-muted">{t("kb.sortBy")}</span>
            {lenses.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setLens(key)}
                className={`rounded px-2 py-1 text-[11px] uppercase tracking-widest ${
                  lens === key ? "bg-keep-action/15 text-keep-action" : "text-keep-muted hover:bg-keep-muted/25"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {lens === "type" ? (
              <TypePanel
                worldId={worldId} detail={detail} kindDefs={kindDefs}
                activeKind={activeKind} setActiveKind={(k) => { setActiveKind(k); setOpenEntityId(null); }}
                selectedPageId={selectedPageId} setSelectedPageId={setSelectedPageId}
                openEntityId={openEntityId} setOpenEntityId={setOpenEntityId}
                onOpenEntry={openEntry}
                mapRefFor={mapRefFor} onShowOnMap={showOnMap}
              />
            ) : lens === "tag" ? (
              <TagPanel detail={detail} labelFor={labelFor} activeTag={activeTag} setActiveTag={setActiveTag} onOpen={openEntry} />
            ) : lens === "arc" ? (
              <ArcPanel detail={detail} labelFor={labelFor} activeArc={activeArc} setActiveArc={setActiveArc} onOpen={openEntry} onOpenSession={(id) => { setLens("session"); setOpenSessionId(id); }} />
            ) : (
              <SessionPanel worldId={worldId} detail={detail} openSessionId={openSessionId} setOpenSessionId={setOpenSessionId} onOpenEntry={openEntry} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Overview ---------- */

function OverviewPanel({
  detail, kindDefs, countFor, labelFor, membership, onPickType, onPickTag, onPickArc, onGoWiki, onOpen,
}: {
  detail: WorldDetail;
  kindDefs: WorldEntityKindDef[];
  countFor: (k: string) => number;
  labelFor: (k: string) => string;
  membership: KbMembership | undefined;
  onPickType: (k: string) => void;
  onPickTag: (t: string) => void;
  onPickArc: (a: string) => void;
  onGoWiki: () => void;
  onOpen: (kind: string, slug: string) => void;
}) {
  const { t } = useTranslation("worlds");
  const w = detail.world;
  const recent = useMemo(() => {
    type R = { key: string; label: string; sub: string; updatedAt: number; onClick: () => void };
    const rows: R[] = [
      ...detail.entities.map((e) => ({ key: `e:${e.id}`, label: e.name, sub: labelFor(e.kind), updatedAt: e.updatedAt, onClick: () => onOpen(e.kind, e.slug) })),
      ...detail.pages.map((p) => ({ key: `p:${p.id}`, label: p.title, sub: t("kb.lore"), updatedAt: p.updatedAt, onClick: () => onOpen("lore", p.slug) })),
    ];
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  }, [detail, labelFor, onOpen, t]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of detail.entities) for (const t of e.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [detail.entities]);

  const arcCounts = (arcId: string) =>
    detail.entities.filter((e) => e.arcId === arcId).length
    + detail.pages.filter((p) => p.arcId === arcId).length
    + detail.sessions.filter((s) => s.arcId === arcId).length;

  // Fact VALUES for the closed enums map through the catalog (en values
  // reproduce the old titleCase() output exactly); counts/dates stay raw.
  const facts: Array<[string, string]> = [];
  if (w.genre) facts.push([t("overview.facts.genre"), t(`overview.factValues.genre.${w.genre}`)]);
  if (w.pacing) facts.push([t("overview.facts.pacing"), t(`overview.factValues.pacing.${w.pacing}`)]);
  facts.push([t("overview.facts.status"), t(`overview.factValues.status.${w.status}`)]);
  facts.push([t("overview.facts.visibility"), t(`overview.factValues.visibility.${w.visibility}`)]);
  facts.push([t("overview.facts.joinMode"), t(`overview.factValues.joinMode.${w.joinMode ?? "open"}`)]);
  facts.push([t("overview.facts.members"), String(w.memberCount)]);
  facts.push([t("overview.facts.lorePages"), String(w.pageCount)]);
  facts.push([t("overview.facts.entries"), String(detail.entities.length)]);
  if (w.linkedRoomCount > 0) facts.push([t("overview.facts.linkedRooms"), String(w.linkedRoomCount)]);
  facts.push([t("overview.facts.created"), new Date(w.createdAt).toISOString().slice(0, 10)]);

  const vibe = WORLD_VIBE_AXES
    .map((a) => ({ key: a.key, label: t(`vibeAxes.${a.key}.label`), desc: t(`vibeAxes.${a.key}.desc`), value: w.vibeStats[a.key] ?? null }))
    .filter((a) => a.value != null) as Array<{ key: string; label: string; desc: string; value: number }>;

  return (
    <div className="space-y-6 p-4">
      {w.coverImageUrl ? (
        // 16:9 container with object-contain so the whole cover shows
        // (uncropped), letterboxed on the panel bg. Centered + width-capped so
        // the ratio holds without the banner growing absurdly tall on wide
        // viewports.
        <div className="mx-auto aspect-video w-full max-w-4xl overflow-hidden rounded-lg border border-keep-rule/60 bg-keep-bg/60">
          <img src={w.coverImageUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-contain" />
        </div>
      ) : null}

      {/* About — contained, larger copy. Full-width so a short description
          doesn't leave a tall dead block beside the sidebar. */}
      <section className="rounded-lg border border-keep-rule/60 bg-keep-bg/40 p-4">
        <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-keep-muted">{t("overview.about")}</h3>
        {w.description ? (
          <p className="whitespace-pre-wrap text-base leading-relaxed">{w.description}</p>
        ) : (
          <p className="italic text-keep-muted">{t("overview.noDescription")}</p>
        )}
        {(w.tags.length > 0 || w.contentWarnings.length > 0) ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {w.tags.map((t) => <span key={t} className="rounded border border-keep-rule/60 px-2 py-0.5 text-[11px] text-keep-muted">{t}</span>)}
            {w.contentWarnings.map((c) => <span key={c} className="rounded border border-keep-accent/40 px-2 py-0.5 text-[11px] text-keep-accent">⚠ {c}</span>)}
          </div>
        ) : null}
      </section>

      {/* Join card + facts strip side by side on lg, stacked on mobile. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {membership ? <JoinCard detail={detail} membership={membership} /> : null}
        <div className={membership ? "" : "lg:col-span-2"}>
          <FactsCard facts={facts} />
        </div>
      </div>

      {vibe.length > 0 ? (
        <section className="rounded-lg border border-keep-rule/60 bg-keep-bg/40 p-4">
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-keep-muted">{t("overview.vibe")}</h3>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {vibe.map((a) => (
              <div key={a.key} title={a.desc}>
                <div className="flex justify-between text-[11px]"><span>{a.label}</span><span className="tabular-nums text-keep-muted">{a.value}</span></div>
                <div className="h-1.5 w-full rounded-full bg-keep-rule/40"><div className="h-1.5 rounded-full bg-keep-action" style={{ width: `${a.value}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <MemberGallery members={detail.members} />

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-[10px] uppercase tracking-widest text-keep-muted">{t("overview.contents")}</h3>
          <button type="button" onClick={onGoWiki} className="text-[11px] text-keep-action hover:underline">{t("overview.openWiki")}</button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {kindDefs.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => onPickType(d.key)}
              className="flex items-start justify-between gap-2 rounded-lg border border-keep-rule/60 bg-keep-bg/40 p-3 text-left hover:border-keep-action/50"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <span aria-hidden style={{ color: d.color }}>{d.icon}</span>{d.label}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-keep-muted">{d.description}</span>
              </span>
              <span className="shrink-0 font-action text-2xl tabular-nums">{countFor(d.key)}</span>
            </button>
          ))}
        </div>
      </section>

      {recent.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-keep-muted">{t("overview.recentlyEdited")}</h3>
          <ResultList rows={recent} />
        </section>
      ) : null}

      {detail.arcs.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-keep-muted">{t("overview.arcs")}</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {detail.arcs.map((a) => (
              <button key={a.id} type="button" onClick={() => onPickArc(a.id)} className="flex items-center gap-2 rounded-lg border border-keep-rule/60 bg-keep-bg/40 p-3 text-left hover:border-keep-action/50">
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.color ?? "var(--keep-action)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{a.title}</span>
                  <span className="block text-[10px] uppercase tracking-widest text-keep-muted">{t(`arcStatus.${a.status}`)}</span>
                </span>
                <span className="shrink-0 font-action text-lg tabular-nums">{arcCounts(a.id)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {tagCounts.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-keep-muted">{t("overview.tags")}</h3>
          <div className="flex flex-wrap gap-1.5">
            {tagCounts.map(([t, n]) => (
              <button key={t} type="button" onClick={() => onPickTag(t)} className="rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1 text-xs hover:border-keep-action/50">
                {t} <span className="tabular-nums text-keep-muted">{n}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function FactsCard({ facts }: { facts: Array<[string, string]> }) {
  return (
    <dl className="grid h-full grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-keep-rule/60 bg-keep-bg/40 p-4 text-sm sm:grid-cols-3 lg:grid-cols-4">
      {facts.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[10px] uppercase tracking-widest text-keep-muted">{k}</dt>
          <dd className="truncate">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Join / Apply / Invite-only / Leave card for the Overview. */
function JoinCard({ detail, membership }: { detail: WorldDetail; membership: KbMembership }) {
  const { t } = useTranslation("worlds");
  const w = detail.world;
  const wrap = (text: string, action: ReactNode) => (
    <div className="flex h-full flex-col justify-center rounded-lg border border-keep-action/40 bg-keep-action/5 p-4">
      <p className="mb-2 text-sm">{text}</p>
      {action}
    </div>
  );
  const btn = "keep-button rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-sm text-keep-action disabled:opacity-50";

  if (detail.viewerIsMember) {
    return wrap(t("joinCard.member"), (
      <button type="button" disabled={membership.busy} onClick={membership.onLeave} className="keep-button rounded border border-keep-accent/50 px-3 py-1 text-sm text-keep-accent disabled:opacity-50">{t("joinCard.leaveWorld")}</button>
    ));
  }
  // joinMode drives the card, independent of visibility: resolveWorld already
  // gated who can SEE this world, so a public / link-shared world still joins or
  // applies here (a private one the viewer can't resolve never renders this).
  if (!membership.isAuthenticated) return wrap(t("joinCard.signIn"), null);
  const joinMode = w.joinMode ?? "open";
  if (joinMode === "invite-only") {
    return wrap(t("joinCard.inviteOnly"), null);
  }
  if (joinMode === "application") {
    const app = detail.viewerApplication;
    if (app && app.status === "pending") return wrap(t("joinCard.pending"), null);
    return wrap(t("joinCard.acceptsApplications"), (
      <button type="button" disabled={membership.busy} onClick={membership.onApply} className={btn}>{app && app.status === "rejected" ? t("actions.reapply") : t("joinCard.applyToJoin")}</button>
    ));
  }
  return wrap(t("joinCard.open"), (
    <button type="button" disabled={membership.busy} onClick={membership.onJoin} className={btn}>{t("joinCard.joinWorld")}</button>
  ));
}

/* ---------- By Type ---------- */

function TypePanel({
  worldId, detail, kindDefs, activeKind, setActiveKind, selectedPageId, setSelectedPageId, openEntityId, setOpenEntityId, onOpenEntry, mapRefFor, onShowOnMap,
}: {
  worldId: string;
  detail: WorldDetail;
  kindDefs: WorldEntityKindDef[];
  activeKind: string;
  setActiveKind: (k: string) => void;
  selectedPageId: string | null;
  setSelectedPageId: (id: string | null) => void;
  openEntityId: string | null;
  setOpenEntityId: (id: string | null) => void;
  onOpenEntry: (kind: string, slug: string) => void;
  mapRefFor: (kind: string, slug: string) => WorldEntityMapRef | null;
  onShowOnMap: (ref: WorldEntityMapRef) => void;
}) {
  const { t } = useTranslation("worlds");
  const tree = useMemo(() => buildWorldTree(detail.pages), [detail.pages]);
  const selectedPage = detail.pages.find((p) => p.id === selectedPageId) ?? null;
  const entries = detail.entities.filter((e) => e.kind === activeKind);

  return (
    <div className="flex min-h-0 flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-keep-rule p-1 md:w-56 md:border-r">
        {kindDefs.map((d) => (
          <button key={d.key} type="button" onClick={() => setActiveKind(d.key)}
            className={`flex items-center justify-between gap-1 rounded px-2 py-1 text-left text-xs ${activeKind === d.key ? "bg-keep-action/15 text-keep-action" : "hover:bg-keep-muted/25"}`}>
            <span className="flex items-center gap-1.5"><span aria-hidden style={{ color: d.color }}>{d.icon}</span>{d.label}</span>
            <span className="tabular-nums text-keep-muted">{d.key === "lore" ? detail.pages.length : detail.entities.filter((e) => e.kind === d.key).length}</span>
          </button>
        ))}
      </aside>
      <section className="min-h-0 flex-1 p-4">
        {activeKind === "lore" ? (
          tree.length === 0 ? <p className="italic text-keep-muted">{t("kb.noLorePages")}</p> : (
            <div className="flex flex-col gap-4 md:flex-row">
              <div className="md:w-56 md:shrink-0">
                <ViewerTree nodes={tree} selectedId={selectedPageId} onSelect={setSelectedPageId} />
              </div>
              <div className="min-w-0 flex-1">
                <PageView page={selectedPage} onOpenEntry={onOpenEntry} mapRefFor={mapRefFor} onShowOnMap={onShowOnMap} />
              </div>
            </div>
          )
        ) : openEntityId ? (
          <EntityDetail worldId={worldId} entityId={openEntityId} onBack={() => setOpenEntityId(null)} onOpenEntry={onOpenEntry} mapRefFor={mapRefFor} onShowOnMap={onShowOnMap} />
        ) : entries.length === 0 ? (
          <p className="italic text-keep-muted">{t("kb.noEntriesOfKind")}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((e) => <EntityCard key={e.id} entity={e} onClick={() => setOpenEntityId(e.id)} />)}
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------- By Tag ---------- */

function TagPanel({ detail, labelFor, activeTag, setActiveTag, onOpen }: {
  detail: WorldDetail; labelFor: (k: string) => string; activeTag: string | null; setActiveTag: (t: string | null) => void; onOpen: (kind: string, slug: string) => void;
}) {
  const { t } = useTranslation("worlds");
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of detail.entities) for (const t of e.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [detail.entities]);
  const matches = activeTag ? detail.entities.filter((e) => e.tags.includes(activeTag)) : [];
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap gap-1.5">
        {tags.map(([t, n]) => (
          <button key={t} type="button" onClick={() => setActiveTag(t)} className={`rounded border px-2 py-1 text-xs ${activeTag === t ? "border-keep-action text-keep-action" : "border-keep-rule/60 hover:border-keep-action/50"}`}>
            {t} <span className="tabular-nums text-keep-muted">{n}</span>
          </button>
        ))}
        {tags.length === 0 ? <p className="italic text-keep-muted">{t("kb.noTaggedEntries")}</p> : null}
      </div>
      {activeTag ? (
        <ResultList rows={matches.map((e) => ({ key: e.id, label: e.name, sub: labelFor(e.kind), onClick: () => onOpen(e.kind, e.slug) }))} />
      ) : null}
    </div>
  );
}

/* ---------- By Arc ---------- */

function ArcPanel({ detail, labelFor, activeArc, setActiveArc, onOpen, onOpenSession }: {
  detail: WorldDetail; labelFor: (k: string) => string; activeArc: string | null; setActiveArc: (a: string | null) => void;
  onOpen: (kind: string, slug: string) => void; onOpenSession: (id: string) => void;
}) {
  const { t } = useTranslation("worlds");
  const arc = activeArc ? detail.arcs.find((a) => a.id === activeArc) ?? null : null;
  const rows = useMemo(() => {
    if (!activeArc) return [];
    type R = { key: string; label: string; sub: string; onClick: () => void };
    const out: R[] = [
      ...detail.entities.filter((e) => e.arcId === activeArc).map((e) => ({ key: `e:${e.id}`, label: e.name, sub: labelFor(e.kind), onClick: () => onOpen(e.kind, e.slug) })),
      ...detail.pages.filter((p) => p.arcId === activeArc).map((p) => ({ key: `p:${p.id}`, label: p.title, sub: t("kb.lore"), onClick: () => onOpen("lore", p.slug) })),
      ...detail.sessions.filter((s) => s.arcId === activeArc).map((s) => ({ key: `s:${s.id}`, label: s.title, sub: t("kb.session"), onClick: () => onOpenSession(s.id) })),
    ];
    return out;
  }, [activeArc, detail, labelFor, onOpen, onOpenSession, t]);
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap gap-1.5">
        {detail.arcs.map((a) => (
          <button key={a.id} type="button" onClick={() => setActiveArc(a.id)} className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${activeArc === a.id ? "border-keep-action text-keep-action" : "border-keep-rule/60 hover:border-keep-action/50"}`}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: a.color ?? "var(--keep-action)" }} />{a.title}
            <span className="text-[10px] uppercase text-keep-muted">{t(`arcStatus.${a.status}`)}</span>
          </button>
        ))}
        {detail.arcs.length === 0 ? <p className="italic text-keep-muted">{t("kb.noArcs")}</p> : null}
      </div>
      {arc ? (
        <>
          {arc.summary ? <p className="text-sm text-keep-muted">{arc.summary}</p> : null}
          <ResultList rows={rows} />
        </>
      ) : null}
    </div>
  );
}

/* ---------- By Session ---------- */

function SessionPanel({ worldId, detail, openSessionId, setOpenSessionId, onOpenEntry }: {
  worldId: string; detail: WorldDetail; openSessionId: string | null; setOpenSessionId: (id: string | null) => void; onOpenEntry: (kind: string, slug: string) => void;
}) {
  const { t } = useTranslation("worlds");
  if (openSessionId) {
    return <div className="p-4"><SessionDetail worldId={worldId} sessionId={openSessionId} onBack={() => setOpenSessionId(null)} onOpenEntry={onOpenEntry} /></div>;
  }
  return (
    <div className="p-4">
      {detail.sessions.length === 0 ? <p className="italic text-keep-muted">{t("kb.noSessions")}</p> : (
        <ul className="space-y-1">
          {detail.sessions.map((s) => {
            const arc = s.arcId ? detail.arcs.find((a) => a.id === s.arcId) : null;
            return (
              <li key={s.id}>
                <button type="button" onClick={() => setOpenSessionId(s.id)} className="flex w-full items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/40 px-3 py-2 text-left hover:border-keep-action/50">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{s.title}</span>
                    {s.summary ? <span className="block truncate text-[11px] text-keep-muted">{s.summary}</span> : null}
                  </span>
                  {arc ? <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted">{arc.title}</span> : null}
                  {s.sessionDate ? <span className="shrink-0 text-[10px] tabular-nums text-keep-muted">{new Date(s.sessionDate).toISOString().slice(0, 10)}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------- Map tab ---------- */

/**
 * Read-only map surface: picker (when the world has several maps), layer
 * toggle chips per marker kind (persisted per device), an "On this map"
 * index of the entries linked by the visible markers (click = fly to the
 * marker), the pan/zoom stage, and a popover for the clicked marker with
 * an optional "Open entry" jump into the knowledge base. Marker data is
 * lazy-fetched per map; secret markers only ever arrive for editors
 * (server-stripped otherwise) and render dimmed/dashed with a DM-only
 * toggle chip — the index derives from that same payload, so its scrub
 * composition is automatic.
 */
function MapPanel({ worldId, detail, kindDefs, onOpenEntry, focus = null }: {
  worldId: string;
  detail: WorldDetail;
  kindDefs: WorldEntityKindDef[];
  onOpenEntry: (kind: string, slug: string) => void;
  /** "Show on map" deep-link from the wiki: select that map, fly to the
   *  marker, open its popover. Handled once per seq. */
  focus?: MapFocus | null;
}) {
  const { t } = useTranslation("worlds");
  const maps = useMemo(
    () => [...(detail.maps ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [detail.maps],
  );
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (focus && maps.some((m) => m.id === focus.mapId)) return focus.mapId;
    return maps[0]?.id ?? null;
  });
  const active = maps.find((m) => m.id === activeId) ?? maps[0] ?? null;
  const [payload, setPayload] = useState<WorldMapPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedMarker, setSelectedMarker] = useState<WorldMapMarker | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [showSecret, setShowSecret] = useState(true);
  // Fullscreen-within-window: the stage takes the whole tab; the picker,
  // index, and description give way (layer chips stay — they drive the map).
  const [expanded, setExpanded] = useState(false);
  const kindMeta = useMemo(() => makeMarkerKindMeta(kindDefs, t), [kindDefs, t]);
  const stageRef = useRef<MapStageHandle | null>(null);
  const [fly, setFly] = useState<MapFlyRequest | null>(null);
  const flySeqRef = useRef(0);

  const activeId2 = active?.id ?? null;
  useEffect(() => {
    if (!activeId2) return;
    let alive = true;
    setPayload(null); setErr(null); setSelectedMarker(null); setFly(null);
    const prefs = readMapLayerPrefs(activeId2);
    setHiddenKinds(new Set(prefs.hidden));
    setShowSecret(!prefs.secretHidden);
    fetchWorldMap(worldId, activeId2)
      .then((p) => { if (alive) setPayload(p); })
      .catch((x) => { if (alive) setErr(x instanceof Error ? x.message : t("errors.loadFailed")); });
    return () => { alive = false; };
    // `t` deliberately omitted: a language flip must not refetch the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, activeId2]);

  /** Select a marker and fly the stage to it (index rows + deep-links). */
  function focusMarker(m: WorldMapMarker) {
    flySeqRef.current += 1;
    setSelectedMarker(m);
    setFly({ marker: m, seq: flySeqRef.current });
  }

  // "Show on map" deep-links: switch to the requested map, then (once its
  // payload is in) fly to the marker — unhiding its layer / the DM-only
  // toggle first, or the jump would land on a filtered-out pin.
  const handledFocusRef = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || handledFocusRef.current === focus.seq) return;
    if (!maps.some((m) => m.id === focus.mapId)) { handledFocusRef.current = focus.seq; return; }
    if (activeId2 !== focus.mapId) { setActiveId(focus.mapId); return; }
    if (!payload || payload.map.id !== focus.mapId) return;
    handledFocusRef.current = focus.seq;
    const m = payload.markers.find((k) => k.id === focus.markerId);
    if (!m) return;
    setHiddenKinds((prev) => {
      if (!prev.has(m.kind)) return prev;
      const next = new Set(prev);
      next.delete(m.kind);
      return next;
    });
    if (m.isSecret) setShowSecret(true);
    focusMarker(m);
  }, [focus, payload, activeId2, maps]);

  const kindsPresent = useMemo(() => {
    const seen = new Map<string, number>();
    for (const m of payload?.markers ?? []) seen.set(m.kind, (seen.get(m.kind) ?? 0) + 1);
    return [...seen.entries()];
  }, [payload]);
  const hasSecret = (payload?.markers ?? []).some((m) => m.isSecret);

  function toggleKind(kind: string) {
    if (!active) return;
    const next = new Set(hiddenKinds);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    setHiddenKinds(next);
    writeMapLayerPrefs(active.id, { hidden: [...next], secretHidden: !showSecret });
  }
  function toggleSecret() {
    if (!active) return;
    const next = !showSecret;
    setShowSecret(next);
    writeMapLayerPrefs(active.id, { hidden: [...hiddenKinds], secretHidden: !next });
  }

  const visibleMarkers = useMemo(
    () => (payload?.markers ?? []).filter((m) => !hiddenKinds.has(m.kind) && (showSecret || !m.isSecret)),
    [payload, hiddenKinds, showSecret],
  );

  // Event details for event-linked markers: server-resolved PER VIEWER (only
  // members of the owning community receive entries), keyed for the popover.
  // A marker with an eventId but no entry here renders the neutral
  // members-only line instead.
  const eventsById = useMemo(() => {
    const m = new Map<string, WorldMapMarkerEvent>();
    for (const ev of payload?.events ?? []) m.set(ev.id, ev);
    return m;
  }, [payload]);

  // A layer/DM-only toggle that filters the selected marker off the stage
  // must also close its popover, or the card floats over a vanished pin.
  useEffect(() => {
    if (!selectedMarker) return;
    if (hiddenKinds.has(selectedMarker.kind) || (!showSecret && selectedMarker.isSecret)) {
      setSelectedMarker(null);
    }
  }, [selectedMarker, hiddenKinds, showSecret]);

  // "On this map": the entries linked by the currently-visible markers,
  // grouped by entry kind, deduped (an entry pinned twice lists once and
  // flies to its first marker). Names/thumbnails resolve through the
  // detail payload; an entry the viewer can't see there (e.g. a hidden
  // draft) falls back to the marker's own label with no thumbnail.
  const indexGroups = useMemo(() => {
    type Row = { slug: string; name: string; imageUrl: string | null; marker: WorldMapMarker };
    const groups = new Map<string, Row[]>();
    const seen = new Set<string>();
    for (const m of visibleMarkers) {
      if (!m.entryKind || !m.entrySlug) continue;
      const key = `${m.entryKind}:${m.entrySlug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let name = m.label;
      let imageUrl: string | null = null;
      if (m.entryKind === "lore") {
        const p = detail.pages.find((p) => p.slug === m.entrySlug);
        if (p) name = p.title;
      } else {
        const e = detail.entities.find((e) => e.kind === m.entryKind && e.slug === m.entrySlug);
        if (e) { name = e.name; imageUrl = e.imageUrl; }
      }
      const row: Row = { slug: m.entrySlug, name, imageUrl, marker: m };
      const list = groups.get(m.entryKind);
      if (list) list.push(row); else groups.set(m.entryKind, [row]);
    }
    return [...groups.entries()].map(([kind, rows]) => ({ kind, rows }));
  }, [visibleMarkers, detail.pages, detail.entities]);

  // Thumbnail for the popover: the linked entry's image, when the entry is
  // visible in the detail payload and has one.
  const selectedEntryImage = useMemo(() => {
    if (!selectedMarker?.entryKind || !selectedMarker.entrySlug || selectedMarker.entryKind === "lore") return null;
    const e = detail.entities.find((x) => x.kind === selectedMarker.entryKind && x.slug === selectedMarker.entrySlug);
    return e?.imageUrl ?? null;
  }, [selectedMarker, detail.entities]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      {!expanded && maps.length > 1 ? (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {maps.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setActiveId(m.id)}
              className={`rounded border px-2 py-1 text-xs ${active?.id === m.id ? "border-keep-action bg-keep-action/15 text-keep-action" : "border-keep-rule/60 hover:border-keep-action/50"}`}
            >
              {m.name}
            </button>
          ))}
        </div>
      ) : null}

      {kindsPresent.length > 0 || hasSecret ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("maps.layers")}</span>
          {kindsPresent.map(([kind, count]) => {
            const meta = kindMeta(kind);
            const on = !hiddenKinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                aria-pressed={on}
                title={on ? t("maps.hideLayerTitle", { label: meta.label }) : t("maps.showLayerTitle", { label: meta.label })}
                className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${on ? "border-keep-rule/60" : "border-dashed border-keep-rule/40 text-keep-muted opacity-60"}`}
              >
                <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: meta.color }} />
                {meta.label} <span className="tabular-nums text-keep-muted">{count}</span>
              </button>
            );
          })}
          {detail.viewerCanEdit && hasSecret ? (
            <button
              type="button"
              onClick={toggleSecret}
              aria-pressed={showSecret}
              title={t("maps.dmOnlyTitle")}
              className={`rounded border px-2 py-0.5 text-[11px] ${showSecret ? "border-keep-accent/60 text-keep-accent" : "border-dashed border-keep-rule/40 text-keep-muted opacity-60"}`}
            >
              {t("maps.dmOnly")}
            </button>
          ) : null}
        </div>
      ) : null}

      {err ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div> : null}

      {/* Stage + left info area (description + "On this map" index). The
          stage renders first in the DOM so narrow windows put the map on
          top; on wide containers the info area orders itself to the left. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 [@container(min-width:768px)]:flex-row">
        <div className="relative min-h-[16rem] flex-1 [@container(min-width:768px)]:order-last">
          {payload ? (
            <WorldMapStage
              ref={stageRef}
              map={payload.map}
              markers={visibleMarkers}
              kindMeta={kindMeta}
              selectedMarkerId={selectedMarker?.id ?? null}
              onMarkerClick={(m) => setSelectedMarker((cur) => (cur?.id === m.id ? null : m))}
              expanded={expanded}
              onToggleExpand={() => setExpanded((v) => !v)}
              flyTo={fly}
              className="h-full w-full"
            />
          ) : !err ? (
            <p className="flex h-full items-center justify-center italic text-keep-muted">{t("common:loadingDots")}</p>
          ) : null}

          {selectedMarker ? (
            <div className="absolute bottom-2 left-2 z-10 w-80 max-w-[calc(100%-1rem)] rounded-lg border border-keep-rule bg-keep-bg/95 p-3 shadow-lg">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{selectedMarker.label}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <span className="flex items-center gap-1 rounded border border-keep-rule/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted">
                      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: kindMeta(selectedMarker.kind).color }} />
                      {kindMeta(selectedMarker.kind).label}
                    </span>
                    {selectedMarker.isSecret ? (
                      <span className="rounded border border-dashed border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent">{t("maps.secretChip")}</span>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedMarker(null)}
                  className="shrink-0 rounded p-0.5 text-keep-muted hover:bg-keep-banner"
                  title={t("common:close")}
                  aria-label={t("common:close")}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {selectedEntryImage ? (
                <img
                  src={selectedEntryImage}
                  alt=""
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                  className="mt-2 max-h-32 w-full rounded border border-keep-rule/40 object-cover"
                />
              ) : null}
              {selectedMarker.body.trim() ? (
                <BodyHtml html={selectedMarker.body} onOpenEntry={onOpenEntry} className="mt-2 !text-xs" />
              ) : null}
              {selectedMarker.eventId ? (
                <MarkerEventCard event={eventsById.get(selectedMarker.eventId) ?? null} />
              ) : null}
              {selectedMarker.entryKind && selectedMarker.entrySlug ? (
                <button
                  type="button"
                  onClick={() => onOpenEntry(selectedMarker.entryKind!, selectedMarker.entrySlug!)}
                  className="keep-button mt-2 rounded border border-keep-action bg-keep-action/15 px-2.5 py-1 text-xs text-keep-action"
                >
                  {t("maps.openEntry")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {!expanded && (indexGroups.length > 0 || payload?.map.description?.trim()) ? (
          <aside className="max-h-48 shrink-0 space-y-3 overflow-y-auto [@container(min-width:768px)]:max-h-none [@container(min-width:768px)]:w-60">
            {payload?.map.description?.trim() ? (
              <div className="rounded-lg border border-keep-rule/60 bg-keep-bg/40 p-3">
                <BodyHtml html={payload.map.description} onOpenEntry={onOpenEntry} className="!text-xs" />
              </div>
            ) : null}
            {indexGroups.length > 0 ? (
              <section aria-label={t("maps.onThisMap")}>
                <h4 className="mb-1.5 text-[10px] uppercase tracking-widest text-keep-muted">{t("maps.onThisMap")}</h4>
                <div className="space-y-2">
                  {indexGroups.map((g) => (
                    <div key={g.kind}>
                      <div className="mb-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-keep-muted">
                        <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: kindMeta(g.kind).color }} />
                        {kindMeta(g.kind).label}
                      </div>
                      <ul className="space-y-1">
                        {g.rows.map((r) => (
                          <li key={`${g.kind}:${r.slug}`}>
                            <button
                              type="button"
                              onClick={() => focusMarker(r.marker)}
                              title={t("maps.jumpToMarkerTitle", { label: r.marker.label })}
                              className="flex w-full items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1 text-left text-xs hover:border-keep-action/40"
                            >
                              {r.imageUrl ? (
                                <img
                                  src={r.imageUrl}
                                  alt=""
                                  referrerPolicy="no-referrer"
                                  loading="lazy"
                                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                                  className="h-7 w-7 shrink-0 rounded border border-keep-rule/40 object-cover"
                                />
                              ) : null}
                              <span className="min-w-0 flex-1 truncate">{r.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The event block inside a marker popover. `event` is the server-resolved
 * per-viewer detail: present only when the viewer can participate in the
 * owning community, so a null here (with the marker still carrying an
 * eventId) means "members only" — render the neutral line, never fetch.
 * Cancelled and ended events keep their title but show their state instead
 * of the date/going row and lose the View button (the panel's upcoming list
 * wouldn't land on them).
 */
function MarkerEventCard({ event }: { event: WorldMapMarkerEvent | null }) {
  const { t } = useTranslation("worlds");
  if (!event) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11px] italic text-keep-muted">
        <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("maps.eventMembersOnly")}
      </p>
    );
  }
  const inactive = event.status === "cancelled" || event.status === "ended";
  return (
    <div className="mt-2 rounded border border-keep-rule/60 bg-keep-bg/60 p-2">
      <div className="flex items-start gap-1.5">
        <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0 text-keep-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{event.title}</div>
          {inactive ? (
            <div className="text-[11px] uppercase tracking-widest text-keep-accent">
              {event.status === "cancelled" ? t("maps.eventCancelled") : t("maps.eventEnded")}
            </div>
          ) : (
            <div className="text-[11px] text-keep-muted">
              {formatDateTime(event.startsAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {" · "}
              {t("maps.eventGoingCount", { count: event.goingCount })}
            </div>
          )}
        </div>
      </div>
      {!inactive ? (
        <button
          type="button"
          onClick={() => {
            const detail: RequestOpenServerEventDetail = { eventId: event.id, serverId: event.serverId };
            window.dispatchEvent(new CustomEvent<RequestOpenServerEventDetail>(REQUEST_OPEN_SERVER_EVENT, { detail }));
          }}
          className="keep-button mt-1.5 rounded border border-keep-action bg-keep-action/15 px-2.5 py-1 text-xs text-keep-action"
        >
          {t("maps.viewEvent")}
        </button>
      ) : null}
    </div>
  );
}

/* ---------- Shared building blocks ---------- */

function ResultList({ title, rows }: { title?: string; rows: Array<{ key?: string; label: string; sub: string; onClick: () => void }> }) {
  const { t } = useTranslation("worlds");
  return (
    <div className="space-y-1">
      {title ? <div className="text-[10px] uppercase tracking-widest text-keep-muted">{title}</div> : null}
      {rows.length === 0 ? <p className="italic text-keep-muted">{t("kb.nothingHere")}</p> : (
        <ul className="space-y-1">
          {rows.map((r, i) => (
            <li key={r.key ?? i}>
              <button type="button" onClick={r.onClick} className="flex w-full items-center justify-between gap-2 rounded border border-keep-rule/60 bg-keep-bg/40 px-3 py-1.5 text-left text-sm hover:border-keep-action/40">
                <span className="min-w-0 truncate">{r.label}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted">{r.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntityCard({ entity, onClick }: { entity: WorldEntityLight; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 rounded-lg border border-keep-rule/60 bg-keep-bg/40 p-2 text-left hover:border-keep-action/50">
      {entity.imageUrl ? (
        <img
          src={entity.imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
          className="h-10 w-10 shrink-0 rounded border border-keep-rule/40 object-cover"
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{entity.name}</span>
        {entity.summary ? <span className="block truncate text-[11px] text-keep-muted">{entity.summary}</span> : null}
      </span>
    </button>
  );
}

/** "Show on map" chip on wiki entry views whose entry has a map marker. */
function ShowOnMapChip({ mapRef, onShowOnMap }: { mapRef: WorldEntityMapRef | null; onShowOnMap?: ((ref: WorldEntityMapRef) => void) | undefined }) {
  const { t } = useTranslation("worlds");
  if (!mapRef || !onShowOnMap) return null;
  return (
    <button
      type="button"
      onClick={() => onShowOnMap(mapRef)}
      title={t("maps.showOnMapTitle")}
      className="mt-1.5 flex w-fit items-center gap-1 rounded border border-keep-action/50 px-2 py-0.5 text-[11px] text-keep-action hover:bg-keep-action/10"
    >
      <MapPin className="h-3 w-3" aria-hidden="true" />
      {t("maps.showOnMap")}
    </button>
  );
}

function EntityDetail({ worldId, entityId, onBack, onOpenEntry, mapRefFor, onShowOnMap }: {
  worldId: string;
  entityId: string;
  onBack: () => void;
  onOpenEntry: (kind: string, slug: string) => void;
  mapRefFor?: (kind: string, slug: string) => WorldEntityMapRef | null;
  onShowOnMap?: (ref: WorldEntityMapRef) => void;
}) {
  const { t } = useTranslation("worlds");
  const [entity, setEntity] = useState<WorldEntity | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setEntity(null); setErr(null);
    fetchWorldEntity(worldId, entityId).then((e) => { if (alive) setEntity(e); }).catch((x) => { if (alive) setErr(x instanceof Error ? x.message : t("errors.loadFailed")); });
    return () => { alive = false; };
    // `t` deliberately omitted: a language flip must not refetch the entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, entityId]);
  if (err) return <p className="text-xs text-keep-accent">{err}</p>;
  if (!entity) return <p className="italic text-keep-muted">{t("common:loading")}</p>;
  const stats = Object.entries(entity.stats);
  return (
    <article id={anchorIdFor(entity.kind, entity.slug)}>
      <button type="button" onClick={onBack} className="mb-2 text-xs text-keep-muted hover:text-keep-action">{t("kb.back")}</button>
      <div className="flex items-start gap-3">
        {entity.imageUrl ? (
          <img
            src={entity.imageUrl}
            alt=""
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={(e) => { e.currentTarget.style.display = "none"; }}
            className="h-20 w-20 shrink-0 rounded border border-keep-rule/40 object-cover"
          />
        ) : null}
        <div className="min-w-0">
          <h3 className="font-action text-xl">{entity.name}</h3>
          {entity.summary ? <p className="text-sm text-keep-muted">{entity.summary}</p> : null}
          {entity.tags.length > 0 ? <div className="mt-1 flex flex-wrap gap-1">{entity.tags.map((t) => <span key={t} className="rounded border border-keep-rule/60 px-1.5 py-0.5 text-[10px] text-keep-muted">{t}</span>)}</div> : null}
          <ShowOnMapChip mapRef={mapRefFor?.(entity.kind, entity.slug) ?? null} onShowOnMap={onShowOnMap} />
        </div>
      </div>
      {stats.length > 0 ? (
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-2">
          {stats.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-keep-rule/40 py-1">
              <dt className="uppercase tracking-widest text-keep-text/80">{k}</dt><dd className="truncate text-right">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <BodyHtml html={entity.bodyHtml} onOpenEntry={onOpenEntry} className="mt-3" />
    </article>
  );
}

function SessionDetail({ worldId, sessionId, onBack, onOpenEntry }: { worldId: string; sessionId: string; onBack: () => void; onOpenEntry: (kind: string, slug: string) => void }) {
  const { t } = useTranslation("worlds");
  const [session, setSession] = useState<WorldSession | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSession(null); setErr(null);
    fetchWorldSession(worldId, sessionId).then((s) => { if (alive) setSession(s); }).catch((x) => { if (alive) setErr(x instanceof Error ? x.message : t("errors.loadFailed")); });
    return () => { alive = false; };
    // `t` deliberately omitted: a language flip must not refetch the log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, sessionId]);
  if (err) return <p className="text-xs text-keep-accent">{err}</p>;
  if (!session) return <p className="italic text-keep-muted">{t("common:loading")}</p>;
  return (
    <article>
      <button type="button" onClick={onBack} className="mb-2 text-xs text-keep-muted hover:text-keep-action">{t("kb.back")}</button>
      <h3 className="font-action text-xl">{session.title}</h3>
      {session.sessionDate ? <p className="text-[11px] tabular-nums text-keep-muted">{new Date(session.sessionDate).toISOString().slice(0, 10)}</p> : null}
      {session.summary ? <p className="mt-1 text-sm text-keep-muted">{session.summary}</p> : null}
      <BodyHtml html={session.bodyHtml} onOpenEntry={onOpenEntry} className="mt-3" />
    </article>
  );
}

/** Sanitized + legibility-nudged HTML body with `@kind:slug` chips wired. */
function BodyHtml({ html, onOpenEntry, className }: { html: string; onOpenEntry: (kind: string, slug: string) => void; className?: string }) {
  const { t } = useTranslation("worlds");
  const themeBg = useActiveTheme().bg;
  const ref = useRef<HTMLDivElement | null>(null);
  const safe = useMemo(() => html.trim() ? legibleHtmlColors(sanitizeUserHtml(html), themeBg) : "", [html, themeBg]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    decorateWorldMentionsIn(el);
    const handler = makeWorldChipClickHandler(onOpenEntry);
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, [safe, onOpenEntry]);
  if (!safe) return <p className="italic text-keep-muted">{t("kb.nothingWritten")}</p>;
  return (
    <div
      ref={ref}
      className={`prose prose-sm max-w-none text-sm leading-relaxed [&_a]:text-keep-action [&_blockquote]:border-l-2 [&_blockquote]:border-keep-rule [&_blockquote]:pl-3 [&_h3]:font-action [&_h4]:font-action [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 ${USER_HTML_SCOPE_CLASS} ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

function PageView({ page, onOpenEntry, mapRefFor, onShowOnMap }: {
  page: WorldPage | null;
  onOpenEntry: (kind: string, slug: string) => void;
  mapRefFor?: (kind: string, slug: string) => WorldEntityMapRef | null;
  onShowOnMap?: (ref: WorldEntityMapRef) => void;
}) {
  const { t } = useTranslation("worlds");
  if (!page) return <p className="italic text-keep-muted">{t("kb.pickLorePage")}</p>;
  return (
    <article id={anchorIdFor("lore", page.slug)}>
      <h3 className="mb-2 font-action text-xl">{page.title}</h3>
      <ShowOnMapChip mapRef={mapRefFor?.("lore", page.slug) ?? null} onShowOnMap={onShowOnMap} />
      <BodyHtml html={page.bodyHtml} onOpenEntry={onOpenEntry} />
    </article>
  );
}

function ViewerTree({ nodes, selectedId, onSelect }: { nodes: WorldTreeNode[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((n) => (
        <li key={n.page.id}>
          <button type="button" onClick={() => onSelect(n.page.id)}
            className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${selectedId === n.page.id ? "bg-keep-action/15 text-keep-action" : "hover:bg-keep-muted/25"}`}
            style={{ paddingLeft: `${n.depth * 12 + 8}px` }} title={n.page.title}>
            {n.page.title}
          </button>
          {n.children.length > 0 ? <ViewerTree nodes={n.children} selectedId={selectedId} onSelect={onSelect} /> : null}
        </li>
      ))}
    </ul>
  );
}

function MemberGallery({ members }: { members: WorldMemberRef[] }) {
  const { t } = useTranslation("worlds");
  if (members.length === 0) return null;
  return (
    <section aria-label={t("kb.membersRegion")}>
      <header className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">{t("kb.members")}</span>
        <span className="text-[10px] text-keep-muted">{members.length}</span>
      </header>
      <div className="flex flex-wrap gap-2 overflow-hidden" style={{ maxHeight: 96 }}>
        {members.map((m) => {
          const cropStyle = cropStyleFor(m.avatarCrop);
          const title = m.characterId !== null ? t("kb.memberTitle", { name: m.displayName, username: m.username }) : m.displayName;
          return (
            <span key={m.userId} title={title} className="relative inline-block h-9 w-9 shrink-0 overflow-hidden rounded-full border border-keep-rule bg-keep-bg">
              {m.avatarUrl ? (
                <img src={m.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" style={cropStyle} />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-keep-muted">{m.displayName.slice(0, 2).toUpperCase()}</span>
              )}
            </span>
          );
        })}
      </div>
    </section>
  );
}
