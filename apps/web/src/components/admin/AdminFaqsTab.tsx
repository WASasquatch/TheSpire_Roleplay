import { useEffect, useState, type FormEvent } from "react";
import DOMPurify from "dompurify";
import { markdownToHtml, normalizeFaqSlug, type FaqAdminEntry } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { useChat } from "../../state/store.js";

/**
 * Admin "FAQ" tab — CRUD for public question/answer entries.
 *
 * `view_admin_faqs` gates the tab; `manage_faqs` gates writes. The answer
 * editor accepts Markdown or HTML (converted with `markdownToHtml`, previewed
 * live); the server re-sanitizes on save with the bio allow-list. Each entry
 * has a unique slug published at `/faq/<slug>`.
 */

interface FormState {
  slug: string;
  question: string;
  answer: string;
  category: string;
  sortOrder: string;
  enabled: boolean;
}

const EMPTY: FormState = { slug: "", question: "", answer: "", category: "", sortOrder: "0", enabled: true };
const inputClass = "w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm text-keep-text outline-none focus:border-keep-action";
const btnClass = "rounded border border-keep-rule px-2 py-0.5 text-xs text-keep-muted hover:text-keep-text";

export function AdminFaqsTab() {
  const canManage = useChat((s) => s.me?.permissions.includes("manage_faqs") ?? false);
  const [faqs, setFaqs] = useState<FaqAdminEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // id, or "new"
  const [form, setForm] = useState<FormState>(EMPTY);
  const [slugStatus, setSlugStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/faqs", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { faqs: FaqAdminEntry[] };
      setFaqs(j.faqs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => { void load(); }, []);

  function startNew() { setForm(EMPTY); setSlugStatus(null); setEditing("new"); }
  function startEdit(f: FaqAdminEntry) {
    // Prefill the editor with the Markdown SOURCE (not the rendered HTML) so a
    // re-save round-trips cleanly instead of re-wrapping the stored HTML.
    setForm({ slug: f.slug, question: f.question, answer: f.answerMarkdown, category: f.category ?? "", sortOrder: String(f.sortOrder), enabled: f.enabled });
    setSlugStatus(null);
    setEditing(f.id);
  }

  async function checkSlug() {
    const norm = normalizeFaqSlug(form.slug);
    if (!norm) { setSlugStatus("Invalid slug (3–40 chars: a–z, 0–9, _)."); return; }
    try {
      const exceptId = editing && editing !== "new" ? `&exceptId=${editing}` : "";
      const r = await fetch(`/admin/faqs/slug-availability?slug=${encodeURIComponent(norm)}${exceptId}`, { credentials: "include" });
      const j = (await r.json()) as { available: boolean; reason?: string | null };
      setSlugStatus(j.available ? `✓ "${norm}" is available` : j.reason === "invalid" ? "Invalid slug." : `"${norm}" is already taken.`);
    } catch { setSlugStatus(null); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true); setError(null);
    try {
      const payload = {
        slug: form.slug.trim(),
        question: form.question.trim(),
        // Send the Markdown source; the server converts + sanitizes to HTML.
        answerMarkdown: form.answer,
        category: form.category.trim() || null,
        sortOrder: Number.parseInt(form.sortOrder, 10) || 0,
        enabled: form.enabled,
      };
      const isNew = editing === "new";
      const r = await fetch(isNew ? "/admin/faqs" : `/admin/faqs/${editing}`, {
        method: isNew ? "POST" : "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await readError(r));
      setEditing(null); setForm(EMPTY); setSlugStatus(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(f: FaqAdminEntry) {
    try {
      const r = await fetch(`/admin/faqs/${f.id}`, {
        method: "PATCH", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !f.enabled }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "toggle failed"); }
  }

  async function remove(f: FaqAdminEntry) {
    if (!window.confirm(`Delete the FAQ "${f.question}"? The /faq/${f.slug} link will 404.`)) return;
    try {
      const r = await fetch(`/admin/faqs/${f.id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "delete failed"); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-keep-muted">FAQ entries</h2>
          <p className="text-xs text-keep-muted">
            Public question/answer entries, each with a shareable link at <code>/faq/&lt;slug&gt;</code> and listed at <code>/faqs</code>.
            Visible to anyone, signed in or not. Answers accept Markdown or HTML.
          </p>
        </div>
        {canManage && editing === null ? (
          <button type="button" onClick={startNew} className="shrink-0 rounded border border-keep-action/50 bg-keep-action/10 px-2 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/20">
            + New FAQ
          </button>
        ) : null}
      </div>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</div> : null}

      {editing !== null ? (
        <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg/40 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-keep-muted">
              Slug (the URL)
              <input className={inputClass} value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} onBlur={() => void checkSlug()} placeholder="how_worlds_work" maxLength={40} required />
              {slugStatus ? <span className="mt-0.5 block text-[11px] text-keep-muted">{slugStatus}</span> : null}
            </label>
            <label className="text-xs text-keep-muted">
              Category (optional)
              <input className={inputClass} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Getting started" maxLength={60} />
            </label>
          </div>
          <label className="block text-xs text-keep-muted">
            Question
            <input className={inputClass} value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} maxLength={200} required />
          </label>
          <label className="block text-xs text-keep-muted">
            Answer (Markdown or HTML)
            <textarea className={`${inputClass} min-h-[6rem] font-mono`} value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} maxLength={8000} required />
          </label>
          {form.answer.trim() ? (
            <div className="rounded border border-keep-rule bg-keep-panel/20 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">Preview</div>
              <div className="prose prose-sm max-w-none text-keep-text" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdownToHtml(form.answer)) }} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1 text-xs text-keep-muted">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              Published
            </label>
            <label className="flex items-center gap-1 text-xs text-keep-muted">
              Sort
              <input className={`${inputClass} w-16`} type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
            </label>
            <div className="ml-auto flex gap-2">
              <button type="submit" disabled={saving} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">
                {saving ? "Saving…" : editing === "new" ? "Create" : "Save"}
              </button>
              <button type="button" onClick={() => { setEditing(null); setForm(EMPTY); setSlugStatus(null); }} className={btnClass}>Cancel</button>
            </div>
          </div>
        </form>
      ) : null}

      {faqs === null ? (
        <p className="text-xs italic text-keep-muted">Loading…</p>
      ) : faqs.length === 0 ? (
        <p className="text-xs italic text-keep-muted">No FAQ entries yet.</p>
      ) : (
        <ul className="space-y-2">
          {faqs.map((f) => (
            <li key={f.id} className="rounded border border-keep-rule bg-keep-panel/30 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {!f.enabled ? <span className="rounded bg-keep-muted/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-keep-muted">draft</span> : null}
                <span className="font-semibold text-keep-text">{f.question}</span>
                <a href={`/faq/${f.slug}`} target="_blank" rel="noreferrer" className="text-[11px] text-keep-action hover:underline">/faq/{f.slug}</a>
                {f.category ? <span className="text-[11px] text-keep-muted">· {f.category}</span> : null}
              </div>
              {canManage ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => startEdit(f)} className={btnClass}>Edit</button>
                  <button type="button" onClick={() => void toggleEnabled(f)} className={btnClass}>{f.enabled ? "Unpublish" : "Publish"}</button>
                  <button type="button" onClick={() => void remove(f)} className="rounded border border-keep-accent/40 px-2 py-0.5 text-xs text-keep-accent hover:bg-keep-accent/10">Delete</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
