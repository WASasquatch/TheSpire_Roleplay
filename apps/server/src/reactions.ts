import { and, asc, eq, inArray } from "drizzle-orm";
import type { ReactionEntry, ReactionRef, ReactionTargetKind } from "@thekeep/shared";
import {
  EMOTICON_SHEET_CELL_COUNT,
  lookupUnicodeEmojiCharByName,
  lookupUnicodeEmojiName,
  reactionRefKey,
} from "@thekeep/shared";
import { emoticonSheets, messageReactions } from "./db/schema.js";
import type { Db } from "./db/index.js";

/**
 * Parse the JSON-encoded `cells` column of an emoticon_sheets row.
 * Tolerant: a corrupted value returns an empty 16-slot grid instead
 * of throwing, the picker / sprite renderer treats those as hidden.
 */
export function parseSheetCells(raw: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return new Array(EMOTICON_SHEET_CELL_COUNT).fill(""); }
  if (!Array.isArray(parsed)) return new Array(EMOTICON_SHEET_CELL_COUNT).fill("");
  const out = parsed.slice(0, EMOTICON_SHEET_CELL_COUNT).map((v) => (typeof v === "string" ? v.trim() : ""));
  while (out.length < EMOTICON_SHEET_CELL_COUNT) out.push("");
  return out;
}

/**
 * Batch-load reactions for a set of target ids of a single kind. Returns
 * a Map keyed by `target_id` with the grouped ReactionEntry[] for each
 * target. Targets with no reactions are omitted from the map.
 *
 * One round-trip for reactions + one for the sheet labels. `viewerUserId`
 * (when present) is used to flag `viewerReacted` per-entry without a
 * separate scan on the client.
 *
 * Used by:
 *   - chat backlog (sendRoomBacklogTo) to embed reactions in the
 *     initial `message:bulk` payload
 *   - DM history GET to embed reactions in returned rows
 *   - GET /reactions/:kind/:id for cold refresh after a missed event
 *   - the toggle endpoint to return the fresh summary after a write
 */
export async function loadReactionsForTargets(
  db: Db,
  kind: ReactionTargetKind,
  targetIds: string[],
  viewerUserId: string | null,
): Promise<Map<string, ReactionEntry[]>> {
  const out = new Map<string, ReactionEntry[]>();
  if (targetIds.length === 0) return out;
  const rows = await db
    .select({
      targetId: messageReactions.targetId,
      userId: messageReactions.userId,
      characterId: messageReactions.characterId,
      displayName: messageReactions.displayName,
      sheetId: messageReactions.sheetId,
      cellIndex: messageReactions.cellIndex,
      unicodeChar: messageReactions.unicodeChar,
      createdAt: messageReactions.createdAt,
    })
    .from(messageReactions)
    .where(and(eq(messageReactions.targetKind, kind), inArray(messageReactions.targetId, targetIds)))
    .orderBy(asc(messageReactions.createdAt));
  if (rows.length === 0) return out;
  // Batched sheet lookup, only fires when at least one row is a
  // sheet-kind reaction. Unicode-only payloads don't need the
  // sheet table at all.
  const sheetIds = [...new Set(rows.map((r) => r.sheetId).filter((v): v is string => v != null))];
  const sheetBySheetId = new Map<string, { slug: string; cells: string[] }>();
  if (sheetIds.length > 0) {
    const sheetRows = await db
      .select({ id: emoticonSheets.id, slug: emoticonSheets.slug, cells: emoticonSheets.cells })
      .from(emoticonSheets)
      .where(inArray(emoticonSheets.id, sheetIds));
    for (const s of sheetRows) sheetBySheetId.set(s.id, { slug: s.slug, cells: parseSheetCells(s.cells) });
  }

  // Group key combines targetId + normalized ref key. The ref key
  // matches what the server's COALESCE unique index uses so the
  // grouping and the DB-level dedupe agree on what "same emoji"
  // means across both ref shapes.
  function groupKey(targetId: string, ref: ReactionRef): string {
    return `${targetId}|${reactionRefKey(ref)}`;
  }
  const grouped = new Map<string, ReactionEntry>();
  for (const r of rows) {
    // Resolve the ref shape. Server already enforces "exactly one"
    // at the toggle-route level; defensive `else` here skips
    // malformed rows so a manual DB edit can't crash the loader.
    let ref: ReactionRef;
    let label: string;
    // Empty / whitespace `unicodeChar` rows render as blank chips on
    // the client, they slipped past the route validation at some
    // point (likely a pre-rename catalog path that wrote the
    // shorthand name field by mistake; can also be a manual DB edit).
    // Treat them as if `unicodeChar` were NULL so the loader either
    // falls through to the sheet branch (rare; would imply both
    // columns set) or skips the row entirely.
    const cleanedUnicode = typeof r.unicodeChar === "string" && r.unicodeChar.trim() !== ""
      ? r.unicodeChar
      : null;
    if (cleanedUnicode != null) {
      // Repair legacy rows where an older picker / typeahead path
      // mistakenly stored the catalog NAME ("100", "smile") in
      // `unicode_char` instead of the actual codepoint ("💯",
      // "😄"). The reverse-lookup only matches exact catalog names,
      // so a free-form codepoint paste like "🦄" (which isn't in the
      // curated catalog) still falls through unchanged. New writes
      // go through the route's `unicodeChar` validation which is
      // also normalized below, so this branch only carries weight
      // for old rows.
      const repaired = lookupUnicodeEmojiCharByName(cleanedUnicode) ?? cleanedUnicode;
      ref = { kind: "unicode", char: repaired };
      label = lookupUnicodeEmojiName(repaired) ?? repaired;
    } else if (r.sheetId != null && r.cellIndex != null) {
      const sheet = sheetBySheetId.get(r.sheetId);
      if (!sheet) continue; // Cascaded out; skip orphan.
      ref = { kind: "sheet", sheetSlug: sheet.slug, cellIndex: r.cellIndex };
      label = sheet.cells[r.cellIndex] ?? "";
    } else {
      continue;
    }
    const k = groupKey(r.targetId, ref);
    let entry = grouped.get(k);
    if (!entry) {
      entry = {
        ref,
        label,
        reactors: [],
        viewerReacted: false,
      };
      grouped.set(k, entry);
      const list = out.get(r.targetId) ?? [];
      list.push(entry);
      out.set(r.targetId, list);
    }
    entry.reactors.push({
      userId: r.userId,
      characterId: r.characterId,
      displayName: r.displayName,
      reactedAt: +r.createdAt,
    });
    if (viewerUserId && r.userId === viewerUserId) entry.viewerReacted = true;
  }
  return out;
}
