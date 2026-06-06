/**
 * Lifetime post-count bumper.
 *
 * The profile view used to compute its three activity counts (chat
 * messages, forum topics, forum replies) by `COUNT(*) FROM messages
 * WHERE …`. That number drifted DOWN every time a row was purged by
 * the retention sweep, soft-deleted by a mod, or cascade-removed with
 * a deleted room, which made the displayed activity an
 * artificially-low "what's still here" number instead of a real
 * "lifetime" stat.
 *
 * After migration 0176, both `users` and `characters` carry three
 * lifetime-counter columns. This module owns the increment side: the
 * caller classifies the message via `classifyMessageForLifetime` and
 * then `bumpLifetimeForMessage` writes a single +1 to whichever
 * counter the message belongs in. Increments only happen at insert
 * time; subsequent deletes never decrement.
 *
 * Whispers, system, cmd, and announce kinds are deliberately
 * excluded, they never contributed to the original COUNT() either
 * (whispers are private; system/cmd/announce are server chrome, not
 * the user's voice).
 */

import { sql, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { characters, users } from "../db/schema.js";

const CHAT_KINDS = new Set([
  "say", "me", "ooc", "roll", "scene", "npc",
]);

/** Which lifetime counter (if any) a given message qualifies for. */
export type LifetimeCategory = "chat" | "topic" | "reply" | null;

/**
 * Classify a freshly-accepted message insert into the lifetime
 * counter bucket it should bump. Returns null when the message
 * doesn't qualify for any counter (whispers, system noise, an
 * off-shape row in a wrongly-moded room, etc.), the caller skips
 * the write in that case.
 *
 * Logic mirrors `computeProfileMetrics` exactly so backfill and
 * forward-flow always agree on what each counter measures.
 */
export function classifyMessageForLifetime(input: {
  kind: string;
  replyMode: "flat" | "nested";
  isReply: boolean;
  hasTitle: boolean;
}): LifetimeCategory {
  if (input.replyMode === "flat") {
    if (input.isReply) return null;
    if (!CHAT_KINDS.has(input.kind)) return null;
    return "chat";
  }
  // nested
  if (input.isReply) return "reply";
  if (input.hasTitle) return "topic";
  return null;
}

/**
 * Increment the appropriate lifetime counter on the user (always) and
 * the character (when non-null). The user row always gets bumped so
 * the master-profile total stays "all activity across every identity
 * this account has"; the character row only when the message was
 * authored under that character.
 *
 * Idempotency: the caller MUST invoke this exactly once per accepted
 * message insert. There's no per-(user, message) de-dup here, that
 * would require an extra index lookup on the hot path, and the
 * insert callsites are countable on one hand.
 *
 * Failure mode: any DB error is swallowed and logged. A failed
 * counter bump shouldn't roll back an otherwise-successful message
 * insert; the lifetime number being one short of perfect is a
 * vastly better failure mode than a real message vanishing.
 */
export async function bumpLifetimeForMessage(
  db: Db,
  userId: string,
  characterId: string | null,
  category: LifetimeCategory,
): Promise<void> {
  if (category === null) return;
  try {
    if (category === "chat") {
      await db.update(users)
        .set({ lifetimeChatMessages: sql`${users.lifetimeChatMessages} + 1` })
        .where(eq(users.id, userId));
      if (characterId) {
        await db.update(characters)
          .set({ lifetimeChatMessages: sql`${characters.lifetimeChatMessages} + 1` })
          .where(eq(characters.id, characterId));
      }
    } else if (category === "topic") {
      await db.update(users)
        .set({ lifetimeForumTopics: sql`${users.lifetimeForumTopics} + 1` })
        .where(eq(users.id, userId));
      if (characterId) {
        await db.update(characters)
          .set({ lifetimeForumTopics: sql`${characters.lifetimeForumTopics} + 1` })
          .where(eq(characters.id, characterId));
      }
    } else {
      // reply
      await db.update(users)
        .set({ lifetimeForumReplies: sql`${users.lifetimeForumReplies} + 1` })
        .where(eq(users.id, userId));
      if (characterId) {
        await db.update(characters)
          .set({ lifetimeForumReplies: sql`${characters.lifetimeForumReplies} + 1` })
          .where(eq(characters.id, characterId));
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[lifetime-counts] bump failed", { userId, characterId, category, err });
  }
}
