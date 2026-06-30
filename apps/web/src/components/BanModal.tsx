import { useState } from "react";
import { Modal } from "./Modal.js";

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
  label: string;
  /** Ban length in ms; `null` = permanent. */
  ms: number | null;
}

/** Default ban-length presets, shared so every ban surface offers the same set. */
export const BAN_DURATIONS: ReadonlyArray<BanDuration> = [
  { label: "1 day", ms: 1 * 24 * 60 * 60 * 1000 },
  { label: "3 days", ms: 3 * 24 * 60 * 60 * 1000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "Permanent", ms: null },
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * "Remove their recent posts" windows. Index 0 (`null`) is the default —
 * banning a regular offender leaves their history intact; the later options
 * are for clearing a spammer. Range runs 1 hour … 7 days, plus All time.
 */
const PURGE_WINDOWS: ReadonlyArray<{ label: string; value: PurgeChoice }> = [
  { label: "Don't remove", value: null },
  { label: "1 hour", value: 1 * HOUR },
  { label: "6 hours", value: 6 * HOUR },
  { label: "24 hours", value: 24 * HOUR },
  { label: "3 days", value: 3 * DAY },
  { label: "7 days", value: 7 * DAY },
  { label: "All time", value: "all" },
];

export function BanModal({
  targetName,
  description,
  reasonRequired = true,
  reasonPlaceholder = "Visible to other moderators in the ban history.",
  reasonMaxLength = 1000,
  showPurge = true,
  purgeScopeLabel = "posts",
  confirmLabel = "Ban account",
  busyLabel = "Banning…",
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
  const [durIdx, setDurIdx] = useState(0);
  const [reason, setReason] = useState("");
  const [purgeIdx, setPurgeIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const trimmed = reason.trim();
  const reasonOk = reasonRequired ? trimmed.length > 0 : true;

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
        <h3 className="mb-1 text-base font-semibold">Ban {targetName}</h3>
        <p className="mb-3 text-xs text-keep-muted">
          {description ?? "Blocks login and chat. A timed ban lifts itself when it expires."}
        </p>

        <div className="mb-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">Duration</div>
          <div className="flex flex-wrap gap-1.5">
            {BAN_DURATIONS.map((d, i) => (
              <button
                key={d.label}
                type="button"
                onClick={() => setDurIdx(i)}
                aria-pressed={durIdx === i}
                className={`rounded border px-2.5 py-1 text-xs font-semibold transition-colors ${
                  durIdx === i
                    ? "border-keep-action bg-keep-action text-keep-bg"
                    : "border-keep-rule bg-keep-panel text-keep-text hover:bg-keep-banner"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-keep-muted">
            Reason{" "}
            {reasonRequired
              ? <span className="text-[#e06070]">(required)</span>
              : <span className="text-keep-muted/70">(optional)</span>}
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={reasonMaxLength}
            placeholder={reasonPlaceholder}
            className="w-full resize-none rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
          />
        </label>

        {showPurge ? (
          <div className="mb-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">
              Remove recent {purgeScopeLabel}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PURGE_WINDOWS.map((p, i) => (
                <button
                  key={p.label}
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
                  {p.label}
                </button>
              ))}
            </div>
            {purgeIdx > 0 ? (
              <p className="mt-1 text-[10px] text-keep-muted">
                Their {purgeScopeLabel} are hidden, not deleted: admins keep them for audit.
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
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={submitting || !reasonOk}
            className="rounded border border-[#e06070]/80 bg-[#e06070] px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
