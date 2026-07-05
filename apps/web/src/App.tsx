import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ChatMessage, PermissionKey, PinnedMessage, PrivateWorldStub, ProfileView, Role, Theme, ThreadCategory, TourId, UiRouteRankingBoard, WorldDetail } from "@thekeep/shared";
import { arcadeGameByKey, DEFAULT_PRESET_DESIGNS, DEFAULT_THEME, isDarkPalette, legibleAgainstBg, matchThemePreset, normalizeTheme, VERSION } from "@thekeep/shared";
// Heavy, authenticated-only surfaces are code-split (B1, plan.md §3) so
// the anonymous splash / login / boot bundle never downloads them. Each
// is a NAMED export, so we adapt it to the default-export shape React.lazy
// expects. Every one of these renders only inside the authenticated <Chat>
// subtree, which is wrapped in a single <Suspense> boundary — so a lazy
// descendant can always suspend into an ancestor and never crash. Do NOT
// lazy-load anything on the anonymous path (SplashLanding, AuthGate, etc.).
const AdminPanel = lazy(() => import("./components/AdminPanel.js").then((m) => ({ default: m.AdminPanel })));
import { AuthGate, SplashShell } from "./components/AuthGate.js";
import { SplashLanding } from "./components/SplashLanding.js";
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from "./components/EmailAuthPages.js";
import { VerifyEmailGate } from "./components/VerifyEmailGate.js";
import { Banner } from "./components/Banner.js";
import { Composer } from "./components/Composer.js";
import { TypingIndicator } from "./components/TypingIndicator.js";
const HelpModal = lazy(() => import("./components/HelpModal.js").then((m) => ({ default: m.HelpModal })));
import { InfoModal } from "./components/InfoModal.js";
import { MessageList } from "./components/MessageList.js";
import { TheaterPanel } from "./components/TheaterPanel.js";
import { MutualPrompts } from "./components/MutualPrompts.js";
import { StoryInvitePrompts } from "./components/StoryInvitePrompts.js";
import { FriendRequestPrompts } from "./components/FriendRequestPrompts.js";
import { BookmarksModal } from "./components/BookmarksModal.js";
const ProfileEditor = lazy(() => import("./components/ProfileEditor.js").then((m) => ({ default: m.ProfileEditor })));
import { ProfileModal } from "./components/ProfileModal.js";
import { RoomPasswordModal } from "./components/RoomPasswordModal.js";
import { RoomsTree, type RoomWithOccupants } from "./components/RoomsTree.js";
import { ServerRail } from "./components/ServerRail.js";
const ServerSettingsView = lazy(() => import("./components/ServerSettingsView.js").then((m) => ({ default: m.ServerSettingsView })));
const ServerDiscoverModal = lazy(() => import("./components/ServerDiscoverModal.js").then((m) => ({ default: m.ServerDiscoverModal })));
import { listServers, resolveServerSlug, visitServer, type ServerSummary } from "./lib/servers.js";
const MessagesModal = lazy(() => import("./components/MessagesModal.js").then((m) => ({ default: m.MessagesModal })));
import { RulesModal } from "./components/RulesModal.js";
import { RulesPage } from "./components/RulesPage.js";
import { isRulesUrl, navigateAwayFromRules } from "./lib/rulesUrl.js";
import { FaqPage } from "./components/FaqPage.js";
import { TopCommunitiesPage, isTopCommunitiesUrl, consumeAddCommunityIntent } from "./components/TopCommunitiesPage.js";
import { faqRoute, type FaqRoute } from "./lib/faqUrl.js";
const EarningDashboard = lazy(() => import("./components/EarningDashboard.js").then((m) => ({ default: m.EarningDashboard })));
import { ErrorBoundary } from "./components/ErrorBoundary.js";
const ArcadeLauncher = lazy(() => import("./components/arcade/ArcadeLauncher.js").then((m) => ({ default: m.ArcadeLauncher })));
const EidolonWindow = lazy(() => import("./components/arcade/EidolonWindow.js").then((m) => ({ default: m.EidolonWindow })));
const UrugalWindow = lazy(() => import("./components/arcade/UrugalWindow.js").then((m) => ({ default: m.UrugalWindow })));
const GrimholdWindow = lazy(() => import("./components/arcade/GrimholdWindow.js").then((m) => ({ default: m.GrimholdWindow })));
import { EarningRibbon } from "./components/EarningRibbon.js";
import { BannerMarquee } from "./components/BannerMarquee.js";
import { RoomInfoBar } from "./components/RoomInfoBar.js";
import { dismiss as dismissPersisted, useDismissed } from "./lib/dismissedBanners.js";
import { onUiRouteOpen } from "./lib/uiRouteOpen.js";
import { recordNav, recordPageView, classifyPublicPath } from "./lib/nav-metrics.js";
import { fetchLatestPublishedStory } from "./lib/latestStory.js";
import { playRoomTransition } from "./lib/transitions/orchestrator.js";
import { reduceMotionEnabled } from "./lib/reducedMotion.js";
// Side-effect: stamps the unified `calm-cosmetics` class on <html> at boot so
// expensive equipped cosmetics are gated even before Settings is opened.
import "./lib/calmCosmetics.js";
import { fetchSpotlightMember, fetchRoomBrief, fetchStoryBrief } from "./lib/uiRouteDynamicLabel.js";
import { loadForumDraft, pruneStaleForumDrafts, saveForumDraft } from "./lib/forumDrafts.js";
import { ItemZoomView, type ItemZoomEntry } from "./components/ItemZoomView.js";
const ThreadModal = lazy(() => import("./components/ThreadModal.js").then((m) => ({ default: m.ThreadModal })));
import { UsersModal } from "./components/UsersModal.js";
import { WorldCatalogModal } from "./components/WorldCatalogModal.js";
const WorldEditorModal = lazy(() => import("./components/WorldEditorModal.js").then((m) => ({ default: m.WorldEditorModal })));
import { WorldViewerModal } from "./components/WorldViewerModal.js";
const WorldsListModal = lazy(() => import("./components/WorldsListModal.js").then((m) => ({ default: m.WorldsListModal })));
import { StaffModal } from "./components/StaffModal.js";
import { AffiliateSubmitPortal } from "./components/AffiliateSubmitPortal.js";
import { StoryCatalogModal } from "./components/StoryCatalogModal.js";
const ForumsCatalogModal = lazy(() => import("./components/ForumsCatalogModal.js").then((m) => ({ default: m.ForumsCatalogModal })));
import { ForumPublicLanding, readReturnForum, RETURN_FORUM_STORAGE_KEY } from "./components/ForumPublicLanding.js";
import { ServerPublicLanding, readReturnServer, RETURN_SERVER_STORAGE_KEY } from "./components/ServerPublicLanding.js";
import { fetchForumNotifications, locateForumTopic } from "./lib/forums.js";
import { fetchNotifBadge } from "./lib/notificationCenter.js";
const NotificationCenter = lazy(() => import("./components/NotificationCenter.js").then((m) => ({ default: m.NotificationCenter })));
const StoryEditorModal = lazy(() => import("./components/StoryEditorModal.js").then((m) => ({ default: m.StoryEditorModal })));
import { StoryReaderModal } from "./components/StoryReaderModal.js";
import { WelcomeModal } from "./components/WelcomeModal.js";
import { ServerOnboardingModal } from "./components/ServerOnboardingModal.js";
import { ServerEventsPanel, OPEN_SERVER_EVENT, type OpenServerEventDetail } from "./components/ServerEventsPanel.js";
import { SiteTour } from "./components/SiteTour.js";
import { getSocket, disconnect as disconnectSocket, hasSessionBeenAnnounced, loadTabCharacter, markLoginIntent, rememberTabCharacter, rememberTabRoom } from "./lib/socket.js";
import { parseWorldFromUrl, syncWorldUrl } from "./lib/worlds.js";
import { parseProfileFromUrl, syncProfileUrl, type PrivateProfileStub } from "./lib/profiles.js";
import { ActiveThemeContext, applyFontPrefs, applyTheme, resolveSplashTheme, splashBgClass, themeStyle, useActiveTheme, type UiFontScale } from "./lib/theme.js";
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
        // Clear a stale token immediately on 401, otherwise the next
        // tab open inherits a dead token and the user wonders why every
        // request bounces them back to the splash.
        if (r.status === 401) clearSessionToken();
        return r.ok
          ? (r.json() as Promise<{
              id: string;
              username: string;
              role: Role;
              permissions: PermissionKey[];
              incognitoMode?: boolean;
              incognitoAlias?: string | null;
              incognitoCharacterId?: string | null;
              emailVerifiedAt?: number | null;
              emailVerificationEnabled?: boolean;
              emailVerificationMode?: "nudge" | "block";
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
          // room never saw an arrival message, the Wallace re-entry
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
            incognitoMode: j.incognitoMode ?? false,
            incognitoAlias: j.incognitoAlias ?? null,
            incognitoCharacterId: j.incognitoCharacterId ?? null,
            emailVerifiedAt: typeof j.emailVerifiedAt === "number" ? j.emailVerifiedAt : null,
            emailVerificationEnabled: j.emailVerificationEnabled ?? false,
            emailVerificationMode: j.emailVerificationMode ?? "nudge",
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

  // Earning, refresh the cached snapshot when a user signs in (so
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

  // Name styles, inject the catalog's CSS into <head> whenever the
  // snapshot lands or admins reload it. Idempotent re-injection: the
  // helper rewrites the shared <style> tag only when the concatenated
  // CSS actually changed. Subscription via Zustand's hook so the
  // effect re-runs on any catalog edit (an admin tweak surfaces live
  // on the next /earning/me fetch).
  const nameStyleCatalog = useEarning((s) => s.snapshot?.catalog.nameStyles);
  useEffect(() => {
    if (nameStyleCatalog) injectNameStyles(nameStyleCatalog);
  }, [nameStyleCatalog]);

  // Free-form borders, same idempotent CSS-injection pattern as
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
  // but it's a long lag for "the site just updated, please refresh",
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
          // ONLY a definitive 401 means the session is actually gone. Every
          // other non-2xx is transient and the session is still valid
          // server-side: 5xx during a synchronous-SQLite event-loop stall,
          // 502/503 across a deploy or machine restart, 429 from the per-IP
          // rate limit when several tabs (or NAT/CGNAT-shared users) poll at
          // once. Treating those as expiry logged healthy users out with a
          // bogus "inactivity" banner AND wiped their token - forcing a
          // needless re-login - every single time the backend hiccupped.
          // Swallow them like the network-blip catch below; the next 60s
          // tick (or the socket's own auth:expired) surfaces a real expiry.
          if (r.status === 401) {
            // Clear the token before disconnecting so an in-flight reconnect
            // attempt doesn't carry the dead sid back to the server.
            clearSessionToken();
            setKickReason("Your session expired due to inactivity. Please log in again.");
            disconnectSocket();
            setMe(null);
          }
          return;
        }
        const j = (await r.json()) as {
          id: string;
          username: string;
          role: Role;
          permissions?: PermissionKey[];
          incognitoMode?: boolean;
          incognitoAlias?: string | null;
          incognitoCharacterId?: string | null;
          emailVerifiedAt?: number | null;
          emailVerificationEnabled?: boolean;
          emailVerificationMode?: "nudge" | "block";
          version?: string;
          updateMessage?: string | null;
        };
        if (j.version && j.version !== VERSION) {
          useChat.getState().setStaleVersion(j.version, j.updateMessage ?? null);
        }
        // Refresh me.permissions on every poll so a matrix edit lands
        // on the affected user's tab within a minute, but only call
        // setMe when something actually changed. Calling setMe with a
        // new object reference on every poll re-renders every
        // subscriber of `me` (banner, message list, composer, etc.),
        // which is a noticeable hit every 60 seconds even when nothing
        // has changed.
        if (Array.isArray(j.permissions)) {
          const cur = useChat.getState().me;
          const nextIncognitoMode = j.incognitoMode ?? false;
          const nextIncognitoAlias = j.incognitoAlias ?? null;
          const nextIncognitoCharacterId = j.incognitoCharacterId ?? null;
          const nextVerifiedAt = typeof j.emailVerifiedAt === "number" ? j.emailVerifiedAt : null;
          const nextVerifyEnabled = j.emailVerificationEnabled ?? false;
          const nextVerifyMode = j.emailVerificationMode ?? "nudge";
          const changed =
            !cur
            || cur.id !== j.id
            || cur.username !== j.username
            || cur.role !== j.role
            || cur.incognitoMode !== nextIncognitoMode
            || cur.incognitoAlias !== nextIncognitoAlias
            || cur.incognitoCharacterId !== nextIncognitoCharacterId
            || cur.emailVerifiedAt !== nextVerifiedAt
            || cur.emailVerificationEnabled !== nextVerifyEnabled
            || cur.emailVerificationMode !== nextVerifyMode
            || !samePermissions(cur.permissions, j.permissions);
          if (changed) {
            setMe({
              id: j.id,
              username: j.username,
              role: j.role,
              permissions: j.permissions,
              incognitoMode: nextIncognitoMode,
              incognitoAlias: nextIncognitoAlias,
              incognitoCharacterId: nextIncognitoCharacterId,
              emailVerifiedAt: nextVerifiedAt,
              emailVerificationEnabled: nextVerifyEnabled,
              emailVerificationMode: nextVerifyMode,
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
  // explanation lives at the world-state block below, declared up here
  // so the profile fetch effect can call its setter.
  const [arrivedViaDeepLink, setArrivedViaDeepLink] = useState<boolean>(() => {
    return parseProfileFromUrl() !== null || parseWorldFromUrl() !== null;
  });

  // Public-rules-page route detection. Drives an early-return branch
  // below that renders RulesPage regardless of auth state, so a
  // registration-form visitor following the "Read the rules" link
  // (or any direct visitor to /rules) sees the page without bouncing
  // through AuthGate first. We track the URL path in state with a
  // popstate listener so back/forward navigation flips between the
  // page and whatever the previous route was without a full reload.
  const [onRulesPage, setOnRulesPage] = useState<boolean>(() => isRulesUrl());
  useEffect(() => {
    const onPop = () => setOnRulesPage(isRulesUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Public FAQ pages (/faqs index, /faq/<slug> entry). Same pre-auth
  // early-return pattern as the rules page so a mod can link an answer to a
  // logged-out visitor. Tracked in state with a popstate listener.
  const [faqPage, setFaqPage] = useState<FaqRoute | null>(() => faqRoute());
  useEffect(() => {
    const onPop = () => setFaqPage(faqRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Public /top-communities topsite board. Same pre-auth early-return pattern.
  const [onTopCommunities, setOnTopCommunities] = useState<boolean>(() => isTopCommunitiesUrl());
  useEffect(() => {
    const onPop = () => setOnTopCommunities(isTopCommunitiesUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Analytics choke point 5 (plan_ext.md §3): public / unauth SPA page views.
  // ONE mount + popstate listener classifies window.location.pathname to a
  // route TEMPLATE (never a raw id-bearing path) and records a page view. The
  // app has no router lib, so every public branch (rules/faq/scriptorium/deep
  // links) funnels through pushState → popstate; this single listener covers
  // them all instead of instrumenting each branch. Gated to logged-out
  // visitors — authed in-app nav is captured by the event choke points, and
  // this keeps public pageview counts free of member browsing noise.
  useEffect(() => {
    if (me) return;
    const track = () => {
      const tpl = classifyPublicPath(window.location.pathname);
      if (tpl) recordPageView(tpl);
    };
    track(); // initial mount / auth-state flip to logged-out
    window.addEventListener("popstate", track);
    return () => window.removeEventListener("popstate", track);
  }, [me]);

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
          // 404 / fetch failure, drop the pending state and exit
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
  // for everyone (including anonymous visitors, the point is that profile
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
   * the recipient lands on a clean view of that content, not the full
   * chat with the modal floating over it. This applies regardless of auth
   * state: an authed user clicking a shared link should also get the
   * standalone view rather than chat-with-overlay, since the URL is meant
   * to be a stable artifact.
   *
   * Mechanism: at mount we record whether the page arrived via a deep
   * link. While that flag is set, App renders the PublicViewerShell with
   * the resolved modal(s). The first time the user closes a modal or the
   * fetch resolves to "no content" (404), we drop the flag and fall
   * through to the normal app for the rest of the session, so in-app
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
          // 404 / fetch failure, drop standalone mode and let normal app
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

  // Public Rules page, wins over every other branch (deep-link,
  // splash, AuthGate, chat) because the route is intentionally
  // available without auth and we don't want any other surface to
  // intercept it. Back link pops history to "/" so a visitor lands
  // back on the splash / chat shell depending on auth state.
  if (onRulesPage) {
    return (
      <RulesPage
        onBack={() => {
          navigateAwayFromRules();
          // Manually fire popstate so the path-state above resets
          // without waiting for a browser-driven navigation event.
          window.dispatchEvent(new PopStateEvent("popstate"));
        }}
      />
    );
  }

  // Public FAQ pages render regardless of auth state (the page's own links +
  // Back control drive navigation, which fires popstate to reset this state).
  if (faqPage) {
    return <FaqPage route={faqPage} />;
  }

  // Public Top Communities board (/top-communities). Renders regardless of auth;
  // "Add Your Site" navigates to registration or into the app (firing popstate,
  // which resets this state) and opens the Add-Your-Community modal on entry.
  if (onTopCommunities) {
    return <TopCommunitiesPage />;
  }

  // Deep-link still resolving, show the standalone shell with a loading
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
  // /w/<X> for ANY auth state, the URL is meant to be a stable shareable
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
            // Refetch this profile after a mod action so NSFW flags / bio
            // edits reflect in the standalone viewer too. Reuses the
            // pendingProfile fetch effect (same path onOpenProfile uses).
            onModerated={() => {
              const profileName = openProfileForSync.kind === "master"
                ? openProfileForSync.profile.username
                : openProfileForSync.profile.name;
              setPendingProfile({ name: profileName, data: null });
            }}
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
 *  identical arrays, but we sort defensively to avoid spurious
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
 * forward, sign-in for anonymous viewers, or "open chat" for already-
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
  const setTheaterSync = useChat((s) => s.setTheaterSync);
  const pushTheaterReaction = useChat((s) => s.pushTheaterReaction);
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
  void appendForumTopicsPage; // legacy hookup kept for back-compat; new code uses goToForumPage.
  const setForumTopicsLoading = useChat((s) => s.setForumTopicsLoading);
  const prependOwnForumTopic = useChat((s) => s.prependOwnForumTopic);
  const queuePendingForumTopic = useChat((s) => s.queuePendingForumTopic);
  const flushPendingForumTopics = useChat((s) => s.flushPendingForumTopics);
  const updateForumTopic = useChat((s) => s.updateForumTopic);
  const bumpTopicActivity = useChat((s) => s.bumpTopicActivity);
  const removeForumTopic = useChat((s) => s.removeForumTopic);

  const currentRoomId = useChat((s) => s.currentRoomId);
  // Server Rail (Multi-Server Lift) state. All inert when the feature flag is
  // off: serversEnabled gates the rail render + every server-scoped fetch.
  const serversEnabled = useChat((s) => s.branding.serversEnabled === true);
  const currentServerId = useChat((s) => s.currentServerId);
  const setCurrentServerId = useChat((s) => s.setCurrentServerId);
  const setDefaultServerId = useChat((s) => s.setDefaultServerId);
  // The home/system server id (learned from the catalog). Used to skip the
  // onboarding flow on the home server (Batch 2 self-roles trigger).
  const defaultServerId = useChat((s) => s.defaultServerId);
  const myActiveTransitionKey = useChat((s) => s.myActiveTransitionKey);
  const setMyActiveTransitionKey = useChat((s) => s.setMyActiveTransitionKey);
  // Stable wrapper around the chat content; the room-transition orchestrator
  // overlays + clones it during a room switch. (The fetch of the equipped
  // transition lives after `activeCharacterId` is declared, below.)
  const chatWrapperRef = useRef<HTMLDivElement | null>(null);
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
   * empty object opens on the default Overview tab, the same shape
   * the "Your Earning" tools-panel entry uses.
   */
  type EarningOpenSpec = {
    tab?: "overview" | "ledger" | "styles" | "borders" | "cosmetics" | "items" | "rankings" | "settings";
    itemSubTab?: "inventory" | "shop" | "collection" | "pets";
    /** When opening the Rankings tab, scroll to + flash this board. */
    board?: UiRouteRankingBoard;
  };
  const [earningOpen, setEarningOpen] = useState<EarningOpenSpec | null>(null);
  // Analytics choke point 4 (plan_ext.md §3): the EarningDashboard sub-tab is
  // recorded at the modal-open hook (no internal EarningDashboard edit). Fire
  // once per open transition (null → spec) and record the initial tab, so the
  // many setEarningOpen({...}) call sites don't each need instrumenting.
  const earningWasOpen = useRef(false);
  useEffect(() => {
    if (earningOpen && !earningWasOpen.current) {
      recordNav("tab", `earning:${earningOpen.tab ?? "overview"}`, {
        ...(earningOpen.itemSubTab ? { itemSubTab: earningOpen.itemSubTab } : {}),
      });
    }
    earningWasOpen.current = !!earningOpen;
  }, [earningOpen]);
  // Spire Arcade: the launcher (a modal) and the free-floating Eidolon
  // Tamer window (non-modal, kept up while chatting). Both read the current
  // activeCharacterId at render so the right identity's wallet/inventory is
  // used. Permission gating is enforced at the dispatch + by the server.
  const [arcadeOpen, setArcadeOpen] = useState(false);
  const [eidolonOpen, setEidolonOpen] = useState(false);
  const [urugalOpen, setUrugalOpen] = useState(false);
  const [grimholdOpen, setGrimholdOpen] = useState(false);
  /**
   * Full-screen item-zoom view triggered by the `/item <name>` chat
   * command. Mounts the same overlay that powers tap-to-zoom on
   * profile Collection / Pet pins. State is null when closed; an
   * `ItemZoomEntry` (server-resolved catalog row) when open.
   */
  const [openItem, setOpenItem] = useState<ItemZoomEntry | null>(null);
  const [helpOpen, setHelpOpen] = useState<{ filter?: string; guide?: string } | null>(null);
  const [usersOpen, setUsersOpen] = useState<{ query?: string } | null>(null);
  // Server-emitted info modal, server commands like /list and /find
  // populate this with a title + multi-line body that the user can
  // read at leisure (toast is too transient for list output).
  const [infoOpen, setInfoOpen] = useState<{ title: string; body: string } | null>(null);
  /**
   * Unified Messages modal toggle. Replaces the older split-up trio
   * (FriendsModal + DmListModal + DmFloatingPanel). The Tools
   * drawer's "Messages" and "Friends" entries both flip this on,
   * the modal handles friends + requests + conversations in one
   * place. Fetches fresh on each open.
   */
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  // Password prompt for private rooms, set when the server emits a
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
  // Set by the `world-application-prompt` ui:hint (paired with an
  // `open-world` hint from the `/world join <slug>` slash command).
  // The id is matched against worldViewerId at viewer mount time,
  // when they agree, the viewer auto-opens the ApplicationFormModal
  // on top of itself, mirroring the catalog's Apply path. Cleared
  // back to null once the viewer is closed so the form doesn't
  // re-open on a future viewer mount for the same world.
  const [pendingWorldApplicationId, setPendingWorldApplicationId] = useState<string | null>(null);
  const [worldCatalogOpen, setWorldCatalogOpen] = useState(false);
  const [staffOpen, setStaffOpen] = useState(false);
  // Roleplay Communities (Affiliates v2) self-service portal. Logged-in members
  // reopen it from the nav to manage their listings and copy their link-backs
  // without hunting the splash CTA. The portal owns its own inner state; this is
  // just the open/close latch.
  const [affiliatesOpen, setAffiliatesOpen] = useState<null | "list" | "add">(null);
  // Honor the "Add Your Site" intent set on the public /top-communities page:
  // when the member lands in the app (fresh sign-in or already signed in) with
  // the flag set, open the modal straight to the Add-Your-Community form.
  useEffect(() => {
    if (consumeAddCommunityIntent()) setAffiliatesOpen("add");
  }, []);
  // Scriptorium catalog state. Object → open; null → closed. The
  // optional `tab` lets `/scriptorium my` etc. land on a specific tab.
  const [scriptoriumOpen, setScriptoriumOpen] = useState<{ tab?: "find" | "my" | "reading" | "following" } | null>(null);
  // Forums Catalog state (Forums revamp). Object → open; optional `key`
  // (slug or id from `/forums <slug>`) lands on a specific forum, and
  // optional `topic` (bookmark / search jumps into board posts) opens
  // straight onto that topic's thread inside the catalog.
  const [forumsOpen, setForumsOpen] = useState<{
    key?: string;
    topic?: { boardId: string; topicId: string; postId?: string };
    create?: boolean;
  } | null>(null);
  // /f/<slug> deep-link for SIGNED-IN visitors (anonymous ones get the
  // public landing in UnauthRouter): open the catalog on that forum and
  // normalize the URL. Also consumes the return key the public landing
  // stored before its login/register round-trip, so the visitor lands on
  // the forum the share link promised.
  useEffect(() => {
    const m = /^\/f\/([a-z0-9_]{3,40})(?:\/t\/([A-Za-z0-9_-]{4,64}))?\/?$/.exec(window.location.pathname);
    const fromPath = m?.[1] ?? null;
    const topicFromPath = m?.[2] ?? null;
    const postFromHash = /^#p-([A-Za-z0-9_-]{4,64})$/.exec(window.location.hash)?.[1];
    let fromStorage: string | null = null;
    try {
      const pending = readReturnForum();
      if (pending) {
        fromStorage = pending.slug;
        window.localStorage.removeItem(RETURN_FORUM_STORAGE_KEY);
      }
    } catch { /* private mode */ }
    const slug = fromPath ?? fromStorage;
    if (!slug) return;
    if (topicFromPath) {
      // Topic permalink: resolve the board (and root topic for reply
      // links) server-side, then open the catalog on it. Falls back to
      // the forum's front page if the post is gone.
      void locateForumTopic(topicFromPath)
        .then((loc) => setForumsOpen({
          key: loc.forumId,
          topic: {
            boardId: loc.boardRoomId,
            topicId: loc.topicId,
            ...(postFromHash ? { postId: postFromHash } : {}),
          },
        }))
        .catch(() => setForumsOpen({ key: slug }));
    } else {
      setForumsOpen({ key: slug });
    }
    if (fromPath) window.history.replaceState(null, "", "/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // /s/<slug> deep-link (Multi-Server Lift): resolve the permanent share
  // address to a server the viewer may open and enter its rooms via the normal
  // /visit path — including private servers a global staffer never joined.
  // Deferred until the servers flag is known (by then the shell + socket are
  // up); a link the viewer can't open resolves to null → a brief notice.
  const serverDeepLinkDone = useRef(false);
  useEffect(() => {
    if (serverDeepLinkDone.current || !serversEnabled) return;
    const m = /^\/s\/([a-z0-9-]{3,40})\/?$/.exec(window.location.pathname);
    serverDeepLinkDone.current = true;
    let slug = m?.[1] ?? null;
    if (!slug) {
      // Consume the return key the public /s/ landing stored before its
      // login/register round-trip, so the visitor lands in the community.
      try {
        const pending = readReturnServer();
        if (pending) { slug = pending.slug; window.localStorage.removeItem(RETURN_SERVER_STORAGE_KEY); }
      } catch { /* private mode */ }
    }
    if (!slug) return;
    void resolveServerSlug(slug)
      .then((s) => {
        if (s) void enterServerById(s.id, s.name);
        else setNotice({ code: "SERVER_LINK", message: "That server link is private or no longer exists." });
      })
      .catch(() => { /* non-fatal */ })
      .finally(() => { window.history.replaceState(null, "", "/"); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serversEnabled]);

  // Seed the forum-notification badge once per boot; the socket's
  // forum:notifications pulse keeps it live from then on.
  useEffect(() => {
    let alive = true;
    fetchForumNotifications(1)
      .then((r) => { if (alive) useChat.getState().setForumNotifUnread(r.unread); })
      .catch(() => { /* badge stays 0 until the first pulse */ });
    return () => { alive = false; };
  }, []);
  // Seed the Notification Center badge once per boot; the socket's
  // notifications:badge pulse keeps it live from then on.
  useEffect(() => {
    let alive = true;
    fetchNotifBadge()
      .then((b) => { if (alive) useChat.getState().setNotifBadge(b.unread, b.unreadByServer); })
      .catch(() => { /* badge stays 0 until the first pulse */ });
    return () => { alive = false; };
  }, []);
  // Seed per-channel unread/mention/mute state once per boot (Batch 2
  // per-channel-reads). One grouped GET /me/room-reads → the three store
  // maps RoomsTree reads for its per-room dot / mention pill / muted glyph.
  // The `room:unread` socket pulse keeps unread + mention live from then on;
  // mute changes ride the mute PUT + its re-emitted pulse. Absent roomIds are
  // treated as {unread:0, hasMention:false, muted:false} by the renderers.
  useEffect(() => {
    let alive = true;
    fetch("/me/room-reads", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j || typeof j !== "object") return;
        useChat.getState().seedRoomReads(
          j as Record<string, { unread: number; hasMention: boolean; muted: boolean }>,
        );
      })
      .catch(() => { /* dots stay clear until the first room:unread pulse */ });
    return () => { alive = false; };
  }, []);
  // Story editor state. Discriminated by presence: null → closed;
  // { storyId: null } → New Story wizard; { storyId: "xyz" } → edit
  // existing story. Avoids the empty-string sentinel pattern.
  const [storyEditor, setStoryEditor] = useState<{ storyId: string | null } | null>(null);
  // Story reader state. Object → open; null → closed. `chapterIndex`
  // optional so `/story <slug> chapter <N>` can land on a specific page.
  const [storyReader, setStoryReader] = useState<{ storyId: string; chapterIndex?: number } | null>(null);
  // Bridge: any surface (e.g. the Scriptorium rankings in the Earning
  // dashboard) can request the reader via the store; App owns the actual
  // reader state, so it watches the request, opens the reader, and clears it.
  const openStoryReaderId = useChat((s) => s.openStoryReaderId);
  const setOpenStoryReader = useChat((s) => s.setOpenStoryReader);
  useEffect(() => {
    if (!openStoryReaderId) return;
    setStoryReader({ storyId: openStoryReaderId });
    setOpenStoryReader(null);
  }, [openStoryReaderId, setOpenStoryReader]);
  const [navLinksVersion, setNavLinksVersion] = useState(0);

  /**
   * UI route dispatcher, `{rules}` / `{modal:earning:items:shop}` /
   * `{scriptorium:latest}` chips dispatched from chat lines, the
   * banner marquee, or scheduled-announcement bodies route through
   * a single `tk:open-ui-route` event the shell listens for. The
   * resolved catalog entry carries a discriminated `target`; the
   * handler narrows and calls the existing modal setter. Adding a
   * new route = add one catalog entry + one branch here.
   */
  useEffect(() => onUiRouteOpen((detail) => {
    const t = detail.entry.target;
    switch (t.kind) {
      case "modal-earning": {
        const spec: EarningOpenSpec = {};
        if (t.tab) spec.tab = t.tab;
        if (t.itemSubTab) spec.itemSubTab = t.itemSubTab;
        if (t.board) spec.board = t.board;
        setEarningOpen(spec);
        return;
      }
      case "open-member": {
        // Resolve a member (newest / random; the `random` fetch
        // re-rolls each click) then open their profile via the same
        // profile:fetch path @mentions use. `@cid:` tokens resolve a
        // character; a bare username resolves the master account.
        void fetchSpotlightMember(t.scope, t.pick).then((m) => {
          if (!m) {
            setNotice({ code: "NO_MEMBER", message: "No member to show right now." });
            return;
          }
          socket.emit("profile:fetch", { username: m.token }, (res) => {
            if (res.ok) setOpenProfile(res.profile);
            else setNotice({ code: res.code, message: res.message });
          });
        });
        return;
      }
      case "open-arcade": {
        // Read `me` fresh from the store — this effect's deps are
        // [openEditor], so a closure-captured `me` would be stale.
        if (!useChat.getState().me?.permissions.includes("use_arcade")) {
          setNotice({ code: "NO_PERMISSION", message: "The Spire Arcade isn't available to you." });
          return;
        }
        setArcadeOpen(true);
        return;
      }
      case "open-arcade-game": {
        const perms = useChat.getState().me?.permissions ?? [];
        const game = arcadeGameByKey(t.game);
        if (!game || !perms.includes("use_arcade") || !perms.includes(game.permission)) {
          setNotice({ code: "NO_PERMISSION", message: "That game isn't available to you." });
          return;
        }
        // Open the game's window directly (the window/server enforce the
        // per-player unlock gate). New games add their opener here; the
        // launcher is the safe fallback for a registry entry whose window
        // isn't wired up yet.
        const openers: Record<string, () => void> = {
          eidolon: () => setEidolonOpen(true),
          urugal: () => setUrugalOpen(true),
          grimhold: () => setGrimholdOpen(true),
        };
        (openers[game.key] ?? (() => setArcadeOpen(true)))();
        return;
      }
      case "open-world":
        // Parametric `{world:<slug>}` chip. The viewer accepts an id or
        // slug and does its own visibility-gated fetch (a private world
        // the viewer can't see renders the modal's "private" stub), so
        // we just hand it the ref straight through.
        setWorldViewerId(t.ref);
        return;
      case "open-story": {
        // Parametric `{scriptorium:<slug>}` chip. Resolve slug → {id,title}
        // via the visibility-gated lookup (cached from the label render),
        // then pop the StoryReader to it — the same path the
        // `{scriptorium:latest:story}` chip + `/story <slug>` take. A null
        // brief means the story is gone or not visible to this viewer, so
        // we surface a gentle notice instead of a silent no-op.
        void fetchStoryBrief(t.ref).then((brief) => {
          if (!brief) {
            setNotice({ code: "NO_STORY", message: "That story isn't available to you." });
            return;
          }
          setStoryReader({ storyId: brief.id });
        });
        return;
      }
      case "nav-room": {
        // Parametric `{room:<slug>}` chip. Resolve slug → {id,name} via
        // the visibility-gated lookup (cached from the label render),
        // then reuse the same room-join path a userlist/RoomsTree click
        // takes. A null brief means the room is gone or not visible to
        // this viewer, so we surface a gentle notice instead of a
        // silent no-op.
        void fetchRoomBrief(t.ref).then((brief) => {
          if (!brief) {
            setNotice({ code: "NO_ROOM", message: "That room isn't available to you." });
            return;
          }
          onRoomClick(brief.id);
        });
        return;
      }
      case "modal-rules":     setRulesOpen(true); return;
      case "modal-messages":  setMessagesOpen(true); return;
      case "modal-worlds":    setWorldCatalogOpen(true); return;
      case "modal-help":      setHelpOpen({}); return;
      case "modal-profile-own": openEditor({ mode: "master", characterId: null }); return;
      case "modal-admin":      setAdminOpen(true); return;
      case "nav-scriptorium":
        // Sort is the catalog's default-newest-first sort, so the
        // `sort: "latest"` variant doesn't need a query param, it
        // matches what the catalog already lands on. If we add an
        // alternative sort later, fork on `t.sort` here.
        setScriptoriumOpen({});
        return;
      case "nav-scriptorium-latest-story": {
        // Dynamic chip, resolve the latest published story id at
        // click time and pop the StoryReader directly to it. The chip
        // label was already resolved at render via the shared
        // fetcher; this re-call hits the same TTL cache so there's
        // no extra round-trip in the common case. Falls back to
        // opening the catalog (the static `{scriptorium:latest}`
        // surface) when nothing is published, better than a no-op
        // click on a chip that already promised a destination.
        void fetchLatestPublishedStory().then((r) => {
          if (r?.id) setStoryReader({ storyId: r.id });
          else setScriptoriumOpen({});
        });
        return;
      }
    }
  }), [openEditor]);
  const [composerText, setComposerText] = useState("");
  // Live mirror of composerText used by the topic-draft auto-save
  // cleanup. The effect that owns the activeTopicId watcher needs to
  // read the LATEST text inside its cleanup so it can save the
  // half-written reply against the topic that is about to be swapped
  // away from, closure-capturing composerText at effect-create time
  // would freeze the text at "what was typed when activeTopicId
  // became X", losing every keystroke since.
  const composerTextRef = useRef<string>("");
  composerTextRef.current = composerText;
  // Per-room cached thread categories. Populated lazily for nested rooms
  // on join; the Composer's category picker reads from this. Stale
  // entries (after admin edits) refresh on the next room-join cycle.
  const [threadCategoriesByRoom, setThreadCategoriesByRoom] = useState<Record<string, ThreadCategory[]>>({});
  // Forum-mode state. Both reset whenever the active room changes,
  // navigating away from a thread shouldn't leave the composer thinking
  // it's still replying to the previous room's topic.
  //   activeTopicId  , id of the topic the user is currently reading
  //                      (and replying to). null = no topic selected,
  //                      composer is disabled in forum rooms.
  //   topicCreateMode, composer is in "start a new topic" mode (title
  //                      input visible). After successful create, this
  //                      flips back to false and activeTopicId points
  //                      at the new topic.
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [topicCreateMode, setTopicCreateMode] = useState(false);

  // One-time prune of stale forum-reply drafts on app mount. Cheap,
  // walks just the namespaced `forum-draft:*` keys in localStorage
  // and drops anything past the stale ceiling or unparseable. Keeps
  // the per-user storage footprint bounded without needing a
  // background sweeper.
  useEffect(() => {
    pruneStaleForumDrafts();
  }, []);

  // Per-topic reply drafts. Save the in-flight composer text against
  // the active topic id on every change AND eagerly on a topic
  // switch (the cleanup runs before the effect re-fires with the new
  // id, so it captures the text that belonged to the OUTGOING
  // topic). Loading runs once per id flip: when activeTopicId
  // becomes a topic, we read whatever the user had been typing
  // before and seed the composer with it; when it becomes null
  // (room change, /leave-thread, etc.), the composer empties.
  //
  // Partition: keyed by topic id, so switching topic X → Y empties
  // the composer (loading Y's saved text if any), and switching
  // back to X restores X's text. Multi-topic users can keep several
  // half-finished replies in flight without losing any of them.
  //
  // The save runs on EVERY composerText change as well so a
  // browser-tab-crash or a page refresh mid-typing doesn't lose the
  // current text, the cleanup-on-switch handles the partition
  // boundary, the per-change save handles surprise teardown.
  useEffect(() => {
    if (!activeTopicId) {
      setComposerText("");
      return;
    }
    setComposerText(loadForumDraft(activeTopicId));
    const draftTopicId = activeTopicId;
    return () => {
      // Cleanup runs AFTER the next render's composerText has
      // landed in the ref but BEFORE the new activeTopicId's load
      // effect-body runs. So `composerTextRef.current` here is the
      // text the user had typed in the OUTGOING topic.
      saveForumDraft(draftTopicId, composerTextRef.current);
    };
  }, [activeTopicId]);
  // Per-keystroke save (debounced) so a tab close mid-typing
  // doesn't lose the draft, the cleanup-on-switch above only fires
  // when activeTopicId actually changes. Skip when no topic is
  // active (there's nothing to key against).
  useEffect(() => {
    if (!activeTopicId) return;
    const handle = window.setTimeout(() => {
      saveForumDraft(activeTopicId, composerText);
    }, 500);
    return () => { window.clearTimeout(handle); };
  }, [activeTopicId, composerText]);
  // Composer-fill chips (`[room](compose:/go room)` links from /myrooms)
  // dispatch this so a click REPLACES the composer contents with the
  // command, letting the user review or tweak it (e.g. swap the password)
  // before sending. The markdown renderer restricts the payload to a
  // `/go ` command, so nothing destructive can be pre-loaded this way.
  useEffect(() => {
    function onComposeSet(e: Event) {
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      const text = detail?.text;
      if (typeof text === "string" && text) setComposerText(text);
    }
    window.addEventListener("spire:compose-set", onComposeSet);
    return () => window.removeEventListener("spire:compose-set", onComposeSet);
  }, []);
  // "Preferred category for the next + New topic", set when the user
  // clicks a category section header in the forum view. Tristate where
  // `undefined` means "no signal yet" (composer falls back to its own
  // persisted localStorage default), `null` is the Uncategorized
  // bucket, and a string is a specific category id. Resets on room
  // change so a click in room A doesn't leak into room B.
  const [activeForumCategoryId, setActiveForumCategoryId] = useState<string | null | undefined>(undefined);
  // Pop-out modal target. Independent of activeTopicId: clicking the
  // ⤢ icon on a topic card opens the focused-view modal AND also sets
  // activeTopicId (so the underlying list view expands to match), but
  // closing the modal leaves activeTopicId alone, the user stays
  // focused on the same topic in the list. Resets on room change.
  const [poppedTopicId, setPoppedTopicId] = useState<string | null>(null);
  // Rooms drawer on mobile (md breakpoint and below). Always-open on desktop.
  const [railOpen, setRailOpen] = useState(false);
  const [roomsTree, setRoomsTree] = useState<RoomWithOccupants[]>([]);
  const [roomsTreeVersion, setRoomsTreeVersion] = useState(0);
  // Server Rail catalog (Multi-Server Lift). null = not loaded yet; only ever
  // fetched when the servers feature flag is on, so flag-off keeps it null and
  // the rail never renders. Re-fetched on the same tree-version bumps that
  // refresh the room list (joins/leaves move servers between groups).
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  // Per-server owner console (Multi-Server Lift). Holds the id of the server
  // whose settings modal is open, opened from the rail's gear/long-press on a
  // server the viewer manages. Flag-gated through the rail that sets it.
  const [serverSettingsId, setServerSettingsId] = useState<string | null>(null);
  // The server Discover surface (rail "+"). `{ create: true }` lands straight
  // on the create-a-server application form for apply-eligible viewers.
  const [serverDiscoverOpen, setServerDiscoverOpen] = useState<{ create?: boolean } | null>(null);
  // Theme resolution layers. `activeTheme` is derived (not stored) below
  // as `characterTheme || userTheme || branding.defaultTheme`, so changing
  // ANY of the three causes the active theme to refresh, including when
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
  // Load THIS identity's equipped room transition so the room-switch hook can
  // play it. Refetched on identity change; the shop updates the store directly.
  useEffect(() => {
    if (!me) { setMyActiveTransitionKey(null); return; }
    let cancelled = false;
    // Multi-Server Lift: the equipped room transition is per-server (the
    // WRITE via setActiveRoomTransition scopes to the active server), so
    // this read must too — otherwise it always reflects the home server
    // and a transition equipped on a community server never plays.
    const params = new URLSearchParams();
    if (activeCharacterId) params.set("characterId", activeCharacterId);
    if (currentServerId) params.set("serverId", currentServerId);
    const qs = params.toString();
    fetch(`/earning/me/active-room-transition${qs ? `?${qs}` : ""}`, { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<{ key: string | null }>) : null))
      .then((j) => { if (!cancelled && j) setMyActiveTransitionKey(j.key); })
      .catch(() => { /* non-fatal; the switch just stays instant */ });
    return () => { cancelled = true; };
  }, [me?.id, activeCharacterId, currentServerId, setMyActiveTransitionKey]);

  // Multi-Server Lift: re-scope the cached Earning snapshot whenever the
  // user moves to a different server. `refresh()` reads currentServerId
  // itself, but only fires on its own triggers (sign-in, socket events);
  // this drives the refetch on a plain server switch so the wallet / XP /
  // rank shown OUTSIDE the dashboard (composer strip, arcade, profile
  // editor) follows the server the user is actually in. Coalescing keys on
  // the resolved server id, so the sign-in refresh and this one share a
  // single round trip when they resolve to the same server.
  useEffect(() => {
    if (!me) return;
    void useEarning.getState().refresh(currentServerId);
  }, [me?.id, currentServerId]);
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
  // the chat-shell backdrop when the resolved style is "glass", the
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
  /**
   * Server onboarding / self-roles flow (Batch 2 self-roles). Holds the id of
   * the server whose onboarding modal is open, or null. Triggered on server
   * ENTRY (a currentServerId change while the servers flag is on) — the modal
   * self-fetches GET /servers/:id/onboarding and self-resolves (calls onDone)
   * when the flow is off/empty/already completed, so the pre-check here is an
   * optimization, not a correctness requirement. `onboardedServersRef` dedupes
   * so re-entering the same server in one session doesn't re-open it after the
   * member dismissed it.
   */
  const [onboardingServerId, setOnboardingServerId] = useState<string | null>(null);
  const onboardedServersRef = useRef<Set<string>>(new Set());
  /**
   * One-time guided site tour. /me/profile returns `showSiteTour: true`
   * only while the user's stored tour_seen_version is behind the current
   * SITE_TOUR_VERSION; the tour dismiss endpoint bumps it so re-fetches
   * stop asking. Mirrors the one-shot `welcome` gating above, and the
   * tour is deliberately held back until the welcome modal is gone (see
   * the render below) so the two never stack.
   */
  const [showSiteTour, setShowSiteTour] = useState(false);
  // On-demand tour replay. The "Take the tour" menu row (and the Help
  // modal button) flips this store flag so a user who dismissed the
  // first-run tour can re-open it any time, independent of the one-shot
  // showSiteTour above.
  const siteTourForced = useChat((s) => s.siteTourForced);
  const setSiteTourForced = useChat((s) => s.setSiteTourForced);
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
   * renders for crawlers, so the user sees the same name in their
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
   * DB-level default and is the right answer ONCE per session, at the
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
          disableNameStyles?: boolean;
          disableBorderStyles?: boolean;
          disableInlineAvatars?: boolean;
          defaultForumId?: string | null;
          publicProfileBgUrl?: string | null;
          publicProfileBgMode?: "cover" | "contain" | "tile" | "stretch";
          welcome?: { html: string; hash: string } | null;
          showSiteTour?: boolean;
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
            // sibling tab on another device, using it directly is what
            // caused the phone-refresh-picks-up-desktop's-character bug.
            // The cache survives reload (sessionStorage) but is per-tab.
            // Three states from loadTabCharacter:
            //   undefined → no cache; fall back to DB (new tab / first
            //               load / private-mode failure)
            //   null      → explicit OOC sentinel, honor it
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
              // Cache agrees with DB, same seed path as no-cache, but
              // we can trust the name field that came back with the
              // profile fetch instead of waiting on a /characters lookup.
              setActiveCharacterId(u.activeCharacterId);
              setActiveCharacterName(u.activeCharacterName ?? null);
            } else {
              // Cache disagrees with DB (the multi-device case). Apply
              // the cached id immediately; the character-theme effect
              // below will fetch the row and patch in the name once it
              // arrives. Leaving the name null briefly is fine,
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
          // Viewer-side flair opt-outs. StyledName / BorderedAvatar /
          // UserNameTag read these to render the plain fallback for users
          // who turned cosmetics off for performance. Defaults false so
          // flair shows for accounts that haven't touched the toggles.
          useChat.getState().setFlairPrefs({
            disableNameStyles: u.disableNameStyles ?? false,
            disableBorderStyles: u.disableBorderStyles ?? false,
            disableInlineAvatars: u.disableInlineAvatars ?? false,
          });
          // Default forum (the Forums catalog lands here when opened without
          // a deep-link). Synced across devices via /me/profile.
          useChat.getState().setDefaultForumId(u.defaultForumId ?? null);
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
          // First-run tour flag. Server sets it true only while the
          // user's tour_seen_version is behind SITE_TOUR_VERSION; the
          // dismiss endpoint bumps it, so re-fetches stop asking. The
          // render below holds the tour back until the welcome modal
          // (if any) is dismissed so they don't stack.
          setShowSiteTour(u.showSiteTour === true);
          useChat.getState().setToursToShow((u as { toursToShow?: TourId[] }).toursToShow ?? []);
        }
      } catch { /* ignore */ }
    }
    load();
    return () => { cancelled = true; };
  }, [themeVersion]);

  /**
   * Character theme load, keyed on the LOCAL `activeCharacterId` so a
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
          // Same null-coalesce shape as the master styleKey above,
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
  // changes, including when admin pushes a new site default to the
  // branding store via /admin/settings save. Previously this was a
  // one-shot state set inside the load() above, so admin palette
  // changes only landed for the user after a manual reload.
  const activeTheme = useMemo<Theme>(() => {
    // A character is its own identity, distinct theme bucket from
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
  // A forum surface (catalog modal / public landing) may be overriding the
  // root design. When it is, this effect must apply THAT design, not the
  // viewer's — otherwise it clobbers the forum's ornaments on the one commit
  // where it re-runs while the surface is mounted (signing in from a forum).
  const scopedRootDesign = useChat((s) => s.scopedRootDesign);
  useEffect(() => {
    // Apply the palette first so the ornament generator can read the
    // resulting CSS vars. Style resolution priority (highest wins):
    //   1. Character override (characters.style_key), set when active
    //      character has its own pinned design.
    //   2. Master override (users.style_key), user picked a personal
    //      design in their master profile.
    //   3. Theme-pinned design, when the active palette matches a
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
    // falls through to `branding.defaultTheme`, the light Spire
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
    // A mounted forum surface owns the root design while it's up; apply its
    // palette-derived ornaments so this effect re-asserts (never clobbers) it.
    if (scopedRootDesign) {
      applyStyle(scopedRootDesign.theme, scopedRootDesign.styleKey);
    } else {
      applyStyle(activeTheme, resolvedStyle);
    }

    // Glass shell-bg URL, character > master > Spire artwork
    // (light or dark variant by palette luminance). Published as
    // CSS vars on `<html>`; the actual paint happens via a CSS rule
    // on `.keep-bg-overlay` (a fixed full-viewport div INSIDE the
    // chat shell). Painting on the html element directly leaked the
    // image past the chat shell whenever a browser extension /
    // devtools UI shifted the document, the strip above the shell
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
      // dark backdrop pixels into a midtone, the user reports this
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
  }, [activeTheme, activeCharacterId, characterStyleKey, userStyleKey, siteStyleKey, themeDesignMap, me, characterBgUrl, characterBgMode, userBgUrl, userBgMode, scopedRootDesign]);

  // Per-user font/size accessibility. Independent of the palette effect
  // above because font preferences don't layer through character/room
  // overrides, they're user-level and apply once. Re-runs on every
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
      // Surface the heartbeat to the ConnectionOrb so it pulses on each check.
      window.dispatchEvent(new Event("tk:heartbeat"));
    }
    function onVisibility() {
      if (!document.hidden) ping();
    }
    document.addEventListener("mousemove", ping, { passive: true });
    document.addEventListener("keydown", ping);
    document.addEventListener("pointerdown", ping, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    // CRUCIAL: a visible tab is "present" even with zero input. Watching a
    // live scene (reading, spectating) generates no mousemove/keydown, so
    // input-only heartbeats let an actively-watching user idle out and get
    // kicked at the session-timeout boundary while they're right there
    // seeing chat live. So we ALSO ping on an interval whenever the tab is
    // visible (`!document.hidden`). A hidden/backgrounded tab stops
    // pinging and is allowed to idle out as before; switching back fires
    // `visibilitychange` → an immediate re-ping. ping()'s own 30s throttle
    // keeps this from doubling up with input-driven pings.
    const visibleHeartbeat = window.setInterval(() => {
      if (!document.hidden) ping();
    }, HEARTBEAT_MS);
    // Send one immediately on mount so the session is extended as soon as
    // the user lands in chat (matches their "I just logged in" intent).
    ping();
    return () => {
      document.removeEventListener("mousemove", ping);
      document.removeEventListener("keydown", ping);
      document.removeEventListener("pointerdown", ping);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(visibleHeartbeat);
    };
  }, [socket]);

  // Manual resync (ConnectionOrb click): reconnecting the socket restores
  // room state server-side; this also refreshes the rooms rail for the
  // already-connected case so the click visibly re-syncs the userlist.
  useEffect(() => {
    const onResync = () => { setRoomsTreeVersion((v) => v + 1); };
    window.addEventListener("tk:resync", onResync);
    return () => window.removeEventListener("tk:resync", onResync);
  }, []);

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
   * lands. The pendingFriendRequests array is the canonical source,
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
        // Scope the room list to the CURRENT server only when the
        // Multi-Server Lift is on; flag-off the URL is the exact "/rooms"
        // it has always been (byte-identical behavior). The server ignores
        // the param when the feature is disabled, so this is also safe if a
        // stale flag and a fresh room ever briefly disagree.
        const url =
          serversEnabled && currentServerId
            ? `/rooms?serverId=${encodeURIComponent(currentServerId)}`
            : "/rooms";
        const r = await fetch(url, { credentials: "include" });
        if (!r.ok) return;
        const j = (await r.json()) as { rooms: RoomWithOccupants[] };
        if (!cancelled) setRoomsTree(j.rooms);
      } catch { /* ignore */ }
    }
    load();
    const id = window.setInterval(load, 20_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [roomsTreeVersion, currentRoomId, serversEnabled, currentServerId]);

  // Load the Server Rail catalog — ONLY when the feature flag is on, so
  // flag-off makes zero extra requests and the rail stays unmounted. Refreshes
  // on the same tree-version bumps that move servers between owned/joined and
  // discover (a join/leave/visit). Learns the default server id for the shell.
  useEffect(() => {
    if (!serversEnabled) {
      setServers(null);
      setDefaultServerId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await listServers();
        if (cancelled) return;
        setServers(list);
        const sys = list.find((s) => s.isDefault || s.isSystem);
        setDefaultServerId(sys?.id ?? null);
      } catch { /* leave the rail in its loading/last-good state */ }
    })();
    return () => { cancelled = true; };
  }, [serversEnabled, roomsTreeVersion, setDefaultServerId]);

  // Server onboarding / self-roles trigger (Batch 2 self-roles). On ENTERING a
  // community server (currentServerId resolves to a non-home server id we
  // haven't already onboarded this session), open the onboarding modal. The
  // modal itself fetches the flow and self-resolves when onboarding is
  // off/empty/already-completed, so this only decides WHEN to mount it. Skipped
  // on the home/default server and flag-off. Mirrors the one-shot welcome host.
  useEffect(() => {
    if (!serversEnabled || !currentServerId) return;
    if (currentServerId === defaultServerId) return;
    if (onboardedServersRef.current.has(currentServerId)) return;
    onboardedServersRef.current.add(currentServerId);
    setOnboardingServerId(currentServerId);
  }, [serversEnabled, currentServerId, defaultServerId]);

  useEffect(() => {
    // Coalesced rooms-tree refetch. A presence storm (many joins/leaves/
    // char-switches in a burst) used to fire one immediate `/rooms` refetch
    // PER presence event, per client, each rebuilding the whole tree
    // (N+1 over every public room) - which serialized on the synchronous
    // SQLite event loop and spiked p99 for everyone. Funnel every
    // structural refetch through one 400ms trailing debounce so a burst
    // collapses to a single refetch. The 20s interval backstop and the
    // inline occupant write below still keep the rail live in the gap.
    let treeRefetchId: number | null = null;
    const scheduleTreeRefetch = () => {
      if (treeRefetchId != null) window.clearTimeout(treeRefetchId);
      treeRefetchId = window.setTimeout(() => {
        setRoomsTreeVersion((v) => v + 1);
        treeRefetchId = null;
      }, 400);
    };
    // Coalesced inbox-counts refetch. `dm:new` fires per inbound DM, so a
    // DM storm used to fire one `/me/inbox-counts` PER message. The DM
    // bodies themselves still land instantly via `appendDmMessage`; only
    // the ✉ badge-count refetch is funnelled through this 400ms trailing
    // debounce, so a burst collapses to a single counts fetch after it
    // settles. Read the store action fresh inside the timeout so we never
    // fire a stale closure.
    let inboxCountsRefetchId: number | null = null;
    const scheduleInboxCountsRefetch = () => {
      if (inboxCountsRefetchId != null) window.clearTimeout(inboxCountsRefetchId);
      inboxCountsRefetchId = window.setTimeout(() => {
        inboxCountsRefetchId = null;
        void useChat.getState().refreshInboxCounts();
      }, 400);
    };
    // Coalesced friend-state refetch. `friend:request` fires on four
    // distinct causes and can arrive in a burst; each event otherwise
    // triggered a `/me/friend-requests` re-poll + a friends-version bump
    // + a counts fetch. Keep the three atomic inside one scheduled
    // callback (same as today) so the modal never re-fires on a version
    // bump before the store write lands, and collapse a burst to a single
    // re-poll. Capture the identity id at schedule time so the LAST event
    // in the burst wins the scope, matching the current fire-time read of
    // `activeCharacterId`. The user-visible notice toast stays immediate
    // and outside this debounce (below) so distinct sender names are
    // never merged or dropped.
    let friendStateRefetchId: number | null = null;
    const scheduleFriendStateRefetch = (charId: string | null) => {
      if (friendStateRefetchId != null) window.clearTimeout(friendStateRefetchId);
      friendStateRefetchId = window.setTimeout(() => {
        friendStateRefetchId = null;
        fetch(withIdentityQuery("/me/friend-requests", charId), { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (j && Array.isArray(j.requests)) useChat.getState().setPendingFriendRequests(j.requests);
          })
          .catch(() => {});
        useChat.getState().bumpFriendsVersion();
        void useChat.getState().refreshInboxCounts();
      }, 400);
    };
    socket.on("room:state", ({ room, occupants }) => {
      setRoom(room);
      setOccupants(room.id, occupants);
      setCurrentRoom(room.id);
      // The CURRENT server is derived ONLY from the room we're actually in, so
      // it can never drift from a stale rail click. `serverId` rides the room
      // payload once the Multi-Server Lift lands server-side; read it
      // defensively so this compiles before/while that field is being added,
      // and so flag-off (where it's absent) simply leaves currentServerId null.
      setCurrentServerId((room as { serverId?: string | null }).serverId ?? null);
      // Joining/creating a room means the rooms tree is stale.
      setRoomsTreeVersion((v) => v + 1);
    });
    // Pinned-messages set for a room (migration 0316). The server sends this
    // whenever a pin is added / removed; we replace that room's cached set
    // wholesale (empty array clears the strip). Seeding on room open is done
    // via the GET fetch effect below — this keeps it live thereafter.
    socket.on("room:pins", ({ roomId, pins }) => {
      setPinsByRoom((prev) => ({ ...prev, [roomId]: pins }));
    });
    // Theater (watch-party) live playback state + floating reactions.
    // Both just feed the store; the TheaterPanel reads from it and owns
    // all player/animation behavior.
    socket.on("theater:sync", (payload) => {
      setTheaterSync(payload);
    });
    socket.on("theater:reaction", ({ roomId, emoji, side, displayName }) => {
      pushTheaterReaction({ roomId, emoji, side, displayName });
    });
    socket.on("presence:update", ({ roomId, occupants }) => {
      setOccupants(roomId, occupants);
      // Push the fresh occupants straight into the rail's roomsTree
      // state too. RoomsTree reads `room.occupants` from this prop, not
      // from useChat.occupants, so without this direct write the rail
      // would keep showing the stale userlist until the /rooms refetch
      // triggered by the version bump below landed (~200–500ms). That
      // delay was visible whenever someone entered, left, or, most
      // pointedly, went incognito: their chat-side leave broadcast
      // fired instantly, but their userlist row lingered until the
      // refetch caught up. Mirror the server-side sort so the rail's
      // ordering matches what the /rooms response would have brought
      // in, and avoid touching rooms unrelated to this update so any
      // independent edits to other rows survive.
      setRoomsTree((prev) => {
        const idx = prev.findIndex((r) => r.id === roomId);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = {
          ...prev[idx]!,
          occupants: [...occupants].sort((a, b) =>
            a.displayName.localeCompare(b.displayName),
          ),
        };
        return next;
      });
      // Presence changes in our current room mean other rooms might have
      // changed too (e.g. another user just left a room to join ours), so
      // refresh the rooms tree - but as a DEBOUNCED backstop, not the primary
      // update path: the direct occupant write above keeps the rail live, and
      // the debounce stops a presence storm from firing one full-tree refetch
      // per event. It still corrects for anything the direct write couldn't
      // see (a brand-new room the rail doesn't know about yet).
      scheduleTreeRefetch();
      // NOTE: we deliberately do NOT bump themeVersion here. A presence event
      // is triggered by ANY occupant (someone else joining/leaving/going
      // incognito/switching character) and has no bearing on the *local*
      // viewer's theme. Bumping it re-fetched /me/profile + /characters/:id on
      // every presence event, per client - a presence storm turned that into a
      // request flood. Our own theme re-resolves where it actually changes: our
      // own /char switch (me:character-update, below) and profile saves both
      // bump themeVersion already.
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
    // Scriptorium prose chip, `@world:slug` mention in chapter HTML
     // was clicked. The chip dispatches a CustomEvent so the chapter
     // body can stay decoupled from the App-level modal state.
    function onWorldChip(e: Event) {
      const detail = (e as CustomEvent<{ slug: string }>).detail;
      if (!detail?.slug) return;
      // setWorldViewerId accepts either an id or a slug, the viewer
      // resolves it via the worlds route.
      setWorldViewerId(detail.slug);
    }
    window.addEventListener("scriptorium:open-world-by-slug", onWorldChip);

    socket.on("rooms:tree-changed", () => {
      scheduleTreeRefetch();
    });

    /**
     * Scriptorium, a story you follow just published a new chapter.
     * Surfaces as a one-line system message in the user's current room
     * (mirrors the friend-online pattern). Quiet by design: no toast,
     * no sound, the project's no-daily-grind ethos extends to
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
      // Append to the chat backlog regardless of mode, replies and
      // flat-chat messages live here, and the forum reply view reads
      // replies from this buffer.
      appendMessage(msg);

      // Sound effects. Discrete events:
      //   announce → alert.mp3   (admin megaphone)
      //   whisper  → whisper.mp3 (1:1 private contact in-room. Has
      //                           its own dedicated sound now that
      //                           we ship a fourth audio file,
      //                           previously folded into the DM
      //                           ping. Distinct from DM so a
      //                           whisper "they spoke to me here"
      //                           and a DM "they reached out from
      //                           outside" feel different even though
      //                           both are 1:1.)
      //   anything else (except system + our own) → tap.mp3
      // System notices (joins/kicks/topic changes) stay silent, they
      // would dogpile on a busy room. Our own outbound messages stay
      // silent, the user already knows they sent something. Recipient
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
        // shows a false "start of history", at worst the user
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
      // the MessageList renders "start of history"; when true,
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
    // Bulk hard-delete (the `/trash` purge): drop the ids from the live
    // buffer so they vanish for everyone without a tombstone or refetch.
    socket.on("message:bulk-delete", ({ roomId, ids }) => {
      useChat.getState().removeMessages(roomId, ids);
      for (const id of ids) removeForumTopic(roomId, id);
    });
    socket.on("watch:online", ({ username, displayName }) => {
      // Show ONLY the public-facing display name. When the watched
      // user is in-character, `displayName` is the character name,
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
    // A block involving me changed. Make it feel live without a reload:
    // when newly blocked, purge that user's buffered messages (presence
    // repaints itself, the server re-broadcasts it) and close an open
    // profile with them; either way refresh friends/DM lists. On unblock
    // their content flows again naturally on the next room load / fetch.
    socket.on("relationships:changed", ({ withUserId, blocked }) => {
      const st = useChat.getState();
      if (blocked) {
        st.purgeUserMessages(withUserId);
        const cur = st.openProfile;
        if (cur && cur.profile.userId === withUserId) st.setOpenProfile(null);
      }
      st.bumpFriendsVersion();
    });
    socket.on("error:notice", (n) => setNotice(n));
    // Per-channel unread pulse (Batch 2 per-channel-reads). REPLACES the
    // cached unread + mention for one room wholesale (no accumulation);
    // `unread: 0` clears the dot. Mute state is NOT carried here — it comes
    // from the boot /me/room-reads map + the mute PUT response — so a live
    // delta can never clobber the muted glyph. Never triggers a /rooms
    // refetch; RoomsTree reads these store maps directly.
    socket.on("room:unread", ({ roomId, unread, hasMention }) => {
      useChat.getState().setRoomUnread(roomId, unread, hasMention);
    });
    // Per-channel mute toggled on ANOTHER tab of this account (migration 0318).
    // Replaces the cached `muted` flag for one room so every live socket repaints
    // its mute glyph without a poll. Separate from `room:unread` (mute lives
    // outside the unread map), so it can never clobber the count.
    socket.on("room:muted", ({ roomId, muted }) => {
      useChat.getState().setRoomMuted(roomId, muted);
    });
    // A server just became available to this account (creation application
    // approved, or a membership accepted). Refetch the rail so it appears live
    // without a page refresh; ServerRail fades in whatever is genuinely new.
    socket.on("servers:changed", () => {
      void listServers().then(setServers).catch(() => {});
    });
    // Forum inbox pulse: keeps the rail + bell badges live without
    // refetching (replies to your topics, quotes, watched topics).
    socket.on("forum:notifications", ({ unread }) => {
      useChat.getState().setForumNotifUnread(unread);
    });
    // Notification Center (unified inbox): a fresh row + the live badge.
    socket.on("notifications:new", (n) => {
      useChat.getState().prependNotif(n);
    });
    socket.on("notifications:badge", ({ unread, unreadByServer }) => {
      useChat.getState().setNotifBadge(unread, unreadByServer);
    });
    // Reasoned forced logout (account disabled, admin site-kick).
    // Registered BEFORE auth:expired's generic handler matters: the
    // server sends BOTH (this one for the reason, auth:expired for
    // legacy clients), and whichever sets kickReason last wins - so the
    // generic handler below must not clobber a specific reason.
    socket.on("session:kicked", ({ message }) => {
      setKickReason(message);
      disconnectSocket();
      setMe(null);
    });
    socket.on("auth:expired", () => {
      // Server invalidated the session (idle window elapsed, admin disabled
      // the account, or the janitor sweep deleted the row). Hand the client
      // back to the splash with an explanation banner - the cookie is
      // already worthless, so /auth/me would 401 anyway. Skip when a
      // specific reason already landed via session:kicked (the server
      // sends both; the specific one must win the splash banner).
      if (useChat.getState().kickReason) return;
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
        case "world-application-prompt":
          // Paired with an `open-world` hint that just set
          // worldViewerId. Stash the same id so the viewer's
          // openApplicationOnMount prop reads true on its first
          // render and the ApplicationFormModal mounts on top.
          setPendingWorldApplicationId(h.worldId);
          break;
        case "open-scriptorium":
          setScriptoriumOpen(h.tab ? { tab: h.tab } : {});
          break;
        case "open-forums":
          setForumsOpen(h.create ? { create: true } : h.slug ? { key: h.slug } : {});
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
        case "open-info-modal":
          setInfoOpen({ title: h.title, body: h.body });
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
        case "download-export": {
          // /export — fetch the server-built HTML log and save it. We append
          // the viewer's timezone offset (minutes EAST of UTC) so the log's
          // timestamps read in their local time, matching the chat. The
          // transfer is a plain credentialed fetch → Blob → temporary
          // <a download>, so nothing streams over the socket and the cookie
          // session authorizes the request. Errors surface as a toast.
          const tzMin = -new Date().getTimezoneOffset();
          const sep = h.url.includes("?") ? "&" : "?";
          const fullUrl = `${h.url}${sep}tz=${tzMin}`;
          const filename = h.filename;
          void (async () => {
            try {
              const r = await fetch(fullUrl, { credentials: "include" });
              if (!r.ok) {
                setNotice({ code: "EXPORT_FAILED", message: "Couldn't generate the chat export. Try a shorter range." });
                return;
              }
              const blob = await r.blob();
              const objectUrl = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = objectUrl;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
            } catch {
              setNotice({ code: "EXPORT_FAILED", message: "Couldn't generate the chat export. Try a shorter range." });
            }
          })();
          break;
        }
        case "my-rooms": {
          // /myrooms — the caller's archived rooms, rendered as a PRIVATE,
          // client-local chat line (never broadcast: the list can name
          // private rooms). Each room is a click-to-fill `/go` link the
          // composer-set listener below turns into composer text. We inject
          // straight into the current room's buffer; it isn't persisted, so
          // it evaporates on the next resync/room-switch, which is the right
          // lifetime for an ephemeral helper. (Forum/nested rooms filter
          // local non-reply lines, so there the Tools-menu "My Rooms"
          // section is the surface instead.)
          const rid = useChat.getState().currentRoomId;
          if (!rid) break;
          const meId = useChat.getState().me?.id ?? "system";
          const body = h.rooms.length
            ? [
                `Your archived rooms (${h.rooms.length}). Tap one to load its /go command into your message box:`,
                ...h.rooms.map((r) => {
                  const lock = r.type === "private" ? "🔒 " : "";
                  const topic = r.topic ? ` - ${r.topic}` : "";
                  return `${lock}[${r.name}](compose:/go ${r.name})${topic}`;
                }),
              ].join("\n")
            : "You have no archived rooms. A room you own is archived once everyone leaves it; it'll show up here so you can bring it back.";
          useChat.getState().appendMessage({
            id: `local-myrooms-${Date.now()}`,
            roomId: rid,
            userId: meId,
            characterId: null,
            displayName: "system",
            kind: "system",
            body,
            createdAt: Date.now(),
          });
          break;
        }
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
     * /me/profile here, that endpoint serves the user-level DB default
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
     * Incognito state push, fired by the server whenever the user's
     * `/incognito` command flips the mode bit or changes the alias.
     * Updates `me.incognitoMode` / `me.incognitoAlias` in the store
     * synchronously so the menu's "Go Incognito" / "Leave Incognito"
     * label and the "You are in incognito mode" chat banner flip the
     * moment the toggle lands. Without this, those surfaces only
     * resync on the next /auth/me poll (60s), which read as the
     * command silently failing and led mods to re-issue it.
     */
    socket.on("me:incognito-update", ({ incognitoMode: nextMode, incognitoAlias: nextAlias, incognitoCharacterId: nextCharId }: {
      incognitoMode: boolean;
      incognitoAlias: string | null;
      incognitoCharacterId: string | null;
    }) => {
      const cur = useChat.getState().me;
      if (!cur) return;
      if (cur.incognitoMode === nextMode && cur.incognitoAlias === nextAlias && cur.incognitoCharacterId === nextCharId) return;
      setMe({ ...cur, incognitoMode: nextMode, incognitoAlias: nextAlias, incognitoCharacterId: nextCharId });
    });

    /**
     * DM live updates. `dm:new` covers both inbound and outbound
     * (the server fans every send to both participants' sockets),
     * so the local store-update path is uniform regardless of
     * sender. `dm:update` carries edit / soft-delete echoes;
     * `dm:read` advances the OTHER party's seen marker.
     *
     * Conversations the client hasn't seen before are pulled in via
     * a single `/me/dms` refetch, cheaper than threading a partial
     * "new conversation" payload through the socket event, and the
     * conversation list response already carries the metadata
     * (otherDisplayName, avatar, unread, online) the rail needs.
     */
    /**
     * On every (re)connect: pull /me/dms so the conversation list
     * reflects anything that happened while we were disconnected
     * (most importantly, DMs from other users, those arrive as
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
      //
      // If the Messages modal is open and filtered to a DIFFERENT
      // identity than the global voice, scope to THAT filter instead,
      // a reconnect-time refetch against the global voice would
      // full-replace `dmConversations` with the wrong identity's
      // threads and wipe the open thread's conversation row (messages
      // vanish + the thread falls back to its "start the conversation"
      // empty state). `dmInboxFilterCharId` is `undefined` whenever the
      // modal is closed, in which case we fall back to the global voice.
      const dmFilter = useChat.getState().dmInboxFilterCharId;
      const charId = dmFilter !== undefined ? dmFilter : useChat.getState().activeCharacterId;
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
      // Per-identity inbox counts, drives the chat-shell ✉ badge so
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
      // (no-deep-link) path, same socket emits the server already
      // sent on join, just received again.
      socket.emit("me:resync");
    }
    // socket.io-client fires `connect` on the initial handshake and
    // after every successful auto-reconnect, so this single handler
    // covers cold-load AND wake-from-suspend / network-blip cases.
    socket.on("connect", onConnect);
    // If the socket is already connected at the moment this effect
    // mounts (e.g. StrictMode double-mount, hot reload), `connect`
    // won't fire again, run the sync once eagerly.
    if (socket.connected) onConnect();

    socket.on("dm:new", ({ message }) => {
      appendDmMessage(message);
      // Refresh per-identity inbox counts so the chat-shell ✉ badge
      // bumps even when the DM is for an identity that isn't the
      // currently-active one. `dmConversations` is identity-scoped
      // and the refetch below only repopulates it for the viewer's
      // current characterId, a DM pinned to Char B while the viewer
      // is on Char A would otherwise never bump any visible counter
      // and the recipient would have no signal that a message
      // arrived for one of their other identities. Debounced (400ms
      // trailing) so a DM storm collapses to a single counts fetch; the
      // message body already landed immediately via appendDmMessage above.
      scheduleInboxCountsRefetch();
      // Ping on inbound DMs from someone else; silent on our own echo
      // (the server fans every send to the sender's sockets too so
      // multi-tab works). Same posture as the room-message tap sound.
      const meIdForDm = useChat.getState().me?.id ?? null;
      if (message.senderId !== meIdForDm) {
        playPing();
        // Desktop notification when the tab is hidden, matches the
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
              // stack a dozen toasts, the latest replaces prior.
              tag: `tk-dm-${message.senderId}`,
            });
            n.onclick = () => { window.focus(); n.close(); };
          } catch { /* construction failure, non-fatal */ }
        }
      }
      // Pull the conversation list if we don't already know this
      // conversation, otherwise the rail won't surface it. Cheap;
      // /me/dms is bounded by the user's own DM count.
      const known = useChat.getState().dmConversations[message.conversationId];
      if (!known) {
        // Scope to the open messenger's filter when it diverges from
        // the global voice (see onConnect), so surfacing a new thread
        // doesn't clobber the identity the user is currently viewing.
        const dmFilter = useChat.getState().dmInboxFilterCharId;
        const charId = dmFilter !== undefined ? dmFilter : useChat.getState().activeCharacterId;
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
        //   1. We sent it, the server fans our own send back to our
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
          // user's globally-active character, sending the global id
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
    // Emoticon reactions, merge the delta into the cached
    // reactions store. Chat + DM rendering both pull from the same
    // map keyed by (targetKind, targetId), so a single listener
    // covers both surfaces.
    socket.on("reaction:update", (event) => {
      const viewerId = useChat.getState().me?.id ?? null;
      useEmoticons.getState().applyReactionEvent(event, viewerId);
    });
    // Live poll tally / close. Merge the delta into the matching poll
    // message wherever it's cached (chat buffer or forum topic bucket).
    socket.on("poll:update", (update) => {
      useChat.getState().applyPollUpdate(update);
    });
    // Admin replaced / added / deleted an emoticon sheet, refetch
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
      //
      // The re-poll + friends-version bump + counts refresh are
      // burst-prone (a friend-event storm fires this handler once per
      // event), so they're funnelled through a single 400ms trailing
      // debounce. All three stay ATOMIC inside the one scheduled
      // callback so the modal's refreshLists (keyed on friendsVersion)
      // never fires before the /me/friend-requests store write lands.
      // `activeCharacterId` is read at schedule time so the LAST event
      // in the burst wins the identity scope, matching the prior
      // fire-time read.
      scheduleFriendStateRefetch(useChat.getState().activeCharacterId);
      // Soft notice in the banner so the user gets a glance signal
      // even when the chat prompt is offscreen (e.g. they're deep in
      // the forum view). Phrasing keeps it neutral, the actual
      // accept/decline UI lives in the prompt cards.
      setNotice({
        code: "FRIEND_UPDATE",
        message: `Friend update from ${payload.frienderDisplayName}.`,
      });
    });
    // Admin edited a custom command. Bump the shared version so the
    // Composer's autocomplete cache and the HelpModal both refetch
    // `/commands` on their next render, they key their fetch effect
    // on this value. Cheap to fan out (rare event, single fetch per
    // receiver).
    socket.on("commands:updated", () => {
      useChat.getState().bumpCommandsVersion();
    });
    // Earning, wallet/rank live updates. The store's apply* actions
    // are no-ops when the snapshot hasn't loaded yet, so a credit that
    // lands before the user opens the dashboard just gets reconciled
    // by the next /earning/me fetch.
    socket.on("earning:earned", (payload) => {
      useEarning.getState().applyEarned(payload);
    });
    socket.on("earning:rankup", (payload) => {
      useEarning.getState().applyRankUp(payload);
    });
    // Inventory delta, sender / receiver of /give /throw /drop +
    // shop purchases + admin grants. Payload is informational only;
    // we just re-fetch /earning/me so the dashboard's Items tab
    // (inventory list + shop "you own X/Y" line) reflects the new
    // authoritative state. Cheap when the dashboard isn't open,
    // the store keeps a single snapshot regardless.
    socket.on("earning:inventory_changed", () => {
      void useEarning.getState().refresh();
    });
    // Chat-line side effect, currently only `kind: "struck"` fires
    // (target of /throw /drop). The runner branches on kind, so
    // adding a new effect kind is one line here + the runner. We
    // never trigger the effect for the SENDER's own client, the
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
      socket.off("room:pins");
      socket.off("presence:update");
      socket.off("theater:sync");
      socket.off("theater:reaction");
      socket.off("chat:typing:update");
      socket.off("rooms:tree-changed");
      if (treeRefetchId != null) window.clearTimeout(treeRefetchId);
      // Cancel (don't flush) pending debounced refetches so a trailing
      // fetch can't fire against a torn-down listener set on unmount /
      // socket swap. Correctness is backstopped by onConnect, which
      // re-pulls /me/dms + /me/friend-requests + refreshInboxCounts on
      // the next (re)connect, so counts self-heal.
      if (inboxCountsRefetchId != null) window.clearTimeout(inboxCountsRefetchId);
      if (friendStateRefetchId != null) window.clearTimeout(friendStateRefetchId);
      socket.off("message:new");
      socket.off("message:bulk");
      socket.off("message:update");
      socket.off("message:bulk-delete");
      socket.off("watch:online");
      socket.off("error:notice");
      socket.off("room:unread");
      socket.off("room:muted");
      socket.off("servers:changed");
      socket.off("auth:expired");
      socket.off("ui:hint");
      socket.off("mutual:settled");
      socket.off("me:character-update");
      socket.off("me:incognito-update");
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
      // for activeCharacterId is the source of truth, sending it on
      // every chat:input closes the cross-tab race where the server's
      // socket-scoped tabCharId can drift from the UI (reconnect
      // re-seed from DB, sibling tab's /char clear updating the
      // shared user row, etc.). The server validates the claim
      // against owned characters before honoring it.
      asCharacterId: activeCharacterId,
    }, (res) => {
      // Surface a rejected send as a toast. Previously the server's ack (e.g.
      // EMAIL_UNVERIFIED in block mode) was dropped on the floor, so the
      // message just silently vanished with no hint why. The server only acks
      // on rejection, so a successful send never reaches here.
      if (res && res.ok === false) setNotice({ code: res.code, message: res.message });
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
  // topic, defeating the whole point of opening the create form.
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
      .catch(() => { /* non-fatal, picker just stays empty */ });
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
   * Skipped per-category when that bucket already has a topics array,
   * lets a user navigate away and back into the same room without
   * re-fetching everything (they'll just keep what's loaded).
   */
  // Narrow the dep on rooms to JUST the reply-mode of the current
  // room. Putting the whole `rooms` record in the deps caused the
  // forum-topics fetch to be cancelled on every `room:state` event
  // (presence change, /char, etc.), `rooms` is a new object
  // reference per zustand `set()`, so any unrelated room mutation
  // would tear down the in-flight topics fetch via the effect
  // cleanup, leaving every bucket stuck in "Loading topics…".
  const currentReplyMode = rooms[currentRoomId ?? ""]?.replyMode ?? null;
  // Same posture for threadCategoriesByRoom, only the current room's
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
    // would silently bail after resolving, leaving every bucket
    // stuck in `loading: true` with no topics. Reading from getState
    // here gives us a fresh snapshot per effect fire without re-firing
    // on every store mutation.
    const buckets = useChat.getState().forumTopicsByRoom[currentRoomId] ?? {};
    // Wire-shape of GET /rooms/:id/topics, the server returns the
    // new offset-pagination fields alongside the legacy
    // {topics, hasMore} pair so older clients mid-deploy still work.
    type ForumTopicsPageResponseInline = {
      topics: ChatMessage[];
      hasMore: boolean;
      page: number | null;
      perPage: number;
      totalPages: number;
      totalCount: number;
    };
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
      // First-page fetch, `page=1` triggers the offset-paginated
      // branch on the server. No `perPage` override; the server
      // uses the admin-set `forumTopicsPerPage`.
      const url = `/rooms/${encodeURIComponent(currentRoomId)}/topics?category=${encodeURIComponent(categoryParam)}&page=1`;
      fetch(url, { credentials: "include" })
        .then((res) => (res.ok ? (res.json() as Promise<ForumTopicsPageResponseInline>) : null))
        .then((j) => {
          if (cancelled || !j) return;
          setForumTopicsPage(currentRoomId, key, j.topics, {
            currentPage: j.page ?? 1,
            totalPages: j.totalPages || 1,
            totalCount: j.totalCount || 0,
            perPage: j.perPage || 20,
          });
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
   * Navigate a category's forum bucket to the given page number.
   * Replaces the bucket's topics + pagination metadata in one shot.
   * No-op when the target page is already showing OR out of range.
   * Used by the per-category pagination strip (Prev / 1 2 … N /
   * Next), replaces the old "Load older" cursor flow entirely.
   */
  async function goToForumPage(categoryKey: string, targetPage: number): Promise<void> {
    if (!currentRoomId) return;
    const bucket = forumTopicsByRoom[currentRoomId]?.[categoryKey];
    if (!bucket || bucket.loading) return;
    if (targetPage < 1 || targetPage > bucket.totalPages) return;
    if (targetPage === bucket.currentPage) return;
    setForumTopicsLoading(currentRoomId, categoryKey, true);
    try {
      const categoryParam = categoryKey === "_uncat" ? "" : categoryKey;
      const url = `/rooms/${encodeURIComponent(currentRoomId)}/topics?category=${encodeURIComponent(categoryParam)}&page=${targetPage}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as {
        topics: ChatMessage[];
        page: number | null;
        perPage: number;
        totalPages: number;
        totalCount: number;
      };
      setForumTopicsPage(currentRoomId, categoryKey, j.topics, {
        currentPage: j.page ?? targetPage,
        totalPages: j.totalPages || 1,
        totalCount: j.totalCount || 0,
        perPage: j.perPage || 20,
      });
    } catch (err) {
      setForumTopicsLoading(currentRoomId, categoryKey, false);
      setNotice({ code: "FORUM_PAGE_FAILED", message: err instanceof Error ? err.message : "Couldn't load that page." });
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
   * me, including OTHER characters of mine that aren't active in
   * this tab, which produced a real bug: clicking the icon of
   * Character B while voicing Character A in this tab opened the
   * profile editor bound to A's session, so saves leaked Character
   * B's intended edits onto Character A.
   *
   * The correct test is "same userId AND same display name as the
   * SESSION's active identity," because each tab voices at most one
   * identity at a time and its display name is unique within the
   * session (per-character name uniqueness per owner + the OOC
   * username slot are mutually exclusive in the userlist, you only
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
   * `characterId` is the identity row the click landed on, a
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
   * the target to the right per-identity thread, null routes to the
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
    // Per-channel read marker (Batch 2 per-channel-reads): opening a room
    // clears its unread. Do it OPTIMISTICALLY here — zero the store maps
    // immediately for instant feedback, then POST the watermark. The server
    // ALSO marks the room read on join (joinRoomBody → markRoomRead) and
    // re-emits `room:unread {unread:0}` to every tab, so this POST is a
    // fast-path confirm, not the source of truth. Fire-and-forget; a failure
    // just leaves the server-side join-mark to settle it. Never triggers a
    // /rooms refetch.
    useChat.getState().setRoomUnread(roomId, 0, false);
    void fetch(`/me/rooms/${encodeURIComponent(roomId)}/read`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => { /* server-side join-mark backstops this */ });
    // Mobile: close the rooms/userlist drawer BEFORE the transition snapshots
    // the chat. The drawer is a fixed child of the wrapper we clone, so if it's
    // still open at snapshot time the clone freezes the open drawer over the
    // whole animation (it only "closed" once the overlay was torn down). A
    // plain setRailOpen(false) re-renders too late — the synchronous
    // playRoomTransition clone runs first. flushSync forces the drawer out of
    // the DOM now so the snapshot is clean. No-op on desktop (rail isn't a
    // drawer there) and when already closed; closing a fixed overlay doesn't
    // reflow the row, so the captured rect is unchanged.
    if (railOpen) flushSync(() => setRailOpen(false));
    const doJoin = () => {
      socket.emit("room:join", { roomId }, (res) => {
        if (!res.ok) setNotice({ code: res.code, message: res.message });
      });
    };
    // Play the equipped room transition (self-only). Gated by the
    // `use_room_transitions` permission; null key / unequipped falls through to
    // an instant switch inside playRoomTransition.
    const permitted = !!me?.permissions?.includes("use_room_transitions");
    const equipped = permitted ? myActiveTransitionKey : null;
    // Reduce Motion: give a gentle baseline fade on room switch (calmer than an
    // instant snap) — unless the viewer has a transition equipped, in which case
    // theirs plays. `force` lets it run even under the OS reduced-motion media
    // query, which would otherwise skip straight to an instant swap.
    const reduceMotion = reduceMotionEnabled();
    const key = reduceMotion ? (equipped ?? "fade") : equipped;
    void playRoomTransition(key, {
      wrapperEl: chatWrapperRef.current,
      swap: doJoin,
      force: reduceMotion,
      // The new room has rendered once the store's currentRoomId catches up.
      isReady: () => useChat.getState().currentRoomId === roomId,
    });
  }

  // Server Rail icon click (Multi-Server Lift). Already on this server ⇒ no-op.
  // Otherwise resolve the server's landing room via /visit (which also clears
  // its unseen dot) and join it through the SAME room-join path a RoomsTree
  // click uses, so bans/passwords/transitions all behave identically.
  // currentServerId then updates from the resulting room:state, never here, so
  // it can't drift. Only ever invoked while the feature flag is on.
  async function enterServerById(id: string, name: string) {
    if (id === currentServerId) return;
    try {
      const { landingRoomId } = await visitServer(id);
      // Reflect the cleared unseen dot immediately; the next catalog refetch
      // confirms it.
      setServers((prev) =>
        prev ? prev.map((s) => (s.id === id ? { ...s, hasUnseen: false } : s)) : prev,
      );
      if (landingRoomId) {
        onRoomClick(landingRoomId);
      } else {
        setNotice({ code: "NO_LANDING", message: `${name} has no room to enter yet.` });
      }
    } catch (e) {
      setNotice({ code: "SERVER_VISIT_FAILED", message: e instanceof Error ? e.message : "Couldn't open that server." });
    }
  }
  async function onServerSelect(server: ServerSummary) {
    await enterServerById(server.id, server.name);
  }

  // Top-bar rebrand + "back home" link (Multi-Server Lift). While the viewer is
  // inside a NON-home server, the Banner shows that server's name/icon/banner
  // and offers a link back to the home server. Null on the home server or
  // flag-off, so the shell is byte-identical to today.
  const currentServer = useMemo(
    () => (serversEnabled && currentServerId ? servers?.find((s) => s.id === currentServerId) ?? null : null),
    [serversEnabled, currentServerId, servers],
  );
  // Light the server-rail "unseen" dot from the Notification Center: a server
  // with unread notifications shows the dot even if its own activity feed is
  // quiet. ORs the per-server unread into each summary's hasUnseen.
  const notifUnreadByServer = useChat((s) => s.notifUnreadByServer);
  const serversForRail = useMemo(
    () => servers?.map((s) => ((notifUnreadByServer[s.id] ?? 0) > 0 && !s.hasUnseen ? { ...s, hasUnseen: true } : s)) ?? null,
    [servers, notifUnreadByServer],
  );

  // Resolve a notification target into an in-app navigation. Shared by the bell
  // (clicking a row), the service-worker push click (postMessage from sw.js),
  // and the boot-time `?n=<kind>:<id>` marker (a push opened a fresh tab).
  const openNotifTarget = useCallback((kind: string, id: string | null, serverId?: string | null) => {
    if (kind === "server") {
      const sid = id ?? serverId ?? null;
      const srv = servers?.find((s) => s.id === sid);
      if (srv) void onServerSelect(srv);
    } else if (kind === "event" && id) {
      // Community-event reminder (bell row, web-push tap, or boot `?n=event:<id>`
      // marker). Switch to the event's owning server first (the events panel only
      // holds the CURRENT server's events), then ask ServerEventsPanel to open on
      // it. The panel reloads on open, so dispatching AFTER the switch settles
      // lands the focus once the new server's list is in flight. When the server
      // is already active (or the marker carries no serverId), dispatch straight
      // away. The `?n=event:<id>:<serverId>` marker now carries the owning server,
      // so a push-opened fresh tab switches to it before focusing the event.
      const detail: OpenServerEventDetail = { eventId: id, serverId: serverId ?? null };
      const emit = () => window.dispatchEvent(new CustomEvent<OpenServerEventDetail>(OPEN_SERVER_EVENT, { detail }));
      const srv = serverId ? servers?.find((s) => s.id === serverId) : undefined;
      if (srv && serverId !== currentServerId) void onServerSelect(srv).then(emit);
      else emit();
    } else if (kind === "dm") {
      setMessagesOpen(true);
    } else if (kind === "earning") {
      setEarningOpen({});
    } else if (kind === "forum" || kind === "topic" || kind === "message") {
      setForumsOpen({});
    }
  }, [servers, onServerSelect, currentServerId]);

  // Parse the server-encoded "/?n=<kind>:<id>" deep-link marker. The event kind
  // appends the owning server ("event:<id>:<serverId>") so a push-opened tab can
  // switch to it; that third segment is split off into `serverId`.
  const parseNotifMarker = (rawUrl: string): { kind: string; id: string; serverId?: string } | null => {
    try {
      const n = new URL(rawUrl, window.location.origin).searchParams.get("n");
      if (!n) return null;
      const idx = n.indexOf(":");
      if (idx < 0) return { kind: n, id: "" };
      const kind = n.slice(0, idx);
      const rest = n.slice(idx + 1);
      if (kind === "event") {
        const sep = rest.indexOf(":");
        if (sep >= 0) return { kind, id: rest.slice(0, sep), serverId: rest.slice(sep + 1) };
      }
      return { kind, id: rest };
    } catch { return null; }
  };

  // Service-worker push click: a focused tab gets a message telling it where to
  // deep-link (a SPA can't navigate from the URL change alone).
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | undefined;
      if (d?.type !== "tk-notification-click" || typeof d.url !== "string") return;
      const t = parseNotifMarker(d.url);
      if (t) openNotifTarget(t.kind, t.id || null, t.serverId ?? null);
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [openNotifTarget]);

  // Boot: if a push opened a fresh tab at "/?n=...", deep-link once signed in,
  // then strip the marker so a refresh doesn't replay it.
  useEffect(() => {
    if (!me) return;
    const t = parseNotifMarker(window.location.href);
    if (!t) return;
    openNotifTarget(t.kind, t.id || null, t.serverId ?? null);
    const url = new URL(window.location.href);
    url.searchParams.delete("n");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [me, openNotifTarget]);

  // "?googleLinked=1": the Google account-link flow (started from Edit
  // Profile → Privacy → Connected accounts) redirects back to the app root
  // with this marker once the link succeeds. Surface a brief confirmation
  // via the shared Toast, then strip the param so a refresh doesn't replay it.
  useEffect(() => {
    if (!me) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("googleLinked") !== "1") return;
    setNotice({ code: "GOOGLE_LINKED", message: "Google account linked." });
    url.searchParams.delete("googleLinked");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [me, setNotice]);

  // "?googleError=<code>": the Google callback bounces failures (bad/expired
  // state, token-exchange failure, already-linked collision, disabled account)
  // back to the app root with a reason. Surface a friendly message and strip the
  // param so a refresh doesn't replay it. Fires regardless of auth state (a
  // login-flow failure happens while logged out), mirroring googleLinked above.
  useEffect(() => {
    const url = new URL(window.location.href);
    const gErr = url.searchParams.get("googleError");
    if (!gErr) return;
    const message =
      gErr === "already_linked"
        ? "That Google account is already connected to a different account."
        : gErr === "disabled"
          ? "That account is disabled. Please contact an admin."
          : "Google sign-in didn't complete. Please try again.";
    setNotice({ code: "GOOGLE_ERROR", message });
    url.searchParams.delete("googleError");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [setNotice]);
  // The current server's identity drives the top bar (banner + wordmark + name)
  // for EVERY server, including the home server — so an owner's uploaded banner
  // shows wherever they are. Banner falls back to the global site branding for
  // any field the server leaves unset. Null only when flag-off / no server.
  const serverBrand = useMemo(
    () =>
      currentServer
        ? {
            name: currentServer.name,
            logoUrl: currentServer.logoUrl ?? null,
            horizontalLogoUrl: currentServer.horizontalLogoUrl ?? null,
            bannerImageUrl: currentServer.bannerImageUrl ?? null,
            bannerCoverCss: currentServer.bannerCoverCss ?? null,
            bannerFocusY: currentServer.bannerFocusY ?? null,
            bannerCrop: currentServer.bannerCrop ?? null,
            bannerHeight: currentServer.bannerHeight ?? null,
          }
        : null,
    [currentServer],
  );
  // The viewer can manage the server they're currently in (owner/admin/mod) →
  // surface the prominent "Server Admin" nav link that opens its console.
  const canManageCurrentServer = !!currentServer
    && (currentServer.viewerRole === "owner"
      || currentServer.viewerRole === "admin"
      || currentServer.viewerRole === "mod");

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
  //    route, fetch the topic the hit belongs to (the hit itself if
  //    it's a topic, or its parent if it's a reply) plus the full
  //    reply chain, merge them into the local stores, and open
  //    `ThreadModal` centered on the topic with `highlightMessageId`
  //    set so the modal scrolls to and flashes the specific hit.
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [viewingHistory, setViewingHistory] = useState<boolean>(false);
  // Pinned messages per room (migration 0316). Seeded from GET /rooms/:id/pins
  // on room open and kept live by the `room:pins` socket broadcast (which
  // replaces a room's set wholesale). Local App state — pins are room-scoped
  // UI, not global store data.
  const [pinsByRoom, setPinsByRoom] = useState<Record<string, PinnedMessage[]>>({});
  async function jumpToMessage(roomId: string, messageId: string) {
    setRailOpen(false);
    // Forum boards live ENTIRELY in the Forums Catalog (Phase 1C): a
    // bookmark or search hit pointing into one opens the catalog at that
    // topic instead of attempting a room jump (which boards now refuse).
    // The thread route resolves the owning TOPIC from any message id, so
    // bookmarked replies land on their thread too.
    const boardForumId = useChat.getState().rooms[roomId]?.forumId;
    if (boardForumId) {
      try {
        const r = await fetch(
          `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/thread`,
          { credentials: "include" },
        );
        if (!r.ok) throw new Error("gone");
        const j = (await r.json()) as { topic: ChatMessage };
        setBookmarksOpen(false);
        // postId flashes the exact bookmarked/search-hit post.
        setForumsOpen({ key: boardForumId, topic: { boardId: roomId, topicId: j.topic.id, postId: messageId } });
      } catch {
        setNotice({ code: "JUMP_FAILED", message: "Couldn't open that topic, it may have been removed." });
      }
      return;
    }
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

    // Re-read the room's replyMode AFTER the join completes, the
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
          setNotice({ code: "JUMP_FAILED", message: "Couldn't open that thread, it may have been removed." });
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

        // Merge the replies into `messagesByRoom` so the modal, which
        // reads replies from the chat buffer, sees them. We use
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
          setNotice({ code: "JUMP_FAILED", message: "Couldn't load that message, it may have been removed." });
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

  // "Return to live", refresh the buffer with the recent backlog and
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
  // Per-room banner dismissals. Keyed by (roomId, kind) in
  // localStorage; the stored value is the world id or topic text the
  // user dismissed, so the banner reappears automatically when the
  // admin changes either one (a fresh value won't match the stored
  // dismissal). World banners are dismissed per world rather than
  // per room so the same affiliation across linked rooms stays
  // dismissed once.
  const linkedWorldId = room?.linkedWorld?.id ?? null;
  const [worldBannerDismissed, dismissWorldBanner] = useRoomBannerDismissal(
    currentRoomId,
    "world",
    linkedWorldId,
  );
  // (The room topic is no longer a dismissible banner — it lives in the
  // always-on RoomInfoBar now, so its dismissal state was removed.)
  // Resolve activeTopicId → the actual topic message so the composer can
  // render the "Replying to" indicator. We look it up by id in the room's
  // buffer; null when the id isn't present (paged out, deleted, or no
  // active topic). Falls back gracefully if the message isn't loaded.
  const isForumRoom = room?.replyMode === "nested";
  // Viewer-side moderator gate. Used to expose Lock/Unlock + cross-
  // author Delete in the forum UI. The server is authoritative on
  // every action, this only controls UI affordance visibility. Gates
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
  // Pin CHAT messages (migration 0316): the sitewide `pin_message` grant OR
  // the room owner/mod (per-room role from the viewer's own occupant row).
  // Server re-checks the same tiered gate on POST/DELETE /messages/:id/pin.
  const canPinMessage = !!me && (
    me.permissions.includes("pin_message")
    || me.permissions.includes("edit_any_room_metadata")
    || occ.some((o) => o.userId === me.id && (o.role === "owner" || o.role === "mod"))
  );
  // Seed the pinned-messages strip on room open (migration 0316). The live
  // `room:pins` socket broadcast keeps it current after this; the GET just
  // primes the initial set (the join broadcast may fire before Chat's socket
  // listeners attach, and standalone deep-link shells skip it entirely). Flat
  // rooms only — forum boards render their own chrome, not the RoomInfoBar.
  useEffect(() => {
    if (!currentRoomId || isForumRoom) return;
    let cancelled = false;
    fetch(`/rooms/${encodeURIComponent(currentRoomId)}/pins`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j || !Array.isArray(j.pins)) return;
        setPinsByRoom((prev) => ({ ...prev, [currentRoomId]: j.pins as PinnedMessage[] }));
      })
      .catch(() => { /* strip stays empty; a socket delta will fill it */ });
    return () => { cancelled = true; };
  }, [currentRoomId, isForumRoom]);
  // Set of source message ids currently pinned in this room, so MessageList's
  // row action renders Pin vs Unpin. Rebuilt only when this room's pin set
  // changes. Null messageIds (source hard-deleted) are dropped — there's no
  // live row to toggle.
  const pinnedMessageIdsForRoom = useMemo(() => {
    const set = new Set<string>();
    const rp = currentRoomId ? pinsByRoom[currentRoomId] : undefined;
    if (rp) for (const p of rp) if (p.messageId) set.add(p.messageId);
    return set;
  }, [currentRoomId, pinsByRoom]);
  // Theater playback-control gate. Mirrors the server's `callerCanEditRoom`
  // (room owner / mod, or the site-wide grant): only these drive shared
  // play/pause/seek. Everyone else's player follows. Derived from the
  // viewer's own occupant row (per-room role) plus the granular grant.
  const canControlTheater =
    !!me &&
    (me.permissions.includes("edit_any_room_metadata") ||
      occ.some((o) => o.userId === me.id && (o.role === "owner" || o.role === "mod")));
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
    // Lookup precedence: the room's live message buffer first (covers
    // a topic whose body the viewer is actively scrolling), then the
    // forum buckets for this room (covers Reply clicked from a topic
    // card that's loaded into the category list but whose body isn't
    // in the message buffer, the common case on a fresh forum-room
    // visit). Without the bucket fallback the composer stayed in
    // "pick a topic" disabled state even after Reply set
    // activeTopicId, because `messages` is only the chat backlog,
    // not the topic catalog.
    let m = messages.find((x) => x.id === activeTopicId);
    if (!m && currentRoomId) {
      const roomBuckets = forumTopicsByRoom[currentRoomId];
      if (roomBuckets) {
        for (const bucket of Object.values(roomBuckets)) {
          m = bucket.topics.find((x) => x.id === activeTopicId)
            ?? bucket.pending.find((x) => x.id === activeTopicId);
          if (m) break;
        }
      }
    }
    if (!m) return null;
    return { id: m.id, title: m.title ?? null, body: m.body, locked: !!m.lockedAt };
  }, [activeTopicId, messages, currentRoomId, forumTopicsByRoom]);
  // Pop-out modal data. We look up the topic message itself + the
  // replies that target it (id-matched). Replies stay in their
  // original chronological order, same as the inline forum view.
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
    // inspect the palette imperatively at render time, currently the
    // message renderers that nudge a player's chosen text color toward a
    // legible variant against the current background. The CSS-var path
    // (set by applyTheme above) still drives all standard styling; this
    // is just for components that must branch on the bg color in JS.
    <ActiveThemeContext.Provider value={activeTheme}>
    {/* Single high-level Suspense boundary for the whole authenticated
        shell (B1, plan.md §3). Every React.lazy modal/surface declared at
        the top of this file (AdminPanel, EarningDashboard, the arcade
        windows, world/story editors, ProfileEditor, ThreadModal, HelpModal,
        MessagesModal, NotificationCenter, ServerSettingsView,
        ServerDiscoverModal, ForumsCatalogModal, WorldsListModal, ...)
        renders somewhere inside this subtree, so each one suspends into
        THIS ancestor while its chunk loads and can never render un-bounded.
        The fallback is null: these are on-demand modals/panels, so there's
        nothing to show until the user opens one, and the surrounding chat
        shell is already painted. This boundary is only reached when the
        user is authenticated (<Chat> is rendered solely from the `me`
        branch), so the anonymous splash/login/boot path never hits it. */}
    <Suspense fallback={null}>
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
    <div className="fixed inset-0 flex h-dvh flex-col overflow-hidden lg:flex-row">
      {/* Theme-style ambient overlay. The active StyleGenerator (medieval-
          parchment in Phase 1) emits an SVG gradient stack as a CSS var
          on <html>; this div renders it as a fixed full-viewport background
          behind every other element. When no style is active the CSS var
          falls back to `none` and this div is invisible. */}
      <div aria-hidden className="keep-bg-overlay" />
      {/* LEFT column on desktop (lg:flex-row parent): banner + account gates +
          chat. flex-1 so the full-height RoomsTree + ServerRail sit to its right
          and reach the TOP of the viewport, instead of being pushed below a
          full-width banner. On mobile (flex-col parent) the rails are a fixed
          drawer / hidden, so this is the only in-flow child and fills the screen
          exactly as before. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Banner
        navLinksVersion={navLinksVersion}
        onOpenRules={() => setRulesOpen(true)}
        onOpenEarning={() => setEarningOpen({})}
        onOpenScriptorium={() => setScriptoriumOpen({})}
        onOpenWorlds={() => setWorldCatalogOpen(true)}
        onOpenArcade={() => setArcadeOpen(true)}
        onOpenStaff={() => setStaffOpen(true)}
        onOpenAffiliates={() => setAffiliatesOpen("list")}
        serverBrand={serverBrand}
        notificationBell={
          // Community events (calendar) + the notification bell sit side by
          // side in the Banner header as first-class siblings. The events
          // entry is self-gated (renders nothing unless servers are on and the
          // viewer is inside one), so flag-off the header is unchanged.
          <>
          <ServerEventsPanel />
          <NotificationCenter
            onOpen={(n) => {
              const md = n.metadata ?? {};
              if (n.targetKind === "room" && n.targetId) {
                // Chat mention → jump to and flash the exact message. jumpToMessage
                // switches into the right server + room via room:join first, then
                // scrolls, mirroring the quoted-post jump. Empty messageId (e.g. a
                // web-push deep-link with no metadata) just enters the room.
                const mid = typeof md.messageId === "string" ? md.messageId : "";
                void jumpToMessage(n.targetId, mid);
              } else if (n.targetKind === "dm") {
                // DM → open the messenger straight to the sender's thread (their
                // identity), scoped to the identity that received it — not the
                // default inbox/friends list.
                const oc = typeof md.otherCharacterId === "string" ? md.otherCharacterId : null;
                useChat.getState().setDmInboxFilterCharId(n.characterId ?? null);
                if (n.actorUserId) setOpenDmOtherUser(n.actorUserId, oc);
                setMessagesOpen(true);
              } else {
                openNotifTarget(n.targetKind, n.targetId, n.serverId);
              }
            }}
            onOpenForums={() => setForumsOpen({})}
          />
          </>
        }
        {...(canManageCurrentServer && currentServer ? { onOpenServerAdmin: () => setServerSettingsId(currentServer.id) } : {})}
        {...(hasAnyAdminAccess ? { onOpenAdmin: () => setAdminOpen(true) } : {})}
      />
      <StaleVersionBanner />
      <IncognitoBanner />
      <VerifyEmailGate />
      {/* Per-room view wrapper. Bundles the room's own banners (world /
          topic / expiry), the header accent rail, and the chat+rooms row
          into ONE stable flex-col. The room-transition orchestrator snapshots
          and overlays THIS element, so the overlay must span the same box
          regardless of which per-room banners are present. Before this
          wrapper existed the transition targeted only the chat+rooms row, so
          switching to a room WITHOUT a topic dropped the topic banner above
          the row, reflowed the row upward, and left an uncovered strip at the
          top of the animation (the overlay was still pinned to the old, lower
          rect). Keeping the per-room banners inside the wrapper means that
          reflow happens within the covered area — and the banners animate
          along with the room instead of popping outside the effect. The
          account-level banners (rank-up ribbon, version, marquee) stay OUTSIDE
          so they don't get swept into a room switch. */}
      {/* Chat + room-list row. Sits directly under the header/account gates so
          the room-list rail extends all the way up to the header bar. The chat
          COLUMN (<main>) is the room-transition snapshot target; the rail is a
          sibling, so it isn't swept into a room switch. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* `min-w-0` is non-negotiable: by default a flex child's
            `min-width` is `auto` (= its intrinsic content width), so a
            wide descendant, a long topic title, an action button strip,
            anything with non-wrapping content, forces <main> to grow
            beyond the viewport. The parent's `overflow-hidden` then
            clips the right edge visually, which is what produced the
            "everything pushed off-screen" bug in mobile forum view.
            `min-w-0` lets the flex child shrink to its allocated slot
            and forces descendants to honor their own truncation rules. */}
        <main ref={chatWrapperRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* Site announcements + earning ribbon live INSIDE the chat column
              (not full-width above the row) so they don't push the room-list
              rail down off the header. Their content is site/account level —
              identical across rooms — so sitting inside the transition target
              is harmless. */}
          <BannerMarquee
            appName={branding.siteName}
            // Only offer the server source when the viewer is inside a REAL
            // community server (not the home/default/system server), so the
            // marquee toggle has a genuine second stream to switch to. Null
            // everywhere else keeps the bar app-only.
            serverName={
              currentServer && !currentServer.isDefault && !currentServer.isSystem
                ? currentServer.name
                : null
            }
          />
          <EarningRibbon onOpenEarning={() => setEarningOpen({})} />
          {room?.linkedWorld && !worldBannerDismissed ? (
            <div className="keep-notice keep-notice-accent relative flex w-full items-center justify-center pr-10">
              <button
                type="button"
                onClick={() => setWorldViewerId(room.linkedWorld!.id)}
                className="flex flex-1 items-center justify-center gap-2 px-4 py-1 text-xs text-keep-action hover:brightness-110"
                title="Open this room's linked world"
              >
                <span className="uppercase tracking-widest">World</span>
                <span className="font-semibold normal-case tracking-normal">{room.linkedWorld.name}</span>
                <span className="text-[10px] text-keep-muted">by {room.linkedWorld.ownerUsername}</span>
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); dismissWorldBanner(); }}
                title="Hide this world banner. It'll come back if the room's linked world changes."
                aria-label="Hide world banner"
                className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded border border-keep-action/40 bg-keep-action/20 text-[11px] leading-none text-keep-action hover:border-keep-action hover:bg-keep-action/40"
              >
                ×
              </button>
            </div>
          ) : null}
          {/* Room Info bar — clickable; replaces the old dismissible topic
              marquee. Icon + name + topic + quick stats, expands to a metadata
              pullout. Skipped for forum boards (their own header chrome). */}
          {room && !isForumRoom ? (
            <RoomInfoBar
              room={room}
              canEdit={canControlTheater}
              onOpenWorld={(id) => setWorldViewerId(id)}
              pins={currentRoomId ? pinsByRoom[currentRoomId] ?? [] : []}
              canPinMessage={canPinMessage}
              onJumpToMessage={(id) => { if (currentRoomId) void jumpToMessage(currentRoomId, id); }}
              onUnpin={(messageId) => {
                void fetch(`/messages/${encodeURIComponent(messageId)}/pin`, {
                  method: "DELETE",
                  credentials: "include",
                }).catch(() => { /* room:pins will resync; nothing to surface */ });
              }}
            />
          ) : null}
          {room?.messageExpiryMinutes && room.messageExpiryMinutes > 0 ? (
            <div className="keep-notice px-4 py-0.5 text-center text-[10px] uppercase tracking-widest text-keep-muted">
              Messages auto-expire after {formatExpiry(room.messageExpiryMinutes)}
            </div>
          ) : null}
          {/* Accent-color rail separating the header/banner zone from the chat.
              A 3px strip in a light tint of the user's accent; the scifi style
              gives it a glow halo. `data-rail="header"` distinguishes it from
              the matching rail above the composer. */}
          <div aria-hidden className="keep-accent-rail" data-rail="header" />
          {/* Theater (watch-party) video panel. Sits below the banner /
              marquee / earning / room-info stack at the top of the chat
              column, above the message list. Resizable on the vertical; the
              chat below takes the remaining flex space. Only renders when the
              room has theater mode on. */}
          {room?.theaterMode && currentRoomId ? (
            // Boundary so a player failure (most often a stale-deploy chunk
            // 404 on the react-player provider import) reloads to the fresh
            // build instead of blank-screening the app; a persistent failure
            // falls back to an inert panel and leaves the chat below working.
            <ErrorBoundary
              label="theater"
              fallback={() => (
                <div className="flex shrink-0 items-center justify-center bg-black px-4 py-3 text-center text-sm text-white/60">
                  The theater player couldn't load. Reload the page to try again.
                </div>
              )}
            >
              <TheaterPanel
                socket={socket}
                roomId={currentRoomId}
                room={room}
                canControl={canControlTheater}
                onShowStreamGuide={() => setHelpOpen({ guide: "theater-stream" })}
              />
            </ErrorBoundary>
          ) : null}
          {/* "Viewing older history" only applies to flat rooms, for
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
              Viewing older history, click to return to live
            </button>
          ) : null}
          {/* Relative wrapper so the TypingIndicator inside can anchor
              `absolute bottom-0` over the chat feed's reserved bottom
              padding (see MessageList's `pb-6`). This is the Discord
              pattern: chat reserves a small strip at the bottom that
              stays empty when nobody's typing and gets overlaid with
              the typing strip when someone is, no layout shift, no
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
              // (shouldn't happen, MessageList only renders inside
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
            canPinMessage={canPinMessage}
            pinnedMessageIds={pinnedMessageIdsForRoom}
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
            onGoToForumPage={goToForumPage}
            onFlushPendingTopics={(categoryKey) => {
              if (!currentRoomId) return;
              flushPendingForumTopics(currentRoomId, categoryKey);
            }}
            activeTopicId={activeTopicId}
            onSetActiveTopic={(id) => {
              setActiveTopicId(id);
              // Picking a topic implicitly cancels topic-create mode,
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
          {/* Scriptorium collaborator invites, Accept | Decline cards
              mirroring MutualPrompts. The persistent counterpart lives
              on the catalog's My Stories tab. */}
          <StoryInvitePrompts
            socket={socket}
            onError={(n) => setNotice(n)}
          />
          {/* Inline friend-request prompts. Sit alongside the mutual-
              title prompts so any inbound social ask lands in one
              consistent slot above the composer. Cards dispatch
              /accept or /decline via the existing send() pipe, the
              server emits a fresh friend:request echo when the row
              flips, which clears the card via the store re-sync. */}
          <FriendRequestPrompts />
          {/* Second accent rail, sits between the message stream and
              the composer. Same base class as the header rail, but
              `data-rail="footer"` lets the scifi style keep the
              canonical magenta peak here because the body's bottom-
              right accent bloom sits directly under this rail's
              bright end, so the rail genuinely emits into the
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
              // Leaving a thread to start a new topic is the natural UX,
              // the composer can only be in one forum-state at a time.
              setActiveTopicId(null);
              setTopicCreateMode(true);
            }}
            onCancelTopicCreate={() => setTopicCreateMode(false)}
            onLeaveThread={() => setActiveTopicId(null)}
            onOpenEarning={() => setEarningOpen({})}
          />
        </main>
      </div>{/* /chat row */}
      </div>{/* /left column — RoomsTree + ServerRail follow as full-height siblings */}
        {/* Mobile-only backdrop when rail drawer is open */}
        {railOpen ? (
          <div
            className="fixed inset-0 z-30 bg-black/60 lg:hidden"
            onClick={() => setRailOpen(false)}
            aria-hidden="true"
          />
        ) : null}
        {/* Right-side navigation cluster: userlist + server rail.
            MOBILE: one FULL-WIDTH sliding overlay (the "Menu") laid out as a row —
            the userlist fills the space and the server rail pins to its right edge,
            so phones can finally switch/create servers. DESKTOP (lg:contents): the
            wrapper box dissolves and RoomsTree + ServerRail become the shell row's
            own static columns exactly as before (the room-transition snapshot keys
            off the chat wrapper ref, so this added node never enters a snapshot). */}
        <div
          className={`fixed inset-y-0 right-0 z-40 flex w-full flex-row bg-keep-bg shadow-2xl transition-transform lg:contents ${railOpen ? "translate-x-0" : "translate-x-full"}`}
        >
        <RoomsTree
          rooms={roomsTree}
          currentRoomId={currentRoomId}
          selfUserId={me?.id ?? null}
          activeCharacterId={activeCharacterId}
          activeCharacterName={activeCharacterName}
          onIconClick={onIconClick}
          onNameClick={(uid, dn, cid) => {
            // Forward characterId verbatim, a rail click on a
            // CHARACTER row would otherwise lose its identity here
            // and downstream `identityArgFor` would fall back to
            // `@id:<userId>`, routing the whisper to the master
            // instead of the character the user actually clicked.
            // That was a real per-identity leak: a rail click on
            // Sister_Rosalina ended up addressing The_Darkest_Thoughts
            // (her master account) because this wrapper dropped the
            // characterId argument.
            onNameClick(uid, dn, cid);
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
          onOpenArcade={() => { setArcadeOpen(true); setRailOpen(false); }}
          onOpenForums={() => { setForumsOpen({}); setRailOpen(false); }}
          onClose={() => setRailOpen(false)}
          fontStep={fontStep}
        />
        {/* Server Rail (Multi-Server Lift) — the OUTERMOST RIGHT column, sitting
            just outboard of the userlist rail (RoomsTree). This app's primary
            navigation lives on the right, so the server rail rides the far-right
            edge as part of that cluster rather than Discord's far-left. Rendered
            ONLY when the feature flag is on, so flag-off users see today's exact
            shell (no rail, no layout shift). On mobile it rides the right edge of
            the full-screen Menu overlay (above); on desktop lg:contents lifts it
            back out as the shell row's own far-right column. */}
        {serversEnabled ? (
          <ServerRail
            servers={serversForRail}
            currentServerId={currentServerId}
            canApply={!!me?.permissions?.includes("apply_create_server")}
            onSelect={(s) => { void onServerSelect(s); setRailOpen(false); }}
            onDiscover={() => { setServerDiscoverOpen({}); setRailOpen(false); }}
            onOpenSettings={(s) => { setServerSettingsId(s.id); setRailOpen(false); }}
          />
        ) : null}
        </div>{/* /right-side navigation cluster */}
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
                  // id is available (shouldn't happen here, the
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
                onBlock: (name: string) => {
                  setOpenProfile(null);
                  // Mirrors onIgnore: route through the /block command (same
                  // socket pipeline + identity-token resolution) rather than
                  // a one-off fetch. The command fans out the live refresh,
                  // so the blocked user vanishes from chat/userlist at once.
                  // Undo lives in Profile -> Privacy (the HTTP /me/blocks API).
                  const targetArg = identityArgFor({
                    userId: openProfile.profile.userId,
                    characterId: openProfile.kind === "character"
                      ? (openProfile.profile.id ?? null)
                      : null,
                    displayName: name,
                  });
                  send(`/block ${targetArg}`);
                },
              }
            : {})}
          // Active-character action, only renders on profiles the viewer
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
          // After a moderator action (gallery NSFW flag, bio edit) re-fetch
          // THIS profile so the change reflects in place. Uses the identity
          // token (not the display name) so a character / master sharing a
          // name can't resolve to the wrong identity, profile:fetch passes
          // the token straight through resolveProfileView's @id:/@cid: path.
          onModerated={() => {
            const token = openProfile.kind === "character"
              ? `@cid:${openProfile.profile.id}`
              : `@id:${openProfile.profile.userId}`;
            socket.emit("profile:fetch", { username: token }, (res) => {
              if (res.ok) setOpenProfile(res.profile);
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
          // friendly, we don't pass `undefined` through.
          {...(editor.adminContext ? { adminContext: editor.adminContext } : {})}
          // Optional initial tab from the editor open-state, lets
          // deep-links like the shop's flair-buy CTA land on the
          // Flair tab instead of the default Description.
          {...(editor.initialTab ? { initialTab: editor.initialTab } : {})}
          onClose={() => {
            closeEditor();
            setThemeVersion((v) => v + 1);
          }}
          // Re-apply the active theme on save ONLY when the saved
          // target is the identity this tab is currently voicing.
          // Otherwise the bump triggers App's theme effect, which
          // pulls activeTheme from the active identity (not the one
          // being edited) and clobbers the editor's live preview,
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
          // Oversight drill-in: open any server's per-server admin console from
          // the Servers tab (manage_any_server resolves owner-equivalent).
          onOpenServerConsole={(id) => { setAdminOpen(false); setServerSettingsId(id); }}
          // Step into a server's chat to moderate — closes admin, then takes the
          // normal /visit + room-join path (which already admits staff to any
          // server's rooms, private or not, via canParticipate).
          onEnterServer={(id, name) => { setAdminOpen(false); void enterServerById(id, name); }}
        />
      ) : null}
      {rulesOpen ? <RulesModal onClose={() => setRulesOpen(false)} /> : null}
      {/* Per-server owner console (Multi-Server Lift). Only reachable when the
          servers flag is on — the rail that opens it is itself flag-gated — and
          re-checks the viewer's per-server permissions inside. */}
      {serverSettingsId ? (
        <ServerSettingsView
          serverId={serverSettingsId}
          // Every save refetches the catalog so the rail icon, top-bar banner,
          // and Discover cards update LIVE (the console is only 75vw on desktop,
          // so the rail is visible behind it) without waiting for close/refresh.
          onChanged={() => { void listServers().then(setServers).catch(() => {}); }}
          onClose={() => {
            setServerSettingsId(null);
            void listServers().then(setServers).catch(() => {});
          }}
        />
      ) : null}
      {serverDiscoverOpen ? (
        <ServerDiscoverModal
          canApply={!!me?.permissions?.includes("apply_create_server")}
          {...(serverDiscoverOpen.create ? { initialCreate: true } : {})}
          onSelect={(s) => void onServerSelect(s)}
          onClose={() => setServerDiscoverOpen(null)}
        />
      ) : null}
      {earningOpen ? (
        <EarningDashboard
          onClose={() => setEarningOpen(null)}
          {...(earningOpen.tab ? { initialTab: earningOpen.tab } : {})}
          {...(earningOpen.itemSubTab ? { initialItemSubTab: earningOpen.itemSubTab } : {})}
          {...(earningOpen.board ? { initialBoard: earningOpen.board } : {})}
        />
      ) : null}
      {arcadeOpen ? (
        <ArcadeLauncher
          characterId={activeCharacterId}
          onLaunch={(game) => {
            if (game === "urugal") setUrugalOpen(true);
            else if (game === "grimhold") setGrimholdOpen(true);
            else setEidolonOpen(true);
          }}
          onClose={() => setArcadeOpen(false)}
        />
      ) : null}
      {eidolonOpen ? (
        <EidolonWindow characterId={activeCharacterId} onClose={() => setEidolonOpen(false)} />
      ) : null}
      {urugalOpen ? (
        <UrugalWindow characterId={activeCharacterId} onClose={() => setUrugalOpen(false)} />
      ) : null}
      {grimholdOpen ? (
        <GrimholdWindow characterId={activeCharacterId} onClose={() => setGrimholdOpen(false)} />
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
          {...(helpOpen.guide ? { initialGuide: helpOpen.guide } : {})}
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
      {infoOpen ? (
        <InfoModal
          title={infoOpen.title}
          body={infoOpen.body}
          onClose={() => setInfoOpen(null)}
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
      {staffOpen && me ? (
        <StaffModal
          onClose={() => setStaffOpen(false)}
          meId={me.id}
          onMessage={(userId) => {
            // Staff cards are the master/OOC identity; open the DM there.
            setStaffOpen(false);
            openDmWithUser(userId, null);
          }}
        />
      ) : null}
      {affiliatesOpen ? (
        // Top RP Communities portal. Self-contained: the board (list view) plus
        // the Add-Your-Community form + "my submissions" for signed-in members
        // (a log-in prompt otherwise), so it's safe to mount without an `me` gate.
        <AffiliateSubmitPortal
          onClose={() => setAffiliatesOpen(null)}
          initialView={affiliatesOpen}
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
          onClose={() => {
            setWorldViewerId(null);
            // Clear the pending-application latch so a future viewer
            // open on a different (or even the same) world doesn't
            // pop the form on mount.
            setPendingWorldApplicationId(null);
          }}
          // True when the `/world join <slug>` slash command emitted
          // a `world-application-prompt` alongside `open-world`. The
          // ids must match so a stale prompt from a previous world
          // doesn't surface on an unrelated viewer open.
          openApplicationOnMount={pendingWorldApplicationId === worldViewerId}
          // Only owners get the "Edit" button. The server enforces the same
          // check on PATCH/DELETE; this is just for UI affordance. We don't
          // know ownership without inspecting the loaded WorldDetail, so
          // expose the action only when we can plausibly succeed: the viewer
          // is logged in. The editor itself will show an error if they
          // aren't actually the owner.
          {...(me ? { onEdit: () => { const id = worldViewerId; setWorldViewerId(null); setPendingWorldApplicationId(null); setWorldEditorId(id); } } : {})}
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
      {forumsOpen ? (
        <ForumsCatalogModal
          {...(forumsOpen.key ? { initialKey: forumsOpen.key } : {})}
          {...(forumsOpen.topic ? { initialTopic: forumsOpen.topic } : {})}
          {...(forumsOpen.create ? { initialCreate: true } : {})}
          onOpenWorld={(worldId) => setWorldViewerId(worldId)}
          onClose={() => setForumsOpen(null)}
          onIconClick={onIconClick}
          onNameClick={onNameClick}
          onMentionClick={onMentionClick}
          onWorldMentionClick={(slug) => setWorldViewerId(slug)}
          selfNames={selfNames}
          fontStep={fontStep}
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
      {/* Server onboarding / self-roles flow (Batch 2 self-roles). Opened on
          entry to a community server (see the trigger effect). The modal
          fetches the flow itself and calls onDone immediately when there's
          nothing to show, so mounting it eagerly on entry is safe. Its
          welcome header + name come from the server catalog when available. */}
      {onboardingServerId ? (
        <ServerOnboardingModal
          serverId={onboardingServerId}
          serverName={servers?.find((s) => s.id === onboardingServerId)?.name}
          onDone={() => setOnboardingServerId(null)}
        />
      ) : null}
      {/* Guided site tour. Two entry points share one render:
            - First-run: `showSiteTour` (from /me/profile) opens it, but
              only once the one-shot welcome modal is gone, so the two
              never stack. The SiteTour component POSTs the dismiss so
              re-fetches stop asking.
            - On demand: the "Take the tour" menu row flips the store's
              `siteTourForced`, which opens it regardless of the one-time
              flag. onClose clears both so it doesn't immediately reopen. */}
      {(showSiteTour && !welcome) || siteTourForced ? (
        <SiteTour
          onClose={() => {
            setShowSiteTour(false);
            setSiteTourForced(false);
          }}
        />
      ) : null}
    </div>
    </Suspense>
    </ActiveThemeContext.Provider>
  );
}

/**
 * Per-room banner-dismissal memory. Keyed on (roomId, kind) in
 * localStorage; the stored value is the exact world id or topic text
 * the user dismissed, so the banner reappears automatically when the
 * admin edits either one (a fresh value won't match the stored
 * dismissal). When the user leaves the room and comes back the
 * decision persists, sessionStorage would lose it on refresh, which
 * we explicitly don't want for chrome the user has actively hidden.
 *
 * Returns `[dismissed, dismiss]`, `dismissed` is true only when
 * `currentValue` is present AND matches the cached value, so a null
 * `currentValue` (no world linked, no topic set) never reads as
 * dismissed and rendering the banner conditionally on
 * `value && !dismissed` is correct.
 */
function useRoomBannerDismissal(
  roomId: string | null,
  kind: "world" | "topic",
  currentValue: string | null,
): readonly [boolean, () => void] {
  const storageKey = roomId ? `tk:dismissed:room-${kind}:${roomId}` : null;
  const [stored, setStored] = useState<string | null>(() => {
    if (!storageKey) return null;
    try {
      if (typeof localStorage === "undefined") return null;
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  // Re-read on roomId change so navigating between rooms picks up
  // each room's own dismissal independently.
  useEffect(() => {
    if (!storageKey) {
      setStored(null);
      return;
    }
    try {
      setStored(typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null);
    } catch {
      setStored(null);
    }
  }, [storageKey]);
  const dismissed = !!currentValue && stored === currentValue;
  const dismiss = useCallback(() => {
    if (!storageKey || !currentValue) return;
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(storageKey, currentValue);
    } catch {
      // Quota or private-mode, best effort; the dismissal still
      // sticks for the current session via the React state below.
    }
    setStored(currentValue);
  }, [storageKey, currentValue]);
  return [dismissed, dismiss] as const;
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
 * stays put until refresh, no dismiss button on purpose, because
 * dismissing it would just hide the very thing the user needs to act
 * on. The 60s /auth/me poll keeps the comparison fresh, so a deploy
 * surfaces this within a minute of landing.
 */
/**
 * Standing reminder rendered while the viewer is incognito. Without
 * this, a mod who toggles /incognito and then forgets has no signal
 * that everyone else is treating them as gone, they might type a
 * normal chat line expecting their name on it and instead drop a
 * "System" message into the room. The banner sits directly under the
 * deploy notice so it shares the same eye-line as other "site state"
 * affordances. One-click exit via "Leave" fires /incognito which
 * toggles the flag back off.
 */
function IncognitoBanner() {
  const incognitoMode = useChat((s) => s.me?.incognitoMode);
  const incognitoCharacterId = useChat((s) => s.me?.incognitoCharacterId ?? null);
  const tabCharacterId = useChat((s) => s.activeCharacterId);
  const incognitoAlias = useChat((s) => s.me?.incognitoAlias);
  const currentRoomId = useChat((s) => s.currentRoomId);
  if (!incognitoMode || (tabCharacterId ?? null) !== (incognitoCharacterId ?? null)) return null;
  const alias = incognitoAlias ?? "System";
  return (
    <div className="keep-notice keep-notice-accent flex flex-wrap items-center justify-center gap-2 px-3 py-1 text-xs">
      <span aria-hidden>👻</span>
      <span>
        You're incognito as <b>{alias}</b>. The userlist hides you and your messages render as system lines.
      </span>
      <button
        type="button"
        onClick={() => {
          if (!currentRoomId) return;
          getSocket().emit("chat:input", { roomId: currentRoomId, text: "/incognito" });
        }}
        disabled={!currentRoomId}
        className="keep-button rounded border border-keep-action bg-keep-action/20 px-2 py-0.5 text-xs font-semibold text-keep-action hover:bg-keep-action/30 disabled:opacity-50"
      >
        Leave
      </button>
    </div>
  );
}

function StaleVersionBanner() {
  const staleVersion = useChat((s) => s.staleVersion);
  const staleUpdateMessage = useChat((s) => s.staleUpdateMessage);
  const siteName = useChat((s) => s.branding.siteName);
  // Persistent close, keyed by the specific stale-version string so a
  // viewer who dismisses "please update to 0.20.4" still re-sees the
  // banner when 0.20.5 ships. The key joins the version into the
  // dismissed-set entry so a future stale version triggers a fresh
  // notification automatically.
  const dismissKey = staleVersion ? `stale-version:${staleVersion}` : "stale-version";
  const dismissed = useDismissed(dismissKey);
  // The banner itself keeps the original `.keep-notice-accent` chrome
  // (theme-style-aware accent tint + gradient + border). Only the
  // optional ADMIN-AUTHORED release-note paragraph needs its color
  // nudged for legibility, the default `text-keep-muted` washes out
  // against the accent tint on glass / scifi themes where the chat
  // shell's bg image bleeds through. We nudge JUST that fragment
  // against the panel slot (which is what the accent tint blends
  // over), leaving the rest of the banner's chrome untouched.
  const theme = useActiveTheme();
  const noteColor = legibleAgainstBg(theme.muted, theme.panel, 3.0);
  if (!staleVersion) return null;
  if (dismissed) return null;
  return (
    <div className="keep-notice keep-notice-accent flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 text-xs">
      <span>
        You're running <b>{siteName} {VERSION}</b>. The current version is <b>{staleVersion}</b>.
        {/* Admin-authored release note from `remote-deploy.sh
            --update-msg "..."`. Italicized + nudged against the
            panel slot so it reads as secondary context without
            disappearing into the tint on glass / scifi. Falls back
            silently when the deploy didn't carry a note. */}
        {staleUpdateMessage ? (
          <> <em style={{ color: noteColor }}>{staleUpdateMessage}</em></>
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
      {/* Persistent close, the version-keyed dismiss stays in effect
          until a newer stale version arrives, at which point the
          banner re-shows with the new key. */}
      <button
        type="button"
        onClick={() => dismissPersisted(dismissKey)}
        title="Dismiss until a newer version is announced"
        aria-label="Dismiss update banner"
        className="shrink-0 rounded px-1 text-base leading-none text-keep-muted opacity-60 hover:opacity-100 hover:text-keep-text"
      >
        ×
      </button>
    </div>
  );
}
