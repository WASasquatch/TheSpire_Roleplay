import { useMemo, type ComponentType, type SVGProps } from "react";
import { legibleAgainstBg, type RoomOccupant, type RoomSummary, type Theme } from "@thekeep/shared";
import { useActiveTheme } from "../lib/theme.js";
import { AdminIcon, MasterAdminIcon, ModIcon } from "./StaffIcons.js";
import { ToolPanel } from "./ToolPanel.js";
import { UserNameTag } from "./UserNameTag.js";

export interface RoomWithOccupants extends RoomSummary {
  occupants: RoomOccupant[];
}

interface Props {
  rooms: RoomWithOccupants[];
  currentRoomId: string | null;
  /** When set, the Tools panel's identity dropdown adopts an in-character label + "Leave Character" row. */
  activeCharacterId?: string | null;
  /** Display name of the active character — used by the identity button label. */
  activeCharacterName?: string | null;
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  onRoomClick: (roomId: string) => void;
  onCommand: (text: string) => void;
  /** Open the world viewer modal for a given world id (clicking a primary-world section header). */
  onWorldClick: (worldId: string) => void;
  /** Jump to a specific message in a room. Wired by the in-rail search bar. */
  onJumpToMessage: (roomId: string, messageId: string) => void;
  /** Open the unified Messages modal (DMs + friends + friend requests). */
  onOpenMessages: () => void;
  /**
   * Mobile drawer state. On md+ screens the rail is always visible regardless;
   * isOpen only controls the slide-in/out at sub-md widths.
   */
  isOpen?: boolean;
  onClose?: () => void;
}

/**
 * Right-rail navigation: each room (public always, plus the private room the
 * caller is currently in) is rendered as a header followed by its occupants
 * indented underneath. Click a room name to switch; click an occupant icon
 * for profile, click their name to whisper.
 */
export function RoomsTree({
  rooms,
  currentRoomId,
  activeCharacterId,
  activeCharacterName,
  onIconClick,
  onNameClick,
  onRoomClick,
  onCommand,
  onWorldClick,
  onJumpToMessage,
  onOpenMessages,
  isOpen,
  onClose,
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
  return (
    <aside
      // Solid bg-keep-bg on mobile so the chat doesn't bleed through the
      // drawer; on md+ keep the subtle panel tint that visually separates
      // the rail from the chat. Slightly wider on mobile (72) to give
      // thumbs a comfortable target.
      className={`
        keep-app-sidebar
        flex h-full w-72 flex-col border-l border-keep-rule bg-keep-bg text-sm shadow-2xl
        fixed inset-y-0 right-0 z-40 transform transition-transform
        ${drawerOpen ? "translate-x-0" : "translate-x-full"}
        md:static md:w-64 md:translate-x-0 md:transform-none md:transition-none
        md:bg-keep-banner/30 md:shadow-none
      `}
    >
      {/* Header row - title + room count, with the mobile-only close
          button living inside it (instead of an absolute overlay) so it
          gets real layout space and never covers the room list. */}
      <div className="flex items-center justify-between border-b border-keep-rule bg-keep-banner/40 px-3 py-2 md:bg-transparent md:py-1.5">
        <span className="text-xs uppercase tracking-widest text-keep-muted">
          Rooms <span className="text-keep-rule">({rooms.length})</span>
        </span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="keep-button flex h-8 w-8 items-center justify-center rounded border border-keep-rule bg-keep-panel text-base text-keep-text hover:bg-keep-banner md:hidden"
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
      />
    </aside>
  );
}

function RoomGroup({
  room,
  isCurrent,
  onIconClick,
  onNameClick,
  onRoomClick,
  onWorldClick,
}: {
  room: RoomWithOccupants;
  isCurrent: boolean;
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  onRoomClick: (roomId: string) => void;
  onWorldClick: (worldId: string) => void;
}) {
  const isPrivate = room.type === "private";
  // Group occupants by primary world. Unaffiliated bucket keys "_none" so
  // it sorts to the end deterministically. Within a world, sort by display
  // name; world buckets sort by world name; "_none" is always last.
  const groups = groupByPrimaryWorld(room.occupants);
  const showHeaders = groups.length > 1; // a single bucket is just a flat list
  // Active theme drives the legibility nudge that keeps the staff
  // icons readable against the rail bg — even on a custom palette
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
        className={`flex w-full items-baseline justify-between px-3 py-2.5 text-left font-bold hover:bg-keep-banner/30 hover:text-keep-accent md:py-1 ${
          isCurrent ? "text-keep-action" : "text-keep-accent"
        }`}
      >
        <span className="truncate">
          {/* Room-shape glyph. Flat rooms behave like ephemeral chats;
              nested rooms persist their conversations as threaded
              replies (forum-style) so newcomers know which mode the
              room is in before they enter. */}
          {room.replyMode === "nested" ? (
            <span title="threaded conversations — replies persist as forum-style threads" className="mr-1">🧵</span>
          ) : (
            <span title="flat chat — chronological, ephemeral feel" className="mr-1">💬</span>
          )}
          {isPrivate ? <span title="private - password required" className="mr-1">🔒</span> : null}
          {room.name}
        </span>
        <span className="ml-2 shrink-0 font-normal text-keep-muted">({room.occupants.length})</span>
      </button>
      {room.occupants.length === 0 ? (
        <div className="px-5 pb-2 text-[11px] italic text-keep-muted md:pb-1">empty</div>
      ) : (
        <ul className="pb-1">
          {groups.map((g) => (
            <li key={g.world?.id ?? "_none"}>
              {showHeaders ? (
                g.world ? (
                  <button
                    type="button"
                    onClick={() => onWorldClick(g.world!.id)}
                    title={`Open ${g.world.name} (by ${g.world.ownerUsername})`}
                    // py-1.5 mobile / py-0.5 desktop. Section banding via
                    // muted/25 - same pattern used for hover highlights.
                    className="flex w-full items-baseline justify-between bg-keep-muted/25 px-3 py-1.5 text-left text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-muted/40 md:py-0.5"
                  >
                    <span className="truncate">{g.world.name}</span>
                    <span className="ml-2 shrink-0">{g.users.length}</span>
                  </button>
                ) : (
                  <div className="bg-keep-muted/10 px-3 py-1.5 text-[10px] uppercase tracking-widest text-keep-muted/70 md:py-0.5">
                    Unaffiliated
                    <span className="ml-2">{g.users.length}</span>
                  </div>
                )
              ) : null}
              <ul>
                {g.users.map((o) => {
                  // Composite key — a single account voicing two
                  // different characters in two tabs renders as two
                  // occupant rows (one per identity). Keying on userId
                  // alone would dup-React-key in that case.
                  const chip = resolveStaffChip(o, theme);
                  return (
                    <li
                      key={`${o.userId}:${o.characterId ?? ""}`}
                      className="flex items-center justify-between gap-2 px-3 py-1.5 pl-5 md:py-0.5"
                    >
                      <div className="min-w-0 flex-1 truncate">
                        <UserNameTag
                          displayName={o.displayName}
                          gender={o.gender}
                          color={o.chatColor ?? null}
                          away={o.away}
                          awayMessage={o.awayMessage ?? null}
                          rolePrefix={resolveRolePrefix(o)}
                          ooc={o.characterId === null}
                          onIconClick={() => onIconClick(o.userId, o.displayName)}
                          onNameClick={() => onNameClick(o.userId, o.displayName)}
                        />
                      </div>
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
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface OccupantGroup {
  /** Null = the unaffiliated bucket. */
  world: { id: string; slug: string; name: string; ownerUsername: string } | null;
  users: RoomOccupant[];
}

/**
 * Bucket occupants by their primary world. World buckets sort by world name;
 * the unaffiliated bucket always lands at the end. Within a bucket, sort by
 * display name (case-insensitive) so the list is stable as users come and go.
 */
function groupByPrimaryWorld(occupants: RoomOccupant[]): OccupantGroup[] {
  const buckets = new Map<string, OccupantGroup>();
  for (const o of occupants) {
    const key = o.primaryWorld?.id ?? "_none";
    let g = buckets.get(key);
    if (!g) {
      g = { world: o.primaryWorld ?? null, users: [] };
      buckets.set(key, g);
    }
    g.users.push(o);
  }
  for (const g of buckets.values()) {
    g.users.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
  }
  return [...buckets.values()].sort((a, b) => {
    if (!a.world && !b.world) return 0;
    if (!a.world) return 1;
    if (!b.world) return -1;
    return a.world.name.toLowerCase().localeCompare(b.world.name.toLowerCase());
  });
}

/**
 * Resolve the small role chip rendered before a user's name. Owner takes
 * precedence; otherwise either a per-room mod OR a site-level mod gets a
 * star (a site mod is conceptually "a mod for every room", so it makes
 * sense to share the marker). Site admins use italics instead - handled
 * elsewhere via UserNameTag's `italic` prop - so admin doesn't need a
 * prefix here.
 */
function resolveRolePrefix(o: RoomOccupant): string {
  if (o.role === "owner") return "♛";
  if (o.role === "mod" || o.accountRole === "mod") return "★";
  return "";
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
 *                   site-mod, per-room mod, or per-room owner — all
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
  if (o.accountRole === "masteradmin") {
    return {
      label: "Master admin",
      Icon: MasterAdminIcon,
      color: legibleAgainstBg(theme.accent, theme.bg),
      title:
        "Master admin — site-wide authority including settings, branding, and account management.",
    };
  }
  if (o.accountRole === "admin") {
    return {
      label: "Admin",
      Icon: AdminIcon,
      color: legibleAgainstBg(theme.action, theme.bg),
      title: "Site admin — site-wide moderation across every room.",
    };
  }
  if (o.accountRole === "mod" || o.role === "mod" || o.role === "owner") {
    return {
      label:
        o.accountRole === "mod"
          ? "Site moderator"
          : o.role === "owner"
          ? "Room owner"
          : "Room moderator",
      Icon: ModIcon,
      color: legibleAgainstBg(theme.system, theme.bg),
      title:
        o.accountRole === "mod"
          ? "Site moderator — moderation across every room."
          : o.role === "owner"
          ? "Room owner — moderation authority in this room."
          : "Room moderator — moderation authority in this room.",
    };
  }
  return null;
}
