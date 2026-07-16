/**
 * Single source of truth for the app's release version. Imported by the
 * splash footer (web bundle) and any server-side surface that wants to
 * stamp the build (log lines, response headers, future /healthz etc.).
 *
 * Bumping:
 *   - `pnpm bump:patch`  →  0.6.0 → 0.6.1
 *   - `pnpm bump:minor`  →  0.6.0 → 0.7.0
 *   - `pnpm bump:major`  →  0.6.0 → 1.0.0
 *
 * Or pass `--bump <level>` to ship.sh / pnpm ship so the bump rides with
 * the same commit as the changes it represents.
 *
 * SemVer-ish: pre-1.0 minor bumps are roughly "milestone progress",
 * patch bumps are bug fixes / small adjustments, and a 1.0 release
 * signals "feature-complete for the original scope, API surface settled."
 */
export const VERSION = "0.33.15";

/**
 * True when `version` sorts below the 1.0.0 release under SemVer ordering.
 * Drives self-retiring "Beta" surfaces: any 0.x.y build qualifies, as does
 * a 1.0.0 prerelease (e.g. "1.0.0-rc.1", which SemVer places BEFORE 1.0.0).
 * bump.sh only ever writes plain x.y.z, but the prerelease branch keeps the
 * gate correct if a tagged prerelease build ever ships. Unparseable input
 * fails CLOSED (returns false) so a malformed version can't pin the badge on
 * forever.
 */
export function isBetaVersion(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim(),
  );
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const prerelease = m[4];
  if (major < 1) return true;
  if (major > 1) return false;
  // major === 1: only the 1.0.0 prereleases sort below 1.0.0.
  return minor === 0 && patch === 0 && prerelease !== undefined;
}
