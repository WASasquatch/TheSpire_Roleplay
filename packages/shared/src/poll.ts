/**
 * Poll posts — a `kind: "poll"` message that presents options to pick from,
 * then reveals tallies (and optionally who voted) once the viewer has voted.
 * One shared model for both chat rooms and forum boards.
 *
 * Persistence split:
 *   - `messages.pollDataJson` stores {@link PollData} — the static definition
 *     plus close-state (question rides `body` for chat / `title` for forum).
 *   - `poll_votes` rows are the mutable tally (one per voter+option), so
 *     concurrent voting never read-modify-writes a JSON array.
 *
 * The wire shape the client renders is {@link PollState}: the definition plus
 * resolved tallies and the viewer's own ballot, attached to `ChatMessage.poll`.
 */

/** Validation bounds, shared by the chat command, forum composer, and server. */
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_OPTION_MAX = 120;
export const POLL_QUESTION_MAX = 200;

export interface PollOption {
  /** Stable id (nanoid); votes reference this, not the option's text/index. */
  id: string;
  text: string;
}

/** The stored definition + close-state (the shape of `messages.pollDataJson`). */
export interface PollData {
  options: PollOption[];
  /** Voter may pick several options when true; exactly one when false. */
  allowMultiple: boolean;
  /** Author choice: reveal who voted for what (true) or counts only (false). */
  showVoters: boolean;
  /** Optional auto-close deadline (epoch ms); null = no deadline. */
  closesAt: number | null;
  /** Set when manually closed, or stamped when the deadline passes (epoch ms). */
  closedAt: number | null;
}

/** One voter shown under an option (only when the poll's showVoters is on). */
export interface PollVoter {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Resolved count for one option. `voters` present only when showVoters. */
export interface PollTally {
  optionId: string;
  count: number;
  voters?: PollVoter[];
}

/**
 * Per-viewer wire state attached to a poll message (`ChatMessage.poll`).
 * Carries the definition, the current tallies, and THIS viewer's ballot so
 * the client knows whether to reveal results (you've voted) and which
 * option(s) you picked.
 */
export interface PollState extends PollData {
  tallies: PollTally[];
  /** Distinct voters across the whole poll. */
  totalVoters: number;
  /** The option ids THIS viewer has selected (empty = hasn't voted). */
  myVote: string[];
}

/** ServerToClient `poll:update` payload — merged into `ChatMessage.poll`. */
export interface PollUpdate {
  messageId: string;
  tallies: PollTally[];
  totalVoters: number;
  /** Mirrors PollData.closedAt so a close propagates live. */
  closedAt: number | null;
}

/** A poll is closed when manually closed or its deadline has passed. */
export function isPollClosed(p: Pick<PollData, "closedAt" | "closesAt">, nowMs: number): boolean {
  if (p.closedAt != null) return true;
  if (p.closesAt != null && nowMs >= p.closesAt) return true;
  return false;
}
