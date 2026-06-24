/**
 * Admin → System tab.
 *
 * Two halves:
 *   1. Live metrics — polls GET /admin/system/metrics every few seconds
 *      and renders server vitals (process + host resource use, live
 *      connection counts, SQLite size, headline row counts, and Fly
 *      machine identity when present). Read-only; gated on
 *      `view_system_metrics` (the outer AdminPanel hides the whole tab).
 *   2. Maintenance tools — destructive live-ops actions, each gated on
 *      its own permission (masteradmin-only by default) AND a deliberate
 *      two-step confirm: Restart the server, and Purge ALL messages.
 *
 * The server re-checks every permission, so a UI that mis-renders a
 * button can't bypass the gate.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "../state/store.js";

interface SystemMetrics {
  serverTimeMs: number;
  process: { uptimeSec: number; nodeVersion: string; pid: number; rss: number; heapUsed: number; heapTotal: number; external: number };
  host: { platform: string; cpuCount: number; cpuModel: string; loadAvg: number[]; totalMem: number; freeMem: number; hostUptimeSec: number };
  connections: { sockets: number; onlineUsers: number };
  database: { bytes: number; walBytes: number };
  counts: { users: number; rooms: number; messages: number; sessions: number; worlds: number };
  fly: { machineId: string | null; region: string | null; app: string | null; imageRef: string | null };
}

const POLL_MS = 4000;

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "n/a";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{title}</legend>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">{children}</div>
    </fieldset>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string | undefined }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-keep-muted">{label}</span>
      <span className="font-mono text-keep-text" title={hint}>{value}</span>
    </div>
  );
}

export function AdminSystemTab() {
  const permissions = useChat((s) => s.me?.permissions) ?? [];
  const canRestart = permissions.includes("restart_application");
  const canPurge = permissions.includes("purge_all_messages");

  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/admin/system/metrics", { credentials: "include" });
      if (!r.ok) throw new Error(`metrics ${r.status}`);
      setMetrics((await r.json()) as SystemMetrics);
      setError(null);
      setStale(false);
    } catch (err) {
      // Keep the last good reading on screen, just flag it stale, so a
      // transient blip (or a restart in progress) doesn't blank the panel.
      setStale(true);
      setError(err instanceof Error ? err.message : "failed to load metrics");
    }
  }, []);

  useEffect(() => {
    void load();
    timer.current = window.setInterval(() => void load(), POLL_MS);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [load]);

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <p className="text-keep-muted">
          Live server vitals, refreshed every {POLL_MS / 1000}s.{stale ? " (reconnecting…)" : ""}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1 hover:bg-keep-banner/60"
        >
          Refresh
        </button>
      </div>

      {!metrics && error ? (
        <div className="rounded border border-keep-rule p-3 text-keep-muted">Couldn't load metrics: {error}</div>
      ) : null}

      {metrics ? (
        <>
          <Panel title="Process">
            <Stat label="Uptime" value={fmtDuration(metrics.process.uptimeSec)} />
            <Stat label="Node" value={metrics.process.nodeVersion} />
            <Stat label="PID" value={metrics.process.pid} />
            <Stat label="Memory (RSS)" value={fmtBytes(metrics.process.rss)} />
            <Stat label="Heap used" value={`${fmtBytes(metrics.process.heapUsed)} / ${fmtBytes(metrics.process.heapTotal)}`} />
            <Stat label="External" value={fmtBytes(metrics.process.external)} />
          </Panel>

          <Panel title="Host">
            <Stat label="Platform" value={metrics.host.platform} />
            <Stat label="CPUs" value={metrics.host.cpuCount} hint={metrics.host.cpuModel} />
            <Stat
              label="Load (1/5/15m)"
              value={metrics.host.loadAvg.every((n) => n === 0) ? "n/a" : metrics.host.loadAvg.map((n) => n.toFixed(2)).join(" / ")}
            />
            <Stat label="Memory free" value={`${fmtBytes(metrics.host.freeMem)} / ${fmtBytes(metrics.host.totalMem)}`} />
            <Stat label="Host uptime" value={fmtDuration(metrics.host.hostUptimeSec)} />
          </Panel>

          <Panel title="Connections & data">
            <Stat label="Live sockets" value={metrics.connections.sockets} />
            <Stat label="Online users" value={metrics.connections.onlineUsers} />
            <Stat label="Database" value={fmtBytes(metrics.database.bytes)} hint="thekeep.sqlite" />
            <Stat label="WAL" value={fmtBytes(metrics.database.walBytes)} />
            <Stat label="Messages" value={metrics.counts.messages.toLocaleString()} />
            <Stat label="Users" value={metrics.counts.users.toLocaleString()} />
            <Stat label="Rooms" value={metrics.counts.rooms.toLocaleString()} />
            <Stat label="Sessions" value={metrics.counts.sessions.toLocaleString()} />
            <Stat label="Worlds" value={metrics.counts.worlds.toLocaleString()} />
          </Panel>

          {metrics.fly.machineId || metrics.fly.app ? (
            <Panel title="Fly.io">
              <Stat label="App" value={metrics.fly.app ?? "—"} />
              <Stat label="Region" value={metrics.fly.region ?? "—"} />
              <Stat label="Machine" value={metrics.fly.machineId ?? "—"} />
              <Stat label="Image" value={metrics.fly.imageRef ?? "—"} hint={metrics.fly.imageRef ?? undefined} />
            </Panel>
          ) : null}
        </>
      ) : (
        !error ? <div className="rounded border border-keep-rule p-3 text-keep-muted">Loading metrics…</div> : null
      )}

      {(canRestart || canPurge) ? (
        <fieldset className="rounded border border-red-700/50 p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-red-400">Maintenance tools</legend>
          <p className="mb-2 text-keep-muted">
            Destructive live-ops actions. Each one is logged to the Audit tab. Use with care.
          </p>
          <div className="space-y-3">
            {canRestart ? <RestartTool /> : null}
            {canPurge ? <PurgeMessagesTool onPurged={() => void load()} /> : null}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

/* ---------------- Restart ---------------- */

function RestartTool() {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const restart = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/admin/system/restart", { method: "POST", credentials: "include" });
      // The process exits right after replying, so the socket may drop
      // before/right as the body arrives — treat a network error here as
      // "restart is happening," not a failure.
      if (r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string };
        setMsg(j.message ?? "Restarting…");
      } else {
        setMsg(`Restart failed (${r.status}).`);
        setBusy(false);
        return;
      }
    } catch {
      setMsg("Restarting… (connection dropped, as expected)");
    }
    // Give the server a few seconds to come back, then reload the page so
    // the admin lands on a fresh session-checked app instead of a dead tab.
    window.setTimeout(() => window.location.reload(), 6000);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-[180px] flex-1">
        <div className="font-semibold text-keep-text">Restart the server</div>
        <div className="text-keep-muted">Drops live connections for a few seconds, then the app reloads.</div>
      </div>
      {!armed ? (
        <button type="button" disabled={busy} onClick={() => setArmed(true)}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner/60">
          Restart…
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy} onClick={() => void restart()}
            className="keep-button rounded border border-red-700 bg-red-950/40 px-3 py-1 text-red-300 hover:bg-red-900/50">
            {busy ? "Restarting…" : "Confirm restart"}
          </button>
          <button type="button" disabled={busy} onClick={() => setArmed(false)}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner/60">
            Cancel
          </button>
        </div>
      )}
      {msg ? <span className="w-full text-keep-muted">{msg}</span> : null}
    </div>
  );
}

/* ---------------- Purge all messages ---------------- */

function PurgeMessagesTool({ onPurged }: { onPurged: () => void }) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ready = confirmText === "PURGE";

  const purge = async () => {
    if (!ready) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/admin/system/purge-messages", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "PURGE" }),
      });
      const j = (await r.json().catch(() => ({}))) as { deleted?: number; message?: string; error?: string };
      if (!r.ok) {
        setMsg(j.message ?? j.error ?? `Failed (${r.status}).`);
      } else {
        setMsg(`Deleted ${(j.deleted ?? 0).toLocaleString()} messages.`);
        setConfirmText("");
        onPurged();
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-keep-rule/40 pt-3">
      <div className="min-w-[180px] flex-1">
        <div className="font-semibold text-keep-text">Purge all messages</div>
        <div className="text-keep-muted">
          Permanently deletes every chat message site-wide. Irreversible. Rooms and accounts are
          untouched. Type <span className="font-mono text-red-400">PURGE</span> to enable.
        </div>
      </div>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder="PURGE"
        className="w-28 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
      />
      <button type="button" disabled={!ready || busy} onClick={() => void purge()}
        className="keep-button rounded border border-red-700 bg-red-950/40 px-3 py-1 text-red-300 hover:bg-red-900/50 disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? "Purging…" : "Purge"}
      </button>
      {msg ? <span className="w-full text-keep-muted">{msg}</span> : null}
    </div>
  );
}
