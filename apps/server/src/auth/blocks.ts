/**
 * Block relationships — the single source of truth every surface consults.
 *
 * A block is GLOBAL (keyed on master userId, spans all characters) and
 * MUTUAL: when A blocks B, neither account can see or interact with the other
 * anywhere. One directed row is written per initiation
 * (`blocks.blockerUserId` blocked `blocks.blockedUserId`), but the effect is
 * symmetric, so every helper here looks at BOTH directions.
 *
 * Contrast with `ignores` (one-way, message-only). Surfaces that already
 * filter by `ignores` should union the block set on top; surfaces that
 * resolve a name or list users for a viewer should drop anyone in the
 * viewer's block set.
 */
import { and, eq, or, inArray } from "drizzle-orm";
import { isModeratorRole, type Role } from "@thekeep/shared";
import { blocks, users } from "../db/schema.js";
import type { Db } from "../db/index.js";

/** The directed (blocker=x AND blocked=y) equality, factored out so the
 *  either-direction guard below reads as two clean halves of an OR. */
function directed(x: string, y: string) {
  return and(eq(blocks.blockerUserId, x), eq(blocks.blockedUserId, y));
}

/**
 * True when `targetUserId` may NOT be blocked: moderators and admins are
 * un-blockable. This makes both "a user can't block a mod/admin" and "a
 * mod/admin can't block another mod/admin" fall out of one rule, the target's
 * role is what matters, never the blocker's. Regular + trusted users stay
 * blockable. A missing user is treated as not-protected (the caller's own
 * existence checks handle that case).
 */
export async function isBlockProtected(db: Db, targetUserId: string): Promise<boolean> {
  const u = (await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1))[0];
  return !!u && isModeratorRole(u.role as Role);
}

/**
 * Every userId that `userId` is in a block with, in EITHER direction — i.e.
 * the complete set of accounts this viewer must not see and that must not see
 * them. Returns an empty Set when there are none (the common case).
 */
export async function blockedUserIdsFor(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ blocker: blocks.blockerUserId, blocked: blocks.blockedUserId })
    .from(blocks)
    .where(or(eq(blocks.blockerUserId, userId), eq(blocks.blockedUserId, userId)));
  const out = new Set<string>();
  for (const r of rows) {
    // Add whichever side ISN'T the viewer. (A self-row can't exist — POST
    // rejects self-block — but guarding keeps the viewer out of their own set.)
    if (r.blocker !== userId) out.add(r.blocker);
    if (r.blocked !== userId) out.add(r.blocked);
  }
  return out;
}

/**
 * True iff a block exists between `a` and `b` in either direction. Cheap
 * guard for resolve / send paths (whisper, DM, friend request, profile view).
 */
export async function isBlockedBetween(db: Db, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const row = (await db
    .select({ blocker: blocks.blockerUserId })
    .from(blocks)
    .where(or(directed(a, b), directed(b, a)))
    .limit(1))[0];
  return !!row;
}

/**
 * Batched block graph among a set of userIds: maps each userId to the set of
 * the OTHER ids (within the input) it's blocked with. Empty map when no input
 * pair is blocked — the presence fast-path keys off `.size === 0` to keep the
 * room-wide broadcast untouched in the overwhelmingly common no-blocks case.
 */
export async function blocksAmong(db: Db, userIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (userIds.length < 2) return out;
  const rows = await db
    .select({ blocker: blocks.blockerUserId, blocked: blocks.blockedUserId })
    .from(blocks)
    .where(and(
      inArray(blocks.blockerUserId, userIds),
      inArray(blocks.blockedUserId, userIds),
    ));
  const link = (x: string, y: string) => {
    const s = out.get(x) ?? new Set<string>();
    s.add(y);
    out.set(x, s);
  };
  for (const r of rows) {
    link(r.blocker, r.blocked);
    link(r.blocked, r.blocker);
  }
  return out;
}

/**
 * Record `blockerUserId` blocking `blockedUserId`. Idempotent
 * (`onConflictDoNothing`); returns true when a row was actually inserted so
 * callers can skip the live-refresh fan-out on a redundant block. Performs no
 * other mutation, friendships / DMs are kept and merely filtered while the
 * block stands (keep-but-hide).
 */
export async function createBlock(db: Db, blockerUserId: string, blockedUserId: string): Promise<boolean> {
  if (blockerUserId === blockedUserId) return false;
  const res = await db
    .insert(blocks)
    .values({ blockerUserId, blockedUserId })
    .onConflictDoNothing();
  return res.changes > 0;
}

/**
 * Remove the blocker's own block row. Returns true when a row was deleted.
 * Only the initiating side's row is touched, the blocked user can't undo a
 * block, and a reciprocal block (the other direction) is independent.
 */
export async function deleteBlock(db: Db, blockerUserId: string, blockedUserId: string): Promise<boolean> {
  const res = await db
    .delete(blocks)
    .where(and(eq(blocks.blockerUserId, blockerUserId), eq(blocks.blockedUserId, blockedUserId)));
  return res.changes > 0;
}
