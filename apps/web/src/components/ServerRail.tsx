/**
 * Server Rail (Multi-Server Lift, Phase 6).
 *
 * A thin (w-14) vertical column of round server icons, the outermost
 * navigation rail of the chat shell — owned/joined servers up top, a hairline
 * divider, then discoverable servers, and a bottom-pinned "+" that opens the
 * discover / apply-to-create affordance. It is the server-level analog of the
 * Forums rail's owned/joined/discover split (ForumRailList).
 *
 * This component ONLY renders when the servers feature flag is on — App gates
 * it on `branding.serversEnabled`, so with the flag off the chat shell is
 * byte-identical to today and this code is never mounted. Clicking an icon is
 * delegated upward (`onSelect`) so App can resolve the server's landing room
 * and reuse the existing socket room-join path; the rail itself owns only
 * presentation + the active/unseen states.
 *
 * Icon-only buttons each carry a `title` + `aria-label` (the rail is all
 * glyphs, no text labels).
 */
import { useMemo, useRef } from "react";
import { Compass, Plus, Settings as SettingsIcon } from "lucide-react";
import type { ServerSummary } from "../lib/servers.js";

/** A server is "owned/joined" (top group) when the viewer holds any role OR
 *  it's the implicit-membership system server; everything else is discover. */
function isMine(s: ServerSummary): boolean {
  return s.viewerRole != null || s.isSystem;
}

/** Whether the viewer holds a managing chair on this server, so the settings
 *  gear should be offered. Owner/admin/mod manage; a plain member doesn't. The
 *  console itself re-checks every action against the granular permission set. */
function canManage(s: ServerSummary): boolean {
  return s.viewerRole === "owner" || s.viewerRole === "admin" || s.viewerRole === "mod";
}

export function ServerRail({
  servers,
  currentServerId,
  canApply,
  onSelect,
  onDiscover,
  onOpenSettings,
}: {
  servers: ServerSummary[] | null;
  /** The server the viewer's CURRENT room belongs to — drives the active pill. */
  currentServerId: string | null;
  /** Global `apply_create_server`: shows the bottom "+" apply affordance. */
  canApply: boolean;
  /** Resolve this server's landing room and join it (existing room-join path). */
  onSelect: (server: ServerSummary) => void;
  /** Open the discover / apply-to-create surface (bottom "+"). */
  onDiscover: () => void;
  /** Open the per-server owner console for a server the viewer manages. The
   *  gear affordance (hover + long-press) on owned/managed icons calls this;
   *  omit to hide the affordance entirely. */
  onOpenSettings?: (server: ServerSummary) => void;
}) {
  const { mine, discover } = useMemo(() => {
    const list = servers ?? [];
    return {
      mine: list.filter(isMine),
      discover: list.filter((s) => !isMine(s)),
    };
  }, [servers]);

  return (
    <nav
      aria-label="Servers"
      className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-keep-rule bg-keep-panel/40 py-2"
    >
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">
        {servers == null ? (
          // Loading: a couple of dim placeholders so the column doesn't jump.
          <>
            <div className="h-10 w-10 animate-pulse rounded-2xl bg-keep-rule/30" aria-hidden="true" />
            <div className="h-10 w-10 animate-pulse rounded-2xl bg-keep-rule/20" aria-hidden="true" />
          </>
        ) : (
          <>
            {mine.map((s) => (
              <ServerIcon
                key={s.id}
                server={s}
                active={currentServerId === s.id}
                onClick={() => onSelect(s)}
                onOpenSettings={onOpenSettings && canManage(s) ? () => onOpenSettings(s) : undefined}
              />
            ))}
            {mine.length > 0 && discover.length > 0 ? (
              <hr className="my-0.5 w-7 border-keep-rule" aria-hidden="true" />
            ) : null}
            {discover.map((s) => (
              <ServerIcon
                key={s.id}
                server={s}
                active={currentServerId === s.id}
                onClick={() => onSelect(s)}
                onOpenSettings={onOpenSettings && canManage(s) ? () => onOpenSettings(s) : undefined}
              />
            ))}
          </>
        )}
      </div>

      {/* Bottom-pinned discover / apply-to-create. The "+" always opens the
          discover surface; that surface offers the create application only to
          members who hold the global apply_create_server permission, so the
          title copy adapts to what the viewer will actually get. */}
      <div className="flex shrink-0 flex-col items-center">
        <hr className="mb-2 w-7 border-keep-rule" aria-hidden="true" />
        <button
          type="button"
          onClick={onDiscover}
          title={canApply ? "Discover servers, or apply to create your own" : "Discover servers"}
          aria-label={canApply ? "Discover servers, or apply to create your own" : "Discover servers"}
          className="flex h-10 w-10 items-center justify-center rounded-2xl border border-keep-action/50 bg-keep-action/10 text-keep-action transition-all hover:rounded-xl hover:bg-keep-action/20"
        >
          {canApply ? <Plus className="h-5 w-5" aria-hidden="true" /> : <Compass className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>
    </nav>
  );
}

/**
 * One round server tile. Renders the server's logo when set, otherwise a
 * lettered fallback tinted with `iconColor`. The Discord-style active pill is
 * a left-edge bar that grows on hover; an unseen dot rides the top-right.
 */
function ServerIcon({
  server,
  active,
  onClick,
  onOpenSettings,
}: {
  server: ServerSummary;
  active: boolean;
  onClick: () => void;
  /** Present only on servers the viewer manages: opens the owner console. */
  onOpenSettings?: (() => void) | undefined;
}) {
  // First letter (grapheme-naive but fine for the fallback glyph).
  const letter = (server.name.trim()[0] ?? "?").toUpperCase();
  const tint = server.iconColor ?? undefined;
  const label = server.isSystem
    ? `${server.name} (home server)`
    : server.viewerRole != null
      ? server.name
      : `${server.name} — visit`;

  // Long-press (touch) opens settings without a visible gear, mirroring the
  // hover gear on pointer devices. A timer started on press fires the console;
  // a release/move before it elapses falls through to the normal tap = select.
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const clearLongPress = () => { if (longPress.current) { clearTimeout(longPress.current); longPress.current = null; } };

  return (
    <div
      className="group relative flex w-full items-center justify-center"
      onContextMenu={onOpenSettings ? (e) => { e.preventDefault(); onOpenSettings(); } : undefined}
      onTouchStart={onOpenSettings ? () => {
        fired.current = false;
        clearLongPress();
        longPress.current = setTimeout(() => { fired.current = true; onOpenSettings(); }, 500);
      } : undefined}
      onTouchEnd={onOpenSettings ? () => clearLongPress() : undefined}
      onTouchMove={onOpenSettings ? () => clearLongPress() : undefined}
    >
      {/* Active / hover pill on the left rail edge. */}
      <span
        aria-hidden="true"
        className={`absolute left-0 w-1 rounded-r-full bg-keep-action transition-all ${
          active ? "h-6 opacity-100" : "h-2 opacity-0 group-hover:opacity-60"
        }`}
      />
      <button
        type="button"
        // Skip the select when a long-press already opened settings, so a
        // touch that triggered the console doesn't also navigate on release.
        onClick={() => { if (fired.current) { fired.current = false; return; } onClick(); }}
        title={label}
        aria-label={label}
        aria-current={active ? "true" : undefined}
        className={`relative flex h-10 w-10 items-center justify-center overflow-hidden border text-sm font-semibold uppercase transition-all ${
          active
            ? "rounded-xl border-keep-action/70 ring-2 ring-keep-action/40"
            : "rounded-2xl border-transparent hover:rounded-xl hover:border-keep-rule"
        }`}
        style={tint && !server.logoUrl ? { backgroundColor: tint, color: "#fff" } : undefined}
      >
        {server.logoUrl ? (
          <img
            src={server.logoUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span className={tint ? "" : "text-keep-text"}>{letter}</span>
        )}
        {server.hasUnseen && !active ? (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-keep-accent ring-2 ring-keep-panel"
          />
        ) : null}
      </button>
      {/* Settings gear: a hover/focus affordance on servers the viewer manages.
          Sits over the tile's bottom-right; keyboard-reachable (it's a real
          button) so the console isn't gated behind hover/long-press alone. */}
      {onOpenSettings ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
          title={`${server.name} — settings`}
          aria-label={`${server.name} — settings`}
          className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-keep-rule bg-keep-panel text-keep-muted opacity-0 transition-opacity hover:text-keep-text focus:opacity-100 group-hover:opacity-100"
        >
          <SettingsIcon className="h-2.5 w-2.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
