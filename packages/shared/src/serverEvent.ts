/**
 * Server events (community calendar) wire shapes — server `server_events` +
 * `server_event_rsvps` tables (migration 0317). An event is scoped to a server
 * and created by a member optionally voicing a character; times are ms epoch.
 * The `manage_events` server permission gates create/edit/cancel; RSVPing is a
 * plain member action. The feature team owns the concrete status vocabularies
 * (kept as string unions here so the wire is self-documenting).
 */

/** Lifecycle of a scheduled event. */
export type ServerEventStatus = "scheduled" | "live" | "ended" | "cancelled";

/** A member's answer to an event. */
export type ServerEventRsvpStatus = "going" | "maybe" | "declined";

/** One scheduled event as sent to the client. */
export interface ServerEvent {
  id: string;
  serverId: string;
  /** Who created it (null after that account is deleted). */
  createdByUserId: string | null;
  /** Host identity, when the creator voiced a character; null = OOC/none. */
  hostCharacterId: string | null;
  title: string;
  /** Curated Lucide icon slug shown before the title; null = no icon. */
  icon: string | null;
  /** Sanitized HTML description, or null. */
  descriptionHtml: string | null;
  /** Start time, ms epoch. */
  startsAt: number;
  /** End time, ms epoch; null = open-ended. */
  endsAt: number | null;
  /** Optional deep link to a room where the event happens. */
  linkedRoomId: string | null;
  /** Optional deep link to a forum board tied to the event. */
  linkedForumId: string | null;
  /** Optional `<roomId>:<messageId>` chat-message link (see messageLink.ts).
   *  No FK behind it — the message may prune; dead links fail at click. */
  linkedMessageId: string | null;
  /** Optional http(s) external destination. At most ONE of the four link
   *  fields is ever set (enforced at write). */
  externalUrl: string | null;
  status: ServerEventStatus;
  /** Opt-in reminder lead time in ms before startsAt; null = no reminder. */
  reminderLeadMs: number | null;
  /** When the reminder fired (fires at most once); null = not yet. */
  reminderFiredAt: number | null;
  /** Preset repeat rule JSON (shared EventRecurrence); null = one-off. */
  recurrenceJson: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One RSVP row (per event, user, and optional identity). */
export interface ServerEventRsvp {
  id: string;
  eventId: string;
  userId: string;
  /** Identity the member RSVP'd as; null = OOC. */
  characterId: string | null;
  status: ServerEventRsvpStatus;
  updatedAt: number;
}
