/**
 * Server Admin → Events tab (Multi-Server Lift).
 *
 * The per-server community-calendar manager, gated on the `manage_events`
 * server permission. An owner/mod schedules one-off events (a session, a
 * tournament, a lore night), optionally links a room/forum, sets an opt-in
 * reminder lead, and can cancel or delete. Every fetch hits
 * `/servers/:id/events`; rows are created + listed WHERE `server_id = :id`.
 *
 * Times: the form uses a native `datetime-local` (the manager's local wall
 * clock) and converts to a UTC ms epoch on save (and back for edit), so the
 * stored `startsAt`/`endsAt` are always absolute — no timezone ambiguity on the
 * wire. The member-facing panel (ServerEventsPanel) renders them back through
 * `toLocaleString` for each viewer.
 *
 * House style mirrors the sibling AnnouncementsTab (keep-* tokens, inline fetch
 * helpers — lib/servers.ts stays untouched). Description accepts the same HTML
 * as profile bios; the server re-sanitizes on save.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  ServerEvent,
  ServerEventRsvp,
  ServerViewerState,
} from "@thekeep/shared";
import { readError } from "../../lib/http.js";

interface EventsTabProps {
  serverId: string;
  viewer: ServerViewerState;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}

const sid = (id: string) => encodeURIComponent(id);

/** One event + its aggregate RSVP counts (the list shape the route returns). */
interface EventRow {
  event: ServerEvent;
  counts: { going: number; maybe: number; declined: number };
  myRsvps: ServerEventRsvp[];
}

interface PickerRoom { id: string; name: string }
interface PickerChar { id: string; name: string }

/** Reminder-lead options offered in the form; MUST match the server's
 *  REMINDER_LEADS_MS allow-list (servers/events.ts). */
const REMINDER_OPTIONS: { label: string; ms: number | null }[] = [
  { label: "No reminder", ms: null },
  { label: "5 minutes before", ms: 5 * 60_000 },
  { label: "10 minutes before", ms: 10 * 60_000 },
  { label: "15 minutes before", ms: 15 * 60_000 },
  { label: "30 minutes before", ms: 30 * 60_000 },
  { label: "1 hour before", ms: 60 * 60_000 },
  { label: "2 hours before", ms: 2 * 60 * 60_000 },
  { label: "1 day before", ms: 24 * 60 * 60_000 },
];

/** A UTC ms epoch → the `datetime-local` value string in LOCAL time (the input
 *  has no timezone, so we hand it local wall-clock and read it back the same). */
function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  // Subtract the offset so toISOString (UTC) yields the LOCAL wall clock, then
  // trim to minutes for the input.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** A `datetime-local` value (local wall clock) → UTC ms epoch. */
function localInputToMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export default function EventsTab({ serverId, viewer }: EventsTabProps) {
  const canManage = viewer.permissions.includes("manage_events");
  return (
    <div className="max-w-3xl space-y-6">
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-keep-muted">
          Community events
        </h2>
        <p className="mb-3 text-xs text-keep-muted">
          Schedule sessions, tournaments, or lore nights on this server's calendar. Members can
          RSVP going, maybe, or can't make it, and an optional reminder pings everyone who's going
          a little before it starts. Cancelling keeps the event on the calendar marked cancelled;
          deleting removes it entirely.
        </p>
        <EventsSection serverId={serverId} canManage={canManage} />
      </section>
    </div>
  );
}

function EventsSection({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ServerEvent | null>(null);
  const [adding, setAdding] = useState(false);

  // Shared pickers (this server's rooms + the manager's characters), lifted so
  // the table can resolve names and the form skips duplicate fetches.
  const [rooms, setRooms] = useState<PickerRoom[]>([]);
  const [chars, setChars] = useState<PickerChar[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Reuse the announcements room picker (same server-scoped source).
        const r = await fetch(`/servers/${sid(serverId)}/announcements/rooms`, { credentials: "include" });
        if (r.ok) {
          const j = (await r.json()) as { rooms?: PickerRoom[] };
          if (!cancelled && Array.isArray(j.rooms)) setRooms(j.rooms);
        }
      } catch { /* leave empty */ }
      try {
        const c = await fetch(`/characters`, { credentials: "include" });
        if (c.ok) {
          const j = (await c.json()) as { characters?: PickerChar[] };
          if (!cancelled && Array.isArray(j.characters)) setChars(j.characters);
        }
      } catch { /* leave empty */ }
    })();
    return () => { cancelled = true; };
  }, [serverId]);

  const roomNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rooms) m.set(r.id, r.name);
    return m;
  }, [rooms]);

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/servers/${sid(serverId)}/events`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { events: EventRow[] };
      setRows(j.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [serverId]);

  async function cancelEvent(row: EventRow) {
    if (!window.confirm("Cancel this event? It stays on the calendar marked cancelled.")) return;
    try {
      const r = await fetch(`/servers/${sid(serverId)}/events/${sid(row.event.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "cancel failed");
    }
  }

  async function remove(row: EventRow) {
    if (!window.confirm("Delete this event? RSVPs are lost and members lose it on refresh.")) return;
    try {
      const r = await fetch(`/servers/${sid(serverId)}/events/${sid(row.event.id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  if (rows === null) return <p className="text-xs italic text-keep-muted">Loading…</p>;
  return (
    <div className="space-y-3">
      {error ? <p className="text-xs text-keep-accent">{error}</p> : null}
      {canManage ? (
        <button
          type="button"
          onClick={() => { setAdding(true); setEditing(null); }}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/25"
        >
          + New event
        </button>
      ) : null}
      {(adding || editing) && canManage ? (
        <EventForm
          serverId={serverId}
          rooms={rooms}
          chars={chars}
          {...(editing ? { initial: editing } : {})}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSaved={async () => { setAdding(false); setEditing(null); await load(); }}
        />
      ) : null}
      {rows.length === 0 ? (
        <p className="text-xs italic text-keep-muted">No events yet.</p>
      ) : (
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-b border-keep-rule text-keep-muted">
              <th className="px-2 py-1 text-left">Event</th>
              <th className="px-2 py-1 text-left">When</th>
              <th className="px-2 py-1 text-left">RSVPs</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const ev = row.event;
              return (
                <tr key={ev.id} className="border-b border-keep-rule/40 align-top">
                  <td className="max-w-[220px] px-2 py-2">
                    <div className="font-semibold text-keep-text">
                      {ev.title}
                      {ev.status === "cancelled" ? (
                        <span className="ml-1 text-[10px] uppercase tracking-widest text-keep-accent">(cancelled)</span>
                      ) : ev.status === "live" ? (
                        <span className="ml-1 text-[10px] uppercase tracking-widest text-keep-action">(live)</span>
                      ) : ev.status === "ended" ? (
                        <span className="ml-1 text-[10px] uppercase tracking-widest text-keep-muted">(ended)</span>
                      ) : null}
                    </div>
                    {ev.linkedRoomId ? (
                      <div className="text-[10px] text-keep-muted">
                        Room: {roomNameById.get(ev.linkedRoomId) ?? ev.linkedRoomId}
                      </div>
                    ) : null}
                    {ev.reminderLeadMs ? (
                      <div className="text-[10px] text-keep-muted">Reminder set</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <div>{new Date(ev.startsAt).toLocaleString()}</div>
                    {ev.endsAt ? (
                      <div className="text-[10px] text-keep-muted">to {new Date(ev.endsAt).toLocaleString()}</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <span className="text-keep-text">{row.counts.going}</span> going
                    {row.counts.maybe ? <span className="text-keep-muted"> · {row.counts.maybe} maybe</span> : null}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {canManage ? (
                      <>
                        <button
                          type="button"
                          onClick={() => { setEditing(ev); setAdding(false); }}
                          className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                        >
                          Edit
                        </button>
                        {ev.status !== "cancelled" ? (
                          <button
                            type="button"
                            onClick={() => void cancelEvent(row)}
                            className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                          >
                            Cancel
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void remove(row)}
                          className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/20"
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EventForm({
  serverId,
  initial,
  rooms,
  chars,
  onCancel,
  onSaved,
}: {
  serverId: string;
  initial?: ServerEvent;
  rooms: PickerRoom[];
  chars: PickerChar[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.descriptionHtml ?? "");
  const [startsAt, setStartsAt] = useState(initial ? msToLocalInput(initial.startsAt) : "");
  const [endsAt, setEndsAt] = useState(initial?.endsAt ? msToLocalInput(initial.endsAt) : "");
  const [hostCharacterId, setHostCharacterId] = useState<string | null>(initial?.hostCharacterId ?? null);
  const [linkedRoomId, setLinkedRoomId] = useState<string | null>(initial?.linkedRoomId ?? null);
  const [reminderLeadMs, setReminderLeadMs] = useState<number | null>(initial?.reminderLeadMs ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const startMs = localInputToMs(startsAt);
      if (!title.trim()) throw new Error("A title is required.");
      if (startMs == null) throw new Error("A start time is required.");
      const endMs = endsAt ? localInputToMs(endsAt) : null;
      if (endMs != null && endMs <= startMs) throw new Error("The end time must be after the start time.");

      const payload = {
        title: title.trim(),
        descriptionHtml: description.trim() ? description : null,
        startsAt: startMs,
        endsAt: endMs,
        hostCharacterId,
        linkedRoomId,
        reminderLeadMs,
      };
      const url = initial
        ? `/servers/${sid(serverId)}/events/${sid(initial.id)}`
        : `/servers/${sid(serverId)}/events`;
      const r = await fetch(url, {
        method: initial ? "PATCH" : "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await readError(r));
      await onSaved();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-rule bg-keep-panel/30 p-3 text-xs">
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={140}
          placeholder="Friday night session"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
      </label>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description (optional, HTML allowed)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={8000}
          placeholder="What's happening, who it's for, anything to prep."
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px]"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <label className="block flex-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Starts</span>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
        <label className="block flex-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Ends (optional)</span>
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
      </div>
      <p className="text-[10px] text-keep-muted">Times use your local clock; members see them in theirs.</p>

      <div className="flex flex-wrap gap-2">
        <label className="block flex-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Host (optional)</span>
          <select
            value={hostCharacterId ?? ""}
            onChange={(e) => setHostCharacterId(e.target.value || null)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="">None / OOC</option>
            {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="block flex-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Linked room (optional)</span>
          <select
            value={linkedRoomId ?? ""}
            onChange={(e) => setLinkedRoomId(e.target.value || null)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="">None</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Reminder</span>
        <select
          value={reminderLeadMs == null ? "" : String(reminderLeadMs)}
          onChange={(e) => setReminderLeadMs(e.target.value ? Number(e.target.value) : null)}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        >
          {REMINDER_OPTIONS.map((o) => (
            <option key={o.label} value={o.ms == null ? "" : String(o.ms)}>{o.label}</option>
          ))}
        </select>
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          Pings everyone RSVP'd going or maybe, once, this far before the start.
        </span>
      </label>

      {error ? <p className="text-keep-accent">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner">
          Cancel
        </button>
        <button type="submit" disabled={submitting}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">
          {submitting ? "Saving…" : initial ? "Save changes" : "Create event"}
        </button>
      </div>
    </form>
  );
}
