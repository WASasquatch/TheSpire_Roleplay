/**
 * Auto-moderation rule wire shape — server `automod_rules` table (migration
 * 0319). A configurable rule the chat + forum pipelines consult before a
 * message lands: it MATCHES on a `kind` and applies an `action`. Rules are
 * site-wide (`serverId` null) or scoped to one community server; `scope` picks
 * which surfaces a rule polices. Gated behind the `automodEnabled` site setting;
 * the `bypass_automod` permission (trusted + mod + admin by default) exempts
 * staff. The feature team owns the concrete matching/enforcement logic; this
 * type is just the persisted/serialized shape.
 */

/**
 * What a rule matches on.
 *   keyword     — a literal word/phrase (honors `caseInsensitive` / `wholeWord`).
 *   regex       — `pattern` is a regular-expression source.
 *   link        — any URL in the message.
 *   invite      — a chat/forum/other-service invite link.
 *   mention_cap — too many @mentions in one message (`pattern` = the numeric cap).
 */
export type AutomodRuleKind = "keyword" | "regex" | "link" | "invite" | "mention_cap";

/** What a matched rule does. */
export type AutomodRuleAction = "warn" | "delete" | "mute";

/** Which surfaces a rule polices. */
export type AutomodRuleScope = "chat" | "forum" | "both";

/** One auto-moderation rule as sent to the client (admin console). */
export interface AutomodRule {
  id: string;
  /** null = site-wide; set = scoped to this community server. */
  serverId: string | null;
  enabled: boolean;
  kind: AutomodRuleKind;
  /** Matcher input: word/phrase, regex source, or the numeric cap for mention_cap. */
  pattern: string;
  action: AutomodRuleAction;
  /** Mute duration (ms) when `action === "mute"`; null = engine default. */
  muteMs: number | null;
  scope: AutomodRuleScope;
  caseInsensitive: boolean;
  wholeWord: boolean;
  /** Admin note explaining the rule; null = none. */
  note: string | null;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}
