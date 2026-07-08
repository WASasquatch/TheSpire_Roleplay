/**
 * Client-side identity helpers.
 *
 * An "identity" on the wire is the tuple `(userId, characterId)` where
 * `characterId === null` means the OOC / master slot. Several components
 * independently (a) built a compound string key to partition per-identity
 * cosmetics / conversation maps and (b) compared two identities for
 * equality. This module is the single home for both so producers and
 * comparators can never drift apart.
 *
 * `characterId` on every wire type (RoomOccupant, DM conversation, friend
 * row, selected target, compose fallback) is `string | null` — never
 * `undefined` — so folding `?? null` in the comparator is a no-op and the
 * result is identical to a bare `===`, matching the previous inline
 * copies (both the `?? null`-normalized and the raw-`===` ones).
 */

/**
 * Compound key for an identity, used only as an in-memory Map/Set/React
 * list key (never persisted, never sent to the server). The `::`
 * delimiter avoids colliding a userId ending in `:` with an empty
 * characterId; the empty string stands in for the OOC/master side so it
 * is distinguishable from a real characterId.
 */
export function identityKey(userId: string, characterId: string | null | undefined): string {
  return `${userId}::${characterId ?? ""}`;
}

/**
 * True when two identities refer to the same `(userId, characterId)`
 * person-slot. `userId` is compared strictly; `characterId` is folded
 * through `?? null` so a `null` OOC id matches regardless of how either
 * caller spells "no character". Behavior-identical to the inline
 * `a.userId === b.userId && a.characterId === b.characterId` copies
 * because every characterId source is `string | null`.
 */
export function identityEquals(
  aUserId: string | null | undefined,
  aCharacterId: string | null | undefined,
  bUserId: string | null | undefined,
  bCharacterId: string | null | undefined,
): boolean {
  return aUserId === bUserId && (aCharacterId ?? null) === (bCharacterId ?? null);
}
