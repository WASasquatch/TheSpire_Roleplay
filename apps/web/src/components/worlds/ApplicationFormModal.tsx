import { useEffect, useState } from "react";
import type { WorldApplicationEntry, WorldDetail } from "@thekeep/shared";
import { WORLD_APP_ANSWER_MAX_LEN } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { Modal } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";

interface Props {
  worldId: string;
  worldName: string;
  onClose: () => void;
  onSubmitted: (app: WorldApplicationEntry) => void;
}

/**
 * Application form for joining a `joinMode: "application"` world.
 *
 * The form fetches the world's CURRENT question list on mount (so a
 * stale catalog page can't lock the applicant into a previous
 * version's questions) and renders one textarea per prompt. Submit
 * POSTs to `/worlds/:id/applications` with the answer array; on 409
 * the form surfaces the existing pending application so the user
 * isn't stuck staring at "you already applied" with no out.
 *
 * Empty question list is legal, an application with no Q&A just
 * captures the applicant's intent-to-join. The Submit button stays
 * enabled in that case because the server doesn't require any text.
 *
 * UX posture: no "Save draft" / "Continue later", applications are
 * short enough that a single-shot fill-and-submit is the right
 * shape. Closing the modal mid-fill loses the draft, same as every
 * other one-off form in the app.
 */
export function ApplicationFormModal({ worldId, worldName, onClose, onSubmitted }: Props) {
  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState<string[]>([]);
  // Track an existing pending application so we can show "you've
  // already applied" without offering a re-submit path. The user
  // withdraws first if they want to redo it.
  const [existingPending, setExistingPending] = useState<WorldApplicationEntry | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/worlds/${worldId}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return (await r.json()) as WorldDetail | { private: true };
      })
      .then((detail) => {
        if (cancelled) return;
        if ("private" in detail) {
          // Catalog already filtered for visibility, but if a race
          // makes a private stub land here, surface it cleanly.
          setError("This world is private, you'd need to sign in or be invited.");
          setQuestions([]);
          setAnswers([]);
          return;
        }
        const qs = detail.world.applicationQuestions;
        setQuestions(qs);
        setAnswers(qs.map(() => ""));
        if (
          detail.viewerApplication &&
          detail.viewerApplication.status === "pending"
        ) {
          setExistingPending(detail.viewerApplication);
        }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "load failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [worldId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}/applications`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: answers.map((a) => a.trim()) }),
      });
      if (!r.ok) {
        // 409 means a pending application already exists, fetch
        // the world detail again to populate it so the user sees
        // their current state instead of a dead-end error.
        if (r.status === 409) {
          throw new Error(await readError(r));
        }
        throw new Error(await readError(r));
      }
      const body = (await r.json()) as { ok: true; application: WorldApplicationEntry };
      onSubmitted(body.application);
    } catch (e) {
      setError(e instanceof Error ? e.message : "submit failed");
    } finally {
      setBusy(false);
    }
  }

  async function withdrawExisting() {
    if (!existingPending) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/worlds/${worldId}/applications/${encodeURIComponent(existingPending.id)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!r.ok) throw new Error(await readError(r));
      // After withdraw, drop the existing-pending state so the form
      // shows fresh, the user can re-fill and submit again.
      setExistingPending(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "withdraw failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} zIndex={60} variant="centered">
      <div
        onClick={(e) => e.stopPropagation()}
        className="keep-frame flex max-h-[85vh] w-full max-w-lg flex-col rounded bg-keep-bg shadow-lg"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-3 py-2">
          <div>
            <h2 className="font-action text-sm">Apply to join</h2>
            <p className="text-[10px] text-keep-muted">{worldName}</p>
          </div>
          <CloseButton onClick={onClose} />
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
          {error ? (
            <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">
              {error}
            </div>
          ) : null}

          {loading ? (
            <p className="italic text-keep-muted">Loading questions…</p>
          ) : existingPending ? (
            // The applicant has a pending application already. Show
            // it read-only with a Withdraw button so they can cancel
            // and re-submit; the server's partial unique index
            // guarantees only one pending row per (world, user) at
            // a time.
            <div className="space-y-2">
              <p className="text-keep-text">
                You already have a pending application for this world. The owner hasn't reviewed it yet.
              </p>
              <ul className="space-y-2">
                {existingPending.questions.map((q, i) => (
                  <li key={i} className="rounded border border-keep-rule bg-keep-banner/30 p-2">
                    <div className="text-keep-muted">{q}</div>
                    <div className="mt-1 whitespace-pre-wrap text-keep-text">
                      {existingPending.answers[i] || <span className="italic text-keep-muted">(empty)</span>}
                    </div>
                  </li>
                ))}
                {existingPending.questions.length === 0 ? (
                  <li className="italic text-keep-muted">No questions, just intent to join.</li>
                ) : null}
              </ul>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={withdrawExisting}
                  disabled={busy}
                  className="rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
                >
                  {busy ? "Withdrawing…" : "Withdraw application"}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-keep-muted hover:bg-keep-banner"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
              {questions.length === 0 ? (
                <p className="text-keep-text">
                  The owner hasn't set any questions, submit to register your interest in joining.
                </p>
              ) : (
                <ul className="space-y-2">
                  {questions.map((q, i) => (
                    <li key={i} className="space-y-1">
                      <label className="block text-keep-text">{q}</label>
                      <textarea
                        rows={3}
                        value={answers[i] ?? ""}
                        maxLength={WORLD_APP_ANSWER_MAX_LEN}
                        onChange={(e) => {
                          const v = e.target.value;
                          setAnswers((arr) => {
                            const next = [...arr];
                            next[i] = v;
                            return next;
                          });
                        }}
                        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                      />
                      <div className="text-right text-[10px] text-keep-muted">
                        {(answers[i]?.length ?? 0)} / {WORLD_APP_ANSWER_MAX_LEN}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={submit}
                  disabled={busy}
                  className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
                >
                  {busy ? "Submitting…" : "Submit application"}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-keep-muted hover:bg-keep-banner"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
