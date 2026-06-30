/**
 * Spire Arcade shared types. The first arcade game is the Eidolon Tamer
 * (a Tamagotchi-style familiar). Access is gated two ways, both enforced
 * server-side: the `use_arcade` / `use_eidolon_tamer` permission keys
 * (the admin kill-switch) AND a one-time purchase of the
 * `flair_eidolon_tamer` cosmetic (the player's unlock).
 *
 * State is per-IDENTITY (master account OR a specific character), keyed
 * the same way currency/inventory partition. It is server-authoritative:
 * decay is a pure function of elapsed wall-clock since `serverNowMs`, so
 * the server reproduces it on every read and the client only ticks
 * locally for smooth visuals between syncs (mirrors the Theater model).
 */

import type { PermissionKey } from "./permissions.js";

/* =========================================================================
   Arcade games registry — the single source of truth for "what games
   exist." Adding a game here automatically gives it a `{arcade:<key>}`
   navigation chip (uiRoutes generates one per entry, so the catalog, both
   chip renderers, the validator, and the Help reference all pick it up)
   plus per-game permission gating on the chip click. The only per-game
   piece NOT driven from here is the actual window component + its open
   state (apps/web/App.tsx, keyed by `key`) — a React component can't be
   expressed as data.
   ========================================================================= */

export interface ArcadeGameDef {
  /** Stable key. Used in the `{arcade:<key>}` token and to look up the
   *  window opener client-side. Lowercase a-z/digits only so it satisfies
   *  the UI-route token grammar. */
  key: string;
  /** Display name shown on the chip and in Help. */
  label: string;
  /** lucide-react icon NAME (PascalCase) rendered before the label. The
   *  web side maps it to a component (lib/uiRouteIcons). */
  icon: string;
  /** Chip title / Help description (terse). */
  description: string;
  /** Per-game permission required to PLAY (on top of `use_arcade`). The
   *  chip-click dispatcher checks both before opening the window. */
  permission: PermissionKey;
}

export const ARCADE_GAMES = [
  { key: "eidolon", label: "Eidolon Tamer", icon: "Egg", description: "Open the Eidolon Tamer.", permission: "use_eidolon_tamer" },
  { key: "urugal", label: "Urugal's Descent", icon: "Pickaxe", description: "Open Urugal's Descent.", permission: "use_urugal_descent" },
  { key: "grimhold", label: "Grimhold", icon: "Ghost", description: "Open the Grimhold cabinet (six games).", permission: "use_grimhold" },
] as const satisfies ReadonlyArray<ArcadeGameDef>;

/** Union of the registered game keys ("eidolon" | "urugal" | "grimhold"). */
export type ArcadeGameKey = (typeof ARCADE_GAMES)[number]["key"];

/** Lookup by key. Returns null for an unknown key. */
export function arcadeGameByKey(key: string): ArcadeGameDef | null {
  return ARCADE_GAMES.find((g) => g.key === key) ?? null;
}

/** The one-time unlock cosmetic key (a "Flair" in the shop). */
export const FLAIR_EIDOLON_TAMER = "flair_eidolon_tamer";

/**
 * The `items.category` values the Eidolon Tamer consumes / requires. A server
 * that turns on the Arcade needs exactly these item rows to function: `pet`
 * (the familiars you can hatch), `food` (feeding), `toy` (reusable play), and
 * `magic` (cure / revive potions). Named here so the per-server "import Arcade
 * items" path (servers/earning.ts) copies precisely this slice of the Spire
 * built-in `items` catalog — never the whole shop. The unlock itself
 * (`FLAIR_EIDOLON_TAMER`) is a `cosmetics` row, imported alongside these.
 */
export const EIDOLON_ITEM_CATEGORIES = ["pet", "food", "toy", "magic"] as const;
export type EidolonItemCategory = (typeof EIDOLON_ITEM_CATEGORIES)[number];

/** Display cost of the Eidolon Tamer unlock. Mirrors the cosmetics seed in
 *  migration 0201; the real charge is server-side at purchase time. */
export const EIDOLON_UNLOCK_COST = 2500;

/** The four hand-drawn starter species (the four starting eggs). */
export const EIDOLON_SPECIES_IDS = ["dragon", "gargoyle", "wraith", "slime"] as const;
export type EidolonSpeciesId = (typeof EIDOLON_SPECIES_IDS)[number];

/**
 * Lifecycle stage. The chosen death model is DORMANCY, not permadeath: a
 * familiar whose health reaches 0 goes `"dormant"` — frozen (no further
 * decay, no XP), but revivable with a Potion, so the player's invested
 * level/XP/streak survive. `"dead"` is the legacy permanent state from
 * before dormancy shipped; it's treated identically to dormant everywhere
 * (frozen + revivable), so old rows get retroactive mercy.
 */
export type EidolonStage = "egg" | "alive" | "dead" | "dormant";

/** A familiar in the lifeless (dormant or legacy-dead) state: frozen, awaiting
 *  a Potion-revive. The single predicate the server + client share. */
export const eidolonIsDormant = (stage: EidolonStage): boolean => stage === "dormant" || stage === "dead";

export interface EidolonStats {
  satiety: number;
  joy: number;
  vigor: number;
  hygiene: number;
  health: number;
}

/**
 * The wire snapshot returned by every `/arcade/eidolon*` endpoint,
 * already caught up to `serverNowMs`. `kind: "pet"` means the familiar
 * is one of the player's owned pets (rendered from `petIconUrl` with
 * hue/animation VFX); `kind: "species"` uses one of the drawn species.
 */
export interface EidolonSnapshot {
  stage: EidolonStage;
  kind: "species" | "pet";
  /** Set when kind === "species". */
  speciesId: EidolonSpeciesId | null;
  /** Set when kind === "pet": the pet item key + its resolved image. */
  petItemKey: string | null;
  petIconUrl: string | null;
  /** Pet display name (the pet's nickname, or a rolled name for species). */
  name: string;
  stats: EidolonStats;
  sick: boolean;
  asleep: boolean;
  ageHours: number;
  /** In-sim hour 0..24 (drives day/night). */
  simHour: number;
  /** Active mess (ooze) count, 0..3. */
  messCount: number;
  /** Lifetime XP earned by being kept well + happy (passive, time-based). */
  xp: number;
  /** Level derived from `xp` (see eidolonLevelFromXp). */
  level: number;
  /** Currency it would fetch if sold right now (see eidolonSaleValue). */
  saleValue: number;
  /** Care-streak: consecutive days tended (with a one-day grace before reset). */
  streakCount: number;
  /** Best streak this familiar has ever reached. */
  bestStreak: number;
  /** Whether the familiar has already been tended on the current day. */
  checkedInToday: boolean;
  /** Passive-XP multiplier the live streak currently grants (>= 1). */
  streakMultiplier: number;
  /** Whether opt-in "your familiar needs you" push nudges are enabled. */
  nudgeOptin: boolean;
  /** Personality trait (null for familiars hatched before traits shipped). */
  trait: EidolonTraitId | null;
  /** Rare variant (e.g. "prismatic"); null for an ordinary familiar. */
  variant: EidolonVariantId | null;
  /** Server clock when this snapshot was taken; the client extrapolates
   *  decay from here for smooth visuals until the next sync. */
  serverNowMs: number;
}

/** Whether the familiar is null (never hatched on this identity). The
 *  `GET /arcade/eidolon` endpoint returns `{ eidolon: null }` in that
 *  case so the client shows the egg-select screen. */
export interface EidolonStateResponse {
  eidolon: EidolonSnapshot | null;
}

/** Lightweight, public-view summary of an identity's familiar, shown on
 *  their profile (read-only; no stats, no economy). `GET /arcade/eidolon/summary`. */
export interface EidolonProfileSummary {
  kind: "species" | "pet";
  speciesId: EidolonSpeciesId | null;
  petIconUrl: string | null;
  name: string;
  level: number;
  ageHours: number;
  streakCount: number;
  dead: boolean;
  sick: boolean;
  /** Rare variant (e.g. "prismatic"); null for an ordinary familiar. */
  variant: EidolonVariantId | null;
  /** Pre-resolved mood word (e.g. "content", "ailing", "dormant"). */
  moodLabel: string;
}

/* =========================================================================
   Pure decay engine — the SINGLE source of truth shared by the server
   (authoritative catch-up on every read) and the web client (local ticking
   between syncs, for smooth gauge motion only). Ported verbatim from the
   standalone simulator. Deterministic: no randomness lives here (the sick
   roll is server-side, in earning/eidolon.ts), so client and server agree.
   ========================================================================= */

export interface EidolonTraits {
  satiety: number;
  joy: number;
  vigor: number;
  hygiene: number;
  healthDrain: number;
  sickChance: number;
  messChance: number;
  joyGain: number;
}

export const DEFAULT_TRAITS: EidolonTraits = {
  satiety: 1, joy: 1, vigor: 1, hygiene: 1, healthDrain: 1, sickChance: 1, messChance: 1, joyGain: 1,
};

/** Per-species personality knobs (the four starter eggs). Pets use the
 *  balanced DEFAULT_TRAITS. Mirrors SPECIES[*].traits in the simulator. */
export const SPECIES_TRAITS: Record<EidolonSpeciesId, EidolonTraits> = {
  dragon: { satiety: 1.6, joy: 1, vigor: 1, hygiene: 0.9, healthDrain: 0.55, sickChance: 0.4, messChance: 1, joyGain: 1 },
  gargoyle: { satiety: 0.5, joy: 0.55, vigor: 0.6, hygiene: 0.5, healthDrain: 0.5, sickChance: 0.5, messChance: 0.5, joyGain: 0.75 },
  wraith: { satiety: 0.45, joy: 1.7, vigor: 0.7, hygiene: 0.4, healthDrain: 1.35, sickChance: 1.2, messChance: 0.3, joyGain: 1.15 },
  slime: { satiety: 1.05, joy: 0.55, vigor: 1, hygiene: 1.9, healthDrain: 0.8, sickChance: 0.05, messChance: 2, joyGain: 1.25 },
};

export const RATE = { satiety: 7, joy: 5, vigor: 5, hygiene: 4 };
export const NIGHT_START = 19;
export const NIGHT_END = 7;
export const isNightHour = (h: number): boolean => h >= NIGHT_START || h < NIGHT_END;

export const clampStat = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));
export const clampStats = (s: EidolonStats): EidolonStats => ({
  satiety: clampStat(s.satiety), joy: clampStat(s.joy), vigor: clampStat(s.vigor),
  hygiene: clampStat(s.hygiene), health: clampStat(s.health),
});

export function traitsFor(kind: "species" | "pet", speciesId: string | null): EidolonTraits {
  if (kind === "species" && speciesId && (SPECIES_TRAITS as Record<string, EidolonTraits>)[speciesId]) {
    return (SPECIES_TRAITS as Record<string, EidolonTraits>)[speciesId]!;
  }
  return DEFAULT_TRAITS;
}

/** One decay step over `dtH` sim-hours. Verbatim from the simulator engine. */
export function applyDecay(
  s: EidolonStats,
  dtH: number,
  ctx: { asleep: boolean; night: boolean; sick: boolean; messCount: number },
  tr: EidolonTraits = DEFAULT_TRAITS,
): EidolonStats {
  const slow = ctx.asleep ? 0.2 : 1;
  const messDrain = ctx.messCount * 1.5;
  const satiety = s.satiety - RATE.satiety * tr.satiety * dtH * slow;
  let joy = s.joy - RATE.joy * tr.joy * dtH * slow;
  const hygiene = s.hygiene - (RATE.hygiene * tr.hygiene + messDrain) * dtH * slow;
  let vigor = ctx.asleep ? s.vigor + 12 * dtH : s.vigor - RATE.vigor * tr.vigor * dtH;
  const health = s.health;
  if (ctx.night && !ctx.asleep) { vigor -= 4 * dtH; joy -= 4 * dtH; }
  if (!ctx.night && ctx.asleep) { joy -= 2 * dtH; }
  const cs = clampStats({ satiety, joy, vigor, hygiene, health });
  if (ctx.sick) cs.health = clampStat(cs.health - 6 * tr.healthDrain * dtH);
  if (cs.satiety <= 0) cs.health = clampStat(cs.health - 3 * tr.healthDrain * dtH);
  if (cs.hygiene <= 0) cs.health = clampStat(cs.health - 2 * tr.healthDrain * dtH);
  return cs;
}

export const freshStats = (): EidolonStats => ({ satiety: 80, joy: 75, vigor: 85, hygiene: 80, health: 100 });

/** Joy gain multiplier for the active familiar (species personality). */
export const joyGainFor = (kind: "species" | "pet", speciesId: string | null): number =>
  traitsFor(kind, speciesId).joyGain;

/* ---- personality traits (a per-familiar quirk layered on the species) ---- */
export const EIDOLON_TRAIT_IDS = ["hardy", "gluttonous", "stoic", "vivacious", "pristine", "feral"] as const;
export type EidolonTraitId = (typeof EIDOLON_TRAIT_IDS)[number];

/** Each trait multiplies the species decay knobs (+ joyGain), composing
 *  MULTIPLICATIVELY with SPECIES_TRAITS — so e.g. a Hardy Wraith is both
 *  resilient (trait) and fast-fading (species). label/flavor are display-only. */
export const EIDOLON_TRAITS: Record<EidolonTraitId, { label: string; flavor: string; mods: Partial<EidolonTraits> }> = {
  hardy: { label: "Hardy", flavor: "Shrugs off illness and clings to life.", mods: { healthDrain: 0.6, sickChance: 0.6 } },
  gluttonous: { label: "Gluttonous", flavor: "Always hungry, but food delights it.", mods: { satiety: 1.5, joyGain: 1.25 } },
  stoic: { label: "Stoic", flavor: "Even-tempered; slow to sadden, slow to cheer.", mods: { joy: 0.6, joyGain: 0.7 } },
  vivacious: { label: "Vivacious", flavor: "Big feelings: dips fast, but cheers fast.", mods: { joy: 1.35, joyGain: 1.4 } },
  pristine: { label: "Pristine", flavor: "Fastidiously, impossibly clean.", mods: { hygiene: 0.5, messChance: 0.4 } },
  feral: { label: "Feral", flavor: "Wild and spirited; high upkeep.", mods: { vigor: 1.4, hygiene: 1.4, sickChance: 1.2, joyGain: 1.2 } },
};

const isTraitId = (id: string | null | undefined): id is EidolonTraitId =>
  !!id && (EIDOLON_TRAIT_IDS as readonly string[]).includes(id);

/** A familiar's EFFECTIVE decay traits: species base × personality trait mods.
 *  Falls back to the species base when there's no (or an unknown) trait. */
export function effectiveTraits(kind: "species" | "pet", speciesId: string | null, traitId: string | null | undefined): EidolonTraits {
  const base = traitsFor(kind, speciesId);
  if (!isTraitId(traitId)) return base;
  const m = EIDOLON_TRAITS[traitId].mods;
  return {
    satiety: base.satiety * (m.satiety ?? 1),
    joy: base.joy * (m.joy ?? 1),
    vigor: base.vigor * (m.vigor ?? 1),
    hygiene: base.hygiene * (m.hygiene ?? 1),
    healthDrain: base.healthDrain * (m.healthDrain ?? 1),
    sickChance: base.sickChance * (m.sickChance ?? 1),
    messChance: base.messChance * (m.messChance ?? 1),
    joyGain: base.joyGain * (m.joyGain ?? 1),
  };
}

/** Random personality trait for a freshly hatched familiar (server-side, at hatch). */
export const rollTraitId = (): EidolonTraitId => EIDOLON_TRAIT_IDS[Math.floor(Math.random() * EIDOLON_TRAIT_IDS.length)]!;

/* =========================================================================
   Mood — the single source of truth for "what is the familiar feeling",
   shared so the SERVER (the /eidolon chat emote) can speak the same mood the
   CLIENT sprite shows. The client's deriveVisual() uses eidolonPrimaryMood
   for its `primary`, so the two never drift.
   ========================================================================= */
const invMood = (v: number, hi: number, lo: number): number => Math.max(0, Math.min(1, (hi - v) / (hi - lo)));

export type EidolonMood = "happy" | "sad" | "angry" | "hungry" | "sick" | "dirty" | "tired" | "sleeping" | "dead";

export const EIDOLON_MOOD_LABEL: Record<EidolonMood, string> = {
  happy: "content", sad: "forlorn", angry: "wrathful", hungry: "famished",
  sick: "ailing", dirty: "filthy", tired: "weary", sleeping: "dreaming", dead: "dormant",
};

export const EIDOLON_STATUS_LINE: Record<EidolonMood, (n: string) => string> = {
  happy: (n) => `${n} hums with quiet contentment.`,
  sad: (n) => `${n} droops, longing to be played with.`,
  angry: (n) => `${n} seethes; tend to it, mortal.`,
  hungry: (n) => `${n} grumbles with hunger.`,
  sick: (n) => `${n} festers. It needs a remedy.`,
  dirty: (n) => `${n} is caked in grime.`,
  tired: (n) => `${n}'s eyes grow heavy.`,
  sleeping: (n) => `${n} slumbers in the void.`,
  dead: (n) => `${n} lies dormant; a magical item would wake it.`,
};

/** The familiar's dominant mood from its current stats. Pure; mirrors the
 *  `primary` selection the standalone simulator used. */
export function eidolonPrimaryMood(stats: EidolonStats, ctx: { asleep: boolean; sick: boolean; dead: boolean }): EidolonMood {
  if (ctx.dead) return "dead";
  if (ctx.asleep) return "sleeping";
  const hungerI = invMood(stats.satiety, 55, 8);
  const sadI = invMood(stats.joy, 55, 12);
  const tiredI = invMood(stats.vigor, 48, 6);
  const dirtI = invMood(stats.hygiene, 74, 8);
  const sickI = ctx.sick ? 1 : invMood(stats.health, 45, 10);
  const angryI = stats.joy < 24 ? invMood(stats.joy, 24, 4) : 0;
  const concerns: Array<[EidolonMood, number]> = [
    ["sick", sickI * 1.25], ["hungry", hungerI], ["dirty", dirtI * 1.05],
    ["angry", angryI * 1.1], ["sad", sadI], ["tired", tiredI * 0.9],
  ];
  let primary: EidolonMood = "happy", pv = 0;
  for (const [k, v] of concerns) if (v > pv) { pv = v; primary = k; }
  if (pv < 0.28) primary = "happy";
  return primary;
}

/** The in-character mood sentence for a familiar (used by the chat emote). */
export function eidolonMoodLine(name: string, stats: EidolonStats, ctx: { asleep: boolean; sick: boolean; dead: boolean }): string {
  return EIDOLON_STATUS_LINE[eidolonPrimaryMood(stats, ctx)](name);
}

/** Name-LESS mood action, for posting as a `/me`-style emote where the actor
 *  name is supplied separately (renders "<Familiar> <action>"). */
export const EIDOLON_MOOD_ACTION: Record<EidolonMood, string> = {
  happy: "hums with quiet contentment.",
  sad: "droops, longing to be played with.",
  angry: "seethes; tend to it, mortal.",
  hungry: "grumbles with hunger.",
  sick: "festers, in need of a remedy.",
  dirty: "is caked in grime.",
  tired: "grows heavy-eyed and weary.",
  sleeping: "slumbers in the void.",
  dead: "lies dormant, lifeless and still.",
};
export function eidolonMoodAction(stats: EidolonStats, ctx: { asleep: boolean; sick: boolean; dead: boolean }): string {
  return EIDOLON_MOOD_ACTION[eidolonPrimaryMood(stats, ctx)];
}

/* =========================================================================
   Progression — XP, levels, and sale value. A familiar earns XP passively
   for being kept well-fed, happy, rested, clean, and healthy (time-based,
   NOT click-based — keeps with the "reward longevity, not grinding" ethos).
   Higher levels are worth more currency when sold, letting a player cash out
   a well-raised familiar to fund the next one. A freshly hatched familiar
   (level 1, 0 XP) is worth 0, so hatch->sell can't be farmed.
   ========================================================================= */

/** Max XP a thriving familiar earns per sim-hour, scaled by wellbeing. */
export const EIDOLON_XP_PER_HOUR = 10;

/** XP earned over `dtH` sim-hours given current wellbeing (0 when neglected,
 *  steeply reduced while sick). Pure; shared by the server catch-up. */
export function eidolonXpGain(stats: EidolonStats, sick: boolean, dtH: number): number {
  // Defensive: a non-finite stat (e.g. a corrupted row) must not poison XP
  // with NaN — Math.max/min don't clamp NaN, so guard at the entry.
  if (![stats.satiety, stats.joy, stats.vigor, stats.hygiene, stats.health, dtH].every(Number.isFinite)) return 0;
  const care = (stats.satiety + stats.vigor + stats.hygiene + stats.health) / 4;
  let wellbeing = (care * 0.5 + stats.joy * 0.5) / 100; // 0..1, joy (Spirit) weighted equal to overall care
  if (sick) wellbeing *= 0.3;
  return EIDOLON_XP_PER_HOUR * Math.max(0, Math.min(1, wellbeing)) * Math.max(0, dtH);
}

/** Cumulative XP required to REACH a level (level 1 = 0). cumXp(L)=25·(L-1)·L. */
export const eidolonXpForLevel = (level: number): number => 25 * Math.max(0, level - 1) * Math.max(0, level);

/** Level from total XP (level 1 at 0 XP) — inverse of the quadratic above. */
export const eidolonLevelFromXp = (xp: number): number =>
  Math.max(1, Math.floor((25 + Math.sqrt(625 + 100 * Math.max(0, xp))) / 50));

/** Currency a familiar fetches when sold: 0 at level 1 with no XP (so a
 *  fresh hatch is worthless to sell), growing with level + banked XP. */
export function eidolonSaleValue(xp: number): number {
  const level = eidolonLevelFromXp(xp);
  const intoLevel = Math.max(0, xp - eidolonXpForLevel(level));
  return Math.max(0, (level - 1) * 60 + Math.floor(intoLevel / 8));
}

/* ---- daily care-streak (the retention loop) ---- */
/** Passive-XP multiplier granted by the current care-streak: gentle, capped
 *  at +25%. Shared so the client tick and server catch-up agree. */
export const streakXpMultiplier = (streakCount: number): number =>
  1 + Math.min(0.25, Math.max(0, streakCount) * 0.02);
/** One-shot currency bonus the FIRST time a streak reaches a milestone. */
export const EIDOLON_STREAK_REWARDS: Record<number, number> = { 3: 25, 7: 75, 14: 150, 30: 400 };
export const streakRewardFor = (streakCount: number): number => EIDOLON_STREAK_REWARDS[streakCount] ?? 0;

/* ---- active-care XP (the bar moves when you actually tend) ---- */
/** XP per point of wellbeing a care action actually restores. Passive XP
 *  (eidolonXpGain) rewards keeping a familiar thriving over time; this rewards
 *  the hands-on tend that brings a decayed one back up, so the Lv/XP bar visibly
 *  jumps when you feed/play/clean a needy familiar. */
export const EIDOLON_CARE_XP_FACTOR = 0.4;
/**
 * XP earned for an action that raised the gauge total by `gaugeGain` (sum of
 * Satiety+Spirit+Vigor+Hygiene+Health deltas, post-clamp). Returns 0 for a
 * no-op / net-negative action (e.g. playing with an already-joyful familiar),
 * so it can't be farmed by spamming a maxed gauge — XP only flows for care
 * that actually helped. Scaled by the same care-streak multiplier as passive
 * XP for consistency.
 */
export function eidolonCareXp(gaugeGain: number, streakCount = 0): number {
  if (!Number.isFinite(gaugeGain) || gaugeGain <= 0) return 0;
  return Math.round(gaugeGain * EIDOLON_CARE_XP_FACTOR * streakXpMultiplier(streakCount));
}

/* ---- visiting (patting another player's familiar) ---- */
/** Cooldown between pats of the same familiar by the same visitor (24h). */
export const EIDOLON_PAT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Joy a pat grants the visited familiar (small, < a Play action). */
export const EIDOLON_PAT_JOY_GAIN = 3;

/* ---- heal economy (shared so the client can label the basic-heal cost) ---- */
/** Currency charged for a basic (item-less) Remedy click. */
export const EIDOLON_BASIC_HEAL_COST = 15;
/** Health restored by a basic heal. */
export const EIDOLON_BASIC_HEAL_AMOUNT = 8;
/** Health restored by a potion (which also fully cures sickness). */
export const EIDOLON_POTION_HEAL_AMOUNT = 35;

/* ---- dormancy + Potion-revive (the chosen death model) ---- */
/** Health a Potion-revive restores a dormant familiar to. */
export const EIDOLON_REVIVE_HEALTH = 45;
/** Floor the morale/upkeep stats are lifted to on revive, so a familiar woken
 *  from dormancy with a starved/filthy stat doesn't instantly drain back to 0. */
export const EIDOLON_REVIVE_FLOOR = 35;
/** Stats for a familiar revived from dormancy: health restored to a safe band
 *  and the (collapsed) upkeep stats lifted off the floor. A fragile second
 *  life — NOT a full reset — so neglect still costs the lost time + a Potion.
 *  Sickness is cleared by the caller. Pure; the server applies it. */
export function reviveStats(s: EidolonStats): EidolonStats {
  return clampStats({
    satiety: Math.max(s.satiety, EIDOLON_REVIVE_FLOOR),
    joy: Math.max(s.joy, EIDOLON_REVIVE_FLOOR),
    vigor: Math.max(s.vigor, EIDOLON_REVIVE_FLOOR),
    hygiene: Math.max(s.hygiene, EIDOLON_REVIVE_FLOOR),
    health: EIDOLON_REVIVE_HEALTH,
  });
}

/* =========================================================================
   Food economy — feeding a real catalog Food item. Foods are MULTI-STAT:
   every food restores Satiety, and many also restore a little Spirit (joy),
   Vigor, or Hygiene, so the shop has flavor (a hearty stew vs. a sweet cake).
   Shared so the server applies it and the in-game drawer could preview it.
   Health is never restored by food (that's the Remedy/Potion economy).
   ========================================================================= */

/** Satiety restored by feeding one of an item. Explicit table for the built-in
 *  foods; for anything else (admin-added food, no nutrition column), a
 *  price-derived fallback clamped to 12..50. */
export const EIDOLON_FOOD_SATIETY: Record<string, number> = {
  candies: 10, cookie: 14, onion: 12, mushroom: 12, tomato: 14, apple: 16, pear: 16,
  honeypot: 20, fish: 22, loaf_of_bread: 24, cheese_wheel: 26, turkey_leg: 30, pie: 30,
  bowl_of_stew: 34, cake: 40, hammock_of_cake: 50,
};
export function eidolonFoodSatiety(item: { key: string; price: number }): number {
  if (EIDOLON_FOOD_SATIETY[item.key] != null) return EIDOLON_FOOD_SATIETY[item.key]!;
  return Math.max(12, Math.min(50, 12 + Math.round((item.price ?? 0) / 8)));
}

/** Per-food bonus to the non-Satiety stats — what makes a food "multi-stat".
 *  Sweets cheer (joy), hearty meals invigorate (vigor), fresh produce is a
 *  little cleansing (hygiene). Built-in foods only; the default is a small joy. */
export const EIDOLON_FOOD_BONUS: Record<string, { joy?: number; vigor?: number; hygiene?: number }> = {
  candies: { joy: 10 }, cookie: { joy: 8 }, cake: { joy: 14 }, pie: { joy: 12 }, hammock_of_cake: { joy: 18 },
  honeypot: { joy: 10, vigor: 4 },
  fish: { vigor: 8 }, turkey_leg: { vigor: 10 }, bowl_of_stew: { vigor: 12, joy: 4 },
  apple: { hygiene: 4, joy: 3 }, pear: { hygiene: 4, joy: 3 }, tomato: { vigor: 4 }, mushroom: { vigor: 5 },
  cheese_wheel: { vigor: 4 }, loaf_of_bread: { vigor: 4 },
};

export interface EidolonFoodEffect { satiety: number; joy: number; vigor: number; hygiene: number }
/** Total positive stat deltas from feeding one of an item: Satiety from the
 *  table + any multi-stat bonus + a small default joy (eating is a pleasure).
 *  The FEED handler also applies a tiny Hygiene cost (eating is messy) and
 *  scales `joy` by the familiar's joyGain trait. Pure. */
export function eidolonFoodEffect(item: { key: string; price: number }): EidolonFoodEffect {
  const b = EIDOLON_FOOD_BONUS[item.key] ?? {};
  return { satiety: eidolonFoodSatiety(item), joy: b.joy ?? 2, vigor: b.vigor ?? 0, hygiene: b.hygiene ?? 0 };
}

/* =========================================================================
   Toys — REUSABLE play-things (the `category:'toy'` catalog items seeded by
   migration 0207). Unlike food/potions, a toy is NOT consumed: owning one lets
   the player play with it freely for a bigger, varied joy boost beyond the free
   Play gesture. Each toy has its own profile (energetic vs. soothing vs.
   splashy). Toys never RESTORE Vigor (only spend it or leave it), so there's no
   free-resource exploit; joy is naturally bounded by the 100 cap.
   ========================================================================= */
export interface EidolonToyEffect { joy: number; vigor: number; hygiene: number }
/** Per-toy effect, keyed by the `toy_*` item key (see migration 0207). Joy is
 *  scaled by the familiar's joyGain trait in the handler; vigor/hygiene apply
 *  flat. Unknown toys fall back to the free Play gesture's profile. */
export const EIDOLON_TOY_EFFECT: Record<string, EidolonToyEffect> = {
  toy_feather: { joy: 20, vigor: -4, hygiene: 0 },  // Feather Teaser — energetic
  toy_ball: { joy: 18, vigor: -6, hygiene: 0 },     // Snow Ball — a tiring chase
  toy_dice: { joy: 12, vigor: 0, hygiene: 0 },      // Bone Dice — a calm game
  toy_plushie: { joy: 16, vigor: 0, hygiene: 0 },   // Cuddle Plushie — soothing
  toy_balloon: { joy: 14, vigor: -4, hygiene: 8 },  // Water Balloon — splashy + a rinse
};
export const eidolonToyEffect = (itemKey: string): EidolonToyEffect =>
  EIDOLON_TOY_EFFECT[itemKey] ?? { joy: 14, vigor: -2, hygiene: 0 };

/* =========================================================================
   Rare eggs — a hatch has a small chance to be a special VARIANT (currently
   the "prismatic": a shimmering version of a species). Variants are visual
   prestige + a modest sale-value bump; they don't change decay, so they're a
   lucky cosmetic windfall, not a power tier. Species only (pets use their own
   art). Surprise-at-hatch (no egg-select change) so it stays a happy moment.
   ========================================================================= */
export const EIDOLON_VARIANT_IDS = ["prismatic"] as const;
export type EidolonVariantId = (typeof EIDOLON_VARIANT_IDS)[number];
export const EIDOLON_VARIANTS: Record<EidolonVariantId, { label: string; saleMult: number }> = {
  prismatic: { label: "Prismatic", saleMult: 1.15 },
};
/** Chance a freshly hatched SPECIES egg is a rare variant. */
export const EIDOLON_VARIANT_CHANCE = 0.08;
const isVariantId = (v: string | null | undefined): v is EidolonVariantId =>
  !!v && (EIDOLON_VARIANT_IDS as readonly string[]).includes(v);
/** Sale-value multiplier from the variant (1 for none/unknown). */
export const eidolonVariantSaleMult = (variant: string | null | undefined): number =>
  isVariantId(variant) ? EIDOLON_VARIANTS[variant].saleMult : 1;
/** Roll a rare variant at hatch (server-side); null = ordinary. */
export const rollVariant = (): EidolonVariantId | null =>
  Math.random() < EIDOLON_VARIANT_CHANCE ? "prismatic" : null;

/* =========================================================================
   Lineage — when a familiar departs (sold/released) it's recorded in The Hall,
   and the NEXT familiar this identity hatches inherits from the most recent
   one: a level-scaled XP head-start (so it visibly starts a little grown) plus
   the predecessor's personality trait (the "bloodline"). The inherited XP is
   tracked separately (bonusXp) and is NOT sellable — only EARNED xp counts
   toward sale value — so a hatch->sell loop can't farm the head-start.
   ========================================================================= */
export const EIDOLON_LINEAGE_XP_PER_LEVEL = 12;
export const EIDOLON_LINEAGE_XP_CAP = 250;
/** The non-sellable XP head-start a new familiar inherits from a predecessor
 *  that reached `peakLevel`. Level 1 predecessors pass nothing on. */
export const eidolonLineageBonusXp = (peakLevel: number): number =>
  Math.min(EIDOLON_LINEAGE_XP_CAP, Math.max(0, Math.floor(peakLevel) - 1) * EIDOLON_LINEAGE_XP_PER_LEVEL);

/** Currency a familiar fetches when sold, accounting for the non-sellable
 *  inherited head-start (only EARNED xp sells) and the variant prestige bump.
 *  The single source of truth shared by the snapshot + the sell endpoint. */
export function eidolonSaleValueOf(totalXp: number, bonusXp: number, variant: string | null | undefined): number {
  const earned = Math.max(0, totalXp - Math.max(0, bonusXp));
  return Math.round(eidolonSaleValue(earned) * eidolonVariantSaleMult(variant));
}

/** How a familiar left its keeper, for The Hall memorial. */
export type EidolonDepartReason = "sold" | "released";
/** One memorial record in The Hall — a familiar that has departed. Read-only. */
export interface EidolonHallEntry {
  id: string;
  name: string;
  kind: "species" | "pet";
  speciesId: EidolonSpeciesId | null;
  trait: EidolonTraitId | null;
  variant: EidolonVariantId | null;
  peakLevel: number;
  ageHours: number;
  departReason: EidolonDepartReason;
  /** Wall-clock ms the familiar departed. */
  departedAt: number;
}
