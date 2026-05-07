import { eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { messages, rooms, sessions, users } from "./db/schema.js";
import { hashPassword } from "./auth/passwords.js";
import { ensureSiteSettings, getSettings } from "./settings.js";
import type { Db } from "./db/index.js";

/**
 * Default system rooms shipped on every fresh install. Each one is a
 * permanent, public, isSystem=true room that survives auto-expiry and admin
 * sweeps. The Spire itself is the canonical landing room - sockets auto-join
 * it on connect - and the others are thematic gathering places that give
 * roleplayers somewhere to go beyond the entry point.
 *
 * Re-running the seed is idempotent: if a room with the same name already
 * exists we leave it alone so admin edits to topic / description / type are
 * preserved across restarts.
 */
const DEFAULT_ROOMS: Array<{
  name: string;
  topic: string;
  description: string;
}> = [
  {
    name: "The_Spire",
    topic: "The beacon-tower where the universe arrives. New here? Step out and explore.",
    description:
      "The Spire is an ancient beacon-tower where entities from across the universe are summoned into being. Those who appear at its base often arrive disoriented, displaced from distant worlds, timelines, or realms, with some retaining only fragments of memory while others remember nothing of who they were or where they came from. It stands as both a gateway and a mystery, a place of arrival, loss, and uncertain purpose.",
  },
  {
    name: "Tavern",
    topic: "A warm corner beneath the Spire. Drinks, stories, and strangers-turned-friends.",
    description:
      "The Tavern stands at the crossroads beneath the Spire, its windows warm with lantern-light and the air thick with woodsmoke, spiced wine, and the cadence of stories told and retold. Travelers from every realm gather here to trade rumors over scarred wooden tables, to drink away memories they cannot quite recall, or to forge new bonds with strangers who, like them, arrived with no clear road ahead.",
  },
  {
    name: "Library",
    topic: "A quiet sanctum of vaulted stone - lore, fragments, forgotten histories.",
    description:
      "The Library is a quiet sanctum of vaulted stone, its endless shelves lined with tomes, scrolls, and stranger relics gathered from countless arrivals. Some volumes catalogue the histories of vanished worlds; others record fragments brought by those who came before. Lamplight flickers on dust-laden pages, and the silence carries a weight - as if the books themselves are listening.",
  },
  {
    name: "Garden",
    topic: "A still place beneath the Spire's eastern flank. For walking, remembering, forgetting.",
    description:
      "The Garden lies at the Spire's eastern flank, a hidden grove of moss-soft paths and slow-flowing water. Trees from a hundred worlds grow side by side here, their leaves whispering memories that aren't quite anyone's. Many come to walk in stillness, to remember, or simply to forget the weight of their arrival for a while.",
  },
  {
    name: "Bazaar",
    topic: "Trade in goods, names, and half-remembered things.",
    description:
      "The Bazaar sprawls along the Spire's outer terraces in a riot of colored awnings, ringing bells, and competing tongues. Merchants barter in coin and curiosity alike - pieces of broken realms, half-remembered songs, an hour of someone else's name. If something exists, the Bazaar has it for sale; if it doesn't, someone here is willing to invent it.",
  },
];

/** System rows we always need to exist (system user, default rooms, settings). */
export async function ensureSystemSeeds(db: Db): Promise<void> {
  // System sentinel user - owns server-authored messages, never logs in.
  const sys = (await db.select().from(users).where(eq(users.username, "system")).limit(1))[0];
  if (!sys) {
    await db.insert(users).values({
      id: "system",
      email: "system@thekeep.local",
      username: "system",
      passwordHash: await hashPassword(nanoid(64)),
      role: "admin",
      bioHtml: "",
      disabledAt: new Date(0), // effectively unlogin-able
    });
  }

  // One-time migration: existing installs were seeded with a room called
  // "MainHall" before The Spire became the canonical landing. If it still
  // exists as a system room, rename it in place so message history,
  // memberships, bans, etc. (all keyed on roomId, not name) survive.
  // Topic + description are overwritten because the new lore replaces the
  // old generic welcome - admins who customized those will need to re-edit.
  const legacy = (await db.select().from(rooms).where(eq(rooms.name, "MainHall")).limit(1))[0];
  const alreadyHasSpire = (await db.select().from(rooms).where(eq(rooms.name, "The_Spire")).limit(1))[0];
  if (legacy && legacy.isSystem && !alreadyHasSpire) {
    const spireDefaults = DEFAULT_ROOMS.find((r) => r.name === "The_Spire")!;
    await db.update(rooms).set({
      name: spireDefaults.name,
      topic: spireDefaults.topic,
      description: spireDefaults.description,
    }).where(eq(rooms.id, legacy.id));
  }

  // Create any missing default rooms. The unique index on lower(name) makes
  // the existence check authoritative; admin customizations to topic /
  // description / type on already-present rooms are preserved.
  for (const def of DEFAULT_ROOMS) {
    const existing = (await db.select().from(rooms).where(eq(rooms.name, def.name)).limit(1))[0];
    if (existing) continue;
    await db.insert(rooms).values({
      id: nanoid(),
      name: def.name,
      type: "public",
      isSystem: true,
      ownerId: null,
      topic: def.topic,
      description: def.description,
    });
  }

  await ensureSiteSettings(db);
}

/**
 * Periodic janitor - split into two cadences so idle session expiry is
 * detected promptly without burning DB writes on the slower retention sweep:
 *
 *   - Session sweep runs every 60 seconds. Deletes any session whose
 *     `expiresAt` is in the past and force-disconnects connected sockets
 *     whose underlying row was just swept. With sliding-idle expiry, a
 *     truly idle user gets kicked within a minute of their idle window
 *     elapsing, instead of having to wait for the next chat:input.
 *
 *   - Retention sweep runs hourly. Deletes messages older than the
 *     admin-configured retention window. No-op when retention is 0 (forever).
 *
 * `io` is optional so test harnesses can pass `null`; in production, the
 * live IoServer is passed in so the session sweep can boot expired sockets.
 */
export function startJanitor(
  db: Db,
  log: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
  io: IoServer<ClientToServerEvents, ServerToClientEvents> | null = null,
): () => void {
  async function sweepSessions() {
    try {
      const expired = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
      if (expired.changes > 0) log.info(`[janitor] cleared ${expired.changes} expired sessions`);

      if (io && expired.changes > 0) {
        const liveSids = new Set(
          (await db.select({ id: sessions.id }).from(sessions)).map((r) => r.id),
        );
        const liveSockets = await io.fetchSockets();
        let kicked = 0;
        for (const s of liveSockets) {
          const sid = (s.data as { sid?: string }).sid;
          if (sid && !liveSids.has(sid)) {
            s.emit("auth:expired");
            s.disconnect(true);
            kicked += 1;
          }
        }
        if (kicked > 0) log.info(`[janitor] booted ${kicked} sockets whose sessions expired`);
      }
    } catch (err) {
      log.error({ err }, "[janitor] session sweep failed");
    }
  }

  async function sweepMessages() {
    try {
      const { messageRetentionMs } = await getSettings(db);
      if (messageRetentionMs > 0) {
        const cutoff = new Date(Date.now() - messageRetentionMs);
        const r = await db.delete(messages).where(lt(messages.createdAt, cutoff));
        if (r.changes > 0) log.info(`[janitor] purged ${r.changes} messages older than retention window`);
      }
    } catch (err) {
      log.error({ err }, "[janitor] message sweep failed");
    }
  }

  // Run both immediately on startup so the first sweep doesn't have to wait.
  void sweepSessions();
  void sweepMessages();
  const sessionId = setInterval(() => void sweepSessions(), 60 * 1000);
  const messageId = setInterval(() => void sweepMessages(), 60 * 60 * 1000);
  return () => {
    clearInterval(sessionId);
    clearInterval(messageId);
  };
}
