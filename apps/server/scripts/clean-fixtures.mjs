// Remove leftover smoke-test data: duplicate nav_links, smoke-test users.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, "..", process.env.SQLITE_PATH ?? process.env.DATABASE_URL ?? "./data/thekeep.sqlite");
const db = new Database(dbPath);

console.log("--- before ---");
console.log("nav_links:", db.prepare("SELECT id,label,href,enabled FROM nav_links ORDER BY position").all());

// Drop ALL nav_links so the user starts clean.
const r = db.prepare("DELETE FROM nav_links").run();
console.log(`deleted ${r.changes} nav_links`);

console.log("--- after ---");
console.log("nav_links:", db.prepare("SELECT id,label,href FROM nav_links").all());
