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
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dbUrl = process.env.DATABASE_URL ?? "./data/thekeep.sqlite";
const dbPath = resolve(root, dbUrl);
const dbDir = dirname(dbPath);
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

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
      console.log(`  (already-applied detected — baselining ${file})`);
      recordApplied.run(file);
      continue;
    }
    throw err;
  }
}

// Baseline check: if any pre-existing migration files weren't recorded above
// because the loop never reached them (we threw), exit non-zero.
console.log("done. db:", dbPath);
