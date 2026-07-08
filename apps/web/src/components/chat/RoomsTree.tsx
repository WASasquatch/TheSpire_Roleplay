import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type SVGProps,
} from "react";
import { legibleAgainstBg, roleRank, type PermissionKey, type RoomOccupant, type RoomSummary, type ServerModPermission, type Theme } from "@thekeep/shared";
import { Ban, Bell, BellOff, Clapperboard, Landmark, MessagesSquare, Plus, ScrollText, ShieldAlert, UserX, VolumeX } from "lucide-react";
import { useChat } from "../../state/store.js";
import { useActiveTheme } from "../../lib/theme.js";
import { AdminIcon, CharacterMaskIcon, MasterAdminIcon, ModIcon } from "../moderation/StaffIcons.js";
import { CreateRoomModal } from "../CreateRoomModal.js";
import { ToolPanel } from "../ToolPanel.js";
import { UserNameTag } from "../UserNameTag.js";
import { identityArgFor } from "../../lib/commandText.js";
import { createPersistedDimension } from "../../lib/persistedDimension.js";
import { SearchBar } from "./SearchBar.js";

export interface RoomWithOccupants extends RoomSummary {
  occupants: RoomOccupant[];
}

/** Bounds for the desktop userlist rail width, in pixels. */
const MIN_RAIL_WIDTH = 200; // narrow enough that staff icons + a short name still fit
const MAX_RAIL_WIDTH = 480; // wide enough for long room/character names without eating most of the chat
const DEFAULT_RAIL_WIDTH = 256; // matches the previous Tailwind `md:w-64` baseline
const RAIL_WIDTH_STORAGE_KEY = "tk_userlist_width";

/**
 * Hydrate/persist the rail width from localStorage with a sanity-checked
 * fallback. Reading inside the `useState` initializer (not a `useEffect`)
 * means the first render already uses the saved width — no visible "snap
 * from default to saved" flash on mount. An out-of-range saved value is
 * rejected back to the default (not clamped).
 */
const railWidthDim = createPersistedDimension({
  key: RAIL_WIDTH_STORAGE_KEY,
  min: MIN_RAIL_WIDTH,
  max: MAX_RAIL_WIDTH,
  default: DEFAULT_RAIL_WIDTH,
  outOfRange: "reject",
});

interface Props {
  rooms: RoomWithOccupants[];
  currentRoomId: string | null;
  /**
   * Viewer's own userId. Threaded through to the per-room flicker
   * guard so it can tell a legitimately-empty list (the viewer was
   * the only person here and just left, switched away, or went
   * incognito) apart from a transient server-side race in
   * `currentOccupants`. Without this signal the guard treated every
   * fresh empty as a race and kept the viewer's stale row in the
   * rail for the full 1200ms guard window, which manifested as
   * "I'm still in my own userlist after /incognito" until the cache
   * timed out. Null while the user isn't signed in.
   */
  selfUserId: string | null;
  /** When set, the Tools panel's identity dropdown adopts an in-character label + "Leave Character" row. */
  activeCharacterId?: string | null;
  /** Display name of the active character, used by the identity button label. */
  activeCharacterName?: string | null;
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onRoomClick: (roomId: string) => void;
  onCommand: (text: string) => void;
  /** Open the world viewer modal for a given world id (clicking a primary-world section header). */
  onWorldClick: (worldId: string) => void;
  /** Jump to a specific message in a room. Wired by the in-rail search bar. */
  onJumpToMessage: (roomId: string, messageId: string) => void;
  /** Open the unified Messages modal (DMs + friends + friend requests). */
  onOpenMessages: () => void;
  /** Open the Earning dashboard. Threaded straight through to ToolPanel
   *  so the rail's Tools drawer can surface a one-click entry. */
  onOpenEarning?: () => void;
  /** Open the Spire Arcade launcher. Threaded through to ToolPanel too. */
  onOpenArcade?: () => void;
  /** Open the Forums Catalog modal (the pinned header row below the
   *  Rooms title). Boards — rooms with a forumId — are filtered out of
   *  the room list and live in the catalog instead. */
  onOpenForums?: () => void;
  /** Mobile-menu close affordance. The drawer's open/slide is owned by the
   *  wrapper in App (the full-screen Menu overlay); this just lets the in-rail
   *  ✕ button dismiss it. */
  onClose?: () => void;
  /**
   * Same 0–3 reading-size step the Tools menu cycles for the chat
   * surface. Applied to the rail's root container as a font-size in
   * em so descendants, userlist names, icon glyphs sized with `em`,
   * room headers, scale together with the chat lines. Default 1
   * (medium) when omitted keeps the rail at its historic size.
   */
  fontStep?: 0 | 1 | 2 | 3;
}

/**
 * Same step → em map the chat surface uses (see MessageList.FONT_EM).
 * Hoisted here so the rail can read it without importing MessageList.
 * Keep the two arrays in sync; the Tools-menu cycle button labels
 * (0–3) assume identical scaling on both surfaces.
 */
const RAIL_FONT_EM = ["1.15em", "1.3em", "1.5em", "1.75em"] as const;

/**
 * Shared "action pill" look for the rail's two header affordances — the
 * Forums Catalog "Open" chip and the Rooms header "New" button — so they
 * read as one family instead of two unrelated controls. Shape + typography
 * + accent live here; each call site layers on what's specific to it (the
 * interactive "New" adds a fill + hover + the Plus icon; the "Open" chip is
 * a non-interactive label riding the already-filled Forums button).
 */
const ACTION_PILL =
  "rounded-full border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-keep-action";

/** Unread forum-notification pill on the Forums Catalog button. Reads
 *  the store directly so the rail updates on every socket pulse without
 *  threading a prop through App. */
function ForumNotifBadge() {
  const unread = useChat((s) => s.forumNotifUnread);
  if (unread <= 0) return null;
  return (
    <span
      title={`${unread} unread forum notification${unread === 1 ? "" : "s"}`}
      className="rounded-full bg-keep-accent px-1.5 py-0.5 text-[10px] font-bold leading-none text-keep-bg"
    >
      {unread > 99 ? "99+" : unread}
    </span>
  );
}

/**
 * Per-room unread / mention cue on a room row (Batch 2 per-channel-reads).
 * Reads the store maps directly (same pattern as {@link ForumNotifBadge}) so a
 * `room:unread` socket delta repaints just this glyph without touching the room
 * tree or forcing a `/rooms` refetch. Two distinct cues:
 *
 *   - Mention pill (accent) — a count of unread messages that @mention the
 *     viewer. Shown even when the room is MUTED: a direct mention is never
 *     silenced, only the ambient dot is.
 *   - Unread dot (action) — ambient "there are new messages here". SUPPRESSED
 *     when the room is muted.
 *
 * Renders nothing when there's neither an unread nor a mention. Mirrors the
 * ForumNotifBadge pill styling so the two read as one family.
 */
function RoomUnreadCue({ roomId }: { roomId: string }) {
  const unread = useChat((s) => s.roomUnread[roomId] ?? 0);
  const hasMention = useChat((s) => !!s.roomHasMention[roomId]);
  const muted = useChat((s) => !!s.roomMuted[roomId]);
  // Mentions always pill; the ambient dot is hidden under a mute.
  const showDot = unread > 0 && !muted;
  if (!showDot && !hasMention) return null;
  return (
    <span className="ml-1.5 inline-flex shrink-0 items-center gap-1 align-middle">
      {hasMention ? (
        <span
          title={`You were mentioned (${unread} unread)`}
          className="rounded-full bg-keep-accent px-1.5 py-0.5 text-[10px] font-bold leading-none text-keep-bg"
        >
          @{unread > 99 ? "99+" : unread}
        </span>
      ) : showDot ? (
        <span
          title={`${unread} unread message${unread === 1 ? "" : "s"}`}
          aria-label={`${unread} unread`}
          className="h-2.5 w-2.5 rounded-full bg-keep-action"
          style={{ boxShadow: "0 0 0 1.5px rgba(0,0,0,.3)" }}
        />
      ) : null}
    </span>
  );
}

/**
 * Per-room mute toggle rendered at the right edge of a room row (Batch 2
 * per-channel-reads). Reads the muted flag from the store and flips it via
 * `PUT /me/rooms/:id/mute` — optimistically, restoring on failure. The server
 * re-emits `room:unread` so sibling tabs repaint too. A muted room hides its
 * ambient unread dot but still pills direct mentions (see {@link RoomUnreadCue}).
 * Kept as a SIBLING of the room-switch button (not nested — invalid HTML), so
 * toggling mute never also switches into the room.
 */
function RoomMuteToggle({ roomId }: { roomId: string }) {
  const muted = useChat((s) => !!s.roomMuted[roomId]);
  const setRoomMuted = useChat((s) => s.setRoomMuted);
  function toggle() {
    const next = !muted;
    // Optimistic flip; the mute PUT response + the server's room:unread
    // re-emit will confirm (and any sibling tab picks it up via the socket).
    setRoomMuted(roomId, next);
    void fetch(`/me/rooms/${encodeURIComponent(roomId)}/mute`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ muted: next }),
    })
      .then((r) => {
        if (!r.ok) setRoomMuted(roomId, muted); // roll back on rejection
      })
      .catch(() => setRoomMuted(roomId, muted));
  }
  return (
    <button
      type="button"
      onClick={toggle}
      className={`pointer-events-none flex h-6 w-6 shrink-0 items-center justify-center rounded text-keep-muted opacity-0 transition-opacity hover:bg-keep-banner/60 hover:text-keep-text focus:pointer-events-auto focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 ${
        muted ? "pointer-events-auto opacity-100 text-keep-accent" : ""
      }`}
      title={muted ? "Muted — tap to unmute (mentions still notify)" : "Mute this room"}
      aria-label={muted ? "Unmute room" : "Mute room"}
      aria-pressed={muted}
    >
      {muted ? <BellOff className="h-3.5 w-3.5" aria-hidden /> : <Bell className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}

/**
 * The viewer's moderation reach over the CURRENT room, resolved once at the
 * rail level and threaded down to each occupant row. Each flag is "may the
 * viewer issue this action against a member of this room" — the union of three
 * grants, matching the server's `callerCanModerateRoom` / `callerOwnsRoom`
 * precedence (mod.ts): a site-wide permission, being the room owner/mod, or
 * holding the equivalent per-server permission on THIS room's server.
 *
 * The buttons only GATE the affordance; the server re-checks authority on
 * every `/kick` / `/ban` / `/mute`, so an over-generous flag can never grant
 * real power — a stale/racey flag just shows a button the command will reject.
 */
interface RoomModCaps {
  /** Boot a member from the room (site `kick_user`, room owner/mod, or server `kick_member`). */
  kick: boolean;
  /** Time-silence a member in the room (site `mute_user`, room owner/mod, or server `mute_member`). */
  mute: boolean;
  /** Bar a member from the room (site `ban_user`, room OWNER, or server `ban_member`). Room MODS
   *  can't ban — mirrors mod.ts `/ban` gating on `callerOwnsRoom`, not `callerCanModerateRoom`. */
  ban: boolean;
}

const NO_MOD_CAPS: RoomModCaps = { kick: false, mute: false, ban: false };

/**
 * Resolve {@link RoomModCaps} for the current room. Reads the viewer's SITE
 * permissions off the store (`me.permissions`) and their per-identity room
 * `role` off their own occupant row (owner/mod), then unions in the viewer's
 * per-SERVER permissions for this room's server — fetched from
 * `GET /servers/:id` (the same viewer-permission slice ServerSettingsView
 * reads), so a community server's mod/admin gets the userlist actions their
 * `/kick` / `/ban` already accept server-side, without waiting to be a room
 * owner or `/promote`d here. The fetch only runs when servers are enabled AND
 * the room is on a real sub-server (`currentServerId` set); on the home server
 * or flag-off it stays on the site + room-role grants alone.
 */
function useRoomModCaps(
  currentRoomId: string | null,
  selfUserId: string | null,
  selfOccupantRole: "owner" | "mod" | "member" | null,
): RoomModCaps {
  const perms = useChat((s) => s.me?.permissions ?? null);
  const serversEnabled = useChat((s) => !!s.branding.serversEnabled);
  const currentServerId = useChat((s) => s.currentServerId);

  // Per-server permission set for THIS room's server. Only meaningful on a real
  // sub-server; null everywhere else (home server, flag-off, not signed in).
  const [serverPerms, setServerPerms] = useState<ServerModPermission[] | null>(null);
  useEffect(() => {
    if (!serversEnabled || !currentServerId || !selfUserId) {
      setServerPerms(null);
      return;
    }
    let cancelled = false;
    fetch(`/servers/${encodeURIComponent(currentServerId)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { viewer?: { permissions?: string[] } } | null) => {
        if (cancelled) return;
        const list = j?.viewer?.permissions;
        setServerPerms(Array.isArray(list) ? (list as ServerModPermission[]) : []);
      })
      .catch(() => { if (!cancelled) setServerPerms([]); });
    return () => { cancelled = true; };
    // Re-resolve when the viewer moves to a different server, changes identity,
    // or the flag flips. currentRoomId isn't a dependency: server perms are
    // server-scoped, so moving between rooms of the same server keeps them.
  }, [serversEnabled, currentServerId, selfUserId]);

  const hasSite = (k: PermissionKey) => !!perms?.includes(k);
  const hasServer = (k: ServerModPermission) => !!serverPerms?.includes(k);
  const isRoomMod = selfOccupantRole === "owner" || selfOccupantRole === "mod";
  const isRoomOwner = selfOccupantRole === "owner";

  if (!selfUserId || !currentRoomId) return NO_MOD_CAPS;
  return {
    kick: hasSite("kick_user") || isRoomMod || hasServer("kick_member"),
    mute: hasSite("mute_user") || isRoomMod || hasServer("mute_member"),
    // Ban is owner-tier locally (a room mod can't ban), matching mod.ts.
    ban: hasSite("ban_user") || isRoomOwner || hasServer("ban_member"),
  };
}

/**
 * Right-rail navigation: each room (public always, plus the private room the
 * caller is currently in) is rendered as a header followed by its occupants
 * indented underneath. Click a room name to switch; click an occupant icon
 * for profile, click their name to whisper.
 */
export function RoomsTree({
  // Defensive default: the rail is a critical always-mounted component behind
  // the app ErrorBoundary, so a transient undefined `rooms` (e.g. an
  // inconsistent Vite HMR bundle over the \\wsl mount) must degrade to an empty
  // rail, never white-screen the whole app.
  rooms = [],
  currentRoomId,
  selfUserId,
  activeCharacterId,
  activeCharacterName,
  onIconClick,
  onNameClick,
  onRoomClick,
  onCommand,
  onWorldClick,
  onJumpToMessage,
  onOpenMessages,
  onOpenEarning,
  onOpenArcade,
  onOpenForums,
  onClose,
  fontStep = 1,
}: Props) {

  // "Create Room" prompt, opened from the Rooms header button. Local to the
  // rail since it only needs `onCommand` (already threaded through) to fire
  // the create command.
  const [showCreateRoom, setShowCreateRoom] = useState(false);

  // Active server id for the in-rail message-search "This server" scope. Read
  // from the store (not a prop) so the SearchBar mount doesn't force a new
  // prop through App; null on the home server / flag-off, which the search
  // route treats as "everything the viewer can see".
  const currentServerId = useChat((s) => s.currentServerId);

  // Boards (rooms inside a forum, forumId set) live in the Forums Catalog,
  // not the room list. Filtering keys on forumId — NOT replyMode — so a
  // standalone nested room someone made via /replymode stays listed. The
  // caller's CURRENT room is always kept even when it's a board, so being
  // inside one never strands you with no rail entry for where you are.
  const visibleRooms = useMemo(
    () => rooms.filter((r) => !r.forumId || r.id === currentRoomId),
    [rooms, currentRoomId],
  );

  // Pin the caller's current room to the top of the rail so it stays
  // visible on installs with many rooms. The server returns rooms in
  // alphabetical order; we partition just enough to lift the active
  // room out and leave the rest in their original order. No-op when
  // the user isn't in any room or the room isn't in this list.
  const orderedRooms = useMemo(() => {
    if (!currentRoomId) return visibleRooms;
    const idx = visibleRooms.findIndex((r) => r.id === currentRoomId);
    if (idx <= 0) return visibleRooms;
    return [visibleRooms[idx]!, ...visibleRooms.slice(0, idx), ...visibleRooms.slice(idx + 1)];
  }, [visibleRooms, currentRoomId]);

  // The viewer's own per-identity room role in the CURRENT room, used to unlock
  // the userlist mod actions for a room owner/mod. Owner shows on the OOC row,
  // mod on the promoted identity (broadcast.ts), and the viewer may be voicing
  // either right now, so we take the STRONGEST role across all of their rows in
  // this room ("owner" wins over "mod" wins over "member").
  const selfOccupantRole = useMemo<"owner" | "mod" | "member" | null>(() => {
    if (!selfUserId || !currentRoomId) return null;
    const here = rooms.find((r) => r.id === currentRoomId);
    if (!here) return null;
    let role: "owner" | "mod" | "member" | null = null;
    for (const o of here.occupants) {
      if (o.userId !== selfUserId) continue;
      if (o.role === "owner") return "owner";
      if (o.role === "mod") role = "mod";
      else if (role === null) role = "member";
    }
    return role;
  }, [rooms, currentRoomId, selfUserId]);

  // Resolve the viewer's moderation reach for the current room ONCE (site
  // permission + room owner/mod + this server's mod grant) and thread it to
  // every occupant row's action menu. Only the current room's rows act on it;
  // other rooms in the rail render read-only (you moderate where you stand).
  const modCaps = useRoomModCaps(currentRoomId, selfUserId, selfOccupantRole);

  // Desktop-only horizontal resize for the rail. The user drags the
  // left edge, pulling LEFT widens the rail (eats into the chat
  // column), pulling RIGHT narrows it. Value persists per-browser
  // via localStorage so the choice rides along with the tab.
  // Mobile keeps the fixed w-72 drawer width since "drag to resize"
  // doesn't translate to a slide-out panel.
  const [railWidth, setRailWidth] = useState<number>(railWidthDim.load);
  useEffect(() => {
    railWidthDim.save(railWidth);
  }, [railWidth]);

  // Drag state lives on a ref (not React state) so each pointermove
  // doesn't trigger a re-render of the closure. We re-render via
  // `setRailWidth` once per frame's worth of movement, React batches
  // the updates so the userlist re-paint stays smooth even on long
  // occupant lists.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  function startResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: railWidth };
  }
  function moveResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    // Drag LEFT (clientX decreases) → rail widens. The math:
    // `startWidth + (startX - currentX)` because pulling left
    // increases startX-currentX, which adds to the width.
    const delta = dragRef.current.startX - e.clientX;
    const next = Math.min(
      MAX_RAIL_WIDTH,
      Math.max(MIN_RAIL_WIDTH, dragRef.current.startWidth + delta),
    );
    setRailWidth(next);
  }
  function endResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    dragRef.current = null;
  }

  return (
    <aside
      // Solid bg-keep-bg on mobile so the chat doesn't bleed through the
      // drawer; on md+ keep the subtle panel tint that visually separates
      // the rail from the chat. Slightly wider on mobile (72) to give
      // thumbs a comfortable target.
      //
      // Desktop width: `md:w-[var(--keep-rail-width)]` reads the
      // CSS variable we set inline below from React state. Using a
      // variable instead of inline `style.width` means the mobile
      // `w-72` class still wins at narrow viewports without us having
      // to JS-gate the inline style.
      //
      // `md:relative` (not the previous `md:static`) so the absolute-
      // positioned resize handle below positions against the aside
      // instead of walking up the layout tree.
      // Drawer open/close + slide is now owned by the wrapper in App (the
      // full-screen Menu overlay that also carries the server rail). Here the
      // rail is just an in-flow flex child: on mobile it FILLS the space left of
      // the server rail (flex-1); on desktop it returns to its fixed, resizable
      // width via the --keep-rail-width CSS variable.
      className={`
        keep-app-sidebar
        flex h-full min-w-0 flex-1 flex-col border-l border-keep-rule bg-keep-bg text-sm
        lg:relative lg:flex-none lg:w-[var(--keep-rail-width)]
        lg:bg-keep-banner/30 lg:shadow-none
      `}
      style={{
        ["--keep-rail-width" as string]: `${railWidth}px`,
        // The Tools-menu font-size cycle drives the chat surface via
        // an em font-size on MessageList. Mirror it here so the rail
        //, userlist rows, room headers, all the descendants that
        // inherit `font-size` and the em-sized icons in
        // [UserNameTag.tsx](./UserNameTag.tsx), scale in lockstep.
        // Items in the rail still using rem-based Tailwind sizes
        // (text-xs etc.) stay fixed, which is the intended floor:
        // labels stay readable even at the smallest step.
        fontSize: RAIL_FONT_EM[fontStep],
      } as CSSProperties}
    >
      {/* Resize handle, desktop-only. Sits flush against the rail's
          left border (covering it visually) so dragging "the border"
          feels natural. `cursor-ew-resize` is the bidirectional
          east-west arrow conventionally used for column resizing.
          The hover/active tints are subtle so the rail doesn't feel
          like a UI element at rest, the cursor change is the
          primary affordance. Pointer-capture (via setPointerCapture
          in `startResize`) keeps the drag tracking even when the
          cursor strays outside the handle's thin hit area. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize userlist"
        title="Drag to resize the userlist"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        className="absolute inset-y-0 left-0 z-30 hidden w-1.5 cursor-ew-resize hover:bg-keep-action/30 active:bg-keep-action/50 lg:block"
      />
      {/* Message search — pinned to the very TOP of the rail, ABOVE the
          Forums Catalog button, in its own border-b container. The shared
          <SearchBar> (Batch 2 search-core) toggles between "This room" and
          "This server" scope; server scope hunts every room the viewer can
          see. Reads currentServerId from the store so a badge/tree change
          never has to thread a new prop. Cross-server hits jump via the hit's
          own roomId. */}
      <div className="border-b border-keep-rule px-2 py-1.5">
        <SearchBar
          roomId={currentRoomId}
          currentServerId={currentServerId}
          defaultScope="room"
          onJump={(messageId, roomId) => {
            // The hit carries its OWN room, so a server-scope hit in a
            // different room lands correctly — onJumpToMessage joins that
            // room if it isn't the current one.
            onJumpToMessage(roomId, messageId);
          }}
        />
      </div>
      {/* Forums Catalog entry — pinned ABOVE the Rooms header (it's a
          peer surface to the room list, not a room within it). Forum
          boards don't live in this rail (see visibleRooms); this is their
          front door, so it's styled as a BUTTON (inset, action-bordered,
          with an explicit "Open" chip) — the earlier full-bleed banner row
          read as a section header, not something clickable. */}
      {onOpenForums ? (
        <div className="border-b border-keep-rule px-2 py-1.5">
          <button
            type="button"
            data-tour="forums-catalog-button"
            onClick={onOpenForums}
            title="Open the Forums Catalog - long-form boards owned by the community"
            className="keep-button flex w-full items-center gap-2 rounded border border-keep-action/60 bg-keep-action/10 px-2.5 py-2 text-left transition-colors hover:border-keep-action hover:bg-keep-action/20 lg:py-1.5"
          >
            <Landmark className="h-4 w-4 shrink-0 text-keep-action" aria-hidden="true" />
            <span className="font-action text-sm text-keep-text">Forums Catalog</span>
            <ForumNotifBadge />
            <span aria-hidden className={`ml-auto ${ACTION_PILL}`}>
              Open
            </span>
          </button>
        </div>
      ) : null}
      {/* Header row - title + room count, with the mobile-only close
          button living inside it (instead of an absolute overlay) so it
          gets real layout space and never covers the room list. */}
      <div className="flex items-center justify-between border-b border-keep-rule bg-keep-banner/40 px-3 py-2 lg:bg-transparent lg:py-1.5">
        <span className="text-xs uppercase tracking-widest text-keep-muted">
          Rooms <span className="text-keep-rule">({visibleRooms.length})</span>
        </span>
        <div className="flex items-center gap-1.5">
          {/* Floating-right create action. Icon-only, so it carries both a
              title (hover) and aria-label (assistive tech) per the icon-
              button convention. Available to everyone — anyone can mint a
              room via /go. */}
          <button
            type="button"
            onClick={() => setShowCreateRoom(true)}
            // Deliberately NOT `.keep-button`: that class is theme-scoped tile
            // styling ([data-theme-style] .keep-button → 2px radius, panel bg,
            // neutral border) whose higher specificity overrode the accent
            // pill, which is exactly why this read as a different control from
            // the Forums "Open" chip. Styled purely by ACTION_PILL so the two
            // stay identical across every theme.
            className={`flex items-center gap-1 ${ACTION_PILL} transition-colors hover:border-keep-action hover:bg-keep-action/20`}
            aria-label="Create a room"
            title="Create a new room"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            <span className="hidden sm:inline">New</span>
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="keep-button flex h-8 w-8 items-center justify-center rounded border border-keep-rule bg-keep-panel text-base text-keep-text hover:bg-keep-banner lg:hidden"
              aria-label="Close rooms"
              title="Close rooms drawer"
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>
      <div data-tour="rooms-tree" className="min-h-0 flex-1 overflow-y-auto">
        {visibleRooms.length === 0 ? (
          <div className="px-3 py-2 text-xs text-keep-muted">(no rooms)</div>
        ) : (
          <ul>
            {orderedRooms.map((r) => (
              <RoomGroup
                key={r.id}
                room={r}
                isCurrent={r.id === currentRoomId}
                selfUserId={selfUserId}
                onIconClick={onIconClick}
                onNameClick={onNameClick}
                onRoomClick={onRoomClick}
                onWorldClick={onWorldClick}
                onCommand={onCommand}
                // Mod actions only bind to the room the viewer is standing in;
                // every other room in the rail renders its userlist read-only.
                modCaps={r.id === currentRoomId ? modCaps : NO_MOD_CAPS}
              />
            ))}
          </ul>
        )}
      </div>
      <ToolPanel
        onCommand={onCommand}
        activeCharacterId={activeCharacterId ?? null}
        activeCharacterName={activeCharacterName ?? null}
        currentRoomId={currentRoomId}
        onJumpToMessage={onJumpToMessage}
        onOpenMessages={onOpenMessages}
        {...(onOpenEarning ? { onOpenEarning } : {})}
        {...(onOpenArcade ? { onOpenArcade } : {})}
      />
      {showCreateRoom ? (
        <CreateRoomModal onCommand={onCommand} onClose={() => setShowCreateRoom(false)} />
      ) : null}
    </aside>
  );
}

function RoomGroup({
  room,
  isCurrent,
  selfUserId,
  onIconClick,
  onNameClick,
  onRoomClick,
  onWorldClick,
  onCommand,
  modCaps,
}: {
  room: RoomWithOccupants;
  isCurrent: boolean;
  selfUserId: string | null;
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onRoomClick: (roomId: string) => void;
  onWorldClick: (worldId: string) => void;
  /** Fire a slash command (used by the per-occupant Kick / Mute / Ban menu). */
  onCommand: (text: string) => void;
  /** The viewer's moderation reach over THIS room (all false for non-current
   *  rooms, so their userlists render read-only). */
  modCaps: RoomModCaps;
}) {
  const isPrivate = room.type === "private";
  /**
   * Flicker guard: bridge transient empty `occupants` arrays so the
   * userlist doesn't vanish for the brief window where a /rooms
   * refetch (triggered by every `presence:update` / `rooms:tree-
   * changed` server event) momentarily sees the room with zero
   * occupants, typically caused by the sending socket's tab being
   * mid-broadcast when `currentOccupants` calls `fetchSockets()`.
   *
   * We cache the most-recent non-empty occupants list and stamp the
   * moment it was last "seen full." If a render brings in an empty
   * list within {@link FLICKER_GUARD_MS}, we keep showing the cached
   * value instead. Past the window we accept the empty state, a
   * room that genuinely emptied (the actual last person left) will
   * still render "empty" after the guard expires.
   *
   * Note: this is a stop-gap. The underlying cause is on the server
   * (`currentOccupants` reading `io.in().fetchSockets()` races with
   * send-time socket joins/leaves under load). Removing this guard
   * once that root cause is fixed is safe.
   */
  const FLICKER_GUARD_MS = 1200;
  const lastNonEmptyRef = useRef<{ list: RoomOccupant[]; at: number }>({ list: [], at: 0 });
  if (room.occupants.length > 0) {
    lastNonEmptyRef.current = { list: room.occupants, at: Date.now() };
  }
  // Skip the cache fallback when the cached list contained only the
  // viewing user. A fresh empty list in that case is legitimate (self
  // left the room, switched away, or, the case this branch was added
  // for, went incognito) and bridging it back to the cached self-row
  // produced the visible bug where the user stayed in their own
  // userlist for the full 1200ms guard window after /incognito until
  // the cache timed out. The server-race the guard was originally
  // built for involves OTHER users transiently dropping out of
  // `currentOccupants`; those still get the cache, so the original
  // anti-flicker behavior is preserved.
  const cachedHasOnlySelf =
    selfUserId != null
    && lastNonEmptyRef.current.list.length > 0
    && lastNonEmptyRef.current.list.every((o) => o.userId === selfUserId);
  const displayedOccupants =
    room.occupants.length === 0
    && lastNonEmptyRef.current.list.length > 0
    && !cachedHasOnlySelf
    && Date.now() - lastNonEmptyRef.current.at < FLICKER_GUARD_MS
      ? lastNonEmptyRef.current.list
      : room.occupants;
  // Per migration 0187 the userlist no longer groups by primary
  // world, primary-world is gone now that memberships are
  // per-identity, and the grouping was the surface that leaked
  // characters back to their master's affiliations. The userlist is
  // a flat alphabetical list sorted by display name.
  const sortedOccupants = [...displayedOccupants].sort((a, b) =>
    a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()),
  );
  // Active theme drives the legibility nudge that keeps the staff
  // icons readable against the rail bg, even on a custom palette
  // where the natural slot color would land too close to the chat
  // background to read. The rail container uses `bg-keep-bg`, so we
  // contrast each icon's slot color against `theme.bg`.
  const theme = useActiveTheme();
  // Site name for the "<site> Owner" role badge (keeps the top site role
  // distinct from a community-server owner). Reactive so a branding rename
  // repaints the crowns.
  const siteName = useChat((s) => s.branding.siteName);

  return (
    <li
      className={`keep-row border-b border-keep-rule/40 ${isCurrent ? "bg-keep-banner/40" : ""}`}
      data-active={isCurrent ? "true" : undefined}
    >
      {/* The room-switch button spans the FULL row width so its hover/active
          "title bar" reaches the container edge. The per-room mute toggle is a
          SIBLING (not nested — button-in-button is invalid HTML) but is OVERLAID
          absolutely on the right rather than taking layout width. `pr-9` on the
          button reserves the strip the bell floats over. The overlay wrapper is
          click-through (pointer-events-none) so tapping anywhere but the bell
          still switches rooms; the toggle itself re-enables pointer events when
          visible. `group` fades the glyph in on row hover (and it stays visible
          when a room is actively muted). */}
      <div className="group relative flex w-full items-stretch">
        <button
          type="button"
          onClick={() => onRoomClick(room.id)}
          title={room.topic ?? ""}
          className={`flex min-w-0 flex-1 items-baseline justify-between py-2.5 pl-3 pr-9 text-left text-[1.1rem] font-bold hover:bg-keep-banner/30 hover:text-keep-accent lg:py-1 ${
            isCurrent ? "text-keep-action" : "text-keep-accent"
          }`}
        >
          <span className="flex min-w-0 items-baseline">
            <span className="truncate">
              {/* Room-mode glyph (lucide, `currentColor` — lighter than the old
                  board.png / scroll.png). A room in Theater Mode shows a
                  clapperboard so the rail flags the watch-party at a glance;
                  otherwise threaded (nested, forum-style) vs flat (chronological,
                  ephemeral). em-sized so it scales with the Tools-menu font step. */}
              {(() => {
                const glyphStyle: CSSProperties = { width: "1.4em", height: "1.4em" };
                if (room.theaterMode) {
                  return (
                    <span
                      title="theater mode: a shared video plays above the chat"
                      className="mr-1 inline-flex shrink-0 align-middle text-keep-accent"
                    >
                      <Clapperboard aria-hidden style={glyphStyle} />
                    </span>
                  );
                }
                const nested = room.replyMode === "nested";
                const Icon = nested ? MessagesSquare : ScrollText;
                const title = nested
                  ? "threaded conversations, replies persist as forum-style threads"
                  : "flat chat, chronological, ephemeral feel";
                return (
                  <span
                    title={title}
                    className="mr-1 inline-flex shrink-0 align-middle text-keep-muted"
                  >
                    <Icon aria-hidden style={glyphStyle} />
                  </span>
                );
              })()}
              {isPrivate ? <span title="private - password required" className="mr-1">🔒</span> : null}
              {room.name}
            </span>
            {/* Unread dot / mention pill (per-channel). Sits right after the
                name, before the occupant count, so it reads as a property of
                the room. Suppressed on the current room's dot by the server
                (entering marks it read). */}
            <RoomUnreadCue roomId={room.id} />
          </span>
          <span className="ml-2 shrink-0 font-normal text-keep-muted">({displayedOccupants.length})</span>
        </button>
        {/* Per-room mute toggle — overlaid at the right edge (not in flow) so
            the room button stays full-width. Click-through wrapper; the toggle
            re-enables pointer events on itself when visible. */}
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-1.5">
          <RoomMuteToggle roomId={room.id} />
        </div>
      </div>
      {displayedOccupants.length === 0 ? (
        <div className="px-5 pb-2 text-[11px] italic text-keep-muted lg:pb-1">empty</div>
      ) : (
        <ul className="pb-1">
          {sortedOccupants.map((o) => {
            // Composite key, a single account voicing two different
            // characters in two tabs renders as two occupant rows
            // (one per identity). Keying on userId alone would
            // dup-React-key in that case.
            const chip = resolveStaffChip(o, theme, siteName);
            return (
                    <li
                      key={`${o.userId}:${o.characterId ?? ""}`}
                      // Idle ghosts (tab closed / refreshed within the
                      // admin-configured grace window) dim to 50% so
                      // they read as "still around but inactive." Live
                      // and live+/away rows stay at full opacity, the
                      // /away message is shown via the existing
                      // UserNameTag tooltip, so we don't compound the
                      // signals.
                      className={`keep-occupant-row flex items-center justify-between gap-2 px-3 py-1.5 pl-5 lg:py-0.5 ${o.idle ? "opacity-50" : ""}`}
                    >
                      {/* Scale the username + its em-sized icons down
                          a touch relative to the rail's font-size so
                          more of long names fits before the truncate
                          kicks in. Driven off the parent's font-size
                          (which the Tools font-step setting controls)
                          so the relationship holds at every step. The
                          rank gem at `md` = 1.6em scales with this
                          too, keeping the icon proportional to the
                          name rather than dwarfing it.

                          Deliberately NOT `truncate` on this wrapper,
                          UserNameTag's name button already applies
                          `overflow-clip text-ellipsis` internally when
                          `truncate` is passed, so the long-name
                          ellipsis still works. Adding `overflow: hidden`
                          here as well clipped the avatar's VFX bleed
                          (Phoenix feathers, Aurora glow, etc.) at the
                          row's edge, the new in-place template
                          renderer relies on this wrapper staying
                          overflow:visible so decoration can paint
                          into the row gutter. */}
                      <div className="min-w-0 flex-1 text-[0.85em]">
                        <UserNameTag
                          displayName={o.displayName}
                          gender={o.gender}
                          color={o.chatColor ?? null}
                          away={o.away}
                          awayMessage={o.awayMessage ?? null}
                          ooc={o.characterId === null}
                          // Userlist rank sigil, drives from the live
                          // occupant's pool rank (per-character when
                          // attached, master pool otherwise). Slightly
                          // larger glyph than the chat-line sigil since
                          // the rail has room. Userlist uses the
                          // abridged `gem` variant (gem_rank_1.png …
                          // gem_rank_6.png), one icon per top-level
                          // rank, tier ignored, because the rail row
                          // has no room for the per-tier chevron detail
                          // and the rank category alone is enough.
                          rankKey={o.rankKey ?? null}
                          tier={o.tier ?? null}
                          rankSigilSize="md"
                          rankIconVariant="gem"
                          // Active name style, live from the occupant
                          // payload, so style edits update the rail
                          // instantly on the next presence broadcast.
                          nameStyleKey={o.activeNameStyleKey ?? null}
                          nameStyleConfig={o.nameStyleConfig ?? null}
                          // Phase 4, inline-avatar cosmetic swaps the
                          // gender-icon click target for a bordered
                          // avatar. UserNameTag honors `inlineAvatar`
                          // only when an avatarUrl is also available
                          // (a user with the cosmetic but no avatar
                          // keeps the gender-icon affordance).
                          avatarUrl={o.avatarUrl ?? null}
                          avatarCrop={o.avatarCrop ?? null}
                          selectedBorderRankKey={o.selectedBorderRankKey ?? null}
                          selectedFreeformBorderKey={o.selectedFreeformBorderKey ?? null}
                          freeformBorderConfig={o.freeformBorderConfig ?? null}
                          inlineAvatar={o.inlineAvatarEnabled}
                          onIconClick={() => onIconClick(o.userId, o.displayName, o.characterId)}
                          onNameClick={() => onNameClick(o.userId, o.displayName, o.characterId)}
                          // Rail rows are width-constrained (user-
                          // draggable resize handle) and have to
                          // ellipsize long names. Chat lines pass the
                          // default (truncate=false) so italic + name-
                          // style decorations there render fully.
                          truncate
                          // Rail alignment: pin the avatar slot + reserve the
                          // rank slot so names line up regardless of border /
                          // avatar / rank, and suppress the inline (ooc)/[away]
                          // text (shown as the mask + sphere cluster below).
                          railAlign
                        />
                      </div>
                      {/* Right-edge identity/status cluster, inline + right-
                          aligned: [character mask?] [status sphere] [staff
                          crown?]. Replaces the old (ooc)/(idle)/[away] text
                          suffixes:
                            - mask present  → voicing a CHARACTER; absent → OOC
                            - sphere colour → green online / grey idle / yellow away
                          The sphere always renders, so the row always has a
                          right anchor for `justify-between`. */}
                      <div className="flex shrink-0 items-center gap-1.5">
                        {o.characterId !== null ? (
                          <CharacterMaskIcon
                            className="h-4 w-4 text-keep-muted"
                            title="In character"
                          />
                        ) : null}
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          // Concrete status colours (not theme slots) so
                          // green/grey/yellow read as the universal
                          // online/idle/away convention on every palette. A
                          // faint dark ring separates a bright sphere from a
                          // bright row background.
                          style={{
                            backgroundColor: o.away ? "#facc15" : o.idle ? "#9ca3af" : "#22c55e",
                            boxShadow: "0 0 0 1.5px rgba(0,0,0,.3)",
                          }}
                          title={
                            o.away
                              ? `Away${o.awayMessage ? `: ${o.awayMessage}` : ""}`
                              : o.idle
                              ? "Idle, tab closed or refreshed, may return"
                              : "Online"
                          }
                          aria-label={o.away ? "Away" : o.idle ? "Idle" : "Online"}
                        />
                        {chip ? (
                          <span
                            className="shrink-0"
                            // Inline `color` is what the `currentColor`
                            // fills/strokes inside the SVG pick up. The
                            // value has already been nudged for legibility
                            // against the rail bg, so the icon reads
                            // cleanly across every theme.
                            style={{ color: chip.color }}
                            title={chip.title}
                            aria-label={chip.label}
                          >
                            <chip.Icon className="h-4 w-4" />
                          </span>
                        ) : null}
                        {/* Moderator action menu (Kick / Mute / Ban). Rendered
                            only when the viewer can act on THIS target — see
                            OccupantModMenu for the per-target gate. The menu
                            fires the same /kick, /mute, /ban chat commands a
                            mod would type, so the server's authority check runs
                            unchanged. */}
                        <OccupantModMenu
                          occupant={o}
                          selfUserId={selfUserId}
                          caps={modCaps}
                          onCommand={onCommand}
                        />
                      </div>
                    </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

// groupByPrimaryWorld + OccupantGroup were retired in migration
// 0187 alongside the per-master primary-world concept. The userlist
// is now a flat alphabetical list (see sortedOccupants in
// RoomEntry above).

/**
 * Per-occupant moderator action menu (Kick / Mute / Ban), rendered at the
 * right edge of a userlist row. A shield button toggles a small popover of the
 * enabled actions; each one fires the matching chat command via `onCommand`
 * with an unambiguous `@id:` / `@cid:` identity token (so a name with spaces
 * or a shared name can't mis-route). The server re-authorizes every command,
 * so this is purely an affordance — it renders nothing unless the viewer can
 * plausibly act on this target.
 *
 * Hidden entirely when:
 *   - the viewer holds no kick/mute/ban reach here (`caps` all false),
 *   - the row is the viewer's own account (you don't moderate yourself),
 *   - the target's SITE role out-ranks the viewer's (a server mod can't boot a
 *     site admin — the server refuses it too, this just hides the dead button).
 * The target's per-room crown does NOT hide the menu: a room owner may still
 * need to discipline a mod they promoted.
 */
function OccupantModMenu({
  occupant,
  selfUserId,
  caps,
  onCommand,
}: {
  occupant: RoomOccupant;
  selfUserId: string | null;
  caps: RoomModCaps;
  onCommand: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const myRole = useChat((s) => s.me?.role ?? null);
  const anyCap = caps.kick || caps.mute || caps.ban;
  const isSelf = selfUserId !== null && occupant.userId === selfUserId;
  // Don't offer actions the viewer can't win: a target whose ACCOUNT role
  // out-ranks the viewer is untouchable (mirrors mod.ts roleRank guards).
  const outranksMe = myRole !== null && roleRank(occupant.accountRole) > roleRank(myRole);
  if (!anyCap || isSelf || outranksMe) return null;

  // Target the exact identity shown in the row (character token when voicing
  // one, else the master token). resolveIdentityArg maps either back to the
  // account the mod commands act on.
  const targetArg = identityArgFor({
    userId: occupant.userId,
    characterId: occupant.characterId,
    displayName: occupant.displayName,
  });
  const run = (verb: "kick" | "mute" | "ban", confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    // /mute needs a duration argument; default to a short cool-off. The mod can
    // re-issue /mute with a custom duration from the composer for longer holds.
    const suffix = verb === "mute" ? " 10m" : "";
    onCommand(`/${verb} ${targetArg}${suffix}`);
    setOpen(false);
  };

  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-5 w-5 items-center justify-center rounded text-keep-muted opacity-70 transition-colors hover:bg-keep-system/15 hover:text-keep-system focus:opacity-100"
        title={`Moderate ${occupant.displayName}`}
        aria-label={`Moderate ${occupant.displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open ? (
        <>
          {/* Click-away scrim: closes the menu when the viewer clicks anywhere
              else. Transparent + fixed so it covers the viewport without
              shifting layout. */}
          <span
            className="fixed inset-0 z-40"
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <span
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 flex min-w-[7rem] flex-col overflow-hidden rounded border border-keep-rule bg-keep-panel py-0.5 text-xs shadow-lg"
          >
            {caps.kick ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => run("kick")}
                className="flex items-center gap-2 px-2.5 py-1.5 text-left text-keep-text hover:bg-keep-action/10"
                title="Boot from this room (they can rejoin)"
              >
                <UserX className="h-3.5 w-3.5 shrink-0" aria-hidden /> Kick
              </button>
            ) : null}
            {caps.mute ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => run("mute")}
                className="flex items-center gap-2 px-2.5 py-1.5 text-left text-keep-text hover:bg-keep-accent/10"
                title="Silence for 10 minutes (adjust the duration from chat)"
              >
                <VolumeX className="h-3.5 w-3.5 shrink-0" aria-hidden /> Mute
              </button>
            ) : null}
            {caps.ban ? (
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  run("ban", `Ban ${occupant.displayName} from this room? They won't be able to re-enter until unbanned.`)
                }
                className="flex items-center gap-2 px-2.5 py-1.5 text-left text-keep-system hover:bg-keep-system/10"
                title="Bar from this room until unbanned"
              >
                <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden /> Ban
              </button>
            ) : null}
          </span>
        </>
      ) : null}
    </span>
  );
}

interface StaffChip {
  /** Accessible name for the SVG icon (announced by screen readers). */
  label: string;
  /** Icon component rendered at the row's right edge. Uses
   *  `currentColor` for fill/stroke so the `color` style on the
   *  wrapping span drives the paint. */
  Icon: ComponentType<SVGProps<SVGSVGElement> & { title?: string }>;
  /** Hex color, already nudged for legibility against the rail bg. */
  color: string;
  /** Hover tooltip explaining the tier so newer users learn what each
   *  icon means without a docs lookup. */
  title: string;
}

/**
 * Resolve the staff-tier icon rendered at the right edge of each
 * userlist row. Replaces the earlier text chips ("MASTER" / "ADMIN" /
 * "MOD") which read as giant badges next to short usernames. Icons
 * carry the same recognition signal at a fraction of the visual
 * weight.
 *
 * Tiers shown most-prominent first, since only one icon is shown per
 * row and we want the highest authority to win:
 *   masteradmin   → crown icon in the accent slot (sitewide god-mode)
 *   admin         → trophy + base icon in the action slot (sitewide
 *                   moderation)
 *   mod / owner   → trophy outline icon in the system slot (either
 *                   site-mod, per-room mod, or per-room owner, all
 *                   three carry moderation powers and a user asking
 *                   for help doesn't care which flavor)
 *   user/trusted  → no icon
 *
 * Colors map onto theme slots so a custom palette repaints the icons
 * along with everything else, and each slot's color is run through
 * `legibleAgainstBg` against the rail's actual background (`theme.bg`)
 * so a custom palette that happens to pick a slot color too close to
 * the bg gets nudged toward legibility before the icon paints.
 */
function resolveStaffChip(o: RoomOccupant, theme: Theme, siteName: string): StaffChip | null {
  // SITE-staff badges (masteradmin / admin / site-mod) are suppressed
  // on character rows so an admin/mod can RP without the public
  // signaling "this character belongs to staff." The OOC ↔ character
  // partition is meant to be one-way for site staff: master surfaces
  // own the role info, character surfaces own none.
  //
  // Per-room ROLE badges (room owner / room mod) DO surface on
  // character rows: room moderation is a publicly-attached role the
  // room owner picked, occupants need to know who's running the
  // room they're in regardless of which identity that person is
  // voicing right now. Without this, a room owner who RPs as their
  // character loses the crown the moment they slip in-character,
  // and a re-promoted mod (the original "Florian still no crown
  // after /promote" report) reads as a regular member to everyone
  // else in the room.
  const isMasterRow = o.characterId === null;
  if (!isMasterRow) {
    // `o.role` is now PER-IDENTITY (the server derives it from
    // room_mods + rooms.owner_id, see broadcast.ts), so a character row
    // only carries "mod" when THAT identity was specifically /promoted,
    // and "owner" never lands on a character (ownership shows on the
    // owner's OOC row alone). That means staff who merely own/moderate
    // the default rooms no longer leak a crown onto every character they
    // RP, while a character explicitly promoted to room mod does show
    // one. Site badges (admin/master/site-mod) stay master-only below.
    if (o.role === "mod" || o.role === "owner") {
      return {
        label: o.role === "owner" ? "Room owner" : "Room Mod",
        Icon: ModIcon,
        color: legibleAgainstBg(theme.system, theme.bg),
        title:
          o.role === "owner"
            ? "Room owner, moderation authority in this room."
            : "Room Mod, moderation authority in this room.",
      };
    }
    return null;
  }

  if (o.accountRole === "masteradmin") {
    return {
      label: `${siteName} Owner`,
      Icon: MasterAdminIcon,
      color: legibleAgainstBg(theme.accent, theme.bg),
      title:
        `${siteName} Owner, site-wide authority including settings, branding, and account management.`,
    };
  }
  if (o.accountRole === "admin") {
    return {
      label: `${siteName} Admin`,
      Icon: AdminIcon,
      color: legibleAgainstBg(theme.action, theme.bg),
      title: `${siteName} Admin, site-wide moderation across every room.`,
    };
  }
  // Site-mod beats per-room badges in label / tooltip if both apply
  // (a site-mod who also owns the room reads as "Global Moderator"
  // since that's the broader authority).
  const isSiteMod = o.accountRole === "mod";
  if (isSiteMod || o.role === "mod" || o.role === "owner") {
    return {
      label:
        isSiteMod
          ? `${siteName} Moderator`
          : o.role === "owner"
          ? "Room owner"
          : "Room Mod",
      Icon: ModIcon,
      color: legibleAgainstBg(theme.system, theme.bg),
      title:
        isSiteMod
          ? `${siteName} Moderator, moderation across every room.`
          : o.role === "owner"
          ? "Room owner, moderation authority in this room."
          : "Room Mod, moderation authority in this room.",
    };
  }
  return null;
}
