import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Globe,
  FileText,
  VenetianMask,
  MessagesSquare,
  Landmark,
  Users,
  Paintbrush2,
  Settings,
  HelpCircle,
  Gamepad2,
  Archive,
  Lock,
  RotateCcw,
  X,
} from "lucide-react";
import { useChat } from "../state/store.js";
import {
  getReduceMotionToggle,
  osReduceMotionForced,
  setReduceMotionToggle,
  useReducedMotion,
} from "../lib/reducedMotion.js";
import {
  getReduceCosmeticsToggle,
  setReduceCosmeticsToggle,
  useCalmCosmetics,
} from "../lib/calmCosmetics.js";
import { fetchForums } from "../lib/forums.js";
import { fetchArchivedRooms, hideArchivedRoom } from "../lib/rooms.js";
import type { ArchivedRoomBrief, ForumSummary } from "@thekeep/shared";
import { CloseButton } from "./shared/CloseButton.js";
import { CreateCharacterModal } from "./profile/CreateCharacterModal.js";

/** Shape of `/characters` rows, narrow projection of the server payload. */
interface CharacterRow {
  id: string;
  name: string;
  avatarUrl: string | null;
}

interface Props {
  onCommand: (text: string) => void;
  /** Id of the active character on this tab, or null when posting as the master. */
  activeCharacterId?: string | null;
  /** Display name of the active character (passed through from App so the
   *  identity button can show "Sigrid" instead of just the id). */
  activeCharacterName?: string | null;
  /** Current room; the search bar scopes to it. Null disables the bar. */
  currentRoomId: string | null;
  /** Jump to a specific message id in the given room. Search bar wires this. */
  onJumpToMessage: (roomId: string, messageId: string) => void;
  /** Open the unified Messages modal (DMs + friends + friend requests). */
  onOpenMessages: () => void;
  /** Open the Earning dashboard (wallet, ranks, shop, collection, pets).
   *  Optional so a future caller that doesn't surface earning can drop
   *  the menu entry; the Account section just hides the row when omitted. */
  onOpenEarning?: () => void;
  onOpenArcade?: () => void;
}

/**
 * Bottom of the right rail. Composes:
 *   - Always-visible trigger bar with the most-clicked actions.
 *   - "More tools" drawer that slides up over the rail (rooms list hides
 *     behind it). The drawer holds buttons + inline forms for less-frequent
 *     commands, including ones that would otherwise require remembering the
 *     slash syntax (worlds, mood, scene, find, etc.).
 *
 * Mobile lives inside the existing rooms drawer (RoomsTree at sub-md widths
 * is a fixed-position slide-out), so the drawer here just expands upward
 * within that container - works the same as desktop.
 */
export function ToolPanel({ onCommand, activeCharacterId, activeCharacterName, onOpenMessages, onOpenEarning, onOpenArcade }: Props) {
  // NOTE: `currentRoomId` + `onJumpToMessage` remain in Props (RoomsTree still
  // passes them) but are no longer consumed here — the message SearchBar they
  // fed moved to the top of the rail (RoomsTree). Left in the interface so the
  // existing mount stays type-compatible without an App-level change.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [moodOpen, setMoodOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  // Identity switcher (above the Tools trigger). Lazily loads the user's
  // character list the first time it's opened, most sessions never
  // touch it, so paying the /characters fetch on every mount would be
  // wasteful. After the first open the result is cached for this tab.
  const [identityOpen, setIdentityOpen] = useState(false);
  const [characters, setCharacters] = useState<CharacterRow[] | null>(null);
  const [charactersLoading, setCharactersLoading] = useState(false);
  // "Create Character" name-prompt toggle (opened from the identity
  // switcher). On create we switch into the new character and open its
  // profile editor so the user lands straight in setup.
  const [createCharOpen, setCreateCharOpen] = useState(false);
  const openEditor = useChat((s) => s.openEditor);
  const me = useChat((s) => s.me);
  // Replay the site tour on demand from the "Take the tour" menu row.
  // The tour itself is rendered at the App level; flipping this store
  // flag opens it regardless of whether the one-time showSiteTour has
  // already been dismissed.
  const setSiteTourForced = useChat((s) => s.setSiteTourForced);
  // Reduce Motion (accessibility) — effective state (OS setting OR per-device
  // toggle). osForced = the OS demands it, so the toggle shows on + locked.
  const reduceMotion = useReducedMotion();
  const reduceMotionForced = osReduceMotionForced();
  // "Reduce cosmetic effects" — the cosmetics-only manual toggle. `calmActive`
  // is the effective unified gate (reduce-motion OR low-perf OR this toggle);
  // we surface it so the row reads as "On" when an upstream gate already
  // quiets cosmetics, and so the row reflects the user's own choice.
  const calmActive = useCalmCosmetics();
  const fontStep = useChat((s) => s.fontStep);
  const setFontStep = useChat((s) => s.setFontStep);
  const refreshIntervalSec = useChat((s) => s.refreshIntervalSec);
  // "Export my data" (Account section). The export is an AUTHENTICATED GET, so
  // we fetch it (the bearer token rides the patched window.fetch) and download
  // the returned blob — a plain <a href> navigation wouldn't carry the token.
  const [exportingData, setExportingData] = useState(false);
  async function exportMyData() {
    if (exportingData) return;
    setExportingData(true);
    try {
      const r = await fetch("/me/export", { credentials: "include" });
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      const cd = r.headers.get("content-disposition") ?? "";
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "thespire-export.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      useChat.getState().setNotice({ code: "EXPORT_OK", message: "Your data export downloaded — keep it somewhere safe." });
    } catch {
      useChat.getState().setNotice({ code: "EXPORT_FAILED", message: "Couldn't build your export just now. Try again in a minute." });
    } finally {
      setExportingData(false);
    }
  }
  // Per-kind totals across EVERY identity the user owns (master / OOC
  // + each character). Kept as two numbers, not one combined cue,
  // because reports of "the badge said I have messages but they were
  // friend requests" kept landing: conflating the two left users
  // hunting for a DM that wasn't there. The envelope renders two
  // distinct pips so the user can tell apart "you have unread DMs" vs
  // "someone wants to friend you" without opening the modal.
  //
  // Reads from `inboxCountsByIdentity` (refreshed on every dm:new /
  // dm:read / friend:request by the App-level socket handlers, plus
  // by the messenger when it's open) instead of from
  // `dmConversations`. The conversations map is IDENTITY-SCOPED,
  // only the currently-active character's threads are loaded, so a
  // DM that lands on Char B while the viewer is on Char A would
  // otherwise leave the badge at zero and the recipient would have
  // no signal that a message arrived for one of their other
  // identities. Summing the per-identity counts surfaces every
  // unread regardless of which chip the viewer is currently on.
  const unreadDmsTotal = useChat((s) => {
    let n = 0;
    for (const row of s.inboxCountsByIdentity.values()) n += row.unreadDms;
    return n;
  });
  const pendingFriendRequestsTotal = useChat((s) => {
    let n = 0;
    for (const row of s.inboxCountsByIdentity.values()) n += row.pendingFriendRequests;
    return n;
  });
  // Combined total, used by the inner Tools-drawer "Messages" row
  // (one-line list item that doesn't have room for two distinct pips)
  // and as the keep-it-simple hover summary on the envelope.
  const messagesBadgeTotal = unreadDmsTotal + pendingFriendRequestsTotal;

  // Aggregate unread forum-notification count (replies to your topics,
  // quotes, mentions). Same store value the rail's Forums Catalog badge
  // reads, so the two surfaces never disagree. Drives the badge on the
  // drawer's "Forums Catalog" row.
  const forumNotifUnread = useChat((s) => s.forumNotifUnread);

  // Quick-bookmark forum list: forums the viewer owns, mods, or has joined,
  // plus open forums they've opened before ("interacted with"). Fetched
  // lazily the first time the drawer opens — most sessions never open the
  // drawer, so paying the /forums fetch on every mount would be wasteful.
  // Re-fetched on each open so a freshly-joined/created forum surfaces
  // without a reload; the cached list renders immediately meanwhile.
  const [forums, setForums] = useState<ForumSummary[] | null>(null);
  useEffect(() => {
    if (!drawerOpen) return;
    let cancelled = false;
    fetchForums()
      .then((list) => { if (!cancelled) setForums(list); })
      .catch(() => { /* catalog row still works; bookmarks just stay hidden */ });
    return () => { cancelled = true; };
  }, [drawerOpen]);

  // Archived rooms the viewer owns, for the "My Rooms" section. Same lazy
  // pattern as the forum bookmarks above: fetched the first time the drawer
  // opens and re-fetched on each open so a room that archived (or got
  // recreated) mid-session stays accurate. `null` = not loaded yet (show a
  // hint), `[]` = loaded-and-empty.
  const [archivedRooms, setArchivedRooms] = useState<ArchivedRoomBrief[] | null>(null);
  useEffect(() => {
    if (!drawerOpen) return;
    let cancelled = false;
    fetchArchivedRooms()
      .then((list) => { if (!cancelled) setArchivedRooms(list); })
      .catch(() => { /* section just shows its empty/hint state */ });
    return () => { cancelled = true; };
  }, [drawerOpen]);

  // "X" on a My Rooms row: hide that archived room from the list (e.g. a typo
  // room). Optimistic — drop it immediately, restore (re-sorted) if the server
  // rejects. Non-destructive; the room can be recreated any time with /go.
  function hideArchivedRoomRow(room: ArchivedRoomBrief) {
    setArchivedRooms((cur) => (cur ? cur.filter((r) => r.id !== room.id) : cur));
    void hideArchivedRoom(room.id).catch(() => {
      setArchivedRooms((cur) => (cur ? [...cur, room].sort((a, b) => a.name.localeCompare(b.name)) : cur));
    });
  }

  const forumBookmarks = useMemo(() => {
    if (!forums) return [] as ForumSummary[];
    return forums
      .filter((f) => f.viewerRole != null || (f.postingMode === "open" && f.visited))
      // Owned forums first (you tend them), then everything else by name.
      .sort((a, b) => {
        const rank = (f: ForumSummary) => (f.viewerRole === "owner" ? 0 : 1);
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });
  }, [forums]);

  // Accordion: at most one section open at a time. Every section starts
  // collapsed so the drawer opens as a short, scannable list of category
  // headers instead of a long wall of rows. Tapping a header opens it and
  // auto-collapses whichever was open. `null` = all collapsed.
  const [openSection, setOpenSection] = useState<string | null>(null);
  function toggleSection(title: string) {
    setOpenSection((cur) => (cur === title ? null : title));
  }
  // Scroll container + per-section anchors. The drawer grows UPWARD out of
  // the trigger bar, so its "bottom" edge is the one nearest the thumb;
  // we default the scroll there on open and nudge a freshly-opened section
  // into view.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // On open: collapse to a clean slate and pin the scroll to the bottom
  // (the section headers closest to the trigger bar, where the thumb
  // already rests). rAF so the measurement runs after children paint.
  useEffect(() => {
    if (!drawerOpen) { setOpenSection(null); return; }
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(id);
  }, [drawerOpen]);

  // When a section expands, scroll it into view so its newly-revealed rows
  // are visible even if it sat above the previously-open (taller) section.
  useEffect(() => {
    if (!openSection) return;
    const el = sectionRefs.current[openSection];
    if (!el) return;
    const id = requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(id);
  }, [openSection]);

  function cycleFont() {
    setFontStep(((fontStep + 1) % 4) as 0 | 1 | 2 | 3);
  }

  // Run a slash command and collapse the drawer + any open inline picker.
  // Used by the simple no-args buttons; the inline forms manage their own
  // close state so the user can submit and stay in context if they like.
  function fire(cmd: string) {
    onCommand(cmd);
    setDrawerOpen(false);
    setColorOpen(false);
    setRefreshOpen(false);
    setMoodOpen(false);
    setSceneOpen(false);
    setFindOpen(false);
    setPrivateOpen(false);
  }

  /**
   * Lazy load the character list when the identity dropdown opens for
   * the first time. Re-uses the cached list on subsequent opens this
   * session; an /char create or rename happens through the editor and
   * its own onSaved hooks would need to invalidate this, but the
   * cache is per-mount of ToolPanel, which is cheap to remount (e.g.
   * after a room switch we don't, but after a full reload we do).
   */
  useEffect(() => {
    if (!identityOpen) return;
    // Re-fetch on every open. The previous "fetch once and cache for
    // the rest of the mount" guard meant a character created mid-
    // session via the profile editor never surfaced here until the
    // user reloaded the page. The dropdown only opens on a deliberate
    // click so a single network call per open is cheap, and we
    // render the cached list immediately below so there's no loading
    // flash while the refresh is in flight; the spinner only shows
    // when there's no cache to display yet.
    let cancelled = false;
    if (characters === null) setCharactersLoading(true);
    fetch("/characters")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        if (j && Array.isArray(j.characters)) {
          setCharacters(
            j.characters.map((c: { id: string; name: string; avatarUrl: string | null }) => ({
              id: c.id,
              name: c.name,
              avatarUrl: c.avatarUrl,
            })),
          );
        } else if (characters === null) {
          // Only fall to empty when we genuinely had nothing to show.
          // A bad refresh shouldn't wipe a previously-good cached list.
          setCharacters([]);
        }
      })
      .catch(() => { if (!cancelled && characters === null) setCharacters([]); })
      .finally(() => { if (!cancelled) setCharactersLoading(false); });
    return () => { cancelled = true; };
    // `characters` is intentionally NOT in the dependency list, adding
    // it would loop the effect on every successful fetch (the fetch
    // writes characters, which fires the effect, which fetches again).
    // We only want to (re)fetch when the dropdown opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityOpen]);

  // Esc closes the identity dropdown too, same UX as the Tools drawer.
  useEffect(() => {
    if (!identityOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIdentityOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [identityOpen]);

  function switchCharacter(name: string) {
    onCommand(`/char switch ${name}`);
    setIdentityOpen(false);
  }
  function leaveCharacter() {
    onCommand("/char clear");
    setIdentityOpen(false);
  }
  function openCreateCharacter() {
    // Close the dropdown first so the name modal isn't stacked behind
    // the switcher's backdrop.
    setIdentityOpen(false);
    setCreateCharOpen(true);
  }
  function toggleIncognito() {
    onCommand("/incognito");
    setIdentityOpen(false);
  }
  // Permission-gated incognito affordance. Only mods/admins with
  // `use_ghost_mode` see the button at all, regular users can't
  // even discover the feature exists, which is the privacy contract
  // the staff-observation tool was designed around.
  const canIncognito = !!me?.permissions.includes("use_ghost_mode");
  const incognitoMode = !!me?.incognitoMode;

  // Esc closes the drawer when it's open. Registering only while open keeps
  // global key behavior unchanged when the drawer is dismissed.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDrawerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="keep-tool-panel relative shrink-0 border-t border-keep-rule bg-keep-banner/60 px-2 py-2">
      {drawerOpen ? (
        <>
          {/* Backdrop. Fixed-viewport so a click anywhere outside closes the
              drawer, including the chat area. Slightly tinted on desktop;
              tinted heavier on mobile (where the rail is itself a drawer
              and the backdrop is the only visual separation). */}
          <button
            type="button"
            aria-label="Close tools"
            onClick={() => setDrawerOpen(false)}
            className="fixed inset-0 z-30 bg-black/20 md:bg-black/10"
          />
          {/* Drawer body. Anchored to the trigger bar's top edge and grows
              upward; max-h is sized to fit inside the rail's available
              space (~14rem reserved for the chat banner + room-topic
              strip + a small safety margin). Without this cap the
              drawer can extend ABOVE the rail and get clipped by the
              parent's overflow-hidden, at which point its sticky
              header sits in the clipped region and the user sees the
              top section title disappear behind the chat banner.
              The internal overflow-y-auto handles any overflow from
              tools sections themselves. */}
          <div ref={scrollRef} className="keep-menu-surface absolute inset-x-0 bottom-full z-40 max-h-[calc(100dvh-14rem)] overflow-y-auto rounded-t border-x border-t border-keep-rule bg-keep-bg shadow-2xl">
            <header className="sticky top-0 z-10 flex items-center justify-between border-b border-keep-rule bg-keep-banner px-3 py-2">
              <span className="text-xs font-action uppercase tracking-widest">Menu</span>
              <CloseButton onClick={() => setDrawerOpen(false)} />
            </header>

            {/* Accordion sections. Order runs top→bottom: authoring/creative
                first, then community + navigation, then social, then prefs,
                with search last (nearest the trigger bar). Each header taps
                open/closed; opening one auto-collapses the rest. */}
            <Section
              title="Worldbuilding"
              icon={<Globe size={14} aria-hidden />}
              open={openSection === "Worldbuilding"}
              onToggle={() => toggleSection("Worldbuilding")}
              innerRef={(el) => { sectionRefs.current["Worldbuilding"] = el; }}
            >
              <MenuItem label="My Worlds" hint="Manage your worlds + pages" onClick={() => fire("/worlds")} />
              <MenuItem label="World Catalog" hint="Browse open worlds" onClick={() => fire("/world catalog")} />
            </Section>

            <Section
              title="Writing"
              icon={<FileText size={14} aria-hidden />}
              open={openSection === "Writing"}
              onToggle={() => toggleSection("Writing")}
              innerRef={(el) => { sectionRefs.current["Writing"] = el; }}
            >
              <MenuItem label="My Stories" hint="Drafts + published, open the editor" onClick={() => fire("/scriptorium my")} />
              <MenuItem label="Scriptorium" hint="Browse the library, read and write" onClick={() => fire("/scriptorium")} />
            </Section>

            <Section
              title="Roleplay"
              icon={<VenetianMask size={14} aria-hidden />}
              open={openSection === "Roleplay"}
              onToggle={() => toggleSection("Roleplay")}
              innerRef={(el) => { sectionRefs.current["Roleplay"] = el; }}
            >
              <MenuItem
                label="Set Mood"
                hint="Show a mood next to your name"
                active={moodOpen}
                onClick={() => setMoodOpen((v) => !v)}
              />
              {moodOpen ? (
                <InlinePanel>
                  <InlineForm
                    placeholder="e.g. brooding, exhausted, smug"
                    submitLabel="Set"
                    extraButtons={[{ label: "Clear", onClick: () => fire("/mood clear") }]}
                    onSubmit={(text) => { if (text.trim()) fire(`/mood ${text.trim()}`); }}
                  />
                </InlinePanel>
              ) : null}
              <MenuItem
                label="Set Scene"
                hint="Set the room's scene title"
                active={sceneOpen}
                onClick={() => setSceneOpen((v) => !v)}
              />
              {sceneOpen ? (
                <InlinePanel>
                  <InlineForm
                    placeholder="e.g. The dragon's lair"
                    submitLabel="Set"
                    extraButtons={[{ label: "End scene", onClick: () => fire("/scene end") }]}
                    onSubmit={(text) => { if (text.trim()) fire(`/scene ${text.trim()}`); }}
                  />
                </InlinePanel>
              ) : null}
              <MenuItem label="NPCs: On" hint="Enable NPC voice in this room" onClick={() => fire("/npcmode on")} />
              <MenuItem label="NPCs: Off" hint="Disable NPC voice in this room" onClick={() => fire("/npcmode off")} />
            </Section>

            <Section
              title="Forums"
              icon={<MessagesSquare size={14} aria-hidden />}
              open={openSection === "Forums"}
              onToggle={() => toggleSection("Forums")}
              innerRef={(el) => { sectionRefs.current["Forums"] = el; }}
              badge={forumNotifUnread}
            >
              <MenuItem
                label="Forums Catalog"
                hint="Community-owned message boards"
                badge={forumNotifUnread}
                onClick={() => fire("/forums")}
              />
              <MenuItem label="Create a Forum" hint="Apply to open your own forum" onClick={() => fire("/forums create")} />
              {/* Quick bookmarks: forums you own / have joined, plus open forums
                  you've visited. Indented as a sub-list under the two actions so
                  they read as shortcuts, not top-level menu rows. Each lands
                  straight on its forum via `/forums <slug>`. The unseen dot
                  mirrors the catalog rail's "new activity since your last visit"
                  cue. */}
              {forumBookmarks.map((f) => (
                <ForumBookmarkRow
                  key={f.id}
                  forum={f}
                  onClick={() => fire(`/forums ${f.slug}`)}
                />
              ))}
            </Section>

            <Section
              title="Rooms"
              icon={<Landmark size={14} aria-hidden />}
              open={openSection === "Rooms"}
              onToggle={() => toggleSection("Rooms")}
              innerRef={(el) => { sectionRefs.current["Rooms"] = el; }}
            >
              <MenuItem
                label="Find Rooms"
                hint="Search for a room by name"
                active={findOpen}
                onClick={() => setFindOpen((v) => !v)}
              />
              {findOpen ? (
                <InlinePanel>
                  <InlineForm
                    placeholder="search text (or empty for all)"
                    submitLabel="Find"
                    onSubmit={(text) => fire(text.trim() ? `/find ${text.trim()}` : "/find")}
                  />
                </InlinePanel>
              ) : null}
              <MenuItem label="List Rooms" hint="Show all public rooms" onClick={() => fire("/list")} />
              <MenuItem
                label="New Private Room"
                hint="Create a password-locked room"
                active={privateOpen}
                onClick={() => setPrivateOpen((v) => !v)}
              />
              {privateOpen ? (
                <InlinePanel>
                  <PrivateForm onSubmit={(name, pw) => fire(`/private ${name} ${pw}`)} />
                </InlinePanel>
              ) : null}
            </Section>

            <Section
              title="My Rooms"
              icon={<Archive size={14} aria-hidden />}
              open={openSection === "My Rooms"}
              onToggle={() => toggleSection("My Rooms")}
              innerRef={(el) => { sectionRefs.current["My Rooms"] = el; }}
              {...(archivedRooms ? { badge: archivedRooms.length } : {})}
            >
              {archivedRooms === null ? (
                <div className="px-3 py-2 text-xs text-keep-muted">Loading your rooms…</div>
              ) : archivedRooms.length === 0 ? (
                <div className="px-3 py-2 text-xs text-keep-muted">
                  No archived rooms yet. A room you own is archived once everyone leaves it,
                  then shows up here so you can bring it back.
                </div>
              ) : (
                archivedRooms.map((r) => (
                  <ArchivedRoomRow
                    key={r.id}
                    room={r}
                    onRecreate={() => fire(`/go ${r.name}`)}
                    onHide={() => hideArchivedRoomRow(r)}
                  />
                ))
              )}
            </Section>

            <Section
              title="People"
              icon={<Users size={14} aria-hidden />}
              open={openSection === "People"}
              onToggle={() => toggleSection("People")}
              innerRef={(el) => { sectionRefs.current["People"] = el; }}
              badge={messagesBadgeTotal}
            >
              <MenuItem
                label="Messages"
                hint="DMs, friends, and friend requests, all in one place"
                badge={messagesBadgeTotal}
                onClick={() => { onOpenMessages(); setDrawerOpen(false); }}
              />
              <MenuItem label="All Users" hint="Browse the user directory" onClick={() => fire("/users")} />
              <MenuItem label="Ignore List" hint="Show or clear your ignore list" onClick={() => fire("/ignore")} />
            </Section>

            <Section
              title="Display"
              icon={<Paintbrush2 size={14} aria-hidden />}
              open={openSection === "Display"}
              onToggle={() => toggleSection("Display")}
              innerRef={(el) => { sectionRefs.current["Display"] = el; }}
            >
              <MenuItem
                label="Chat Color"
                hint="Set your chat color"
                active={colorOpen}
                onClick={() => setColorOpen((v) => !v)}
              />
              {colorOpen ? (
                <InlinePanel>
                  <ColorPicker
                    onPick={(hex) => fire(`/color ${hex}`)}
                    onClear={() => fire("/color clear")}
                  />
                </InlinePanel>
              ) : null}
              <MenuItem
                label={`Font Size: ${fontStep}`}
                hint="Cycle local chat font size"
                onClick={cycleFont}
              />
              <MenuItem
                label={`Reduce Motion: ${reduceMotion ? "On" : "Off"}`}
                hint={
                  reduceMotionForced
                    ? "On because your device asks for it"
                    : "Soft fades; stops auto-playing motion. Helps if motion feels unwell"
                }
                active={reduceMotion}
                onClick={() => {
                  if (reduceMotionForced) return; // OS-locked on; nothing to toggle
                  setReduceMotionToggle(!getReduceMotionToggle());
                }}
              />
              <MenuItem
                label={`Reduce cosmetic effects: ${calmActive ? "On" : "Off"}`}
                hint={
                  calmActive && !getReduceCosmeticsToggle()
                    ? "On already from your motion or performance settings. Quiets name-style and avatar-border animations"
                    : "Quiets name-style and avatar-border animations for smoother, lighter chat"
                }
                active={calmActive}
                onClick={() => setReduceCosmeticsToggle(!getReduceCosmeticsToggle())}
              />
              <MenuItem
                label={refreshIntervalSec > 0 ? `Slow mode: every ${refreshIntervalSec}s` : "Refresh"}
                hint={refreshIntervalSec > 0 ? "Real-time userlist + typing paused; resyncs on a schedule" : "Refresh once, or slow real-time updates to ease load on this device"}
                active={refreshOpen || refreshIntervalSec > 0}
                onClick={() => setRefreshOpen((v) => !v)}
              />
              {refreshOpen ? (
                <InlinePanel>
                  <RefreshPicker
                    current={refreshIntervalSec}
                    onPick={(n) => {
                      if (n === 0) fire("/refresh off");
                      else if (n === -1) fire("/refresh");
                      else fire(`/refresh ${n}`);
                    }}
                  />
                </InlinePanel>
              ) : null}
            </Section>

            <Section
              title="Account"
              icon={<Settings size={14} aria-hidden />}
              open={openSection === "Account"}
              onToggle={() => toggleSection("Account")}
              innerRef={(el) => { sectionRefs.current["Account"] = el; }}
            >
              <MenuItem label="Edit Profile" hint="Open your profile editor" onClick={() => fire("/profile")} />
              {onOpenEarning ? (
                <MenuItem
                  label="Your Earning"
                  hint="Wallet, ranks, shop, items, collection, pets"
                  onClick={() => { onOpenEarning(); setDrawerOpen(false); }}
                />
              ) : null}
              <MenuItem label="Bookmarks" hint="Your saved chat messages" onClick={() => fire("/bookmarks")} />
              <MenuItem
                label={exportingData ? "Preparing export…" : "Export my data"}
                hint="Download your profile, characters, worlds, and stories"
                onClick={() => { if (!exportingData) void exportMyData(); }}
              />
              <MenuItem label="Toggle Away" hint="Mark yourself away" onClick={() => fire("/away")} />
            </Section>

            {/* Spire Arcade, always exposed (not tucked inside the Account
                accordion) so the games stay one tap away. Styled like a
                section header but acts as a direct button, matching the Help
                row below. Permission-gated, hidden entirely when the viewer
                lacks arcade access. */}
            {onOpenArcade && me?.permissions.includes("use_arcade") ? (
              <button
                type="button"
                onClick={() => { onOpenArcade(); setDrawerOpen(false); }}
                title="Play the arcade's games, like the Eidolon Tamer"
                className="flex w-full items-center gap-2 border-y border-keep-rule/60 bg-keep-banner/40 px-3 py-1.5 text-[10px] font-action uppercase tracking-[0.2em] text-keep-muted hover:bg-keep-banner/60 hover:text-keep-text lg:py-1"
              >
                <span aria-hidden className="shrink-0"><Gamepad2 size={14} aria-hidden /></span>
                <span className="flex-1 text-left">Spire Arcade</span>
                <span aria-hidden className="shrink-0 text-sm leading-none text-keep-muted">›</span>
              </button>
            ) : null}

            {/* Take the tour, replays the guided site walkthrough. Sits
                beside Help so a newcomer who dismissed the first-run tour
                (or wants a refresher) can find it in the same spot they'd
                look for the guides. Flips the store flag the App-level
                tour watches, then closes the drawer so the spotlight has a
                clean view of the rails behind it. */}
            <button
              type="button"
              onClick={() => { setSiteTourForced(true); setDrawerOpen(false); }}
              title="Replay the guided walkthrough of the chat and its rails"
              className="flex w-full items-center gap-2 border-y border-keep-rule/60 bg-keep-banner/40 px-3 py-1.5 text-[10px] font-action uppercase tracking-[0.2em] text-keep-muted hover:bg-keep-banner/60 hover:text-keep-text lg:py-1"
            >
              <span aria-hidden className="shrink-0"><HelpCircle size={14} aria-hidden /></span>
              <span className="flex-1 text-left">Take the tour</span>
              <span aria-hidden className="shrink-0 text-sm leading-none text-keep-muted">›</span>
            </button>

            {/* Help, always exposed (not tucked inside the Account accordion)
                so a newcomer can always find the guides + command reference
                without hunting. Styled like a section header but acts as a
                direct button. */}
            <button
              type="button"
              onClick={() => fire("/help")}
              title="Browse the guides and every command"
              className="flex w-full items-center gap-2 border-y border-keep-rule/60 bg-keep-banner/40 px-3 py-1.5 text-[10px] font-action uppercase tracking-[0.2em] text-keep-muted hover:bg-keep-banner/60 hover:text-keep-text lg:py-1"
            >
              <span aria-hidden className="shrink-0"><HelpCircle size={14} aria-hidden /></span>
              <span className="flex-1 text-left">Help / Commands</span>
              <span aria-hidden className="shrink-0 text-sm leading-none text-keep-muted">›</span>
            </button>

            {/* Message search moved OUT of this drawer to a dedicated
                container pinned at the TOP of the rail (RoomsTree), above the
                Forums Catalog button, so it's always reachable without
                opening the Tools menu and now carries a room/server scope
                toggle (Batch 2 search-core). */}
          </div>
        </>
      ) : null}

      {/* Identity switcher (flex-1) + Messenger shortcut (icon-square).
          The two share a row so the DM unread badge sits where the eye
          naturally lands when scanning the bottom strip, instead of
          competing with the Tools button. Identity dropdown owns the
          left, messenger icon owns the right, fixed-width so it
          doesn't push the identity label around. All three buttons
          (identity, envelope, Tools) share the same explicit height
          (h-9 mobile / lg:h-7 desktop) so they line up regardless of
          their font-size differences. Without the fixed heights the
          envelope's `text-base` glyph would render taller than the
          identity's `text-xs` label and the row's bottom edges would
          drift apart. */}
      <div className="flex gap-1">
        <div className="min-w-0 flex-1">
          <IdentityButton
            masterName={me?.username ?? null}
            activeCharacterName={activeCharacterName ?? null}
            characters={characters}
            loading={charactersLoading}
            open={identityOpen}
            onToggle={() => setIdentityOpen((v) => !v)}
            onClose={() => setIdentityOpen(false)}
            onSwitch={switchCharacter}
            onLeave={leaveCharacter}
            onCreateCharacter={openCreateCharacter}
            inCharacter={!!activeCharacterId}
            canIncognito={canIncognito}
            incognitoMode={incognitoMode}
            onToggleIncognito={toggleIncognito}
          />
        </div>
        <button
          type="button"
          onClick={onOpenMessages}
          title={(() => {
            // Spell out both numbers in the tooltip, the inner Tools
            // drawer doesn't have room for two pips so this is the
            // disambiguation surface for users who can't tell the
            // DM cue from the friend-request cue at a glance.
            const parts: string[] = [];
            if (unreadDmsTotal > 0) {
              parts.push(`${unreadDmsTotal} unread DM${unreadDmsTotal === 1 ? "" : "s"}`);
            }
            if (pendingFriendRequestsTotal > 0) {
              parts.push(`${pendingFriendRequestsTotal} friend request${pendingFriendRequestsTotal === 1 ? "" : "s"}`);
            }
            return parts.length > 0 ? `${parts.join(" + ")}, open Messages` : "Open Messages";
          })()}
          aria-label="Open Messages"
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded border border-keep-rule bg-keep-bg text-sm leading-none hover:bg-keep-banner lg:h-7 lg:w-7"
        >
          <span aria-hidden>✉</span>
          {/* DM pip, top-right, accent red. Reserved for actual unread
              messages; users learn to read this corner as "someone
              messaged me." */}
          {unreadDmsTotal > 0 ? (
            <span
              aria-hidden
              className="absolute -right-1 -top-1 min-w-[1.1rem] rounded-full bg-keep-action px-1 py-0 text-center text-[10px] font-semibold leading-tight text-keep-bg"
            >
              {unreadDmsTotal > 99 ? "99+" : unreadDmsTotal}
            </span>
          ) : null}
          {/* Friend-request pip, bottom-right, accent yellow, with a
              "+" prefix so it reads as "someone wants to add you" even
              for a low number. Kept visually distinct from the DM pip
              so the user doesn't conflate them and go hunting for a
              message that's actually just a friendship invite. */}
          {pendingFriendRequestsTotal > 0 ? (
            <span
              aria-hidden
              className="absolute -bottom-1 -right-1 min-w-[1.1rem] rounded-full bg-keep-accent px-1 py-0 text-center text-[10px] font-semibold leading-tight text-keep-bg"
            >
              +{pendingFriendRequestsTotal > 99 ? "99" : pendingFriendRequestsTotal}
            </span>
          ) : null}
        </button>
      </div>

      {/* Trigger bar - always visible at the bottom of the rail. The
          DM unread badge moved to the dedicated messenger icon above;
          the Tools trigger stays uncluttered. Height locked to match
          the identity/envelope row. */}
      <button
        type="button"
        data-tour="menu-button"
        onClick={() => setDrawerOpen((v) => !v)}
        title="Open the menu"
        className={`mt-1 flex h-9 w-full items-center justify-center gap-2 rounded border border-keep-rule text-xs font-semibold uppercase tracking-widest lg:h-7 ${
          drawerOpen ? "bg-keep-banner" : "bg-keep-bg hover:bg-keep-banner"
        }`}
      >
        <span aria-hidden>{drawerOpen ? "▼" : "▲"}</span>
        Menu
      </button>

      {/* Create-character name prompt. On success switch into the new
          character (by id, so a name with a non-breaking space still
          resolves) and open its profile editor so the user lands in
          setup immediately. */}
      {createCharOpen ? (
        <CreateCharacterModal
          onCancel={() => setCreateCharOpen(false)}
          onCreated={(c) => {
            setCreateCharOpen(false);
            // Append to the cached roster so the new identity shows on
            // the next dropdown open without waiting for a refetch.
            setCharacters((prev) =>
              prev ? [...prev, { id: c.id, name: c.name, avatarUrl: c.avatarUrl }] : [{ id: c.id, name: c.name, avatarUrl: c.avatarUrl }],
            );
            onCommand(`/char switch @cid:${c.id}`);
            openEditor({ mode: "character", characterId: c.id });
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ *
 *  IdentityButton, character switcher dropdown
 *
 *  Sits above the Tools trigger and is always visible. The button's
 *  label reflects who's currently posting:
 *    - In character: the character's display name.
 *    - OOC:          "<username> OOC".
 *
 *  Clicking it pops a dropdown that lists every other character on
 *  the account as a one-tap switch. When the user is currently in
 *  character, the dropdown closes with a red "Leave Character" row
 *  that fires `/char clear`. (When already OOC there's nothing to
 *  leave, so the row is omitted.)
 *
 *  Lives in the same parent positioning context as the Tools drawer
 *  so its `absolute inset-x-0 bottom-full` panel rises out of the
 *  bottom strip just like the Tools drawer does.
 * ------------------------------------------------------------ */
function IdentityButton({
  masterName,
  activeCharacterName,
  characters,
  loading,
  open,
  onToggle,
  onClose,
  onSwitch,
  onLeave,
  onCreateCharacter,
  inCharacter,
  canIncognito,
  incognitoMode,
  onToggleIncognito,
}: {
  masterName: string | null;
  activeCharacterName: string | null;
  characters: CharacterRow[] | null;
  loading: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSwitch: (name: string) => void;
  onLeave: () => void;
  /** Open the create-character name prompt. */
  onCreateCharacter: () => void;
  inCharacter: boolean;
  /** True only for users holding the `use_ghost_mode` permission.
   *  When false the incognito row is omitted entirely so regular
   *  users can't even discover the affordance exists. */
  canIncognito: boolean;
  /** Mirrors `me.incognitoMode`, flips the button label between
   *  "Go Incognito" and "Leave Incognito" without a refetch. */
  incognitoMode: boolean;
  onToggleIncognito: () => void;
}) {
  const buttonLabel = inCharacter
    ? activeCharacterName ?? "Active character"
    : `${masterName ?? "OOC"} (OOC)`;

  // Filter the dropdown so the *currently active* character doesn't
  // appear as a switch target, switching to yourself is a no-op that
  // confuses more than it helps. Still shown when OOC (no active char).
  const switchTargets = (characters ?? []).filter(
    (c) => !inCharacter || c.name !== activeCharacterName,
  );

  return (
    <div className="relative">
      {open ? (
        <>
          {/* Same backdrop discipline as the Tools drawer, fixed
              viewport so a click anywhere outside closes the panel. */}
          <button
            type="button"
            aria-label="Close identity menu"
            onClick={onClose}
            className="fixed inset-0 z-30 bg-black/20 md:bg-black/10"
          />
          {/* Anchored to the trigger's top edge; grows upward like
              the Tools drawer. Capped so it never overflows the rail
              even when the user has 30+ characters. */}
          <div className="keep-menu-surface absolute inset-x-0 bottom-full z-40 mb-1 max-h-[calc(100dvh-14rem)] overflow-y-auto rounded border border-keep-rule bg-keep-bg shadow-2xl">
            <header className="sticky top-0 border-b border-keep-rule bg-keep-banner px-3 py-1 text-[10px] font-action uppercase tracking-[0.2em] text-keep-muted">
              Switch identity
            </header>
            {loading && switchTargets.length === 0 ? (
              <div className="px-3 py-2 text-xs italic text-keep-muted">Loading…</div>
            ) : switchTargets.length === 0 ? (
              <div className="px-3 py-2 text-xs italic text-keep-muted">
                {inCharacter
                  ? "No other characters on this account."
                  : "No characters yet, create one below."}
              </div>
            ) : (
              <ul>
                {switchTargets.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onSwitch(c.name)}
                      className="flex w-full items-center gap-2 border-b border-keep-rule/40 px-3 py-1.5 text-left text-sm hover:bg-keep-banner/40 lg:py-1"
                    >
                      <Avatar url={c.avatarUrl} name={c.name} />
                      <span className="min-w-0 flex-1 truncate text-keep-text">{c.name}</span>
                      <span aria-hidden className="shrink-0 text-keep-muted">›</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/* "Create Character" lives at the bottom of the switcher so
                it's always one tap away from the roster. Action-tinted
                (constructive) to read distinctly from the red
                "Leave Character" bail below it. Opens the name prompt,
                then switches into the new character + opens its editor. */}
            <button
              type="button"
              onClick={onCreateCharacter}
              title="Create a new character and start setting it up"
              className="flex w-full items-center justify-center gap-1 border-t border-keep-rule bg-keep-action/10 px-3 py-2 text-xs font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20 lg:py-1"
            >
              <span aria-hidden>+</span>
              <span>Create Character</span>
            </button>
            {/* "Leave Character" lives at the very bottom of the
                dropdown so the destructive option is one extra
                deliberate scroll away from the casual switch targets.
                Red tint reads as the OOC-bail action; omitted entirely
                when already OOC. */}
            {inCharacter ? (
              <button
                type="button"
                onClick={onLeave}
                title="Drop the active character and return to your master (OOC) account."
                className="flex w-full items-center justify-center gap-1 border-t border-keep-rule bg-keep-accent/10 px-3 py-2 text-xs font-semibold uppercase tracking-widest text-keep-accent hover:bg-keep-accent/20 lg:py-1"
              >
                ← Leave Character (OOC)
              </button>
            ) : null}
            {/* Incognito ("ghost") mode toggle. Only renders for users
                holding the `use_ghost_mode` permission. Lives below
                "Leave Character" because it's a staff-observation
                tool, not a routine identity switch, keeps it visually
                separate from the regular character roster above. */}
            {canIncognito ? (
              <button
                type="button"
                onClick={onToggleIncognito}
                title={incognitoMode
                  ? "Reveal yourself, the room sees you join again."
                  : "Disappear from userlists and observe rooms unseen. Mod/admin only."}
                className={`flex w-full items-center justify-center gap-1 border-t border-keep-rule px-3 py-2 text-xs font-semibold uppercase tracking-widest lg:py-1 ${
                  incognitoMode
                    ? "bg-keep-action/20 text-keep-action hover:bg-keep-action/30"
                    : "bg-keep-bg text-keep-muted hover:bg-keep-banner hover:text-keep-text"
                }`}
              >
                <span aria-hidden>👻</span>
                <span>{incognitoMode ? "Leave Incognito" : "Go Incognito"}</span>
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      <button
        type="button"
        data-tour="identity-button"
        onClick={onToggle}
        title={
          inCharacter
            ? "Switch character or return to OOC"
            : "Switch into a character"
        }
        // Height locked to h-9 mobile / lg:h-7 desktop to match the
        // adjacent envelope shortcut and the Tools trigger below.
        // Without the explicit height the row's bottom edges drift
        // apart whenever one button's content has a different font-
        // size than its siblings.
        className={`flex h-9 w-full items-center justify-center gap-2 rounded border border-keep-rule text-xs font-semibold uppercase tracking-widest lg:h-7 ${
          open
            ? "bg-keep-banner"
            : inCharacter
              ? "bg-keep-action/10 text-keep-action hover:bg-keep-action/20"
              : "bg-keep-bg hover:bg-keep-banner"
        }`}
      >
        <span aria-hidden>{open ? "▼" : "▲"}</span>
        <span className="min-w-0 truncate">{buttonLabel}</span>
      </button>
    </div>
  );
}

/** Tiny circular avatar / initials fallback for the switcher rows. */
function Avatar({ url, name }: { url: string | null; name: string }) {
  const [errored, setErrored] = useState(false);
  const initials = name
    .split(/[  \-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";
  return (
    <span
      className="relative inline-block h-6 w-6 shrink-0 overflow-hidden rounded border border-keep-rule bg-keep-banner"
    >
      {url && !errored ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setErrored(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-keep-muted">
          {initials}
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------ *
 *  Drawer building blocks
 *
 *  The drawer renders as a vertical dropdown, section headers in a
 *  banner-tinted strip, then each option as a full-width row with a
 *  primary label and a smaller hint underneath. Matches the mobile-
 *  navigation pattern the rest of the app uses (single column,
 *  generous tap targets, theme-agnostic separators). The previous
 *  grid-of-buttons layout collapsed awkwardly on narrow widths and
 *  did not play well with the medieval/modern/scifi ornament styles
 *  (each style draws its own border treatment around `keep-frame`
 *  surfaces; a row-based list reads consistently across all three
 *  because the visual unit is the divider, not a bordered tile).
 * ------------------------------------------------------------ */

/**
 * Collapsible accordion section. The header is a full-width tap target
 * (icon + title + optional badge + open/closed chevron) styled like the
 * old divider strip; its rows render only while `open`. The drawer keeps
 * at most one section open at a time (the parent owns that state), so the
 * menu reads as a short list of categories until you drill into one.
 *
 * `innerRef` exposes the section's root element to the parent so it can
 * scroll a freshly-opened section into view.
 */
function Section({
  title,
  icon,
  open,
  onToggle,
  innerRef,
  badge,
  children,
}: {
  title: string;
  icon: ReactNode;
  open: boolean;
  onToggle: () => void;
  innerRef?: (el: HTMLDivElement | null) => void;
  /** Optional count shown on the collapsed header so an unread/pending
   *  cue (forum notifications, messages) is visible without expanding. */
  badge?: number;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div ref={innerRef}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 border-y border-keep-rule/60 px-3 py-1.5 text-[10px] font-action uppercase tracking-[0.2em] lg:py-1 ${
          open
            ? "bg-keep-banner/70 text-keep-text"
            : "bg-keep-banner/40 text-keep-muted hover:bg-keep-banner/60 hover:text-keep-text"
        }`}
      >
        <span aria-hidden className="shrink-0">{icon}</span>
        <span className="flex-1 text-left">{title}</span>
        {/* Collapsed-header cue: surface the count so it's visible without
            opening the section. Hidden while open (the rows inside carry
            their own badges). */}
        {!open && badge && badge > 0 ? (
          <span className="shrink-0 rounded-full bg-keep-action px-1.5 py-0 text-[10px] font-semibold leading-tight text-keep-bg">
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
        <span aria-hidden className="shrink-0 text-sm leading-none">{open ? "▾" : "▸"}</span>
      </button>
      {open ? <div className={reduceMotion ? "tk-slide-down-in" : undefined}>{children}</div> : null}
    </div>
  );
}

/**
 * Wrapper for the inline forms / pickers that drop down beneath
 * their trigger row (mood, scene, find, private-room, color,
 * refresh). Adds a subtle indent + padded surface so the form
 * visually nests under the row above instead of butting against
 * the next divider. Pure visual containment, the form components
 * own their own internal layout.
 */
function InlinePanel({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <div className={`border-b border-keep-rule/40 bg-keep-banner/20 px-3 py-2${reduceMotion ? " tk-slide-down-in" : ""}`}>
      {children}
    </div>
  );
}

/**
 * A single dropdown row. Full-width, left-aligned label. The `hint`
 * surfaces as a native browser tooltip on hover/focus rather than
 * sitting under the label, keeps the menu compact enough to fit on
 * one screen without scrolling, while still being self-documenting
 * for users who pause over a row. Hover paints the row with the
 * panel-banner tint so the theme's accent color is reserved for
 * the active / pressed state.
 */
function MenuItem({
  label,
  hint,
  onClick,
  active,
  badge,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  active?: boolean;
  /**
   * Optional unread-count badge. Falsy / zero / negative hides the pill;
   * counts above 99 collapse to "99+" to avoid blowing out the row.
   */
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      // py-1.5 on mobile keeps a usable thumb target while staying
      // compact; md+ tightens to py-1. Border on the bottom only so
      // adjacent rows visually fuse into a single list. Active rows
      // get a left accent stripe + banner tint instead of a full
      // background swap, preserves row text contrast across themes.
      className={`flex w-full items-center gap-3 border-b border-keep-rule/40 px-3 py-1.5 text-left text-sm lg:py-1 ${
        active
          ? "border-l-2 border-l-keep-action bg-keep-banner/60 pl-[10px]"
          : "hover:bg-keep-banner/40"
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-keep-text">{label}</span>
      {badge && badge > 0 ? (
        <span className="shrink-0 rounded-full bg-keep-action px-1.5 py-0 text-[10px] font-semibold text-keep-bg">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
      <span aria-hidden className="shrink-0 text-keep-muted">
        {active ? "▾" : "›"}
      </span>
    </button>
  );
}

/**
 * A single forum quick-bookmark row beneath the Forums actions. Compact
 * and indented (pl-6) so the list reads as shortcuts nested under "Forums
 * Catalog" / "Create a Forum" rather than as peer menu rows. Shows the
 * forum's logo (or initials), its name, an owner tag for forums you tend,
 * and an unseen dot when there's been activity since your last visit.
 */
function ForumBookmarkRow({ forum, onClick }: { forum: ForumSummary; onClick: () => void }) {
  const isOwner = forum.viewerRole === "owner";
  return (
    <button
      type="button"
      onClick={onClick}
      title={forum.tagline ?? `Open ${forum.name}`}
      className="flex w-full items-center gap-2 border-b border-keep-rule/40 py-1.5 pl-6 pr-3 text-left text-sm hover:bg-keep-banner/40 lg:py-1"
    >
      <Avatar url={forum.logoUrl} name={forum.name} />
      <span className="min-w-0 flex-1 truncate text-keep-text">{forum.name}</span>
      {isOwner ? (
        <span className="shrink-0 rounded border border-keep-rule px-1 text-[9px] font-action uppercase tracking-wider text-keep-muted">
          Owner
        </span>
      ) : null}
      {forum.unseen ? (
        <span
          aria-hidden
          title="New activity since your last visit"
          className="h-2 w-2 shrink-0 rounded-full bg-keep-accent"
        />
      ) : null}
      <span aria-hidden className="shrink-0 text-keep-muted">›</span>
    </button>
  );
}

/**
 * One archived-room row in the "My Rooms" section. The main (left) area is the
 * Recreate action — clicking fires `/go <name>`, which resurrects the room
 * with its original settings (a private room returns private with its
 * original password) and joins it. A trailing "X" hides the room from this
 * list (non-destructive; for a typo room you never meant to make) — the
 * archived room is untouched and can be recreated any time with /go. A lock
 * glyph marks private rooms; the topic, when set, rides along as a muted
 * subtitle so a user with several archived rooms can tell them apart.
 *
 * It's a flex of two sibling <button>s (not nested — invalid HTML): the
 * Recreate target takes the slack, the X sits flush at the right.
 */
function ArchivedRoomRow({ room, onRecreate, onHide }: { room: ArchivedRoomBrief; onRecreate: () => void; onHide: () => void }) {
  return (
    <div className="flex w-full items-center border-b border-keep-rule/40">
      <button
        type="button"
        onClick={onRecreate}
        title={
          room.type === "private"
            ? `Recreate and join ${room.name} (returns private with its original password)`
            : `Recreate and join ${room.name}`
        }
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-6 pr-2 text-left text-sm hover:bg-keep-banner/40 lg:py-1"
      >
        {room.type === "private" ? (
          <Lock size={12} aria-hidden className="shrink-0 text-keep-muted" />
        ) : null}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-keep-text">{room.name}</span>
          {room.topic ? (
            <span className="ml-1.5 truncate text-xs text-keep-muted">- {room.topic}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[10px] font-action uppercase tracking-wider text-keep-muted">
          <RotateCcw size={12} aria-hidden />
          Recreate
        </span>
      </button>
      <button
        type="button"
        onClick={onHide}
        title={`Remove ${room.name} from this list, doesn't delete it; recreate any time with /go`}
        aria-label={`Remove ${room.name} from your rooms list`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-keep-muted hover:bg-keep-banner/60 hover:text-keep-text"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

function InlineForm({
  placeholder,
  submitLabel,
  onSubmit,
  extraButtons,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (text: string) => void;
  extraButtons?: Array<{ label: string; onClick: () => void }>;
}) {
  const [text, setText] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(text);
    setText("");
  }
  return (
    <form onSubmit={submit} className="space-y-1 rounded border border-keep-rule/60 bg-keep-banner/30 p-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-xs outline-none focus:border-keep-action lg:py-1"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      <div className="flex gap-1">
        <button
          type="submit"
          className="keep-button flex-1 rounded border border-keep-rule bg-keep-banner px-2 py-1.5 text-xs hover:bg-keep-banner/80 lg:py-1"
        >
          {submitLabel}
        </button>
        {extraButtons?.map((b) => (
          <button
            key={b.label}
            type="button"
            onClick={b.onClick}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-xs hover:bg-keep-banner lg:py-1"
          >
            {b.label}
          </button>
        ))}
      </div>
    </form>
  );
}

function PrivateForm({ onSubmit }: { onSubmit: (name: string, password: string) => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !password.trim()) return;
    onSubmit(name.trim(), password.trim());
    setName("");
    setPassword("");
  }
  return (
    <form onSubmit={submit} className="space-y-1 rounded border border-keep-rule/60 bg-keep-banner/30 p-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="room name"
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-xs outline-none focus:border-keep-action lg:py-1"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      <input
        type="text"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="password"
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-xs outline-none focus:border-keep-action lg:py-1"
      />
      <button
        type="submit"
        disabled={!name.trim() || !password.trim()}
        className="keep-button w-full rounded border border-keep-rule bg-keep-banner px-2 py-1.5 text-xs hover:bg-keep-banner/80 disabled:opacity-50 lg:py-1"
      >
        Create room
      </button>
    </form>
  );
}

const PRESETS = [
  "#990000", "#cc6600", "#cc9900", "#669933",
  "#006699", "#003366", "#663399", "#660033",
  "#333333", "#666666",
];

const REFRESH_PRESETS: Array<{ label: string; value: number }> = [
  { label: "Now (one-shot)", value: -1 },
  { label: "Every 10s", value: 10 },
  { label: "Every 30s", value: 30 },
  { label: "Every 60s", value: 60 },
  { label: "Every 5m", value: 300 },
];

function RefreshPicker({ current, onPick }: { current: number; onPick: (n: number) => void }) {
  const [custom, setCustom] = useState("");
  return (
    <div className="rounded border border-keep-rule/60 bg-keep-banner/30 p-2 text-xs">
      {current > 0 ? (
        <div className="mb-1 text-keep-muted">currently every {current}s</div>
      ) : null}
      <div className="mb-1.5 text-[10px] leading-snug text-keep-muted">
        Pauses the real-time userlist + typing churn and resyncs on this schedule — eases load on a slower device. Chat messages stay live.
      </div>
      <ul className="mb-1 space-y-0.5">
        {REFRESH_PRESETS.map((p) => (
          <li key={p.label}>
            <button
              type="button"
              onClick={() => onPick(p.value)}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-left hover:bg-keep-banner lg:py-1"
            >
              {p.label}
            </button>
          </li>
        ))}
      </ul>
      <div className="mb-1 flex items-center gap-1">
        <input
          type="number"
          min={5}
          max={3600}
          step={1}
          placeholder="seconds"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="flex-1 rounded border border-keep-rule px-2 py-1.5 lg:py-1"
        />
        <button
          type="button"
          onClick={() => {
            const n = parseInt(custom, 10);
            if (Number.isFinite(n) && n >= 5 && n <= 3600) onPick(n);
          }}
          className="rounded border border-keep-rule bg-keep-banner px-2 py-1.5 hover:bg-keep-banner/80 lg:py-1"
        >
          Set
        </button>
      </div>
      <button
        type="button"
        onClick={() => onPick(0)}
        className="w-full rounded border border-keep-rule bg-keep-bg py-1.5 hover:bg-keep-banner lg:py-1"
      >
        Off
      </button>
    </div>
  );
}

function ColorPicker({ onPick, onClear }: { onPick: (hex: string) => void; onClear: () => void }) {
  const [custom, setCustom] = useState("#990000");
  return (
    <div className="rounded border border-keep-rule/60 bg-keep-banner/30 p-2 text-xs">
      <div className="mb-1 grid grid-cols-5 gap-1">
        {PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            className="h-7 w-full rounded border border-keep-rule lg:h-5"
            style={{ backgroundColor: c }}
            aria-label={c}
            title={c}
          />
        ))}
      </div>
      <div className="flex items-center gap-1">
        <input
          type="color"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="h-8 w-10 cursor-pointer border border-keep-rule lg:h-6 lg:w-8"
        />
        <input
          type="text"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className="flex-1 rounded border border-keep-rule px-2 py-1.5 font-mono lg:py-1"
          maxLength={7}
        />
        <button
          type="button"
          onClick={() => onPick(custom)}
          className="rounded border border-keep-rule bg-keep-banner px-2 py-1.5 hover:bg-keep-banner/80 lg:py-1"
        >
          Set
        </button>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="keep-button mt-1 w-full rounded border border-keep-rule bg-keep-bg py-1.5 hover:bg-keep-banner lg:py-1"
      >
        Clear
      </button>
    </div>
  );
}
