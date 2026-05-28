/**
 * Client helpers for the Phase 3 user-uploaded reaction sheet flow.
 *
 * Wire shapes mirror the server payloads in
 * apps/server/src/routes/emoticons.ts. The user submits, the admin
 * moderation queue approves or rejects, and rejection refunds the
 * snapshotted cost back to the paying identity's pool.
 */

import { readError } from "./http.js";

export type EmoticonSubmissionStatus = "pending" | "approved" | "rejected";

/** One submission as viewed by the submitter. */
export interface MyEmoticonSubmission {
  id: string;
  slug: string;
  name: string;
  /** Relative URL under /uploads/emoticons/. Still set even after
   *  rejection (the row is retained for audit), but the image file
   *  itself has been deleted on rejection — the client should not
   *  attempt to render it for rejected rows. */
  imageUrl: string;
  cells: string[];
  status: EmoticonSubmissionStatus;
  submitterScope: "user" | "character" | null;
  submitterPoolId: string | null;
  /** Snapshot of the cost paid at submission time. The refund on
   *  rejection equals this exact value, even if the admin has
   *  retuned the catalog price in between. */
  costPaid: number | null;
  /** Set on rejection only. Surfaced in the user's "My uploads"
   *  list so they can see why and re-submit accordingly. */
  rejectionReason: string | null;
  reviewedAt: number | null;
  createdAt: number;
}

/** Admin view — includes a pre-resolved human-readable label for the
 *  submitter so the queue doesn't render bare uuids. */
export interface AdminEmoticonSubmission extends MyEmoticonSubmission {
  submitterLabel: string;
  /** users.id of the account that submitted (regardless of which of
   *  their identities paid). Distinct from `submitterPoolId` which
   *  is the character id under character-scope. */
  submitterUserId: string | null;
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as T;
}

/**
 * Submit a new reaction sheet for moderation. Server validates the
 * image (PNG/JPEG/WebP/GIF magic-bytes), debits the cost of
 * `flair_reaction_sheet` from the active identity's pool, and
 * inserts a pending row.
 *
 * Throws on:
 *   - slug already in use (409)
 *   - >= 3 pending submissions outstanding (429)
 *   - insufficient funds (402)
 *   - unsupported image type (415)
 *   - cosmetic disabled (503)
 */
export async function submitEmoticonSheet(payload: {
  slug: string;
  name: string;
  cells: string[];
  imageDataUrl: string;
  characterId: string | null;
}): Promise<{
  ok: true;
  submissionId: string;
  slug: string;
  status: EmoticonSubmissionStatus;
  costPaid: number;
}> {
  const r = await fetch("/me/emoticon-submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  return jsonOrThrow(r);
}

/** Caller's own submission list, any status, newest first. */
export async function fetchMyEmoticonSubmissions(): Promise<{ submissions: MyEmoticonSubmission[] }> {
  return jsonOrThrow(await fetch("/me/emoticon-submissions", { credentials: "include" }));
}

/** Admin moderation queue. Up to 50 most-recent submissions of any status. */
export async function fetchAdminEmoticonSubmissions(): Promise<{ submissions: AdminEmoticonSubmission[] }> {
  return jsonOrThrow(await fetch("/admin/emoticons/submissions", { credentials: "include" }));
}

export async function approveEmoticonSubmission(id: string): Promise<void> {
  const r = await fetch(`/admin/emoticons/submissions/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    credentials: "include",
  });
  if (!r.ok) throw new Error(await readError(r));
}

export async function rejectEmoticonSubmission(
  id: string,
  reason: string | null,
): Promise<{ ok: true; refundedAmount: number }> {
  const r = await fetch(`/admin/emoticons/submissions/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ ...(reason ? { reason } : {}) }),
  });
  return jsonOrThrow(r);
}
