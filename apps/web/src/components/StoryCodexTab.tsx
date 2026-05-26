import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  StoryDetail,
  StoryEntity,
  StoryEntityKind,
  StoryPlotStatus,
  WorldDetail,
  WorldPage,
} from "@thekeep/shared";
import {
  STORY_ENTITY_BODY_MAX,
  STORY_ENTITY_KINDS,
  STORY_PLOT_STATUSES,
} from "@thekeep/shared";
import { readError } from "../lib/http.js";

interface Props {
  /** Story detail — provides id, allowEdit, linked world id. */
  detail: StoryDetail;
}

/**
 * Editor's Codex tab. Three discriminated sections (characters /
 * locations / plot), each a CRUD list of entities. Selected entity
 * gets a detail editor on the right.
 *
 * When the story is linked to a world (`linkedWorld` set on detail),
 * an extra "Linked world" section surfaces that world's pages as
 * read-only references — the author can browse their world's lore
 * without leaving the editor, but can't edit it from here.
 *
 * Self-contained: owns its own fetches + state so the parent
 * StoryEditorModal doesn't have to thread entity state through.
 */
export function StoryCodexTab({ detail }: Props) {
  const storyId = detail.story.id;
  const linkedWorldId = detail.story.linkedWorld?.id ?? null;
  const [entities, setEntities] = useState<StoryEntity[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingKind, setCreatingKind] = useState<StoryEntityKind | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/stories/${storyId}/codex`);
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { entities: StoryEntity[] };
      setEntities(j.entities);
      if (selectedId && !j.entities.find((e) => e.id === selectedId)) {
        setSelectedId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId]);

  useEffect(() => { void load(); }, [load]);

  // Group entities by kind for the rail.
  const grouped = useMemo(() => {
    const out: Record<StoryEntityKind, StoryEntity[]> = {
      character: [],
      location: [],
      plot: [],
    };
    for (const e of entities ?? []) out[e.kind].push(e);
    return out;
  }, [entities]);

  const selected = selectedId
    ? (entities ?? []).find((e) => e.id === selectedId) ?? null
    : null;

  async function deleteEntity(e: StoryEntity) {
    if (!window.confirm(`Delete ${e.kind} "${e.name}"? Cannot be undone.`)) return;
    try {
      const r = await fetch(`/stories/${storyId}/codex/${e.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await readError(r));
      if (selectedId === e.id) setSelectedId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-keep-rule md:w-72 md:border-r">
        {error ? (
          <p className="border-b border-keep-rule bg-keep-accent/10 px-2 py-1 text-[11px] text-keep-accent">{error}</p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {STORY_ENTITY_KINDS.map((kind) => (
            <KindSection
              key={kind}
              kind={kind}
              entities={grouped[kind]}
              selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setCreatingKind(null); }}
              onAdd={() => { setCreatingKind(kind); setSelectedId(null); }}
              onDelete={deleteEntity}
            />
          ))}
          {linkedWorldId ? (
            <LinkedWorldPanel worldId={linkedWorldId} />
          ) : null}
        </div>
      </aside>

      <section className="min-h-0 flex-1 overflow-y-auto">
        {creatingKind ? (
          <NewEntityForm
            storyId={storyId}
            kind={creatingKind}
            onCancel={() => setCreatingKind(null)}
            onCreated={async (entity) => {
              setCreatingKind(null);
              await load();
              setSelectedId(entity.id);
            }}
          />
        ) : selected ? (
          <EntityEditor
            key={selected.id}
            storyId={storyId}
            entity={selected}
            onSaved={() => load()}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-keep-muted">
            {entities && entities.length === 0
              ? "No codex entries yet. Add a character, location, or plot point on the left."
              : "Pick an entity on the left to edit."}
          </div>
        )}
      </section>
    </div>
  );
}

/* =============================================================
 *  Rail sections
 * ============================================================= */

function KindSection({
  kind,
  entities,
  selectedId,
  onSelect,
  onAdd,
  onDelete,
}: {
  kind: StoryEntityKind;
  entities: StoryEntity[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: (e: StoryEntity) => void;
}) {
  return (
    <div className="border-b border-keep-rule/40">
      <div className="flex items-center justify-between border-b border-keep-rule/40 bg-keep-banner/40 px-3 py-1.5 text-xs">
        <span className="uppercase tracking-widest text-keep-muted">{labelForKind(kind)}</span>
        <button
          type="button"
          onClick={onAdd}
          className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-[11px] hover:bg-keep-banner"
          title={`Add a ${kind}`}
        >
          + {kind === "plot" ? "Point" : kind}
        </button>
      </div>
      {entities.length === 0 ? (
        <p className="px-3 py-2 text-[11px] italic text-keep-muted">No {kind === "plot" ? "plot points" : `${kind}s`} yet.</p>
      ) : (
        <ul>
          {entities.map((e) => {
            const selected = selectedId === e.id;
            return (
              <li
                key={e.id}
                className={`group flex items-center gap-1 px-2 py-1 ${
                  selected ? "bg-keep-action/15" : "hover:bg-keep-muted/20"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(e.id)}
                  className="min-w-0 flex-1 truncate text-left text-xs"
                  title={e.name}
                >
                  <span className={selected ? "text-keep-action" : "text-keep-text"}>{e.name}</span>
                  {kind === "plot" && e.stats.status ? (
                    <span className={`ml-1.5 rounded px-1 py-0 text-[9px] uppercase tracking-widest ${plotStatusClass(e.stats.status as StoryPlotStatus)}`}>
                      {e.stats.status}
                    </span>
                  ) : null}
                  {e.isPublic ? (
                    <span className="ml-1 text-[9px] uppercase tracking-widest text-keep-action/70" title="Surfaces in the reader's Cast & Places appendix">pub</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(e)}
                  className="rounded border border-keep-accent/40 px-1 text-[10px] text-keep-accent opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                  title="Delete"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Read-only side panel for the linked world's pages. Authors browse
 * their own lore without leaving the editor.
 */
function LinkedWorldPanel({ worldId }: { worldId: string }) {
  const [detail, setDetail] = useState<WorldDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openPageId, setOpenPageId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/worlds/${worldId}`, { credentials: "include" })
      .then(async (r) => (r.ok ? ((await r.json()) as WorldDetail) : null))
      .then((j) => { if (!cancelled && j && "world" in j) setDetail(j); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "load failed"); });
    return () => { cancelled = true; };
  }, [worldId]);

  const openPage = openPageId ? detail?.pages.find((p) => p.id === openPageId) ?? null : null;

  return (
    <div className="border-b border-keep-rule/40">
      <div className="border-b border-keep-rule/40 bg-keep-banner/40 px-3 py-1.5 text-xs">
        <span className="uppercase tracking-widest text-keep-muted">Linked World (read-only)</span>
      </div>
      {err ? <p className="px-3 py-1 text-[11px] text-keep-accent">{err}</p> : null}
      {detail === null ? (
        <p className="px-3 py-2 text-[11px] italic text-keep-muted">Loading world…</p>
      ) : (
        <>
          <p className="px-3 py-2 text-[11px] text-keep-muted">
            <span className="text-keep-text">{detail.world.name}</span> — {detail.world.pageCount}{" "}
            {detail.world.pageCount === 1 ? "page" : "pages"}
          </p>
          <ul>
            {detail.pages.slice(0, 30).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setOpenPageId(openPageId === p.id ? null : p.id)}
                  className={`block w-full truncate px-3 py-1 text-left text-xs ${
                    openPageId === p.id ? "bg-keep-action/15 text-keep-action" : "text-keep-muted hover:text-keep-text"
                  }`}
                >
                  {p.title}
                </button>
                {openPageId === p.id && openPage ? (
                  <div className="border-t border-keep-rule/30 bg-keep-bg/30 px-3 py-2 text-[11px]">
                    <div
                      className="prose prose-sm max-w-none text-keep-text/85"
                      dangerouslySetInnerHTML={{ __html: openPage.bodyHtml || "<p><i>(empty page)</i></p>" }}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {detail.pages.length > 30 ? (
            <p className="px-3 py-1 text-[10px] italic text-keep-muted">
              + {detail.pages.length - 30} more pages — open in World viewer for the full tree.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/* =============================================================
 *  New entity wizard + editor
 * ============================================================= */

function NewEntityForm({
  storyId,
  kind,
  onCancel,
  onCreated,
}: {
  storyId: string;
  kind: StoryEntityKind;
  onCancel: () => void;
  onCreated: (e: StoryEntity) => void;
}) {
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${storyId}/codex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          name: name.trim(),
          ...(summary.trim() ? { summary: summary.trim() } : {}),
          // Plot entries start at "planned" by default; characters and
          // locations have no required initial stats.
          ...(kind === "plot" ? { stats: { status: "planned" } } : {}),
        }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const entity = (await r.json()) as StoryEntity;
      onCreated(entity);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 p-4">
      <h3 className="font-action text-base">New {labelForKind(kind).slice(0, -1)}</h3>
      {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5"
        />
      </div>
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">One-liner</label>
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={500}
          placeholder={placeholderFor(kind)}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm"
        />
      </div>
      <div className="flex items-center justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm text-keep-muted hover:text-keep-text">
          Cancel
        </button>
        <button type="submit" disabled={busy || !name.trim()}
          className="rounded border border-keep-action bg-keep-action px-4 py-1 text-sm font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

function EntityEditor({
  storyId,
  entity,
  onSaved,
}: {
  storyId: string;
  entity: StoryEntity;
  onSaved: () => Promise<void> | void;
}) {
  const [name, setName] = useState(entity.name);
  const [slug, setSlug] = useState(entity.slug);
  const [summary, setSummary] = useState(entity.summary);
  const [bodyHtml, setBodyHtml] = useState(entity.bodyHtml);
  const [imageUrl, setImageUrl] = useState(entity.imageUrl ?? "");
  const [isPublic, setIsPublic] = useState(entity.isPublic);
  const [stats, setStats] = useState<Record<string, string>>(entity.stats);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (name.trim() !== entity.name) body.name = name.trim();
      if (slug.trim() && slug.trim().toLowerCase() !== entity.slug) body.slug = slug.trim().toLowerCase();
      if (summary !== entity.summary) body.summary = summary;
      if (bodyHtml !== entity.bodyHtml) body.bodyHtml = bodyHtml;
      const imageNext = imageUrl.trim() === "" ? null : imageUrl.trim();
      if (imageNext !== (entity.imageUrl ?? null)) body.imageUrl = imageNext;
      if (isPublic !== entity.isPublic) body.isPublic = isPublic;
      if (JSON.stringify(stats) !== JSON.stringify(entity.stats)) body.stats = stats;
      if (Object.keys(body).length === 0) { setBusy(false); return; }
      const r = await fetch(`/stories/${storyId}/codex/${entity.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      setSavedAt(Date.now());
      await onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 p-4">
      {err ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div> : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-keep-muted">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
            className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-keep-muted">Slug</label>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} maxLength={60}
            className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 font-mono text-sm" />
        </div>
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">One-liner</label>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={500}
          placeholder={placeholderFor(entity.kind)}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm" />
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">
          Long description (HTML allowed; sanitized)
        </label>
        <textarea value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} maxLength={STORY_ENTITY_BODY_MAX} rows={8}
          placeholder={bodyPlaceholderFor(entity.kind)}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 font-mono text-xs" />
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">Image URL (https only)</label>
        <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..."
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm" />
        {imageUrl ? (
          <img src={imageUrl} alt="" referrerPolicy="no-referrer"
            className="mt-2 h-32 w-auto rounded border border-keep-rule object-cover" />
        ) : null}
      </div>

      {/* Per-kind stats. Plot has a status enum; characters + locations
          have a free-form key/value table the author fills in. */}
      <EntityStatsRow kind={entity.kind} stats={stats} setStats={setStats} />

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
        <span>
          Public — surfaces in the story's reader Cast &amp; Places appendix.
          {" "}
          <span className="text-keep-muted">Default off (continuity notes stay author-only).</span>
        </span>
      </label>

      <div className="flex items-center justify-end gap-3 border-t border-keep-rule pt-3">
        {savedAt ? <span className="text-[11px] italic text-keep-muted">Saved</span> : null}
        <button type="submit" disabled={busy}
          className="rounded border border-keep-action bg-keep-action px-4 py-1 text-sm font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function EntityStatsRow({
  kind,
  stats,
  setStats,
}: {
  kind: StoryEntityKind;
  stats: Record<string, string>;
  setStats: (next: Record<string, string>) => void;
}) {
  if (kind === "plot") {
    const status = (stats.status as StoryPlotStatus | undefined) ?? "planned";
    return (
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">Plot status</label>
        <div className="mt-1 flex flex-wrap gap-1">
          {STORY_PLOT_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStats({ ...stats, status: s })}
              className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-widest ${
                status === s
                  ? plotStatusClass(s) + " border-current"
                  : "border-keep-rule bg-keep-bg text-keep-muted hover:text-keep-text"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  }
  // Characters + locations — free-form key/value table.
  return <FreeformStats stats={stats} setStats={setStats} kind={kind} />;
}

function FreeformStats({
  stats,
  setStats,
  kind,
}: {
  stats: Record<string, string>;
  setStats: (next: Record<string, string>) => void;
  kind: StoryEntityKind;
}) {
  // Drop the reserved `status` key from the user-editable view; plot
  // status has its own controlled chip above (this branch only runs
  // for character + location). Keeps the freeform table from
  // accidentally exposing a writable "status" field that collides.
  const entries = Object.entries(stats).filter(([k]) => k !== "status");
  const [draftKey, setDraftKey] = useState("");
  const [draftVal, setDraftVal] = useState("");

  function add() {
    const k = draftKey.trim();
    const v = draftVal.trim();
    if (!k || stats[k] !== undefined) return;
    setStats({ ...stats, [k]: v });
    setDraftKey("");
    setDraftVal("");
  }
  function update(k: string, v: string) {
    setStats({ ...stats, [k]: v });
  }
  function remove(k: string) {
    const next = { ...stats };
    delete next[k];
    setStats(next);
  }

  const hint = kind === "character" ? "e.g. age, race, gender, alignment" : "e.g. region, climate, population";

  return (
    <div>
      <label className="block text-[10px] uppercase tracking-widest text-keep-muted">Stats</label>
      <p className="mt-0.5 text-[10px] text-keep-muted">{hint}</p>
      {entries.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {entries.map(([k, v]) => (
            <li key={k} className="flex items-center gap-1">
              <input value={k} disabled
                className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs font-mono opacity-70" />
              <input value={v} onChange={(e) => update(k, e.target.value)} maxLength={500}
                className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs" />
              <button type="button" onClick={() => remove(k)}
                className="rounded border border-keep-accent/40 px-1.5 py-1 text-[10px] text-keep-accent">×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex items-center gap-1">
        <input
          value={draftKey}
          onChange={(e) => setDraftKey(e.target.value)}
          placeholder="key"
          maxLength={50}
          className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs font-mono"
        />
        <input
          value={draftVal}
          onChange={(e) => setDraftVal(e.target.value)}
          placeholder="value"
          maxLength={500}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
        />
        <button type="button" onClick={add} disabled={!draftKey.trim()}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-[11px] text-keep-muted hover:text-keep-text disabled:opacity-40">
          Add
        </button>
      </div>
    </div>
  );
}

/* =============================================================
 *  Display helpers
 * ============================================================= */

function labelForKind(k: StoryEntityKind): string {
  return k === "character" ? "Characters" : k === "location" ? "Locations" : "Plot points";
}

function placeholderFor(k: StoryEntityKind): string {
  return k === "character"
    ? "a one-line who-are-they"
    : k === "location"
      ? "a one-line where-is-it"
      : "a one-line what-pays-off";
}

function bodyPlaceholderFor(k: StoryEntityKind): string {
  return k === "character"
    ? "Long-form bio — backstory, motivations, voice notes…"
    : k === "location"
      ? "Long-form description — geography, history, atmosphere…"
      : "Outline notes — setup beats, payoff beats, character impact…";
}

function plotStatusClass(s: StoryPlotStatus): string {
  switch (s) {
    case "planned":  return "bg-keep-muted/25 text-keep-muted";
    case "setup":    return "bg-sky-500/15 text-sky-300";
    case "payoff":   return "bg-amber-500/15 text-amber-300";
    case "resolved": return "bg-emerald-500/15 text-emerald-300";
  }
}
