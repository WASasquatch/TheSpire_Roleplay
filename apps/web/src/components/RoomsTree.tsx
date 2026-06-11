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
import { legibleAgainstBg, type RoomOccupant, type RoomSummary, type Theme } from "@thekeep/shared";
import { useActiveTheme } from "../lib/theme.js";
import { AdminIcon, CharacterMaskIcon, MasterAdminIcon, ModIcon } from "./StaffIcons.js";
import { ToolPanel } from "./ToolPanel.js";
import { UserNameTag } from "./UserNameTag.js";

export interface RoomWithOccupants extends RoomSummary {
  occupants: RoomOccupant[];
}

/** Bounds for the desktop userlist rail width, in pixels. */
const MIN_RAIL_WIDTH = 200; // narrow enough that staff icons + a short name still fit
const MAX_RAIL_WIDTH = 480; // wide enough for long room/character names without eating most of the chat
const DEFAULT_RAIL_WIDTH = 256; // matches the previous Tailwind `md:w-64` baseline
const RAIL_WIDTH_STORAGE_KEY = "tk_userlist_width";

/**
 * Hydrate the rail width from localStorage with a sanity-clamped
 * fallback. Reading inside the `useState` initializer (not a
 * `useEffect`) means the first render already uses the saved width
 *, no visible "snap from default to saved" flash on mount.
 */
function loadRailWidth(): number {
  try {
    const raw = window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_RAIL_WIDTH;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= MIN_RAIL_WIDTH && n <= MAX_RAIL_WIDTH) return n;
  } catch { /* private-mode, fall through to default */ }
  return DEFAULT_RAIL_WIDTH;
}

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
  /**
   * Mobile drawer state. On md+ screens the rail is always visible regardless;
   * isOpen only controls the slide-in/out at sub-md widths.
   */
  isOpen?: boolean;
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
 * Right-rail navigation: each room (public always, plus the private room the
 * caller is currently in) is rendered as a header followed by its occupants
 * indented underneath. Click a room name to switch; click an occupant icon
 * for profile, click their name to whisper.
 */
export function RoomsTree({
  rooms,
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
  isOpen,
  onClose,
  fontStep = 1,
}: Props) {
  // Mobile drawer: fixed-positioned slide-out from the right. md+ falls
  // back to the original static, always-visible rail. We avoid a separate
  // mobile component by toggling via Tailwind's responsive variants.
  const drawerOpen = isOpen ?? false;

  // Pin the caller's current room to the top of the rail so it stays
  // visible on installs with many rooms. The server returns rooms in
  // alphabetical order; we partition just enough to lift the active
  // room out and leave the rest in their original order. No-op when
  // the user isn't in any room or the room isn't in this list.
  const orderedRooms = useMemo(() => {
    if (!currentRoomId) return rooms;
    const idx = rooms.findIndex((r) => r.id === currentRoomId);
    if (idx <= 0) return rooms;
    return [rooms[idx]!, ...rooms.slice(0, idx), ...rooms.slice(idx + 1)];
  }, [rooms, currentRoomId]);

  // Desktop-only horizontal resize for the rail. The user drags the
  // left edge, pulling LEFT widens the rail (eats into the chat
  // column), pulling RIGHT narrows it. Value persists per-browser
  // via localStorage so the choice rides along with the tab.
  // Mobile keeps the fixed w-72 drawer width since "drag to resize"
  // doesn't translate to a slide-out panel.
  const [railWidth, setRailWidth] = useState<number>(loadRailWidth);
  useEffect(() => {
    try { window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(railWidth)); }
    catch { /* private-mode, width still works for this session */ }
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
      className={`
        keep-app-sidebar
        flex h-full w-72 flex-col border-l border-keep-rule bg-keep-bg text-sm shadow-2xl
        fixed inset-y-0 right-0 z-40 transform transition-transform
        ${drawerOpen ? "translate-x-0" : "translate-x-full"}
        lg:relative lg:w-[var(--keep-rail-width)] lg:translate-x-0 lg:transform-none lg:transition-none
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
      {/* Header row - title + room count, with the mobile-only close
          button living inside it (instead of an absolute overlay) so it
          gets real layout space and never covers the room list. */}
      <div className="flex items-center justify-between border-b border-keep-rule bg-keep-banner/40 px-3 py-2 lg:bg-transparent lg:py-1.5">
        <span className="text-xs uppercase tracking-widest text-keep-muted">
          Rooms <span className="text-keep-rule">({rooms.length})</span>
        </span>
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rooms.length === 0 ? (
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
}: {
  room: RoomWithOccupants;
  isCurrent: boolean;
  selfUserId: string | null;
  onIconClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onNameClick: (userId: string, displayName: string, characterId?: string | null) => void;
  onRoomClick: (roomId: string) => void;
  onWorldClick: (worldId: string) => void;
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

  return (
    <li
      className={`keep-row border-b border-keep-rule/40 ${isCurrent ? "bg-keep-banner/40" : ""}`}
      data-active={isCurrent ? "true" : undefined}
    >
      <button
        type="button"
        onClick={() => onRoomClick(room.id)}
        title={room.topic ?? ""}
        className={`flex w-full items-baseline justify-between px-3 py-2.5 text-left text-[1.1rem] font-bold hover:bg-keep-banner/30 hover:text-keep-accent lg:py-1 ${
          isCurrent ? "text-keep-action" : "text-keep-accent"
        }`}
      >
        <span className="truncate">
          {/* Room-shape glyph. Flat rooms behave like ephemeral chats;
              nested rooms persist their conversations as threaded
              replies (forum-style) so newcomers know which mode the
              room is in before they enter. */}
          {/* Room-mode glyph. PNG icons (board.png / scroll.png) replace
              the emoji equivalents (🧵 / 💬) per the Earning asset
              pack so the rail reads consistently across platforms
              regardless of OS emoji font. */}
          {room.replyMode === "nested" ? (
            <img
              src="/assets/icons/board.png"
              alt=""
              aria-hidden
              title="threaded conversations, replies persist as forum-style threads"
              className="mr-1 inline-block shrink-0 select-none align-middle"
              // em-sized so the icon scales with the rail's fontSize
              // (driven by the Tools-menu font-step setting). 1.4em is
              // a tad larger than the room-name's cap-height so the
              // icon reads as a label glyph at every step.
              style={{ minWidth: "1.4em", minHeight: "1.4em", width: "1.4em", height: "1.4em" }}
              draggable={false}
            />
          ) : (
            <img
              src="/assets/icons/scroll.png"
              alt=""
              aria-hidden
              title="flat chat, chronological, ephemeral feel"
              className="mr-1 inline-block shrink-0 select-none align-middle"
              style={{ minWidth: "1.4em", minHeight: "1.4em", width: "1.4em", height: "1.4em" }}
              draggable={false}
            />
          )}
          {isPrivate ? <span title="private - password required" className="mr-1">🔒</span> : null}
          {room.name}
        </span>
        <span className="ml-2 shrink-0 font-normal text-keep-muted">({displayedOccupants.length})</span>
      </button>
      {displayedOccupants.length === 0 ? (
        <div className="px-5 pb-2 text-[11px] italic text-keep-muted lg:pb-1">empty</div>
      ) : (
        <ul className="pb-1">
          {sortedOccupants.map((o) => {
            // Composite key, a single account voicing two different
            // characters in two tabs renders as two occupant rows
            // (one per identity). Keying on userId alone would
            // dup-React-key in that case.
            const chip = resolveStaffChip(o, theme);
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
                      className={`flex items-center justify-between gap-2 px-3 py-1.5 pl-5 lg:py-0.5 ${o.idle ? "opacity-50" : ""}`}
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
function resolveStaffChip(o: RoomOccupant, theme: Theme): StaffChip | null {
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
    if (o.role === "mod" || o.role === "owner") {
      return {
        label: o.role === "owner" ? "Room owner" : "Room moderator",
        Icon: ModIcon,
        color: legibleAgainstBg(theme.system, theme.bg),
        title:
          o.role === "owner"
            ? "Room owner, moderation authority in this room."
            : "Room moderator, moderation authority in this room.",
      };
    }
    return null;
  }

  if (o.accountRole === "masteradmin") {
    return {
      label: "Master admin",
      Icon: MasterAdminIcon,
      color: legibleAgainstBg(theme.accent, theme.bg),
      title:
        "Master admin, site-wide authority including settings, branding, and account management.",
    };
  }
  if (o.accountRole === "admin") {
    return {
      label: "Admin",
      Icon: AdminIcon,
      color: legibleAgainstBg(theme.action, theme.bg),
      title: "Site admin, site-wide moderation across every room.",
    };
  }
  // Site-mod beats per-room badges in label / tooltip if both apply
  // (a site-mod who also owns the room reads as "Site moderator"
  // since that's the broader authority).
  const isSiteMod = o.accountRole === "mod";
  if (isSiteMod || o.role === "mod" || o.role === "owner") {
    return {
      label:
        isSiteMod
          ? "Site moderator"
          : o.role === "owner"
          ? "Room owner"
          : "Room moderator",
      Icon: ModIcon,
      color: legibleAgainstBg(theme.system, theme.bg),
      title:
        isSiteMod
          ? "Site moderator, moderation across every room."
          : o.role === "owner"
          ? "Room owner, moderation authority in this room."
          : "Room moderator, moderation authority in this room.",
    };
  }
  return null;
}
