/**
 * Admin → Servers (Multi-Server Lift, Phase 4).
 *
 * The server-creation review queue: pending applications with
 * approve/reject (+ optional note), and the recent decisions below for
 * context. Viewing is gated by `view_admin_servers` (AdminPanel handles
 * tab visibility); the approve/reject buttons additionally require
 * `review_server_applications` — a viewer without it gets a read-only
 * queue. Approval creates the server + its starter room + the system
 * welcome sticky server-side in one transaction.
 *
 * The deliberate 1:1 mirror of AdminForumsTab. The admin fetch helpers
 * live inline here rather than in `lib/servers.ts` (which carries the
 * rail's member-facing surface); they 404 like any disabled feature when
 * the servers flag is off, so the tab is only reachable when it's on.
 */
import { useCallback, useEffect, useState } from "react";
import type { ServerStatus, ServerVisibility, ServerJoinMode } from "@thekeep/shared";
import { useChat } from "../state/store.js";

/** One creation application as the `/admin/servers/applications` route returns
 *  it. Mirrors the forum `ForumCreationApplicationWire`. */
interface ServerCreationApplicationWire {
  id: string;
  applicantUserId: string;
  applicantUsername: string;
  requestedName: string;
  requestedSlug: string;
  purpose: string;
  status: "pending" | "approved" | "rejected";
  submittedAt: number;
  reviewedAt: number | null;
  reviewedByUsername: string | null;
  reviewNote: string | null;
}

/** One row of the oversight grid from `GET /admin/servers` — every server,
 *  including archived ones the public catalog hides. */
interface AdminServerRow {
  id: string;
  slug: string;
  name: string;
  status: ServerStatus;
  visibility: ServerVisibility;
  joinMode: ServerJoinMode;
  isSystem: boolean;
  isDefault: boolean;
  ownerUsername: string;
  createdAt: number;
}

/** Pull `{ error }` out of a non-OK response, falling back to the status. */
async function jsonOrThrow<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!r.ok) throw new Error(j?.error ?? `Request failed (${r.status}).`);
  return j as T;
}

async function adminFetchServerApplications(): Promise<{
  pending: ServerCreationApplicationWire[]; recent: ServerCreationApplicationWire[];
}> {
  const r = await fetch("/admin/servers/applications", { credentials: "include" });
  return jsonOrThrow(r);
}

async function adminReviewServerApplication(
  id: string,
  action: "approve" | "reject",
  note?: string,
): Promise<ServerCreationApplicationWire> {
  const r = await fetch(`/admin/servers/applications/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(note ? { action, note } : { action }),
  });
  const j = await jsonOrThrow<{ application: ServerCreationApplicationWire }>(r);
  return j.application;
}

async function adminFetchServers(): Promise<AdminServerRow[]> {
  const r = await fetch("/admin/servers", { credentials: "include" });
  const j = await jsonOrThrow<{ servers: AdminServerRow[] }>(r);
  return j.servers;
}

async function adminSetServerStatus(
  serverId: string,
  status: "active" | "featured" | "archived",
): Promise<void> {
  const r = await fetch(`/admin/servers/${encodeURIComponent(serverId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status }),
  });
  await jsonOrThrow(r);
}

export function AdminServersTab({ onOpenConsole, onEnterServer }: {
  onOpenConsole?: (serverId: string) => void;
  /** Step into a server's chat rooms to moderate (global-staff bypass). */
  onEnterServer?: (serverId: string, name: string) => void;
} = {}) {
  const me = useChat((s) => s.me);
  const canReview = !!me?.permissions?.includes("review_server_applications");
  const [pending, setPending] = useState<ServerCreationApplicationWire[] | null>(null);
  const [recent, setRecent] = useState<ServerCreationApplicationWire[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    adminFetchServerApplications()
      .then((j) => { setPending(j.pending); setRecent(j.recent); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : "load failed"));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function review(app: ServerCreationApplicationWire, action: "approve" | "reject") {
    let note: string | undefined;
    if (action === "reject") {
      const v = window.prompt(
        `Decline "${app.requestedName}"? Optional note shown to the applicant (they can re-apply after the cooldown):`,
        "",
      );
      if (v === null) return; // prompt cancelled = no decision
      note = v.trim() || undefined;
    } else if (!window.confirm(
      `Approve "${app.requestedName}" (/s/${app.requestedSlug})?\n\n${app.applicantUsername} becomes its owner; the server + a starter room are created immediately.`,
    )) {
      return;
    }
    setBusyId(app.id); setErr(null);
    try {
      await adminReviewServerApplication(app.id, action, note);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "review failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-5">
      <div>
        <h3 className="font-action text-lg text-keep-text">Server applications</h3>
        <p className="text-xs text-keep-muted">
          Approving creates the server with the applicant as owner, a starter room, and a welcome
          message. Declining starts the re-apply cooldown; the note is shown to the applicant.
        </p>
      </div>
      {err ? <p className="text-sm text-keep-accent">{err}</p> : null}

      <div>
        <h4 className="mb-2 text-xs uppercase tracking-widest text-keep-muted">
          Pending {pending ? `(${pending.length})` : ""}
        </h4>
        {!pending ? (
          <p className="text-sm italic text-keep-muted">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm italic text-keep-muted">No applications waiting. The queue is clear.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((a) => (
              <li key={a.id} className="rounded border border-keep-rule bg-keep-panel/30 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-semibold text-keep-text">{a.requestedName}</span>
                    <span className="ml-2 font-mono text-xs text-keep-muted">/s/{a.requestedSlug}</span>
                  </div>
                  <span className="text-[11px] text-keep-muted">
                    by <span className="text-keep-text">{a.applicantUsername}</span>
                    {" · "}{new Date(a.submittedAt).toLocaleString()}
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
                      {busyId === a.id ? "…" : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void review(a, "reject")}
                      className="rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-accent disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] italic text-keep-muted">
                    You can view the queue; deciding requires the review permission.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ServerCurationSection
        {...(onOpenConsole ? { onOpenConsole } : {})}
        {...(onEnterServer ? { onEnterServer } : {})}
      />

      {recent.length > 0 ? (
        <div>
          <h4 className="mb-2 text-xs uppercase tracking-widest text-keep-muted">Recent decisions</h4>
          <ul className="space-y-1">
            {recent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 rounded border border-keep-rule/50 px-2 py-1 text-xs text-keep-muted">
                <span className={a.status === "approved" ? "font-semibold uppercase text-keep-action" : "font-semibold uppercase text-keep-accent"}>
                  {a.status}
                </span>
                <span className="text-keep-text">{a.requestedName}</span>
                <span className="font-mono">/s/{a.requestedSlug}</span>
                <span>by {a.applicantUsername}</span>
                {a.reviewedByUsername ? <span>· decided by {a.reviewedByUsername}</span> : null}
                {a.reviewedAt ? <span>· {new Date(a.reviewedAt).toLocaleDateString()}</span> : null}
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
 * Curation: every server (including archived, which the public catalog
 * hides) with Feature / Unfeature / Archive / Restore. Featured servers
 * pin to the top of the catalog rail with a star. Buttons require
 * `manage_any_server`; viewers without it get a read-only list.
 */
function ServerCurationSection({ onOpenConsole, onEnterServer }: {
  onOpenConsole?: (serverId: string) => void;
  onEnterServer?: (serverId: string, name: string) => void;
}) {
  const me = useChat((s) => s.me);
  const canCurate = !!me?.permissions?.includes("manage_any_server");
  const [rows, setRows] = useState<AdminServerRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    adminFetchServers()
      .then((s) => { if (alive) setRows(s.sort((a, b) => a.name.localeCompare(b.name))); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "load failed"); });
    return () => { alive = false; };
  }, [tick]);

  async function setStatus(row: AdminServerRow, status: AdminServerRow["status"]) {
    if (status === "archived" && !window.confirm(
      `Archive "${row.name}"? It leaves the catalog (rooms and messages are kept) and can be restored here.`,
    )) return;
    setBusyId(row.id); setErr(null);
    try { await adminSetServerStatus(row.id, status); setTick((t) => t + 1); }
    catch (e) { setErr(e instanceof Error ? e.message : "update failed"); }
    finally { setBusyId(null); }
  }

  return (
    <div>
      <h4 className="mb-2 text-xs uppercase tracking-widest text-keep-muted">
        Servers {rows ? `(${rows.length})` : ""}
      </h4>
      {err ? <p className="mb-1 text-xs text-keep-accent">{err}</p> : null}
      {!rows ? (
        <p className="text-sm italic text-keep-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm italic text-keep-muted">No servers yet.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-1 text-sm">
              <span className="font-semibold text-keep-text">{s.name}</span>
              <span className="font-mono text-[11px] text-keep-muted">/s/{s.slug}</span>
              <span className="text-[11px] text-keep-muted">by {s.ownerUsername}</span>
              <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                s.status === "featured" ? "border-keep-accent/60 text-keep-accent"
                : s.status === "archived" ? "border-keep-rule text-keep-muted line-through"
                : "border-keep-rule text-keep-muted"
              }`}>
                {s.isSystem ? "system" : s.status}
              </span>
              {canCurate ? (
                <span className="ml-auto flex gap-1.5">
                  {/* Step into the server's CHAT to moderate. Staff hold
                      manage_any_server, which the server's authority treats as
                      owner-equivalent, so room entry already lets them in even
                      for private / invite-only servers they never joined. */}
                  {onEnterServer ? (
                    <button
                      type="button"
                      onClick={() => onEnterServer(s.id, s.name)}
                      title="Enter this server's chat to moderate"
                      className="rounded border border-keep-action bg-keep-action/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
                    >
                      Enter
                    </button>
                  ) : null}
                  {/* Oversight drill-in: opens THIS server's per-server admin
                      console (manage_any_server resolves owner-equivalent), the
                      one door for chat-server controls — including the home
                      server. Shown for every server. */}
                  {onOpenConsole ? (
                    <button
                      type="button"
                      onClick={() => onOpenConsole(s.id)}
                      title="Open this server's admin console"
                      className="rounded border border-keep-action/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-action hover:bg-keep-action/10"
                    >
                      Open admin
                    </button>
                  ) : null}
                  {!s.isSystem ? (
                    s.status !== "archived" ? (
                      <>
                        <button
                          type="button" disabled={busyId !== null}
                          onClick={() => void setStatus(s, s.status === "featured" ? "active" : "featured")}
                          className="rounded border border-keep-accent/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
                        >
                          {s.status === "featured" ? "Unfeature" : "Feature"}
                        </button>
                        <button
                          type="button" disabled={busyId !== null}
                          onClick={() => void setStatus(s, "archived")}
                          className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text disabled:opacity-50"
                        >
                          Archive
                        </button>
                      </>
                    ) : (
                      <button
                        type="button" disabled={busyId !== null}
                        onClick={() => void setStatus(s, "active")}
                        className="rounded border border-keep-action/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-action hover:bg-keep-action/10 disabled:opacity-50"
                      >
                        Restore
                      </button>
                    )
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
