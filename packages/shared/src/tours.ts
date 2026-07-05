/**
 * Contextual first-time tours — the reusable catalog of surface-specific coach
 * tours that greet a member the first time they open a given surface (the
 * Forums catalog, a server's admin panel, …).
 *
 * This is the multi-tour sibling of the single whole-screen site tour in
 * `siteTour.ts`. Where that one gates on a single `users.tour_seen_version`
 * integer, each tour here is tracked independently in the `tour_seen` table by
 * (user_id, tour_id) with its own monotonic `seen_version`. The server reports
 * `toursToShow: TourId[]` on `/me/profile` (every tour whose catalog version is
 * ahead of the user's stored seen_version), and `POST /me/tours/:tourId/dismiss`
 * records the current version so that tour stops re-showing until it is bumped.
 *
 * Bump a tour's `version` when its steps change enough that a returning user
 * should see it again; leave it for typo fixes. The step COPY lives in the
 * client registry (apps/web/src/lib/tours), not here — this module is only the
 * shared id catalog + version/label metadata both sides agree on.
 */

export type TourId =
  | "forums-browse"
  | "forum-posting"
  | "forum-create"
  | "forum-admin"
  | "server-create"
  | "server-admin"
  | "site-admin";

export const TOURS: Record<TourId, { version: number; label: string; description: string }> = {
  "forums-browse": {
    version: 1,
    label: "Browsing the forums",
    description: "Find your way around the forum boards and topics.",
  },
  "forum-posting": {
    version: 1,
    label: "Posting on the forums",
    description: "Start a topic and reply to the conversation.",
  },
  "forum-create": {
    version: 1,
    label: "Creating a forum",
    description: "Set up a new forum and its first boards.",
  },
  "forum-admin": {
    version: 1,
    label: "Moderating a forum",
    description: "Manage boards, roles, and moderation tools.",
  },
  "server-create": {
    version: 1,
    label: "Creating a community",
    description: "Spin up a new community server of your own.",
  },
  "server-admin": {
    version: 1,
    label: "Running a community",
    description: "Tune your community's rooms, roles, and settings.",
  },
  "site-admin": {
    version: 1,
    label: "The admin panel",
    description: "Get oriented with the site administration tools.",
  },
};

export const TOUR_IDS: TourId[] = Object.keys(TOURS) as TourId[];
