import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../cosmetics/Modal.js";

/**
 * Shared ban modal — one consistent ban experience across the three places a
 * staff member can ban someone: a profile, the Global Admin user editor, and a
 * Server Admin's bans tab. Each caller wires `onConfirm` to its own endpoint;
 * the modal only collects the inputs (duration, reason, optional post sweep).
 *
 * `purge` is the opt-in "remove their recent posts" window — a lookback in ms,
 * `"all"` for everything, or `null` to leave posts alone (the default). The
 * server soft-hides the matched posts (tombstoned, kept for admin audit), it
 * never hard-deletes them.
 */
export type PurgeChoice = number | "all" | null;

export interface BanDuration {
  /** `moderation`-namespace catalog key for the preset's button label. */
  labelKey: string;
  /** Ban length in ms; `null` = permanent. */
  ms: number | null;
}

/** Default ban-length presets, shared so every ban surface offers the same set. */
export const BAN_DURATIONS: ReadonlyArray<BanDuration> = [
  { labelKey: "banModal.durations.day1", ms: 1 * 24 * 60 * 60 * 1000 },
  { labelKey: "banModal.durations.days3", ms: 3 * 24 * 60 * 60 * 1000 },
  { labelKey: "banModal.durations.days7", ms: 7 * 24 * 60 * 60 * 1000 },
  { labelKey: "banModal.durations.days30", ms: 30 * 24 * 60 * 60 * 1000 },
  { labelKey: "banModal.durations.permanent", ms: null },
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * "Remove their recent posts" windows. Index 0 (`null`) is the default —
 * banning a regular offender leaves their history intact; the later options
 * are for clearing a spammer. Range runs 1 hour … 7 days, plus All time.
 */
const PURGE_WINDOWS: ReadonlyArray<{ labelKey: string; value: PurgeChoice }> = [
  { labelKey: "banModal.durations.dontRemove", value: null },
  { labelKey: "banModal.durations.hour1", value: 1 * HOUR },
  { labelKey: "banModal.durations.hours6", value: 6 * HOUR },
  { labelKey: "banModal.durations.hours24", value: 24 * HOUR },
  { labelKey: "banModal.durations.days3", value: 3 * DAY },
  { labelKey: "banModal.durations.days7", value: 7 * DAY },
  { labelKey: "banModal.durations.allTime", value: "all" },
];

export function BanModal({
  targetName,
  description,
  reasonRequired = true,
  reasonPlaceholder,
  reasonMaxLength = 1000,
  showPurge = true,
  purgeScopeLabel,
  confirmLabel,
  busyLabel,
  onConfirm,
  onClose,
}: {
  targetName: string;
  description?: string;
  /** Account bans require a reason; server bans make it optional. */
  reasonRequired?: boolean;
  reasonPlaceholder?: string;
  reasonMaxLength?: number;
  /** Whether to offer the "remove recent posts" sweep (default on). */
  showPurge?: boolean;
  /** Noun for the post sweep, e.g. "posts" or "posts here". */
  purgeScopeLabel?: string;
  confirmLabel?: string;
  busyLabel?: string;
  onConfirm: (durationMs: number | null, reason: string, purge: PurgeChoice) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation("moderation");
  const [durIdx, setDurIdx] = useState(0);
  const [reason, setReason] = useState("");
  const [purgeIdx, setPurgeIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const trimmed = reason.trim();
  const reasonOk = reasonRequired ? trimmed.length > 0 : true;
  // Localized defaults for the caller-overridable copy slots.
  const scopeLabel = purgeScopeLabel ?? t("banModal.purgeScopePosts");

  async function confirm() {
    if (submitting || !reasonOk) return;
    setSubmitting(true);
    try {
      await onConfirm(
        BAN_DURATIONS[durIdx]!.ms,
        trimmed,
        showPurge ? PURGE_WINDOWS[purgeIdx]!.value : null,
      );
    } catch { /* parent surfaces the error + keeps dialog open */ }
    finally { setSubmitting(false); }
  }

  return (
    <Modal onClose={onClose} variant="centered" zIndex={70}>
      <div
        className="w-[min(440px,94vw)] rounded-lg border border-keep-rule bg-keep-bg p-4 text-keep-text shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-base font-semibold">{t("banModal.title", { name: targetName })}</h3>
        <p className="mb-3 text-xs text-keep-muted">
          {description ?? t("banModal.description")}
        </p>

        <div className="mb-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">{t("banModal.duration")}</div>
          <div className="flex flex-wrap gap-1.5">
            {BAN_DURATIONS.map((d, i) => (
              <button
                key={d.labelKey}
                type="button"
                onClick={() => setDurIdx(i)}
                aria-pressed={durIdx === i}
                className={`rounded border px-2.5 py-1 text-xs font-semibold transition-colors ${
                  durIdx === i
                    ? "border-keep-action bg-keep-action text-keep-bg"
                    : "border-keep-rule bg-keep-panel text-keep-text hover:bg-keep-banner"
                }`}
              >
                {t(d.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-keep-muted">
            {t("banModal.reason")}{" "}
            {reasonRequired
              ? <span className="text-[#e06070]">{t("banModal.reasonRequired")}</span>
              : <span className="text-keep-muted/70">{t("banModal.reasonOptional")}</span>}
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={reasonMaxLength}
            placeholder={reasonPlaceholder ?? t("banModal.reasonPlaceholder")}
            className="w-full resize-none rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
          />
        </label>

        {showPurge ? (
          <div className="mb-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">
              {t("banModal.removeRecent", { scope: scopeLabel })}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PURGE_WINDOWS.map((p, i) => (
                <button
                  key={p.labelKey}
                  type="button"
                  onClick={() => setPurgeIdx(i)}
                  aria-pressed={purgeIdx === i}
                  className={`rounded border px-2.5 py-1 text-xs font-semibold transition-colors ${
                    purgeIdx === i
                      ? i === 0
                        ? "border-keep-action bg-keep-action text-keep-bg"
                        : "border-[#e06070] bg-[#e06070] text-white"
                      : "border-keep-rule bg-keep-panel text-keep-text hover:bg-keep-banner"
                  }`}
                >
                  {t(p.labelKey)}
                </button>
              ))}
            </div>
            {purgeIdx > 0 ? (
              <p className="mt-1 text-[10px] text-keep-muted">
                {t("banModal.purgeNote", { scope: scopeLabel })}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-keep-rule bg-keep-panel px-3 py-1.5 text-xs text-keep-text hover:bg-keep-banner"
          >
            {t("common:cancel")}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={submitting || !reasonOk}
            className="rounded border border-[#e06070]/80 bg-[#e06070] px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting
              ? busyLabel ?? t("banModal.banning")
              : confirmLabel ?? t("banModal.confirmBan")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
