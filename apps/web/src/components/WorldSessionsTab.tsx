/**
 * Session-log editor for the WorldEditorModal right pane. Sessions are
 * chronological logs that optionally belong to an arc. Light rows ship in
 * WorldDetail; the full body is fetched lazily on edit.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorldDetail } from "@thekeep/shared";
import { BUILTIN_WORLD_ENTITY_KINDS, deriveSlug } from "@thekeep/shared";
import { createWorldSession, deleteWorldSession, fetchWorldSession, updateWorldSession } from "../lib/worldEntities.js";
import { EntryLinkPicker, buildLinkTargets, type LinkTarget } from "./EntryLinkPicker.js";

function dateInputValue(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  // YYYY-MM-DD for <input type="date">, in UTC to match the stored epoch.
  return d.toISOString().slice(0, 10);
}

export function WorldSessionsTab({
  worldId, detail, onChanged,
}: {
  worldId: string;
  detail: WorldDetail;
  onChanged: () => Promise<void> | void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const linkTargets = useMemo(() => {
    const labelByKey = new Map<string, string>([
      ...BUILTIN_WORLD_ENTITY_KINDS.map((k) => [k.key, k.label] as const),
      ...detail.entityKinds.map((k) => [k.key, k.label] as const),
    ]);
    const kindLabel = (k: string) => labelByKey.get(k) ?? k;
    return buildLinkTargets(detail.entities, detail.pages.map((p) => ({ slug: p.slug, title: p.title })), kindLabel);
  }, [detail.entities, detail.pages, detail.entityKinds]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-action text-sm uppercase tracking-widest text-keep-muted">Sessions</h3>
        <button type="button" onClick={() => { setCreating(true); setSelectedId(null); }} className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs hover:bg-keep-banner">+ New session</button>
      </div>
      {err ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div> : null}

      {creating ? (
        <SessionEditor worldId={worldId} detail={detail} targets={linkTargets} onCancel={() => setCreating(false)} onSaved={async (id) => { setCreating(false); await onChanged(); setSelectedId(id); }} onError={setErr} />
      ) : selectedId ? (
        <SessionEditor key={selectedId} worldId={worldId} detail={detail} targets={linkTargets} sessionId={selectedId} onCancel={() => setSelectedId(null)} onSaved={async () => { await onChanged(); }} onDeleted={async () => { setSelectedId(null); await onChanged(); }} onError={setErr} />
      ) : detail.sessions.length === 0 ? (
        <p className="italic text-keep-muted">No sessions yet.</p>
      ) : (
        <ul className="space-y-1">
          {detail.sessions.map((s) => {
            const arc = s.arcId ? detail.arcs.find((a) => a.id === s.arcId) : null;
            return (
              <li key={s.id}>
                <button type="button" onClick={() => setSelectedId(s.id)} className="flex w-full items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1.5 text-left text-sm hover:border-keep-action/40">
                  <span className="min-w-0 flex-1 truncate font-semibold">{s.title}</span>
                  {arc ? <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted">{arc.title}</span> : null}
                  {s.sessionDate ? <span className="shrink-0 text-[10px] tabular-nums text-keep-muted">{dateInputValue(s.sessionDate)}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SessionEditor({
  worldId, detail, targets, sessionId, onCancel, onSaved, onDeleted, onError,
}: {
  worldId: string;
  detail: WorldDetail;
  targets: LinkTarget[];
  sessionId?: string;
  onCancel: () => void;
  onSaved: (id: string) => void | Promise<void>;
  onDeleted?: () => void | Promise<void>;
  onError: (m: string | null) => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [summary, setSummary] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [dateStr, setDateStr] = useState("");
  const [arcId, setArcId] = useState("");
  const [loading, setLoading] = useState(!!sessionId);
  const [busy, setBusy] = useState(false);
  const effectiveSlug = slugDirty ? slug : deriveSlug(title);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    setLoading(true);
    fetchWorldSession(worldId, sessionId)
      .then((s) => {
        if (!alive) return;
        setTitle(s.title); setSlug(s.slug); setSlugDirty(true); setSummary(s.summary);
        setBodyHtml(s.bodyHtml); setDateStr(dateInputValue(s.sessionDate)); setArcId(s.arcId ?? "");
      })
      .catch((x) => onError(x instanceof Error ? x.message : "load failed"))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [worldId, sessionId, onError]);

  async function save() {
    if (busy) return;
    onError(null);
    setBusy(true);
    try {
      const sessionDate = dateStr ? Date.parse(`${dateStr}T00:00:00Z`) : null;
      const input = { title: title.trim(), slug: effectiveSlug, summary, bodyHtml, sessionDate, arcId: arcId || null };
      const s = sessionId ? await updateWorldSession(worldId, sessionId, input) : await createWorldSession(worldId, input);
      await onSaved(s.id);
    } catch (x) {
      onError(x instanceof Error ? x.message : "save failed");
    } finally { setBusy(false); }
  }
  async function remove() {
    if (!sessionId || busy) return;
    if (!window.confirm(`Delete session "${title}"?`)) return;
    setBusy(true);
    try { await deleteWorldSession(worldId, sessionId); await onDeleted?.(); }
    catch (x) { onError(x instanceof Error ? x.message : "delete failed"); }
    finally { setBusy(false); }
  }

  function insertToken(token: string) {
    const ta = bodyRef.current;
    if (!ta) { setBodyHtml((b) => b + token); return; }
    const start = ta.selectionStart ?? bodyHtml.length;
    const end = ta.selectionEnd ?? bodyHtml.length;
    setBodyHtml(bodyHtml.slice(0, start) + token + bodyHtml.slice(end));
    requestAnimationFrame(() => { ta.focus(); const pos = start + token.length; ta.setSelectionRange(pos, pos); });
  }

  if (loading) return <p className="italic text-keep-muted">Loading…</p>;

  return (
    <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-bg/30 p-3 text-sm">
      <label className="block"><span className="text-[11px] uppercase tracking-widest text-keep-muted">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" /></label>
      <label className="block"><span className="text-[11px] uppercase tracking-widest text-keep-muted">Slug</span>
        <input value={effectiveSlug} onChange={(e) => { setSlug(e.target.value); setSlugDirty(true); }} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs" /></label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="block"><span className="text-[11px] uppercase tracking-widest text-keep-muted">Date</span>
          <input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} className="mt-0.5 block rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm" /></label>
        <label className="block"><span className="text-[11px] uppercase tracking-widest text-keep-muted">Arc</span>
          <select value={arcId} onChange={(e) => setArcId(e.target.value)} className="mt-0.5 block rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm">
            <option value="">— none —</option>
            {detail.arcs.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select></label>
      </div>
      <label className="block"><span className="text-[11px] uppercase tracking-widest text-keep-muted">Summary</span>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" /></label>
      <div className="block">
        <div className="mb-0.5 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">Recap / log</span>
          <EntryLinkPicker targets={targets} onPick={insertToken} />
        </div>
        <textarea ref={bodyRef} value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} rows={8} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs" placeholder="HTML allowed. Link entries with @npc:slug, @location:slug …" /></div>
      <div className="flex items-center gap-2 pt-1">
        <button type="button" disabled={busy || !title.trim()} onClick={() => void save()} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action disabled:opacity-50">Save</button>
        <button type="button" onClick={onCancel} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">Cancel</button>
        {sessionId ? <button type="button" disabled={busy} onClick={() => void remove()} className="ml-auto rounded border border-keep-accent/50 px-3 py-1 text-xs text-keep-accent hover:bg-keep-accent/10">Delete</button> : null}
      </div>
    </div>
  );
}
