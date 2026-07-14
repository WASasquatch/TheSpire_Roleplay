import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import type { Io } from "./worlds/shared.js";
import { registerWorldCoreRoutes } from "./worlds/core.js";
import { registerWorldKnowledgeBaseRoutes } from "./worlds/knowledgeBase.js";
import { registerWorldMapRoutes } from "./worlds/maps.js";
import { registerWorldMembershipRoutes } from "./worlds/membership.js";
import { registerWorldApplicationRoutes } from "./worlds/applications.js";

/**
 * Worlds route surface. The implementation was split into cohesive
 * sub-registrars (core CRUD + catalog, knowledge base, membership, and
 * applications); this thin entry point preserves the original public
 * signature so existing importers keep working unchanged. Shared helpers,
 * schemas, and wire-shape projections live in ./worlds/shared.js.
 */
export async function registerWorldRoutes(app: FastifyInstance, db: Db, io: Io, uploadsRoot: string): Promise<void> {
  await registerWorldCoreRoutes(app, db, io);
  await registerWorldKnowledgeBaseRoutes(app, db, io);
  await registerWorldMapRoutes(app, db, io, uploadsRoot);
  await registerWorldMembershipRoutes(app, db, io);
  await registerWorldApplicationRoutes(app, db, io);
}
