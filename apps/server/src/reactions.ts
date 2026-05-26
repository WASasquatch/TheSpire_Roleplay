import { and, asc, eq, inArray } from "drizzle-orm";
import type { ReactionEntry, ReactionTargetKind } from "@thekeep/shared";
import { EMOTICON_SHEET_CELL_COUNT } from "@thekeep/shared";
import { emoticonSheets, messageReactions } from "./db/schema.js";
import type { Db } from "./db/index.js";

/**
 * Parse the JSON-encoded `cells` column of an emoticon_sheets row.
 * Tolerant: a corrupted value returns an empty 16-slot grid instead
 * of throwing — the picker / sprite renderer treats those as hidden.
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
      createdAt: messageReactions.createdAt,
    })
    .from(messageReactions)
    .where(and(eq(messageReactions.targetKind, kind), inArray(messageReactions.targetId, targetIds)))
    .orderBy(asc(messageReactions.createdAt));
  if (rows.length === 0) return out;
  const sheetIds = [...new Set(rows.map((r) => r.sheetId))];
  const sheetRows = await db
    .select({ id: emoticonSheets.id, slug: emoticonSheets.slug, cells: emoticonSheets.cells })
    .from(emoticonSheets)
    .where(inArray(emoticonSheets.id, sheetIds));
  const sheetBySheetId = new Map(sheetRows.map((s) => [s.id, { slug: s.slug, cells: parseSheetCells(s.cells) }]));

  // Group key combines targetId + sheetSlug + cellIndex. Within a
  // group, reactors are accumulated in createdAt-asc order (the ORDER
  // BY above is the source of that ordering).
  function key(targetId: string, slug: string, cell: number): string {
    return `${targetId}|${slug}|${cell}`;
  }
  const grouped = new Map<string, ReactionEntry>();
  for (const r of rows) {
    const sheet = sheetBySheetId.get(r.sheetId);
    if (!sheet) continue; // Cascaded out from under us; skip orphan.
    const label = sheet.cells[r.cellIndex] ?? "";
    const k = key(r.targetId, sheet.slug, r.cellIndex);
    let entry = grouped.get(k);
    if (!entry) {
      entry = {
        sheetSlug: sheet.slug,
        cellIndex: r.cellIndex,
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
