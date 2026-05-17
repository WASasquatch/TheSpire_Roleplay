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
