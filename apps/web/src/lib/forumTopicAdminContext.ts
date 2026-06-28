import { createContext } from "react";

/**
 * Lets a forum TOPIC card (deep in MessageList) offer Move-to-board and
 * Merge actions without prop-drilling. The Forums Catalog provides the
 * handlers (it knows the forum's boards + can open the picker modal). A
 * null value means the viewer can't move topics here, so the buttons hide
 * — gating lives entirely in whether the provider passes a value, which the
 * server re-checks on the actual move/merge call.
 */
export interface ForumTopicAdmin {
  /** Open the board picker to move this topic to another board. */
  onMove: (topicId: string, currentBoardId: string, title: string) => void;
  /** Open the topic picker to merge this topic into another. */
  onMerge: (topicId: string, title: string) => void;
}

export const ForumTopicAdminContext = createContext<ForumTopicAdmin | null>(null);
