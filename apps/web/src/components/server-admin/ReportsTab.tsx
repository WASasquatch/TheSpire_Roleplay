/**
 * Server Admin → Reports (Multi-Server Lift — the "Admin Partition").
 *
 * The per-server twin of the global Reports admin, scoped to ONE server. A
 * server owner/mod (holding `manage_reports`) sees the reports filed against
 * THIS server's messages and resolves or dismisses them, without ever touching
 * the platform-wide queue. DM/profile reports stay global and never appear
 * here (the backend filters on reports.server_id = :id).
 *
 * House style mirrors the other Server Settings console tabs (MembersTab /
 * BansTab in ServerSettingsView.tsx): keep-* Tailwind palette, uppercase
 * tracking-widest section labels, the shared `run`/`busy` action plumbing, and
 * inline fetch helpers (lib/servers.ts is a shared do-not-touch module, so we
 * carry our own here rather than widen it).
 */
import { useEffect, useState } from "react";
import type { ProfileView, ServerViewerState } from "@thekeep/shared";
import { ProfileModal } from "../profile/ProfileModal.js";

/* ============================================================
 * Wire shapes (consumed read-only from /servers/:id/reports).
 * Local on purpose — lib/servers.ts is shared and not to be touched.
 * ============================================================ */

type ReportRowStatus = "open" | "reviewed" | "dismissed";

interface ServerReportWire {
  id: string;
  reporterUserId: string;
  reporterDisplayName: string;
  messageId: string;
  messageBody: string;
  messageDisplayName: string;
  messageUserId?: string | null;
  messageCreatedAt: number;
  roomId: string;
  roomName: string;
  reason?: string | null;
  status: ReportRowStatus;
  resolvedById?: string | null;
  resolvedByDisplayName?: string | null;
  resolvedAt?: number | null;
  resolutionNote?: string | null;
  createdAt: number;
}

/* ============================================================
 * Inline fetch helpers (do NOT widen lib/servers.ts).
 * ============================================================ */

async function jsonOrThrow<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!r.ok) throw new Error(j?.error ?? `Request failed (${r.status}).`);
  return j as T;
}

const sid = (id: string) => encodeURIComponent(id);

async function apiGetServerReports(serverId: string): Promise<ServerReportWire[]> {
  const j = await jsonOrThrow<{ reports: ServerReportWire[] }>(
    await fetch(`/servers/${sid(serverId)}/reports`, { credentials: "include" }),
  );
  return j.reports;
}

async function apiResolveServerReport(
  serverId: string,
  reportId: string,
  status: "reviewed" | "dismissed",
  note?: string,
): Promise<void> {
  await jsonOrThrow(
    await fetch(`/servers/${sid(serverId)}/reports/${sid(reportId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ status, ...(note && note.trim() ? { note: note.trim() } : {}) }),
    }),
  );
}

/* ============================================================
 * One report card (open → action buttons; resolved → outcome line).
 * ============================================================ */

function ReportCard({
  report,
  serverId,
  busy,
  run,
  onChanged,
  onViewAuthor,
}: {
  report: ServerReportWire;
  serverId: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onChanged: () => void;
  onViewAuthor?: (userId: string) => void;
}) {
  const [note, setNote] = useState("");
  const open = report.status === "open";
  const authorId = report.messageUserId ?? null;

  return (
    <li className="space-y-2 rounded border border-keep-rule bg-keep-panel/30 px-2.5 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {authorId && onViewAuthor ? (
          <button
            type="button"
            onClick={() => onViewAuthor(authorId)}
            title="View this member's profile to verify the report"
            className="text-sm font-semibold text-keep-text underline decoration-dotted underline-offset-2 hover:text-keep-action"
          >
            {report.messageDisplayName}
          </button>
        ) : (
          <span className="text-sm font-semibold text-keep-text">{report.messageDisplayName}</span>
        )}
        <span className="text-[11px] text-keep-muted">in {report.roomName}</span>
        <span className="ml-auto text-[10px] text-keep-muted">{new Date(report.createdAt).toLocaleString()}</span>
      </div>

      <p className="whitespace-pre-wrap break-words rounded border border-keep-rule/60 bg-keep-bg px-2 py-1 text-sm text-keep-text">
        {report.messageBody}
      </p>

      <div className="text-[11px] text-keep-muted">
        Reported by <span className="text-keep-text">{report.reporterDisplayName}</span>
        {report.reason ? <span> · "{report.reason}"</span> : null}
      </div>

      {open ? (
        <div className="space-y-1.5 border-t border-keep-rule/60 pt-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Resolution note (optional, kept in the Mod Log)"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => { await apiResolveServerReport(serverId, report.id, "dismissed", note); onChanged(); })}
              className="rounded border border-keep-rule px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-muted hover:text-keep-text disabled:opacity-50"
            >
              Dismiss
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => { await apiResolveServerReport(serverId, report.id, "reviewed", note); onChanged(); })}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
            >
              Mark reviewed
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-keep-rule/60 pt-1.5 text-[11px] text-keep-muted">
          <span className="uppercase tracking-widest text-keep-accent">{report.status}</span>
          {report.resolvedByDisplayName ? <span> by {report.resolvedByDisplayName}</span> : null}
          {report.resolvedAt ? <span> · {new Date(report.resolvedAt).toLocaleDateString()}</span> : null}
          {report.resolutionNote ? <span className="italic"> · "{report.resolutionNote}"</span> : null}
        </div>
      )}
    </li>
  );
}

/* ============================================================
 * The tab
 * ============================================================ */

export default function ReportsTab({
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
  const [reports, setReports] = useState<ServerReportWire[] | null>(null);
  const [tick, setTick] = useState(0);
  const [viewing, setViewing] = useState<ProfileView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  // Gate the action UI on the mirrored permission, exactly like the routes
  // re-check; owner implies the key.
  const canManage = viewer.isOwner || viewer.permissions.includes("manage_reports");

  useEffect(() => {
    let alive = true;
    apiGetServerReports(serverId)
      .then((rs) => { if (alive) setReports(rs); })
      .catch(() => { if (alive) setReports([]); });
    return () => { alive = false; };
  }, [serverId, tick]);

  // After a resolve/dismiss, refetch this tab's queue AND let the console
  // refresh shared state (mirrors the other tabs' onSaved contract).
  const refresh = () => { setTick((t) => t + 1); onSaved(); };

  // Open the reported member's profile so a mod can verify a report before
  // acting. Resolves by the stable @id: token (never the display name, which
  // can contain spaces and break the identity parser).
  async function openProfile(userId: string) {
    setViewError(null);
    try {
      const r = await fetch(`/profiles/${encodeURIComponent(`@id:${userId}`)}`, { credentials: "include" });
      if (!r.ok) { setViewError(r.status === 404 ? "That member no longer exists." : `Couldn't load their profile (HTTP ${r.status}).`); return; }
      const j = await r.json();
      if (j && "private" in j) { setViewError("That profile is restricted."); return; }
      setViewing(j as ProfileView);
    } catch { setViewError("Couldn't load their profile."); }
  }

  if (!reports) return <p className="text-sm italic text-keep-muted">Loading…</p>;

  const open = reports.filter((r) => r.status === "open");
  const resolved = reports.filter((r) => r.status !== "open");

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-[11px] text-keep-muted">
        Reports your members filed against this server's messages. Direct-message and profile reports go to the
        platform team, not here.
      </p>
      {viewError ? <p className="text-xs text-keep-accent">{viewError}</p> : null}

      <section className="space-y-1.5">
        <p className="text-xs uppercase tracking-widest text-keep-muted">Open ({open.length})</p>
        {open.length === 0 ? (
          <p className="text-xs italic text-keep-muted">Nothing waiting. All clear.</p>
        ) : (
          <ul className="space-y-2">
            {open.map((r) => (
              <ReportCard key={r.id} report={r} serverId={serverId} busy={busy || !canManage} run={run} onChanged={refresh} onViewAuthor={openProfile} />
            ))}
          </ul>
        )}
      </section>

      {resolved.length > 0 ? (
        <section className="space-y-1.5">
          <p className="text-xs uppercase tracking-widest text-keep-muted">Recently resolved</p>
          <ul className="space-y-2">
            {resolved.map((r) => (
              <ReportCard key={r.id} report={r} serverId={serverId} busy={busy || !canManage} run={run} onChanged={refresh} onViewAuthor={openProfile} />
            ))}
          </ul>
        </section>
      ) : null}

      {viewing ? (
        <ProfileModal profile={viewing} onClose={() => setViewing(null)} bypassNsfwGate={true} zIndex={60} />
      ) : null}
    </div>
  );
}
