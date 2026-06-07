/**
 * Eidolon Tamer server-side logic. The pure, deterministic decay engine
 * (traits, applyDecay, night logic, freshStats) now lives in
 * `@thekeep/shared` so the web client ticks the exact same math for smooth
 * visuals. This module keeps the server-only pieces: the authoritative
 * `catchUp` (which rolls sickness with Math.random), the realtime sim-hour,
 * food nutrition, name rolls, and heal economy constants.
 *
 * Production runs in REALTIME (1 sim-hour per real-hour); the standalone
 * simulator's accelerated "Test" mode is dropped.
 */
import {
  applyDecay, clampStat, effectiveTraits, eidolonXpGain, freshStats, isNightHour, streakRewardFor, streakXpMultiplier,
  type EidolonStats,
} from "@thekeep/shared";

export {
  applyDecay, clampStat, freshStats, isNightHour, joyGainFor, traitsFor,
  NIGHT_START, NIGHT_END, type EidolonTraits, SPECIES_TRAITS,
} from "@thekeep/shared";

export interface EidolonProgress {
  stats: EidolonStats;
  sick: boolean;
  ageHours: number;
  simHour: number;
  asleep: boolean;
  messCount: number;
  /** Lifetime XP after this catch-up (accrued from wellbeing over elapsed time). */
  xp: number;
  dead: boolean;
}

/** Real-clock hour 0..24 used as the sim hour (realtime mode). */
export function currentSimHour(now: Date = new Date()): number {
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}

/**
 * Reproduce decay from a persisted snapshot up to `nowMs`. Steps in
 * <=0.5h increments (so the night/sick transitions resolve correctly),
 * caps the offline gap at 72h, and reports death if health hits 0.
 * Mirrors `catchUp` in the standalone simulator exactly.
 */
export function catchUp(
  row: {
    satiety: number; joy: number; vigor: number; hygiene: number; health: number;
    sick: boolean; ageHours: number; simHour: number; messCount: number; xp: number; lastSeenMs: number;
    kind: "species" | "pet"; speciesId: string | null; stage: "egg" | "alive" | "dead" | "dormant";
    streakCount?: number; trait?: string | null;
  },
  nowMs: number,
  opts: { xpMultiplier?: number } = {},
): EidolonProgress {
  // Passive-XP multiplier: the intrinsic care-streak bonus (from the row),
  // times any extra multiplier the caller passes (future traits/economy).
  // Defaults to the streak bonus alone, so existing callers are unaffected.
  const extra = Number.isFinite(opts.xpMultiplier) ? Math.max(0, opts.xpMultiplier as number) : 1;
  const xpMult = extra * streakXpMultiplier(row.streakCount ?? 0);
  let st: EidolonStats = { satiety: row.satiety, joy: row.joy, vigor: row.vigor, hygiene: row.hygiene, health: row.health };
  // A dormant (or legacy-dead) familiar is FROZEN: it stays put at 0 health,
  // accrues no decay and no XP, until a Potion-revive wakes it. `dead: true`
  // is the shared "lifeless" signal the routes/UI key off (see eidolonIsDormant).
  if (row.stage === "dead" || row.stage === "dormant" || st.health <= 0) {
    return { stats: { ...st, health: 0 }, sick: row.sick, ageHours: row.ageHours, simHour: row.simHour, asleep: false, messCount: row.messCount, xp: row.xp, dead: true };
  }
  const tr = effectiveTraits(row.kind, row.speciesId, row.trait);
  let elapsedH = Math.min(Math.max(0, (nowMs - row.lastSeenMs) / 3_600_000), 72);
  let sick = row.sick, age = row.ageHours, hour = row.simHour, xp = row.xp;
  const messCount = row.messCount;
  while (elapsedH > 0.0001) {
    const step = Math.min(0.5, elapsedH);
    const night = isNightHour(hour);
    st = applyDecay(st, step, { asleep: night, night, sick, messCount }, tr);
    if (!sick && (st.satiety < 28 || st.hygiene < 28) && Math.random() < 0.18 * tr.sickChance * step) sick = true;
    xp += eidolonXpGain(st, sick, step) * xpMult;
    age += step;
    hour = (hour + step) % 24;
    elapsedH -= step;
    if (st.health <= 0) return { stats: st, sick, ageHours: age, simHour: hour, asleep: false, messCount, xp, dead: true };
  }
  return { stats: st, sick, ageHours: age, simHour: hour, asleep: isNightHour(hour), messCount, xp, dead: false };
}

const NAMES = ["Mortis", "Vesper", "Grimble", "Nyx", "Obol", "Wretch", "Sable", "Thessaly", "Cinder", "Rue"];
export const rollName = (): string => NAMES[Math.floor(Math.random() * NAMES.length)]!;

/* ---- daily care-streak check-in (server day-key, with a one-day grace) ---- */

/** UTC day key (YYYY-MM-DD), matching the flash-sale convention. */
export function serverDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
/** Integer day number for a YYYY-MM-DD key (for gap math). */
function dayNumFromKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

export interface CheckInResult {
  streakCount: number;
  bestStreak: number;
  lastCheckInDayKey: string;
  /** True when this tend was the first of a new day (the streak moved). */
  advanced: boolean;
  /** Milestone currency to grant on this check-in (0 = none). */
  reward: number;
}

/**
 * Roll a care-streak check-in. Tending again the same day is a no-op. A new
 * day advances the streak; a single missed day is forgiven (the one-day
 * grace, gap of 2), but two-or-more consecutive missed days reset it to 1.
 */
export function rollCheckIn(
  prev: { streakCount: number; lastCheckInDayKey: string | null; bestStreak: number },
  todayKey: string,
): CheckInResult {
  if (prev.lastCheckInDayKey === todayKey) {
    return { streakCount: prev.streakCount, bestStreak: prev.bestStreak, lastCheckInDayKey: todayKey, advanced: false, reward: 0 };
  }
  let streak: number;
  if (!prev.lastCheckInDayKey) {
    streak = 1;
  } else {
    const gap = dayNumFromKey(todayKey) - dayNumFromKey(prev.lastCheckInDayKey);
    // gap 1 = consecutive; gap 2 = exactly one missed day (forgiven); gap >= 3
    // = two+ consecutive misses -> reset. (gap <= 0 shouldn't happen since the
    // same-day case returned above, but treat it as a continuation.)
    streak = gap <= 2 ? prev.streakCount + 1 : 1;
  }
  const bestStreak = Math.max(prev.bestStreak, streak);
  return { streakCount: streak, bestStreak, lastCheckInDayKey: todayKey, advanced: true, reward: streakRewardFor(streak) };
}

/** Food nutrition + toy effects are now multi-stat and shared (so the in-game
 *  drawer can preview them); re-exported here under the names the routes use.
 *  `eidolonFoodEffect` returns Satiety + the multi-stat bonus; the FEED handler
 *  applies a small Hygiene cost + the joyGain trait scale on top. */
export {
  eidolonFoodSatiety as foodSatiety, eidolonFoodEffect as foodEffect, eidolonToyEffect as toyEffect,
  type EidolonFoodEffect, type EidolonToyEffect,
} from "@thekeep/shared";

/** Heal economy constants live in @thekeep/shared (the client labels the
 *  basic-heal cost); re-exported here under the names the routes use. */
export {
  EIDOLON_BASIC_HEAL_COST as BASIC_HEAL_COST,
  EIDOLON_BASIC_HEAL_AMOUNT as BASIC_HEAL_AMOUNT,
  EIDOLON_POTION_HEAL_AMOUNT as POTION_HEAL_AMOUNT,
} from "@thekeep/shared";
