/**
 * Welcome wagon (migration 0353, retention package).
 *
 * The single strongest survival signal in the funnel data is a newcomer
 * getting a CONVERSATION on day one — and the leavers who did speak mostly
 * spoke into rooms where nobody pulled them in. This module closes that loop:
 * when an account sends its FIRST-EVER public chat message, every ONLINE
 * member viewing that server gets a Notification Center ping ("X just said
 * their first words in <room>. Say hi!") deep-linked to the room.
 *
 * Guarantees:
 *   - Once per account, ever: `users.first_spoke_at` is claimed atomically
 *     (UPDATE ... WHERE first_spoke_at IS NULL), so multi-tab / burst sends
 *     race into exactly one notification fan-out. Pre-migration accounts
 *     were backfilled non-NULL and can never trigger it.
 *   - Public speech only: speech kinds in public, non-forum, non-nested,
 *     non-role-locked rooms. Private and role-gated spaces never announce —
 *     the ping must not leak where a gated conversation is happening.
 *   - Effectively 18+ rooms (room OR server flag) never announce either:
 *     recipients are every online socket on the server, minors included,
 *     and the title carries the room name — the live emit bypasses the
 *     read-time age filter, so the gate has to sit on the fan-out itself.
 *   - Per-recipient safety rides the notification engine: `insertOne`
 *     already drops blocked/blocking pairs, isolated minor↔adult pairings,
 *     the newcomer themselves, and muted categories.
 *   - Best-effort by contract: failure never surfaces to the send path.
 */
import { eq, isNull, and } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, MessageKind, ServerToClientEvents } from "@thekeep/shared";
import { rooms, users } from "../db/schema.js";
import { DEFAULT_SERVER_ID } from "../earning/pool.js";
import { effectiveRoomNsfw } from "../lib/nsfwRooms.js";
import { roleLockedRoomIdsForServer } from "../lib/roleGates.js";
import { notifyMany, type NotifyInput } from "../notifications/engine.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Kinds that count as the author actually speaking in public. Whispers never
 *  route through addMessage; system/cmd/announce/poll are not "speaking". */
const SPEECH_KINDS = new Set<MessageKind>(["say", "me", "ooc", "roll", "npc", "scene"]);

/**
 * Per-process fast path: accounts already known to have spoken. Saves the
 * per-message users read once an account has triggered (or been read as
 * already-spoken) — the overwhelmingly common case on the hot send path.
 */
const knownSpoken = new Set<string>();

/** Bound one fan-out so a huge server can't turn one message into thousands
 *  of inbox writes. Recipients are "sockets currently viewing this server",
 *  which is naturally small on the populations this feature targets. */
const MAX_RECIPIENTS = 200;

export async function maybeFireFirstWords(
  io: Io,
  db: Db,
  sender: { id: string },
  roomId: string,
  kind: MessageKind,
  displayName: string,
): Promise<void> {
  try {
    if (!SPEECH_KINDS.has(kind)) return;
    if (knownSpoken.has(sender.id)) return;
    const row = (await db
      .select({ firstSpokeAt: users.firstSpokeAt })
      .from(users)
      .where(eq(users.id, sender.id))
      .limit(1))[0];
    if (!row) return;
    if (row.firstSpokeAt) {
      knownSpoken.add(sender.id);
      return;
    }

    // Room gates: only a public, flat, non-forum, non-role-locked, non-18+
    // room may announce. A first message in a gated space still CLAIMS
    // first_spoke_at (the account has spoken; a later public message is no
    // longer "first words") but stays silent. The effective 18+ check
    // (room OR server flag) matters because the fan-out below reaches every
    // online socket on the server — minors included — and the title names
    // the room; the notifications read-path age filter only covers later
    // inbox reads, not the live emit.
    const room = (await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1))[0];
    if (!room) return;
    const announceable =
      room.type === "public" &&
      !room.forumId &&
      room.replyMode !== "nested" &&
      // Info rooms (post_mode 'staff') never announce: only staff can speak
      // there, and the "say hi" deep link would drop responders into a
      // room they can't reply in (and that displays nobody).
      room.postMode !== "staff" &&
      // Staff-only rooms (staff_only, migration 0363) never announce: the ping
      // reaches every online member, but only staff can see or enter one.
      !room.staffOnly &&
      !(await effectiveRoomNsfw(db, room)) &&
      !(await roleLockedRoomIdsForServer(db, [room.id])).has(room.id);

    // Atomic once-ever claim.
    const claimed = await db
      .update(users)
      .set({ firstSpokeAt: new Date() })
      .where(and(eq(users.id, sender.id), isNull(users.firstSpokeAt)));
    knownSpoken.add(sender.id);
    if (Number(claimed.changes ?? 0) === 0) return; // lost a race — already fired
    if (!announceable) return;

    // Online members of THIS server (socket.data.serverId is stamped on every
    // room join; NULL/unset means the default server). One fetchSockets walk,
    // deduped per account, newcomer excluded.
    const serverId = room.serverId ?? DEFAULT_SERVER_ID;
    // Stored rows follow the mention idiom: NULL serverId = the default/home
    // server (a fresh install may not even have the system-server row yet, and
    // notifications.server_id is FK'd to servers).
    const storedServerId = room.serverId ?? null;
    const recipients = new Set<string>();
    for (const s of await io.fetchSockets()) {
      const uid = (s.data as { userId?: string }).userId;
      if (!uid || uid === sender.id) continue;
      const sockServer = (s.data as { serverId?: string }).serverId ?? DEFAULT_SERVER_ID;
      if (sockServer !== serverId) continue;
      recipients.add(uid);
      if (recipients.size >= MAX_RECIPIENTS) break;
    }
    if (recipients.size === 0) return;

    // Snapshot copy stays English like every stored notification title. The
    // snippet is left empty on purpose: the room name + actor are the whole
    // story, and an empty snippet sidesteps per-recipient minor-language
    // masking concerns. push:false — this targets people who are ONLINE.
    const inputs: NotifyInput[] = [...recipients].map((userId) => ({
      userId,
      category: "server",
      kind: "first_words",
      serverId: storedServerId,
      actor: { id: sender.id, name: displayName },
      title: `${displayName} just said their first words in ${room.name}. Say hi!`,
      target: { kind: "room", id: room.id },
      dedupeKey: `first-words:${sender.id}`,
      push: false,
    }));
    await notifyMany(db, io, inputs);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[welcome-wagon] first-words notification failed", err);
  }
}
