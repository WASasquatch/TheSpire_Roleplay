import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/index.js";
import type { Io } from "./shared.js";
import { registerStoryCatalogRoutes } from "./catalogRoutes.js";
import { registerStoryChapterRoutes } from "./chapterRoutes.js";
import { registerStoryEngagementRoutes } from "./engagementRoutes.js";
import { registerStoryCodexRoutes } from "./codexRoutes.js";
import { registerStoryReportRoutes } from "./reportRoutes.js";

export async function registerStoryRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  await registerStoryCatalogRoutes(app, db);
  await registerStoryChapterRoutes(app, db, io);
  await registerStoryEngagementRoutes(app, db, io);
  await registerStoryCodexRoutes(app, db, io);
  await registerStoryReportRoutes(app, db, io);
}
