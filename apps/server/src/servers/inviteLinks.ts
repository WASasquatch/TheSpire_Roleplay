/**
 * Server invite links — the shared policy + redemption core behind:
 *   - the public `/i/<code>` landing (GET /servers/invite/:code),
 *   - the logged-in one-click join (POST /servers/invite/:code/join),
 *   - member/staff invite creation (POST /servers/:id/invites),
 *   - the signup carry-through (/auth/register + /auth/google/finish
 *     `inviteCode`), and
 *   - the first-landing placement tier (socketHandlers).
 *
 * One module so the liveness predicate (revoked / expired / used up), the
 * who-may-create policy (servers.invite_create_mode, migration 0356), and the
 * atomic use-claim can never drift between surfaces. Redemption composes with
 * — never bypasses — the existing join gates: server moderation, the hard 18+
 * age gate, server bans, and application-mode review (an invite code does NOT
 * skip the application queue; that matches the pre-existing /servers/:id/join
 * behavior, which refuses application-mode servers before ever reading a
 * code).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { SERVER_MEMBER_INVITE_CAP } from "@thekeep/shared";
import {
  rooms,
  serverInvites,
  serverMembers,
  serverUsergroupMembers,
  servers,
  users,
} from "../db/schema.js";
import { findServerLanding } from "../realtime/broadcast.js";
import type { Db } from "../db/index.js";
import { isServerModerationActive } from "./moderation.js";
import { serverAuthority, serverCan, type ServerAuthority, type ServerCaller } from "./authority.js";

type InviteRow = typeof serverInvites.$inferSelect;
type ServerRow = typeof servers.$inferSelect;

/** Live = not revoked, not expired, under its use cap. */
export function isInviteLive(inv: InviteRow, now = Date.now()): boolean {
  if (inv.revokedAt) return false;
  if (inv.expiresAt && +inv.expiresAt <= now) return false;
  if (inv.maxUses != null && inv.usedCount >= inv.maxUses) return false;
  return true;
}

/** The 'roles'-mode allowlist (servers.invite_create_group_ids, JSON
 *  string[]). Malformed/NULL reads as empty — fail closed. */
export function parseInviteCreateGroupIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Staff tier for invite purposes: the owner or a manage_invites holder.
 *  Staff always may create, are exempt from the member cap, and may revoke
 *  anyone's invites. */
export function isInviteStaff(a: ServerAuthority): boolean {
  return a.isOwner || serverCan(a, "manage_invites");
}

/**
 * May this caller mint an invite link for the server? Staff always;
 * otherwise the owner's `invite_create_mode` policy decides ('staff' —
 * the default — admits nobody else; 'all' admits any member; 'roles'
 * admits members of the picked usergroups). Never on a moderated server,
 * never for banned callers, non-members, or members who can no longer
 * participate.
 */
export async function canCreateServerInvite(
  db: Db,
  a: ServerAuthority,
  userId: string,
): Promise<boolean> {
  if (!a.server) return false;
  if (isInviteStaff(a)) return true;
  // canParticipate composes the hard 18+ gate: an isNsfw flip KEEPS minor
  // members' rows (keep-but-hide), so isMember alone would still let a
  // minor member of an 18+ community mint public invites to it.
  if (!a.isMember || a.ban || !a.canParticipate) return false;
  if (isServerModerationActive(a.server)) return false;
  const mode = a.server.inviteCreateMode;
  if (mode === "all") return true;
  if (mode === "roles") {
    const groupIds = parseInviteCreateGroupIds(a.server.inviteCreateGroupIds);
    if (groupIds.length === 0) return false;
    const hit = (await db
      .select({ groupId: serverUsergroupMembers.groupId })
      .from(serverUsergroupMembers)
      .where(eq(serverUsergroupMembers.userId, userId)))
      .some((r) => groupIds.includes(r.groupId));
    return hit;
  }
  return false; // 'staff'
}

/** Count a creator's ACTIVE invites on one server (the non-staff cap,
 *  {@link SERVER_MEMBER_INVITE_CAP}). Live rows only — revoked/expired/spent
 *  invites free their slot. */
export async function countLiveInvitesBy(db: Db, serverId: string, userId: string): Promise<number> {
  const now = Date.now();
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(serverInvites)
    .where(and(
      eq(serverInvites.serverId, serverId),
      eq(serverInvites.createdByUserId, userId),
      isNull(serverInvites.revokedAt),
      sql`(${serverInvites.expiresAt} is null or ${serverInvites.expiresAt} > ${now})`,
      sql`(${serverInvites.maxUses} is null or ${serverInvites.usedCount} < ${serverInvites.maxUses})`,
    ));
  return Number(rows[0]?.n ?? 0);
}

export { SERVER_MEMBER_INVITE_CAP };

/**
 * Resolve an invite code to a REDEEMABLE (live invite + presentable server)
 * pair, or null. "Presentable" deliberately folds the server's own state in:
 * an archived or actively moderated server's invites read as plain invalid —
 * the public surface must never disclose moderation status (age-plan posture:
 * dead is dead, no reason given).
 */
export async function findLiveInvite(
  db: Db,
  code: string,
): Promise<{ invite: InviteRow; server: ServerRow } | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const invite = (await db.select().from(serverInvites)
    .where(eq(serverInvites.code, trimmed)).limit(1))[0];
  if (!invite || !isInviteLive(invite)) return null;
  const server = (await db.select().from(servers)
    .where(eq(servers.id, invite.serverId)).limit(1))[0];
  if (!server) return null;
  if (server.status === "archived") return null;
  if (isServerModerationActive(server)) return null;
  return { invite, server };
}

/**
 * Atomically claim one use of an invite and enroll the user as a member.
 * The conditional UPDATE is the race gate (mirrors the pre-existing
 * /servers/:id/join redemption): concurrent redemptions can't blow past
 * max_uses, and a revocation/expiry that lands mid-flight loses cleanly.
 * Returns false when the claim failed (invite no longer usable).
 */
export function redeemInviteMembership(db: Db, inviteId: string, serverId: string, userId: string): boolean {
  let claimed = false;
  db.transaction((tx) => {
    const claim = tx.update(serverInvites)
      .set({ usedCount: sql`${serverInvites.usedCount} + 1` })
      .where(and(
        eq(serverInvites.id, inviteId),
        isNull(serverInvites.revokedAt),
        sql`(${serverInvites.maxUses} is null or ${serverInvites.usedCount} < ${serverInvites.maxUses})`,
        sql`(${serverInvites.expiresAt} is null or ${serverInvites.expiresAt} > ${Date.now()})`,
      ))
      .run();
    if (claim.changes === 0) return;
    claimed = true;
    tx.insert(serverMembers)
      .values({ serverId, userId, role: "member" })
      .onConflictDoNothing()
      .run();
  });
  return claimed;
}

/**
 * Invites die with the membership: revoke every live invite a departing
 * member created on this server. Called from leave / member-removal /
 * server-ban paths (the pre-existing invite system did NOT do this — codes
 * outlived their creator's membership; the member-creation feature makes
 * that a real abuse channel). Returns the revoked codes so callers can
 * audit. Best-effort by contract — callers must not fail their primary
 * action on this.
 */
export async function revokeInvitesOfMember(db: Db, serverId: string, userId: string): Promise<string[]> {
  const now = Date.now();
  const live = await db
    .select({ id: serverInvites.id, code: serverInvites.code })
    .from(serverInvites)
    .where(and(
      eq(serverInvites.serverId, serverId),
      eq(serverInvites.createdByUserId, userId),
      isNull(serverInvites.revokedAt),
      sql`(${serverInvites.expiresAt} is null or ${serverInvites.expiresAt} > ${now})`,
    ));
  if (live.length === 0) return [];
  for (const row of live) {
    await db.update(serverInvites).set({ revokedAt: new Date() })
      .where(eq(serverInvites.id, row.id));
  }
  return live.map((r) => r.code);
}

/**
 * Signup carry-through (/auth/register + /auth/google/finish `inviteCode`):
 * best-effort join of the invited server for a freshly minted account,
 * composing with every join gate. Refusals are SILENT here by design — the
 * account itself must always succeed; the client's post-boot join attempt
 * re-runs the same gates and surfaces the localized refusal (the honest
 * notice for a minor bouncing off an 18+ community, an application-mode
 * server, or a dead code). On success the account is stamped
 * `users.invited_server_id` so its FIRST socket landing places it in the
 * invited server (see {@link consumeInvitedLanding}); default-server
 * membership and all global onboarding are untouched either way.
 */
export async function redeemInviteForSignup(
  db: Db,
  user: ServerCaller & { id: string; isAdult: boolean },
  code: string,
): Promise<{ joined: boolean; serverId: string | null }> {
  const hit = await findLiveInvite(db, code);
  if (!hit) return { joined: false, serverId: null };
  const { invite, server } = hit;
  // Application-mode review is never bypassed by a code (matches the
  // pre-existing /servers/:id/join semantics, which refuse application-mode
  // servers before reading a code).
  if (server.joinMode === "application") return { joined: false, serverId: null };
  // Hard 18+ gate: an 18+ community accepts no minor member — the invite
  // changes nothing. `canParticipate` can't stand in for this here (it is
  // also false for any non-member of an invite-mode server), so the age
  // slice is checked directly.
  if (server.isNsfw && !user.isAdult) return { joined: false, serverId: null };
  const a = await serverAuthority(db, user, server.id);
  if (a.ban) return { joined: false, serverId: null };
  if (!redeemInviteMembership(db, invite.id, server.id, user.id)) {
    return { joined: false, serverId: null };
  }
  await db.update(users).set({ invitedServerId: server.id }).where(eq(users.id, user.id));
  return { joined: true, serverId: server.id };
}

/**
 * First-landing placement (one-shot): consume `users.invited_server_id` and
 * hand back the invited server's landing room. Called by the socket
 * placement walk AHEAD of the liveliest-room tier, so an invited signup's
 * first screen is the community the link promised. Always clears the stamp
 * (even on failure) — it is strictly a first-landing hint, never a standing
 * preference. Heals an auto-archived landing room in place (the same lazy
 * repair /servers/:id/visit performs) and reports it so the caller can pulse
 * a tree refetch.
 */
export async function consumeInvitedLanding(
  db: Db,
  user: ServerCaller & { id: string },
): Promise<{ roomId: string; serverId: string; healed: boolean } | null> {
  const row = (await db
    .select({ invitedServerId: users.invitedServerId })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1))[0];
  const serverId = row?.invitedServerId ?? null;
  if (!serverId) return null;
  await db.update(users).set({ invitedServerId: null }).where(eq(users.id, user.id));
  // The gates may have shifted between signup and first connect (server
  // moderated, flipped 18+, the account banned) — degrade to the normal
  // landing walk rather than dead-ending the connect.
  const a = await serverAuthority(db, user, serverId);
  if (!a.server || !a.canParticipate || isServerModerationActive(a.server)) return null;
  const landing = await findServerLanding(db, serverId);
  if (!landing) return null;
  let healed = false;
  if (landing.archivedAt) {
    await db.update(rooms)
      .set({ archivedAt: null, archiveHiddenAt: null })
      .where(eq(rooms.id, landing.id));
    healed = true;
  }
  return { roomId: landing.id, serverId, healed };
}
