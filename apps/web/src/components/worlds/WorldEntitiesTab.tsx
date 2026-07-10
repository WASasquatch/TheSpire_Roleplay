/**
 * World knowledge-base entry editor, rendered in the WorldEditorModal's right
 * pane. Mirrors the Scriptorium StoryCodexTab: pick a kind (built-in
 * Location/NPC/Item/Faction or a custom kind), list its entries, and edit one
 * in place. "Lore" is NOT here — it stays the page tree.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorldDetail, WorldEntity, WorldEntityLight, WorldEntityKindDef } from "@thekeep/shared";
import { BUILTIN_WORLD_ENTITY_KINDS, deriveSlug, parseTagList } from "@thekeep/shared";
import {
  createWorldEntity,
  createWorldEntityKind,
  deleteWorldEntity,
  deleteWorldEntityKind,
  fetchWorldEntity,
  updateWorldEntity,
} from "../../lib/worldEntities.js";
import { EntryLinkPicker, buildLinkTargets, type LinkTarget } from "./EntryLinkPicker.js";

/** Built-in kinds that are real entity rows (drop the synthetic "lore"). */
const BUILTIN_ENTITY_KINDS = BUILTIN_WORLD_ENTITY_KINDS.filter((k) => !k.synthetic);

export function WorldEntitiesTab({
  worldId,
  detail,
  onChanged,
}: {
  worldId: string;
  detail: WorldDetail;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation("worlds");
  const kinds: WorldEntityKindDef[] = useMemo(() => {
    const custom: WorldEntityKindDef[] = detail.entityKinds.map((k) => ({
      key: k.key, label: k.label, description: k.description,
      icon: k.icon ?? "✦", color: k.color ?? "#8a8a8a", sortOrder: k.sortOrder, builtIn: false,
    }));
    // Built-in kind labels/descriptions localize; custom kinds are the
    // owner's own text and render as written.
    const builtIn: WorldEntityKindDef[] = BUILTIN_ENTITY_KINDS.map((k) => ({
      ...k,
      label: t(`kinds.${k.key}.label`),
      description: t(`kinds.${k.key}.description`),
    }));
    return [...builtIn, ...custom];
  }, [detail.entityKinds, t]);

  const [activeKind, setActiveKind] = useState<string>(kinds[0]?.key ?? "npc");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingKind, setAddingKind] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const entriesOfKind = detail.entities.filter((e) => e.kind === activeKind);
  const activeDef = kinds.find((k) => k.key === activeKind);
  const activeIsCustom = !!activeDef && !activeDef.builtIn;
  const kindLabel = (k: string) => kinds.find((x) => x.key === k)?.label ?? k;
  const linkTargets = useMemo(
    () => buildLinkTargets(detail.entities, detail.pages.map((p) => ({ slug: p.slug, title: p.title })), kindLabel),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.entities, detail.pages, detail.entityKinds],
  );

  async function removeActiveKind() {
    if (!activeIsCustom) return;
    if (!window.confirm(t("entities.confirmDeleteKind", { label: activeDef?.label ?? "" }))) return;
    setErr(null);
    try {
      await deleteWorldEntityKind(worldId, activeKind);
      await onChanged();
      setActiveKind(BUILTIN_ENTITY_KINDS[0]?.key ?? "npc");
    } catch (x) {
      setErr(x instanceof Error ? x.message : t("errors.deleteFailed"));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {kinds.map((k) => {
          const count = detail.entities.filter((e) => e.kind === k.key).length;
          return (
            <button
              key={k.key}
              type="button"
              onClick={() => { setActiveKind(k.key); setSelectedId(null); setCreating(false); setAddingKind(false); }}
              className={`flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                activeKind === k.key && !addingKind ? "border-keep-action bg-keep-action/15 text-keep-action" : "border-keep-rule hover:bg-keep-banner"
              }`}
              title={k.description}
            >
              <span aria-hidden>{k.icon}</span>
              <span>{k.label}</span>
              <span className="tabular-nums text-keep-muted">{count}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => { setAddingKind(true); setSelectedId(null); setCreating(false); }}
          className="rounded border border-dashed border-keep-rule px-2 py-1 text-xs text-keep-muted hover:bg-keep-banner"
          title={t("entities.addKindTitle")}
        >
          {t("entities.addKind")}
        </button>
      </div>

      {err ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div> : null}

      {addingKind ? (
        <NewKindForm
          worldId={worldId}
          onCancel={() => setAddingKind(false)}
          onCreated={async (key) => { setAddingKind(false); await onChanged(); setActiveKind(key); }}
          onError={setErr}
        />
      ) : creating ? (
        <EntityEditor
          key={`new-${activeKind}`}
          worldId={worldId}
          kind={activeKind}
          targets={linkTargets}
          onCancel={() => setCreating(false)}
          onSaved={async (e) => { setCreating(false); await onChanged(); setSelectedId(e.id); }}
          onError={setErr}
        />
      ) : selectedId ? (
        <EntityEditor
          key={selectedId}
          worldId={worldId}
          kind={activeKind}
          entityId={selectedId}
          targets={linkTargets}
          onCancel={() => setSelectedId(null)}
          onSaved={async () => { await onChanged(); }}
          onDeleted={async () => { setSelectedId(null); await onChanged(); }}
          onError={setErr}
        />
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs hover:bg-keep-banner"
            >
              {t("entities.newEntry")}
            </button>
            {activeIsCustom ? (
              <button
                type="button"
                onClick={() => void removeActiveKind()}
                className="rounded border border-keep-accent/50 px-2 py-1 text-xs text-keep-accent hover:bg-keep-accent/10"
                title={t("entities.deleteKindTitle")}
              >
                {t("entities.deleteKind")}
              </button>
            ) : null}
          </div>
          {entriesOfKind.length === 0 ? (
            <p className="italic text-keep-muted">{t("entities.noEntries")}</p>
          ) : (
            <ul className="space-y-1">
              {entriesOfKind.map((e: WorldEntityLight) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(e.id)}
                    className="flex w-full items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1.5 text-left text-sm hover:border-keep-action/40"
                  >
                    {e.imageUrl ? (
                      <img src={e.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded border border-keep-rule/40 object-cover" />
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{e.name}</span>
                      {e.summary ? <span className="block truncate text-[11px] text-keep-muted">{e.summary}</span> : null}
                    </span>
                    {!e.isPublic ? <span className="shrink-0 text-[10px] uppercase tracking-widest text-keep-muted">{t("entities.hidden")}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Entity editor (new or existing) ---------- */

function EntityEditor({
  worldId, kind, entityId, targets, onCancel, onSaved, onDeleted, onError,
}: {
  worldId: string;
  kind: string;
  entityId?: string;
  targets: LinkTarget[];
  onCancel: () => void;
  onSaved: (e: WorldEntity) => void | Promise<void>;
  onDeleted?: () => void | Promise<void>;
  onError: (m: string | null) => void;
}) {
  const { t } = useTranslation("worlds");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [summary, setSummary] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [stats, setStats] = useState<Array<[string, string]>>([]);
  const [loading, setLoading] = useState(!!entityId);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!entityId) return;
    let alive = true;
    setLoading(true);
    fetchWorldEntity(worldId, entityId)
      .then((e) => {
        if (!alive) return;
        setName(e.name); setSlug(e.slug); setSlugDirty(true); setSummary(e.summary);
        setBodyHtml(e.bodyHtml); setTagsText(e.tags.join(", ")); setImageUrl(e.imageUrl ?? "");
        setIsPublic(e.isPublic); setStats(Object.entries(e.stats));
      })
      .catch((x) => onError(x instanceof Error ? x.message : t("errors.loadFailed")))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // `t` deliberately omitted: a language flip must not refetch (and reset)
    // an in-progress edit; the fallback error text just stays pre-flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, entityId, onError]);

  const effectiveSlug = slugDirty ? slug : deriveSlug(name);

  async function save() {
    if (busy) return;
    onError(null);
    setBusy(true);
    try {
      const statsObj = Object.fromEntries(stats.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
      const input = {
        name: name.trim(), slug: effectiveSlug, summary, bodyHtml,
        tags: parseTagList(tagsText), imageUrl: imageUrl.trim() || null, isPublic,
        stats: statsObj,
      };
      const e = entityId
        ? await updateWorldEntity(worldId, entityId, input)
        : await createWorldEntity(worldId, { kind, ...input });
      await onSaved(e);
    } catch (x) {
      onError(x instanceof Error ? x.message : t("errors.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!entityId || busy) return;
    if (!window.confirm(t("entities.confirmDelete", { name }))) return;
    setBusy(true);
    try {
      await deleteWorldEntity(worldId, entityId);
      await onDeleted?.();
    } catch (x) {
      onError(x instanceof Error ? x.message : t("errors.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  function insertToken(token: string) {
    const ta = bodyRef.current;
    if (!ta) { setBodyHtml((b) => b + token); return; }
    const start = ta.selectionStart ?? bodyHtml.length;
    const end = ta.selectionEnd ?? bodyHtml.length;
    const next = bodyHtml.slice(0, start) + token + bodyHtml.slice(end);
    setBodyHtml(next);
    requestAnimationFrame(() => { ta.focus(); const pos = start + token.length; ta.setSelectionRange(pos, pos); });
  }

  if (loading) return <p className="italic text-keep-muted">{t("common:loading")}</p>;

  return (
    <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-bg/30 p-3 text-sm">
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("fields.name")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" />
      </label>
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("fields.slug")}</span>
        <input value={effectiveSlug} onChange={(e) => { setSlug(e.target.value); setSlugDirty(true); }} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs" />
      </label>
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("fields.summary")}</span>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" placeholder={t("entities.summaryPlaceholder")} />
      </label>
      <div className="block">
        <div className="mb-0.5 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("fields.body")}</span>
          <EntryLinkPicker targets={targets} onPick={insertToken} />
        </div>
        <textarea ref={bodyRef} value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} rows={8} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs" placeholder={t("entities.bodyPlaceholder")} />
      </div>
      <StatsEditor stats={stats} onChange={setStats} />
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("entities.tagsLabel")}</span>
        <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" placeholder={t("entities.tagsPlaceholder")} />
      </label>
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("entities.imageUrl")}</span>
        <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" placeholder={t("entities.imagePlaceholder")} />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
        <span className="text-xs">{t("entities.publicLabel")}</span>
      </label>
      <div className="flex items-center gap-2 pt-1">
        <button type="button" disabled={busy || !name.trim()} onClick={() => void save()} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action disabled:opacity-50">{t("common:save")}</button>
        <button type="button" onClick={onCancel} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">{t("common:cancel")}</button>
        {entityId ? <button type="button" disabled={busy} onClick={() => void remove()} className="ml-auto rounded border border-keep-accent/50 px-3 py-1 text-xs text-keep-accent hover:bg-keep-accent/10">{t("common:delete")}</button> : null}
      </div>
    </div>
  );
}

/* ---------- Free-form stats kv editor ---------- */

function StatsEditor({ stats, onChange }: { stats: Array<[string, string]>; onChange: (s: Array<[string, string]>) => void }) {
  const { t } = useTranslation("worlds");
  return (
    <div className="space-y-1">
      <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("entities.stats")}</span>
      {stats.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1">
          <input value={k} onChange={(e) => { const n = [...stats]; n[i] = [e.target.value, v]; onChange(n); }} placeholder={t("entities.statKeyPlaceholder")} className="w-1/3 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs" />
          <input value={v} onChange={(e) => { const n = [...stats]; n[i] = [k, e.target.value]; onChange(n); }} placeholder={t("entities.statValuePlaceholder")} className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs" />
          <button type="button" onClick={() => onChange(stats.filter((_, j) => j !== i))} className="rounded border border-keep-rule px-1.5 text-xs text-keep-muted hover:bg-keep-banner" title={t("entities.removeStat")}>✕</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...stats, ["", ""]])} className="rounded border border-keep-rule px-2 py-0.5 text-[11px] text-keep-muted hover:bg-keep-banner">{t("entities.addStat")}</button>
    </div>
  );
}

/* ---------- New custom kind ---------- */

function NewKindForm({
  worldId, onCancel, onCreated, onError,
}: {
  worldId: string;
  onCancel: () => void;
  onCreated: (key: string) => void | Promise<void>;
  onError: (m: string | null) => void;
}) {
  const { t } = useTranslation("worlds");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [keyDirty, setKeyDirty] = useState(false);
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("✦");
  const [busy, setBusy] = useState(false);
  const effectiveKey = keyDirty ? key : deriveSlug(label);

  async function create() {
    if (busy) return;
    onError(null);
    setBusy(true);
    try {
      await createWorldEntityKind(worldId, { key: effectiveKey, label: label.trim(), description, icon });
      await onCreated(effectiveKey);
    } catch (x) {
      onError(x instanceof Error ? x.message : t("errors.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-bg/30 p-3 text-sm">
      <p className="text-[11px] uppercase tracking-widest text-keep-muted">{t("entities.newKind")}</p>
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("entities.kindLabelPlaceholder")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" />
      <input value={effectiveKey} onChange={(e) => { setKey(e.target.value); setKeyDirty(true); }} placeholder={t("entities.kindKeyPlaceholder")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs" />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("entities.kindDescriptionPlaceholder")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" />
      <input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder={t("entities.kindIconPlaceholder")} className="w-24 rounded border border-keep-rule bg-keep-bg px-2 py-1" maxLength={4} />
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy || !label.trim()} onClick={() => void create()} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action disabled:opacity-50">{t("actions.create")}</button>
        <button type="button" onClick={onCancel} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">{t("common:cancel")}</button>
      </div>
    </div>
  );
}
