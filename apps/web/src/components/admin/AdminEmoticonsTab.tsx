import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { EmoticonSheet } from "@thekeep/shared";
import { EMOTICON_SHEET_CELL_COUNT, isEmoticonCellEmpty } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { fetchEmoticonCatalog, useEmoticons } from "../../state/emoticons.js";
import { EmoticonSprite } from "../emoticons/EmoticonSprite.js";
import {
  approveEmoticonSubmission,
  fetchAdminEmoticonSubmissions,
  rejectEmoticonSubmission,
  type AdminEmoticonSubmission,
} from "../../lib/emoticonSubmissions.js";

/**
 * Admin: emoticon sheet management.
 *
 * Lets master/site admins upload new sticker sheets, edit per-cell
 * labels (or mark cells empty to hide them from the picker), replace
 * sheet images in-place, and delete sheets. Deletion cascades to
 * every reaction placed with the sheet, there's a confirm prompt
 * since that's user-visible content vanishing.
 *
 * Storage posture: image goes up as a base64 data URL (matches the
 * existing /admin/upload/logo route), server writes it under
 * /uploads/emoticons/<id>-<hash>.<ext>. Re-upload of identical bytes
 * is a no-op; a different image necessarily produces a new content
 * hash → new URL → busts any picker cache.
 */
export function AdminEmoticonsTab() {
  const sheets = useEmoticons((s) => s.sheets);
  const [creatingOpen, setCreatingOpen] = useState(false);

  // Catalog can be stale on first mount if the boot prefetch hasn't
  // landed yet. Refresh on open so the editor always reflects current
  // server state.
  useEffect(() => {
    void fetchEmoticonCatalog();
  }, []);

  return (
    <div className="space-y-4">
      {/* Moderation queue ABOVE the sheet management, it's the
          time-sensitive surface (users are waiting on review) and
          should be the first thing an admin sees on opening the tab. */}
      <SubmissionsQueue />

      <header className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-action text-base">Emoticon sheets</h3>
          <p className="text-xs text-keep-muted">
            Each sheet is a 4×4 grid. The bottom row is reserved for future cells, leave any label blank or "empty" to hide a cell from the picker.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreatingOpen((v) => !v)}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg"
        >
          {creatingOpen ? "Cancel" : "+ New sheet"}
        </button>
      </header>

      {creatingOpen ? (
        <CreateSheetForm
          onCreated={() => {
            setCreatingOpen(false);
            void fetchEmoticonCatalog();
          }}
        />
      ) : null}

      {sheets.length === 0 ? (
        <p className="rounded border border-keep-rule bg-keep-panel/30 p-3 text-xs italic text-keep-muted">
          No emoticon sheets installed yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {sheets.map((s) => (
            <li key={s.id}>
              <SheetEditor sheet={s} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* =============================================================
 *  Create form, slug + name + cells + image upload
 * ============================================================= */
function CreateSheetForm({ onCreated }: { onCreated: () => void }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [cells, setCells] = useState<string[]>(() => new Array(EMOTICON_SHEET_CELL_COUNT).fill(""));
  const [imageDataUrl, setImageDataUrl] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function setCell(i: number, v: string) {
    setCells((prev) => prev.map((c, ix) => (ix === i ? v : c)));
  }

  async function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") setImageDataUrl(result);
    };
    reader.readAsDataURL(f);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      if (!imageDataUrl) throw new Error("upload a sheet image first");
      const r = await fetch("/admin/emoticons/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: slug.trim().toLowerCase(), name: name.trim(), cells, imageDataUrl }),
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-keep-action/40 bg-keep-panel/30 p-3 space-y-3">
      <h4 className="font-action text-sm">New emoticon sheet</h4>
      {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <label className="block text-xs">
          <span className="block uppercase tracking-widest text-keep-muted">Slug</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="e.g. orc-default"
            className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs"
            maxLength={40}
          />
        </label>
        <label className="block text-xs">
          <span className="block uppercase tracking-widest text-keep-muted">Display name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Orc"
            className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
            maxLength={80}
          />
        </label>
      </div>
      <div>
        <label className="block text-xs">
          <span className="block uppercase tracking-widest text-keep-muted">Sheet image (PNG / JPG / WebP / GIF, 4×4 grid)</span>
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
            alt="preview"
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
          {busy ? "Creating..." : "Create sheet"}
        </button>
      </div>
    </div>
  );
}

/* =============================================================
 *  Per-sheet editor, labels, replace image, delete
 * ============================================================= */
function SheetEditor({ sheet }: { sheet: EmoticonSheet }) {
  const [name, setName] = useState(sheet.name);
  const [cells, setCells] = useState<string[]>(sheet.cells);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Reset local state when the underlying row changes (admin elsewhere
  // edited the same sheet, or our own save came back through the
  // emoticons:updated refetch).
  useEffect(() => {
    setName(sheet.name);
    setCells(sheet.cells);
  }, [sheet.name, sheet.cells, sheet.imageUrl]);

  function setCell(i: number, v: string) {
    setCells((prev) => prev.map((c, ix) => (ix === i ? v : c)));
  }

  async function save(extra?: { imageDataUrl?: string }) {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (name !== sheet.name) body.name = name.trim();
      if (JSON.stringify(cells) !== JSON.stringify(sheet.cells)) body.cells = cells;
      if (extra?.imageDataUrl) body.imageDataUrl = extra.imageDataUrl;
      if (Object.keys(body).length === 0) { setBusy(false); return; }
      const r = await fetch(`/admin/emoticons/sheets/${sheet.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      await fetchEmoticonCatalog();
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function replaceImage(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") void save({ imageDataUrl: result });
    };
    reader.readAsDataURL(f);
    // Clear the input so a re-select of the same file fires onChange.
    e.target.value = "";
  }

  async function del() {
    if (!window.confirm(
      `Delete "${sheet.name}" (${sheet.slug})? Every reaction placed with this sheet on any chat message, DM, or forum post will also be removed. Cannot be undone.`,
    )) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/admin/emoticons/sheets/${sheet.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      await fetchEmoticonCatalog();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-keep-rule bg-keep-panel/30 p-3 space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm font-action"
            maxLength={80}
          />
          <p className="mt-0.5 truncate text-[10px] font-mono text-keep-muted">
            slug: {sheet.slug} · image: {sheet.imageUrl}
          </p>
        </div>
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
            Replace image
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
          >
            {busy ? "Saving..." : savedFlash ? "Saved" : "Save"}
          </button>
          <button
            type="button"
            onClick={del}
            disabled={busy}
            className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2 py-1 text-[11px] uppercase tracking-widest text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </header>
      {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
      <CellLabelEditor
        cells={cells}
        onChange={setCell}
        sheetSlug={sheet.slug}
      />
    </div>
  );
}

/* =============================================================
 *  4×4 label grid, used by both create + edit forms
 * ============================================================= */
function CellLabelEditor({
  cells,
  onChange,
  sheetSlug,
}: {
  cells: string[];
  onChange: (i: number, v: string) => void;
  /** When present, renders the live sprite preview beside each cell so
   *  admins can verify the label matches the image. Omit during the
   *  create flow, the sheet doesn't exist in the catalog yet. */
  sheetSlug?: string;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">
        Cell labels (4×4, row-major). Empty or "empty" = hidden from picker.
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
              {sheetSlug ? (
                <EmoticonSprite sheetSlug={sheetSlug} cellIndex={i} size={28} />
              ) : (
                <span className="inline-block h-7 w-7 shrink-0 rounded border border-dashed border-keep-rule/40 text-[9px] leading-7 text-center text-keep-muted">
                  {i + 1}
                </span>
              )}
              <input
                value={label}
                onChange={(e) => onChange(i, e.target.value)}
                placeholder="label"
                maxLength={40}
                className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-1 py-0.5 text-xs"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =============================================================
 *  Submissions moderation queue (Phase 3)
 *
 *  Shows the most recent user submissions of any status, with
 *  Approve and Reject actions on pending rows. Approve flips the
 *  sheet live in the picker. Reject prompts for a reason, then
 *  refunds the paid Currency to the submitter's pool and deletes
 *  the asset file.
 * ============================================================= */
function SubmissionsQueue() {
  const [rows, setRows] = useState<AdminEmoticonSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchAdminEmoticonSubmissions();
      setRows(r.submissions);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load submissions");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function approve(id: string) {
    setBusyId(id);
    setErr(null);
    try {
      await approveEmoticonSubmission(id);
      await refresh();
      // Bust the local picker catalog so the newly-approved sheet
      // appears in the user-facing picker immediately for this
      // admin's tab too (other clients receive `emoticons:updated`
      // via socket and re-fetch).
      await fetchEmoticonCatalog();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(row: AdminEmoticonSubmission) {
    const reason = window.prompt(
      `Reject "${row.name}" from ${row.submitterLabel}?\n\nOptional reason (shown to the submitter):`,
      "",
    );
    // null = cancel; empty string = reject without a reason
    if (reason === null) return;
    setBusyId(row.id);
    setErr(null);
    try {
      const r = await rejectEmoticonSubmission(row.id, reason.trim() || null);
      await refresh();
      // Quick toast so the admin sees the refund landed.
      // eslint-disable-next-line no-alert
      window.alert(`Rejected. Refunded ${r.refundedAmount} Currency to the submitter.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setBusyId(null);
    }
  }

  const pending = rows.filter((r) => r.status === "pending");
  const recent = rows.filter((r) => r.status !== "pending").slice(0, 10);

  return (
    <section className="space-y-3 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-action text-base">User submissions</h3>
          <p className="text-xs text-keep-muted">
            Reject refunds the paid Currency and deletes the image. Approve makes the sheet live for everyone.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner"
        >
          Refresh
        </button>
      </header>
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
          {err}
        </div>
      ) : null}
      {loading ? (
        <p className="text-xs text-keep-muted">Loading…</p>
      ) : (
        <>
          <div className="text-[10px] uppercase tracking-widest text-keep-muted">
            Pending ({pending.length})
          </div>
          {pending.length === 0 ? (
            <p className="text-xs italic text-keep-muted">Nothing waiting for review.</p>
          ) : (
            <ul className="space-y-2">
              {pending.map((r) => (
                <SubmissionRow
                  key={r.id}
                  row={r}
                  busy={busyId === r.id}
                  onApprove={() => void approve(r.id)}
                  onReject={() => void reject(r)}
                />
              ))}
            </ul>
          )}
          {recent.length > 0 ? (
            <>
              <div className="mt-3 text-[10px] uppercase tracking-widest text-keep-muted">
                Recently reviewed
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
  row: AdminEmoticonSubmission;
  busy: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded border border-keep-rule p-2 text-xs">
      {row.status !== "rejected" ? (
        <img
          src={row.imageUrl}
          alt=""
          className="h-12 w-12 shrink-0 rounded border border-keep-rule object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-keep-rule bg-keep-banner/40 text-[10px] uppercase text-keep-muted">
          Rejected
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="font-semibold">
          {row.name} <span className="text-keep-muted">· {row.slug}</span>
        </div>
        <div className="text-[10px] text-keep-muted">
          By {row.submitterLabel} · {row.costPaid != null ? `${row.costPaid} Currency` : "no cost recorded"}
          {row.status !== "pending" ? ` · ${row.status}` : ""}
        </div>
        {row.rejectionReason ? (
          <div className="text-[10px] italic text-keep-accent">
            Reason: {row.rejectionReason}
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
            Approve
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      ) : null}
    </li>
  );
}
