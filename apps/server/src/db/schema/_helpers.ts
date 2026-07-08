import { sql } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";

export const id = () => text("id").primaryKey();
export const ts = (name: string) =>
  integer(name, { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`);
