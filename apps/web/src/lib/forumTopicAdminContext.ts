import { createContext } from "react";

/**
 * Lets a forum TOPIC card (deep in MessageList) open the unified "Move topic"
 * modal — recategorize within the board, move to another board, or merge into
 * another topic — without prop-drilling the forum's board list. The Forums
 * Catalog provides the boards + a refresh callback, and ONLY when the viewer
 * holds `move_topics`; a null value hides the Move affordance entirely. The
 * server re-checks every move/merge/recategorize call regardless.
 */
export interface ForumTopicAdminBoard {
  roomId: string;
  name: string;
  topicCount: number;
}

export interface ForumTopicAdmin {
  /** Boards in this forum, for the move-to-board + merge pickers. */
  boards: ForumTopicAdminBoard[];
  /** Refresh the catalog after a successful move / merge / recategorize. */
  onChanged: () => void;
}

export const ForumTopicAdminContext = createContext<ForumTopicAdmin | null>(null);
