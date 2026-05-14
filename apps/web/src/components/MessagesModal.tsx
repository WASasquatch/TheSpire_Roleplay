import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  DirectConversationSummary,
  DirectMessage,
  DirectMessageHistoryPage,
  InboxIdentityCount,
} from "@thekeep/shared";
import { Modal } from "./Modal.js";
import { useChat } from "../state/store.js";
import { readError, withIdentityQuery } from "../lib/http.js";
import { parseInline } from "../lib/markdown.js";
import { FormattingToolbar } from "./FormattingToolbar.js";
import { SynonymPopup } from "./SynonymPopup.js";
import { UsernameAutocomplete } from "./UsernameAutocomplete.js";

interface Props {
  onClose: () => void;
  /** Slash-command dispatcher for /friend, /accept, /decline, /unfriend. */
  onCommand: (text: string) => void;
  /**
   * Optional pre-selected user id — when the modal opens, this user's
   * thread is shown immediately. Used by the "💬 Message" button on
   * profiles. Null/undefined opens to the empty-state.
   */
  initialOtherUserId?: string | null;
}

interface FriendListEntry {
  userId: string;
  username: string;
  /**
   * The friend's character id on this friendship row, or null when
   * the row is OOC-pinned. Drives the @handle display + the
   * `targetCharacterId` we seed onto a brand-new DM thread so the
   * conversation is created against the right identity.
   */
  characterId: string | null;
  displayName: string;
  /** Character name when characterId is set; master username otherwise. */
  handle: string;
  avatarUrl: string | null;
  online: boolean;
}

interface FriendRequestEntry {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Sender's character id on this request; null = they sent it as their master/OOC handle. */
  frienderCharacterId: string | null;
  /** My (receiver) character id when the request was fetched; null = OOC inbox. */
  friendedCharacterId: string | null;
  createdAt: number;
}

/** Stable empty array sentinel — see Zustand selector notes elsewhere. */
const NO_DM_MESSAGES: DirectMessage[] = [];

const PAGE_SIZE = 50;

/**
 * Unified Messages modal. Replaces the old standalone FriendsModal,
 * DmListModal, and DmFloatingPanel — the three felt fragmented and
 * the user couldn't tell which one to open for what. This is the
 * single surface:
 *
 *   ┌───────────┬───────────────────┐
 *   │ INBOX     │ ▼ Header (other) │
 *   │ ─────     │ ─────────────────│
 *   │ Friends   │                   │
 *   │ Recents   │  message list     │
 *   │ Compose…  │                   │
 *   │ Add Frd…  │ ─────────────────│
 *   │           │  Composer         │
 *   └───────────┴───────────────────┘
 *
 * Left pane sections:
 *   - Pending friend requests (only when count > 0) with Accept /
 *     Decline buttons.
 *   - Friends (accepted, mutual) with online dot + last message
 *     preview if a conversation exists.
 *   - Recent conversations with non-friends (anyone you've DM'd who
 *     isn't a mutual friend).
 *   - Inline add-friend form (dispatches /friend).
 *   - Inline compose form for messaging a non-friend by username.
 *
 * Right pane: selected conversation. Loads history, sends messages,
 * marks read. Empty state when nothing's selected.
 *
 * Mobile: at <md the left list takes the full modal; selecting a
 * conversation slides the thread pane in (with a Back chevron in
 * its header). Desktop shows both side-by-side.
 */
export function MessagesModal({ onClose, onCommand, initialOtherUserId }: Props) {
  const me = useChat((s) => s.me);
  const dmConversations = useChat((s) => s.dmConversations);
  const setDmConversations = useChat((s) => s.setDmConversations);
  const setDmMessages = useChat((s) => s.setDmMessages);
  const appendDmMessage = useChat((s) => s.appendDmMessage);
  const upsertDmConversation = useChat((s) => s.upsertDmConversation);
  const setOpenDmOtherUser = useChat((s) => s.setOpenDmOtherUser);
  // Pending requests come from the store so accept/decline in *any*
  // surface (this inbox, the chat-level prompts, or the DM thread's
  // bottom banner) clears every other surface in one shot. Previously
  // the modal kept its own copy and would diverge — accepting from
  // the inbox left the chat prompt and the DM banner stuck.
  const pendingFriendRequests = useChat((s) => s.pendingFriendRequests);
  const setPendingFriendRequests = useChat((s) => s.setPendingFriendRequests);
  const removePendingFriendRequest = useChat((s) => s.removePendingFriendRequest);

  const [friends, setFriends] = useState<FriendListEntry[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(initialOtherUserId ?? null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Mobile pane switch — only one of "list" or "thread" is visible at <md.
  // Pre-pick "thread" when the modal opens with a user selected so the
  // mobile user lands directly in the conversation.
  const [mobileView, setMobileView] = useState<"list" | "thread">(
    initialOtherUserId ? "thread" : "list",
  );

  /**
   * Width of the left (list) column on md+ viewports. Default tuned to
   * roughly the inbox-list proportion you'd see in Discord / Messenger
   * (about a quarter of a 1100px modal). Persisted to localStorage so
   * a user's drag-resize sticks across reopens. Mobile ignores this
   * entirely — the left pane goes full-width via flex-1 when it's
   * the only visible pane.
   */
  const LIST_WIDTH_MIN = 220;
  const LIST_WIDTH_MAX = 560;
  const LIST_WIDTH_DEFAULT = 280;
  const LIST_WIDTH_STORAGE_KEY = "messagesModal:listWidth";
  const [listWidth, setListWidth] = useState<number>(() => {
    if (typeof window === "undefined") return LIST_WIDTH_DEFAULT;
    try {
      const raw = window.localStorage.getItem(LIST_WIDTH_STORAGE_KEY);
      if (!raw) return LIST_WIDTH_DEFAULT;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return LIST_WIDTH_DEFAULT;
      return Math.max(LIST_WIDTH_MIN, Math.min(LIST_WIDTH_MAX, n));
    } catch {
      return LIST_WIDTH_DEFAULT;
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(LIST_WIDTH_STORAGE_KEY, String(listWidth)); } catch { /* private mode */ }
  }, [listWidth]);

  /**
   * Pointer-drag resize for the divider between the list and the
   * thread pane. We capture the pointer so a fast drag past the
   * divider's bounds keeps tracking. Touch + mouse both go through
   * the unified Pointer Events API; cursor + hover affordance
   * `cursor-col-resize` on the divider element.
   */
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: listWidth };
  }
  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const delta = e.clientX - dragRef.current.startX;
    const next = Math.max(
      LIST_WIDTH_MIN,
      Math.min(LIST_WIDTH_MAX, dragRef.current.startWidth + delta),
    );
    setListWidth(next);
  }
  function onResizeEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
  }
  // Add-friend / compose form drafts.
  const [addDraft, setAddDraft] = useState("");
  const [composeDraft, setComposeDraft] = useState("");
  // Inline status strips shown right under each form. Cleared
  // automatically after a few seconds so the strip doesn't shout
  // forever after a successful submit; errors stick until the next
  // edit or submit so the user can read them at leisure.
  type FormStatus = { kind: "ok" | "info" | "error"; text: string } | null;
  const [addStatus, setAddStatus] = useState<FormStatus>(null);
  const [composeStatus, setComposeStatus] = useState<FormStatus>(null);
  useEffect(() => {
    if (!addStatus || addStatus.kind === "error") return;
    const t = window.setTimeout(() => setAddStatus(null), 4000);
    return () => window.clearTimeout(t);
  }, [addStatus]);
  useEffect(() => {
    if (!composeStatus || composeStatus.kind === "error") return;
    const t = window.setTimeout(() => setComposeStatus(null), 4000);
    return () => window.clearTimeout(t);
  }, [composeStatus]);

  // Pull the active character id from the store so identity-scoped
  // fetches default to the right inbox. Used as the SEED for the
  // modal-local filter below — a chip click in the switcher can take
  // the filter elsewhere without touching the user's global voice.
  const activeCharacterId = useChat((s) => s.activeCharacterId);

  /**
   * Inbox filter id, modal-local. Drives which identity's friends /
   * DMs / friend-requests show in the left pane and which identity the
   * thread send routes through. Defaults to the user's global active
   * character so the modal opens to the "current voice" inbox, but the
   * chip switcher at the top of the list can override it without
   * firing `me:switch-character` — that's the design choice from the
   * spec: switching chips ONLY refilters the inbox.
   *
   * When the user changes their global active character externally
   * (the /char dropdown, a slash command, another tab), we mirror that
   * change into the filter — the assumption is that any global switch
   * is also what they want to see in their messages.
   */
  const [inboxFilterCharId, setInboxFilterCharId] = useState<string | null>(activeCharacterId);
  useEffect(() => {
    setInboxFilterCharId(activeCharacterId);
  }, [activeCharacterId]);

  /**
   * The character roster used to render the switcher chips. Fetched
   * once per modal open from `/characters` (the same endpoint the
   * Identity tool panel uses). Includes only the caller's non-deleted
   * characters; master / OOC is rendered as the first chip from a
   * fixed sentinel, not from this list.
   */
  interface CharChipRow { id: string; name: string; avatarUrl: string | null }
  const [myCharacters, setMyCharacters] = useState<CharChipRow[]>([]);
  /**
   * Per-identity unread counts (DMs + pending friend requests) keyed
   * on characterId (null = master). Refreshed alongside the inbox
   * lists so the chip badges stay in sync with what the list shows.
   */
  const [inboxCounts, setInboxCounts] = useState<Map<string | null, InboxIdentityCount>>(() => new Map());

  /** Refetch the left-pane lists (friends + requests + conversations). */
  const refreshLists = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const [fr, fq, dm] = await Promise.all([
        fetch(withIdentityQuery("/me/friends", inboxFilterCharId), { credentials: "include" }),
        fetch(withIdentityQuery("/me/friend-requests", inboxFilterCharId), { credentials: "include" }),
        fetch(withIdentityQuery("/me/dms", inboxFilterCharId), { credentials: "include" }),
      ]);
      if (!fr.ok && fr.status !== 401) throw new Error(await readError(fr));
      if (!fq.ok && fq.status !== 401) throw new Error(await readError(fq));
      if (!dm.ok && dm.status !== 401) throw new Error(await readError(dm));
      const friendsJson = fr.ok ? ((await fr.json()) as { friends: FriendListEntry[] }) : { friends: [] };
      const reqJson = fq.ok ? ((await fq.json()) as { requests: FriendRequestEntry[] }) : { requests: [] };
      const dmJson = dm.ok ? ((await dm.json()) as { conversations: DirectConversationSummary[] }) : { conversations: [] };
      setFriends(friendsJson.friends);
      // Pending requests go straight into the store so every surface
      // (this inbox, the chat prompts, the DM banner) sees the same
      // list. Local component state is no longer involved.
      setPendingFriendRequests(reqJson.requests);
      setDmConversations(dmJson.conversations);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoadingList(false);
    }
  }, [setDmConversations, setPendingFriendRequests, inboxFilterCharId]);

  useEffect(() => {
    refreshLists();
  }, [refreshLists, refreshKey]);

  /**
   * Inbox counts feed the per-identity chip badges. Kept on a separate
   * fetch from refreshLists so we can refresh just the counts whenever
   * the global DM/friend state changes (dm:new or friend:request from
   * the socket) — refreshLists would loop because it owns the same
   * store fields it'd be reacting to. The counts endpoint returns
   * every identity I own, regardless of the inbox filter, so the chips
   * keep showing badges for unread on the OTHER characters too.
   */
  useEffect(() => {
    let cancelled = false;
    fetch("/me/inbox-counts", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j || !Array.isArray(j.counts)) return;
        const m = new Map<string | null, InboxIdentityCount>();
        for (const row of j.counts as InboxIdentityCount[]) m.set(row.characterId, row);
        setInboxCounts(m);
      })
      .catch(() => { /* badges are non-critical */ });
    return () => { cancelled = true; };
  }, [dmConversations, pendingFriendRequests, refreshKey]);

  // Re-fire refreshLists whenever the inbox filter changes — Char A
  // and Char B keep separate friends + DM inboxes, so flipping
  // chips (or following a global /char switch) should swap the
  // visible lists.
  useEffect(() => {
    setRefreshKey((v) => v + 1);
    // Drop any selected conversation; the new identity might not be
    // a participant on it. (Re-selecting after refresh shows the new
    // inbox's most recent conversation via auto-open.)
    setSelectedUserId(null);
    autoOpenAttempted.current = false;
  }, [inboxFilterCharId]);

  // One-shot character roster fetch for the switcher chips. The roster
  // changes rarely (only when the user creates/renames/deletes a
  // character) so refetching on every refreshKey would be wasteful;
  // the rare add/rename case is caught when the modal reopens.
  useEffect(() => {
    let cancelled = false;
    fetch("/characters", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j || !Array.isArray(j.characters)) return;
        setMyCharacters(j.characters.map((c: { id: string; name: string; avatarUrl: string | null }) => ({
          id: c.id, name: c.name, avatarUrl: c.avatarUrl,
        })));
      })
      .catch(() => { /* roster is non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  /**
   * Auto-open the most recently active conversation when the modal
   * opens without an explicit target. Matches the user mental model
   * of "open Messages and pick up where I left off" — same as the
   * Discord/Messenger first-paint. Skipped when:
   *   - The modal was opened with `initialOtherUserId` (profile DM
   *     button has already picked the target).
   *   - The user has already manually selected something this session.
   *   - No conversations exist yet (empty state stays empty).
   * Triggers only on the transition from null → first-known recency,
   * so re-renders that don't change the conversation set don't
   * stomp the user's later picks.
   */
  const autoOpenAttempted = useRef(false);
  useEffect(() => {
    if (autoOpenAttempted.current) return;
    if (selectedUserId !== null) return;
    const convs = Object.values(dmConversations);
    if (convs.length === 0) return;
    autoOpenAttempted.current = true;
    const mostRecent = convs.reduce((best, c) =>
      c.lastMessageAt > best.lastMessageAt ? c : best,
    );
    setSelectedUserId(mostRecent.otherUserId);
    // Don't flip mobile to "thread" — on phones the user explicitly
    // tapped Messages and probably wants the inbox view first. Desktop
    // shows both panes anyway, so the auto-selection just highlights
    // the row and seeds the right pane.
  }, [dmConversations, selectedUserId]);

  /**
   * Compose the unified list shown in the left pane. Order:
   *   1. Friends (alphabetical, online first)
   *   2. Recent non-friend conversations (by lastMessageAt desc)
   * Conversation metadata (last preview, unread, online) is folded
   * onto matching friend rows so the user sees one entry per person.
   */
  const friendIds = useMemo(() => new Set(friends.map((f) => f.userId)), [friends]);
  const convByOther = useMemo(() => {
    const m = new Map<string, DirectConversationSummary>();
    for (const c of Object.values(dmConversations)) m.set(c.otherUserId, c);
    return m;
  }, [dmConversations]);
  const friendRows = friends.map((f) => ({
    kind: "friend" as const,
    userId: f.userId,
    username: f.username,
    // The friend's pinned character id on this friendship — drives
    // both the @handle display (character name when set) and the
    // `targetCharacterId` we seed onto a brand-new DM thread so the
    // first message lands in the right per-identity inbox.
    characterId: f.characterId,
    displayName: f.displayName,
    handle: f.handle,
    avatarUrl: f.avatarUrl,
    online: f.online,
    conv: convByOther.get(f.userId) ?? null,
  }));
  const nonFriendConvRows = useMemo(() => Object.values(dmConversations)
    .filter((c) => !friendIds.has(c.otherUserId))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .map((c) => ({
      kind: "conv" as const,
      userId: c.otherUserId,
      username: c.otherUsername,
      // Same per-identity pinning as friend rows. `otherCharacterId`
      // comes off the conversation row and may be null when the
      // thread is OOC-pinned.
      characterId: c.otherCharacterId,
      displayName: c.otherDisplayName,
      handle: c.otherCharacterId ? c.otherDisplayName : c.otherUsername,
      avatarUrl: c.otherAvatarUrl,
      online: c.otherOnline,
      conv: c,
    })),
  [dmConversations, friendIds]);

  function selectUser(userId: string) {
    setSelectedUserId(userId);
    setMobileView("thread");
  }

  /**
   * Whenever the selection (manual or auto-open) changes, mirror it
   * into the store's `openDmOtherUserId` so the App-level `dm:new`
   * handler can tell "user is staring at this conversation right now"
   * and skip the unread bump. Also locally reset that conversation's
   * unreadCount to 0 — the server-side /read POST in ThreadPane fires
   * separately, but resetting the badge optimistically here keeps the
   * UI from showing a stale count for the half-second between mount
   * and the POST round-trip.
   *
   * Cleanup on unmount clears the store flag so a stale tab doesn't
   * keep claiming to view a conversation it's no longer showing.
   */
  useEffect(() => {
    setOpenDmOtherUser(selectedUserId);
    if (selectedUserId !== null) {
      const conv = Object.values(useChat.getState().dmConversations)
        .find((c) => c.otherUserId === selectedUserId);
      if (conv && conv.unreadCount > 0) {
        upsertDmConversation({ ...conv, unreadCount: 0 });
      }
    }
    return () => { setOpenDmOtherUser(null); };
  }, [selectedUserId, setOpenDmOtherUser, upsertDmConversation]);

  // Accept/decline route through identity-keyed endpoints, NOT the
  // `/accept <name>` / `/decline <name>` slash commands. Reason:
  // `resolveIdentityByName` on the server resolves master-first, so a
  // request whose sender was on a character with the same name as a
  // master account never matched the row — the row stayed pending and
  // the UI looped on a banner that wouldn't clear. The new endpoints
  // operate on the exact (frienderUserId, frienderCharacterId,
  // friendedCharacterId) tuple carried in the inbox payload, so no
  // name disambiguation is needed.
  async function acceptRequest(r: FriendRequestEntry) {
    // Optimistic removal: every surface (this inbox, the chat-level
    // prompt card, the DM thread's bottom banner) reads from the
    // shared pendingFriendRequests store, so dropping the row here
    // clears them all in one render.
    removePendingFriendRequest(r.userId);
    try {
      await fetch(`/me/friend-requests/${encodeURIComponent(r.userId)}/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frienderCharacterId: r.frienderCharacterId ?? undefined,
          characterId: r.friendedCharacterId ?? undefined,
        }),
      });
    } catch { /* refresh below will resync */ }
    window.setTimeout(() => setRefreshKey((v) => v + 1), 200);
  }
  async function declineRequest(r: FriendRequestEntry) {
    removePendingFriendRequest(r.userId);
    try {
      await fetch(`/me/friend-requests/${encodeURIComponent(r.userId)}/decline`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frienderCharacterId: r.frienderCharacterId ?? undefined,
          characterId: r.friendedCharacterId ?? undefined,
        }),
      });
    } catch { /* refresh below will resync */ }
    window.setTimeout(() => setRefreshKey((v) => v + 1), 200);
  }
  function removeFriend(f: FriendListEntry) {
    if (!window.confirm(`Remove ${f.displayName} from your friends list?`)) return;
    onCommand(`/unfriend ${f.username}`);
    window.setTimeout(() => setRefreshKey((v) => v + 1), 500);
  }
  /**
   * Submit the add-friend form. Hits POST /me/friend-requests instead
   * of dispatching the slash command so we get a structured success/
   * error response — the slash-command path emits its result as a
   * room system message, which the modal can't easily surface inline.
   *
   * The status messages map onto the four distinct server responses:
   *   - sent             → "Friend request sent to <name>."
   *   - accepted         → "You and <name> are now friends." (they had asked us first)
   *   - already_pending  → "Request to <name> is still pending."
   *   - already_friends  → "You and <name> are already friends."
   * Errors:
   *   - 404 no_user      → "No user named <name>."
   *   - 400 self         → "Can't friend yourself."
   */
  async function sendFriendRequest(e: FormEvent) {
    e.preventDefault();
    const name = addDraft.trim();
    if (!name) return;
    setAddStatus({ kind: "info", text: "Sending…" });
    try {
      const r = await fetch("/me/friend-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: name,
          // Friend FROM my active identity. When I'm in character, this
          // is the character; when OOC, omitted = master.
          characterId: inboxFilterCharId ?? undefined,
        }),
      });
      const j = await r.json().catch(() => ({} as { error?: string; status?: string; username?: string }));
      if (!r.ok) {
        const msg =
          j.error === "no_user" ? `No user named "${name}".`
          : j.error === "self" ? "You can't friend yourself."
          : j.error ?? "Friend request failed.";
        setAddStatus({ kind: "error", text: msg });
        return;
      }
      const target = j.username ?? name;
      const ok =
        j.status === "accepted" ? `You and ${target} are now friends.`
        : j.status === "already_pending" ? `Friend request to ${target} is still pending.`
        : j.status === "already_friends" ? `You and ${target} are already friends.`
        : `Friend request sent to ${target}.`;
      setAddStatus({ kind: "ok", text: ok });
      setAddDraft("");
      // Refresh inbox so the new pending row shows up (or disappears
      // if we just auto-accepted into mutual friendship).
      setRefreshKey((v) => v + 1);
    } catch {
      setAddStatus({ kind: "error", text: "Network error — try again." });
    }
  }

  /**
   * Compose-to-nonfriend: just opens the right-pane thread for the
   * typed user. The actual conversation is created server-side on
   * first send (see DM routes). We resolve by socket profile-fetch
   * to confirm the user exists before opening the pane.
   */
  function composeToUser(e: FormEvent) {
    e.preventDefault();
    const name = composeDraft.trim();
    if (!name) return;
    setComposeStatus({ kind: "info", text: "Looking up…" });
    fetch(`/profiles/${encodeURIComponent(name)}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`No user named "${name}".`);
        const j = await r.json();
        if ("private" in j) throw new Error("That profile is private.");
        const userId = j.profile?.userId;
        if (!userId) throw new Error("Couldn't resolve user.");
        setComposeDraft("");
        setComposeStatus(null);
        selectUser(userId);
      })
      .catch((err) => setComposeStatus({
        kind: "error",
        text: err instanceof Error ? err.message : "Lookup failed.",
      }));
  }

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        onClick={(e) => e.stopPropagation()}
        // Mobile: edge-to-edge fullscreen (no border-radius, full dvh).
        // Desktop: centered card with the existing 78vw/1100px cap and
        // 85vh height. `100dvh` follows the browser's *dynamic* viewport
        // so the on-screen keyboard doesn't paint the modal off-screen
        // on iOS Safari / Chrome Android — `100vh` would.
        className="flex h-[100dvh] w-full flex-col overflow-hidden border border-keep-border bg-keep-bg shadow-xl md:h-[85vh] md:w-[78vw] md:max-w-[1100px] md:rounded"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-lg">Messages</h2>
          <button type="button" onClick={onClose} className="text-sm text-keep-muted hover:text-keep-text">
            close
          </button>
        </header>

        {/* Mobile-only tab strip. Lets users flip between the inbox
            (Friends + Recents + add forms) and the active conversation
            without relying on the per-row back-arrow inside the thread
            header. Hidden on md+ where both panes are visible at once.
            The Chat tab is disabled until a conversation is selected —
            tapping it with no selection would surface the empty-state
            pane, which is more confusing than a dimmed-out tab. */}
        <div className="flex shrink-0 border-b border-keep-rule bg-keep-banner/40 md:hidden" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === "list"}
            onClick={() => setMobileView("list")}
            className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-widest ${
              mobileView === "list"
                ? "border-b-2 border-keep-action text-keep-text"
                : "text-keep-muted hover:text-keep-text"
            }`}
          >
            Inbox
            {pendingFriendRequests.length > 0 ? (
              <span className="ml-1 inline-block rounded-full bg-keep-action px-1.5 text-[10px] font-semibold text-keep-bg">
                {pendingFriendRequests.length}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === "thread"}
            disabled={!selectedUserId}
            onClick={() => setMobileView("thread")}
            className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-widest disabled:opacity-40 ${
              mobileView === "thread"
                ? "border-b-2 border-keep-action text-keep-text"
                : "text-keep-muted hover:text-keep-text"
            }`}
          >
            Chat
          </button>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* LEFT pane — list. Hidden on mobile when thread is visible.
              The state-driven `listWidth` (set by the drag-resize
              handle) only applies on md+; on mobile the aside fills
              the full modal width. We pass the width as a CSS custom
              property so the responsive `md:w-[var(...)]` class can
              consume it — using `style={{ width }}` directly would win
              over `w-full` on mobile via specificity. */}
          <aside
            style={{ "--list-width": `${listWidth}px` } as React.CSSProperties}
            className={
              "flex min-h-0 w-full flex-col border-keep-rule md:w-[var(--list-width)] md:shrink-0 md:flex-none " +
              (mobileView === "list" ? "flex-1" : "hidden md:flex")
            }
          >
            {error ? (
              <div className="mx-3 mt-3 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
                {error}
              </div>
            ) : null}
            {/* Character switcher chips — pinned above the list so the
                row stays visible while the list scrolls. Click a chip
                to refilter the inbox by that identity (does NOT change
                your global active character / voice). Badge totals
                unread DMs + pending friend requests for that identity. */}
            <CharacterSwitcher
              characters={myCharacters}
              counts={inboxCounts}
              selectedId={inboxFilterCharId}
              onSelect={setInboxFilterCharId}
            />
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-xs">
              {/* Pending requests — sourced from the shared store so
                  accept/decline elsewhere clears this list automatically. */}
              {pendingFriendRequests.length > 0 ? (
                <div className="mb-2">
                  <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">
                    Friend requests ({pendingFriendRequests.length})
                  </div>
                  <ul className="space-y-1">
                    {pendingFriendRequests.map((r) => (
                      <li key={r.userId} className="flex items-center gap-2 rounded border border-keep-action/30 bg-keep-action/5 p-2">
                        {/* Avatar + name is now a click target: clicking
                            opens the thread pane with this user, which
                            shows the same accept/decline as a sticky
                            banner at the bottom. The ✓/× buttons stay
                            here as quick-answer shortcuts for the inbox
                            view. */}
                        <button
                          type="button"
                          onClick={() => selectUser(r.userId)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <Avatar url={r.avatarUrl} name={r.displayName} size={32} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-keep-text">{r.displayName}</span>
                            <span className="block truncate text-[10px] text-keep-muted">wants to be friends</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => acceptRequest(r)}
                          title="Accept friend request"
                          className="rounded border border-keep-action bg-keep-action/10 px-1.5 py-0.5 text-[10px] text-keep-action hover:bg-keep-action/20"
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          onClick={() => declineRequest(r)}
                          title="Decline friend request"
                          className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-[10px] text-keep-muted hover:border-keep-accent hover:text-keep-accent"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* Friends */}
              <div className="mb-2">
                <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">
                  Friends ({friendRows.length})
                </div>
                {loadingList && friendRows.length === 0 ? (
                  <div className="italic text-keep-muted">Loading...</div>
                ) : friendRows.length === 0 ? (
                  <div className="italic text-keep-muted">No friends yet.</div>
                ) : (
                  <ul className="space-y-1">
                    {friendRows.map((row) => (
                      <UserRow
                        key={row.userId}
                        row={row}
                        active={selectedUserId === row.userId}
                        onSelect={() => selectUser(row.userId)}
                        onRemove={() => removeFriend({
                          userId: row.userId,
                          username: row.username,
                          characterId: row.characterId,
                          displayName: row.displayName,
                          handle: row.handle,
                          avatarUrl: row.avatarUrl,
                          online: row.online,
                        })}
                      />
                    ))}
                  </ul>
                )}
              </div>

              {/* Non-friend recent conversations */}
              {nonFriendConvRows.length > 0 ? (
                <div className="mb-2">
                  <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">
                    Recent ({nonFriendConvRows.length})
                  </div>
                  <ul className="space-y-1">
                    {nonFriendConvRows.map((row) => (
                      <UserRow
                        key={row.userId}
                        row={row}
                        active={selectedUserId === row.userId}
                        onSelect={() => selectUser(row.userId)}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {/* Bottom forms: add friend + compose. Each input gets a
                debounced username autocomplete so users don't have to
                remember the exact spelling, and an inline status strip
                that shows the server's response (request sent, already
                friends, no such user, etc.) so submitting actually
                feels like it did something. */}
            <div className="shrink-0 space-y-2 border-t border-keep-rule/60 bg-keep-bg/50 p-3 text-xs">
              <form onSubmit={sendFriendRequest} className="flex gap-1">
                <UsernameAutocomplete
                  value={addDraft}
                  onChange={setAddDraft}
                  onPick={() => { /* keep the form open so the user can hit Enter to send */ }}
                  placeholder="add friend by username..."
                />
                <button
                  type="submit"
                  disabled={!addDraft.trim()}
                  className="rounded border border-keep-action bg-keep-action/10 px-2 py-1 text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
                >
                  + Friend
                </button>
              </form>
              {addStatus ? (
                <div
                  className={
                    "rounded border px-2 py-1 text-[11px] " +
                    (addStatus.kind === "error"
                      ? "border-keep-accent/50 bg-keep-accent/10 text-keep-accent"
                      : addStatus.kind === "ok"
                        ? "border-keep-action/50 bg-keep-action/10 text-keep-action"
                        : "border-keep-rule bg-keep-banner/40 text-keep-muted")
                  }
                >
                  {addStatus.text}
                </div>
              ) : null}
              <form onSubmit={composeToUser} className="flex gap-1">
                <UsernameAutocomplete
                  value={composeDraft}
                  onChange={setComposeDraft}
                  onPick={() => { /* same — Enter from input submits the form */ }}
                  placeholder="message non-friend..."
                />
                <button
                  type="submit"
                  disabled={!composeDraft.trim()}
                  className="rounded border border-keep-rule bg-keep-banner px-2 py-1 hover:bg-keep-banner/80 disabled:opacity-50"
                >
                  💬
                </button>
              </form>
              {composeStatus ? (
                <div
                  className={
                    "rounded border px-2 py-1 text-[11px] " +
                    (composeStatus.kind === "error"
                      ? "border-keep-accent/50 bg-keep-accent/10 text-keep-accent"
                      : composeStatus.kind === "ok"
                        ? "border-keep-action/50 bg-keep-action/10 text-keep-action"
                        : "border-keep-rule bg-keep-banner/40 text-keep-muted")
                  }
                >
                  {composeStatus.text}
                </div>
              ) : null}
            </div>
          </aside>

          {/* Draggable divider between list and thread. Desktop only —
              mobile shows one pane at a time so there's nothing to
              resize. `cursor-col-resize` + a hover tint signal that
              the strip is grabbable. We capture the pointer so a
              fast drag past the strip's bounds keeps tracking. */}
          <div
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            onDoubleClick={() => setListWidth(LIST_WIDTH_DEFAULT)}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize conversation list"
            title="Drag to resize · double-click to reset"
            className="hidden w-1 shrink-0 cursor-col-resize touch-none bg-keep-rule/40 hover:bg-keep-action/40 md:block"
          />

          {/* RIGHT pane — thread. Hidden on mobile when list is visible. */}
          <section
            className={
              "flex min-h-0 flex-col " +
              (mobileView === "thread" ? "flex-1" : "hidden md:flex md:flex-1")
            }
          >
            {selectedUserId ? (() => {
              // Resolve the friend/conv row for the selected user so we
              // can hand the pinned otherCharacterId down even when no
              // DirectConversation exists yet. Without this seed, the
              // first DM with a character-friend would create the
              // conversation against the master (OOC) side — which is
              // exactly the per-identity-partition leak the user
              // reported: clicking a character friend opened a chat
              // with their OOC account.
              const selectedRow =
                friendRows.find((r) => r.userId === selectedUserId)
                  ?? nonFriendConvRows.find((r) => r.userId === selectedUserId)
                  ?? null;
              return (
                <ThreadPane
                  otherUserId={selectedUserId}
                  fallback={selectedRow}
                  initialOtherCharacterId={selectedRow?.characterId ?? null}
                  onBack={() => setMobileView("list")}
                  appendDmMessage={appendDmMessage}
                  setDmMessages={setDmMessages}
                  meId={me?.id ?? null}
                  onCommand={onCommand}
                  myCharacterId={inboxFilterCharId}
                />
              );
            })() : (
              <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-sm italic text-keep-muted">
                Pick a friend or recent conversation to start chatting.
              </div>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}

/* ============================================================
 *  Sub-components
 * ============================================================ */

function UserRow({
  row,
  active,
  onSelect,
  onRemove,
}: {
  row: {
    userId: string;
    username: string;
    /** Pinned character id for this row, or null when OOC-pinned. */
    characterId: string | null;
    displayName: string;
    /** Character name when characterId is set; master username otherwise. */
    handle: string;
    avatarUrl: string | null;
    online: boolean;
    conv: DirectConversationSummary | null;
  };
  active: boolean;
  onSelect: () => void;
  onRemove?: () => void;
}) {
  return (
    <li
      className={
        "flex items-center gap-2 rounded border p-1.5 " +
        (active
          ? "border-keep-action bg-keep-action/10"
          : "border-keep-rule/60 bg-keep-bg hover:border-keep-action hover:bg-keep-banner/40")
      }
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Avatar url={row.avatarUrl} name={row.displayName} size={32} online={row.online} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-semibold text-keep-text">{row.displayName}</span>
            {row.conv && row.conv.unreadCount > 0 ? (
              <span className="shrink-0 rounded-full bg-keep-action px-1.5 py-0 text-[10px] font-semibold text-keep-bg">
                {row.conv.unreadCount > 99 ? "99+" : row.conv.unreadCount}
              </span>
            ) : null}
          </span>
          <span className="block truncate text-[10px] text-keep-muted">
            {row.conv?.lastMessagePreview ?? `@${row.handle}`}
          </span>
        </span>
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          title="Remove friend"
          className="shrink-0 text-[10px] text-keep-muted hover:text-keep-accent"
        >
          ×
        </button>
      ) : null}
    </li>
  );
}

function Avatar({
  url,
  name,
  size,
  online,
}: {
  url: string | null;
  name: string;
  size: number;
  online?: boolean;
}) {
  const [errored, setErrored] = useState(false);
  return (
    <span
      className="relative inline-block shrink-0 overflow-hidden rounded border border-keep-rule bg-keep-banner"
      style={{ width: size, height: size }}
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
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-keep-muted">
          {initialsFor(name)}
        </span>
      )}
      {online !== undefined ? (
        <span
          aria-hidden
          className={
            "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ring-keep-bg " +
            (online ? "bg-emerald-500" : "bg-keep-muted/60")
          }
        />
      ) : null}
    </span>
  );
}

function initialsFor(name: string): string {
  const parts = name.split(/[  \-_]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/* ============================================================
 *  Character switcher (top of inbox list)
 * ============================================================ */

/**
 * Identity picker pinned above the inbox list. Renders as a single
 * chip showing the currently-filtered identity; clicking it opens a
 * scrollable dropdown listing OOC + every character with their unread
 * badge. A horizontal chip row was the first iteration, but the
 * default per-user character cap is 100, which would overflow the
 * left pane horizontally even with scroll affordances; a dropdown
 * scales to that count without disturbing the inbox layout.
 *
 * Click semantics: per design choice, picking an identity ONLY
 * refilters the inbox in this modal — it does not call
 * `me:switch-character` or change the user's global voice. A user
 * can read Char A's messages without breaking their current in-room
 * Char B identity.
 */
function CharacterSwitcher({
  characters,
  counts,
  selectedId,
  onSelect,
}: {
  characters: { id: string; name: string; avatarUrl: string | null }[];
  counts: Map<string | null, InboxIdentityCount>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Hide the switcher entirely when the user has no characters — the
  // only option would be OOC, which is the default. Showing a
  // single-option dropdown is just noise.
  // (Hooks above must run unconditionally; this early return sits
  // *after* them so React's hook order stays stable across renders.)

  // Close on outside click / Escape so the dropdown behaves like a
  // native control. Bound only while open to avoid wasting handler
  // dispatch on every click in the modal.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (characters.length === 0) return null;

  function badgeFor(id: string | null): number {
    const c = counts.get(id);
    return (c?.unreadDms ?? 0) + (c?.pendingFriendRequests ?? 0);
  }

  // Total of every OTHER identity's badge — surfaced on the current
  // chip when the dropdown is closed so the user sees "there's traffic
  // somewhere else" at a glance without opening the menu.
  const selectedChar = selectedId ? characters.find((c) => c.id === selectedId) : null;
  const selectedLabel = selectedChar ? selectedChar.name : "OOC";
  const selectedAvatar = selectedChar ? selectedChar.avatarUrl : null;
  let otherUnread = 0;
  for (const c of characters) if (c.id !== selectedId) otherUnread += badgeFor(c.id);
  if (selectedId !== null) otherUnread += badgeFor(null);

  function row(id: string | null, label: string, avatarUrl: string | null) {
    const b = badgeFor(id);
    const active = selectedId === id;
    return (
      <button
        key={id ?? "master"}
        type="button"
        onClick={() => { onSelect(id); setOpen(false); }}
        className={
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] transition-colors " +
          (active
            ? "bg-keep-action/10 text-keep-action"
            : "text-keep-text hover:bg-keep-banner")
        }
      >
        <Avatar url={avatarUrl} name={label} size={20} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {b > 0 ? (
          <span className="rounded-full bg-keep-accent px-1.5 py-px text-[10px] font-semibold leading-none text-keep-bg">
            {b > 99 ? "99+" : b}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div ref={wrapRef} className="relative shrink-0 border-b border-keep-rule px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-[11px] text-keep-text hover:border-keep-action/60 hover:bg-keep-banner"
      >
        <Avatar url={selectedAvatar} name={selectedLabel} size={20} />
        <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
        {otherUnread > 0 ? (
          <span
            title={`${otherUnread} unread on other ${otherUnread === 1 ? "identity" : "identities"}`}
            className="rounded-full bg-keep-accent px-1.5 py-px text-[10px] font-semibold leading-none text-keep-bg"
          >
            {otherUnread > 99 ? "99+" : otherUnread}
          </span>
        ) : null}
        <span aria-hidden className="text-keep-muted">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute left-3 right-3 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded border border-keep-rule bg-keep-parchment shadow-lg"
        >
          {row(null, "OOC", null)}
          {characters.map((c) => row(c.id, c.name, c.avatarUrl))}
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
 *  Thread pane (right side)
 * ============================================================ */

function ThreadPane({
  otherUserId,
  fallback,
  initialOtherCharacterId,
  onBack,
  appendDmMessage,
  setDmMessages,
  meId,
  onCommand,
  myCharacterId,
}: {
  otherUserId: string;
  fallback: { displayName: string; avatarUrl: string | null; online: boolean } | null;
  /**
   * The friend/conv row's pinned character id for the OTHER party,
   * threaded in from the parent so the first send on a brand-new
   * thread targets the right character. Without this, opening a DM
   * with a character-friend whose conversation doesn't yet exist
   * would default `targetCharacterId` to null and create the
   * conversation against their OOC side — the per-identity partition
   * would silently leak to OOC on first contact.
   */
  initialOtherCharacterId: string | null;
  onBack: () => void;
  appendDmMessage: (msg: DirectMessage) => void;
  setDmMessages: (conversationId: string, msgs: DirectMessage[]) => void;
  meId: string | null;
  /** Dispatch slash commands (used for /accept and /decline on the pinned banner). */
  onCommand: (text: string) => void;
  /**
   * My identity for this thread — the inbox filter from the parent
   * modal, not the global activeCharacterId. The chip switcher at the
   * top of the inbox can take this somewhere different than the user's
   * global voice; the thread fetches / sends MUST follow the filter so
   * the thread you're viewing stays consistent with its pinned side.
   */
  myCharacterId: string | null;
}) {
  // Resolve conversation reactively — server creates the row on first
  // send, so it may be absent until then. NO_DM_MESSAGES is a stable
  // sentinel to prevent the Zustand selector loop bug.
  const conversation = useChat(
    (s) => Object.values(s.dmConversations).find((c) => c.otherUserId === otherUserId) ?? null,
  );
  // My identity for this thread — forwarded from the parent modal's
  // inbox filter. Drives `?characterId=` on history fetches and the
  // read-marker POST so the server scopes the thread to my pinned
  // side. Null = master OOC.
  const activeCharacterId = myCharacterId;
  // Target identity pinned to THIS thread. Existing conversations
  // carry an authoritative `otherCharacterId` from the server (the
  // pinned side of the row); fresh threads with no conversation yet
  // fall back to the friend/conv row's pinned character so the first
  // send creates the conversation against the right identity — not
  // the OOC side, which was the partition-leak the user reported.
  const targetCharacterId = conversation?.otherCharacterId ?? initialOtherCharacterId;
  const messages = useChat((s) =>
    conversation ? (s.dmMessagesByConv[conversation.id] ?? NO_DM_MESSAGES) : NO_DM_MESSAGES,
  );
  /**
   * Bumped by the socket `connect` handler in App.tsx — see store
   * comment. Watching it here lets a foregrounded ThreadPane catch
   * up on history it missed while the socket was disconnected
   * (Socket.io drops `dm:new` to offline sockets without replay).
   */
  const dmReseedTick = useChat((s) => s.dmReseedTick);
  /**
   * If the OTHER party has a pending friend request to us, surface it
   * as a pinned banner at the bottom of this thread. The full list
   * lives in the store; we only care about the one matching the
   * thread's other user — undefined when there's no pending request.
   */
  const pendingFromThisUser = useChat((s) =>
    s.pendingFriendRequests.find((r) => r.userId === otherUserId),
  );
  const removePendingFriendRequest = useChat((s) => s.removePendingFriendRequest);

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastSeenCount = useRef(messages.length);
  // Reference handed to the formatting toolbar so its wrap-with-markdown
  // buttons can read selection bounds + restore focus after each edit.
  const dmInputRef = useRef<HTMLInputElement | null>(null);

  const header = useMemo(() => {
    if (conversation) {
      return {
        displayName: conversation.otherDisplayName,
        avatarUrl: conversation.otherAvatarUrl,
        online: conversation.otherOnline,
      };
    }
    return {
      displayName: fallback?.displayName ?? "…",
      avatarUrl: fallback?.avatarUrl ?? null,
      online: fallback?.online ?? false,
    };
  }, [conversation, fallback]);

  // Seed history whenever the conversation id changes or the socket
  // reconnects (dmReseedTick bump). Two non-obvious bits:
  //
  //   1. We key the effect on `conversation?.id` (a string) rather
  //      than the `conversation` object itself. The object identity
  //      flips every time `dmConversations` is replaced — even when
  //      the conversation's *id* is unchanged — so depending on the
  //      object would cause the seed fetch to re-run on every
  //      `dm:new`-driven upsert. The id is the only thing that
  //      actually determines what to fetch.
  //
  //   2. We use AbortController for cancellation instead of a
  //      `seededFor` ref + cancelled flag. The previous ref-based
  //      gate interacted badly with React 18 StrictMode: the ref
  //      was set BEFORE the fetch resolved, so the dev-mode
  //      double-mount could end up with the ref set but no
  //      setDmMessages call (the in-flight fetch was cancelled and
  //      the remount skipped because the ref-saw-this-key). With
  //      an AbortController the cleanup truly aborts the in-flight
  //      request and the remount fires a fresh one.
  useEffect(() => {
    if (!conversation) return;
    const convId = conversation.id;
    const ac = new AbortController();
    setError(null);
    fetch(withIdentityQuery(`/me/dms/${convId}/messages?limit=${PAGE_SIZE}`, activeCharacterId), {
      credentials: "include",
      signal: ac.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return (await r.json()) as DirectMessageHistoryPage;
      })
      .then((j) => {
        // Merge — don't replace. A `dm:new` socket event could have
        // landed via `appendDmMessage` while this seed fetch was in
        // flight; replacing the buffer wholesale would wipe that
        // freshly-arrived message. Server is the source of truth
        // for older history; the buffer is the source of truth for
        // in-flight arrivals. Union by id, sort by createdAt.
        const current = useChat.getState().dmMessagesByConv[convId] ?? [];
        const seen = new Set(j.messages.map((m) => m.id));
        const extras = current.filter((m) => !seen.has(m.id));
        const merged = extras.length === 0
          ? j.messages
          : [...j.messages, ...extras].sort((a, b) => a.createdAt - b.createdAt);
        setDmMessages(convId, merged);
        setHasMore(j.hasMore);
        lastSeenCount.current = merged.length;
      })
      .catch((e: unknown) => {
        // AbortError is the cleanup path firing — not a real error.
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "load failed");
      });
    fetch(`/me/dms/${convId}/read`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upTo: Date.now(), characterId: activeCharacterId ?? undefined }),
      signal: ac.signal,
    }).catch(() => {});
    return () => { ac.abort(); };
  }, [conversation?.id, setDmMessages, dmReseedTick, activeCharacterId]);

  // Auto-scroll on new message arrivals.
  useEffect(() => {
    if (messages.length === lastSeenCount.current) return;
    lastSeenCount.current = messages.length;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/me/dms/with/${encodeURIComponent(otherUserId)}/messages`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: text,
            characterId: activeCharacterId ?? undefined,
            targetCharacterId: targetCharacterId ?? undefined,
          }),
        },
      );
      if (!r.ok) throw new Error(await readError(r));
      const j = await r.json() as { message: DirectMessage };
      // The server also fans via dm:new, but appending here lets the
      // message show instantly without waiting for the socket round-
      // trip. appendDmMessage dedupes by id, so the inbound echo is
      // a no-op.
      appendDmMessage(j.message);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    } finally {
      setBusy(false);
    }
  }, [draft, busy, otherUserId, appendDmMessage, activeCharacterId, targetCharacterId]);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-keep-rule bg-keep-banner/60 px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-1 text-keep-muted hover:text-keep-text md:hidden"
          aria-label="Back to list"
        >
          ←
        </button>
        <Avatar url={header.avatarUrl} name={header.displayName} size={32} online={header.online} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-keep-text">{header.displayName}</span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">
        {hasMore ? (
          <div className="mb-1 text-center text-[10px] italic text-keep-muted">Older history available.</div>
        ) : null}
        {!conversation ? (
          <div className="py-6 text-center italic text-keep-muted">
            Send a message to start the conversation.
          </div>
        ) : messages.length === 0 ? (
          <div className="py-6 text-center italic text-keep-muted">Say hello.</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {messages.map((m) => (
              <DmRow key={m.id} msg={m} isMine={m.senderId === meId} />
            ))}
          </ul>
        )}
      </div>

      {/* Pinned friend-request banner. Sits between the message list
          and the composer so a request from the person whose thread
          you're viewing is impossible to miss without a single tap.
          Mirrors the chat-level FriendRequestPrompts behavior:
          optimistic local removal on click, then the server's
          friend:request echo re-syncs the canonical state. */}
      {pendingFromThisUser ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-keep-action/50 bg-keep-action/10 px-3 py-2 text-sm">
          <span aria-hidden className="text-base text-keep-action">+</span>
          <span className="min-w-[120px] flex-1 leading-snug">
            <span className="font-semibold text-keep-text">{pendingFromThisUser.displayName}</span>
            <span className="text-keep-muted"> sent you a friend request.</span>
          </span>
          <span className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => {
                // Identity-keyed accept (see MessagesModal.acceptRequest
                // for the rationale — name-based lookup loops forever
                // when the sender was on a character whose name collides
                // with a master account).
                const r = pendingFromThisUser;
                removePendingFriendRequest(r.userId);
                void fetch(`/me/friend-requests/${encodeURIComponent(r.userId)}/accept`, {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    frienderCharacterId: r.frienderCharacterId ?? undefined,
                    characterId: r.friendedCharacterId ?? undefined,
                  }),
                }).catch(() => {});
              }}
              className="rounded border border-keep-action bg-keep-action px-3 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg hover:bg-keep-action/90"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => {
                const r = pendingFromThisUser;
                removePendingFriendRequest(r.userId);
                void fetch(`/me/friend-requests/${encodeURIComponent(r.userId)}/decline`, {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    frienderCharacterId: r.frienderCharacterId ?? undefined,
                    characterId: r.friendedCharacterId ?? undefined,
                  }),
                }).catch(() => {});
              }}
              className="rounded border border-keep-border bg-keep-bg px-3 py-1 text-xs uppercase tracking-widest text-keep-muted hover:bg-keep-panel hover:text-keep-text"
            >
              Decline
            </button>
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="border-t border-keep-accent/40 bg-keep-accent/10 px-3 py-1 text-[11px] text-keep-accent">
          {error}
        </div>
      ) : null}
      <form onSubmit={send} className="flex shrink-0 flex-col gap-1 border-t border-keep-rule bg-keep-banner/40 p-2">
        <FormattingToolbar
          inputRef={dmInputRef}
          value={draft}
          onChange={setDraft}
          disabled={busy}
        />
        <div className="flex items-center gap-1">
          {/* Relative wrapper anchors the SynonymPopup to the input's
              top edge — the popup uses `absolute bottom-full` so it
              floats above the input when the user highlights a word
              and synonyms land. */}
          <div className="relative min-w-0 flex-1">
            <SynonymPopup inputRef={dmInputRef} value={draft} onChange={setDraft} />
            <input
              ref={dmInputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`Message ${header.displayName}...`}
              maxLength={4000}
              disabled={busy}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action disabled:opacity-50"
            />
          </div>
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="rounded border border-keep-action bg-keep-action/10 px-3 py-1 text-xs text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
          >
            {busy ? "..." : "Send"}
          </button>
        </div>
      </form>
    </>
  );
}

function DmRow({ msg, isMine }: { msg: DirectMessage; isMine: boolean }) {
  if (msg.deletedAt) {
    return (
      <li className={"flex " + (isMine ? "justify-end" : "justify-start")}>
        <span className="text-[11px] italic text-keep-muted/70">[message removed]</span>
      </li>
    );
  }
  // Layout: the row is a full-width flex container; the inner bubble is
  // content-sized but capped at 85% of the row. Without the flex
  // wrapper, the bubble's `max-w-[85%]` resolves against the inline-
  // block's own shrink-to-fit width — which collapses to a single
  // character per line on short messages ("Hey there" rendered as
  // "Hey\nthere"). justify-end / justify-start places the bubble.
  return (
    <li className={"flex " + (isMine ? "justify-end" : "justify-start")}>
      <div
        className={
          "max-w-[85%] rounded-lg px-2 py-1 " +
          (isMine ? "bg-keep-action/15 text-keep-text" : "bg-keep-banner/70 text-keep-text")
        }
      >
        {!isMine ? (
          <div className="mb-0.5 text-[10px] font-semibold text-keep-muted">{msg.displayName}</div>
        ) : null}
        <div className="whitespace-pre-wrap break-words text-sm leading-snug">
          {parseInline(msg.body)}
        </div>
        {msg.editedAt ? <span className="text-[9px] italic text-keep-muted">(edited)</span> : null}
      </div>
    </li>
  );
}
