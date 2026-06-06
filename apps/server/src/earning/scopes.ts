/**
 * Lookup helpers around "every logged-in identity for user X".
 *
 * The award engine needs these for the "every logged-in character
 * earns full IC award" rule. The source of truth is live socket
 * state (`io.fetchSockets()`), not the DB, a character can be
 * attached to one tab and not another, and the `socket.data.tabCharId`
 * override only exists in memory.
 *
 * The query also de-dupes on the identity tuple (userId, characterId)
 * the same way `currentOccupants` does in broadcast.ts. Two tabs as
 * the same character collapse to one award; two tabs as two
 * characters earn each character independently.
 */

import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * Every distinct character a user is currently posting as across all
 * of their live sockets. Returns an empty array when the user has
 * no live tabs attached to any character. Order is arbitrary.
 *
 * `defaultActiveCharacterId` is the user's master-row `active_character_id`
 * used as the fallback when a socket has not issued a per-tab `/char`
 * override (`socket.data.tabCharId === undefined`). Caller passes it so
 * we don't need a second DB roundtrip in the award hot path.
 *
 * A null in the returned array means "this user has a logged-in tab
 * voicing OOC" (no character), relevant for the OOC routing branch
 * but not for the IC fan-out. The caller filters as needed.
 */
export async function liveCharacterIdsFor(
  io: Io,
  userId: string,
  defaultActiveCharacterId: string | null,
): Promise<Array<string | null>> {
  const sockets = await io.fetchSockets();
  const seen = new Set<string | null>();
  for (const s of sockets) {
    const data = s.data as { userId?: string; tabCharId?: string | null };
    if (data.userId !== userId) continue;
    const tab = data.tabCharId;
    const resolved = tab !== undefined ? tab : defaultActiveCharacterId;
    seen.add(resolved);
  }
  return [...seen];
}

/**
 * Same as `liveCharacterIdsFor` but filters to non-null entries, the
 * award-pipeline's IC fan-out only cares about characters, never OOC
 * tabs.
 */
export async function liveCharacterIdsOnly(
  io: Io,
  userId: string,
  defaultActiveCharacterId: string | null,
): Promise<string[]> {
  const all = await liveCharacterIdsFor(io, userId, defaultActiveCharacterId);
  return all.filter((id): id is string => id !== null);
}
