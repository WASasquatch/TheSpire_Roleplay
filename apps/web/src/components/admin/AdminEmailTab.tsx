import { useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { EMAIL_CATEGORY_KEYS, EMAIL_CATEGORY_LABELS, EMAIL_CATEGORY_HINTS, DEFAULT_EMAIL_CATEGORY, emailCategoryLabel, type EmailCategory } from "@thekeep/shared";
import { formatDateTime } from "../../lib/intlFormat.js";
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
  try { return formatDateTime(ms); } catch { return String(ms); }
}

function CampaignRow({ c, onCancel }: { c: Campaign; onCancel: (id: string) => void }) {
  const { t } = useTranslation("admin");
  const canCancel = c.status === "scheduled" || c.status === "sending";
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs">
      <span className="min-w-0 truncate">
        {c.category ? <span className="mr-1 rounded bg-keep-panel px-1 text-[10px] uppercase tracking-wide text-keep-muted">{emailCategoryLabel(c.category)}</span> : null}
        {c.subject}
        {c.status === "scheduled" && c.scheduledAt ? <span className="ml-1 text-keep-muted">{t("email.scheduledSuffix", { when: fmtWhen(c.scheduledAt) })}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-keep-muted">
        <span>{t("email.sentProgress", { sent: c.sentCount, total: c.total })}{c.failedCount ? t("email.failedSuffix", { count: c.failedCount }) : ""} · {c.status}</span>
        {canCancel ? <button type="button" className="text-keep-accent hover:underline" onClick={() => onCancel(c.id)}>{t("email.cancelAction")}</button> : null}
      </span>
    </div>
  );
}

export function AdminEmailTab() {
  const { t } = useTranslation("admin");
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
    if (!window.confirm(t("email.cancelConfirm"))) return;
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
      setSettingsMsg(t("saved"));
      await refreshStatus();
    } catch {
      setSettingsMsg(t("email.saveFailedPermissions"));
    } finally {
      setSavingSettings(false);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    setSendMsg(null);
    if (!subject.trim() || !html.trim()) { setSendMsg(t("email.subjectBodyRequired")); return; }
    if (mode === "user" && !picked) { setSendMsg(t("email.pickRecipient")); return; }
    if (mode === "all" && !window.confirm(t("email.broadcastConfirm"))) return;
    setSending(true);
    try {
      if (mode === "user" && picked) {
        const r = await fetch("/admin/email/send", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toUserId: picked.id, subject, html }),
        });
        if (!r.ok) throw new Error(t("email.sendFailed"));
        setSendMsg(t("email.sentTo", { name: picked.username }));
      } else {
        const r = await fetch("/admin/email/broadcast", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject, html, category }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error === "no_recipients" ? t("email.noRecipients") : t("email.broadcastFailed"));
        setSendMsg(t("email.queuedFor", { count: j.total }));
      }
      setSubject(""); setHtml(""); setPicked(null); setQuery("");
      await refreshStatus();
    } catch (err) {
      setSendMsg(err instanceof Error ? err.message : t("email.failed"));
    } finally {
      setSending(false);
    }
  }

  async function scheduleNewsletter(e: FormEvent) {
    e.preventDefault();
    setNlMsg(null);
    if (!nlSubject.trim() || !nlHtml.trim()) { setNlMsg(t("email.subjectBodyRequired")); return; }
    const whenMs = nlWhen ? new Date(nlWhen).getTime() : Date.now();
    if (Number.isNaN(whenMs)) { setNlMsg(t("email.invalidTime")); return; }
    const future = whenMs > Date.now() + 30_000;
    const confirmMsg = future
      ? t("email.newsletterConfirmScheduled", { when: fmtWhen(whenMs) })
      : t("email.newsletterConfirmNow");
    if (!window.confirm(confirmMsg)) return;
    setNlSending(true);
    try {
      const r = await fetch("/admin/email/broadcast", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: nlSubject, html: nlHtml, category: "newsletter", ...(future ? { scheduledAt: whenMs } : {}) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error === "no_recipients" ? t("email.noRecipients") : t("email.scheduleFailed"));
      setNlMsg(future ? t("email.scheduledFor", { count: j.total, when: fmtWhen(whenMs) }) : t("email.sendingNowTo", { count: j.total }));
      setNlSubject(""); setNlHtml(""); setNlWhen("");
      await refreshStatus();
    } catch (err) {
      setNlMsg(err instanceof Error ? err.message : t("email.failed"));
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
          <Trans t={t} i18nKey="email.notConfigured">
            {"Email isn't configured yet. Set the "}
            <code>BREVO_API_KEY</code>
            {" secret. Sending will be skipped until it's set."}
          </Trans>
        </div>
      ) : null}

      <div className="flex gap-1 border-b border-keep-rule pb-2">
        {tabBtn("compose", t("email.tabCompose"))}
        {tabBtn("newsletter", t("email.tabNewsletter"))}
        {tabBtn("settings", t("email.tabSettings"))}
      </div>

      {section === "compose" ? (
        <>
          <form data-admin-anchor="email.sendTitle" onSubmit={send} className={card}>
            <div className={legend}>{t("email.sendTitle")}</div>
            <div className="flex gap-4 text-xs">
              <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "user"} onChange={() => setMode("user")} /> {t("email.specificUser")}</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "all"} onChange={() => setMode("all")} /> {t("email.allUsers")}</label>
            </div>

            {mode === "user" ? (
              <div className="space-y-1">
                {picked ? (
                  <div className="flex items-center justify-between rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs">
                    <span>{picked.username} &lt;{picked.email}&gt;</span>
                    <button type="button" className="text-keep-muted hover:text-keep-text" onClick={() => setPicked(null)}>{t("email.change")}</button>
                  </div>
                ) : (
                  <>
                    <input className={input} placeholder={t("email.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
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
                  <span className="mb-1 block text-xs text-keep-muted">{t("email.categoryLabel")}</span>
                  <select className={input} value={category} onChange={(e) => setCategory(e.target.value as EmailCategory)}>
                    {EMAIL_CATEGORY_KEYS.map((k) => <option key={k} value={k}>{EMAIL_CATEGORY_LABELS[k]}</option>)}
                  </select>
                  <span className="mt-1 block text-[11px] text-keep-muted">{EMAIL_CATEGORY_HINTS[category]}</span>
                </label>
                <div className="rounded border border-keep-action/40 bg-keep-action/10 px-2 py-1 text-[11px] text-keep-text/90">
                  <Trans
                    t={t}
                    i18nKey="email.broadcastInfo"
                    values={{ label: EMAIL_CATEGORY_LABELS[category], cap: status?.dailyCap ?? 300 }}
                  >
                    {"Goes to every account with an email that hasn't unsubscribed from "}
                    <strong>{"{{label}}"}</strong>
                    {" (everyone is included by default), in daily batches of up to {{cap}}. The footer link lets a recipient unsubscribe from this category only."}
                  </Trans>
                </div>
              </div>
            )}

            <input className={input} placeholder={t("email.subjectPlaceholder")} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
            <div className="min-h-[220px]"><RichEditor value={html} onChange={setHtml} placeholder={t("email.messagePlaceholder")} minHeight="180px" /></div>
            <div className="flex items-center gap-3">
              <button type="submit" className={btn} disabled={sending}>{sending ? t("email.sending") : mode === "user" ? t("email.sendEmail") : t("email.queueBroadcast")}</button>
              {sendMsg ? <span className="text-xs text-keep-muted">{sendMsg}</span> : null}
            </div>
          </form>

          {broadcasts.length > 0 ? (
            <div className={card}>
              <div className="flex items-center justify-between">
                <div className={legend}>{t("email.recentBroadcasts")}</div>
                <button type="button" className="text-xs text-keep-muted hover:text-keep-text" onClick={refreshStatus}>{t("email.refreshLower")}</button>
              </div>
              <div className="space-y-1">{broadcasts.map((c) => <CampaignRow key={c.id} c={c} onCancel={cancelCampaign} />)}</div>
            </div>
          ) : null}
        </>
      ) : null}

      {section === "newsletter" ? (
        <>
          <form data-admin-anchor="email.newNewsletter" onSubmit={scheduleNewsletter} className={card}>
            <div className={legend}>{t("email.newNewsletter")}</div>
            <p className="text-[11px] text-keep-muted">
              <Trans t={t} i18nKey="email.newsletterInfo">
                {"Goes to every account with an email that hasn't unsubscribed from "}
                <strong>Newsletter</strong>
                {" (everyone is included by default). Pick a delivery time (or leave it blank to send now); it goes out in daily batches starting then, and skips anyone who unsubscribes before it sends."}
              </Trans>
            </p>
            <input className={input} placeholder={t("email.subjectPlaceholder")} value={nlSubject} maxLength={200} onChange={(e) => setNlSubject(e.target.value)} />
            <div className="min-h-[220px]"><RichEditor value={nlHtml} onChange={setNlHtml} placeholder={t("email.newsletterPlaceholder")} minHeight="180px" /></div>
            <label className="block">
              <span className="mb-1 block text-xs text-keep-muted">{t("email.deliverAt")}</span>
              <input className={input} type="datetime-local" value={nlWhen} onChange={(e) => setNlWhen(e.target.value)} />
            </label>
            <div className="flex items-center gap-3">
              <button type="submit" className={btn} disabled={nlSending}>{nlSending ? t("common:saving") : nlWhen ? t("email.scheduleNewsletter") : t("email.sendNewsletterNow")}</button>
              {nlMsg ? <span className="text-xs text-keep-muted">{nlMsg}</span> : null}
            </div>
          </form>

          <div className={card}>
            <div className="flex items-center justify-between">
              <div className={legend}>{t("email.newsletters")}</div>
              <button type="button" className="text-xs text-keep-muted hover:text-keep-text" onClick={refreshStatus}>{t("email.refreshLower")}</button>
            </div>
            {newsletters.length > 0 ? (
              <div className="space-y-1">{newsletters.map((c) => <CampaignRow key={c.id} c={c} onCancel={cancelCampaign} />)}</div>
            ) : <p className="text-xs text-keep-muted">{t("email.noNewsletters")}</p>}
          </div>
        </>
      ) : null}

      {section === "settings" ? (
        <form data-admin-anchor="email.verificationLegend" onSubmit={saveSettings} className={card}>
          <div className={legend}>{t("email.verificationLegend")}</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={verifyEnabled} onChange={(e) => setVerifyEnabled(e.target.checked)} />
            <span>{t("email.requireVerification")}</span>
          </label>
          <div className={verifyEnabled ? "space-y-2" : "space-y-2 opacity-50"}>
            <label className="block">
              <span className="mb-1 block text-xs text-keep-muted">{t("email.enforcement")}</span>
              <select className={input} value={verifyMode} disabled={!verifyEnabled} onChange={(e) => setVerifyMode(e.target.value === "block" ? "block" : "nudge")}>
                <option value="nudge">{t("email.modeNudge")}</option>
                <option value="block">{t("email.modeBlock")}</option>
              </select>
            </label>
          </div>
          <p className="text-[11px] text-keep-muted">{t("email.verificationNote")}</p>
          <label data-admin-anchor="email.dailyCapLabel" className="block">
            <span className="mb-1 block text-xs text-keep-muted">{t("email.dailyCapLabel")}</span>
            <input className={input + " w-32"} value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} placeholder="300" />
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" className={btn} disabled={savingSettings}>{savingSettings ? t("common:saving") : t("saveSettings")}</button>
            {settingsMsg ? <span className="text-xs text-keep-muted">{settingsMsg}</span> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
