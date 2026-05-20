/**
 * Single-slot in-memory lock for backup operations.
 *
 * Why only one at a time:
 *   - `VACUUM INTO` and full-DB upload both hold significant SQLite
 *     resources. Running two concurrently risks WAL contention and
 *     blows the response latency for ordinary requests on top of
 *     the already-significant event-loop blocking.
 *   - Pre-import auto-snapshots write into the same `/data/backups/`
 *     directory; two imports racing each other could collide on
 *     filename generation (timestamps with millisecond resolution).
 *   - Content imports hold a database transaction. A second import
 *     attempting to start while the first is mid-transaction would
 *     contend for the writer lock anyway — the in-memory check just
 *     makes that contention loud (clean 409 with a "still running"
 *     message) instead of silently blocking.
 *
 * The lock is in-memory, so it only protects against concurrent
 * attempts on a SINGLE server process. With multiple Fly machines
 * sharing a volume we'd want a file-based mutex; we currently run
 * one machine per app so that's not a concern.
 */

import type { BackupOperationKind, BackupOperationStatus } from "@thekeep/shared";

interface Slot {
  kind: BackupOperationKind;
  startedAt: number;
  message: string;
}

let slot: Slot | null = null;

/**
 * Try to acquire the lock for a new operation. Returns true on
 * success and stores the slot info; returns false when an
 * operation is already in flight. The caller MUST release in a
 * try/finally so a thrown error doesn't leave the lock held
 * forever.
 */
export function tryAcquire(kind: BackupOperationKind, message: string): boolean {
  if (slot !== null) return false;
  slot = { kind, startedAt: Date.now(), message };
  return true;
}

/** Update the in-flight slot's status message (e.g. switching from
 *  "running VACUUM INTO" to "moving snapshot into place"). Silently
 *  no-op when no slot is held (a stale caller). */
export function updateMessage(message: string): void {
  if (slot) slot.message = message;
}

/** Release the lock. Safe to call when no slot is held. */
export function release(): void {
  slot = null;
}

/** Snapshot of the current state for the GET /status endpoint. */
export function getStatus(): BackupOperationStatus {
  if (!slot) return { currentOperation: null };
  return {
    currentOperation: {
      kind: slot.kind,
      startedAt: slot.startedAt,
      message: slot.message,
    },
  };
}

/**
 * Wrapper that acquires + releases the lock around an async block.
 * Resolves to either { ok: true, value } or { ok: false, busy: status }
 * so callers can return a 409 cleanly without throwing.
 *
 * Errors thrown inside `fn` propagate after the lock is released —
 * the caller's try/catch sees the original error.
 */
export async function withLock<T>(
  kind: BackupOperationKind,
  message: string,
  fn: () => Promise<T>,
): Promise<
  | { ok: true; value: T }
  | { ok: false; busy: BackupOperationStatus }
> {
  if (!tryAcquire(kind, message)) {
    return { ok: false, busy: getStatus() };
  }
  try {
    const value = await fn();
    return { ok: true, value };
  } finally {
    release();
  }
}
