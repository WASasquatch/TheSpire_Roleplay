/**
 * Server Admin → Emoticons (Admin Partition — plan_ext.md §4, surface B).
 *
 * The per-server analog of the GLOBAL `AdminEmoticonsTab`. A server owner/mod
 * holding `manage_emoticons` curates THIS server's emoticon sheets and reviews
 * THIS server's user submissions, scoped to `/servers/:id/emoticons/*`.
 *
 * READ-ONLY shared/built-ins: platform-shared sheets (server_id NULL) are
 * returned by the list endpoint with `editable: false` and rendered without
 * edit/delete affordances — a sub-server can see what its members can already
 * use, but cannot mutate the shared catalog (that stays in the global panel).
 *
 * House conventions: default-export `function EmoticonsTab({ serverId, viewer,
 * busy, run, onSaved })` (the per-console tab prop contract; note this tab uses
 * `serverId: string` rather than the full `detail` object the other tabs take —
 * flagged to the orchestrator). Inline `fetch` helpers (no shared lib widening).
 * `keep-*` styling mirroring the sibling tabs in `ServerSettingsView.tsx` and
 * the global `AdminEmoticonsTab.tsx`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { EMOTICON_SHEET_CELL_COUNT, isEmoticonCellEmpty, type ServerViewerState } from "@thekeep/shared";
import { readError } from "../../lib/http.js";

/* ============================================================
 * Wire shapes (consumed read-only from /servers/:id/emoticons).
 * Local because lib/servers.ts is a shared, do-not-touch module.
 * ============================================================ */
interface ServerSheet {
  id: string;
  slug: string;
  name: string;
  imageUrl: string;
  cells: string[];
  sortOrder: number;
  status: string;
  serverId: string | null;
  /** False for platform-shared/built-in sheets → rendered read-only. */
  editable: boolean;
  useCount: number;
  createdAt: number;
}

interface ServerSubmission {
  id: string;
  slug: string;
  name: string;
  imageUrl: string;
  cells: string[];
  status: string;
  submitterScope: string | null;
  submitterPoolId: string | null;
  submitterLabel: string;
  costPaid: number | null;
  rejectionReason: string | null;
  reviewedAt: number | null;
  createdAt: number;
}

/* ============================================================
 * Inline fetch helpers.
 * ============================================================ */
async function apiListSheets(serverId: string): Promise<{ sheets: ServerSheet[] }> {
  const r = await fetch(`/servers/${serverId}/emoticons/sheets`, { credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
  return r.json() as Promise<{ sheets: ServerSheet[] }>;
}

async function apiCreateSheet(
  serverId: string,
  body: { slug: string; name: string; cells: string[]; imageDataUrl: string },
): Promise<void> {
  const r = await fetch(`/servers/${serverId}/emoticons/sheets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!r.ok) throw new Error(await readError(r));
}

async function apiUpdateSheet(
  serverId: string,
  sheetId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const r = await fetch(`/servers/${serverId}/emoticons/sheets/${sheetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!r.ok) throw new Error(await readError(r));
}

async function apiDeleteSheet(serverId: string, sheetId: string): Promise<void> {
  const r = await fetch(`/servers/${serverId}/emoticons/sheets/${sheetId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok) throw new Error(await readError(r));
}

async function apiListSubmissions(serverId: string): Promise<{ submissions: ServerSubmission[] }> {
  const r = await fetch(`/servers/${serverId}/emoticons/submissions`, { credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
  return r.json() as Promise<{ submissions: ServerSubmission[] }>;
}

async function apiApproveSubmission(serverId: string, sheetId: string): Promise<void> {
  const r = await fetch(`/servers/${serverId}/emoticons/submissions/${sheetId}/approve`, {
    method: "POST",
    credentials: "include",
  });
  if (!r.ok) throw new Error(await readError(r));
}

async function apiRejectSubmission(
  serverId: string,
  sheetId: string,
  reason: string | null,
): Promise<{ refundedAmount: number }> {
  const r = await fetch(`/servers/${serverId}/emoticons/submissions/${sheetId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: reason ?? undefined }),
    credentials: "include",
  });
  if (!r.ok) throw new Error(await readError(r));
  return r.json() as Promise<{ refundedAmount: number }>;
}

/* ============================================================
 * Tab props — the per-console contract (note: `serverId` not `detail`).
 * ============================================================ */
interface EmoticonsTabProps {
  serverId: string;
  viewer: ServerViewerState;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}

export default function EmoticonsTab({ serverId, viewer, busy, run, onSaved }: EmoticonsTabProps) {
  const { t } = useTranslation("servers");
  const [sheets, setSheets] = useState<ServerSheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creatingOpen, setCreatingOpen] = useState(false);

  // Belt-and-braces: the routes re-check `manage_emoticons`, but hide the
  // mutating affordances if the mirrored viewer perm is absent.
  const canManage = viewer.isOwner || viewer.permissions.includes("manage_emoticons");

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await apiListSheets(serverId);
      setSheets(r.sheets);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("emoticonsTab.loadSheetsError"));
    } finally {
      setLoading(false);
    }
  }, [serverId, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const owned = useMemo(() => sheets.filter((s) => s.editable), [sheets]);
  const shared = useMemo(() => sheets.filter((s) => !s.editable), [sheets]);

  return (
    <div className="space-y-4">
      {/* Submission review is the time-sensitive surface (members are waiting),
          so it leads the tab — mirrors the global AdminEmoticonsTab. */}
      <SubmissionsQueue serverId={serverId} busy={busy} run={run} onSettled={() => void refresh()} />

      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-action text-base">{t("emoticonsTab.heading")}</h3>
          <p className="text-xs text-keep-muted">
            {t("emoticonsTab.blurb")}
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setCreatingOpen((v) => !v)}
            className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg"
          >
            {creatingOpen ? t("shared.cancel") : t("emoticonsTab.newSheet")}
          </button>
        ) : null}
      </header>

      {err ? <p className="text-xs text-keep-accent">{err}</p> : null}

      {creatingOpen && canManage ? (
        <CreateSheetForm
          serverId={serverId}
          busy={busy}
          run={run}
          onCreated={() => { setCreatingOpen(false); onSaved(); void refresh(); }}
        />
      ) : null}

      {loading ? (
        <p className="text-xs text-keep-muted">{t("shared.loading")}</p>
      ) : (
        <>
          {owned.length === 0 ? (
            <p className="rounded border border-keep-rule bg-keep-panel/30 p-3 text-xs italic text-keep-muted">
              {t("emoticonsTab.noSheets")}
            </p>
          ) : (
            <ul className="space-y-3">
              {owned.map((s) => (
                <li key={s.id}>
                  <SheetEditor
                    serverId={serverId}
                    sheet={s}
                    busy={busy}
                    run={run}
                    canManage={canManage}
                    onChanged={() => { onSaved(); void refresh(); }}
                  />
                </li>
              ))}
            </ul>
          )}

          {/* Platform-shared / built-in sheets, read-only. They're already
              usable by this server's members; shown here for reference so an
              owner knows what's available before adding their own. */}
          {shared.length > 0 ? (
            <section className="space-y-2 rounded border border-keep-rule/60 bg-keep-bg/30 p-3">
              <header>
                <h3 className="font-action text-sm">{t("emoticonsTab.sharedHeading")}</h3>
                <p className="text-[11px] text-keep-muted">
                  {t("emoticonsTab.sharedBlurb")}
                </p>
              </header>
              <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {shared.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 rounded border border-keep-rule bg-keep-panel/20 p-2 text-xs"
                  >
                    <img
                      src={s.imageUrl}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded border border-keep-rule object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{s.name}</div>
                      <div className="truncate text-[10px] font-mono text-keep-muted">{s.slug}</div>
                    </div>
                    <span className="shrink-0 rounded border border-keep-rule/60 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-keep-muted">
                      {t("emoticonsTab.readOnly")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ============================================================
 * Create form — slug + name + cells + image upload.
 * ============================================================ */
function CreateSheetForm({
  serverId,
  busy,
  run,
  onCreated,
}: {
  serverId: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onCreated: () => void;
}) {
  const { t } = useTranslation("servers");
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [cells, setCells] = useState<string[]>(() => new Array(EMOTICON_SHEET_CELL_COUNT).fill(""));
  const [imageDataUrl, setImageDataUrl] = useState<string>("");

  function setCell(i: number, v: string) {
    setCells((prev) => prev.map((c, ix) => (ix === i ? v : c)));
  }

  function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") setImageDataUrl(result);
    };
    reader.readAsDataURL(f);
  }

  function submit() {
    void run(async () => {
      if (!imageDataUrl) throw new Error(t("emoticonsTab.uploadFirst"));
      await apiCreateSheet(serverId, { slug: slug.trim().toLowerCase(), name: name.trim(), cells, imageDataUrl });
      onCreated();
    });
  }

  return (
    <div className="rounded border border-keep-action/40 bg-keep-panel/30 p-3 space-y-3">
      <h4 className="font-action text-sm">{t("emoticonsTab.newSheetTitle")}</h4>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <label className="block text-xs">
          <span className="block uppercase tracking-widest text-keep-muted">{t("emoticonsTab.slugLabel")}</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={t("emoticonsTab.slugPlaceholder")}
            className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs"
            maxLength={40}
          />
        </label>
        <label className="block text-xs">
          <span className="block uppercase tracking-widest text-keep-muted">{t("emoticonsTab.displayNameLabel")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("emoticonsTab.displayNamePlaceholder")}
            className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
            maxLength={80}
          />
        </label>
      </div>
      <div>
        <label className="block text-xs">
          <span className="block uppercase tracking-widest text-keep-muted">{t("emoticonsTab.sheetImageLabel")}</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={pickFile}
            className="mt-1 block text-xs"
          />
        </label>
        {imageDataUrl ? (
          <img
            src={imageDataUrl}
            alt={t("emoticonsTab.previewAlt")}
            className="mt-2 max-h-48 rounded border border-keep-rule object-contain"
          />
        ) : null}
      </div>
      <CellLabelEditor cells={cells} onChange={setCell} />
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !slug.trim() || !name.trim() || !imageDataUrl}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {busy ? t("emoticonsTab.creating") : t("emoticonsTab.createSheet")}
        </button>
      </div>
    </div>
  );
}

/* ============================================================
 * Per-sheet editor — labels, replace image, delete. Editable rows only.
 * ============================================================ */
function SheetEditor({
  serverId,
  sheet,
  busy,
  run,
  canManage,
  onChanged,
}: {
  serverId: string;
  sheet: ServerSheet;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation("servers");
  const [name, setName] = useState(sheet.name);
  const [cells, setCells] = useState<string[]>(sheet.cells);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Reset local state when the underlying row changes (our save came back
  // through the refresh, or another mod edited the same sheet).
  useEffect(() => {
    setName(sheet.name);
    setCells(sheet.cells);
  }, [sheet.name, sheet.cells, sheet.imageUrl]);

  function setCell(i: number, v: string) {
    setCells((prev) => prev.map((c, ix) => (ix === i ? v : c)));
  }

  function save(extra?: { imageDataUrl?: string }) {
    void run(async () => {
      const body: Record<string, unknown> = {};
      if (name.trim() !== sheet.name) body.name = name.trim();
      if (JSON.stringify(cells) !== JSON.stringify(sheet.cells)) body.cells = cells;
      if (extra?.imageDataUrl) body.imageDataUrl = extra.imageDataUrl;
      if (Object.keys(body).length === 0) return;
      await apiUpdateSheet(serverId, sheet.id, body);
      onChanged();
    });
  }

  function replaceImage(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") save({ imageDataUrl: result });
    };
    reader.readAsDataURL(f);
    // Clear so re-selecting the same file fires onChange again.
    e.target.value = "";
  }

  function del() {
    if (!window.confirm(
      t("emoticonsTab.deleteSheetConfirm", { name: sheet.name, slug: sheet.slug }),
    )) return;
    void run(async () => {
      await apiDeleteSheet(serverId, sheet.id);
      onChanged();
    });
  }

  return (
    <div className="rounded border border-keep-rule bg-keep-panel/30 p-3 space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <img
          src={sheet.imageUrl}
          alt=""
          className="h-12 w-12 shrink-0 rounded border border-keep-rule object-cover"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canManage}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm font-action disabled:opacity-60"
            maxLength={80}
          />
          <p className="mt-0.5 truncate text-[10px] font-mono text-keep-muted">
            {t("emoticonsTab.slugLine", { slug: sheet.slug })}
          </p>
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-1">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={replaceImage}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text disabled:opacity-50"
            >
              {t("emoticonsTab.replaceImage")}
            </button>
            <button
              type="button"
              onClick={() => save()}
              disabled={busy}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
            >
              {busy ? t("shared.saving") : t("shared.save")}
            </button>
            <button
              type="button"
              onClick={del}
              disabled={busy}
              className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2 py-1 text-[11px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
            >
              {t("shared.delete")}
            </button>
          </div>
        ) : null}
      </header>
      <CellLabelEditor cells={cells} onChange={setCell} disabled={!canManage} />
    </div>
  );
}

/* ============================================================
 * 4×4 label grid — shared by create + edit forms.
 * ============================================================ */
function CellLabelEditor({
  cells,
  onChange,
  disabled,
}: {
  cells: string[];
  onChange: (i: number, v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("servers");
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">
        {t("emoticonsTab.cellLabelsHint")}
      </p>
      <div className="grid grid-cols-4 gap-1">
        {cells.map((label, i) => {
          const hidden = isEmoticonCellEmpty(label);
          return (
            <div
              key={i}
              className={`flex items-center gap-1 rounded border p-1 ${
                hidden ? "border-keep-rule/40 bg-keep-panel/20 opacity-60" : "border-keep-rule bg-keep-bg"
              }`}
            >
              <span className="inline-block h-7 w-7 shrink-0 rounded border border-dashed border-keep-rule/40 text-center text-[9px] leading-7 text-keep-muted">
                {i + 1}
              </span>
              <input
                value={label}
                onChange={(e) => onChange(i, e.target.value)}
                disabled={disabled}
                placeholder={t("emoticonsTab.labelPlaceholder")}
                maxLength={40}
                className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-1 py-0.5 text-xs disabled:opacity-60"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
 * Submission moderation queue — Approve / Reject pending rows.
 * ============================================================ */
function SubmissionsQueue({
  serverId,
  busy,
  run,
  onSettled,
}: {
  serverId: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSettled: () => void;
}) {
  const { t } = useTranslation("servers");
  const [rows, setRows] = useState<ServerSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await apiListSubmissions(serverId);
      setRows(r.submissions);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("emoticonsTab.loadSubmissionsError"));
    } finally {
      setLoading(false);
    }
  }, [serverId, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  function approve(row: ServerSubmission) {
    void run(async () => {
      await apiApproveSubmission(serverId, row.id);
      await refresh();
      // The approved sheet now lives in the catalog list — refresh it too.
      onSettled();
    });
  }

  function reject(row: ServerSubmission) {
    const reason = window.prompt(
      t("emoticonsTab.rejectPrompt", { name: row.name, submitter: row.submitterLabel }),
      "",
    );
    // null = cancel; empty string = reject without a reason.
    if (reason === null) return;
    void run(async () => {
      const res = await apiRejectSubmission(serverId, row.id, reason.trim() || null);
      await refresh();
      onSettled();
      // eslint-disable-next-line no-alert
      window.alert(t("emoticonsTab.rejectedAlert", { amount: res.refundedAmount }));
    });
  }

  const pending = rows.filter((r) => r.status === "pending");
  const recent = rows.filter((r) => r.status !== "pending").slice(0, 10);

  return (
    <section className="space-y-3 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-action text-base">{t("emoticonsTab.submissionsHeading")}</h3>
          <p className="text-xs text-keep-muted">
            {t("emoticonsTab.submissionsBlurb")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner"
        >
          {t("emoticonsTab.refresh")}
        </button>
      </header>
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
          {err}
        </div>
      ) : null}
      {loading ? (
        <p className="text-xs text-keep-muted">{t("shared.loading")}</p>
      ) : (
        <>
          <div className="text-[10px] uppercase tracking-widest text-keep-muted">
            {t("emoticonsTab.pendingHeading", { n: pending.length })}
          </div>
          {pending.length === 0 ? (
            <p className="text-xs italic text-keep-muted">{t("emoticonsTab.noneWaiting")}</p>
          ) : (
            <ul className="space-y-2">
              {pending.map((r) => (
                <SubmissionRow
                  key={r.id}
                  row={r}
                  busy={busy}
                  onApprove={() => approve(r)}
                  onReject={() => reject(r)}
                />
              ))}
            </ul>
          )}
          {recent.length > 0 ? (
            <>
              <div className="mt-3 text-[10px] uppercase tracking-widest text-keep-muted">
                {t("emoticonsTab.recentlyReviewed")}
              </div>
              <ul className="space-y-2">
                {recent.map((r) => (
                  <SubmissionRow key={r.id} row={r} busy={false} />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function SubmissionRow({
  row,
  busy,
  onApprove,
  onReject,
}: {
  row: ServerSubmission;
  busy: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const { t } = useTranslation("servers");
  return (
    <li className="flex flex-wrap items-center gap-2 rounded border border-keep-rule p-2 text-xs">
      {row.status !== "rejected" ? (
        <img
          src={row.imageUrl}
          alt=""
          className="h-12 w-12 shrink-0 rounded border border-keep-rule object-cover"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-keep-rule bg-keep-banner/40 text-[10px] uppercase text-keep-muted">
          {t("emoticonsTab.rejectedChip")}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="font-semibold">
          {row.name} <span className="text-keep-muted">· {row.slug}</span>
        </div>
        <div className="text-[10px] text-keep-muted">
          {t("emoticonsTab.byLine", { name: row.submitterLabel })}{row.costPaid != null ? t("emoticonsTab.costCurrency", { n: row.costPaid }) : t("emoticonsTab.noCost")}
          {row.status !== "pending" ? ` · ${row.status}` : ""}
        </div>
        {row.rejectionReason ? (
          <div className="text-[10px] italic text-keep-accent">
            {t("emoticonsTab.reasonLine", { reason: row.rejectionReason })}
          </div>
        ) : null}
      </div>
      {onApprove && onReject ? (
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
          >
            {t("emoticonsTab.approve")}
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
          >
            {t("emoticonsTab.reject")}
          </button>
        </div>
      ) : null}
    </li>
  );
}
