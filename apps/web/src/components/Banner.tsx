import { useEffect, useState, type CSSProperties } from "react";
import { useChat } from "../state/store.js";
import { disconnect } from "../lib/socket.js";

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
}

/**
 * Top banner.
 *
 * Layout: title on the left; admin-managed links + Admin (admin-only) + Exit
 * on the right. Exit is hard-coded — admins can't delete the logout path.
 *
 * The banner background, logo color, and logo font are all driven by the
 * admin-configured site branding (see /admin/settings). Each falls back to
 * the active theme's panel color / text color / font-action stack when not
 * overridden, so a fresh install still looks coherent.
 */
export function Banner({ navLinksVersion, onOpenAdmin }: Props) {
  const me = useChat((s) => s.me);
  const setMe = useChat((s) => s.setMe);
  const branding = useChat((s) => s.branding);
  const [links, setLinks] = useState<NavLinkRow[]>([]);

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

  async function logout() {
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "include" });
    } catch { /* best-effort */ }
    disconnect();
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

  return (
    <header
      style={headerStyle}
      className={`flex items-center justify-between border-b border-keep-rule px-4 py-2 ${
        branding.bannerCoverCss ? "" : "bg-keep-banner"
      }`}
    >
      <h1 style={logoStyle} className="font-action text-xl tracking-wide">
        {branding.siteName}
      </h1>
      <nav className="flex items-center gap-3 text-xs uppercase tracking-widest text-keep-muted">
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
        {me?.role === "admin" && onOpenAdmin ? (
          <>
            {links.length > 0 ? <span className="text-keep-rule">|</span> : null}
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
        {(links.length > 0 || me?.role === "admin") ? (
          <span className="text-keep-rule">|</span>
        ) : null}
        <button
          type="button"
          onClick={logout}
          className="uppercase tracking-widest text-keep-accent hover:underline"
          title="Log out and return to the login screen"
        >
          Exit
        </button>
      </nav>
    </header>
  );
}
