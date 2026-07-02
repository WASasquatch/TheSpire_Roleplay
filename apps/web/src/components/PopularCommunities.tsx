import { useEffect, useState } from "react";
import { Compass } from "lucide-react";
import { fetchPopularServers, type PopularServer } from "../lib/servers.js";
import { SPLASH_PANEL_HOVER } from "../lib/splashPanel.js";

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
      aria-label="Popular communities"
      className={`rounded-md border border-keep-border/50 bg-keep-panel/30 p-5 sm:p-6 ${SPLASH_PANEL_HOVER}`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Compass className="h-5 w-5 shrink-0 text-keep-accent" aria-hidden />
        <h2 className="font-action text-xl text-keep-text sm:text-2xl">Popular communities</h2>
      </div>
      <p className="mb-4 text-sm text-keep-text/85 lg:text-base">
        Places people are already gathering. Take a look inside.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {servers.map((s) => {
          const letter = (s.name.trim()[0] ?? "?").toUpperCase();
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
                  <span className="mt-0.5 block text-[11px] uppercase tracking-widest text-keep-muted">
                    {s.memberCount.toLocaleString()} {s.memberCount === 1 ? "member" : "members"}
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
