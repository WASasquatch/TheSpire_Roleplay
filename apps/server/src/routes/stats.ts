import type { FastifyInstance } from "fastify";
import { gte, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { messages, rooms } from "../db/schema.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Sitewide stats for the metadata strip:
 *   - public/private/password room counts
 *   - currently-online users (across all rooms, deduped by userId)
 *   - per-day message counts for the last 7 days (oldest first)
 */
export async function registerStatsRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
): Promise<void> {
  // /stats is anonymous + cheap to compute, but completely unrate-limited it
  // makes a free amplification target. 120/min/IP comfortably covers the
  // splash polling every 30s across multiple tabs.
  const limit = {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  } as const;
  app.get("/stats", limit, async () => {
    // Room totals by type.
    const roomCounts = await db
      .select({ type: rooms.type, n: sql<number>`count(*)` })
      .from(rooms)
      .groupBy(rooms.type);
    const byType: Record<string, number> = { public: 0, private: 0 };
    for (const r of roomCounts) byType[r.type] = r.n;

    // Connected users right now - dedupe by userId across all sockets.
    const sockets = await io.fetchSockets();
    const onlineUsers = new Set<string>();
    for (const s of sockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (uid) onlineUsers.add(uid);
    }

    // 7-day message frequency, bucketed by UTC day. SQLite stores createdAt
    // as ms-epoch integers; convert to YYYY-MM-DD via strftime.
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const freqRows = await db
      .select({
        day: sql<string>`strftime('%Y-%m-%d', ${messages.createdAt} / 1000, 'unixepoch')`.as("day"),
        n: sql<number>`count(*)`,
      })
      .from(messages)
      .where(gte(messages.createdAt, new Date(sevenDaysAgo)))
      .groupBy(sql`day`);

    const dayMap = new Map(freqRows.map((r) => [r.day, r.n]));
    const days: { day: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      days.push({ day: key, count: dayMap.get(key) ?? 0 });
    }

    return {
      online: onlineUsers.size,
      rooms: {
        public: byType.public ?? 0,
        private: byType.private ?? 0,
        total: roomCounts.reduce((s, r) => s + r.n, 0),
      },
      messagesPerDay: days,
    };
  });
}
