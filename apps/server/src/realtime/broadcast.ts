/**
 * Realtime broadcast hub.
 *
 * The implementation was split (MOVE-ONLY, no logic change) into three
 * cohesive sub-modules under `./broadcast/`:
 *   - persistence: chat-message persist + filtered emit (addMessage,
 *     addMessageDirect, addSystemMessage, pushTriggers, sendRoomBacklogTo).
 *   - presence:    room join/leave, idle ghosts, occupant list, room-state /
 *     presence broadcasts, theater sync, landing resolution, tree pulse.
 *   - incognito:   the per-identity incognito visibility predicate + the
 *     char-switch exit guard.
 *
 * This file stays the emit hub: it re-exports every public symbol so all
 * existing importers keep resolving `realtime/broadcast.js` unchanged.
 */
export * from "./broadcast/persistence.js";
export * from "./broadcast/presence.js";
export * from "./broadcast/incognito.js";
