/**
 * Phase 3, user-facing reaction sheet submission modal.
 *
 * Opens from the Flair tab's "Custom Reaction Sheet" card. Two
 * sections, top-down:
 *
 *   1. Submit a new sheet, slug + name + 16 cell labels + image
 *      upload (PNG/JPEG/WebP/GIF). Cost shown live; insufficient-
 *      funds disables the submit button.
 *   2. My uploads, history list with status per row. Rejected rows
 *      surface the moderator's reason and confirm the refund.
 *
 * Per-identity scope follows the rest of the Flair tab, the
 * active character pays from its own pool, master pays from its
 * own. Switching identities (via /char in chat, or the per-tab
 * character switcher) re-targets the form.
 */

import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { COMMUNITY_EMOTICON_USE_COST, slugRx } from "@thekeep/shared";
import { Modal, MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";
import { CoinAmount } from "../earning/CoinAmount.js";
import {
  submitEmoticonSheet,
  fetchMyEmoticonSubmissions,
  setEmoticonCommerce,
  type MyEmoticonSubmission,
} from "../../lib/emoticonSubmissions.js";
import { useChat } from "../../state/store.js";

/** 4×4 grid, same constant the server validates against. */
const CELL_COUNT = 16;
const SLUG_RX = slugRx(42);

/** Default labels mirroring the seeded basic / male / female sheets
 *  (see server `DEFAULT_EMOTICON_CELLS`). Most custom uploads follow
 *  the same reaction set + ordering, pre-filling spares the author
 *  from retyping the common mood vocabulary. They can edit any cell
 *  or blank it out if their sheet diverges; trailing four are empty
 *  because the stock sheets only populate the first 12 cells. */
const DEFAULT_CELLS: readonly string[] = [
  "happy", "laughing", "angry", "sad",
  "crying", "surprised", "embarrassed", "smug",
  "sleepy", "lovestruck", "confused", "determined",
  "", "", "", "",
];

interface Props {
  onClose: () => void;
  /** Current cost of the `flair_reaction_sheet` cosmetic, fetched
   *  by the caller (the Flair tab already has the catalog loaded).
   *  Server re-validates on submit so a stale price here just shows
   *  a brief "insufficient funds" message; not a security issue. */
  costAtSubmission: number;
  /** Active identity's wallet balance, used to gate the submit
   *  button on the client. Server enforces the real check. */
  activeWallet: number;
  /** Caller refreshes their earning snapshot after a successful
   *  submission so the wallet display in the dashboard updates. */
  onRefreshEarning: () => void;
}

export function EmoticonSubmissionModal({
  onClose,
  costAtSubmission,
  activeWallet,
  onRefreshEarning,
}: Props) {
  const { t } = useTranslation("arcade");
  const activeCharacterId = useChat((s) => s.activeCharacterId);

  // Form state
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [cells, setCells] = useState<string[]>(() => [...DEFAULT_CELLS]);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imagePreviewWarning, setImagePreviewWarning] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // History state
  const [history, setHistory] = useState<MyEmoticonSubmission[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  async function refreshHistory() {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const r = await fetchMyEmoticonSubmissions();
      setHistory(r.submissions);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : t("emoticons.submission.history.loadFailed"));
    } finally {
      setHistoryLoading(false);
    }
  }
  useEffect(() => { void refreshHistory(); }, []);

  function onFileChosen(file: File) {
    setFormError(null);
    setImagePreviewWarning(null);
    // APNG files report as `image/png` from most browsers (the
    // animation track piggybacks on the PNG container), but Safari
    // reports them as `image/apng`. Accept both so animated PNG
    // uploads don't bounce off the type check on Safari.
    if (!/^image\/(png|apng|jpeg|webp|gif)$/.test(file.type)) {
      setImagePreviewWarning(t("emoticons.submission.form.unsupportedType"));
      return;
    }
    // 6 MB soft cap on the client. The server's hard cap (8MB base64,
    // ~6MB actual bytes) will reject anything bigger anyway, but
    // surfacing it here saves the round-trip.
    if (file.size > 6 * 1024 * 1024) {
      setImagePreviewWarning(t("emoticons.submission.form.tooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      setImageDataUrl(result);
    };
    reader.onerror = () => setImagePreviewWarning(t("emoticons.submission.form.readFailed"));
    reader.readAsDataURL(file);
  }

  // Form validation, rendered next to the submit button so the
  // user sees exactly what's missing.
  const slugValid = SLUG_RX.test(slug);
  const labeledCellCount = cells.filter((c) => c.trim().length > 0).length;
  const canSubmit =
    !!imageDataUrl &&
    slugValid &&
    name.trim().length > 0 &&
    labeledCellCount > 0 &&
    activeWallet >= costAtSubmission &&
    !submitting;

  async function submit() {
    if (!canSubmit || !imageDataUrl) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await submitEmoticonSheet({
        slug,
        name: name.trim(),
        // Normalize cells to exactly CELL_COUNT entries; pad with
        // empty strings so a sparse fill is OK. Server validates
        // the array length on its side.
        cells: cells.slice(0, CELL_COUNT).concat(Array<string>(CELL_COUNT - cells.length).fill("")),
        imageDataUrl,
        characterId: activeCharacterId,
      });
      // Reset the form on success; history refreshes to show the
      // new pending row.
      setSlug("");
      setName("");
      setCells([...DEFAULT_CELLS]);
      setImageDataUrl(null);
      onRefreshEarning();
      await refreshHistory();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t("emoticons.submission.form.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // EarningDashboard renders at zIndex=50, without a bump here the
    // nested submission modal lands at the default zIndex=40 and gets
    // hidden behind the dashboard's `bg-black/40` backdrop, which is
    // what users saw as "a weird transparent dark overlay" when they
    // clicked Submit. zIndex=60 puts this above the dashboard shell.
    <Modal onClose={onClose} zIndex={60}>
      {/* `stopPropagation` so clicking inside the card doesn't bubble
          up to the backdrop's onClose. */}
      <div onClick={(e) => e.stopPropagation()} className={`${MODAL_CARD_CONTENT} bg-keep-bg`}>
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule px-4 py-3">
          <h2 className="font-action text-lg uppercase tracking-widest text-keep-text">
            {t("emoticons.submission.title")}
          </h2>
          <CloseButton onClick={onClose} />
        </header>

        {/* `min-h-0 flex-1 overflow-y-auto` so the body scrolls within
            the fixed-height modal card. Without min-h-0 the body
            would expand to its natural height and get clipped by the
            parent's overflow-hidden, hiding the submit button below
            the fold. */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
          {/* ---------- Helper assets ---------- */}
          <section className="space-y-2 rounded border border-keep-action/30 bg-keep-action/5 p-3">
            <h3 className="font-action text-sm uppercase tracking-widest text-keep-action">
              {t("emoticons.submission.build.header")}
            </h3>
            <p className="text-xs text-keep-muted">
              <Trans t={t} i18nKey="emoticons.submission.build.spec">
                Sheets are <strong className="text-keep-text">4x4 grid, square cells</strong>, submitted at <strong className="text-keep-text">600x600px</strong> (so each cell is 150x150px) as <strong className="text-keep-text">PNG, WebP, or APNG with a transparent background</strong> so reactions composite cleanly over any chat theme. JPEG / GIF also accepted but transparency is lost.
              </Trans>
            </p>
            <p className="text-xs text-keep-muted">
              <Trans t={t} i18nKey="emoticons.submission.build.animated">
                <strong className="text-keep-text">WebP and APNG can be animated</strong>. Looping idle frames, blinks, shimmer, etc. all carry through to the picker. You can work at a larger canvas while drawing for clarity, but downscale to 600x600px before submitting so file size stays reasonable.
              </Trans>
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <a
                href="/assets/emoticons/basic_male_emoticon_sheet.png"
                download
                className="inline-flex items-center gap-1.5 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs text-keep-text hover:bg-keep-banner"
              >
                <span aria-hidden>📥</span>
                <span>{t("emoticons.submission.build.demoSheet")}</span>
              </a>
              <a
                href="/assets/emoticons/alignment_aid_grid.png"
                download
                className="inline-flex items-center gap-1.5 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs text-keep-text hover:bg-keep-banner"
              >
                <span aria-hidden>📐</span>
                <span>{t("emoticons.submission.build.alignmentGrid")}</span>
              </a>
            </div>
            <p className="text-[10px] italic text-keep-muted">
              {t("emoticons.submission.build.gridNote")}
            </p>
          </section>

          {/* ---------- Submission form ---------- */}
          <section className="space-y-3 rounded border border-keep-rule bg-keep-bg/40 p-3">
            <h3 className="font-action text-sm uppercase tracking-widest text-keep-muted">
              {t("emoticons.submission.form.header")}
            </h3>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div>
                {activeCharacterId ? (
                  <Trans t={t} i18nKey="emoticons.submission.form.paidFromCharacter">
                    Paid from <strong className="text-keep-text">this character</strong>: <CoinAmount amount={costAtSubmission} /> per submission
                  </Trans>
                ) : (
                  <Trans t={t} i18nKey="emoticons.submission.form.paidFromMaster">
                    Paid from <strong className="text-keep-text">your master pool</strong>: <CoinAmount amount={costAtSubmission} /> per submission
                  </Trans>
                )}
              </div>
              <div className="text-keep-muted">
                <Trans t={t} i18nKey="emoticons.submission.form.wallet">
                  Wallet: <CoinAmount amount={activeWallet} />
                </Trans>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <label className="text-xs">
                <span className="text-keep-muted">{t("emoticons.submission.form.slugLabel")}</span>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  placeholder={t("emoticons.submission.form.slugPlaceholder")}
                  className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
                />
                {slug && !slugValid ? (
                  <span className="text-[10px] text-keep-accent">
                    {t("emoticons.submission.form.slugError")}
                  </span>
                ) : null}
              </label>
              <label className="text-xs">
                <span className="text-keep-muted">{t("emoticons.submission.form.nameLabel")}</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
                />
              </label>
            </div>

            {/* Image upload + preview */}
            <label className="block text-xs">
              <span className="text-keep-muted">
                <Trans t={t} i18nKey="emoticons.submission.form.imageLabel">
                  Sheet image. 4x4 grid at <strong className="text-keep-text">600x600px</strong> (150px cells). <strong className="text-keep-text">Transparent PNG, WebP, or APNG recommended</strong> (WebP / APNG can be animated); JPEG / GIF accepted but lose transparency. ≤6 MB.
                </Trans>
              </span>
              <input
                type="file"
                accept="image/png,image/apng,image/jpeg,image/webp,image/gif"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFileChosen(f);
                }}
                className="mt-0.5 block w-full text-xs text-keep-muted file:mr-3 file:rounded file:border file:border-keep-rule file:bg-keep-bg file:px-2 file:py-1 file:text-xs file:text-keep-text"
              />
              {imagePreviewWarning ? (
                <span className="text-[10px] text-keep-accent">{imagePreviewWarning}</span>
              ) : null}
            </label>
            {imageDataUrl ? (
              <div className="overflow-hidden rounded border border-keep-rule bg-keep-banner/40">
                {/* Preview at the actual aspect ratio so the user sees
                    cell alignment before submitting. */}
                <img
                  src={imageDataUrl}
                  alt={t("emoticons.submission.form.previewAlt")}
                  className="block max-h-[256px] w-auto"
                />
              </div>
            ) : null}

            {/* 16 cell labels */}
            <details className="rounded border border-keep-rule bg-keep-bg/60 p-2 text-xs">
              <summary className="cursor-pointer font-semibold text-keep-text">
                {t("emoticons.submission.form.cellLabels", { filled: labeledCellCount, total: CELL_COUNT })}
              </summary>
              <p className="mb-2 mt-1 text-[10px] text-keep-muted">
                {t("emoticons.submission.form.cellLabelsNote")}
              </p>
              <div className="grid grid-cols-4 gap-1">
                {cells.map((c, i) => (
                  <input
                    key={i}
                    type="text"
                    value={c}
                    onChange={(e) => {
                      const next = [...cells];
                      next[i] = e.target.value;
                      setCells(next);
                    }}
                    placeholder={`#${i + 1}`}
                    maxLength={40}
                    className="rounded border border-keep-rule bg-keep-bg px-1 py-0.5 text-[10px]"
                  />
                ))}
              </div>
            </details>

            {formError ? (
              <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
                {formError}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-[10px] text-keep-muted">
                {t("emoticons.submission.form.reviewNote")}
              </span>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                title={
                  !imageDataUrl ? t("emoticons.submission.form.chooseImage")
                  : !slugValid ? t("emoticons.submission.form.fixSlug")
                  : name.trim().length === 0 ? t("emoticons.submission.form.addName")
                  : labeledCellCount === 0 ? t("emoticons.submission.form.labelOneCell")
                  : activeWallet < costAtSubmission ? t("emoticons.submission.form.notEnoughCurrency")
                  : t("emoticons.submission.form.submit")
                }
                className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
              >
                {submitting ? t("emoticons.submission.form.submitting") : t("emoticons.submission.form.submit")}
              </button>
            </div>
          </section>

          {/* ---------- My uploads history ---------- */}
          <section className="space-y-2">
            <h3 className="font-action text-sm uppercase tracking-widest text-keep-muted">
              {t("emoticons.submission.history.header")}
            </h3>
            {historyError ? (
              <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
                {historyError}
              </div>
            ) : null}
            {historyLoading ? (
              <p className="text-xs text-keep-muted">{t("common:loading")}</p>
            ) : history.length === 0 ? (
              <p className="text-xs text-keep-muted">{t("emoticons.submission.history.empty")}</p>
            ) : (
              <ul className="space-y-1">
                {history.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center gap-2 rounded border border-keep-rule p-2 text-xs"
                  >
                    {/* Only render the asset image for approved + pending.
                        Rejected rows have had their file deleted, so a
                        broken image would render. */}
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
                        {t("emoticons.submission.history.statusRejected")}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">
                        {row.name} <span className="text-keep-muted">· {row.slug}</span>
                      </div>
                      <div className="text-[10px] text-keep-muted">
                        {statusLabel(row, t)}
                      </div>
                      {row.rejectionReason ? (
                        <div className="text-[10px] italic text-keep-accent">
                          {t("emoticons.submission.history.reason", { reason: row.rejectionReason })}
                        </div>
                      ) : null}
                      {/* Commerce toggle + usage tally, only meaningful
                          on approved rows (the live picker is the only
                          place commerce_enabled is consulted). Pending
                          and rejected rows still carry the flag but
                          surfacing the control there would be misleading. */}
                      {row.status === "approved" ? (
                        <ApprovedRowControls
                          row={row}
                          onChanged={refreshHistory}
                        />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Per-approved-row controls: lifetime usage tally + commerce toggle.
 * Local optimistic state keeps the toggle snappy; we only re-fetch
 * the parent's list after a successful save so the row's costPaid /
 * status etc. stay in sync.
 */
function ApprovedRowControls({
  row,
  onChanged,
}: {
  row: MyEmoticonSubmission;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation("arcade");
  const [enabled, setEnabled] = useState(row.commerceEnabled);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setEnabled(row.commerceEnabled); }, [row.commerceEnabled]);
  async function flip(next: boolean) {
    if (saving || enabled === next) return;
    setSaving(true);
    setErr(null);
    // Optimistic flip, the picker shows the new state immediately;
    // a failure rolls it back.
    setEnabled(next);
    try {
      const r = await setEmoticonCommerce(row.id, next);
      setEnabled(r.commerceEnabled);
      await onChanged();
    } catch (e) {
      setEnabled(!next);
      setErr(e instanceof Error ? e.message : t("emoticons.submission.history.saveFailed"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px]">
      <span className="text-keep-muted">
        {t("emoticons.submission.history.useCount", { count: row.useCount })}
      </span>
      <span aria-hidden className="text-keep-muted/70">·</span>
      <label className="inline-flex cursor-pointer items-center gap-1 text-keep-muted">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void flip(e.target.checked)}
          disabled={saving}
          className="h-3 w-3 accent-keep-action"
        />
        <span>
          {t("emoticons.submission.history.chargeToggle", { cost: COMMUNITY_EMOTICON_USE_COST })}
        </span>
      </label>
      {err ? (
        <span className="text-keep-accent">· {err}</span>
      ) : null}
    </div>
  );
}

function statusLabel(row: MyEmoticonSubmission, t: TFunction): string {
  switch (row.status) {
    case "pending":
      return t("emoticons.submission.history.statusPending");
    case "approved":
      return t("emoticons.submission.history.statusApproved");
    case "rejected":
      return row.costPaid != null
        ? t("emoticons.submission.history.statusRejectedRefunded", { amount: row.costPaid })
        : t("emoticons.submission.history.statusRejected");
    default:
      return row.status;
  }
}
