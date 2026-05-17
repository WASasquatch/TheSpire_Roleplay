/**
 * IC / OOC routing for the Earning award engine.
 *
 * The award engine credits different pools depending on the source of
 * the activity. The rule is *source-based* per plan.md:
 *
 *   IC chat → every logged-in character of the sending user at full
 *             configured rate. Master pool earns nothing.
 *   OOC chat / forum / OOC presence → master pool only. Characters
 *                                     earn nothing from OOC sources.
 *
 * What counts as "IC" depends on both the message kind *and* whether
 * the sender was attached as a character at send time. See
 * `routeMessage` for the precise rule.
 */

import type { MessageKind } from "@thekeep/shared";

/** Routing scope the award engine credits. */
export type AwardScope =
  | { kind: "character" }
  | { kind: "master" }
  | { kind: "none" }; // award nothing (system/cmd, or rule rejected)

/** Per-message classification. */
export type MessageSourceKind = "say" | "action" | "whisper" | "none";

/**
 * Classify the kind for award lookup. Maps the broad MessageKind enum
 * down to the three buckets the awards config models. `cmd` and
 * `system` return "none" — they never earn anything.
 *
 * - say          → `say`
 * - me, scene,
 *   npc, announce → `action`  (treated as the higher-effort author kind)
 * - whisper       → `whisper` (defaults to 0 in seed config; admin-tunable)
 * - ooc           → `say`     (still an authored line, just OOC-routed)
 * - roll          → `say`     (a /roll is still a chat post)
 * - cmd, system   → `none`    (engine-generated, never earns)
 */
export function messageSourceKind(kind: MessageKind): MessageSourceKind {
  switch (kind) {
    case "say":
    case "ooc":
    case "roll":
      return "say";
    case "me":
    case "scene":
    case "npc":
    case "announce":
      return "action";
    case "whisper":
      return "whisper";
    case "cmd":
    case "system":
    default:
      return "none";
  }
}

/**
 * Decide which scope a message awards to.
 *
 * Rule:
 *   - kind in {cmd, system} → none
 *   - kind === "ooc"        → master pool (OOC channel regardless of attached character)
 *   - kind === "whisper"    → master pool (private; routing matters only if whisper
 *                             awards are admin-enabled, which is off by default)
 *   - otherwise IC chat     → character pool when the sender had an active
 *                             character at send time; master pool otherwise
 *                             (a user posting OOC without an attached character)
 *
 * `characterId` here is the snapshot stored on the message row at
 * send time — same field the rest of the system uses for color /
 * avatar snapshots, so the routing decision is stable forever
 * regardless of later /char clears or character deletes.
 */
export function routeMessage(
  kind: MessageKind,
  characterId: string | null,
): AwardScope {
  if (kind === "cmd" || kind === "system") return { kind: "none" };
  if (kind === "ooc" || kind === "whisper") return { kind: "master" };
  return characterId ? { kind: "character" } : { kind: "master" };
}

/**
 * Convenience: forum activity is always master-pool in v1 (every board
 * is treated as OOC). When per-board IC flags ship later this becomes
 * a per-board lookup; for now it's a constant.
 */
export function routeForum(): AwardScope {
  return { kind: "master" };
}
