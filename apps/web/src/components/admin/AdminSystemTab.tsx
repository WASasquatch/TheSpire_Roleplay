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
import { Trans, useTranslation } from "react-i18next";
import { i18n } from "../../lib/i18n.js";
import { formatNumber } from "../../lib/intlFormat.js";
import { useChat } from "../../state/store.js";

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
  if (!Number.isFinite(sec) || sec < 0) return i18n.t("admin:system.na");
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return i18n.t("admin:system.durationDhm", { d, h, m });
  if (h > 0) return i18n.t("admin:system.durationHm", { h, m });
  if (m > 0) return i18n.t("admin:system.durationMs", { m, s });
  return i18n.t("admin:system.durationS", { s });
}

function Panel({ title, anchor, children }: { title: string; anchor?: string; children: React.ReactNode }) {
  return (
    // `anchor` is the find-a-setting jump target (adminSearchIndex.ts): the
    // panel's own catalog title key, stamped verbatim as data-admin-anchor.
    <fieldset {...(anchor ? { "data-admin-anchor": anchor } : {})} className="rounded border border-keep-rule p-3 text-xs">
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
  const { t } = useTranslation("admin");
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
      if (!r.ok) throw new Error(t("system.metricsStatus", { status: r.status }));
      setMetrics((await r.json()) as SystemMetrics);
      setError(null);
      setStale(false);
    } catch (err) {
      // Keep the last good reading on screen, just flag it stale, so a
      // transient blip (or a restart in progress) doesn't blank the panel.
      setStale(true);
      setError(err instanceof Error ? err.message : t("system.metricsFailed"));
    }
  }, [t]);

  useEffect(() => {
    void load();
    timer.current = window.setInterval(() => void load(), POLL_MS);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [load]);

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <p className="text-keep-muted">
          {t("system.vitals", { seconds: POLL_MS / 1000 })}{stale ? t("system.reconnecting") : ""}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1 hover:bg-keep-banner/60"
        >
          {t("refresh")}
        </button>
      </div>

      {!metrics && error ? (
        <div className="rounded border border-keep-rule p-3 text-keep-muted">{t("system.loadError", { error })}</div>
      ) : null}

      {metrics ? (
        <>
          <Panel anchor="system.panelProcess" title={t("system.panelProcess")}>
            <Stat label={t("system.uptime")} value={fmtDuration(metrics.process.uptimeSec)} />
            <Stat label={t("system.node")} value={metrics.process.nodeVersion} />
            <Stat label={t("system.pid")} value={metrics.process.pid} />
            <Stat label={t("system.memoryRss")} value={fmtBytes(metrics.process.rss)} />
            <Stat label={t("system.heapUsed")} value={`${fmtBytes(metrics.process.heapUsed)} / ${fmtBytes(metrics.process.heapTotal)}`} />
            <Stat label={t("system.external")} value={fmtBytes(metrics.process.external)} />
          </Panel>

          <Panel anchor="system.panelHost" title={t("system.panelHost")}>
            <Stat label={t("system.platform")} value={metrics.host.platform} />
            <Stat label={t("system.cpus")} value={metrics.host.cpuCount} hint={metrics.host.cpuModel} />
            <Stat
              label={t("system.loadAvg")}
              value={metrics.host.loadAvg.every((n) => n === 0) ? t("system.na") : metrics.host.loadAvg.map((n) => n.toFixed(2)).join(" / ")}
            />
            <Stat label={t("system.memoryFree")} value={`${fmtBytes(metrics.host.freeMem)} / ${fmtBytes(metrics.host.totalMem)}`} />
            <Stat label={t("system.hostUptime")} value={fmtDuration(metrics.host.hostUptimeSec)} />
          </Panel>

          <Panel anchor="system.panelConnections" title={t("system.panelConnections")}>
            <Stat label={t("system.liveSockets")} value={metrics.connections.sockets} />
            <Stat label={t("system.onlineUsers")} value={metrics.connections.onlineUsers} />
            <Stat label={t("system.database")} value={fmtBytes(metrics.database.bytes)} hint="thekeep.sqlite" />
            <Stat label={t("system.wal")} value={fmtBytes(metrics.database.walBytes)} />
            <Stat label={t("system.messages")} value={formatNumber(metrics.counts.messages)} />
            <Stat label={t("system.users")} value={formatNumber(metrics.counts.users)} />
            <Stat label={t("system.rooms")} value={formatNumber(metrics.counts.rooms)} />
            <Stat label={t("system.sessions")} value={formatNumber(metrics.counts.sessions)} />
            <Stat label={t("system.worlds")} value={formatNumber(metrics.counts.worlds)} />
          </Panel>

          {metrics.fly.machineId || metrics.fly.app ? (
            <Panel anchor="system.panelFly" title={t("system.panelFly")}>
              <Stat label={t("system.app")} value={metrics.fly.app ?? "-"} />
              <Stat label={t("system.region")} value={metrics.fly.region ?? "-"} />
              <Stat label={t("system.machine")} value={metrics.fly.machineId ?? "-"} />
              <Stat label={t("system.image")} value={metrics.fly.imageRef ?? "-"} hint={metrics.fly.imageRef ?? undefined} />
            </Panel>
          ) : null}
        </>
      ) : (
        !error ? <div className="rounded border border-keep-rule p-3 text-keep-muted">{t("system.loadingMetrics")}</div> : null
      )}

      {(canRestart || canPurge) ? (
        <fieldset data-admin-anchor="system.maintenanceTools" className="rounded border border-red-700/50 p-3 text-xs">
          <legend className="px-1 uppercase tracking-widest text-red-400">{t("system.maintenanceTools")}</legend>
          <p className="mb-2 text-keep-muted">
            {t("system.maintenanceDescription")}
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
  const { t } = useTranslation("admin");
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
        setMsg(j.message ?? t("system.restarting"));
      } else {
        setMsg(t("system.restartFailed", { status: r.status }));
        setBusy(false);
        return;
      }
    } catch {
      setMsg(t("system.restartingDropped"));
    }
    // Give the server a few seconds to come back, then reload the page so
    // the admin lands on a fresh session-checked app instead of a dead tab.
    window.setTimeout(() => window.location.reload(), 6000);
  };

  return (
    <div data-admin-anchor="system.restartTitle" className="flex flex-wrap items-center gap-2">
      <div className="min-w-[180px] flex-1">
        <div className="font-semibold text-keep-text">{t("system.restartTitle")}</div>
        <div className="text-keep-muted">{t("system.restartDescription")}</div>
      </div>
      {!armed ? (
        <button type="button" disabled={busy} onClick={() => setArmed(true)}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner/60">
          {t("system.restartButton")}
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy} onClick={() => void restart()}
            className="keep-button rounded border border-red-700 bg-red-950/40 px-3 py-1 text-red-300 hover:bg-red-900/50">
            {busy ? t("system.restarting") : t("system.confirmRestart")}
          </button>
          <button type="button" disabled={busy} onClick={() => setArmed(false)}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner/60">
            {t("common:cancel")}
          </button>
        </div>
      )}
      {msg ? <span className="w-full text-keep-muted">{msg}</span> : null}
    </div>
  );
}

/* ---------------- Purge all messages ---------------- */

function PurgeMessagesTool({ onPurged }: { onPurged: () => void }) {
  const { t } = useTranslation("admin");
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
        setMsg(j.message ?? j.error ?? t("system.failedStatus", { status: r.status }));
      } else {
        setMsg(t("system.purgeDeleted", { n: formatNumber(j.deleted ?? 0) }));
        setConfirmText("");
        onPurged();
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t("requestFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-admin-anchor="system.purgeTitle" className="flex flex-wrap items-center gap-2 border-t border-keep-rule/40 pt-3">
      <div className="min-w-[180px] flex-1">
        <div className="font-semibold text-keep-text">{t("system.purgeTitle")}</div>
        <div className="text-keep-muted">
          <Trans t={t} i18nKey="system.purgeDescription">
            {"Permanently deletes every chat message site-wide. Irreversible. Rooms and accounts are untouched. Type "}
            <span className="font-mono text-red-400">PURGE</span>
            {" to enable."}
          </Trans>
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
        {busy ? t("system.purging") : t("system.purge")}
      </button>
      {msg ? <span className="w-full text-keep-muted">{msg}</span> : null}
    </div>
  );
}
