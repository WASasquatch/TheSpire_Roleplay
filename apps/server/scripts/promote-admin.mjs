// Promote a user to admin by username. Usage: node scripts/promote-admin.mjs <username>
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbUrl = process.env.SQLITE_PATH ?? process.env.DATABASE_URL ?? "./data/thekeep.sqlite";
const dbPath = resolve(__dirname, "..", dbUrl);

const username = process.argv[2];
if (!username) {
  console.error("usage: node promote-admin.mjs <username>");
  process.exit(1);
}

const db = new Database(dbPath);
const before = db
  .prepare("SELECT id, username, role FROM users WHERE lower(username) = ?")
  .get(username.toLowerCase());
if (!before) {
  console.error(`user not found: ${username}`);
  process.exit(2);
}
console.log("before:", before);
const r = db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(before.id);
console.log("updated rows:", r.changes);
const after = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(before.id);
console.log("after:", after);

// Invalidate any active sessions so the role refreshes on next request.
const sessR = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(before.id);
console.log("invalidated sessions:", sessR.changes);
