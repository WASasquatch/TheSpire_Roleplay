import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, "..", process.env.DATABASE_URL ?? "./data/thekeep.sqlite");
const db = new Database(dbPath);
const rows = db.prepare("SELECT id, name, type, (password_hash IS NOT NULL) AS has_pw, owner_id FROM rooms ORDER BY name").all();
console.log(rows);
