/**
 * Room-transition cosmetics — animations that play on the user's own client
 * when they switch chat rooms. Purchased + equipped per identity (master/OOC
 * and each character), exactly like name styles; the catalog metadata lives
 * here (shared by the shop + the purchase gate), while the animation
 * implementations live in apps/web/src/lib/transitions. Both keyed by the
 * same string. Every transition costs the same flat price; equipping nothing
 * → instant switch (the true free default — no transition is owned by default).
 */

/** Flat price for every room transition. No rarity tiers — one price. */
export const ROOM_TRANSITION_PRICE = 1500;

export interface RoomTransition {
  key: string;
  label: string;
  /** Price in currency. Currently a flat `ROOM_TRANSITION_PRICE` for all. */
  cost: number;
  description: string;
}

/**
 * The catalog. Order = display order in the shop. Keys match the animation
 * registry in the web client. All flat-priced (no rarity); nothing is free —
 * the default is an instant switch (equip nothing).
 */
export const ROOM_TRANSITIONS: RoomTransition[] = [
  { key: "slide", label: "Dimensional Slide", cost: ROOM_TRANSITION_PRICE,
    description: "A clean lateral shove: the old chamber slides out, the new one arrives from the dark. The honest baseline every room rite is judged against." },
  { key: "page", label: "Page Turn", cost: ROOM_TRANSITION_PRICE,
    description: "The chamber turns on its spine like a leaf of the great book, edge-on for an instant before the next page settles flat. Pairs with parchment-themed rooms." },
  { key: "candle", label: "Candle Snuff", cost: ROOM_TRANSITION_PRICE,
    description: "The chamber's light is drawn down to a single guttering flame, which winks out, and the dark blooms open on the next." },
  { key: "tv", label: "Television", cost: ROOM_TRANSITION_PRICE,
    description: "Scanlines bloom, then the picture is crushed top-and-bottom to a screaming white line, and the next room blinks back the way an old cathode tube wakes." },
  { key: "hologram", label: "Hologram Scan", cost: ROOM_TRANSITION_PRICE,
    description: "The chamber flickers into a holographic projection; a bright scan-line sweeps down and renders the next room into being." },
  { key: "glitch", label: "Tech Glitch", cost: ROOM_TRANSITION_PRICE,
    description: "Luminance and vibrancy stutter, horizontal slices tear sideways, the signal inverts for a frame, and resolves on a new feed. Datamosh for the arcane age." },
  { key: "stone", label: "Stone Vault", cost: ROOM_TRANSITION_PRICE,
    description: "Two slabs of the Spire's stonework grind shut across the chamber, the light pinched off at the seam, then heave apart on the next." },
  { key: "transporter", label: "Transporter Beam", cost: ROOM_TRANSITION_PRICE,
    description: "The chamber dematerialises into rising columns of light and a scatter of motes, then reassembles, particle by particle, in the next." },
  { key: "veil", label: "Shadow Veil", cost: ROOM_TRANSITION_PRICE,
    description: "A starlit curtain of dark falls from above, holds the room in night, then sweeps on past the floor to unveil the next: the Spire's signature cosmic drape." },
  { key: "fog", label: "War Fog", cost: ROOM_TRANSITION_PRICE,
    description: "Brooding banks of gray roll in from both flanks, their inner edges dissolving into a fog that settles over the whole chamber, then they split and peel away to either side." },
  { key: "sigil", label: "Summoning Sigil", cost: ROOM_TRANSITION_PRICE,
    description: "A rune-circle wheels open over the chamber, blazes to a sigil-flare, and the next room is conjured out of the light." },
  { key: "warp", label: "Warp Jump", cost: ROOM_TRANSITION_PRICE,
    description: "The stars stretch to threads as the chamber is flung through the jump, the light deepening to black at the crest, and the next fades up on the far side." },
  { key: "arcane", label: "Arcane Dissolve", cost: ROOM_TRANSITION_PRICE,
    description: "The chamber sublimates into a rising swarm of embers and warps through a sigil-haze, reforming as the sparks burn out. Reads in the room's own accent colour." },
  { key: "ripple", label: "Scrying Ripple", cost: ROOM_TRANSITION_PRICE,
    description: "The surface of the chamber ripples as if it were a scrying pool, a ring spreading from centre; at the peak of the warp the vision resolves on the next room." },
  { key: "eclipse", label: "Eclipse", cost: ROOM_TRANSITION_PRICE,
    description: "A black sun crosses the chamber (its corona flaring, stars surfacing in the shadow), then slides on, and the next room dawns." },
  { key: "wormhole", label: "Wormhole", cost: ROOM_TRANSITION_PRICE,
    description: "The chamber is drawn down a wormhole (soft rings of light receding into a dark throat) and out the far side into the next." },
  { key: "ink", label: "Ink Bleed", cost: ROOM_TRANSITION_PRICE,
    description: "A drop of pitch-black ink blooms outward with a ragged, bleeding edge (satellite blots blooming ahead of it) until it drowns the chamber, then recedes to leave the next room dry on the page." },
  { key: "burn", label: "Ember Burn", cost: ROOM_TRANSITION_PRICE,
    description: "Scorched parchment creeps across the chamber on a living, ragged line of fire (embers crawling and guttering along the edge), then peels away to ash, the next room surfacing through the cinders. The crown rite." },
];

const BY_KEY: Record<string, RoomTransition> = Object.fromEntries(
  ROOM_TRANSITIONS.map((t) => [t.key, t]),
);

export function getRoomTransition(key: string | null | undefined): RoomTransition | null {
  if (!key) return null;
  return BY_KEY[key] ?? null;
}

/** A key is valid + currently sellable (exists in the catalog). */
export function isRoomTransitionKey(key: string): boolean {
  return key in BY_KEY;
}
