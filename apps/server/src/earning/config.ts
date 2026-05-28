/**
 * Earning system configuration.
 *
 * Every numeric input the XP / Currency / Rank engine touches lives
 * here, not hardcoded in the award pipeline. The runtime state is
 * persisted as a JSON blob on `site_settings.earning_config_json`
 * (single column, since the shape is deeply nested and admin edits
 * replace the whole document atomically through the structured
 * Awards-tab form).
 *
 * Reads route through `getSettings()` which calls `parseEarningConfig`
 * on the stored JSON. Parse failures or NULL fall back to
 * `DEFAULT_EARNING_CONFIG`, so an empty or corrupt config row never
 * brings the earning engine down — earning just behaves as if no
 * admin override were in place.
 */

/** Per-pool award amounts for a single source-kind. */
export interface AwardAmount {
  xp: number;
  currency: number;
}

/** Per-pool enable flags for a single source. Either flag = false → that pool earns 0 from that source. */
export interface SourceEnableFlags {
  xp: boolean;
  currency: boolean;
}

/**
 * Length-bonus curve for a single message kind. Linear interpolation
 * between (floorChars, 1.0x) and (ceilChars, maxMultiplier); below
 * floor stays 1.0x, above ceil clamps to maxMultiplier.
 *   enabled=false → always 1.0x
 *   maxMultiplier <= 1 → effectively disabled (no upside)
 */
export interface LengthBonusSpec {
  enabled: boolean;
  floorChars: number;
  ceilChars: number;
  maxMultiplier: number;
}

export interface EarningConfig {
  /** Master kill-switch. When false, no source awards anything. */
  enabled: boolean;
  awards: {
    message: {
      say: AwardAmount;
      action: AwardAmount;
      whisper: AwardAmount;
    };
    forum: {
      topic: AwardAmount;
      reply: AwardAmount;
    };
    presence: {
      perBlock: AwardAmount;
    };
  };
  /** Messages shorter than this many trimmed characters earn 0. */
  bodyFloorChars: number;
  /**
   * Per-message-kind length-bonus + spam-detection knobs.
   *
   * Length bonus rewards effort on action / scene RP posts. The award
   * engine multiplies the per-kind XP+Currency by a linearly-
   * interpolated factor between 1.0x at `floorChars` and `maxMultiplier`
   * at `ceilChars`. Messages above `ceilChars` clamp to the max — no
   * "infinite wall of text" exploit. Disabled per-kind = always 1.0x.
   *
   * Spam detection drops the award to 0 for messages that fail any of
   * the heuristics in `analyzeMessageQuality`:
   *   - very low unique-char ratio over a length threshold
   *     ("aaaaaaaaaaa", "!!!!!!!!!!")
   *   - a single token dominating the body ("spam spam spam spam")
   *   - exact-duplicate of the user's last few messages (echo)
   * The ledger row carries `metadata.flaggedSpam = true` so admins can
   * audit + tune; `enabled: false` skips all checks (legacy behavior).
   */
  messageQuality: {
    /** Per-message-kind length bonus. Action defaults to a steeper
     *  curve than say — RP posts get the reward, casual chat gets a
     *  flatter multiplier. Whisper inherits action's settings but is
     *  effectively no-op while whisper award is 0. */
    lengthBonus: {
      say: LengthBonusSpec;
      action: LengthBonusSpec;
      whisper: LengthBonusSpec;
    };
    /** Spam detection — applied AFTER the length multiplier (so a
     *  100-word spammy wall of text still earns 0). */
    spam: {
      enabled: boolean;
      /** Below this many trimmed chars, skip every heuristic (short
       *  messages like "yes" are not spam — they just earn the base
       *  rate). */
      minLengthToCheck: number;
      /** Reject messages where (unique chars / total chars) is below
       *  this AND length ≥ minLengthToCheck. 0.18 catches most
       *  keysmash / repeated-letter spam without dinging legitimate
       *  short repetitions. Range 0..1; 0 disables. */
      uniqueCharRatioFloor: number;
      /** Reject messages where any single whitespace-split token
       *  occupies > this fraction of the body. 0.55 catches "spam
       *  spam spam spam" without dinging legitimate "no no no no". */
      dominantTokenRatioCap: number;
      /** How many of the user's most recent messages to compare
       *  against for echo detection. 0 disables. The cache is bounded
       *  per-user in memory. */
      echoLookback: number;
    };
  };
  /** Length of a single presence-award block in minutes. Default 5. */
  presenceBlockMinutes: number;
  /** Hard cap on presence blocks awarded per scope per UTC day. */
  presenceDailyBlockCap: number;
  enabledSources: {
    message: SourceEnableFlags;
    forum: SourceEnableFlags;
    presence: SourceEnableFlags;
  };
  /**
   * Multiplier applied to per-character IC awards when the user has
   * more than one character logged in. 1.0 = each character earns
   * the full configured rate; lower throttles multi-character earning
   * if it inflates the economy in production. Masteradmin-only field
   * in the Awards tab.
   */
  multiCharacterEarnDivisor: number;
  /** Anti-abuse gates on `/currency send`. */
  currencyTransfer: {
    enabled: boolean;
    dailySendCap: number;
    dailyReceiveCap: number;
    minSenderAccountAgeDays: number;
    minRecipientAccountAgeDays: number;
    minTransferAmount: number;
    maxTransferAmount: number;
  };
  backfill: {
    /** One-time XP per historical message at boot-time backfill. 0 = skip. */
    xpPerHistoricalMessage: number;
    /** Epoch ms when backfill last ran; non-null = skip on next boot. */
    completedAt: number | null;
  };
}

export const DEFAULT_EARNING_CONFIG: EarningConfig = {
  enabled: true,
  awards: {
    message: {
      say: { xp: 3, currency: 3 },
      action: { xp: 5, currency: 5 },
      whisper: { xp: 0, currency: 0 },
    },
    forum: {
      topic: { xp: 25, currency: 25 },
      reply: { xp: 10, currency: 10 },
    },
    presence: {
      perBlock: { xp: 1, currency: 1 },
    },
  },
  bodyFloorChars: 5,
  messageQuality: {
    lengthBonus: {
      // Casual chat — gentle curve. A heart-felt one-liner shouldn't
      // be punished, but a paragraph reply gets a small bump.
      say: { enabled: true, floorChars: 40, ceilChars: 240, maxMultiplier: 1.5 },
      // RP action posts — steeper curve. A descriptive paragraph
      // earns ~2x; a long scene-setting block earns 3x.
      action: { enabled: true, floorChars: 60, ceilChars: 600, maxMultiplier: 3.0 },
      // Whispers default to whatever the action curve is — moot
      // while the whisper award is 0, but the knob is there if an
      // admin enables whisper rewards.
      whisper: { enabled: false, floorChars: 60, ceilChars: 600, maxMultiplier: 1.0 },
    },
    spam: {
      enabled: true,
      minLengthToCheck: 12,
      // 0.18 = "1 unique character per ~5.5 total chars". Catches
      // "aaaaaaaaaaa" and "!!!!!!!!!!!!" without tripping legitimate
      // short emphatic posts.
      uniqueCharRatioFloor: 0.18,
      // 0.55 = "more than half the body is a single repeated token".
      // Catches "spam spam spam spam" without dinging "no, no, no!".
      dominantTokenRatioCap: 0.55,
      echoLookback: 3,
    },
  },
  presenceBlockMinutes: 5,
  presenceDailyBlockCap: 12,
  enabledSources: {
    message: { xp: true, currency: true },
    forum: { xp: true, currency: true },
    presence: { xp: true, currency: true },
  },
  multiCharacterEarnDivisor: 1.0,
  currencyTransfer: {
    enabled: true,
    dailySendCap: 500,
    dailyReceiveCap: 5000,
    minSenderAccountAgeDays: 14,
    minRecipientAccountAgeDays: 14,
    minTransferAmount: 1,
    maxTransferAmount: 1000,
  },
  backfill: {
    // 5 XP per historical message — same scale as the live `action`
    // award (5 XP). The system gets dropped onto installs that
    // already have months/years of message history, and the previous
    // 1 XP/message was too thin to put longtime regulars anywhere
    // near the ranks the new (raised) thresholds expect. At 5/msg a
    // user with ~5000 lifetime posts lands around the bottom of
    // Recognized — proportional to the activity they actually had.
    // Admins can still tune via the Awards tab; this is just the
    // seeded default for fresh installs.
    xpPerHistoricalMessage: 5.0,
    completedAt: null,
  },
};

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function amount(input: unknown, fallback: AwardAmount): AwardAmount {
  const src = obj(input);
  return { xp: num(src.xp, fallback.xp), currency: num(src.currency, fallback.currency) };
}

function flags(input: unknown, fallback: SourceEnableFlags): SourceEnableFlags {
  const src = obj(input);
  return { xp: bool(src.xp, fallback.xp), currency: bool(src.currency, fallback.currency) };
}

function lengthBonus(input: unknown, fallback: LengthBonusSpec): LengthBonusSpec {
  const src = obj(input);
  return {
    enabled: bool(src.enabled, fallback.enabled),
    floorChars: Math.max(0, num(src.floorChars, fallback.floorChars)),
    ceilChars: Math.max(0, num(src.ceilChars, fallback.ceilChars)),
    // Clamp to a sane upper bound — 10x on a 5XP base = 50XP per
    // message, which is already extreme. Beyond that is almost
    // certainly an admin typo.
    maxMultiplier: Math.max(1.0, Math.min(10.0, num(src.maxMultiplier, fallback.maxMultiplier))),
  };
}

/**
 * Normalize a stored JSON blob (or a partial admin patch) into a full
 * EarningConfig. Every missing key falls back to the corresponding
 * value in DEFAULT_EARNING_CONFIG, so the engine can trust the
 * returned shape unconditionally. Unknown/extra keys are dropped.
 */
export function normalizeEarningConfig(input: unknown): EarningConfig {
  const src = obj(input);
  const awards = obj(src.awards);
  const awardsMessage = obj(awards.message);
  const awardsForum = obj(awards.forum);
  const awardsPresence = obj(awards.presence);
  const enabledSources = obj(src.enabledSources);
  const transfer = obj(src.currencyTransfer);
  const backfill = obj(src.backfill);
  const def = DEFAULT_EARNING_CONFIG;
  return {
    enabled: bool(src.enabled, def.enabled),
    awards: {
      message: {
        say: amount(awardsMessage.say, def.awards.message.say),
        action: amount(awardsMessage.action, def.awards.message.action),
        whisper: amount(awardsMessage.whisper, def.awards.message.whisper),
      },
      forum: {
        topic: amount(awardsForum.topic, def.awards.forum.topic),
        reply: amount(awardsForum.reply, def.awards.forum.reply),
      },
      presence: {
        perBlock: amount(awardsPresence.perBlock, def.awards.presence.perBlock),
      },
    },
    bodyFloorChars: num(src.bodyFloorChars, def.bodyFloorChars),
    messageQuality: (() => {
      const mq = obj(src.messageQuality);
      const lb = obj(mq.lengthBonus);
      const sp = obj(mq.spam);
      const defMq = def.messageQuality;
      return {
        lengthBonus: {
          say: lengthBonus(lb.say, defMq.lengthBonus.say),
          action: lengthBonus(lb.action, defMq.lengthBonus.action),
          whisper: lengthBonus(lb.whisper, defMq.lengthBonus.whisper),
        },
        spam: {
          enabled: bool(sp.enabled, defMq.spam.enabled),
          minLengthToCheck: Math.max(0, num(sp.minLengthToCheck, defMq.spam.minLengthToCheck)),
          uniqueCharRatioFloor: Math.max(0, Math.min(1, num(sp.uniqueCharRatioFloor, defMq.spam.uniqueCharRatioFloor))),
          dominantTokenRatioCap: Math.max(0, Math.min(1, num(sp.dominantTokenRatioCap, defMq.spam.dominantTokenRatioCap))),
          echoLookback: Math.max(0, Math.min(20, num(sp.echoLookback, defMq.spam.echoLookback))),
        },
      };
    })(),
    presenceBlockMinutes: num(src.presenceBlockMinutes, def.presenceBlockMinutes),
    presenceDailyBlockCap: num(src.presenceDailyBlockCap, def.presenceDailyBlockCap),
    enabledSources: {
      message: flags(enabledSources.message, def.enabledSources.message),
      forum: flags(enabledSources.forum, def.enabledSources.forum),
      presence: flags(enabledSources.presence, def.enabledSources.presence),
    },
    multiCharacterEarnDivisor: num(src.multiCharacterEarnDivisor, def.multiCharacterEarnDivisor),
    currencyTransfer: {
      enabled: bool(transfer.enabled, def.currencyTransfer.enabled),
      dailySendCap: num(transfer.dailySendCap, def.currencyTransfer.dailySendCap),
      dailyReceiveCap: num(transfer.dailyReceiveCap, def.currencyTransfer.dailyReceiveCap),
      minSenderAccountAgeDays: num(transfer.minSenderAccountAgeDays, def.currencyTransfer.minSenderAccountAgeDays),
      minRecipientAccountAgeDays: num(transfer.minRecipientAccountAgeDays, def.currencyTransfer.minRecipientAccountAgeDays),
      minTransferAmount: num(transfer.minTransferAmount, def.currencyTransfer.minTransferAmount),
      maxTransferAmount: num(transfer.maxTransferAmount, def.currencyTransfer.maxTransferAmount),
    },
    backfill: {
      xpPerHistoricalMessage: num(backfill.xpPerHistoricalMessage, def.backfill.xpPerHistoricalMessage),
      completedAt:
        backfill.completedAt === null || backfill.completedAt === undefined
          ? null
          : num(backfill.completedAt, 0) || null,
    },
  };
}

/**
 * Parse the raw stored JSON string. Null or invalid JSON falls back to
 * DEFAULT_EARNING_CONFIG so the engine always has a usable config.
 */
export function parseEarningConfig(json: string | null | undefined): EarningConfig {
  if (!json) return DEFAULT_EARNING_CONFIG;
  try {
    return normalizeEarningConfig(JSON.parse(json));
  } catch {
    return DEFAULT_EARNING_CONFIG;
  }
}
