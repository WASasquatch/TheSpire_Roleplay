import { isAdminRole, type AvatarCrop, type RoomOccupant } from "@thekeep/shared";
import type { Gender } from "../../lib/gender.js";
import { identityKey } from "../../lib/identity.js";

export function buildOccupantMaps(occupants: RoomOccupant[]) {
  const genderByUser = new Map<string, Gender>();
  // Account-level role lookup so the renderer can italicize site admins'
  // names. Only populated for users currently in the room - history from
  // someone who's left renders without italics, which is fine (italics is
  // decorative, not load-bearing identification).
  const adminUserIds = new Set<string>();
  // Earning, equipped name style + cosmetic state keyed by the FULL
  // identity tuple (userId, characterId). Each row in `occupants`
  // represents ONE identity, a user has one occupant row for OOC/
  // master and one per character they're currently voicing. Keying
  // these maps by userId alone collapsed the rows down to "last
  // wins", which is why a master's equipped Embers bled onto every
  // character of the same user (and vice versa). Building a
  // compound key keeps each identity's cosmetics separate, and the
  // message-level lookup below uses the same `(userId,
  // characterId)` tuple the message was authored under.
  //
  // Falls back to plain rendering for backlog from identities that
  // have left the room (matches the gender / admin-italics
  // fallbacks above, styling is decorative, not load-bearing).
  // (`identityKey` lives in ../lib/identity — `${userId}::${characterId}`.)
  const styleByIdentity = new Map<string, { key: string; config: Record<string, unknown> | null }>();
  const cosmeticsByIdentity = new Map<string, {
    avatarUrl: string | null;
    avatarCrop: AvatarCrop | null;
    selectedBorderRankKey: string | null;
    selectedFreeformBorderKey: string | null;
    freeformBorderConfig: Record<string, string> | null;
    inlineAvatarEnabled: boolean;
  }>();
  const genderByIdentity = new Map<string, Gender>();
  for (const o of occupants) {
    const k = identityKey(o.userId, o.characterId);
    genderByIdentity.set(k, o.gender);
    // Admin status IS account-wide (the user holds the role
    // regardless of which character they're voicing), so this stays
    // keyed by userId. Call sites that consume this set also need to
    // gate on the per-message `characterId === null` check to avoid
    // italicizing a staff user's CHARACTER voices, that would leak
    // the OOC ↔ character link the per-identity partition is meant
    // to keep private. See `isSenderAdmin` usage below.
    if (isAdminRole(o.accountRole)) adminUserIds.add(o.userId);
    if (o.activeNameStyleKey) {
      styleByIdentity.set(k, { key: o.activeNameStyleKey, config: o.nameStyleConfig });
    }
    cosmeticsByIdentity.set(k, {
      avatarUrl: o.avatarUrl,
      avatarCrop: o.avatarCrop,
      selectedBorderRankKey: o.selectedBorderRankKey,
      selectedFreeformBorderKey: o.selectedFreeformBorderKey,
      freeformBorderConfig: o.freeformBorderConfig,
      inlineAvatarEnabled: o.inlineAvatarEnabled,
    });
    // ALSO write the master/OOC identity (`identityKey(userId, null)`)
    // for this user, even when the occupant row represents a
    // character, the wire carries the user's master slot fields too.
    // This is what lets past OOC messages from a user currently
    // voicing a character render with the master's equipped style
    // and cosmetics instead of falling through to plain. If the
    // occupant IS the OOC row (characterId === null), this is a
    // no-op overwrite of the row we just wrote.
    const masterKey = identityKey(o.userId, null);
    if (!styleByIdentity.has(masterKey) && o.masterNameStyleKey) {
      styleByIdentity.set(masterKey, { key: o.masterNameStyleKey, config: o.masterNameStyleConfig });
    }
    if (!cosmeticsByIdentity.has(masterKey)) {
      cosmeticsByIdentity.set(masterKey, {
        avatarUrl: o.masterAvatarUrl,
        avatarCrop: o.masterAvatarCrop,
        selectedBorderRankKey: o.masterSelectedBorderRankKey,
        selectedFreeformBorderKey: o.masterSelectedFreeformBorderKey,
        freeformBorderConfig: o.masterFreeformBorderConfig,
        inlineAvatarEnabled: o.masterInlineAvatarEnabled,
      });
    }
    // Keep a fallback by userId only for the gender map so the
    // existing default-keyed lookups elsewhere still resolve to
    // something sane for chat lines that authored before the
    // occupant joined, first-write-wins via the if-guard, so a
    // character row doesn't clobber the OOC fallback.
    if (!genderByUser.has(o.userId)) genderByUser.set(o.userId, o.gender);
  }
  return { genderByUser, adminUserIds, styleByIdentity, cosmeticsByIdentity, genderByIdentity };
}
