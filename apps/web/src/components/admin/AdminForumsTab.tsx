/**
 * Admin → Forums (Forums revamp, Phase 2).
 *
 * The forum-creation review queue: pending applications with
 * approve/reject (+ optional note), and the recent decisions below for
 * context. Viewing is gated by `view_admin_forums` (AdminPanel handles
 * tab visibility); the approve/reject buttons additionally require
 * `review_forum_applications` — a viewer without it gets a read-only
 * queue. Approval creates the forum + its starter board + the system
 * welcome sticky server-side in one transaction.
 */
import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ForumCreationApplicationWire } from "@thekeep/shared";
import {
  adminFetchForumApplications,
  adminFetchForums,
  adminReviewForumApplication,
  adminSetForumStatus,
  type AdminForumRow,
} from "../../lib/forums.js";
import { formatDate, formatDateTime } from "../../lib/intlFormat.js";
import { useChat } from "../../state/store.js";

export function AdminForumsTab() {
  const { t } = useTranslation("admin");
  const me = useChat((s) => s.me);
  const canReview = !!me?.permissions?.includes("review_forum_applications");
  const [pending, setPending] = useState<ForumCreationApplicationWire[] | null>(null);
  const [recent, setRecent] = useState<ForumCreationApplicationWire[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    adminFetchForumApplications()
      .then((j) => { setPending(j.pending); setRecent(j.recent); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : t("loadFailed")));
  }, [t]);
  useEffect(() => { reload(); }, [reload]);

  async function review(app: ForumCreationApplicationWire, action: "approve" | "reject") {
    let note: string | undefined;
    if (action === "reject") {
      const v = window.prompt(
        t("review.declinePrompt", { name: app.requestedName }),
        "",
      );
      if (v === null) return; // prompt cancelled = no decision
      note = v.trim() || undefined;
    } else if (!window.confirm(
      t("forums.approveConfirm", { name: app.requestedName, slug: app.requestedSlug, applicant: app.applicantUsername }),
    )) {
      return;
    }
    setBusyId(app.id); setErr(null);
    try {
      await adminReviewForumApplication(app.id, action, note);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("review.reviewFailed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-5">
      <div>
        <h3 className="font-action text-lg text-keep-text">{t("forums.title")}</h3>
        <p className="text-xs text-keep-muted">
          {t("forums.description")}
        </p>
      </div>
      {err ? <p className="text-sm text-keep-accent">{err}</p> : null}

      <div>
        <h4 className="mb-2 text-xs uppercase tracking-widest text-keep-muted">
          {pending ? t("review.pendingCount", { count: pending.length }) : t("review.pending")}
        </h4>
        {!pending ? (
          <p className="text-sm italic text-keep-muted">{t("common:loading")}</p>
        ) : pending.length === 0 ? (
          <p className="text-sm italic text-keep-muted">{t("review.queueClear")}</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((a) => (
              <li key={a.id} className="rounded border border-keep-rule bg-keep-panel/30 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-semibold text-keep-text">{a.requestedName}</span>
                    <span className="ml-2 font-mono text-xs text-keep-muted">/f/{a.requestedSlug}</span>
                  </div>
                  <span className="text-[11px] text-keep-muted">
                    <Trans t={t} i18nKey="review.byUserStyled" values={{ name: a.applicantUsername }}>
                      {"by "}
                      <span className="text-keep-text">{"{{name}}"}</span>
                    </Trans>
                    {" · "}{formatDateTime(a.submittedAt)}
                  </span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-sm text-keep-text/90">{a.purpose}</p>
                {canReview ? (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void review(a, "approve")}
                      className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-action disabled:opacity-50"
                    >
                      {busyId === a.id ? "…" : t("review.approve")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void review(a, "reject")}
                      className="rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-accent disabled:opacity-50"
                    >
                      {t("review.decline")}
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] italic text-keep-muted">
                    {t("review.readOnlyQueue")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ForumCurationSection />

      {recent.length > 0 ? (
        <div>
          <h4 className="mb-2 text-xs uppercase tracking-widest text-keep-muted">{t("review.recentDecisions")}</h4>
          <ul className="space-y-1">
            {recent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 rounded border border-keep-rule/50 px-2 py-1 text-xs text-keep-muted">
                <span className={a.status === "approved" ? "font-semibold uppercase text-keep-action" : "font-semibold uppercase text-keep-accent"}>
                  {t(`review.status.${a.status}`)}
                </span>
                <span className="text-keep-text">{a.requestedName}</span>
                <span className="font-mono">/f/{a.requestedSlug}</span>
                <span>{t("review.byUser", { name: a.applicantUsername })}</span>
                {a.reviewedByUsername ? <span>{t("review.decidedBy", { name: a.reviewedByUsername })}</span> : null}
                {a.reviewedAt ? <span>· {formatDate(a.reviewedAt)}</span> : null}
                {a.reviewNote ? <span className="w-full italic">"{a.reviewNote}"</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Curation: every forum (including archived, which the public catalog
 * hides) with Feature / Unfeature / Archive / Restore. Featured forums
 * pin to the top of the catalog rail with a star. Buttons require
 * `manage_any_forum`; viewers without it get a read-only list.
 */
function ForumCurationSection() {
  const { t } = useTranslation("admin");
  const me = useChat((s) => s.me);
  const canCurate = !!me?.permissions?.includes("manage_any_forum");
  const [rows, setRows] = useState<AdminForumRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    adminFetchForums()
      .then((f) => { if (alive) setRows(f.sort((a, b) => a.name.localeCompare(b.name))); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : t("loadFailed")); });
    return () => { alive = false; };
  }, [tick, t]);

  async function setStatus(row: AdminForumRow, status: AdminForumRow["status"]) {
    if (status === "archived" && !window.confirm(
      t("forums.archiveConfirm", { name: row.name }),
    )) return;
    setBusyId(row.id); setErr(null);
    try { await adminSetForumStatus(row.id, status); setTick((t) => t + 1); }
    catch (e) { setErr(e instanceof Error ? e.message : t("updateFailed")); }
    finally { setBusyId(null); }
  }

  return (
    <div data-admin-anchor="forums.forums">
      <h4 className="mb-2 text-xs uppercase tracking-widest text-keep-muted">
        {rows ? t("forums.forumsCount", { count: rows.length }) : t("forums.forums")}
      </h4>
      {err ? <p className="mb-1 text-xs text-keep-accent">{err}</p> : null}
      {!rows ? (
        <p className="text-sm italic text-keep-muted">{t("common:loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm italic text-keep-muted">{t("forums.none")}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1 text-sm">
              <span className="font-semibold text-keep-text">{f.name}</span>
              <span className="font-mono text-[11px] text-keep-muted">/f/{f.slug}</span>
              <span className="text-[11px] text-keep-muted">{t("review.byUser", { name: f.ownerUsername })}</span>
              <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                f.status === "featured" ? "border-keep-accent/60 text-keep-accent"
                : f.status === "archived" ? "border-keep-rule text-keep-muted line-through"
                : "border-keep-rule text-keep-muted"
              }`}>
                {f.isSystem ? t("review.entityStatus.system") : t(`review.entityStatus.${f.status}`)}
              </span>
              {canCurate && !f.isSystem ? (
                <span className="ml-auto flex gap-1.5">
                  {f.status !== "archived" ? (
                    <>
                      <button
                        type="button" disabled={busyId !== null}
                        onClick={() => void setStatus(f, f.status === "featured" ? "active" : "featured")}
                        className="rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
                      >
                        {f.status === "featured" ? t("review.unfeature") : t("review.feature")}
                      </button>
                      <button
                        type="button" disabled={busyId !== null}
                        onClick={() => void setStatus(f, "archived")}
                        className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text disabled:opacity-50"
                      >
                        {t("review.archive")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button" disabled={busyId !== null}
                      onClick={() => void setStatus(f, "active")}
                      className="rounded border border-keep-action/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-action hover:bg-keep-action/10 disabled:opacity-50"
                    >
                      {t("review.restore")}
                    </button>
                  )}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
