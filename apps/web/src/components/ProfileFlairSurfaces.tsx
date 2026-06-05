import { useEffect, useMemo, useState } from "react";
import { markdownToHtml, type ProfileVisitorStats } from "@thekeep/shared";
import { sanitizeUserHtml } from "../lib/userHtml.js";

/**
 * Profile-side render surfaces for the two flairs added in
 * migration 0192. Each component fetches its own data so they can
 * drop into ProfileModal at the right slots without ProfileModal
 * needing to know about flair plumbing.
 *
 * `ProfileMarquee` — rotating quote strip rendered between the
 *   header and the bio/stats grid when the profile owner has the
 *   `flair_profile_marquee` flair AND has configured quotes.
 *
 * `ProfileVisitorsChip` — small inline counter for distinct
 *   member + external viewers, rendered only when the owner has
 *   the `flair_profile_visitors` flair AND has flipped the
 *   visibility toggle on.
 *
 * `useTrackProfileView` — log-once-per-mount hook that POSTs to
 *   `/profiles/:name/view`. Always-on regardless of flair state so
 *   the counter has data the moment the owner equips it. Skipped
 *   when the viewer would be looking at their own profile
 *   (server also dedupes self-views, but skipping the request
 *   keeps the network quiet).
 */

const ROTATION_MS = 8_000;
const FADE_MS = 300;

interface ProfileNameProps {
  /** `/p/<name>` slug — what the lookup endpoint matches on. */
  profileName: string;
  /** Optional character id when this profile is character-scoped.
   *  Null = master / OOC profile. */
  characterId: string | null;
}

export function ProfileMarquee({ profileName, characterId }: ProfileNameProps) {
  const [quotes, setQuotes] = useState<string[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [fading, setFading] = useState(false);
  // Bumped on manual dot-click so the auto-rotation effect tears
  // down + restarts its interval — viewer gets the full ROTATION_MS
  // on the quote they explicitly chose, same posture as the
  // sitewide announcement marquee.
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(buildUrl(`/profiles/${encodeURIComponent(profileName)}/marquee`, characterId));
        if (!r.ok) return;
        const j = (await r.json()) as { quotes?: string[] };
        if (!cancelled && Array.isArray(j.quotes)) {
          setQuotes(j.quotes);
          setActiveIdx(0);
        }
      } catch { /* ignore — flair simply won't render */ }
    }
    void load();
    return () => { cancelled = true; };
  }, [profileName, characterId]);

  useEffect(() => {
    if (quotes.length < 2) return;
    const id = window.setInterval(() => {
      setFading(true);
      window.setTimeout(() => {
        setActiveIdx((i) => (i + 1) % quotes.length);
        setFading(false);
      }, FADE_MS);
    }, ROTATION_MS);
    return () => window.clearInterval(id);
  }, [quotes.length, resetKey]);

  const renderedHtml = useMemo(() => {
    const active = quotes[activeIdx] ?? "";
    return sanitizeUserHtml(markdownToHtml(active));
  }, [quotes, activeIdx]);

  if (quotes.length === 0) return null;

  return (
    <div
      // Full-width strip, blends into the profile's keep-panel
      // surface so the marquee reads as part of the profile chrome
      // rather than a sitewide bar. Same fade behavior as the
      // chat-top announcement marquee for cross-surface consistency.
      role="region"
      aria-label="Profile quotes"
      className="w-full border-y border-keep-action/30 bg-keep-action/5 px-4 py-2"
    >
      <div
        style={{
          opacity: fading ? 0 : 1,
          transition: `opacity ${FADE_MS}ms ease-in-out`,
        }}
        className="mx-auto max-w-2xl text-center text-sm italic leading-snug [&_a]:underline [&_a]:underline-offset-2 [&_li]:m-0 [&_li]:inline [&_p]:m-0 [&_p]:inline [&_strong]:font-semibold [&_ul]:m-0 [&_ul]:inline"
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
      {quotes.length > 1 ? (
        <div className="mt-1.5 flex items-center justify-center gap-1.5" aria-hidden>
          {quotes.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                if (i === activeIdx) return;
                setFading(true);
                window.setTimeout(() => {
                  setActiveIdx(i);
                  setFading(false);
                  setResetKey((k) => k + 1);
                }, FADE_MS);
              }}
              className={`h-1.5 w-1.5 rounded-full transition hover:scale-125 ${
                i === activeIdx
                  ? "bg-keep-action"
                  : "bg-keep-action/40"
              }`}
              aria-label={`Show quote ${i + 1} of ${quotes.length}`}
              title={`Show quote ${i + 1} of ${quotes.length}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProfileVisitorsChip({ profileName, characterId }: ProfileNameProps) {
  const [stats, setStats] = useState<ProfileVisitorStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(buildUrl(`/profiles/${encodeURIComponent(profileName)}/visitor-stats`, characterId));
        if (!r.ok) return;
        const j = (await r.json()) as { visible: boolean; stats: ProfileVisitorStats };
        if (!cancelled && j.visible) setStats(j.stats);
      } catch { /* ignore */ }
    }
    void load();
    return () => { cancelled = true; };
  }, [profileName, characterId]);
  if (!stats || stats.total === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-keep-rule/60 bg-keep-bg/40 px-1.5 py-0.5 text-[11px] text-keep-muted"
      title={`${stats.members} members + ${stats.external} external`}
    >
      <span aria-hidden>👀</span>
      <span className="tabular-nums">{stats.total.toLocaleString()}</span>
      <span>{stats.total === 1 ? "visitor" : "visitors"}</span>
    </span>
  );
}

/**
 * Fire-and-forget view logger. Mounts once when the profile modal
 * opens; never retries on failure (the metric is best-effort).
 * Skips when `isSelf` is true so a viewer doesn't pad their own
 * counter just by browsing their profile.
 */
export function useTrackProfileView({
  profileName,
  characterId,
  isSelf,
}: ProfileNameProps & { isSelf: boolean }) {
  useEffect(() => {
    if (isSelf) return;
    void fetch(buildUrl(`/profiles/${encodeURIComponent(profileName)}/view`, characterId), {
      method: "POST",
      credentials: "include",
    }).catch(() => { /* swallow */ });
  }, [profileName, characterId, isSelf]);
}

function buildUrl(base: string, characterId: string | null): string {
  return characterId ? `${base}?characterId=${encodeURIComponent(characterId)}` : base;
}
