/**
 * World-map editor, rendered in the WorldEditorModal's right pane (same
 * {worldId, detail, onChanged} contract as WorldEntitiesTab). Map list
 * CRUD on top, then the shared map stage in edit mode: click empty space
 * to place a marker (form opens focused), drag a marker to move it
 * (optimistic + resync on settle), click a marker to edit it. A
 * searchable sidebar lists every marker with jump-to (pan + zoom).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorldDetail, WorldEntityKindDef, WorldMap, WorldMapLinkableEvent, WorldMapMarker, WorldMapMarkerLabelMode, WorldMapMarkerScaleMode, WorldMapMarkerSize } from "@thekeep/shared";
import {
  BUILTIN_MAP_MARKER_KINDS,
  BUILTIN_WORLD_ENTITY_KINDS,
  WORLD_MAPS_CAP,
  WORLD_MAP_MARKERS_CAP,
  WORLD_MAP_UPLOAD_MAX_BYTES,
  deriveSlug,
} from "@thekeep/shared";
import {
  createWorldMap,
  createWorldMapMarker,
  deleteWorldMap,
  deleteWorldMapMarker,
  fetchWorldMap,
  fetchWorldMapLinkableEvents,
  updateWorldMap,
  updateWorldMapMarker,
  type WorldMapMarkerInput,
  type WorldMapPayload,
} from "../../lib/worldMaps.js";
import { EVENT_ICONS, EVENT_ICON_NAMES } from "../../lib/eventIcons.js";
import { formatDateTime } from "../../lib/intlFormat.js";
import { makeMarkerKindMeta } from "../../lib/worldMapKinds.js";
import { useChat } from "../../state/store.js";
import { safeCssColor } from "../shared/RoleBadgeChips.js";
import { WorldMapStage, type MapStageHandle } from "./WorldMapStage.js";
import { EntryLinkPicker, buildLinkTargets } from "./EntryLinkPicker.js";

/** Mirrors the server's upload allowlist (SVG stays external-URL-only). */
const UPLOAD_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const COLOR_SWATCHES = ["#e05c5c", "#e0894a", "#d4a44c", "#3fb27f", "#4ac6d4", "#5b8def", "#9b6cff", "#cfcfcf"];

export function WorldMapsTab({
  worldId,
  detail,
  onChanged,
}: {
  worldId: string;
  detail: WorldDetail;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation("worlds");
  const maps = useMemo(
    () => [...(detail.maps ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [detail.maps],
  );
  const [selectedMapId, setSelectedMapId] = useState<string | null>(maps[0]?.id ?? null);
  const selected = maps.find((m) => m.id === selectedMapId) ?? maps[0] ?? null;
  const [creatingMap, setCreatingMap] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [payload, setPayload] = useState<WorldMapPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draftPos, setDraftPos] = useState<{ x: number; y: number } | null>(null);
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const stageRef = useRef<MapStageHandle | null>(null);
  // Admin-gated upload mode: rides the /site branding payload. The route
  // enforces the switch server-side either way — this only hides the picker.
  const uploadsEnabled = useChat((s) => s.branding.worldMapUploadsEnabled ?? false);
  // Upcoming events of communities featuring this world, for the marker
  // "Linked event" select. Null while loading — and while the multi-server
  // feature is dark, where the whole linked-event block stays hidden (a
  // single-server site has no "communities" to talk about).
  const serversEnabled = useChat((s) => s.branding.serversEnabled ?? false);
  const [linkableEvents, setLinkableEvents] = useState<WorldMapLinkableEvent[] | null>(null);
  useEffect(() => {
    if (!serversEnabled) { setLinkableEvents(null); return; }
    let alive = true;
    setLinkableEvents(null);
    fetchWorldMapLinkableEvents(worldId)
      .then((evs) => { if (alive) setLinkableEvents(evs); })
      .catch(() => { if (alive) setLinkableEvents([]); });
    return () => { alive = false; };
  }, [worldId, serversEnabled]);

  const kindDefs: WorldEntityKindDef[] = useMemo(() => {
    // A custom kind registered before its key became a builtin (poi/town)
    // would duplicate the builtin's entry and React key; the builtin wins.
    const builtinKeys = new Set<string>(BUILTIN_WORLD_ENTITY_KINDS.map((k) => k.key));
    const custom: WorldEntityKindDef[] = detail.entityKinds
      .filter((k) => !builtinKeys.has(k.key.toLowerCase()))
      .map((k) => ({
        key: k.key, label: k.label, description: k.description,
        icon: k.icon ?? "✦", color: k.color ?? "#8a8a8a", sortOrder: k.sortOrder, builtIn: false,
      }));
    const builtIn: WorldEntityKindDef[] = BUILTIN_WORLD_ENTITY_KINDS.map((k) => ({
      ...k,
      label: t(`kinds.${k.key}.label`),
      description: t(`kinds.${k.key}.description`),
    }));
    return [...builtIn, ...custom];
  }, [detail.entityKinds, t]);
  const kindMeta = useMemo(() => makeMarkerKindMeta(kindDefs, t), [kindDefs, t]);
  const kindLabel = (k: string) => kindMeta(k).label;
  const linkTargets = useMemo(
    () => buildLinkTargets(detail.entities, detail.pages.map((p) => ({ slug: p.slug, title: p.title })), kindLabel),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.entities, detail.pages, detail.entityKinds],
  );
  /** Options for the marker-kind select: marker builtins + every entity
   *  kind, deduped (poi/town live on BOTH lists since kind parity; the
   *  marker-builtin entry wins so the select keeps its familiar order). */
  const kindOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; label: string }> = [];
    for (const k of BUILTIN_MAP_MARKER_KINDS) {
      seen.add(k);
      out.push({ key: k, label: t(`maps.markerKinds.${k}`) });
    }
    for (const d of kindDefs) {
      if (!seen.has(d.key)) out.push({ key: d.key, label: d.label });
    }
    return out;
  }, [kindDefs, t]);

  const selectedId2 = selected?.id ?? null;
  async function refetchMap() {
    if (!selectedId2) return;
    try {
      setPayload(await fetchWorldMap(worldId, selectedId2));
    } catch (x) {
      setErr(x instanceof Error ? x.message : t("errors.loadFailed"));
    }
  }
  useEffect(() => {
    if (!selectedId2) { setPayload(null); return; }
    let alive = true;
    setPayload(null); setErr(null); setDraftPos(null); setEditingMarkerId(null);
    fetchWorldMap(worldId, selectedId2)
      .then((p) => { if (alive) setPayload(p); })
      .catch((x) => { if (alive) setErr(x instanceof Error ? x.message : t("errors.loadFailed")); });
    return () => { alive = false; };
    // `t` deliberately omitted: a language flip must not refetch the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, selectedId2]);

  async function removeMap() {
    if (!selected || !payload) return;
    if (!window.confirm(t("maps.confirmDeleteMap", { name: selected.name, count: payload.markers.length }))) return;
    setErr(null);
    try {
      await deleteWorldMap(worldId, selected.id);
      setSelectedMapId(null);
      setPayload(null);
      await onChanged();
    } catch (x) {
      setErr(x instanceof Error ? x.message : t("errors.deleteFailed"));
    }
  }

  /** Drag-drop move: optimistic position, PATCH, resync either way. */
  function moveMarker(m: WorldMapMarker, x: number, y: number) {
    setPayload((p) => p ? { ...p, markers: p.markers.map((k) => (k.id === m.id ? { ...k, x, y } : k)) } : p);
    updateWorldMapMarker(worldId, m.mapId, m.id, { x, y })
      .catch((e) => setErr(e instanceof Error ? e.message : t("errors.saveFailed")))
      .finally(() => { void refetchMap(); });
  }

  /** PATCH the measured natural dimensions back as stability hints. */
  function patchDimensions(w: number, h: number) {
    const map = payload?.map;
    if (!map || (map.width === w && map.height === h)) return;
    updateWorldMap(worldId, map.id, { width: w, height: h }).catch(() => { /* hint only */ });
  }

  const editingMarker = editingMarkerId ? payload?.markers.find((m) => m.id === editingMarkerId) ?? null : null;
  const filteredMarkers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = payload?.markers ?? [];
    return q ? list.filter((m) => m.label.toLowerCase().includes(q)) : list;
  }, [payload, search]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {maps.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => { setSelectedMapId(m.id); setCreatingMap(false); setEditingMeta(false); }}
            className={`rounded border px-2 py-1 text-xs ${selected?.id === m.id && !creatingMap ? "border-keep-action bg-keep-action/15 text-keep-action" : "border-keep-rule hover:bg-keep-banner"}`}
          >
            {m.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setCreatingMap(true); setEditingMeta(false); }}
          disabled={maps.length >= WORLD_MAPS_CAP}
          className="rounded border border-dashed border-keep-rule px-2 py-1 text-xs text-keep-muted hover:bg-keep-banner disabled:opacity-50"
          title={maps.length >= WORLD_MAPS_CAP ? t("maps.mapCapTitle", { max: WORLD_MAPS_CAP }) : t("maps.newMapTitle")}
        >
          {t("maps.newMap")}
        </button>
      </div>

      {err ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div> : null}

      {creatingMap ? (
        <MapMetaForm
          worldId={worldId}
          uploadsEnabled={uploadsEnabled}
          onCancel={() => setCreatingMap(false)}
          onSaved={async (m) => { setCreatingMap(false); await onChanged(); setSelectedMapId(m.id); }}
          onError={setErr}
        />
      ) : !selected ? (
        <p className="italic text-keep-muted">{t("maps.noMaps")}</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setEditingMeta((v) => !v)}
              className={`rounded border px-2 py-1 text-xs ${editingMeta ? "border-keep-action text-keep-action" : "border-keep-rule hover:bg-keep-banner"}`}
            >
              {t("maps.mapSettings")}
            </button>
            <button
              type="button"
              onClick={() => void removeMap()}
              className="rounded border border-keep-accent/50 px-2 py-1 text-xs text-keep-accent hover:bg-keep-accent/10"
            >
              {t("maps.deleteMap")}
            </button>
            {payload ? (
              <span className="ml-auto text-[11px] tabular-nums text-keep-muted">
                {t("maps.markerCount", { count: payload.markers.length, max: WORLD_MAP_MARKERS_CAP })}
              </span>
            ) : null}
          </div>

          {editingMeta && payload ? (
            <MapMetaForm
              worldId={worldId}
              map={payload.map}
              uploadsEnabled={uploadsEnabled}
              onCancel={() => setEditingMeta(false)}
              onSaved={async () => { setEditingMeta(false); await onChanged(); await refetchMap(); }}
              onError={setErr}
            />
          ) : null}

          {payload ? (
            <div className="flex flex-col gap-3 [@container(min-width:768px)]:flex-row">
              <aside className="shrink-0 space-y-2 [@container(min-width:768px)]:w-56">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("maps.searchMarkersPlaceholder")}
                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
                />
                {filteredMarkers.length === 0 ? (
                  <p className="text-xs italic text-keep-muted">{payload.markers.length === 0 ? t("maps.noMarkers") : t("maps.noMarkerMatches")}</p>
                ) : (
                  <ul className="max-h-72 space-y-1 overflow-y-auto">
                    {filteredMarkers.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => { setEditingMarkerId(m.id); setDraftPos(null); stageRef.current?.jumpToMarker(m); }}
                          className={`flex w-full items-center gap-1.5 rounded border px-2 py-1 text-left text-xs ${editingMarkerId === m.id ? "border-keep-action text-keep-action" : "border-keep-rule/60 hover:border-keep-action/40"}`}
                          title={t("maps.jumpToMarkerTitle", { label: m.label })}
                        >
                          <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: safeCssColor(m.color) ?? safeCssColor(kindMeta(m.kind).color) ?? "var(--keep-action)" }} />
                          <span className="min-w-0 flex-1 truncate">{m.label}</span>
                          {m.isSecret ? <span className="shrink-0 text-[9px] uppercase tracking-widest text-keep-accent">{t("maps.secretChip")}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-[11px] text-keep-muted">{t("maps.placeHint")}</p>
              </aside>

              <div className="min-w-0 flex-1 space-y-2">
                <WorldMapStage
                  ref={stageRef}
                  map={payload.map}
                  markers={payload.markers}
                  kindMeta={kindMeta}
                  canEdit
                  selectedMarkerId={editingMarkerId}
                  onMarkerClick={(m) => { setEditingMarkerId(m.id); setDraftPos(null); }}
                  onPlace={(x, y) => { setDraftPos({ x, y }); setEditingMarkerId(null); }}
                  onMarkerMove={moveMarker}
                  onImageSize={patchDimensions}
                  className="h-[26rem] w-full"
                />
                {draftPos ? (
                  <MarkerForm
                    key="new-marker"
                    worldId={worldId}
                    mapId={payload.map.id}
                    draftPos={draftPos}
                    kindOptions={kindOptions}
                    targets={linkTargets}
                    events={linkableEvents}
                    atCap={payload.markers.length >= WORLD_MAP_MARKERS_CAP}
                    onCancel={() => setDraftPos(null)}
                    onSaved={async (m) => { setDraftPos(null); await refetchMap(); setEditingMarkerId(m.id); }}
                    onError={setErr}
                  />
                ) : editingMarker ? (
                  <MarkerForm
                    key={editingMarker.id}
                    worldId={worldId}
                    mapId={payload.map.id}
                    marker={editingMarker}
                    kindOptions={kindOptions}
                    targets={linkTargets}
                    events={linkableEvents}
                    atCap={false}
                    onCancel={() => setEditingMarkerId(null)}
                    onSaved={async () => { await refetchMap(); }}
                    onDeleted={async () => { setEditingMarkerId(null); await refetchMap(); }}
                    onError={setErr}
                  />
                ) : null}
              </div>
            </div>
          ) : !err ? (
            <p className="italic text-keep-muted">{t("common:loadingDots")}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ---------- Map meta form (create or edit) ---------- */

function MapMetaForm({
  worldId, map, uploadsEnabled, onCancel, onSaved, onError,
}: {
  worldId: string;
  map?: WorldMap;
  uploadsEnabled: boolean;
  onCancel: () => void;
  onSaved: (m: WorldMap) => void | Promise<void>;
  onError: (m: string | null) => void;
}) {
  const { t } = useTranslation("worlds");
  const [name, setName] = useState(map?.name ?? "");
  const [slug, setSlug] = useState(map?.slug ?? "");
  const [slugDirty, setSlugDirty] = useState(!!map);
  // An upload-kind map's stored /uploads/… path never prefills the URL
  // field — it isn't an https link, and echoing it into a field that asks
  // for one reads as stale data. Blank-with-stored-image is the valid
  // "keep what's there" state (see keepingStoredImage below).
  const [imageUrl, setImageUrl] = useState(map && map.imageKind !== "upload" ? map.imageUrl : "");
  const [description, setDescription] = useState(map?.description ?? "");
  // Picked file for the admin-gated upload mode (AdminBrandingTab idiom:
  // <input type=file> → FileReader.readAsDataURL → JSON body). Takes
  // precedence over the URL field when set.
  const [pendingFile, setPendingFile] = useState<{ dataUrl: string; name: string } | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const effectiveSlug = slugDirty ? slug : deriveSlug(name);
  // Mirror the server's https-only rule so a bad paste surfaces as a
  // localized inline hint instead of the route's generic 400.
  const trimmedUrl = imageUrl.trim();
  const urlValid = (() => {
    try { return new URL(trimmedUrl).protocol === "https:"; } catch { return false; }
  })();
  // An upload-kind map with the URL field left blank keeps its stored
  // /uploads/… image — valid to save without re-sending an image source.
  const keepingStoredImage = !!map && map.imageKind === "upload" && trimmedUrl === "";
  const imageValid = pendingFile != null || urlValid || keepingStoredImage;

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    setFileErr(null);
    const f = e.target.files?.[0];
    if (!f) return;
    if (!UPLOAD_MIME_TYPES.includes(f.type)) {
      setFileErr(t("maps.uploadBadType"));
      e.target.value = "";
      return;
    }
    if (f.size > WORLD_MAP_UPLOAD_MAX_BYTES) {
      setFileErr(t("maps.uploadTooLarge", { mb: Math.round(WORLD_MAP_UPLOAD_MAX_BYTES / (1024 * 1024)) }));
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const v = reader.result;
      if (typeof v === "string") setPendingFile({ dataUrl: v, name: f.name });
    };
    reader.readAsDataURL(f);
  }

  async function save() {
    if (busy) return;
    onError(null);
    setBusy(true);
    try {
      const input: Parameters<typeof updateWorldMap>[2] = {
        name: name.trim(),
        slug: effectiveSlug,
        description,
      };
      // Exactly one image source per request: a picked file wins; otherwise
      // a non-empty URL rides along only when it's new. A blank field on an
      // upload-kind map sends neither, keeping the stored image.
      if (pendingFile) input.imageDataUrl = pendingFile.dataUrl;
      else if (trimmedUrl && (!map || trimmedUrl !== map.imageUrl)) input.imageUrl = trimmedUrl;
      const saved = map
        ? await updateWorldMap(worldId, map.id, input)
        : await createWorldMap(worldId, input);
      await onSaved(saved);
    } catch (x) {
      onError(x instanceof Error ? x.message : t("errors.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-bg/30 p-3 text-sm">
      <p className="text-[11px] uppercase tracking-widest text-keep-muted">{map ? t("maps.editMap") : t("maps.newMapHeading")}</p>
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("fields.name")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" placeholder={t("maps.namePlaceholder")} />
      </label>
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("fields.slug")}</span>
        <input value={effectiveSlug} onChange={(e) => { setSlug(e.target.value); setSlugDirty(true); }} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs" />
      </label>
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.imageUrl")}</span>
        <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" placeholder={t("maps.imageUrlPlaceholder")} />
        {trimmedUrl && !urlValid && !pendingFile ? (
          <span className="mt-0.5 block text-[11px] text-keep-accent">{t("maps.imageUrlInvalid")}</span>
        ) : keepingStoredImage && !pendingFile ? (
          <span className="mt-0.5 block text-[11px] text-keep-muted">{t("maps.storedImageNote")}</span>
        ) : !imageValid && !trimmedUrl ? (
          <span className="mt-0.5 block text-[11px] text-keep-accent">{t("maps.imageRequired")}</span>
        ) : (
          <span className="mt-0.5 block text-[11px] text-keep-muted">{t("maps.imageUrlHint")}</span>
        )}
      </label>
      {uploadsEnabled ? (
        <div className="block">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.uploadImage")}</span>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <input
              type="file"
              accept={UPLOAD_MIME_TYPES.join(",")}
              onChange={onPickFile}
              className="max-w-full text-xs"
              aria-label={t("maps.uploadImage")}
            />
            {pendingFile ? (
              <button type="button" onClick={() => setPendingFile(null)} className="rounded border border-keep-rule px-1.5 py-0.5 text-[11px] text-keep-muted hover:bg-keep-banner">
                {t("maps.clear")}
              </button>
            ) : null}
          </div>
          {fileErr ? (
            <span className="mt-0.5 block text-[11px] text-keep-accent">{fileErr}</span>
          ) : pendingFile ? (
            <span className="mt-0.5 block text-[11px] text-keep-muted">{t("maps.uploadPicked", { name: pendingFile.name })}</span>
          ) : (
            <span className="mt-0.5 block text-[11px] text-keep-muted">{t("maps.uploadHint")}</span>
          )}
        </div>
      ) : null}
      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("fields.description")}</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs" placeholder={t("maps.descriptionPlaceholder")} />
      </label>
      <div className="flex items-center gap-2 pt-1">
        <button type="button" disabled={busy || !name.trim() || !imageValid} onClick={() => void save()} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action disabled:opacity-50">
          {map ? t("common:save") : t("actions.create")}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">{t("common:cancel")}</button>
      </div>
    </div>
  );
}

/* ---------- Marker form (create at a clicked position, or edit) ---------- */

function MarkerForm({
  worldId, mapId, marker, draftPos, kindOptions, targets, events, atCap, onCancel, onSaved, onDeleted, onError,
}: {
  worldId: string;
  mapId: string;
  marker?: WorldMapMarker;
  draftPos?: { x: number; y: number };
  kindOptions: Array<{ key: string; label: string }>;
  targets: ReturnType<typeof buildLinkTargets>;
  /** Upcoming events of communities featuring this world (null = loading). */
  events: WorldMapLinkableEvent[] | null;
  atCap: boolean;
  onCancel: () => void;
  onSaved: (m: WorldMapMarker) => void | Promise<void>;
  onDeleted?: () => void | Promise<void>;
  onError: (m: string | null) => void;
}) {
  const { t } = useTranslation("worlds");
  const [label, setLabel] = useState(marker?.label ?? "");
  const [kind, setKind] = useState(marker?.kind ?? "poi");
  const [color, setColor] = useState(marker?.color ?? "");
  const [icon, setIcon] = useState<string | null>(marker?.icon ?? null);
  const [size, setSize] = useState<WorldMapMarkerSize>(marker?.size ?? "md");
  const [scaleMode, setScaleMode] = useState<WorldMapMarkerScaleMode>(marker?.scaleMode ?? "fixed");
  const [labelMode, setLabelMode] = useState<WorldMapMarkerLabelMode>(marker?.labelMode ?? "icon");
  const [minZoom, setMinZoom] = useState(marker?.minZoom != null ? String(marker.minZoom) : "");
  const [maxZoom, setMaxZoom] = useState(marker?.maxZoom != null ? String(marker.maxZoom) : "");
  const [entryKind, setEntryKind] = useState<string | null>(marker?.entryKind ?? null);
  const [entrySlug, setEntrySlug] = useState<string | null>(marker?.entrySlug ?? null);
  const [eventId, setEventId] = useState<string | null>(marker?.eventId ?? null);
  const [body, setBody] = useState(marker?.body ?? "");
  const [isSecret, setIsSecret] = useState(marker?.isSecret ?? false);
  const [showIcons, setShowIcons] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Empty clears the bound; finite input clamps into the server's
   *  0.1–32 range; anything unparseable is a visible error, not a
   *  silent clear. */
  function parseZoom(raw: string): number | null | "invalid" {
    if (raw.trim() === "") return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return "invalid";
    return Math.min(32, Math.max(0.1, v));
  }
  const zoomMin = parseZoom(minZoom);
  const zoomMax = parseZoom(maxZoom);
  const zoomError = zoomMin === "invalid" || zoomMax === "invalid"
    ? t("maps.zoomBandNumberError")
    : zoomMin != null && zoomMax != null && zoomMin > zoomMax
      ? t("maps.zoomBandOrderError")
      : null;

  async function save() {
    if (busy || zoomError || zoomMin === "invalid" || zoomMax === "invalid") return;
    onError(null);
    setBusy(true);
    try {
      const input: WorldMapMarkerInput = {
        kind,
        label: label.trim(),
        color: color.trim() || null,
        icon,
        size,
        scaleMode,
        labelMode,
        minZoom: zoomMin,
        maxZoom: zoomMax,
        entryKind,
        entrySlug,
        eventId,
        body,
        isSecret,
      };
      const saved = marker
        ? await updateWorldMapMarker(worldId, mapId, marker.id, input)
        : await createWorldMapMarker(worldId, mapId, { ...input, x: draftPos?.x ?? 0.5, y: draftPos?.y ?? 0.5 });
      await onSaved(saved);
    } catch (x) {
      onError(x instanceof Error ? x.message : t("errors.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!marker || busy) return;
    if (!window.confirm(t("maps.confirmDeleteMarker", { label: marker.label }))) return;
    setBusy(true);
    try {
      await deleteWorldMapMarker(worldId, mapId, marker.id);
      await onDeleted?.();
    } catch (x) {
      onError(x instanceof Error ? x.message : t("errors.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  const IconPreview = icon ? EVENT_ICONS[icon] : undefined;
  // Label-kind annotations never read labelMode or the icon, and text-only
  // markers draw fixed outlined white text (no pin, icon, or color), so the
  // inert controls hide or dim instead of silently doing nothing.
  const isLabelKind = kind === "label";
  const textOnly = !isLabelKind && labelMode === "text";

  return (
    <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-bg/30 p-3 text-sm">
      <p className="text-[11px] uppercase tracking-widest text-keep-muted">
        {marker ? t("maps.editMarker") : t("maps.newMarker")}
      </p>
      {atCap && !marker ? <p className="text-xs text-keep-accent">{t("maps.markerCapReached", { max: WORLD_MAP_MARKERS_CAP })}</p> : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.markerLabel")}</span>
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" placeholder={t("maps.markerLabelPlaceholder")} />
        </label>
        <label className="block">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.markerKind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1">
            {kindOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
      </div>

      <div className={textOnly ? "block opacity-60" : "block"} title={textOnly ? t("maps.textOnlyHint") : undefined}>
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("fields.color")}</span>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {COLOR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-5 w-5 rounded-full border ${color === c ? "border-keep-action ring-1 ring-keep-action" : "border-keep-rule/60"}`}
              style={{ background: c }}
              title={c}
              aria-label={t("maps.pickColor", { color: c })}
            />
          ))}
          <input value={color} onChange={(e) => setColor(e.target.value)} maxLength={32} placeholder={t("maps.colorPlaceholder")} className="w-28 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 font-mono text-xs" />
          {color ? (
            <button type="button" onClick={() => setColor("")} className="rounded border border-keep-rule px-1.5 py-0.5 text-[11px] text-keep-muted hover:bg-keep-banner">
              {t("maps.clear")}
            </button>
          ) : null}
        </div>
      </div>

      {isLabelKind ? null : (
      <div className={textOnly ? "block opacity-60" : "block"} title={textOnly ? t("maps.textOnlyHint") : undefined}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.markerIcon")}</span>
          <button type="button" onClick={() => setShowIcons((v) => !v)} className="rounded border border-keep-rule px-2 py-0.5 text-[11px] text-keep-muted hover:bg-keep-banner">
            {IconPreview ? <IconPreview className="inline h-3.5 w-3.5" aria-hidden="true" /> : icon ? <span aria-hidden>{icon}</span> : t("maps.pickIcon")}
          </button>
          {icon ? (
            <button type="button" onClick={() => setIcon(null)} className="rounded border border-keep-rule px-1.5 py-0.5 text-[11px] text-keep-muted hover:bg-keep-banner">
              {t("maps.clear")}
            </button>
          ) : null}
        </div>
        {showIcons ? (
          <div className="mt-1 space-y-1 rounded border border-keep-rule/60 bg-keep-bg p-2">
            <div className="flex flex-wrap gap-1">
              {EVENT_ICON_NAMES.map((slug) => {
                const Ico = EVENT_ICONS[slug];
                if (!Ico) return null;
                return (
                  <button
                    key={slug}
                    type="button"
                    onClick={() => { setIcon(slug); setShowIcons(false); }}
                    className={`rounded border p-1 ${icon === slug ? "border-keep-action text-keep-action" : "border-keep-rule/60 hover:bg-keep-banner"}`}
                    title={slug}
                    aria-label={t("maps.pickIconNamed", { name: slug })}
                  >
                    <Ico className="h-4 w-4" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <span className="text-keep-muted">{t("maps.emojiInstead")}</span>
              <input
                value={icon && !EVENT_ICONS[icon] ? icon : ""}
                onChange={(e) => setIcon(e.target.value.trim() || null)}
                maxLength={8}
                className="w-16 rounded border border-keep-rule bg-keep-bg px-2 py-0.5"
                placeholder="🏰"
              />
            </label>
          </div>
        ) : null}
      </div>
      )}
      {textOnly ? <p className="text-[11px] text-keep-muted">{t("maps.textOnlyHint")}</p> : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {isLabelKind ? null : (
        <label className="block">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.labelMode")}</span>
          <select value={labelMode} onChange={(e) => setLabelMode(e.target.value as WorldMapMarkerLabelMode)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs" title={t("maps.labelModeTitle")}>
            <option value="icon">{t("maps.labelModeIcon")}</option>
            <option value="text">{t("maps.labelModeText")}</option>
            <option value="both">{t("maps.labelModeBoth")}</option>
          </select>
        </label>
        )}
        <label className="block">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.markerSize")}</span>
          <select value={size} onChange={(e) => setSize(e.target.value as WorldMapMarkerSize)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs">
            {(["sm", "md", "lg", "xl"] as const).map((s) => <option key={s} value={s}>{t(`maps.sizes.${s}`)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.scaleMode")}</span>
          <select value={scaleMode} onChange={(e) => setScaleMode(e.target.value as WorldMapMarkerScaleMode)} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs" title={t("maps.scaleModeTitle")}>
            <option value="fixed">{t("maps.scaleFixed")}</option>
            <option value="map">{t("maps.scaleMap")}</option>
          </select>
        </label>
        <label className="block" title={t("maps.zoomBandTitle")}>
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.minZoom")}</span>
          <input value={minZoom} onChange={(e) => setMinZoom(e.target.value)} inputMode="decimal" placeholder="—" className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs" />
        </label>
        <label className="block" title={t("maps.zoomBandTitle")}>
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.maxZoom")}</span>
          <input value={maxZoom} onChange={(e) => setMaxZoom(e.target.value)} inputMode="decimal" placeholder="—" className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs" />
        </label>
      </div>
      {zoomError ? <p className="text-[11px] text-keep-accent">{zoomError}</p> : null}

      <div className="block">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.entryLink")}</span>
          {entryKind && entrySlug ? (
            <>
              <span className="rounded border border-keep-rule/60 px-1.5 py-0.5 font-mono text-[11px] text-keep-muted">@{entryKind}:{entrySlug}</span>
              <button type="button" onClick={() => { setEntryKind(null); setEntrySlug(null); }} className="rounded border border-keep-rule px-1.5 py-0.5 text-[11px] text-keep-muted hover:bg-keep-banner">
                {t("maps.clear")}
              </button>
            </>
          ) : (
            <EntryLinkPicker
              targets={targets}
              onPick={(token) => {
                const m = /^@([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)\s*$/.exec(token);
                const k = m?.[1];
                const s = m?.[2];
                if (k && s) { setEntryKind(k); setEntrySlug(s); }
              }}
            />
          )}
        </div>
        <span className="mt-0.5 block text-[11px] text-keep-muted">{t("maps.entryLinkHint")}</span>
      </div>

      {events == null ? null : events.length > 0 || eventId ? (
        <label className="block">
          <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.linkedEvent")}</span>
          <select
            value={eventId ?? ""}
            onChange={(e) => setEventId(e.target.value || null)}
            className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
          >
            <option value="">{t("maps.linkedEventNone")}</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {`${ev.serverName} — ${ev.title} (${formatDateTime(ev.startsAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})`}
              </option>
            ))}
            {/* A stored link whose event is no longer upcoming (cancelled or
                past) must stay selectable so an unrelated edit can't drop it. */}
            {eventId && !events.some((ev) => ev.id === eventId) ? (
              <option value={eventId}>{t("maps.linkedEventStale")}</option>
            ) : null}
          </select>
          <span className="mt-0.5 block text-[11px] text-keep-muted">{t("maps.eventLinkHint")}</span>
        </label>
      ) : (
        <p className="text-[11px] text-keep-muted">{t("maps.eventLinkNoneHint")}</p>
      )}

      <label className="block">
        <span className="text-[11px] uppercase tracking-widest text-keep-muted">{t("maps.markerBody")}</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs" placeholder={t("maps.markerBodyPlaceholder")} />
      </label>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={isSecret} onChange={(e) => setIsSecret(e.target.checked)} />
        <span className="text-xs">{t("maps.secretLabel")}</span>
      </label>
      <p className="text-[11px] text-keep-muted">{t("maps.secretHint")}</p>

      <div className="flex items-center gap-2 pt-1">
        <button type="button" disabled={busy || !label.trim() || !!zoomError || (atCap && !marker)} onClick={() => void save()} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action disabled:opacity-50">
          {marker ? t("common:save") : t("maps.addMarker")}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-keep-rule px-3 py-1 text-xs hover:bg-keep-banner">{t("common:cancel")}</button>
        {marker ? (
          <button type="button" disabled={busy} onClick={() => void remove()} className="ml-auto rounded border border-keep-accent/50 px-3 py-1 text-xs text-keep-accent hover:bg-keep-accent/10">
            {t("common:delete")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
