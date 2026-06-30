/**
 * Poll server helpers — shared by the /poll command, the forum poll composer,
 * the vote/close socket handlers, and message hydration.
 *
 * The poll DEFINITION lives in `messages.pollDataJson` ({@link PollData}); the
 * tally is the `poll_votes` table (one row per voter+option). Reads here join
 * the two into the per-viewer {@link PollState} the client renders, revealing
 * voter identities only when the poll's `showVoters` is on.
 */
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  type PollData,
  type PollState,
  type PollTally,
} from "@thekeep/shared";
import type { Db } from "./db/index.js";
import { pollVotes, users } from "./db/schema.js";

/** Parse a stored pollDataJson; null on anything malformed. */
export function parsePollData(json: string | null | undefined): PollData | null {
  if (!json) return null;
  try {
    const d = JSON.parse(json) as PollData;
    if (!Array.isArray(d.options) || d.options.length < POLL_MIN_OPTIONS) return null;
    if (!d.options.every((o) => o && typeof o.id === "string" && typeof o.text === "string")) return null;
    return {
      options: d.options.map((o) => ({ id: o.id, text: o.text })),
      allowMultiple: !!d.allowMultiple,
      showVoters: !!d.showVoters,
      closesAt: typeof d.closesAt === "number" ? d.closesAt : null,
      closedAt: typeof d.closedAt === "number" ? d.closedAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Validate a poll definition from raw inputs and serialize it. Returns the
 * JSON string + parsed data, or an error message for the caller to surface.
 * Question is validated by the caller (it rides body/title); we cap it here
 * only when provided for a consistent message.
 */
export function buildPollData(input: {
  optionTexts: string[];
  allowMultiple: boolean;
  showVoters: boolean;
  closesAt: number | null;
  question?: string;
}): { ok: true; json: string; data: PollData } | { ok: false; error: string } {
  if (input.question !== undefined && input.question.trim().length > POLL_QUESTION_MAX) {
    return { ok: false, error: `Poll question is capped at ${POLL_QUESTION_MAX} characters.` };
  }
  const texts = input.optionTexts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (texts.length < POLL_MIN_OPTIONS) {
    return { ok: false, error: `A poll needs at least ${POLL_MIN_OPTIONS} options.` };
  }
  if (texts.length > POLL_MAX_OPTIONS) {
    return { ok: false, error: `A poll can have at most ${POLL_MAX_OPTIONS} options.` };
  }
  if (texts.some((t) => t.length > POLL_OPTION_MAX)) {
    return { ok: false, error: `Each option is capped at ${POLL_OPTION_MAX} characters.` };
  }
  const closesAt = input.closesAt != null && Number.isFinite(input.closesAt) && input.closesAt > Date.now()
    ? Math.round(input.closesAt)
    : null;
  const data: PollData = {
    options: texts.map((text) => ({ id: nanoid(8), text })),
    allowMultiple: input.allowMultiple,
    showVoters: input.showVoters,
    closesAt,
    closedAt: null,
  };
  return { ok: true, json: JSON.stringify(data), data };
}

/** Tally counts (+ voter identities when showVoters) across a poll's options. */
export async function loadPollTallies(
  db: Db,
  pollMessageId: string,
  data: PollData,
): Promise<{ tallies: PollTally[]; totalVoters: number }> {
  const rows = await db
    .select({ optionId: pollVotes.optionId, userId: pollVotes.userId })
    .from(pollVotes)
    .where(eq(pollVotes.pollMessageId, pollMessageId));

  const counts = new Map<string, number>();
  const votersByOption = new Map<string, string[]>();
  const distinct = new Set<string>();
  for (const r of rows) {
    counts.set(r.optionId, (counts.get(r.optionId) ?? 0) + 1);
    distinct.add(r.userId);
    if (data.showVoters) {
      const list = votersByOption.get(r.optionId) ?? [];
      list.push(r.userId);
      votersByOption.set(r.optionId, list);
    }
  }

  let info = new Map<string, { displayName: string; avatarUrl: string | null }>();
  if (data.showVoters && distinct.size) {
    const userRows = await db
      .select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, [...distinct]));
    info = new Map(userRows.map((u) => [u.id, { displayName: u.username, avatarUrl: u.avatarUrl ?? null }]));
  }

  const tallies: PollTally[] = data.options.map((o) => ({
    optionId: o.id,
    count: counts.get(o.id) ?? 0,
    ...(data.showVoters
      ? {
          voters: (votersByOption.get(o.id) ?? []).map((uid) => ({
            userId: uid,
            displayName: info.get(uid)?.displayName ?? "-",
            avatarUrl: info.get(uid)?.avatarUrl ?? null,
          })),
        }
      : {}),
  }));
  return { tallies, totalVoters: distinct.size };
}

/** Per-viewer poll state for one message (definition + tallies + my ballot). */
export async function loadPollState(
  db: Db,
  pollMessageId: string,
  viewerId: string | null,
  pollDataJson: string | null,
): Promise<PollState | null> {
  const data = parsePollData(pollDataJson);
  if (!data) return null;
  const { tallies, totalVoters } = await loadPollTallies(db, pollMessageId, data);
  let myVote: string[] = [];
  if (viewerId) {
    const mine = await db
      .select({ optionId: pollVotes.optionId })
      .from(pollVotes)
      .where(and(eq(pollVotes.pollMessageId, pollMessageId), eq(pollVotes.userId, viewerId)));
    myVote = mine.map((r) => r.optionId);
  }
  return { ...data, tallies, totalVoters, myVote };
}

/** Zero-tally state for a just-created poll (no votes yet). */
export function emptyPollState(pollDataJson: string): PollState | null {
  const data = parsePollData(pollDataJson);
  if (!data) return null;
  return {
    ...data,
    tallies: data.options.map((o) => ({ optionId: o.id, count: 0, ...(data.showVoters ? { voters: [] } : {}) })),
    totalVoters: 0,
    myVote: [],
  };
}
