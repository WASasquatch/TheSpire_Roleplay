/**
 * Admin per-catalog export / import for the Earning system.
 *
 * Each catalog ships as a ZIP file that bundles:
 *   - manifest.json    catalog kind, format version, timestamps
 *   - rows.json        the full catalog rows (JSON array; timestamps stripped)
 *   - assets/...       any /uploads/* images the rows reference, packed at
 *                      their original relative paths so a round-trip
 *                      restores the URLs verbatim
 *
 * Import is UPSERT BY KEY — the admin's pre-import rows are preserved unless
 * the import file explicitly carries a row with the same primary key (in
 * which case the import wins). Rows NOT in the file are left alone, so a
 * partial import can't accidentally nuke a built-in catalog. Want a true
 * "full restore"? Export, edit, re-import.
 *
 * Image extraction: server-side we walk the imported assets/ entries and
 * write them into `uploads/<relative-path>` under the server's uploads root
 * (the same directory `/uploads/*` is served from). Existing files are
 * overwritten by hash — exports already produce content-addressed names for
 * uploaded images, so this is the desired behavior.
 */

import { and, asc, eq, isNotNull } from "drizzle-orm";
import JSZip from "jszip";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";
import { freeformBorders, items, nameStyles, rankTiers, ranks } from "../db/schema.js";

/** Current export format version. Bump on incompatible row-shape changes. */
const EXPORT_VERSION = 1;

/** Catalog kinds that have export/import endpoints. */
export type EarningCatalogKind = "name-styles" | "items" | "borders" | "ranks" | "freeform-borders";

/** Manifest baked into every export ZIP. */
interface ExportManifest {
  kind: EarningCatalogKind;
  version: number;
  exportedAt: number;
  /** Row count at export time. Diagnostic only — import re-counts. */
  rowCount: number;
}

interface ExportResult {
  /** Raw zip bytes — caller is responsible for streaming/encoding. */
  zip: Buffer;
  /** Suggested filename, e.g. `name-styles-export-20260527.zip`. */
  filename: string;
}

interface ImportResult {
  inserted: number;
  updated: number;
  skippedAssets: number;
  /** Asset paths that were written. Surfaced so the admin can spot which
   *  /uploads files just got overwritten by the import. */
  writtenAssets: string[];
  /** Soft errors that didn't abort the whole import (e.g. one row failed
   *  validation but the rest landed). */
  warnings: string[];
}

/* ============================================================
 *  EXPORT
 * ============================================================ */

export async function exportCatalog(
  db: Db,
  kind: EarningCatalogKind,
  uploadsRoot: string,
): Promise<ExportResult> {
  const zip = new JSZip();
  const exportedAt = Date.now();
  const yyyyMmDd = new Date(exportedAt).toISOString().slice(0, 10).replace(/-/g, "");

  let rowCount = 0;
  const referencedUploads = new Set<string>();

  if (kind === "name-styles") {
    const rows = await db.select().from(nameStyles).orderBy(asc(nameStyles.order));
    zip.file("rows.json", JSON.stringify(rows.map(stripTimestamps), null, 2));
    rowCount = rows.length;
    // Name styles are HTML+CSS only — no image refs.
  } else if (kind === "items") {
    const rows = await db.select().from(items).orderBy(asc(items.order));
    for (const r of rows) collectUploadPath(r.iconUrl, referencedUploads);
    zip.file("rows.json", JSON.stringify(rows.map(stripTimestamps), null, 2));
    rowCount = rows.length;
  } else if (kind === "ranks") {
    // Ranks ship with their tiers because a rank without tiers is
    // useless (the resolver requires at least Tier I to place
    // users). Bundle both tables side-by-side.
    const rankRows = await db.select().from(ranks).orderBy(asc(ranks.order));
    const tierRows = await db.select().from(rankTiers).orderBy(asc(rankTiers.rankKey), asc(rankTiers.tier));
    for (const r of tierRows) {
      collectUploadPath(r.sigilImageUrl, referencedUploads);
      collectUploadPath(r.borderImageUrl, referencedUploads);
    }
    zip.file("rows.json", JSON.stringify({
      ranks: rankRows.map(stripTimestamps),
      tiers: tierRows.map(stripTimestamps),
    }, null, 2));
    rowCount = rankRows.length + tierRows.length;
  } else if (kind === "borders") {
    // Borders = the BORDER-RELATED COLUMNS of rank_tiers (any tier
    // with a borderImageUrl OR a non-null borderCost). Importing
    // this kind only touches those columns — the rank structure
    // itself isn't disturbed.
    const tierRows = await db
      .select({
        rankKey: rankTiers.rankKey,
        tier: rankTiers.tier,
        borderImageUrl: rankTiers.borderImageUrl,
        borderCost: rankTiers.borderCost,
      })
      .from(rankTiers)
      .where(isNotNull(rankTiers.borderImageUrl))
      .orderBy(asc(rankTiers.rankKey), asc(rankTiers.tier));
    for (const r of tierRows) collectUploadPath(r.borderImageUrl, referencedUploads);
    zip.file("rows.json", JSON.stringify(tierRows, null, 2));
    rowCount = tierRows.length;
  } else if (kind === "freeform-borders") {
    // Free-form (non-rank-tied) borders catalog from migration 0149.
    // Each row carries EITHER an `imageUrl` OR a `template`+`styleCss`
    // pair (server enforces XOR). Image-mode rows reference a
    // /uploads/* path; template-mode rows are pure text. The
    // ownership ledgers are NOT exported — they're per-user state,
    // not catalog content.
    const rows = await db.select().from(freeformBorders).orderBy(asc(freeformBorders.order));
    for (const r of rows) collectUploadPath(r.imageUrl, referencedUploads);
    zip.file("rows.json", JSON.stringify(rows.map(stripTimestamps), null, 2));
    rowCount = rows.length;
  } else {
    throw new Error(`unknown catalog kind: ${kind as string}`);
  }

  // Bundle referenced uploads. Missing files are silently skipped
  // (the row may reference an asset that was deleted on disk but
  // not the DB) — the import side warns when an asset path in
  // rows.json has no zip entry.
  for (const rel of referencedUploads) {
    const abs = resolve(uploadsRoot, rel);
    if (!isWithin(uploadsRoot, abs)) continue; // safety: refuse traversal
    if (!existsSync(abs)) continue;
    try {
      const bytes = await readFile(abs);
      zip.file(`assets/${rel}`, bytes);
    } catch { /* unreadable; skip */ }
  }

  const manifest: ExportManifest = { kind, version: EXPORT_VERSION, exportedAt, rowCount };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return {
    zip: buf,
    filename: `${kind}-export-${yyyyMmDd}.zip`,
  };
}

/* ============================================================
 *  IMPORT
 * ============================================================ */

export async function importCatalog(
  db: Db,
  zipBytes: Buffer,
  uploadsRoot: string,
  expectedKind: EarningCatalogKind,
): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(zipBytes);
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw new Error("ZIP missing manifest.json");
  const manifest = JSON.parse(await manifestEntry.async("string")) as ExportManifest;

  if (typeof manifest.kind !== "string") throw new Error("manifest.kind missing");
  if (manifest.kind !== expectedKind) {
    throw new Error(
      `ZIP kind mismatch: file is '${manifest.kind}', upload slot is '${expectedKind}'. ` +
      "Re-upload through the matching catalog's Import button.",
    );
  }
  if (manifest.version !== EXPORT_VERSION) {
    throw new Error(
      `unsupported export version ${manifest.version} (expected ${EXPORT_VERSION}). ` +
      "Re-export from a server running the same Earning version, or upgrade this server.",
    );
  }

  const rowsEntry = zip.file("rows.json");
  if (!rowsEntry) throw new Error("ZIP missing rows.json");
  const rowsText = await rowsEntry.async("string");
  const rows: unknown = JSON.parse(rowsText);

  // Write assets first so a row that references an image lands
  // with the image already on disk. Refused if the entry tries to
  // escape the uploads root (path traversal defense).
  const written: string[] = [];
  let skippedAssets = 0;
  const assetEntries = Object.values(zip.files).filter((f) => f.name.startsWith("assets/") && !f.dir);
  for (const entry of assetEntries) {
    const rel = entry.name.slice("assets/".length);
    const abs = resolve(uploadsRoot, rel);
    if (!isWithin(uploadsRoot, abs)) { skippedAssets += 1; continue; }
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, await entry.async("nodebuffer"));
      written.push(`/uploads/${rel}`);
    } catch {
      skippedAssets += 1;
    }
  }

  const warnings: string[] = [];
  let inserted = 0;
  let updated = 0;

  if (manifest.kind === "name-styles") {
    if (!Array.isArray(rows)) throw new Error("rows.json must be an array for name-styles");
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      const key = String(row.key ?? "");
      if (!key) { warnings.push("skipping name-style row without key"); continue; }
      const existing = (await db.select({ k: nameStyles.key }).from(nameStyles).where(eq(nameStyles.key, key)).limit(1))[0];
      const values = {
        key,
        name: String(row.name ?? key),
        description: String(row.description ?? ""),
        template: String(row.template ?? ""),
        styleCss: String(row.styleCss ?? row.style_css ?? ""),
        cost: Number(row.cost ?? 0) || 0,
        enabled: row.enabled !== false,
        isBuiltin: row.isBuiltin === true || row.is_builtin === true,
        order: Number(row.order ?? 0) || 0,
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(nameStyles).set(values).where(eq(nameStyles.key, key));
        updated += 1;
      } else {
        await db.insert(nameStyles).values(values);
        inserted += 1;
      }
    }
  } else if (manifest.kind === "items") {
    if (!Array.isArray(rows)) throw new Error("rows.json must be an array for items");
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      const key = String(row.key ?? "");
      if (!key) { warnings.push("skipping item row without key"); continue; }
      const existing = (await db.select({ k: items.key }).from(items).where(eq(items.key, key)).limit(1))[0];
      const values = {
        key,
        name: String(row.name ?? key),
        namePlural: row.namePlural == null ? null : String(row.namePlural),
        description: String(row.description ?? ""),
        iconUrl: row.iconUrl == null ? null : String(row.iconUrl),
        price: Number(row.price ?? 0) || 0,
        stackLimit: Number(row.stackLimit ?? 99) || 99,
        giveMessagesJson: typeof row.giveMessagesJson === "string" ? row.giveMessagesJson : "[]",
        throwMessagesJson: typeof row.throwMessagesJson === "string" ? row.throwMessagesJson : "[]",
        dropMessagesJson: typeof row.dropMessagesJson === "string" ? row.dropMessagesJson : "[]",
        aliasesJson: typeof row.aliasesJson === "string" ? row.aliasesJson : "[]",
        category: String(row.category ?? "misc"),
        enabled: row.enabled !== false,
        forSale: row.forSale !== false,
        // Dates round-trip as ISO strings via JSON.stringify(Date),
        // so `Number(isoString)` is NaN. Hand the raw value (string OR
        // number) straight to the Date constructor — it parses ISO
        // strings AND treats numbers as unix ms. Anything else (object,
        // bool) becomes Invalid Date, which we coerce to null to avoid
        // poisoning the row.
        saleStartsAt: toDateOrNull(row.saleStartsAt),
        saleEndsAt: toDateOrNull(row.saleEndsAt),
        order: Number(row.order ?? 0) || 0,
        isBuiltin: row.isBuiltin === true,
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(items).set(values).where(eq(items.key, key));
        updated += 1;
      } else {
        await db.insert(items).values(values);
        inserted += 1;
      }
    }
  } else if (manifest.kind === "ranks") {
    if (!rows || typeof rows !== "object") throw new Error("rows.json must be {ranks,tiers} for ranks");
    const blob = rows as { ranks?: unknown[]; tiers?: unknown[] };
    for (const r of blob.ranks ?? []) {
      const row = r as Record<string, unknown>;
      const key = String(row.key ?? "");
      if (!key) { warnings.push("skipping rank without key"); continue; }
      const existing = (await db.select({ k: ranks.key }).from(ranks).where(eq(ranks.key, key)).limit(1))[0];
      const values = {
        key,
        name: String(row.name ?? key),
        order: Number(row.order ?? 0) || 0,
        enabled: row.enabled !== false,
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(ranks).set(values).where(eq(ranks.key, key));
        updated += 1;
      } else {
        await db.insert(ranks).values(values);
        inserted += 1;
      }
    }
    for (const r of blob.tiers ?? []) {
      const row = r as Record<string, unknown>;
      const rankKey = String(row.rankKey ?? "");
      const tier = Number(row.tier ?? 0);
      if (!rankKey || !tier) { warnings.push("skipping rank-tier without rankKey/tier"); continue; }
      // Tiers don't have a single PK we can blind-upsert against;
      // match on (rankKey, tier) which IS unique.
      const existing = (await db
        .select({ id: rankTiers.id })
        .from(rankTiers)
        .where(and(eq(rankTiers.rankKey, rankKey), eq(rankTiers.tier, tier)))
        .limit(1))[0];
      const values = {
        rankKey,
        tier,
        label: String(row.label ?? `Tier ${tier}`),
        xpThreshold: Number(row.xpThreshold ?? 0) || 0,
        sigilImageUrl: String(row.sigilImageUrl ?? ""),
        borderImageUrl: row.borderImageUrl == null ? null : String(row.borderImageUrl),
        borderCost: row.borderCost == null ? null : Number(row.borderCost),
        enabled: row.enabled !== false,
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(rankTiers).set(values).where(eq(rankTiers.id, existing.id));
        updated += 1;
      } else {
        await db.insert(rankTiers).values({ ...values, id: newRowId() });
        inserted += 1;
      }
    }
  } else if (manifest.kind === "borders") {
    if (!Array.isArray(rows)) throw new Error("rows.json must be an array for borders");
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      const rankKey = String(row.rankKey ?? "");
      const tier = Number(row.tier ?? 0);
      if (!rankKey || !tier) { warnings.push("skipping border without rankKey/tier"); continue; }
      // Border import is SURGICAL — it only touches borderImageUrl
      // and borderCost on an EXISTING rank_tier row. If the matching
      // (rankKey, tier) doesn't exist we skip (admin needs to create
      // the rank/tier first via a Ranks import or the admin UI).
      const existing = (await db
        .select({ id: rankTiers.id })
        .from(rankTiers)
        .where(and(eq(rankTiers.rankKey, rankKey), eq(rankTiers.tier, tier)))
        .limit(1))[0];
      if (!existing) {
        warnings.push(`borders: no rank_tier for (${rankKey}, ${tier}); skipped`);
        continue;
      }
      await db
        .update(rankTiers)
        .set({
          borderImageUrl: row.borderImageUrl == null ? null : String(row.borderImageUrl),
          borderCost: row.borderCost == null ? null : Number(row.borderCost),
          updatedAt: new Date(),
        })
        .where(eq(rankTiers.id, existing.id));
      updated += 1;
    }
  } else if (manifest.kind === "freeform-borders") {
    if (!Array.isArray(rows)) throw new Error("rows.json must be an array for freeform-borders");
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      const key = String(row.key ?? "");
      if (!key) { warnings.push("skipping freeform-border row without key"); continue; }
      // Enforce the XOR invariant the live admin endpoints check:
      // EITHER imageUrl OR template+styleCss, never both. An import
      // file that breaks this is malformed; we drop the row with a
      // warning rather than abort the whole import.
      const hasImage = row.imageUrl != null && String(row.imageUrl) !== "";
      const hasTemplate = row.template != null && String(row.template) !== "";
      if (hasImage && hasTemplate) {
        warnings.push(`freeform-border ${key}: both imageUrl and template set; skipped`);
        continue;
      }
      if (!hasImage && !hasTemplate) {
        warnings.push(`freeform-border ${key}: neither imageUrl nor template set; skipped`);
        continue;
      }
      const existing = (await db.select({ k: freeformBorders.key })
        .from(freeformBorders).where(eq(freeformBorders.key, key)).limit(1))[0];
      const values = {
        key,
        name: String(row.name ?? key),
        description: String(row.description ?? ""),
        imageUrl: hasImage ? String(row.imageUrl) : null,
        template: hasTemplate ? String(row.template) : null,
        styleCss: row.styleCss == null ? null : String(row.styleCss),
        rarity: String(row.rarity ?? "common"),
        cost: Number(row.cost ?? 0) || 0,
        enabled: row.enabled !== false,
        isBuiltin: row.isBuiltin === true || row.is_builtin === true,
        order: Number(row.order ?? 0) || 0,
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(freeformBorders).set(values).where(eq(freeformBorders.key, key));
        updated += 1;
      } else {
        await db.insert(freeformBorders).values(values);
        inserted += 1;
      }
    }
  } else {
    throw new Error(`unknown catalog kind in manifest: ${manifest.kind}`);
  }

  return { inserted, updated, skippedAssets, writtenAssets: written, warnings };
}

/* ============================================================
 *  Helpers
 * ============================================================ */

/** Strip timestamp columns so a round-trip doesn't shuffle createdAt forward. */
function stripTimestamps<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return rest;
}

/** If the URL is `/uploads/<rel>`, push `<rel>` into the set. */
function collectUploadPath(url: string | null | undefined, into: Set<string>): void {
  if (!url) return;
  if (!url.startsWith("/uploads/")) return;
  const rel = url.slice("/uploads/".length);
  if (rel) into.add(rel);
}

/** Defense against path-traversal in zip entries (`../../../etc/passwd`). */
function isWithin(root: string, candidate: string): boolean {
  const rootResolved = resolve(root) + "/";
  return candidate.startsWith(rootResolved);
}

function newRowId(): string {
  // Lightweight uid for new rank_tiers rows. Format is intentionally
  // not compatible with the existing nanoid IDs in the table — that's
  // fine because ids are opaque downstream.
  return randomBytes(12).toString("hex");
}

/**
 * Parse an unknown value into a Date or null. Handles the three shapes
 * a `timestamp_ms` column round-trips through:
 *   - number (unix ms; the on-disk format and what `+date` yields)
 *   - string (ISO; what `JSON.stringify(date)` produces — this is the
 *     case the previous `Number(value)` wrapper got wrong, yielding
 *     NaN → Invalid Date)
 *   - null/undefined/garbage → null
 */
function toDateOrNull(value: unknown): Date | null {
  if (value == null) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
