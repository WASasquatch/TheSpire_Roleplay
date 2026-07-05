/**
 * Notification Center — a top-bar bell with an unread badge that opens a
 * right-side slide-over listing the unified inbox (server approvals, @mentions,
 * DMs, friend requests, earning milestones, announcements, report outcomes).
 *
 * Counts + live rows come from the store (fed by the notifications:badge /
 * notifications:new socket events, seeded by a boot fetch in App). Opening the
 * panel pulls a fresh page; clicking a row deep-links via the `onOpen` callback
 * (App maps each target to its existing navigation) and marks it read. The
 * separate, still-live forum inbox folds in as a single count + a link row, so
 * the bell is one number without a risky data migration.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AtSign,
  Award,
  Bell,
  Flag,
  Landmark,
  Megaphone,
  MessageSquare,
  Server as ServerIcon,
  Settings as SettingsIcon,
  UserPlus,
  X,
} from "lucide-react";
import type { NotificationCategory, NotificationWire } from "@thekeep/shared";
import { NOTIFICATION_CATEGORIES } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import {
  fetchNotifPrefs,
  fetchNotifications,
  markNotificationsRead,
  markNotificationsSeen,
  saveNotifPrefs,
} from "../lib/notificationCenter.js";
import { disablePush, enablePush, readPushState, type PushState } from "../lib/push.js";
import { useReducedMotion } from "../lib/reducedMotion.js";

/** Track the `lg` (1024px) breakpoint so the panel can be a dropdown on
 *  desktop and a fullscreen modal on phones. */
function useIsLgUp(): boolean {
  const [lg, setLg] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 1024px)").matches
      : true);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setLg(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return lg;
}

/** Categories shown in the mute preferences (skip the internal "system" kind). */
const MUTABLE_CATEGORIES: { key: NotificationCategory; label: string }[] = [
  { key: "mention", label: "Mentions" },
  { key: "dm", label: "Direct messages" },
  { key: "friend", label: "Friend requests" },
  { key: "server", label: "Server events" },
  { key: "forum", label: "Forum activity" },
  { key: "earning", label: "Earning milestones" },
  { key: "announcement", label: "Announcements" },
  { key: "report", label: "Report outcomes" },
];

/** Coarse filter chips. "All" plus the categories worth isolating. */
const FILTERS: { key: NotificationCategory | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mention", label: "Mentions" },
  { key: "server", label: "Servers" },
  { key: "dm", label: "DMs" },
];

function categoryIcon(n: NotificationWire) {
  const cls = "h-4 w-4 shrink-0";
  switch (n.category) {
    case "mention": return <AtSign className={cls} aria-hidden />;
    case "dm": return <MessageSquare className={cls} aria-hidden />;
    case "friend": return <UserPlus className={cls} aria-hidden />;
    case "server": return <ServerIcon className={cls} aria-hidden />;
    case "forum": return <Landmark className={cls} aria-hidden />;
    case "earning": return <Award className={cls} aria-hidden />;
    case "announcement": return <Megaphone className={cls} aria-hidden />;
    case "report": return <Flag className={cls} aria-hidden />;
    default: return <Bell className={cls} aria-hidden />;
  }
}

/** Compact "3m" / "5h" / "2d" relative time. */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

function Avatar({ url, name }: { url: string | null; name: string | null }) {
  const label = (name ?? "?").slice(0, 2).toUpperCase();
  return url ? (
    <img src={url} alt="" className="h-8 w-8 shrink-0 rounded-full border border-keep-rule object-cover" referrerPolicy="no-referrer" />
  ) : (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-keep-rule bg-keep-banner text-[10px] uppercase text-keep-muted">{label}</span>
  );
}

export function NotificationCenter({
  onOpen,
  onOpenForums,
}: {
  /** Deep-link a clicked notification (App maps target → its navigation). */
  onOpen: (n: NotificationWire) => void;
  /** Open the (separate) forum inbox; shown only when there's forum activity. */
  onOpenForums?: () => void;
}) {
  const notifUnread = useChat((s) => s.notifUnread);
  const forumUnread = useChat((s) => s.forumNotifUnread);
  const items = useChat((s) => s.notifItems);
  const setNotifItems = useChat((s) => s.setNotifItems);
  const setNotifBadge = useChat((s) => s.setNotifBadge);
  const markLocal = useChat((s) => s.markNotifReadLocal);

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NotificationCategory | "all">("all");
  const [loading, setLoading] = useState(false);
  // Preferences sub-view (gear): category mutes + browser-push opt-in.
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [pushState, setPushState] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  // Anchoring: on desktop the panel is a dropdown pinned under the bell; we
  // measure the bell's rect and place a body-portaled `fixed` popover at it
  // (a portal sidesteps the banner's stacking context / transforms that would
  // otherwise clip or re-anchor an in-tree dropdown). On phones it's a
  // fullscreen modal, so no anchor is needed.
  const bellRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const isLgUp = useIsLgUp();
  const reduceMotion = useReducedMotion();
  const close = () => setOpen(false);

  const total = notifUnread + forumUnread;

  // Measure the bell to place the desktop dropdown; re-measure on resize.
  useLayoutEffect(() => {
    if (!open || !isLgUp) { setAnchor(null); return; }
    const update = () => {
      const r = bellRef.current?.getBoundingClientRect();
      if (r) setAnchor({ top: Math.round(r.bottom + 8), right: Math.round(Math.max(8, window.innerWidth - r.right)) });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open, isLgUp]);

  // Escape closes (document-level so the panel needn't hold focus).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // On open: pull a fresh first page and acknowledge the badge as seen.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    fetchNotifications({ limit: 30, category: filter === "all" ? null : filter })
      .then((page) => { if (alive) { setNotifItems(page.notifications); setNotifBadge(page.unread); } })
      .catch(() => { /* keep whatever's in the store */ })
      .finally(() => { if (alive) setLoading(false); });
    void markNotificationsSeen();
    return () => { alive = false; };
  }, [open, filter, setNotifItems, setNotifBadge]);

  function clickRow(n: NotificationWire) {
    if (!n.readAt) {
      markLocal([n.id]);
      void markNotificationsRead([n.id]).then((b) => setNotifBadge(b.unread, b.unreadByServer)).catch(() => {});
    }
    setOpen(false);
    // Deep-link via App's `onOpen` (→ openNotifTarget). Community-event reminders
    // are handled there too: openNotifTarget's "event" case switches to the
    // owning server first, THEN dispatches OPEN_SERVER_EVENT so ServerEventsPanel
    // opens on the event once the correct server's list is loading. Dispatching
    // here as well would fire before the server switch (wrong server) and double
    // up, so we route everything through the single App path.
    onOpen(n);
  }

  function markAllRead() {
    markLocal("all");
    void markNotificationsRead("all").then((b) => setNotifBadge(b.unread, b.unreadByServer)).catch(() => {});
  }

  // Load mute prefs + current browser-push state when the prefs view opens.
  useEffect(() => {
    if (!prefsOpen) return;
    let alive = true;
    fetchNotifPrefs()
      .then((p) => { if (alive) setMuted(new Set(p.mutedCategories)); })
      .catch(() => { /* default: nothing muted */ });
    void readPushState().then((s) => { if (alive) setPushState(s); }).catch(() => {});
    return () => { alive = false; };
  }, [prefsOpen]);

  /** Flip a category's muted state and persist. `on` = notifications enabled. */
  function setCategoryEnabled(category: NotificationCategory, on: boolean) {
    setMuted((prev) => {
      const next = new Set(prev);
      if (on) next.delete(category); else next.add(category);
      const list = [...next].filter((c) => (NOTIFICATION_CATEGORIES as readonly string[]).includes(c));
      void saveNotifPrefs(list).catch(() => {});
      return next;
    });
  }

  /** Toggle the browser-push subscription (offline notifications). */
  function togglePush() {
    if (pushBusy) return;
    setPushBusy(true);
    const action = pushState === "subscribed" ? disablePush() : enablePush();
    void action.then((s) => setPushState(s)).catch(() => {}).finally(() => setPushBusy(false));
  }

  const shown = filter === "all" ? items : items.filter((n) => n.category === filter);

  return (
    <>
      <button
        ref={bellRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label={total > 0 ? `Notifications (${total} unread)` : "Notifications"}
        aria-expanded={open}
        className="relative flex h-8 w-8 items-center justify-center rounded border border-keep-rule bg-keep-panel text-keep-muted hover:text-keep-text"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {total > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-keep-accent px-1 text-[10px] font-bold leading-none text-keep-bg">
            {total > 99 ? "99+" : total}
          </span>
        ) : null}
      </button>

      {open ? createPortal(
        <>
          {/* Backdrop: dims + closes on phones; an invisible click-catcher that
              still closes on desktop (where the panel is a small dropdown). */}
          <div className="fixed inset-0 z-[59] bg-black/50 lg:bg-transparent" onClick={close} aria-hidden="true" />
          {/* Phones: fullscreen modal (inset-0). Desktop: a dropdown pinned
              under the bell via the measured `top/right`, capped height, its own
              rounded/bordered card. Reduce Motion swaps the pop for a calm fade. */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            style={isLgUp && anchor ? { top: anchor.top, right: anchor.right } : undefined}
            className={`fixed inset-0 z-[60] flex flex-col overflow-hidden bg-keep-bg text-keep-text shadow-2xl lg:inset-auto lg:h-auto lg:max-h-[min(70vh,40rem)] lg:w-[22rem] lg:rounded-lg lg:border lg:border-keep-rule${reduceMotion ? " tk-fade-in" : ""}`}
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-keep-rule px-3 py-2.5">
              <Bell className="h-4 w-4 text-keep-action" aria-hidden="true" />
              <span className="flex-1 text-sm font-semibold text-keep-text">{prefsOpen ? "Notification settings" : "Notifications"}</span>
              {!prefsOpen ? (
                <button type="button" onClick={markAllRead} disabled={total === 0}
                  className="rounded border border-keep-rule px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text disabled:opacity-40">
                  Mark all read
                </button>
              ) : null}
              <button type="button" onClick={() => setPrefsOpen((p) => !p)}
                title={prefsOpen ? "Back to notifications" : "Notification settings"}
                aria-label={prefsOpen ? "Back to notifications" : "Notification settings"}
                className={`rounded border p-1 ${prefsOpen ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"}`}>
                <SettingsIcon className="h-4 w-4" aria-hidden="true" />
              </button>
              <button type="button" onClick={() => setOpen(false)} title="Close" aria-label="Close"
                className="rounded border border-keep-rule p-1 text-keep-muted hover:text-keep-text">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </header>

            {prefsOpen ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <p className="mb-2 text-xs text-keep-muted">Choose what lands in your bell. A muted type makes no alert at all: no row, badge, or push.</p>
                <ul className="space-y-1">
                  {MUTABLE_CATEGORIES.map((c) => {
                    const on = !muted.has(c.key);
                    return (
                      <li key={c.key}>
                        <label className="flex cursor-pointer items-center justify-between gap-2 rounded border border-keep-rule/60 px-2.5 py-2 text-sm">
                          <span className="text-keep-text">{c.label}</span>
                          <input type="checkbox" checked={on} onChange={(e) => setCategoryEnabled(c.key, e.target.checked)} />
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-4 rounded border border-keep-rule/60 p-2.5">
                  <p className="text-sm text-keep-text">Browser notifications</p>
                  <p className="mt-0.5 text-[11px] text-keep-muted">
                    {pushState === "subscribed" ? "On: you'll be pinged even when the app is closed."
                      : pushState === "denied" ? "Blocked in your browser settings. Allow notifications for this site to enable."
                      : pushState === "unsupported" ? "Your browser doesn't support push notifications."
                      : "Off: turn on to be pinged when the app is closed."}
                  </p>
                  {pushState !== "unsupported" && pushState !== "denied" ? (
                    <button type="button" onClick={togglePush} disabled={pushBusy}
                      className="mt-2 rounded border border-keep-action bg-keep-action px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
                      {pushBusy ? "…" : pushState === "subscribed" ? "Turn off" : "Turn on"}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
            <>
            <div className="flex shrink-0 flex-wrap gap-1 border-b border-keep-rule px-3 py-1.5">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                  className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${filter === f.key ? "border-keep-action text-keep-action" : "border-keep-rule text-keep-muted hover:text-keep-text"}`}>
                  {f.label}
                </button>
              ))}
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {forumUnread > 0 && onOpenForums ? (
                <button type="button" onClick={() => { setOpen(false); onOpenForums(); }}
                  className="flex w-full items-center gap-2 border-b border-keep-rule bg-keep-panel/30 px-3 py-2 text-left hover:bg-keep-banner">
                  <Landmark className="h-4 w-4 shrink-0 text-keep-action" aria-hidden="true" />
                  <span className="flex-1 text-sm text-keep-text">Forum activity</span>
                  <span className="rounded-full bg-keep-accent px-1.5 text-[10px] font-bold text-keep-bg">{forumUnread}</span>
                </button>
              ) : null}

              {loading && shown.length === 0 ? (
                <div className="flex min-h-[10rem] flex-1 items-center justify-center px-6 py-10">
                  <p className="text-center text-sm italic text-keep-muted">Loading…</p>
                </div>
              ) : shown.length === 0 ? (
                <div className="flex min-h-[10rem] flex-1 items-center justify-center px-6 py-10">
                  <p className="text-center text-sm italic text-keep-muted">You have no notifications yet</p>
                </div>
              ) : (
                <ul>
                  {shown.map((n) => (
                    <li key={n.id}>
                      <button type="button" onClick={() => clickRow(n)}
                        className={`flex w-full items-start gap-2.5 border-b border-keep-rule/60 px-3 py-2.5 text-left hover:bg-keep-banner ${n.readAt ? "opacity-70" : "bg-keep-panel/20"}`}>
                        {n.actorUserId ? <Avatar url={n.actorAvatarUrl} name={n.actorName} /> : (
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-keep-rule bg-keep-banner text-keep-muted">{categoryIcon(n)}</span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className={`min-w-0 flex-1 truncate text-sm ${n.readAt ? "text-keep-text" : "font-semibold text-keep-text"}`}>{n.title}</span>
                            {!n.readAt ? <span className="h-2 w-2 shrink-0 rounded-full bg-keep-accent" aria-hidden="true" /> : null}
                            <span className="shrink-0 text-[10px] text-keep-muted">{ago(n.createdAt)}</span>
                          </span>
                          {n.snippet ? <span className="mt-0.5 block truncate text-xs text-keep-muted">{n.snippet}</span> : null}
                          {n.serverName ? <span className="mt-0.5 inline-block rounded border border-keep-rule px-1 text-[9px] uppercase tracking-widest text-keep-muted">{n.serverName}</span> : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            </>
            )}
          </div>
        </>,
        document.body,
      ) : null}
    </>
  );
}
