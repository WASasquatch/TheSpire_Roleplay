import { eq } from "drizzle-orm";
import type { Server as IoServer, Socket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { users } from "../../db/schema.js";
import type { Db } from "../../db/index.js";
import type { SessionUser } from "../../commands/types.js";
import { tFor } from "../../i18n.js";
import { socketsForUser } from "../presence.js";
import { broadcastPresence } from "./presence.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * Canonical per-IDENTITY incognito visibility check.
 *
 * An identity is hidden iff the account is in incognito mode AND the identity
 * in question is the exact one the account went incognito AS
 * (`incognitoCharacterId`; null = OOC/master). A DIFFERENT character the same
 * account voices on another tab stays visible. This is the single predicate the
 * userlist filter (`currentOccupants`), the watcher ping (`pingWatchers`), the
 * enter/leave presence gates, and the message-author rewrite all encode inline;
 * exported here so the typing-indicator path (`realtime/typing.ts`) can gate its
 * broadcast with the byte-identical rule instead of re-deriving it (a hidden
 * mod's name must not leak through "…is typing" while every other surface hides
 * them).
 *
 * Accepts the loose incognito shape shared by `SessionUser` and a raw `users`
 * row so either caller can pass what it already holds.
 */
export function isHiddenIncognitoIdentity(
  who: { incognitoMode: boolean; incognitoCharacterId: string | null },
  characterId: string | null,
): boolean {
  return who.incognitoMode && (characterId ?? null) === (who.incognitoCharacterId ?? null);
}

/**
 * Fail-closed guard against a hidden moderator SILENTLY reappearing when the
 * tab they went incognito on switches character.
 *
 * Going incognito stamps `incognitoCharacterId` with the switching tab's
 * current identity, and only THAT identity is filtered out of userlists /
 * presence / typing. If the same socket then `/char`-switches (or uses the
 * profile "switch to this character" button), its identity no longer matches
 * `incognitoCharacterId`, so every hide gate stops firing and the mod pops back
 * into the room — presence, attribution, the lot — while they likely still
 * believe they're invisible. There is no legitimate "half-incognito" state, so
 * rather than try to keep hiding the new identity we EXIT incognito entirely
 * (identical end state to `/incognito off`) and tell the mod plainly.
 *
 * `priorCharacterId` is the identity the socket was voicing BEFORE the switch —
 * the caller captures `socket.data.tabCharId` (resolved to the account default
 * when unset) just before applying the switch. We act only when that prior
 * identity was the incognito one; a switch on a tab that was NEVER the hidden
 * identity (e.g. a sibling tab voicing a different character) is a no-op, so a
 * mod hidden as Character A on tab 1 keeps their cover when tab 2 changes
 * characters.
 *
 * Side effects on an actual exit (mirrors `incognito.ts` leaveIncognito):
 *   - clears `incognito_mode` / `incognito_character_id` on the `users` row;
 *   - syncs the in-memory `SessionUser` + the per-socket cached user so the rest
 *     of this tick and the next dispatched event see the cleared state;
 *   - fans `me:incognito-update` to EVERY live socket the account owns (menu
 *     label + banner flip immediately, same as the command does);
 *   - emits a private `error:notice` to the switching socket explaining why;
 *   - refreshes presence in every room the account has a socket in, so the mod
 *     reappears consistently everywhere (not just the room they switched in).
 *
 * Best-effort and defensive: any failure is swallowed so a presence hiccup can
 * never wedge a character switch. Returns true iff it actually exited incognito.
 */
export async function exitIncognitoOnCharSwitch(
  io: Io,
  db: Db,
  socket: Sock,
  user: SessionUser,
  priorCharacterId: string | null,
): Promise<boolean> {
  // Only the tab that IS the hidden identity may trigger the exit. A switch on
  // any other tab (already-visible sibling) must leave the cover intact.
  if (!isHiddenIncognitoIdentity(user, priorCharacterId)) return false;
  try {
    await db
      .update(users)
      .set({ incognitoMode: false, incognitoCharacterId: null })
      .where(eq(users.id, user.id));
    // Keep the live session user (and the per-socket cached user, if the socket
    // carries one) in sync so later code in this tick / next event sees the
    // cleared flags without a round-trip through loadSessionUser.
    user.incognitoMode = false;
    user.incognitoCharacterId = null;
    const cached = (socket.data as { user?: SessionUser }).user;
    if (cached && cached.id === user.id) {
      cached.incognitoMode = false;
      cached.incognitoCharacterId = null;
    }
    // Flip the menu label / banner on every tab the moment the exit lands.
    // One socket pass: emit the update AND collect the rooms to refresh.
    const mine = await socketsForUser(io, user.id);
    const userRooms = new Set<string>();
    for (const s of mine) {
      s.emit("me:incognito-update", {
        incognitoMode: false,
        incognitoAlias: user.incognitoAlias,
        incognitoCharacterId: null,
      });
      for (const r of s.rooms) {
        if (r.startsWith("room:")) userRooms.add(r.slice(5));
      }
    }
    // Tell the mod plainly why they're visible again.
    socket.emit("error:notice", {
      code: "INCOGNITO_OFF",
      message: tFor(user.locale, "errors:server.realtime.incognitoOff"),
    });
    // Reappear consistently in every room the account is in (mirrors the
    // command's all-rooms refresh, not just the room the switch happened in).
    for (const rid of userRooms) {
      await broadcastPresence(io, db, rid);
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[incognito] exit-on-char-switch failed", { userId: user.id, err });
    return false;
  }
}
