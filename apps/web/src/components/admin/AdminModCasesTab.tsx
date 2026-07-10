import { useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ProfileView } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { formatDateTime } from "../../lib/intlFormat.js";
import { useChat } from "../../state/store.js";
import { ProfileModal } from "../profile/ProfileModal.js";

/**
 * Admin "Mod Log" tab — the moderation case log.
 *
 * `view_admin_mod_cases` gates the tab (read); `manage_mod_cases` gates
 * create/edit/resolve/delete + the update timeline + evidence backup. Reporter
 * and subject accept freehand text OR an `@id:`/`@cid:` token; the server
 * resolves it into a stored link + label so the log stays queryable by person.
 */

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
  relatedReportId: string | null;
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
 *  Catalog keys under `modCases.nature.*`; resolved with t() at render. */
const NATURE_SUGGESTION_KEYS = ["spam", "nsfw", "harassment", "oocDispute", "banEvasion", "underage", "impersonation", "advertising", "threats", "consent", "other"] as const;

type Tab = "all" | "open" | "in_progress" | "resolved" | "notes";
const TAB_KEYS: readonly Tab[] = ["all", "open", "in_progress", "resolved", "notes"];
type Sort = "newest" | "oldest" | "updated" | "reporter" | "subject" | "nature";
const SORT_KEYS: readonly Sort[] = ["newest", "oldest", "updated", "reporter", "subject", "nature"];

const STATUS_BADGE: Record<CaseStatus, string> = {
  open: "bg-keep-accent/15 text-keep-accent",
  in_progress: "bg-keep-action/15 text-keep-action",
  resolved: "bg-keep-muted/20 text-keep-muted",
};

const inputClass = "w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm text-keep-text outline-none focus:border-keep-action";
const btnClass = "rounded border border-keep-rule px-2 py-0.5 text-xs text-keep-muted hover:text-keep-text";

/**
 * A reporter/subject cell. When linked to a real identity it renders as a
 * clickable chip that opens that profile; otherwise plain freehand text.
 */
function Party({
  label, text, linked, isCharacter, onOpen,
}: {
  label: string | null;
  text: string | null;
  linked: boolean;
  isCharacter: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation("admin");
  if (linked && label) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 rounded border border-keep-action/40 bg-keep-action/10 px-1.5 py-0.5 text-[11px] font-semibold text-keep-action hover:bg-keep-action/20"
        title={isCharacter ? t("modCases.openCharProfile") : t("modCases.openOocProfile")}
      >
        {label}
        <span className="text-[8px] uppercase tracking-widest opacity-70">{isCharacter ? t("modCases.charBadge") : t("modCases.oocBadge")}</span>
      </button>
    );
  }
  if (text) return <span className="text-keep-text">{text}</span>;
  return <span className="italic text-keep-muted/60">-</span>;
}

/** One case (or note) row with its evidence, timeline, and update composer. */
function CaseCard({
  c, canManage, onChanged, onEdit, onOpenParty, onError,
}: {
  c: ModCase;
  canManage: boolean;
  onChanged: () => void;
  onEdit: () => void;
  onOpenParty: (p: { userId: string | null; characterId: string | null; fallbackLabel: string | null }) => void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation("admin");
  const [upBody, setUpBody] = useState("");
  const [upStatus, setUpStatus] = useState<CaseStatus | "">("");
  const [busy, setBusy] = useState(false);
  const isNote = c.kind === "note";

  async function call(url: string, init: RequestInit) {
    setBusy(true);
    try {
      const r = await fetch(url, { credentials: "include", ...init });
      if (!r.ok) throw new Error(await readError(r));
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : t("failed"));
    } finally {
      setBusy(false);
    }
  }

  async function addUpdate() {
    if (!upBody.trim()) return;
    const payload: { body: string; status?: CaseStatus } = { body: upBody.trim() };
    if (upStatus) payload.status = upStatus;
    await call(`/admin/mod-cases/${c.id}/updates`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    setUpBody(""); setUpStatus("");
  }
  const setStatus = (status: CaseStatus) =>
    call(`/admin/mod-cases/${c.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
  const delUpdate = (uid: string) =>
    call(`/admin/mod-cases/${c.id}/updates/${uid}`, { method: "DELETE" });
  const delEvidence = (eid: string) =>
    call(`/admin/mod-cases/${c.id}/evidence/${eid}`, { method: "DELETE" });
  function remove() {
    if (!window.confirm(isNote ? t("modCases.deleteNoteConfirm") : t("modCases.deleteCaseConfirm"))) return;
    void call(`/admin/mod-cases/${c.id}`, { method: "DELETE" });
  }

  return (
    <li className="rounded border border-keep-rule bg-keep-panel/30 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {isNote ? (
          <span className="rounded bg-keep-action/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-keep-muted">{t("modCases.noteBadge")}</span>
        ) : (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_BADGE[c.status]}`}>{t(`modCases.status.${c.status}`)}</span>
        )}
        <span className="font-semibold text-keep-text">{c.nature}</span>
        <span className="ml-auto text-[11px] text-keep-muted" title={c.createdByName ? t("modCases.loggedBy", { name: c.createdByName }) : undefined}>
          {formatDateTime(c.createdAt)}{c.createdByName ? ` · ${c.createdByName}` : ""}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-keep-muted">
        <span>{t("modCases.from")}<Party label={c.reporterLabel} text={c.reporterText} linked={!!c.reporterUserId} isCharacter={!!c.reporterCharacterId} onOpen={() => onOpenParty({ userId: c.reporterUserId, characterId: c.reporterCharacterId, fallbackLabel: c.reporterLabel })} /></span>
        <span>{t("modCases.about")}<Party label={c.subjectLabel} text={c.subjectText} linked={!!c.subjectUserId} isCharacter={!!c.subjectCharacterId} onOpen={() => onOpenParty({ userId: c.subjectUserId, characterId: c.subjectCharacterId, fallbackLabel: c.subjectLabel })} /></span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-keep-text">{c.complaintBody}</p>
      {c.resolution ? (
        <p className="mt-2 whitespace-pre-wrap border-l-2 border-keep-action/40 pl-2 text-keep-muted">
          <span className="font-semibold text-keep-text">{t("modCases.resolutionLabel")}</span>{c.resolution}
        </p>
      ) : null}

      {/* Backed-up message evidence (survives the janitor). */}
      {c.evidence.length > 0 ? (
        <div className="mt-2 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-keep-muted">{t("modCases.backedUpMessages", { count: c.evidence.length })}</p>
          {c.evidence.map((e) => (
            <div key={e.id} className="rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1 text-xs">
              <div className="flex items-center gap-2 text-[10px] text-keep-muted">
                <span className="font-semibold text-keep-text">{e.authorLabel ?? t("modCases.unknown")}</span>
                {e.roomName ? <span>{t("modCases.inRoom", { room: e.roomName })}</span> : null}
                {e.originalCreatedAt ? <span>· {formatDateTime(e.originalCreatedAt)}</span> : null}
                {e.kind && e.kind !== "say" ? <span className="uppercase tracking-widest">· {e.kind}</span> : null}
                {canManage ? <button type="button" disabled={busy} onClick={() => void delEvidence(e.id)} className="ml-auto text-keep-accent hover:underline">{t("modCases.remove")}</button> : null}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-keep-text">{e.body ?? <span className="italic text-keep-muted">{t("modCases.emptyBody")}</span>}</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* Update timeline (append-only). */}
      {c.updates.length > 0 ? (
        <div className="mt-2 space-y-1 border-l-2 border-keep-rule/60 pl-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-keep-muted">{t("modCases.updates")}</p>
          {c.updates.map((u) => (
            <div key={u.id} className="text-xs">
              <div className="flex items-center gap-2 text-[10px] text-keep-muted">
                <span className="font-semibold text-keep-text">{u.authorName ?? t("modCases.staff")}</span>
                <span>{formatDateTime(u.createdAt)}</span>
                {u.statusChange ? <span className={`rounded px-1 py-0 text-[9px] font-semibold uppercase ${STATUS_BADGE[u.statusChange]}`}>→ {t(`modCases.status.${u.statusChange}`)}</span> : null}
                {canManage ? <button type="button" disabled={busy} onClick={() => void delUpdate(u.id)} className="ml-auto text-keep-accent hover:underline">{t("modCases.remove")}</button> : null}
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
              {t("modCases.addUpdate")}
              <textarea className={`${inputClass} mt-0.5 min-h-[2.5rem]`} value={upBody} onChange={(e) => setUpBody(e.target.value)} placeholder={t("modCases.updatePlaceholder")} maxLength={8000} />
            </label>
            {!isNote ? (
              <select className={`${inputClass} sm:w-36`} value={upStatus} onChange={(e) => setUpStatus(e.target.value as CaseStatus | "")} title={t("modCases.statusSelectTitle")}>
                <option value="">{t("modCases.keepStatus")}</option>
                {(["open", "in_progress", "resolved"] as const).map((s) => <option key={s} value={s}>{t("modCases.setStatus", { status: t(`modCases.status.${s}`) })}</option>)}
              </select>
            ) : null}
            <button type="button" disabled={busy || !upBody.trim()} onClick={() => void addUpdate()} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">{t("add")}</button>
          </div>
          {/* Quick status + edit/delete */}
          <div className="flex flex-wrap items-center gap-2">
            {!isNote ? (["open", "in_progress", "resolved"] as const).map((s) => (
              <button key={s} type="button" disabled={busy || c.status === s} onClick={() => void setStatus(s)}
                className={`rounded px-2 py-0.5 text-xs ${c.status === s ? STATUS_BADGE[s] + " font-semibold" : "border border-keep-rule text-keep-muted hover:text-keep-text"}`}>
                {t(`modCases.status.${s}`)}
              </button>
            )) : null}
            <button type="button" onClick={onEdit} className={`${btnClass} ml-auto`}>{t("edit")}</button>
            <button type="button" onClick={remove} className="rounded border border-keep-accent/40 px-2 py-0.5 text-xs text-keep-accent hover:bg-keep-accent/10">{t("common:delete")}</button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function AdminModCasesTab() {
  const { t } = useTranslation("admin");
  const canManage = useChat((s) => s.me?.permissions.includes("manage_mod_cases") ?? false);
  const [cases, setCases] = useState<ModCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // case id being edited, or "new"
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<ProfileView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  async function openParty(p: { userId: string | null; characterId: string | null; fallbackLabel: string | null }) {
    setViewError(null);
    const target = p.characterId ? `@cid:${p.characterId}` : p.userId ? `@id:${p.userId}` : p.fallbackLabel;
    if (!target) { setViewError(t("modCases.resolveError")); return; }
    try {
      const r = await fetch(`/profiles/${encodeURIComponent(target)}`, { credentials: "include" });
      if (!r.ok) { setViewError(r.status === 404 ? t("modCases.identityGone") : t("modCases.profileLoadHttpError", { status: r.status })); return; }
      const j = await r.json();
      if (j && "private" in j) { setViewError(t("modCases.profileRestricted")); return; }
      setViewing(j as ProfileView);
    } catch {
      setViewError(t("modCases.profileLoadError"));
    }
  }

  async function load() {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (tab === "notes") params.set("kind", "note");
      else if (tab !== "all") { params.set("status", tab); params.set("kind", "case"); }
      if (sort !== "newest") params.set("sort", sort);
      if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
      const qs = params.toString();
      const r = await fetch(`/admin/mod-cases${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { cases: ModCase[] };
      setCases(j.cases);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("loadFailed"));
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, sort, debouncedSearch]);

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
      const r = await fetch(isNew ? "/admin/mod-cases" : `/admin/mod-cases/${editing}`, {
        method: isNew ? "POST" : "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { evidenceSnapshotted?: number };
      const requested = payload.evidenceMessageIds ? payload.evidenceMessageIds.split(/[\s,]+/).filter(Boolean).length : 0;
      if (requested > 0) {
        const found = j.evidenceSnapshotted ?? 0;
        setInfo(found < requested ? t("modCases.backupPartial", { found, requested, missing: requested - found }) : t("modCases.backupDone", { count: found }));
      }
      setEditing(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const isNoteForm = form.kind === "note";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-keep-muted">{t("modCases.title")}</h2>
        <p className="text-xs text-keep-muted">
          <Trans t={t} i18nKey="modCases.description">
            {"A record of complaints, reports, disputes, and notes handled by staff: who complained, about whom or what, and how it was resolved. Reporter and subject accept a plain name or an "}
            <code>@id:</code>
            {"/"}
            <code>@cid:</code>
            {" token to link the exact identity. This is separate from the user-filed Reports queue."}
          </Trans>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 text-xs">
          {TAB_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded px-2 py-0.5 ${tab === key ? "bg-keep-action/15 text-keep-action" : "text-keep-muted hover:text-keep-text"}`}
            >
              {t(`modCases.tab.${key}`)}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("modCases.searchPlaceholder")}
          className={`${inputClass} h-7 max-w-[16rem] flex-1`}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={`${inputClass} h-7 w-auto`} title={t("modCases.sortTitle")}>
          {SORT_KEYS.map((key) => <option key={key} value={key}>{t(`modCases.sort.${key}`)}</option>)}
        </select>
        {canManage && editing === null ? (
          <button type="button" onClick={startNew} className="rounded border border-keep-action/50 bg-keep-action/10 px-2 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/20">
            {t("modCases.new")}
          </button>
        ) : null}
      </div>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</div> : null}
      {info ? <div className="rounded border border-keep-action/40 bg-keep-action/10 px-2 py-1 text-xs text-keep-action">{info}</div> : null}

      {editing !== null ? (
        <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg/40 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-keep-muted">
              {t("modCases.typeLabel")}
              <select className={inputClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as CaseKind })}>
                <option value="case">{t("modCases.kindCase")}</option>
                <option value="note">{t("modCases.kindNote")}</option>
              </select>
            </label>
            <label className="text-xs text-keep-muted">
              {t("modCases.categoryLabel")}
              <input className={inputClass} list="modcase-natures" value={form.nature} onChange={(e) => setForm({ ...form, nature: e.target.value })} placeholder={t("modCases.categoryPlaceholder")} maxLength={80} required />
              <datalist id="modcase-natures">{NATURE_SUGGESTION_KEYS.map((k) => <option key={k} value={t(`modCases.nature.${k}`)} />)}</datalist>
            </label>
            <label className="text-xs text-keep-muted">
              {t("modCases.reporterLabel")}
              <input className={inputClass} value={form.reporter} onChange={(e) => setForm({ ...form, reporter: e.target.value })} placeholder={t("modCases.partyPlaceholder")} maxLength={120} />
            </label>
            <label className="text-xs text-keep-muted">
              {t("modCases.subjectLabel")}
              <input className={inputClass} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder={t("modCases.partyPlaceholder")} maxLength={120} />
            </label>
            {!isNoteForm ? (
              <label className="text-xs text-keep-muted">
                {t("modCases.statusLabel")}
                <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CaseStatus })}>
                  <option value="open">{t("modCases.status.open")}</option>
                  <option value="in_progress">{t("modCases.status.in_progress")}</option>
                  <option value="resolved">{t("modCases.status.resolved")}</option>
                </select>
              </label>
            ) : null}
          </div>
          <label className="block text-xs text-keep-muted">
            {isNoteForm ? t("modCases.noteFieldLabel") : t("modCases.complaintFieldLabel")}
            <textarea className={`${inputClass} min-h-[5rem]`} value={form.complaintBody} onChange={(e) => setForm({ ...form, complaintBody: e.target.value })} maxLength={8000} required />
          </label>
          {!isNoteForm ? (
            <label className="block text-xs text-keep-muted">
              {t("modCases.resolutionFieldLabel")}
              <textarea className={`${inputClass} min-h-[3rem]`} value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })} placeholder={t("modCases.resolutionPlaceholder")} maxLength={8000} />
            </label>
          ) : null}
          <label className="block text-xs text-keep-muted">
            {t("modCases.evidenceLabel")} <span className="opacity-70">{t("modCases.evidenceLabelHint")}</span>
            <input className={inputClass} value={form.evidenceMessageIds} onChange={(e) => setForm({ ...form, evidenceMessageIds: e.target.value })} placeholder={t("modCases.evidencePlaceholder")} maxLength={4000} />
            <span className="mt-0.5 block text-[10px] text-keep-muted/80">{t("modCases.evidenceHelp")}</span>
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">
              {saving ? t("common:saving") : editing === "new" ? (isNoteForm ? t("modCases.createNote") : t("modCases.createCase")) : t("saveChanges")}
            </button>
            <button type="button" onClick={() => { setEditing(null); setForm(EMPTY_FORM); }} className={btnClass}>{t("common:cancel")}</button>
          </div>
        </form>
      ) : null}

      {cases === null ? (
        <p className="text-xs italic text-keep-muted">{t("common:loading")}</p>
      ) : cases.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{debouncedSearch.trim() ? t("modCases.noSearchMatches") : t("modCases.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {cases.map((c) => (
            <CaseCard
              key={c.id}
              c={c}
              canManage={canManage}
              onChanged={() => void load()}
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
