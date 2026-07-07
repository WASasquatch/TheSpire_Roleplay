import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import {
  users,
  characters,
  characterPortraits,
  userPortraits,
  characterJournalEntries,
  worlds,
  worldPages,
  worldArcs,
  worldSessions,
  worldEntities,
  stories,
  storyChapters,
  storyEntities,
} from "../db/schema.js";
import { getSessionUser } from "./auth.js";
import type { Db } from "../db/index.js";

/**
 * `users` columns that are secrets or moderation state — never part of a user's
 * OWN-data export. Everything else on the row is their profile / settings /
 * cosmetics, which is theirs to take.
 */
const SENSITIVE_USER_COLUMNS = [
  "passwordHash",
  "bannedAt",
  "bannedUntil",
  "banReason",
  "bannedById",
  "disabledAt",
] as const;

/**
 * Data-portability export — the "Portable backups: take your work with you"
 * help guide. `GET /me/export` streams the caller's OWN content as one
 * downloadable JSON file:
 *
 *   - account   : master profile + settings + cosmetics (minus secrets /
 *                 moderation columns above)
 *   - characters: every character they own (live, not soft-deleted), each with
 *                 its portrait gallery + journal entries
 *   - gallery   : their master / OOC portrait gallery
 *   - worlds    : worlds they authored, each with pages, arcs, sessions, and
 *                 codex entities (locations / NPCs / items / factions)
 *   - stories   : Scriptorium stories they wrote, each with chapters + codex
 *
 * Deliberately EXCLUDES (matching the guide): other people's messages (theirs,
 * not the exporter's) and the live economy — items, currency balance, ranks —
 * which are tied to the running system and not portable content.
 *
 * Auth rides the same bearer-token fetch as every other route; the client
 * fetches this and triggers a blob download (a plain <a href> navigation would
 * not carry the token). No CDN/browser caching of a personal data dump.
 */
export async function registerDataExportRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/me/export", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    const u = (await db.select().from(users).where(eq(users.id, me.id)).limit(1))[0];
    if (!u) { reply.code(404); return { error: "not found" }; }

    // Account: strip secrets + moderation columns; the rest is the user's own.
    const account: Record<string, unknown> = { ...u };
    for (const k of SENSITIVE_USER_COLUMNS) delete account[k];

    // Characters (live only), each with its gallery + journal.
    const ownChars = await db
      .select()
      .from(characters)
      .where(and(eq(characters.userId, me.id), isNull(characters.deletedAt)));
    const charactersOut = await Promise.all(
      ownChars.map(async (c) => {
        const [portraits, journal] = await Promise.all([
          db.select().from(characterPortraits).where(eq(characterPortraits.characterId, c.id)),
          db.select().from(characterJournalEntries).where(eq(characterJournalEntries.characterId, c.id)),
        ]);
        return { ...c, portraits, journal };
      }),
    );

    // Master / OOC portrait gallery.
    const gallery = await db.select().from(userPortraits).where(eq(userPortraits.userId, me.id));

    // Authored worlds, each with pages / arcs / sessions / codex entities.
    const ownWorlds = await db.select().from(worlds).where(eq(worlds.ownerUserId, me.id));
    const worldsOut = await Promise.all(
      ownWorlds.map(async (w) => {
        const [pages, arcs, sessions, entities] = await Promise.all([
          db.select().from(worldPages).where(eq(worldPages.worldId, w.id)),
          db.select().from(worldArcs).where(eq(worldArcs.worldId, w.id)),
          db.select().from(worldSessions).where(eq(worldSessions.worldId, w.id)),
          db.select().from(worldEntities).where(eq(worldEntities.worldId, w.id)),
        ]);
        return { ...w, pages, arcs, sessions, entities };
      }),
    );

    // Authored Scriptorium stories, each with chapters + codex entities.
    const ownStories = await db.select().from(stories).where(eq(stories.authorUserId, me.id));
    const storiesOut = await Promise.all(
      ownStories.map(async (s) => {
        const [chapters, entities] = await Promise.all([
          db.select().from(storyChapters).where(eq(storyChapters.storyId, s.id)),
          db.select().from(storyEntities).where(eq(storyEntities.storyId, s.id)),
        ]);
        return { ...s, chapters, entities };
      }),
    );

    const payload = {
      format: "thespire-export-v1",
      exportedAt: new Date().toISOString(),
      note:
        "Your own content from The Spire. Images are referenced by URL. Other people's " +
        "messages and the live economy (items, currency, ranks) are intentionally not included.",
      account,
      characters: charactersOut,
      gallery,
      worlds: worldsOut,
      stories: storiesOut,
    };

    const safeName = (u.username || "account").replace(/[^a-zA-Z0-9._-]/g, "_");
    const date = new Date().toISOString().slice(0, 10);
    reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="thespire-export-${safeName}-${date}.json"`)
      .header("cache-control", "no-store");
    // Return the already-serialized string so Fastify sends it verbatim with the
    // attachment headers above (Date columns become ISO strings via stringify).
    return JSON.stringify(payload, null, 2);
  });
}
