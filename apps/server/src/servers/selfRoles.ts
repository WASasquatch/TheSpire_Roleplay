/**
 * Self-roles + server onboarding — Multi-Server Lift (Batch 2).
 *
 * Two member-facing surfaces built on the EXISTING usergroup system
 * (servers/usergroups.ts + the serverUsergroupMembers roster), gated behind the
 * same `serversEnabled` flag every server route respects:
 *
 *   Self-roles — a permission-RELAXED clone of the manager usergroup-member
 *   routes. Where those require `manage_usergroups`, these let ANY participant
 *   join/leave a group the owner marked `member_selectable = 1`. The relaxation
 *   is tightly clamped: the group must belong to THIS server AND be
 *   member_selectable AND non-default; a member can only touch their OWN
 *   membership; and an `isAuto` row (earned via auto-join rules) is sticky —
 *   self-leave never removes it (earned standing sticks, exactly as the auto
 *   engine documents). Usergroups grant member FEATURES only, so this can never
 *   mint a moderator regardless of what a client sends.
 *
 *     GET    /servers/:id/self-roles        (canParticipate) the member_selectable
 *                                           groups + which the caller is in.
 *     PUT    /servers/:id/self-roles/:gid   self-join a member_selectable group.
 *     DELETE /servers/:id/self-roles/:gid   self-leave (skips sticky isAuto rows).
 *
 *   Onboarding — a new member answers a set of prompts on join; each chosen
 *   option maps to a member_selectable usergroup which we grant. The prompt set
 *   is an OnboardingConfig stored on server_settings.onboarding_config_json
 *   (Foundation wired the column + settings read); completion reuses the
 *   per-(user,server) serverWelcomeSeen row (`seen_hash` = the onboarding hash)
 *   so an owner editing the flow re-shows it, mirroring the welcome-hash gate.
 *
 *     GET  /servers/:id/onboarding          { config, hash, completed }.
 *     POST /servers/:id/onboarding/complete { hash, selections } — validate each
 *                                           usergroupId is in the prompt option
 *                                           set + member_selectable, grant the
 *                                           memberships, upsert serverWelcomeSeen.
 *
 * IntB registers this in routes/servers.ts (registerServerRoutes). Cross-server
 * safe: every group/usergroup row is scoped on `server_id = :id`; a client id
 * from another server is invisible (404), never joinable. Every write re-checks
 * authority (never trusts the client), and each route 404/403s when the flag is
 * off or the caller can't participate.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import type { OnboardingConfig } from "@thekeep/shared";
import {
  serverUsergroupMembers,
  serverUsergroups,
  serverWelcomeSeen,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "../routes/auth.js";
import { areServersEnabled, getServerSettings, getSettings } from "../settings.js";
import { tFor } from "../i18n.js";
import { serverAuthority } from "./authority.js";

/**
 * Stable short hash of an onboarding config, matching settings.ts' hashWelcome
 * recipe (sha-256 truncated to 16 hex). Gates re-show: editing the flow changes
 * the hash so members re-onboard; an empty/absent flow hashes to "" so the
 * client can shortcut "nothing to onboard". Hashed on the canonical serialized
 * JSON the owner console stored, so the client and completion checks agree.
 */
function hashOnboarding(configJson: string | null): string {
  if (!configJson || !configJson.trim()) return "";
  return createHash("sha256").update(configJson).digest("hex").slice(0, 16);
}

/**
 * Parse a stored OnboardingConfig JSON into a shape safe to work with. Tolerant
 * of bad/legacy JSON (returns an empty flow). Only the fields we read are kept;
 * unknown keys are ignored so a future config extension never breaks this route.
 */
function parseOnboardingConfig(configJson: string | null): OnboardingConfig {
  if (!configJson) return { prompts: [] };
  try {
    const raw = JSON.parse(configJson) as unknown;
    if (!raw || typeof raw !== "object") return { prompts: [] };
    const prompts = Array.isArray((raw as { prompts?: unknown }).prompts)
      ? (raw as { prompts: unknown[] }).prompts
      : [];
    const out: OnboardingConfig["prompts"] = [];
    for (const p of prompts) {
      if (!p || typeof p !== "object") continue;
      const pr = p as Record<string, unknown>;
      const id = typeof pr.id === "string" ? pr.id : null;
      const label = typeof pr.label === "string" ? pr.label : null;
      const kind = pr.kind === "multi" ? "multi" : "single";
      if (!id || !label) continue;
      const options: OnboardingConfig["prompts"][number]["options"] = [];
      const rawOpts = Array.isArray(pr.options) ? pr.options : [];
      for (const o of rawOpts) {
        if (!o || typeof o !== "object") continue;
        const oo = o as Record<string, unknown>;
        const optLabel = typeof oo.label === "string" ? oo.label : null;
        const usergroupId = typeof oo.usergroupId === "string" ? oo.usergroupId : null;
        if (!optLabel || !usergroupId) continue;
        options.push({ label: optLabel, usergroupId });
      }
      out.push({
        id,
        label,
        ...(typeof pr.help === "string" ? { help: pr.help } : {}),
        kind,
        options,
      });
    }
    return { prompts: out };
  } catch {
    return { prompts: [] };
  }
}

/**
 * Resolve caller + this server's authority for a member-facing route. The flag
 * is checked here so every route is inert when servers are disabled. All these
 * routes require `canParticipate` (read/join is a member action — no manager
 * permission). Sets the reply code + returns null on failure.
 */
async function gate(
  req: FastifyRequest,
  reply: FastifyReply,
  db: Db,
  serverId: string,
): Promise<{ meId: string; serverId: string; locale: string | null } | null> {
  if (!areServersEnabled(await getSettings(db))) {
    reply.code(404);
    return null;
  }
  const me = await getSessionUser(req, db);
  if (!me) {
    reply.code(401);
    return null;
  }
  const a = await serverAuthority(db, me, serverId);
  if (!a.server) {
    reply.code(404);
    return null;
  }
  if (!a.canParticipate) {
    reply.code(403);
    return null;
  }
  return { meId: me.id, serverId: a.server.id, locale: me.locale };
}

/**
 * A member-selectable, non-default group scoped to THIS server. Returns the row
 * or null; the cross-server + member_selectable clamp lives in the WHERE so a
 * client id from another server (or a non-selectable/default group) is
 * invisible — never self-joinable.
 */
async function selectableGroup(db: Db, serverId: string, groupId: string) {
  return (await db
    .select()
    .from(serverUsergroups)
    .where(and(
      eq(serverUsergroups.id, groupId),
      eq(serverUsergroups.serverId, serverId),
      eq(serverUsergroups.memberSelectable, true),
      eq(serverUsergroups.isDefault, false),
    ))
    .limit(1))[0];
}

/**
 * Register the member-facing self-roles + onboarding routes. Mounted once by
 * registerServerRoutes (IntB) after the manager usergroup routes.
 */
export async function registerSelfRolesRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /* =========================================================
   *  Self-roles — member-picked usergroups
   * ========================================================= */

  /** The member_selectable groups of this server + which the caller is in. */
  app.get<{ Params: { id: string } }>("/servers/:id/self-roles", async (req, reply) => {
    const g = await gate(req, reply, db, req.params.id);
    if (!g) return { error: "forbidden" };

    const groups = await db
      .select({
        id: serverUsergroups.id,
        name: serverUsergroups.name,
        color: serverUsergroups.color,
        description: serverUsergroups.description,
        sortOrder: serverUsergroups.sortOrder,
      })
      .from(serverUsergroups)
      .where(and(
        eq(serverUsergroups.serverId, g.serverId),
        eq(serverUsergroups.memberSelectable, true),
        eq(serverUsergroups.isDefault, false),
      ))
      .orderBy(serverUsergroups.sortOrder, serverUsergroups.createdAt);

    // Which of THOSE the caller currently holds (auto or manual).
    const ids = groups.map((x) => x.id);
    const mineIds = ids.length
      ? new Set(
          (await db
            .select({ groupId: serverUsergroupMembers.groupId })
            .from(serverUsergroupMembers)
            .where(and(
              eq(serverUsergroupMembers.userId, g.meId),
              inArray(serverUsergroupMembers.groupId, ids),
            )))
            .map((m) => m.groupId),
        )
      : new Set<string>();

    return {
      groups: groups.map((x) => ({
        id: x.id,
        name: x.name,
        color: x.color ?? null,
        description: x.description ?? null,
        member: mineIds.has(x.id),
      })),
    };
  });

  /** Self-join a member_selectable group (idempotent). */
  app.put<{ Params: { id: string; gid: string } }>("/servers/:id/self-roles/:gid", async (req, reply) => {
    const g = await gate(req, reply, db, req.params.id);
    if (!g) return { error: "forbidden" };

    const group = await selectableGroup(db, g.serverId, req.params.gid);
    if (!group) {
      reply.code(404);
      return { error: tFor(g.locale, "errors:server.servers.roleNotSelfSelectable") };
    }

    // isAuto false = a self-picked membership. onConflictDoNothing keeps this
    // idempotent AND preserves an existing auto row (never downgrades it).
    await db
      .insert(serverUsergroupMembers)
      .values({ groupId: group.id, userId: g.meId, addedBy: g.meId, isAuto: false })
      .onConflictDoNothing();

    return { ok: true, member: true };
  });

  /** Self-leave a member_selectable group. Sticky: an isAuto (earned) row is
   *  never removed — auto-earned standing sticks, matching the auto engine. */
  app.delete<{ Params: { id: string; gid: string } }>("/servers/:id/self-roles/:gid", async (req, reply) => {
    const g = await gate(req, reply, db, req.params.id);
    if (!g) return { error: "forbidden" };

    const group = await selectableGroup(db, g.serverId, req.params.gid);
    if (!group) {
      reply.code(404);
      return { error: tFor(g.locale, "errors:server.servers.roleNotSelfSelectable") };
    }

    // Only delete a MANUAL row. An auto membership (isAuto = 1) is earned and
    // stays; the caller keeps the role but the request is a benign no-op.
    await db
      .delete(serverUsergroupMembers)
      .where(and(
        eq(serverUsergroupMembers.groupId, group.id),
        eq(serverUsergroupMembers.userId, g.meId),
        eq(serverUsergroupMembers.isAuto, false),
      ));

    // Report the resulting membership honestly (an auto row survives → still a
    // member) so the client can reconcile its toggle without a refetch.
    const still = (await db
      .select({ groupId: serverUsergroupMembers.groupId })
      .from(serverUsergroupMembers)
      .where(and(
        eq(serverUsergroupMembers.groupId, group.id),
        eq(serverUsergroupMembers.userId, g.meId),
      ))
      .limit(1))[0];
    return { ok: true, member: !!still };
  });

  /* =========================================================
   *  Onboarding — new-member prompt flow
   * ========================================================= */

  /** The server's onboarding config + hash + whether the caller has completed
   *  the CURRENT version. Returns an empty flow when onboarding is off so IntA
   *  can uniformly treat "nothing to show" as completed. */
  app.get<{ Params: { id: string } }>("/servers/:id/onboarding", async (req, reply) => {
    const g = await gate(req, reply, db, req.params.id);
    if (!g) return { error: "forbidden" };

    const settings = await getServerSettings(db, g.serverId);
    // Off (master switch or no config) → present as an empty, already-complete
    // flow so the client never shows an onboarding modal for it.
    if (!settings.onboardingEnabled || !settings.onboardingConfigJson) {
      return { config: { prompts: [] } as OnboardingConfig, hash: "", completed: true };
    }

    const config = parseOnboardingConfig(settings.onboardingConfigJson);
    if (config.prompts.length === 0) {
      return { config, hash: "", completed: true };
    }
    const hash = hashOnboarding(settings.onboardingConfigJson);

    const seen = (await db
      .select({ seenHash: serverWelcomeSeen.seenHash })
      .from(serverWelcomeSeen)
      .where(and(
        eq(serverWelcomeSeen.userId, g.meId),
        eq(serverWelcomeSeen.serverId, g.serverId),
      ))
      .limit(1))[0];
    const completed = !!seen && seen.seenHash === hash;

    return { config, hash, completed };
  });

  /** Complete onboarding: validate every selected usergroup is a member_selectable
   *  option in THIS config, grant the memberships, and stamp serverWelcomeSeen
   *  so the flow doesn't re-show until the owner edits it (hash change). */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/servers/:id/onboarding/complete",
    async (req, reply) => {
      const g = await gate(req, reply, db, req.params.id);
      if (!g) return { error: "forbidden" };

      const body = (req.body ?? {}) as { hash?: unknown; selections?: unknown };
      const clientHash = typeof body.hash === "string" && body.hash.length <= 64 ? body.hash : "";
      const selections = Array.isArray(body.selections)
        ? body.selections.filter((s): s is string => typeof s === "string")
        : [];

      const settings = await getServerSettings(db, g.serverId);
      // Onboarding off → nothing to complete; still stamp so a stale client
      // stops asking. Stamp with "" (the current hash of an empty flow).
      if (!settings.onboardingEnabled || !settings.onboardingConfigJson) {
        await upsertSeen(db, g.meId, g.serverId, "");
        return { ok: true, granted: [] as string[] };
      }

      const config = parseOnboardingConfig(settings.onboardingConfigJson);
      const currentHash = hashOnboarding(settings.onboardingConfigJson);

      // The set of usergroupIds this config actually offers — the ONLY groups a
      // completion may grant. A client-supplied id outside this set is dropped.
      const offered = new Set<string>();
      for (const p of config.prompts) for (const o of p.options) offered.add(o.usergroupId);
      const candidateIds = [...new Set(selections)].filter((id) => offered.has(id));

      // Re-verify against the DB: each must still be a member_selectable,
      // non-default group of THIS server (never trust the config alone — an
      // owner may have deleted/locked a group after publishing the flow).
      let granted: string[] = [];
      if (candidateIds.length) {
        const valid = await db
          .select({ id: serverUsergroups.id })
          .from(serverUsergroups)
          .where(and(
            inArray(serverUsergroups.id, candidateIds),
            eq(serverUsergroups.serverId, g.serverId),
            eq(serverUsergroups.memberSelectable, true),
            eq(serverUsergroups.isDefault, false),
          ));
        granted = valid.map((v) => v.id);
        for (const groupId of granted) {
          await db
            .insert(serverUsergroupMembers)
            .values({ groupId, userId: g.meId, addedBy: g.meId, isAuto: false })
            .onConflictDoNothing();
        }
      }

      // Record what the member actually saw. If the config changed mid-flow the
      // client's hash won't match; store the LIVE hash so we don't lock them out
      // of the new version (they'll re-onboard on next entry), matching the
      // welcome-dismiss "record the current version" behavior.
      const stampHash = clientHash === currentHash ? clientHash : currentHash;
      await upsertSeen(db, g.meId, g.serverId, stampHash);

      return { ok: true, granted };
    },
  );
}

/**
 * Upsert the per-(user,server) serverWelcomeSeen row's seen_hash. Reused by both
 * the welcome flow and onboarding: the same row records "this member has seen the
 * current server intro" and the hash gates re-show when the owner edits it.
 */
async function upsertSeen(db: Db, userId: string, serverId: string, hash: string): Promise<void> {
  await db
    .insert(serverWelcomeSeen)
    .values({ userId, serverId, seenHash: hash })
    .onConflictDoUpdate({
      target: [serverWelcomeSeen.userId, serverWelcomeSeen.serverId],
      set: { seenHash: hash, seenAt: new Date() },
    });
}
