/**
 * Server Admin → FAQs tab (Multi-Server Lift — the "Admin Partition").
 *
 * The per-server twin of components/AdminFaqsTab.tsx (the global FAQ admin),
 * scoped to ONE server. A server owner/mod holding `manage_faqs` curates THIS
 * server's question/answer entries; every fetch hits /servers/:id/faqs and the
 * routes re-check the grant + scope by `faqs.server_id` on the server side.
 *
 * House conventions (mirrors the sibling tabs in ServerSettingsView.tsx):
 *   - keep-* utility classes, no lib/servers.ts widening (inline fetch helpers).
 *   - props are the console's TabProps-style contract; this tab only needs the
 *     server id + viewer state, plus busy/run/onSaved for the shared error +
 *     spinner plumbing the console owns.
 *
 * The answer editor accepts Markdown or HTML (previewed live via markdownToHtml
 * + DOMPurify); the server re-sanitizes on save with the bio allow-list. Each
 * entry keeps a slug, but per-server FAQ entries are an admin surface only —
 * there is no per-server public /faq/<slug> page, so the slug is shown for
 * reference rather than linked.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { markdownToHtml, normalizeFaqSlug, type FaqAdminEntry, type ServerViewerState } from "@thekeep/shared";
import { readError } from "../../lib/http.js";

interface FaqsTabProps {
  serverId: string;
  viewer: ServerViewerState;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}

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

const sid = (id: string) => encodeURIComponent(id);

export default function FaqsTab({ serverId, viewer, busy, run, onSaved }: FaqsTabProps) {
  const { t } = useTranslation("servers");
  // The route requires manage_faqs for every action, so anyone who can open this
  // tab can write; the owner short-circuit mirrors serverCan.
  const canManage = viewer.isOwner || viewer.permissions.includes("manage_faqs");
  const [faqs, setFaqs] = useState<FaqAdminEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // faq id, or "new"
  const [form, setForm] = useState<FormState>(EMPTY);
  const [slugStatus, setSlugStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/servers/${sid(serverId)}/faqs`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { faqs: FaqAdminEntry[] };
      setFaqs(j.faqs);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("shared.loadFailed"));
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [serverId]);

  function startNew() { setForm(EMPTY); setSlugStatus(null); setEditing("new"); }
  function startEdit(f: FaqAdminEntry) {
    // Prefill with the Markdown SOURCE (not the rendered HTML) so a re-save
    // round-trips cleanly instead of re-wrapping the stored HTML.
    setForm({ slug: f.slug, question: f.question, answer: f.answerMarkdown, category: f.category ?? "", sortOrder: String(f.sortOrder), enabled: f.enabled });
    setSlugStatus(null);
    setEditing(f.id);
  }

  async function checkSlug() {
    const norm = normalizeFaqSlug(form.slug);
    if (!norm) { setSlugStatus(t("faqsTab.slugInvalidLong")); return; }
    try {
      const exceptId = editing && editing !== "new" ? `&exceptId=${encodeURIComponent(editing)}` : "";
      const r = await fetch(`/servers/${sid(serverId)}/faqs/slug-availability?slug=${encodeURIComponent(norm)}${exceptId}`, { credentials: "include" });
      const j = (await r.json()) as { available: boolean; reason?: string | null };
      setSlugStatus(j.available ? t("faqsTab.slugAvailable", { slug: norm }) : j.reason === "invalid" ? t("faqsTab.slugInvalidShort") : t("faqsTab.slugTaken", { slug: norm }));
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
      const r = await fetch(isNew ? `/servers/${sid(serverId)}/faqs` : `/servers/${sid(serverId)}/faqs/${sid(editing!)}`, {
        method: isNew ? "POST" : "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await readError(r));
      setEditing(null); setForm(EMPTY); setSlugStatus(null);
      await load();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("shared.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(f: FaqAdminEntry) {
    await run(async () => {
      const r = await fetch(`/servers/${sid(serverId)}/faqs/${sid(f.id)}`, {
        method: "PATCH", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !f.enabled }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
      onSaved();
    });
  }

  async function remove(f: FaqAdminEntry) {
    if (!window.confirm(t("faqsTab.deleteConfirm", { question: f.question }))) return;
    await run(async () => {
      const r = await fetch(`/servers/${sid(serverId)}/faqs/${sid(f.id)}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
      onSaved();
    });
  }

  /** Move one entry up/down and persist the whole order (bulk reorder route). */
  async function move(index: number, dir: -1 | 1) {
    if (!faqs) return;
    const next = [...faqs];
    const swap = index + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[index], next[swap]] = [next[swap]!, next[index]!];
    setFaqs(next); // optimistic
    await run(async () => {
      const r = await fetch(`/servers/${sid(serverId)}/faqs/reorder`, {
        method: "PATCH", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order: next.map((f) => f.id) }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
      onSaved();
    });
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-widest text-keep-muted">{t("faqsTab.heading")}</h2>
          <p className="text-[11px] text-keep-muted">
            {t("faqsTab.blurb")}
          </p>
        </div>
        {canManage && editing === null ? (
          <button type="button" onClick={startNew} className="shrink-0 rounded border border-keep-action/50 bg-keep-action/10 px-2 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/20">
            {t("faqsTab.newFaq")}
          </button>
        ) : null}
      </div>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</div> : null}

      {editing !== null ? (
        <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg/40 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-keep-muted">
              {t("faqsTab.slugLabel")}
              <input className={inputClass} value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} onBlur={() => void checkSlug()} placeholder={t("faqsTab.slugPlaceholder")} maxLength={40} required />
              {slugStatus ? <span className="mt-0.5 block text-[11px] text-keep-muted">{slugStatus}</span> : null}
            </label>
            <label className="text-xs text-keep-muted">
              {t("faqsTab.categoryLabel")}
              <input className={inputClass} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder={t("faqsTab.categoryPlaceholder")} maxLength={60} />
            </label>
          </div>
          <label className="block text-xs text-keep-muted">
            {t("faqsTab.questionLabel")}
            <input className={inputClass} value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} maxLength={200} required />
          </label>
          <label className="block text-xs text-keep-muted">
            {t("faqsTab.answerLabel")}
            <textarea className={`${inputClass} min-h-[6rem] font-mono`} value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} maxLength={8000} required />
          </label>
          {form.answer.trim() ? (
            <div className="rounded border border-keep-rule bg-keep-panel/20 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">{t("announceTab.preview")}</div>
              <div className="prose prose-sm max-w-none text-keep-text" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(markdownToHtml(form.answer)) }} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1 text-xs text-keep-muted">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              {t("faqsTab.published")}
            </label>
            <label className="flex items-center gap-1 text-xs text-keep-muted">
              {t("faqsTab.sort")}
              <input className={`${inputClass} w-16`} type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
            </label>
            <div className="ml-auto flex gap-2">
              <button type="submit" disabled={saving} className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">
                {saving ? t("faqsTab.savingDots") : editing === "new" ? t("faqsTab.create") : t("shared.save")}
              </button>
              <button type="button" onClick={() => { setEditing(null); setForm(EMPTY); setSlugStatus(null); }} className={btnClass}>{t("shared.cancel")}</button>
            </div>
          </div>
        </form>
      ) : null}

      {faqs === null ? (
        <p className="text-xs italic text-keep-muted">{t("faqsTab.loadingDots")}</p>
      ) : faqs.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{t("faqsTab.noEntries")}</p>
      ) : (
        <ul className="space-y-2">
          {faqs.map((f, i) => (
            <li key={f.id} className="rounded border border-keep-rule bg-keep-panel/30 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {!f.enabled ? <span className="rounded bg-keep-muted/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-keep-muted">{t("faqsTab.draft")}</span> : null}
                <span className="font-semibold text-keep-text">{f.question}</span>
                <span className="text-[11px] text-keep-muted">{f.slug}</span>
                {f.category ? <span className="text-[11px] text-keep-muted">· {f.category}</span> : null}
              </div>
              {canManage ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" disabled={busy || i === 0} onClick={() => void move(i, -1)} title={t("console.onboarding.moveUp")}
                    className="rounded border border-keep-rule px-1.5 py-0.5 text-xs text-keep-muted hover:text-keep-text disabled:opacity-40">↑</button>
                  <button type="button" disabled={busy || i === faqs.length - 1} onClick={() => void move(i, 1)} title={t("console.onboarding.moveDown")}
                    className="rounded border border-keep-rule px-1.5 py-0.5 text-xs text-keep-muted hover:text-keep-text disabled:opacity-40">↓</button>
                  <button type="button" onClick={() => startEdit(f)} className={btnClass}>{t("shared.edit")}</button>
                  <button type="button" onClick={() => void toggleEnabled(f)} className={btnClass}>{f.enabled ? t("faqsTab.unpublish") : t("faqsTab.publish")}</button>
                  <button type="button" onClick={() => void remove(f)} className="rounded border border-keep-accent/40 px-2 py-0.5 text-xs text-keep-accent hover:bg-keep-accent/10">{t("shared.delete")}</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
