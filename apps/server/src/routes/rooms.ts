import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type {
  ClientToServerEvents,
  RoomOccupant,
  RoomSummary,
  ServerToClientEvents,
} from "@thekeep/shared";
import { rooms } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { buildRoomSummary, currentOccupants } from "../realtime/broadcast.js";

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

    // Delegate summary + occupant assembly to the shared builders so this
    // route returns the same shape as the websocket `room:state`/
    // `presence:update` events. Without unification, fields like
    // `linkedWorld`/`primaryWorld`/`accountRole`/`mood` were silently
    // missing from /rooms and the rail UI lost half its features.
    const result: RoomWithOccupants[] = await Promise.all(
      allRooms.map(async (r): Promise<RoomWithOccupants> => {
        const summary = await buildRoomSummary(db, r);
        const occupants = (await currentOccupants(io, db, r.id))
          .slice()
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
        return { ...summary, occupants };
      }),
    );

    return { rooms: result };
  });
}
