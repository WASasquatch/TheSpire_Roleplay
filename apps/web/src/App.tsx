import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, PermissionKey, PrivateWorldStub, ProfileView, Role, Theme, ThreadCategory, WorldDetail } from "@thekeep/shared";
import { DEFAULT_PRESET_DESIGNS, DEFAULT_THEME, isDarkPalette, matchThemePreset, normalizeTheme, VERSION } from "@thekeep/shared";
import { AdminPanel } from "./components/AdminPanel.js";
import { AuthGate, SplashShell } from "./components/AuthGate.js";
import { SplashLanding } from "./components/SplashLanding.js";
import { Banner } from "./components/Banner.js";
import { Composer } from "./components/Composer.js";
import { TypingIndicator } from "./components/TypingIndicator.js";
import { HelpModal } from "./components/HelpModal.js";
import { MessageList } from "./components/MessageList.js";
import { MutualPrompts } from "./components/MutualPrompts.js";
import { StoryInvitePrompts } from "./components/StoryInvitePrompts.js";
import { FriendRequestPrompts } from "./components/FriendRequestPrompts.js";
import { BookmarksModal } from "./components/BookmarksModal.js";
import { ProfileEditor } from "./components/ProfileEditor.js";
import { ProfileModal } from "./components/ProfileModal.js";
import { RoomPasswordModal } from "./components/RoomPasswordModal.js";
import { RoomsTree, type RoomWithOccupants } from "./components/RoomsTree.js";
import { MessagesModal } from "./components/MessagesModal.js";
import { RulesModal } from "./components/RulesModal.js";
import { EarningDashboard } from "./components/EarningDashboard.js";
import { EarningRibbon } from "./components/EarningRibbon.js";
import { ItemZoomView, type ItemZoomEntry } from "./components/ItemZoomView.js";
import { ThreadModal } from "./components/ThreadModal.js";
import { UsersModal } from "./components/UsersModal.js";
import { WorldCatalogModal } from "./components/WorldCatalogModal.js";
import { WorldEditorModal } from "./components/WorldEditorModal.js";
import { WorldViewerModal } from "./components/WorldViewerModal.js";
import { WorldsListModal } from "./components/WorldsListModal.js";
import { StoryCatalogModal } from "./components/StoryCatalogModal.js";
import { StoryEditorModal } from "./components/StoryEditorModal.js";
import { StoryReaderModal } from "./components/StoryReaderModal.js";
import { WelcomeModal } from "./components/WelcomeModal.js";
import { getSocket, disconnect as disconnectSocket, hasSessionBeenAnnounced, loadTabCharacter, markLoginIntent, rememberTabCharacter, rememberTabRoom } from "./lib/socket.js";
import { parseWorldFromUrl, syncWorldUrl } from "./lib/worlds.js";
import { parseProfileFromUrl, syncProfileUrl, type PrivateProfileStub } from "./lib/profiles.js";
import { ActiveThemeContext, applyFontPrefs, applyTheme, resolveSplashTheme, splashBgUrl, themeStyle, type UiFontScale } from "./lib/theme.js";
import { applyStyle, DEFAULT_STYLE_KEY } from "./lib/ornaments/index.js";
import { fire as fireNotification, permission as notifPermission, shouldNotify, type NotifyPref } from "./lib/notifications.js";
import { clearSessionToken, withIdentityQuery } from "./lib/http.js";
import { identityArgFor, nameForCommand } from "./lib/commandText.js";
import { playAlert, playPing, playTap, playWhisper } from "./lib/sound.js";
import { saveCachedActiveTheme, useChat, type SiteBranding } from "./state/store.js";
import { fetchEmoticonCatalog, useEmoticons } from "./state/emoticons.js";
import { parseScriptoriumFromUrl, storyPermalink } from "./lib/scriptoriumUrl.js";
import { useEarning } from "./state/earning.js";
import { runStruckEffect } from "./lib/chatEffects.js";
import { injectNameStyles } from "./lib/nameStyleInjector.js";
import { injectFreeformBorders } from "./lib/freeformBorderInjector.js";

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

  // Prime the emoticon catalog once at boot. Public endpoint; safe
  // for anonymous splash visitors too (they won't render reactions
  // but a future-clicked link could carry them straight into chat
  // where the picker needs the sheets cached). Subsequent admin
  // edits push `emoticons:updated` over the socket, which the
  // listener below re-fetches.
  useEffect(() => {
    void fetchEmoticonCatalog();
  }, []);

  // Sync the logo font CSS variable with branding. (Tab title is set
  // in a separate route-aware effect below.)
  useEffect(() => {
    const logoFont = branding.logoFont ?? "";
    document.documentElement.style.setProperty("--keep-logo-font", logoFont);
  }, [branding.logoFont]);

  // Restore session on mount. Until this resolves we deliberately render
  // *neither* AuthGate nor Chat - otherwise a logged-in user reloading the
  // page (or following a banner link) sees AuthGate flash for ~100ms before
  // the token probe completes. The bearer token is attached automatically
  // by the lib/http fetch interceptor when sessionStorage holds one.
  useEffect(() => {
    let cancelled = false;
    fetch("/auth/me")
      .then(async (r) => {
        // Clear a stale token immediately on 401 — otherwise the next
        // tab open inherits a dead token and the user wonders why every
        // request bounces them back to the splash.
        if (r.status === 401) clearSessionToken();
        return r.ok
          ? (r.json() as Promise<{
              id: string;
              username: string;
              role: Role;
              permissions: PermissionKey[];
              version?: string;
              updateMessage?: string | null;
            }>)
          : null;
      })
      .then((j) => {
        if (cancelled) return;
        if (j) {
          // Cookie-restored session = first time this tab has entered
          // the app under this account. Treat it as a real "session
          // start" so the server fires the "X has connected." chat
          // broadcast (and the custom session-connect template if the
          // user has the flair). Without this, returning users who
          // re-enter via an existing cookie got the watcher ping
          // ("X is online") in their friends' rooms but their own
          // room never saw an arrival message — the Wallace re-entry
          // bug. `hasSessionBeenAnnounced` reads a tab-sticky
          // sessionStorage flag that `markLoginIntent` sets, so a
          // page reload within the SAME tab is silent (sessionStorage
          // survives reload) while a brand-new tab gets a fresh slate
          // and announces correctly. The login form path also calls
          // markLoginIntent independently; both ultimately set the
          // same one-shot sessionStorage marker the socket auth
          // callback consumes.
          if (!hasSessionBeenAnnounced()) {
            markLoginIntent();
          }
          setMe({
            id: j.id,
            username: j.username,
            role: j.role,
            permissions: j.permissions ?? [],
          });
          // Detect a post-deploy version drift on the very first probe.
          // If the user opened this tab before a deploy, the bundle they
          // loaded reports an older VERSION than the live server, and
          // we surface that immediately rather than waiting up to 60s
          // for the backstop poll.
          if (j.version && j.version !== VERSION) {
            useChat.getState().setStaleVersion(j.version, j.updateMessage ?? null);
          }
        }
        setAuthChecked(true);
      })
      .catch(() => {
        if (!cancelled) setAuthChecked(true);
      });
    return () => { cancelled = true; };
  }, [setMe, setAuthChecked]);

  // Earning — refresh the cached snapshot when a user signs in (so
  // the Banner indicator dot and the dashboard load with up-to-date
  // wallets + unack rank-ups), reset to the empty state on sign-out
  // so the next account doesn't briefly see the previous user's
  // numbers before the next fetch lands.
  useEffect(() => {
    if (me) {
      void useEarning.getState().refresh();
    } else {
      useEarning.getState().reset();
    }
  }, [me?.id]);

  // Name styles — inject the catalog's CSS into <head> whenever the
  // snapshot lands or admins reload it. Idempotent re-injection: the
  // helper rewrites the shared <style> tag only when the concatenated
  // CSS actually changed. Subscription via Zustand's hook so the
  // effect re-runs on any catalog edit (an admin tweak surfaces live
  // on the next /earning/me fetch).
  const nameStyleCatalog = useEarning((s) => s.snapshot?.catalog.nameStyles);
  useEffect(() => {
    if (nameStyleCatalog) injectNameStyles(nameStyleCatalog);
  }, [nameStyleCatalog]);

  // Free-form borders — same idempotent CSS-injection pattern as
  // name styles. Only the `template`+`style_css` rows contribute
  // rules; image-based rows render via overlay <img> in
  // BorderedAvatar and have no CSS to ship.
  const freeformBorderCatalog = useEarning((s) => s.snapshot?.catalog.freeformBorders);
  useEffect(() => {
    if (freeformBorderCatalog) injectFreeformBorders(freeformBorderCatalog);
  }, [freeformBorderCatalog]);

  // Backstop poll: re-verify the session every 60s so admin-shortened TTLs
  // (or janitor sweeps) drop the user back to the login splash even if they
  // never type or click. The socket bounces them sooner via `auth:expired`,
  // but this catches cases where the socket disconnected silently.
  //
  // /auth/me is intentionally NOT counted as user activity on the server
  // (see auth/session.ts) - otherwise this poll would keep idle tabs logged
  // in forever, defeating the idle-timeout feature.
  //
  // The same fetch also carries the post-deploy version-drift check (see
  // `probeVersion` below). Up to 60s is fine for the session-TTL purpose,
  // but it's a long lag for "the site just updated, please refresh" —
  // so we ALSO probe on tab focus and on socket reconnect (see effects
  // below). A deploy reliably triggers the socket reconnect path, so in
  // practice the banner now surfaces within a couple of seconds of the
  // user's tab regaining the server.
  const probeVersion = useCallback(async () => {
    try {
      const r = await fetch("/auth/me");
      if (!r.ok) return;
      const j = (await r.json()) as { version?: string; updateMessage?: string | null };
      if (j.version && j.version !== VERSION) {
        useChat.getState().setStaleVersion(j.version, j.updateMessage ?? null);
      }
    } catch { /* network blip - ignore */ }
  }, []);
  useEffect(() => {
    if (!me) return;
    const id = window.setInterval(async () => {
      try {
        const r = await fetch("/auth/me");
        if (!r.ok) {
          // Same logic as logout: clear the token before disconnecting
          // so an in-flight reconnect attempt doesn't carry the dead
          // sid back to the server.
          clearSessionToken();
          setKickReason("Your session expired due to inactivity. Please log in again.");
          disconnectSocket();
          setMe(null);
          return;
        }
        const j = (await r.json()) as {
          id: string;
          username: string;
          role: Role;
          permissions?: PermissionKey[];
          version?: string;
          updateMessage?: string | null;
        };
        if (j.version && j.version !== VERSION) {
          useChat.getState().setStaleVersion(j.version, j.updateMessage ?? null);
        }
        // Refresh me.permissions on every poll so a matrix edit lands
        // on the affected user's tab within a minute — but only call
        // setMe when something actually changed. Calling setMe with a
        // new object reference on every poll re-renders every
        // subscriber of `me` (banner, message list, composer, etc.),
        // which is a noticeable hit every 60 seconds even when nothing
        // has changed.
        if (Array.isArray(j.permissions)) {
          const cur = useChat.getState().me;
          const changed =
            !cur
            || cur.id !== j.id
            || cur.username !== j.username
            || cur.role !== j.role
            || !samePermissions(cur.permissions, j.permissions);
          if (changed) {
            setMe({
              id: j.id,
              username: j.username,
              role: j.role,
              permissions: j.permissions,
            });
          }
        }
      } catch { /* network blip - ignore */ }
    }, 60_000);
    return () => window.clearInterval(id);
  }, [me, setMe, setKickReason]);

  // Tab-focus re-probe. A user with a backgrounded tab won't see the
  // 60s poll fire reliably (browsers throttle timers in hidden tabs),
  // so the version mismatch can sit undetected for many minutes. Firing
  // `probeVersion` on visibility / focus catches the "I tabbed back
  // after the site was redeployed" case immediately.
  useEffect(() => {
    if (!me) return;
    function onVisible() {
      if (document.visibilityState === "visible") void probeVersion();
    }
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [me, probeVersion]);

  // Socket-reconnect re-probe. The most common cause of a reconnect is
  // a server restart, which is also the most common cause of a fresh
  // VERSION on the server. Probing on reconnect means the banner pops
  // within seconds of a deploy instead of waiting for the next 60s
  // poll tick.
  useEffect(() => {
    if (!me) return;
    const socket = getSocket();
    function onConnect() { void probeVersion(); }
    socket.io.on("reconnect", onConnect);
    return () => { socket.io.off("reconnect", onConnect); };
  }, [me, probeVersion]);

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
    return (
      <UnauthRouter
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
/** Order-insensitive permission-set equality. The server returns
 *  permissions in catalog order, so identical sets are also
 *  identical arrays — but we sort defensively to avoid spurious
 *  inequality from any future re-ordering on the wire. Cheap at
 *  catalog size (~75 keys). */
function samePermissions(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function UnauthRouter(props: {
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

  // Scriptorium public surfaces — render the catalog / reader inside
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
 * server — we surface a "log in to read this story" card instead of
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
    return <p className="p-8 italic text-keep-muted">Loading story...</p>;
  }
  if (resolved.kind === "notfound") {
    return (
      <div className="mx-auto max-w-sm p-8 text-center">
        <p className="font-action text-lg text-keep-text">Story not found</p>
        <p className="mt-2 text-sm text-keep-muted">
          This story doesn't exist or has been removed.
        </p>
        <button
          type="button"
          onClick={() => onNavigate("/scriptorium")}
          className="mt-4 rounded border border-keep-action bg-keep-action/15 px-3 py-1.5 text-xs uppercase tracking-widest text-keep-action"
        >
          Back to Scriptorium
        </button>
      </div>
    );
  }
  if (resolved.kind === "stub") {
    return (
      <div className="mx-auto max-w-sm p-8 text-center">
        <p className="font-action text-lg text-keep-text">{resolved.title}</p>
        <p className="mt-2 text-sm text-keep-muted">
          This story is rated NC-17 (explicit content). You'll need to log in or register to read it.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onNavigate(`/login?story=${encodeURIComponent(slug)}`)}
            className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg"
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => onNavigate(`/register?story=${encodeURIComponent(slug)}`)}
            className="rounded border border-keep-action bg-keep-action/15 px-3 py-1.5 text-xs uppercase tracking-widest text-keep-action"
          >
            Register
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
      style={themeStyle(resolveSplashTheme(branding))}
      className="relative min-h-screen w-full bg-keep-bg text-keep-text"
    >
      {/* Subtle backdrop image, same as the login splash, so the standalone
          page still feels like part of the site rather than a stripped
          modal floating on a flat color. Same dark/light swap as the
          login splash via splashBgUrl (resolved palette decides). */}
      <div
        aria-hidden
        className="absolute inset-0 bg-cover bg-[position:-175px_center] opacity-40 md:bg-center"
        style={{ backgroundImage: `url(${splashBgUrl(resolveSplashTheme(branding))})` }}
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
  // Branding lives in the global store; AdminPanel saves push into it
  // directly so the derived activeTheme below picks up new site
  // defaults without waiting for a /me/profile re-fetch.
  const branding = useChat((s) => s.branding);
  const setKickReason = useChat((s) => s.setKickReason);
  const setRoom = useChat((s) => s.setRoom);
  const setOccupants = useChat((s) => s.setOccupants);
  const appendMessage = useChat((s) => s.appendMessage);
  const updateMessage = useChat((s) => s.updateMessage);
  const setMessages = useChat((s) => s.setMessages);
  // DM store actions (Phase 4). Pulled flat so the socket-handler
  // effect can reference them by their stable function identity.
  const appendDmMessage = useChat((s) => s.appendDmMessage);
  const updateDmMessage = useChat((s) => s.updateDmMessage);
  const setDmConversations = useChat((s) => s.setDmConversations);
  const upsertDmConversation = useChat((s) => s.upsertDmConversation);
  const openDmOtherUserId = useChat((s) => s.openDmOtherUserId);
  const openDmOtherCharacterId = useChat((s) => s.openDmOtherCharacterId);
  const setOpenDmOtherUser = useChat((s) => s.setOpenDmOtherUser);
  const bumpDmReseed = useChat((s) => s.bumpDmReseed);
  const setCurrentRoom = useChat((s) => s.setCurrentRoom);
  const setNotice = useChat((s) => s.setNotice);
  const setOpenProfile = useChat((s) => s.setOpenProfile);
  const openEditor = useChat((s) => s.openEditor);
  const closeEditor = useChat((s) => s.closeEditor);
  // Forum-pagination store actions.
  const setForumTopicsPage = useChat((s) => s.setForumTopicsPage);
  const appendForumTopicsPage = useChat((s) => s.appendForumTopicsPage);
  const setForumTopicsLoading = useChat((s) => s.setForumTopicsLoading);
  const prependOwnForumTopic = useChat((s) => s.prependOwnForumTopic);
  const queuePendingForumTopic = useChat((s) => s.queuePendingForumTopic);
  const flushPendingForumTopics = useChat((s) => s.flushPendingForumTopics);
  const updateForumTopic = useChat((s) => s.updateForumTopic);
  const bumpTopicActivity = useChat((s) => s.bumpTopicActivity);
  const removeForumTopic = useChat((s) => s.removeForumTopic);

  const currentRoomId = useChat((s) => s.currentRoomId);
  const rooms = useChat((s) => s.rooms);
  const messagesByRoom = useChat((s) => s.messagesByRoom);
  const forumTopicsByRoom = useChat((s) => s.forumTopicsByRoom);
  const occupants = useChat((s) => s.occupants);
  const notice = useChat((s) => s.notice);
  const openProfile = useChat((s) => s.openProfile);
  const editor = useChat((s) => s.editor);
  const fontStep = useChat((s) => s.fontStep);
  const refreshIntervalSec = useChat((s) => s.refreshIntervalSec);
  const setRefreshIntervalSec = useChat((s) => s.setRefreshIntervalSec);

  const [adminOpen, setAdminOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  /**
   * EarningDashboard open state. Null = closed; an object = open at
   * the specified tab + items sub-tab. Storing the open-spec instead
   * of a boolean lets `ui:hint { kind: "open-earning", tab, itemSubTab }`
   * deep-link straight into the Shop / Collection / Pets sub-tabs
   * from the `/shop` / `/collection` / `/pets` builtin commands. An
   * empty object opens on the default Overview tab — the same shape
   * the "Your Earning" tools-panel entry uses.
   */
  type EarningOpenSpec = {
    tab?: "overview" | "ledger" | "styles" | "borders" | "cosmetics" | "items" | "settings";
    itemSubTab?: "inventory" | "shop" | "collection" | "pets";
  };
  const [earningOpen, setEarningOpen] = useState<EarningOpenSpec | null>(null);
  /**
   * Full-screen item-zoom view triggered by the `/item <name>` chat
   * command. Mounts the same overlay that powers tap-to-zoom on
   * profile Collection / Pet pins. State is null when closed; an
   * `ItemZoomEntry` (server-resolved catalog row) when open.
   */
  const [openItem, setOpenItem] = useState<ItemZoomEntry | null>(null);
  const [helpOpen, setHelpOpen] = useState<{ filter?: string } | null>(null);
  const [usersOpen, setUsersOpen] = useState<{ query?: string } | null>(null);
  /**
   * Unified Messages modal toggle. Replaces the older split-up trio
   * (FriendsModal + DmListModal + DmFloatingPanel). The Tools
   * drawer's "Messages" and "Friends" entries both flip this on —
   * the modal handles friends + requests + conversations in one
   * place. Fetches fresh on each open.
   */
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
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
  // Scriptorium catalog state. Object → open; null → closed. The
  // optional `tab` lets `/scriptorium my` etc. land on a specific tab.
  const [scriptoriumOpen, setScriptoriumOpen] = useState<{ tab?: "find" | "my" | "reading" | "following" } | null>(null);
  // Story editor state. Discriminated by presence: null → closed;
  // { storyId: null } → New Story wizard; { storyId: "xyz" } → edit
  // existing story. Avoids the empty-string sentinel pattern.
  const [storyEditor, setStoryEditor] = useState<{ storyId: string | null } | null>(null);
  // Story reader state. Object → open; null → closed. `chapterIndex`
  // optional so `/story <slug> chapter <N>` can land on a specific page.
  const [storyReader, setStoryReader] = useState<{ storyId: string; chapterIndex?: number } | null>(null);
  const [navLinksVersion, setNavLinksVersion] = useState(0);
  const [composerText, setComposerText] = useState("");
  // Per-room cached thread categories. Populated lazily for nested rooms
  // on join; the Composer's category picker reads from this. Stale
  // entries (after admin edits) refresh on the next room-join cycle.
  const [threadCategoriesByRoom, setThreadCategoriesByRoom] = useState<Record<string, ThreadCategory[]>>({});
  // Forum-mode state. Both reset whenever the active room changes —
  // navigating away from a thread shouldn't leave the composer thinking
  // it's still replying to the previous room's topic.
  //   activeTopicId   — id of the topic the user is currently reading
  //                      (and replying to). null = no topic selected,
  //                      composer is disabled in forum rooms.
  //   topicCreateMode — composer is in "start a new topic" mode (title
  //                      input visible). After successful create, this
  //                      flips back to false and activeTopicId points
  //                      at the new topic.
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [topicCreateMode, setTopicCreateMode] = useState(false);
  // "Preferred category for the next + New topic" — set when the user
  // clicks a category section header in the forum view. Tristate where
  // `undefined` means "no signal yet" (composer falls back to its own
  // persisted localStorage default), `null` is the Uncategorized
  // bucket, and a string is a specific category id. Resets on room
  // change so a click in room A doesn't leak into room B.
  const [activeForumCategoryId, setActiveForumCategoryId] = useState<string | null | undefined>(undefined);
  // Pop-out modal target. Independent of activeTopicId: clicking the
  // ⤢ icon on a topic card opens the focused-view modal AND also sets
  // activeTopicId (so the underlying list view expands to match), but
  // closing the modal leaves activeTopicId alone — the user stays
  // focused on the same topic in the list. Resets on room change.
  const [poppedTopicId, setPoppedTopicId] = useState<string | null>(null);
  // Rooms drawer on mobile (md breakpoint and below). Always-open on desktop.
  const [railOpen, setRailOpen] = useState(false);
  const [roomsTree, setRoomsTree] = useState<RoomWithOccupants[]>([]);
  const [roomsTreeVersion, setRoomsTreeVersion] = useState(0);
  // Theme resolution layers. `activeTheme` is derived (not stored) below
  // as `characterTheme || userTheme || branding.defaultTheme`, so changing
  // ANY of the three causes the active theme to refresh — including when
  // admin pushes a new site-wide default to `branding`. Storing them
  // separately avoids the previous bug where activeTheme was set in a
  // one-shot effect that only re-ran on `themeVersion` bumps, leaving
  // the chat stuck on the OLD site default after an admin palette change.
  const [userTheme, setUserTheme] = useState<Theme | null>(null);
  // Per-user UI font + size preferences. User-level accessibility settings,
  // not theme-layered (a character doesn't override font; that'd be
  // hostile to a user with low vision). Loaded with the master profile,
  // applied to <html> via applyFontPrefs.
  const [uiFontFamily, setUiFontFamily] = useState<string | null>(null);
  const [uiFontScale, setUiFontScale] = useState<UiFontScale | null>(null);
  const [characterTheme, setCharacterTheme] = useState<Theme | null>(null);
  const [activeCharacterId, setActiveCharacterIdLocal] = useState<string | null>(null);
  const [activeCharacterName, setActiveCharacterName] = useState<string | null>(null);
  // Wrapper that mirrors local state into the Zustand store so any
  // component / fetch can read the active identity via useChat. The
  // friend + DM endpoints scope responses by this id (server filters
  // on `?characterId=`); without this mirror they'd always default to
  // OOC. Wrapped instead of dropping local state so we don't need to
  // refactor every existing consumer of `activeCharacterId`.
  const setActiveCharacterIdStore = useChat((s) => s.setActiveCharacterIdStore);
  const setActiveCharacterId = (id: string | null) => {
    setActiveCharacterIdLocal(id);
    setActiveCharacterIdStore(id);
  };
  const [notifyPref, setNotifyPref] = useState<NotifyPref>("mentions");
  // Per-user style override. `null` means "follow the site default";
  // applyStyle below resolves user > site > hardcoded fallback.
  const [userStyleKey, setUserStyleKey] = useState<string | null>(null);
  // Per-character style override. Same shape as userStyleKey; loaded
  // from the active character row in the character-theme effect
  // below. Null = inherit the chain (master → theme-pinned → site).
  const [characterStyleKey, setCharacterStyleKey] = useState<string | null>(null);
  // Per-user / per-character public-profile backdrop image. Used as
  // the chat-shell backdrop when the resolved style is "glass" — the
  // glass design reveals whatever image the user picked for their
  // public profile, falling back to the Spire artwork. Mirrored from
  // the same `publicProfileBgUrl/Mode` columns that drive the profile
  // modal backdrop (no separate schema for the chat shell).
  type BgMode = "cover" | "contain" | "tile" | "stretch";
  const [userBgUrl, setUserBgUrl] = useState<string | null>(null);
  const [userBgMode, setUserBgMode] = useState<BgMode>("cover");
  const [characterBgUrl, setCharacterBgUrl] = useState<string | null>(null);
  const [characterBgMode, setCharacterBgMode] = useState<BgMode>("cover");
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
   * Route-aware tab title. Mirrors the per-route SEO that the server
   * renders for crawlers — so the user sees the same name in their
   * browser tab whether they arrived via deep link (server-rendered)
   * or by navigating inside the SPA (client-rendered). Falls back to
   * the admin-configured site name plus a roleplay-chat tagline at
   * rest, matching the homepage `<title>` the server produces for `/`.
   *
   * Priority: open profile > open world viewer > open story reader >
   * default. The first match wins so the most specific context shows.
   */
  useEffect(() => {
    const siteName = branding.siteName || "The Spire";
    let title: string;
    if (openProfile) {
      const name = openProfile.kind === "master"
        ? openProfile.profile.username
        : openProfile.profile.name;
      title = `${name} - Roleplay Profile · ${siteName}`;
    } else if (worldViewerId) {
      title = `Roleplay World · ${siteName}`;
    } else if (storyReader) {
      title = `Story · Scriptorium · ${siteName}`;
    } else {
      title = `${siteName} - Roleplay Chat & Collaborative Writing`;
    }
    document.title = title;
  }, [branding.siteName, openProfile, worldViewerId, storyReader]);

  /**
   * Resolve and apply the caller's *active* theme: the active character's
   * theme if set, else the master theme. Re-fetched whenever the editor
   * closes or `/char switch` fires (both bump themeVersion).
   */
  /**
   * First-load seed only. `/me/profile.activeCharacterId` is the user's
   * DB-level default and is the right answer ONCE per session — at the
   * moment this tab connects. Subsequent updates flow through
   * `me:character-update` events (per-tab) so a sibling tab's /char
   * doesn't override this tab's identity through a backend poll.
   */
  const profileSeededRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const me = await fetch("/me/profile", { credentials: "include" });
        if (!me.ok) return;
        const u = (await me.json()) as {
          theme?: unknown;
          styleKey?: string | null;
          uiFontFamily?: string | null;
          uiFontScale?: UiFontScale | null;
          activeCharacterId: string | null;
          activeCharacterName?: string | null;
          notifyPref?: NotifyPref;
          soundDmEnabled?: boolean;
          soundChatEnabled?: boolean;
          soundAlertEnabled?: boolean;
          soundWhisperEnabled?: boolean;
          disableInputHistory?: boolean;
          disableThesaurus?: boolean;
          publicProfileBgUrl?: string | null;
          publicProfileBgMode?: "cover" | "contain" | "tile" | "stretch";
          welcome?: { html: string; hash: string } | null;
          limits?: {
            maxBioLength?: number;
            maxMessageLength?: number;
            maxDirectMessageLength?: number;
            maxForumPostLength?: number;
            maxForumTopicTitleLength?: number;
          };
        };
        // The server returns user.theme which already falls back to the
        // site default when the user has nothing explicit set
        // (parseUserThemeJson on the server side does this). We pull
        // both layers separately into state so the derived activeTheme
        // below picks the right one in real time.
        const fetchedUserTheme = u.theme ? normalizeTheme(u.theme) : null;
        if (!cancelled) {
          setUserTheme(fetchedUserTheme);
          // Seed activeCharacterId/Name from the DB default ONLY on the
          // very first profile load of this tab. After that, the
          // identity is owned by me:character-update events so a /char
          // run on another tab can't override this tab's voice when
          // something else (presence:update, theme save) bumps
          // themeVersion and re-runs this effect.
          if (!profileSeededRef.current) {
            // Prefer this tab's sessionStorage cache over the DB default.
            // The DB row (`users.activeCharacterId`) is account-global,
            // so on a refresh the value may have been mutated by a
            // sibling tab on another device — using it directly is what
            // caused the phone-refresh-picks-up-desktop's-character bug.
            // The cache survives reload (sessionStorage) but is per-tab.
            // Three states from loadTabCharacter:
            //   undefined → no cache; fall back to DB (new tab / first
            //               load / private-mode failure)
            //   null      → explicit OOC sentinel — honor it
            //   string    → cached character id; use it. We still need
            //               the name, which the DB-default name field
            //               doesn't cover. The character-theme effect
            //               below fetches `/characters/:id` and the
            //               server-side socket handshake validates
            //               ownership + falls back to OOC silently if
            //               the id no longer resolves.
            const cached = loadTabCharacter();
            if (cached === undefined) {
              setActiveCharacterId(u.activeCharacterId);
              setActiveCharacterName(u.activeCharacterName ?? null);
              rememberTabCharacter(u.activeCharacterId);
            } else if (cached === null) {
              setActiveCharacterId(null);
              setActiveCharacterName(null);
            } else if (cached === u.activeCharacterId) {
              // Cache agrees with DB — same seed path as no-cache, but
              // we can trust the name field that came back with the
              // profile fetch instead of waiting on a /characters lookup.
              setActiveCharacterId(u.activeCharacterId);
              setActiveCharacterName(u.activeCharacterName ?? null);
            } else {
              // Cache disagrees with DB (the multi-device case). Apply
              // the cached id immediately; the character-theme effect
              // below will fetch the row and patch in the name once it
              // arrives. Leaving the name null briefly is fine —
              // nothing renders the active character name on first
              // paint that would visibly flicker.
              setActiveCharacterId(cached);
              setActiveCharacterName(null);
            }
            profileSeededRef.current = true;
          }
          if (u.notifyPref) setNotifyPref(u.notifyPref);
          // Seed sound prefs into the store. The lib/sound module
          // reads from this on every play(), so a fresh /me/profile
          // load applies the user's toggles before the first sound
          // event has a chance to fire.
          useChat.getState().setSoundPrefs({
            dm: u.soundDmEnabled ?? true,
            whisper: u.soundWhisperEnabled ?? true,
            chat: u.soundChatEnabled ?? true,
            alert: u.soundAlertEnabled ?? true,
          });
          // Input-behavior opt-outs. Composer reads disableHistory to
          // gate the ArrowUp recall; SynonymPopup reads disableThesaurus
          // to skip its `selectionchange` listener entirely. Defaults
          // stay false so the features remain on for accounts that
          // haven't touched the toggles.
          useChat.getState().setInputPrefs({
            disableHistory: u.disableInputHistory ?? false,
            disableThesaurus: u.disableThesaurus ?? false,
          });
          // Admin-configured input caps. Composers (chat, DM, forum
          // topic title, bio editor) read these from the store so a
          // tuning change picks up on the next /me/profile load
          // instead of requiring a deploy. Missing fields fall back
          // to the cached defaults already in the store.
          if (u.limits) {
            const cur = useChat.getState().inputLimits;
            useChat.getState().setInputLimits({
              maxBioLength: u.limits.maxBioLength ?? cur.maxBioLength,
              maxMessageLength: u.limits.maxMessageLength ?? cur.maxMessageLength,
              maxDirectMessageLength: u.limits.maxDirectMessageLength ?? cur.maxDirectMessageLength,
              maxForumPostLength: u.limits.maxForumPostLength ?? cur.maxForumPostLength,
              maxForumTopicTitleLength: u.limits.maxForumTopicTitleLength ?? cur.maxForumTopicTitleLength,
            });
          }
          setUserStyleKey(typeof u.styleKey === "string" ? u.styleKey : null);
          setUserBgUrl(typeof u.publicProfileBgUrl === "string" && u.publicProfileBgUrl.trim() !== "" ? u.publicProfileBgUrl.trim() : null);
          setUserBgMode(
            u.publicProfileBgMode === "contain" || u.publicProfileBgMode === "tile" || u.publicProfileBgMode === "stretch"
              ? u.publicProfileBgMode
              : "cover",
          );
          setUiFontFamily(typeof u.uiFontFamily === "string" ? u.uiFontFamily : null);
          setUiFontScale(
            u.uiFontScale === "small" || u.uiFontScale === "medium" ||
            u.uiFontScale === "large" || u.uiFontScale === "xl"
              ? u.uiFontScale
              : null,
          );
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

  /**
   * Character theme load — keyed on the LOCAL `activeCharacterId` so a
   * per-tab switch (via me:character-update) re-fetches this tab's
   * theme without dragging in the DB default from `/me/profile`. Runs
   * on the initial seed too because the seed effect above sets
   * activeCharacterId, which then triggers this.
   */
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!activeCharacterId) {
        setCharacterTheme(null);
        setCharacterStyleKey(null);
        setCharacterBgUrl(null);
        setCharacterBgMode("cover");
        return;
      }
      try {
        const c = await fetch(`/characters/${activeCharacterId}`, { credentials: "include" });
        if (!c.ok) return;
        const cr = (await c.json()) as {
          name?: string;
          themeJson?: string | null;
          styleKey?: string | null;
          publicProfileBgUrl?: string | null;
          publicProfileBgMode?: string | null;
        };
        let fetched: Theme | null = null;
        if (cr.themeJson) {
          try { fetched = normalizeTheme(JSON.parse(cr.themeJson)); } catch { /* none */ }
        }
        if (!cancelled) {
          setCharacterTheme(fetched);
          // Same null-coalesce shape as the master styleKey above —
          // null + undefined both mean "no override on this character".
          setCharacterStyleKey(cr.styleKey ?? null);
          setCharacterBgUrl(typeof cr.publicProfileBgUrl === "string" && cr.publicProfileBgUrl.trim() !== "" ? cr.publicProfileBgUrl.trim() : null);
          setCharacterBgMode(
            cr.publicProfileBgMode === "contain" || cr.publicProfileBgMode === "tile" || cr.publicProfileBgMode === "stretch"
              ? cr.publicProfileBgMode
              : "cover",
          );
          // Sync the character name with the row we just loaded. The
          // seed path may have left it null when the tab-cache id
          // disagreed with the DB default; this fills it in. Idempotent
          // when the seed already had the right name.
          if (typeof cr.name === "string") setActiveCharacterName(cr.name);
        }
      } catch { /* ignore */ }
    }
    load();
    return () => { cancelled = true; };
  }, [activeCharacterId, themeVersion]);

  // Derived active theme. Recomputes whenever ANY of the three layers
  // changes — including when admin pushes a new site default to the
  // branding store via /admin/settings save. Previously this was a
  // one-shot state set inside the load() above, so admin palette
  // changes only landed for the user after a manual reload.
  const activeTheme = useMemo<Theme>(() => {
    // A character is its own identity — distinct theme bucket from
    // OOC. Voicing a character that hasn't picked a theme yet falls
    // straight through to the SITE default, NOT the master account's
    // theme. The legacy fallthrough (`characterTheme ?? userTheme`)
    // smeared OOC's palette onto every fresh character and made
    // "save a theme on this character" look like it reset back to
    // OOC's theme as soon as the editor reloaded.
    if (activeCharacterId) {
      return characterTheme ?? branding.defaultTheme ?? DEFAULT_THEME;
    }
    return userTheme ?? branding.defaultTheme ?? DEFAULT_THEME;
  }, [activeCharacterId, characterTheme, userTheme, branding.defaultTheme]);

  // Apply whichever theme is active to the document. Sets CSS vars on <html>
  // so they override the :root defaults from styles.css.
  // Read the site-wide design defaults off branding (push-updated by
  // /site + admin saves). The map gives admins per-preset pinning;
  // `defaultStyleKey` is the fallback when nothing matches.
  const siteStyleKey = useChat((s) => s.branding.defaultStyleKey);
  const themeDesignMap = useChat((s) => s.branding.themeDesignMap);
  useEffect(() => {
    // Apply the palette first so the ornament generator can read the
    // resulting CSS vars. Style resolution priority (highest wins):
    //   1. Character override (characters.style_key) — set when active
    //      character has its own pinned design.
    //   2. Master override (users.style_key) — user picked a personal
    //      design in their master profile.
    //   3. Theme-pinned design — when the active palette matches a
    //      named preset, look up its admin-configured pinned design
    //      in themeDesignMap. Custom palettes (no preset match) skip
    //      this tier and fall through to the site default.
    //   4. Site default (site_settings.default_style_key).
    //   5. Hardcoded fallback ('medieval').
    applyTheme(activeTheme);
    // Cache the resolved active theme so a brief sign-out renders the
    // splash in the user's most recent palette instead of bouncing
    // through Parchment / Darkness defaults. See
    // `loadCachedActiveTheme` in state/store.ts for the read side.
    //
    // Gated on `me` being signed in: while the splash is showing
    // (me === null pre-auth-check, or after sign-out) `activeTheme`
    // falls through to `branding.defaultTheme` — the light Spire
    // Modern fallback. Writing THAT to the cache would clobber the
    // user's actual last-active palette and bounce them into the
    // light splash on the next visit even though their last real
    // theme was dark. By only writing while authenticated, the
    // cache only ever captures themes the user actually saw applied
    // to their own chat session.
    if (me) saveCachedActiveTheme(activeTheme);
    const presetName = matchThemePreset(activeTheme);
    const pinnedForPreset = presetName ? themeDesignMap[presetName] : undefined;
    // Built-in preset→design pairings (Glass Light/Dark → glass).
    // Falls between admin override (themeDesignMap) and the site-wide
    // default so shipped presets carry their design intent without
    // requiring an admin to wire the map for every preset.
    const builtinForPreset = presetName ? DEFAULT_PRESET_DESIGNS[presetName] : undefined;
    // Design resolution mirrors the palette: a character is its own
    // identity, so its design picks don't fall through to the
    // master's. Voicing a character with no design override goes
    // straight to the theme-pinned design (if any) and then the site
    // default. The OOC chain still cascades master → presets → site.
    const resolvedStyle = activeCharacterId
      ? (characterStyleKey || pinnedForPreset || builtinForPreset || siteStyleKey || DEFAULT_STYLE_KEY)
      : (userStyleKey || pinnedForPreset || builtinForPreset || siteStyleKey || DEFAULT_STYLE_KEY);
    applyStyle(activeTheme, resolvedStyle);

    // Glass shell-bg URL — character > master > Spire artwork
    // (light or dark variant by palette luminance). Published as
    // CSS vars on `<html>`; the actual paint happens via a CSS rule
    // on `.keep-bg-overlay` (a fixed full-viewport div INSIDE the
    // chat shell). Painting on the html element directly leaked the
    // image past the chat shell whenever a browser extension /
    // devtools UI shifted the document — the strip above the shell
    // exposed html's image. Painting inside the shell means any
    // shift takes the image with it; the gap shows only the theme
    // bg-color, not the artwork.
    const root = document.documentElement;
    if (resolvedStyle === "glass") {
      // Same partition as theme + design: when voicing a character,
      // ONLY their own bg is considered; OOC's bg never bleeds onto a
      // character's chat shell, and vice versa. The OOC path keeps
      // the master bg.
      const personalUrl = activeCharacterId ? characterBgUrl : userBgUrl;
      const personalMode = activeCharacterId ? characterBgMode : userBgMode;
      const url = personalUrl ?? (isDarkPalette(activeTheme) ? "/the_spire_bg_dark.jpg" : "/the_spire_bg.jpg");
      const size = personalUrl
        ? (personalMode === "stretch" ? "100% 100%" : personalMode)
        : "cover";
      const repeat = personalUrl && personalMode === "tile" ? "repeat" : "no-repeat";
      root.style.setProperty("--keep-shell-bg-url", `url("${url}")`);
      root.style.setProperty("--keep-shell-bg-size", size);
      root.style.setProperty("--keep-shell-bg-repeat", repeat);
      // Luminance-aware glass overlay tints. On dark themes the
      // panels should darken the backdrop (deep panel color at low
      // alpha); on light themes they should LIGHTEN it (high-alpha
      // white). Using the palette's own panel/bg at the same alpha
      // both ways produces a uniformly-gray look on light themes
      // because the heavy backdrop-filter blur averages bright +
      // dark backdrop pixels into a midtone — the user reports this
      // as "too dark for light mode."
      // Light themes get aggressive white-overlay alpha because the
      // backdrop image's dark regions (corners of a typical nebula
      // / landscape) bleed through at low alpha and read as dark
      // panels. Bumping to 0.80-0.85 keeps the artwork visible
      // through the frost while ensuring chrome reads clearly as
      // light glass, not "frosted dark gray."
      const isDark = isDarkPalette(activeTheme);
      root.style.setProperty("--keep-glass-panel-tint", isDark
        ? "rgb(var(--keep-panel) / 0.45)"
        : "rgb(255 255 255 / 0.82)");
      root.style.setProperty("--keep-glass-bg-tint", isDark
        ? "rgb(var(--keep-bg) / 0.45)"
        : "rgb(255 255 255 / 0.85)");
      root.style.setProperty("--keep-glass-tool-tint", isDark
        ? "rgb(var(--keep-panel) / 0.15)"
        : "rgb(255 255 255 / 0.65)");
      root.style.setProperty("--keep-glass-chat-tint", isDark
        ? "rgb(var(--keep-bg) / 0.75)"
        : "rgb(255 255 255 / 0.85)");
    } else {
      root.style.removeProperty("--keep-shell-bg-url");
      root.style.removeProperty("--keep-shell-bg-size");
      root.style.removeProperty("--keep-shell-bg-repeat");
      root.style.removeProperty("--keep-glass-panel-tint");
      root.style.removeProperty("--keep-glass-bg-tint");
      root.style.removeProperty("--keep-glass-tool-tint");
      root.style.removeProperty("--keep-glass-chat-tint");
    }
  }, [activeTheme, activeCharacterId, characterStyleKey, userStyleKey, siteStyleKey, themeDesignMap, me, characterBgUrl, characterBgMode, userBgUrl, userBgMode]);

  // Per-user font/size accessibility. Independent of the palette effect
  // above because font preferences don't layer through character/room
  // overrides — they're user-level and apply once. Re-runs on every
  // bump of `themeVersion` (which is also what triggers the /me/profile
  // re-fetch, so any save in the editor surfaces immediately).
  useEffect(() => {
    // applyFontPrefs installs a viewport matchMedia listener so the
    // mobile-vs-desktop font tier re-applies when the window resizes
    // or a tablet rotates. The returned cleanup removes that listener
    // when the prefs change (the next effect run installs a fresh
    // one) or when the component unmounts.
    const cleanup = applyFontPrefs({ fontFamily: uiFontFamily, fontScale: uiFontScale });
    return cleanup;
  }, [uiFontFamily, uiFontScale]);

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
  // Hoisted out of the notifications effect so the MessageList renderer can
  // share the same identity set. Reference is stable per-identity-change so
  // child memoization (renderForumBody useMemo) doesn't churn on every
  // render.
  const selfNames = useMemo<ReadonlyArray<string>>(
    () => [
      ...(me?.username ? [me.username] : []),
      ...(activeCharacterName ? [activeCharacterName] : []),
    ],
    [me?.username, activeCharacterName],
  );

  /**
   * System-announcement-style chat line whenever a NEW friend request
   * lands. The pendingFriendRequests array is the canonical source —
   * we diff its membership against the previous render and emit one
   * system message per newly-appeared sender id.
   *
   * Why diff instead of listening to `friend:request` directly?
   *
   *   - The socket event fires for FOUR distinct causes (new request,
   *     accept echo, decline echo, unfriend echo). Only the first is
   *     "new incoming request from someone you haven't heard from
   *     yet." Diffing the resolved list filters out the other three
   *     for free.
   *   - The initial fetch on connect should NOT spam a system line
   *     for every already-pending request the user had before
   *     reconnecting. `seededRef` covers that: the first observation
   *     of the array just records the baseline.
   *
   * The message is room-scoped (uses currentRoomId), so users in any
   * room see the cue inline. Skipped silently when no room is active.
   */
  const pendingFriendRequests = useChat((s) => s.pendingFriendRequests);
  const prevPendingIdsRef = useRef<Set<string>>(new Set());
  const pendingSeededRef = useRef(false);
  useEffect(() => {
    const currIds = new Set(pendingFriendRequests.map((r) => r.userId));
    if (!pendingSeededRef.current) {
      prevPendingIdsRef.current = currIds;
      pendingSeededRef.current = true;
      return;
    }
    const roomId = useChat.getState().currentRoomId;
    for (const r of pendingFriendRequests) {
      if (prevPendingIdsRef.current.has(r.userId)) continue;
      // New request → emit system line. No-op when not in any room
      // (the line would have no home to render in).
      if (!roomId) continue;
      appendMessage({
        id: `friend-req-${r.userId}-${Date.now()}`,
        roomId,
        userId: "system",
        characterId: null,
        displayName: "system",
        kind: "system",
        body: `${r.displayName} sent you a friend request. Open Messages to accept or decline.`,
        color: null,
        createdAt: Date.now(),
      });
    }
    prevPendingIdsRef.current = currIds;
  }, [pendingFriendRequests, appendMessage]);

  useEffect(() => {
    function onMessage(msg: ChatMessage) {
      if (shouldNotify(msg, me?.id ?? null, notifyPref, document.hidden, selfNames)) {
        fireNotification(msg, selfNames);
      }
    }
    socket.on("message:new", onMessage);
    return () => { socket.off("message:new", onMessage); };
  }, [socket, me, notifyPref, selfNames]);

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
      // The friends modal pulls fresh data on every open, so we no
      // longer need to bump a live refresh key here. Online dots in
      // an open FriendsModal will lag slightly until the user re-
      // opens it; acceptable for a non-live affordance.
    });
    // Phase 4 typing indicator. Server is authoritative; we just
    // replace the room's typer set with whatever lands. Server has
    // already filtered the viewer themselves and anyone they've
    // ignored, so the renderer can show every entry verbatim.
    socket.on("chat:typing:update", ({ roomId, typers }) => {
      useChat.getState().setTypers(roomId, typers);
    });
    // Global rooms-tree invalidation. Server-emits this any time room
    // creation/deletion/archival/metadata/presence anywhere in the app
    // could change the rooms tree the user sees. Debounced because a
    // flurry of presence updates (mass reconnect, restart) would
    // otherwise hammer /rooms.
    // Scriptorium prose chip — `@world:slug` mention in chapter HTML
     // was clicked. The chip dispatches a CustomEvent so the chapter
     // body can stay decoupled from the App-level modal state.
    function onWorldChip(e: Event) {
      const detail = (e as CustomEvent<{ slug: string }>).detail;
      if (!detail?.slug) return;
      // setWorldViewerId accepts either an id or a slug — the viewer
      // resolves it via the worlds route.
      setWorldViewerId(detail.slug);
    }
    window.addEventListener("scriptorium:open-world-by-slug", onWorldChip);

    let treeDebounceId: number | null = null;
    socket.on("rooms:tree-changed", () => {
      if (treeDebounceId != null) window.clearTimeout(treeDebounceId);
      treeDebounceId = window.setTimeout(() => {
        setRoomsTreeVersion((v) => v + 1);
        treeDebounceId = null;
      }, 400);
    });

    /**
     * Scriptorium — a story you follow just published a new chapter.
     * Surfaces as a one-line system message in the user's current room
     * (mirrors the friend-online pattern). Quiet by design: no toast,
     * no sound — the project's no-daily-grind ethos extends to
     * passive author/reader interactions.
     */
    socket.on("story:chapter-published", (ev) => {
      const rid = useChat.getState().currentRoomId;
      if (!rid) return;
      appendMessage({
        id: `story-pub-${ev.chapterId}-${Date.now()}`,
        roomId: rid,
        userId: "system",
        characterId: null,
        displayName: "system",
        kind: "system",
        body: `✦ ${ev.authorDisplayName} published "${ev.chapterTitle}" of ${ev.storyTitle}.`,
        color: null,
        createdAt: Date.now(),
      });
    });
    socket.on("message:new", (msg: ChatMessage) => {
      // Append to the chat backlog regardless of mode — replies and
      // flat-chat messages live here, and the forum reply view reads
      // replies from this buffer.
      appendMessage(msg);

      // Sound effects. Discrete events:
      //   announce → alert.mp3   (admin megaphone)
      //   whisper  → whisper.mp3 (1:1 private contact in-room. Has
      //                           its own dedicated sound now that
      //                           we ship a fourth audio file —
      //                           previously folded into the DM
      //                           ping. Distinct from DM so a
      //                           whisper "they spoke to me here"
      //                           and a DM "they reached out from
      //                           outside" feel different even though
      //                           both are 1:1.)
      //   anything else (except system + our own) → tap.mp3
      // System notices (joins/kicks/topic changes) stay silent — they
      // would dogpile on a busy room. Our own outbound messages stay
      // silent — the user already knows they sent something. Recipient
      // gate on whispers: msg.toUserId must match meId so the sender's
      // own outgoing whisper doesn't ping itself (the sender's tab
      // already sees the line they composed).
      const meId = useChat.getState().me?.id ?? null;
      if (msg.kind === "announce") {
        playAlert();
      } else if (msg.kind === "whisper" && msg.toUserId === meId) {
        playWhisper();
      } else if (msg.kind !== "system" && msg.kind !== "whisper" && msg.userId !== meId) {
        playTap();
      }

      // Forum-side topic / reply bookkeeping. Driven off the room's
      // replyMode from the live store snapshot so we don't capture a
      // stale value in this closure (the listener is registered once
      // per mount and outlives many room switches).
      const state = useChat.getState();
      const roomRow = state.rooms[msg.roomId];
      if (!roomRow || roomRow.replyMode !== "nested") return;

      if (!msg.replyToId && msg.kind !== "system") {
        // New top-level topic. The author's own send lands directly
        // in the bucket so they see it right away; everyone else's
        // queues behind the "X new topics" pill.
        const categoryKey = msg.threadCategoryId ?? "_uncat";
        if (state.me && msg.userId === state.me.id) {
          prependOwnForumTopic(msg.roomId, categoryKey, msg);
        } else {
          queuePendingForumTopic(msg.roomId, categoryKey, msg);
        }
      } else if (msg.replyToId) {
        // Reply to a topic. Bump the parent's activity timestamp so
        // the forum view re-sorts it to the top of its bucket.
        bumpTopicActivity(msg.roomId, msg.replyToId, msg.createdAt);
      }
    });
    socket.on("message:bulk", (msgs: ChatMessage[]) => {
      if (msgs.length) {
        const roomId = msgs[0]!.roomId;
        setMessages(roomId, msgs);
        // Seed the paginator optimistically. The authoritative value
        // lands a beat later via `room:history_meta` (sent by the
        // server immediately after the bulk). Defaulting to TRUE
        // here means the brief gap between the two events never
        // shows a false "start of history" — at worst the user
        // sees a "Scroll up for earlier messages" hint that the
        // meta event then clears. Counting msgs.length >= 50 used
        // to seed this and was unreliable: server-side filtering
        // (ignores + whispers) regularly trimmed the visible count
        // below 50 even when older history existed.
        useChat.getState().setRoomHistoryHasMore(roomId, true);
      }
    });
    socket.on("room:history_meta", ({ roomId, hasMore }) => {
      // Authoritative paginator state from the server's backlog
      // query. Lands right after `message:bulk` on every room join
      // (and again on relocate-to-room after kick/ban). When false,
      // the MessageList renders "— start of history —"; when true,
      // scrolling within 200px of the top triggers the load-older
      // fetch and prepends another page.
      useChat.getState().setRoomHistoryHasMore(roomId, hasMore);
    });
    socket.on("message:update", (msg: ChatMessage) => {
      updateMessage(msg);
      // Forum side: if this is a topic, reflect lock/edit state into
      // the topics store; if it's a freshly-deleted topic, remove it
      // from every category bucket so the forum view stops rendering
      // it without waiting for a refetch.
      if (!msg.replyToId) {
        if (msg.deletedAt) removeForumTopic(msg.roomId, msg.id);
        else updateForumTopic(msg);
      }
    });
    socket.on("watch:online", ({ username, displayName }) => {
      // Show ONLY the public-facing display name. When the watched
      // user is in-character, `displayName` is the character name —
      // appending " (master_username)" outed the OOC account to
      // every watcher's room, breaking the same per-identity privacy
      // contract that protects DMs / friends / userlists. The
      // notification tag still keys on the master username so
      // duplicate browser toasts collapse correctly.
      const body = `${displayName} is online.`;
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
        case "open-scriptorium":
          setScriptoriumOpen(h.tab ? { tab: h.tab } : {});
          break;
        case "open-story-editor":
          setStoryEditor({ storyId: h.storyId });
          break;
        case "open-story":
          setStoryReader({
            storyId: h.storyId,
            ...(typeof h.chapterIndex === "number" ? { chapterIndex: h.chapterIndex } : {}),
          });
          break;
        case "clear-room-messages": {
          // Read fresh state - the ui:hint handler is registered once and
          // its closure would otherwise capture a stale currentRoomId.
          const rid = useChat.getState().currentRoomId;
          if (rid) setMessages(rid, []);
          break;
        }
        case "prompt-room-password":
          setPwPrompt({ roomId: h.roomId, roomName: h.roomName });
          break;
        case "open-bookmarks":
          setBookmarksOpen(true);
          break;
        case "open-earning":
          // Build the open-spec from the hint. Empty object = open at
          // the default Overview tab (the "Your Earning" tools-panel
          // shape); a populated object deep-links into a specific
          // tab + items sub-tab. The dashboard component reads the
          // initial-tab props on mount.
          setEarningOpen({
            ...(h.tab ? { tab: h.tab } : {}),
            ...(h.itemSubTab ? { itemSubTab: h.itemSubTab } : {}),
          });
          break;
        case "open-item":
          // /item <name> resolved server-side; hint carries the
          // full catalog row inline so no follow-up fetch is needed.
          setOpenItem(h.item);
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

    /**
     * Per-tab character switch confirmation. Fired only to the socket
     * that originated the switch (in-chat /char, ProfileEditor's switch
     * button, profile-modal action). We update local activeCharacterId
     * + name in place and bump themeVersion so the theme re-resolves
     * against the new character. We deliberately do NOT poll
     * /me/profile here — that endpoint serves the user-level DB default
     * which may not match THIS tab's identity in a multi-tab session.
     */
    socket.on("me:character-update", ({ activeCharacterId: aci, activeCharacterName: acn }) => {
      setActiveCharacterId(aci);
      setActiveCharacterName(acn);
      setThemeVersion((v) => v + 1);
      // Persist the per-tab voicing identity so a socket reconnect
      // (network blip, mobile suspend, page reload) restores this tab's
      // character via the handshake instead of letting the server
      // re-seed from `users.activeCharacterId` (which a sibling tab
      // may have mutated to a different character in the meantime).
      // See [socket.ts](./lib/socket.ts)'s `rememberTabCharacter`.
      rememberTabCharacter(aci);
    });

    /**
     * DM live updates. `dm:new` covers both inbound and outbound
     * (the server fans every send to both participants' sockets),
     * so the local store-update path is uniform regardless of
     * sender. `dm:update` carries edit / soft-delete echoes;
     * `dm:read` advances the OTHER party's seen marker.
     *
     * Conversations the client hasn't seen before are pulled in via
     * a single `/me/dms` refetch — cheaper than threading a partial
     * "new conversation" payload through the socket event, and the
     * conversation list response already carries the metadata
     * (otherDisplayName, avatar, unread, online) the rail needs.
     */
    /**
     * On every (re)connect: pull /me/dms so the conversation list
     * reflects anything that happened while we were disconnected
     * (most importantly, DMs from other users — those arrive as
     * `dm:new` to live sockets, so an offline window means missed
     * events. The DB has them, but the local store doesn't until we
     * refetch). We also bump dmReseedTick so any open ThreadPane
     * re-runs its history seed and picks up the missed messages it
     * never saw via socket.
     */
    function onConnect() {
      // Both endpoints are identity-scoped on the server, so we pass
      // the current active character (or nothing, for OOC). When the
      // user switches characters, the activeCharacterId effect below
      // re-fires onConnect's payload too.
      const charId = useChat.getState().activeCharacterId;
      fetch(withIdentityQuery("/me/dms", charId), { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && Array.isArray(j.conversations)) setDmConversations(j.conversations);
        })
        .catch(() => {});
      fetch(withIdentityQuery("/me/friend-requests", charId), { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && Array.isArray(j.requests)) useChat.getState().setPendingFriendRequests(j.requests);
        })
        .catch(() => {});
      // Per-identity inbox counts — drives the chat-shell ✉ badge so
      // unread DMs on every identity (not just the currently-active
      // one) bump the count. Without this initial pull, the badge
      // would stay at zero on cold-load until the user opened the
      // messenger to surface its own fetch path.
      void useChat.getState().refreshInboxCounts();
      bumpDmReseed();
      // Resync room state + backlog. Required for the deep-link case:
      // the socket may have been created (and joined a room) by an
      // App-level effect while the user was in the standalone shell
      // viewing /p/<name>. The initial `room:state` / `message:bulk`
      // went out before Chat's listeners existed; without this resync
      // Chat would render blank after dismissal. Cheap on the normal
      // (no-deep-link) path — same socket emits the server already
      // sent on join, just received again.
      socket.emit("me:resync");
    }
    // socket.io-client fires `connect` on the initial handshake and
    // after every successful auto-reconnect, so this single handler
    // covers cold-load AND wake-from-suspend / network-blip cases.
    socket.on("connect", onConnect);
    // If the socket is already connected at the moment this effect
    // mounts (e.g. StrictMode double-mount, hot reload), `connect`
    // won't fire again — run the sync once eagerly.
    if (socket.connected) onConnect();

    socket.on("dm:new", ({ message }) => {
      appendDmMessage(message);
      // Refresh per-identity inbox counts so the chat-shell ✉ badge
      // bumps even when the DM is for an identity that isn't the
      // currently-active one. `dmConversations` is identity-scoped
      // and the refetch below only repopulates it for the viewer's
      // current characterId — a DM pinned to Char B while the viewer
      // is on Char A would otherwise never bump any visible counter
      // and the recipient would have no signal that a message
      // arrived for one of their other identities.
      void useChat.getState().refreshInboxCounts();
      // Ping on inbound DMs from someone else; silent on our own echo
      // (the server fans every send to the sender's sockets too so
      // multi-tab works). Same posture as the room-message tap sound.
      const meIdForDm = useChat.getState().me?.id ?? null;
      if (message.senderId !== meIdForDm) {
        playPing();
        // Desktop notification when the tab is hidden — matches the
        // message:new path's policy. Without this DMs were silent on
        // a backgrounded tab even with browser notification permission
        // granted, leaving users with only the OS push (which the
        // server gate suppresses when ANY of their sockets is live).
        // notifyPref is intentionally bypassed: DMs are direct
        // person-to-person contact, the inbox equivalent of an `@`
        // mention. "off" still mutes them; "mentions" and "all" both
        // fire a toast.
        if (
          document.hidden &&
          notifyPref !== "off" &&
          notifPermission() === "granted"
        ) {
          try {
            const n = new Notification(`Direct message from ${message.displayName}`, {
              body: message.body.length > 140 ? `${message.body.slice(0, 140)}…` : message.body,
              icon: "/favicon.ico",
              // Tag groups by sender so a chatty DM partner doesn't
              // stack a dozen toasts — the latest replaces prior.
              tag: `tk-dm-${message.senderId}`,
            });
            n.onclick = () => { window.focus(); n.close(); };
          } catch { /* construction failure — non-fatal */ }
        }
      }
      // Pull the conversation list if we don't already know this
      // conversation — otherwise the rail won't surface it. Cheap;
      // /me/dms is bounded by the user's own DM count.
      const known = useChat.getState().dmConversations[message.conversationId];
      if (!known) {
        const charId = useChat.getState().activeCharacterId;
        fetch(withIdentityQuery("/me/dms", charId), { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (j && Array.isArray(j.conversations)) setDmConversations(j.conversations);
          })
          .catch(() => {});
      } else {
        // Decide whether this DM counts as a new unread.
        //
        // Three cases that should NOT bump the badge:
        //   1. We sent it — the server fans our own send back to our
        //      sockets too, but the user obviously read what they
        //      typed.
        //   2. The user is currently viewing this conversation in the
        //      open Messages modal (selectedUserId === otherUser).
        //      They've effectively read it on arrival; fire a /read
        //      POST so the server's last-read-at advances too.
        //   3. Anyone else's message into this conversation: bump.
        const state = useChat.getState();
        const meIdInner = state.me?.id ?? "";
        const otherUserId = known.otherUserId;
        const isSelf = message.senderId === meIdInner;
        // Match the open thread on BOTH userId AND the pinned character
        // id. Without the character match, a `dm:new` for one of a
        // master's character threads is silently treated as read while
        // the user is staring at that master's OOC thread (or any other
        // character thread), and the unread badge never advances on the
        // off-screen conversation.
        const viewing = state.openDmOtherUserId === otherUserId
          && state.openDmOtherCharacterId === known.otherCharacterId;
        if (viewing && !isSelf) {
          // Mark read on the server so the next /me/dms refetch
          // returns unreadCount=0 too. Use the VIEWER's character id
          // pinned to THIS conversation (echoed back from the server
          // in `myCharacterId`), NOT the global `activeCharacterId`.
          // The chip filter in the open messenger can differ from the
          // user's globally-active character — sending the global id
          // 404'd whenever the user was reading a chip-filtered inbox
          // that wasn't their current voice, which meant the read
          // marker never advanced and the unread badge snapped back
          // to its server value on the next inbox refetch.
          fetch(`/me/dms/${known.id}/read`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              upTo: Date.now(),
              characterId: known.myCharacterId ?? undefined,
            }),
          }).catch(() => {});
        }
        upsertDmConversation({
          ...known,
          lastMessageAt: message.createdAt,
          lastMessagePreview: message.deletedAt
            ? "[message removed]"
            : message.body.slice(0, 120),
          unreadCount: isSelf || viewing ? known.unreadCount : known.unreadCount + 1,
        });
      }
    });
    socket.on("dm:update", ({ message }) => {
      updateDmMessage(message);
    });
    socket.on("dm:read", ({ conversationId, readerUserId }) => {
      // Two distinct meanings depending on who the reader is:
      //   - readerUserId === me  → echo of OUR OWN read action on
      //     another tab. Clear the local conv's unreadCount and
      //     bump `inboxCountsVersion` so MessagesModal's chip pip
      //     refetches `/me/inbox-counts`. Without this, marking a
      //     thread read on tab A leaves the pip lit on tab B until
      //     the next manual refresh.
      //   - readerUserId !== me  → the OTHER party advanced their
      //     seen marker (Phase 4+ "seen" indicator); we just
      //     consume the event here so the listener doesn't warn.
      const state = useChat.getState();
      const myId = state.me?.id ?? null;
      if (myId && readerUserId === myId) {
        const conv = Object.values(state.dmConversations).find((c) => c.id === conversationId);
        if (conv && conv.unreadCount > 0) {
          state.upsertDmConversation({ ...conv, unreadCount: 0 });
        }
        state.bumpInboxCountsVersion();
        // Also refresh the global per-identity counts so the chat-
        // shell ✉ badge drops to match the just-read state on every
        // tab, not just the messenger's chip pip.
        void state.refreshInboxCounts();
      }
    });
    // Emoticon reactions — merge the delta into the cached
    // reactions store. Chat + DM rendering both pull from the same
    // map keyed by (targetKind, targetId), so a single listener
    // covers both surfaces.
    socket.on("reaction:update", (event) => {
      const viewerId = useChat.getState().me?.id ?? null;
      useEmoticons.getState().applyReactionEvent(event, viewerId);
    });
    // Admin replaced / added / deleted an emoticon sheet — refetch
    // the catalog. Cheap (one round trip, no auth required), and
    // refetching beats trying to incrementally apply a partial
    // payload the server didn't ship.
    socket.on("emoticons:updated", () => {
      void fetchEmoticonCatalog();
    });
    // Friend-state changed somewhere (new request landed, an existing
    // request was accepted/declined, or a friendship ended). Surface
    // a small notice so the user knows even when the Messages modal
    // isn't open; the modal itself refetches on next open.
    socket.on("friend:request", (payload) => {
      // Refresh the pending-requests list every time the server tells
      // us anything about friend state changed. The event fires on
      // four distinct causes (new request, accept echo, decline echo,
      // unfriend echo); the canonical answer for "what's in my inbox
      // right now" lives at /me/friend-requests, so we re-poll instead
      // of guessing from the payload. The in-chat prompt card and the
      // DM pinned banner both read from the store, so this single
      // fetch updates both surfaces atomically.
      fetch(withIdentityQuery("/me/friend-requests", useChat.getState().activeCharacterId), { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && Array.isArray(j.requests)) useChat.getState().setPendingFriendRequests(j.requests);
        })
        .catch(() => {});
      // Bump the friends-version counter so MessagesModal's
      // refreshLists effect re-fires (it keys on this). Covers
      // every echo cause — accept by the other party, decline
      // echo, unfriend echo, new request — so the modal's local
      // friends + conversations + pending-inbox state stays in
      // lockstep with whatever just changed server-side, even
      // when the user wasn't the one who initiated the action.
      useChat.getState().bumpFriendsVersion();
      // Per-identity counts refresh — the pending friend-request
      // half of the chat-shell badge needs to track new requests on
      // ANY of the user's identities (a friend request to Char B
      // while the viewer is on Char A should still bump the badge).
      void useChat.getState().refreshInboxCounts();
      // Soft notice in the banner so the user gets a glance signal
      // even when the chat prompt is offscreen (e.g. they're deep in
      // the forum view). Phrasing keeps it neutral — the actual
      // accept/decline UI lives in the prompt cards.
      setNotice({
        code: "FRIEND_UPDATE",
        message: `Friend update from ${payload.frienderDisplayName}.`,
      });
    });
    // Admin edited a custom command. Bump the shared version so the
    // Composer's autocomplete cache and the HelpModal both refetch
    // `/commands` on their next render — they key their fetch effect
    // on this value. Cheap to fan out (rare event, single fetch per
    // receiver).
    socket.on("commands:updated", () => {
      useChat.getState().bumpCommandsVersion();
    });
    // Earning — wallet/rank live updates. The store's apply* actions
    // are no-ops when the snapshot hasn't loaded yet, so a credit that
    // lands before the user opens the dashboard just gets reconciled
    // by the next /earning/me fetch.
    socket.on("earning:earned", (payload) => {
      useEarning.getState().applyEarned(payload);
    });
    socket.on("earning:rankup", (payload) => {
      useEarning.getState().applyRankUp(payload);
    });
    // Inventory delta — sender / receiver of /give /throw /drop +
    // shop purchases + admin grants. Payload is informational only;
    // we just re-fetch /earning/me so the dashboard's Items tab
    // (inventory list + shop "you own X/Y" line) reflects the new
    // authoritative state. Cheap when the dashboard isn't open —
    // the store keeps a single snapshot regardless.
    socket.on("earning:inventory_changed", () => {
      void useEarning.getState().refresh();
    });
    // Chat-line side effect — currently only `kind: "struck"` fires
    // (target of /throw /drop). The runner branches on kind, so
    // adding a new effect kind is one line here + the runner. We
    // never trigger the effect for the SENDER's own client — the
    // server scopes the emit to the target's sockets only.
    socket.on("chat:effect", (payload) => {
      if (payload.kind === "struck") {
        // `variant` selects which strike audio fires (throw / drop).
        // Older server builds without the field land here with
        // `variant: undefined`; the runner gracefully renders the
        // visual reaction without a sound in that case.
        runStruckEffect(payload.variant);
      }
    });

    return () => {
      socket.off("room:state");
      socket.off("presence:update");
      socket.off("chat:typing:update");
      socket.off("rooms:tree-changed");
      if (treeDebounceId != null) window.clearTimeout(treeDebounceId);
      socket.off("message:new");
      socket.off("message:bulk");
      socket.off("message:update");
      socket.off("watch:online");
      socket.off("error:notice");
      socket.off("auth:expired");
      socket.off("ui:hint");
      socket.off("mutual:settled");
      socket.off("me:character-update");
      socket.off("dm:new");
      socket.off("dm:update");
      socket.off("dm:read");
      socket.off("friend:request");
      socket.off("commands:updated");
      socket.off("earning:earned");
      socket.off("earning:rankup");
      socket.off("earning:inventory_changed");
      socket.off("chat:effect");
      socket.off("reaction:update");
      socket.off("emoticons:updated");
      socket.off("connect", onConnect);
      window.removeEventListener("scriptorium:open-world-by-slug", onWorldChip);
    };
  }, [socket, setRoom, setOccupants, appendMessage, updateMessage, setMessages, setCurrentRoom, setNotice, setOpenProfile, openEditor, setRefreshIntervalSec, setMe, prependOwnForumTopic, queuePendingForumTopic, bumpTopicActivity, updateForumTopic, removeForumTopic]);

  function send(
    text: string,
    opts?: { threadCategoryId?: string | null; threadTitle?: string; replyToId?: string },
  ) {
    if (!currentRoomId) return;
    socket.emit("chat:input", {
      roomId: currentRoomId,
      text,
      ...(opts?.threadCategoryId ? { threadCategoryId: opts.threadCategoryId } : {}),
      ...(opts?.threadTitle ? { threadTitle: opts.threadTitle } : {}),
      ...(opts?.replyToId ? { replyToId: opts.replyToId } : {}),
      // Authoritative per-send identity claim. This tab's React state
      // for activeCharacterId is the source of truth — sending it on
      // every chat:input closes the cross-tab race where the server's
      // socket-scoped tabCharId can drift from the UI (reconnect
      // re-seed from DB, sibling tab's /char clear updating the
      // shared user row, etc.). The server validates the claim
      // against owned characters before honoring it.
      asCharacterId: activeCharacterId,
    });
  }

  // Forum bookkeeping: when a new topic message arrives that was
  // authored by THIS user (matched by userId + the freshly-set title),
  // jump straight into it as the active topic so the composer becomes
  // a reply box for the topic they just created. Listening on the
  // store's message append rather than the socket directly so we
  // catch our own optimistic appends too. The check is constrained to
  // "the user just submitted a topic-create" via topicCreateMode so we
  // don't auto-activate every topic anyone else creates.
  //
  // We also stamp the moment topicCreateMode flipped on and only count
  // topics created AFTER that timestamp. Without this guard, clicking
  // "+ New Topic" on a different section while your own older topic is
  // sitting in the buffer would instantly satisfy the "found my own
  // topic" check and silently flip you into reply mode for that older
  // topic — defeating the whole point of opening the create form.
  const topicCreateModeAt = useRef(0);
  useEffect(() => {
    if (topicCreateMode) topicCreateModeAt.current = Date.now();
  }, [topicCreateMode]);
  useEffect(() => {
    if (!topicCreateMode || !me) return;
    const startedAt = topicCreateModeAt.current;
    const buf = messagesByRoom[currentRoomId ?? ""] ?? [];
    // Walk from the newest end backwards looking for our own most-
    // recent topic post. We don't need to look far; the topic create
    // mode is only active while the request is pending.
    for (let i = buf.length - 1; i >= Math.max(0, buf.length - 5); i--) {
      const m = buf[i]!;
      if (
        m.userId === me.id &&
        m.title &&
        !m.replyToId &&
        m.createdAt > startedAt
      ) {
        setActiveTopicId(m.id);
        setTopicCreateMode(false);
        return;
      }
    }
  }, [topicCreateMode, me, currentRoomId, messagesByRoom]);

  // Reset forum-mode state on every room switch so the composer doesn't
  // try to reply into a thread that lived in the room we just left.
  // `activeForumCategoryId` also clears: a section-click in room A
  // should not pre-select a (likely nonexistent) category in room B.
  useEffect(() => {
    setActiveTopicId(null);
    setTopicCreateMode(false);
    setPoppedTopicId(null);
    setActiveForumCategoryId(undefined);
  }, [currentRoomId]);

  // Mirror the current room into this tab's sessionStorage so a
  // reconnect (page reload, server restart, mobile suspend) can replay
  // it via the handshake. Account-isolated: each tab keeps its own
  // value, so a desktop tab in Tavern and a phone tab in Library both
  // come back to where they were instead of racing for the single
  // `users.lastRoomId` DB slot.
  useEffect(() => {
    if (currentRoomId) rememberTabRoom(currentRoomId);
  }, [currentRoomId]);

  // Lazy thread-category fetch. Triggered when the current room flips to
  // a nested-mode room we haven't seen yet, OR when the room object's
  // replyMode changes to nested (admin toggled /replymode). Flat rooms
  // and rooms we already have a list for are skipped so this doesn't
  // spam the server.
  useEffect(() => {
    if (!currentRoomId) return;
    const r = rooms[currentRoomId];
    if (!r || r.replyMode !== "nested") return;
    if (threadCategoriesByRoom[currentRoomId]) return;
    let cancelled = false;
    fetch(`/rooms/${encodeURIComponent(currentRoomId)}/thread-categories`, { credentials: "include" })
      .then((res) => (res.ok ? (res.json() as Promise<{ categories: ThreadCategory[] }>) : null))
      .then((j) => {
        if (cancelled || !j) return;
        setThreadCategoriesByRoom((cur) => ({ ...cur, [currentRoomId]: j.categories }));
      })
      .catch(() => { /* non-fatal — picker just stays empty */ });
    return () => { cancelled = true; };
  }, [currentRoomId, rooms, threadCategoriesByRoom]);

  /**
   * Initial forum-topics fetch. Once the room flips to nested-mode AND
   * the categories list has loaded, fetch the first page of topics for
   * each category (including the synthetic "_uncat" bucket). The
   * categories must load first because the bucket-keys come from
   * there; the topics endpoint accepts `category=<id>` or `category=""`
   * (meaning uncategorized) to scope the page.
   *
   * Skipped per-category when that bucket already has a topics array —
   * lets a user navigate away and back into the same room without
   * re-fetching everything (they'll just keep what's loaded).
   */
  // Narrow the dep on rooms to JUST the reply-mode of the current
  // room. Putting the whole `rooms` record in the deps caused the
  // forum-topics fetch to be cancelled on every `room:state` event
  // (presence change, /char, etc.) — `rooms` is a new object
  // reference per zustand `set()`, so any unrelated room mutation
  // would tear down the in-flight topics fetch via the effect
  // cleanup, leaving every bucket stuck in "Loading topics…".
  const currentReplyMode = rooms[currentRoomId ?? ""]?.replyMode ?? null;
  // Same posture for threadCategoriesByRoom — only the current room's
  // list matters for THIS effect, and only its presence/absence at
  // that. We still need to react when categories arrive for the first
  // time, but not when an unrelated room's category list mutates.
  // Mirror the categories into a ref so the effect can read the
  // current value without subscribing to the whole record (which
  // would re-cancel the in-flight fetches on every unrelated update,
  // the same hazard `rooms` had).
  const currentCategoriesLoaded = !!threadCategoriesByRoom[currentRoomId ?? ""];
  const categoriesRef = useRef(threadCategoriesByRoom);
  categoriesRef.current = threadCategoriesByRoom;

  useEffect(() => {
    if (!currentRoomId) return;
    if (currentReplyMode !== "nested") return;
    if (!currentCategoriesLoaded) return; // wait for categories to load first
    const cats = categoriesRef.current[currentRoomId];
    if (!cats) return;

    // Read forumTopicsByRoom via getState() instead of putting it in
    // this effect's deps. If it were a dep, the effect's own call to
    // setForumTopicsLoading below would mutate the store, retrigger
    // this effect, run the cleanup (flipping `cancelled = true` on the
    // closure the in-flight fetches are bound to), and those fetches
    // would silently bail after resolving — leaving every bucket
    // stuck in `loading: true` with no topics. Reading from getState
    // here gives us a fresh snapshot per effect fire without re-firing
    // on every store mutation.
    const buckets = useChat.getState().forumTopicsByRoom[currentRoomId] ?? {};
    // Build the list of bucket keys to populate: every category id +
    // the uncategorized bucket. Skip ones already loaded.
    const keys: string[] = [];
    for (const c of cats) {
      if (!buckets[c.id]) keys.push(c.id);
    }
    if (!buckets["_uncat"]) keys.push("_uncat");
    if (keys.length === 0) return;

    let cancelled = false;
    for (const key of keys) {
      setForumTopicsLoading(currentRoomId, key, true);
      const categoryParam = key === "_uncat" ? "" : key;
      const url = `/rooms/${encodeURIComponent(currentRoomId)}/topics?category=${encodeURIComponent(categoryParam)}&limit=20`;
      fetch(url, { credentials: "include" })
        .then((res) => (res.ok ? (res.json() as Promise<{ topics: ChatMessage[]; hasMore: boolean }>) : null))
        .then((j) => {
          if (cancelled || !j) return;
          setForumTopicsPage(currentRoomId, key, j.topics, j.hasMore);
        })
        .catch(() => {
          if (cancelled) return;
          // Leave the bucket empty on error; the renderer just shows
          // "No topics yet" which is benign for a network blip.
          setForumTopicsLoading(currentRoomId, key, false);
        });
    }
    return () => { cancelled = true; };
  }, [currentRoomId, currentReplyMode, currentCategoriesLoaded, setForumTopicsLoading, setForumTopicsPage]);

  /**
   * "Load older topics" handler for the forum view. Fetches the next
   * page for a category, using the oldest-loaded topic's
   * `lastActivityAt` as the cursor. The store appends the result; the
   * button shows a busy state while in flight.
   *
   * Passed down to MessageList → ForumView so each category section
   * can wire its own button without each one fetching independently.
   */
  async function loadOlderTopics(categoryKey: string): Promise<void> {
    if (!currentRoomId) return;
    const bucket = forumTopicsByRoom[currentRoomId]?.[categoryKey];
    if (!bucket || !bucket.hasMore || bucket.loading) return;
    const oldest = bucket.topics[bucket.topics.length - 1];
    if (!oldest) return;
    const cursor = oldest.lastActivityAt ?? oldest.createdAt;
    setForumTopicsLoading(currentRoomId, categoryKey, true);
    try {
      const categoryParam = categoryKey === "_uncat" ? "" : categoryKey;
      const url = `/rooms/${encodeURIComponent(currentRoomId)}/topics?category=${encodeURIComponent(categoryParam)}&before=${cursor}&limit=20`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { topics: ChatMessage[]; hasMore: boolean };
      appendForumTopicsPage(currentRoomId, categoryKey, j.topics, j.hasMore);
    } catch (err) {
      setForumTopicsLoading(currentRoomId, categoryKey, false);
      setNotice({ code: "LOAD_OLDER_FAILED", message: err instanceof Error ? err.message : "Couldn't load older topics." });
    }
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
   * Decide whether a userlist / chat-line click on `(userId, displayName)`
   * targets THIS tab's currently-voicing identity. The naive
   * `userId === me.id` check matches any identity that belongs to
   * me — including OTHER characters of mine that aren't active in
   * this tab — which produced a real bug: clicking the icon of
   * Character B while voicing Character A in this tab opened the
   * profile editor bound to A's session, so saves leaked Character
   * B's intended edits onto Character A.
   *
   * The correct test is "same userId AND same display name as the
   * SESSION's active identity," because each tab voices at most one
   * identity at a time and its display name is unique within the
   * session (per-character name uniqueness per owner + the OOC
   * username slot are mutually exclusive in the userlist — you only
   * see one identity per tab).
   */
  function isSelfActiveIdentity(userId: string, displayName: string): boolean {
    if (!me || userId !== me.id) return false;
    const myActiveDisplayName = activeCharacterName ?? me.username;
    return displayName === myActiveDisplayName;
  }

  /**
   * Click on the gender icon - view someone's profile, or open the editor
   * ONLY when the click targets this tab's currently-voicing identity.
   * For any OTHER identity (including other characters you own that
   * aren't active in this tab), open the read-only profile view.
   * (Slash-command equivalents: /whois <name> and /profile.)
   *
   * `characterId` is the identity row the click landed on — a
   * character id when the click targeted a character, null for the
   * master/OOC row. Used to open the profile of the EXACT identity
   * clicked rather than letting profile:fetch fall back to a master
   * lookup that may collide with a same-named character.
   */
  function onIconClick(userId: string, displayName: string, characterId?: string | null) {
    if (isSelfActiveIdentity(userId, displayName)) {
      send("/profile");
      return;
    }
    // Token-aware fetch when we have the id: the server resolves the
    // exact identity and never falls back to the master-takes-precedence
    // name rule. Bare-name fetch is the legacy path for callers that
    // didn't carry an id yet (mention clicks, mostly).
    const tokenName = characterId
      ? `@cid:${characterId}`
      : `@id:${userId}`;
    socket.emit("profile:fetch", { username: tokenName }, (res) => {
      if (res.ok) setOpenProfile(res.profile);
      else setNotice({ code: res.code, message: res.message });
    });
  }

  /**
   * Click on the name - PREPEND `/whisper <token> ` to whatever the
   * user is already drafting so they don't lose in-progress text. For
   * your own active identity we fall back to the icon behavior (open
   * editor) since whispering yourself is useless.
   *
   * Using `identityArgFor` substitutes a `@cid:` / `@id:` token
   * whenever the click source has the id (every userlist + chat-line
   * click does), so two users sharing a name get routed to the right
   * one. Falls back to the NBSP-escaped name for callers without an id.
   */
  function onNameClick(userId: string, displayName: string, characterId?: string | null) {
    if (isSelfActiveIdentity(userId, displayName)) {
      send("/profile");
      return;
    }
    const targetArg = identityArgFor({ userId, characterId: characterId ?? null, displayName });
    setComposerText((cur) => `/whisper ${targetArg} ${cur ?? ""}`);
  }

  /**
   * Click on a message's timestamp - PREPEND `/reply <id> ` to the
   * current composer text. Mirrors the /whisper-on-name pattern.
   * Only enabled by MessageList for replyable kinds (say/me/ooc);
   * the server re-validates on submit.
   */
  function onTimeClick(msgId: string) {
    setComposerText((cur) => `/reply ${msgId} ${cur ?? ""}`);
  }

  /**
   * Open the unified Messages modal with a specific user pre-selected.
   * Routed from ProfileModal's "💬 Message" button and any other
   * "send a DM to this person" entry points. `otherCharacterId` pins
   * the target to the right per-identity thread — null routes to the
   * master/OOC conversation; a character id opens the thread for that
   * character. Without the character id the modal would surface
   * whichever (userId, _) conversation happened to land first in the
   * store, leaking the character→master link.
   */
  function openDmWithUser(otherUserId: string, otherCharacterId: string | null) {
    setOpenDmOtherUser(otherUserId, otherCharacterId);
    setMessagesOpen(true);
    // Best-effort cache warm so the modal's first paint is correct.
    fetch(withIdentityQuery("/me/dms", useChat.getState().activeCharacterId), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && Array.isArray(j.conversations)) setDmConversations(j.conversations);
      })
      .catch(() => {});
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

  // Jump-to-message flow shared by search, bookmarks, and (eventually)
  // mention navigation. Two distinct paths depending on the room's
  // reply mode:
  //
  //  - Flat rooms: load a chronological window via
  //    `/messages/around`, replace `messagesByRoom` wholesale, set the
  //    "viewing older history" banner, then flash the row in
  //    MessageList via `highlightMessageId`.
  //
  //  - Forum rooms: the chronological-window model doesn't compose
  //    with the per-category topic buckets, so we go a different
  //    route — fetch the topic the hit belongs to (the hit itself if
  //    it's a topic, or its parent if it's a reply) plus the full
  //    reply chain, merge them into the local stores, and open
  //    `ThreadModal` centered on the topic with `highlightMessageId`
  //    set so the modal scrolls to and flashes the specific hit.
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [viewingHistory, setViewingHistory] = useState<boolean>(false);
  async function jumpToMessage(roomId: string, messageId: string) {
    setRailOpen(false);
    // Different room: switch first via the same socket path /go uses, so
    // joinRoom handles bans, password, etc.
    if (roomId !== currentRoomId) {
      await new Promise<void>((resolve) => {
        socket.emit("room:join", { roomId }, (res) => {
          if (!res.ok) setNotice({ code: res.code, message: res.message });
          resolve();
        });
      });
    }

    // Re-read the room's replyMode AFTER the join completes — the
    // local store updates when `room:state` lands. For same-room
    // jumps the value is already current.
    const isForum = useChat.getState().rooms[roomId]?.replyMode === "nested";

    if (isForum) {
      // Forum path. The `/messages/:messageId/thread` endpoint figures
      // out the topic for us regardless of whether the id is a topic
      // or a reply, and returns the topic + every reply under it.
      try {
        const r = await fetch(
          `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/thread`,
          { credentials: "include" },
        );
        if (!r.ok) {
          setNotice({ code: "JUMP_FAILED", message: "Couldn't open that thread — it may have been removed." });
          return;
        }
        const j = (await r.json()) as { topic: ChatMessage; replies: ChatMessage[] };

        // Splice the topic into its bucket so closing the modal
        // leaves the topic visible in the underlying forum list.
        // Uses the existing own-prepend action (it dedupes if the
        // topic was already loaded). categoryKey mirrors the
        // server's bucket convention.
        const categoryKey = j.topic.threadCategoryId ?? "_uncat";
        prependOwnForumTopic(roomId, categoryKey, j.topic);

        // Merge the replies into `messagesByRoom` so the modal — which
        // reads replies from the chat buffer — sees them. We use
        // appendMessage in a loop (with the store's own de-dup) so
        // existing buffer entries aren't clobbered.
        for (const r of j.replies) appendMessage(r);

        setActiveTopicId(j.topic.id);
        setTopicCreateMode(false);
        setPoppedTopicId(j.topic.id);
        setHighlightMessageId(messageId);
      } catch (err) {
        setNotice({ code: "JUMP_FAILED", message: err instanceof Error ? err.message : "load failed" });
      }
      return;
    }

    // Flat-room path: chronological window load.
    const existing = useChat.getState().messagesByRoom[roomId] ?? [];
    const alreadyLoaded = existing.some((m) => m.id === messageId);
    if (!alreadyLoaded) {
      try {
        const r = await fetch(
          `/rooms/${encodeURIComponent(roomId)}/messages/around?messageId=${encodeURIComponent(messageId)}&before=20&after=20`,
          { credentials: "include" },
        );
        if (!r.ok) {
          setNotice({ code: "JUMP_FAILED", message: "Couldn't load that message — it may have been removed." });
          return;
        }
        const j = (await r.json()) as { messages: ChatMessage[] };
        setMessages(roomId, j.messages);
        setViewingHistory(true);
      } catch (err) {
        setNotice({ code: "JUMP_FAILED", message: err instanceof Error ? err.message : "load failed" });
        return;
      }
    }
    setHighlightMessageId(messageId);
  }

  // "Return to live" — refresh the buffer with the recent backlog and
  // drop the historical-view flag. Re-issues room:join, which on the
  // server returns the standard last-50 message:bulk we get on connect.
  function returnToLive() {
    if (!currentRoomId) return;
    socket.emit("room:join", { roomId: currentRoomId }, () => {});
    setViewingHistory(false);
  }

  const room = currentRoomId ? rooms[currentRoomId] : undefined;
  const messages = currentRoomId ? messagesByRoom[currentRoomId] ?? [] : [];
  const occ = currentRoomId ? occupants[currentRoomId] ?? [] : [];
  // Resolve activeTopicId → the actual topic message so the composer can
  // render the "Replying to" indicator. We look it up by id in the room's
  // buffer; null when the id isn't present (paged out, deleted, or no
  // active topic). Falls back gracefully if the message isn't loaded.
  const isForumRoom = room?.replyMode === "nested";
  // Viewer-side moderator gate. Used to expose Lock/Unlock + cross-
  // author Delete in the forum UI. The server is authoritative on
  // every action — this only controls UI affordance visibility. Gates
  // on the granular Phase-2 permission keys (which fold in role grants
  // + per-user overrides) instead of the legacy tier check, so a user
  // explicitly granted just `delete_others_message` via the matrix
  // sees the moderator delete button without needing the full mod
  // role.
  const canModerate = !!me && (
    me.permissions.includes("delete_others_message")
    || me.permissions.includes("lock_forum_topic")
  );
  // Pin/Unpin visibility. Stricter than canModerate.
  const canPin = !!me && me.permissions.includes("pin_forum_topic");
  // Cross-author edit gate. The moderation lever for author touch-up
  // requests that miss the normal grace window. The server re-checks
  // via `hasPermission(me, "edit_others_message")` on PATCH
  // /messages/:id.
  const canAdminEdit = !!me && me.permissions.includes("edit_others_message");
  // Admin-panel access gate. The matrix-grantable `view_admin_*` keys
  // each map to an AdminPanel tab; if the viewer holds even one,
  // they're allowed to open the panel (the tab-visibility helper
  // inside `AdminPanel` filters the strip to only the tabs they can
  // actually use). Surfaces the Admin button on the banner and gates
  // the AdminPanel modal render.
  const hasAnyAdminAccess = !!me && me.permissions.some((k) => k.startsWith("view_admin_"));
  const activeTopic = useMemo(() => {
    if (!activeTopicId) return null;
    const m = messages.find((x) => x.id === activeTopicId);
    if (!m) return null;
    return { id: m.id, title: m.title ?? null, body: m.body, locked: !!m.lockedAt };
  }, [activeTopicId, messages]);
  // Pop-out modal data. We look up the topic message itself + the
  // replies that target it (id-matched). Replies stay in their
  // original chronological order — same as the inline forum view.
  // If the topic was deleted server-side after the modal opened, we
  // return null and the modal effect below auto-closes.
  const poppedTopic = useMemo(() => {
    if (!poppedTopicId) return null;
    return messages.find((m) => m.id === poppedTopicId) ?? null;
  }, [poppedTopicId, messages]);
  const poppedReplies = useMemo(() => {
    if (!poppedTopicId) return [] as ChatMessage[];
    return messages.filter((m) => m.replyToId === poppedTopicId);
  }, [poppedTopicId, messages]);
  // Auto-close if the topic vanishes from view: either paged out of
  // the buffer entirely (poppedTopic === null) OR soft-deleted while
  // the modal is open (poppedTopic.deletedAt set). Without the
  // deletedAt branch the modal would linger showing the topic header
  // with a "[message removed]" body and an active reply composer.
  useEffect(() => {
    if (!poppedTopicId) return;
    if (!poppedTopic || poppedTopic.deletedAt) setPoppedTopicId(null);
  }, [poppedTopicId, poppedTopic]);

  return (
    // ActiveThemeContext exposes `activeTheme` to descendants that need to
    // inspect the palette imperatively at render time — currently the
    // message renderers that nudge a player's chosen text color toward a
    // legible variant against the current background. The CSS-var path
    // (set by applyTheme above) still drives all standard styling; this
    // is just for components that must branch on the bg color in JS.
    <ActiveThemeContext.Provider value={activeTheme}>
    {/* Pin the entire chat shell to the viewport with position: fixed so
        document-level scroll (autoFocus on the composer scrolling things
        into view, mobile chrome address-bar resize, etc.) can't shift it
        out from under the user. inset-0 (top/right/bottom/left = 0) anchors
        it to all four edges of the layout viewport, which is what older
        browsers fall back to. h-dvh overrides the height where supported,
        so on mobile keyboards the shell shrinks with the visual viewport
        and the composer follows instead of being pushed beneath the
        keyboard. overflow-hidden keeps any internal flex child that grows
        past its allocated height from leaking back into document overflow. */}
    <div className="fixed inset-0 flex h-dvh flex-col overflow-hidden">
      {/* Theme-style ambient overlay. The active StyleGenerator (medieval-
          parchment in Phase 1) emits an SVG gradient stack as a CSS var
          on <html>; this div renders it as a fixed full-viewport background
          behind every other element. When no style is active the CSS var
          falls back to `none` and this div is invisible. */}
      <div aria-hidden className="keep-bg-overlay" />
      <Banner
        navLinksVersion={navLinksVersion}
        onOpenRules={() => setRulesOpen(true)}
        onOpenEarning={() => setEarningOpen({})}
        onOpenScriptorium={() => setScriptoriumOpen({})}
        onOpenWorlds={() => setWorldCatalogOpen(true)}
        {...(hasAnyAdminAccess ? { onOpenAdmin: () => setAdminOpen(true) } : {})}
      />
      <StaleVersionBanner />
      {/* Earning — persistent rank-up ribbon. Only renders when the
          user has unacknowledged rank-ups. Tucked under the version
          banner so deploy nags still take precedence. */}
      <EarningRibbon onOpenEarning={() => setEarningOpen({})} />
      {room?.linkedWorld ? (
        <button
          type="button"
          onClick={() => setWorldViewerId(room.linkedWorld!.id)}
          className="keep-notice keep-notice-accent flex w-full items-center justify-center gap-2 px-4 py-1 text-xs text-keep-action hover:brightness-110"
          title="Open this room's linked world"
        >
          <span className="uppercase tracking-widest">World</span>
          <span className="font-semibold normal-case tracking-normal">{room.linkedWorld.name}</span>
          <span className="text-[10px] text-keep-muted">by {room.linkedWorld.ownerUsername}</span>
        </button>
      ) : null}
      {room?.topic ? (
        <div className="keep-notice px-4 py-1 text-center text-sm italic text-keep-muted">
          {room.topic}
        </div>
      ) : null}
      {room?.messageExpiryMinutes && room.messageExpiryMinutes > 0 ? (
        <div className="keep-notice px-4 py-0.5 text-center text-[10px] uppercase tracking-widest text-keep-muted">
          Messages auto-expire after {formatExpiry(room.messageExpiryMinutes)}
        </div>
      ) : null}
      {/* Accent-color rail. A 3px standalone strip in a light tint of
          the user's `accent` color, separating the entire header zone
          (banner + topic + expiry) from the chat content below. In the
          scifi style it gains a multi-layer accent glow halo so the
          divider reads as a glowing tube; modern/medieval render it
          as a clean colored strip without the bloom. The strip exists
          as its own element rather than a border on a container so it
          can project its glow downward into the chat without being
          clipped by the parent. `data-rail="header"` distinguishes
          this one from the matching rail above the composer so the
          scifi style can paint it in a darker blue/purple (no bg
          bloom underneath this rail's bright end, so a flat magenta
          peak read as a bare neon strip floating on its own — the
          purple lets it sink into the ambient instead). */}
      <div aria-hidden className="keep-accent-rail" data-rail="header" />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* The friends list used to live here as an always-visible
            48px-wide rail, but a column that narrow couldn't fit
            avatars or a readable label and ended up squeezing the
            rest of the chat shell. Friends now live inside the
            unified Messages modal (Tools → People → Messages); the
            old standalone Friends button was redundant once the two
            features merged into one surface. */}
        {/* `min-w-0` is non-negotiable: by default a flex child's
            `min-width` is `auto` (= its intrinsic content width), so a
            wide descendant — a long topic title, an action button strip,
            anything with non-wrapping content — forces <main> to grow
            beyond the viewport. The parent's `overflow-hidden` then
            clips the right edge visually, which is what produced the
            "everything pushed off-screen" bug in mobile forum view.
            `min-w-0` lets the flex child shrink to its allocated slot
            and forces descendants to honor their own truncation rules. */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* "Viewing older history" only applies to flat rooms — for
              forum rooms the topic buckets paginate independently and
              there's no single "live" chronological view to return to.
              The forum jump path opens ThreadModal and never sets
              viewingHistory, but this gate is a belt-and-suspenders
              against any future caller that flips the flag in a
              nested room. */}
          {viewingHistory && !isForumRoom ? (
            <button
              type="button"
              onClick={returnToLive}
              className="flex w-full items-center justify-center gap-2 border-b border-keep-action/40 bg-keep-action/15 px-3 py-1 text-xs text-keep-action hover:bg-keep-action/25"
              title="Reload the recent backlog and return to live chat"
            >
              <span aria-hidden>↓</span>
              Viewing older history — click to return to live
            </button>
          ) : null}
          {/* Relative wrapper so the TypingIndicator inside can anchor
              `absolute bottom-0` over the chat feed's reserved bottom
              padding (see MessageList's `pb-6`). This is the Discord
              pattern: chat reserves a small strip at the bottom that
              stays empty when nobody's typing and gets overlaid with
              the typing strip when someone is — no layout shift, no
              composer jitter, no chat space lost while typing. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
          <MessageList
            messages={messages}
            occupants={occ}
            selfUserId={me?.id ?? null}
            selfNames={selfNames}
            roomType={room?.type ?? null}
            replyMode={room?.replyMode ?? "flat"}
            onIconClick={onIconClick}
            onNameClick={onNameClick}
            onMentionClick={onMentionClick}
            onWorldClick={(slug) => setWorldViewerId(slug)}
            onTimeClick={onTimeClick}
            onJumpToReply={(id) => {
              // Click on a reply's quote → jump to the parent message
              // in this room. Reuses the same flow bookmarks use; the
              // helper handles both flat-room scroll + forum-modal
              // expand-and-flash. No-op when there's no current room
              // (shouldn't happen — MessageList only renders inside
              // one).
              if (currentRoomId) void jumpToMessage(currentRoomId, id);
            }}
            fontStep={fontStep}
            highlightMessageId={highlightMessageId}
            onHighlightDone={() => setHighlightMessageId(null)}
            roomId={currentRoomId}
            {...(isForumRoom && currentRoomId && threadCategoriesByRoom[currentRoomId]
              ? { threadCategories: threadCategoriesByRoom[currentRoomId] }
              : {})}
            canModerate={canModerate}
            canPin={canPin}
            canAdminEdit={canAdminEdit}
            onQuotePost={(quoteText) => {
              // Inline forum-view quote: pre-fill the MAIN composer.
              // Append to whatever's already typed so the user can
              // stack multiple quotes if they want to reply to a few
              // posts at once.
              setComposerText((cur) => (cur ? `${cur}\n\n${quoteText}` : quoteText));
            }}
            {...(isForumRoom && currentRoomId && forumTopicsByRoom[currentRoomId]
              ? { forumBuckets: forumTopicsByRoom[currentRoomId] }
              : {})}
            onLoadOlderTopics={loadOlderTopics}
            onFlushPendingTopics={(categoryKey) => {
              if (!currentRoomId) return;
              flushPendingForumTopics(currentRoomId, categoryKey);
            }}
            activeTopicId={activeTopicId}
            onSetActiveTopic={(id) => {
              setActiveTopicId(id);
              // Picking a topic implicitly cancels topic-create mode —
              // the user just told us they want to read/reply rather
              // than start a new thread.
              if (id) setTopicCreateMode(false);
            }}
            onPopoutTopic={(id) => {
              // Pop-out also flips the underlying list view to that
              // topic so when the user closes the modal they land on
              // the same expanded topic in the inline forum. Cancels
              // topic-create for the same reason onSetActiveTopic does.
              setActiveTopicId(id);
              setTopicCreateMode(false);
              setPoppedTopicId(id);
            }}
            onActivateCategory={(id) => setActiveForumCategoryId(id)}
            // Per-section "+ New Topic" button: collapse-out of any reply
            // mode, set this section as the target category, and pop the
            // composer into topic-create. Single click escapes "stuck in
            // replying to thread X" without making the user hunt for a
            // Cancel button first.
            onStartTopicInCategory={(id) => {
              setActiveTopicId(null);
              setActiveForumCategoryId(id);
              setTopicCreateMode(true);
            }}
          />
          {/* TypingIndicator overlays the bottom of the message stream
              (absolute-positioned inside the relative wrapper above).
              Renders null when nobody else is typing, so the reserved
              padding strip is just empty space at rest. */}
          <TypingIndicator roomId={currentRoomId} />
          </div>
          <MutualPrompts
            socket={socket}
            onError={(n) => setNotice(n)}
          />
          {/* Scriptorium collaborator invites — Accept | Decline cards
              mirroring MutualPrompts. The persistent counterpart lives
              on the catalog's My Stories tab. */}
          <StoryInvitePrompts
            socket={socket}
            onError={(n) => setNotice(n)}
          />
          {/* Inline friend-request prompts. Sit alongside the mutual-
              title prompts so any inbound social ask lands in one
              consistent slot above the composer. Cards dispatch
              /accept or /decline via the existing send() pipe — the
              server emits a fresh friend:request echo when the row
              flips, which clears the card via the store re-sync. */}
          <FriendRequestPrompts />
          {/* Second accent rail — sits between the message stream and
              the composer. Same base class as the header rail, but
              `data-rail="footer"` lets the scifi style keep the
              canonical magenta peak here because the body's bottom-
              right accent bloom sits directly under this rail's
              bright end — so the rail genuinely emits into the
              bloom rather than floating on bare ambient. */}
          <div aria-hidden className="keep-accent-rail" data-rail="footer" />
          <Composer
            value={composerText}
            onChange={setComposerText}
            onSend={send}
            occupants={occ}
            onOpenRail={() => setRailOpen(true)}
            roomId={currentRoomId}
            {...(isForumRoom && currentRoomId && threadCategoriesByRoom[currentRoomId]
              ? { threadCategories: threadCategoriesByRoom[currentRoomId] }
              : {})}
            isForumRoom={!!isForumRoom}
            canModerate={canModerate}
            activeTopic={activeTopic}
            topicCreateMode={topicCreateMode}
            {...(activeForumCategoryId !== undefined
              ? { preferredCategoryId: activeForumCategoryId }
              : {})}
            onStartTopicCreate={() => {
              // Leaving a thread to start a new topic is the natural UX —
              // the composer can only be in one forum-state at a time.
              setActiveTopicId(null);
              setTopicCreateMode(true);
            }}
            onCancelTopicCreate={() => setTopicCreateMode(false)}
            onLeaveThread={() => setActiveTopicId(null)}
            onOpenEarning={() => setEarningOpen({})}
          />
        </main>
        {/* Mobile-only backdrop when rail drawer is open */}
        {railOpen ? (
          <div
            className="fixed inset-0 z-30 bg-black/60 lg:hidden"
            onClick={() => setRailOpen(false)}
            aria-hidden="true"
          />
        ) : null}
        <RoomsTree
          rooms={roomsTree}
          currentRoomId={currentRoomId}
          activeCharacterId={activeCharacterId}
          activeCharacterName={activeCharacterName}
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
          onJumpToMessage={jumpToMessage}
          onOpenMessages={() => { setMessagesOpen(true); setRailOpen(false); }}
          onOpenEarning={() => { setEarningOpen({}); setRailOpen(false); }}
          isOpen={railOpen}
          onClose={() => setRailOpen(false)}
          fontStep={fontStep}
        />
      </div>
      {notice ? <Toast notice={notice} onDismiss={() => setNotice(null)} /> : null}
      {openProfile ? (
        <ProfileModal
          profile={openProfile}
          onClose={() => setOpenProfile(null)}
          // Stack above MessagesModal (z=50) so opening a profile from
          // inside a DM (avatar/name click in the thread header or a
          // message bubble) lands on TOP of the messenger instead of
          // behind it. Other entry points (chat avatar tile, mentions)
          // open against a modal-free canvas where 60 is still fine.
          zIndex={60}
          // The owner + admin-tier moderators skip the NSFW gate
          // splash. Owners wouldn't gain anything from being warned
          // about their own content; moderators holding
          // `view_user_directory_secure` need to see profiles for
          // moderation regardless of how the author marked them.
          bypassNsfwGate={
            !!me && (
              me.id === openProfile.profile.userId
              || me.permissions.includes("view_user_directory_secure")
            )
          }
          // Whisper / ignore are noise on your own profile - they're for
          // interacting with someone else. Suppress when the profile's
          // owning userId matches the viewer (covers your master profile
          // and any of your characters - both shapes carry userId).
          {...(me && openProfile.profile.userId !== me.id
            ? {
                onWhisper: (name: string) => {
                  setOpenProfile(null);
                  // Prefer the identity token so a same-named character
                  // belonging to a different account can't intercept
                  // the whisper. `identityArgFor` picks `@cid:` when the
                  // profile is a character, `@id:` for the master, and
                  // falls back to the NBSP-escaped name only if neither
                  // id is available (shouldn't happen here — the
                  // profile carries both).
                  const targetArg = identityArgFor({
                    userId: openProfile.profile.userId,
                    characterId: openProfile.kind === "character"
                      ? (openProfile.profile.id ?? null)
                      : null,
                    displayName: name,
                  });
                  setComposerText((cur) => `/whisper ${targetArg} ${cur ?? ""}`);
                },
                // Open the unified Messages modal pinned to the right
                // per-identity thread: when the profile in view is a
                // character we hand its id to the messenger so the
                // character's conversation opens (not the master/OOC
                // one), preserving the privacy partition between a
                // user's identities. If no conversation exists yet the
                // panel renders in "Send a message to start" mode and
                // the first POST creates the conversation pinned to
                // that same identity.
                onMessage: (userId: string) => {
                  const targetCharId = openProfile.kind === "character"
                    ? (openProfile.profile.id ?? null)
                    : null;
                  setOpenProfile(null);
                  openDmWithUser(userId, targetCharId);
                },
                onIgnore: (name: string) => {
                  setOpenProfile(null);
                  // Token form for the same disambiguation reason as
                  // onWhisper above. Server-side /ignore accepts both.
                  const targetArg = identityArgFor({
                    userId: openProfile.profile.userId,
                    characterId: openProfile.kind === "character"
                      ? (openProfile.profile.id ?? null)
                      : null,
                    displayName: name,
                  });
                  send(`/ignore ${targetArg}`);
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
                  // Per-tab switch via socket. The server scopes the new
                  // identity to THIS socket so a parallel tab voicing a
                  // different character isn't dragged along; me:character-
                  // update lands in the global listener and refreshes
                  // activeCharacterId/Name + themeVersion.
                  socket.emit("me:switch-character", { characterId: targetId }, (res) => {
                    if (res.ok) {
                      setOpenProfile(null);
                    } else {
                      setNotice({ code: res.code ?? "SWITCH_FAILED", message: res.message ?? "switch failed" });
                    }
                  });
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
          // Optional admin-acting-on-other-user context. When set,
          // ProfileEditor skips its `/me` + character-list fetches
          // (those return the caller's own data) and edits the named
          // character via the admin-allowed `/characters/:id`
          // endpoints. Conditional spread is exactOptionalPropertyTypes-
          // friendly — we don't pass `undefined` through.
          {...(editor.adminContext ? { adminContext: editor.adminContext } : {})}
          onClose={() => {
            closeEditor();
            setThemeVersion((v) => v + 1);
          }}
          // Re-apply the active theme on save ONLY when the saved
          // target is the identity this tab is currently voicing.
          // Otherwise the bump triggers App's theme effect, which
          // pulls activeTheme from the active identity (not the one
          // being edited) and clobbers the editor's live preview —
          // making "Save" look like it reverted the theme to OOC.
          // Saving the active identity still gives the live-update
          // experience the comment originally promised.
          onSaved={(savedTarget) => {
            if (!savedTarget) return;
            const editingActive = savedTarget.kind === "master"
              ? activeCharacterId === null
              : savedTarget.id === activeCharacterId;
            if (editingActive) setThemeVersion((v) => v + 1);
          }}
        />
      ) : null}
      {adminOpen && hasAnyAdminAccess ? (
        <AdminPanel
          onClose={() => setAdminOpen(false)}
          onLinksChanged={() => setNavLinksVersion((v) => v + 1)}
        />
      ) : null}
      {rulesOpen ? <RulesModal onClose={() => setRulesOpen(false)} /> : null}
      {earningOpen ? (
        <EarningDashboard
          onClose={() => setEarningOpen(null)}
          {...(earningOpen.tab ? { initialTab: earningOpen.tab } : {})}
          {...(earningOpen.itemSubTab ? { initialItemSubTab: earningOpen.itemSubTab } : {})}
        />
      ) : null}
      {openItem ? (
        <ItemZoomView entry={openItem} onClose={() => setOpenItem(null)} />
      ) : null}
      {poppedTopic ? (
        <ThreadModal
          topic={poppedTopic}
          replies={poppedReplies}
          selfUserId={me?.id ?? null}
          selfNames={selfNames}
          roomType={room?.type ?? null}
          canModerate={canModerate}
          canPin={canPin}
          canAdminEdit={canAdminEdit}
          occupants={occ}
          onIconClick={onIconClick}
          onNameClick={onNameClick}
          onMentionClick={onMentionClick}
          onWorldClick={(slug) => setWorldViewerId(slug)}
          onTimeClick={onTimeClick}
          onJumpToReply={(id) => {
            if (currentRoomId) void jumpToMessage(currentRoomId, id);
          }}
          onReply={(text) => send(text, { replyToId: poppedTopic.id })}
          onClose={() => setPoppedTopicId(null)}
          highlightMessageId={highlightMessageId}
          onHighlightDone={() => setHighlightMessageId(null)}
        />
      ) : null}
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
      {messagesOpen && me ? (
        <MessagesModal
          onClose={() => { setMessagesOpen(false); setOpenDmOtherUser(null); }}
          onCommand={(text) => send(text)}
          initialOtherUserId={openDmOtherUserId}
          initialOtherCharacterId={openDmOtherCharacterId}
          // Open the profile modal when the DM header / bubble name is
          // clicked. Same socket-backed fetch chat's avatar-tile click
          // uses, so character vs master profile selection follows the
          // same rules everywhere.
          onOpenProfile={(displayName) => {
            socket.emit("profile:fetch", { username: displayName }, (res) => {
              if (res.ok) setOpenProfile(res.profile);
              else setNotice({ code: res.code, message: res.message });
            });
          }}
        />
      ) : null}
      {bookmarksOpen ? (
        <BookmarksModal
          onClose={() => setBookmarksOpen(false)}
          onJumpToMessage={jumpToMessage}
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
      {scriptoriumOpen ? (
        <StoryCatalogModal
          {...(scriptoriumOpen.tab ? { initialTab: scriptoriumOpen.tab } : {})}
          onClose={() => setScriptoriumOpen(null)}
          onOpenStory={(storyId) => {
            // Keep the catalog mounted underneath so closing the reader
            // returns the user to where they were browsing. The reader
            // modal stacks on top (later in JSX → higher z-stack at
            // equal z-index). Reader's onBack closes it without touching
            // the catalog state.
            setStoryReader({ storyId });
          }}
          onOpenEditor={(storyId) => {
            // Same stacking pattern as onOpenStory.
            setStoryEditor({ storyId });
          }}
        />
      ) : null}
      {storyEditor ? (
        <StoryEditorModal
          storyId={storyEditor.storyId}
          onClose={() => setStoryEditor(null)}
          onDeleted={() => setStoryEditor(null)}
          {...(scriptoriumOpen ? { onBack: () => setStoryEditor(null) } : {})}
        />
      ) : null}
      {storyReader ? (
        <StoryReaderModal
          storyId={storyReader.storyId}
          {...(typeof storyReader.chapterIndex === "number" ? { initialChapterIndex: storyReader.chapterIndex } : {})}
          onClose={() => setStoryReader(null)}
          {...(scriptoriumOpen ? { onBack: () => setStoryReader(null) } : {})}
          {...(me ? {
            onEdit: () => {
              // The reader gates the Edit button server-side
              // (viewerCanEdit). Open the editor stacked on top of the
              // reader; closing the editor returns to the reader, and
              // closing the reader returns to the catalog (if open).
              setStoryEditor({ storyId: storyReader.storyId });
            },
          } : {})}
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
    </ActiveThemeContext.Provider>
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

/**
 * Sticky "you're on an old version, please refresh" banner. Mounted in
 * the chat shell just under the main Banner so it's the first thing
 * users see across the top of the page when a drift is detected. The
 * Refresh button does a hard reload so the browser pulls the new
 * index.html and (transitively) the new asset bundle. The banner
 * stays put until refresh — no dismiss button on purpose, because
 * dismissing it would just hide the very thing the user needs to act
 * on. The 60s /auth/me poll keeps the comparison fresh, so a deploy
 * surfaces this within a minute of landing.
 */
function StaleVersionBanner() {
  const staleVersion = useChat((s) => s.staleVersion);
  const staleUpdateMessage = useChat((s) => s.staleUpdateMessage);
  const siteName = useChat((s) => s.branding.siteName);
  if (!staleVersion) return null;
  return (
    <div className="keep-notice keep-notice-accent flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 text-xs">
      <span>
        You're running <b>{siteName} {VERSION}</b>. The current version is <b>{staleVersion}</b>.
        {/* Admin-authored release note from `remote-deploy.sh
            --update-msg "..."`. Italicized + muted so it reads as
            secondary context next to the version lines. Falls back
            silently when the deploy didn't carry a note. */}
        {staleUpdateMessage ? (
          <> <em className="text-keep-muted">{staleUpdateMessage}</em></>
        ) : null}
        {" "}Please refresh to update.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="keep-button rounded border border-keep-action bg-keep-action/20 px-2 py-0.5 text-xs font-semibold text-keep-action hover:bg-keep-action/30"
      >
        Refresh
      </button>
    </div>
  );
}
