/**
 * Shared permission gate for routes registered behind the admin
 * `preHandler` (which attaches the session user to `req.sessionUser`).
 * Returns the session user on success so handlers that need it for
 * audit metadata can capture it through the same call; returns `null`
 * after sending a 403 when the user is missing the requested key.
 *
 * Usage:
 *   const me = await requireSessionPermission(req, reply, "kick_user", db);
 *   if (!me) return;
 *   // ... me is the session user, ready for audit metadata
 *
 * Or, when the handler doesn't need the user object:
 *   if (!(await requireSessionPermission(req, reply, "view_admin_settings", db))) return;
 *
 * `null` is falsy, so the boolean-style call site shape is preserved.
 *
 * Originally inlined into three separate admin/*.ts registrars
 * (admin/routes, admin/earning, admin/backup) with diverging shapes
 *, boolean in one, user-or-null in the others. Centralised here so
 * a future audit can grep one definition.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { PermissionKey, Role } from "@thekeep/shared";
import type { Db } from "../db/index.js";
import { hasPermission } from "./permissions.js";

export interface SessionUserCtx {
  id: string;
  role: Role;
  /**
   * Age context (age-restriction plan Phase 0). Present whenever the ctx
   * was attached from `getSessionUser` (the admin preHandler does), so
   * admin handlers can gate on the caller's age without a re-fetch.
   * Optional because the interface is also satisfied by narrower {id,
   * role} projections in older call sites.
   */
  birthdate?: string | null;
  isAdult?: boolean;
  hideNsfw?: boolean;
}

export async function requireSessionPermission(
  req: FastifyRequest,
  reply: FastifyReply,
  key: PermissionKey,
  db: Db,
): Promise<SessionUserCtx | null> {
  const me = (req as FastifyRequest & { sessionUser?: SessionUserCtx }).sessionUser;
  if (!me || !(await hasPermission(me, key, db))) {
    reply.code(403);
    reply.send({ error: "forbidden", missing: key });
    return null;
  }
  return me;
}
