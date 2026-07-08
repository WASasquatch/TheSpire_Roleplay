/**
 * Forums route surface (Forums revamp).
 *
 * The implementation was split into cohesive sub-registrars — catalog +
 * discovery + curation, forum-creation / membership applications, board
 * reading + owner console, moderation (roles / members / reports / prefixes /
 * usergroups / mods / bans), and the notification center + topic
 * watches/reads. This thin entry point preserves the original public
 * signature so existing importers (index.ts) keep working unchanged, and it
 * re-exports `resolveTopicAuthorFlair` on the same path `rooms.ts` imports it
 * from. Shared scaffolding (the `Io` type, the flair resolver, the image
 * write/unlink helpers, and the owner / permission / target gate helpers)
 * lives in `./forums/shared.js`.
 *
 * Both browse endpoints are ANONYMOUS-TOLERANT by design: they expose only
 * public fields, and the public `/f/<slug>` page reuses them for logged-out
 * visitors (viewer: null). Forum mutation routes require sessions.
 */
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import type { Db } from "../db/index.js";
import type { Io } from "./forums/shared.js";
import { registerForumCatalogRoutes } from "./forums/catalog.js";
import { registerForumApplicationRoutes } from "./forums/applications.js";
import { registerForumBoardRoutes } from "./forums/boards.js";
import { registerForumModerationRoutes } from "./forums/moderation.js";
import { registerForumTopicRoutes } from "./forums/topics.js";
import { getSessionUser } from "./auth.js";
import { emailContentBlocked } from "../auth/emailGate.js";

// Re-exported on its original path so `rooms.ts` (and any other importer)
// keeps resolving `resolveTopicAuthorFlair` from `./forums.js`.
export { resolveTopicAuthorFlair } from "./forums/shared.js";

export async function registerForumRoutes(app: FastifyInstance, db: Db, io: Io, uploadsRoot: string): Promise<void> {
  const forumsDir = join(uploadsRoot, "forums");

  // Email-verification block gate (defense-in-depth behind the client UI).
  // When block mode is on, an unverified non-staff account can't reach the
  // authed forum API — reads OR mutations. Scoped to the `/forums*` and
  // `/me/forums*` request paths so it never touches the PUBLIC server-rendered
  // `/f/:slug` splash (anonymous SEO, a different route) or any DM/messenger
  // path. Anonymous requests (no session) skip the check and stay tolerant.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/forums") && !path.startsWith("/me/forums")) return;
    const me = await getSessionUser(req, db).catch(() => null);
    if (!me) return;
    if (await emailContentBlocked(me, db)) {
      return reply
        .code(403)
        .send({ error: "EMAIL_UNVERIFIED", message: "Verify your email to access the forums." });
    }
  });

  await registerForumCatalogRoutes(app, db, io);
  await registerForumApplicationRoutes(app, db, io);
  await registerForumBoardRoutes(app, db, io, forumsDir);
  await registerForumModerationRoutes(app, db, io);
  await registerForumTopicRoutes(app, db);
}
