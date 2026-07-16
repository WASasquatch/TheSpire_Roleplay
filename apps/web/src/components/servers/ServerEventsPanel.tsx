/**
 * ServerEventsPanel — the member-facing community calendar (Multi-Server Lift).
 *
 * A header entry (a Calendar button) that surfaces this server's upcoming
 * events. Opening it lists upcoming OCCURRENCES (a repeating event appears
 * once per occurrence inside the fetch window; RSVPs are per SERIES) with
 * going/maybe/decline RSVP buttons and live attendee counts; the caller RSVPs
 * as their currently-voiced identity (OOC when none is active), matching the
 * per-identity contract. Cards carry a Server/Forum context chip and one
 * navigation action per link kind (room join / message jump / forum open /
 * confirmed external tab). The management surface (create/edit/cancel) lives
 * in the Server Settings → Events tab; this panel is read-and-RSVP only.
 *
 * Self-contained: it reads `currentServerId` + `branding.serversEnabled` from
 * the store and mounts nothing when the feature is off or there's no server, so
 * it's inert flag-off. It listens for a `tk:open-server-event` CustomEvent
 * (dispatched by App's openNotifTarget when an event reminder is clicked / a
 * push is tapped, with an `eventId` to scroll to; and by this panel's own
 * trigger button with an empty `eventId` to just open) to open itself.
 *
 * The Banner injects its bell slot into BOTH the desktop and mobile icon
 * clusters, so this panel mounts twice. A module-level owner election keeps
 * exactly ONE instance owning the open-listener + modal (else a deep-link would
 * stack two modals); every mount still renders its own trigger button + badge.
 *
 * House style mirrors the sibling server-admin surfaces (keep-* tokens, inline
 * fetch helpers against the documented /servers/:id/events endpoints).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, MapPin, MessageSquareQuote, MessagesSquare, Repeat } from "lucide-react";
import type {
  ServerEvent,
  ServerEventRsvp,
  ServerEventRsvpStatus,
} from "@thekeep/shared";
import { parseEventRecurrence, parseMessageLink } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { formatDate, formatDateTime } from "../../lib/intlFormat.js";
import { EventIcon } from "../../lib/eventIcons.js";
import { getSocket } from "../../lib/socket.js";
import { useChat } from "../../state/store.js";
import { FloatingWindow } from "../shared/FloatingWindow.js";

/** Custom event NotificationCenter dispatches to jump to a specific event. */
export const OPEN_SERVER_EVENT = "tk:open-server-event";
export interface OpenServerEventDetail {
  eventId: string;
  serverId?: string | null;
}

/** Cross-shell REQUEST to open an event that may live on another server
 *  (a world map's "View event" button). App routes it through the same
 *  flow as a reminder deep-link: switch to the owning server first, THEN
 *  dispatch OPEN_SERVER_EVENT — dispatching OPEN_SERVER_EVENT directly
 *  would open this panel on whatever server happens to be current. */
export const REQUEST_OPEN_SERVER_EVENT = "tk:request-open-server-event";
export type RequestOpenServerEventDetail = OpenServerEventDetail;

/** Cross-shell deep-link channels App subscribes to (this panel's link cards
 *  live outside the Chat shell's prop tree, same posture as
 *  OPEN_SERVER_EVENT). A message jump rides App's jumpToMessage — its server
 *  routes are the only authorization boundary; a forum link opens the Forums
 *  Catalog through App's usual gate. */
export const JUMP_TO_MESSAGE_EVENT = "tk:jump-to-message";
export interface JumpToMessageDetail {
  roomId: string;
  messageId: string;
}
export const OPEN_FORUM_CATALOG_EVENT = "tk:open-forum-catalog";
export interface OpenForumCatalogDetail {
  /** Forum id or slug, exactly what ForumsCatalog's initialKey accepts. */
  key: string;
}

const sid = (id: string) => encodeURIComponent(id);

/** One event OCCURRENCE with its aggregate counts + the caller's RSVP rows
 *  (the windowed list shape). Recurring events appear once per occurrence;
 *  counts/RSVPs are per SERIES. */
interface EventRow {
  event: ServerEvent;
  occurrenceStartsAt?: number;
  occurrenceEndsAt?: number | null;
  counts: { going: number; maybe: number; declined: number };
  myRsvps: ServerEventRsvp[];
}

/** Concrete start/end of a list row (old-bundle tolerance: fall back to the
 *  event's own times when the occurrence fields are absent). */
function occStart(row: EventRow): number {
  return row.occurrenceStartsAt ?? row.event.startsAt;
}
function occEnd(row: EventRow): number | null {
  return row.occurrenceEndsAt !== undefined ? row.occurrenceEndsAt : row.event.endsAt;
}
/** Stable list key — a recurring event renders once per occurrence. */
function rowKey(row: EventRow): string {
  return `${row.event.id}:${occStart(row)}`;
}
/** Derived context: forum-linked events are Forum events, all else Server. */
function eventContext(ev: ServerEvent): "server" | "forum" {
  return ev.linkedForumId ? "forum" : "server";
}
/** i18n key suffix for an event's repeat cadence, or null for one-offs. */
function repeatKey(ev: ServerEvent): "repeatsDaily" | "repeatsWeekly" | "repeatsBiweekly" | "repeatsMonthly" | null {
  const rule = parseEventRecurrence(ev.recurrenceJson);
  if (!rule) return null;
  return rule.freq === "daily" ? "repeatsDaily"
    : rule.freq === "weekly" ? "repeatsWeekly"
      : rule.freq === "biweekly" ? "repeatsBiweekly"
        : "repeatsMonthly";
}

/** A friendly local datetime; open-ended events omit the end. */
function formatWhen(t: TFunction<"servers">, startsAt: number, endsAt: number | null): string {
  const start = formatDateTime(startsAt, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  if (endsAt == null) return start;
  const sameDay = new Date(startsAt).toDateString() === new Date(endsAt).toDateString();
  const end = formatDateTime(endsAt, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return t("eventsPanel.whenRange", { start, end });
}

/** Compact "in 3h" / "in 2d" / "started" relative label for the start time. */
function relativeStart(t: TFunction<"servers">, startsAt: number): string {
  const ms = startsAt - Date.now();
  if (ms <= 0) return t("eventsPanel.inProgress");
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return t("eventsPanel.inMinutes", { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("eventsPanel.inHours", { n: hours });
  return t("eventsPanel.inDays", { n: Math.round(hours / 24) });
}

/** Local YYYY-MM-DD key for grouping events + marking calendar days. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** "Saturday, July 4" heading for a day group. */
function formatDayHeader(key: string): string {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  return formatDate(new Date(y, m - 1, d).getTime(), { weekday: "long", month: "long", day: "numeric" });
}

/**
 * Singleton-owner election. The Banner renders its `notificationBell` slot in
 * BOTH the desktop nav and the mobile bar (both always mounted, only CSS-
 * toggled), so this panel mounts twice. Each mount still needs its own trigger
 * button (whichever layout is visible), but only ONE may own the deep-link
 * listener + the modal — otherwise a reminder stacks two identical events
 * modals. The first mount to register claims ownership; it releases on unmount
 * and the next registrant (if any) takes over. `useIsEventsPanelOwner` returns
 * whether THIS instance is the owner and re-renders it when that flips.
 */
const eventsPanelOwners = new Set<symbol>();
const eventsPanelOwnerListeners = new Set<() => void>();
function claimEventsPanelOwner(token: symbol) {
  eventsPanelOwners.add(token);
  eventsPanelOwnerListeners.forEach((l) => l());
}
function releaseEventsPanelOwner(token: symbol) {
  eventsPanelOwners.delete(token);
  eventsPanelOwnerListeners.forEach((l) => l());
}
/** True only for the earliest-registered live instance (insertion order). */
function isEventsPanelOwner(token: symbol): boolean {
  return eventsPanelOwners.values().next().value === token;
}
function useIsEventsPanelOwner(): boolean {
  const tokenRef = useRef<symbol>();
  if (!tokenRef.current) tokenRef.current = Symbol("events-panel");
  const token = tokenRef.current;
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    const sync = () => setOwner(isEventsPanelOwner(token));
    eventsPanelOwnerListeners.add(sync);
    claimEventsPanelOwner(token);
    sync();
    return () => {
      eventsPanelOwnerListeners.delete(sync);
      releaseEventsPanelOwner(token);
    };
  }, [token]);
  return owner;
}

export function ServerEventsPanel() {
  const { t } = useTranslation("servers");
  const serversEnabled = useChat((s) => s.branding.serversEnabled);
  const serverId = useChat((s) => s.currentServerId);
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  // Room names for the "Go to room" link label (linked rooms always belong to
  // the current server, so the store's room map covers them).
  const roomsById = useChat((s) => s.rooms);
  // Only the elected owner listens for the open/deep-link event and renders the
  // modal (the panel mounts twice via the Banner's dual bell slots). Every
  // instance still shows its own trigger button + badge.
  const isOwner = useIsEventsPanelOwner();

  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // When opened from a reminder click, the id to scroll to + flash.
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusRef = useRef<HTMLLIElement | null>(null);
  // Calendar view state: which month the grid shows, and a selected day (set by
  // clicking a day with events) that scrolls the list below to that date.
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // Server vs Forum event context filter (forum-linked = Forum event).
  const [contextFilter, setContextFilter] = useState<"all" | "server" | "forum">("all");

  const load = useCallback(async () => {
    if (!serverId) return;
    setError(null);
    try {
      // Upcoming window: from now forward. Past events fall away naturally.
      const from = Date.now() - 60 * 60_000; // include events that just started
      const r = await fetch(`/servers/${sid(serverId)}/events?from=${from}`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { events: EventRow[] };
      setRows(j.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("eventsPanel.loadError"));
      setRows([]);
    }
  }, [serverId, t]);

  // Load on mount and whenever the server changes, so the header badge shows the
  // upcoming count WITHOUT the panel ever being opened. Also reload on open to
  // refresh live attendee counts + the caller's RSVP just before they act.
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // The single shared open channel (owner-only, so exactly one modal exists).
  // Fired by a trigger-button click (no eventId → just open) and by a
  // reminder deep-link (eventId → open + focus that event). For a reminder,
  // reacting only makes sense once we're on the event's server; the App-level
  // server switch runs first via openNotifTarget, then dispatches this.
  useEffect(() => {
    if (!isOwner) return;
    const onOpenEvent = (e: Event) => {
      const detail = (e as CustomEvent<OpenServerEventDetail>).detail;
      if (detail?.eventId) setFocusId(detail.eventId);
      setOpen(true);
    };
    window.addEventListener(OPEN_SERVER_EVENT, onOpenEvent as EventListener);
    return () => window.removeEventListener(OPEN_SERVER_EVENT, onOpenEvent as EventListener);
  }, [isOwner]);

  // Scroll the focused event into view once the rows land, and sync the calendar
  // to its month + day so the grid reflects where the reminder landed. A
  // recurring event focuses its NEXT occurrence (the first row of the series).
  useEffect(() => {
    if (!focusId || !rows) return;
    const row = rows.find((r) => r.event.id === focusId);
    if (row) {
      const d = new Date(occStart(row));
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
      setSelectedDay(dayKey(occStart(row)));
    }
    const el = focusRef.current;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Clear the flash after a beat so re-renders don't keep re-flashing.
    const t = setTimeout(() => setFocusId(null), 2500);
    return () => clearTimeout(t);
  }, [focusId, rows]);

  // Badge = distinct upcoming EVENTS (a weekly series counts once, however
  // many occurrences its expansion returned).
  const upcomingCount = useMemo(
    () => new Set(
      (rows ?? [])
        .filter((r) => r.event.status === "scheduled" || r.event.status === "live")
        .map((r) => r.event.id),
    ).size,
    [rows],
  );

  // Context filter first, then group by local day (for the list) and per-day
  // counts (for the calendar markers). Chronological within each day.
  const filteredRows = useMemo(
    () => (rows ?? []).filter((r) => contextFilter === "all" || eventContext(r.event) === contextFilter),
    [rows, contextFilter],
  );
  const eventsByDay = useMemo(() => {
    const m = new Map<string, EventRow[]>();
    for (const row of filteredRows) {
      const key = dayKey(occStart(row));
      const list = m.get(key);
      if (list) list.push(row); else m.set(key, [row]);
    }
    for (const list of m.values()) list.sort((a, b) => occStart(a) - occStart(b));
    return m;
  }, [filteredRows]);
  // The row a reminder deep-link should flash: the focused event's first
  // (soonest) occurrence in the current list.
  const focusKey = useMemo(() => {
    if (!focusId) return null;
    const row = filteredRows.find((r) => r.event.id === focusId);
    return row ? rowKey(row) : null;
  }, [focusId, filteredRows]);
  // YYYY-MM-DD sorts chronologically as a plain string.
  const sortedDays = useMemo(() => [...eventsByDay.keys()].sort(), [eventsByDay]);

  // Clicking a calendar day shows that day's detail below (its events, or a
  // "nothing on this day" note); the detail's back button clears the selection.
  const onSelectDay = useCallback((key: string) => setSelectedDay(key), []);

  async function rsvp(row: EventRow, status: ServerEventRsvpStatus) {
    if (!serverId) return;
    setBusyId(row.event.id);
    setError(null);
    try {
      const r = await fetch(`/servers/${sid(serverId)}/events/${sid(row.event.id)}/rsvp`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, characterId: activeCharacterId ?? null }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { counts: EventRow["counts"]; myRsvps: ServerEventRsvp[] };
      setRows((prev) => (prev ?? []).map((x) =>
        x.event.id === row.event.id ? { ...x, counts: j.counts, myRsvps: j.myRsvps } : x));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("eventsPanel.rsvpError"));
    } finally {
      setBusyId(null);
    }
  }

  // Feature-gated + server-scoped: render nothing (not even the button) when the
  // servers feature is off or we're not inside a server.
  if (!serversEnabled || !serverId) return null;

  // The caller's current RSVP for an event (for the active identity), so the
  // buttons can show which one is selected.
  const myStatusFor = (row: EventRow): ServerEventRsvpStatus | null => {
    const mine = row.myRsvps.find((r) => (r.characterId ?? null) === (activeCharacterId ?? null));
    return mine?.status ?? null;
  };

  // One clear action per link kind. Room joins ride the same socket path /go
  // uses (bans/passwords enforced by joinRoom); message links ride App's
  // jumpToMessage (its server checks are the boundary — a pruned or denied
  // message surfaces App's own "message is gone" toast); forum links open the
  // Forums Catalog; external links confirm, naming the host, then open a
  // noopener tab.
  const openLink = (ev: ServerEvent) => {
    if (ev.linkedRoomId) {
      const roomId = ev.linkedRoomId;
      getSocket().emit("room:join", { roomId }, (res) => {
        // The modal is already closed when this ack lands, so a denied join
        // (ban, password, role gate) must surface through the app-level
        // notice — the same path App's own join uses — not modal-local state.
        if (!res.ok) useChat.getState().setNotice({ code: res.code, message: res.message });
      });
      setOpen(false);
      return;
    }
    if (ev.linkedMessageId) {
      const link = parseMessageLink(ev.linkedMessageId);
      if (!link) return;
      window.dispatchEvent(new CustomEvent<JumpToMessageDetail>(JUMP_TO_MESSAGE_EVENT, {
        detail: { roomId: link.roomId, messageId: link.messageId },
      }));
      setOpen(false);
      return;
    }
    if (ev.linkedForumId) {
      window.dispatchEvent(new CustomEvent<OpenForumCatalogDetail>(OPEN_FORUM_CATALOG_EVENT, {
        detail: { key: ev.linkedForumId },
      }));
      setOpen(false);
      return;
    }
    if (ev.externalUrl) {
      let host = ev.externalUrl;
      try { host = new URL(ev.externalUrl).hostname; } catch { /* show raw */ }
      if (window.confirm(t("eventsPanel.externalConfirm", { host }))) {
        window.open(ev.externalUrl, "_blank", "noopener,noreferrer");
      }
    }
  };

  const renderEventCard = (row: EventRow) => {
    const ev = row.event;
    const key = rowKey(row);
    const startsAt = occStart(row);
    const endsAt = occEnd(row);
    const mine = myStatusFor(row);
    const cancelled = ev.status === "cancelled";
    const ended = ev.status === "ended";
    const closed = cancelled || ended;
    const flash = focusKey === key;
    const repeats = repeatKey(ev);
    const roomName = ev.linkedRoomId ? roomsById[ev.linkedRoomId]?.name ?? null : null;
    return (
      <li
        key={key}
        ref={flash ? focusRef : undefined}
        className={`rounded border p-3 transition-colors ${
          flash ? "border-keep-action bg-keep-action/10" : "border-keep-rule bg-keep-panel/20"
        } ${cancelled ? "opacity-60" : ""}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-keep-text">
              <EventIcon name={ev.icon} className="h-4 w-4 shrink-0 text-keep-muted" />
              <span className="truncate">{ev.title}</span>
              {ev.status === "live" ? (
                <span className="shrink-0 rounded bg-keep-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-keep-bg">{t("eventsPanel.live")}</span>
              ) : null}
              {cancelled ? (
                <span className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-keep-accent">{t("eventsPanel.cancelled")}</span>
              ) : null}
            </h3>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-keep-muted">
              <span>{formatWhen(t, startsAt, endsAt)}</span>
              {!closed ? <span className="text-keep-action">{relativeStart(t, startsAt)}</span> : null}
              {repeats ? (
                <span className="inline-flex items-center gap-1 rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest">
                  <Repeat className="h-3 w-3" aria-hidden="true" />
                  {t(`eventsPanel.${repeats}`)}
                </span>
              ) : null}
              <span className="inline-flex items-center rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-widest">
                {eventContext(ev) === "forum" ? t("eventsPanel.forumEvent") : t("eventsPanel.serverEvent")}
              </span>
            </p>
            {ev.hostName ? (
              <p className="mt-0.5 text-[11px] text-keep-muted">{t("eventsPanel.hostedBy", { name: ev.hostName })}</p>
            ) : null}
          </div>
        </div>

        {ev.descriptionHtml ? (
          <div
            className="prose prose-sm mt-2 max-w-none text-xs text-keep-text [&_p]:m-0"
            dangerouslySetInnerHTML={{ __html: ev.descriptionHtml }}
          />
        ) : null}

        {ev.linkedRoomId || ev.linkedMessageId || ev.linkedForumId || ev.externalUrl ? (
          <p className="mt-2">
            <button
              type="button"
              onClick={() => openLink(ev)}
              className="inline-flex items-center gap-1.5 rounded border border-keep-rule bg-keep-bg px-2.5 py-1 text-[11px] text-keep-muted hover:border-keep-action/60 hover:text-keep-action"
            >
              {ev.linkedRoomId ? (
                <>
                  <MapPin className="h-3 w-3" aria-hidden="true" />
                  {roomName ? t("eventsPanel.goToRoomNamed", { name: roomName }) : t("eventsPanel.goToRoom")}
                </>
              ) : ev.linkedMessageId ? (
                <>
                  <MessageSquareQuote className="h-3 w-3" aria-hidden="true" />
                  {t("eventsPanel.viewMessage")}
                </>
              ) : ev.linkedForumId ? (
                <>
                  <MessagesSquare className="h-3 w-3" aria-hidden="true" />
                  {t("eventsPanel.openForum")}
                </>
              ) : (
                <>
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  {t("eventsPanel.openExternal")}
                </>
              )}
            </button>
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(["going", "maybe", "declined"] as const).map((status) => {
            const active = mine === status;
            const label = status === "going" ? t("eventsPanel.going") : status === "maybe" ? t("eventsPanel.maybe") : t("eventsPanel.cantMakeIt");
            return (
              <button
                key={status}
                type="button"
                disabled={closed || busyId === ev.id}
                onClick={() => void rsvp(row, status)}
                className={`rounded border px-2.5 py-1 text-xs ${
                  active
                    ? "border-keep-action bg-keep-action/15 font-semibold text-keep-action"
                    : "border-keep-rule bg-keep-bg text-keep-muted hover:text-keep-text"
                } disabled:opacity-50`}
              >
                {label}
              </button>
            );
          })}
          <span className="ml-auto text-[11px] text-keep-muted">
            {t("eventsPanel.goingCount", { n: row.counts.going })}
            {row.counts.maybe ? t("eventsPanel.maybeCountSuffix", { n: row.counts.maybe }) : ""}
          </span>
        </div>
        {repeats ? (
          <p className="mt-1.5 text-[10px] italic text-keep-muted">{t("eventsPanel.seriesRsvpHint")}</p>
        ) : null}
      </li>
    );
  };

  return (
    <>
      <button
        type="button"
        onClick={() =>
          // Route through the shared open channel so whichever instance owns the
          // modal (desktop vs. mobile bell slot) is the one that shows it —
          // never two. Empty eventId ⇒ open without focusing any row.
          window.dispatchEvent(
            new CustomEvent<OpenServerEventDetail>(OPEN_SERVER_EVENT, { detail: { eventId: "" } }),
          )
        }
        title={t("eventsPanel.title")}
        aria-label={upcomingCount > 0 ? t("eventsPanel.titleWithCount", { n: upcomingCount }) : t("eventsPanel.title")}
        className="relative flex h-8 w-8 items-center justify-center rounded border border-keep-rule bg-keep-panel text-keep-muted hover:text-keep-text"
      >
        <CalendarDays className="h-4 w-4" aria-hidden="true" />
        {upcomingCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-keep-action px-1 text-[10px] font-bold leading-none text-keep-bg">
            {upcomingCount > 9 ? t("eventsPanel.badgeOverflow") : upcomingCount}
          </span>
        ) : null}
      </button>

      {open && isOwner ? (
        <FloatingWindow
          title={
            <span className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-keep-action" aria-hidden="true" />
              {t("eventsPanel.title")}
            </span>
          }
          onClose={() => setOpen(false)}
          initialWidth={840}
          initialHeight={720}
          className="keep-frame rounded border border-keep-rule bg-keep-bg text-keep-text"
        >
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {error ? <p className="shrink-0 px-4 pt-3 text-xs text-keep-accent">{error}</p> : null}
              {/* Calendar (pinned): gives the panel a shape even with no upcoming
                  events, and shows at a glance which days have something on.
                  Click a marked day to jump the list below to it. */}
              <div className="shrink-0 border-b border-keep-rule p-4">
                <MonthCalendar
                  year={viewYear}
                  month={viewMonth}
                  onPrev={() => { const d = new Date(viewYear, viewMonth - 1, 1); setViewYear(d.getFullYear()); setViewMonth(d.getMonth()); }}
                  onNext={() => { const d = new Date(viewYear, viewMonth + 1, 1); setViewYear(d.getFullYear()); setViewMonth(d.getMonth()); }}
                  eventsByDay={eventsByDay}
                  selectedDay={selectedDay}
                  onSelectDay={onSelectDay}
                  onOpenEvent={(key, eventId) => { setSelectedDay(key); setFocusId(eventId); }}
                />
              </div>
              {/* Server vs Forum context filter (forum-linked events are
                  Forum events; everything else is a Server event). */}
              <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-keep-rule px-4 py-2">
                {([
                  ["all", t("eventsPanel.filterAll")],
                  ["server", t("eventsPanel.filterServer")],
                  ["forum", t("eventsPanel.filterForum")],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setContextFilter(key)}
                    aria-pressed={contextFilter === key}
                    className={`rounded border px-2.5 py-1 text-[11px] ${
                      contextFilter === key
                        ? "border-keep-action bg-keep-action/15 font-semibold text-keep-action"
                        : "border-keep-rule bg-keep-bg text-keep-muted hover:text-keep-text"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {/* Below the calendar: a single day's detail when one is picked,
                  otherwise every upcoming event grouped by date (soonest first). */}
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {rows === null ? (
                  <p className="text-sm italic text-keep-muted">{t("shared.loading")}</p>
                ) : selectedDay ? (
                  <div>
                    <div className="mb-3 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedDay(null)}
                        className="shrink-0 rounded border border-keep-rule px-2 py-1 text-[11px] text-keep-muted hover:text-keep-text"
                      >
                        {t("eventsPanel.allUpcoming")}
                      </button>
                      <h4 className="min-w-0 truncate text-sm font-semibold text-keep-text">{formatDayHeader(selectedDay)}</h4>
                    </div>
                    {(eventsByDay.get(selectedDay) ?? []).length === 0 ? (
                      <p className="text-sm italic text-keep-muted">{t("eventsPanel.noneOnDay")}</p>
                    ) : (
                      <ul className="space-y-3">
                        {(eventsByDay.get(selectedDay) ?? []).map((row) => renderEventCard(row))}
                      </ul>
                    )}
                  </div>
                ) : filteredRows.length === 0 ? (
                  <p className="text-sm italic text-keep-muted">{t("eventsPanel.noneUpcoming")}</p>
                ) : (
                  <div className="space-y-4">
                    {sortedDays.map((key) => (
                      <div key={key}>
                        <h4 className="mb-2 text-xs font-semibold uppercase tracking-widest text-keep-muted">{formatDayHeader(key)}</h4>
                        <ul className="space-y-3">
                          {(eventsByDay.get(key) ?? []).map((row) => renderEventCard(row))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
        </FloatingWindow>
      ) : null}
    </>
  );
}

/** How many event badges a calendar cell shows before collapsing the rest
 *  into a "+N more" chip (which opens that day's full list). */
const MAX_CELL_BADGES = 2;

/**
 * A month grid for the events panel, laid out like a wall calendar: the date
 * sits in each cell's top-left, and every event that day shows as a clickable
 * badge (its icon + a truncated title) rather than a bare dot, so members can
 * see AND open what's on at a glance. Clicking a badge opens that event;
 * clicking the date (or "+N more") opens the whole day. Today gets a ring, the
 * selected day a highlight. Purely presentational — the panel owns the month +
 * selection state.
 */
function MonthCalendar({
  year, month, onPrev, onNext, eventsByDay, selectedDay, onSelectDay, onOpenEvent,
}: {
  year: number;
  month: number;
  onPrev: () => void;
  onNext: () => void;
  eventsByDay: Map<string, EventRow[]>;
  selectedDay: string | null;
  onSelectDay: (key: string) => void;
  onOpenEvent: (key: string, eventId: string) => void;
}) {
  const { t } = useTranslation("servers");
  const first = new Date(year, month, 1);
  const startWeekday = first.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dayKey(Date.now());
  const monthLabel = formatDate(first.getTime(), { month: "long", year: "numeric" });
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button type="button" onClick={onPrev} title={t("eventsPanel.prevMonth")} aria-label={t("eventsPanel.prevMonth")}
          className="rounded p-1 text-keep-muted hover:bg-keep-panel hover:text-keep-text">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <span className="text-sm font-semibold text-keep-text">{monthLabel}</span>
        <button type="button" onClick={onNext} title={t("eventsPanel.nextMonth")} aria-label={t("eventsPanel.nextMonth")}
          className="rounded p-1 text-keep-muted hover:bg-keep-panel hover:text-keep-text">
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-widest text-keep-muted">
        {[
          t("eventsPanel.weekdaySun"), t("eventsPanel.weekdayMon"), t("eventsPanel.weekdayTue"),
          t("eventsPanel.weekdayWed"), t("eventsPanel.weekdayThu"), t("eventsPanel.weekdayFri"),
          t("eventsPanel.weekdaySat"),
        ].map((w, i) => <div key={i}>{w}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d == null) return <div key={`b${i}`} className="min-h-[3.75rem]" />;
          const key = dayKey(new Date(year, month, d).getTime());
          const dayRows = eventsByDay.get(key) ?? [];
          const count = dayRows.length;
          const has = count > 0;
          const isToday = key === todayKey;
          const isSelected = key === selectedDay;
          return (
            <div
              key={key}
              className={`flex min-h-[3.75rem] flex-col gap-0.5 rounded border p-1 transition-colors ${
                isSelected
                  ? "border-keep-action bg-keep-action/10"
                  : isToday
                    ? "border-keep-rule bg-keep-panel/30"
                    : "border-transparent hover:bg-keep-panel/40"
              }`}
            >
              {/* Date, top-left, like a wall calendar; clicking it opens the
                  whole day's list below. */}
              <button
                type="button"
                onClick={() => onSelectDay(key)}
                title={has ? t("eventsPanel.dayEvents", { count }) : t("eventsPanel.noEvents")}
                aria-label={`${monthLabel} ${d}${has ? t("eventsPanel.dayEventsSuffix", { count }) : ""}`}
                className={`self-start rounded px-1 text-[11px] leading-none ${
                  isSelected || isToday ? "font-semibold text-keep-action" : has ? "font-semibold text-keep-text" : "text-keep-muted"
                } hover:text-keep-action`}
              >
                {d}
              </button>
              {has ? (
                <div className="flex min-w-0 flex-col gap-0.5">
                  {dayRows.slice(0, MAX_CELL_BADGES).map((row) => (
                    <button
                      key={rowKey(row)}
                      type="button"
                      onClick={() => onOpenEvent(key, row.event.id)}
                      title={row.event.title}
                      className="flex min-w-0 items-center gap-1 rounded bg-keep-action/15 px-1 py-0.5 text-left text-[10px] leading-tight text-keep-action hover:bg-keep-action/30"
                    >
                      <EventIcon name={row.event.icon} className="h-3 w-3 shrink-0" />
                      <span className="truncate">{row.event.title}</span>
                    </button>
                  ))}
                  {count > MAX_CELL_BADGES ? (
                    <button
                      type="button"
                      onClick={() => onSelectDay(key)}
                      className="rounded px-1 text-left text-[10px] leading-tight text-keep-muted hover:text-keep-text"
                    >
                      {t("eventsPanel.dayMore", { n: count - MAX_CELL_BADGES })}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
