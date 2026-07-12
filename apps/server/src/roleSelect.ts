/**
 * Role-picker server helpers — shared by the /roleselect command, backlog
 * hydration, and the older-pages route. Mirrors polls.ts: the panel
 * DEFINITION lives in the message body ({role:<usergroupId>} token lines,
 * parsed by @thekeep/shared roleSelect.ts); this module joins it with the
 * LIVE half — group names/colors and the viewer's memberships — into the
 * per-viewer {@link RoleSelectState} the client renders.
 *
 * The read is clamped exactly like the self-role endpoints (servers/
 * selfRoles.ts): only THIS server's member-selectable, non-default groups
 * hydrate. A token pointing anywhere else gets no entry, and the client
 * renders that line as plain text — never clickable — so a deleted group,
 * a later-flipped memberSelectable flag, or a cross-server id can never
 * mint a working toggle.
 */
import { and, eq, inArray } from "drizzle-orm";
import { parseRoleSelectBody, type RoleSelectState } from "@thekeep/shared";
import { serverUsergroupMembers, serverUsergroups } from "./db/schema.js";
import type { Db } from "./db/index.js";

/**
 * Hydrate a panel body for one viewer. `viewerId` null (the creation
 * broadcast, which is viewer-agnostic like a fresh poll's zero tallies)
 * marks every role un-held; the per-viewer truth is restored on backlog
 * hydration. Returns null when the body isn't a panel or none of its
 * tokens resolve — the caller then leaves the row un-hydrated and the
 * client shows the raw text.
 */
export async function loadRoleSelectState(
  db: Db,
  roomServerId: string,
  viewerId: string | null,
  body: string | null | undefined,
): Promise<RoleSelectState | null> {
  const tokens = parseRoleSelectBody(body);
  if (tokens.length === 0) return null;
  const ids = [...new Set(tokens.map((t) => t.usergroupId))];
  const groups = await db
    .select({
      id: serverUsergroups.id,
      name: serverUsergroups.name,
      color: serverUsergroups.color,
      description: serverUsergroups.description,
    })
    .from(serverUsergroups)
    .where(and(
      inArray(serverUsergroups.id, ids),
      eq(serverUsergroups.serverId, roomServerId),
      eq(serverUsergroups.memberSelectable, true),
      eq(serverUsergroups.isDefault, false),
    ));
  if (groups.length === 0) return null;
  const mine = viewerId
    ? new Set(
        (await db
          .select({ groupId: serverUsergroupMembers.groupId })
          .from(serverUsergroupMembers)
          .where(and(
            eq(serverUsergroupMembers.userId, viewerId),
            inArray(serverUsergroupMembers.groupId, groups.map((g) => g.id)),
          )))
          .map((m) => m.groupId),
      )
    : new Set<string>();
  return {
    serverId: roomServerId,
    roles: groups.map((g) => ({
      usergroupId: g.id,
      name: g.name,
      color: g.color ?? null,
      description: g.description ?? null,
      member: mine.has(g.id),
    })),
  };
}
