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
import { useChat } from "../../state/store.js";
import { BanModal } from "../moderation/BanModal.js";
import { Modal } from "../cosmetics/Modal.js";

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
  /** Global-admin moderation state (migration 0306). The server already applies
   *  lazy ban expiry in `GET /admin/servers`, so a "banned" row past its
   *  `moderationUntil` arrives here as "none" — no client re-evaluation needed. */
  moderationState?: "none" | "suspended" | "banned";
  /** Ban auto-expiry (timestamp ms; null = permanent / indefinite). */
  moderationUntil?: number | null;
  /** Optional staff note attached to the suspend/ban. */
  moderationNote?: string | null;
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

/**
 * Global-admin moderation: suspend (indefinite hold), ban (auto-expiring),
 * or lift (state "none"). `manage_any_server` only; the server 409s the
 * system/home server. `untilMs` is honored only for `state: "banned"`
 * (null = permanent); the note is optional (shown to blocked users beneath
 * the notice). POST /admin/servers/:id/moderation.
 */
async function adminSetServerModeration(
  serverId: string,
  state: "suspended" | "banned" | "none",
  untilMs?: number | null,
  note?: string | null,
): Promise<void> {
  const body: { state: typeof state; untilMs?: number | null; note?: string } = { state };
  if (state === "banned") body.untilMs = untilMs ?? null;
  const trimmedNote = note?.trim();
  if (trimmedNote) body.note = trimmedNote;
  const r = await fetch(`/admin/servers/${encodeURIComponent(serverId)}/moderation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  await jsonOrThrow(r);
}

/**
 * Hard, irreversible delete of a server + all its data. `manage_any_server`
 * only; the server 409s the system/home server. The type-the-slug confirm is
 * a client-side guard only (the server keys off the id). DELETE /admin/servers/:id.
 */
async function adminDeleteServer(serverId: string): Promise<void> {
  const r = await fetch(`/admin/servers/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
    credentials: "include",
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
  /** The server whose Ban modal (duration picker + note) is open, if any. */
  const [banRow, setBanRow] = useState<AdminServerRow | null>(null);
  /** The server whose type-the-slug delete confirm is open, if any. */
  const [deleteRow, setDeleteRow] = useState<AdminServerRow | null>(null);

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

  /** Suspend (indefinite) with an optional note, or lift back to "none". Ban
   *  goes through the {@link BanModal} instead (it needs the duration picker). */
  async function moderate(
    row: AdminServerRow,
    state: "suspended" | "none",
    note?: string | null,
  ) {
    setBusyId(row.id); setErr(null);
    try { await adminSetServerModeration(row.id, state, null, note); setTick((t) => t + 1); }
    catch (e) { setErr(e instanceof Error ? e.message : "update failed"); }
    finally { setBusyId(null); }
  }

  function askSuspend(row: AdminServerRow) {
    const v = window.prompt(
      `Suspend "${row.name}"? It's put under review and blocked to everyone but its owner, that server's staff, and global staff (who can enter to fix it). Optional note shown to blocked users:`,
      "",
    );
    if (v === null) return; // cancelled = no change
    void moderate(row, "suspended", v.trim() || null);
  }

  function askLift(row: AdminServerRow) {
    if (!window.confirm(
      `Lift the ${row.moderationState === "banned" ? "ban" : "suspension"} on "${row.name}"? It becomes fully accessible again.`,
    )) return;
    void moderate(row, "none");
  }

  async function confirmDelete(row: AdminServerRow) {
    setBusyId(row.id); setErr(null);
    try {
      await adminDeleteServer(row.id);
      setDeleteRow(null);
      setTick((t) => t + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    } finally {
      setBusyId(null);
    }
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
              {/* Moderation badge — the server already lazy-expires bans in
                  GET /admin/servers, so "banned" here is always still-active. */}
              {s.moderationState === "suspended" ? (
                <span className="rounded border border-[#e0a020] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-[#e0a020]">
                  Suspended
                </span>
              ) : s.moderationState === "banned" ? (
                <span
                  className="rounded border border-[#e06070] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-[#e06070]"
                  title={s.moderationNote ?? undefined}
                >
                  Banned{s.moderationUntil ? ` until ${new Date(s.moderationUntil).toLocaleDateString()}` : ""}
                </span>
              ) : null}
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
                  {/* Moderation (suspend / ban / lift) + hard delete — global
                      staff only, and NEVER the system/home server (it's sacred:
                      the server 409s it too, this just hides the buttons). When
                      a hold is active only Lift shows; otherwise Suspend + Ban. */}
                  {!s.isSystem ? (
                    <>
                      {s.moderationState === "suspended" || s.moderationState === "banned" ? (
                        <button
                          type="button" disabled={busyId !== null}
                          onClick={() => askLift(s)}
                          title="Lift the suspension / ban — the server becomes accessible again"
                          className="rounded border border-keep-action/60 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-action hover:bg-keep-action/10 disabled:opacity-50"
                        >
                          Lift
                        </button>
                      ) : (
                        <>
                          <button
                            type="button" disabled={busyId !== null}
                            onClick={() => askSuspend(s)}
                            title="Put under review — block everyone but the owner and staff"
                            className="rounded border border-[#e0a020]/70 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-[#e0a020] hover:bg-[#e0a020]/10 disabled:opacity-50"
                          >
                            Suspend
                          </button>
                          <button
                            type="button" disabled={busyId !== null}
                            onClick={() => setBanRow(s)}
                            title="Ban for a set duration — auto-lifts when it expires"
                            className="rounded border border-[#e06070]/70 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-[#e06070] hover:bg-[#e06070]/10 disabled:opacity-50"
                          >
                            Ban
                          </button>
                        </>
                      )}
                      <button
                        type="button" disabled={busyId !== null}
                        onClick={() => setDeleteRow(s)}
                        title="Permanently delete this server and all its data"
                        className="rounded border border-[#e06070] bg-[#e06070]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-[#e06070] hover:bg-[#e06070]/20 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Ban modal — reuses the shared duration picker; note is optional and
          shown to blocked users. No post-sweep for servers (showPurge=false). */}
      {banRow ? (
        <BanModal
          targetName={`server "${banRow.name}"`}
          description="Blocks everyone but the owner, that server's staff, and global staff. Auto-lifts when the duration elapses."
          reasonRequired={false}
          reasonPlaceholder="Optional note shown to blocked users beneath the ban notice."
          showPurge={false}
          confirmLabel="Ban server"
          busyLabel="Banning…"
          onConfirm={async (durationMs, reason) => {
            const untilMs = durationMs === null ? null : Date.now() + durationMs;
            await adminSetServerModeration(banRow.id, "banned", untilMs, reason);
            setBanRow(null);
            setTick((t) => t + 1);
          }}
          onClose={() => setBanRow(null)}
        />
      ) : null}

      {/* Type-the-slug delete confirm — irreversible, so the exact slug must be
          retyped before the button unlocks. */}
      {deleteRow ? (
        <DeleteServerModal
          row={deleteRow}
          busy={busyId === deleteRow.id}
          onConfirm={() => void confirmDelete(deleteRow)}
          onClose={() => setDeleteRow(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Type-the-slug confirm for the hard, irreversible server delete. The
 * destructive button stays disabled until the operator retypes the exact
 * `/s/<slug>` — a deliberate speed bump, since delete wipes the server and all
 * of its data with no undo. Mirrors the ban dialog's centered-modal chrome.
 */
function DeleteServerModal({ row, busy, onConfirm, onClose }: {
  row: AdminServerRow;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === row.slug;
  return (
    <Modal onClose={onClose} variant="centered" zIndex={70}>
      <div
        className="w-[min(440px,94vw)] rounded-lg border border-keep-rule bg-keep-bg p-4 text-keep-text shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-base font-semibold text-[#e06070]">Delete "{row.name}"</h3>
        <p className="mb-3 text-xs text-keep-muted">
          This permanently removes the server, its rooms and messages, members,
          invites, and every scrap of its data. There is no undo.
        </p>
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-keep-muted">
            Type <span className="font-mono text-keep-text">{row.slug}</span> to confirm
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={row.slug}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-sm outline-none focus:border-[#e06070]"
          />
        </label>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-keep-rule bg-keep-panel px-3 py-1.5 text-xs text-keep-text hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || !matches}
            className="rounded border border-[#e06070]/80 bg-[#e06070] px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete server"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
