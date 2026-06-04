import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ANNOUNCEMENT_BANNER_BODY_MAX,
  COLOR_TOKEN_OR_HEX_RE,
  describeSchedule,
  markdownToHtml,
  parseScheduleSpec,
  resolveMessageColor,
  SCHEDULED_ANNOUNCEMENT_BODY_MAX,
  THEMEABLE_TEXT_SLOTS,
  type AnnouncementBanner,
  type ScheduledAnnouncement,
  type ThemeableTextSlot,
} from "@thekeep/shared";
import { readError } from "../lib/http.js";
import { useActiveTheme } from "../lib/theme.js";
import { sanitizeUserHtml } from "../lib/userHtml.js";
import { useChat } from "../state/store.js";

/**
 * Admin tab for the two announcement surfaces.
 *
 * `view_admin_announcements` gates the tab itself. Each section
 * gates its own write operations independently:
 *   - `manage_banner_announcements` for the rotating banner CRUD
 *   - `manage_scheduled_announcements` for the cron-like CRUD
 *
 * Body editors accept either raw HTML or basic Markdown
 * (`**bold**`, `*italic*`, `[text](url)`, `- item`); the editor
 * runs the markdown converter on input and shows the resulting
 * HTML in a side-by-side preview. The server re-sanitizes on save
 * with the same allow-list profile bios use, so an unsupported
 * tag is filtered out before storage.
 */
export function AdminAnnouncementsTab() {
  const permissions = useChat((s) => s.me?.permissions ?? []);
  const canManageBanners = permissions.includes("manage_banner_announcements");
  const canManageScheduled = permissions.includes("manage_scheduled_announcements");

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-keep-muted">
          Banner marquee
        </h2>
        <p className="mb-3 text-xs text-keep-muted">
          Rows shown here render in a rotating banner above the chat. The marquee fades
          between entries every ~8 seconds when there are two or more enabled.
          Viewers can dismiss the bar for themselves; the dismissal persists in
          their browser until they clear site data.
        </p>
        <BannerSection canManage={canManageBanners} />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-keep-muted">
          Scheduled <code>/announce</code> cronjobs
        </h2>
        <p className="mb-3 text-xs text-keep-muted">
          Rows here fire as a sitewide or per-room <code>/announce</code> at the
          configured time. One-shot rows auto-disable after firing; recurring
          rows re-arm to <em>now + interval</em> on each fire (a server restart
          mid-cycle won't double-fire to catch up).
        </p>
        <ScheduledSection canManage={canManageScheduled} />
      </section>
    </div>
  );
}

/* ============================================================
 *  Banner CRUD
 * ============================================================ */

function BannerSection({ canManage }: { canManage: boolean }) {
  const [banners, setBanners] = useState<AnnouncementBanner[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AnnouncementBanner | null>(null);
  const [adding, setAdding] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/announcements/banners", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { banners: AnnouncementBanner[] };
      setBanners(j.banners);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => { void load(); }, []);

  async function toggleEnabled(b: AnnouncementBanner) {
    try {
      const r = await fetch(`/admin/announcements/banners/${b.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !b.enabled }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "toggle failed");
    }
  }

  async function remove(b: AnnouncementBanner) {
    if (!window.confirm("Delete this banner? Viewers will lose it on next refresh.")) return;
    try {
      const r = await fetch(`/admin/announcements/banners/${b.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  if (banners === null) return <p className="text-xs italic text-keep-muted">Loading…</p>;
  return (
    <div className="space-y-3">
      {error ? <p className="text-xs text-keep-accent">{error}</p> : null}
      {canManage ? (
        <button
          type="button"
          onClick={() => { setAdding(true); setEditing(null); }}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/25"
        >
          + New banner
        </button>
      ) : null}
      {(adding || editing) && canManage ? (
        <BannerForm
          {...(editing ? { initial: editing } : {})}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSaved={async () => { setAdding(false); setEditing(null); await load(); }}
        />
      ) : null}
      {banners.length === 0 ? (
        <p className="text-xs italic text-keep-muted">No banners yet.</p>
      ) : (
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-b border-keep-rule text-keep-muted">
              <th className="px-2 py-1 text-left">Preview</th>
              <th className="px-2 py-1">Order</th>
              <th className="px-2 py-1">Enabled</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {banners.map((b) => (
              <tr key={b.id} className="border-b border-keep-rule/40 align-top">
                <td className="px-2 py-2">
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(b.bodyHtml) }}
                  />
                </td>
                <td className="px-2 py-2 text-center tabular-nums">{b.sortOrder}</td>
                <td className="px-2 py-2 text-center">
                  {canManage ? (
                    <input
                      type="checkbox"
                      checked={b.enabled}
                      onChange={() => void toggleEnabled(b)}
                    />
                  ) : (
                    <span>{b.enabled ? "yes" : "no"}</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right">
                  {canManage ? (
                    <>
                      <button
                        type="button"
                        onClick={() => { setEditing(b); setAdding(false); }}
                        className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(b)}
                        className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/20"
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BannerForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: AnnouncementBanner;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  // Round-trip note: existing rows store sanitized HTML, so the
  // editor seeds the textarea with that HTML directly. Admins who
  // originally typed markdown will see the converted HTML on edit
  // — acceptable trade for keeping the storage shape one thing.
  const [body, setBody] = useState(initial?.bodyHtml ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [sortOrder, setSortOrder] = useState(initial?.sortOrder ?? 0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live HTML preview — runs the markdown converter so an admin
  // typing `**bold**` sees the rendered output. Raw HTML in the
  // input passes through unchanged.
  const previewHtml = useMemo(() => sanitizeUserHtml(markdownToHtml(body)), [body]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        bodyHtml: markdownToHtml(body),
        enabled,
        sortOrder,
      };
      const url = initial
        ? `/admin/announcements/banners/${initial.id}`
        : "/admin/announcements/banners";
      const method = initial ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
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
    <form
      onSubmit={submit}
      className="space-y-2 rounded border border-keep-rule bg-keep-panel/30 p-3 text-xs"
    >
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">
          Body (HTML or Markdown)
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={ANNOUNCEMENT_BANNER_BODY_MAX}
          placeholder="**Welcome** to the chat! Read the [house rules](/rules) before posting."
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px]"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          {body.length} / {ANNOUNCEMENT_BANNER_BODY_MAX}. Both formats supported;
          Markdown converts to HTML on save.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enabled</span>
        </label>
        <label className="flex items-center gap-1">
          <span>Order</span>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
            className="w-16 rounded border border-keep-rule bg-keep-bg px-1 py-0.5 text-right tabular-nums"
          />
        </label>
      </div>

      {body.trim() ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-2">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">
            Preview
          </div>
          <div
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      ) : null}

      {error ? <p className="text-keep-accent">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Create banner"}
        </button>
      </div>
    </form>
  );
}

/* ============================================================
 *  Scheduled CRUD
 * ============================================================ */

function ScheduledSection({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<ScheduledAnnouncement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScheduledAnnouncement | null>(null);
  const [adding, setAdding] = useState(false);
  // Active theme bg so list-row + form previews use the same color
  // resolver the chat renderer uses — theme tokens turn into CSS
  // vars, and hex literals get nudged for legibility against the
  // viewer's current palette. Without this the previews only
  // painted literal `#rrggbb` colors and silently fell through for
  // `theme:<slot>` selections, which gave admins a false-negative
  // ("did the color save?") on what's actually a fully-working
  // theme token.
  const themeBg = useActiveTheme().bg;
  // Shared room list. Lifted from ScheduledForm to the section so
  // the table rows can resolve `targetRoomId` to a friendly name
  // instead of showing the raw nanoid. ScheduledForm receives the
  // list as a prop and skips its own fetch.
  const [rooms, setRooms] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/admin/announcements/rooms", { credentials: "include" });
        if (!r.ok) return;
        const j = (await r.json()) as { rooms?: Array<{ id: string; name: string }> };
        if (!cancelled && Array.isArray(j.rooms)) setRooms(j.rooms);
      } catch { /* leave empty */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const roomNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rooms) m.set(r.id, r.name);
    return m;
  }, [rooms]);

  async function load() {
    setError(null);
    try {
      const r = await fetch("/admin/announcements/scheduled", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { scheduled: ScheduledAnnouncement[] };
      setRows(j.scheduled);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => { void load(); }, []);

  async function toggleEnabled(row: ScheduledAnnouncement) {
    try {
      const r = await fetch(`/admin/announcements/scheduled/${row.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !row.enabled }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "toggle failed");
    }
  }

  async function remove(row: ScheduledAnnouncement) {
    if (!window.confirm("Delete this scheduled announcement?")) return;
    try {
      const r = await fetch(`/admin/announcements/scheduled/${row.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  // Manual fire — broadcasts immediately without touching the
  // schedule's bookkeeping (last_run_at / next_run_at). Lets the
  // admin verify content + target before the natural tick fires.
  async function fireNow(row: ScheduledAnnouncement) {
    if (!window.confirm(
      row.targetRoomId
        ? "Fire this announcement now in the target room? (Does not change the schedule.)"
        : "Fire this announcement now in EVERY room? (Does not change the schedule.)",
    )) return;
    try {
      const r = await fetch(`/admin/announcements/scheduled/${row.id}/fire`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
    } catch (e) {
      setError(e instanceof Error ? e.message : "fire failed");
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
          + New scheduled announcement
        </button>
      ) : null}
      {(adding || editing) && canManage ? (
        <ScheduledForm
          rooms={rooms}
          {...(editing ? { initial: editing } : {})}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSaved={async () => { setAdding(false); setEditing(null); await load(); }}
        />
      ) : null}
      {rows.length === 0 ? (
        <p className="text-xs italic text-keep-muted">No scheduled announcements yet.</p>
      ) : (
        <table className="w-full min-w-[680px] text-xs">
          <thead>
            <tr className="border-b border-keep-rule text-keep-muted">
              <th className="px-2 py-1 text-left">Body</th>
              <th className="px-2 py-1 text-left">Schedule</th>
              <th className="px-2 py-1 text-left">Target</th>
              <th className="px-2 py-1">Enabled</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-keep-rule/40 align-top">
                <td className="max-w-[240px] px-2 py-2">
                  <div
                    className="prose prose-sm max-w-none [&_p]:m-0"
                    style={(() => {
                      // Same resolver chat uses — theme tokens become
                      // CSS vars, hex literals get nudged for
                      // legibility. Without this the row faked a
                      // "no color" preview for `theme:<slot>` rows.
                      const resolved = resolveMessageColor(r.color, themeBg);
                      return resolved ? { color: resolved } : {};
                    })()}
                    dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(r.bodyHtml) }}
                  />
                </td>
                <td className="px-2 py-2">
                  <div>{r.scheduleSpec}</div>
                  <div className="text-[10px] text-keep-muted">{describeSchedule(r)}</div>
                </td>
                <td className="px-2 py-2">
                  {r.targetRoomId
                    ? (roomNameById.get(r.targetRoomId) ?? <code className="text-keep-muted">{r.targetRoomId}</code>)
                    : <em className="text-keep-muted">sitewide</em>}
                </td>
                <td className="px-2 py-2 text-center">
                  {canManage ? (
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={() => void toggleEnabled(r)}
                    />
                  ) : (
                    <span>{r.enabled ? "yes" : "no"}</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right">
                  {canManage ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void fireNow(r)}
                        className="mr-1 rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-keep-action hover:bg-keep-action/20"
                        title="Broadcast this announcement now. The schedule stays unchanged."
                      >
                        Fire now
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditing(r); setAdding(false); }}
                        className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(r)}
                        className="rounded border border-keep-accent/60 bg-keep-accent/10 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/20"
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ScheduledForm({
  initial,
  rooms,
  onCancel,
  onSaved,
}: {
  initial?: ScheduledAnnouncement;
  /** Lifted from `ScheduledSection` so the form + table use one
   *  fetch — and the table can resolve `targetRoomId` to a room
   *  name without duplicate requests. */
  rooms: Array<{ id: string; name: string }>;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [body, setBody] = useState(initial?.bodyMarkdown ?? "");
  const [scheduleSpec, setScheduleSpec] = useState(initial?.scheduleSpec ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [targetRoomId, setTargetRoomId] = useState<string | null>(initial?.targetRoomId ?? null);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resolved color the chat renderer would actually paint — feeds
  // the preview block below so admins see the EXACT swatch their
  // viewers will get. Pure: `theme:<slot>` → `rgb(var(--keep-X))`,
  // `#rrggbb` → contrast-nudged hex, null → undefined (no override).
  const themeBg = useActiveTheme().bg;
  const previewColor = resolveMessageColor(color, themeBg);

  const parsed = useMemo(
    () => (scheduleSpec.trim() ? parseScheduleSpec(scheduleSpec) : null),
    [scheduleSpec],
  );
  const previewHtml = useMemo(() => sanitizeUserHtml(markdownToHtml(body)), [body]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (!parsed || !parsed.ok) {
        throw new Error(parsed && !parsed.ok ? parsed.message : "Schedule is required.");
      }
      if (color !== null && !COLOR_TOKEN_OR_HEX_RE.test(color)) {
        throw new Error("Color must be `#rrggbb` or a `theme:<slot>` token.");
      }
      const payload = {
        scheduleSpec,
        bodyMarkdown: body,
        bodyHtml: markdownToHtml(body),
        color,
        targetRoomId,
        enabled,
      };
      const url = initial
        ? `/admin/announcements/scheduled/${initial.id}`
        : "/admin/announcements/scheduled";
      const method = initial ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
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
    <form
      onSubmit={submit}
      className="space-y-2 rounded border border-keep-rule bg-keep-panel/30 p-3 text-xs"
    >
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">
          Body (HTML or Markdown)
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={SCHEDULED_ANNOUNCEMENT_BODY_MAX}
          placeholder="**Daily reminder:** Check the [event board](/rules#events) for tonight's sessions."
          className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px]"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          {body.length} / {SCHEDULED_ANNOUNCEMENT_BODY_MAX}
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Schedule</span>
        <input
          type="text"
          value={scheduleSpec}
          onChange={(e) => setScheduleSpec(e.target.value)}
          placeholder="1d8h  /  3h  /  30m  /  2026-06-04T18:00"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px]"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          Interval (e.g. <code>1d8h</code>) for recurring, or an ISO datetime for
          a one-shot. Minimum interval is 1 minute; maximum 30 days.
          {parsed && !parsed.ok ? (
            <span className="ml-2 text-keep-accent">{parsed.message}</span>
          ) : null}
          {parsed && parsed.ok ? (
            <span className="ml-2 text-keep-action">
              {parsed.parsed.kind === "interval"
                ? `Recurring every ${formatIntervalMs(parsed.parsed.intervalMs)}.`
                : `Fires once on ${new Date(parsed.parsed.runAt).toLocaleString()}.`}
            </span>
          ) : null}
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Target room</span>
        <select
          value={targetRoomId ?? ""}
          onChange={(e) => setTargetRoomId(e.target.value || null)}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        >
          <option value="">Sitewide (every room)</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </label>

      <fieldset className="space-y-1">
        <legend className="mb-1 block uppercase tracking-widest text-keep-muted">
          Color (optional)
        </legend>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setColor(null)}
            className={`rounded border px-2 py-0.5 text-[11px] ${
              color === null
                ? "border-keep-action bg-keep-action/15"
                : "border-keep-rule bg-keep-bg hover:bg-keep-banner"
            }`}
          >
            none
          </button>
          {THEMEABLE_TEXT_SLOTS.map((slot: ThemeableTextSlot) => {
            const token = `theme:${slot}`;
            const active = color === token;
            return (
              <button
                key={slot}
                type="button"
                onClick={() => setColor(token)}
                className={`rounded border px-2 py-0.5 text-[11px] capitalize ${
                  active
                    ? "border-keep-action bg-keep-action/15"
                    : "border-keep-rule bg-keep-bg hover:bg-keep-banner"
                }`}
                style={{ color: `rgb(var(--keep-${slot}))` }}
              >
                {slot}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={color && color.startsWith("#") ? color : "#990000"}
            onChange={(e) => setColor(e.target.value)}
            className="h-7 w-10 cursor-pointer rounded border border-keep-rule"
            aria-label="Custom hex color"
          />
          <input
            type="text"
            value={color && color.startsWith("#") ? color : ""}
            onChange={(e) => setColor(e.target.value || null)}
            placeholder={color && color.startsWith("theme:") ? `(using ${color})` : "(no override)"}
            maxLength={7}
            pattern="^#[0-9a-fA-F]{6}$"
            className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono"
          />
        </div>
      </fieldset>

      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Enabled</span>
      </label>

      {body.trim() ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-2">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-keep-muted">
            <span>Preview (as it will render in chat)</span>
            {previewColor ? (
              // Tiny swatch so the admin can confirm the resolved
              // color matches their pick even when the text body
              // is short or the contrast nudge has shifted the
              // rendered hex away from what the picker shows.
              <span className="flex items-center gap-1 normal-case tracking-normal">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 rounded border border-keep-rule"
                  style={{ backgroundColor: previewColor }}
                />
                <span className="text-keep-muted">
                  {color?.startsWith("theme:") ? color : previewColor}
                </span>
              </span>
            ) : null}
          </div>
          {/* `font-bold` mirrors the announce-kind chat render so
              weight + color render together exactly as a viewer
              will see it post-broadcast. Without the weight match
              an admin could think "the bold isn't applying" when
              the chat render does in fact apply it. */}
          <div
            className="prose prose-sm max-w-none font-bold [&_p]:m-0"
            style={previewColor ? { color: previewColor } : {}}
          >
            <span aria-hidden>📣 </span>
            <span dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        </div>
      ) : null}

      {error ? <p className="text-keep-accent">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Schedule announcement"}
        </button>
      </div>
    </form>
  );
}

function formatIntervalMs(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.join("") || "0m";
}
