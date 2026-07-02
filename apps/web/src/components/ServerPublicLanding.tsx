/**
 * Anonymous landing for `/s/<slug>` — the shareable public face of a community
 * for visitors without a session (mirrors {@link ForumPublicLanding}). Before
 * this, a shared community link dead-ended on the login form; now a logged-out
 * visitor gets the community's banner/logo/name/tagline, its description, and a
 * clear join/login entrance, with the community's own theme applied to the card.
 *
 * The chosen destination is remembered in localStorage; after the login/register
 * round-trip the authed boot reads {@link readReturnServer} and enters the
 * community the link promised.
 */
import { useEffect, useMemo, useState } from "react";
import { LogIn, Server, UserPlus, Users } from "lucide-react";
import { normalizeTheme } from "@thekeep/shared";
import { fetchPublicServer, type PublicServerLanding } from "../lib/servers.js";
import { DEFAULT_STYLE_KEY } from "../lib/ornaments/index.js";
import {
  forumBannerInk,
  inkClass,
  isDarkSurface,
  themeStyle,
  useActiveTheme,
  useImageAverageColor,
  useScopedRootDesign,
} from "../lib/theme.js";
import { sanitizeUserHtml, USER_HTML_SCOPE_CLASS } from "../lib/userHtml.js";
import { useChat } from "../state/store.js";

/** localStorage key the authed boot consumes to enter the community after the
 *  login/registration round-trip. */
export const RETURN_SERVER_STORAGE_KEY = "spire:return-server";

/** Read the pending community destination (`{slug, name}`; a legacy plain-slug
 *  value still parses across a deploy). */
export function readReturnServer(): { slug: string; name: string | null } | null {
  try {
    const raw = window.localStorage.getItem(RETURN_SERVER_STORAGE_KEY);
    if (!raw) return null;
    if (raw.startsWith("{")) {
      const j = JSON.parse(raw) as { slug?: string; name?: string };
      return j.slug ? { slug: j.slug, name: j.name ?? null } : null;
    }
    return { slug: raw, name: null };
  } catch {
    return null;
  }
}

export function ServerPublicLanding({ slug, onNavigate }: {
  slug: string;
  onNavigate: (path: string) => void;
}) {
  const branding = useChat((s) => s.branding);
  const siteName = branding.siteName || "The Spire";
  const [detail, setDetail] = useState<PublicServerLanding | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPublicServer(slug)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "load failed"); });
    return () => { alive = false; };
  }, [slug]);

  const serverTheme = useMemo(() => {
    if (!detail?.themeJson) return null;
    try { return normalizeTheme(JSON.parse(detail.themeJson)); } catch { return null; }
  }, [detail?.themeJson]);
  const activeTheme = useActiveTheme();
  // The community's design (glass/medieval/…) at the ROOT while this page is up
  // (designs can't be subtree-scoped); site-default when unset.
  useScopedRootDesign(
    serverTheme ?? activeTheme,
    detail ? detail.themeStyleKey ?? DEFAULT_STYLE_KEY : null,
    !!detail,
    activeTheme,
  );

  const descriptionHtml = useMemo(
    () => (detail?.descriptionHtml ? sanitizeUserHtml(detail.descriptionHtml) : null),
    [detail?.descriptionHtml],
  );
  // Must run before the early returns (Rules of Hooks): sample the banner for
  // legible hero ink over the image.
  const bannerColor = useImageAverageColor(detail?.bannerImageUrl ?? null);

  function go(path: "/login" | "/register") {
    try {
      window.localStorage.setItem(
        RETURN_SERVER_STORAGE_KEY,
        JSON.stringify({ slug, name: detail?.name ?? null }),
      );
    } catch { /* private mode — the visitor just lands in chat instead */ }
    onNavigate(path);
  }

  if (err) {
    return (
      <div className="relative z-10 mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-3 px-4 text-center">
        <Server className="h-8 w-8 text-keep-muted" aria-hidden="true" />
        <p className="text-sm text-keep-text">
          {err === "not found" ? "That community is private or no longer exists." : err}
        </p>
        <a href="/" className="text-xs uppercase tracking-widest text-keep-action hover:underline">
          To {siteName}
        </a>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="relative z-10 flex min-h-screen items-center justify-center">
        <p className="text-sm italic text-keep-muted">Opening the community…</p>
      </div>
    );
  }

  const isApplication = detail.joinMode === "application";
  const gateCopy = isApplication
    ? `This community accepts new members by application. Create a free ${siteName} account, then apply to join.`
    : `Create a free ${siteName} account to step into this community's rooms and forums.`;

  const hasBanner = !!detail.bannerImageUrl;
  const heroPalette = serverTheme ?? activeTheme;
  const heroDark = isDarkSurface(heroPalette, { imageOverlay: hasBanner });
  const bannerInk = hasBanner ? forumBannerInk(heroPalette, bannerColor) : null;

  return (
    <div className="relative z-10 mx-auto min-h-screen w-full px-0 py-0 md:px-6 md:py-8 lg:w-[min(100%,max(82vw,80rem))]">
      <article
        className="keep-frame overflow-hidden border-y border-keep-rule bg-keep-bg text-keep-text shadow-2xl md:rounded-lg md:border"
        style={serverTheme ? themeStyle(serverTheme) : undefined}
      >
        {/* HERO — the community's marquee, the first impression a share link
            makes. Banner image (or banner tint) behind the identity block. */}
        <header
          className="relative border-b border-keep-rule bg-keep-banner/40 px-5 py-8 md:px-10 md:py-14"
          style={detail.bannerImageUrl ? {
            backgroundImage: `url(${detail.bannerImageUrl})`,
            backgroundSize: "cover",
            backgroundPosition: `center ${detail.bannerFocusY ?? 50}%`,
          } : undefined}
        >
          <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:gap-6">
            {detail.logoUrl ? (
              <img src={detail.logoUrl} alt="" className="h-16 w-16 shrink-0 rounded object-cover drop-shadow-lg md:h-24 md:w-24" />
            ) : (
              <span
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded border border-keep-rule bg-keep-bg/60 shadow-lg md:h-24 md:w-24"
                style={detail.iconColor ? { background: `${detail.iconColor}22` } : undefined}
              >
                <Server className="h-8 w-8 text-keep-accent md:h-12 md:w-12" aria-hidden="true" />
              </span>
            )}
            <div className="min-w-0">
              <h1
                className={`break-words font-action text-3xl md:text-5xl ${bannerInk ? "" : inkClass.title(heroDark)}`}
                style={bannerInk?.title}
              >{detail.name}</h1>
              {detail.tagline ? (
                <p
                  className={`mt-1 text-sm md:text-lg ${bannerInk ? "" : inkClass.sub(heroDark)}`}
                  style={bannerInk?.sub}
                >{detail.tagline}</p>
              ) : null}
              <p
                className={`mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] md:text-xs ${bannerInk ? "" : inkClass.meta(heroDark)}`}
                style={bannerInk?.meta}
              >
                {detail.ownerUsername ? (
                  <span>kept by <span className={bannerInk ? "" : inkClass.strong(heroDark)} style={bannerInk?.strong}>{detail.ownerUsername}</span></span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3 w-3" aria-hidden="true" />
                  {detail.memberCount > 0 ? `${detail.memberCount.toLocaleString()} member${detail.memberCount === 1 ? "" : "s"}` : "open to all"}
                </span>
                <span>founded {new Date(detail.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</span>
              </p>
            </div>
          </div>
        </header>

        {/* CALL TO ACTION — the entrance. */}
        <div className="border-b border-keep-rule bg-keep-action/10 px-5 py-5 md:px-10">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="font-action text-lg text-keep-text md:text-xl">
                {isApplication ? "Apply to join this community" : "Step inside"}
              </p>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-keep-muted md:text-sm">{gateCopy}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => go("/register")}
                className="flex items-center gap-2 rounded border border-keep-action bg-keep-action px-5 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-bg shadow-lg transition-transform hover:scale-[1.03]"
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                {isApplication ? "Register to apply" : "Create your account"}
              </button>
              <button
                type="button"
                onClick={() => go("/login")}
                className="flex items-center gap-2 rounded border border-keep-action bg-keep-action/15 px-4 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/25"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                Log in
              </button>
            </div>
          </div>
        </div>

        {descriptionHtml ? (
          <div
            className={`border-b border-keep-rule px-5 py-5 text-sm leading-relaxed md:px-8 ${USER_HTML_SCOPE_CLASS}`}
            dangerouslySetInnerHTML={{ __html: descriptionHtml }}
          />
        ) : null}

        <footer className="border-t border-keep-rule bg-keep-banner/30 px-5 py-3 text-[11px] text-keep-muted md:px-8">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
            <span>Membership: <span className="text-keep-text">{isApplication ? "by application" : "open to all"}</span></span>
            {detail.ownerUsername ? <span>Owner: <span className="text-keep-text">{detail.ownerUsername}</span></span> : null}
            <span>Founded: <span className="text-keep-text">{new Date(detail.createdAt).toLocaleDateString()}</span></span>
            <span className="ml-auto">Hosted by <span className="text-keep-text">{siteName}</span></span>
          </div>
        </footer>
      </article>
    </div>
  );
}
