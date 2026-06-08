/**
 * The world knowledge-base body, rendered inside WorldViewerModal. Two top-
 * level views: an **Overview** (description, join card, world facts/vibe, and
 * summary cards) and the **Wiki** (a control panel that sorts world content By
 * Type / By Tag / By Arc / By Session). "Lore" is the existing page tree; the
 * other types are world_entities. Bodies render `@kind:slug` cross-link chips.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  WorldDetail, WorldEntity, WorldEntityKindDef, WorldEntityLight, WorldMemberRef, WorldPage, WorldSession,
} from "@thekeep/shared";
import { BUILTIN_WORLD_ENTITY_KINDS, WORLD_VIBE_AXES } from "@thekeep/shared";
import { legibleHtmlColors, sanitizeUserHtml, USER_HTML_SCOPE_CLASS } from "../lib/userHtml.js";
import { useActiveTheme } from "../lib/theme.js";
import { cropStyleFor } from "../lib/avatarCrop.js";
import { buildWorldTree, type WorldTreeNode } from "../lib/worlds.js";
import { fetchWorldEntity, fetchWorldSession } from "../lib/worldEntities.js";
import { anchorIdFor, decorateWorldMentionsIn, flashKbEntry, makeWorldChipClickHandler } from "../lib/worldMentions.js";

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
  const [view, setView] = useState<"overview" | "wiki">("overview");
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
    const custom = detail.entityKinds.map((k) => ({
      key: k.key, label: k.label, description: k.description,
      icon: k.icon ?? "✦", color: k.color ?? "#8a8a8a", sortOrder: k.sortOrder, builtIn: false,
    }));
    return [...BUILTIN_WORLD_ENTITY_KINDS, ...custom];
  }, [detail.entityKinds]);
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
      hits.push({ label: p.title, sub: "Lore", onClick: () => openEntry("lore", p.slug) });
    }
    for (const s of detail.sessions) if (s.title.toLowerCase().includes(q)) {
      hits.push({ label: s.title, sub: "Session", onClick: () => { setView("wiki"); setLens("session"); setOpenSessionId(s.id); } });
    }
    return hits.slice(0, 40);
  }, [search, detail]); // eslint-disable-line react-hooks/exhaustive-deps

  const lenses: Array<[WikiLens, string]> = [["type", "By Type"], ["tag", "By Tag"], ["arc", "By Arc"], ["session", "By Session"]];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top nav: Overview | Wiki + search */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-keep-rule bg-keep-banner/30 px-3 py-1.5">
        <nav className="flex gap-1">
          {([["overview", "Overview"], ["wiki", "Wiki"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => { setView(key); setSearch(""); }}
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
          placeholder="Search titles…"
          className="ml-auto w-44 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
        />
      </div>

      {searchResults ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ResultList title={`${searchResults.length} result${searchResults.length === 1 ? "" : "s"}`} rows={searchResults} />
        </div>
      ) : view === "overview" ? (
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
            <span className="mr-1 text-[10px] uppercase tracking-widest text-keep-muted">Sort by</span>
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

function titleCase(s: string): string {
  return s.split(/[-_]/).map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}
function joinModeLabel(m: string): string {
  return m === "application" ? "By application" : m === "invite-only" ? "Invite-only" : "Open";
}

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
  const w = detail.world;
  const recent = useMemo(() => {
    type R = { key: string; label: string; sub: string; updatedAt: number; onClick: () => void };
    const rows: R[] = [
      ...detail.entities.map((e) => ({ key: `e:${e.id}`, label: e.name, sub: labelFor(e.kind), updatedAt: e.updatedAt, onClick: () => onOpen(e.kind, e.slug) })),
      ...detail.pages.map((p) => ({ key: `p:${p.id}`, label: p.title, sub: "Lore", updatedAt: p.updatedAt, onClick: () => onOpen("lore", p.slug) })),
    ];
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  }, [detail, labelFor, onOpen]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of detail.entities) for (const t of e.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [detail.entities]);

  const arcCounts = (arcId: string) =>
    detail.entities.filter((e) => e.arcId === arcId).length
    + detail.pages.filter((p) => p.arcId === arcId).length
    + detail.sessions.filter((s) => s.arcId === arcId).length;

  const facts: Array<[string, string]> = [];
  if (w.genre) facts.push(["Genre", titleCase(w.genre)]);
  if (w.pacing) facts.push(["Pacing", titleCase(w.pacing)]);
  facts.push(["Status", titleCase(w.status)]);
  facts.push(["Visibility", titleCase(w.visibility)]);
  facts.push(["Join mode", joinModeLabel(w.joinMode ?? "open")]);
  facts.push(["Members", String(w.memberCount)]);
  facts.push(["Lore pages", String(w.pageCount)]);
  facts.push(["Entries", String(detail.entities.length)]);
  if (w.linkedRoomCount > 0) facts.push(["Linked rooms", String(w.linkedRoomCount)]);
  facts.push(["Created", new Date(w.createdAt).toISOString().slice(0, 10)]);

  const vibe = WORLD_VIBE_AXES
    .map((a) => ({ key: a.key, label: a.label, desc: a.desc, value: w.vibeStats[a.key] ?? null }))
    .filter((a) => a.value != null) as Array<{ key: string; label: string; desc: string; value: number }>;

  return (
    <div className="space-y-6 p-4">
      {w.coverImageUrl ? (
        <img src={w.coverImageUrl} alt="" referrerPolicy="no-referrer" className="h-40 w-full rounded-lg border border-keep-rule/60 object-cover" />
      ) : null}

      {/* About — contained, larger copy. Full-width so a short description
          doesn't leave a tall dead block beside the sidebar. */}
      <section className="rounded-lg border border-keep-rule/60 bg-keep-bg/40 p-4">
        <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-keep-muted">About</h3>
        {w.description ? (
          <p className="whitespace-pre-wrap text-base leading-relaxed">{w.description}</p>
        ) : (
          <p className="italic text-keep-muted">This world has no description yet.</p>
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
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-keep-muted">Vibe</h3>
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
          <h3 className="text-[10px] uppercase tracking-widest text-keep-muted">Contents</h3>
          <button type="button" onClick={onGoWiki} className="text-[11px] text-keep-action hover:underline">Open wiki →</button>
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
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-keep-muted">Recently edited</h3>
          <ResultList rows={recent} />
        </section>
      ) : null}

      {detail.arcs.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-keep-muted">Arcs</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {detail.arcs.map((a) => (
              <button key={a.id} type="button" onClick={() => onPickArc(a.id)} className="flex items-center gap-2 rounded-lg border border-keep-rule/60 bg-keep-bg/40 p-3 text-left hover:border-keep-action/50">
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.color ?? "var(--keep-action)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{a.title}</span>
                  <span className="block text-[10px] uppercase tracking-widest text-keep-muted">{a.status}</span>
                </span>
                <span className="shrink-0 font-action text-lg tabular-nums">{arcCounts(a.id)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {tagCounts.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[10px] uppercase tracking-widest text-keep-muted">Tags</h3>
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
  const w = detail.world;
  const wrap = (text: string, action: ReactNode) => (
    <div className="flex h-full flex-col justify-center rounded-lg border border-keep-action/40 bg-keep-action/5 p-4">
      <p className="mb-2 text-sm">{text}</p>
      {action}
    </div>
  );
  const btn = "keep-button rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-sm text-keep-action disabled:opacity-50";

  if (detail.viewerIsMember) {
    return wrap("You're a member of this world.", (
      <button type="button" disabled={membership.busy} onClick={membership.onLeave} className="keep-button rounded border border-keep-accent/50 px-3 py-1 text-sm text-keep-accent disabled:opacity-50">Leave world</button>
    ));
  }
  if (w.visibility !== "open") return null; // no public path
  if (!membership.isAuthenticated) return wrap("Sign in to join this world.", null);
  const joinMode = w.joinMode ?? "open";
  if (joinMode === "invite-only") {
    return wrap("This world is invite-only — the author adds members directly. Message them if you'd like in.", null);
  }
  if (joinMode === "application") {
    const app = detail.viewerApplication;
    if (app && app.status === "pending") return wrap("Your application is pending the author's review.", null);
    return wrap("This world accepts applications to join.", (
      <button type="button" disabled={membership.busy} onClick={membership.onApply} className={btn}>{app && app.status === "rejected" ? "Reapply" : "Apply to join"}</button>
    ));
  }
  return wrap("This world is open — join as your current identity.", (
    <button type="button" disabled={membership.busy} onClick={membership.onJoin} className={btn}>Join world</button>
  ));
}

/* ---------- By Type ---------- */

function TypePanel({
  worldId, detail, kindDefs, activeKind, setActiveKind, selectedPageId, setSelectedPageId, openEntityId, setOpenEntityId, onOpenEntry,
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
}) {
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
          tree.length === 0 ? <p className="italic text-keep-muted">No Lore pages yet.</p> : (
            <div className="flex flex-col gap-4 md:flex-row">
              <div className="md:w-56 md:shrink-0">
                <ViewerTree nodes={tree} selectedId={selectedPageId} onSelect={setSelectedPageId} />
              </div>
              <div className="min-w-0 flex-1">
                <PageView page={selectedPage} onOpenEntry={onOpenEntry} />
              </div>
            </div>
          )
        ) : openEntityId ? (
          <EntityDetail worldId={worldId} entityId={openEntityId} onBack={() => setOpenEntityId(null)} onOpenEntry={onOpenEntry} />
        ) : entries.length === 0 ? (
          <p className="italic text-keep-muted">No entries of this kind.</p>
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
        {tags.length === 0 ? <p className="italic text-keep-muted">No tagged entries yet.</p> : null}
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
  const arc = activeArc ? detail.arcs.find((a) => a.id === activeArc) ?? null : null;
  const rows = useMemo(() => {
    if (!activeArc) return [];
    type R = { key: string; label: string; sub: string; onClick: () => void };
    const out: R[] = [
      ...detail.entities.filter((e) => e.arcId === activeArc).map((e) => ({ key: `e:${e.id}`, label: e.name, sub: labelFor(e.kind), onClick: () => onOpen(e.kind, e.slug) })),
      ...detail.pages.filter((p) => p.arcId === activeArc).map((p) => ({ key: `p:${p.id}`, label: p.title, sub: "Lore", onClick: () => onOpen("lore", p.slug) })),
      ...detail.sessions.filter((s) => s.arcId === activeArc).map((s) => ({ key: `s:${s.id}`, label: s.title, sub: "Session", onClick: () => onOpenSession(s.id) })),
    ];
    return out;
  }, [activeArc, detail, labelFor, onOpen, onOpenSession]);
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap gap-1.5">
        {detail.arcs.map((a) => (
          <button key={a.id} type="button" onClick={() => setActiveArc(a.id)} className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${activeArc === a.id ? "border-keep-action text-keep-action" : "border-keep-rule/60 hover:border-keep-action/50"}`}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: a.color ?? "var(--keep-action)" }} />{a.title}
            <span className="text-[10px] uppercase text-keep-muted">{a.status}</span>
          </button>
        ))}
        {detail.arcs.length === 0 ? <p className="italic text-keep-muted">No arcs yet.</p> : null}
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
  if (openSessionId) {
    return <div className="p-4"><SessionDetail worldId={worldId} sessionId={openSessionId} onBack={() => setOpenSessionId(null)} onOpenEntry={onOpenEntry} /></div>;
  }
  return (
    <div className="p-4">
      {detail.sessions.length === 0 ? <p className="italic text-keep-muted">No sessions logged yet.</p> : (
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

/* ---------- Shared building blocks ---------- */

function ResultList({ title, rows }: { title?: string; rows: Array<{ key?: string; label: string; sub: string; onClick: () => void }> }) {
  return (
    <div className="space-y-1">
      {title ? <div className="text-[10px] uppercase tracking-widest text-keep-muted">{title}</div> : null}
      {rows.length === 0 ? <p className="italic text-keep-muted">Nothing here.</p> : (
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
      {entity.imageUrl ? <img src={entity.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded border border-keep-rule/40 object-cover" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{entity.name}</span>
        {entity.summary ? <span className="block truncate text-[11px] text-keep-muted">{entity.summary}</span> : null}
      </span>
    </button>
  );
}

function EntityDetail({ worldId, entityId, onBack, onOpenEntry }: { worldId: string; entityId: string; onBack: () => void; onOpenEntry: (kind: string, slug: string) => void }) {
  const [entity, setEntity] = useState<WorldEntity | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setEntity(null); setErr(null);
    fetchWorldEntity(worldId, entityId).then((e) => { if (alive) setEntity(e); }).catch((x) => { if (alive) setErr(x instanceof Error ? x.message : "load failed"); });
    return () => { alive = false; };
  }, [worldId, entityId]);
  if (err) return <p className="text-xs text-keep-accent">{err}</p>;
  if (!entity) return <p className="italic text-keep-muted">Loading…</p>;
  const stats = Object.entries(entity.stats);
  return (
    <article id={anchorIdFor(entity.kind, entity.slug)}>
      <button type="button" onClick={onBack} className="mb-2 text-xs text-keep-muted hover:text-keep-action">← Back</button>
      <div className="flex items-start gap-3">
        {entity.imageUrl ? <img src={entity.imageUrl} alt="" className="h-20 w-20 shrink-0 rounded border border-keep-rule/40 object-cover" /> : null}
        <div className="min-w-0">
          <h3 className="font-action text-xl">{entity.name}</h3>
          {entity.summary ? <p className="text-sm text-keep-muted">{entity.summary}</p> : null}
          {entity.tags.length > 0 ? <div className="mt-1 flex flex-wrap gap-1">{entity.tags.map((t) => <span key={t} className="rounded border border-keep-rule/60 px-1.5 py-0.5 text-[10px] text-keep-muted">{t}</span>)}</div> : null}
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
  const [session, setSession] = useState<WorldSession | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSession(null); setErr(null);
    fetchWorldSession(worldId, sessionId).then((s) => { if (alive) setSession(s); }).catch((x) => { if (alive) setErr(x instanceof Error ? x.message : "load failed"); });
    return () => { alive = false; };
  }, [worldId, sessionId]);
  if (err) return <p className="text-xs text-keep-accent">{err}</p>;
  if (!session) return <p className="italic text-keep-muted">Loading…</p>;
  return (
    <article>
      <button type="button" onClick={onBack} className="mb-2 text-xs text-keep-muted hover:text-keep-action">← Back</button>
      <h3 className="font-action text-xl">{session.title}</h3>
      {session.sessionDate ? <p className="text-[11px] tabular-nums text-keep-muted">{new Date(session.sessionDate).toISOString().slice(0, 10)}</p> : null}
      {session.summary ? <p className="mt-1 text-sm text-keep-muted">{session.summary}</p> : null}
      <BodyHtml html={session.bodyHtml} onOpenEntry={onOpenEntry} className="mt-3" />
    </article>
  );
}

/** Sanitized + legibility-nudged HTML body with `@kind:slug` chips wired. */
function BodyHtml({ html, onOpenEntry, className }: { html: string; onOpenEntry: (kind: string, slug: string) => void; className?: string }) {
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
  if (!safe) return <p className="italic text-keep-muted">Nothing written here yet.</p>;
  return (
    <div
      ref={ref}
      className={`prose prose-sm max-w-none text-sm leading-relaxed [&_a]:text-keep-action [&_blockquote]:border-l-2 [&_blockquote]:border-keep-rule [&_blockquote]:pl-3 [&_h3]:font-action [&_h4]:font-action [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 ${USER_HTML_SCOPE_CLASS} ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

function PageView({ page, onOpenEntry }: { page: WorldPage | null; onOpenEntry: (kind: string, slug: string) => void }) {
  if (!page) return <p className="italic text-keep-muted">Pick a Lore page.</p>;
  return (
    <article id={anchorIdFor("lore", page.slug)}>
      <h3 className="mb-2 font-action text-xl">{page.title}</h3>
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
  if (members.length === 0) return null;
  return (
    <section aria-label="World members">
      <header className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">Members</span>
        <span className="text-[10px] text-keep-muted">{members.length}</span>
      </header>
      <div className="flex flex-wrap gap-2 overflow-hidden" style={{ maxHeight: 96 }}>
        {members.map((m) => {
          const cropStyle = cropStyleFor(m.avatarCrop);
          const title = m.characterId !== null ? `${m.displayName} (${m.username})` : m.displayName;
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
