/**
 * Age derivation — the single source of truth every age gate consults
 * (age-restriction plan, Phase 0; mirrors auth/blocks.ts as the one
 * helper module surfaces import instead of re-deriving).
 *
 * The ONLY stored signal is `users.birthdate` (ISO YYYY-MM-DD, migration
 * 0329). Everything else is computed at read time, so nothing has to be
 * flipped when a 17-year-old turns 18 — the very next session build (or
 * any other read) derives them adult.
 *
 * Two enforcement tiers built on these helpers:
 *   * HARD — `isAdultUser` (minors AND anonymous denied; adults always
 *     pass, hide preference or not): joining/reading 18+ rooms, NSFW
 *     topics/threads/profiles/worlds, setting any NSFW flag, backlog /
 *     export / live delivery, notifications.
 *   * SOFT — `canSeeNsfw` (also honors the adult "Hide 18+ content"
 *     preference): topic lists, both searches, discovery/catalog listings.
 *
 * There is deliberately NO staff/permission bypass: a minor account can
 * never pass an age gate, whatever its role. Site staff are unaffected
 * because staff accounts are adult accounts.
 */

/** Strict ISO date shape the registration paths persist. */
const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

/** The minimal slice of a users row (or session projection) the age
 *  helpers need. Kept structural so DB rows, SessionUser, and route
 *  projections all satisfy it without adapters. */
export interface AgeSubject {
  /** ISO YYYY-MM-DD, or null for legacy accounts (adult by attestation). */
  birthdate: string | null;
}

/** AgeSubject + the adult soft preference, for `canSeeNsfw`. */
export interface NsfwViewer extends AgeSubject {
  /** The adult "Hide 18+ content" preference (users.hide_nsfw). */
  hideNsfw: boolean;
}

/**
 * Full years of age at `now`, date-only in UTC — a user is one year older
 * AT MIDNIGHT UTC on their birthday, so "adult on the 18th birthday" holds
 * exactly. Returns null for a malformed string (see isAdultUser for how
 * that's treated). Exported for the registration minimum-age check.
 */
export function ageUtc(birthdate: string, now: Date = new Date()): number | null {
  if (!ISO_DATE_RX.test(birthdate)) return null;
  const [y, m, d] = birthdate.split("-").map(Number) as [number, number, number];
  // Reject impossible calendar dates (2007-02-31, month 13). Date.UTC
  // silently rolls them over, so round-trip the components to detect it.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  let age = now.getUTCFullYear() - y;
  const beforeBirthdayThisYear =
    now.getUTCMonth() + 1 < m ||
    (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  if (beforeBirthdayThisYear) age -= 1;
  return age;
}

/**
 * Adult = 18 or older (UTC date-only), OR a legacy account with no stored
 * birthdate — every pre-feature account attested "I am 18 or older" at
 * signup, so NULL is grandfathered adult (policy decision #2).
 *
 * A malformed NON-null birthdate (only reachable via a manual DB edit —
 * both signup paths and the admin editor validate) derives as NOT adult:
 * failing closed can inconvenience one broken row, failing open would let
 * a minor through every gate.
 */
export function isAdultUser(row: AgeSubject, now: Date = new Date()): boolean {
  if (row.birthdate === null) return true;
  const age = ageUtc(row.birthdate, now);
  return age !== null && age >= 18;
}

/** Convenience negation so call sites read as the policy they enforce. */
export function isMinor(row: AgeSubject, now: Date = new Date()): boolean {
  return !isAdultUser(row, now);
}

/**
 * SOFT-tier predicate: may this viewer see NSFW-labeled content in
 * listings/search/discovery? Anonymous (null/undefined) -> false; minors
 * -> false always; adults -> unless they turned on "Hide 18+ content".
 * HARD gates must use `isAdultUser` instead — an adult with the hide
 * preference still passes those.
 */
export function canSeeNsfw(viewer: NsfwViewer | null | undefined, now: Date = new Date()): boolean {
  if (!viewer) return false;
  return isAdultUser(viewer, now) && !viewer.hideNsfw;
}

/**
 * The registration floor, governed by the one admin flag
 * (`site_settings.allow_minor_signups`, migration 0330): OFF -> 18 (the
 * historical posture, now enforced by DOB instead of a checkbox); ON -> 13
 * (COPPA floor — under-13 signups are rejected, never stored).
 */
export function minimumSignupAge(settings: { allowMinorSignups: boolean }): number {
  return settings.allowMinorSignups ? 13 : 18;
}

/**
 * Registration-time check both signup paths share: is this birthdate a
 * valid calendar date AND at least `minAge` years old (UTC date-only,
 * boundary-inclusive — the birthday itself passes)? Malformed input is
 * simply "no" so the routes surface one friendly rejection.
 */
export function meetsMinimumAge(birthdate: string, minAge: number, now: Date = new Date()): boolean {
  const age = ageUtc(birthdate, now);
  return age !== null && age >= minAge;
}

/**
 * Plausibility ceiling shared by both signup paths and the admin DOB
 * editor: nobody registering is over 130. A birthdate past the ceiling is
 * a century typo (a 2011-born kid typing 1911) — exactly the input that
 * would otherwise silently derive an ADULT account with every minor gate
 * off and, per decision #7, no self-service correction path.
 */
export const MAX_PLAUSIBLE_AGE = 130;

/**
 * Signup-time companion to {@link meetsMinimumAge}: a VALID calendar date
 * more than {@link MAX_PLAUSIBLE_AGE} years back. Malformed input is not
 * "too old" — the floor check already rejects it with the friendlier copy.
 */
export function exceedsMaximumPlausibleAge(birthdate: string, now: Date = new Date()): boolean {
  const age = ageUtc(birthdate, now);
  return age !== null && age > MAX_PLAUSIBLE_AGE;
}
