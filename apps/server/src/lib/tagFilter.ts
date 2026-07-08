import { sql, type AnyColumn, type SQL } from "drizzle-orm";

// Tags / content warnings are stored as comma-separated strings. To test
// membership we wrap BOTH the column value and the needle in commas so a
// search for `,courtly,` doesn't accidentally match `low-courtly` or similar
// substring overlaps. The needle is lowercased to match the `lower(col)`
// comparison; no LIKE-escaping is applied (tags are simple slugs).

/** Require the column's comma-list to contain `tag` (case-insensitive). */
export function tagIncludes(col: AnyColumn, tag: string): SQL {
  const needle = `%,${tag.toLowerCase()},%`;
  return sql`(',' || lower(${col}) || ',') LIKE ${needle}`;
}

/** Require the column's comma-list to NOT contain `cw` (case-insensitive). */
export function tagExcludes(col: AnyColumn, cw: string): SQL {
  const needle = `%,${cw.toLowerCase()},%`;
  return sql`(',' || lower(${col}) || ',') NOT LIKE ${needle}`;
}
