/**
 * Admin → Backups tab.
 *
 * Three vertically-stacked panels, all gated to masteradmin (the
 * outer AdminPanel hides this tab from plain admins; the server also
 * 403s every endpoint, so a URL-guessing admin can't sneak in):
 *
 *   1. Full database, Create+download a fresh .zip snapshot
 *      bundling database.sqlite + the entire /uploads/ tree; upload
 *      + import a candidate .zip (with a confirmation modal once
 *      we've inspected it).
 *
 *   2. Content backup, Create+download a .zip snapshot bundling
 *      content.json (every exportable table) + the /uploads/ tree;
 *      upload + import a candidate .zip (with a per-table diff
 *      preview before confirm).
 *
 *   3. Snapshots, Listing of every artifact in /data/backups/,
 *      with download + delete actions. Auto-snapshots taken
 *      before a destructive restore are labelled distinctly so
 *      admins know which copies to keep as undo points.
 *
 * Everything destructive (Import) takes a pre-import snapshot
 * automatically, the server side handles that, so a botched
 * restore is one Snapshots-tab click away from undo.
 *
 * Format note: every artifact (download or upload) is a v3+ ZIP
 * envelope that bundles the database payload AND the uploads tree.
 * Earlier formats (.sqlite / .json on disk, no uploads bundled)
 * are not supported by this UI or the server routes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BackupOperationStatus,
  BackupSnapshotEntry,
  ContentBackupInspectReport,
  ContentImportDiffEntry,
  FullBackupInspectReport,
} from "@thekeep/shared";

interface CreateResponse extends BackupSnapshotEntry { /* same shape */ }
interface ContentImportResult {
  ok: true;
  inserted: number;
  updated: number;
  unchanged: number;
  uploadsRestored: number;
  preSnapshotId: string;
}
interface FullImportResult {
  ok: true;
  preSnapshotId: string;
  uploadsRestored: number;
  message: string;
}

export function AdminBackupsTab() {
  const [snapshots, setSnapshots] = useState<BackupSnapshotEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local "we just kicked off something" message. Distinct from
  // serverStatus.currentOperation, the local message is set
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
        /* ignore, next tick retries */
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
    // Re-creating the loop on serverStatus changes is intentional,
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
          // hard error, show a friendly note and let the status
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
        // Snapshots list. Failures here (network / auth) surface as
        // the same error banner the create errors do, the file is
        // still on disk in /data/backups/ and the admin can retry
        // from the Snapshots panel below.
        await triggerDownload(entry.id);
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
          custom commands, settings, system rooms + worlds). Every snapshot is a ZIP that bundles the database payload
          AND every uploaded image (emoticon sheets, logos, rank sigil + border PNGs), so restoring on a fresh host
          comes up with everything intact. Each destructive import auto-saves a pre-restore safety snapshot so undo is
          one click away.
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
    onBusy("Uploading + inspecting archive…");
    onError("");
    try {
      const res = await fetch("/admin/backup/full/inspect", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/zip" },
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
      onError("Cannot import, file failed validation.");
      return;
    }
    if (report.missingMigrations.length > 0) {
      onError(
        `Cannot import, this install is missing ${report.missingMigrations.length} migration(s) the backup expects. Deploy first.`,
      );
      return;
    }
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      "Replacing the live database AND the uploads tree with this backup will sign every user out, drop unsaved changes, and restart the server. A pre-restore safety snapshot will be taken automatically. Continue?",
    )) return;
    onBusy("Importing full archive, the server will restart…");
    onError("");
    try {
      const res = await fetch("/admin/backup/full/import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/zip" },
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
      // Don't refresh, the server is about to exit. Just surface
      // the message; the page will become unreachable for ~30s.
      onError("");
      onBusy(`${result.message} (${result.uploadsRestored} upload file(s) staged. Pre-restore snapshot: ${result.preSnapshotId})`);
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
          .zip, database.sqlite + uploads/ (everything: users, messages, earning, cosmetics, all images)
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
          Upload .zip to inspect…
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
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
              File failed validation, not a valid backup archive, or the inner database isn't from a Spire install
              (missing the <span className="font-mono">users.system</span> sentinel row that every Spire install seeds).
            </p>
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-1">
                <li>Users: <span className="font-mono">{report.counts.users.toLocaleString()}</span></li>
                <li>Characters: <span className="font-mono">{report.counts.characters.toLocaleString()}</span></li>
                <li>Messages: <span className="font-mono">{report.counts.messages.toLocaleString()}</span></li>
                <li>Rooms: <span className="font-mono">{report.counts.rooms.toLocaleString()}</span></li>
                <li className="col-span-2 pt-1 border-t border-keep-rule/40">
                  Bundled uploads:{" "}
                  <span className="font-mono">{report.uploadsFileCount.toLocaleString()}</span> file(s),{" "}
                  <span className="font-mono">{formatBytes(report.uploadsBytes)}</span>
                </li>
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
                  Import (replaces live DB + uploads, restarts server)
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
  const [report, setReport] = useState<(ContentBackupInspectReport & { __file?: File }) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    onBusy("Uploading + inspecting content archive…");
    onError("");
    try {
      const res = await fetch("/admin/backup/content/inspect", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/zip" },
        body: f,
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { busy?: BackupOperationStatus; error?: string; message?: string };
        if (body.busy?.currentOperation) {
          onError(`Another backup operation is in progress (${body.busy.currentOperation.kind}). Wait for it to finish.`);
          return;
        }
        throw new Error(body.message || body.error || "inspect refused");
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(body.message || body.error || `inspect failed: ${res.status}`);
      }
      const r = (await res.json()) as ContentBackupInspectReport;
      setReport({ ...r, __file: f });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      onBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function commitImport() {
    if (!report || !report.__file) return;
    const diff = report.diff;
    if (diff.missingMigrations.length > 0) {
      onError(
        `Cannot import, this install is missing ${diff.missingMigrations.length} migration(s) the backup expects. Deploy first.`,
      );
      return;
    }
    const totals = diff.entries.reduce(
      (acc, e) => ({
        add: acc.add + e.toAdd,
        wipe: acc.wipe + e.onlyOnTarget,
      }),
      { add: 0, wipe: 0 },
    );
    // Mirror restore: every table in the document gets wiped on the
    // target before the source rows are inserted, AND the uploads
    // tree is replaced wholesale. Spell that out in the confirm so
    // the admin isn't surprised when their live users get replaced
    // by the backup's snapshot.
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      `MIRROR RESTORE: this will DELETE ${totals.wipe.toLocaleString()} row(s) currently on this install and REPLACE them with ${totals.add.toLocaleString()} row(s) from the backup, across ${diff.entries.length} tables. It will also REPLACE the live uploads tree with the ${report.uploadsFileCount.toLocaleString()} file(s) bundled in the archive. A pre-import safety snapshot will be saved automatically so you can roll back if needed. Continue?`,
    )) return;
    onBusy("Importing content backup…");
    onError("");
    try {
      const res = await fetch("/admin/backup/content/import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/zip" },
        body: report.__file,
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
      onBusy(`Imported: ${result.inserted} row(s) added, ${result.uploadsRestored} upload file(s) restored. Pre-import snapshot: ${result.preSnapshotId}`);
      setReport(null);
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
        <h4 className="font-action text-sm">Content backup (ZIP envelope)</h4>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">
          .zip, content.json (every exportable table) + uploads/ (every uploaded image)
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
          Upload .zip to inspect…
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
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
            <span className="text-keep-muted">
              format v{report.diff.uploadedVersion} → server v{report.diff.serverVersion} · {formatBytes(report.sizeBytes)}
            </span>
          </div>
          {report.diff.missingMigrations.length > 0 ? (
            <p className="text-keep-accent">
              ⚠ This install is missing {report.diff.missingMigrations.length} migration(s) the backup expects:
              <span className="ml-1 font-mono break-all">{report.diff.missingMigrations.slice(0, 3).join(", ")}{report.diff.missingMigrations.length > 3 ? "…" : ""}</span>
            </p>
          ) : null}
          <p className="text-keep-muted">
            Bundled uploads:{" "}
            <span className="font-mono text-keep-text">{report.uploadsFileCount.toLocaleString()}</span> file(s),{" "}
            <span className="font-mono text-keep-text">{formatBytes(report.uploadsBytes)}</span>
            , will replace the live <span className="font-mono">/uploads/</span> tree on import.
          </p>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-keep-rule/60 text-[10px] uppercase tracking-widest text-keep-muted">
                <th className="py-1 pr-2">Table</th>
                <th className="py-1 px-2 text-right">From backup</th>
                <th className="py-1 pl-2 text-right">Wipes from target</th>
              </tr>
            </thead>
            <tbody>
              {report.diff.entries.map((e: ContentImportDiffEntry) => (
                <tr key={e.table} className="border-b border-keep-rule/30">
                  <td className="py-1 pr-2 font-mono">{e.table}</td>
                  <td className="py-1 px-2 text-right font-mono">{e.toAdd || ""}</td>
                  <td className="py-1 pl-2 text-right font-mono text-keep-accent">{e.onlyOnTarget || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-keep-muted">
            Content backup is a <b className="text-keep-text">mirror restore</b>, every table the document carries gets wiped on this install and replaced with the source rows, and the entire <span className="font-mono">/uploads/</span> tree is replaced with the archive's. Tables not in the document are left untouched. A pre-import safety snapshot is saved automatically so you can roll back.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => void commitImport()}
              disabled={busy || report.diff.missingMigrations.length > 0}
              className="rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-sm text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
            >
              Import (mirror restore)
            </button>
            <button
              type="button"
              onClick={() => setReport(null)}
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
                onClick={() => { void triggerDownload(e.id); }}
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

async function triggerDownload(id: string): Promise<void> {
  // CANNOT use a bare anchor `href` here. The server's auth model is
  // `Authorization: Bearer <sid>` injected by the monkey-patched
  // window.fetch in lib/http.ts; plain anchor navigations bypass
  // fetch entirely so they carry no Authorization header and the
  // admin gate 403s every download. We instead fetch the file
  // through the patched fetch (which DOES carry the token),
  // materialize the response as a blob, and trigger the download
  // off a blob:// URL via an anchor with the `download` attribute
  // so the browser still respects the filename + saves to disk
  // instead of opening inline.
  const res = await fetch(`/admin/backup/snapshots/${encodeURIComponent(id)}`, {
    credentials: "include",
  });
  if (!res.ok) {
    let detail = `download failed: ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = `${detail}, ${body.error}`;
    } catch { /* response body wasn't JSON; the status alone is enough */ }
    throw new Error(detail);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = id;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a moment to actually start the download before
  // we invalidate the object URL. Revoking too early can race the
  // download and produce a zero-byte file on some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
