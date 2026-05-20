/**
 * Admin → Backups tab.
 *
 * Three vertically-stacked panels, all gated to masteradmin (the
 * outer AdminPanel hides this tab from plain admins; the server also
 * 403s every endpoint, so a URL-guessing admin can't sneak in):
 *
 *   1. Full database — Create+download a fresh .sqlite snapshot;
 *      upload + import a candidate .sqlite (with a confirmation
 *      modal once we've inspected it).
 *
 *   2. Content backup — Create+download a JSON document of every
 *      admin-customizable table; upload + import a candidate JSON
 *      (with a per-table diff preview before confirm).
 *
 *   3. Snapshots — Listing of every artifact in /data/backups/,
 *      with download + delete actions. Auto-snapshots taken
 *      before a destructive restore are labelled distinctly so
 *      admins know which copies to keep as undo points.
 *
 * Everything destructive (Import) takes a pre-import snapshot
 * automatically — the server side handles that — so a botched
 * restore is one Snapshots-tab click away from undo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BackupContentDocument,
  BackupOperationStatus,
  BackupSnapshotEntry,
  ContentImportDiff,
  ContentImportDiffEntry,
  FullBackupInspectReport,
} from "@thekeep/shared";

interface CreateResponse extends BackupSnapshotEntry { /* same shape */ }
interface ContentImportResult {
  ok: true;
  inserted: number;
  updated: number;
  unchanged: number;
  preSnapshotId: string;
}
interface FullImportResult {
  ok: true;
  preSnapshotId: string;
  message: string;
}

export function AdminBackupsTab() {
  const [snapshots, setSnapshots] = useState<BackupSnapshotEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local "we just kicked off something" message. Distinct from
  // serverStatus.currentOperation — the local message is set
  // immediately on button click and cleared either when the server
  // status confirms an in-flight op (the server's message replaces
  // it) or when the operation completes.
  const [busy, setBusy] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<BackupOperationStatus>({ currentOperation: null });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/admin/backup/snapshots", { credentials: "include" });
      if (!res.ok) throw new Error(`list failed: ${res.status}`);
      const body = (await res.json()) as { snapshots: BackupSnapshotEntry[] };
      setSnapshots(body.snapshots);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Status poll. Always running while the tab is mounted so a
  // backup kicked off in another browser tab (or another admin)
  // also surfaces here. Cadence dynamically tightens to 1.5s when
  // an op is in flight + relaxes to 8s when idle so we don't burn
  // requests just to show "Idle".
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick() {
      try {
        const res = await fetch("/admin/backup/status", { credentials: "include" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as BackupOperationStatus;
        if (cancelled) return;
        const wasBusy = serverStatus.currentOperation !== null;
        setServerStatus(body);
        const isBusy = body.currentOperation !== null;
        // Transition busy → idle = an op just finished; refresh the
        // snapshots list so a new artifact (or a deletion) lands
        // immediately without the admin having to click Refresh.
        if (wasBusy && !isBusy) {
          void refresh();
        }
      } catch {
        /* ignore — next tick retries */
      } finally {
        if (!cancelled) {
          const delay = serverStatus.currentOperation ? 1500 : 8000;
          timer = setTimeout(() => void tick(), delay);
        }
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Re-creating the loop on serverStatus changes is intentional —
    // it lets the dynamic cadence (1.5s / 8s) take effect mid-poll.
  }, [serverStatus.currentOperation, refresh]);

  // Convenience: a unified "is anything happening?" flag for the UI.
  const anyBusy = busy !== null || serverStatus.currentOperation !== null;
  const busyMessage = serverStatus.currentOperation?.message ?? busy;

  /* ---------- create ---------- */

  const createSnapshot = useCallback(
    async (kind: "full" | "content") => {
      const label = kind === "full" ? "full DB" : "content";
      setBusy(`Starting ${label} snapshot…`);
      setError(null);
      try {
        const res = await fetch(`/admin/backup/${kind}/create`, {
          method: "POST",
          credentials: "include",
        });
        if (res.status === 409) {
          // Server's already running another op. Don't surface as a
          // hard error — show a friendly note and let the status
          // poll display the live state of the in-flight job.
          const body = (await res.json().catch(() => ({}))) as { busy?: BackupOperationStatus };
          const op = body.busy?.currentOperation;
          setError(
            op
              ? `Another backup operation is in progress (${op.kind}: ${op.message}). Wait for it to finish before starting another.`
              : "Server is busy with another backup operation. Try again in a moment.",
          );
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
          throw new Error(body.message || body.error || `create failed: ${res.status}`);
        }
        const entry = (await res.json()) as CreateResponse;
        // Immediately trigger a browser download of the just-created
        // artifact so the admin doesn't have to find it in the
        // Snapshots list. They can still re-download later from there.
        triggerDownload(entry.id);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  /* ---------- delete ---------- */

  const removeSnapshot = useCallback(
    async (entry: BackupSnapshotEntry) => {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Delete snapshot "${entry.filename}"? This can't be undone.`)) return;
      setBusy(`Deleting ${entry.filename}…`);
      try {
        const res = await fetch(`/admin/backup/snapshots/${encodeURIComponent(entry.id)}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `delete failed: ${res.status}`);
        }
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h3 className="font-action text-lg">Backups</h3>
        <p className="text-xs text-keep-muted">
          Snapshot the database (full file) or the admin-customizable content (items, name styles, ranks, border frames,
          custom commands, settings, system rooms + worlds). Restore on this install or import on a fresh one. Every
          destructive import auto-saves a pre-restore safety snapshot so undo is one click away.
        </p>
      </header>

      {busyMessage ? (
        <div className="rounded border border-keep-action/40 bg-keep-action/10 px-3 py-2 text-xs text-keep-action">
          {/* Spinner + message. The status comes from the SERVER's
              in-flight op when set; otherwise from the LOCAL busy
              flag set on button click. */}
          <span className="mr-2 inline-block animate-pulse">●</span>
          {busyMessage}
          {serverStatus.currentOperation ? (
            <span className="ml-2 text-keep-muted">
              ({Math.round((Date.now() - serverStatus.currentOperation.startedAt) / 1000)}s)
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-3 py-2 text-xs text-keep-accent">
          {error}
        </div>
      ) : null}

      <FullDbPanel
        onCreate={() => createSnapshot("full")}
        onImported={refresh}
        onError={setError}
        onBusy={setBusy}
        busy={anyBusy}
      />
      <ContentPanel
        onCreate={() => createSnapshot("content")}
        onImported={refresh}
        onError={setError}
        onBusy={setBusy}
        busy={anyBusy}
      />
      <SnapshotsPanel
        snapshots={snapshots}
        loading={loading}
        onRefresh={refresh}
        onDelete={removeSnapshot}
      />
    </div>
  );
}

/* ============================================================
 *  Full DB panel
 * ============================================================ */

function FullDbPanel({
  onCreate,
  onImported,
  onError,
  onBusy,
  busy,
}: {
  onCreate: () => Promise<void>;
  onImported: () => Promise<void>;
  onError: (msg: string) => void;
  onBusy: (msg: string | null) => void;
  busy: boolean;
}) {
  const [report, setReport] = useState<(FullBackupInspectReport & { __file?: File }) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    onBusy("Uploading + inspecting database…");
    onError("");
    try {
      const res = await fetch("/admin/backup/full/inspect", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/octet-stream" },
        body: f,
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { busy?: BackupOperationStatus };
        if (body.busy?.currentOperation) {
          onError(`Another backup operation is in progress (${body.busy.currentOperation.kind}). Wait for it to finish.`);
          return;
        }
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `inspect failed: ${res.status}`);
      }
      const r = (await res.json()) as FullBackupInspectReport;
      setReport({ ...r, __file: f });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      onBusy(null);
      // Reset so picking the SAME file again still triggers onChange.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function commitImport() {
    if (!report || !report.__file) return;
    if (!report.ok) {
      onError("Cannot import — file failed validation.");
      return;
    }
    if (report.missingMigrations.length > 0) {
      onError(
        `Cannot import — this install is missing ${report.missingMigrations.length} migration(s) the backup expects. Deploy first.`,
      );
      return;
    }
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      "Replacing the live database with this backup will sign every user out, drop unsaved changes, and restart the server. A pre-restore safety snapshot will be taken automatically. Continue?",
    )) return;
    onBusy("Importing full database — the server will restart…");
    onError("");
    try {
      const res = await fetch("/admin/backup/full/import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/octet-stream" },
        body: report.__file,
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { busy?: BackupOperationStatus; error?: string; message?: string };
        if (body.busy?.currentOperation) {
          onError(`Another backup operation is in progress (${body.busy.currentOperation.kind}). Wait for it to finish.`);
          onBusy(null);
          return;
        }
        // Other 409 (schema-behind) falls through to the generic error
        throw new Error(body.message || body.error || "import refused");
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(body.message || body.error || `import failed: ${res.status}`);
      }
      const result = (await res.json()) as FullImportResult;
      // Don't refresh — the server is about to exit. Just surface
      // the message; the page will become unreachable for ~30s.
      onError("");
      onBusy(`${result.message} (Pre-restore snapshot: ${result.preSnapshotId})`);
      setReport(null);
      // After a short window, force a reload so the admin lands on
      // the restored install.
      setTimeout(() => { window.location.reload(); }, 12_000);
    } catch (err) {
      onError((err as Error).message);
      onBusy(null);
    }
  }

  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40 p-3 space-y-3">
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="font-action text-sm">Full database snapshot</h4>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">
          .sqlite — everything: users, messages, earning, cosmetics
        </span>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onCreate()}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-sm text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          Create + download
        </button>
        <label className="rounded border border-keep-rule px-3 py-1 text-sm text-keep-text hover:bg-keep-banner cursor-pointer">
          Upload .sqlite to inspect…
          <input
            ref={fileInputRef}
            type="file"
            accept=".sqlite,application/octet-stream"
            className="hidden"
            onChange={(e) => void onFileChosen(e)}
            disabled={busy}
          />
        </label>
      </div>

      {report ? (
        <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-banner/30 p-3 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-semibold">Inspect report</span>
            <span className="text-keep-muted">{formatBytes(report.sizeBytes)}</span>
          </div>
          {!report.ok ? (
            <p className="text-keep-accent">
              File failed validation — not a SQLite database, or not from a Spire install (missing the
              <span className="ml-1 font-mono">users.system</span> sentinel row that every Spire install seeds).
            </p>
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-1">
                <li>Users: <span className="font-mono">{report.counts.users.toLocaleString()}</span></li>
                <li>Characters: <span className="font-mono">{report.counts.characters.toLocaleString()}</span></li>
                <li>Messages: <span className="font-mono">{report.counts.messages.toLocaleString()}</span></li>
                <li>Rooms: <span className="font-mono">{report.counts.rooms.toLocaleString()}</span></li>
              </ul>
              {report.missingMigrations.length > 0 ? (
                <p className="text-keep-accent">
                  ⚠ Target install is missing {report.missingMigrations.length} migration(s) the backup expects. Deploy before importing:
                  <span className="ml-1 font-mono break-all">{report.missingMigrations.slice(0, 3).join(", ")}{report.missingMigrations.length > 3 ? "…" : ""}</span>
                </p>
              ) : null}
              {report.extraMigrationsOnServer.length > 0 ? (
                <p className="text-keep-muted">
                  Note: this install has {report.extraMigrationsOnServer.length} migration(s) ahead of the backup. Import will still work; newer columns get default values.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void commitImport()}
                  disabled={busy || report.missingMigrations.length > 0}
                  className="rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-sm text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
                >
                  Import (replaces live DB, restarts server)
                </button>
                <button
                  type="button"
                  onClick={() => { setReport(null); void onImported(); }}
                  disabled={busy}
                  className="rounded border border-keep-rule px-3 py-1 text-sm text-keep-muted hover:bg-keep-banner"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/* ============================================================
 *  Content panel
 * ============================================================ */

function ContentPanel({
  onCreate,
  onImported,
  onError,
  onBusy,
  busy,
}: {
  onCreate: () => Promise<void>;
  onImported: () => Promise<void>;
  onError: (msg: string) => void;
  onBusy: (msg: string | null) => void;
  busy: boolean;
}) {
  const [diff, setDiff] = useState<(ContentImportDiff & { __doc?: BackupContentDocument }) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    onBusy("Inspecting uploaded content document…");
    onError("");
    try {
      const text = await f.text();
      let doc: BackupContentDocument;
      try {
        doc = JSON.parse(text) as BackupContentDocument;
      } catch {
        throw new Error("not a valid JSON document");
      }
      if (doc.kind !== "content") {
        throw new Error("file is not a content backup");
      }
      const res = await fetch("/admin/backup/content/inspect", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(doc),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `inspect failed: ${res.status}`);
      }
      const d = (await res.json()) as ContentImportDiff;
      setDiff({ ...d, __doc: doc });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      onBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function commitImport() {
    if (!diff || !diff.__doc) return;
    if (diff.missingMigrations.length > 0) {
      onError(
        `Cannot import — this install is missing ${diff.missingMigrations.length} migration(s) the backup expects. Deploy first.`,
      );
      return;
    }
    const totals = diff.entries.reduce(
      (acc, e) => ({ add: acc.add + e.toAdd, upd: acc.upd + e.toUpdate }),
      { add: 0, upd: 0 },
    );
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      `Applying this content backup will add ${totals.add} row(s) and update ${totals.upd} row(s) across ${diff.entries.length} tables. A pre-import safety snapshot will be saved. Continue?`,
    )) return;
    onBusy("Importing content backup…");
    onError("");
    try {
      const res = await fetch("/admin/backup/content/import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(diff.__doc),
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { busy?: BackupOperationStatus; error?: string; message?: string };
        if (body.busy?.currentOperation) {
          onError(`Another backup operation is in progress (${body.busy.currentOperation.kind}). Wait for it to finish.`);
          onBusy(null);
          return;
        }
        throw new Error(body.message || body.error || "import refused");
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(body.message || body.error || `import failed: ${res.status}`);
      }
      const result = (await res.json()) as ContentImportResult;
      onError("");
      onBusy(`Imported: ${result.inserted} added, ${result.updated} updated, ${result.unchanged} unchanged. Pre-import snapshot: ${result.preSnapshotId}`);
      setDiff(null);
      await onImported();
      // Clear the success line after a few seconds so the panel
      // doesn't get stuck looking busy.
      setTimeout(() => onBusy(null), 4000);
    } catch (err) {
      onError((err as Error).message);
      onBusy(null);
    }
  }

  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40 p-3 space-y-3">
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="font-action text-sm">Content backup (cosmetics & config)</h4>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">
          .json — items, name styles, ranks, border frames, custom commands, settings
        </span>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onCreate()}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-sm text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          Create + download
        </button>
        <label className="rounded border border-keep-rule px-3 py-1 text-sm text-keep-text hover:bg-keep-banner cursor-pointer">
          Upload .json to inspect…
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => void onFileChosen(e)}
            disabled={busy}
          />
        </label>
      </div>

      {diff ? (
        <div className="space-y-2 rounded border border-keep-rule/60 bg-keep-banner/30 p-3 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-semibold">Inspect report</span>
            <span className="text-keep-muted">format v{diff.uploadedVersion} → server v{diff.serverVersion}</span>
          </div>
          {diff.missingMigrations.length > 0 ? (
            <p className="text-keep-accent">
              ⚠ This install is missing {diff.missingMigrations.length} migration(s) the backup expects:
              <span className="ml-1 font-mono break-all">{diff.missingMigrations.slice(0, 3).join(", ")}{diff.missingMigrations.length > 3 ? "…" : ""}</span>
            </p>
          ) : null}
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-keep-rule/60 text-[10px] uppercase tracking-widest text-keep-muted">
                <th className="py-1 pr-2">Table</th>
                <th className="py-1 px-2 text-right">Add</th>
                <th className="py-1 px-2 text-right">Update</th>
                <th className="py-1 px-2 text-right">On target only</th>
                <th className="py-1 pl-2 text-right">Unchanged</th>
              </tr>
            </thead>
            <tbody>
              {diff.entries.map((e: ContentImportDiffEntry) => (
                <tr key={e.table} className="border-b border-keep-rule/30">
                  <td className="py-1 pr-2 font-mono">{e.table}</td>
                  <td className="py-1 px-2 text-right font-mono">{e.toAdd || ""}</td>
                  <td className="py-1 px-2 text-right font-mono">{e.toUpdate || ""}</td>
                  <td className="py-1 px-2 text-right font-mono text-keep-muted">{e.onlyOnTarget || ""}</td>
                  <td className="py-1 pl-2 text-right font-mono text-keep-muted">{e.unchanged || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-keep-muted">
            "On target only" rows survive the import — nothing is deleted.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => void commitImport()}
              disabled={busy || diff.missingMigrations.length > 0}
              className="rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-sm text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
            >
              Import (applies upserts)
            </button>
            <button
              type="button"
              onClick={() => setDiff(null)}
              disabled={busy}
              className="rounded border border-keep-rule px-3 py-1 text-sm text-keep-muted hover:bg-keep-banner"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ============================================================
 *  Snapshots panel
 * ============================================================ */

function SnapshotsPanel({
  snapshots,
  loading,
  onRefresh,
  onDelete,
}: {
  snapshots: BackupSnapshotEntry[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onDelete: (entry: BackupSnapshotEntry) => Promise<void>;
}) {
  const grouped = useMemo(() => {
    const out: Record<string, BackupSnapshotEntry[]> = { manual: [], pre_full_import: [], pre_content_import: [] };
    for (const s of snapshots) {
      if (!out[s.trigger]) out[s.trigger] = [];
      out[s.trigger]!.push(s);
    }
    return out;
  }, [snapshots]);

  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40 p-3 space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-action text-sm">On-disk snapshots</h4>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={loading}
          className="rounded border border-keep-rule px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p className="text-[11px] text-keep-muted">
        Manual snapshots are downloads you triggered. Pre-import snapshots are taken automatically before each restore so you can undo. Up to 10 of each kind are retained; the oldest are pruned automatically.
      </p>

      <SnapshotGroup title="Manual" entries={grouped.manual ?? []} onDelete={onDelete} />
      <SnapshotGroup title="Pre full-DB import (safety copies)" entries={grouped.pre_full_import ?? []} onDelete={onDelete} />
      <SnapshotGroup title="Pre content import (safety copies)" entries={grouped.pre_content_import ?? []} onDelete={onDelete} />
    </section>
  );
}

function SnapshotGroup({
  title,
  entries,
  onDelete,
}: {
  title: string;
  entries: BackupSnapshotEntry[];
  onDelete: (entry: BackupSnapshotEntry) => Promise<void>;
}) {
  return (
    <div>
      <h5 className="text-[10px] uppercase tracking-widest text-keep-muted">{title}</h5>
      {entries.length === 0 ? (
        <p className="text-xs italic text-keep-muted">No snapshots in this bucket.</p>
      ) : (
        <ul className="mt-1 divide-y divide-keep-rule/30">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 py-1 text-xs">
              <span className="inline-block w-12 shrink-0 rounded border border-keep-rule/60 bg-keep-banner/40 px-1 text-center text-[10px] uppercase tracking-widest text-keep-muted">
                {e.kind}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono">{e.filename}</span>
              <span className="shrink-0 text-keep-muted">{formatBytes(e.sizeBytes)}</span>
              <span className="shrink-0 text-keep-muted">{new Date(e.createdAt).toLocaleString()}</span>
              <button
                type="button"
                onClick={() => triggerDownload(e.id)}
                className="rounded border border-keep-rule px-2 py-0.5 text-xs hover:bg-keep-banner"
              >
                Download
              </button>
              <button
                type="button"
                onClick={() => void onDelete(e)}
                className="rounded border border-keep-rule px-2 py-0.5 text-xs text-keep-accent hover:bg-keep-accent/10"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
 *  Helpers
 * ============================================================ */

function triggerDownload(id: string) {
  // Use an anchor + click rather than `window.open` so the
  // browser respects the Content-Disposition: attachment header
  // (a fresh tab would render the JSON inline instead).
  const a = document.createElement("a");
  a.href = `/admin/backup/snapshots/${encodeURIComponent(id)}`;
  a.download = id;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
