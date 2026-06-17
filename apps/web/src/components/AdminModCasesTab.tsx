import { useEffect, useState, type FormEvent } from "react";
import type { ProfileView } from "@thekeep/shared";
import { readError } from "../lib/http.js";
import { useChat } from "../state/store.js";
import { ProfileModal } from "./ProfileModal.js";

/**
 * Admin "Mod Log" tab — the moderation case log.
 *
 * `view_admin_mod_cases` gates the tab (read); `manage_mod_cases` gates
 * create/edit/resolve/delete. Reporter and subject accept freehand text OR an
 * `@id:`/`@cid:` identity token; the server resolves a token (or a name that
 * maps to exactly one identity) into a stored link + label so the log stays
 * queryable by person, while arbitrary text stays freehand.
 */

interface ModCase {
  id: string;
  nature: string;
  complaintBody: string;
  resolution: string | null;
  status: "open" | "resolved";
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
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

interface FormState {
  nature: string;
  reporter: string;
  subject: string;
  complaintBody: string;
  resolution: string;
  status: "open" | "resolved";
}

const EMPTY_FORM: FormState = { nature: "", reporter: "", subject: "", complaintBody: "", resolution: "", status: "open" };

const inputClass = "w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm text-keep-text outline-none focus:border-keep-action";
const btnClass = "rounded border border-keep-rule px-2 py-0.5 text-xs text-keep-muted hover:text-keep-text";

/**
 * A reporter/subject cell. When linked to a real identity it renders as a
 * clickable chip that opens that profile; otherwise plain freehand text.
 * `isCharacter` adds a small persona hint so a character link reads distinctly
 * from an OOC one.
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
  return <span className="italic text-keep-muted/60">—</span>;
}

export function AdminModCasesTab() {
  const canManage = useChat((s) => s.me?.permissions.includes("manage_mod_cases") ?? false);
  const [cases, setCases] = useState<ModCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [editing, setEditing] = useState<string | null>(null); // case id being edited, or "new"
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // Linked-profile viewer (local modal, like the admin Users tab — keeps the
  // admin panel open underneath rather than fighting the global profile state).
  const [viewing, setViewing] = useState<ProfileView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);

  /**
   * Open the profile for a linked party by its stored id, via the `@cid:`/
   * `@id:` token form of `/profiles/:name`. `resolveProfileView` resolves a
   * token to the EXACT identity from the live row, so this is both precise
   * (no per-user name collisions) and rename-proof — the whole reason the case
   * rows keep ids, not names. Falls back to the snapshot label only when no id
   * is stored (pure freehand).
   */
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

  async function load() {
    setError(null);
    try {
      const q = filter === "all" ? "" : `?status=${filter}`;
      const r = await fetch(`/admin/mod-cases${q}`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { cases: ModCase[] };
      setCases(j.cases);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  function startNew() {
    setForm(EMPTY_FORM);
    setEditing("new");
  }
  function startEdit(c: ModCase) {
    setForm({
      nature: c.nature,
      reporter: c.reporterText ?? "",
      subject: c.subjectText ?? "",
      complaintBody: c.complaintBody,
      resolution: c.resolution ?? "",
      status: c.status,
    });
    setEditing(c.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        nature: form.nature.trim(),
        complaintBody: form.complaintBody.trim(),
        reporter: form.reporter.trim() || undefined,
        subject: form.subject.trim() || undefined,
        resolution: form.resolution.trim() || undefined,
        status: form.status,
      };
      const isNew = editing === "new";
      const r = await fetch(isNew ? "/admin/mod-cases" : `/admin/mod-cases/${editing}`, {
        method: isNew ? "POST" : "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await readError(r));
      setEditing(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(c: ModCase, status: "open" | "resolved") {
    try {
      const r = await fetch(`/admin/mod-cases/${c.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed");
    }
  }

  async function remove(c: ModCase) {
    if (!window.confirm("Delete this case log entry? This cannot be undone.")) return;
    try {
      const r = await fetch(`/admin/mod-cases/${c.id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-keep-muted">Moderation case log</h2>
        <p className="text-xs text-keep-muted">
          A record of complaints, reports, and disputes handled by staff — who complained, about whom or what,
          and how it was resolved. Reporter and subject accept a plain name or an <code>@id:</code>/<code>@cid:</code> token
          to link the exact identity. This is separate from the user-filed Reports queue.
        </p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1 text-xs">
          {(["all", "open", "resolved"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-0.5 ${filter === f ? "bg-keep-action/15 text-keep-action" : "text-keep-muted hover:text-keep-text"}`}
            >
              {f[0]!.toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        {canManage && editing === null ? (
          <button type="button" onClick={startNew} className="rounded border border-keep-action/50 bg-keep-action/10 px-2 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/20">
            + New case
          </button>
        ) : null}
      </div>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</div> : null}

      {editing !== null ? (
        <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg/40 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-keep-muted">
              Nature
              <input className={inputClass} value={form.nature} onChange={(e) => setForm({ ...form, nature: e.target.value })} placeholder="e.g. harassment, spam, OOC dispute" maxLength={80} required />
            </label>
            <label className="text-xs text-keep-muted">
              Status
              <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as "open" | "resolved" })}>
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
              </select>
            </label>
            <label className="text-xs text-keep-muted">
              Who complained
              <input className={inputClass} value={form.reporter} onChange={(e) => setForm({ ...form, reporter: e.target.value })} placeholder="name, @id:…, @cid:…, or freehand" maxLength={120} />
            </label>
            <label className="text-xs text-keep-muted">
              About whom / what
              <input className={inputClass} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="name, @id:…, @cid:…, or freehand" maxLength={120} />
            </label>
          </div>
          <label className="block text-xs text-keep-muted">
            Complaint / details
            <textarea className={`${inputClass} min-h-[5rem]`} value={form.complaintBody} onChange={(e) => setForm({ ...form, complaintBody: e.target.value })} maxLength={8000} required />
          </label>
          <label className="block text-xs text-keep-muted">
            Resolution / action taken
            <textarea className={`${inputClass} min-h-[3rem]`} value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })} placeholder="Leave blank while open" maxLength={8000} />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">
              {saving ? "Saving…" : editing === "new" ? "Create case" : "Save changes"}
            </button>
            <button type="button" onClick={() => { setEditing(null); setForm(EMPTY_FORM); }} className={btnClass}>Cancel</button>
          </div>
        </form>
      ) : null}

      {cases === null ? (
        <p className="text-xs italic text-keep-muted">Loading…</p>
      ) : cases.length === 0 ? (
        <p className="text-xs italic text-keep-muted">No cases logged yet.</p>
      ) : (
        <ul className="space-y-2">
          {cases.map((c) => (
            <li key={c.id} className="rounded border border-keep-rule bg-keep-panel/30 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${c.status === "open" ? "bg-keep-action/15 text-keep-action" : "bg-keep-muted/15 text-keep-muted"}`}>
                  {c.status}
                </span>
                <span className="font-semibold text-keep-text">{c.nature}</span>
                <span className="ml-auto text-[11px] text-keep-muted">{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-keep-muted">
                <span>From: <Party label={c.reporterLabel} text={c.reporterText} linked={!!c.reporterUserId} isCharacter={!!c.reporterCharacterId} onOpen={() => void openParty({ userId: c.reporterUserId, characterId: c.reporterCharacterId, fallbackLabel: c.reporterLabel })} /></span>
                <span>About: <Party label={c.subjectLabel} text={c.subjectText} linked={!!c.subjectUserId} isCharacter={!!c.subjectCharacterId} onOpen={() => void openParty({ userId: c.subjectUserId, characterId: c.subjectCharacterId, fallbackLabel: c.subjectLabel })} /></span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-keep-text">{c.complaintBody}</p>
              {c.resolution ? (
                <p className="mt-2 whitespace-pre-wrap border-l-2 border-keep-action/40 pl-2 text-keep-muted">
                  <span className="font-semibold text-keep-text">Resolution: </span>{c.resolution}
                </p>
              ) : null}
              {canManage ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => startEdit(c)} className={btnClass}>Edit</button>
                  {c.status === "open" ? (
                    <button type="button" onClick={() => void setStatus(c, "resolved")} className={btnClass}>Mark resolved</button>
                  ) : (
                    <button type="button" onClick={() => void setStatus(c, "open")} className={btnClass}>Reopen</button>
                  )}
                  <button type="button" onClick={() => void remove(c)} className="rounded border border-keep-accent/40 px-2 py-0.5 text-xs text-keep-accent hover:bg-keep-accent/10">Delete</button>
                </div>
              ) : null}
            </li>
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
