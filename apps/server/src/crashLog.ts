/**
 * Durable crash diagnostics, survive Fly's "10 restarts → purged
 * logs" loop so we can actually see what killed the process.
 *
 * Problem this solves: when a Fly machine crashes 10 times in a
 * window, Fly stops auto-restarting and (importantly) drops the
 * machine's stdout/stderr scrollback. The "Logs from previous
 * starts" tab goes empty. The admin is left blind to the actual
 * cause of the loop.
 *
 * Approach: every crash signal we can intercept writes a JSON line
 * to `<sqlitePath>/../crash-log.jsonl`. The crash log lives on the
 * mounted /data volume next to the SQLite database, so it survives
 * container restarts AND Fly's log purge. Two consumers:
 *
 *   1. `GET /admin/diagnostics/crashes` (server-side route) reads
 *      recent entries for masteradmins. Works when the server is
 *      alive but past restarts left no fly-log trail.
 *   2. `node apps/server/scripts/print-crashes.mjs` is a standalone
 *      CLI you can run via `fly ssh console` even when the server
 *      itself won't start.
 *
 * Implementation notes:
 *   - All file I/O on the crash path is SYNCHRONOUS. `uncaughtException`
 *     and `unhandledRejection` handlers must complete BEFORE the
 *     process exits; async appendFile can lose the entry.
 *   - We rotate at 1 MB. The current file moves to `crash-log.jsonl.prev`;
 *     keep one previous generation so a long-running stable install
 *     doesn't grow the file unboundedly, but a brand-new crash storm
 *     can't immediately overwrite the previous round of context.
 *   - Entries include the Fly machine id + region so a cross-host
 *     stack trace dump (one entry per restart) is debuggable as a
 *     timeline.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const SQLITE_PATH = process.env.SQLITE_PATH ?? process.env.DATABASE_URL ?? "./data/thekeep.sqlite";
export const CRASH_LOG_PATH = resolve(dirname(SQLITE_PATH), "crash-log.jsonl");
export const PREV_LOG_PATH = CRASH_LOG_PATH + ".prev";
const ROTATE_AT_BYTES = 1_000_000;

const FLY_MACHINE_ID = process.env.FLY_MACHINE_ID ?? "";
const FLY_REGION = process.env.FLY_REGION ?? "";
const FLY_APP = process.env.FLY_APP_NAME ?? "";

/**
 * Discrete event kinds we record. Each tagged so the read-side can
 * filter ("show me only uncaughtException entries from the last day")
 * without parsing the message text.
 */
export type CrashKind =
  | "uncaughtException"
  | "unhandledRejection"
  | "signal"
  | "boot-start"
  | "boot-ok"
  | "boot-fail"
  | "migration-fail";

export interface CrashEntry {
  /** Date.now() at the moment of the event. */
  ts: number;
  kind: CrashKind;
  /** Signal name when kind === "signal" (SIGTERM, SIGINT, …). */
  signal?: string;
  /** Short human-readable message, the Error.message, the migration filename, etc. */
  message?: string;
  /** Full stack trace if available. */
  stack?: string;
  /** Free-form context the caller wanted persisted (env, URL, etc.). */
  context?: Record<string, unknown>;
  /** Fly machine id (empty string when not on Fly). */
  flyMachineId: string;
  /** Fly region (empty string when not on Fly). */
  flyRegion: string;
  /** Fly app name (empty string when not on Fly). */
  flyApp: string;
  /** PID of the process at write time. */
  pid: number;
  /** Process uptime in seconds at write time. Lets you tell "crashed during boot" from "crashed after running for 6 hours." */
  uptimeSec: number;
}

function rotateIfTooLarge(): void {
  try {
    if (!existsSync(CRASH_LOG_PATH)) return;
    const size = statSync(CRASH_LOG_PATH).size;
    if (size < ROTATE_AT_BYTES) return;
    try { if (existsSync(PREV_LOG_PATH)) unlinkSync(PREV_LOG_PATH); } catch { /* best effort */ }
    renameSync(CRASH_LOG_PATH, PREV_LOG_PATH);
  } catch { /* best effort, never throw from inside a crash handler */ }
}

/**
 * Synchronously append one crash entry. Safe to call from
 * `uncaughtException` / `unhandledRejection` / signal handlers.
 * Never throws, even if the disk is full or the volume is missing,
 * the worst case is a console.error and the original crash still
 * unwinds normally.
 */
export function writeCrashEntry(
  partial: Omit<CrashEntry, "ts" | "flyMachineId" | "flyRegion" | "flyApp" | "pid" | "uptimeSec">,
): void {
  try {
    const dir = dirname(CRASH_LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    rotateIfTooLarge();
    const entry: CrashEntry = {
      ts: Date.now(),
      ...partial,
      flyMachineId: FLY_MACHINE_ID,
      flyRegion: FLY_REGION,
      flyApp: FLY_APP,
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
    };
    appendFileSync(CRASH_LOG_PATH, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch (err) {
    // Last-ditch console log. Even if Fly's stdout is being purged
    // for this incident, the line still goes through the standard
    // pino/console pipe so a `fly logs` watcher catches it during a
    // live debug session.
    try { console.error("[crashLog] failed to write entry:", err); } catch { /* nothing */ }
  }
}

/**
 * Install global handlers. Idempotent, calling twice is fine but
 * only the first call binds. Returns the resolved log path so the
 * caller can log it on boot for sanity.
 *
 * Should be called as the VERY FIRST statement in the server entry
 * point so that any subsequent import that throws at module-eval
 * time is still captured.
 */
let installed = false;
export function installCrashHandlers(): string {
  if (installed) return CRASH_LOG_PATH;
  installed = true;

  process.on("uncaughtException", (err) => {
    writeCrashEntry({
      kind: "uncaughtException",
      message: err?.message ?? String(err),
      ...(err?.stack ? { stack: err.stack } : {}),
    });
    // Re-exit explicitly. Node's default behavior is to exit non-zero
    // on uncaughtException, but being explicit also documents intent
    // and avoids any version-drift surprises.
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    writeCrashEntry({
      kind: "unhandledRejection",
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
    });
    process.exit(1);
  });

  // Signals: log the event, then exit explicitly. Registering a
  // listener on a signal REPLACES Node's default "exit on receipt"
  // behavior, so if we just log and return, the event loop keeps
  // running (Fastify is still listening on the port) and Ctrl+C in
  // dev hangs until tsx sends SIGKILL after ~5s. We exit with code
  // 0 because a signal-driven shutdown is graceful, not a crash,
  // distinguishing "Fly stopped me" / "user pressed Ctrl+C" from a
  // real uncaughtException.
  //
  // The setImmediate gives in-flight microtasks (a Fastify response
  // body being written, a pending DB write) a single tick to finish
  // before the process drops. Not a full graceful drain, Fastify
  // doesn't know we're shutting down, but enough to avoid cutting
  // off a response mid-flush in the common case.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      writeCrashEntry({ kind: "signal", signal: sig });
      setImmediate(() => process.exit(0));
    });
  }

  return CRASH_LOG_PATH;
}

/**
 * Record a successful boot. Lets the log read like a timeline:
 *   boot-start → migration-fail | boot-fail | boot-ok → ... → exit
 *
 * If you see a stretch of `boot-start` entries with no matching
 * `boot-ok`, the server isn't getting to listen, usually a
 * migration or top-level import failure.
 */
export function recordBootStart(): void {
  writeCrashEntry({ kind: "boot-start" });
}

export function recordBootSuccess(context?: Record<string, unknown>): void {
  writeCrashEntry({
    kind: "boot-ok",
    ...(context ? { context } : {}),
  });
}

export function recordBootFailure(err: unknown, context?: Record<string, unknown>): void {
  const e = err instanceof Error ? err : new Error(String(err));
  writeCrashEntry({
    kind: "boot-fail",
    message: e.message,
    ...(e.stack ? { stack: e.stack } : {}),
    ...(context ? { context } : {}),
  });
}

/**
 * Read the most-recent-first N entries from both the current log
 * and (if needed) the rotated `.prev` log. Each line is parsed
 * independently; a malformed line is skipped silently rather than
 * tanking the whole read, the log writer should never produce them
 * but a partial write during a power loss could.
 */
export function readRecentCrashes(limit = 100): CrashEntry[] {
  const out: CrashEntry[] = [];
  for (const path of [CRASH_LOG_PATH, PREV_LOG_PATH]) {
    if (out.length >= limit) break;
    if (!existsSync(path)) continue;
    let content: string;
    try { content = readFileSync(path, "utf8"); } catch { continue; }
    // Lines are appended chronologically; reverse so the most recent
    // (== most relevant during a crash investigation) come first.
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const e = JSON.parse(line) as CrashEntry;
        out.push(e);
        if (out.length >= limit) break;
      } catch { /* skip malformed line */ }
    }
  }
  return out;
}
