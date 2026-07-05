import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, X } from "lucide-react";
import type {
  AvatarCrop,
  DirectConversationSummary,
  DirectMessage,
  DirectMessageHistoryPage,
  InboxIdentityCount,
} from "@thekeep/shared";
import { cropStyleFor } from "../lib/avatarCrop.js";
import { EmoticonTypeahead } from "./EmoticonTypeahead.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { useChat } from "../state/store.js";
import { readError, withIdentityQuery } from "../lib/http.js";
import { identityArgFor, nameForCommand } from "../lib/commandText.js";
import { parseInline } from "../lib/markdown.js";
import { FormattingToolbar } from "./FormattingToolbar.js";
import { SynonymPopup } from "./SynonymPopup.js";
import { UsernameAutocomplete } from "./UsernameAutocomplete.js";
import { CloseButton } from "./CloseButton.js";
import { ReactionBar, ReactionAddButton } from "./ReactionBar.js";
import { handlePlainTextCopy } from "../lib/chatCopy.js";
import { useReducedMotion } from "../lib/reducedMotion.js";

interface Props {
  onClose: () => void;
  /** Slash-command dispatcher for /friend, /accept, /decline, /unfriend. */
  onCommand: (text: string) => void;
  /**
   * Optional pre-selected user id, when the modal opens, this user's
   * thread is shown immediately. Used by the "💬 Message" button on
   * profiles. Null/undefined opens to the empty-state.
   */
  initialOtherUserId?: string | null;
  /**
   * Optional pre-selected character id pinned to the same target.
   * Required to distinguish a master/OOC thread from each of that
   * master's character threads, without it, opening DM from
   * a character profile would surface the OOC conversation and leak
   * the character-to-master link.
   */
  initialOtherCharacterId?: string | null;
  /**
   * Open another user's profile by display name. Threaded from
   * App.tsx so clicking a name / avatar in a DM bubble OR the
   * thread header opens the profile modal, same flow chat uses on
   * the avatar tile. Optional so the modal stays callable from
   * surfaces that don't have profile-open wired (none today, but
   * keeping the option open).
   */
  onOpenProfile?: (displayName: string) => void;
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
  /** Server-resolved zoom/pan for `avatarUrl`. */
  avatarCrop: AvatarCrop;
  online: boolean;
  /** False when this friend is a character-pinned identity whose
   *  owner has toggled the per-character Direct Messenger opt-in off.
   *  The row stays in the list (existing friendships aren't deleted)
   *  but the "Message" action greys out + a small "DM off" badge
   *  surfaces so the player knows why. Master-pinned friendships are
   *  always true. Defaults to true if missing for forward-compat with
   *  older server responses. */
  recipientDmEnabled?: boolean;
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

/** Match returned by /me/friend-resolve. Mirrors the server's
 *  FriendResolveMatch, kept inline to avoid threading a shared
 *  type through the API surface. */
interface FriendResolveMatch {
  kind: "master" | "character";
  userId: string;
  characterId: string | null;
  displayName: string;
  masterUsername: string;
  avatarUrl: string | null;
}

/** Stable empty array sentinel, see Zustand selector notes elsewhere. */
const NO_DM_MESSAGES: DirectMessage[] = [];

const PAGE_SIZE = 50;

/** Floor / ceiling for the auto-growing DM composer textarea, in px.
 *  Floor matches roughly one tappable line at the modal's text-sm
 *  size + py-1 padding; ceiling caps long drafts so the conversation
 *  above doesn't get squeezed. Used by BOTH the inline onChange
 *  handler and the post-send reset effect so neither path can leave
 *  the input collapsed under one line. */
const AUTO_GROW_MIN_PX = 36;
const AUTO_GROW_MAX_PX = 128;

/**
 * Unified Messages modal. Replaces the old standalone FriendsModal,
 * DmListModal, and DmFloatingPanel, the three felt fragmented and
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
export function MessagesModal({ onClose, onCommand, initialOtherUserId, initialOtherCharacterId, onOpenProfile }: Props) {
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
  // the modal kept its own copy and would diverge, accepting from
  // the inbox left the chat prompt and the DM banner stuck.
  const pendingFriendRequests = useChat((s) => s.pendingFriendRequests);
  const setPendingFriendRequests = useChat((s) => s.setPendingFriendRequests);
  const removePendingFriendRequest = useChat((s) => s.removePendingFriendRequest);

  const [friends, setFriends] = useState<FriendListEntry[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Selected DM target, identified by BOTH userId and the pinned
   * character id, because one master account can host multiple
   * concurrent threads (OOC plus one per character). Matching only on
   * userId conflates them and (a) highlights every row owned by that
   * master when you click any one of them and (b) opens the wrong
   * (usually master-OOC) thread for a character-pinned row, leaking
   * the character→master link. The composite identity is what makes
   * the rows behave as fully independent contacts.
   */
  const [selectedTarget, setSelectedTarget] = useState<{ userId: string; characterId: string | null } | null>(
    initialOtherUserId ? { userId: initialOtherUserId, characterId: initialOtherCharacterId ?? null } : null,
  );
  const [refreshKey, setRefreshKey] = useState(0);
  // Mobile pane switch, only one of "list" or "thread" is visible at <md.
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
   * entirely, the left pane goes full-width via flex-1 when it's
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
  /**
   * Transient header info for a brand-new compose-to-non-friend target.
   * Populated from the `/profiles/:name` lookup BEFORE the first message
   * is sent, without it the ThreadPane has no friend row + no
   * conversation row to derive the header from, so it falls back to the
   * "…" placeholder until send creates the conversation. Cleared when
   * the conversation materializes (a friend/conv row takes over) or
   * when the user navigates away.
   */
  const [composeFallback, setComposeFallback] = useState<{
    userId: string;
    characterId: string | null;
    displayName: string;
    avatarUrl: string | null;
  } | null>(null);
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
  // modal-local filter below, a chip click in the switcher can take
  // the filter elsewhere without touching the user's global voice.
  const activeCharacterId = useChat((s) => s.activeCharacterId);

  /**
   * Inbox filter id, modal-local. Drives which identity's friends /
   * DMs / friend-requests show in the left pane and which identity the
   * thread send routes through. Seeds from the user's global active
   * character so the modal opens to the "current voice" inbox, but the
   * chip switcher at the top of the list can override it without
   * firing `me:switch-character`, that's the design choice from the
   * spec: switching chips ONLY refilters the inbox.
   *
   * When the user changes their global active character externally
   * (the /char dropdown, a slash command, another tab), we mirror that
   * change into the filter, the assumption is that any global switch
   * is also what they want to see in their messages.
   *
   * Auto-jump on open: see the effect below. If the seeded identity has
   * no unread / pending but another identity does, we hop the filter to
   * that identity on the first counts-load so the user lands directly
   * on the messages the badge is telling them about, instead of an
   * empty inbox they have to puzzle out by clicking the dropdown.
   */
  const [inboxFilterCharId, setInboxFilterCharId] = useState<string | null>(activeCharacterId);
  useEffect(() => {
    setInboxFilterCharId(activeCharacterId);
  }, [activeCharacterId]);

  // Mirror the active inbox filter into the store while this modal is
  // mounted so the App-level DM refetches (socket reconnect, dm:new
  // for an unknown conversation) reload the identity the user is
  // actually viewing rather than the global voice. Without this, a
  // reconnect/refocus refetch scoped to the global character would
  // full-replace `dmConversations` with the wrong identity's threads
  // and wipe the open thread's conversation row, the bug behind
  // "switching tabs sends to the wrong inbox / removes messages."
  // Cleared to `undefined` on unmount so a closed messenger falls back
  // to the global voice.
  const setDmInboxFilterCharId = useChat((s) => s.setDmInboxFilterCharId);
  useEffect(() => {
    setDmInboxFilterCharId(inboxFilterCharId);
    return () => setDmInboxFilterCharId(undefined);
  }, [inboxFilterCharId, setDmInboxFilterCharId]);

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
   * Per-identity unread counts, sourced from the global store so
   * the chat-shell ✉ badge and the modal's chip pip see the same
   * numbers. The store's `refreshInboxCounts` is called from
   * App-level socket handlers on dm:new / dm:read / friend:request
   * so the badge stays current without the messenger having to be
   * open. This effect adds the messenger-local refresh triggers
   * (opens, list refetches) on top of those.
   */
  const inboxCounts = useChat((s) => s.inboxCountsByIdentity);
  const refreshInboxCounts = useChat((s) => s.refreshInboxCounts);

  /**
   * Which `inboxFilterCharId` the current `dmConversations` map was
   * loaded for. Auto-open consults this so it doesn't grab a target
   * from the previous chip's stale data, that was the bug behind
   * "click Kaal chip, Wallace conv auto-opens but the unread badge
   * never clears": the auto-open ran against OOC's leftover convs
   * before refreshLists had repopulated Kaal's, picked a target that
   * wasn't actually in Kaal's inbox, and ThreadPane mounted with
   * `conversation === null` (so the /read POST never fired).
   * `undefined` = "no fetch has resolved yet this open."
   */
  const [convsLoadedForCharId, setConvsLoadedForCharId] = useState<string | null | undefined>(undefined);

  /** Refetch the left-pane lists (friends + requests + conversations). */
  const refreshLists = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    // Pin the filter id at fetch start. If the user flips chips before
    // this Promise.all resolves, we'll discard the late result rather
    // than letting it overwrite the new chip's data, classic stale-
    // response guard.
    const startedForCharId = inboxFilterCharId;
    try {
      const [fr, fq, dm] = await Promise.all([
        fetch(withIdentityQuery("/me/friends", startedForCharId), { credentials: "include" }),
        fetch(withIdentityQuery("/me/friend-requests", startedForCharId), { credentials: "include" }),
        fetch(withIdentityQuery("/me/dms", startedForCharId), { credentials: "include" }),
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
      setConvsLoadedForCharId(startedForCharId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoadingList(false);
    }
  }, [setDmConversations, setPendingFriendRequests, inboxFilterCharId]);

  // `friendsVersion` from the store is the cross-tab/cross-user
  // refresh signal, the App-level `friend:request` socket listener
  // bumps it on every echo (accept, decline, unfriend, new request).
  // Without this dep, accepting in one user's modal updated their own
  // friends list (via the local `refreshKey` bump in `acceptRequest`)
  // but the OTHER party's modal stayed stale until they closed and
  // reopened it or hit a full page refresh.
  const friendsVersion = useChat((s) => s.friendsVersion);
  useEffect(() => {
    refreshLists();
  }, [refreshLists, refreshKey, friendsVersion]);

  /**
   * Inbox counts feed the per-identity chip badges. Kept on a separate
   * fetch from refreshLists so we can refresh just the counts whenever
   * the global DM/friend state changes (dm:new or friend:request from
   * the socket), refreshLists would loop because it owns the same
   * store fields it'd be reacting to. The counts endpoint returns
   * every identity I own, regardless of the inbox filter, so the chips
   * keep showing badges for unread on the OTHER characters too.
   */
  // `inboxCountsVersion` bumps from ThreadPane (after the /read
  // POST resolves) and from the App-level `dm:read` socket listener.
  // Both signals mean "the server-side read marker just advanced,
  // refetch counts so the chip pip stops lying."
  const inboxCountsVersion = useChat((s) => s.inboxCountsVersion);
  useEffect(() => {
    void refreshInboxCounts();
    // Intentionally NOT keyed on dmConversations / pendingFriendRequests.
    // The App-level dm:new / friend:request socket handlers already
    // refresh the counts when those lists change, so re-firing here on
    // every list replacement was a redundant second /me/inbox-counts
    // fetch. Key only on the meaningful triggers: refreshKey (local
    // open/accept bumps) and inboxCountsVersion (read-marker advances
    // from ThreadPane after /read and from the App dm:read handler).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshInboxCounts, refreshKey, inboxCountsVersion]);

  // NOTE: an earlier "auto-jump to the identity with unread items"
  // effect lived here. Removed deliberately, characters are their
  // own accounts per the partition contract; opening the messenger
  // while voicing Character A should land on Character A's inbox,
  // even when OOC has waiting DMs. The previous auto-jump caused a
  // visible "spaz" where the chip would flip to OOC after a beat
  // and the list briefly desync'd with the chip. The per-chip
  // unread pips in the switcher already point the user at the
  // identity with messages; the auto-jump was adding more noise than
  // signal. If we want to surface "you have unread on OOC" while
  // viewing a character inbox, the right place is a banner or a
  // bumped pip, not a forced filter switch.

  // Re-fire refreshLists whenever the inbox filter changes, Char A
  // and Char B keep separate friends + DM inboxes, so flipping
  // chips (or following a global /char switch) should swap the
  // visible lists.
  useEffect(() => {
    setRefreshKey((v) => v + 1);
    // Drop any selected conversation; the new identity might not be
    // a participant on it. (Re-selecting after refresh shows the new
    // inbox's most recent conversation via auto-open.)
    setSelectedTarget(null);
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
   * of "open Messages and pick up where I left off", same as the
   * Discord/Messenger first-paint. Skipped when:
   *   - The modal was opened with `initialOtherUserId` (profile DM
   *     button has already picked the target).
   *   - The user has already manually selected something this session.
   *   - No conversations exist yet (empty state stays empty).
   *   - `dmConversations` is still loaded for a PREVIOUS chip
   *     (`convsLoadedForCharId !== inboxFilterCharId`). Without this
   *     gate, clicking a chip auto-opened a target from the previous
   *     chip's stale conversation list, ThreadPane then mounted with
   *     `conversation === null` after refreshLists landed, the /read
   *     POST never fired, and the unread badge on the *actual* most-
   *     recent thread of the new chip persisted forever.
   *
   * Triggers only on the transition from null → first-known recency,
   * so re-renders that don't change the conversation set don't
   * stomp the user's later picks.
   */
  const autoOpenAttempted = useRef(false);
  useEffect(() => {
    if (autoOpenAttempted.current) return;
    if (selectedTarget !== null) return;
    if (convsLoadedForCharId !== inboxFilterCharId) return; // stale data, wait
    const convs = Object.values(dmConversations);
    if (convs.length === 0) return;
    autoOpenAttempted.current = true;
    const mostRecent = convs.reduce((best, c) =>
      c.lastMessageAt > best.lastMessageAt ? c : best,
    );
    setSelectedTarget({ userId: mostRecent.otherUserId, characterId: mostRecent.otherCharacterId });
    // Don't flip mobile to "thread", on phones the user explicitly
    // tapped Messages and probably wants the inbox view first. Desktop
    // shows both panes anyway, so the auto-selection just highlights
    // the row and seeds the right pane.
  }, [dmConversations, selectedTarget, convsLoadedForCharId, inboxFilterCharId]);

  /**
   * Compose the unified list shown in the left pane. Order:
   *   1. Friends (alphabetical, online first)
   *   2. Recent non-friend conversations (by lastMessageAt desc)
   * Conversation metadata (last preview, unread, online) is folded
   * onto matching friend rows so the user sees one entry per person.
   */
  /**
   * Composite identity key for a (userId, characterId) pair. Empty
   * string represents the OOC/master side so it's distinguishable from
   * a character id "0" or similar. Used as the lookup key for the
   * conversation map and the selection-active comparison.
   */
  function identityKey(userId: string, characterId: string | null): string {
    return `${userId}:${characterId ?? ""}`;
  }
  // Friend rows are partitioned per (userId, characterId) on the
  // friend's side, so the dedupe set has to be too, otherwise a
  // friendship pinned to a character and a separate friendship with
  // the same user's OOC handle would collide.
  const friendKeys = useMemo(
    () => new Set(friends.map((f) => identityKey(f.userId, f.characterId))),
    [friends],
  );
  const convByOther = useMemo(() => {
    const m = new Map<string, DirectConversationSummary>();
    for (const c of Object.values(dmConversations)) m.set(identityKey(c.otherUserId, c.otherCharacterId), c);
    return m;
  }, [dmConversations]);
  // Conversations with unread messages float to the top of whichever
  // section they appear in (Friends OR Recents), with the
  // most-recently-active unread first. Within each "tier" (unread vs.
  // read) we then sort by lastMessageAt desc so threads the user just
  // touched stay near the top; friend rows with no conversation yet
  // fall to the bottom in original (server) order. The unread tier is
  // also visually highlighted on the row itself, see UserRow.
  function dmRowOrder<R extends { conv: DirectConversationSummary | null }>(a: R, b: R): number {
    const au = (a.conv?.unreadCount ?? 0) > 0 ? 1 : 0;
    const bu = (b.conv?.unreadCount ?? 0) > 0 ? 1 : 0;
    if (au !== bu) return bu - au; // unread tier first
    const at = a.conv?.lastMessageAt ?? 0;
    const bt = b.conv?.lastMessageAt ?? 0;
    return bt - at; // newer activity first; 0 (no conv yet) sinks last
  }
  const friendRows = friends
    .map((f) => ({
      kind: "friend" as const,
      userId: f.userId,
      username: f.username,
      // The friend's pinned character id on this friendship, drives
      // both the @handle display (character name when set) and the
      // `targetCharacterId` we seed onto a brand-new DM thread so the
      // first message lands in the right per-identity inbox.
      characterId: f.characterId,
      displayName: f.displayName,
      handle: f.handle,
      avatarUrl: f.avatarUrl,
      avatarCrop: f.avatarCrop,
      online: f.online,
      // Inherited from the server's per-row resolution. `false` means
      // the friend's character has Direct Messenger toggled off; the
      // row stays in the list (existing relationship), but starting
      // a new DM thread is gated. Defaults true so older response
      // shapes without the field stay reachable.
      recipientDmEnabled: f.recipientDmEnabled ?? true,
      conv: convByOther.get(identityKey(f.userId, f.characterId)) ?? null,
    }))
    .sort(dmRowOrder);
  const nonFriendConvRows = useMemo(() => Object.values(dmConversations)
    .filter((c) => !friendKeys.has(identityKey(c.otherUserId, c.otherCharacterId)))
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
      avatarCrop: c.otherAvatarCrop,
      online: c.otherOnline,
      conv: c,
    }))
    .sort(dmRowOrder),
  [dmConversations, friendKeys]);

  function selectUser(userId: string, characterId: string | null) {
    setSelectedTarget({ userId, characterId });
    setMobileView("thread");
  }

  /**
   * Whenever the selection (manual or auto-open) changes, mirror it
   * into the store's `openDmOtherUserId` so the App-level `dm:new`
   * handler can tell "user is staring at this conversation right now"
   * and skip the unread bump. Also locally reset that conversation's
   * unreadCount to 0, the server-side /read POST in ThreadPane fires
   * separately, but resetting the badge optimistically here keeps the
   * UI from showing a stale count for the half-second between mount
   * and the POST round-trip.
   *
   * Cleanup on unmount clears the store flag so a stale tab doesn't
   * keep claiming to view a conversation it's no longer showing.
   */
  useEffect(() => {
    setOpenDmOtherUser(selectedTarget?.userId ?? null, selectedTarget?.characterId ?? null);
    if (selectedTarget !== null) {
      const conv = Object.values(useChat.getState().dmConversations)
        .find((c) =>
          c.otherUserId === selectedTarget.userId
          && c.otherCharacterId === selectedTarget.characterId,
        );
      if (conv) {
        // Optimistic clear so the badge drops to 0 immediately on
        // selection, the user expects opening a thread to "consume"
        // its notification without waiting for the server round-trip.
        if (conv.unreadCount > 0) {
          upsertDmConversation({ ...conv, unreadCount: 0 });
        }
        // ACTUAL server-side mark-read. Previously this only fired
        // from ThreadPane's seed effect, gated on `conversation?.id`
        // changing, so re-clicking the already-selected row, or
        // auto-opening a thread whose conv.id matched a prior selection,
        // updated the local store but never advanced
        // `directConversationReads.lastReadAt`. The next refreshLists
        // refetch returned the stale server unread count and the
        // "cleared" badge snapped back to its old value. Firing the
        // POST here, keyed on identity-aware selection rather than
        // conversation-id-change, closes that gap.
        //
        // `inboxFilterCharId` (not the global `activeCharacterId`) is
        // the right characterId to send: the conversation is pinned to
        // the identity the user is currently filtered to, and the
        // server's identity auth on /read checks the request character
        // against the conv's pinned side. Sending the global active
        // character (which may be different from the chip filter)
        // produced 404s on every off-active-identity read.
        void fetch(`/me/dms/${conv.id}/read`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upTo: Date.now(),
            characterId: inboxFilterCharId ?? undefined,
          }),
        })
          .then((r) => {
            if (!r.ok) return; // 401/404/etc, leave the optimistic clear standing for UX
            useChat.getState().bumpInboxCountsVersion();
            void useChat.getState().refreshInboxCounts();
          })
          .catch(() => { /* network blip, next selection will retry */ });
      }
    }
    return () => { setOpenDmOtherUser(null); };
    // `inboxFilterCharId` is in deps so the /read POST carries the
    // right characterId; the effect itself is fundamentally about
    // "the user opened this thread under THIS identity."
  }, [selectedTarget, setOpenDmOtherUser, upsertDmConversation, inboxFilterCharId]);

  // Accept/decline route through identity-keyed endpoints, NOT the
  // `/accept <name>` / `/decline <name>` slash commands. Reason:
  // `resolveIdentityByName` on the server resolves master-first, so a
  // request whose sender was on a character with the same name as a
  // master account never matched the row, the row stayed pending and
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
    // Token form so a same-named character belonging to another
    // account can't intercept the unfriend. /unfriend is per-identity
    // server-side, so the character-id token preserves "remove THIS
    // friendship, not the OOC one with the same person."
    const targetArg = identityArgFor({
      userId: f.userId,
      characterId: f.characterId,
      displayName: f.displayName,
    });
    onCommand(`/unfriend ${targetArg}`);
    window.setTimeout(() => setRefreshKey((v) => v + 1), 500);
  }
  /**
   * Submit the add-friend form. Hits POST /me/friend-requests instead
   * of dispatching the slash command so we get a structured success/
   * error response, the slash-command path emits its result as a
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
  /**
   * Two-step friend add:
   *   1. Resolve the typed name to all matching identities (master
   *      + any number of characters that share the name).
   *   2. Zero matches → "no user." One match → commit immediately
   *      (preserves the legacy single-input UX). Multiple → expose
   *      a picker so the user explicitly chooses the identity
   *      they meant. Sender-side `characterId` stays scoped to the
   *      caller's currently-active identity.
   */
  const [resolveMatches, setResolveMatches] = useState<FriendResolveMatch[] | null>(null);

  async function commitFriendRequest(match: FriendResolveMatch) {
    setAddStatus({ kind: "info", text: "Sending…" });
    setResolveMatches(null);
    try {
      const r = await fetch("/me/friend-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Explicit identity target, bypasses the server's name-
          // based resolution so the picker's choice is honored
          // exactly (a character with the same name as a master
          // doesn't lose to the master).
          targetUserId: match.userId,
          targetCharacterId: match.characterId,
          characterId: inboxFilterCharId ?? undefined,
        }),
      });
      const j = await r.json().catch(() => ({} as { error?: string; status?: string; username?: string }));
      if (!r.ok) {
        const msg =
          j.error === "no_user" ? `No user named "${match.displayName}".`
          : j.error === "self" ? "You can't friend yourself."
          : j.error ?? "Friend request failed.";
        setAddStatus({ kind: "error", text: msg });
        return;
      }
      const target = match.displayName;
      const ok =
        j.status === "accepted" ? `You and ${target} are now friends.`
        : j.status === "already_pending" ? `Friend request to ${target} is still pending.`
        : j.status === "already_friends" ? `You and ${target} are already friends.`
        : `Friend request sent to ${target}.`;
      setAddStatus({ kind: "ok", text: ok });
      setAddDraft("");
      setRefreshKey((v) => v + 1);
    } catch {
      setAddStatus({ kind: "error", text: "Network error, try again." });
    }
  }

  async function sendFriendRequest(e: FormEvent) {
    e.preventDefault();
    const name = addDraft.trim();
    if (!name) return;
    setAddStatus({ kind: "info", text: "Looking up…" });
    setResolveMatches(null);
    try {
      const r = await fetch(`/me/friend-resolve?name=${encodeURIComponent(name)}`, {
        credentials: "include",
      });
      if (!r.ok) {
        setAddStatus({ kind: "error", text: "Lookup failed." });
        return;
      }
      const j = (await r.json()) as { matches?: FriendResolveMatch[] };
      const matches = j.matches ?? [];
      if (matches.length === 0) {
        setAddStatus({ kind: "error", text: `No user named "${name}".` });
        return;
      }
      if (matches.length === 1) {
        // Unambiguous, commit straight through without showing the picker.
        await commitFriendRequest(matches[0]!);
        return;
      }
      // Ambiguous, surface the picker. Status text becomes a hint;
      // the actual UI is rendered inline in the add-friend form.
      setAddStatus({ kind: "info", text: `Pick the identity you meant:` });
      setResolveMatches(matches);
    } catch {
      setAddStatus({ kind: "error", text: "Network error, try again." });
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
        // Seed the right-pane header so it shows the resolved name and
        // avatar immediately. Without this the pane sits on "…" until
        // the first message creates the conversation row. For a master
        // hit, the DM lands OOC (characterId null); for a character
        // hit, pin the first message to that character so it lands in
        // the right per-identity inbox.
        const isCharacter = j.kind === "character";
        setComposeFallback({
          userId,
          characterId: isCharacter ? (j.profile.id ?? null) : null,
          displayName: isCharacter ? j.profile.name : j.profile.username,
          avatarUrl: j.profile.avatarUrl ?? null,
        });
        setComposeDraft("");
        setComposeStatus(null);
        selectUser(userId, isCharacter ? (j.profile.id ?? null) : null);
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
        // Mobile: edge-to-edge fullscreen via MODAL_CARD_CONTENT.
        // Desktop: centered card at the standard 75vw/2400px cap.
        // `keep-frame` lets each theme own the border, corner radius,
        // shadow, and the parchment/cyber texture overlay, same
        // pattern AdminPanel / ProfileEditor / EarningDashboard use
        // so DM modal matches the rest of the themed shell instead
        // of reading as a bare bg-keep-bg rectangle.
        className={`${MODAL_CARD_CONTENT} keep-frame bg-keep-bg lg:rounded`}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-lg">Messages</h2>
          <CloseButton onClick={onClose} />
        </header>

        {/* Mobile-only tab strip. Lets users flip between the inbox
            (Friends + Recents + add forms) and the active conversation
            without relying on the per-row back-arrow inside the thread
            header. Hidden on md+ where both panes are visible at once.
            The Chat tab is disabled until a conversation is selected,
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
            disabled={!selectedTarget}
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
          {/* LEFT pane, list. Hidden on mobile when thread is visible.
              The state-driven `listWidth` (set by the drag-resize
              handle) only applies on md+; on mobile the aside fills
              the full modal width. We pass the width as a CSS custom
              property so the responsive `md:w-[var(...)]` class can
              consume it, using `style={{ width }}` directly would win
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
            {/* Character switcher chips, pinned above the list so the
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
              {/* Pending requests, sourced from the shared store so
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
                          onClick={() => selectUser(r.userId, r.frienderCharacterId)}
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
                          aria-label="Accept friend request"
                          className="rounded border border-keep-action bg-keep-action/10 px-1.5 py-0.5 text-keep-action hover:bg-keep-action/20"
                        >
                          <Check className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => declineRequest(r)}
                          title="Decline friend request"
                          aria-label="Decline friend request"
                          className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-keep-muted hover:border-keep-accent hover:text-keep-accent"
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
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
                        key={identityKey(row.userId, row.characterId)}
                        row={row}
                        active={
                          selectedTarget?.userId === row.userId
                          && selectedTarget?.characterId === row.characterId
                        }
                        onSelect={() => selectUser(row.userId, row.characterId)}
                        onRemove={() => removeFriend({
                          userId: row.userId,
                          username: row.username,
                          characterId: row.characterId,
                          displayName: row.displayName,
                          handle: row.handle,
                          avatarUrl: row.avatarUrl,
                          avatarCrop: row.avatarCrop,
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
                        key={identityKey(row.userId, row.characterId)}
                        row={row}
                        active={
                          selectedTarget?.userId === row.userId
                          && selectedTarget?.characterId === row.characterId
                        }
                        onSelect={() => selectUser(row.userId, row.characterId)}
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
                  // Picking from the dropdown commits the friend
                  // request to that exact identity, no follow-up
                  // disambiguation roundtrip. Mirrors the picker's
                  // commit path so a same-named character on another
                  // account can't intercept.
                  onPick={(s) => {
                    void commitFriendRequest({
                      kind: s.kind === "character" ? "character" : "master",
                      userId: s.userId,
                      characterId: s.characterId,
                      displayName: s.displayName,
                      masterUsername: s.masterUsername,
                      avatarUrl: s.avatarUrl,
                    });
                  }}
                  placeholder="add friend..."
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
              {/* Disambiguation picker. Shown when a typed name
                  matches multiple identities (master + characters,
                  or two characters from different players). Each
                  match button commits the friend request to that
                  exact identity, bypassing the server's master-first
                  name resolution. */}
              {resolveMatches && resolveMatches.length > 0 ? (
                <div className="rounded border border-keep-action/40 bg-keep-action/5 p-1">
                  <ul className="space-y-1">
                    {resolveMatches.map((m) => (
                      <li key={`${m.userId}:${m.characterId ?? ""}`}>
                        <button
                          type="button"
                          onClick={() => void commitFriendRequest(m)}
                          className="flex w-full items-center gap-2 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-left text-[11px] hover:border-keep-action hover:bg-keep-action/10"
                          title={
                            m.kind === "character"
                              ? `Send to ${m.displayName} (character of ${m.masterUsername})`
                              : `Send to ${m.displayName} (master account)`
                          }
                        >
                          {m.avatarUrl ? (
                            <img
                              src={m.avatarUrl}
                              alt=""
                              referrerPolicy="no-referrer"
                              className="h-6 w-6 shrink-0 rounded-full object-cover"
                            />
                          ) : (
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-keep-panel text-[10px] uppercase text-keep-muted">
                              {m.displayName.slice(0, 2)}
                            </span>
                          )}
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-semibold text-keep-text">{m.displayName}</span>
                            <span className="truncate text-[10px] text-keep-muted">
                              {m.kind === "character"
                                ? `character of ${m.masterUsername}`
                                : "master account"}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={() => { setResolveMatches(null); setAddStatus(null); }}
                    className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-[10px] text-keep-muted hover:text-keep-text"
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
              <form onSubmit={composeToUser} className="flex gap-1">
                <UsernameAutocomplete
                  value={composeDraft}
                  onChange={setComposeDraft}
                  // Picking from the dropdown opens the DM thread to
                  // that exact identity. We seed `composeFallback`
                  // with the picked identity so the right pane shows
                  // the correct name + avatar immediately, even
                  // before the first message creates the conversation
                  // row server-side.
                  onPick={(s) => {
                    const charId = s.kind === "character" ? s.characterId : null;
                    setComposeFallback({
                      userId: s.userId,
                      characterId: charId,
                      displayName: s.displayName,
                      avatarUrl: s.avatarUrl,
                    });
                    setComposeDraft("");
                    setComposeStatus(null);
                    selectUser(s.userId, charId);
                  }}
                  placeholder="message someone..."
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

          {/* Draggable divider between list and thread. Desktop only,
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

          {/* RIGHT pane, thread. Hidden on mobile when list is visible. */}
          <section
            className={
              "flex min-h-0 flex-col " +
              (mobileView === "thread" ? "flex-1" : "hidden md:flex md:flex-1")
            }
          >
            {selectedTarget ? (() => {
              // Resolve the friend/conv row for the selected target so we
              // can hand the pinned otherCharacterId down even when no
              // DirectConversation exists yet. Without this seed, the
              // first DM with a character-friend would create the
              // conversation against the master (OOC) side, which is
              // exactly the per-identity-partition leak the user
              // reported: clicking a character friend opened a chat
              // with their OOC account.
              // Compose-to-non-friend fallback: when neither a friend
              // row nor an existing conversation exists yet, fall back
              // to the transient profile we resolved from
              // `/profiles/:name`. This keeps the right-pane header
              // populated (name + avatar) BEFORE the first message
              // creates a conversation row.
              const matchesTarget = (r: { userId: string; characterId: string | null }) =>
                r.userId === selectedTarget.userId && r.characterId === selectedTarget.characterId;
              const selectedRow =
                friendRows.find(matchesTarget)
                  ?? nonFriendConvRows.find(matchesTarget)
                  ?? (composeFallback
                      && composeFallback.userId === selectedTarget.userId
                      && composeFallback.characterId === selectedTarget.characterId
                      ? {
                          userId: composeFallback.userId,
                          characterId: composeFallback.characterId,
                          displayName: composeFallback.displayName,
                          avatarUrl: composeFallback.avatarUrl,
                          online: false,
                        }
                      : null);
              return (
                <ThreadPane
                  otherUserId={selectedTarget.userId}
                  otherCharacterId={selectedTarget.characterId}
                  fallback={selectedRow}
                  onBack={() => setMobileView("list")}
                  appendDmMessage={appendDmMessage}
                  setDmMessages={setDmMessages}
                  meId={me?.id ?? null}
                  onCommand={onCommand}
                  myCharacterId={inboxFilterCharId}
                  {...(onOpenProfile ? { onOpenProfile } : {})}
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
    /** Server-resolved zoom/pan applied to the inbox thumbnail. */
    avatarCrop: AvatarCrop;
    online: boolean;
    conv: DirectConversationSummary | null;
    /** When false, this row is a friend whose character has Direct
     *  Messenger opted out. The row still renders so the player can
     *  see the relationship + the history, but the thread-open click
     *  surfaces a hint and is visually de-emphasized. Optional + true
     *  by default so older row shapes (non-friend conv rows, etc.)
     *  don't get downgraded. */
    recipientDmEnabled?: boolean;
  };
  active: boolean;
  onSelect: () => void;
  onRemove?: () => void;
}) {
  const dmAvailable = row.recipientDmEnabled !== false;
  const unread = (row.conv?.unreadCount ?? 0) > 0;
  // Three visual states, applied in priority order: selection wins
  // (the user is already looking at this thread, so the unread halo
  // would be noise), then unread (action-tinted border + softly
  // glowing bg so the row reads as a "demands attention" cue at a
  // glance), then the resting border. The unread tint is the same
  // action color used for the badge so the two read as a matched pair.
  const rowClass = active
    ? "border-keep-action bg-keep-action/10"
    : unread
      ? "border-keep-action/70 bg-keep-action/10 shadow-[0_0_0_1px_rgba(0,0,0,0)] hover:bg-keep-action/15"
      : "border-keep-rule/60 bg-keep-bg hover:border-keep-action hover:bg-keep-banner/40";
  return (
    <li className={"flex items-center gap-2 rounded border p-1.5 " + rowClass}>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Avatar url={row.avatarUrl} name={row.displayName} size={32} online={row.online} crop={row.avatarCrop} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={
                "truncate text-sm text-keep-text " +
                (unread ? "font-bold" : "font-semibold")
              }
            >
              {row.displayName}
            </span>
            {unread ? (
              <span className="shrink-0 rounded-full bg-keep-action px-1.5 py-0 text-[10px] font-semibold text-keep-bg">
                {row.conv!.unreadCount > 99 ? "99+" : row.conv!.unreadCount}
              </span>
            ) : null}
          </span>
          <span
            className={
              "block truncate text-[10px] " +
              (unread ? "font-semibold text-keep-text" : "text-keep-muted")
            }
          >
            {dmAvailable ? (
              row.conv?.lastMessagePreview ?? `@${row.handle}`
            ) : (
              // Subtle hint that this character can no longer be
              // reached, the friendship row stays so a player can
              // still see the relationship + history, but the next
              // send is gated server-side. Italic-muted contrast
              // matches other "informational, not actionable" rail
              // copy in the modal.
              <span className="italic text-keep-muted">@{row.handle} · DM unavailable</span>
            )}
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
  crop,
}: {
  url: string | null;
  name: string;
  size: number;
  online?: boolean;
  /** Owner-chosen zoom + focal point. Same shape BorderedAvatar uses;
   *  null / default = legacy centered-cover render. */
  crop?: AvatarCrop | null;
}) {
  const [errored, setErrored] = useState(false);
  // Resolve the crop via the shared helper so DM avatars stay in sync
  // with every other avatar surface (BorderedAvatar, freeform-border
  // templates, world member gallery).
  const cropStyle = cropStyleFor(crop);
  return (
    // Outer wrapper is `relative` but NOT `overflow-hidden`/`rounded-full`,
    // so the online-status pip can sit on the bottom-right corner and
    // visually overlap the avatar's circular edge without being clipped.
    // The clipping (rounded mask + image crop) lives on the inner span
    // below so it's scoped to the photo only.
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      <span
        // Round avatar, matches the chat-line / userlist / profile
        // treatment so the DM rail and conversation thread agree
        // visually with everywhere else.
        className="absolute inset-0 overflow-hidden rounded-full border border-keep-rule bg-keep-banner"
      >
        {url && !errored ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setErrored(true)}
            className="absolute inset-0 h-full w-full object-cover"
            style={cropStyle}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-keep-muted">
            {initialsFor(name)}
          </span>
        )}
      </span>
      {online !== undefined ? (
        <span
          aria-hidden
          className={
            // Anchored to the outer wrapper (not the clipped circle), so
            // the pip can spill past the avatar edge. The `ring-2 ring-keep-bg`
            // gives it a halo against the bg color, matching the same
            // treatment chat-line + userlist avatars use.
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
 * refilters the inbox in this modal, it does not call
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
  // Calm-mode ease: the dropdown opens BELOW the chip (top-full), pure CSS
  // positioned, so it slides down gently. Reduce Motion only.
  const reduceMotion = useReducedMotion();

  // Hide the switcher entirely when the user has no characters, the
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

  // Total of every OTHER identity's badge, surfaced on the current
  // chip when the dropdown is closed so the user sees "there's traffic
  // somewhere else" at a glance without opening the menu.
  const selectedChar = selectedId ? characters.find((c) => c.id === selectedId) : null;
  const selectedLabel = selectedChar ? selectedChar.name : "OOC";
  const selectedAvatar = selectedChar ? selectedChar.avatarUrl : null;
  let otherUnread = 0;
  for (const c of characters) if (c.id !== selectedId) otherUnread += badgeFor(c.id);
  if (selectedId !== null) otherUnread += badgeFor(null);

  // Build the "jump-to-identity" hint strip, one pill per OTHER
  // identity that has unread DMs or pending friend requests. Click
  // jumps the inbox filter straight there without going through the
  // dropdown. This was added because the old "X unread on other
  // identities" pip told users SOMETHING was waiting but not WHICH
  // chip to click, so reports of "the badge says I have messages but
  // my inbox is empty" persisted even though the data was there.
  interface JumpHint { id: string | null; label: string; avatarUrl: string | null; count: number }
  const jumpHints: JumpHint[] = [];
  if (selectedId !== null) {
    const oocCount = badgeFor(null);
    if (oocCount > 0) jumpHints.push({ id: null, label: "OOC", avatarUrl: null, count: oocCount });
  }
  for (const c of characters) {
    if (c.id === selectedId) continue;
    const n = badgeFor(c.id);
    if (n > 0) jumpHints.push({ id: c.id, label: c.name, avatarUrl: c.avatarUrl, count: n });
  }
  // Sort hottest first so the loudest chip is closest to the dropdown.
  jumpHints.sort((a, b) => b.count - a.count);

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
      {/* "Jump to other identity" strip. Only renders when at least
          one OTHER identity has unread DMs or pending friend requests,
          on a clean inbox the strip is invisible and the dropdown
          header carries no extra weight. Each pill is its own click
          target so the user goes straight to the right chip without
          opening the dropdown first. */}
      {jumpHints.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {jumpHints.map((h) => (
            <button
              key={h.id ?? "master"}
              type="button"
              onClick={() => onSelect(h.id)}
              title={`Switch to ${h.label}, ${h.count} waiting`}
              className="flex items-center gap-1 rounded-full border border-keep-action/40 bg-keep-action/10 px-1.5 py-0.5 text-[10px] text-keep-action hover:bg-keep-action/20"
            >
              <Avatar url={h.avatarUrl} name={h.label} size={14} />
              <span className="max-w-[8rem] truncate font-medium">{h.label}</span>
              <span className="rounded-full bg-keep-accent px-1 py-px font-semibold leading-none text-keep-bg">
                {h.count > 99 ? "99+" : h.count}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {open ? (
        <div
          role="listbox"
          className={`absolute left-3 right-3 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded border border-keep-rule bg-keep-parchment shadow-lg${reduceMotion ? " tk-slide-down-in" : ""}`}
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
  otherCharacterId,
  fallback,
  onBack,
  appendDmMessage,
  setDmMessages,
  meId,
  onCommand,
  myCharacterId,
  onOpenProfile,
}: {
  otherUserId: string;
  /**
   * The character id pinned to this thread on the OTHER party's side
   *, null for an OOC/master thread. Required (paired with userId) to
   * pick out the right conversation when the master account hosts
   * multiple concurrent threads (OOC plus one per character). Matching
   * on userId alone would surface the wrong thread and leak the
   * character→master link.
   */
  otherCharacterId: string | null;
  fallback: { displayName: string; avatarUrl: string | null; online: boolean } | null;
  onBack: () => void;
  appendDmMessage: (msg: DirectMessage) => void;
  setDmMessages: (conversationId: string, msgs: DirectMessage[]) => void;
  meId: string | null;
  onCommand: (text: string) => void;
  myCharacterId: string | null;
  /** Open the other party's profile when the header name / avatar is
   *  clicked. When omitted, the header renders the name plainly with
   *  no click affordance (no point in a click that does nothing). */
  onOpenProfile?: (displayName: string) => void;
}) {
  // Resolve conversation reactively, server creates the row on first
  // send, so it may be absent until then. Matching on BOTH userId AND
  // the pinned character id is what keeps a master's OOC thread, their
  // Char A thread and their Char B thread separate, otherwise the
  // first one returned by `find` wins and the rest are invisible.
  // NO_DM_MESSAGES is a stable sentinel to prevent the Zustand selector
  // loop bug.
  const conversation = useChat(
    (s) => Object.values(s.dmConversations).find(
      (c) => c.otherUserId === otherUserId && c.otherCharacterId === otherCharacterId,
    ) ?? null,
  );
  // Admin-configured DM length cap, server is the source of truth,
  // this mirrors it so the input's maxLength matches what the send
  // path will accept.
  const maxDmLength = useChat((s) => s.inputLimits.maxDirectMessageLength);
  // My identity for this thread, forwarded from the parent modal's
  // inbox filter. Drives `?characterId=` on history fetches and the
  // read-marker POST so the server scopes the thread to my pinned
  // side. Null = master OOC.
  const activeCharacterId = myCharacterId;
  // Target identity pinned to THIS thread. Existing conversations
  // carry an authoritative `otherCharacterId` from the server (the
  // pinned side of the row); fresh threads with no conversation yet
  // fall back to the prop, which the parent seeds from the friend/conv
  // row's pinned character so the first send creates the conversation
  // against the right identity, not the OOC side, which was the
  // partition-leak the user reported.
  const targetCharacterId = conversation?.otherCharacterId ?? otherCharacterId;
  const messages = useChat((s) =>
    conversation ? (s.dmMessagesByConv[conversation.id] ?? NO_DM_MESSAGES) : NO_DM_MESSAGES,
  );
  /**
   * Bumped by the socket `connect` handler in App.tsx, see store
   * comment. Watching it here lets a foregrounded ThreadPane catch
   * up on history it missed while the socket was disconnected
   * (Socket.io drops `dm:new` to offline sockets without replay).
   */
  const dmReseedTick = useChat((s) => s.dmReseedTick);
  /**
   * If the OTHER party has a pending friend request to us, surface it
   * as a pinned banner at the bottom of this thread. The full list
   * lives in the store; we only care about the one matching the
   * thread's other user, undefined when there's no pending request.
   */
  const pendingFromThisUser = useChat((s) =>
    s.pendingFriendRequests.find((r) => r.userId === otherUserId),
  );
  const removePendingFriendRequest = useChat((s) => s.removePendingFriendRequest);
  // Viewer's own zoom/pan + url for THIS thread's pinned identity,
  // pulled from any room's live occupant cache where the viewer is
  // currently present. Both fields come from the SAME live source so
  // they always agree, without that pairing, the bubble was
  // rendering the snapshot URL frozen at send time under the LIVE
  // crop, so an avatar change re-cropped the OLD picture (sized for
  // the new picture's framing). Falls through to null (default crop
  // / snapshot fallback) when the viewer isn't in any room at the
  // moment, same graceful-degradation pattern the chat-line path
  // uses for offline senders.
  //
  // Each selector returns ONE primitive / one persisted reference
  // (never a fresh object literal). An earlier draft combined both
  // into a `{ url, crop }` literal and crashed the DM modal with
  // React's #185 infinite-update error because Zustand's default
  // `Object.is` comparison saw a new object every render → the
  // component re-rendered → the selector re-ran → … Two separate
  // selectors over the same lookup keep the equality check stable.
  const myAvatarUrl = useChat((s) => {
    if (!meId) return null;
    const matchChar = myCharacterId ?? null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find((o) => o.userId === meId && o.characterId === matchChar);
      if (row) return row.avatarUrl;
    }
    return null;
  });
  const myAvatarCrop = useChat((s) => {
    if (!meId) return null;
    const matchChar = myCharacterId ?? null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find((o) => o.userId === meId && o.characterId === matchChar);
      if (row) return row.avatarCrop;
    }
    return null;
  });

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastSeenCount = useRef(messages.length);
  // Reference handed to the formatting toolbar so its wrap-with-markdown
  // buttons can read selection bounds + restore focus after each edit.
  const dmInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync the textarea's auto-grown height with the draft value. The
  // onChange handler keeps things in sync during typing; this effect
  // covers programmatic resets, primarily setDraft("") after a
  // successful send, so the textarea snaps back to one row instead
  // of staying inflated at its prior height.
  //
  // Floor at AUTO_GROW_MIN_PX. On mobile, an empty textarea's
  // `scrollHeight` can return a value smaller than a usable line
  // (or even 0 if the modal is still settling its layout when this
  // effect fires), without the floor the textarea collapsed to a
  // sliver and there was nothing to tap into. The floor keeps a
  // visible one-line tap target no matter what scrollHeight returns.
  useEffect(() => {
    const ta = dmInputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(AUTO_GROW_MIN_PX, Math.min(ta.scrollHeight, AUTO_GROW_MAX_PX))}px`;
  }, [draft]);

  const header = useMemo(() => {
    if (conversation) {
      return {
        displayName: conversation.otherDisplayName,
        avatarUrl: conversation.otherAvatarUrl,
        avatarCrop: conversation.otherAvatarCrop,
        online: conversation.otherOnline,
      };
    }
    return {
      displayName: fallback?.displayName ?? "…",
      avatarUrl: fallback?.avatarUrl ?? null,
      // No fallback crop on the compose target, render at the
      // default (centered cover) until the conversation row arrives.
      avatarCrop: null as AvatarCrop | null,
      online: fallback?.online ?? false,
    };
  }, [conversation, fallback]);

  // Seed history whenever the conversation id changes or the socket
  // reconnects (dmReseedTick bump). Two non-obvious bits:
  //
  //   1. We key the effect on `conversation?.id` (a string) rather
  //      than the `conversation` object itself. The object identity
  //      flips every time `dmConversations` is replaced, even when
  //      the conversation's *id* is unchanged, so depending on the
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
        // Merge, don't replace. A `dm:new` socket event could have
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
        // Deliberately DON'T sync `lastSeenCount` to the seeded
        // length here. If we did, the auto-scroll-on-arrival effect
        // would see `messages.length === lastSeenCount.current` on
        // its next run and skip, which left the thread parked at
        // its initial scrollTop=0 (top of list). Letting the effect
        // observe a genuine 0→N transition makes the initial open
        // scroll to the most recent message.
      })
      .catch((e: unknown) => {
        // AbortError is the cleanup path firing, not a real error.
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "load failed");
      });
    fetch(`/me/dms/${convId}/read`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upTo: Date.now(), characterId: activeCharacterId ?? undefined }),
      signal: ac.signal,
    })
      .then(() => {
        // Bump inbox-counts version so the per-character chip pip
        // refetches NOW that the server-side read marker is
        // committed. Without this, the inbox-counts refetch
        // triggered by the optimistic `unreadCount: 0` on
        // selection change races ahead of the DB write and
        // comes back stale, the conversation row badge clears
        // but the chip pip stays.
        useChat.getState().bumpInboxCountsVersion();
      })
      .catch(() => {});
    return () => { ac.abort(); };
  }, [conversation?.id, setDmMessages, dmReseedTick, activeCharacterId]);

  // Reset the seen-count guard whenever the open conversation
  // changes so a chip-switch into a cached thread always scrolls to
  // the bottom, even if the new thread happens to have the same
  // number of messages as the previous one (which would otherwise
  // make the length-only check below short-circuit). Without this
  // reset the "open conversation X with 5 cached messages, then
  // open Y which also has 5" path landed parked at scrollTop=0.
  useEffect(() => {
    lastSeenCount.current = -1;
  }, [conversation?.id]);

  // Auto-scroll on new message arrivals (including the initial seed
  // load, which is what plants the user at the most-recent message
  // when they open a thread).
  //
  // Two layout-timing gotchas the simple `el.scrollTop = scrollHeight`
  // version missed:
  //
  //   1. React's commit runs BEFORE the browser's layout pass for
  //      newly-rendered children. Assigning scrollTop here reads the
  //      pre-layout scrollHeight, which doesn't yet include the
  //      avatars/images about to flow in. A double rAF defers past
  //      the next paint so scrollHeight reflects the settled layout.
  //
  //   2. Bubble avatars load asynchronously and grow row heights as
  //      they come in. The first scroll-to-bottom can land "halfway
  //      up" once each avatar's intrinsic size finally pushes the
  //      list taller. We re-scroll after every image load inside the
  //      scroll container (one listener delegated at the container)
  //      until the user manually scrolls away, in which case future
  //      re-scrolls are suppressed.
  useEffect(() => {
    if (messages.length === lastSeenCount.current) return;
    lastSeenCount.current = messages.length;
    if (messages.length === 0) return;  // nothing to scroll past yet
    const el = scrollRef.current;
    if (!el) return;
    let cancelled = false;
    const scrollToBottom = () => {
      if (cancelled) return;
      const cur = scrollRef.current;
      if (!cur) return;
      cur.scrollTop = cur.scrollHeight;
    };
    // Double rAF: first frame finishes React's commit + initial
    // layout, second frame guarantees we're reading a settled
    // scrollHeight.
    requestAnimationFrame(() => requestAnimationFrame(scrollToBottom));
    // Belt-and-suspenders: also re-pin after a short timeout in case
    // the layout settled past the second rAF (long thread, slow
    // device). The cancelled flag prevents a stale timer from
    // jumping us back to bottom after the user scrolled away.
    const t = window.setTimeout(scrollToBottom, 80);
    // Catch any avatar/image whose load resolves AFTER the initial
    // scroll. Delegated `load` listener at the container so we don't
    // wire one per <img>. Once attached, every image load triggers
    // a re-pin to the bottom until effect cleanup.
    const onLoad = (e: Event) => {
      const ev = e.target as HTMLElement | null;
      if (ev && ev.tagName === "IMG") scrollToBottom();
    };
    el.addEventListener("load", onLoad, true);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      el.removeEventListener("load", onLoad, true);
    };
  }, [messages.length, conversation?.id]);

  /**
   * Trim leading + trailing whitespace runs entirely, and cap any
   * interior run of 4+ consecutive newlines down to 3. Users can still
   * have up to triple-line breaks for visual rhythm; "press Enter 50
   * times" wall-of-whitespace messages get folded automatically.
   */
  function normalizeMessage(text: string): string {
    return text.replace(/\n{4,}/g, "\n\n\n").trim();
  }

  const submitDraft = useCallback(async () => {
    const text = normalizeMessage(draft);
    if (!text || busy) return;
    // Length gate. The server enforces maxDmLength too, but a
    // pre-flight check skips the wasted round trip AND lets us
    // surface a clear "X / Y chars; trim and resend" message
    // instead of the generic server error string. Draft stays in
    // place either way (the catch path below already preserves
    // it on server-side rejection), but bailing here keeps the
    // toolbar counter and this error message in lockstep.
    if (text.length > maxDmLength) {
      setError(`Message is ${text.length} chars; limit is ${maxDmLength}. Trim it and try again.`);
      return;
    }
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
      // Refocus the textarea so the user can keep typing without
      // having to click back into it. Deferred one task so React's
      // post-send re-render has finished (busy flips back to false,
      // any disabled state on the textarea / send button propagates)
      // before focus() is called.
      setTimeout(() => dmInputRef.current?.focus(), 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    } finally {
      setBusy(false);
    }
  }, [draft, busy, otherUserId, appendDmMessage, activeCharacterId, targetCharacterId, maxDmLength]);

  const send = useCallback((e: FormEvent) => {
    e.preventDefault();
    void submitDraft();
  }, [submitDraft]);

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
        {/* Avatar + name both open the other party's profile when the
            parent wires `onOpenProfile`. Avatar uses the same
            click-to-view affordance chat has on its row tiles. */}
        {onOpenProfile ? (
          <button
            type="button"
            onClick={() => onOpenProfile(header.displayName)}
            className="shrink-0 rounded hover:opacity-90"
            title={`View ${header.displayName}'s profile`}
          >
            <Avatar url={header.avatarUrl} name={header.displayName} size={32} online={header.online} crop={header.avatarCrop} />
          </button>
        ) : (
          <Avatar url={header.avatarUrl} name={header.displayName} size={32} online={header.online} />
        )}
        {onOpenProfile ? (
          <button
            type="button"
            onClick={() => onOpenProfile(header.displayName)}
            className="min-w-0 flex-1 truncate rounded text-left text-sm font-semibold text-keep-text hover:text-keep-action"
            title={`View ${header.displayName}'s profile`}
          >
            {header.displayName}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-keep-text">{header.displayName}</span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm"
        // Plain-text-only clipboard for any selection copied out of
        // the DM thread, same posture as the chat feed (see
        // lib/chatCopy.ts). Strips name-style CSS, link
        // decoration, bold / italic, etc. so a copied DM line
        // pastes as the prose the user meant to quote, not as a
        // visually re-rendered chat snippet.
        onCopy={handlePlainTextCopy}
      >
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
              <DmRow
                key={m.id}
                msg={m}
                isMine={m.senderId === meId}
                otherUrl={conversation?.otherAvatarUrl ?? null}
                otherCrop={conversation?.otherAvatarCrop ?? null}
                myUrl={myAvatarUrl}
                myCrop={myAvatarCrop}
                {...(onOpenProfile ? { onOpenProfile } : {})}
              />
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
                // for the rationale, name-based lookup loops forever
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
          maxLength={maxDmLength}
        />
        <div className="flex items-center gap-1">
          {/* Relative wrapper anchors the SynonymPopup to the input's
              top edge, the popup uses `absolute bottom-full` so it
              floats above the input when the user highlights a word
              and synonyms land. */}
          <div className="relative min-w-0 flex-1">
            <SynonymPopup inputRef={dmInputRef} value={draft} onChange={setDraft} />
            {/* Textarea (not <input>) so Shift+Enter can insert a
                newline and multi-line messages are possible. Enter
                alone submits via the onKeyDown handler below; the
                form's default Enter-submit behavior doesn't fire on
                textareas, which conveniently also keeps the textarea
                focused across sends (the old <input> bounced focus
                to the submit button on Enter). Auto-grows up to
                ~8rem then scrolls so long drafts don't crowd out the
                conversation above. */}
            <textarea
              ref={dmInputRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                // Auto-grow: reset to single-line then expand to fit
                // content. Floored at AUTO_GROW_MIN_PX so the input
                // can't shrink below one tappable line on mobile (see
                // the matching useEffect above for the layout-timing
                // rationale).
                const ta = e.target;
                ta.style.height = "auto";
                ta.style.height = `${Math.max(AUTO_GROW_MIN_PX, Math.min(ta.scrollHeight, AUTO_GROW_MAX_PX))}px`;
              }}
              onKeyDown={(e) => {
                // Enter alone -> send. Shift+Enter / Ctrl+Enter /
                // Alt+Enter / Meta+Enter -> insert newline (browser
                // default). IME composition pass-through: a Japanese /
                // Chinese / Korean user pressing Enter to commit an
                // IME candidate should NOT submit the message.
                if (e.key !== "Enter") return;
                if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
                if (e.nativeEvent.isComposing) return;
                e.preventDefault();
                void submitDraft();
              }}
              placeholder={`Message ${header.displayName}...`}
              maxLength={maxDmLength}
              rows={1}
              className="block w-full resize-none rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
              // `minHeight` is the static floor, even before any JS
              // runs, the textarea reserves a tappable row. The JS
              // auto-grow then mirrors the same floor so a freshly
              // mounted modal on mobile never paints the input as a
              // 0-height sliver. `maxHeight` caps the grow so long
              // drafts scroll internally instead of crowding the
              // conversation above.
              style={{ minHeight: `${AUTO_GROW_MIN_PX}px`, maxHeight: `${AUTO_GROW_MAX_PX}px` }}
            />
            {/* `:emoji-name` typeahead. Same shape as the main composer's
               , see EmoticonTypeahead for the full contract. */}
            <EmoticonTypeahead
              textareaRef={dmInputRef}
              value={draft}
              onChange={setDraft}
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

function DmRow({ msg, isMine, otherUrl, otherCrop, myUrl, myCrop, onOpenProfile }: {
  msg: DirectMessage;
  isMine: boolean;
  /** Live avatar URL for the OTHER party (from the conversation row).
   *  Paired with `otherCrop` so URL + crop come from the same
   *  refreshed source; without that pairing the message bubble
   *  rendered the SNAPSHOT URL (frozen at send time) under the LIVE
   *  crop, so an avatar change re-cropped the old picture. Null
   *  falls back to the snapshot. */
  otherUrl: string | null;
  /** Live crop for the OTHER party's avatar (from the conversation row). */
  otherCrop: AvatarCrop | null;
  /** Live avatar URL for the VIEWER on this thread's pinned identity.
   *  Same pairing rationale as `otherUrl`, falls back to the
   *  snapshot when the viewer isn't in any room (no live source). */
  myUrl: string | null;
  /** Live crop for the VIEWER's avatar on this thread's pinned identity.
   *  Pulled from the live occupant cache by the parent ThreadPane.
   *  Null = viewer isn't in any room right now, default crop renders. */
  myCrop: AvatarCrop | null;
  onOpenProfile?: (displayName: string) => void;
}) {
  // Prefer the live (URL, crop) pair so an avatar change shows the
  // new image with its matching crop. Falls back to the snapshot
  // URL + null crop when the live source isn't available (sender
  // offline + not pinned to the conv). Both fields always come from
  // ONE source per side, never crossed.
  const liveOther = otherUrl !== null;
  const liveMine = myUrl !== null;
  const renderUrlOther = liveOther ? otherUrl : msg.avatarUrl;
  const renderCropOther = liveOther ? otherCrop : null;
  const renderUrlMine = liveMine ? myUrl : msg.avatarUrl;
  const renderCropMine = liveMine ? myCrop : null;
  const renderUrl = isMine ? renderUrlMine : renderUrlOther;
  const renderCrop = isMine ? renderCropMine : renderCropOther;
  // Tap-to-reveal timestamp footer. DMs hide their send time by default
  // to keep threads visually clean; tapping a bubble surfaces the full
  // date+time underneath. Toggling again hides it. Clicks on inline
  // links/buttons inside the body don't toggle, they navigate normally.
  const [showTime, setShowTime] = useState(false);
  if (msg.deletedAt) {
    return (
      <li className={"flex " + (isMine ? "justify-end" : "justify-start")}>
        <span className="text-[11px] italic text-keep-muted/70">[message removed]</span>
      </li>
    );
  }
  function toggleTime(e: React.MouseEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (t.closest("a, button")) return;
    setShowTime((v) => !v);
  }
  // Layout: outer column aligns the message to the appropriate side.
  // Inside, a horizontal flex pairs the sender's snapshotted avatar
  // with the bubble. The wrapper carries the width cap (was on the
  // bubble before), expressed as a percentage of the CONTAINER (the
  // thread pane) rather than of the viewport: mobile keeps a roomy
  // ~92% so the alignment cue still reads, md+ allows up to 85% of the
  // pane and tops out at 46rem so long paragraphs fill the available
  // space instead of wrapping into a skinny strip. The earlier `30vw`
  // cap was viewport-relative, so on a tablet or a constrained desktop
  // (where the inbox rail already eats a chunk of width) the bubble
  // collapsed to roughly half the pane, the "very skinny strip of
  // text" users reported, while an absolute ceiling keeps lines
  // readable on an ultrawide.
  //
  // `flex-row-reverse` on mine puts my avatar on the right of my
  // bubble, mirroring the existing right-alignment. Avatar uses the
  // snapshotted url so a later /char switch doesn't rewrite past
  // attribution (server-side snapshot in resolveSenderSnapshot is now
  // character-only, no master-avatar fallback, so this can't leak
  // the OOC owner anymore).
  // Floating "react" trigger geometry, the button overlays the
  // bubble's *outer* bottom corner so it sits in the gutter between
  // bubbles without taking layout space inside the message row. Outer
  // here means the edge AWAY from the avatar: bottom-right on received
  // bubbles, bottom-left on own bubbles. Picked over a fixed corner
  // (always bottom-right) so the trigger never crowds the avatar /
  // edit affordances on the user's own messages.
  //
  // Always laid out in the DOM (opacity-toggled, not display:none) so
  // the EmoticonPicker's getBoundingClientRect() always reads a valid
  // anchor, previously the button was display:none until hover, which
  // made the picker open against a zero-rect anchor and pop into the
  // viewport corner whenever the click-to-open path lost hover state
  // mid-render.
  const reactBtnPlacement = isMine
    ? "left-0 -translate-x-1/2"
    : "right-0 translate-x-1/2";
  const reactBtnClass =
    "absolute z-10 bottom-0 translate-y-1/2 " +
    reactBtnPlacement +
    " flex h-7 w-7 items-center justify-center rounded-full border border-keep-rule" +
    " bg-keep-bg text-sm leading-none text-keep-muted shadow-sm transition" +
    " opacity-0 pointer-events-none" +
    " group-hover:opacity-100 group-hover:pointer-events-auto" +
    " group-focus-within:opacity-100 group-focus-within:pointer-events-auto" +
    " hover:scale-110 hover:border-keep-action hover:text-keep-action";
  return (
    <li className={"group flex flex-col " + (isMine ? "items-end" : "items-start")}>
      <div
        className={
          "relative flex items-end gap-1.5 max-w-[92%] md:max-w-[min(85%,46rem)] " +
          (isMine ? "flex-row-reverse" : "flex-row")
        }
      >
        {/* Avatar + sender-name both open the sender's profile when
            a callback is wired. Only renders the click on the OTHER
            party's bubble (clicking your own name to open your own
            profile is a noisy action that has its own /profile
            command). */}
        {!isMine && onOpenProfile ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenProfile(msg.displayName); }}
            className="shrink-0 rounded-full hover:opacity-90"
            title={`View ${msg.displayName}'s profile`}
          >
            <Avatar url={renderUrl} name={msg.displayName} size={28} crop={renderCrop} />
          </button>
        ) : (
          <Avatar url={renderUrl} name={msg.displayName} size={28} crop={renderCrop} />
        )}
        <div
          onClick={toggleTime}
          className={
            "min-w-0 cursor-pointer rounded-lg px-2 py-1 " +
            (isMine ? "bg-keep-action/15 text-keep-text" : "bg-keep-banner/70 text-keep-text")
          }
        >
          {!isMine ? (
            onOpenProfile ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenProfile(msg.displayName); }}
                className="mb-0.5 rounded text-[10px] font-semibold text-keep-muted hover:text-keep-action"
                title={`View ${msg.displayName}'s profile`}
              >
                {msg.displayName}
              </button>
            ) : (
              <div className="mb-0.5 text-[10px] font-semibold text-keep-muted">{msg.displayName}</div>
            )
          ) : null}
          <div className="whitespace-pre-wrap break-words text-sm leading-snug">
            {parseInline(msg.body)}
          </div>
          {msg.editedAt ? <span className="text-[9px] italic text-keep-muted">(edited)</span> : null}
        </div>
        {/* Floating react trigger, sibling of the bubble (not a
            descendant), so a click on it doesn't bubble through the
            bubble's onClick={toggleTime}. */}
        <ReactionAddButton
          targetKind="dm"
          targetId={msg.id}
          className={reactBtnClass}
          title="React"
          label={<span aria-hidden>😊</span>}
        />
      </div>
      {showTime ? (
        <span className="mt-0.5 px-2 text-[10px] text-keep-muted">
          {formatDmTime(msg.createdAt)}
        </span>
      ) : null}
      <div className={"mt-0.5 max-w-[92%] md:max-w-[min(85%,46rem)] " + (isMine ? "pr-9" : "pl-9")}>
        <ReactionBar
          targetKind="dm"
          targetId={msg.id}
          hideAddButton
          {...(msg.reactions ? { initialEntries: msg.reactions } : {})}
          {...(msg.deletedAt ? { readOnly: true } : {})}
        />
      </div>
    </li>
  );
}

/** Bubble timestamp footer, locale-formatted date + time on a single
 *  line. `dateStyle: "medium"` + `timeStyle: "short"` lands on e.g.
 *  "May 17, 2026, 6:34 PM" in en-US without runaway length. */
function formatDmTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
