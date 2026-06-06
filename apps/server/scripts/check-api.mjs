// Borrow WAS's most recent session cookie and hit the same endpoints the
// browser would, to see exactly what the client receives.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, "..", process.env.SQLITE_PATH ?? process.env.DATABASE_URL ?? "./data/thekeep.sqlite");
const db = new Database(dbPath);

const sess = db
  .prepare(`
    SELECT s.id, s.user_id, u.username, u.active_character_id
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE u.username = 'WAS' AND s.expires_at > unixepoch() * 1000
    ORDER BY s.created_at DESC
    LIMIT 1
  `)
  .get();

if (!sess) {
  console.error("no active session for WAS, log in once and retry");
  process.exit(1);
}

const cookie = `tk_sess=${sess.id}`;
console.log("using cookie:", cookie.slice(0, 20) + "…");

const me = await (await fetch("http://127.0.0.1:3001/me/profile", { headers: { Cookie: cookie } })).json();
console.log("\n=== /me/profile ===");
console.log(JSON.stringify(me, null, 2));

if (me.activeCharacterId) {
  const c = await (await fetch(`http://127.0.0.1:3001/characters/${me.activeCharacterId}`, { headers: { Cookie: cookie } })).json();
  console.log("\n=== /characters/:id ===");
  console.log(JSON.stringify(c, null, 2));
}
