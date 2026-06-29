import { nanoid } from "nanoid";
import { eq, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AuditAction } from "@thekeep/shared";
import { auditLog } from "./db/schema.js";
import type { Db } from "./db/index.js";

/**
 * Append an entry to the audit log. Called from every mod/admin command and
 * admin route that mutates moderation state. Best-effort: a logging error
 * doesn't fail the moderation action it's recording, but we surface it via
 * pino so the operator sees it.
 *
 * Privacy contract:
 *   - Never put whisper bodies, private-room message contents, or any other
 *     content the actor wouldn't have been authorized to see into `reason`
 *     or `metadata`.
 *   - The `target_message_id` FK is kept as-is for public messages; resolving
 *     it back to body happens at read time and that resolver enforces the
 *     "public room only" rule (see routes/admin reports/audit handlers).
 *
 * Scope: this PLATFORM path always leaves `server_id` NULL — the entry lands
 * in the global Audit feed. Server-scoped moderation calls go through
 * {@link auditServerAction} instead, which stamps `server_id` so the row falls
 * OUT of the global feed and INTO the owning server's Mod Log. `recordAudit`
 * itself is unchanged for platform actions.
 */
export async function recordAudit(
  db: Db,
  entry: {
    actorUserId: string;
    action: AuditAction;
    targetUserId?: string | null;
    targetRoomId?: string | null;
    targetMessageId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: nanoid(),
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetUserId: entry.targetUserId ?? null,
      targetRoomId: entry.targetRoomId ?? null,
      targetMessageId: entry.targetMessageId ?? null,
      reason: entry.reason ?? null,
      metadataJson: entry.metadata ? JSON.stringify(entry.metadata) : null,
    });
  } catch (err) {
    // Logging the failure but not rethrowing - the moderation action
    // already happened and rolling back over a missed audit row would be
    // worse than the missed row.
    // eslint-disable-next-line no-console
    console.error("[audit] failed to record entry", { action: entry.action, err });
  }
}

/**
 * Append a SERVER-SCOPED audit entry (multi-server lift, Phase 5). Identical
 * to {@link recordAudit} except it stamps `audit_log.server_id`, which:
 *   - EXCLUDES the row from the global Audit feed (the global read filters
 *     `server_id IS NULL`, see {@link globalAuditScopeWhere}), and
 *   - INCLUDES it in the owning server's per-server Mod Log (which filters by
 *     `server_id = <id>`, see {@link serverModLogScopeWhere}).
 *
 * Same privacy contract as `recordAudit`. Used by every server-scoped
 * moderation write (room/message moderation, membership, bans, settings) so
 * §9.8's "stamp server_id at every server-scoped write" holds going forward.
 * Best-effort, never throws.
 */
export async function auditServerAction(
  db: Db,
  entry: {
    serverId: string;
    actorUserId: string;
    action: AuditAction;
    targetUserId?: string | null;
    targetRoomId?: string | null;
    targetMessageId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: nanoid(),
      serverId: entry.serverId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetUserId: entry.targetUserId ?? null,
      targetRoomId: entry.targetRoomId ?? null,
      targetMessageId: entry.targetMessageId ?? null,
      reason: entry.reason ?? null,
      metadataJson: entry.metadata ? JSON.stringify(entry.metadata) : null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[audit] failed to record server entry", { serverId: entry.serverId, action: entry.action, err });
  }
}

/**
 * Read-path scope predicate for the GLOBAL Audit feed: platform-owned rows
 * only (`server_id IS NULL`). Server-scoped moderation lands in the owning
 * server's Mod Log instead and must never bleed into the platform feed. Append
 * this to the existing condition list in the `/admin/audit` query.
 *
 * FLAG NOTE: every legacy and platform row has `server_id` NULL (the column
 * defaults NULL and only `auditServerAction` ever sets it), so applying this
 * filter is a no-op against today's data — the global feed shows exactly the
 * same rows until a server-scoped write actually happens.
 */
export function globalAuditScopeWhere(): SQL {
  return isNull(auditLog.serverId);
}

/**
 * The mirror predicate for a per-server Mod Log read: rows stamped with THIS
 * server's id. Lives here so the global-exclusion and server-inclusion rules
 * stay in one file and can never drift apart.
 */
export function serverModLogScopeWhere(serverId: string): SQL {
  return eq(auditLog.serverId, serverId);
}

/* ============================================================
 * Mod Log metadata-visibility filter (plan §9.8)
 *
 * A per-server Mod Log is read by the SERVER's owner/mods, who are NOT
 * platform staff. The raw audit metadata can carry implementation detail or
 * cross-surface ids that a non-platform owner has no business seeing (and, for
 * non-server-scoped action shapes, raw bodies). So the per-server read path
 * runs each row's parsed metadata through an ALLOWLIST: only the fields
 * explicitly surfaced for that action survive; everything else is stripped.
 *
 * Platform staff reading the GLOBAL feed are unaffected — they see metadata
 * verbatim, exactly as today. This filter applies ONLY on the per-server Mod
 * Log path for a non-platform owner.
 * ============================================================ */

/**
 * Per-action allowlist of metadata keys safe to surface to a non-platform
 * server owner in their Mod Log. Anything not listed is stripped. Actions
 * absent from this map surface NO metadata (safe default) — a server owner
 * sees the action/actor/target/time, not the raw blob.
 *
 * Deliberately conservative: room/topic moderation shows the human-meaningful
 * bits (title, lock/sticky state, category move endpoints); never raw bodies,
 * never cross-server foreign ids beyond the scoping ones the server already
 * owns.
 */
const SERVER_MOD_LOG_METADATA_ALLOWLIST: Partial<Record<AuditAction, readonly string[]>> = {
  forum_post_delete: ["isTopic", "title"],
  forum_topic_lock: ["locked", "title"],
  forum_topic_sticky: ["sticky", "title"],
  forum_topic_move: ["from", "to", "toBoard", "fromBoard", "title"],
  mod_case_create: ["id", "kind"],
  mod_case_update: ["id", "statusChange", "keys"],
  mod_case_delete: ["id"],
  report_resolve: ["reportId"],
  report_dismiss: ["reportId"],
};

/**
 * Apply the per-server Mod Log metadata-visibility filter (§9.8) to a single
 * parsed metadata object for a non-platform owner. Returns a NEW object
 * containing only the allowlisted keys for that action (or null when nothing
 * survives). Platform-staff reads of the global feed should NOT call this.
 */
export function filterServerModLogMetadata(
  action: AuditAction,
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const allow = SERVER_MOD_LOG_METADATA_ALLOWLIST[action];
  if (!allow || allow.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const key of allow) {
    if (key in metadata && metadata[key] !== undefined) out[key] = metadata[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}
