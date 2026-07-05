import { useEffect, useState } from "react";
import { Compass, Radio } from "lucide-react";
import { fetchPopularServers, type PopularServer } from "../lib/servers.js";
import { relTime } from "../lib/forums.js";
import { SPLASH_PANEL_HOVER } from "../lib/splashPanel.js";
import { useChat } from "../state/store.js";

/**
 * "Popular communities" band for the splash. Fetches the top public communities
 * (GET /servers/popular, anonymous-safe) and renders them as social-proof cards,
 * including The Spire itself (counted by its full membership). Renders NOTHING
 * when the fetch is empty or fails, so a cold-start / servers-off install never
 * shows an empty section. The parent only mounts this when servers are enabled.
 *
 * Cards route to /register: there's no anonymous per-community preview yet, so
 * the honest path for a logged-out visitor is to sign up and step inside.
 */
export function PopularCommunities({ onNavigate }: { onNavigate: (path: string) => void }) {
  const activityFeedsEnabled = useChat((s) => s.branding.activityFeedsEnabled);
  const siteName = useChat((s) => s.branding.siteName?.trim() || "The Spire");
  const [servers, setServers] = useState<PopularServer[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPopularServers().then((s) => {
      if (!cancelled) setServers(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function go(e: React.MouseEvent, path: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(path);
  }

  if (!servers || servers.length === 0) return null;

  return (
    <section
      aria-label={`Popular ${siteName} chat servers`}
      className={`rounded-md border border-keep-border/50 bg-keep-panel/30 p-5 sm:p-6 ${SPLASH_PANEL_HOVER}`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Compass className="h-5 w-5 shrink-0 text-keep-accent" aria-hidden />
        <h2 className="font-action text-xl text-keep-text sm:text-2xl">Popular {siteName} Chat Servers</h2>
      </div>
      <p className="mb-4 text-sm text-keep-text/85 lg:text-base">
        Places people are already gathering. Take a look inside.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {servers.map((s) => {
          const letter = (s.name.trim()[0] ?? "?").toUpperCase();
          // LIVE proof (B4): only when activity feeds are on AND the number is
          // truly > 0 (cold-start posture — never a dead "0 online"). Member
          // count is evergreen and always shows.
          const liveOnline =
            activityFeedsEnabled && typeof s.onlineCount === "number" && s.onlineCount > 0
              ? s.onlineCount
              : null;
          const lastPost = activityFeedsEnabled ? relTime(s.lastActivityAt ?? null) : null;
          return (
            <li key={s.slug}>
              <a
                href={`/s/${s.slug}`}
                onClick={(e) => go(e, `/s/${s.slug}`)}
                title={`Visit ${s.name}`}
                className="flex h-full items-center gap-3 rounded-md border border-keep-border/50 bg-keep-bg/40 p-3 transition hover:border-keep-accent/60 hover:bg-keep-bg/60"
              >
                {s.logoUrl ? (
                  <img
                    src={s.logoUrl}
                    alt=""
                    loading="lazy"
                    className="h-10 w-10 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <span
                    aria-hidden
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-keep-border/60 font-action text-lg text-keep-text"
                    style={{ background: s.iconColor ? `${s.iconColor}22` : "rgb(var(--keep-panel))" }}
                  >
                    {letter}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-semibold text-keep-text">{s.name}</span>
                    {s.isSystem ? (
                      <span className="shrink-0 rounded border border-keep-accent/40 px-1 text-[9px] font-semibold uppercase tracking-widest text-keep-accent">
                        Home
                      </span>
                    ) : null}
                  </span>
                  {s.tagline ? (
                    <span className="mt-0.5 line-clamp-1 text-xs text-keep-muted">{s.tagline}</span>
                  ) : null}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] uppercase tracking-widest text-keep-muted">
                    <span>
                      {s.memberCount.toLocaleString()} {s.memberCount === 1 ? "member" : "members"}
                    </span>
                    {liveOnline !== null ? (
                      <span className="inline-flex items-center gap-1 text-keep-action">
                        <Radio className="h-3 w-3" aria-hidden />
                        {liveOnline.toLocaleString()} online
                      </span>
                    ) : null}
                    {lastPost ? (
                      <span className="normal-case tracking-normal text-keep-muted/90">
                        Last post {lastPost}
                      </span>
                    ) : null}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
