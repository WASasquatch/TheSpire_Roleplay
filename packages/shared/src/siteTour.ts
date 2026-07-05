/**
 * Site coach tour — the one-time guided walkthrough of the chat screen that
 * greets a new member on first load (and can be replayed from Help).
 *
 * `SITE_TOUR_VERSION` is the "content version" of that tour, the same
 * seen-once mechanism as the new-user welcome (`users.welcome_seen_hash`) but
 * expressed as a monotonic integer instead of a copy hash: the tour's copy is
 * hard-coded in the client, not admin-authored, so a plain version bump is the
 * right lever to re-show it after a meaningful revision.
 *
 * The server compares `users.tour_seen_version` against this constant on
 * `/me/profile`; when the stored value is lower it reports `showSiteTour: true`
 * so the client auto-opens the tour. `POST /me/tour/dismiss` writes this exact
 * value back, so a user who has seen version N never sees it again until the
 * constant is bumped to N+1.
 *
 * Bump this (and only this) when the tour's steps change enough that returning
 * users should see it again. Leave it alone for typo fixes.
 */
export const SITE_TOUR_VERSION = 1;

/**
 * The site-tour fields the `/me/profile` response carries. Mixed into that
 * (otherwise inline-typed) payload so the client can read `showSiteTour`
 * without re-deriving the version comparison itself.
 */
export interface SiteTourProfileFields {
  /**
   * True when the server determined the viewer has not yet seen the current
   * tour version (`users.tour_seen_version < SITE_TOUR_VERSION`). The client
   * auto-opens the coach tour once when this is true, then POSTs
   * `/me/tour/dismiss` to record it.
   */
  showSiteTour: boolean;
}
