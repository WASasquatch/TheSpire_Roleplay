import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChat } from "../state/store.js";
import { AuthGate, SplashShell } from "../components/AuthGate.js";
import { SplashLanding } from "../components/marketing/SplashLanding.js";
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from "../components/EmailAuthPages.js";
import { StoryCatalogModal } from "../components/scriptorium/StoryCatalogModal.js";
import { StoryReaderModal } from "../components/scriptorium/StoryReaderModal.js";
import { ForumPublicLanding } from "../components/forums/ForumPublicLanding.js";
import { ServerPublicLanding } from "../components/servers/ServerPublicLanding.js";
import { applyTheme, resolveSplashTheme, splashBgClass, themeStyle } from "./theme.js";
import { parseScriptoriumFromUrl, storyPermalink } from "./scriptoriumUrl.js";

/**
 * Unauth-side router. Drives which face of the entrance the visitor sees
 * based on `window.location.pathname`:
 *
 *   - `/` (and anything we don't otherwise route)  → SplashLanding (marketing)
 *   - `/login`                                     → AuthGate (login form)
 *   - `/register`                                  → AuthGate (register form)
 *   - deep-link gates (/p/, /w/) come in with a    → AuthGate with hint
 *     `pending*Hint` from the parent; we always
 *     route those to AuthGate regardless of path
 *     so the hint actually surfaces.
 *
 * SPA navigation between these uses pushState + a synthetic popstate so
 * the parent re-renders without a full page reload, keeping bundle warm
 * and theme/state alive across the transition. Hard refresh / direct
 * navigation still works because the server registers `/login` and
 * `/register` as serveSplash routes that ship the same index.html.
 */
export function UnauthRouter(props: {
  pendingProfileHint?: { name: string; isPrivate: boolean };
  pendingWorldHint?: { name: string; slug: string };
}) {
  const [path, setPath] = useState<string>(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Centralized client-side nav: pushState changes the URL, dispatching
  // popstate manually fires every listener (including this router's) so
  // the page re-renders without a hard reload.
  const navigate = (next: string) => {
    if (window.location.pathname === next) return;
    window.history.pushState(null, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  // Deep-link hints always force AuthGate so the visitor sees the
  // "this profile is private, sign in to view" banner regardless of
  // which URL slot they happen to be on.
  const hasDeepLinkHint = !!(props.pendingProfileHint || props.pendingWorldHint);
  const serversEnabled = useChat((s) => s.branding.serversEnabled);

  // Scriptorium public surfaces, render the catalog / reader inside
  // the standalone PublicViewerShell so anonymous visitors can browse
  // and read up to R-rated stories without an account. NC-17 cards
  // surface in the catalog but the reader returns a login-prompt
  // stub when an unauthenticated viewer opens one.
  if (!hasDeepLinkHint) {
    const route = parseScriptoriumFromUrl();
    if (route?.kind === "catalog") {
      return (
        <PublicViewerShell isAuthenticated={false}>
          <StoryCatalogModal
            onClose={() => navigate("/")}
            onOpenStory={(_storyId, card) => {
              // Anonymous catalog: prefer the canonical permalink so
              // the URL is shareable and stays bookmarkable.
              if (card) navigate(storyPermalink(card.author.masterUsername, card.slug));
            }}
            onOpenEditor={() => navigate("/login")}
          />
        </PublicViewerShell>
      );
    }
    if (route?.kind === "story") {
      return (
        <PublicViewerShell isAuthenticated={false}>
          <AnonymousStoryReader
            handle={route.handle}
            slug={route.slug}
            onClose={() => navigate("/scriptorium")}
            onNavigate={navigate}
          />
        </PublicViewerShell>
      );
    }
  }

  // Forum landing (/f/<slug>): the shareable public face of a community
  // forum. Renders inside the standalone shell so anonymous visitors get
  // the branded page with its login/register entrance; the chosen forum
  // is remembered and reopened after the auth round-trip.
  if (!hasDeepLinkHint) {
    const fm = /^\/f\/([a-z0-9_]{3,40})(?:\/t\/([A-Za-z0-9_-]{4,64}))?\/?$/.exec(path);
    if (fm?.[1]) {
      const anonPost = /^#p-([A-Za-z0-9_-]{4,64})$/.exec(window.location.hash)?.[1];
      return (
        <PublicViewerShell isAuthenticated={false}>
          <ForumPublicLanding
            slug={fm[1]}
            initialTopicId={fm[2] ?? null}
            initialPostId={anonPost ?? null}
            onNavigate={navigate}
          />
        </PublicViewerShell>
      );
    }
  }

  // Community landing (/s/<slug>): the shareable public face of a hosted
  // community. Logged-out visitors get the branded page + login/register
  // entrance; signed-in visitors enter the server directly (handled in App).
  // Gated on the servers flag; server slugs use hyphens (vs forum underscores).
  if (!hasDeepLinkHint && serversEnabled) {
    const sm = /^\/s\/([a-z0-9-]{3,40})\/?$/.exec(path);
    if (sm?.[1]) {
      return (
        <PublicViewerShell isAuthenticated={false}>
          <ServerPublicLanding slug={sm[1]} onNavigate={navigate} />
        </PublicViewerShell>
      );
    }
  }

  // Email flow pages (logged-out): request a reset link, set a new password
  // from a ?token= link, confirm an email from a ?token= link. All render
  // inside SplashShell so they match the login chrome.
  if (!hasDeepLinkHint && path === "/forgot-password") {
    return <ForgotPasswordPage onNavigate={navigate} />;
  }
  if (!hasDeepLinkHint && path === "/reset-password") {
    return <ResetPasswordPage onNavigate={navigate} />;
  }
  if (!hasDeepLinkHint && path === "/verify-email") {
    return <VerifyEmailPage onNavigate={navigate} />;
  }

  if (!hasDeepLinkHint && path === "/") {
    return <SplashLanding onNavigate={navigate} />;
  }

  const initialMode: "login" | "register" = path === "/register" ? "register" : "login";
  return (
    <AuthGate
      initialMode={initialMode}
      onNavigate={navigate}
      {...(props.pendingProfileHint ? { pendingProfileHint: props.pendingProfileHint } : {})}
      {...(props.pendingWorldHint ? { pendingWorldHint: props.pendingWorldHint } : {})}
    />
  );
}

/**
 * Anonymous-side reader wrapper. Resolves `@handle/slug` to a story
 * id via the canonical /stories/@h/s endpoint, then mounts the reader
 * with that id. NC-17 stories return a `private: true` stub from the
 * server, we surface a "log in to read this story" card instead of
 * crashing the modal.
 */
function AnonymousStoryReader({
  handle,
  slug,
  onClose,
  onNavigate,
}: {
  handle: string;
  slug: string;
  onClose: () => void;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation("scriptorium");
  const [resolved, setResolved] = useState<
    | { kind: "loading" }
    | { kind: "ok"; storyId: string }
    | { kind: "stub"; title: string }
    | { kind: "notfound" }
  >({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch(`/stories/@${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (!r.ok) {
          if (r.status === 404) return { kind: "notfound" as const };
          throw new Error("load failed");
        }
        const j = await r.json();
        if (j && j.private === true) {
          return { kind: "stub" as const, title: typeof j.title === "string" ? j.title : slug };
        }
        const id = j?.story?.id;
        if (typeof id !== "string") return { kind: "notfound" as const };
        return { kind: "ok" as const, storyId: id };
      })
      .then((res) => { if (!cancelled) setResolved(res); })
      .catch(() => { if (!cancelled) setResolved({ kind: "notfound" }); });
    return () => { cancelled = true; };
  }, [handle, slug]);

  if (resolved.kind === "loading") {
    return <p className="p-8 italic text-keep-muted">{t("anonReader.loading")}</p>;
  }
  if (resolved.kind === "notfound") {
    return (
      <div className="mx-auto max-w-sm p-8 text-center">
        <p className="font-action text-lg text-keep-text">{t("anonReader.notFoundTitle")}</p>
        <p className="mt-2 text-sm text-keep-muted">
          {t("anonReader.notFoundBody")}
        </p>
        <button
          type="button"
          onClick={() => onNavigate("/scriptorium")}
          className="mt-4 rounded border border-keep-action bg-keep-action/15 px-3 py-1.5 text-xs uppercase tracking-widest text-keep-action"
        >
          {t("backToScriptorium")}
        </button>
      </div>
    );
  }
  if (resolved.kind === "stub") {
    return (
      <div className="mx-auto max-w-sm p-8 text-center">
        <p className="font-action text-lg text-keep-text">{resolved.title}</p>
        <p className="mt-2 text-sm text-keep-muted">
          {t("anonReader.nc17Gate")}
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onNavigate(`/login?story=${encodeURIComponent(slug)}`)}
            className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg"
          >
            {t("marketing:auth.logIn")}
          </button>
          <button
            type="button"
            onClick={() => onNavigate(`/register?story=${encodeURIComponent(slug)}`)}
            className="rounded border border-keep-action bg-keep-action/15 px-3 py-1.5 text-xs uppercase tracking-widest text-keep-action"
          >
            {t("marketing:auth.register")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <StoryReaderModal
      storyId={resolved.storyId}
      onClose={onClose}
      onBack={() => onNavigate("/scriptorium")}
    />
  );
}

/**
 * Standalone shell for direct-link content viewing. Applies the site's
 * default theme so the modal renders against the configured palette and
 * pins a small action link in the corner so the visitor has a clear path
 * forward, sign-in for anonymous viewers, or "open chat" for already-
 * authed users who landed here from a shared link.
 */
export function PublicViewerShell({
  children,
  isAuthenticated,
}: {
  children: React.ReactNode;
  isAuthenticated: boolean;
}) {
  const { t } = useTranslation("marketing");
  const branding = useChat((s) => s.branding);
  const siteName = branding.siteName || "The Spire";

  // Mirror the authenticated shell's applyTheme onto <html>. The
  // catalog / reader render through <Modal>, which portals to
  // document.body and so escapes the subtree theme vars set on the
  // div below. On a public route the authenticated <Chat> never
  // mounts, so applyTheme() is otherwise never called and <html>
  // keeps the static light :root defaults from styles.css — leaving
  // every portaled modal stuck on that flat palette: illegible
  // against a dark-device backdrop and ignoring the visitor's
  // light/dark preference. Stamping the resolved splash palette on
  // <html> here lets portaled descendants inherit it. Re-resolve on
  // a prefers-color-scheme flip so toggling the OS theme updates the
  // page live (resolveSplashTheme reads the media query).
  useEffect(() => {
    const apply = () => applyTheme(resolveSplashTheme(branding));
    apply();
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", apply);
    return () => mq?.removeEventListener?.("change", apply);
  }, [branding]);

  return (
    <div
      style={themeStyle(resolveSplashTheme(branding))}
      className="relative min-h-screen w-full bg-keep-bg text-keep-text"
    >
      {/* Subtle backdrop image, same as the login splash, so the standalone
          page still feels like part of the site rather than a stripped
          modal floating on a flat color. Same dark/light swap as the
          login splash via splashBgUrl (resolved palette decides). */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-cover bg-[position:-175px_center] opacity-40 md:bg-center ${splashBgClass(resolveSplashTheme(branding))}`}
      />
      <div aria-hidden className="absolute inset-0 bg-keep-bg/70" />
      <a
        href="/"
        // Mobile: pinned bottom-right so it can't collide with the
        // full-screen modal's header (the modal's own close button lives
        // top-right on small screens). Desktop: top-right corner where the
        // modal has natural margin around it.
        className="fixed bottom-3 right-4 z-[60] rounded border border-keep-rule bg-keep-bg/90 px-3 py-1 text-xs uppercase tracking-widest text-keep-action shadow hover:bg-keep-bg md:bottom-auto md:top-3"
      >
        {isAuthenticated
          ? t("publicShell.openSite", { siteName })
          : t("publicShell.signIn", { siteName })}
      </a>
      {children}
    </div>
  );
}

export function BootSplash() {
  const { t } = useTranslation("marketing");
  return (
    <SplashShell>
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-keep-muted">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-keep-action" />
          {t("boot.checkingSession")}
        </div>
      </div>
    </SplashShell>
  );
}
