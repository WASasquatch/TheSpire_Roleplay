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
import { Trans, useTranslation } from "react-i18next";
import { LogIn, Server, UserPlus, Users } from "lucide-react";
import { normalizeTheme } from "@thekeep/shared";
import { fetchPublicServer, type PublicServerLanding } from "../../lib/servers.js";
import { formatDate, formatNumber } from "../../lib/intlFormat.js";
import { DEFAULT_STYLE_KEY } from "../../lib/ornaments/index.js";
import {
  forumBannerInk,
  inkClass,
  isDarkSurface,
  themeStyle,
  useActiveTheme,
  useImageAverageColor,
  useScopedRootDesign,
} from "../../lib/theme.js";
import { sanitizeUserHtml, USER_HTML_SCOPE_CLASS } from "../../lib/userHtml.js";
import { useChat } from "../../state/store.js";
import { createPendingDestination } from "../../lib/pendingDestination.js";

const returnServer = createPendingDestination("spire:return-server");

/** localStorage key the authed boot consumes to enter the community after the
 *  login/registration round-trip. */
export const RETURN_SERVER_STORAGE_KEY = returnServer.storageKey;

/** Read the pending community destination (`{slug, name}`; a legacy plain-slug
 *  value still parses across a deploy). */
export const readReturnServer = returnServer.read;

export function ServerPublicLanding({ slug, onNavigate }: {
  slug: string;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation("servers");
  const branding = useChat((s) => s.branding);
  const siteName = branding.siteName || "The Spire";
  const [detail, setDetail] = useState<PublicServerLanding | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPublicServer(slug)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : t("shared.loadFailed")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    returnServer.write(slug, detail?.name ?? null);
    onNavigate(path);
  }

  if (err) {
    return (
      <div className="relative z-10 mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-3 px-4 text-center">
        <Server className="h-8 w-8 text-keep-muted" aria-hidden="true" />
        <p className="text-sm text-keep-text">
          {err === "not found" ? t("landing.notFound") : err}
        </p>
        <a href="/" className="text-xs uppercase tracking-widest text-keep-action hover:underline">
          {t("landing.toSite", { site: siteName })}
        </a>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="relative z-10 flex min-h-screen items-center justify-center">
        <p className="text-sm italic text-keep-muted">{t("landing.opening")}</p>
      </div>
    );
  }

  const isApplication = detail.joinMode === "application";
  const gateCopy = isApplication
    ? t("landing.gateApply", { site: siteName })
    : t("landing.gateOpen", { site: siteName });

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
                  <span><Trans t={t} i18nKey="landing.keptBy" values={{ name: detail.ownerUsername }} components={{ owner: <span className={bannerInk ? "" : inkClass.strong(heroDark)} style={bannerInk?.strong} /> }} /></span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3 w-3" aria-hidden="true" />
                  {detail.memberCount > 0 ? t("landing.members", { count: detail.memberCount, formatted: formatNumber(detail.memberCount) }) : t("landing.openToAll")}
                </span>
                <span>{t("landing.founded", { date: formatDate(detail.createdAt, { year: "numeric", month: "long", day: "numeric" }) })}</span>
              </p>
            </div>
          </div>
        </header>

        {/* CALL TO ACTION — the entrance. */}
        <div className="border-b border-keep-rule bg-keep-action/10 px-5 py-5 md:px-10">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="font-action text-lg text-keep-text md:text-xl">
                {isApplication ? t("landing.ctaApplyTitle") : t("landing.ctaOpenTitle")}
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
                {isApplication ? t("landing.registerToApply") : t("landing.createAccount")}
              </button>
              <button
                type="button"
                onClick={() => go("/login")}
                className="flex items-center gap-2 rounded border border-keep-action bg-keep-action/15 px-4 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/25"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                {t("landing.logIn")}
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
            <span>{t("landing.membershipLabel")}<span className="text-keep-text">{isApplication ? t("landing.byApplication") : t("landing.openToAll")}</span></span>
            {detail.ownerUsername ? <span>{t("landing.ownerLabel")}<span className="text-keep-text">{detail.ownerUsername}</span></span> : null}
            <span>{t("landing.foundedLabel")}<span className="text-keep-text">{formatDate(detail.createdAt)}</span></span>
            <span className="ml-auto"><Trans t={t} i18nKey="landing.hostedBy" values={{ site: siteName }} components={{ site: <span className="text-keep-text" /> }} /></span>
          </div>
        </footer>
      </article>
    </div>
  );
}
