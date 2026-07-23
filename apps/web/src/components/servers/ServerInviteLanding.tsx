/**
 * Branded landing for `/i/<code>` — a server invite link's public face
 * (mirrors {@link ServerPublicLanding}, the `/s/<slug>` page). Renders for
 * BOTH audiences:
 *
 *   - anonymous visitors get the community's banner/logo/name/description
 *     with "Create account" / "Sign in and join" CTAs; the code is remembered
 *     in localStorage and threads through registration (the register POST
 *     carries `inviteCode`) or is redeemed by the authed boot after login;
 *   - signed-in visitors (App mounts this over the chat shell) get a
 *     one-click "Join" — or "Enter" when they already belong.
 *
 * Dead codes — and archived / moderated servers, which the API folds into the
 * same uniform 404 — render a graceful "invite invalid or expired" state.
 * 18+ communities arrive with their public-safe banner (or none) from the
 * API; the page states "18+ community" plainly instead of leaking art.
 */
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowRight, BookOpen, LogIn, MailX, Server, UserPlus, Users } from "lucide-react";
import { normalizeTheme } from "@thekeep/shared";
import { fetchServerInvite, joinServerInvite, type PublicServerInvite } from "../../lib/servers.js";
import { formatDate, formatNumber } from "../../lib/intlFormat.js";
import { DEFAULT_STYLE_KEY } from "../../lib/ornaments/index.js";
import {
  backgroundArtCss,
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

// Unlike the read-only forum/community return slots, redeeming this one
// MUTATES membership on the next authed boot — a stale code from an
// abandoned login weeks ago must not silently auto-join, so it expires.
const PENDING_INVITE_MAX_AGE_MS = 60 * 60 * 1000;

const pendingInvite = createPendingDestination("spire:invite", { maxAgeMs: PENDING_INVITE_MAX_AGE_MS });

/** localStorage key the authed boot + register form consume. The stored
 *  `{slug, name}` shape holds the CODE in the slug field. */
export const PENDING_INVITE_STORAGE_KEY = pendingInvite.storageKey;

/** Read the pending invite (`{slug: code, name}`), or null. */
export const readPendingInvite = pendingInvite.read;

/** Remember an invite code before sending the visitor through auth. */
export const writePendingInvite = pendingInvite.write;

/** Drop the pending invite (consumed, or explicitly abandoned). */
export function clearPendingInvite(): void {
  try { window.localStorage.removeItem(PENDING_INVITE_STORAGE_KEY); } catch { /* private mode */ }
}

export function ServerInviteLanding({ code, onNavigate, authed }: {
  code: string;
  onNavigate: (path: string) => void;
  /** Present when a session exists: the page swaps its register/login CTAs
   *  for a one-click join. `alreadyMember` flips the label to "Enter". */
  authed?: {
    alreadyMember: (serverId: string) => boolean;
    onEntered: (serverId: string, name: string) => void;
    onDismiss: () => void;
  };
}) {
  const { t } = useTranslation("servers");
  const branding = useChat((s) => s.branding);
  const siteName = branding.siteName || "The Spire";
  const [detail, setDetail] = useState<PublicServerInvite | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchServerInvite(code)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : t("shared.loadFailed")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const serverTheme = useMemo(() => {
    if (!detail?.themeJson) return null;
    try { return normalizeTheme(JSON.parse(detail.themeJson)); } catch { return null; }
  }, [detail?.themeJson]);
  const activeTheme = useActiveTheme();
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
  const bannerColor = useImageAverageColor(detail?.bannerImageUrl ?? null);

  function go(path: "/login" | "/register") {
    // Thread the invite through the auth round-trip: the register POST sends
    // it as `inviteCode`; a plain login redeems it from the authed boot.
    writePendingInvite(code, detail?.name ?? null);
    onNavigate(path);
  }

  async function joinNow() {
    if (!authed || !detail || joining) return;
    setJoining(true);
    setJoinErr(null);
    try {
      const res = await joinServerInvite(code);
      authed.onEntered(res.serverId, res.name);
    } catch (e) {
      setJoinErr(e instanceof Error ? e.message : t("shared.loadFailed"));
    } finally {
      setJoining(false);
    }
  }

  if (err) {
    // Graceful dead-invite state: expired, revoked, spent, or a community
    // that is no longer open — one honest message for all of them.
    return (
      <div className="relative z-10 mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-3 px-4 text-center">
        <MailX className="h-8 w-8 text-keep-muted" aria-hidden="true" />
        <p className="font-action text-lg text-keep-text">{t("inviteLanding.invalidTitle")}</p>
        <p className="max-w-md text-sm text-keep-muted">
          {err === "not found" ? t("inviteLanding.invalidBody") : err}
        </p>
        {authed ? (
          <button
            type="button"
            onClick={authed.onDismiss}
            className="text-xs uppercase tracking-widest text-keep-action hover:underline"
          >
            {t("landing.toSite", { site: siteName })}
          </button>
        ) : (
          <a href="/" className="text-xs uppercase tracking-widest text-keep-action hover:underline">
            {t("landing.toSite", { site: siteName })}
          </a>
        )}
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
  const isMember = !!authed && !!detail && authed.alreadyMember(inviteServerKey(detail));
  const hasBanner = !!detail.bannerImageUrl;
  const heroPalette = serverTheme ?? activeTheme;
  const heroDark = isDarkSurface(heroPalette, { imageOverlay: hasBanner });
  const bannerInk = hasBanner ? forumBannerInk(heroPalette, bannerColor) : null;

  return (
    <>
      {/* Owner-uploaded background art (migration 0368) — same fixed
          backdrop treatment as the /s/<slug> landing; the payload drops
          it for 18+ communities so nothing NSFW-adjacent reaches an
          anonymous invite page. */}
      {detail.background ? (
        <div
          aria-hidden
          className="fixed inset-0 z-0 bg-cover bg-center"
          style={{
            backgroundColor: detail.background.color,
            backgroundImage: backgroundArtCss(detail.background),
          }}
        >
          <div className="absolute inset-0 bg-keep-bg/50" />
        </div>
      ) : null}
    <div className="relative z-10 mx-auto min-h-screen w-full px-0 py-0 md:px-6 md:py-8 lg:w-[min(100%,max(82vw,80rem))]">
      <article
        className="keep-frame overflow-hidden border-y border-keep-rule bg-keep-bg text-keep-text shadow-2xl md:rounded-lg md:border"
        style={serverTheme ? themeStyle(serverTheme) : undefined}
      >
        {/* HERO — identical marquee to the /s/<slug> landing. */}
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
              <p
                className={`text-[11px] font-semibold uppercase tracking-[0.25em] md:text-xs ${bannerInk ? "" : inkClass.meta(heroDark)}`}
                style={bannerInk?.meta}
              >
                {t("inviteLanding.kicker")}
              </p>
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
                {detail.isNsfw ? (
                  <span className="inline-flex items-center rounded border border-[#e06070] bg-[#e06070]/20 px-1.5 py-0.5 font-bold uppercase leading-none tracking-widest text-[#e06070]">
                    {t("inviteLanding.adultChip")}
                  </span>
                ) : null}
              </p>
            </div>
          </div>
        </header>

        {/* CALL TO ACTION — the entrance the invite promises. */}
        <div className="border-b border-keep-rule bg-keep-action/10 px-5 py-5 md:px-10">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="font-action text-lg text-keep-text md:text-xl">
                {isMember
                  ? t("inviteLanding.ctaMemberTitle")
                  : t("inviteLanding.ctaTitle", { name: detail.name })}
              </p>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-keep-muted md:text-sm">
                {isMember
                  ? t("inviteLanding.ctaMemberBody")
                  : isApplication
                    ? authed
                      ? t("inviteLanding.ctaApplicationAuthedBody")
                      : t("inviteLanding.ctaApplicationBody", { site: siteName })
                    : authed
                      ? t("inviteLanding.ctaAuthedBody")
                      : t("inviteLanding.ctaAnonBody", { site: siteName })}
              </p>
              {detail.isNsfw ? (
                <p className="mt-1 text-xs font-semibold text-[#e06070]">{t("inviteLanding.adultNote")}</p>
              ) : null}
              {joinErr ? (
                <p className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-text">{joinErr}</p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2.5">
              {authed ? (
                <>
                  {isApplication && !isMember ? (
                    /* A join POST can only 409 here (codes never bypass the
                       application queue) — route to the community's page,
                       where the apply flow lives, instead. */
                    <a
                      href={`/s/${encodeURIComponent(detail.slug)}`}
                      className="flex items-center gap-2 rounded border border-keep-action bg-keep-action px-5 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-bg no-underline shadow-lg transition-transform hover:scale-[1.03]"
                    >
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      {t("inviteLanding.openCommunityPage")}
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void joinNow()}
                      disabled={joining}
                      className="flex items-center gap-2 rounded border border-keep-action bg-keep-action px-5 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-bg shadow-lg transition-transform hover:scale-[1.03] disabled:opacity-60"
                    >
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      {joining
                        ? isMember
                          ? t("landing.opening")
                          : t("inviteLanding.joining")
                        : isMember
                          ? t("inviteLanding.enter")
                          : t("inviteLanding.join", { name: detail.name })}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={authed.onDismiss}
                    className="flex items-center gap-2 rounded border border-keep-rule bg-keep-bg/60 px-4 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-muted hover:text-keep-text"
                  >
                    {t("inviteLanding.notNow")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => go("/register")}
                    className="flex items-center gap-2 rounded border border-keep-action bg-keep-action px-5 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-bg shadow-lg transition-transform hover:scale-[1.03]"
                  >
                    <UserPlus className="h-4 w-4" aria-hidden="true" />
                    {t("landing.createAccount")}
                  </button>
                  <button
                    type="button"
                    onClick={() => go("/login")}
                    className="flex items-center gap-2 rounded border border-keep-action bg-keep-action/15 px-4 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/25"
                  >
                    <LogIn className="h-4 w-4" aria-hidden="true" />
                    {t("inviteLanding.signInAndJoin")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {descriptionHtml ? (
          <div
            className={`border-b border-keep-rule px-5 py-5 text-sm leading-relaxed md:px-8 ${USER_HTML_SCOPE_CLASS}`}
            dangerouslySetInnerHTML={{ __html: descriptionHtml }}
          />
        ) : null}

        {/* WORLD — readable lore, only ever present when publicly viewable
            (resolved through the world's own gates for anonymous viewers). */}
        {detail.world ? (
          <div className="border-b border-keep-rule px-5 py-5 md:px-8">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">{t("landing.worldTitle")}</p>
            <a
              href={`/w/${encodeURIComponent(detail.world.slug)}`}
              className="group flex items-center gap-3 rounded border border-keep-rule bg-keep-panel/30 p-3 no-underline hover:border-keep-action"
            >
              <BookOpen className="h-6 w-6 shrink-0 text-keep-accent" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-keep-text group-hover:text-keep-action">{detail.world.name}</span>
                <span className="block text-xs text-keep-muted">{t("landing.worldHint")}</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-keep-muted group-hover:text-keep-action" aria-hidden="true" />
            </a>
          </div>
        ) : null}

        <footer className="border-t border-keep-rule bg-keep-banner/30 px-5 py-3 text-[11px] text-keep-muted md:px-8">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
            <span>{t("landing.membershipLabel")}<span className="text-keep-text">{isApplication ? t("landing.byApplication") : t("inviteLanding.byInvitation")}</span></span>
            {detail.ownerUsername ? <span>{t("landing.ownerLabel")}<span className="text-keep-text">{detail.ownerUsername}</span></span> : null}
            <span>{t("landing.foundedLabel")}<span className="text-keep-text">{formatDate(detail.createdAt)}</span></span>
            <span className="ml-auto"><Trans t={t} i18nKey="landing.hostedBy" values={{ site: siteName }} components={{ site: <span className="text-keep-text" /> }} /></span>
          </div>
        </footer>
      </article>
    </div>
    </>
  );
}

/** The invite payload has no server id (anonymous wire); membership checks
 *  key on the slug, which the authed caller's catalog also carries. */
function inviteServerKey(detail: PublicServerInvite): string {
  return detail.slug;
}
