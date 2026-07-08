/**
 * Arcade purchase-unlock gate (finding P2).
 *
 * Every arcade game is unlocked once per identity by a one-time purchase that
 * writes a `purchase_<flairKey>` row into `earning_ledger`. The four game gates
 * (routes/arcade.ts, routes/arcadeUrugal.ts, routes/arcadeGrimhold.ts, and the
 * `/eidolon` command) each re-implemented the identical ledger existence check;
 * this is the single shared reader for it. Returns a boolean ONLY — each caller
 * keeps its own failure shape (HTTP 402 `needsUnlock` vs `error:notice
 * EIDOLON_LOCKED`) and its own permission double-gate.
 *
 * INTENTIONAL, ASYMMETRIC serverId scoping (project memory — do NOT "fix"):
 * the Eidolon Tamer is a SEPARATE familiar per server, so its route
 * (arcade.ts) scopes the unlock to a `serverId`. Urugal, Grimhold, and the
 * `/eidolon` emote command check the unlock GLOBALLY (no serverId filter). The
 * `serverId` param is therefore OPTIONAL: pass it to reproduce the per-server
 * check, omit it for the global check. With the servers flag off the only
 * server is the default, so the per-server check is byte-identical to the
 * global one.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { earningLedger } from "../db/schema.js";

type Scope = "user" | "character";

/**
 * True when the given identity owns the one-time unlock for `flairKey`
 * (a `purchase_<flairKey>` ledger row exists). Pass `serverId` to scope the
 * check to a single server (Eidolon Tamer); omit it for a global check
 * (Urugal / Grimhold / `/eidolon`).
 */
export async function ownsPurchase(
  db: Db,
  opts: { flairKey: string; scope: Scope; ownerId: string; serverId?: string },
): Promise<boolean> {
  const { flairKey, scope, ownerId, serverId } = opts;
  const conds = [
    eq(earningLedger.scope, scope),
    eq(earningLedger.ownerId, ownerId),
    eq(earningLedger.reason, `purchase_${flairKey}`),
  ];
  // serverId first when present, mirroring the original arcade.ts predicate
  // order (AND is commutative, so this is purely cosmetic).
  if (serverId !== undefined) conds.unshift(eq(earningLedger.serverId, serverId));
  const owned = (
    await db.select({ id: earningLedger.id }).from(earningLedger).where(and(...conds)).limit(1)
  )[0];
  return !!owned;
}
