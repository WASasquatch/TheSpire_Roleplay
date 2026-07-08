import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { AvatarCrop } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { useEarning } from "../state/earning.js";
import { disconnect } from "../lib/socket.js";
import { clearSessionToken } from "../lib/http.js";
import { cropStyleFor } from "../lib/avatarCrop.js";
import { useStoryInviteCount } from "../lib/storyInvites.js";
import { navigateToFaqIndex } from "../lib/faqUrl.js";
import { useReducedMotion } from "../lib/reducedMotion.js";
import { ConnectionOrb } from "./chat/ConnectionOrb.js";

/** True at Tailwind's `lg` breakpoint (>=1024px). Drives desktop-vs-mobile
 *  banner behavior: desktop always shows the server banner; mobile defaults to
 *  the collapsed horizontal bar and reveals the banner on tap. */
function useIsLgUp(): boolean {
  const [lg, setLg] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setLg(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return lg;
}

interface NavLinkRow {
  id: string;
  label: string;
  href: string;
  target: "_self" | "_blank";
  position: number;
  enabled: boolean;
}

interface Props {
  /** Bumped by AdminPanel after editing links so the banner re-fetches. */
  navLinksVersion: number;
  onOpenAdmin?: () => void;
  onOpenRules: () => void;
  /** Opens the Earning dashboard modal. */
  onOpenEarning: () => void;
  /** Opens the Scriptorium catalog. Signed-in only, anonymous splash
   *  visitors can browse via FeaturedStoriesStrip + the `/stories/...`
   *  shareable links instead. */
  onOpenScriptorium: () => void;
  onOpenWorlds: () => void;
  /** Opens the Staff directory modal. */
  onOpenStaff: () => void;
  /** Opens the Roleplay Communities (affiliates) portal so members can manage
   *  their listings and copy their link-backs. Signed-in only, matching the
   *  other member-facing nav entries. */
  onOpenAffiliates: () => void;
  /** Opens the Spire Arcade launcher. Permission-gated by the parent;
   *  the link only renders when the viewer holds `use_arcade`. */
  onOpenArcade: () => void;
  /** Multi-Server Lift: when the viewer is inside a NON-home server, its
   *  identity (name / round icon / banner) rebrands this top bar. Null on the
   *  home server or with the servers feature off (byte-identical to today). */
  serverBrand?: {
    name: string;
    logoUrl: string | null;
    /** Wide "wordmark" logo. When set it REPLACES the app wordmark on the
     *  left of the bar, so members read which server they're in at a glance. */
    horizontalLogoUrl: string | null;
    bannerImageUrl: string | null;
    bannerCoverCss: string | null;
    bannerFocusY: number | null;
    /** Pan/zoom crop applied to bannerImageUrl (same renderer as avatars). */
    bannerCrop: AvatarCrop | null;
    /** Owner-set banner band height in px. Null ⇒ the default responsive height. */
    bannerHeight: number | null;
  } | null;
  /** Open the CURRENT server's owner/mod console (the per-server admin). Passed
   *  ONLY when the viewer can manage the server they're in, so the nav shows a
   *  prominent "Server Admin" link — the primary path to the console, replacing
   *  reliance on the small gear on the rail icon. */
  onOpenServerAdmin?: () => void;
  /** Notification Center bell, rendered into the top-bar icon cluster (next to
   *  the connection orb) on both desktop and mobile. Passed from App so the
   *  deep-link navigation stays there. */
  notificationBell?: ReactNode;
}

/**
 * Top banner.
 *
 * Layout: title on the left; admin-managed links + Admin (admin-only) + Exit
 * on the right. Exit is hard-coded - admins can't delete the logout path.
 *
 * The banner background, logo color, and logo font are all driven by the
 * admin-configured site branding (see /admin/settings). Each falls back to
 * the active theme's panel color / text color / font-action stack when not
 * overridden, so a fresh install still looks coherent.
 */
export function Banner({ navLinksVersion, onOpenAdmin, onOpenRules, onOpenEarning, onOpenScriptorium, onOpenWorlds, onOpenArcade, onOpenStaff, onOpenAffiliates, serverBrand, onOpenServerAdmin, notificationBell }: Props) {
  const me = useChat((s) => s.me);
  const setMe = useChat((s) => s.setMe);
  const branding = useChat((s) => s.branding);
  // Earning indicator dot, small marker next to the link when the
  // user has unacknowledged rank-up notifications. Reads from the
  // store directly so it stays live with `earning:rankup` socket
  // events without prop drilling.
  const earningHasNew = useEarning((s) => s.unackRankUps.length > 0);
  // Pending Scriptorium invite count, surfaces a small dot on the
  // Scriptorium nav entry so the recipient sees it without opening
  // the catalog. The hook itself always runs (Rules of Hooks); the
  // value is only surfaced in the UI when signed in.
  const storyInviteCount = useStoryInviteCount();
  const [links, setLinks] = useState<NavLinkRow[]>([]);
  // Mobile-only dropdown state. The desktop inline nav is always
  // rendered; this just toggles a hamburger panel that mirrors the
  // links on narrow screens where the inline strip would overflow or
  // crowd the brand.
  const [menuOpen, setMenuOpen] = useState(false);
  // Admin-managed custom links live behind a single "More" dropdown
  // on desktop so the nav row doesn't grow unbounded with each new
  // admin-added link. Mobile mirrors the pattern as a collapsible
  // section inside the hamburger panel.
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  // Calm-mode ease: the "More" popover and the mobile hamburger panel both
  // open BELOW their trigger (top-full), pure CSS positioned, so they slide
  // down gently. Reduce Motion only; OFF keeps the instant snap.
  const reduceMotion = useReducedMotion();
  const isLgUp = useIsLgUp();
  // The server banner can be COLLAPSED to a horizontal bar on BOTH breakpoints.
  // The collapsed/expanded choice is REMEMBERED PER SERVER (localStorage, per
  // device): collapse a server's banner and it stays collapsed for THAT server
  // across visits and reloads. With no saved choice yet, it follows the
  // breakpoint default (desktop opens, mobile collapses) and keeps following it
  // on resize. The bar/chevron toggles the state and saves it for this server.
  const currentServerId = useChat((s) => s.currentServerId);
  const bannerPrefKey = `bannerOpen:${currentServerId ?? "home"}`;
  const [bannerOpen, setBannerOpen] = useState<boolean>(() => {
    try {
      const v = window.localStorage.getItem(bannerPrefKey);
      if (v != null) return v === "1";
    } catch { /* private mode / no storage */ }
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(min-width: 1024px)").matches;
  });
  useEffect(() => {
    let saved: boolean | null = null;
    try {
      const v = window.localStorage.getItem(bannerPrefKey);
      saved = v == null ? null : v === "1";
    } catch { /* private mode / no storage */ }
    setBannerOpen(saved ?? isLgUp);
  }, [bannerPrefKey, isLgUp]);
  const toggleBanner = () => {
    setBannerOpen((o) => {
      const next = !o;
      try { window.localStorage.setItem(bannerPrefKey, next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/nav-links", { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<{ links: NavLinkRow[] }>) : { links: [] }))
      .then((j) => {
        if (!cancelled) setLinks(j.links);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [navLinksVersion]);

  // Esc closes the dropdown when it's open. Listener only registered
  // while open so global keydown behavior stays untouched otherwise.
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Desktop "More" dropdown closes on Esc or outside-click. Same
  // pattern as the mobile hamburger but scoped to a popover, so a
  // tap on any other nav button or the chat feed dismisses it.
  useEffect(() => {
    if (!moreOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t && t.closest("[data-nav-more]")) return;
      setMoreOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDocClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDocClick);
    };
  }, [moreOpen]);

  async function logout() {
    try {
      // The fetch monkey-patch (lib/http) attaches the current bearer
      // token, so the server can identify and delete this tab's session
      // row. Best-effort: a network failure shouldn't leave us
      // half-logged-out, so we proceed with the local cleanup either way.
      await fetch("/auth/logout", { method: "POST" });
    } catch { /* best-effort */ }
    // Clear in this order: token → socket → me. Socket disconnect
    // races against the React re-render that hides the chat shell;
    // clearing the token first guarantees that any in-flight fetch
    // started before this handler ran can't accidentally re-authenticate
    // the now-deleted server-side session row by piggybacking the old
    // token.
    clearSessionToken();
    // Pass `intentional: true` so the socket emits `me:exit` before
    // tearing down. Server reads that flag in the disconnect handler
    // and fires the "X has disconnected." chat broadcast. Without the
    // flag the disconnect stays silent (mobile suspend, tab close,
    // network drop all look identical otherwise).
    disconnect(true);
    // Land on the splash, not the login form. UnauthRouter renders
    // SplashLanding only when pathname is "/"; after a login from
    // /login (or /register) the URL stays there, so without this the
    // exit would drop the user back onto the auth form they came in
    // through. Use replaceState so the back button doesn't return to
    // the now-logged-out app shell.
    if (window.location.pathname !== "/") {
      window.history.replaceState(null, "", "/");
    }
    setMe(null);
  }

  // Header background. Inside a server (serverBrand set, including the home
  // server when the flag is on) that server's banner takes over the top bar.
  //
  // Three render paths, in priority order:
  //   1. bannerImageUrl  → painted as an absolutely-positioned <img> behind the
  //      content so the pan/zoom CROP (cropStyleFor) applies, not just a focal
  //      point. A dark scrim then sits over the art for legibility. The bar
  //      grows taller in this mode so the banner art has room to read.
  //   2. bannerCoverCss  → a flat CSS background on the <header> (gradients /
  //      solid brand color); also taller, scrim optional but harmless.
  //   3. neither         → today's bar exactly (theme panel fallback class).
  //
  // On the home server with the flag OFF, serverBrand is null and we keep the
  // admin-configured site banner background exactly as before. `hasBg` decides
  // whether to keep the theme's panel fallback class.
  const serverBannerImg = serverBrand?.bannerImageUrl ?? null;
  // Whether THIS server's brand HAS a banner (image or css). A null serverBrand
  // (flag off) never has one, so the flag-off bar stays byte-identical to today.
  const hasServerBanner = !!serverBrand && (!!serverBannerImg || !!serverBrand.bannerCoverCss);
  // Whether the banner is currently SHOWN (tall, art visible, logo scaled up).
  // Desktop: always, when the server has one. Mobile: only once the viewer taps
  // the bar open. Drives the tall layout, the art, and the logo scaling.
  const bannerShown = hasServerBanner && bannerOpen;

  const headerStyle: CSSProperties = {};
  let hasBg = false;
  if (serverBrand) {
    // Server banner art only paints while SHOWN; collapsed reverts to the plain
    // theme bar (bg-keep-banner class below).
    if (serverBannerImg && bannerShown) {
      // Painted by the <img> layer; the header stays transparent so the cropped
      // art shows through. `hasBg` still set so the theme panel class is dropped.
      hasBg = true;
    } else if (serverBrand.bannerCoverCss && bannerShown) {
      headerStyle.background = serverBrand.bannerCoverCss;
      hasBg = true;
    }
  } else if (branding.bannerCoverCss) {
    headerStyle.background = branding.bannerCoverCss;
    hasBg = true;
  }

  // Banner height: collapsed bar vs the (owner-set, 48-240px; default 96px) tall
  // banner. Animating min-height between the two drives the mobile open/close
  // slide. Set only when the server has a banner; otherwise the bar keeps its
  // natural height (today's exact shell).
  const BANNER_BAR_PX = 56; // collapsed horizontal-bar height
  const BANNER_MAX_PX = 240; // matches the owner slider's max
  const expandedBannerPx = serverBrand?.bannerHeight ?? 96;
  if (hasServerBanner) {
    headerStyle.minHeight = bannerShown ? expandedBannerPx : BANNER_BAR_PX;
  }
  // Logo/wordmark scales WITH the banner height: at the 240px max it's 6rem tall
  // with a 2rem left margin; smaller banners scale both down proportionally.
  // Collapsed (no scale applied) falls back to the existing mobile logo size.
  const bannerScale = Math.min(1, expandedBannerPx / BANNER_MAX_PX);
  const logoMaxHeightRem = 6 * bannerScale;
  const logoMarginLeftRem = 2 * bannerScale;
  const logoFontSizeRem = Math.max(1.25, logoMaxHeightRem * 0.6);

  // The logo area shows the current server's identity inside a server, else the
  // global site logo/name. logoColor/font stay the site's. When the server has
  // a WIDE wordmark (horizontalLogoUrl) it wins over the round logo + name so
  // the taller bar reads as that server's brand; otherwise we fall back to the
  // round logo, then the server/site name text.
  const effectiveLogo = serverBrand
    ? { logoUrl: serverBrand.logoUrl ?? "", siteName: serverBrand.name, horizontalLogoUrl: serverBrand.horizontalLogoUrl }
    : { logoUrl: branding.logoUrl, siteName: branding.siteName, horizontalLogoUrl: null as string | null };

  // Logo color/font come from branding too; the explicit empty string for
  // logoFont reverts to font-action's stack since the wrapper class still
  // applies. (Tailwind's `font-action` resolves to its CSS var fallback.)
  const logoStyle: CSSProperties = {};
  if (branding.logoColor) logoStyle.color = branding.logoColor;
  if (branding.logoFont) logoStyle.fontFamily = branding.logoFont;

  // Click handlers that fire the action then close the mobile dropdown.
  // Dropdown stays alive past the click on desktop (it isn't rendered
  // there), so these no-op the close on md+, the inline nav doesn't
  // need it.
  function fireRules() { onOpenRules(); setMenuOpen(false); }
  function fireAdmin() { if (onOpenAdmin) onOpenAdmin(); setMenuOpen(false); }
  function fireEarning() { onOpenEarning(); setMenuOpen(false); }
  function fireScriptorium() { onOpenScriptorium(); setMenuOpen(false); }
  function fireWorlds() { onOpenWorlds(); setMenuOpen(false); }
  function fireArcade() { onOpenArcade(); setMenuOpen(false); }
  function fireStaff() { onOpenStaff(); setMenuOpen(false); }
  function fireAffiliates() { onOpenAffiliates(); setMenuOpen(false); }
  function fireLogout() { setMenuOpen(false); void logout(); }

  // Arcade is auth-gated AND permission-gated, the launcher itself 403s
  // without `use_arcade`, so the nav entry stays hidden rather than
  // teasing a surface the viewer can't open.
  const canArcade = !!me?.permissions.includes("use_arcade");

  return (
    <header
      style={headerStyle}
      className={`keep-app-banner relative z-30 flex justify-between border-b border-keep-rule px-4 py-2 ${
        // Tall art-bearing banner pins the nav to the TOP (items-start) and
        // stretches the logo column full-height; collapsed/no-banner centers.
        bannerShown ? "items-start" : "items-center"
      } ${
        // `isolate` keeps the absolute banner image + mobile dropdown stacking
        // local to the bar; kept whenever the server has a banner (even
        // collapsed) so the dropdown z-order is unchanged.
        hasServerBanner ? "isolate" : ""
      } ${hasBg ? "" : "bg-keep-banner"} ${
        // Animate the open/close slide (mobile) + the desktop-banner min-height.
        hasServerBanner ? "transition-[min-height] duration-300 ease-out" : ""
      }`}
    >
      {/* Server banner IMAGE layer — absolutely positioned behind the content so
          the pan/zoom crop (cropStyleFor) applies, not just a focal point. Wrapped
          in an `overflow-hidden` box so a zoomed crop (transform: scale) clips to
          the bar instead of spilling — the header itself stays NON-clipping so the
          dropdowns (More popover, mobile menu) anchored at `top-full` still render
          below it. Sits under everything (z-0); the content carries `relative` to
          float over it. Only the image path renders this; the bannerCoverCss path
          paints via headerStyle.background instead. */}
      {serverBannerImg ? (
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 z-0 overflow-hidden transition-opacity duration-300 ${
            bannerShown ? "opacity-100" : "opacity-0"
          }`}
        >
          <img
            src={serverBannerImg}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full select-none object-cover"
            style={cropStyleFor(serverBrand?.bannerCrop)}
          />
          {/* Legibility scrim — darkens the art left-to-right so the wordmark +
              nav stay readable over busy banners. Left side (logo) is darkest;
              the right (nav) keeps a lighter wash so the art still shows. */}
          <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-black/40 to-black/20" />
        </div>
      ) : null}
      {/* Tap target: clicking the bar/banner background toggles it open or
          closed, on BOTH breakpoints now. Sits ABOVE the art (z-0) but BELOW the
          logo / nav / hamburger (z-10), which keep their own taps. */}
      {hasServerBanner ? (
        <button
          type="button"
          aria-label={bannerShown ? "Collapse banner" : "Show banner"}
          onClick={toggleBanner}
          className="absolute inset-0 z-[5] cursor-pointer"
        />
      ) : null}
      {/* Visible collapse/expand handle, centered on the bottom edge so the
          toggle is discoverable on desktop (the full-area tap is invisible).
          z-20 floats it above the nav; the chevron points down to expand a
          collapsed bar, up to collapse an open one. */}
      {hasServerBanner ? (
        <button
          type="button"
          onClick={toggleBanner}
          aria-label={bannerShown ? "Collapse banner" : "Show banner"}
          title={bannerShown ? "Collapse banner" : "Show banner"}
          className="absolute bottom-0 left-1/2 z-20 -translate-x-1/2 translate-y-1/2 rounded-full border border-keep-rule bg-keep-bg/85 px-2.5 py-0.5 text-[11px] leading-none text-keep-muted shadow hover:text-keep-text"
        >
          <span aria-hidden>{bannerShown ? "▴" : "▾"}</span>
        </button>
      ) : null}
      {/* Over a server banner the bar is tall and the row is `items-start`
          (nav pinned top), so stretch the logo column to the full bar height
          and center the wordmark within it. `text-shadow` keeps a text/round-
          logo fallback legible over the art; image wordmarks ignore it. */}
      <h1
        style={{
          ...logoStyle,
          // Scale the wordmark/logo with the banner height when it's shown; let
          // it revert to the CSS-class size (current mobile size) when collapsed.
          ...(bannerShown
            ? { marginLeft: `${logoMarginLeftRem}rem`, fontSize: `${logoFontSizeRem}rem` }
            : {}),
        }}
        className={`font-action text-xl tracking-wide transition-all duration-300 ${
          bannerShown
            ? "relative z-10 flex items-center self-stretch [text-shadow:0_1px_3px_rgba(0,0,0,.7)]"
            : hasServerBanner
              ? "relative z-10" // collapsed bar: stay above the tap layer
              : ""
        } ${
          // Over a server banner the logo isn't a link, so let taps fall through
          // to the collapse/expand tap layer behind it (mobile).
          hasServerBanner ? "pointer-events-none lg:pointer-events-auto" : ""
        }`}
      >
        {/* `siteUrl` is the admin-configured canonical home for the
            site (often a marketing landing page on a sibling domain).
            When set, wrap the logo in an anchor, `color:inherit` +
            `no-underline` keep the chip visually identical to the
            unwrapped form so the logo still reads as a logo. The
            `rel="home"` hint helps screen readers and crawlers
            understand the link role. We treat an external host
            (different origin) as worth `noopener noreferrer` so the
            target page can't poke `window.opener`; same-origin links
            don't need it. */}
        {!serverBrand && branding.siteUrl ? (
          <a
            href={branding.siteUrl}
            rel="home noopener noreferrer"
            className="text-inherit no-underline hover:text-inherit hover:no-underline focus:outline-none focus:ring-1 focus:ring-keep-action"
            title={branding.siteName}
          >
            <LogoInner branding={effectiveLogo} {...(bannerShown ? { imgMaxHeight: `${logoMaxHeightRem}rem` } : {})} />
          </a>
        ) : (
          <LogoInner branding={effectiveLogo} {...(bannerShown ? { imgMaxHeight: `${logoMaxHeightRem}rem` } : {})} />
        )}
      </h1>

      {/* Desktop nav. Hidden below md+; the hamburger button + dropdown
          below handle narrow screens. `relative z-10` lifts it over the
          banner image + scrim; over a server banner the links also carry a
          soft text-shadow so they read against the art even where the scrim
          is lightest (right edge). */}
      {/* The nav sits in a translucent dark "pill" (rounded, bordered, drop
          shadow) so the links stay legible over busy server banner art, while
          the banner still shows through. relative z-10 lifts it over the banner
          image + scrim; over a server banner the links also carry a soft
          text-shadow for the lightest (right-edge) scrim.

          ONLY while the banner art is EXPANDED, though — once collapsed to the
          slim bar there's no art to sit over, so the pill (bg/border/shadow/
          padding) is dropped and the nav falls back to a plain horizontal list:
          the slim bar itself is the container at that point. */}
      <nav className={`hidden items-center gap-3 text-sm uppercase tracking-widest text-keep-muted lg:flex ${
        // `relative z-10` must apply whenever there's a server banner — NOT only
        // when expanded — so the nav stays ABOVE the full-area `toggleBanner` tap
        // layer (absolute z-[5]). When collapsed the nav was a static, unpositioned
        // element, so the z-[5] tap layer painted over it and swallowed every link
        // click (the banner just expanded instead). Mirrors the mobile hamburger,
        // which already lifts on `hasServerBanner` alone.
        hasServerBanner ? "relative z-10" : ""
      } ${
        // The decorative pill (border/bg/shadow/padding/text-shadow) is only for
        // sitting over banner ART, so it stays gated to the EXPANDED state — the
        // collapsed slim bar has no art and falls back to a plain link row.
        hasServerBanner && bannerShown ? "rounded-[10px] border border-white/20 bg-black/50 p-2.5 shadow-[0_10px_10px_rgba(0,0,0,0.2)] [text-shadow:0_1px_2px_rgba(0,0,0,.7)]" : ""
      }`}>
        {/* Admin-managed custom links collapse behind a single "More"
            popover so a busy install with many links doesn't push the
            built-in nav items off the row. `data-nav-more` is the
            scope marker the outside-click listener uses to keep the
            popover alive when the user is interacting with it. */}
        {links.length > 0 ? (
          <span className="relative flex items-center gap-3" data-nav-more>
            <button
              type="button"
              onClick={() => setMoreOpen((o) => !o)}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              className="uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title="Site links"
            >
              More
              <span aria-hidden className="ml-1 text-[0.7em]">
                {moreOpen ? "▴" : "▾"}
              </span>
            </button>
            {moreOpen ? (
              <div
                role="menu"
                className={`keep-menu-surface absolute right-0 top-full z-40 mt-1 flex w-56 flex-col overflow-hidden rounded border border-keep-rule text-sm normal-case tracking-normal shadow-2xl${reduceMotion ? " tk-slide-down-in" : ""}`}
              >
                {links.map((l) => (
                  <a
                    key={l.id}
                    href={l.href}
                    target={l.target}
                    rel={l.target === "_blank" ? "noopener noreferrer" : undefined}
                    onClick={() => setMoreOpen(false)}
                    className="border-b border-keep-rule/40 px-3 py-2 text-keep-text last:border-b-0 hover:bg-keep-banner"
                  >
                    {l.label}
                  </a>
                ))}
              </div>
            ) : null}
            <span className="text-keep-rule">|</span>
          </span>
        ) : null}
        {/* Only render the Earning link for signed-in users, the
            dashboard requires auth and the link itself shouldn't tease
            anonymous splash visitors. */}
        {me ? (
          <>
            <button
              type="button"
              onClick={onOpenEarning}
              className="relative uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title="Your Earning, XP, Currency, ranks, and cosmetics"
            >
              Earning
              {/* Tiny dot when there's an unacknowledged rank-up. Sits
                  to the top-right of the label so it's discoverable
                  without competing with the link text. */}
              {earningHasNew ? (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-1 inline-block h-1.5 w-1.5 rounded-full bg-keep-action"
                />
              ) : null}
            </button>
            <span className="text-keep-rule">|</span>
            <button
              type="button"
              onClick={onOpenScriptorium}
              className="relative uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title={
                storyInviteCount > 0
                  ? `${storyInviteCount} pending collaboration ${storyInviteCount === 1 ? "invite" : "invites"}. Open the Scriptorium to act on ${storyInviteCount === 1 ? "it" : "them"}`
                  : "The Scriptorium. Long-form fiction by the people who live here"
              }
            >
              Scriptorium
              {storyInviteCount > 0 ? (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-1 inline-block h-1.5 w-1.5 rounded-full bg-keep-action"
                />
              ) : null}
            </button>
            <span className="text-keep-rule">|</span>
            <button
              type="button"
              onClick={onOpenWorlds}
              className="uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title="Worlds catalog. Browse open roleplay worlds, lore, and wikis"
            >
              Worlds
            </button>
            <span className="text-keep-rule">|</span>
            <button
              type="button"
              onClick={onOpenStaff}
              className="uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title="Meet the staff, the mods and admins who run the Spire"
            >
              Staff
            </button>
            <span className="text-keep-rule">|</span>
            <button
              type="button"
              onClick={onOpenAffiliates}
              className="uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title="Top RP Communities. List your own and copy your link-back"
            >
              Top Communities
            </button>
            {canArcade ? (
              <>
                <span className="text-keep-rule">|</span>
                <button
                  type="button"
                  onClick={onOpenArcade}
                  className="uppercase tracking-widest text-keep-muted hover:text-keep-text"
                  title="The Spire Arcade. Play the cabinet's games, like the Eidolon Tamer"
                >
                  Arcade
                </button>
              </>
            ) : null}
            <span className="text-keep-rule">|</span>
          </>
        ) : null}
        <button
          type="button"
          onClick={onOpenRules}
          className="uppercase tracking-widest text-keep-muted hover:text-keep-text"
          title="The app rules and this server's own rules"
        >
          Rules
        </button>
        <span className="text-keep-rule">|</span>
        {/* Server FAQ: the per-server FAQ page (/faqs), mounted pre-auth like
            Rules so it's shareable. Shows the current server's entries. */}
        <button
          type="button"
          onClick={navigateToFaqIndex}
          className="uppercase tracking-widest text-keep-muted hover:text-keep-text"
          title="Frequently asked questions for this server"
        >
          FAQ
        </button>
        {/* The two admin doors sit on the RIGHT, just left of Exit: Server Admin
            (the current server's console, owners/mods only) then Global Admin
            (platform settings + cross-community oversight, site staff only).
            Both are parent-gated — the callback is only passed when permitted. */}
        {onOpenServerAdmin ? (
          <>
            <span className="text-keep-rule">|</span>
            <button
              type="button"
              onClick={onOpenServerAdmin}
              className="uppercase tracking-widest text-keep-action hover:text-keep-text"
              title="Manage this server: settings, rooms, members, moderation"
            >
              Server Admin
            </button>
          </>
        ) : null}
        {onOpenAdmin ? (
          <>
            <span className="text-keep-rule">|</span>
            <button
              type="button"
              onClick={onOpenAdmin}
              className="uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title="Global Admin: platform settings and cross-community oversight"
            >
              Global Admin
            </button>
          </>
        ) : null}
        <span className="text-keep-rule">|</span>
        <button
          type="button"
          onClick={logout}
          className="uppercase tracking-widest text-keep-accent hover:underline"
          title="Log out and return to the login screen"
        >
          Exit
        </button>
        {notificationBell}
        <ConnectionOrb />
      </nav>

      {/* Mobile controls: events + notifications first, THEN the hamburger
          menu trigger (its dropdown panel lives underneath the header so we
          don't overflow the narrow banner), then the connection orb. The
          hamburger sits to the RIGHT of events/notifications, not the left.
          `relative z-10` floats the row over the banner scrim. */}
      <div className={`flex items-center gap-2 lg:hidden ${hasServerBanner ? "relative z-10" : ""}`}>
        {notificationBell}
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          title="Menu"
          className="flex h-9 w-9 items-center justify-center rounded border border-keep-rule bg-keep-bg/60 text-lg text-keep-text hover:bg-keep-banner"
        >
          {menuOpen ? "✕" : "☰"}
        </button>
        <ConnectionOrb />
      </div>

      {/* Mobile dropdown. Fixed-viewport backdrop catches outside-clicks
          so tapping the chat closes the menu. The panel itself sits
          absolutely under the header, right-aligned, with stacked
          rows. The themed banner CSS sets `isolation: isolate`, which
          creates a stacking context, so the header itself carries
          `z-30` above to lift the whole context above the chat
          `<main>` sibling; otherwise the dropdown's z-40 would be
          trapped inside the banner's context and paint *under* the
          later-in-DOM chat content. Modals (z-40/50, fixed inset-0)
          still float above. */}
      {menuOpen ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-30 cursor-default bg-transparent lg:hidden"
          />
          <nav
            className={`keep-menu-surface absolute right-2 top-full z-40 mt-1 flex w-56 flex-col overflow-hidden rounded border border-keep-rule text-sm shadow-2xl lg:hidden${reduceMotion ? " tk-slide-down-in" : ""}`}
          >
            {/* Custom links live behind a collapsible row so a long
                list doesn't crowd the built-in actions. Header taps
                expand the list in-place; individual link taps close
                the whole menu, matching the other rows. */}
            {links.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setMobileMoreOpen((o) => !o)}
                  aria-expanded={mobileMoreOpen}
                  className="flex items-center justify-between border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
                >
                  <span>More</span>
                  <span aria-hidden className="text-xs text-keep-muted">
                    {mobileMoreOpen ? "▴" : "▾"}
                  </span>
                </button>
                {mobileMoreOpen
                  ? links.map((l) => (
                      <a
                        key={l.id}
                        href={l.href}
                        target={l.target}
                        rel={l.target === "_blank" ? "noopener noreferrer" : undefined}
                        onClick={() => setMenuOpen(false)}
                        className="border-b border-keep-rule/40 bg-keep-banner/40 py-2 pl-6 pr-3 text-keep-text hover:bg-keep-banner"
                      >
                        {l.label}
                      </a>
                    ))
                  : null}
              </>
            ) : null}
            {/* These are menu items, not buttons. Drop the `keep-button`
                class so they don't pick up the pill/lift styling, they
                render as flat link-style rows matching the <a> siblings
                above. The shared <nav> already gives them a rounded outer
                container; individual items have no border-radius. */}
            {me ? (
              <>
                <button
                  type="button"
                  onClick={fireEarning}
                  className="flex items-center gap-2 border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
                >
                  <span>Earning</span>
                  {earningHasNew ? (
                    <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-keep-action" />
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={fireScriptorium}
                  className="flex items-center gap-2 border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
                >
                  <span>Scriptorium</span>
                  {storyInviteCount > 0 ? (
                    <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-keep-action" />
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={fireWorlds}
                  className="flex items-center gap-2 border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
                >
                  <span>Worlds</span>
                </button>
                <button
                  type="button"
                  onClick={fireStaff}
                  className="flex items-center gap-2 border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
                >
                  <span>Staff</span>
                </button>
                <button
                  type="button"
                  onClick={fireAffiliates}
                  className="flex items-center gap-2 border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
                >
                  <span>Top Communities</span>
                </button>
                {canArcade ? (
                  <button
                    type="button"
                    onClick={fireArcade}
                    className="flex items-center gap-2 border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
                  >
                    <span>Arcade</span>
                  </button>
                ) : null}
              </>
            ) : null}
            <button
              type="button"
              onClick={fireRules}
              className="border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
            >
              Rules
            </button>
            <button
              type="button"
              onClick={() => { navigateToFaqIndex(); setMenuOpen(false); }}
              className="border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
            >
              FAQ
            </button>
            {/* Server Admin then Global Admin, grouped just above Exit (mirrors
                the desktop nav's right-side ordering). */}
            {onOpenServerAdmin ? (
              <button
                type="button"
                onClick={() => { onOpenServerAdmin(); setMenuOpen(false); }}
                className="border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-action hover:bg-keep-banner"
              >
                Server Admin
              </button>
            ) : null}
            {onOpenAdmin ? (
              <button
                type="button"
                onClick={fireAdmin}
                className="border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
              >
                Global Admin
              </button>
            ) : null}
            <button
              type="button"
              onClick={fireLogout}
              className="bg-transparent px-3 py-2 text-left font-semibold text-keep-accent hover:bg-keep-accent/10"
            >
              Exit
            </button>
          </nav>
        </>
      ) : null}
    </header>
  );
}

/**
 * Logo content shared between the linked and unlinked banner paths.
 * Pulled out into its own component so the `branding.siteUrl ? <a>…</a>
 * : <>…</>` ternary in the header stays readable, without it the
 * image-vs-text branch would be duplicated under both arms of the
 * outer ternary.
 */
function LogoInner({
  branding,
  imgMaxHeight,
}: {
  branding: { logoUrl: string; siteName: string; horizontalLogoUrl: string | null };
  /** When set (banner shown), overrides the CSS-class max-height so the
   *  wordmark/logo scales with the banner height. Inline beats the class. */
  imgMaxHeight?: string;
}) {
  // Inline max-height wins over the Tailwind max-h-* fallback when scaling; the
  // transition eases the scale-up/down on the mobile open/close toggle.
  const scaleStyle = imgMaxHeight ? { maxHeight: imgMaxHeight } : undefined;
  // Server WIDE wordmark wins when present — it's the clearest "which server
  // am I in" cue, so it replaces the round logo + name entirely. A taller
  // `max-h` than the round logo lets it fill the taller banner bar; w-auto
  // keeps the aspect ratio whatever the source dimensions are.
  if (branding.horizontalLogoUrl) {
    return (
      <img
        src={branding.horizontalLogoUrl}
        alt={branding.siteName}
        className="max-h-10 w-auto select-none object-contain transition-[max-height] duration-300 lg:max-h-12"
        style={scaleStyle}
        draggable={false}
      />
    );
  }
  if (branding.logoUrl) {
    // Image logo (default install ships /thespire-logo.png; admins can
    // swap it via /admin/settings or upload via the admin panel). The
    // surrounding <h1> stays for screen-readers + SEO. `max-h` keeps
    // the banner height stable regardless of source PNG dimensions; the
    // 1580×446 default lands well within that on retina.
    return (
      <img
        src={branding.logoUrl}
        alt={branding.siteName}
        className="max-h-8 w-auto select-none transition-[max-height] duration-300"
        style={scaleStyle}
        draggable={false}
      />
    );
  }
  return <>{branding.siteName}</>;
}
