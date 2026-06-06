/**
 * Presence-broadcast template helpers (migration 0161).
 *
 * Two new flairs let users override the default lifecycle broadcast
 * messages:
 *   - `flair_room_presence`    → join + leave room lines
 *   - `flair_session_presence` → connect + exit session lines
 *
 * Each stored value is a short plain-text template with `{name}` and
 * (room flair only) `{room}` placeholders. The renderer substitutes
 * the live values at fire time, falls back to the default phrasing
 * when the slot is null, and refuses to render anything that looks
 * structurally HTML (angle brackets are stripped at write time).
 *
 * Validation is intentionally cheap, no full template language, no
 * conditionals. The slot is a vibe customization, not a scripting
 * surface. Keep the surface area narrow.
 */

/** Maximum length of any single presence template. Wider than the
 *  typing-phrase cap (60) because lifecycle lines naturally read as
 *  full sentences ("Mira strolls into the bonfire glade, brushing
 *  ashes off her cloak.") while typing phrases are stub-form. */
export const PRESENCE_TEMPLATE_MAX = 100;

/** Default phrasings, what the server emits when the template slot
 *  is null. Centralized so both the server (broadcaster) and the
 *  client (Flair settings preview) speak the same baseline. */
export const DEFAULT_PRESENCE_TEMPLATES = {
  roomJoin: "{name} has entered the room.",
  roomLeave: "{name} has left the room.",
  sessionConnect: "{name} has connected.",
  sessionExit: "{name} has disconnected.",
} as const;

/** Placeholder tokens supported by each slot. The room-presence
 *  slots accept both `{name}` and `{room}`; session-presence only
 *  accepts `{name}`. Renderer leaves unknown placeholder tokens
 *  alone so future expansion is additive. */
export const PRESENCE_PLACEHOLDERS = {
  roomJoin: ["name", "room"] as const,
  roomLeave: ["name", "room"] as const,
  sessionConnect: ["name"] as const,
  sessionExit: ["name"] as const,
} as const;

/**
 * Server-side validator. Returns null when the value is acceptable,
 * or an error string when it isn't. Empty / whitespace-only inputs
 * pass through as null (treated as "clear the slot"); callers turn
 * that into a NULL column write.
 *
 * Rejects:
 *   - oversize input (> PRESENCE_TEMPLATE_MAX)
 *   - control characters (NUL, etc., sanitizers downstream catch
 *     these too, but earlier rejection beats silent corruption)
 *   - angle brackets (no HTML injection surface; these lines render
 *     through the chat message pipeline which strips tags, but the
 *     write-time reject keeps the slot's stored text readable when
 *     an admin inspects it)
 */
export function validatePresenceTemplate(value: string): string | null {
  if (value.length > PRESENCE_TEMPLATE_MAX) {
    return `template too long (max ${PRESENCE_TEMPLATE_MAX} chars)`;
  }
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
    return "template contains control characters";
  }
  if (/[<>]/.test(value)) {
    return "template contains angle brackets, use plain text only";
  }
  return null;
}

/**
 * Normalize an inbound template string. Trims whitespace, collapses
 * runs of internal whitespace into single spaces. Returns null when
 * the input becomes empty (caller writes NULL to the column to clear
 * the slot).
 */
export function normalizePresenceTemplate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Substitute `{name}` and (optionally) `{room}` into a template.
 * Falls back to the supplied default when the template is null /
 * empty. Placeholder substitution is literal text, no escaping
 * needed because the consumer is the chat message body, which is
 * already plain-text and gets rendered with the standard sanitizer.
 *
 * Unknown placeholder tokens (e.g. `{foo}`) are preserved verbatim,
 * matching the user's input. We deliberately don't error on them so
 * future placeholder additions don't require a coordinated client
 * + server update.
 */
export function renderPresenceTemplate(
  template: string | null | undefined,
  fallback: string,
  values: { name: string; room?: string | null },
): string {
  const src = template && template.length > 0 ? template : fallback;
  return src
    .replace(/\{name\}/g, values.name)
    .replace(/\{room\}/g, values.room ?? "");
}
