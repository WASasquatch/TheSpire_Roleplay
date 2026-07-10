/**
 * "public" - anyone can join.
 * "private" - password required; /invite whitelists specific users so they
 *             skip the password prompt.
 */
export type RoomType = "public" | "private";

import type { LinkedWorldRef } from "./world.js";
import type { AvatarCrop, Role } from "./profile.js";
import type { TheaterLoop, TheaterSource } from "./theater.js";

export interface RoomSummary {
  id: string;
  name: string;
  type: RoomType;
  topic: string | null;
  ownerId: string | null;
  memberCount: number;
  /** When true, /npc is rejected in this room. Owners/mods toggle. */
  npcDisabled: boolean;
  /**
   * When true the room is EXEMPT from the empty-room archival sweep (server
   * channels default to this so the server's structure doesn't vanish when a
   * channel empties). Owners toggle it from the Rooms console; ad-hoc user
   * rooms stay false and still park when the last occupant leaves.
   */
  persistent: boolean;
  /**
   * EFFECTIVE 18+ rating for this room (`server.is_nsfw OR room.is_nsfw`,
   * age-restriction plan Phase 2). Drives the "18+" / "SFW" chips in the
   * rail, Room Info bar, and expanded banner. Cosmetic mirror only — the
   * server hides 18+ rooms from minors entirely, so a minor never receives
   * a row with this set. Optional: absent (older bundle, or not yet
   * populated) means all-ages.
   */
  isNsfw?: boolean;
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
  /**
   * Theater (synchronized watch-party) CONFIG for this room. When
   * `theaterMode` is true the chat renders a video panel above the
   * message list and owners/mods drive shared playback; everyone else
   * follows. The live playback position is NOT here - it rides the
   * `theater:sync` socket event (see TheaterSync). These three fields
   * are owner/mod-toggleable via `/theater` and persisted on the room.
   */
  theaterMode: boolean;
  theaterLoop: TheaterLoop;
  theaterPlaylist: TheaterSource[];
  /**
   * Forum container id (Forums revamp). Non-null ⇒ this room is a BOARD
   * inside that forum: the chat room list filters it out (the Forums
   * Catalog is its home), keeping only the caller's CURRENT room visible
   * so navigation never strands them. Filtering keys on this field, NOT
   * on replyMode — standalone nested rooms stay in the room list.
   */
  forumId: string | null;
  /**
   * The server this room belongs to (Multi-Server Lift). The client derives
   * its CURRENT server purely from the room it's in, so this is what drives
   * the server rail's active pill and the per-server rooms scoping. It is
   * populated ONLY when the servers feature flag is on (the server stamps the
   * effective server, treating a NULL row as the default/is_system server);
   * with the flag off it stays null so the shell is byte-identical to today.
   */
  serverId: string | null;
  /**
   * Room icon shown left of the name in the Room Info bar. Holds EITHER an
   * http(s) image URL (rendered as <img>) OR a short emoji/text glyph
   * (rendered as-is). Set via `/icon` (owner/mod/admin). Null = no icon.
   */
  icon: string | null;
  /** Room creation time (epoch ms). Surfaced as a "Created …" stat. */
  createdAt: number;
  /**
   * Cumulative count of visible chat messages this room has EVER received
   * (say/me/ooc/roll/scene/npc). Only ever incremented — unaffected by
   * retention/expiry truncation — so it reflects lifetime activity, not the
   * shrinking live buffer. Persists across archive/resurrect.
   */
  messageCount: number;
  /**
   * Title of the room's currently-open scene (set by `/scene <title>`,
   * cleared by `/scene end`). Null when no scene is open. Surfaced in the
   * Room Info bar/pullout so a late joiner sees the active beat.
   */
  currentSceneTitle: string | null;
  /**
   * Per-channel notification/read hints (migration 0318). Optional so older
   * server bundles that don't compute them omit them (the client treats absent
   * as "muted false / 0 unread / no mention"). `muted` is the caller's per-room
   * mute (`per_room_notify_prefs`); `unread` is the caller's unread count for
   * this room past their `room_reads` high-water mark; `hasMention` is true when
   * any unread row @mentions the caller. Live deltas ride the `room:unread`
   * socket event.
   */
  muted?: boolean;
  unread?: number;
  hasMention?: boolean;
}

/**
 * Full room dossier behind the Room Info bar's expandable pullout. Served by
 * `GET /rooms/:id/info` and lazy-loaded only when a viewer expands the bar, so
 * the heavier fields (description, NPC history) stay off the hot-path room
 * broadcast. The password is NEVER included.
 */
export interface RoomInfo {
  id: string;
  name: string;
  type: RoomType;
  /** URL-safe link handle (migration 0260). Drives the `{room:<slug>}`
   *  navigation chip; surfaced in the Room Info pullout as a copyable
   *  token. Null only for a row not yet backfilled. */
  slug: string | null;
  icon: string | null;
  /** Long-form room description (the `/describe` text). Null when unset. */
  description: string | null;
  topic: string | null;
  /** Display name of the current owner, or null for system/ownerless rooms. */
  ownerName: string | null;
  createdAt: number;
  messageCount: number;
  /** Distinct NPC display names ever voiced in this room, in first-seen order. */
  npcs: string[];
  currentScene: { title: string; imageUrl: string | null } | null;
  replyMode: "flat" | "nested";
  messageExpiryMinutes: number | null;
  difficultyClass: number | null;
  theaterMode: boolean;
  /** Effective 18+ rating (same semantics as RoomSummary.isNsfw); absent = all-ages. */
  isNsfw?: boolean;
  linkedWorld: LinkedWorldRef | null;
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
   * tab, their last socket dropped but they're inside the configured
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
  /**
   * Per-room role for THIS identity, drives the userlist crown. Derived
   * server-side: "owner" only on the room owner's OOC/master row
   * (rooms.owner_id), "mod" only on the exact identity a /promote
   * targeted (room_mods), else "member". NOT the per-account
   * room_members.role (that's the moderation-authority source and would
   * paint a crown on every character an owner/mod voices).
   */
  role: "owner" | "mod" | "member";
  /** Account-level role (users.role). Lets the UI mark site admins regardless of room role. */
  accountRole: Role;
  /** Free-text current mood/expression set via /mood. Null when unset. */
  mood: string | null;
  // primaryWorld was retired in migration 0187, with per-identity
  // world memberships the cross-identity "primary world" badge
  // became meaningless, and the userlist grouping it drove was the
  // surface that visibly linked characters to their master's world
  // affiliation. The world's own member list is now the source of
  // truth for "who's in this world."
  /**
   * Earning, the occupant's current rank/tier on the relevant pool.
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
   * Earning, name style + per-user config for live rendering of
   * styled display names. Set when the user has a style equipped via
   * the dashboard; null when on the default rendering.
   *
   * `nameStyleConfig` is the parsed JSON shape the style's CSS reads
   * (color picks, glow strength, etc.), schema varies per style.
   * Renderer falls back to the style's defaults when null.
   */
  activeNameStyleKey: string | null;
  nameStyleConfig: Record<string, unknown> | null;
  /**
   * The user's MASTER/OOC name style + config, present even when
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
   * Earning, purchasable cosmetic state for the occupant.
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
   *                             set, the BorderedAvatar renderer
   *                             checks the freeform slot first and
   *                             falls back to the rank-tied slot.
   *  inlineAvatarEnabled        Master-scoped toggle for the
   *                             "show avatar after the timestamp in
   *                             chat lines + replace gender-icon click
   *                             target in userlist" cosmetic.
   */
  avatarUrl: string | null;
  /**
   * Owner-chosen zoom + focal point for the resolved avatar above.
   * Mirrors `avatarUrl`'s scope rule: when the occupant is voicing a
   * character, this is the character's crop; otherwise the master's.
   * BorderedAvatar applies it whenever it differs from the default
   * (centered, no zoom). See `AvatarCrop` for field semantics.
   */
  avatarCrop: AvatarCrop;
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
   * above, past OOC messages from a user currently voicing a
   * character still render with the user's master cosmetic
   * choices, not the character's.
   */
  masterAvatarUrl: string | null;
  /** Master-slot crop for OOC backlog rendering. Parallel to
   *  `masterAvatarUrl`: even when this row represents a character,
   *  the chat renderer still uses this to crop the user's OOC
   *  avatar on past OOC messages. */
  masterAvatarCrop: AvatarCrop;
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
