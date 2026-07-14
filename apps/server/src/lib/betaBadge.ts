import { VERSION, isBetaVersion } from "@thekeep/shared";

/**
 * Whether the splash "Beta" badge is live: the admin toggle
 * (site_settings.beta_badge_enabled, migration 0357) ANDed with the
 * app-version gate (VERSION < 1.0.0 under SemVer ordering). The version
 * gate means the badge retires itself the moment a 1.0.0 build ships,
 * with no admin action and no dangling toggle to remember.
 *
 * `version` is injectable for tests only; production callers pass nothing
 * and get the real build version.
 */
export function betaBadgeActive(
  settings: { betaBadgeEnabled: boolean },
  version: string = VERSION,
): boolean {
  return settings.betaBadgeEnabled && isBetaVersion(version);
}
