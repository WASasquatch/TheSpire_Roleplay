import { useEffect, useMemo, useState } from "react";
import type { ChatMessage, Theme } from "@thekeep/shared";
import { DEFAULT_THEME, normalizeTheme } from "@thekeep/shared";
import { AdminPanel } from "./components/AdminPanel.js";
import { AuthGate, SplashShell } from "./components/AuthGate.js";
import { Banner } from "./components/Banner.js";
import { Composer } from "./components/Composer.js";
import { HelpModal } from "./components/HelpModal.js";
import { MessageList } from "./components/MessageList.js";
import { ProfileEditor } from "./components/ProfileEditor.js";
import { ProfileModal } from "./components/ProfileModal.js";
import { RoomsTree, type RoomWithOccupants } from "./components/RoomsTree.js";
import { UsersModal } from "./components/UsersModal.js";
import { getSocket } from "./lib/socket.js";
import { applyTheme } from "./lib/theme.js";
import { fire as fireNotification, shouldNotify, type NotifyPref } from "./lib/notifications.js";
import { useChat, type SiteBranding } from "./state/store.js";

export function App() {
  const me = useChat((s) => s.me);
  const setMe = useChat((s) => s.setMe);
  const authChecked = useChat((s) => s.authChecked);
  const setAuthChecked = useChat((s) => s.setAuthChecked);
  const branding = useChat((s) => s.branding);
  const setBranding = useChat((s) => s.setBranding);

  // Public branding fetch — runs unauthenticated so the login screen and
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
  // *neither* AuthGate nor Chat — otherwise a logged-in user reloading the
  // page (or following a banner link) sees AuthGate flash for ~100ms before
  // the cookie probe completes.
  useEffect(() => {
    let cancelled = false;
    fetch("/auth/me", { credentials: "include" })
      .then(async (r) => (r.ok ? (r.json() as Promise<{ id: string; username: string; role: "user" | "mod" | "admin" }>) : null))
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

  if (!authChecked) return <BootSplash />;
  if (!me) return <AuthGate />;
  return <Chat />;
}

function BootSplash() {
  return (
    <SplashShell>
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-keep-muted">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-keep-action" />
          checking session…
        </div>
      </div>
    </SplashShell>
  );
}

function Chat() {
  const me = useChat((s) => s.me);
  const setRoom = useChat((s) => s.setRoom);
  const setOccupants = useChat((s) => s.setOccupants);
  const appendMessage = useChat((s) => s.appendMessage);
  const setMessages = useChat((s) => s.setMessages);
  const setCurrentRoom = useChat((s) => s.setCurrentRoom);
  const setNotice = useChat((s) => s.setNotice);
  const setHint = useChat((s) => s.setHint);
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
  const [helpOpen, setHelpOpen] = useState<{ filter?: string } | null>(null);
  const [usersOpen, setUsersOpen] = useState<{ query?: string } | null>(null);
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
  const [themeVersion, setThemeVersion] = useState(0);

  const socket = useMemo(() => getSocket(), []);

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
   * Desktop notifications — fires when the tab is hidden (minimized OR on
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
      // /char switch broadcasts presence — refetch the active theme too.
      setRoomsTreeVersion((v) => v + 1);
      setThemeVersion((v) => v + 1);
    });
    socket.on("message:new", (msg: ChatMessage) => appendMessage(msg));
    socket.on("message:bulk", (msgs: ChatMessage[]) => {
      if (msgs.length) setMessages(msgs[0]!.roomId, msgs);
    });
    socket.on("error:notice", (n) => setNotice(n));
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
        case "clear-room-messages": {
          // Read fresh state — the ui:hint handler is registered once and
          // its closure would otherwise capture a stale currentRoomId.
          const rid = useChat.getState().currentRoomId;
          if (rid) setMessages(rid, []);
          break;
        }
        default:
          setHint(h);
      }
    });

    return () => {
      socket.off("room:state");
      socket.off("presence:update");
      socket.off("message:new");
      socket.off("message:bulk");
      socket.off("error:notice");
      socket.off("ui:hint");
    };
  }, [socket, setRoom, setOccupants, appendMessage, setMessages, setCurrentRoom, setNotice, setHint, setOpenProfile, openEditor, setRefreshIntervalSec]);

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
   * Click on the gender icon — view someone's profile, or open the editor
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
   * Click on the name — pre-fill the composer with `/whisper <name> ` so the
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
   * Click on an @mention inside a message body. Per the spec this should
   * open the user's profile (not whisper) — and resolve to their *active*
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
    // h-dvh (dynamic viewport height) so mobile keyboards reflow properly
    // instead of the chat being pushed off-screen when the on-screen keyboard
    // appears. Falls back to h-screen on browsers that don't support `dvh`.
    <div className="flex h-screen h-dvh flex-col">
      <Banner
        navLinksVersion={navLinksVersion}
        {...(me?.role === "admin" ? { onOpenAdmin: () => setAdminOpen(true) } : {})}
      />
      {room?.topic ? (
        <div className="border-b border-keep-rule bg-keep-banner/40 px-4 py-1 text-center text-sm italic text-keep-muted">
          {room.topic}
        </div>
      ) : null}
      <div className="relative flex flex-1 overflow-hidden">
        <main className="flex flex-1 flex-col">
          <MessageList
            messages={messages}
            occupants={occ}
            onIconClick={onIconClick}
            onNameClick={onNameClick}
            onMentionClick={onMentionClick}
            fontStep={fontStep}
          />
          <Composer
            value={composerText}
            onChange={setComposerText}
            onSend={send}
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
          isOpen={railOpen}
          onClose={() => setRailOpen(false)}
        />
      </div>
      {notice ? <Toast notice={notice} onDismiss={() => setNotice(null)} /> : null}
      {openProfile ? (
        <ProfileModal
          profile={openProfile}
          onClose={() => setOpenProfile(null)}
          onWhisper={(name) => {
            setOpenProfile(null);
            setComposerText(`/whisper ${name} `);
          }}
          onIgnore={(name) => {
            setOpenProfile(null);
            send(`/ignore ${name}`);
          }}
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
    </div>
  );
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
