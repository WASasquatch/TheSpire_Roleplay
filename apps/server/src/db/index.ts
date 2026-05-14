import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

// SQLITE_PATH is the canonical name. DATABASE_URL is kept as a fallback
// so existing local .env files keep working — flyctl flags any var named
// `DATABASE_URL` as "potentially sensitive" because it usually carries
// a Postgres-style connection string with credentials. Ours is just a
// filesystem path on the mounted volume, so the rename clears the
// warning without smuggling a non-secret into the secrets store.
const dbUrl = process.env.SQLITE_PATH ?? process.env.DATABASE_URL ?? "./data/thekeep.sqlite";
const dbPath = resolve(dbUrl);
const dbDir = dirname(dbPath);
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("synchronous = NORMAL");

export const db = drizzle(sqlite, { schema });
export { schema };
export type Db = typeof db;
