import { createContext } from "react";

/**
 * Lets a forum post's toolbar (deep inside MessageList) offer a "Report"
 * action without drilling a callback through every layer. The Forums
 * Catalog provides the handler (it knows the forumId); a null value means
 * "not in a reportable forum context" so the button hides (e.g. plain chat,
 * the public /f/ landing for signed-out visitors).
 *
 * The handler receives the reported message id + the author's display name
 * (for the confirm copy); it opens the reason prompt and posts the report.
 */
export const ForumReportContext = createContext<
  ((messageId: string, authorName: string) => void) | null
>(null);
