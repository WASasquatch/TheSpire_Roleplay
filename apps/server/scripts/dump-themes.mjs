import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, "..", process.env.DATABASE_URL ?? "./data/thekeep.sqlite");
const db = new Database(dbPath);

console.log("--- users with theme_json ---");
console.log(db.prepare("SELECT id, username, theme_json IS NOT NULL AS has_theme, active_character_id FROM users").all());

console.log("\n--- characters ---");
console.log(db.prepare("SELECT id, user_id, name, theme_json IS NOT NULL AS has_theme, theme_json FROM characters WHERE deleted_at IS NULL").all());
