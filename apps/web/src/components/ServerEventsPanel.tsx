/**
 * ServerEventsPanel — the member-facing community calendar (Multi-Server Lift).
 *
 * A header entry (a Calendar button) that surfaces this server's upcoming
 * events. Opening it lists scheduled/live events with going/maybe/decline RSVP
 * buttons and live attendee counts; the caller RSVPs as their currently-voiced
 * identity (OOC when none is active), matching the per-identity contract. The
 * management surface (create/edit/cancel) lives in the Server Settings → Events
 * tab; this panel is read-and-RSVP only.
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
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, X } from "lucide-react";
import type {
  ServerEvent,
  ServerEventRsvp,
  ServerEventRsvpStatus,
} from "@thekeep/shared";
import { readError } from "../lib/http.js";
import { EventIcon } from "../lib/eventIcons.js";
import { useChat } from "../state/store.js";
import { Modal } from "./Modal.js";

/** Custom event NotificationCenter dispatches to jump to a specific event. */
export const OPEN_SERVER_EVENT = "tk:open-server-event";
export interface OpenServerEventDetail {
  eventId: string;
  serverId?: string | null;
}

const sid = (id: string) => encodeURIComponent(id);

/** One event with its aggregate counts + the caller's RSVP rows (list shape). */
interface EventRow {
  event: ServerEvent;
  counts: { going: number; maybe: number; declined: number };
  myRsvps: ServerEventRsvp[];
}

/** A friendly local datetime; open-ended events omit the end. */
function formatWhen(startsAt: number, endsAt: number | null): string {
  const start = new Date(startsAt).toLocaleString([], {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  if (endsAt == null) return start;
  const sameDay = new Date(startsAt).toDateString() === new Date(endsAt).toDateString();
  const end = new Date(endsAt).toLocaleString([], sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${start} – ${end}`;
}

/** Compact "in 3h" / "in 2d" / "started" relative label for the start time. */
function relativeStart(startsAt: number): string {
  const ms = startsAt - Date.now();
  if (ms <= 0) return "in progress";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** Local YYYY-MM-DD key for grouping events + marking calendar days. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** "Saturday, July 4" heading for a day group. */
function formatDayHeader(key: string): string {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
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
  const serversEnabled = useChat((s) => s.branding.serversEnabled);
  const serverId = useChat((s) => s.currentServerId);
  const activeCharacterId = useChat((s) => s.activeCharacterId);
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
      setError(e instanceof Error ? e.message : "Couldn't load events.");
      setRows([]);
    }
  }, [serverId]);

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
  // to its month + day so the grid reflects where the reminder landed.
  useEffect(() => {
    if (!focusId || !rows) return;
    const row = rows.find((r) => r.event.id === focusId);
    if (row) {
      const d = new Date(row.event.startsAt);
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
      setSelectedDay(dayKey(row.event.startsAt));
    }
    const el = focusRef.current;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Clear the flash after a beat so re-renders don't keep re-flashing.
    const t = setTimeout(() => setFocusId(null), 2500);
    return () => clearTimeout(t);
  }, [focusId, rows]);

  const upcomingCount = useMemo(
    () => (rows ?? []).filter((r) => r.event.status === "scheduled" || r.event.status === "live").length,
    [rows],
  );

  // Group events by local day (for the list) and per-day counts (for the
  // calendar markers). Chronological within each day.
  const eventsByDay = useMemo(() => {
    const m = new Map<string, EventRow[]>();
    for (const row of rows ?? []) {
      const key = dayKey(row.event.startsAt);
      const list = m.get(key);
      if (list) list.push(row); else m.set(key, [row]);
    }
    for (const list of m.values()) list.sort((a, b) => a.event.startsAt - b.event.startsAt);
    return m;
  }, [rows]);
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
      setError(e instanceof Error ? e.message : "Couldn't save your RSVP.");
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

  const renderEventCard = (row: EventRow) => {
    const ev = row.event;
    const mine = myStatusFor(row);
    const cancelled = ev.status === "cancelled";
    const ended = ev.status === "ended";
    const closed = cancelled || ended;
    const flash = focusId === ev.id;
    return (
      <li
        key={ev.id}
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
                <span className="shrink-0 rounded bg-keep-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-keep-bg">Live</span>
              ) : null}
              {cancelled ? (
                <span className="shrink-0 rounded border border-keep-accent/60 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-keep-accent">Cancelled</span>
              ) : null}
            </h3>
            <p className="mt-0.5 text-xs text-keep-muted">
              {formatWhen(ev.startsAt, ev.endsAt)}
              {!closed ? <span className="ml-2 text-keep-action">{relativeStart(ev.startsAt)}</span> : null}
            </p>
          </div>
        </div>

        {ev.descriptionHtml ? (
          <div
            className="prose prose-sm mt-2 max-w-none text-xs text-keep-text [&_p]:m-0"
            dangerouslySetInnerHTML={{ __html: ev.descriptionHtml }}
          />
        ) : null}

        {ev.linkedRoomId ? (
          <p className="mt-2 flex items-center gap-1 text-[11px] text-keep-muted">
            <MapPin className="h-3 w-3" aria-hidden="true" />
            <span>Happens in a linked room.</span>
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(["going", "maybe", "declined"] as const).map((status) => {
            const active = mine === status;
            const label = status === "going" ? "Going" : status === "maybe" ? "Maybe" : "Can't make it";
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
            {row.counts.going} going
            {row.counts.maybe ? ` · ${row.counts.maybe} maybe` : ""}
          </span>
        </div>
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
        title="Community events"
        aria-label={upcomingCount > 0 ? `Community events (${upcomingCount} upcoming)` : "Community events"}
        className="relative flex h-8 w-8 items-center justify-center rounded border border-keep-rule bg-keep-panel text-keep-muted hover:text-keep-text"
      >
        <CalendarDays className="h-4 w-4" aria-hidden="true" />
        {upcomingCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-keep-action px-1 text-[10px] font-bold leading-none text-keep-bg">
            {upcomingCount > 9 ? "9+" : upcomingCount}
          </span>
        ) : null}
      </button>

      {open && isOwner ? (
        <Modal onClose={() => setOpen(false)} variant="mobile-fullscreen">
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex h-full w-full flex-col overflow-hidden bg-keep-bg text-keep-text lg:h-[85vh] lg:max-h-[85vh] lg:w-[52rem] lg:max-w-4xl lg:rounded-lg lg:border lg:border-keep-rule lg:shadow-2xl"
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-keep-rule px-4 py-3">
              <CalendarDays className="h-5 w-5 text-keep-action" aria-hidden="true" />
              <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-keep-text">Community events</h2>
              <button type="button" onClick={() => setOpen(false)} title="Close" aria-label="Close"
                className="shrink-0 rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </header>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
                />
              </div>
              {/* Below the calendar: a single day's detail when one is picked,
                  otherwise every upcoming event grouped by date (soonest first). */}
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {rows === null ? (
                  <p className="text-sm italic text-keep-muted">Loading…</p>
                ) : selectedDay ? (
                  <div>
                    <div className="mb-3 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedDay(null)}
                        className="shrink-0 rounded border border-keep-rule px-2 py-1 text-[11px] text-keep-muted hover:text-keep-text"
                      >
                        ‹ All upcoming
                      </button>
                      <h4 className="min-w-0 truncate text-sm font-semibold text-keep-text">{formatDayHeader(selectedDay)}</h4>
                    </div>
                    {(eventsByDay.get(selectedDay) ?? []).length === 0 ? (
                      <p className="text-sm italic text-keep-muted">No events on this day.</p>
                    ) : (
                      <ul className="space-y-3">
                        {(eventsByDay.get(selectedDay) ?? []).map((row) => renderEventCard(row))}
                      </ul>
                    )}
                  </div>
                ) : rows.length === 0 ? (
                  <p className="text-sm italic text-keep-muted">No upcoming events yet. Pick a day above, or check back soon.</p>
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
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * A compact month grid for the events panel. Days that have events carry an
 * accent dot and are clickable (scrolls the list to that date); today gets a
 * ring. Purely presentational — the panel owns the month + selection state.
 */
function MonthCalendar({
  year, month, onPrev, onNext, eventsByDay, selectedDay, onSelectDay,
}: {
  year: number;
  month: number;
  onPrev: () => void;
  onNext: () => void;
  eventsByDay: Map<string, EventRow[]>;
  selectedDay: string | null;
  onSelectDay: (key: string) => void;
}) {
  const first = new Date(year, month, 1);
  const startWeekday = first.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dayKey(Date.now());
  const monthLabel = first.toLocaleDateString([], { month: "long", year: "numeric" });
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button type="button" onClick={onPrev} title="Previous month" aria-label="Previous month"
          className="rounded p-1 text-keep-muted hover:bg-keep-panel hover:text-keep-text">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <span className="text-sm font-semibold text-keep-text">{monthLabel}</span>
        <button type="button" onClick={onNext} title="Next month" aria-label="Next month"
          className="rounded p-1 text-keep-muted hover:bg-keep-panel hover:text-keep-text">
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-widest text-keep-muted">
        {["S", "M", "T", "W", "T", "F", "S"].map((w, i) => <div key={i}>{w}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d == null) return <div key={`b${i}`} className="aspect-square" />;
          const key = dayKey(new Date(year, month, d).getTime());
          const count = eventsByDay.get(key)?.length ?? 0;
          const has = count > 0;
          const isToday = key === todayKey;
          const isSelected = key === selectedDay;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelectDay(key)}
              title={has ? `${count} event${count === 1 ? "" : "s"}` : "No events"}
              aria-label={`${monthLabel} ${d}${has ? `, ${count} event${count === 1 ? "" : "s"}` : ""}`}
              className={`relative flex aspect-square cursor-pointer flex-col items-center justify-center rounded text-xs transition-colors ${
                isSelected
                  ? "bg-keep-action/20 font-semibold text-keep-action ring-1 ring-keep-action"
                  : has
                    ? "font-semibold text-keep-text hover:bg-keep-panel"
                    : "text-keep-muted hover:bg-keep-panel hover:text-keep-text"
              } ${isToday && !isSelected ? "ring-1 ring-keep-rule" : ""}`}
            >
              <span>{d}</span>
              {has ? <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-keep-action" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
