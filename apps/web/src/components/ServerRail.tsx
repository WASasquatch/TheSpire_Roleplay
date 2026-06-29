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
import { useMemo } from "react";
import { Compass, Plus } from "lucide-react";
import type { ServerSummary } from "../lib/servers.js";

/** A server is "owned/joined" (top group) when the viewer holds any role OR
 *  it's the implicit-membership system server; everything else is discover. */
function isMine(s: ServerSummary): boolean {
  return s.viewerRole != null || s.isSystem;
}

export function ServerRail({
  servers,
  currentServerId,
  canApply,
  onSelect,
  onDiscover,
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
}: {
  server: ServerSummary;
  active: boolean;
  onClick: () => void;
}) {
  // First letter (grapheme-naive but fine for the fallback glyph).
  const letter = (server.name.trim()[0] ?? "?").toUpperCase();
  const tint = server.iconColor ?? undefined;
  const label = server.isSystem
    ? `${server.name} (home server)`
    : server.viewerRole != null
      ? server.name
      : `${server.name} — visit`;

  return (
    <div className="relative flex w-full items-center justify-center">
      {/* Active / hover pill on the left rail edge. */}
      <span
        aria-hidden="true"
        className={`absolute left-0 w-1 rounded-r-full bg-keep-action transition-all ${
          active ? "h-6 opacity-100" : "h-2 opacity-0 group-hover:opacity-60"
        }`}
      />
      <button
        type="button"
        onClick={onClick}
        title={label}
        aria-label={label}
        aria-current={active ? "true" : undefined}
        className={`group relative flex h-10 w-10 items-center justify-center overflow-hidden border text-sm font-semibold uppercase transition-all ${
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
    </div>
  );
}
