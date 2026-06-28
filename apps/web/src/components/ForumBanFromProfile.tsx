import { useEffect, useState } from "react";
import { Ban } from "lucide-react";
import type { ForumManagedEntry } from "@thekeep/shared";
import { banFromForum, fetchMyManagedForums } from "../lib/forums.js";
import { Modal } from "./Modal.js";

/**
 * Profile action: ban this user from a forum the VIEWER owns or moderates
 * (with the ban_users grant). Self-hides unless the viewer manages at least
 * one such forum. When they manage several, a picker chooses which forum
 * first; with exactly one it jumps straight to the ban dialog.
 *
 * Scope is the forum's boards only — never a site-wide account ban (that
 * lives in the staff ModeratorPanel and needs `ban_account`). The server
 * re-checks the grant and refuses to forum-ban site staff.
 */
export function ForumBanFromProfile({ targetUserId, targetName }: {
  targetUserId: string;
  targetName: string;
}) {
  const [forums, setForums] = useState<ForumManagedEntry[] | null>(null);
  const [step, setStep] = useState<"idle" | "pick" | "confirm">("idle");
  const [chosen, setChosen] = useState<ForumManagedEntry | null>(null);
  const [hours, setHours] = useState("168");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Resolve the viewer's ban-capable forums once. Cheap (owner/mod rows only).
  useEffect(() => {
    let alive = true;
    fetchMyManagedForums()
      .then((all) => { if (alive) setForums(all.filter((f) => f.permissions.includes("ban_users"))); })
      .catch(() => { if (alive) setForums([]); });
    return () => { alive = false; };
  }, [targetUserId]);

  // Nothing to offer (still loading, or the viewer manages no ban-capable forum).
  if (!forums || forums.length === 0) return null;

  function open() {
    setError(null);
    if (forums!.length === 1) { setChosen(forums![0]!); setStep("confirm"); }
    else setStep("pick");
  }
  function close() { setStep("idle"); setChosen(null); setReason(""); setError(null); }

  function submit() {
    if (!chosen) return;
    setBusy(true); setError(null);
    banFromForum(chosen.id, {
      target: `@id:${targetUserId}`,
      hours: hours === "perm" ? null : parseInt(hours, 10),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    })
      .then(() => { setDone(true); close(); })
      .catch((e) => setError(e instanceof Error ? e.message : "Ban failed."))
      .finally(() => setBusy(false));
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={done}
        title={done ? "Banned from your forum" : "Ban this user from a forum you run"}
        className="flex items-center gap-1.5 rounded border border-keep-system/60 px-2 py-1 text-xs text-keep-system hover:bg-keep-system/10 disabled:opacity-50"
      >
        <Ban className="h-4 w-4" aria-hidden="true" />
        {done ? "Forum-banned" : "Ban from forum"}
      </button>

      {step !== "idle" ? (
        <Modal onClose={close} zIndex={60}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="keep-frame w-full rounded bg-keep-bg p-5 text-keep-text md:w-[min(460px,82vw)]"
          >
            {step === "pick" ? (
              <>
                <h2 className="font-action text-lg">Ban from which forum?</h2>
                <p className="mt-1 text-sm text-keep-muted">You run more than one. Pick where to ban <b>{targetName}</b>.</p>
                <ul className="mt-3 space-y-1">
                  {forums.map((f) => (
                    <li key={f.id}>
                      <button
                        type="button"
                        onClick={() => { setChosen(f); setStep("confirm"); }}
                        className="flex w-full items-center gap-2 rounded border border-keep-rule px-2 py-1.5 text-left hover:border-keep-action hover:bg-keep-banner/40"
                      >
                        {f.logoUrl ? (
                          <img src={f.logoUrl} alt="" className="h-6 w-6 shrink-0 rounded border border-keep-rule object-cover" />
                        ) : (
                          <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-keep-rule bg-keep-banner text-[9px] uppercase text-keep-muted">{f.name.slice(0, 2)}</span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex justify-end">
                  <button type="button" onClick={close} className="rounded border border-keep-rule px-3 py-1 text-sm hover:bg-keep-banner">Cancel</button>
                </div>
              </>
            ) : (
              <>
                <h2 className="font-action text-lg">Ban from {chosen?.name}</h2>
                <p className="mt-1 text-sm text-keep-muted">
                  Bans <b>{targetName}</b> from this forum's boards only — not the rest of the Spire.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <select
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                    className="rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
                  >
                    <option value="24">1 day</option>
                    <option value="168">7 days</option>
                    <option value="720">30 days</option>
                    <option value="perm">Permanent</option>
                  </select>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={300}
                    placeholder="Reason (shown to them)"
                    className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm outline-none focus:border-keep-action"
                  />
                </div>
                {error ? <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</div> : null}
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={close} className="rounded border border-keep-rule px-3 py-1 text-sm hover:bg-keep-banner">Cancel</button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={submit}
                    className="rounded border border-keep-system/70 bg-keep-system/15 px-3 py-1 text-sm font-semibold text-keep-system disabled:opacity-50"
                  >
                    {busy ? "Banning…" : "Ban"}
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
