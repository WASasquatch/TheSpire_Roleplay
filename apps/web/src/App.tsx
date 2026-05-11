import { useEffect, useMemo, useState } from "react";
import type { ChatMessage, PrivateWorldStub, ProfileView, Role, Theme, WorldDetail } from "@thekeep/shared";
import { DEFAULT_THEME, normalizeTheme } from "@thekeep/shared";
import { AdminPanel } from "./components/AdminPanel.js";
import { AuthGate, SplashShell } from "./components/AuthGate.js";
import { Banner } from "./components/Banner.js";
import { Composer } from "./components/Composer.js";
import { HelpModal } from "./components/HelpModal.js";
import { MessageList } from "./components/MessageList.js";
import { MutualPrompts } from "./components/MutualPrompts.js";
import { ProfileEditor } from "./components/ProfileEditor.js";
import { ProfileModal } from "./components/ProfileModal.js";
import { RoomPasswordModal } from "./components/RoomPasswordModal.js";
import { RoomsTree, type RoomWithOccupants } from "./components/RoomsTree.js";
import { RulesModal } from "./components/RulesModal.js";
import { UsersModal } from "./components/UsersModal.js";
import { WorldCatalogModal } from "./components/WorldCatalogModal.js";
import { WorldEditorModal } from "./components/WorldEditorModal.js";
import { WorldViewerModal } from "./components/WorldViewerModal.js";
import { WorldsListModal } from "./components/WorldsListModal.js";
import { WelcomeModal } from "./components/WelcomeModal.js";
import { getSocket, disconnect as disconnectSocket } from "./lib/socket.js";
import { parseWorldFromUrl, syncWorldUrl } from "./lib/worlds.js";
import { parseProfileFromUrl, syncProfileUrl, type PrivateProfileStub } from "./lib/profiles.js";
import { applyTheme, themeStyle } from "./lib/theme.js";
import { fire as fireNotification, shouldNotify, type NotifyPref } from "./lib/notifications.js";
import { useChat, type SiteBranding } from "./state/store.js";

export function App() {
  const me = useChat((s) => s.me);
  const setMe = useChat((s) => s.setMe);
  const authChecked = useChat((s) => s.authChecked);
  const setAuthChecked = useChat((s) => s.setAuthChecked);
  const branding = useChat((s) => s.branding);
  const setBranding = useChat((s) => s.setBranding);
  const setKickReason = useChat((s) => s.setKickReason);

  // Public branding fetch - runs unauthenticated so the login screen and
  // boot splash can show the configured site name. Admin saves push their
  // result straight into the store, so no version bumper is needed here.
  useEffect(() => {
    let cancelled = false;
    fetch("/site")
      .then((r) => (r.ok ? (r.json() as Promise<SiteBranding>) : null))
      .then((j) => {
        if (!cancelled && j) setBranding(j);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [setBranding]);

  // Sync the tab title and the logo font CSS variable with the configured
  // branding. Both are global to the document; the banner reads the var.
  useEffect(() => {
    document.title = branding.siteName || "The Spire";
    const logoFont = branding.logoFont ?? "";
    document.documentElement.style.setProperty("--keep-logo-font", logoFont);
  }, [branding.siteName, branding.logoFont]);

  // Restore session on mount. Until this resolves we deliberately render
  // *neither* AuthGate nor Chat - otherwise a logged-in user reloading the
  // page (or following a banner link) sees AuthGate flash for ~100ms before
  // the cookie probe completes.
  useEffect(() => {
    let cancelled = false;
    fetch("/auth/me", { credentials: "include" })
      .then(async (r) => (r.ok ? (r.json() as Promise<{ id: string; username: string; role: Role }>) : null))
      .then((j) => {
        if (cancelled) return;
        if (j) setMe({ id: j.id, username: j.username, role: j.role });
        setAuthChecked(true);
      })
      .catch(() => {
        if (!cancelled) setAuthChecked(true);
      });
    return () => { cancelled = true; };
  }, [setMe, setAuthChecked]);

  // Backstop poll: re-verify the session every 60s so admin-shortened TTLs
  // (or janitor sweeps) drop the user back to the login splash even if they
  // never type or click. The socket bounces them sooner via `auth:expired`,
  // but this catches cases where the socket disconnected silently.
  //
  // /auth/me is intentionally NOT counted as user activity on the server
  // (see auth/session.ts) - otherwise this poll would keep idle tabs logged
  // in forever, defeating the idle-timeout feature.
  useEffect(() => {
    if (!me) return;
    const id = window.setInterval(async () => {
      try {
        const r = await fetch("/auth/me", { credentials: "include" });
        if (!r.ok) {
          setKickReason("Your session expired due to inactivity. Please log in again.");
          disconnectSocket();
          setMe(null);
        }
      } catch { /* network blip - ignore */ }
    }, 60_000);
    return () => window.clearInterval(id);
  }, [me, setMe, setKickReason]);

  // /p/<username> deep-link state. Lives at App level (not Chat) so it's
  // available to AuthGate too: anonymous visitors landing on /p/<X> see a
  // banner above the login form telling them which profile they're trying
  // to view, with the appropriate copy for public-vs-private.
  const setOpenProfile = useChat((s) => s.setOpenProfile);
  const [pendingProfile, setPendingProfile] = useState<{
    name: string;
    /** null = still loading; PrivateProfileStub = anonymous-restricted; ProfileView = ready to open. */
    data: PrivateProfileStub | { kind: "view"; view: ProfileView } | null;
  } | null>(() => {
    const name = parseProfileFromUrl();
    return name ? { name, data: null } : null;
  });

  // Standalone-hotlink-view flag. True iff the page first loaded at a
  // /p/<X> or /w/<X> URL. While set, App renders the modal in a clean
  // standalone shell regardless of auth state (so an off-site share is a
  // stable artifact, not a chat overlay). Cleared the first time the user
  // dismisses or the verdict comes back as 404. Detailed effect-by-effect
  // explanation lives at the world-state block below — declared up here
  // so the profile fetch effect can call its setter.
  const [arrivedViaDeepLink, setArrivedViaDeepLink] = useState<boolean>(() => {
    return parseProfileFromUrl() !== null || parseWorldFromUrl() !== null;
  });

  // Mount-time fetch for the deep-link target. Uses HTTP (works whether the
  // viewer is authed or not) so the AuthGate can decide what banner to show
  // before any session is established.
  useEffect(() => {
    if (!pendingProfile || pendingProfile.data) return;
    let cancelled = false;
    fetch(`/profiles/${encodeURIComponent(pendingProfile.name)}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) return null;
        return (await r.json()) as PrivateProfileStub | ProfileView;
      })
      .then((j) => {
        if (cancelled) return;
        if (!j) {
          // 404 / fetch failure — drop the pending state and exit
          // standalone view (if we were in it) so the normal app flow can
          // take over. The URL stays /p/<name> in the address bar; the
          // user can navigate away or refresh.
          setPendingProfile(null);
          setArrivedViaDeepLink(false);
          return;
        }
        if ("private" in j) {
          setPendingProfile((cur) => (cur ? { ...cur, data: j } : cur));
        } else {
          setPendingProfile((cur) => (cur ? { ...cur, data: { kind: "view", view: j } } : cur));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pendingProfile]);

  // Once we have a fetched profile, open the modal. Public profiles open
  // for everyone (including anonymous visitors — the point is that profile
  // links are hotlinkable off-site). Private stubs require auth; for those
  // we leave the pending state set so the AuthGate hint stays visible until
  // the user logs in, then re-fetch with credentials to get the full data.
  useEffect(() => {
    if (!pendingProfile?.data) return;
    if ("private" in pendingProfile.data) {
      // Stub case. If anonymous, leave it for the AuthGate to surface.
      if (!me) return;
      // Logged in but the cached fetch was the public-anonymous one - retry
      // with credentials to get the full profile.
      fetch(`/profiles/${encodeURIComponent(pendingProfile.name)}`, { credentials: "include" })
        .then((r) => (r.ok ? (r.json() as Promise<PrivateProfileStub | ProfileView>) : null))
        .then((j) => {
          if (!j) return;
          if ("private" in j) {
            // Still private after login (e.g. NSFW stub for some flow we
            // don't yet have); leave the hint up so the user can dismiss.
            return;
          }
          setOpenProfile(j);
          setPendingProfile(null);
        })
        .catch(() => {});
      return;
    }
    setOpenProfile(pendingProfile.data.view);
    setPendingProfile(null);
  }, [me, pendingProfile, setOpenProfile]);

  // Keep the URL in sync with the open profile modal so the deep-link is
  // bookmarkable and the back button closes the modal naturally.
  const openProfileForSync = useChat((s) => s.openProfile);
  useEffect(() => {
    if (!openProfileForSync) {
      // Only clear the URL if it's currently a /p/ URL - don't stomp /w/ etc.
      if (parseProfileFromUrl()) syncProfileUrl(null);
      return;
    }
    const name = openProfileForSync.kind === "master"
      ? openProfileForSync.profile.username
      : openProfileForSync.profile.name;
    syncProfileUrl(name);
  }, [openProfileForSync]);

  // popstate: back/forward navigation. If the URL points to a profile,
  // re-trigger the deep-link load (via setPendingProfile). If it points
  // away from /p/<X>, close the open modal.
  useEffect(() => {
    function onPop() {
      const name = parseProfileFromUrl();
      if (!name) {
        if (useChat.getState().openProfile) setOpenProfile(null);
        return;
      }
      // Same name as the currently-open modal? No-op.
      const open = useChat.getState().openProfile;
      const openName = open
        ? (open.kind === "master" ? open.profile.username : open.profile.name)
        : null;
      if (openName === name) return;
      setPendingProfile({ name, data: null });
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [setOpenProfile]);

  /* ========================================================================
   * Standalone hotlink view (/p/<X> and /w/<X> direct navigation).
   *
   * The point of these URLs is that they're shareable off-site: someone
   * pastes a profile or world link into Discord / a forum / wherever, and
   * the recipient lands on a clean view of that content — not the full
   * chat with the modal floating over it. This applies regardless of auth
   * state: an authed user clicking a shared link should also get the
   * standalone view rather than chat-with-overlay, since the URL is meant
   * to be a stable artifact.
   *
   * Mechanism: at mount we record whether the page arrived via a deep
   * link. While that flag is set, App renders the PublicViewerShell with
   * the resolved modal(s). The first time the user closes a modal or the
   * fetch resolves to "no content" (404), we drop the flag and fall
   * through to the normal app for the rest of the session — so in-app
   * navigation (clicking a name in chat, etc.) keeps the modal-over-chat
   * behavior the rest of the codebase expects.
   *
   * The world fetch effect runs in any auth state because Chat's own
   * world-viewer plumbing only kicks in once we've left the deep-link
   * flag, by which point this state is null and harmless.
   *
   * (`arrivedViaDeepLink` is declared up near `pendingProfile` so the
   * profile fetch effect can call its setter from above this block.)
   * ====================================================================== */
  const [pendingPublicWorld, setPendingPublicWorld] = useState<{
    slug: string;
    data: PrivateWorldStub | { kind: "view"; detail: WorldDetail } | null;
  } | null>(() => {
    const slug = parseWorldFromUrl();
    return slug ? { slug, data: null } : null;
  });

  // Mount-time fetch for the public-world deep-link. Skipped once we've
  // left the standalone view (Chat owns the world viewer state from that
  // point on) or when we already have a verdict.
  useEffect(() => {
    if (!arrivedViaDeepLink || !pendingPublicWorld || pendingPublicWorld.data) return;
    let cancelled = false;
    fetch(`/worlds/${encodeURIComponent(pendingPublicWorld.slug)}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) return null;
        return (await r.json()) as PrivateWorldStub | WorldDetail;
      })
      .then((j) => {
        if (cancelled) return;
        if (!j) {
          // 404 / fetch failure — drop standalone mode and let normal app
          // flow take over. URL stays /w/<slug> in the address bar; the
          // user can navigate away or refresh.
          setPendingPublicWorld(null);
          setArrivedViaDeepLink(false);
          return;
        }
        if ("private" in j) {
          setPendingPublicWorld((cur) => (cur ? { ...cur, data: j } : cur));
        } else {
          setPendingPublicWorld((cur) => (cur ? { ...cur, data: { kind: "view", detail: j } } : cur));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [arrivedViaDeepLink, pendingPublicWorld]);

  // popstate for the world flow. Only listens during the standalone-view
  // window; once the user has dismissed, Chat's own popstate handler runs.
  useEffect(() => {
    if (!arrivedViaDeepLink) return;
    function onPop() {
      const slug = parseWorldFromUrl();
      if (!slug) {
        setPendingPublicWorld(null);
        return;
      }
      setPendingPublicWorld((cur) => (cur && cur.slug === slug ? cur : { slug, data: null }));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [arrivedViaDeepLink]);

  if (!authChecked) return <BootSplash />;

  // Resolve deep-link verdicts shared by every code path below.
  const publicWorldDetail = pendingPublicWorld?.data && !("private" in pendingPublicWorld.data)
    ? pendingPublicWorld.data.detail
    : null;
  const profileStub = pendingProfile?.data && "private" in pendingProfile.data
    ? pendingProfile
    : null;
  const worldStub = pendingPublicWorld?.data && "private" in pendingPublicWorld.data
    ? pendingPublicWorld.data
    : null;

  // Deep-link still resolving — show the standalone shell with a loading
  // indicator so authed users don't see Chat flash for ~100ms before the
  // modal pops in. Without this, the render between auth-check completion
  // and verdict-fetch completion would briefly land on Chat.
  if (arrivedViaDeepLink && !openProfileForSync && !publicWorldDetail && !profileStub && !worldStub) {
    return (
      <PublicViewerShell isAuthenticated={!!me}>
        <div className="fixed inset-0 z-40 flex items-center justify-center">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-keep-muted">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-keep-action" />
            loading...
          </div>
        </div>
      </PublicViewerShell>
    );
  }

  // Standalone hotlink view. Triggered by direct navigation to /p/<X> or
  // /w/<X> for ANY auth state — the URL is meant to be a stable shareable
  // artifact, so an authed user clicking a shared link sees the modal
  // alone too, not chat-with-overlay. Once the user dismisses, we drop
  // out to the normal app for the rest of the session.
  if (arrivedViaDeepLink && (openProfileForSync || publicWorldDetail)) {
    return (
      <PublicViewerShell isAuthenticated={!!me}>
        {openProfileForSync ? (
          <ProfileModal
            profile={openProfileForSync}
            onClose={() => {
              setOpenProfile(null);
              setPendingProfile(null);
              // If there's nothing else to view, drop out of standalone
              // mode so the rest of the session uses normal in-app flow.
              if (!publicWorldDetail) setArrivedViaDeepLink(false);
            }}
            // Bond clicks load another profile while keeping standalone
            // mode active. World chips do the same via the world path.
            onOpenProfile={(name) => setPendingProfile({ name, data: null })}
            onOpenWorld={(slug) => setPendingPublicWorld({ slug, data: null })}
          />
        ) : null}
        {publicWorldDetail ? (
          <WorldViewerModal
            worldId={publicWorldDetail.world.id}
            initialDetail={publicWorldDetail}
            // Authed visitors get the full controls; anon viewers get a
            // read-only view. The fetch already filtered by visibility,
            // so this is purely about hiding buttons that would 401.
            isAuthenticated={!!me}
            onClose={() => {
              setPendingPublicWorld(null);
              // Address-bar housekeeping: if a profile is still open
              // underneath, replace /w/<slug> with /p/<name>; otherwise
              // replace with /. Replace (not push) so the back button
              // doesn't re-open the world the user just dismissed.
              if (openProfileForSync) {
                const profileName = openProfileForSync.kind === "master"
                  ? openProfileForSync.profile.username
                  : openProfileForSync.profile.name;
                syncProfileUrl(profileName, { replace: true });
              } else {
                syncWorldUrl(null, { replace: true });
              }
              // No other modal? Exit standalone mode for the rest of
              // the session.
              if (!openProfileForSync) setArrivedViaDeepLink(false);
            }}
          />
        ) : null}
      </PublicViewerShell>
    );
  }

  if (!me) {
    // Anonymous + private deep-link stub → AuthGate with a hint banner so
    // the visitor knows why they hit the wall. Or anon with no deep-link
    // at all → plain AuthGate.
    return (
      <AuthGate
        {...(profileStub
          ? { pendingProfileHint: { name: profileStub.name, isPrivate: true } }
          : worldStub
            ? { pendingWorldHint: { name: worldStub.name, slug: worldStub.slug } }
            : {})}
      />
    );
  }
  return <Chat />;
}

/**
 * Standalone shell for direct-link content viewing. Applies the site's
 * default theme so the modal renders against the configured palette and
 * pins a small action link in the corner so the visitor has a clear path
 * forward — sign-in for anonymous viewers, or "open chat" for already-
 * authed users who landed here from a shared link.
 */
function PublicViewerShell({
  children,
  isAuthenticated,
}: {
  children: React.ReactNode;
  isAuthenticated: boolean;
}) {
  const branding = useChat((s) => s.branding);
  const siteName = branding.siteName || "The Spire";
  return (
    <div
      style={themeStyle(branding.defaultTheme)}
      className="relative min-h-screen w-full bg-keep-bg text-keep-text"
    >
      {/* Subtle backdrop image, same as the login splash, so the standalone
          page still feels like part of the site rather than a stripped
          modal floating on a flat color. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-cover bg-[position:-175px_center] opacity-40 md:bg-center"
        style={{ backgroundImage: "url(/the_spire_bg.jpg)" }}
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
        {isAuthenticated ? `Open ${siteName}` : `Sign in to ${siteName}`}
      </a>
      {children}
    </div>
  );
}

function BootSplash() {
  return (
    <SplashShell>
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-keep-muted">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-keep-action" />
          checking session...
        </div>
      </div>
    </SplashShell>
  );
}

function Chat() {
  const me = useChat((s) => s.me);
  const setMe = useChat((s) => s.setMe);
  const setKickReason = useChat((s) => s.setKickReason);
  const setRoom = useChat((s) => s.setRoom);
  const setOccupants = useChat((s) => s.setOccupants);
  const appendMessage = useChat((s) => s.appendMessage);
  const updateMessage = useChat((s) => s.updateMessage);
  const setMessages = useChat((s) => s.setMessages);
  const setCurrentRoom = useChat((s) => s.setCurrentRoom);
  const setNotice = useChat((s) => s.setNotice);
  const setOpenProfile = useChat((s) => s.setOpenProfile);
  const openEditor = useChat((s) => s.openEditor);
  const closeEditor = useChat((s) => s.closeEditor);

  const currentRoomId = useChat((s) => s.currentRoomId);
  const rooms = useChat((s) => s.rooms);
  const messagesByRoom = useChat((s) => s.messagesByRoom);
  const occupants = useChat((s) => s.occupants);
  const notice = useChat((s) => s.notice);
  const openProfile = useChat((s) => s.openProfile);
  const editor = useChat((s) => s.editor);
  const fontStep = useChat((s) => s.fontStep);
  const refreshIntervalSec = useChat((s) => s.refreshIntervalSec);
  const setRefreshIntervalSec = useChat((s) => s.setRefreshIntervalSec);

  const [adminOpen, setAdminOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState<{ filter?: string } | null>(null);
  const [usersOpen, setUsersOpen] = useState<{ query?: string } | null>(null);
  // Password prompt for private rooms — set when the server emits a
  // `prompt-room-password` ui:hint (rail click → server says "needs
  // password"). Cleared on cancel or successful join.
  const [pwPrompt, setPwPrompt] = useState<{ roomId: string; roomName: string } | null>(null);
  // Worldbuilding modals. Only one is visible at a time but state lives
  // independently so e.g. closing the viewer doesn't tear down the list.
  const [worldsListOpen, setWorldsListOpen] = useState(false);
  const [worldEditorId, setWorldEditorId] = useState<string | null>(null);
  // Seed from the URL: if the page loaded at /w/<slug>, the viewer opens
  // immediately so deep-links work pre- and post-login. WorldViewerModal
  // normalizes the URL to the canonical slug after the world detail loads.
  const [worldViewerId, setWorldViewerId] = useState<string | null>(() => parseWorldFromUrl());
  const [worldCatalogOpen, setWorldCatalogOpen] = useState(false);
  const [navLinksVersion, setNavLinksVersion] = useState(0);
  const [composerText, setComposerText] = useState("");
  // Rooms drawer on mobile (md breakpoint and below). Always-open on desktop.
  const [railOpen, setRailOpen] = useState(false);
  const [roomsTree, setRoomsTree] = useState<RoomWithOccupants[]>([]);
  const [roomsTreeVersion, setRoomsTreeVersion] = useState(0);
  const [activeTheme, setActiveTheme] = useState<Theme>(DEFAULT_THEME);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [activeCharacterName, setActiveCharacterName] = useState<string | null>(null);
  const [notifyPref, setNotifyPref] = useState<NotifyPref>("mentions");
  /**
   * Admin-configured one-shot welcome modal. /me/profile returns this only
   * when the user hasn't acknowledged the current welcome's content hash;
   * dismissing POSTs the hash so they don't see it again until the admin
   * edits the welcome text (which rotates the hash and re-shows to all).
   */
  const [welcome, setWelcome] = useState<{ html: string; hash: string } | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);

  const socket = useMemo(() => getSocket(), []);

  /**
   * Keep the URL in sync with the open world viewer so deep-links survive
   * refresh + are bookmarkable. Pushing to history (rather than replacing)
   * means the browser back button closes the viewer naturally instead of
   * navigating off the app.
   */
  useEffect(() => {
    syncWorldUrl(worldViewerId);
  }, [worldViewerId]);

  /**
   * Browser back/forward navigation - read the URL and adjust state to
   * match. Without this, popstate would change the URL but leave the
   * viewer state stale (open viewer + URL says /, or closed viewer + URL
   * says /w/...).
   */
  useEffect(() => {
    function onPop() {
      const slug = parseWorldFromUrl();
      setWorldViewerId(slug);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /**
   * Resolve and apply the caller's *active* theme: the active character's
   * theme if set, else the master theme. Re-fetched whenever the editor
   * closes or `/char switch` fires (both bump themeVersion).
   */
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const me = await fetch("/me/profile", { credentials: "include" });
        if (!me.ok) return;
        const u = (await me.json()) as {
          theme?: unknown;
          activeCharacterId: string | null;
          activeCharacterName?: string | null;
          notifyPref?: NotifyPref;
          welcome?: { html: string; hash: string } | null;
        };
        let theme = normalizeTheme(u.theme);
        if (u.activeCharacterId) {
          const c = await fetch(`/characters/${u.activeCharacterId}`, { credentials: "include" });
          if (c.ok) {
            const cr = (await c.json()) as { themeJson?: string | null };
            if (cr.themeJson) {
              try { theme = normalizeTheme(JSON.parse(cr.themeJson)); } catch { /* keep master */ }
            }
          }
        }
        if (!cancelled) {
          setActiveTheme(theme);
          setActiveCharacterId(u.activeCharacterId);
          setActiveCharacterName(u.activeCharacterName ?? null);
          if (u.notifyPref) setNotifyPref(u.notifyPref);
          // Server-side gating: only present when there's an unseen
          // welcome to surface. Dismissal flips the user's stored hash
          // server-side, so re-fetches stop returning this field.
          if (u.welcome) setWelcome(u.welcome);
        }
      } catch { /* ignore */ }
    }
    load();
    return () => { cancelled = true; };
  }, [themeVersion]);

  // Apply whichever theme is active to the document. Sets CSS vars on <html>
  // so they override the :root defaults from styles.css.
  useEffect(() => { applyTheme(activeTheme); }, [activeTheme]);

  /**
   * Activity heartbeat for sliding session-idle expiry.
   *
   * The server treats `presence:active` as the canonical "user is at the
   * keyboard" signal and uses it to extend the session row's expiresAt.
   * Without this, a user who keeps the chat tab open but only reads (no
   * commands, no room switches) would be considered idle and kicked at
   * the timeout boundary.
   *
   * Throttled to once every 30 seconds so we're not slamming the socket
   * on every mousemove. Listens on document so any interaction in the chat
   * UI counts; pointer events cover both desktop mouse and mobile touch.
   * `visibilitychange` re-pings when the user switches back to the tab so
   * a long-backgrounded tab gets a fresh extension immediately on return.
   */
  useEffect(() => {
    const HEARTBEAT_MS = 30_000;
    let lastSent = 0;
    function ping() {
      const now = Date.now();
      if (now - lastSent < HEARTBEAT_MS) return;
      lastSent = now;
      socket.emit("presence:active");
    }
    function onVisibility() {
      if (!document.hidden) ping();
    }
    document.addEventListener("mousemove", ping, { passive: true });
    document.addEventListener("keydown", ping);
    document.addEventListener("pointerdown", ping, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    // Send one immediately on mount so the session is extended as soon as
    // the user lands in chat (matches their "I just logged in" intent).
    ping();
    return () => {
      document.removeEventListener("mousemove", ping);
      document.removeEventListener("keydown", ping);
      document.removeEventListener("pointerdown", ping);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [socket]);

  /**
   * Desktop notifications - fires when the tab is hidden (minimized OR on
   * another tab) and the message matches the user's notifyPref. Filtering is
   * pure (in lib/notifications.ts) so it's deterministic per-message.
   *
   * `selfNames` covers both the master username and (if any) the active
   * character name so @mentions resolve no matter which identity is
   * currently in play.
   */
  useEffect(() => {
    const selfNames = [
      ...(me?.username ? [me.username] : []),
      ...(activeCharacterName ? [activeCharacterName] : []),
    ];
    function onMessage(msg: ChatMessage) {
      if (shouldNotify(msg, me?.id ?? null, notifyPref, document.hidden, selfNames)) {
        fireNotification(msg, selfNames);
      }
    }
    socket.on("message:new", onMessage);
    return () => { socket.off("message:new", onMessage); };
  }, [socket, me, notifyPref, activeCharacterName]);

  // Fetch the rooms tree whenever it might have changed: room switches,
  // explicit refresh, or every 20s as a backstop for cross-room presence.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/rooms", { credentials: "include" });
        if (!r.ok) return;
        const j = (await r.json()) as { rooms: RoomWithOccupants[] };
        if (!cancelled) setRoomsTree(j.rooms);
      } catch { /* ignore */ }
    }
    load();
    const id = window.setInterval(load, 20_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [roomsTreeVersion, currentRoomId]);

  useEffect(() => {
    socket.on("room:state", ({ room, occupants }) => {
      setRoom(room);
      setOccupants(room.id, occupants);
      setCurrentRoom(room.id);
      // Joining/creating a room means the rooms tree is stale.
      setRoomsTreeVersion((v) => v + 1);
    });
    socket.on("presence:update", ({ roomId, occupants }) => {
      setOccupants(roomId, occupants);
      // Presence changes in our current room mean other rooms might have
      // changed too (e.g. another user just left a room to join ours), and
      // /char switch broadcasts presence - refetch the active theme too.
      setRoomsTreeVersion((v) => v + 1);
      setThemeVersion((v) => v + 1);
    });
    socket.on("message:new", (msg: ChatMessage) => appendMessage(msg));
    socket.on("message:bulk", (msgs: ChatMessage[]) => {
      if (msgs.length) setMessages(msgs[0]!.roomId, msgs);
    });
    socket.on("message:update", (msg: ChatMessage) => updateMessage(msg));
    socket.on("watch:online", ({ username, displayName }) => {
      // Surface a small system line in the current room so the user sees
      // it inline (and it sticks in the timeline). Desktop toast is fired
      // separately - watchers usually want both surfaces.
      const body = displayName === username
        ? `${username} is online.`
        : `${displayName} (${username}) is online.`;
      const id = `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const roomId = useChat.getState().currentRoomId;
      if (roomId) {
        appendMessage({
          id,
          roomId,
          userId: "system",
          characterId: null,
          displayName: "system",
          kind: "system",
          body: `☆ ${body}`,
          color: null,
          createdAt: Date.now(),
        });
      }
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try { new Notification("Watching", { body, icon: "/favicon.ico", tag: `watch-${username}` }); }
        catch { /* ignore */ }
      }
    });
    socket.on("error:notice", (n) => setNotice(n));
    socket.on("auth:expired", () => {
      // Server invalidated the session (idle window elapsed, admin disabled
      // the account, or the janitor sweep deleted the row). Hand the client
      // back to the splash with an explanation banner - the cookie is
      // already worthless, so /auth/me would 401 anyway.
      setKickReason("Your session expired due to inactivity. Please log in again.");
      disconnectSocket();
      setMe(null);
    });
    socket.on("ui:hint", (h) => {
      switch (h.kind) {
        case "open-profile":
          setOpenProfile(h.profile);
          break;
        case "open-my-editor":
          openEditor({ mode: h.mode, characterId: h.characterId });
          break;
        case "open-character-editor":
          openEditor({ mode: "character", characterId: h.characterId });
          break;
        case "set-refresh-interval":
          setRefreshIntervalSec(h.seconds);
          break;
        case "open-help":
          setHelpOpen(h.filter ? { filter: h.filter } : {});
          break;
        case "open-users":
          setUsersOpen(h.query ? { query: h.query } : {});
          break;
        case "open-worlds-list":
          setWorldsListOpen(true);
          break;
        case "open-world-catalog":
          setWorldCatalogOpen(true);
          break;
        case "open-world":
          setWorldViewerId(h.worldId);
          break;
        case "clear-room-messages": {
          // Read fresh state - the ui:hint handler is registered once and
          // its closure would otherwise capture a stale currentRoomId.
          const rid = useChat.getState().currentRoomId;
          if (rid) setMessages(rid, []);
          break;
        }
        case "force-room-join": {
          // A sibling tab/device on this same account just changed rooms;
          // server is asking us to follow. Fire room:join — the server's
          // own loop guard skips siblings already in the target room, so
          // this won't ping-pong. We don't surface a notice here (the
          // user already initiated the move on the other tab) and we
          // don't block on the ack (any failure just leaves us where we
          // were, which the user can correct manually).
          const targetId = h.roomId;
          if (useChat.getState().currentRoomId !== targetId) {
            socket.emit("room:join", { roomId: targetId }, () => {});
          }
          break;
        }
        case "prompt-room-password":
          setPwPrompt({ roomId: h.roomId, roomName: h.roomName });
          break;
      }
    });

    /**
     * Mutual-title state changed somewhere - if the user is currently
     * looking at a profile, refetch it so newly-accepted titles (or
     * dissolved ones) appear without forcing them to close and reopen
     * the modal. We read openProfile via getState to avoid putting it
     * in this useEffect's deps and re-binding all socket listeners.
     */
    socket.on("mutual:settled", () => {
      const open = useChat.getState().openProfile;
      if (!open) return;
      const name = open.kind === "master" ? open.profile.username : open.profile.name;
      socket.emit("profile:fetch", { username: name }, (res) => {
        if (res.ok) setOpenProfile(res.profile);
        // If the lookup fails (e.g. the other party deleted), leave the
        // current view in place rather than yanking it out from under
        // the user.
      });
    });

    return () => {
      socket.off("room:state");
      socket.off("presence:update");
      socket.off("message:new");
      socket.off("message:bulk");
      socket.off("message:update");
      socket.off("watch:online");
      socket.off("error:notice");
      socket.off("auth:expired");
      socket.off("ui:hint");
      socket.off("mutual:settled");
    };
  }, [socket, setRoom, setOccupants, appendMessage, updateMessage, setMessages, setCurrentRoom, setNotice, setOpenProfile, openEditor, setRefreshIntervalSec, setMe]);

  function send(text: string) {
    if (!currentRoomId) return;
    socket.emit("chat:input", { roomId: currentRoomId, text });
  }

  /**
   * Auto-refresh interval. The server emits a `set-refresh-interval` UI hint
   * whose `seconds` value drives this effect. We re-run whenever the interval
   * or the current room changes; cleanup cancels the prior timer.
   */
  useEffect(() => {
    if (!refreshIntervalSec || !currentRoomId) return;
    const ms = refreshIntervalSec * 1000;
    const id = window.setInterval(() => {
      socket.emit("chat:input", { roomId: currentRoomId, text: "/refresh" });
    }, ms);
    return () => window.clearInterval(id);
  }, [refreshIntervalSec, currentRoomId, socket]);

  /**
   * Click on the gender icon - view someone's profile, or open the editor
   * if it's me. (Slash-command equivalents: /whois <name> and /profile.)
   */
  function onIconClick(userId: string, displayName: string) {
    if (me && userId === me.id) {
      send("/profile");
      return;
    }
    socket.emit("profile:fetch", { username: displayName }, (res) => {
      if (res.ok) setOpenProfile(res.profile);
      else setNotice({ code: res.code, message: res.message });
    });
  }

  /**
   * Click on the name - pre-fill the composer with `/whisper <name> ` so the
   * user can finish typing and Enter. For your own name we fall back to the
   * icon behavior (open editor) since whispering yourself is useless.
   */
  function onNameClick(userId: string, displayName: string) {
    if (me && userId === me.id) {
      send("/profile");
      return;
    }
    setComposerText(`/whisper ${displayName} `);
  }

  /**
   * Click on a message's timestamp - pre-fill the composer with `/reply <id> `
   * so the user can finish typing and Enter. Mirrors the /whisper-on-name
   * pattern. Only enabled by MessageList for replyable kinds (say/me/ooc);
   * the server re-validates on submit.
   */
  function onTimeClick(msgId: string) {
    setComposerText(`/reply ${msgId} `);
  }

  /**
   * Click on an @mention inside a message body. Per the spec this should
   * open the user's profile (not whisper) - and resolve to their *active*
   * character profile when they have one, falling back to master. The
   * existing profile:fetch handler already implements that resolution.
   */
  function onMentionClick(name: string) {
    socket.emit("profile:fetch", { username: name }, (res) => {
      if (res.ok) setOpenProfile(res.profile);
      else setNotice({ code: res.code, message: res.message });
    });
  }

  function onRoomClick(roomId: string) {
    if (roomId === currentRoomId) return;
    socket.emit("room:join", { roomId }, (res) => {
      if (!res.ok) setNotice({ code: res.code, message: res.message });
    });
  }

  const room = currentRoomId ? rooms[currentRoomId] : undefined;
  const messages = currentRoomId ? messagesByRoom[currentRoomId] ?? [] : [];
  const occ = currentRoomId ? occupants[currentRoomId] ?? [] : [];

  return (
    // Pin the entire chat shell to the viewport with position: fixed so
    // document-level scroll (autoFocus on the composer scrolling things
    // into view, mobile chrome address-bar resize, etc.) can't shift it
    // out from under the user. inset-0 (top/right/bottom/left = 0) anchors
    // it to all four edges of the layout viewport, which is what older
    // browsers fall back to. h-dvh overrides the height where supported,
    // so on mobile keyboards the shell shrinks with the visual viewport
    // and the composer follows instead of being pushed beneath the
    // keyboard. overflow-hidden keeps any internal flex child that grows
    // past its allocated height from leaking back into document overflow.
    <div className="fixed inset-0 flex h-dvh flex-col overflow-hidden">
      <Banner
        navLinksVersion={navLinksVersion}
        onOpenRules={() => setRulesOpen(true)}
        {...(me?.role === "admin" ? { onOpenAdmin: () => setAdminOpen(true) } : {})}
      />
      {room?.linkedWorld ? (
        <button
          type="button"
          onClick={() => setWorldViewerId(room.linkedWorld!.id)}
          className="flex w-full items-center justify-center gap-2 border-b border-keep-rule bg-keep-action/10 px-4 py-1 text-xs text-keep-action hover:bg-keep-action/20"
          title="Open this room's linked world"
        >
          <span className="uppercase tracking-widest">World</span>
          <span className="font-semibold normal-case tracking-normal">{room.linkedWorld.name}</span>
          <span className="text-[10px] text-keep-muted">by {room.linkedWorld.ownerUsername}</span>
        </button>
      ) : null}
      {room?.topic ? (
        <div className="border-b border-keep-rule bg-keep-banner/40 px-4 py-1 text-center text-sm italic text-keep-muted">
          {room.topic}
        </div>
      ) : null}
      {room?.messageExpiryMinutes && room.messageExpiryMinutes > 0 ? (
        <div className="border-b border-keep-rule/60 bg-keep-banner/20 px-4 py-0.5 text-center text-[10px] uppercase tracking-widest text-keep-muted">
          Messages auto-expire after {formatExpiry(room.messageExpiryMinutes)}
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <main className="flex min-h-0 flex-1 flex-col">
          <MessageList
            messages={messages}
            occupants={occ}
            selfUserId={me?.id ?? null}
            roomType={room?.type ?? null}
            replyMode={room?.replyMode ?? "flat"}
            onIconClick={onIconClick}
            onNameClick={onNameClick}
            onMentionClick={onMentionClick}
            onWorldClick={(slug) => setWorldViewerId(slug)}
            onTimeClick={onTimeClick}
            fontStep={fontStep}
          />
          <MutualPrompts
            socket={socket}
            onError={(n) => setNotice(n)}
          />
          <Composer
            value={composerText}
            onChange={setComposerText}
            onSend={send}
            occupants={occ}
            onOpenRail={() => setRailOpen(true)}
          />
        </main>
        {/* Mobile-only backdrop when rail drawer is open */}
        {railOpen ? (
          <div
            className="fixed inset-0 z-30 bg-black/60 md:hidden"
            onClick={() => setRailOpen(false)}
            aria-hidden="true"
          />
        ) : null}
        <RoomsTree
          rooms={roomsTree}
          currentRoomId={currentRoomId}
          activeCharacterId={activeCharacterId}
          onIconClick={onIconClick}
          onNameClick={(uid, dn) => {
            onNameClick(uid, dn);
            setRailOpen(false); // mobile: close drawer after picking
          }}
          onRoomClick={(rid) => {
            onRoomClick(rid);
            setRailOpen(false);
          }}
          onCommand={(text) => {
            send(text);
            setRailOpen(false);
          }}
          onWorldClick={(worldId) => {
            setWorldViewerId(worldId);
            setRailOpen(false);
          }}
          isOpen={railOpen}
          onClose={() => setRailOpen(false)}
        />
      </div>
      {notice ? <Toast notice={notice} onDismiss={() => setNotice(null)} /> : null}
      {openProfile ? (
        <ProfileModal
          profile={openProfile}
          onClose={() => setOpenProfile(null)}
          // The owner + site admins skip the NSFW gate splash. Owners
          // wouldn't gain anything from being warned about their own
          // content; admins need to see profiles for moderation regardless
          // of how the author marked them.
          bypassNsfwGate={!!me && (me.id === openProfile.profile.userId || me.role === "admin")}
          // Whisper / ignore are noise on your own profile - they're for
          // interacting with someone else. Suppress when the profile's
          // owning userId matches the viewer (covers your master profile
          // and any of your characters - both shapes carry userId).
          {...(me && openProfile.profile.userId !== me.id
            ? {
                onWhisper: (name: string) => {
                  setOpenProfile(null);
                  setComposerText(`/whisper ${name} `);
                },
                onIgnore: (name: string) => {
                  setOpenProfile(null);
                  send(`/ignore ${name}`);
                },
              }
            : {})}
          // Active-character action — only renders on profiles the viewer
          // owns. Three cases:
          //   * master profile + viewer has an active char → "Switch to OOC"
          //     (clears active character)
          //   * a non-active character of theirs            → "Switch to <name>"
          //   * the currently-active character              → "Disable <name>"
          // All three call the same endpoint the editor uses; afterwards
          // bump themeVersion so chat re-fetches /me/profile and re-applies
          // the right theme.
          {...(() => {
            if (!me || openProfile.profile.userId !== me.id) return {};
            const isMaster = openProfile.kind === "master";
            const isCharacterOpen = openProfile.kind === "character";
            const openCharId = isCharacterOpen ? openProfile.profile.id : null;
            const isActiveOpen = isCharacterOpen && openCharId === activeCharacterId;

            let label: string | null = null;
            let nextCharacterId: string | null | undefined = undefined;
            if (isMaster && activeCharacterId) {
              label = "Switch to OOC";
              nextCharacterId = null;
            } else if (isCharacterOpen && !isActiveOpen) {
              label = `Switch to ${openProfile.profile.name}`;
              nextCharacterId = openCharId;
            } else if (isCharacterOpen && isActiveOpen) {
              label = `Disable ${openProfile.profile.name}`;
              nextCharacterId = null;
            }
            if (!label || nextCharacterId === undefined) return {};

            const targetId = nextCharacterId;
            return {
              activeCharacterAction: {
                label,
                onClick: () => {
                  fetch("/me/active-character", {
                    method: "PUT",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ characterId: targetId }),
                  })
                    .then(async (r) => {
                      if (!r.ok) {
                        const j = (await r.json().catch(() => ({} as { error?: string })));
                        throw new Error(j.error ?? `HTTP ${r.status}`);
                      }
                      setOpenProfile(null);
                      setThemeVersion((v) => v + 1);
                    })
                    .catch((err) => setNotice({ code: "SWITCH_FAILED", message: err instanceof Error ? err.message : "switch failed" }));
                },
              },
            };
          })()}
          onOpenProfile={(name) => {
            socket.emit("profile:fetch", { username: name }, (res) => {
              if (res.ok) setOpenProfile(res.profile);
              else setNotice({ code: res.code, message: res.message });
            });
          }}
          // Worlds chips on the profile open the viewer on top of the
          // profile modal. Closing the world viewer drops the user back to
          // the profile they were reading, which matches how the room
          // banner's world button stacks above other open modals.
          onOpenWorld={(slug) => setWorldViewerId(slug)}
        />
      ) : null}
      {editor ? (
        <ProfileEditor
          mode={editor.mode}
          characterId={editor.characterId}
          onClose={() => {
            closeEditor();
            setThemeVersion((v) => v + 1);
          }}
          // Re-apply the active theme on every save so users see changes
          // immediately without having to close the editor.
          onSaved={() => setThemeVersion((v) => v + 1)}
        />
      ) : null}
      {adminOpen && me?.role === "admin" ? (
        <AdminPanel
          onClose={() => setAdminOpen(false)}
          onLinksChanged={() => setNavLinksVersion((v) => v + 1)}
        />
      ) : null}
      {rulesOpen ? <RulesModal onClose={() => setRulesOpen(false)} /> : null}
      {pwPrompt ? (
        <RoomPasswordModal
          roomId={pwPrompt.roomId}
          roomName={pwPrompt.roomName}
          socket={socket}
          onClose={() => setPwPrompt(null)}
        />
      ) : null}
      {helpOpen ? (
        <HelpModal
          onClose={() => setHelpOpen(null)}
          {...(helpOpen.filter ? { initialFilter: helpOpen.filter } : {})}
        />
      ) : null}
      {usersOpen ? (
        <UsersModal
          {...(usersOpen.query ? { initialQuery: usersOpen.query } : {})}
          onClose={() => setUsersOpen(null)}
          onOpenName={(name) => {
            setUsersOpen(null);
            socket.emit("profile:fetch", { username: name }, (res) => {
              if (res.ok) setOpenProfile(res.profile);
              else setNotice({ code: res.code, message: res.message });
            });
          }}
        />
      ) : null}
      {worldsListOpen ? (
        <WorldsListModal
          onClose={() => setWorldsListOpen(false)}
          onOpenEditor={(worldId) => {
            setWorldsListOpen(false);
            setWorldEditorId(worldId);
          }}
          onOpenViewer={(worldId) => {
            setWorldsListOpen(false);
            setWorldViewerId(worldId);
          }}
          onOpenCatalog={() => {
            setWorldsListOpen(false);
            setWorldCatalogOpen(true);
          }}
        />
      ) : null}
      {worldEditorId ? (
        <WorldEditorModal
          worldId={worldEditorId}
          onClose={() => setWorldEditorId(null)}
          onDeleted={() => {
            // After delete, drop back to the list so they can pick another
            // world (or close out).
            setWorldEditorId(null);
            setWorldsListOpen(true);
          }}
        />
      ) : null}
      {worldViewerId ? (
        <WorldViewerModal
          worldId={worldViewerId}
          onClose={() => setWorldViewerId(null)}
          // Only owners get the "Edit" button. The server enforces the same
          // check on PATCH/DELETE; this is just for UI affordance. We don't
          // know ownership without inspecting the loaded WorldDetail, so
          // expose the action only when we can plausibly succeed: the viewer
          // is logged in. The editor itself will show an error if they
          // aren't actually the owner.
          {...(me ? { onEdit: () => { const id = worldViewerId; setWorldViewerId(null); setWorldEditorId(id); } } : {})}
        />
      ) : null}
      {worldCatalogOpen ? (
        <WorldCatalogModal
          currentRoomId={currentRoomId}
          onClose={() => setWorldCatalogOpen(false)}
          onOpenViewer={(worldId) => {
            setWorldCatalogOpen(false);
            setWorldViewerId(worldId);
          }}
        />
      ) : null}
      {/* One-shot welcome / announcement modal. Server decides when to send
          this; we just render and forward dismissal. Sits above other
          modals via its own z-50 so a deploy announcement isn't hidden
          behind a stale profile / world overlay. */}
      {welcome ? (
        <WelcomeModal
          html={welcome.html}
          hash={welcome.hash}
          onDismissed={() => setWelcome(null)}
        />
      ) : null}
    </div>
  );
}

/** Display the per-room expiry window in the most natural unit. Pure helper. */
function formatExpiry(mins: number): string {
  if (mins >= 1440 && mins % 1440 === 0) {
    const d = mins / 1440;
    return `${d} ${d === 1 ? "day" : "days"}`;
  }
  if (mins >= 60 && mins % 60 === 0) {
    const h = mins / 60;
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  return `${mins} ${mins === 1 ? "minute" : "minutes"}`;
}

function Toast({ notice, onDismiss }: { notice: { code: string; message: string }; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [notice, onDismiss]);
  return (
    <div className="pointer-events-none fixed bottom-16 left-1/2 z-30 -translate-x-1/2 max-w-[80vw] rounded border border-keep-rule bg-keep-parchment px-3 py-2 text-sm shadow">
      <span className="text-keep-muted">[{notice.code}]</span>{" "}
      <span className="whitespace-pre-wrap">{notice.message}</span>
    </div>
  );
}
