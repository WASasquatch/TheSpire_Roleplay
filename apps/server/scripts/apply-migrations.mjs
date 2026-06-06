// One-shot migration applier. Reads every .sql file in ./drizzle, splits on
// the `--> statement-breakpoint` marker drizzle-kit generates, and runs the
// statements with better-sqlite3.
//
// Drizzle-kit's `push` mishandles SQLite expression-based unique indexes
// (https://github.com/drizzle-team/drizzle-orm/issues/2470), so we lean on
// `generate` + this applier.
//
// We track applied filenames in a `_migrations` table so re-running is a
// no-op. (Older runs that pre-date this table are auto-baselined: any
// migration that throws "already exists" or "duplicate column name" on its
// first statement is recorded as applied.)
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dbUrl = process.env.SQLITE_PATH ?? process.env.DATABASE_URL ?? "./data/thekeep.sqlite";
const dbPath = resolve(root, dbUrl);
const dbDir = dirname(dbPath);
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

/* ============================================================
 *  Crash log writer (duplicated minimal version of
 *  apps/server/src/crashLog.ts)
 *
 *  This script runs BEFORE the server starts, so its crashes are
 *  the most-invisible class, Fly's "Logs from previous starts" tab
 *  goes empty after 10 restarts and an admin investigating a
 *  migration loop has no way to see what blew up.
 *
 *  We mirror the JSONL append-only format used by crashLog.ts so
 *  the server-side reader (/admin/diagnostics/crashes) AND the
 *  standalone CLI (print-crashes.mjs) handle both event sources
 *  uniformly. Keeping it inline (vs. importing a shared module)
 *  is intentional: the migration script must not depend on tsx,
 *  TypeScript compilation, or anything else that could itself be
 *  broken at boot.
 * ============================================================ */
const CRASH_LOG_PATH = resolve(dbDir, "crash-log.jsonl");
const PREV_LOG_PATH = CRASH_LOG_PATH + ".prev";
const ROTATE_AT_BYTES = 1_000_000;

function writeCrashEntry(partial) {
  try {
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    try {
      if (existsSync(CRASH_LOG_PATH) && statSync(CRASH_LOG_PATH).size >= ROTATE_AT_BYTES) {
        try { if (existsSync(PREV_LOG_PATH)) unlinkSync(PREV_LOG_PATH); } catch { /* nothing */ }
        renameSync(CRASH_LOG_PATH, PREV_LOG_PATH);
      }
    } catch { /* nothing */ }
    const entry = {
      ts: Date.now(),
      ...partial,
      flyMachineId: process.env.FLY_MACHINE_ID ?? "",
      flyRegion: process.env.FLY_REGION ?? "",
      flyApp: process.env.FLY_APP_NAME ?? "",
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
    };
    appendFileSync(CRASH_LOG_PATH, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch (err) {
    try { console.error("[migrate/crashLog] failed to write entry:", err); } catch { /* nothing */ }
  }
}

process.on("uncaughtException", (err) => {
  writeCrashEntry({
    kind: "migration-fail",
    message: `uncaughtException during migration: ${err?.message ?? String(err)}`,
    stack: err?.stack,
  });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  writeCrashEntry({
    kind: "migration-fail",
    message: `unhandledRejection during migration: ${err.message}`,
    stack: err.stack,
  });
  process.exit(1);
});

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS _migrations (
    filename TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
`);

const ALREADY_APPLIED = /already exists|duplicate column name/i;

const migrationsDir = resolve(root, "drizzle");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (!files.length) {
  console.error("no .sql files found in", migrationsDir);
  process.exit(1);
}

const isApplied = db.prepare("SELECT 1 FROM _migrations WHERE filename = ?");
const recordApplied = db.prepare(
  "INSERT OR IGNORE INTO _migrations (filename) VALUES (?)",
);

for (const file of files) {
  if (isApplied.get(file)) {
    console.log(`${file}: already recorded, skipping`);
    continue;
  }

  const sql = readFileSync(resolve(migrationsDir, file), "utf8");
  const stmts = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`applying ${file} (${stmts.length} statements)`);
  try {
    db.transaction(() => {
      for (const s of stmts) db.exec(s);
    })();
    recordApplied.run(file);
  } catch (err) {
    if (err instanceof Error && ALREADY_APPLIED.test(err.message)) {
      console.log(`  (already-applied detected, baselining ${file})`);
      recordApplied.run(file);
      continue;
    }
    // Persistent record of WHICH migration killed boot. The next
    // operator looking at `/admin/diagnostics/crashes` (or running
    // `node scripts/print-crashes.mjs` over fly ssh) gets the
    // filename + stack instead of a blank "Logs from previous
    // starts" tab.
    writeCrashEntry({
      kind: "migration-fail",
      message: `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
      stack: err instanceof Error ? err.stack : undefined,
      context: { file, stmtCount: stmts.length },
    });
    throw err;
  }
}

console.log("done. db:", dbPath);
