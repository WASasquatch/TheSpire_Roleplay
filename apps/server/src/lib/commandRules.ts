/**
 * Per-server command availability (server_command_rules +
 * server_command_role_gates, migration 0355) — the room_role_gates idiom
 * lifted to commands.
 *
 * A rule targets the registry's CANONICAL lowercase name (aliases resolve to
 * it before any check; custom commands ride the same lane by name):
 *   mode='disabled' — refused for everyone in that server's rooms;
 *   mode='roles'    — only usergroup holders with a matching role row may
 *                     run it. A 'roles' rule with ZERO surviving role rows
 *                     (group-delete cascade) falls back to available-to-
 *                     everyone by design — the console calls this out.
 *
 * SERVER STAFF (server_members owner/admin/mod; NULL rooms.server_id homes
 * to the default server) and SITE STAFF bypass every rule, mirroring the
 * room role-gate posture. The gate COMPOSES with the existing dispatch
 * gates (post-mode, mutes, per-command permission checks): every gate must
 * still independently pass.
 *
 * NEVER-RESTRICTABLE commands: /help and /report stay available under any
 * configuration, and any builtin already gated by its own `permission`
 * field is exempt too (restricting a staff-gated command is moot — the
 * console refuses to write rules for these, and dispatch ignores stray
 * rows). Zero rules = everything available, byte-identical to before.
 *
 * This module is the single audit point for both read shapes:
 *   - commandRestrictionFor — the dispatch chokepoint's per-send check
 *     (one indexed PK read when no rule exists — the common case);
 *   - loadCommandRules — ONE batched read of a server's whole rule set for
 *     list surfaces (GET /commands filtering, the console editor), plus
 *     the pure commandUnavailableWith for callers that already batched.
 */

import { and, eq, inArray } from "drizzle-orm";
import { isModeratorRole, type Role } from "@thekeep/shared";
import { serverCommandRoleGates, serverCommandRules, serverMembers, servers, serverUsergroupMembers } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { usergroupIdsFor } from "./roleGates.js";

/** Safety set: these canonical names can never be restricted. `report` has
 *  no builtin today (reports are HTTP) but is pinned per the design so a
 *  future /report command is born unrestrictable. */
export const ALWAYS_AVAILABLE_COMMANDS: ReadonlySet<string> = new Set(["help", "report"]);

/** The handler fields the rule system needs — a full CommandHandler always
 *  satisfies this. */
export interface RuleCommand {
  name: string;
  permission?: string | undefined;
}

/** True when no rule may ever apply to this command: the always-available
 *  safety set plus anything staff-permission-gated by its own definition. */
export function isRuleExemptCommand(cmd: RuleCommand): boolean {
  return !!cmd.permission || ALWAYS_AVAILABLE_COMMANDS.has(cmd.name.toLowerCase());
}

export interface CommandRule {
  mode: "disabled" | "roles";
  roleIds: Set<string>;
}

/** Every rule of one server in two batched reads, keyed by canonical name. */
export async function loadCommandRules(db: Db, serverId: string): Promise<Map<string, CommandRule>> {
  const out = new Map<string, CommandRule>();
  const rules = await db
    .select()
    .from(serverCommandRules)
    .where(eq(serverCommandRules.serverId, serverId));
  if (rules.length === 0) return out;
  for (const r of rules) out.set(r.command, { mode: r.mode, roleIds: new Set() });
  const gates = await db
    .select({ command: serverCommandRoleGates.command, usergroupId: serverCommandRoleGates.usergroupId })
    .from(serverCommandRoleGates)
    .where(eq(serverCommandRoleGates.serverId, serverId));
  for (const g of gates) out.get(g.command)?.roleIds.add(g.usergroupId);
  return out;
}

/** Is this user server staff of `serverId`? server_members owner/admin/mod,
 *  plus the servers.owner_user_id column directly (owners normally carry a
 *  role='owner' member row too, but the column is the source of truth). */
export async function isServerStaffOf(db: Db, userId: string, serverId: string): Promise<boolean> {
  const row = (await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
      inArray(serverMembers.role, ["owner", "admin", "mod"]),
    ))
    .limit(1))[0];
  if (row) return true;
  const owner = (await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.ownerUserId, userId)))
    .limit(1))[0];
  return !!owner;
}

/**
 * Pure form of the availability decision for callers that already batched
 * the reads (GET /commands). True = the viewer must NOT see/run `cmd`.
 * `viewerStaff` covers BOTH bypass tiers (site staff or server staff) —
 * resolve it once per request, not per command.
 */
export function commandUnavailableWith(
  cmd: RuleCommand,
  rules: ReadonlyMap<string, CommandRule>,
  viewerStaff: boolean,
  viewerGroupIds: ReadonlySet<string>,
): boolean {
  if (isRuleExemptCommand(cmd)) return false;
  const rule = rules.get(cmd.name.toLowerCase());
  if (!rule) return false;
  if (viewerStaff) return false;
  if (rule.mode === "disabled") return true;
  // mode='roles': zero surviving rows falls back to everyone.
  if (rule.roleIds.size === 0) return false;
  for (const gid of rule.roleIds) if (viewerGroupIds.has(gid)) return false;
  return true;
}

/**
 * Batch form of the availability check for the inline `!cmd` lane. The
 * expander in addMessage is synchronous, so the DB reads happen up front:
 * returns every canonical name carrying an effective restriction for this
 * author in `serverId`, or undefined when nothing is blocked (no rules, or
 * the author holds a bypass tier). `permissionOf` resolves a rule's command
 * name to its handler's own permission gate so permission-gated builtins
 * keep their stray-row exemption.
 */
export async function blockedCommandNamesFor(
  db: Db,
  user: { id: string; role: Role },
  serverId: string,
  permissionOf: (name: string) => string | undefined,
): Promise<ReadonlySet<string> | undefined> {
  if (isModeratorRole(user.role)) return undefined;
  const rules = await loadCommandRules(db, serverId);
  if (rules.size === 0) return undefined;
  if (await isServerStaffOf(db, user.id, serverId)) return undefined;
  const groupIds = await usergroupIdsFor(db, user.id);
  const blocked = new Set<string>();
  for (const name of rules.keys()) {
    if (commandUnavailableWith({ name, permission: permissionOf(name) }, rules, false, groupIds)) {
      blocked.add(name);
    }
  }
  return blocked.size > 0 ? blocked : undefined;
}

/**
 * The dispatch chokepoint's per-send check. Returns why the command must be
 * refused ("disabled" | "role") or null when it may proceed. Cheap by
 * construction: exempt commands and site staff never read; everyone else
 * costs one indexed PK read (empty for the overwhelmingly common no-rule
 * case), and the server-staff / role-membership reads only run while a rule
 * is actually in play.
 */
export async function commandRestrictionFor(
  db: Db,
  user: { id: string; role: Role },
  serverId: string,
  cmd: RuleCommand,
): Promise<"disabled" | "role" | null> {
  if (isRuleExemptCommand(cmd)) return null;
  if (isModeratorRole(user.role)) return null;
  const rule = (await db
    .select()
    .from(serverCommandRules)
    .where(and(
      eq(serverCommandRules.serverId, serverId),
      eq(serverCommandRules.command, cmd.name.toLowerCase()),
    ))
    .limit(1))[0];
  if (!rule) return null;
  if (await isServerStaffOf(db, user.id, serverId)) return null;
  if (rule.mode === "disabled") return "disabled";
  const gateRows = await db
    .select({ usergroupId: serverCommandRoleGates.usergroupId })
    .from(serverCommandRoleGates)
    .where(and(
      eq(serverCommandRoleGates.serverId, serverId),
      eq(serverCommandRoleGates.command, cmd.name.toLowerCase()),
    ));
  // Zero surviving role rows → available to everyone by design.
  if (gateRows.length === 0) return null;
  const membership = (await db
    .select({ groupId: serverUsergroupMembers.groupId })
    .from(serverUsergroupMembers)
    .where(and(
      eq(serverUsergroupMembers.userId, user.id),
      inArray(serverUsergroupMembers.groupId, gateRows.map((r) => r.usergroupId)),
    ))
    .limit(1))[0];
  return membership ? null : "role";
}
