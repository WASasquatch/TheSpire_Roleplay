import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BarChart3, Check, Lock } from "lucide-react";
import { isPollClosed, type ChatMessage, type PollState } from "@thekeep/shared";
import { ensureInjectedStyle } from "../lib/injectStyle.js";
import { votePoll, closePoll } from "../lib/polls.js";

/**
 * Renders a `kind: "poll"` message: option buttons before you vote, animated
 * result bars after. Bars fill on view; the closer a bar is to 100% the more
 * it rumbles, and a leader that maxes out "pops its top" with a one-shot
 * burst. Works for poll posts in both chat and forum boards.
 *
 * Reveal gate (matches the product ask — "stats of who voted AFTER the user
 * votes"): results show once you've voted, once the poll is closed, or if
 * you're the author. The server filters voter identities to showVoters polls,
 * so a counts-only poll never carries names to render.
 */

const POLL_STYLE_ID = "poll-card-anim";
const POLL_CSS = `
@keyframes poll-fill { from { width: 0; } to { width: var(--poll-pct); } }
@keyframes poll-rumble-soft {
  0%,100% { transform: translate(0,0); }
  25% { transform: translate(-0.5px, 0.5px); }
  75% { transform: translate(0.5px, -0.5px); }
}
@keyframes poll-rumble-strong {
  0%,100% { transform: translate(0,0) scaleY(1); }
  20% { transform: translate(-1.5px, 1px) scaleY(1.03); }
  40% { transform: translate(1.5px, -1px) scaleY(0.99); }
  60% { transform: translate(-1px, -1px) scaleY(1.04); }
  80% { transform: translate(1px, 1px) scaleY(0.98); }
}
@keyframes poll-burst-shard {
  0% { opacity: 0; transform: translate(0,0) scale(0.4); }
  20% { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--sx), var(--sy)) scale(1.1); }
}
.poll-bar-fill { animation: poll-fill 650ms cubic-bezier(0.2, 0.85, 0.2, 1) forwards; }
.poll-bar-rumble-soft { animation: poll-rumble-soft 360ms ease-in-out infinite; }
.poll-bar-rumble-strong { animation: poll-rumble-strong 150ms linear infinite; }
.poll-burst { position: absolute; top: -2px; left: 0; right: 0; height: 0; pointer-events: none; }
.poll-burst > i {
  position: absolute; top: 0; width: 4px; height: 4px; border-radius: 9999px;
  background: rgb(var(--keep-accent)); opacity: 0;
  animation: poll-burst-shard 620ms ease-out forwards;
}
@media (prefers-reduced-motion: reduce) {
  .poll-bar-fill { animation-duration: 1ms; }
  .poll-bar-rumble-soft, .poll-bar-rumble-strong { animation: none; }
  .poll-burst > i { display: none; }
}
`;

interface Props {
  message: ChatMessage;
  poll: PollState;
  /** Viewer authored this poll — may close it and always sees results. */
  isAuthor: boolean;
  /** Site/forum moderator viewing — may close someone else's poll. */
  canModerate?: boolean;
  /** Compact rendering for chat lines (tighter paddings). */
  compact?: boolean;
  /** Anonymous / read-only surface (public /f/ landing): voting is disabled
   *  and a sign-in hint replaces the live controls. */
  readOnly?: boolean;
}

function timeLeft(closesAt: number): string {
  const ms = closesAt - Date.now();
  if (ms <= 0) return "closing…";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `closes in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `closes in ${hrs}h`;
  return `closes in ${Math.round(hrs / 24)}d`;
}

export function PollCard({ message, poll, isAuthor, canModerate, compact, readOnly }: Props) {
  useEffect(() => { ensureInjectedStyle(POLL_STYLE_ID, POLL_CSS); }, []);

  const closed = isPollClosed(poll, Date.now());
  // The question lives on the title (forum topic) or the body (chat line).
  const question = (message.title?.trim() || message.body || "").trim();

  // Local ballot: seed from the server's hydrated myVote, update optimistically.
  const [myVote, setMyVote] = useState<string[]>(poll.myVote);
  useEffect(() => { setMyVote(poll.myVote); }, [poll.myVote]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Multi-choice staging before submit.
  const [staged, setStaged] = useState<Set<string>>(() => new Set(poll.myVote));

  const hasVoted = myVote.length > 0;
  const revealed = hasVoted || closed || isAuthor;

  const totalVotes = useMemo(() => poll.tallies.reduce((a, t) => a + t.count, 0), [poll.tallies]);
  const maxCount = useMemo(() => poll.tallies.reduce((a, t) => Math.max(a, t.count), 0), [poll.tallies]);

  // Fill-on-view: flip a flag when the card scrolls into view so the bars
  // animate width 0 → pct exactly once.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setInView(true); obs.disconnect(); }
    }, { threshold: 0.25 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);

  async function submit(optionIds: string[]) {
    if (busy || closed) return;
    setBusy(true); setErr(null);
    const prev = myVote;
    setMyVote(optionIds); // optimistic
    try {
      await votePoll(message.id, optionIds);
    } catch (e) {
      setMyVote(prev);
      setErr(e instanceof Error ? e.message : "Vote failed.");
    } finally {
      setBusy(false);
    }
  }

  function pickSingle(optionId: string) {
    // Toggle off if re-clicking your current single choice (retract).
    const next = myVote.length === 1 && myVote[0] === optionId ? [] : [optionId];
    void submit(next);
  }

  function toggleStaged(optionId: string) {
    setStaged((cur) => {
      const next = new Set(cur);
      if (next.has(optionId)) next.delete(optionId); else next.add(optionId);
      return next;
    });
  }

  async function doClose() {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await closePoll(message.id); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't close the poll."); }
    finally { setBusy(false); }
  }

  const pad = compact ? "p-2.5" : "p-3.5";

  return (
    <div
      ref={rootRef}
      className={`rounded-lg border border-keep-accent/40 bg-keep-panel/40 ${pad}`}
      role="group"
      aria-label="Poll"
    >
      <div className="mb-2 flex items-start gap-2">
        <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {question ? <p className="font-semibold leading-snug text-keep-text">{question}</p> : null}
          <p className="mt-0.5 text-[11px] uppercase tracking-widest text-keep-muted">
            {poll.allowMultiple ? "Pick any" : "Pick one"}
            {!poll.showVoters ? " · anonymous" : ""}
          </p>
        </div>
      </div>

      {revealed ? (
        <ResultBars
          poll={poll}
          myVote={myVote}
          totalVotes={totalVotes}
          maxCount={maxCount}
          inView={inView}
          closed={closed}
        />
      ) : (
        <>
          <OptionButtons
            poll={poll}
            allowMultiple={poll.allowMultiple}
            staged={staged}
            busy={busy || !!readOnly}
            onPickSingle={pickSingle}
            onToggle={toggleStaged}
            onSubmitMulti={() => void submit([...staged])}
          />
          {readOnly ? (
            <p className="mt-2 text-[11px] italic text-keep-muted">Sign in to vote and see the results.</p>
          ) : null}
        </>
      )}

      {err ? <p className="mt-2 text-xs text-keep-accent">{err}</p> : null}

      <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px] text-keep-muted">
        <span>
          {poll.totalVoters} {poll.totalVoters === 1 ? "voter" : "voters"}
          {closed
            ? " · closed"
            : poll.closesAt != null
              ? ` · ${timeLeft(poll.closesAt)}`
              : ""}
        </span>
        <span className="flex items-center gap-2">
          {!readOnly && revealed && !closed && hasVoted ? (
            <button
              type="button"
              onClick={() => void submit([])}
              disabled={busy}
              className="rounded border border-keep-rule px-1.5 py-0.5 uppercase tracking-widest hover:text-keep-text disabled:opacity-50"
            >
              Retract
            </button>
          ) : null}
          {!readOnly && !closed && (isAuthor || canModerate) ? (
            <button
              type="button"
              onClick={() => void doClose()}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded border border-keep-accent/50 px-1.5 py-0.5 uppercase tracking-widest text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
            >
              <Lock className="h-3 w-3" aria-hidden="true" /> Close
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function OptionButtons({ poll, allowMultiple, staged, busy, onPickSingle, onToggle, onSubmitMulti }: {
  poll: PollState;
  allowMultiple: boolean;
  staged: Set<string>;
  busy: boolean;
  onPickSingle: (id: string) => void;
  onToggle: (id: string) => void;
  onSubmitMulti: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {poll.options.map((o) => {
        const isStaged = staged.has(o.id);
        return (
          <button
            key={o.id}
            type="button"
            disabled={busy}
            onClick={() => (allowMultiple ? onToggle(o.id) : onPickSingle(o.id))}
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition disabled:opacity-50 ${
              allowMultiple && isStaged
                ? "border-keep-accent bg-keep-accent/15 text-keep-text"
                : "border-keep-rule bg-keep-bg/50 text-keep-text hover:border-keep-accent/60 hover:bg-keep-accent/10"
            }`}
          >
            {allowMultiple ? (
              <span
                aria-hidden
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                  isStaged ? "border-keep-accent bg-keep-accent text-keep-bg" : "border-keep-rule"
                }`}
              >
                {isStaged ? <Check className="h-3 w-3" /> : null}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">{o.text}</span>
          </button>
        );
      })}
      {allowMultiple ? (
        <button
          type="button"
          disabled={busy || staged.size === 0}
          onClick={onSubmitMulti}
          className="mt-0.5 self-start rounded-md border border-keep-accent bg-keep-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          Vote
        </button>
      ) : null}
    </div>
  );
}

function ResultBars({ poll, myVote, totalVotes, maxCount, inView, closed }: {
  poll: PollState;
  myVote: string[];
  totalVotes: number;
  maxCount: number;
  inView: boolean;
  closed: boolean;
}) {
  const mine = new Set(myVote);
  return (
    <div className="flex flex-col gap-2">
      {poll.options.map((o) => {
        const tally = poll.tallies.find((t) => t.optionId === o.id);
        const count = tally?.count ?? 0;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        const isLeader = count > 0 && count === maxCount;
        const iVoted = mine.has(o.id);
        // Rumble intensity scales with fill; the leader straining toward
        // 100% shakes hardest and pops its top once it maxes out.
        const rumble = !inView ? "" : pct >= 88 ? " poll-bar-rumble-strong" : pct >= 70 ? " poll-bar-rumble-soft" : "";
        const burst = inView && pct >= 99;
        return (
          <div key={o.id}>
            <div className="mb-0.5 flex items-center justify-between gap-2 text-xs">
              <span className={`min-w-0 flex-1 truncate ${iVoted ? "font-semibold text-keep-text" : "text-keep-text/85"}`}>
                {iVoted ? "✓ " : ""}{o.text}
              </span>
              <span className="shrink-0 tabular-nums text-keep-muted">{pct}% · {count}</span>
            </div>
            <div className="relative h-5 overflow-visible rounded bg-keep-bg/60">
              <div
                className={`relative h-full rounded ${inView ? "poll-bar-fill" : ""}${rumble}`}
                style={{
                  "--poll-pct": `${pct}%`,
                  width: inView ? undefined : 0,
                  background: isLeader
                    ? "linear-gradient(90deg, rgb(var(--keep-accent) / 0.9), rgb(var(--keep-action) / 0.9))"
                    : "rgb(var(--keep-accent) / 0.5)",
                } as CSSProperties}
              >
                {burst ? (
                  <span className="poll-burst" aria-hidden>
                    {BURST_SHARDS.map((s, i) => (
                      <i key={i} style={{ left: `${s.left}%`, "--sx": s.sx, "--sy": s.sy } as CSSProperties} />
                    ))}
                  </span>
                ) : null}
              </div>
            </div>
            {poll.showVoters && tally?.voters && tally.voters.length > 0 ? (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {tally.voters.slice(0, 12).map((v) => (
                  <span
                    key={v.userId}
                    title={v.displayName}
                    className="inline-flex items-center gap-1 rounded-full border border-keep-rule bg-keep-bg/50 py-0.5 pl-0.5 pr-2 text-[11px] text-keep-muted"
                  >
                    {v.avatarUrl ? (
                      <img src={v.avatarUrl} alt="" className="h-4 w-4 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-keep-accent/30 text-[9px] uppercase text-keep-text">
                        {v.displayName.slice(0, 1)}
                      </span>
                    )}
                    {v.displayName}
                  </span>
                ))}
                {tally.voters.length > 12 ? (
                  <span className="text-[11px] text-keep-muted">+{tally.voters.length - 12}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Pre-baked shard trajectories for the cap-pop burst (deterministic so the
 *  render is stable; no Math.random at render time). */
const BURST_SHARDS: Array<{ left: number; sx: string; sy: string }> = [
  { left: 18, sx: "-10px", sy: "-16px" },
  { left: 38, sx: "-3px", sy: "-22px" },
  { left: 52, sx: "4px", sy: "-20px" },
  { left: 68, sx: "11px", sy: "-15px" },
  { left: 84, sx: "16px", sy: "-10px" },
];
