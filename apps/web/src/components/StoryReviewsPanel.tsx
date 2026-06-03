import { useEffect, useState, type FormEvent } from "react";
import type {
  StoryReview,
  StoryReviewPage,
  StoryReviewReply,
} from "@thekeep/shared";
import { STORY_REVIEW_BODY_MAX, STORY_REVIEW_REPLY_MAX } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { readError } from "../lib/http.js";
import { ScriptoriumReportButton } from "./ScriptoriumReportButton.js";

interface Props {
  storyId: string;
  /** Author's user id, so the panel can show moderation affordances (pin/hide). */
  authorUserId: string;
  /** True iff the author has opted into reviews. */
  allowReviews: boolean;
}

/**
 * Reviews surface at the bottom of the story reader. Renders the
 * paginated list (pinned first), an inline composer for the viewer
 * (signed-in non-author), and reply chains under each review.
 *
 * Self-contained — owns its own fetches + state so the reader modal
 * doesn't have to thread review props through every render.
 */
export function StoryReviewsPanel({ storyId, authorUserId, allowReviews }: Props) {
  const me = useChat((s) => s.me);
  const [page, setPage] = useState<StoryReviewPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/stories/${storyId}/reviews`);
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as StoryReviewPage;
      setPage(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [storyId]);

  // Reviews disabled by the author — render nothing. Silently absent
  // beats a "no reviews here" footer the reader has to look at.
  if (!allowReviews) return null;

  const isAuthor = !!me && me.id === authorUserId;
  const canPostReview = !!me && !isAuthor && page && !page.viewerHasReviewed;

  return (
    <section className="mx-auto mt-10 max-w-prose border-t border-current/20 pt-5">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="font-action text-lg">Reviews</h3>
        <span className="text-xs opacity-70">
          {page?.total ?? 0} {page?.total === 1 ? "review" : "reviews"}
          {page?.avgRating != null ? <> · ★ {page.avgRating.toFixed(1)}</> : null}
        </span>
      </header>

      {error ? (
        <p className="mb-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</p>
      ) : null}

      {!me ? (
        <p className="mb-3 rounded border border-keep-rule/40 bg-keep-panel/30 px-3 py-2 text-xs italic">
          <a href="/login" className="text-keep-action underline-offset-4 hover:underline">Sign in</a>
          {" "}to leave a review.
        </p>
      ) : isAuthor ? (
        <p className="mb-3 rounded border border-keep-rule/40 bg-keep-panel/30 px-3 py-2 text-xs italic">
          You can't review your own story. You can pin or hide any review below.
        </p>
      ) : page?.viewerHasReviewed ? (
        <p className="mb-3 rounded border border-keep-rule/40 bg-keep-panel/30 px-3 py-2 text-xs italic">
          You've already reviewed this story. (Within 60 seconds of posting, you could still edit it.)
        </p>
      ) : canPostReview ? (
        <ReviewComposer storyId={storyId} onPosted={() => void load()} />
      ) : null}

      {page === null ? (
        <p className="italic opacity-60">Loading reviews…</p>
      ) : page.reviews.length === 0 ? (
        <p className="italic opacity-60">No reviews yet. Be the first to share what you think.</p>
      ) : (
        <ul className="space-y-4">
          {page.reviews.map((rev) => (
            <ReviewCard
              key={rev.id}
              review={rev}
              storyId={storyId}
              isStoryAuthor={isAuthor}
              onChanged={() => void load()}
              busy={busy}
              setBusy={setBusy}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/* =============================================================
 *  Review composer
 * ============================================================= */

function ReviewComposer({
  storyId,
  onPosted,
}: {
  storyId: string;
  onPosted: () => void;
}) {
  const [rating, setRating] = useState<number>(5);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${storyId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, bodyHtml: body }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setBody("");
      setRating(5);
      onPosted();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "post failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 rounded border border-keep-rule/40 bg-keep-panel/30 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs uppercase tracking-widest opacity-70">Your rating</span>
        <StarPicker value={rating} onChange={setRating} />
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={STORY_REVIEW_BODY_MAX}
        rows={4}
        placeholder="Your thoughts on this story (optional)…"
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm"
      />
      {err ? <p className="mt-1 text-xs text-keep-accent">{err}</p> : null}
      <div className="mt-2 flex items-center justify-between text-[10px] opacity-60">
        <span>You have 60 seconds to edit after posting.</span>
        <button
          type="submit"
          disabled={busy || rating < 1}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {busy ? "Posting…" : "Post review"}
        </button>
      </div>
    </form>
  );
}

function StarPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Star rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          onClick={() => onChange(n)}
          className={`text-lg leading-none transition ${
            n <= value ? "text-amber-400" : "text-keep-muted hover:text-amber-300"
          }`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

/* =============================================================
 *  One review card + its replies + reply composer
 * ============================================================= */

function ReviewCard({
  review,
  storyId,
  isStoryAuthor,
  onChanged,
  busy,
  setBusy,
}: {
  review: StoryReview;
  storyId: string;
  isStoryAuthor: boolean;
  onChanged: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const me = useChat((s) => s.me);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isReviewer = !!me && me.id === review.reviewer.userId;
  const editGraceLeft = review.editGraceExpiresAt
    ? Math.max(0, review.editGraceExpiresAt - Date.now())
    : 0;
  const canEdit = isReviewer && editGraceLeft > 0;

  async function togglePin() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${storyId}/reviews/${review.id}/moderate`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedByAuthor: !review.pinnedByAuthor }),
      });
      if (!r.ok) throw new Error(await readError(r));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "moderate failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleHide() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${storyId}/reviews/${review.id}/moderate`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiddenByAuthor: !review.hiddenByAuthor }),
      });
      if (!r.ok) throw new Error(await readError(r));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "moderate failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelf() {
    if (!window.confirm("Delete your review?")) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${storyId}/reviews/${review.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await readError(r));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  const authorName = review.reviewer.characterName ?? review.reviewer.masterUsername;
  // OOC ↔ character partition: a review posted under a character
  // voice never falls back to the master's avatar — initials of the
  // character's name render instead. The character name above DOES
  // cleanly fall back to the master username because the master
  // username IS the OOC display name (no leak); the avatar would
  // leak the actual master face.
  const authorAvatar = review.reviewer.characterName
    ? (review.reviewer.characterAvatarUrl ?? null)
    : (review.reviewer.masterAvatarUrl ?? null);

  return (
    <li
      className={`rounded border border-keep-rule/40 bg-keep-panel/20 p-3 ${
        review.pinnedByAuthor ? "ring-1 ring-amber-400/40" : ""
      } ${review.hiddenByAuthor ? "opacity-50" : ""}`}
    >
      <header className="mb-1.5 flex items-center gap-2">
        {authorAvatar ? (
          <img src={authorAvatar} alt="" className="h-6 w-6 rounded-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <div className="h-6 w-6 rounded-full bg-keep-bg" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="font-semibold">{authorName}</span>
            {review.reviewer.characterId ? <span className="text-[10px] italic opacity-70">(as character)</span> : null}
            <Stars rating={review.rating} />
          </div>
          <div className="text-[10px] opacity-60">
            {new Date(review.createdAt).toLocaleString()}
            {review.updatedAt !== review.createdAt ? " · edited" : null}
            {review.pinnedByAuthor ? <span className="ml-1 text-amber-400"> · pinned</span> : null}
            {review.hiddenByAuthor ? <span className="ml-1 text-keep-accent"> · hidden by author</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 gap-1 text-[10px]">
          {isStoryAuthor ? (
            <>
              <button
                type="button"
                onClick={togglePin}
                disabled={busy}
                className="rounded border border-keep-rule px-1.5 py-0.5 text-keep-muted hover:text-keep-text"
                title={review.pinnedByAuthor ? "Unpin" : "Pin to top"}
              >
                {review.pinnedByAuthor ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                onClick={toggleHide}
                disabled={busy}
                className="rounded border border-keep-rule px-1.5 py-0.5 text-keep-muted hover:text-keep-text"
                title={review.hiddenByAuthor ? "Unhide" : "Hide from public view"}
              >
                {review.hiddenByAuthor ? "Unhide" : "Hide"}
              </button>
            </>
          ) : null}
          {isReviewer ? (
            <>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => setEditing((v) => !v)}
                  className="rounded border border-keep-rule px-1.5 py-0.5 text-keep-muted hover:text-keep-text"
                  title="Edit (60s grace)"
                >
                  Edit
                </button>
              ) : null}
              <button
                type="button"
                onClick={deleteSelf}
                disabled={busy}
                className="rounded border border-keep-accent/40 px-1.5 py-0.5 text-keep-accent"
                title="Delete your review"
              >
                Delete
              </button>
            </>
          ) : me && !isStoryAuthor ? (
            // Non-reviewer, non-author readers can flag a review for moderation.
            // The story author has their own pin/hide affordances above; admins
            // see Pin/Hide too (isStoryAuthor is also true for them via the
            // server-side check that resolves admin → author for moderation).
            <ScriptoriumReportButton
              storyId={storyId}
              targetKind="review"
              targetId={review.id}
              label="Report this review"
              compact
            />
          ) : null}
        </div>
      </header>

      {err ? <p className="mb-1 text-xs text-keep-accent">{err}</p> : null}

      {editing && canEdit ? (
        <ReviewEditForm
          storyId={storyId}
          review={review}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onChanged(); }}
        />
      ) : review.bodyHtml ? (
        <div
          className="prose prose-sm max-w-none text-sm"
          dangerouslySetInnerHTML={{ __html: review.bodyHtml }}
        />
      ) : (
        <p className="text-xs italic opacity-60">(No prose — rating only.)</p>
      )}

      {review.replies.length > 0 ? (
        <ul className="mt-3 space-y-2 border-l border-keep-rule/30 pl-3">
          {review.replies.map((rr) => (
            <ReplyRow
              key={rr.id}
              storyId={storyId}
              reviewId={review.id}
              reply={rr}
              onChanged={onChanged}
            />
          ))}
        </ul>
      ) : null}

      {me ? (
        <div className="mt-2">
          {replying ? (
            <ReplyComposer
              storyId={storyId}
              reviewId={review.id}
              onClose={() => setReplying(false)}
              onPosted={() => { setReplying(false); onChanged(); }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setReplying(true)}
              className="text-[11px] text-keep-muted underline-offset-2 hover:text-keep-text hover:underline"
            >
              Reply
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span aria-label={`${rating} of 5 stars`} className="text-[12px] text-amber-400">
      {"★".repeat(rating)}<span className="opacity-30">{"★".repeat(5 - rating)}</span>
    </span>
  );
}

function ReviewEditForm({
  storyId,
  review,
  onClose,
  onSaved,
}: {
  storyId: string;
  review: StoryReview;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rating, setRating] = useState<number>(review.rating);
  const [body, setBody] = useState(review.bodyHtml);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${storyId}/reviews/${review.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, bodyHtml: body }),
      });
      if (!r.ok) throw new Error(await readError(r));
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded border border-keep-action/40 bg-keep-action/5 p-2">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs uppercase tracking-widest opacity-70">Rating</span>
        <StarPicker value={rating} onChange={setRating} />
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        maxLength={STORY_REVIEW_BODY_MAX}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm"
      />
      {err ? <p className="mt-1 text-xs text-keep-accent">{err}</p> : null}
      <div className="mt-2 flex justify-end gap-2 text-xs">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-keep-muted hover:text-keep-text"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded border border-keep-action bg-keep-action px-3 py-0.5 font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function ReplyComposer({
  storyId,
  reviewId,
  onClose,
  onPosted,
}: {
  storyId: string;
  reviewId: string;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${storyId}/reviews/${reviewId}/replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bodyHtml: body }),
      });
      if (!r.ok) throw new Error(await readError(r));
      onPosted();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "post failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-1 rounded border border-keep-rule/40 bg-keep-bg/40 p-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        maxLength={STORY_REVIEW_REPLY_MAX}
        autoFocus
        placeholder="Reply…"
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm"
      />
      {err ? <p className="mt-1 text-xs text-keep-accent">{err}</p> : null}
      <div className="mt-1 flex justify-end gap-2 text-xs">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-keep-muted hover:text-keep-text"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !body.trim()}
          className="rounded border border-keep-action bg-keep-action px-3 py-0.5 font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {busy ? "Posting…" : "Post reply"}
        </button>
      </div>
    </form>
  );
}

function ReplyRow({
  storyId,
  reviewId,
  reply,
  onChanged,
}: {
  storyId: string;
  reviewId: string;
  reply: StoryReviewReply;
  onChanged: () => void;
}) {
  const me = useChat((s) => s.me);
  const isOwn = !!me && me.id === reply.replyer.userId;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function deleteSelf() {
    if (!window.confirm("Delete your reply?")) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${storyId}/reviews/${reviewId}/replies/${reply.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await readError(r));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  const name = reply.replyer.characterName ?? reply.replyer.masterUsername;
  // OOC ↔ character partition (see authorAvatar above): replies
  // posted under a character voice render initials when the
  // character has no portrait — never the master's avatar.
  const avatar = reply.replyer.characterName
    ? (reply.replyer.characterAvatarUrl ?? null)
    : (reply.replyer.masterAvatarUrl ?? null);

  return (
    <li>
      <div className="flex items-center gap-1.5 text-xs">
        {avatar ? (
          <img src={avatar} alt="" className="h-4 w-4 rounded-full object-cover" referrerPolicy="no-referrer" />
        ) : null}
        <span className="font-semibold">{name}</span>
        <span className="text-[10px] opacity-60">{new Date(reply.createdAt).toLocaleString()}</span>
        {isOwn ? (
          <button
            type="button"
            onClick={deleteSelf}
            disabled={busy}
            className="ml-auto rounded border border-keep-accent/40 px-1 text-[10px] text-keep-accent"
            title="Delete your reply"
          >
            ×
          </button>
        ) : null}
      </div>
      {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
      <div
        className="prose prose-sm max-w-none text-sm"
        dangerouslySetInnerHTML={{ __html: reply.bodyHtml }}
      />
    </li>
  );
}
