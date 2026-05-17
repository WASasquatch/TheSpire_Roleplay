import { useEffect, useState, type CSSProperties } from "react";
import { isAdminRole } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { useEarning } from "../state/earning.js";
import { disconnect } from "../lib/socket.js";
import { clearSessionToken } from "../lib/http.js";

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
export function Banner({ navLinksVersion, onOpenAdmin, onOpenRules, onOpenEarning }: Props) {
  const me = useChat((s) => s.me);
  const setMe = useChat((s) => s.setMe);
  const branding = useChat((s) => s.branding);
  // Earning indicator dot — small marker next to the link when the
  // user has unacknowledged rank-up notifications. Reads from the
  // store directly so it stays live with `earning:rankup` socket
  // events without prop drilling.
  const earningHasNew = useEarning((s) => s.unackRankUps.length > 0);
  const [links, setLinks] = useState<NavLinkRow[]>([]);
  // Mobile-only dropdown state. The desktop inline nav is always
  // rendered; this just toggles a hamburger panel that mirrors the
  // links on narrow screens where the inline strip would overflow or
  // crowd the brand.
  const [menuOpen, setMenuOpen] = useState(false);

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
    setMe(null);
  }

  // Admin-supplied background CSS shorthand goes on the header itself. When
  // unset, we fall back to the theme's panel color via the existing class.
  const headerStyle: CSSProperties = {};
  if (branding.bannerCoverCss) {
    headerStyle.background = branding.bannerCoverCss;
  }

  // Logo color/font come from branding too; the explicit empty string for
  // logoFont reverts to font-action's stack since the wrapper class still
  // applies. (Tailwind's `font-action` resolves to its CSS var fallback.)
  const logoStyle: CSSProperties = {};
  if (branding.logoColor) logoStyle.color = branding.logoColor;
  if (branding.logoFont) logoStyle.fontFamily = branding.logoFont;

  // Click handlers that fire the action then close the mobile dropdown.
  // Dropdown stays alive past the click on desktop (it isn't rendered
  // there), so these no-op the close on md+ — the inline nav doesn't
  // need it.
  function fireRules() { onOpenRules(); setMenuOpen(false); }
  function fireAdmin() { if (onOpenAdmin) onOpenAdmin(); setMenuOpen(false); }
  function fireEarning() { onOpenEarning(); setMenuOpen(false); }
  function fireLogout() { setMenuOpen(false); void logout(); }

  return (
    <header
      style={headerStyle}
      className={`keep-app-banner relative flex items-center justify-between border-b border-keep-rule px-4 py-2 ${
        branding.bannerCoverCss ? "" : "bg-keep-banner"
      }`}
    >
      <h1 style={logoStyle} className="font-action text-xl tracking-wide">
        {/* `siteUrl` is the admin-configured canonical home for the
            site (often a marketing landing page on a sibling domain).
            When set, wrap the logo in an anchor — `color:inherit` +
            `no-underline` keep the chip visually identical to the
            unwrapped form so the logo still reads as a logo. The
            `rel="home"` hint helps screen readers and crawlers
            understand the link role. We treat an external host
            (different origin) as worth `noopener noreferrer` so the
            target page can't poke `window.opener`; same-origin links
            don't need it. */}
        {branding.siteUrl ? (
          <a
            href={branding.siteUrl}
            rel="home noopener noreferrer"
            className="text-inherit no-underline hover:text-inherit hover:no-underline focus:outline-none focus:ring-1 focus:ring-keep-action"
            title={branding.siteName}
          >
            <LogoInner branding={branding} />
          </a>
        ) : (
          <LogoInner branding={branding} />
        )}
      </h1>

      {/* Desktop nav. Hidden below md+; the hamburger button + dropdown
          below handle narrow screens. */}
      <nav className="hidden items-center gap-3 text-xs uppercase tracking-widest text-keep-muted lg:flex">
        {links.map((l, i) => (
          <span key={l.id} className="flex items-center gap-3">
            {i > 0 ? <span className="text-keep-rule">|</span> : null}
            <a
              href={l.href}
              target={l.target}
              rel={l.target === "_blank" ? "noopener noreferrer" : undefined}
              className="hover:text-keep-text"
            >
              {l.label}
            </a>
          </span>
        ))}
        {links.length > 0 ? <span className="text-keep-rule">|</span> : null}
        {/* Only render the Earning link for signed-in users — the
            dashboard requires auth and the link itself shouldn't tease
            anonymous splash visitors. */}
        {me ? (
          <>
            <button
              type="button"
              onClick={onOpenEarning}
              className="relative uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title="Your Earning — XP, Currency, ranks, and cosmetics"
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
          </>
        ) : null}
        <button
          type="button"
          onClick={onOpenRules}
          className="uppercase tracking-widest text-keep-muted hover:text-keep-text"
          title="House rules and privacy notice"
        >
          Rules
        </button>
        {me && isAdminRole(me.role) && onOpenAdmin ? (
          <>
            <span className="text-keep-rule">|</span>
            <button
              type="button"
              onClick={onOpenAdmin}
              className="uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title="Admin tools"
            >
              Admin
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
      </nav>

      {/* Mobile hamburger trigger. The same actions live in a dropdown
          panel underneath the header so we don't overflow the narrow
          banner with a strip of inline links. */}
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        aria-expanded={menuOpen}
        aria-label={menuOpen ? "Close menu" : "Open menu"}
        title="Menu"
        className="flex h-9 w-9 items-center justify-center rounded border border-keep-rule bg-keep-bg/60 text-lg text-keep-text hover:bg-keep-banner lg:hidden"
      >
        {menuOpen ? "✕" : "☰"}
      </button>

      {/* Mobile dropdown. Fixed-viewport backdrop catches outside-clicks
          so tapping the chat closes the menu. The panel itself sits
          absolutely under the header, right-aligned, with stacked
          rows. Z is above the chat content but below modals (z-40/50). */}
      {menuOpen ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-30 cursor-default bg-transparent lg:hidden"
          />
          <nav
            className="absolute right-2 top-full z-40 mt-1 flex w-56 flex-col overflow-hidden rounded border border-keep-rule bg-keep-bg text-sm shadow-2xl lg:hidden"
          >
            {links.map((l) => (
              <a
                key={l.id}
                href={l.href}
                target={l.target}
                rel={l.target === "_blank" ? "noopener noreferrer" : undefined}
                onClick={() => setMenuOpen(false)}
                className="border-b border-keep-rule/40 px-3 py-2 text-keep-text hover:bg-keep-banner"
              >
                {l.label}
              </a>
            ))}
            {/* These are menu items, not buttons. Drop the `keep-button`
                class so they don't pick up the pill/lift styling — they
                render as flat link-style rows matching the <a> siblings
                above. The shared <nav> already gives them a rounded outer
                container; individual items have no border-radius. */}
            {me ? (
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
            ) : null}
            <button
              type="button"
              onClick={fireRules}
              className="border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
            >
              Rules
            </button>
            {me && isAdminRole(me.role) && onOpenAdmin ? (
              <button
                type="button"
                onClick={fireAdmin}
                className="border-b border-keep-rule/40 bg-transparent px-3 py-2 text-left text-keep-text hover:bg-keep-banner"
              >
                Admin
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
 * : <>…</>` ternary in the header stays readable — without it the
 * image-vs-text branch would be duplicated under both arms of the
 * outer ternary.
 */
function LogoInner({ branding }: { branding: { logoUrl: string; siteName: string } }) {
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
        className="max-h-8 w-auto select-none"
        draggable={false}
      />
    );
  }
  return <>{branding.siteName}</>;
}
