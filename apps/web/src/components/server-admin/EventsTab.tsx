/**
 * Server Admin → Events tab (Multi-Server Lift).
 *
 * The per-server community-calendar manager, gated on the `manage_events`
 * server permission. An owner/mod schedules events (a session, a tournament,
 * a lore night) — one-off or repeating on a preset rule — points each at at
 * most ONE destination (a room, a chat message link, a forum, or an external
 * page), sets an opt-in reminder lead, and can cancel or delete (both act on
 * the whole series). The unwindowed fetch of `/servers/:id/events` returns
 * one row per SERIES; rows are created + listed WHERE `server_id = :id`.
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
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  EventRecurrence,
  EventRecurrenceFreq,
  ServerEvent,
  ServerEventRsvp,
  ServerViewerState,
} from "@thekeep/shared";
import { MAX_RECURRENCE_COUNT, parseEventRecurrence, parseMessageLink } from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { formatDateTime } from "../../lib/intlFormat.js";
import { EVENT_ICONS, EventIcon } from "../../lib/eventIcons.js";

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
interface PickerForum { id: string; name: string }

/** Which primary destination (at most ONE) the event points at. */
type LocationKind = "none" | "room" | "message" | "forum" | "external";

function locationKindOf(ev: ServerEvent): LocationKind {
  if (ev.linkedRoomId) return "room";
  if (ev.linkedMessageId) return "message";
  if (ev.linkedForumId) return "forum";
  if (ev.externalUrl) return "external";
  return "none";
}

/** i18n key suffix for a stored repeat rule (list chip), or null = one-off. */
function repeatChipKey(ev: ServerEvent): "repeatsDaily" | "repeatsWeekly" | "repeatsBiweekly" | "repeatsMonthly" | null {
  const rule = parseEventRecurrence(ev.recurrenceJson);
  if (!rule) return null;
  return rule.freq === "daily" ? "repeatsDaily"
    : rule.freq === "weekly" ? "repeatsWeekly"
      : rule.freq === "biweekly" ? "repeatsBiweekly"
        : "repeatsMonthly";
}

/** Reminder-lead options offered in the form; MUST match the server's
 *  REMINDER_LEADS_MS allow-list (servers/events.ts). Labels live in the
 *  catalog (resolved at render) so a live language flip re-labels them. */
const REMINDER_OPTIONS: { labelKey: string; ms: number | null }[] = [
  { labelKey: "eventsTab.reminderNone", ms: null },
  { labelKey: "eventsTab.reminder5m", ms: 5 * 60_000 },
  { labelKey: "eventsTab.reminder10m", ms: 10 * 60_000 },
  { labelKey: "eventsTab.reminder15m", ms: 15 * 60_000 },
  { labelKey: "eventsTab.reminder30m", ms: 30 * 60_000 },
  { labelKey: "eventsTab.reminder1h", ms: 60 * 60_000 },
  { labelKey: "eventsTab.reminder2h", ms: 2 * 60 * 60_000 },
  { labelKey: "eventsTab.reminder1d", ms: 24 * 60 * 60_000 },
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

/** Hostname of an external link for the list detail line (raw value when the
 *  stored URL somehow fails to parse). */
function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export default function EventsTab({ serverId, viewer }: EventsTabProps) {
  const { t } = useTranslation("servers");
  const canManage = viewer.permissions.includes("manage_events");
  return (
    <div className="max-w-3xl space-y-6">
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-keep-muted">
          {t("eventsTab.heading")}
        </h2>
        <p className="mb-3 text-xs text-keep-muted">
          {t("eventsTab.blurb")}
        </p>
        <EventsSection serverId={serverId} canManage={canManage} />
      </section>
    </div>
  );
}

function EventsSection({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const { t } = useTranslation("servers");
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ServerEvent | null>(null);
  const [adding, setAdding] = useState(false);

  // Shared pickers (this server's rooms + forums + the manager's characters),
  // lifted so the table can resolve names and the form skips duplicate fetches.
  const [rooms, setRooms] = useState<PickerRoom[]>([]);
  const [chars, setChars] = useState<PickerChar[]>([]);
  const [forums, setForums] = useState<PickerForum[]>([]);
  // Server vs Forum context filter (derived: forum-linked = Forum event).
  const [contextFilter, setContextFilter] = useState<"all" | "server" | "forum">("all");

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
      if (canManage) {
        try {
          // This server's affiliated forums (the linkable set).
          const f = await fetch(`/servers/${sid(serverId)}/events/forums`, { credentials: "include" });
          if (f.ok) {
            const j = (await f.json()) as { forums?: PickerForum[] };
            if (!cancelled && Array.isArray(j.forums)) setForums(j.forums);
          }
        } catch { /* leave empty */ }
      }
    })();
    return () => { cancelled = true; };
  }, [serverId, canManage]);

  const roomNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rooms) m.set(r.id, r.name);
    return m;
  }, [rooms]);
  const forumNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of forums) m.set(f.id, f.name);
    return m;
  }, [forums]);

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/servers/${sid(serverId)}/events`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { events: EventRow[] };
      setRows(j.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("shared.loadFailed"));
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [serverId]);

  async function cancelEvent(row: EventRow) {
    if (!window.confirm(t("eventsTab.cancelConfirm"))) return;
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
      setError(e instanceof Error ? e.message : t("eventsTab.cancelFailed"));
    }
  }

  async function remove(row: EventRow) {
    if (!window.confirm(t("eventsTab.deleteConfirm"))) return;
    try {
      const r = await fetch(`/servers/${sid(serverId)}/events/${sid(row.event.id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("announceTab.deleteFailed"));
    }
  }

  if (rows === null) return <p className="text-xs italic text-keep-muted">{t("shared.loading")}</p>;
  // Context filter applied once here so the empty state below can tell "no
  // events at all" apart from "none match the selected filter chip".
  const visible = rows.filter((row) => {
    const ctx = row.event.linkedForumId ? "forum" : "server";
    return contextFilter === "all" || ctx === contextFilter;
  });
  return (
    <div className="space-y-3">
      {error ? <p className="text-xs text-keep-accent">{error}</p> : null}
      {canManage ? (
        <button
          type="button"
          onClick={() => { setAdding(true); setEditing(null); }}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/25"
        >
          {t("eventsTab.newEvent")}
        </button>
      ) : null}
      {(adding || editing) && canManage ? (
        <EventForm
          serverId={serverId}
          rooms={rooms}
          chars={chars}
          forums={forums}
          {...(editing ? { initial: editing } : {})}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSaved={async () => { setAdding(false); setEditing(null); await load(); }}
        />
      ) : null}
      {rows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {([
            ["all", t("eventsTab.filterAll")],
            ["server", t("eventsTab.filterServer")],
            ["forum", t("eventsTab.filterForum")],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setContextFilter(key)}
              aria-pressed={contextFilter === key}
              className={`rounded border px-2 py-0.5 text-[11px] ${
                contextFilter === key
                  ? "border-keep-action bg-keep-action/15 font-semibold text-keep-action"
                  : "border-keep-rule bg-keep-bg text-keep-muted hover:text-keep-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{t("eventsTab.noEvents")}</p>
      ) : visible.length === 0 ? (
        <p className="text-xs italic text-keep-muted">{t("eventsTab.noEventsFiltered")}</p>
      ) : (
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-b border-keep-rule text-keep-muted">
              <th className="px-2 py-1 text-left">{t("eventsTab.colEvent")}</th>
              <th className="px-2 py-1 text-left">{t("eventsTab.colWhen")}</th>
              <th className="px-2 py-1 text-left">{t("eventsTab.colRsvps")}</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const ev = row.event;
              const repeats = repeatChipKey(ev);
              return (
                <tr key={ev.id} className="border-b border-keep-rule/40 align-top">
                  <td className="max-w-[220px] px-2 py-2">
                    <div className="flex items-center gap-1 font-semibold text-keep-text">
                      <EventIcon name={ev.icon} className="h-3.5 w-3.5 shrink-0 text-keep-muted" />
                      {ev.title}
                      {ev.status === "cancelled" ? (
                        <span className="ml-1 text-[10px] uppercase tracking-widest text-keep-accent">{t("eventsTab.statusCancelled")}</span>
                      ) : ev.status === "live" ? (
                        <span className="ml-1 text-[10px] uppercase tracking-widest text-keep-action">{t("eventsTab.statusLive")}</span>
                      ) : ev.status === "ended" ? (
                        <span className="ml-1 text-[10px] uppercase tracking-widest text-keep-muted">{t("eventsTab.statusEnded")}</span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      <span className="rounded border border-keep-rule px-1 py-px text-[9px] uppercase tracking-widest text-keep-muted">
                        {ev.linkedForumId ? t("eventsTab.forumEvent") : t("eventsTab.serverEvent")}
                      </span>
                      {repeats ? (
                        <span className="rounded border border-keep-rule px-1 py-px text-[9px] uppercase tracking-widest text-keep-muted">
                          {t(`eventsTab.${repeats}`)}
                        </span>
                      ) : null}
                    </div>
                    {ev.linkedRoomId ? (
                      <div className="text-[10px] text-keep-muted">
                        {t("eventsTab.roomLine", { name: roomNameById.get(ev.linkedRoomId) ?? ev.linkedRoomId })}
                      </div>
                    ) : null}
                    {ev.linkedForumId ? (
                      <div className="text-[10px] text-keep-muted">
                        {t("eventsTab.forumLine", { name: forumNameById.get(ev.linkedForumId) ?? ev.linkedForumId })}
                      </div>
                    ) : null}
                    {ev.linkedMessageId ? (
                      <div className="text-[10px] text-keep-muted">{t("eventsTab.messageLine")}</div>
                    ) : null}
                    {ev.externalUrl ? (
                      <div className="text-[10px] text-keep-muted">
                        {t("eventsTab.externalLine", { host: hostOf(ev.externalUrl) })}
                      </div>
                    ) : null}
                    {ev.reminderLeadMs ? (
                      <div className="text-[10px] text-keep-muted">{t("eventsTab.reminderSet")}</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <div>{formatDateTime(ev.startsAt)}</div>
                    {ev.endsAt ? (
                      <div className="text-[10px] text-keep-muted">{t("eventsTab.toDate", { date: formatDateTime(ev.endsAt) })}</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <span className="text-keep-text">{row.counts.going}</span>{t("eventsTab.goingSuffix")}
                    {row.counts.maybe ? <span className="text-keep-muted">{t("eventsTab.maybeSuffix", { n: row.counts.maybe })}</span> : null}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {canManage ? (
                      <>
                        <button
                          type="button"
                          onClick={() => { setEditing(ev); setAdding(false); }}
                          className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                        >
                          {t("shared.edit")}
                        </button>
                        {ev.status !== "cancelled" ? (
                          <button
                            type="button"
                            onClick={() => void cancelEvent(row)}
                            className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                          >
                            {t("shared.cancel")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void remove(row)}
                          className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/20"
                        >
                          {t("shared.delete")}
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
  forums,
  onCancel,
  onSaved,
}: {
  serverId: string;
  initial?: ServerEvent;
  rooms: PickerRoom[];
  chars: PickerChar[];
  forums: PickerForum[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation("servers");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [icon, setIcon] = useState<string | null>(initial?.icon ?? null);
  const iconMenuRef = useRef<HTMLDetailsElement | null>(null);
  const [description, setDescription] = useState(initial?.descriptionHtml ?? "");
  const [startsAt, setStartsAt] = useState(initial ? msToLocalInput(initial.startsAt) : "");
  const [endsAt, setEndsAt] = useState(initial?.endsAt ? msToLocalInput(initial.endsAt) : "");
  const [hostCharacterId, setHostCharacterId] = useState<string | null>(initial?.hostCharacterId ?? null);
  // Primary destination — exactly one of room / message / forum / external
  // (the server enforces the same rule on write).
  const [locationKind, setLocationKind] = useState<LocationKind>(initial ? locationKindOf(initial) : "none");
  const [linkedRoomId, setLinkedRoomId] = useState<string | null>(initial?.linkedRoomId ?? null);
  const [linkedForumId, setLinkedForumId] = useState<string | null>(initial?.linkedForumId ?? null);
  const [messageLink, setMessageLink] = useState(initial?.linkedMessageId ?? "");
  const [externalUrl, setExternalUrl] = useState(initial?.externalUrl ?? "");
  // Repeat rule (presets only). "none" = one-off.
  const initialRule = initial ? parseEventRecurrence(initial.recurrenceJson) : null;
  const [repeatFreq, setRepeatFreq] = useState<EventRecurrenceFreq | "none">(initialRule?.freq ?? "none");
  const [repeatDays, setRepeatDays] = useState<number[]>(initialRule?.byWeekday ?? []);
  const [repeatEndMode, setRepeatEndMode] = useState<"never" | "until" | "count">(
    initialRule?.until != null ? "until" : initialRule?.count != null ? "count" : "never",
  );
  const [repeatUntil, setRepeatUntil] = useState(initialRule?.until != null ? msToLocalInput(initialRule.until) : "");
  const [repeatCount, setRepeatCount] = useState(initialRule?.count != null ? String(initialRule.count) : "8");
  const [reminderLeadMs, setReminderLeadMs] = useState<number | null>(initial?.reminderLeadMs ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live validity hint for the paste-a-message-link field (the server
  // re-validates; this just catches typos before submit).
  const messageLinkValid = !messageLink.trim() || parseMessageLink(messageLink) != null;

  // Full weekday names for the one-letter repeat-day chips' titles/labels —
  // the letters alone leave both S's and both T's indistinguishable to a
  // screen reader. 2026-01-04 is a Sunday, anchoring index 0 = Sunday.
  const weekdayNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { weekday: "long" });
    return Array.from({ length: 7 }, (_, d) => fmt.format(new Date(2026, 0, 4 + d)));
  }, [i18n.language]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const startMs = localInputToMs(startsAt);
      if (!title.trim()) throw new Error(t("eventsTab.titleRequired"));
      if (startMs == null) throw new Error(t("eventsTab.startRequired"));
      const endMs = endsAt ? localInputToMs(endsAt) : null;
      if (endMs != null && endMs <= startMs) throw new Error(t("eventsTab.endAfterStart"));

      if (locationKind === "message" && (!messageLink.trim() || !parseMessageLink(messageLink))) {
        throw new Error(t("eventsTab.messageLinkInvalid"));
      }

      let recurrence: EventRecurrence | null = null;
      if (repeatFreq !== "none") {
        recurrence = { freq: repeatFreq };
        // Only a genuine MULTI-day set (Mon/Wed/Fri) needs the weekday list; a
        // single day is just "weekly on the start's day", which the plain
        // weekly rule already handles by stepping from the start — and that
        // path lands on the right day with no timezone guesswork. For a real
        // multi-day set, stamp the creator's offset AT THE START INSTANT
        // (DST-correct) so the server resolves the weekdays in this local
        // frame instead of UTC. The chips are already local weekdays.
        if (repeatFreq === "weekly" && repeatDays.length > 1) {
          recurrence.byWeekday = [...repeatDays].sort((a, b) => a - b);
          recurrence.tzOffsetMinutes = new Date(startMs).getTimezoneOffset();
        }
        if (repeatEndMode === "until") {
          const untilMs = localInputToMs(repeatUntil);
          if (untilMs == null || untilMs <= startMs) throw new Error(t("eventsTab.repeatUntilInvalid"));
          recurrence.until = untilMs;
        } else if (repeatEndMode === "count") {
          const n = Number(repeatCount);
          if (!Number.isInteger(n) || n < 1 || n > MAX_RECURRENCE_COUNT) {
            throw new Error(t("eventsTab.repeatCountInvalid", { max: MAX_RECURRENCE_COUNT }));
          }
          recurrence.count = n;
        }
      }

      const payload = {
        title: title.trim(),
        icon,
        descriptionHtml: description.trim() ? description : null,
        startsAt: startMs,
        endsAt: endMs,
        hostCharacterId,
        // Always ship all four link keys with at most one set, so an edit
        // that changes the destination kind clears the previous one.
        linkedRoomId: locationKind === "room" ? linkedRoomId : null,
        linkedForumId: locationKind === "forum" ? linkedForumId : null,
        linkedMessageId: locationKind === "message" ? messageLink.trim() : null,
        externalUrl: locationKind === "external" && externalUrl.trim() ? externalUrl.trim() : null,
        recurrence,
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
      setError(e2 instanceof Error ? e2.message : t("shared.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-rule bg-keep-panel/30 p-3 text-xs">
      <details ref={iconMenuRef} className="block">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1">
          <span className="uppercase tracking-widest text-keep-muted">{t("eventsTab.iconLabel")}</span>
          {icon ? (
            <span className="flex items-center gap-1 text-keep-text">
              <EventIcon name={icon} className="h-4 w-4" />
              {icon}
            </span>
          ) : (
            <span className="text-keep-muted">{t("eventsTab.iconNone")}</span>
          )}
          <span className="ml-auto text-keep-muted">▾</span>
        </summary>
        <div className="mt-1 flex max-h-52 flex-wrap gap-1 overflow-y-auto rounded border border-keep-rule bg-keep-bg p-2">
          <button
            type="button"
            onClick={() => { setIcon(null); if (iconMenuRef.current) iconMenuRef.current.open = false; }}
            title={t("eventsTab.noIcon")}
            aria-label={t("eventsTab.noIcon")}
            aria-pressed={icon == null}
            className={`flex h-8 w-8 items-center justify-center rounded border text-[9px] uppercase ${icon == null ? "border-keep-action bg-keep-action/15 text-keep-action" : "border-keep-rule text-keep-muted hover:bg-keep-banner"}`}
          >
            {t("eventsTab.iconNone")}
          </button>
          {Object.entries(EVENT_ICONS).map(([name, Ico]) => {
            const on = icon === name;
            return (
              <button
                key={name}
                type="button"
                onClick={() => { setIcon(name); if (iconMenuRef.current) iconMenuRef.current.open = false; }}
                title={name}
                aria-label={name}
                aria-pressed={on}
                className={`flex h-8 w-8 items-center justify-center rounded border ${on ? "border-keep-action bg-keep-action/15 text-keep-action" : "border-keep-rule text-keep-text hover:bg-keep-banner"}`}
              >
                <Ico className="h-4 w-4" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </details>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.titleLabel")}</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={140}
          placeholder={t("eventsTab.titlePlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
      </label>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.descriptionLabel")}</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={8000}
          placeholder={t("eventsTab.descriptionPlaceholder")}
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px]"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <label className="block flex-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.startsLabel")}</span>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
        <label className="block flex-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.endsLabel")}</span>
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
      </div>
      <p className="text-[10px] text-keep-muted">{t("eventsTab.localClockHint")}</p>

      <div className="flex flex-wrap gap-2">
        <label className="block flex-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.hostLabel")}</span>
          <select
            value={hostCharacterId ?? ""}
            onChange={(e) => setHostCharacterId(e.target.value || null)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="">{t("eventsTab.hostServer")}</option>
            {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="block flex-1">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.whereLabel")}</span>
          <select
            value={locationKind}
            onChange={(e) => setLocationKind(e.target.value as LocationKind)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="none">{t("eventsTab.whereNone")}</option>
            <option value="room">{t("eventsTab.whereRoom")}</option>
            <option value="message">{t("eventsTab.whereMessage")}</option>
            <option value="forum">{t("eventsTab.whereForum")}</option>
            <option value="external">{t("eventsTab.whereExternal")}</option>
          </select>
        </label>
      </div>

      {locationKind === "room" ? (
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.linkedRoomLabel")}</span>
          <select
            value={linkedRoomId ?? ""}
            onChange={(e) => setLinkedRoomId(e.target.value || null)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="">{t("eventsTab.iconNone")}</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      ) : locationKind === "message" ? (
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.messageLinkLabel")}</span>
          <input
            type="text"
            value={messageLink}
            onChange={(e) => setMessageLink(e.target.value)}
            placeholder={t("eventsTab.messageLinkPlaceholder")}
            className={`w-full rounded border bg-keep-bg px-2 py-1 ${messageLinkValid ? "border-keep-rule" : "border-keep-accent"}`}
          />
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            {messageLinkValid ? t("eventsTab.messageLinkHint") : t("eventsTab.messageLinkInvalid")}
          </span>
        </label>
      ) : locationKind === "forum" ? (
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.linkedForumLabel")}</span>
          <select
            value={linkedForumId ?? ""}
            onChange={(e) => setLinkedForumId(e.target.value || null)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          >
            <option value="">{t("eventsTab.iconNone")}</option>
            {forums.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {forums.length === 0 ? (
            <span className="mt-0.5 block text-[10px] text-keep-muted">{t("eventsTab.noForums")}</span>
          ) : (
            <span className="mt-0.5 block text-[10px] text-keep-muted">{t("eventsTab.forumEventHint")}</span>
          )}
        </label>
      ) : locationKind === "external" ? (
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.externalLabel")}</span>
          <input
            type="url"
            value={externalUrl}
            onChange={(e) => setExternalUrl(e.target.value)}
            maxLength={500}
            placeholder="https://"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
      ) : null}

      <fieldset className="rounded border border-keep-rule/60 p-2">
        <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("eventsTab.repeatLabel")}</legend>
        <div className="flex flex-wrap gap-2">
          <label className="block flex-1">
            <select
              value={repeatFreq}
              onChange={(e) => setRepeatFreq(e.target.value as EventRecurrenceFreq | "none")}
              aria-label={t("eventsTab.repeatLabel")}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
            >
              <option value="none">{t("eventsTab.repeatNone")}</option>
              <option value="daily">{t("eventsTab.repeatDaily")}</option>
              <option value="weekly">{t("eventsTab.repeatWeekly")}</option>
              <option value="biweekly">{t("eventsTab.repeatBiweekly")}</option>
              <option value="monthly">{t("eventsTab.repeatMonthly")}</option>
            </select>
          </label>
          {repeatFreq !== "none" ? (
            <label className="block flex-1">
              <select
                value={repeatEndMode}
                onChange={(e) => setRepeatEndMode(e.target.value as "never" | "until" | "count")}
                aria-label={t("eventsTab.repeatEndsLabel")}
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
              >
                <option value="never">{t("eventsTab.repeatEndsNever")}</option>
                <option value="until">{t("eventsTab.repeatEndsOn")}</option>
                <option value="count">{t("eventsTab.repeatEndsAfter")}</option>
              </select>
            </label>
          ) : null}
        </div>
        {repeatFreq !== "none" ? (
          <p className="mt-2 rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1.5 text-[10px] text-keep-muted">
            {t("eventsTab.recurrenceStartHint")}
          </p>
        ) : null}
        {repeatFreq === "weekly" ? (
          <div className="mt-2">
            <span className="mb-1 block text-[10px] uppercase tracking-widest text-keep-muted">{t("eventsTab.repeatOnDays")}</span>
            <div className="flex flex-wrap gap-1">
              {[
                t("eventsPanel.weekdaySun"), t("eventsPanel.weekdayMon"), t("eventsPanel.weekdayTue"),
                t("eventsPanel.weekdayWed"), t("eventsPanel.weekdayThu"), t("eventsPanel.weekdayFri"),
                t("eventsPanel.weekdaySat"),
              ].map((label, day) => {
                const on = repeatDays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setRepeatDays((cur) => on ? cur.filter((d) => d !== day) : [...cur, day])}
                    aria-pressed={on}
                    title={`${t("eventsTab.repeatDayToggle")} ${weekdayNames[day]}`}
                    aria-label={`${t("eventsTab.repeatDayToggle")} ${weekdayNames[day]}`}
                    className={`flex h-7 w-7 items-center justify-center rounded border text-[11px] ${
                      on
                        ? "border-keep-action bg-keep-action/15 font-semibold text-keep-action"
                        : "border-keep-rule bg-keep-bg text-keep-muted hover:text-keep-text"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <span className="mt-0.5 block text-[10px] text-keep-muted">{t("eventsTab.repeatDaysHint")}</span>
          </div>
        ) : null}
        {repeatFreq !== "none" && repeatEndMode === "until" ? (
          <label className="mt-2 block">
            <span className="mb-1 block text-[10px] uppercase tracking-widest text-keep-muted">{t("eventsTab.repeatUntilLabel")}</span>
            <input
              type="datetime-local"
              value={repeatUntil}
              onChange={(e) => setRepeatUntil(e.target.value)}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
            />
          </label>
        ) : null}
        {repeatFreq !== "none" && repeatEndMode === "count" ? (
          <label className="mt-2 block">
            <span className="mb-1 block text-[10px] uppercase tracking-widest text-keep-muted">{t("eventsTab.repeatCountLabel")}</span>
            <input
              type="number"
              min={1}
              max={MAX_RECURRENCE_COUNT}
              value={repeatCount}
              onChange={(e) => setRepeatCount(e.target.value)}
              className="w-28 rounded border border-keep-rule bg-keep-bg px-2 py-1"
            />
          </label>
        ) : null}
        {repeatFreq !== "none" ? (
          <p className="mt-2 text-[10px] text-keep-muted">
            {t("eventsTab.recurrenceDstHint")}
            {" "}
            {t("eventsTab.seriesHint")}
          </p>
        ) : null}
      </fieldset>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("eventsTab.reminderLabel")}</span>
        <select
          value={reminderLeadMs == null ? "" : String(reminderLeadMs)}
          onChange={(e) => setReminderLeadMs(e.target.value ? Number(e.target.value) : null)}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        >
          {REMINDER_OPTIONS.map((o) => (
            <option key={o.labelKey} value={o.ms == null ? "" : String(o.ms)}>{t(o.labelKey)}</option>
          ))}
        </select>
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          {t("eventsTab.reminderHint")}
        </span>
      </label>

      {error ? <p className="text-keep-accent">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner">
          {t("shared.cancel")}
        </button>
        <button type="submit" disabled={submitting}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50">
          {submitting ? t("shared.saving") : initial ? t("announceTab.saveChanges") : t("eventsTab.createEvent")}
        </button>
      </div>
    </form>
  );
}
