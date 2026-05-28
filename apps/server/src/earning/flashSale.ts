/**
 * Flash-sale resolver.
 *
 * One row per UTC date in `flash_sales`. Written lazily on the first
 * read of the day — no background cron, no scheduled job. The
 * resolver picks (random per category, unless an admin override row
 * for that date exists in `flash_sale_overrides`), upserts the
 * resolved picks into `flash_sales`, and returns the row.
 *
 * Why on-demand instead of a daily timer: nothing actually NEEDS to
 * happen at midnight UTC until a user opens the Earning dashboard or
 * a purchase route checks for a discount. Lazy resolution means a
 * server that's idle at midnight doesn't burn anything, the
 * resolution is deterministic per day (a second reader gets the same
 * picks via the row that's now in the table), and we never have to
 * babysit a long-running interval. The downside — a stale process
 * could in theory pick at 23:59 and then the date rolls over at
 * 00:00:01 — is bounded to one second per day and self-corrects on
 * the next read.
 *
 * Snapshotting discount: the effective discount % is stored on the
 * `flash_sales` row at pick time (either the override's value or the
 * global default at that moment). An admin tweak to the default
 * after the fact does NOT silently re-price an active sale.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  cosmetics,
  flashSaleOverrides,
  flashSales,
  freeformBorders,
  items,
  nameStyles,
  siteSettings,
} from "../db/schema.js";

export type FlashSaleCategory = "name_style" | "item" | "cosmetic" | "freeform_border";

export interface FlashSaleRow {
  forDate: string;
  nameStyleKey: string | null;
  itemKey: string | null;
  cosmeticKey: string | null;
  freeformBorderKey: string | null;
  nameStyleDiscountPct: number | null;
  itemDiscountPct: number | null;
  cosmeticDiscountPct: number | null;
  freeformBorderDiscountPct: number | null;
}

/**
 * Today's date in UTC, as 'YYYY-MM-DD'. Pure UTC so the rollover is
 * the same instant for every server in every region — admins who
 * queue an override "for tomorrow" don't need to think about which
 * timezone the resolver will run in.
 */
export function todayUtc(now: Date = new Date()): string {
  // toISOString returns 'YYYY-MM-DDTHH:mm:ss.sssZ' — slice the date.
  return now.toISOString().slice(0, 10);
}

/** UTC date offset by `days` from `now`. Used for "tomorrow" admin queues. */
export function dateOffsetUtc(days: number, now: Date = new Date()): string {
  const t = new Date(now.getTime() + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/**
 * Resolve today's flash sale row. Reads `flash_sales` first; if no
 * row exists yet for today's UTC date, picks, inserts, and returns.
 *
 * The pick logic per category:
 *   1. Check `flash_sale_overrides` for (category, today). If found,
 *      use that target_key + discount.
 *   2. Otherwise, if the site setting for that category is enabled,
 *      pick a random eligible row from the catalog.
 *   3. Otherwise, leave that category's pick NULL.
 *
 * "Eligible" rules per catalog:
 *   - name_styles: enabled, cost > 0 (free styles aren't worth
 *     flash-saling — no discount to apply).
 *   - items: enabled, for_sale, cost > 0, and within any
 *     existing sale_starts_at/sale_ends_at window if set.
 *   - cosmetics: enabled, cost > 0.
 *
 * Race posture: concurrent first-readers can both reach the
 * SELECT-then-INSERT path. The INSERT uses ON CONFLICT DO NOTHING
 * on (for_date); the loser's INSERT is a no-op, and both readers
 * re-SELECT the winner's row before returning. Same pattern
 * `ensureConversation` uses elsewhere — single round trip on the
 * happy path, safe under concurrent first-message races.
 */
export async function resolveTodayFlashSale(
  db: Db,
  now: Date = new Date(),
): Promise<FlashSaleRow> {
  const forDate = todayUtc(now);
  // Fast path: today's row already exists.
  const existing = (await db
    .select()
    .from(flashSales)
    .where(eq(flashSales.forDate, forDate))
    .limit(1))[0];
  if (existing) {
    // Backfill any categories that landed null on a pre-migration row.
    // When a new category column was added (e.g. `freeform_border_key`
    // in migration 0160), existing rows for today filled with null —
    // the resolver's old fast path returned them as-is forever,
    // leaving the new category silently missing from the user-facing
    // Flash Sale. Fill the gaps lazily on the first read after deploy
    // so today's row catches up without an admin having to wipe and
    // re-pick. Subsequent reads see all slots populated and skip
    // this work on the fast path.
    const filled = await fillMissingCategories(db, existing, forDate);
    return toFlashSaleRow(filled);
  }

  // Cold path: pick + insert. Reads site settings + overrides +
  // catalogs, then atomically tries to claim today's row. If
  // another tab won the race, re-read and return its picks.
  const settings = (await db.select().from(siteSettings).limit(1))[0];
  const defaultPct = settings?.flashSaleDefaultDiscountPct ?? 25;

  const overrideRows = await db
    .select()
    .from(flashSaleOverrides)
    .where(eq(flashSaleOverrides.forDate, forDate));
  const overrides = new Map<FlashSaleCategory, { targetKey: string; discountPct: number | null }>();
  for (const r of overrideRows) {
    overrides.set(r.category as FlashSaleCategory, {
      targetKey: r.targetKey,
      discountPct: r.discountPct,
    });
  }

  const stylesOn = settings?.flashSaleStylesEnabled ?? true;
  const itemsOn = settings?.flashSaleItemsEnabled ?? true;
  const cosmeticsOn = settings?.flashSaleCosmeticsEnabled ?? true;
  const freeformBordersOn = settings?.flashSaleFreeformBordersEnabled ?? true;

  // Per-category pick. `pickCategory` returns the target key and
  // the effective discount (snapshotted) — null target means "no
  // pick today" (category disabled or catalog empty).
  const stylePick = await pickCategory(db, "name_style", stylesOn, overrides, defaultPct);
  const itemPick = await pickCategory(db, "item", itemsOn, overrides, defaultPct);
  const cosmeticPick = await pickCategory(db, "cosmetic", cosmeticsOn, overrides, defaultPct);
  const freeformBorderPick = await pickCategory(db, "freeform_border", freeformBordersOn, overrides, defaultPct);

  // Atomic claim. The unique PK on (for_date) means only one
  // INSERT can land; the loser of a race silently no-ops and
  // we re-read to inherit the winner's picks.
  await db
    .insert(flashSales)
    .values({
      forDate,
      nameStyleKey: stylePick.targetKey,
      itemKey: itemPick.targetKey,
      cosmeticKey: cosmeticPick.targetKey,
      freeformBorderKey: freeformBorderPick.targetKey,
      nameStyleDiscountPct: stylePick.discountPct,
      itemDiscountPct: itemPick.discountPct,
      cosmeticDiscountPct: cosmeticPick.discountPct,
      freeformBorderDiscountPct: freeformBorderPick.discountPct,
    })
    .onConflictDoNothing({ target: flashSales.forDate });

  const final = (await db
    .select()
    .from(flashSales)
    .where(eq(flashSales.forDate, forDate))
    .limit(1))[0];
  return toFlashSaleRow(final!);
}

/**
 * Lazy backfill — when today's `flash_sales` row was written before a
 * new category column existed (the column ALTERed in later with a
 * default of NULL), the row's slot for that category is null and
 * `toFlashSaleRow` would surface that as "no pick today" forever.
 * Re-run the per-category pick for null slots whose category is
 * currently enabled, then UPDATE the row in place. Subsequent reads
 * see the populated slots and skip this work.
 */
async function fillMissingCategories(
  db: Db,
  row: typeof flashSales.$inferSelect,
  forDate: string,
): Promise<typeof flashSales.$inferSelect> {
  // Cheap check first — only fall through to the settings/overrides
  // lookups when at least one slot is actually empty.
  if (row.nameStyleKey && row.itemKey && row.cosmeticKey && row.freeformBorderKey) {
    return row;
  }
  const settings = (await db.select().from(siteSettings).limit(1))[0];
  const defaultPct = settings?.flashSaleDefaultDiscountPct ?? 25;
  const overrideRows = await db
    .select()
    .from(flashSaleOverrides)
    .where(eq(flashSaleOverrides.forDate, forDate));
  const overrides = new Map<FlashSaleCategory, { targetKey: string; discountPct: number | null }>();
  for (const r of overrideRows) {
    overrides.set(r.category as FlashSaleCategory, {
      targetKey: r.targetKey,
      discountPct: r.discountPct,
    });
  }
  const patch: Partial<typeof flashSales.$inferInsert> = {};
  if (!row.nameStyleKey && (settings?.flashSaleStylesEnabled ?? true)) {
    const pick = await pickCategory(db, "name_style", true, overrides, defaultPct);
    if (pick.targetKey) {
      patch.nameStyleKey = pick.targetKey;
      patch.nameStyleDiscountPct = pick.discountPct;
    }
  }
  if (!row.itemKey && (settings?.flashSaleItemsEnabled ?? true)) {
    const pick = await pickCategory(db, "item", true, overrides, defaultPct);
    if (pick.targetKey) {
      patch.itemKey = pick.targetKey;
      patch.itemDiscountPct = pick.discountPct;
    }
  }
  if (!row.cosmeticKey && (settings?.flashSaleCosmeticsEnabled ?? true)) {
    const pick = await pickCategory(db, "cosmetic", true, overrides, defaultPct);
    if (pick.targetKey) {
      patch.cosmeticKey = pick.targetKey;
      patch.cosmeticDiscountPct = pick.discountPct;
    }
  }
  if (!row.freeformBorderKey && (settings?.flashSaleFreeformBordersEnabled ?? true)) {
    const pick = await pickCategory(db, "freeform_border", true, overrides, defaultPct);
    if (pick.targetKey) {
      patch.freeformBorderKey = pick.targetKey;
      patch.freeformBorderDiscountPct = pick.discountPct;
    }
  }
  if (Object.keys(patch).length === 0) return row;
  await db.update(flashSales).set(patch).where(eq(flashSales.forDate, forDate));
  const refreshed = (await db
    .select()
    .from(flashSales)
    .where(eq(flashSales.forDate, forDate))
    .limit(1))[0];
  return refreshed ?? row;
}

function toFlashSaleRow(r: typeof flashSales.$inferSelect): FlashSaleRow {
  return {
    forDate: r.forDate,
    nameStyleKey: r.nameStyleKey,
    itemKey: r.itemKey,
    cosmeticKey: r.cosmeticKey,
    freeformBorderKey: r.freeformBorderKey,
    nameStyleDiscountPct: r.nameStyleDiscountPct,
    itemDiscountPct: r.itemDiscountPct,
    cosmeticDiscountPct: r.cosmeticDiscountPct,
    freeformBorderDiscountPct: r.freeformBorderDiscountPct,
  };
}

async function pickCategory(
  db: Db,
  category: FlashSaleCategory,
  enabled: boolean,
  overrides: Map<FlashSaleCategory, { targetKey: string; discountPct: number | null }>,
  defaultPct: number,
): Promise<{ targetKey: string | null; discountPct: number | null }> {
  if (!enabled) return { targetKey: null, discountPct: null };

  // Override beats random — even if the override points at a row
  // that's currently disabled. Admins are explicit; the resolver
  // doesn't second-guess. Discount lookup falls back to default
  // when the override didn't specify one.
  const override = overrides.get(category);
  if (override) {
    return {
      targetKey: override.targetKey,
      discountPct: override.discountPct ?? defaultPct,
    };
  }

  // Random pick over the eligible catalog. `ORDER BY random()` is
  // O(n) but n here is tiny (a few dozen rows at most) and this
  // runs at most once per day per category. If the catalog ever
  // grows past ~10k rows we can switch to a reservoir-sample
  // helper, but premature optimization isn't worth the readability
  // hit here.
  const row = await pickEligibleRow(db, category);
  if (!row) return { targetKey: null, discountPct: null };
  return { targetKey: row, discountPct: defaultPct };
}

async function pickEligibleRow(db: Db, category: FlashSaleCategory): Promise<string | null> {
  const now = Date.now();
  if (category === "name_style") {
    const rows = await db
      .select({ key: nameStyles.key })
      .from(nameStyles)
      .where(and(eq(nameStyles.enabled, true), sql`${nameStyles.cost} > 0`))
      .orderBy(sql`random()`)
      .limit(1);
    return rows[0]?.key ?? null;
  }
  if (category === "item") {
    const rows = await db
      .select({ key: items.key })
      .from(items)
      .where(and(
        eq(items.enabled, true),
        eq(items.forSale, true),
        sql`${items.price} > 0`,
        sql`(${items.saleStartsAt} IS NULL OR ${items.saleStartsAt} <= ${now})`,
        sql`(${items.saleEndsAt} IS NULL OR ${items.saleEndsAt} > ${now})`,
      ))
      .orderBy(sql`random()`)
      .limit(1);
    return rows[0]?.key ?? null;
  }
  if (category === "cosmetic") {
    const rows = await db
      .select({ key: cosmetics.key })
      .from(cosmetics)
      .where(and(eq(cosmetics.enabled, true), sql`${cosmetics.cost} > 0`))
      .orderBy(sql`random()`)
      .limit(1);
    return rows[0]?.key ?? null;
  }
  if (category === "freeform_border") {
    const rows = await db
      .select({ key: freeformBorders.key })
      .from(freeformBorders)
      .where(and(eq(freeformBorders.enabled, true), sql`${freeformBorders.cost} > 0`))
      .orderBy(sql`random()`)
      .limit(1);
    return rows[0]?.key ?? null;
  }
  return null;
}

/**
 * Apply a flash-sale discount to a base price. Floors at 0 (a 100%
 * sale + 1 Currency cost shouldn't refund money) and rounds to
 * the nearest integer — Currency is whole numbers everywhere
 * else in the system, no fractional pricing.
 */
export function applyDiscount(basePrice: number, discountPct: number | null): number {
  if (!discountPct || discountPct <= 0) return basePrice;
  const clamped = Math.min(100, Math.max(0, discountPct));
  const after = basePrice - basePrice * (clamped / 100);
  return Math.max(0, Math.round(after));
}

/**
 * Convenience for purchase paths: given a base cost + the catalog
 * row's category, returns the final cost the user should pay AND
 * the discount % applied (so callers can echo "Got 25% off!" in
 * receipts). Pass `forKey` so the discount only applies when the
 * caller's target IS today's pick.
 */
export async function priceWithFlashSale(
  db: Db,
  category: FlashSaleCategory,
  forKey: string,
  basePrice: number,
): Promise<{ finalPrice: number; discountPct: number | null }> {
  const sale = await resolveTodayFlashSale(db);
  const onSaleKey = category === "name_style" ? sale.nameStyleKey
                  : category === "item" ? sale.itemKey
                  : category === "cosmetic" ? sale.cosmeticKey
                  : category === "freeform_border" ? sale.freeformBorderKey
                  : null;
  if (onSaleKey !== forKey) return { finalPrice: basePrice, discountPct: null };
  const pct = category === "name_style" ? sale.nameStyleDiscountPct
            : category === "item" ? sale.itemDiscountPct
            : category === "cosmetic" ? sale.cosmeticDiscountPct
            : sale.freeformBorderDiscountPct;
  return { finalPrice: applyDiscount(basePrice, pct), discountPct: pct };
}
