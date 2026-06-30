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
export const VERSION = "0.29.2";
