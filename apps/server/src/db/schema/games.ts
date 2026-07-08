import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { id, ts } from "./_helpers.js";
import { items } from "./earning.js";
import { blocks } from "./moderation.js";
import { sessions } from "./users.js";

/**
 * Per-identity social-game win + points ledger (migration 0195).
 *
 * One row per (identity, game_kind). Updated automatically by
 * `formatWinningsLine` in games/config.ts whenever a game ends with
 * one or more winners, so adding a new social game kind in code
 * needs no schema or routing change: the rankings page surfaces
 * any game_kind that has rows.
 *
 *   owner_scope    'user' (OOC / master account) or 'character'.
 *                  Master and each character are tracked separately,
 *                  same per-identity model used by the earning
 *                  pipeline. A user playing as a character credits
 *                  the character; an OOC user credits themselves.
 *
 *   game_kind      Lowercase tag matching the kind the registry
 *                  uses ("rps", "trivia", "storydice", "scramble",
 *                  "duel", etc.).
 *
 *   wins           Total wins; incremented by 1 per game-end.
 *
 *   points         Game-specific score sum. For binary-win games
 *                  it mirrors `wins`. For accumulating-score games
 *                  (scramble) it's the winner's actual point total
 *                  on each win.
 */
export const gameStats = sqliteTable("game_stats", {
  /** Per-server economy partition (migration 0284). */
  serverId: text("server_id").notNull().default("server_spire_system"),
  ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
  ownerId: text("owner_id").notNull(),
  gameKind: text("game_kind").notNull(),
  wins: integer("wins").notNull().default(0),
  points: integer("points").notNull().default(0),
  lastWonAt: ts("last_won_at"),
}, (t) => ({
  pk: primaryKey({ columns: [t.serverId, t.ownerScope, t.ownerId, t.gameKind] }),
  // Leaderboard indexes (server_id-leading; recreated server-scoped in
  // migration 0292 after the 0284 rebuild dropped the original 0195 indexes).
  kindWins: index("idx_game_stats_kind_wins").on(t.serverId, t.gameKind, t.wins),
  kindPoints: index("idx_game_stats_kind_points").on(t.serverId, t.gameKind, t.points),
}));
export type DbGameStats = typeof gameStats.$inferSelect;

/* ---------- eidolon_state ----------
 * Per-identity Spire Arcade "Eidolon Tamer" save. Same (ownerScope,
 * ownerId) partition as identity_inventory / game_stats so a master
 * account and each character raise independent familiars and feed from
 * their own currency + inventory. Server-authoritative: decay is a pure
 * function of (now - lastSeenMs), recomputed on every read, so no
 * per-tick writes. Absence of a row = "never hatched" (client shows the
 * egg-select). `kind='pet'` familiars render the owned pet item's
 * iconUrl; `kind='species'` uses one of the four drawn starter species.
 */
export const eidolonState = sqliteTable(
  "eidolon_state",
  {
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    // "dormant" = the chosen death model: health-0 freezes the familiar (no
    // decay, no XP) until a Potion-revive. "dead" is the legacy permanent state,
    // treated identically (frozen + revivable). No CHECK constraint, so adding
    // "dormant" is a type-only widening — no migration needed.
    stage: text("stage", { enum: ["egg", "alive", "dead", "dormant"] }).notNull().default("alive"),
    kind: text("kind", { enum: ["species", "pet"] }).notNull().default("species"),
    speciesId: text("species_id"),
    /**
     * Owned pet item rendered as this familiar (kind='pet'). The FK into items
     * was DROPPED in migration 0298 (catalog gained a composite (server_id, key)
     * PK; SET NULL can't be a composite FK without nulling the NOT NULL
     * server_id). Plain text now; the renderer shows no pet sprite for a missing
     * key, the same outcome SET NULL produced.
     */
    petItemKey: text("pet_item_key"),
    name: text("name").notNull().default(""),
    satiety: real("satiety").notNull().default(80),
    joy: real("joy").notNull().default(75),
    vigor: real("vigor").notNull().default(85),
    hygiene: real("hygiene").notNull().default(80),
    health: real("health").notNull().default(100),
    sick: integer("sick", { mode: "boolean" }).notNull().default(false),
    asleep: integer("asleep", { mode: "boolean" }).notNull().default(false),
    ageHours: real("age_hours").notNull().default(0),
    simHour: real("sim_hour").notNull().default(8),
    messCount: integer("mess_count").notNull().default(0),
    /** Lifetime XP earned passively for being kept well + happy (drives level + sale value). */
    xp: real("xp").notNull().default(0),
    /** Personality trait id (composed onto species decay traits); null = legacy/none. */
    trait: text("trait"),
    /** Rare variant (e.g. "prismatic") rolled at hatch; null = ordinary. Visual
     *  prestige + a sale-value bump; doesn't change decay. Migration 0208. */
    variant: text("variant"),
    /** Non-sellable XP head-start INHERITED from a predecessor (lineage). Counts
     *  toward level/visual but is subtracted before sale value, so a hatch->sell
     *  loop can't farm the bonus. Migration 0208. */
    bonusXp: real("bonus_xp").notNull().default(0),
    /** Daily care-streak: consecutive days tended (one-day grace before reset). */
    streakCount: integer("streak_count").notNull().default(0),
    /** UTC day-key (YYYY-MM-DD) of the last tend; null until first check-in. */
    lastCheckInDayKey: text("last_checkin_day_key"),
    /** Best streak this familiar has ever reached. */
    bestStreak: integer("best_streak").notNull().default(0),
    /** Opt-in "your familiar needs you" push nudges (ON by default once hatched). */
    nudgeOptin: integer("nudge_optin", { mode: "boolean" }).notNull().default(true),
    /** UTC day-key of the last nudge sent; bounds nudges to once per day. */
    lastNudgeDayKey: text("last_nudge_day_key"),
    /** Wall-clock (ms) of the last persisted snapshot; drives offline decay catch-up. */
    lastSeenMs: integer("last_seen_ms").notNull().default(0),
    hatchedAt: ts("hatched_at"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.ownerScope, t.ownerId] }),
  }),
);
export type DbEidolonState = typeof eidolonState.$inferSelect;

/**
 * Eidolon Tamer "visits": one row per (visitor user, target familiar identity),
 * holding the last pat time. Drives the 24h pat cooldown (a social +joy gesture
 * on another player's familiar). Keyed by the visitor's USER id (so a user's
 * many identities can't each pat the same target) — see the /arcade/eidolon/visit
 * route, which also blocks patting any familiar you own.
 */
export const eidolonVisits = sqliteTable(
  "eidolon_visits",
  {
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    visitorUserId: text("visitor_user_id").notNull(),
    targetOwnerScope: text("target_owner_scope", { enum: ["user", "character"] }).notNull(),
    targetOwnerId: text("target_owner_id").notNull(),
    /** Wall-clock (ms) of the last pat; drives the cooldown. */
    visitedAt: integer("visited_at").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serverId, t.visitorUserId, t.targetOwnerScope, t.targetOwnerId] }),
  }),
);
export type DbEidolonVisit = typeof eidolonVisits.$inferSelect;

/**
 * The Hall — a memorial record per departed familiar (sold or released), so a
 * keeper can look back on everyone they've raised AND the next hatch can
 * inherit from the most recent one (lineage). Append-only history; one row per
 * departure (a keeper can have many). `peak_level` is the level at departure,
 * which equals the lifetime peak since XP only ever accrues. Migration 0208.
 */
export const eidolonHall = sqliteTable(
  "eidolon_hall",
  {
    id: text("id").primaryKey(),
    /** Per-server economy partition (migration 0284). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull().default(""),
    kind: text("kind", { enum: ["species", "pet"] }).notNull().default("species"),
    speciesId: text("species_id"),
    trait: text("trait"),
    variant: text("variant"),
    /** Level at departure (= lifetime peak; XP is monotonic). */
    peakLevel: integer("peak_level").notNull().default(1),
    ageHours: real("age_hours").notNull().default(0),
    /** "sold" | "released". */
    departReason: text("depart_reason").notNull().default("released"),
    /** Wall-clock (ms) of departure. */
    departedAt: integer("departed_at").notNull().default(0),
  },
  (t) => ({
    ownerIdx: index("eidolon_hall_owner_idx").on(t.serverId, t.ownerScope, t.ownerId, t.departedAt),
  }),
);
export type DbEidolonHall = typeof eidolonHall.$inferSelect;

/**
 * Urugal's Descent run sessions (Spire Arcade game #2). One row per
 * descent. The server issues `id` at /arcade/urugal/start and validates
 * every milestone event against it: floors must advance monotonically
 * (capped jump) and be paced plausibly, and each floor / boss pays at
 * most once per run. `maxFloor` is the highest PAID floor; `bossesJson`
 * is a JSON array of PAID boss floors. Reward crediting + the daily cap
 * live in the route (see routes/arcadeUrugal.ts + the @thekeep/shared
 * urugal reward curve). The game bundle is untrusted; this table is the
 * server's authoritative record of what's actually been earned.
 */
export const urugalRun = sqliteTable(
  "urugal_run",
  {
    id: text("id").primaryKey(),
    /** Per-server economy partition (migration 0286). */
    serverId: text("server_id").notNull().default("server_spire_system"),
    ownerScope: text("owner_scope", { enum: ["user", "character"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** Master account id (for creditPool's `notifyUserId` + socket emit). */
    userId: text("user_id").notNull(),
    startedAt: integer("started_at").notNull(),
    lastEventAt: integer("last_event_at").notNull(),
    /** Highest floor already PAID for in this run (monotonic gate). */
    maxFloor: integer("max_floor").notNull().default(1),
    /** JSON array of boss floors already PAID for (dedup). */
    bossesJson: text("bosses_json").notNull().default("[]"),
    status: text("status", { enum: ["active", "ended"] }).notNull().default("active"),
    endedAt: integer("ended_at"),
  },
  (t) => ({
    ownerIdx: index("urugal_run_owner_idx").on(t.serverId, t.ownerScope, t.ownerId, t.status),
  }),
);
export type DbUrugalRun = typeof urugalRun.$inferSelect;
