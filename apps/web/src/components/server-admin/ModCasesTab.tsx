/**
 * Server Admin → Mod Cases (Multi-Server Lift — the "Admin Partition").
 *
 * The per-server twin of the GLOBAL AdminModCasesTab, scoped to ONE server. A
 * server owner/admin/mod (holding `manage_mod_cases`) keeps a moderation case
 * log against the users who joined THIS server, without ever touching the
 * platform-wide case log (the backend filters on mod_cases.server_id = :id and
 * stamps it on create).
 *
 * This is DISTINCT from the read-only "Mod Log" tab (view_mod_log audit feed):
 * Mod Log is the automatic action history; Mod Cases is the hand-authored case
 * log (complaints, disputes, notes) with an editable status workflow, an
 * append-only update timeline, and snapshotted message evidence. A "ban" here
 * is recorded as the case outcome — the actual server ban is issued from the
 * Bans tab (server_bans), never a global account ban.
 *
 * House style mirrors the other Server Settings console tabs (ReportsTab /
 * FaqsTab): keep-* Tailwind palette, uppercase tracking-widest section labels,
 * the shared `run`/`busy` action plumbing, and inline fetch helpers
 * (lib/servers.ts is a shared do-not-touch module, so we carry our own here).
 */
import { useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ProfileView, ServerViewerState } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { formatDateTime } from "../../lib/intlFormat.js";
import { ProfileModal } from "../profile/ProfileModal.js";

/* ============================================================
 * Wire shapes (consumed from /servers/:id/mod-cases).
 * Local on purpose — lib/servers.ts is shared and not to be touched.
 * ============================================================ */

type CaseStatus = "open" | "in_progress" | "resolved";
type CaseKind = "case" | "note";

interface CaseUpdate {
  id: string;
  body: string;
  statusChange: CaseStatus | null;
  authorUserId: string | null;
  authorName: string | null;
  createdAt: number;
}
interface CaseEvidence {
  id: string;
  messageId: string | null;
  authorUserId: string | null;
  authorLabel: string | null;
  body: string | null;
  kind: string | null;
  roomId: string | null;
  roomName: string | null;
  originalCreatedAt: number | null;
  snapshottedAt: number;
}
interface ModCase {
  id: string;
  nature: string;
  kind: CaseKind;
  complaintBody: string;
  resolution: string | null;
  status: CaseStatus;
  reporterText: string | null;
  reporterUserId: string | null;
  reporterCharacterId: string | null;
  reporterLabel: string | null;
  subjectText: string | null;
  subjectUserId: string | null;
  subjectCharacterId: string | null;
  subjectLabel: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  updates: CaseUpdate[];
  evidence: CaseEvidence[];
}

interface FormState {
  nature: string;
  kind: CaseKind;
  reporter: string;
  subject: string;
  complaintBody: string;
  resolution: string;
  status: CaseStatus;
  evidenceMessageIds: string;
}

const EMPTY_FORM: FormState = { nature: "", kind: "case", reporter: "", subject: "", complaintBody: "", resolution: "", status: "open", evidenceMessageIds: "" };

/** Suggested complaint categories for the nature datalist (still freehand).
 *  Catalog keys; resolved at render so the suggestions follow the language. */
const NATURE_SUGGESTION_KEYS = [
  "modCasesTab.nature.spam", "modCasesTab.nature.nsfw", "modCasesTab.nature.harassment",
  "modCasesTab.nature.oocDispute", "modCasesTab.nature.banEvasion", "modCasesTab.nature.underage",
  "modCasesTab.nature.impersonation", "modCasesTab.nature.advertising", "modCasesTab.nature.threats",
  "modCasesTab.nature.consent", "modCasesTab.nature.other",
];

type FilterTab = "all" | "open" | "in_progress" | "resolved" | "notes";
const TABS: { key: FilterTab; labelKey: string }[] = [
  { key: "all", labelKey: "modCasesTab.tabAll" },
  { key: "open", labelKey: "modCasesTab.statusOpen" },
  { key: "in_progress", labelKey: "modCasesTab.statusInProgress" },
  { key: "resolved", labelKey: "modCasesTab.statusResolved" },
  { key: "notes", labelKey: "modCasesTab.tabNotes" },
];
type Sort = "newest" | "oldest" | "updated" | "reporter" | "subject" | "nature";
const SORTS: { key: Sort; labelKey: string }[] = [
  { key: "newest", labelKey: "modCasesTab.sortNewest" },
  { key: "oldest", labelKey: "modCasesTab.sortOldest" },
  { key: "updated", labelKey: "modCasesTab.sortUpdated" },
  { key: "reporter", labelKey: "modCasesTab.sortReporter" },
  { key: "subject", labelKey: "modCasesTab.sortSubject" },
  { key: "nature", labelKey: "modCasesTab.sortNature" },
];

const STATUS_LABEL_KEY: Record<CaseStatus, string> = { open: "modCasesTab.statusOpen", in_progress: "modCasesTab.statusInProgress", resolved: "modCasesTab.statusResolved" };
/** Status display label through the active language. */
function statusLabel(t: TFunction<"servers">, s: CaseStatus): string { return t(STATUS_LABEL_KEY[s]); }
const STATUS_BADGE: Record<CaseStatus, string> = {
  open: "bg-keep-accent/15 text-keep-accent",
  in_progress: "bg-keep-action/15 text-keep-action",
  resolved: "bg-keep-muted/20 text-keep-muted",
};

const inputClass = "w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm text-keep-text outline-none focus:border-keep-action";
const btnClass = "rounded border border-keep-rule px-2 py-0.5 text-xs text-keep-muted hover:text-keep-text";

/* ============================================================
 * Inline fetch helpers (do NOT widen lib/servers.ts).
 * ============================================================ */

const sid = (id: string) => encodeURIComponent(id);

/* ============================================================
 * A reporter/subject cell. When linked to a real identity it renders as a
 * clickable chip that opens that profile; otherwise plain freehand text.
 * ============================================================ */
function Party({
  label, text, linked, isCharacter, onOpen,
}: {
  label: string | null;
  text: string | null;
  linked: boolean;
  isCharacter: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation("servers");
  if (linked && label) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 rounded border border-keep-action/40 bg-keep-action/10 px-1.5 py-0.5 text-[11px] font-semibold text-keep-action hover:bg-keep-action/20"
        title={isCharacter ? t("modCasesTab.openCharProfile") : t("modCasesTab.openOocProfile")}
      >
        {label}
        <span className="text-[8px] uppercase tracking-widest opacity-70">{isCharacter ? t("modCasesTab.charChip") : t("modCasesTab.oocChip")}</span>
      </button>
    );
  }
  if (text) return <span className="text-keep-text">{text}</span>;
  return <span className="italic text-keep-muted/60">-</span>;
}

/* ============================================================
 * One case (or note) row with its evidence, timeline, and update composer.
 * ============================================================ */
function CaseCard({
  c, serverId, canManage, busy, run, onChanged, onEdit, onOpenParty, onError,
}: {
  c: ModCase;
  serverId: string;
  canManage: boolean;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onChanged: () => void;
  onEdit: () => void;
  onOpenParty: (p: { userId: string | null; characterId: string | null; fallbackLabel: string | null }) => void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation("servers");
  const [upBody, setUpBody] = useState("");
  const [upStatus, setUpStatus] = useState<CaseStatus | "">("");
  const isNote = c.kind === "note";

  async function call(url: string, init: RequestInit) {
    await run(async () => {
      const r = await fetch(url, { credentials: "include", ...init });
      if (!r.ok) { const msg = await readError(r); onError(msg); throw new Error(msg); }
      onChanged();
    });
  }

  async function addUpdate() {
    if (!upBody.trim()) return;
    const payload: { body: string; status?: CaseStatus } = { body: upBody.trim() };
    if (upStatus) payload.status = upStatus;
    await call(`/servers/${sid(serverId)}/mod-cases/${sid(c.id)}/updates`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    setUpBody(""); setUpStatus("");
  }
  const setStatus = (status: CaseStatus) =>
    call(`/servers/${sid(serverId)}/mod-cases/${sid(c.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
  const delUpdate = (uid: string) =>
    call(`/servers/${sid(serverId)}/mod-cases/${sid(c.id)}/updates/${sid(uid)}`, { method: "DELETE" });
  const delEvidence = (eid: string) =>
    call(`/servers/${sid(serverId)}/mod-cases/${sid(c.id)}/evidence/${sid(eid)}`, { method: "DELETE" });
  function remove() {
    if (!window.confirm(isNote ? t("modCasesTab.deleteNoteConfirm") : t("modCasesTab.deleteCaseConfirm"))) return;
    void call(`/servers/${sid(serverId)}/mod-cases/${sid(c.id)}`, { method: "DELETE" });
  }

  return (
    <li className="rounded border border-keep-rule bg-keep-panel/30 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {isNote ? (
          <span className="rounded bg-keep-action/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-keep-muted">{t("modCasesTab.noteChip")}</span>
        ) : (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_BADGE[c.status]}`}>{statusLabel(t, c.status)}</span>
        )}
        <span className="font-semibold text-keep-text">{c.nature}</span>
        <span className="ml-auto text-[11px] text-keep-muted" title={c.createdByName ? t("modCasesTab.loggedBy", { name: c.createdByName }) : undefined}>
          {formatDateTime(c.createdAt)}{c.createdByName ? ` · ${c.createdByName}` : ""}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-keep-muted">
        <span>{t("modCasesTab.fromLabel")}<Party label={c.reporterLabel} text={c.reporterText} linked={!!c.reporterUserId} isCharacter={!!c.reporterCharacterId} onOpen={() => onOpenParty({ userId: c.reporterUserId, characterId: c.reporterCharacterId, fallbackLabel: c.reporterLabel })} /></span>
        <span>{t("modCasesTab.aboutLabel")}<Party label={c.subjectLabel} text={c.subjectText} linked={!!c.subjectUserId} isCharacter={!!c.subjectCharacterId} onOpen={() => onOpenParty({ userId: c.subjectUserId, characterId: c.subjectCharacterId, fallbackLabel: c.subjectLabel })} /></span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-keep-text">{c.complaintBody}</p>
      {c.resolution ? (
        <p className="mt-2 whitespace-pre-wrap border-l-2 border-keep-action/40 pl-2 text-keep-muted">
          <span className="font-semibold text-keep-text">{t("modCasesTab.resolutionLabel")}</span>{c.resolution}
        </p>
      ) : null}

      {/* Backed-up message evidence (survives the janitor). */}
      {c.evidence.length > 0 ? (
        <div className="mt-2 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-keep-muted">{t("modCasesTab.backedUpHeading", { n: c.evidence.length })}</p>
          {c.evidence.map((e) => (
            <div key={e.id} className="rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1 text-xs">
              <div className="flex items-center gap-2 text-[10px] text-keep-muted">
                <span className="font-semibold text-keep-text">{e.authorLabel ?? t("modCasesTab.unknownAuthor")}</span>
                {e.roomName ? <span>{t("modCasesTab.inRoom", { room: e.roomName })}</span> : null}
                {e.originalCreatedAt ? <span>· {formatDateTime(e.originalCreatedAt)}</span> : null}
                {e.kind && e.kind !== "say" ? <span className="uppercase tracking-widest">· {e.kind}</span> : null}
                {canManage ? <button type="button" disabled={busy} onClick={() => void delEvidence(e.id)} className="ml-auto text-keep-accent hover:underline">{t("modCasesTab.removeLower")}</button> : null}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-keep-text">{e.body ?? <span className="italic text-keep-muted">{t("modCasesTab.emptyBody")}</span>}</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* Update timeline (append-only). */}
      {c.updates.length > 0 ? (
        <div className="mt-2 space-y-1 border-l-2 border-keep-rule/60 pl-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-keep-muted">{t("modCasesTab.updatesHeading")}</p>
          {c.updates.map((u) => (
            <div key={u.id} className="text-xs">
              <div className="flex items-center gap-2 text-[10px] text-keep-muted">
                <span className="font-semibold text-keep-text">{u.authorName ?? t("modCasesTab.staffFallback")}</span>
                <span>{formatDateTime(u.createdAt)}</span>
                {u.statusChange ? <span className={`rounded px-1 py-0 text-[9px] font-semibold uppercase ${STATUS_BADGE[u.statusChange]}`}>→ {statusLabel(t, u.statusChange)}</span> : null}
                {canManage ? <button type="button" disabled={busy} onClick={() => void delUpdate(u.id)} className="ml-auto text-keep-accent hover:underline">{t("modCasesTab.removeLower")}</button> : null}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-keep-text">{u.body}</p>
            </div>
          ))}
        </div>
      ) : null}

      {canManage ? (
        <div className="mt-3 space-y-2 border-t border-keep-rule/60 pt-2">
          {/* Add-update composer */}
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end">
            <label className="flex-1 text-[10px] uppercase tracking-widest text-keep-muted">
              {t("modCasesTab.addUpdateLabel")}
              <textarea className={`${inputClass} mt-0.5 min-h-[2.5rem]`} value={upBody} onChange={(e) => setUpBody(e.target.value)} placeholder={t("modCasesTab.updatePlaceholder")} maxLength={8000} />
            </label>
            {!isNote ? (
              <select className={`${inputClass} sm:w-36`} value={upStatus} onChange={(e) => setUpStatus(e.target.value as CaseStatus | "")} title={t("modCasesTab.statusSelectTitle")}>
                <option value="">{t("modCasesTab.keepStatus")}</option>
                {(["open", "in_progress", "resolved"] as const).map((s) => <option key={s} value={s}>{t("modCasesTab.setStatus", { status: statusLabel(t, s) })}</option>)}
              </select>
            ) : null}
            <button type="button" disabled={busy || !upBody.trim()} onClick={() => void addUpdate()} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">{t("modCasesTab.add")}</button>
          </div>
          {/* Quick status + edit/delete */}
          <div className="flex flex-wrap items-center gap-2">
            {!isNote ? (["open", "in_progress", "resolved"] as const).map((s) => (
              <button key={s} type="button" disabled={busy || c.status === s} onClick={() => void setStatus(s)}
                className={`rounded px-2 py-0.5 text-xs ${c.status === s ? STATUS_BADGE[s] + " font-semibold" : "border border-keep-rule text-keep-muted hover:text-keep-text"}`}>
                {statusLabel(t, s)}
              </button>
            )) : null}
            <button type="button" onClick={onEdit} className={`${btnClass} ml-auto`}>{t("shared.edit")}</button>
            <button type="button" onClick={remove} className="rounded border border-keep-accent/40 px-2 py-0.5 text-xs text-keep-accent hover:bg-keep-accent/10">{t("shared.delete")}</button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/* ============================================================
 * The tab
 * ============================================================ */

export default function ModCasesTab({
  serverId,
  viewer,
  busy,
  run,
  onSaved,
}: {
  serverId: string;
  viewer: ServerViewerState;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}): React.ReactElement {
  const { t } = useTranslation("servers");
  // Gate the action UI on the mirrored permission, exactly like the routes
  // re-check; owner implies the key.
  const canManage = viewer.isOwner || viewer.permissions.includes("manage_mod_cases");
  const [cases, setCases] = useState<ModCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [tab, setTab] = useState<FilterTab>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // case id being edited, or "new"
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<ProfileView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  async function openParty(p: { userId: string | null; characterId: string | null; fallbackLabel: string | null }) {
    setViewError(null);
    const target = p.characterId ? `@cid:${p.characterId}` : p.userId ? `@id:${p.userId}` : p.fallbackLabel;
    if (!target) { setViewError(t("modCasesTab.identityUnresolved")); return; }
    try {
      const r = await fetch(`/profiles/${encodeURIComponent(target)}`, { credentials: "include" });
      if (!r.ok) { setViewError(r.status === 404 ? t("modCasesTab.identityGone") : t("console.users.profileLoadHttp", { status: r.status })); return; }
      const j = await r.json();
      if (j && "private" in j) { setViewError(t("console.users.profileRestricted")); return; }
      setViewing(j as ProfileView);
    } catch {
      setViewError(t("console.users.profileLoadError"));
    }
  }

  // Refetch on filter/sort/search change AND after a save/action (tick).
  useEffect(() => {
    let alive = true;
    setError(null);
    const params = new URLSearchParams();
    if (tab === "notes") params.set("kind", "note");
    else if (tab !== "all") { params.set("status", tab); params.set("kind", "case"); }
    if (sort !== "newest") params.set("sort", sort);
    if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
    const qs = params.toString();
    fetch(`/servers/${sid(serverId)}/mod-cases${qs ? `?${qs}` : ""}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return (await r.json()) as { cases: ModCase[] };
      })
      .then((j) => { if (alive) setCases(j.cases); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : t("shared.loadFailed")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, tab, sort, debouncedSearch, tick]);

  // After any change, refetch this tab AND let the console refresh shared state
  // (mirrors the other tabs' onSaved contract).
  const refresh = () => { setTick((t) => t + 1); onSaved(); };

  function startNew() { setForm(EMPTY_FORM); setInfo(null); setEditing("new"); }
  function startEdit(c: ModCase) {
    setForm({
      nature: c.nature,
      kind: c.kind,
      reporter: c.reporterText ?? "",
      subject: c.subjectText ?? "",
      complaintBody: c.complaintBody,
      resolution: c.resolution ?? "",
      status: c.status,
      evidenceMessageIds: "",
    });
    setInfo(null);
    setEditing(c.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      const payload = {
        nature: form.nature.trim(),
        kind: form.kind,
        complaintBody: form.complaintBody.trim(),
        reporter: form.reporter.trim() || undefined,
        subject: form.subject.trim() || undefined,
        resolution: form.resolution.trim() || undefined,
        status: form.kind === "note" ? undefined : form.status,
        evidenceMessageIds: form.evidenceMessageIds.trim() || undefined,
      };
      const isNew = editing === "new";
      const r = await fetch(
        isNew ? `/servers/${sid(serverId)}/mod-cases` : `/servers/${sid(serverId)}/mod-cases/${sid(editing!)}`,
        {
          method: isNew ? "POST" : "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { evidenceSnapshotted?: number };
      const requested = payload.evidenceMessageIds ? payload.evidenceMessageIds.split(/[\s,]+/).filter(Boolean).length : 0;
      if (requested > 0) {
        const found = j.evidenceSnapshotted ?? 0;
        setInfo(found < requested ? t("modCasesTab.backedUpPartial", { found, requested, skipped: requested - found }) : t("modCasesTab.backedUpAll", { count: found }));
      }
      setEditing(null);
      setForm(EMPTY_FORM);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("shared.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const isNoteForm = form.kind === "note";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-keep-muted">{t("modCasesTab.heading")}</h2>
        <p className="text-[11px] text-keep-muted">
          <Trans t={t} i18nKey="modCasesTab.blurb" values={{ id: "@id:", cid: "@cid:" }} components={{ code: <code /> }} />
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 text-xs">
          {TABS.map((tb) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => setTab(tb.key)}
              className={`rounded px-2 py-0.5 ${tab === tb.key ? "bg-keep-action/15 text-keep-action" : "text-keep-muted hover:text-keep-text"}`}
            >
              {t(tb.labelKey)}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("modCasesTab.searchPlaceholder")}
          className={`${inputClass} h-7 max-w-[16rem] flex-1`}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={`${inputClass} h-7 w-auto`} title={t("modCasesTab.sortTitle")}>
          {SORTS.map((s) => <option key={s.key} value={s.key}>{t(s.labelKey)}</option>)}
        </select>
        {canManage && editing === null ? (
          <button type="button" onClick={startNew} className="rounded border border-keep-action/50 bg-keep-action/10 px-2 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/20">
            {t("modCasesTab.newButton")}
          </button>
        ) : null}
      </div>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</div> : null}
      {info ? <div className="rounded border border-keep-action/40 bg-keep-action/10 px-2 py-1 text-xs text-keep-action">{info}</div> : null}

      {editing !== null ? (
        <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg/40 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-keep-muted">
              {t("modCasesTab.typeLabel")}
              <select className={inputClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as CaseKind })}>
                <option value="case">{t("modCasesTab.kindCase")}</option>
                <option value="note">{t("modCasesTab.kindNote")}</option>
              </select>
            </label>
            <label className="text-xs text-keep-muted">
              {t("modCasesTab.categoryLabel")}
              <input className={inputClass} list="server-modcase-natures" value={form.nature} onChange={(e) => setForm({ ...form, nature: e.target.value })} placeholder={t("modCasesTab.categoryPlaceholder")} maxLength={80} required />
              <datalist id="server-modcase-natures">{NATURE_SUGGESTION_KEYS.map((k) => { const n = t(k); return <option key={n} value={n} />; })}</datalist>
            </label>
            <label className="text-xs text-keep-muted">
              {t("modCasesTab.reporterLabel")}
              <input className={inputClass} value={form.reporter} onChange={(e) => setForm({ ...form, reporter: e.target.value })} placeholder={t("modCasesTab.identityPlaceholder")} maxLength={120} />
            </label>
            <label className="text-xs text-keep-muted">
              {t("modCasesTab.subjectLabel")}
              <input className={inputClass} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder={t("modCasesTab.identityPlaceholder")} maxLength={120} />
            </label>
            {!isNoteForm ? (
              <label className="text-xs text-keep-muted">
                {t("modCasesTab.statusLabel")}
                <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CaseStatus })}>
                  <option value="open">{t("modCasesTab.statusOpen")}</option>
                  <option value="in_progress">{t("modCasesTab.statusInProgress")}</option>
                  <option value="resolved">{t("modCasesTab.statusResolved")}</option>
                </select>
              </label>
            ) : null}
          </div>
          <label className="block text-xs text-keep-muted">
            {isNoteForm ? t("modCasesTab.noteChip") : t("modCasesTab.complaintLabel")}
            <textarea className={`${inputClass} min-h-[5rem]`} value={form.complaintBody} onChange={(e) => setForm({ ...form, complaintBody: e.target.value })} maxLength={8000} required />
          </label>
          {!isNoteForm ? (
            <label className="block text-xs text-keep-muted">
              {t("modCasesTab.resolutionFieldLabel")}
              <textarea className={`${inputClass} min-h-[3rem]`} value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })} placeholder={t("modCasesTab.resolutionPlaceholder")} maxLength={8000} />
            </label>
          ) : null}
          <label className="block text-xs text-keep-muted">
            {t("modCasesTab.evidenceLabel")} <span className="opacity-70">{t("modCasesTab.evidenceHintInline")}</span>
            <input className={inputClass} value={form.evidenceMessageIds} onChange={(e) => setForm({ ...form, evidenceMessageIds: e.target.value })} placeholder={t("modCasesTab.evidencePlaceholder")} maxLength={4000} />
            <span className="mt-0.5 block text-[10px] text-keep-muted/80">{t("modCasesTab.evidenceHintBlock")}</span>
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">
              {saving ? t("shared.saving") : editing === "new" ? (isNoteForm ? t("modCasesTab.createNote") : t("modCasesTab.createCase")) : t("announceTab.saveChanges")}
            </button>
            <button type="button" onClick={() => { setEditing(null); setForm(EMPTY_FORM); }} className={btnClass}>{t("shared.cancel")}</button>
          </div>
        </form>
      ) : null}

      {cases === null ? (
        <p className="text-xs italic text-keep-muted">{t("shared.loading")}</p>
      ) : cases.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{debouncedSearch.trim() ? t("modCasesTab.noSearchMatches") : t("modCasesTab.noCases")}</p>
      ) : (
        <ul className="space-y-2">
          {cases.map((c) => (
            <CaseCard
              key={c.id}
              c={c}
              serverId={serverId}
              canManage={canManage}
              busy={busy}
              run={run}
              onChanged={refresh}
              onEdit={() => startEdit(c)}
              onOpenParty={(p) => void openParty(p)}
              onError={setError}
            />
          ))}
        </ul>
      )}

      {viewError ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{viewError}</div> : null}
      {viewing ? (
        <ProfileModal profile={viewing} onClose={() => setViewing(null)} bypassNsfwGate={true} zIndex={60} />
      ) : null}
    </div>
  );
}
