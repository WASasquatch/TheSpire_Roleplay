import { useEffect, useState, type FormEvent } from "react";
import { EMAIL_CATEGORY_KEYS, EMAIL_CATEGORY_LABELS, EMAIL_CATEGORY_HINTS, DEFAULT_EMAIL_CATEGORY, emailCategoryLabel, type EmailCategory } from "@thekeep/shared";
import { RichEditor } from "../shared/RichEditor.js";

interface Campaign {
  id: string;
  subject: string;
  category?: string;
  status: string;
  scheduledAt?: number | null;
  total: number;
  sentCount: number;
  failedCount: number;
  createdAt: number;
  updatedAt: number;
}
interface StatusResp { configured: boolean; dailyCap: number; campaigns: Campaign[] }
interface RecipUser { id: string; username: string; email: string }

type Section = "compose" | "newsletter" | "settings";

const card = "rounded border border-keep-rule p-4 space-y-3";
const legend = "px-1 text-[10px] uppercase tracking-[0.2em] text-keep-muted";
const input = "w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action";
const btn = "rounded border border-keep-border bg-keep-panel px-3 py-1.5 text-sm font-semibold hover:bg-keep-panel/80 disabled:opacity-50";

function fmtWhen(ms: number): string {
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}

function CampaignRow({ c, onCancel }: { c: Campaign; onCancel: (id: string) => void }) {
  const canCancel = c.status === "scheduled" || c.status === "sending";
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs">
      <span className="min-w-0 truncate">
        {c.category ? <span className="mr-1 rounded bg-keep-panel px-1 text-[10px] uppercase tracking-wide text-keep-muted">{emailCategoryLabel(c.category)}</span> : null}
        {c.subject}
        {c.status === "scheduled" && c.scheduledAt ? <span className="ml-1 text-keep-muted">- scheduled {fmtWhen(c.scheduledAt)}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-keep-muted">
        <span>{c.sentCount}/{c.total} sent{c.failedCount ? `, ${c.failedCount} failed` : ""} · {c.status}</span>
        {canCancel ? <button type="button" className="text-keep-accent hover:underline" onClick={() => onCancel(c.id)}>cancel</button> : null}
      </span>
    </div>
  );
}

export function AdminEmailTab() {
  const [section, setSection] = useState<Section>("compose");

  // Verification settings
  const [verifyEnabled, setVerifyEnabled] = useState(false);
  const [verifyMode, setVerifyMode] = useState<"nudge" | "block">("nudge");
  const [dailyCap, setDailyCap] = useState("300");
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);

  // Immediate compose
  const [mode, setMode] = useState<"user" | "all">("user");
  const [category, setCategory] = useState<EmailCategory>(DEFAULT_EMAIL_CATEGORY);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecipUser[]>([]);
  const [picked, setPicked] = useState<RecipUser | null>(null);
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<string | null>(null);

  // Newsletter (scheduled)
  const [nlSubject, setNlSubject] = useState("");
  const [nlHtml, setNlHtml] = useState("");
  const [nlWhen, setNlWhen] = useState("");
  const [nlSending, setNlSending] = useState(false);
  const [nlMsg, setNlMsg] = useState<string | null>(null);

  const [status, setStatus] = useState<StatusResp | null>(null);

  async function refreshStatus() {
    try {
      const j = (await fetch("/admin/email/status", { credentials: "include" }).then((r) => r.json())) as StatusResp;
      setStatus(j);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    void (async () => {
      try {
        const s = await fetch("/admin/settings", { credentials: "include" }).then((r) => r.json());
        setVerifyEnabled(!!s.emailVerificationEnabled);
        setVerifyMode(s.emailVerificationMode === "block" ? "block" : "nudge");
        setDailyCap(String(s.emailDailyCap ?? 300));
      } catch { /* ignore */ }
      await refreshStatus();
    })();
  }, []);

  useEffect(() => {
    if (mode !== "user" || !query.trim()) { setResults([]); return; }
    const id = window.setTimeout(async () => {
      try {
        const j = await fetch(`/admin/email/recipients?q=${encodeURIComponent(query.trim())}`, { credentials: "include" }).then((r) => r.json());
        setResults(j.users ?? []);
      } catch { /* ignore */ }
    }, 250);
    return () => window.clearTimeout(id);
  }, [query, mode]);

  async function cancelCampaign(id: string) {
    if (!window.confirm("Cancel this campaign? Already-sent emails can't be recalled; the rest won't go out.")) return;
    try {
      await fetch(`/admin/email/campaigns/${id}/cancel`, { method: "POST", credentials: "include" });
      await refreshStatus();
    } catch { /* ignore */ }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsMsg(null);
    try {
      const cap = Math.max(1, Math.min(100000, parseInt(dailyCap, 10) || 300));
      const r = await fetch("/admin/settings", {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailVerificationEnabled: verifyEnabled, emailVerificationMode: verifyMode, emailDailyCap: cap }),
      });
      if (!r.ok) throw new Error("save failed");
      setDailyCap(String(cap));
      setSettingsMsg("Saved.");
      await refreshStatus();
    } catch {
      setSettingsMsg("Save failed (check your permissions).");
    } finally {
      setSavingSettings(false);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    setSendMsg(null);
    if (!subject.trim() || !html.trim()) { setSendMsg("Subject and body are required."); return; }
    if (mode === "user" && !picked) { setSendMsg("Pick a recipient first."); return; }
    if (mode === "all" && !window.confirm("Send this to everyone subscribed now? It will go out in daily batches.")) return;
    setSending(true);
    try {
      if (mode === "user" && picked) {
        const r = await fetch("/admin/email/send", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toUserId: picked.id, subject, html }),
        });
        if (!r.ok) throw new Error("Send failed.");
        setSendMsg(`Sent to ${picked.username}.`);
      } else {
        const r = await fetch("/admin/email/broadcast", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject, html, category }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error === "no_recipients" ? "No eligible recipients." : "Broadcast failed.");
        setSendMsg(`Queued for ${j.total} recipient(s).`);
      }
      setSubject(""); setHtml(""); setPicked(null); setQuery("");
      await refreshStatus();
    } catch (err) {
      setSendMsg(err instanceof Error ? err.message : "Failed.");
    } finally {
      setSending(false);
    }
  }

  async function scheduleNewsletter(e: FormEvent) {
    e.preventDefault();
    setNlMsg(null);
    if (!nlSubject.trim() || !nlHtml.trim()) { setNlMsg("Subject and body are required."); return; }
    const whenMs = nlWhen ? new Date(nlWhen).getTime() : Date.now();
    if (Number.isNaN(whenMs)) { setNlMsg("Pick a valid delivery time."); return; }
    const future = whenMs > Date.now() + 30_000;
    const label = future ? `scheduled for ${fmtWhen(whenMs)}` : "sent now";
    if (!window.confirm(`Send this newsletter to everyone who hasn't unsubscribed from Newsletter (${label})? It goes out in daily batches.`)) return;
    setNlSending(true);
    try {
      const r = await fetch("/admin/email/broadcast", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: nlSubject, html: nlHtml, category: "newsletter", ...(future ? { scheduledAt: whenMs } : {}) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error === "no_recipients" ? "No eligible recipients." : "Could not schedule.");
      setNlMsg(future ? `Scheduled for ${j.total} recipient(s) at ${fmtWhen(whenMs)}.` : `Sending now to ${j.total} recipient(s).`);
      setNlSubject(""); setNlHtml(""); setNlWhen("");
      await refreshStatus();
    } catch (err) {
      setNlMsg(err instanceof Error ? err.message : "Failed.");
    } finally {
      setNlSending(false);
    }
  }

  const newsletters = (status?.campaigns ?? []).filter((c) => c.category === "newsletter");
  const broadcasts = (status?.campaigns ?? []).filter((c) => c.category !== "newsletter");

  const tabBtn = (s: Section, label: string) => (
    <button
      type="button"
      onClick={() => setSection(s)}
      className={`rounded px-3 py-1 text-sm ${section === s ? "bg-keep-panel font-semibold" : "text-keep-muted hover:text-keep-text"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-5 text-sm">
      {status && !status.configured ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-3 py-2 text-xs text-keep-accent">
          Email isn't configured yet. Set the <code>BREVO_API_KEY</code> secret. Sending will be skipped until it's set.
        </div>
      ) : null}

      <div className="flex gap-1 border-b border-keep-rule pb-2">
        {tabBtn("compose", "Compose")}
        {tabBtn("newsletter", "Newsletter")}
        {tabBtn("settings", "Settings")}
      </div>

      {section === "compose" ? (
        <>
          <form onSubmit={send} className={card}>
            <div className={legend}>Send an email</div>
            <div className="flex gap-4 text-xs">
              <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "user"} onChange={() => setMode("user")} /> A specific user</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "all"} onChange={() => setMode("all")} /> All users (broadcast)</label>
            </div>

            {mode === "user" ? (
              <div className="space-y-1">
                {picked ? (
                  <div className="flex items-center justify-between rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs">
                    <span>{picked.username} &lt;{picked.email}&gt;</span>
                    <button type="button" className="text-keep-muted hover:text-keep-text" onClick={() => setPicked(null)}>change</button>
                  </div>
                ) : (
                  <>
                    <input className={input} placeholder="Search username or email…" value={query} onChange={(e) => setQuery(e.target.value)} />
                    {results.length > 0 ? (
                      <div className="max-h-40 overflow-y-auto rounded border border-keep-rule">
                        {results.map((u) => (
                          <button type="button" key={u.id} className="block w-full px-2 py-1 text-left text-xs hover:bg-keep-panel" onClick={() => { setPicked(u); setQuery(""); setResults([]); }}>
                            {u.username} <span className="text-keep-muted">&lt;{u.email}&gt;</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-keep-muted">Category</span>
                  <select className={input} value={category} onChange={(e) => setCategory(e.target.value as EmailCategory)}>
                    {EMAIL_CATEGORY_KEYS.map((k) => <option key={k} value={k}>{EMAIL_CATEGORY_LABELS[k]}</option>)}
                  </select>
                  <span className="mt-1 block text-[11px] text-keep-muted">{EMAIL_CATEGORY_HINTS[category]}</span>
                </label>
                <div className="rounded border border-keep-action/40 bg-keep-action/10 px-2 py-1 text-[11px] text-keep-text/90">
                  Goes to every account with an email that hasn't unsubscribed from <strong>{EMAIL_CATEGORY_LABELS[category]}</strong> (everyone is included by default), in daily batches of up to {status?.dailyCap ?? 300}. The footer link lets a recipient unsubscribe from this category only.
                </div>
              </div>
            )}

            <input className={input} placeholder="Subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
            <div className="min-h-[220px]"><RichEditor value={html} onChange={setHtml} placeholder="Write your message…" minHeight="180px" /></div>
            <div className="flex items-center gap-3">
              <button type="submit" className={btn} disabled={sending}>{sending ? "Sending…" : mode === "user" ? "Send email" : "Queue broadcast"}</button>
              {sendMsg ? <span className="text-xs text-keep-muted">{sendMsg}</span> : null}
            </div>
          </form>

          {broadcasts.length > 0 ? (
            <div className={card}>
              <div className="flex items-center justify-between">
                <div className={legend}>Recent broadcasts</div>
                <button type="button" className="text-xs text-keep-muted hover:text-keep-text" onClick={refreshStatus}>refresh</button>
              </div>
              <div className="space-y-1">{broadcasts.map((c) => <CampaignRow key={c.id} c={c} onCancel={cancelCampaign} />)}</div>
            </div>
          ) : null}
        </>
      ) : null}

      {section === "newsletter" ? (
        <>
          <form onSubmit={scheduleNewsletter} className={card}>
            <div className={legend}>New newsletter</div>
            <p className="text-[11px] text-keep-muted">
              Goes to every account with an email that hasn't unsubscribed from <strong>Newsletter</strong> (everyone is included by default). Pick a delivery time (or leave it blank to send now); it goes out in daily batches starting then, and skips anyone who unsubscribes before it sends.
            </p>
            <input className={input} placeholder="Subject" value={nlSubject} maxLength={200} onChange={(e) => setNlSubject(e.target.value)} />
            <div className="min-h-[220px]"><RichEditor value={nlHtml} onChange={setNlHtml} placeholder="Write the newsletter…" minHeight="180px" /></div>
            <label className="block">
              <span className="mb-1 block text-xs text-keep-muted">Deliver at (leave blank to send now)</span>
              <input className={input} type="datetime-local" value={nlWhen} onChange={(e) => setNlWhen(e.target.value)} />
            </label>
            <div className="flex items-center gap-3">
              <button type="submit" className={btn} disabled={nlSending}>{nlSending ? "Saving…" : nlWhen ? "Schedule newsletter" : "Send newsletter now"}</button>
              {nlMsg ? <span className="text-xs text-keep-muted">{nlMsg}</span> : null}
            </div>
          </form>

          <div className={card}>
            <div className="flex items-center justify-between">
              <div className={legend}>Newsletters</div>
              <button type="button" className="text-xs text-keep-muted hover:text-keep-text" onClick={refreshStatus}>refresh</button>
            </div>
            {newsletters.length > 0 ? (
              <div className="space-y-1">{newsletters.map((c) => <CampaignRow key={c.id} c={c} onCancel={cancelCampaign} />)}</div>
            ) : <p className="text-xs text-keep-muted">No newsletters yet.</p>}
          </div>
        </>
      ) : null}

      {section === "settings" ? (
        <form onSubmit={saveSettings} className={card}>
          <div className={legend}>Email verification</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={verifyEnabled} onChange={(e) => setVerifyEnabled(e.target.checked)} />
            <span>Require new users to verify their email after registering.</span>
          </label>
          <div className={verifyEnabled ? "space-y-2" : "space-y-2 opacity-50"}>
            <label className="block">
              <span className="mb-1 block text-xs text-keep-muted">Enforcement</span>
              <select className={input} value={verifyMode} disabled={!verifyEnabled} onChange={(e) => setVerifyMode(e.target.value === "block" ? "block" : "nudge")}>
                <option value="nudge">Nudge: account works, dismissible reminder banner</option>
                <option value="block">Block: can't chat until verified</option>
              </select>
            </label>
          </div>
          <p className="text-[11px] text-keep-muted">Existing accounts are treated as already verified, so turning this on only affects new sign-ups.</p>
          <label className="block">
            <span className="mb-1 block text-xs text-keep-muted">Broadcast daily cap (emails/day)</span>
            <input className={input + " w-32"} value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} placeholder="300" />
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" className={btn} disabled={savingSettings}>{savingSettings ? "Saving…" : "Save settings"}</button>
            {settingsMsg ? <span className="text-xs text-keep-muted">{settingsMsg}</span> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
