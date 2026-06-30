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
import type { ProfileView, ServerViewerState } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { ProfileModal } from "../ProfileModal.js";

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

/** Suggested complaint categories for the nature datalist (still freehand). */
const NATURE_SUGGESTIONS = ["Spam", "NSFW", "Harassment", "OOC dispute", "Ban evasion", "Underage content", "Impersonation", "Advertising / poaching", "Threats", "Consent / boundary", "Other"];

type FilterTab = "all" | "open" | "in_progress" | "resolved" | "notes";
const TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "resolved", label: "Resolved" },
  { key: "notes", label: "Notes" },
];
type Sort = "newest" | "oldest" | "updated" | "reporter" | "subject" | "nature";
const SORTS: { key: Sort; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "updated", label: "Recently updated" },
  { key: "reporter", label: "Reporter A–Z" },
  { key: "subject", label: "Subject A–Z" },
  { key: "nature", label: "Category A–Z" },
];

const STATUS_LABEL: Record<CaseStatus, string> = { open: "Open", in_progress: "In progress", resolved: "Resolved" };
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
  if (linked && label) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 rounded border border-keep-action/40 bg-keep-action/10 px-1.5 py-0.5 text-[11px] font-semibold text-keep-action hover:bg-keep-action/20"
        title={`Open ${isCharacter ? "character" : "OOC"} profile`}
      >
        {label}
        <span className="text-[8px] uppercase tracking-widest opacity-70">{isCharacter ? "char" : "ooc"}</span>
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
    if (!window.confirm(`Delete this ${isNote ? "note" : "case"}? This cannot be undone (its updates and backed-up evidence go too).`)) return;
    void call(`/servers/${sid(serverId)}/mod-cases/${sid(c.id)}`, { method: "DELETE" });
  }

  return (
    <li className="rounded border border-keep-rule bg-keep-panel/30 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {isNote ? (
          <span className="rounded bg-keep-action/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-keep-muted">Note</span>
        ) : (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
        )}
        <span className="font-semibold text-keep-text">{c.nature}</span>
        <span className="ml-auto text-[11px] text-keep-muted" title={c.createdByName ? `Logged by ${c.createdByName}` : undefined}>
          {new Date(c.createdAt).toLocaleString()}{c.createdByName ? ` · ${c.createdByName}` : ""}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-keep-muted">
        <span>From: <Party label={c.reporterLabel} text={c.reporterText} linked={!!c.reporterUserId} isCharacter={!!c.reporterCharacterId} onOpen={() => onOpenParty({ userId: c.reporterUserId, characterId: c.reporterCharacterId, fallbackLabel: c.reporterLabel })} /></span>
        <span>About: <Party label={c.subjectLabel} text={c.subjectText} linked={!!c.subjectUserId} isCharacter={!!c.subjectCharacterId} onOpen={() => onOpenParty({ userId: c.subjectUserId, characterId: c.subjectCharacterId, fallbackLabel: c.subjectLabel })} /></span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-keep-text">{c.complaintBody}</p>
      {c.resolution ? (
        <p className="mt-2 whitespace-pre-wrap border-l-2 border-keep-action/40 pl-2 text-keep-muted">
          <span className="font-semibold text-keep-text">Resolution: </span>{c.resolution}
        </p>
      ) : null}

      {/* Backed-up message evidence (survives the janitor). */}
      {c.evidence.length > 0 ? (
        <div className="mt-2 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-keep-muted">Backed-up messages ({c.evidence.length})</p>
          {c.evidence.map((e) => (
            <div key={e.id} className="rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1 text-xs">
              <div className="flex items-center gap-2 text-[10px] text-keep-muted">
                <span className="font-semibold text-keep-text">{e.authorLabel ?? "unknown"}</span>
                {e.roomName ? <span>in {e.roomName}</span> : null}
                {e.originalCreatedAt ? <span>· {new Date(e.originalCreatedAt).toLocaleString()}</span> : null}
                {e.kind && e.kind !== "say" ? <span className="uppercase tracking-widest">· {e.kind}</span> : null}
                {canManage ? <button type="button" disabled={busy} onClick={() => void delEvidence(e.id)} className="ml-auto text-keep-accent hover:underline">remove</button> : null}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-keep-text">{e.body ?? <span className="italic text-keep-muted">(empty)</span>}</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* Update timeline (append-only). */}
      {c.updates.length > 0 ? (
        <div className="mt-2 space-y-1 border-l-2 border-keep-rule/60 pl-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-keep-muted">Updates</p>
          {c.updates.map((u) => (
            <div key={u.id} className="text-xs">
              <div className="flex items-center gap-2 text-[10px] text-keep-muted">
                <span className="font-semibold text-keep-text">{u.authorName ?? "staff"}</span>
                <span>{new Date(u.createdAt).toLocaleString()}</span>
                {u.statusChange ? <span className={`rounded px-1 py-0 text-[9px] font-semibold uppercase ${STATUS_BADGE[u.statusChange]}`}>→ {STATUS_LABEL[u.statusChange]}</span> : null}
                {canManage ? <button type="button" disabled={busy} onClick={() => void delUpdate(u.id)} className="ml-auto text-keep-accent hover:underline">remove</button> : null}
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
              Add update
              <textarea className={`${inputClass} mt-0.5 min-h-[2.5rem]`} value={upBody} onChange={(e) => setUpBody(e.target.value)} placeholder="Progress note, contact made, outcome…" maxLength={8000} />
            </label>
            {!isNote ? (
              <select className={`${inputClass} sm:w-36`} value={upStatus} onChange={(e) => setUpStatus(e.target.value as CaseStatus | "")} title="Optionally change status with this update">
                <option value="">Keep status</option>
                {(["open", "in_progress", "resolved"] as const).map((s) => <option key={s} value={s}>Set {STATUS_LABEL[s]}</option>)}
              </select>
            ) : null}
            <button type="button" disabled={busy || !upBody.trim()} onClick={() => void addUpdate()} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">Add</button>
          </div>
          {/* Quick status + edit/delete */}
          <div className="flex flex-wrap items-center gap-2">
            {!isNote ? (["open", "in_progress", "resolved"] as const).map((s) => (
              <button key={s} type="button" disabled={busy || c.status === s} onClick={() => void setStatus(s)}
                className={`rounded px-2 py-0.5 text-xs ${c.status === s ? STATUS_BADGE[s] + " font-semibold" : "border border-keep-rule text-keep-muted hover:text-keep-text"}`}>
                {STATUS_LABEL[s]}
              </button>
            )) : null}
            <button type="button" onClick={onEdit} className={`${btnClass} ml-auto`}>Edit</button>
            <button type="button" onClick={remove} className="rounded border border-keep-accent/40 px-2 py-0.5 text-xs text-keep-accent hover:bg-keep-accent/10">Delete</button>
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
    if (!target) { setViewError("Couldn't resolve that identity."); return; }
    try {
      const r = await fetch(`/profiles/${encodeURIComponent(target)}`, { credentials: "include" });
      if (!r.ok) { setViewError(r.status === 404 ? "That identity no longer exists (renamed away or deleted)." : `Couldn't load profile (HTTP ${r.status}).`); return; }
      const j = await r.json();
      if (j && "private" in j) { setViewError("That profile is restricted."); return; }
      setViewing(j as ProfileView);
    } catch {
      setViewError("Couldn't load profile.");
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
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "load failed"); });
    return () => { alive = false; };
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
        setInfo(found < requested ? `Backed up ${found} of ${requested} messages (${requested - found} skipped: not found, or from another server's room).` : `Backed up ${found} message${found === 1 ? "" : "s"}.`);
      }
      setEditing(null);
      setForm(EMPTY_FORM);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  const isNoteForm = form.kind === "note";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-keep-muted">Moderation case log</h2>
        <p className="text-[11px] text-keep-muted">
          A record of complaints, disputes, and notes your team handled on this server: who complained, about whom or what,
          and how it was resolved. Reporter and subject accept a plain name or an <code>@id:</code>/<code>@cid:</code> token
          to link the exact identity. Banning a member happens on the Bans tab; this log records the outcome. This is separate
          from the read-only Mod Log audit feed.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 text-xs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded px-2 py-0.5 ${tab === t.key ? "bg-keep-action/15 text-keep-action" : "text-keep-muted hover:text-keep-text"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search reporter, subject, category, text…"
          className={`${inputClass} h-7 max-w-[16rem] flex-1`}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={`${inputClass} h-7 w-auto`} title="Sort order">
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {canManage && editing === null ? (
          <button type="button" onClick={startNew} className="rounded border border-keep-action/50 bg-keep-action/10 px-2 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/20">
            + New
          </button>
        ) : null}
      </div>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</div> : null}
      {info ? <div className="rounded border border-keep-action/40 bg-keep-action/10 px-2 py-1 text-xs text-keep-action">{info}</div> : null}

      {editing !== null ? (
        <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg/40 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-keep-muted">
              Type
              <select className={inputClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as CaseKind })}>
                <option value="case">Case (infraction / dispute)</option>
                <option value="note">Note (informational only)</option>
              </select>
            </label>
            <label className="text-xs text-keep-muted">
              Category
              <input className={inputClass} list="server-modcase-natures" value={form.nature} onChange={(e) => setForm({ ...form, nature: e.target.value })} placeholder="e.g. Harassment, Spam, NSFW" maxLength={80} required />
              <datalist id="server-modcase-natures">{NATURE_SUGGESTIONS.map((n) => <option key={n} value={n} />)}</datalist>
            </label>
            <label className="text-xs text-keep-muted">
              Who complained
              <input className={inputClass} value={form.reporter} onChange={(e) => setForm({ ...form, reporter: e.target.value })} placeholder="name, @id:…, @cid:…, or freehand" maxLength={120} />
            </label>
            <label className="text-xs text-keep-muted">
              About whom / what
              <input className={inputClass} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="name, @id:…, @cid:…, or freehand" maxLength={120} />
            </label>
            {!isNoteForm ? (
              <label className="text-xs text-keep-muted">
                Status
                <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CaseStatus })}>
                  <option value="open">Open</option>
                  <option value="in_progress">In progress</option>
                  <option value="resolved">Resolved</option>
                </select>
              </label>
            ) : null}
          </div>
          <label className="block text-xs text-keep-muted">
            {isNoteForm ? "Note" : "Complaint / details"}
            <textarea className={`${inputClass} min-h-[5rem]`} value={form.complaintBody} onChange={(e) => setForm({ ...form, complaintBody: e.target.value })} maxLength={8000} required />
          </label>
          {!isNoteForm ? (
            <label className="block text-xs text-keep-muted">
              Resolution / action taken
              <textarea className={`${inputClass} min-h-[3rem]`} value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })} placeholder="Leave blank while open; add progress via Updates after saving" maxLength={8000} />
            </label>
          ) : null}
          <label className="block text-xs text-keep-muted">
            Back up message IDs <span className="opacity-70">(comma-separated, the IDs you'd /reply to)</span>
            <input className={inputClass} value={form.evidenceMessageIds} onChange={(e) => setForm({ ...form, evidenceMessageIds: e.target.value })} placeholder="msg_abc, msg_def …" maxLength={4000} />
            <span className="mt-0.5 block text-[10px] text-keep-muted/80">Snapshots those chat messages onto the case so they survive cleanup. Only messages from this server's rooms can be attached.</span>
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">
              {saving ? "Saving…" : editing === "new" ? (isNoteForm ? "Create note" : "Create case") : "Save changes"}
            </button>
            <button type="button" onClick={() => { setEditing(null); setForm(EMPTY_FORM); }} className={btnClass}>Cancel</button>
          </div>
        </form>
      ) : null}

      {cases === null ? (
        <p className="text-xs italic text-keep-muted">Loading…</p>
      ) : cases.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{debouncedSearch.trim() ? "No cases match your search." : "No cases logged yet."}</p>
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
