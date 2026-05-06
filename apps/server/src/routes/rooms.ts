import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type {
  ClientToServerEvents,
  RoomOccupant,
  RoomSummary,
  ServerToClientEvents,
} from "@thekeep/shared";
import { characters, roomMembers, rooms, users } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

interface RoomWithOccupants extends RoomSummary {
  occupants: RoomOccupant[];
}

/**
 * Returns the navigable room tree for the right-rail sidebar:
 *   - every public room (always visible, even empty), each with its
 *     currently-connected occupants
 *   - the caller's current room if it happens to be private (so they can see
 *     the people they're whispering with)
 *
 * Private rooms NEVER appear in this list for callers who aren't in them.
 */
export async function registerRoomsRoutes(
  app: FastifyInstance,
  db: Db,
  io: Io,
): Promise<void> {
  app.get("/rooms", async (req: FastifyRequest) => {
    const me = await getSessionUser(req, db);

    // 1. Pull every public room.
    const publicRows = await db
      .select()
      .from(rooms)
      .where(eq(rooms.type, "public"))
      .orderBy(asc(rooms.name));

    // 2. If the caller is logged in, find any private room they're currently
    //    socketed into and include it too. We use the socket-room membership
    //    (not just the DB roomMembers row) so users only see their *active*
    //    private room, not every one they've ever joined.
    let extraPrivate: typeof publicRows = [];
    if (me) {
      const sockets = await io.fetchSockets();
      const privateRoomIds = new Set<string>();
      for (const s of sockets) {
        if ((s.data as { userId?: string }).userId !== me.id) continue;
        for (const r of s.rooms) {
          if (r.startsWith("room:")) privateRoomIds.add(r.slice(5));
        }
      }
      // Subtract public rooms we already have.
      for (const r of publicRows) privateRoomIds.delete(r.id);
      if (privateRoomIds.size) {
        extraPrivate = await db
          .select()
          .from(rooms)
          .where(
            and(eq(rooms.type, "private"), inArray(rooms.id, [...privateRoomIds])),
          );
      }
    }

    const allRooms = [...publicRows, ...extraPrivate];
    if (allRooms.length === 0) return { rooms: [] };

    const allRoomIds = allRooms.map((r) => r.id);

    // 3. Pull socket occupants per room. We do one fetchSockets() and bucket
    //    by room.
    const allSockets = await io.fetchSockets();
    const userIdsByRoom = new Map<string, Set<string>>();
    const allOnlineUserIds = new Set<string>();
    for (const s of allSockets) {
      const uid = (s.data as { userId?: string }).userId;
      if (!uid) continue;
      for (const r of s.rooms) {
        if (!r.startsWith("room:")) continue;
        const rid = r.slice(5);
        if (!allRoomIds.includes(rid)) continue;
        let set = userIdsByRoom.get(rid);
        if (!set) {
          set = new Set();
          userIdsByRoom.set(rid, set);
        }
        set.add(uid);
        allOnlineUserIds.add(uid);
      }
    }

    // 4. Fetch user + active-character data for everyone online.
    let userRowsById = new Map<string, typeof users.$inferSelect>();
    let charById = new Map<string, typeof characters.$inferSelect>();
    if (allOnlineUserIds.size) {
      const userRows = await db
        .select()
        .from(users)
        .where(inArray(users.id, [...allOnlineUserIds]));
      userRowsById = new Map(userRows.map((u) => [u.id, u]));

      const charIds = userRows.map((u) => u.activeCharacterId).filter((v): v is string => !!v);
      if (charIds.length) {
        const charRows = await db
          .select()
          .from(characters)
          .where(and(inArray(characters.id, charIds), isNull(characters.deletedAt)));
        charById = new Map(charRows.map((c) => [c.id, c]));
      }
    }

    // 5. Member roles per room (for the ♛/★ glyphs on occupants).
    const memberRows = await db
      .select()
      .from(roomMembers)
      .where(inArray(roomMembers.roomId, allRoomIds));
    const roleByRoomUser = new Map<string, "owner" | "mod" | "member">();
    for (const m of memberRows) {
      roleByRoomUser.set(`${m.roomId}::${m.userId}`, m.role);
    }

    // 6. DB member counts (totals — different from currently-online).
    const counts = await db
      .select({ roomId: roomMembers.roomId, n: sql<number>`count(*)` })
      .from(roomMembers)
      .where(inArray(roomMembers.roomId, allRoomIds))
      .groupBy(roomMembers.roomId);
    const countByRoom = new Map(counts.map((r) => [r.roomId, r.n]));

    // 7. Assemble.
    const result: RoomWithOccupants[] = allRooms.map((r) => {
      const onlineIds = userIdsByRoom.get(r.id) ?? new Set<string>();
      const occupants: RoomOccupant[] = [...onlineIds]
        .map((uid) => userRowsById.get(uid))
        .filter((u): u is NonNullable<typeof u> => !!u)
        .map((u) => {
          const c = u.activeCharacterId ? charById.get(u.activeCharacterId) : undefined;
          return {
            userId: u.id,
            displayName: c ? c.name : u.username,
            characterId: c?.id ?? null,
            away: u.awayMessage != null,
            awayMessage: u.awayMessage,
            chatColor: u.chatColor,
            gender: resolveGender(u.gender, c?.statsJson),
            role: roleByRoomUser.get(`${r.id}::${u.id}`) ?? "member",
          };
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

      return {
        id: r.id,
        name: r.name,
        type: r.type,
        topic: r.topic,
        ownerId: r.ownerId,
        memberCount: countByRoom.get(r.id) ?? 0,
        occupants,
      };
    });

    return { rooms: result };
  });
}

function resolveGender(
  userGender: "male" | "female" | "nonbinary" | "other" | "undisclosed",
  characterStatsJson?: string | null,
): "male" | "female" | "nonbinary" | "other" | "undisclosed" {
  if (!characterStatsJson) return userGender;
  try {
    const parsed = JSON.parse(characterStatsJson) as { gender?: string };
    const g = parsed.gender?.toLowerCase();
    if (g === "male" || g === "female" || g === "nonbinary" || g === "other") return g;
  } catch { /* fall through */ }
  return userGender;
}
