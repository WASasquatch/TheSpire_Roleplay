/**
 * "public" - anyone can join.
 * "private" - password required; /invite whitelists specific users so they
 *             skip the password prompt.
 */
export type RoomType = "public" | "private";

import type { LinkedWorldRef } from "./world.js";
import type { Role } from "./profile.js";

export interface RoomSummary {
  id: string;
  name: string;
  type: RoomType;
  topic: string | null;
  ownerId: string | null;
  memberCount: number;
  /** When true, /npc is rejected in this room. Owners/mods toggle. */
  npcDisabled: boolean;
  /** World linked to this room (one per room). Surfaced as a banner in chat. Null when no world is linked. */
  linkedWorld: LinkedWorldRef | null;
  /**
   * Per-room message lifetime in minutes. Null = the global retention
   * setting governs. When set, the janitor deletes messages in this room
   * older than this many minutes; the chat surfaces a small
   * "messages auto-expire" hint so participants know.
   */
  messageExpiryMinutes: number | null;
  /**
   * Chat rendering mode for this room.
   *   "flat"   - chronological, replies appear at the end of the timeline.
   *   "nested" - replies group under their parent in a thread container.
   * Owner/mod toggleable.
   */
  replyMode: "flat" | "nested";
}

export type Gender = "male" | "female" | "nonbinary" | "other" | "undisclosed";

export interface RoomOccupant {
  userId: string;
  /** display name resolved from active character (or master username) */
  displayName: string;
  characterId: string | null;
  away: boolean;
  awayMessage: string | null;
  /**
   * True when this occupant is a ghost held over from a disconnected
   * tab — their last socket dropped but they're inside the configured
   * idle-grace window (see site_settings.idleGraceMs). The userlist
   * renders idle rows faded out with an "(idle)" suffix so onlookers
   * can tell they're not active. Distinct from `away`, which is a
   * user-driven /away state with an optional message and applies even
   * while live.
   */
  idle: boolean;
  /** Hex chat color (e.g. "#990000") if user has set one */
  chatColor: string | null;
  /** Resolved gender - character.stats.gender if active, else user.gender */
  gender: Gender;
  /** Per-room role (room_members.role). */
  role: "owner" | "mod" | "member";
  /** Account-level role (users.role). Lets the UI mark site admins regardless of room role. */
  accountRole: Role;
  /** Free-text current mood/expression set via /mood. Null when unset. */
  mood: string | null;
  /**
   * The user's primary world membership, if any. Drives userlist grouping:
   * occupants with the same primaryWorld.id band together under a section
   * header. Null = unaffiliated.
   */
  primaryWorld: LinkedWorldRef | null;
  /**
   * Earning — the occupant's current rank/tier on the relevant pool.
   * Drives the inline sigil rendered next to the display name in the
   * userlist (and reused as the source of truth for chat-line sigils
   * via lookup-by-userId).
   *
   * Scope: when the occupant is attached as a character, this is the
   * CHARACTER's rank (per-character pool); when OOC, it's the master
   * OOC pool's rank. Null = pool below the lowest enabled rank tier
   * (fresh account, or every rank disabled).
   */
  rankKey: string | null;
  tier: number | null;
  /**
   * Earning — name style + per-user config for live rendering of
   * styled display names. Set when the user has a style equipped via
   * the dashboard; null when on the default rendering.
   *
   * `nameStyleConfig` is the parsed JSON shape the style's CSS reads
   * (color picks, glow strength, etc.) — schema varies per style.
   * Renderer falls back to the style's defaults when null.
   */
  activeNameStyleKey: string | null;
  nameStyleConfig: Record<string, unknown> | null;
  /**
   * The user's MASTER/OOC name style + config — present even when
   * the occupant is voicing a character. The chat renderer uses
   * this to style past messages the user authored OOC (where
   * `message.characterId === null`) while still using the active
   * character's style for the current row. Without this the
   * renderer would have no master entry to look up when a user
   * voicing a character is currently in the room, and their OOC
   * backlog would render unstyled.
   */
  masterNameStyleKey: string | null;
  masterNameStyleConfig: Record<string, unknown> | null;
  /**
   * Earning — purchasable cosmetic state for the occupant.
   *
   *  avatarUrl                  Resolved per-identity avatar (character
   *                             when attached, else master). Lets the
   *                             userlist + chat-line inline-avatar
   *                             renderer paint without a second fetch.
   *  selectedBorderRankKey      Rank whose border ring wraps the
   *                             avatar. Per-scope: character's pick
   *                             when attached, master's pick otherwise.
   *                             Null = no border.
   *  selectedFreeformBorderKey  Free-form (non-rank-tied) border key
   *                             from the parallel `freeform_borders`
   *                             catalog. Takes precedence over
   *                             `selectedBorderRankKey` when both are
   *                             set — the BorderedAvatar renderer
   *                             checks the freeform slot first and
   *                             falls back to the rank-tied slot.
   *  inlineAvatarEnabled        Master-scoped toggle for the
   *                             "show avatar after the timestamp in
   *                             chat lines + replace gender-icon click
   *                             target in userlist" cosmetic.
   */
  avatarUrl: string | null;
  selectedBorderRankKey: string | null;
  selectedFreeformBorderKey: string | null;
  /**
   * Per-identity color customization for the equipped freeform border,
   * if any. Parsed JSON object keyed by `--c-<name>` var-name (without
   * the `--c-` prefix) → CSS color string. Renderer inlines these on
   * the BorderedAvatar portal so the cascade overrides the template's
   * `var(--c-name, <fallback>)` references. Null when no customization
   * has been saved (renderer falls back to the catalog row's fallbacks).
   */
  freeformBorderConfig: Record<string, string> | null;
  inlineAvatarEnabled: boolean;
  /**
   * Master/OOC fallbacks for the avatar + border + inline-avatar
   * cosmetics. Same rationale as the master name-style fields
   * above — past OOC messages from a user currently voicing a
   * character still render with the user's master cosmetic
   * choices, not the character's.
   */
  masterAvatarUrl: string | null;
  masterSelectedBorderRankKey: string | null;
  masterSelectedFreeformBorderKey: string | null;
  masterFreeformBorderConfig: Record<string, string> | null;
  masterInlineAvatarEnabled: boolean;
  /**
   * Userlist display preference. When true AND the occupant has a
   * resolved rank, the rooms-tree row renders the rank sigil in place
   * of the gender glyph (and the rank itself becomes the profile
   * click target). When false (default) or when no rank is resolved,
   * the gender glyph renders as before and no rank sigil sits next
   * to the name.
   *
   * Per-user preference broadcast on each presence update so a
   * toggle in the profile editor propagates to every viewer's
   * rail without a reload.
   */
  useRankAsUserlistIcon: boolean;
}
