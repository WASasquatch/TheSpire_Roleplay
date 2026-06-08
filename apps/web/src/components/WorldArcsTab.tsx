/**
 * Arc editor for the WorldEditorModal right pane. Arcs are storyline groupings
 * (with a status) that pages / entries / sessions can belong to. Arc rows ship
 * full in WorldDetail, so this edits in place without an extra fetch.
 */
import { useState } from "react";
import type { WorldArc, WorldArcStatus, WorldDetail } from "@thekeep/shared";
import { WORLD_ARC_STATUSES, deriveSlug } from "@thekeep/shared";
import { createWorldArc, deleteWorldArc, updateWorldArc } from "../lib/worldEntities.js";

export function WorldArcsTab({
  worldId, detail, onChanged,
}: {
  worldId: string;
  detail: WorldDetail;
  onChanged: () => Promise<void> | void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const selected = detail.arcs.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-action text-sm uppercase tracking-widest text-keep-muted">Arcs</h3>
        <button type="button" onClick={() => { setCreating(true); setSelectedId(null); }} className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs hover:bg-keep-banner">+ New arc</button>
      </div>
      {err ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div> : null}

      {creating ? (
        <ArcEditor worldId={worldId} onCancel={() => setCreating(false)} onSaved={async (a) => { setCreating(false); await onChanged(); setSelectedId(a.id); }} onError={setErr} />
      ) : selected ? (
        <ArcEditor key={selected.id} worldId={worldId} arc={selected} onCancel={() => setSelectedId(null)} onSaved={async () => { await onChanged(); }} onDeleted={async () => { setSelectedId(null); await onChanged(); }} onError={setErr} />
      ) : detail.arcs.length === 0 ? (
        <p className="italic text-keep-muted">No arcs yet.</p>
      ) : (
        <ul className="space-y-1">
          {detail.arcs.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => setSelectedId(a.id)} className="flex w-full items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1.5 text-left text-sm hover:border-keep-action/40">
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.color ?? "var(--keep-action)" }} />
                <span className="min-w-0 flex-1 truncate font-semibold">{a.title}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted">{a.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArcEditor({
  worldId, arc, onCancel, onSaved, onDeleted, onError,
}: {
  worldId: string;
  arc?: WorldArc;
  onCancel: () => void;
  onSaved: (a: WorldArc) => void | Promise<void>;
  onDeleted?: () => void | Promise<void>;
  onError: (m: string | null) => void;
}) {
  const [title, setTitle] = useState(arc?.title ?? "");
  const [slug, setSlug] = useState(arc?.slug ?? "");
  const [slugDirty, setSlugDirty] = useState(!!arc);
  const [summary, setSummary] = useState(arc?.summary ?? "");
  const [status, setStatus] = useState<WorldArcStatus>(arc?.status ?? "active");
  const [color, setColor] = useState(arc?.color ?? "");
  const [busy, setBusy] = useState(false);
  const effectiveSlug = slugDirty ? slug : deriveSlug(title);

  async function save() {
    if (busy) return;
    onError(null);
    setBusy(true);
    try {
      const input = { title: title.trim(), slug: effectiveSlug, summary, status, color: color.trim() || null };
      const a = arc ? await updateWorldArc(worldId, arc.id, input) : await createWorldArc(worldId, input);
      await onSaved(a);
    } catch (x) {
      onError(x instanceof Error ? x.message : "save failed");
    } finally { setBusy(false); }
  }
  async function remove() {
    if (!arc || busy) return;
    if (!window.confirm(`Delete arc "${title}"? Entries/pages/sessions keep existing but lose this arc.`)) return;
    setBusy(true);
    try { await deleteWorldArc(worldId, arc.id); await onDeleted?.(); }
    catch (x) { onError(x instanceof Error ? x.message : "delete failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-bg/30 p-3 text-sm">
      <label className="block"><span className="text-[11px] uppercase tracking-widest text-keep-muted">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" /></label>
      <label className="block"><span className="text-[11px] uppercase tracking-widest text-keep-muted">Slug</span>
        <input value={effectiveSlug} onChange={(e) => { setSlug(e.target.value); setSlugDirty(true); }} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs" /></label>
      <label className="block"><span className="text-[11px] uppercase tracking-widest text-keep-muted">Summary</span>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" /></label>
      <div className="flex items-center gap-3">
        <label className="block"><span className="text-[11px] uppercase tracking-widest text-keep-muted">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as WorldArcStatus)} className="mt-0.5 block rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm">
            {WORLD_ARC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select></label>
        <label className="block"><span className="text-[11px] uppercase tracking-widest text-keep-muted">Color</span>
          <input value={color} onChange={(e) => setColor(e.target.value)} placeholder="#5b8def" className="mt-0.5 w-28 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs" /></label>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button type="button" disabled={busy || !title.trim()} onClick={() => void save()} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action disabled:opacity-50">Save</button>
        <button type="button" onClick={onCancel} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">Cancel</button>
        {arc ? <button type="button" disabled={busy} onClick={() => void remove()} className="ml-auto rounded border border-keep-accent/50 px-3 py-1 text-xs text-keep-accent hover:bg-keep-accent/10">Delete</button> : null}
      </div>
    </div>
  );
}
