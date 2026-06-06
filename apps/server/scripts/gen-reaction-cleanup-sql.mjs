// One-shot generator: extracts every (name → char) pair from the
// curated unicode emoji catalog in shared and emits SQL that
// rewrites any `message_reactions.unicode_char` row whose value is a
// catalog name into the actual codepoint. Used to produce migration
// 0185 once; not run at deploy time. Run with:
//   node apps/server/scripts/gen-reaction-cleanup-sql.mjs > apps/server/drizzle/0185_reaction_name_to_char.sql
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = resolve(here, "../../../packages/shared/src/unicodeEmoji.ts");
const src = readFileSync(catalog, "utf8");

// Match `{ char: "X", name: "Y", ... }`, tolerant of whitespace
// + the trailing tags field.
const re = /\{\s*char:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"/g;
const pairs = [];
let m;
while ((m = re.exec(src)) !== null) {
  pairs.push([m[2], m[1]]); // [name, char]
}

function sqlQuote(s) {
  // SQLite string literal: double up single quotes.
  return "'" + s.replace(/'/g, "''") + "'";
}

const valuesBody = pairs
  .map(([n, c], i) => `  (${sqlQuote(n)}, ${sqlQuote(c)})${i === pairs.length - 1 ? "" : ","}`)
  .join("\n");

const out =
`-- Repair message_reactions rows where unicode_char accidentally
-- stored the catalog NAME instead of the codepoint. The route +
-- the reactions loader both normalize lazily now, but this
-- migration physically rewrites the column so the unique index
-- (which keys on the literal value) dedupes correctly going forward.
--
-- Generated from packages/shared/src/unicodeEmoji.ts (${pairs.length} entries).
-- Re-run apps/server/scripts/gen-reaction-cleanup-sql.mjs if the
-- catalog changes and an older curated mapping needs the same
-- treatment.
--
-- Strategy:
--   1. UPDATE OR IGNORE rewrites every row whose unicode_char is a
--      known catalog name. The OR IGNORE skips rows that would
--      collide with an already-correct row on the unique index,
--      same (target, user, target_id) with both the broken and the
--      fixed value sitting in the table.
--   2. A trailing DELETE removes the still-broken stragglers so the
--      table only carries codepoint-shaped values from here on.

WITH name_to_char(name, char) AS (VALUES
${valuesBody}
)
UPDATE OR IGNORE \`message_reactions\`
   SET \`unicode_char\` = (
         SELECT \`char\` FROM name_to_char
          WHERE name_to_char.\`name\` = \`message_reactions\`.\`unicode_char\`
       )
 WHERE \`unicode_char\` IN (SELECT \`name\` FROM name_to_char);
--> statement-breakpoint

-- Sweep any row left behind by the OR IGNORE, it didn't migrate
-- because a correct row already existed for the same target + user.
WITH name_to_char(name, char) AS (VALUES
${valuesBody}
)
DELETE FROM \`message_reactions\`
 WHERE \`unicode_char\` IN (SELECT \`name\` FROM name_to_char);
`;

process.stdout.write(out);
