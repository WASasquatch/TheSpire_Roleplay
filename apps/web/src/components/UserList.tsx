import type { ReactNode } from "react";
import type { RoomOccupant, RoomSummary } from "@thekeep/shared";
import { ToolPanel } from "./ToolPanel.js";
import { UserNameTag } from "./UserNameTag.js";

interface Props {
  roomName: string;
  occupants: RoomOccupant[];
  /** All public rooms — rendered as a clickable list at the top of the rail. */
  publicRooms: RoomSummary[];
  currentRoomId: string | null;
  onIconClick: (userId: string, displayName: string) => void;
  onNameClick: (userId: string, displayName: string) => void;
  onRoomClick: (roomId: string) => void;
  onCommand: (text: string) => void;
  /**
   * Optional slot rendered above everything else in this rail. The parent
   * passes the MetaBar here so the rail's flex layout owns the full column
   * height (otherwise the rail collapses to its content).
   */
  meta?: ReactNode;
}

export function UserList({
  roomName,
  occupants,
  publicRooms,
  currentRoomId,
  onIconClick,
  onNameClick,
  onRoomClick,
  onCommand,
  meta,
}: Props) {
  return (
    <aside className="flex h-full w-64 flex-col border-l border-keep-rule bg-keep-banner/30 text-sm">
      {meta}
      <div className="border-b border-keep-rule px-3 py-1 text-xs uppercase tracking-widest text-keep-muted">
        Rooms
      </div>
      <ul className="max-h-48 shrink-0 overflow-y-auto px-2 py-1 text-xs">
        {publicRooms.length === 0 ? (
          <li className="text-keep-muted">(none)</li>
        ) : (
          publicRooms.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onRoomClick(r.id)}
                className={`block w-full truncate text-left hover:underline ${
                  r.id === currentRoomId ? "font-semibold text-keep-action" : ""
                }`}
                title={r.topic ?? ""}
              >
                {r.name} <span className="text-keep-muted">({r.memberCount})</span>
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="border-y border-keep-rule px-3 py-1 text-xs uppercase tracking-widest text-keep-muted">
        {roomName} <span className="text-keep-rule">({occupants.length})</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {occupants.map((o) => (
          <li key={o.userId} className="truncate">
            <UserNameTag
              displayName={o.displayName}
              gender={o.gender}
              color={o.chatColor ?? null}
              away={o.away}
              awayMessage={o.awayMessage ?? null}
              rolePrefix={o.role === "owner" ? "♛" : o.role === "mod" ? "★" : ""}
              onIconClick={() => onIconClick(o.userId, o.displayName)}
              onNameClick={() => onNameClick(o.userId, o.displayName)}
            />
          </li>
        ))}
      </ul>
      <ToolPanel onCommand={onCommand} />
    </aside>
  );
}
