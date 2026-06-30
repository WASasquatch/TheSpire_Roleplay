import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { siteSettings } from "../db/schema.js";
import type { Db } from "../db/index.js";

/**
 * Public registration-rules read endpoint. Unauthenticated — these are the
 * Global-Admin-authored HTML rules a prospective owner agrees to before
 * applying to register a server (`?kind=server`) or create a forum
 * (`?kind=forum`). Both live on the singleton `site_settings` row
 * (migration 0301); the consuming application forms fetch the matching kind
 * and show an "I agree" gate. Empty string is the default => no gate, so the
 * forms behave exactly as before until an admin writes rules.
 *
 * Forgiving: a missing/unknown `kind` falls back to the server rules rather
 * than 4xx-ing, so a bare/typo'd link still renders something sensible.
 */
export async function registerRegistrationRulesRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get<{ Querystring: { kind?: string } }>("/api/registration-rules", async (req) => {
    const kind = req.query.kind === "forum" ? "forum" : "server";
    const row = (await db
      .select({
        serverRegistrationRulesHtml: siteSettings.serverRegistrationRulesHtml,
        forumRegistrationRulesHtml: siteSettings.forumRegistrationRulesHtml,
      })
      .from(siteSettings)
      .where(eq(siteSettings.id, "singleton"))
      .limit(1))[0];
    const html =
      kind === "forum"
        ? (row?.forumRegistrationRulesHtml ?? "")
        : (row?.serverRegistrationRulesHtml ?? "");
    return { html };
  });
}
