/**
 * Role-picker panels (`/roleselect`) — shared body-token contract.
 *
 * A panel is a normal persisted chat message whose BODY is a list of lines,
 * one per offered role:
 *
 *     [emoji ]{role:<usergroupId>}
 *
 * The body is the durable definition (ids + optional emoji, exactly like a
 * poll's pollDataJson); the LIVE half — group name, color, whether the
 * viewer holds it — is hydrated per viewer into `ChatMessage.roleSelect`
 * ({@link RoleSelectState}) by the server, mirroring the PollState pipeline.
 * A token whose group is gone / no longer member-selectable simply has no
 * entry in the hydrated state, and the client renders that line as plain
 * text — never clickable.
 */

/** Hard cap on roles per panel — keeps the card a card, not a wall. */
export const ROLE_SELECT_MAX_ROLES = 20;

export interface RoleSelectToken {
  /** Optional emoji glyph rendered before the role name. */
  emoji: string | null;
  usergroupId: string;
  /** The original body line, echoed for plain-text fallback rendering. */
  raw: string;
}

/** One live, member-selectable role offered by the panel. */
export interface RoleSelectEntry {
  usergroupId: string;
  name: string;
  /** Owner-styled group color; tint the CHIP, never a username. */
  color: string | null;
  description: string | null;
  /** Whether THIS viewer currently holds the group. */
  member: boolean;
}

/** Per-viewer hydrated panel state (rides `ChatMessage.roleSelect`). */
export interface RoleSelectState {
  /** The room's server — the self-role toggle endpoints key on it. */
  serverId: string;
  roles: RoleSelectEntry[];
}

const ROLE_LINE_RX = /^(?:(\S{1,16})[\s ]+)?\{role:([A-Za-z0-9_-]{1,64})\}$/;

/**
 * Parse a message body into its panel tokens. A line must be EXACTLY an
 * optional emoji glyph + one `{role:…}` token to count; anything else on
 * the line disqualifies it, so ordinary prose that happens to mention a
 * token never turns into a widget. Letters in the prefix disqualify it too
 * (an emoji is never alphabetic) — digits stay legal for keycap emoji.
 * Empty result = not a panel.
 */
export function parseRoleSelectBody(body: string | null | undefined): RoleSelectToken[] {
  if (!body || !body.includes("{role:")) return [];
  const out: RoleSelectToken[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = ROLE_LINE_RX.exec(line);
    if (!m) continue;
    const emoji = m[1] ?? null;
    if (emoji && /\p{L}/u.test(emoji)) continue;
    out.push({ emoji, usergroupId: m[2]!, raw: line });
  }
  return out;
}

/** Serialize picker entries back into the canonical panel body. */
export function buildRoleSelectBody(
  entries: Array<{ emoji: string | null; usergroupId: string }>,
): string {
  return entries
    .map((e) => (e.emoji ? `${e.emoji} {role:${e.usergroupId}}` : `{role:${e.usergroupId}}`))
    .join("\n");
}
