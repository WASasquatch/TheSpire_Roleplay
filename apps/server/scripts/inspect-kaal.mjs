import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, "..", process.env.DATABASE_URL ?? "./data/thekeep.sqlite");
const db = new Database(dbPath);

const u = db.prepare("SELECT id, username, theme_json, active_character_id FROM users WHERE username='WAS'").get();
console.log("WAS user row:", u);

const c = db.prepare("SELECT id, user_id, name, theme_json FROM characters WHERE id=?").get(u.active_character_id);
console.log("\nactive character row:", c);

if (c?.theme_json) {
  console.log("\nparsed theme_json:", JSON.parse(c.theme_json));
}
