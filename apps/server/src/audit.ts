import { nanoid } from "nanoid";
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
