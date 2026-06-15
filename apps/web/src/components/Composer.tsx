import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { CommandDoc, RoomOccupant, ThreadCategory } from "@thekeep/shared";
import { extractMentionTokens } from "@thekeep/shared";
import { CompleterPopup, type CompletionItem } from "./CompleterPopup.js";
import { EarningStatsStrip } from "./EarningStatsStrip.js";
import { EmoticonPickerButton } from "./EmoticonPickerButton.js";
import { EmoticonTypeahead } from "./EmoticonTypeahead.js";
import { SynonymPopup } from "./SynonymPopup.js";
import { useChat } from "../state/store.js";
import { useEarning } from "../state/earning.js";
import type { InventoryEntry, ItemCatalogRow } from "../lib/earning.js";
import { markMentionKnown } from "../state/mentions.js";
import {
  getIdentityTokenName,
  isUnknownIdentityToken,
  markIdentityTokenKnown,
  requestIdentityTokenResolve,
  useIdentityTokensCache,
} from "../state/identityTokens.js";
import { getSocket } from "../lib/socket.js";

interface Props {
  value: string;
  onChange: (text: string) => void;
  /**
   * Submit handler. The forum-mode options route through the same
   * socket payload extensions: `threadTitle` starts a new topic,
   * `replyToId` posts a reply under one. `threadCategoryId` is the
   * legacy carrier for the topic's bucket; the server now also reads
   * it from any new top-level send.
   */
  onSend: (
    text: string,
    opts?: { threadCategoryId?: string | null; threadTitle?: string; replyToId?: string },
  ) => void;
  /** Current room occupants - used to populate @-mention autocomplete. */
  occupants?: RoomOccupant[];
  /** Mobile-only: open the rooms drawer. Hidden on md+. */
  onOpenRail?: () => void;
  /** Current room id; used as the localStorage key for last-used category. */
  roomId?: string | null;
  /**
   * Available thread categories for the current room. Undefined when the
   * room isn't nested or the list hasn't loaded yet; empty array means
   * "nested but no categories defined", the picker is hidden in both
   * cases since there's nothing to choose.
   */
  threadCategories?: ThreadCategory[];
  /**
   * Forum-mode controls. When the host room is nested-mode the composer
   * is one of three states:
   *   - `isForumRoom && !activeTopic && !topicCreateMode` → DISABLED,
   *     with a hint + "New Topic" button.
   *   - `isForumRoom && topicCreateMode` → title input + body + category;
   *     submit calls onSend with `threadTitle`.
   *   - `isForumRoom && activeTopic` → reply mode; submit calls onSend
   *     with `replyToId`.
   * In flat-chat rooms `isForumRoom` is false and these props are
   * ignored, the composer behaves like the historic chat input.
   */
  isForumRoom?: boolean;
  /**
   * Active topic the user is reading / replying to. Passed in as the
   * topic message itself (we need `title` + `id` to render the
   * "Replying to" indicator). `locked` mirrors the server-side
   * `messages.locked_at` state, when true the composer renders a
   * "topic locked" notice and disables the textarea instead of the
   * usual reply indicator. Null = no topic selected.
   */
  activeTopic?: { id: string; title: string | null; body: string; locked: boolean } | null;
  /** True iff the user clicked "New Topic" and the composer is in topic-create mode. */
  topicCreateMode?: boolean;
  /** Open the topic-create form (toggles topicCreateMode on at the App level). */
  onStartTopicCreate?: () => void;
  /** Cancel topic-create mode (revert to the disabled/active-topic state). */
  onCancelTopicCreate?: () => void;
  /** Clear the active topic (leave the thread). */
  onLeaveThread?: () => void;
  /**
   * Override the textarea placeholder. When unset, the composer picks a
   * sensible contextual default (forum-disabled hint / "Reply to ..." /
   * "Type a message..."). Set this when embedding the composer in a
   * context where the contextual defaults don't fit, e.g. the focused
   * thread modal, which is itself the reply context and wants its own
   * "Reply to <topic>..." prompt instead of the chat default.
   */
  placeholder?: string;
  /**
   * Viewer is a moderator (role mod or admin). Moderators bypass the
   * locked-topic input disable, they can still post in locked
   * threads to leave verdicts / notices, matching the server's
   * mod-bypass on the reply gate. The composer renders a distinct
   * "🔒 Locked, replying as moderator" hint when this is true and
   * the active topic is locked.
   */
  canModerate?: boolean;
  /**
   * Opens the Earning dashboard modal. Click target for the
   * EarningStatsStrip rendered in the composer toolbar area. Set
   * by App and threaded through here so the strip can navigate
   * without needing direct access to App's modal state.
   */
  onOpenEarning?: () => void;
  /**
   * Parent-supplied "preferred category for the next new topic" signal,
   * typically wired to the forum view's last-clicked section. Tristate:
   *   - `undefined` (or omitted) → no signal, the dropdown reads its
   *     own persisted localStorage default
   *   - `null` → user nominated the Uncategorized bucket
   *   - `string` → user nominated the given category id
   * Each *change* to this prop syncs the dropdown to the new value (and
   * persists it). Steady-state re-renders with an unchanged value do
   * nothing, so a manual select-dropdown override still wins until the
   * user clicks another section.
   */
  preferredCategoryId?: string | null;
}

const MAX_VISIBLE_LINES = 6;
const MAX_COMPLETIONS = 8;
const HISTORY_MAX = 50;

/** Short label for the "Replying to" indicator: title if present, else a body excerpt. */
function topicLabel(t: { title: string | null; body: string }): string {
  const title = t.title?.trim();
  if (title) return title;
  const body = t.body.trim();
  if (body.length <= 60) return body || "(untitled topic)";
  return `${body.slice(0, 60)}…`;
}

type TriggerKind = "/" | "@" | "whisper-target" | "!" | "item-target" | "item-key" | "user-target";

interface Trigger {
  /**
   *   `/`              - leading slash command (only at message start)
   *   `@`              - mention, anywhere
   *   `whisper-target` - bare username inside /whisper's first arg
   *   `!`              - inline custom-command, anywhere, but only with
   *                      at least one char of name after the `!` (bare
   *                      `!` doesn't open the palette, since punctuation
   *                      shouldn't keep popping the picker for every
   *                      "Wow!" or "stop!")
   *   `item-target`    - first positional arg of /give /throw /drop,
   *                      suggest room occupants by displayName
   *   `item-key`       - item-name slot of /give /throw /drop (after
   *                      target + optional quantity), suggest items
   *                      from the user's CURRENT identity's inventory
   */
  kind: TriggerKind;
  /** Character offset where the trigger token starts (the `/` or `@` itself,
   *  or for whisper-target / item-target / item-key, the first char of
   *  the argument being typed). */
  tokenStart: number;
  /** Lower-cased query (everything after the trigger char up to the caret). */
  query: string;
}

/**
 * Slash commands whose first positional argument is a username, when the
 * user is typing the name, we open the same occupant picker we use for
 * `@`-mentions. Matches the server-side `whisper` command's `aliases`
 * list (see apps/server/src/commands/builtins/whisper.ts) so any alias
 * the dispatcher accepts also lights up the picker.
 */
const WHISPER_CMDS = new Set([
  "whisper", "w", "wh", "to", "msg", "message", "pm",
]);

/**
 * Slash commands that take `<target> [num] <item>`. The composer's
 * trigger detection drives two picker stages for each: occupants at
 * the target slot, then the user's inventory at the item slot.
 * Quantity (digits-only between the two) is the only slot without
 * suggestions, the user just types a number. */
const ITEM_CMDS = new Set(["give", "throw", "drop"]);

/**
 * Social-game (and other) slash commands whose first positional arg
 * is a GLOBAL identity (any user or character, not constrained to
 * the current room's occupants). The picker drives off
 * `/identities/autocomplete` and inserts an identity TOKEN
 * (`@cid:<id>` or `@id:<id>`) so the server resolves unambiguously
 * even when two identities share a display name. Add new commands
 * here as the social-game system grows; nothing else needs to
 * change for the picker to light up. */
const USER_TARGET_CMDS = new Set(["duel"]);

/**
 * NBSP-aware "word char" check used to walk back to a token boundary.
 * `/\s/` matches NBSP (U+00A0), but NBSP is a legal username character,
 * so we treat it as part of the same token to keep names like
 * `The[NBSP]Watcher` whole.
 */
function isWordChar(ch: string): boolean {
  if (ch === " ") return true;
  return !/\s/.test(ch);
}

/**
 * Detect whether the caret sits inside an active completion trigger:
 *   - `/word`, only when the slash is at the start of the message (matches
 *     the dispatcher, which treats slash commands as the *first* token only).
 *   - `@word`, anywhere; mentions can appear mid-message.
 *   - whisper-target: when the caret is in the first positional argument
 *     of a /whisper-alias command, show the same occupant picker (the
 *     name is what the recipient resolves against on the server, so the
 *     picker streamlines what was previously typed-by-hand).
 *
 * Returns null when no trigger is active (e.g. caret in plain text, or after
 * a space).
 */
function detectTrigger(text: string, caret: number): Trigger | null {
  // Whisper-target check first, we want it to win over the @-mention
  // path when the user types `/w foo` (the `foo` part is a bare name,
  // not an @mention). The check looks at the WHOLE line because the
  // trigger boundary isn't a single delimiter char.
  if (text.startsWith("/")) {
    // Find the space that separates the command word from its args. We
    // skip the NBSP-as-whitespace trap here by looking for an ASCII
    // space specifically (NBSP can never appear inside a command name,
    // so the first U+0020 cleanly divides cmd from rest).
    const firstSpace = text.indexOf(" ");
    if (firstSpace > 0 && caret > firstSpace) {
      const cmd = text.slice(1, firstSpace).toLowerCase();
      if (WHISPER_CMDS.has(cmd)) {
        const argStart = firstSpace + 1;
        const argSoFar = text.slice(argStart, caret);
        // Bail out once the caret moves past the first arg, at that
        // point the user is typing the message body, not picking a
        // recipient. NBSP is intentionally NOT counted as whitespace
        // here so `/w The[NBSP]Watcher` keeps the picker open while
        // the name is being typed.
        const pastNameBoundary = /[ \t]/.test(argSoFar);
        if (!pastNameBoundary) {
          return {
            kind: "whisper-target",
            tokenStart: argStart,
            query: argSoFar.toLowerCase(),
          };
        }
      }
      // Social-game (and other) commands whose first positional arg
      // is a global identity. Same scoping rule as whisper-target
      // (stops at the first ASCII space), different downstream source
      // and downstream insertion: the picker hits
      // `/identities/autocomplete` and inserts an identity token, so
      // even two characters sharing a display name route to the
      // right one server-side.
      if (USER_TARGET_CMDS.has(cmd)) {
        const argStart = firstSpace + 1;
        const argSoFar = text.slice(argStart, caret);
        const pastNameBoundary = /[ \t]/.test(argSoFar);
        if (!pastNameBoundary) {
          return {
            kind: "user-target",
            tokenStart: argStart,
            query: argSoFar.toLowerCase(),
          };
        }
      }
      // /give /throw /drop pickers, two stages keyed off how many
      // ASCII spaces appear before the caret inside the args portion.
      //
      //   stage 0 (no space yet):   typing the TARGET name → occupants
      //   stage 1 (one space):      either the quantity or the item.
      //                             If the slot is all digits it's a
      //                             quantity (no popup); otherwise we
      //                             treat it as the item name.
      //   stage 2+ (≥2 spaces):     typing the item name. If the second
      //                             token was numeric, item starts at
      //                             space #2; otherwise the item runs
      //                             from space #1 and may include
      //                             internal spaces ("gold coin").
      if (ITEM_CMDS.has(cmd)) {
        const argStart = firstSpace + 1;
        const argSoFar = text.slice(argStart, caret);
        const sp1 = argSoFar.indexOf(" ");
        if (sp1 === -1) {
          // Target stage. Even an empty query is valid, the popup
          // shows every occupant before the user types anything.
          return {
            kind: "item-target",
            tokenStart: argStart,
            query: argSoFar.toLowerCase(),
          };
        }
        const restAfterTarget = argSoFar.slice(sp1 + 1);
        const sp2 = restAfterTarget.indexOf(" ");
        if (sp2 === -1) {
          // Stage 1, quantity OR item.
          if (/^\d+$/.test(restAfterTarget)) {
            // Mid-quantity: no popup. We don't want the inventory
            // list flashing under the cursor while the user types
            // a number; they'll hit space and we'll show items then.
            return null;
          }
          return {
            kind: "item-key",
            tokenStart: argStart + sp1 + 1,
            query: restAfterTarget.toLowerCase(),
          };
        }
        // Stage 2+. Item name slot, potentially multi-word
        // ("gold coin"). If a numeric quantity sits in slot 1, the
        // item query starts AFTER the second space; otherwise it
        // starts after the first.
        const secondToken = restAfterTarget.slice(0, sp2);
        const hasQuantity = /^\d+$/.test(secondToken);
        const itemStart = hasQuantity
          ? argStart + sp1 + 1 + sp2 + 1
          : argStart + sp1 + 1;
        const itemQuery = hasQuantity
          ? restAfterTarget.slice(sp2 + 1)
          : restAfterTarget;
        return {
          kind: "item-key",
          tokenStart: itemStart,
          query: itemQuery.toLowerCase(),
        };
      }
    }
  }

  // Walk back from the caret to the previous whitespace or start-of-string.
  let s = caret;
  while (s > 0 && isWordChar(text[s - 1]!)) s--;
  const token = text.slice(s, caret);
  if (token.length === 0) return null;
  if (token.startsWith("/")) {
    if (s !== 0) return null; // slash commands only at position 0
    return { kind: "/", tokenStart: s, query: token.slice(1).toLowerCase() };
  }
  if (token.startsWith("@")) {
    return { kind: "@", tokenStart: s, query: token.slice(1).toLowerCase() };
  }
  if (token.startsWith("!")) {
    // Bare `!` (no chars after it) is intentionally ignored, otherwise
    // every "Wow!" or "stop!" would pop the palette mid-sentence. We
    // also require the `!` to sit at start-of-string OR right after a
    // whitespace boundary, so word-internal `!` (rare but defensive)
    // doesn't trigger either. Note: the walk-back loop above already
    // landed `s` on the first char of the token, so the char at
    // text[s-1] is the boundary by construction; we just check it
    // exists and isn't a word char.
    if (token.length < 2) return null;
    if (s > 0 && isWordChar(text[s - 1]!)) return null;
    return { kind: "!", tokenStart: s, query: token.slice(1).toLowerCase() };
  }
  return null;
}

/**
 * Controlled composer with multi-line input + slash/at autocomplete.
 *
 * Multi-line behaviour:
 *   - Enter submits (matches chat conventions on every other platform).
 *   - Shift+Enter inserts a newline so paragraph posters can write blocks.
 *   - The textarea auto-grows up to MAX_VISIBLE_LINES, then internally scrolls.
 *
 * Autocomplete:
 *   - Typing `/<chars>` at message start, or `@<chars>` anywhere, opens a
 *     popup of matching commands or current room occupants.
 *   - Up/Down navigates, Enter or Tab accepts, Esc dismisses.
 *   - Accept replaces the trigger token with the selection plus a trailing
 *     space, then restores the caret.
 *
 * When the value changes from outside (parent sets it), we re-focus and
 * place the caret at the end so the user can keep typing immediately.
 */
export function Composer({
  value,
  onChange,
  onSend,
  occupants,
  onOpenRail,
  roomId,
  threadCategories,
  isForumRoom,
  activeTopic,
  topicCreateMode,
  onStartTopicCreate,
  onCancelTopicCreate,
  onLeaveThread,
  placeholder,
  canModerate,
  preferredCategoryId,
  onOpenEarning,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastValueRef = useRef(value);
  // Phase 4 typing indicator, last time this composer fired a
  // `chat:typing` pulse. Throttled to once per 2s so a long
  // sentence costs at most a handful of tiny socket events. The
  // server's entry TTL is ~5s, so pulsing every 2s comfortably
  // keeps the user's "is typing…" alive across an entire message
  // composition. Empty-text and forum-disabled inputs are skipped
  // (no signal to send). Lives on a ref (not state) so the throttle
  // gate doesn't trigger renders.
  const lastTypingEmitAtRef = useRef(0);

  // Input history. Each successful send pushes its trimmed body onto a
  // ring buffer (deduped against the most recent entry). ArrowUp opens
  // a *popup* of past sends (most recent first) that the user picks
  // from explicitly, pressing ArrowUp does NOT overwrite the current
  // draft. Only Enter on a highlighted entry (or a click) replaces the
  // textarea. This matches the way the @ / / completers behave and
  // keeps the arrow keys from clobbering text the user is actively
  // editing.
  //
  // historyRef holds the buffer itself (no React state, the visible
  // text already lives in the parent's `value`). `historyOpen`/`Index`
  // ARE state because the popup needs to render. Lives for the
  // Composer's lifetime; logging out unmounts the chat and clears it.
  const historyRef = useRef<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(0);
  // Account-level opt-out. When set, the popup never opens, ArrowUp
  // falls through to its native caret-movement behavior. Pulled from
  // the chat store so a toggle in the profile editor takes effect
  // immediately.
  const disableHistory = useChat((s) => s.inputPrefs.disableHistory);
  // Active identity. We don't reset historyRef on character switch
  // (the buffer is per-tab IRC-style, not per-identity), but if the
  // popup is open at the moment of the switch we close it so the
  // user's eye doesn't get pulled to a stale picker while they
  // re-orient to the new identity. Also closes on the user flipping
  // disableHistory mid-popup so the toggle takes effect immediately.
  const activeCharacterId = useChat((s) => s.activeCharacterId);
  useEffect(() => {
    if (historyOpen) {
      setHistoryOpen(false);
      setHistoryIndex(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCharacterId, disableHistory]);

  // Per-identity inventory + catalog for the `item-key` trigger
  // popup. We pull straight from the live earning snapshot, it's
  // already kept fresh by the `earning:inventory_changed` socket
  // listener, so the picker reflects the current stack the moment a
  // /buy / /give / /admin grant lands. Empty array when the snapshot
  // hasn't loaded yet (popup just shows no items, no crash).
  const earningSnapshot = useEarning((s) => s.snapshot);
  const inventoryForActiveIdentity: InventoryEntry[] = useMemo(() => {
    if (!earningSnapshot) return [];
    if (activeCharacterId) {
      return earningSnapshot.inventoryByCharacter?.[activeCharacterId] ?? [];
    }
    return earningSnapshot.inventory ?? [];
  }, [earningSnapshot, activeCharacterId]);
  const itemCatalogByKey = useMemo(() => {
    const m = new Map<string, ItemCatalogRow>();
    for (const c of earningSnapshot?.catalog.items ?? []) m.set(c.key, c);
    return m;
  }, [earningSnapshot]);

  // Thread-category picker state. Only meaningful for nested-mode rooms
  // with at least one category. `selectedCategoryId === null` ==
  // "Uncategorized". Persisted per-room in localStorage so repeat
  // posters in the same bucket don't re-pick on every send.
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  // Topic-title draft used only while topicCreateMode is on. Cleared
  // whenever the composer leaves create mode so a half-typed title
  // doesn't leak into the next new-topic session.
  const [topicTitle, setTopicTitle] = useState("");
  useEffect(() => {
    if (!topicCreateMode) setTopicTitle("");
  }, [topicCreateMode]);
  // Admin-configured cap for forum topic titles. Read from the chat
  // store so a tuning change picks up live (the store is hydrated
  // from /me/profile on first auth-ed boot).
  const maxTopicTitleLength = useChat((s) => s.inputLimits.maxForumTopicTitleLength);
  const maxChatLength = useChat((s) => s.inputLimits.maxMessageLength);
  const maxForumPostLength = useChat((s) => s.inputLimits.maxForumPostLength);
  // Server-side dispatch picks per-room (dispatch.ts: `isForum ?
  // maxForumPostLength : maxMessageLength`). The composer mirrors
  // that here so the toolbar counter and the pre-flight gate
  // reflect the cap the server will actually enforce on send,
  // otherwise a forum room with the 8000 cap was showing 4000 in
  // the counter and forcing trims that the server would have
  // accepted. Topic-create body (no `activeTopic` yet) is also a
  // forum post, so the forum cap applies the moment the user is
  // in a nested room.
  const effectiveMaxLength = isForumRoom ? maxForumPostLength : maxChatLength;
  const setNotice = useChat((s) => s.setNotice);

  useEffect(() => {
    if (!roomId) {
      setSelectedCategoryId(null);
      return;
    }
    try {
      const saved = window.localStorage.getItem(`thespire.thread-cat.${roomId}`);
      // Saved id may have been removed by an admin since last visit; we
      // validate against the current categories list on render and silently
      // ignore stale values, so a missing-category id just falls back to
      // "Uncategorized" without erroring.
      setSelectedCategoryId(saved && saved !== "" ? saved : null);
    } catch { /* storage may be disabled */ }
  }, [roomId]);

  function setAndPersistCategory(catId: string | null) {
    setSelectedCategoryId(catId);
    if (!roomId) return;
    try {
      if (catId) window.localStorage.setItem(`thespire.thread-cat.${roomId}`, catId);
      else window.localStorage.removeItem(`thespire.thread-cat.${roomId}`);
    } catch { /* ignore */ }
  }

  // Sync the dropdown to the parent's "preferred" signal when (and only
  // when) it changes. Ref-guarded so an unchanged prop on re-renders
  // doesn't repeatedly clobber a manual select-dropdown override the
  // user made after their last section click. `undefined` means "no
  // signal", distinct from `null` (Uncategorized).
  const prevPreferredRef = useRef(preferredCategoryId);
  useEffect(() => {
    if (preferredCategoryId === prevPreferredRef.current) return;
    prevPreferredRef.current = preferredCategoryId;
    if (preferredCategoryId === undefined) return;
    setAndPersistCategory(preferredCategoryId);
  // setAndPersistCategory closes over roomId and state setters which
  // are stable; including only the prop keeps the deps list honest.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredCategoryId]);

  // Hide the picker for replies/whispers, they inherit the parent
  // thread's category implicitly server-side. Also hide for any slash
  // command (the picker only governs plain-say top-level messages).
  const isTopLevelSay = !value.trimStart().startsWith("/");
  const showCategoryPicker =
    isTopLevelSay && threadCategories !== undefined && threadCategories.length > 0;

  // Validate the persisted id against the current list; if the admin
  // deleted the category since last visit we silently null it.
  const effectiveCategoryId =
    selectedCategoryId && threadCategories?.some((c) => c.id === selectedCategoryId)
      ? selectedCategoryId
      : null;

  // Cache the command list. Fetched per mount + whenever
  // `commandsVersion` bumps (the App-level socket listener bumps it
  // on `commands:updated` from the server, fired by every admin
  // custom-command edit). Without the version key, a brand-new
  // command would stay invisible in the autocomplete until the user
  // reloaded their tab.
  const [commands, setCommands] = useState<CommandDoc[] | null>(null);
  const commandsVersion = useChat((s) => s.commandsVersion);
  useEffect(() => {
    let cancelled = false;
    fetch("/commands", { credentials: "include" })
      .then((r) => (r.ok ? r.json() as Promise<{ commands: CommandDoc[] }> : null))
      .then((j) => { if (!cancelled && j) setCommands(j.commands); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [commandsVersion]);

  // Caret-driven trigger detection. We track caret separately because React's
  // value+onChange flow doesn't carry the caret position; we update it in a
  // selectionchange handler so popup state stays accurate while the user
  // navigates with arrow keys.
  const [caret, setCaret] = useState<number>(value.length);
  const trigger = useMemo(() => detectTrigger(value, caret), [value, caret]);

  // Server-backed mention suggestions. Occupant filtering only finds
  // people currently in this room; this hits the existing `/users?q=`
  // endpoint so a user can autocomplete an offline friend's master
  // username or any of their characters' names too. Debounced so we
  // don't fire a request on every keystroke. The race-condition guard
  // (`reqIdRef`) drops stale responses when the user keeps typing.
  type ServerSuggestion = { name: string; sublabel?: string; online: boolean };
  const [serverSuggestions, setServerSuggestions] = useState<ServerSuggestion[]>([]);
  const searchReqRef = useRef(0);
  useEffect(() => {
    // Only the whisper-target path still uses the name-string source; `@`
    // mentions now insert identity tokens from `identitySuggestions` below so
    // they point at an exact identity (no name collisions, spaces survive).
    if (!trigger || trigger.kind !== "whisper-target") {
      setServerSuggestions([]);
      return;
    }
    const q = trigger.query;
    if (q.length < 1) { setServerSuggestions([]); return; }
    const myReq = ++searchReqRef.current;
    const handle = window.setTimeout(() => {
      fetch(`/users?q=${encodeURIComponent(q)}&limit=8`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (myReq !== searchReqRef.current) return;
          if (!j || !Array.isArray(j.users)) { setServerSuggestions([]); return; }
          const out: ServerSuggestion[] = [];
          for (const u of j.users as Array<{
            username: string;
            online: boolean;
            characters?: Array<{ id: string; name: string }>;
            activeCharacterId?: string | null;
          }>) {
            // Master username always suggested when it prefix-matches.
            if (u.username.toLowerCase().startsWith(q)) {
              out.push({ name: u.username, online: u.online });
            }
            // Character names that prefix-match too, typing `@ly`
            // should surface a character named "Lyra" even if her
            // master account name doesn't start with "ly".
            for (const c of u.characters ?? []) {
              if (!c.name.toLowerCase().startsWith(q)) continue;
              out.push({
                name: c.name,
                online: u.online,
                sublabel: u.activeCharacterId === c.id ? `${u.username} (active)` : u.username,
              });
            }
          }
          setServerSuggestions(out);
        })
        .catch(() => { if (myReq === searchReqRef.current) setServerSuggestions([]); });
    }, 120);
    return () => window.clearTimeout(handle);
  }, [trigger?.kind, trigger?.query]);

  // Identity-token suggestions for the `user-target` trigger (social
  // games like /duel). Distinct from the username string-search above
  // because the picker needs the full identity tuple (userId,
  // characterId) so it can insert an `@cid:` / `@id:` token. The
  // server endpoint requires at least one character of query, so the
  // empty-query slot is filled by room occupants (also identity-
  // tupled, see the items computation below).
  type IdentitySuggestion = {
    kind: "user" | "character";
    userId: string;
    characterId: string | null;
    displayName: string;
    masterUsername: string;
    online: boolean;
  };
  const [identitySuggestions, setIdentitySuggestions] = useState<IdentitySuggestion[]>([]);
  const identityReqRef = useRef(0);
  useEffect(() => {
    // user-target (e.g. /duel) AND `@` mentions both need the full identity
    // tuple so the picker can insert an `@cid:`/`@id:` token.
    if (!trigger || (trigger.kind !== "user-target" && trigger.kind !== "@")) {
      setIdentitySuggestions([]);
      return;
    }
    const q = trigger.query;
    if (q.length < 1) { setIdentitySuggestions([]); return; }
    const myReq = ++identityReqRef.current;
    const handle = window.setTimeout(() => {
      fetch(`/identities/autocomplete?q=${encodeURIComponent(q)}&limit=8`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (myReq !== identityReqRef.current) return;
          if (!j || !Array.isArray(j.identities)) { setIdentitySuggestions([]); return; }
          setIdentitySuggestions(j.identities as IdentitySuggestion[]);
        })
        .catch(() => { if (myReq === identityReqRef.current) setIdentitySuggestions([]); });
    }, 120);
    return () => window.clearTimeout(handle);
  }, [trigger?.kind, trigger?.query]);

  // Build completion items from the current trigger + sources.
  const items: CompletionItem[] = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "/") {
      if (!commands) return [];
      const out: CompletionItem[] = [];
      for (const c of commands) {
        // Match against the canonical name and aliases. Show the canonical
        // name as the inserted value so aliases route to the same handler;
        // sublabel surfaces what the command does.
        const names = [c.name, ...c.aliases];
        if (names.some((n) => n.toLowerCase().startsWith(trigger.query))) {
          out.push({
            value: `/${c.name}`,
            label: `/${c.name}`,
            sublabel: c.description,
          });
        }
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      return out.slice(0, MAX_COMPLETIONS);
    }
    if (trigger.kind === "!") {
      if (!commands) return [];
      const out: CompletionItem[] = [];
      for (const c of commands) {
        // Only commands with the admin-side "Allow inline use" toggle
        // appear here, the rest of the slash-only commands stay
        // invisible to the `!` trigger.
        if (!c.allowInline) continue;
        const names = [c.name, ...c.aliases];
        if (names.some((n) => n.toLowerCase().startsWith(trigger.query))) {
          out.push({
            value: `!${c.name}`,
            label: `!${c.name}`,
            sublabel: c.description,
          });
        }
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      return out.slice(0, MAX_COMPLETIONS);
    }
    // User-target, first positional of any USER_TARGET_CMDS slash
    // command (currently just /duel). Two sources merged:
    //   1. Room occupants (instant, full identity tuples already in
    //      hand, so we can build the @cid:/@id: token without a
    //      server round-trip).
    //   2. /identities/autocomplete results (catches offline users
    //      and characters not currently in this room).
    // Insertion value is always the IDENTITY TOKEN, not the
    // displayName, so the server resolves unambiguously even when
    // two identities share a name. The label is the displayName;
    // the sublabel hints at character-of-master so the user can
    // pick the right one when names collide.
    if (trigger.kind === "user-target") {
      const out: CompletionItem[] = [];
      const seen = new Set<string>();
      const pushIdentity = (
        userId: string,
        characterId: string | null,
        displayName: string,
        sublabel?: string,
      ) => {
        // Identity-correct dedupe: two suggestions sharing a name
        // are NOT duplicates if they have different ids. Key on the
        // id tuple, not the name.
        const idKey = characterId ? `c:${characterId}` : `u:${userId}`;
        if (seen.has(idKey)) return;
        seen.add(idKey);
        const token = characterId ? `@cid:${characterId}` : `@id:${userId}`;
        out.push({
          value: token,
          label: displayName,
          ...(sublabel ? { sublabel } : {}),
        });
      };
      // Occupants first (instant). Filter by query prefix when the
      // user has started typing; empty query shows everyone in the
      // room so the picker is useful immediately after the space.
      if (occupants) {
        for (const o of occupants) {
          if (trigger.query.length > 0
            && !o.displayName.toLowerCase().startsWith(trigger.query)) continue;
          pushIdentity(o.userId, o.characterId, o.displayName, o.away ? "in room, away" : "in room");
        }
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      // Then server-side identity matches (offline users / out-of-
      // room characters). The endpoint requires q.length >= 1 so
      // this set is empty on the bare `/duel ` (space-only) case;
      // occupants alone seed the picker until the user types a letter.
      for (const s of identitySuggestions) {
        const sublabel = s.kind === "character"
          ? `character of ${s.masterUsername}`
          : "user";
        pushIdentity(s.userId, s.characterId, s.displayName, sublabel);
      }
      return out.slice(0, MAX_COMPLETIONS);
    }
    // Item-target, first positional of /give /throw /drop. Occupant
    // picker, identical filter to the whisper-target path but no
    // server-backed lookup (the target MUST be in the room for the
    // command to land server-side, so suggesting offline users would
    // misdirect, they'd accept an offline name and hit
    // "ITEM_CMD_NO_TARGET" when they pressed Enter).
    //
    // NBSP-substitute spaces in the inserted value the same way
    // whisper-target does: args[0] is a single token, and the parser
    // splits on regular spaces, so a multi-word displayName like
    // "The Doctor" would tokenize as just "The" without NBSP. The
    // server's matchOccupant normalizes NBSP↔space before comparing,
    // so both forms round-trip.
    if (trigger.kind === "item-target") {
      const NBSP_ITEM = " ";
      const out: CompletionItem[] = [];
      if (occupants) {
        for (const o of occupants) {
          if (o.displayName.toLowerCase().startsWith(trigger.query)) {
            out.push({
              value: o.displayName.replace(/ /g, NBSP_ITEM),
              label: o.displayName,
              ...(o.away ? { sublabel: "away" } : {}),
            });
          }
        }
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      return out.slice(0, MAX_COMPLETIONS);
    }
    // Item-key, the item slot of /give /throw /drop. Source is the
    // CURRENT identity's inventory (master if no character is active,
    // otherwise the active character). Filter by prefix on the
    // singular name AND the plural, typing "co" surfaces both
    // "cookies" and any other co-prefixed item the user holds. Empty
    // query lists everything the identity owns. Aliases are NOT
    // surfaced as their own suggestions (they'd duplicate canonical
    // names in the popup); they still match server-side on accept,
    // so the typed-by-hand path keeps working.
    if (trigger.kind === "item-key") {
      const out: CompletionItem[] = [];
      const earningInv = inventoryForActiveIdentity ?? [];
      const catalogByKey = itemCatalogByKey;
      for (const entry of earningInv) {
        const row = catalogByKey.get(entry.itemKey);
        if (!row) continue;
        const lowerName = row.name.toLowerCase();
        const lowerPlural = row.namePlural?.toLowerCase() ?? "";
        if (
          trigger.query.length > 0 &&
          !lowerName.startsWith(trigger.query) &&
          !lowerPlural.startsWith(trigger.query)
        ) continue;
        out.push({
          value: row.name,
          label: row.name,
          sublabel: `× ${entry.quantity.toLocaleString()}${row.description ? `, ${row.description}` : ""}`,
        });
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      return out.slice(0, MAX_COMPLETIONS);
    }
    // @-mention. Inserts an identity TOKEN (`@cid:<id>` / `@id:<id>`), not the
    // typed name, so the mention points at an EXACT identity. This fixes two
    // long-standing bugs: a character name with real spaces never matched the
    // NBSP-escaped mention text (so it silently failed to ping or link), and a
    // name shared by an account and a character resolved to whichever the
    // server found first. The server resolves the token at send time, rewrites
    // the body to `@<displayName>` for display, and snapshots the id so the
    // chip opens the right profile and self-mentions highlight correctly.
    // Sources are the same two as before, but both carry the id tuple:
    // occupants (instant) + /identities/autocomplete (offline / out-of-room).
    if (trigger.kind === "@") {
      const out: CompletionItem[] = [];
      const seen = new Set<string>();
      const pushIdentity = (
        userId: string,
        characterId: string | null,
        displayName: string,
        sublabel?: string,
      ) => {
        const idKey = characterId ? `c:${characterId}` : `u:${userId}`;
        if (seen.has(idKey)) return;
        seen.add(idKey);
        const token = characterId ? `@cid:${characterId}` : `@id:${userId}`;
        out.push({ value: token, label: `@${displayName}`, ...(sublabel ? { sublabel } : {}) });
      };
      if (occupants) {
        for (const o of occupants) {
          if (trigger.query.length > 0 && !o.displayName.toLowerCase().startsWith(trigger.query)) continue;
          pushIdentity(o.userId, o.characterId, o.displayName, o.away ? "in room, away" : "in room");
        }
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      for (const s of identitySuggestions) {
        const sublabel = s.kind === "character" ? `character of ${s.masterUsername}` : "user";
        pushIdentity(s.userId, s.characterId, s.displayName, sublabel);
      }
      return out.slice(0, MAX_COMPLETIONS);
    }
    // whisper-target. Two sources, merged:
    //   1. Occupants of the current room (instant, fastest path for
    //      "who's here right now").
    //   2. Server `/users?q=` suggestions (catches offline folks +
    //      characters not currently in this room, the autocomplete
    //      previously left you stuck if you forgot the exact spelling
    //      of someone not in the room).
    // Dedupe by lowercased name so an occupant doesn't appear twice
    // when the server returns them too.
    // Spaces in a multi-word displayName ("The Doctor", master usernames
    // typed with NBSP, character names with regular spaces) get rewritten
    // to NBSP when forming the inserted mention text. The mention regex
    // is NBSP-friendly but stops at a regular space, so without this
    // conversion `@The Doctor` would tokenize as just `@The`. NBSP
    // renders visually identical to a regular space, so users still
    // SEE "@The Doctor", they just get a single clickable mention.
    // The label keeps a regular space for the popup list so picker
    // results don't look weird.
    const NBSP = " ";
    const out: CompletionItem[] = [];
    const seen = new Set<string>();
    const push = (displayName: string, sublabel?: string) => {
      const key = displayName.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      // whisper-target inserts the bare (NBSP-joined) name; the /whisper
      // resolver normalizes NBSP vs space server-side.
      out.push({
        value: displayName.replace(/ /g, NBSP),
        label: displayName,
        ...(sublabel ? { sublabel } : {}),
      });
    };
    if (occupants) {
      for (const o of occupants) {
        if (o.displayName.toLowerCase().startsWith(trigger.query)) {
          push(o.displayName, o.away ? "away" : undefined);
        }
      }
    }
    // Sort the occupant slice before appending server hits so the
    // local block stays stable as server responses arrive (otherwise
    // the picker re-alphabetizes and jumps on each network update).
    out.sort((a, b) => a.label.localeCompare(b.label));
    for (const s of serverSuggestions) {
      push(s.name, s.sublabel);
    }
    return out.slice(0, MAX_COMPLETIONS);
  }, [trigger, commands, occupants, serverSuggestions, identitySuggestions, inventoryForActiveIdentity, itemCatalogByKey]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  // The popup never steals Enter until the user has opted in by pressing
  // Up/Down (or by clicking, which calls acceptItem directly). Otherwise
  // typing `/say hi` + Enter would silently mutate into the first matching
  // command suggestion, which is hostile when the user knows exactly what
  // they want to send. Tab still accepts as the explicit completion key.
  const [navigatedSuggestions, setNavigatedSuggestions] = useState(false);
  // Reset highlight + opt-in flag when the active item set changes shape
  // (e.g. user keeps typing and the list shortens, or the trigger kind
  // flips between command/mention).
  useEffect(() => {
    setSelectedIndex(0);
    setNavigatedSuggestions(false);
  }, [items.length, trigger?.kind]);

  useEffect(() => {
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
      const el = inputRef.current;
      if (el && document.activeElement !== el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
        setCaret(len);
      }
    }
  }, [value]);

  // Auto-grow: re-measure scrollHeight on every value change, capped at the
  // configured max-height (computed from line-height to stay font-size-aware).
  // useLayoutEffect avoids a flicker where the textarea briefly shows the old
  // height before the resize lands.
  //
  // The explicit `minHeight` floor closes a cross-browser inconsistency:
  // some browsers fold CSS min-height into scrollHeight after the
  // `style.height = "auto"` reset, others don't. Reading the computed
  // min-height back and flooring the inline style here guarantees the
  // textarea never collapses below its CSS floor, important for the
  // mobile layout where the floor is sized to match the ↵+Send right
  // column so the row has no dead space below the input.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = window.getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const minHeight = parseFloat(cs.minHeight) || 0;
    const maxHeight = lineHeight * MAX_VISIBLE_LINES + padTop + padBottom;
    const target = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${target}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    // Empty-check uses the fully-trimmed copy so all-whitespace input
    // doesn't fire a send. Outgoing body keeps leading whitespace:
    // typing " :O" intentionally avoids the `:` action shortcut and
    // sends a literal smiley, so the leading space MUST survive the
    // client → server hop. Only the trailing whitespace is collapsed
    // (accidental trailing newline / spaces on copy-paste).
    if (!value.trim()) return;
    const t = value.trimEnd();
    // Length gate. chat:input is fire-and-forget, by the time the
    // server's TOO_LONG `error:notice` echoes back, the call site
    // below has already cleared the input and the user's text is
    // gone. Validate here so an over-cap submit surfaces the same
    // notice but LEAVES the draft in place for the user to trim
    // and resend. Counter in the toolbar (below) tracks the same
    // value so over-cap is visible before the user even hits send.
    if (t.length > effectiveMaxLength) {
      setNotice({
        code: "TOO_LONG",
        message: `${isForumRoom ? "Post" : "Message"} is ${t.length} chars; limit is ${effectiveMaxLength}. Trim it and try again.`,
      });
      return;
    }
    const buf = historyRef.current;
    if (buf[buf.length - 1] !== t) {
      buf.push(t);
      if (buf.length > HISTORY_MAX) buf.shift();
    }
    // Close any open history popup on send (the user committed; the
    // recall context is done).
    setHistoryOpen(false);
    setHistoryIndex(0);

    // Forum-mode routing. Server enforces these structurally; here we
    // just pick the right payload shape based on which UI mode we're
    // in. Both modes still need the body (`t`), a topic with no body
    // is treated as the first post AND the topic anchor, same row.
    if (isForumRoom && topicCreateMode) {
      const title = topicTitle.trim();
      if (!title) return; // submit-button is disabled in this case too
      onSend(t, {
        threadTitle: title,
        threadCategoryId: effectiveCategoryId,
      });
      onChange("");
      setTopicTitle("");
      setCaret(0);
      return;
    }
    if (isForumRoom && activeTopic) {
      onSend(t, { replyToId: activeTopic.id });
      onChange("");
      setCaret(0);
      return;
    }

    // Flat-room / non-forum path. threadCategoryId only forwards when
    // the picker is visible (i.e. a categorized nested room before the
    // forum rewrite; defensively kept for installs in flat mode).
    onSend(t, showCategoryPicker ? { threadCategoryId: effectiveCategoryId } : undefined);
    onChange("");
    setCaret(0);
  }

  // Replace the composer text with a recalled (or restored) value and park
  // the caret at the end. Used by ArrowUp/ArrowDown history navigation.
  // requestAnimationFrame waits for the controlled value to flush before
  // we reposition the caret, same pattern acceptItem uses.
  const recallText = useCallback((text: string) => {
    onChange(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
      setCaret(len);
    });
  }, [onChange]);

  // Replace the active trigger token with the chosen completion, append a
  // trailing space, and restore the caret right after the inserted text.
  const acceptItem = useCallback((item: CompletionItem) => {
    const t = trigger;
    if (!t) return;
    const inserted = `${item.value} `;
    const next = value.slice(0, t.tokenStart) + inserted + value.slice(caret);
    onChange(next);
    const newCaret = t.tokenStart + inserted.length;
    // Prime the mentions-validity cache so the resulting `@name`
    // renders as a chip on the FIRST render after send, skips the
    // `/mentions/resolve` round-trip that would otherwise leave the
    // mention briefly as plain text. The picker only surfaces names
    // the server vouched for (occupants are by definition real users;
    // server suggestions came from /users?q=), so marking them known
    // here is safe. Whisper-target completions (no `@` prefix) get
    // primed too, same name, same validity, same future render.
    if (t.kind === "@" || t.kind === "whisper-target") {
      const picked = item.value.startsWith("@") ? item.value.slice(1) : item.value;
      if (picked) markMentionKnown(picked);
    }
    // If the picker inserted an identity TOKEN (`@cid:`/`@id:`), prime its
    // display name so the "Mentioning:" hint resolves instantly (no
    // round-trip), and prime the @name chip cache for the post-send rewrite.
    const tokenMatch = /^@(id|cid):([A-Za-z0-9_-]{1,64})$/.exec(item.value);
    const tokKind = tokenMatch?.[1];
    const tokId = tokenMatch?.[2];
    if (tokKind && tokId && item.label) {
      markIdentityTokenKnown(tokKind as "id" | "cid", tokId, item.label);
      markMentionKnown(item.label);
    }
    // setSelectionRange has to wait for the controlled value to flush, so
    // schedule it after the next paint.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  }, [trigger, value, caret, onChange]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Popup-aware navigation comes first: if the popup has items and a
    // navigational key fires, intercept it.
    if (items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % items.length);
        setNavigatedSuggestions(true);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
        setNavigatedSuggestions(true);
        return;
      }
      // Tab is the explicit "accept the suggestion" key, always honored.
      // Enter only accepts if the user has already opted into the popup
      // by pressing Up/Down; otherwise it falls through and submits what
      // the user actually typed (see comment on navigatedSuggestions).
      if (e.key === "Tab") {
        e.preventDefault();
        const item = items[selectedIndex];
        if (item) acceptItem(item);
        return;
      }
      if (
        navigatedSuggestions &&
        e.key === "Enter" &&
        !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        const item = items[selectedIndex];
        if (item) acceptItem(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Force-close the popup by snapping the caret to a position that has
        // no trigger. Setting caret to 0 (no preceding `@`/`/`) is the
        // simplest signal; subsequent typing re-opens it.
        setCaret(0);
        return;
      }
    }

    // History popup. ArrowUp opens it; once open, ArrowUp / ArrowDown
    // navigate within it; Enter accepts the highlighted entry; Esc
    // dismisses. Two gates on the open-trigger:
    //   1. Account-level opt-out (`disableHistory`), when set, the
    //      popup never opens. The arrow keys fall through to native
    //      caret movement.
    //   2. Caret must be on the FIRST line of the textarea. Walking the
    //      cursor up through multi-line text used to pop the recall
    //      and clobber the draft mid-paragraph; gating to the first
    //      line restores the normal "move cursor up to the line above"
    //      behavior everywhere except where there is no line above.
    //
    // Modifier keys (Shift / Ctrl / Alt / Meta) bypass the popup
    // entirely so selection + word-jump shortcuts still work as the
    // OS expects.
    //
    // CRUCIALLY: opening the popup does NOT replace the textarea's
    // value. The user picks an entry explicitly with Enter or by
    // clicking, until then, the in-progress draft is untouched.
    if (historyOpen) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHistoryIndex((i) => Math.min(i + 1, historyRef.current.length - 1));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHistoryIndex((i) => {
          const next = i - 1;
          if (next < 0) {
            // Walked past the most recent entry, close the popup
            // rather than wrapping around. Keeps the muscle memory
            // of "down past the bottom of a list closes it."
            setHistoryOpen(false);
            return 0;
          }
          return next;
        });
        return;
      }
      if (
        e.key === "Enter" &&
        !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        const buf = historyRef.current;
        const picked = buf[buf.length - 1 - historyIndex];
        setHistoryOpen(false);
        setHistoryIndex(0);
        if (picked !== undefined) recallText(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setHistoryOpen(false);
        setHistoryIndex(0);
        return;
      }
      // Any other key (typing, arrow-left/right, etc.) closes the
      // popup and falls through to the normal handler, the user is
      // signaling they're done browsing history.
      setHistoryOpen(false);
      setHistoryIndex(0);
    }
    if (!disableHistory && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === "ArrowUp") {
      // First-line gate. With no newlines anywhere, every caret
      // position is on the first line; otherwise the caret must be
      // at or before the first newline to qualify. Read the live
      // selectionStart in case the controlled-value `caret` lags
      // behind (e.g. a click-to-position that hasn't yet routed
      // through onSelect).
      const el = inputRef.current;
      const caretPos = el?.selectionStart ?? caret;
      const firstNewline = value.indexOf("\n");
      const onFirstLine = firstNewline === -1 || caretPos <= firstNewline;
      if (onFirstLine && historyRef.current.length > 0) {
        e.preventDefault();
        setHistoryOpen(true);
        setHistoryIndex(0);
        return;
      }
    }

    // No popup intercept - fall through to plain Enter/submit.
    if (e.key !== "Enter") return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  }

  // Keep `caret` in sync with native selection changes (mouse clicks,
  // arrow-key navigation that doesn't pass through onKeyDown intercept,
  // keyboard shortcuts, etc.). Wired via the textarea's own events to scope
  // it tightly.
  function syncCaret() {
    const el = inputRef.current;
    if (!el) return;
    setCaret(el.selectionStart ?? value.length);
  }

  // Mobile newline insertion. On-screen keyboards don't have Shift+Enter,
  // and the Enter key on most mobile keyboards is bound to submit, so
  // multi-line posters need an explicit button. Inserts at the caret (or
  // replaces the selection) and restores the caret one char past the
  // inserted newline. Visible only on mobile via `lg:hidden`.
  function insertNewline() {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const next = value.slice(0, start) + "\n" + value.slice(end);
    onChange(next);
    const newCaret = start + 1;
    requestAnimationFrame(() => {
      const el2 = inputRef.current;
      if (!el2) return;
      el2.focus();
      el2.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  }

  /**
   * Wrap the current selection with `before` / `after` markers. If no
   * selection, insert `before + placeholder + after` and place the
   * caret around the placeholder so the user can immediately type
   * over it. Used by the formatting buttons (Bold / Italic / etc).
   */
  function wrapSelection(before: string, after: string, placeholder: string = "text"): void {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const selected = value.slice(start, end);
    const content = selected || placeholder;
    const inserted = `${before}${content}${after}`;
    const next = value.slice(0, start) + inserted + value.slice(end);
    onChange(next);
    // Caret placement: if we used the placeholder (no original
    // selection), select the placeholder text so the user can type
    // straight over it. If we wrapped a real selection, place the
    // caret right after the closing marker.
    const selStart = start + before.length;
    const selEnd = selStart + content.length;
    requestAnimationFrame(() => {
      const el2 = inputRef.current;
      if (!el2) return;
      el2.focus();
      if (selected) {
        el2.setSelectionRange(selEnd, selEnd);
        setCaret(selEnd);
      } else {
        el2.setSelectionRange(selStart, selEnd);
        setCaret(selEnd);
      }
    });
  }

  /**
   * Prefix every line of the current selection (or the current line
   * if no selection) with `prefix`. Used by the Quote button: turns
   * a multi-line selection into a `> ` blockquote.
   */
  function prefixLines(prefix: string): void {
    const el = inputRef.current;
    if (!el) return;
    let start = el.selectionStart ?? value.length;
    let end = el.selectionEnd ?? start;
    // Snap selection to whole lines so the prefix applies cleanly.
    while (start > 0 && value[start - 1] !== "\n") start--;
    while (end < value.length && value[end] !== "\n") end++;
    const block = value.slice(start, end);
    const next = value.slice(0, start)
      + block.split("\n").map((l) => `${prefix}${l}`).join("\n")
      + value.slice(end);
    onChange(next);
    const newCaret = end + (block.split("\n").length * prefix.length);
    requestAnimationFrame(() => {
      const el2 = inputRef.current;
      if (!el2) return;
      el2.focus();
      el2.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  }

  /**
   * Insert a literal string at the caret position (or replacing the
   * current selection). Used by the inline-emoticon picker, no
   * wrap, just paste the token and advance the caret past it.
   */
  function insertAtCursor(literal: string): void {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const next = value.slice(0, start) + literal + value.slice(end);
    onChange(next);
    const caretPos = start + literal.length;
    requestAnimationFrame(() => {
      const el2 = inputRef.current;
      if (!el2) return;
      el2.focus();
      el2.setSelectionRange(caretPos, caretPos);
      setCaret(caretPos);
    });
  }

  /**
   * Link / image insertion: prompts for a URL (rejects empty),
   * wraps the selection (or a placeholder) as `[text](url)` or
   * `![alt](url)` depending on `kind`. Reuses `wrapSelection`'s
   * before/after model, then patches the URL into the suffix.
   */
  function insertLinkOrImage(kind: "link" | "image"): void {
    const url = window.prompt(kind === "image" ? "Image URL (http:// or https://):" : "Link URL (http:// or https://):");
    if (!url) return;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      window.alert("URL must start with http:// or https://");
      return;
    }
    const before = kind === "image" ? "![" : "[";
    const after = `](${trimmed})`;
    wrapSelection(before, after, kind === "image" ? "alt" : "link text");
  }

  // Forum-mode state derivations. The composer has four distinct
  // shapes in a forum room: disabled (no topic), topic-create, reply,
  // and locked (topic exists but won't accept replies from this
  // viewer). Flat rooms ignore all of this and fall through to the
  // chat composer.
  //
  // Moderators bypass the locked-state input disable, they can still
  // post moderation notes in locked threads. `forumReplying` covers
  // both the "topic isn't locked" and "topic IS locked but I'm a mod"
  // cases so the textarea behaves identically; the indicator strip
  // changes copy when locked + canModerate to make the override
  // visible.
  const forumDisabled = !!isForumRoom && !topicCreateMode && !activeTopic;
  const forumLockedForViewer =
    !!isForumRoom && !!activeTopic && activeTopic.locked && !topicCreateMode && !canModerate;
  const forumLockedModOverride =
    !!isForumRoom && !!activeTopic && activeTopic.locked && !topicCreateMode && !!canModerate;
  const forumReplying =
    !!isForumRoom && !!activeTopic && !topicCreateMode && !forumLockedForViewer;
  const forumCreating = !!isForumRoom && !!topicCreateMode;
  // Textarea / Send are inert when the surrounding context can't
  // accept input. Locked threads block sending for non-mods; the
  // server is authoritative and re-rejects on submit anyway.
  const inputDisabled = forumDisabled || forumLockedForViewer;
  const submitDisabled =
    inputDisabled ||
    (forumCreating && !topicTitle.trim()) ||
    !value.trim();

  // Identity tokens currently in the draft (`@id:`/`@cid:`). The composer
  // inserts these so a mention targets an exact identity, but the raw token
  // is an opaque id — resolve each to a display name so the author can see
  // WHO they're referencing before sending.
  const draftTokens = useMemo(() => extractMentionTokens(value), [value]);
  useEffect(() => {
    if (draftTokens.length > 0) requestIdentityTokenResolve(draftTokens);
  }, [draftTokens]);
  // Subscribe to the cache so resolved names re-render the hint when they land.
  const tokenCacheVersion = useIdentityTokensCache((s) => s.version);
  const tokenHints = useMemo(
    () => draftTokens.map((t) => ({
      key: `${t.kind}:${t.id}`,
      kind: t.kind,
      id: t.id,
      name: getIdentityTokenName(t.kind, t.id),
      unknown: isUnknownIdentityToken(t.kind, t.id),
    })),
    // tokenCacheVersion drives the re-read of the (mutated-in-place) cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftTokens, tokenCacheVersion],
  );

  return (
    <form
      onSubmit={submit}
      // `min-h-[5.25rem]` + `justify-end` keep the composer wrapper the
      // same height as the right-rail's bottom strip (identity-button +
      // Tools-trigger stacked), so the two bottom rails align visually
      // at the chat's lower edge instead of the composer hovering an
      // inch above. Extra rows the composer renders in forum / reply
      // modes still grow it past the minimum; the floor only matters
      // in the simple "send a chat message" state.
      className="keep-composer flex min-h-[5.25rem] flex-col justify-end gap-1 border-t border-keep-rule bg-keep-banner/50 p-2"
    >
      {/* Forum-mode disabled state, composer is locked until the user
          picks a topic or starts a new one. The "New Topic" button is
          the primary call-to-action in this state. */}
      {forumDisabled ? (
        <div className="flex items-center justify-between gap-2 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1 text-xs text-keep-muted">
          {/* `min-w-0 flex-1` lets the long hint shrink + wrap on narrow
              viewports instead of pushing the "+ New Topic" button off
              the right edge. Default flex items have `min-width: auto`
              which means "as wide as the intrinsic content", and a
              one-line sentence in English has no good wrap point, so
              without this it forces horizontal overflow on mobile. */}
          <span className="min-w-0 flex-1">This room is a forum, pick a topic to reply, or start a new one.</span>
          {onStartTopicCreate ? (
            <button
              type="button"
              onClick={onStartTopicCreate}
              className="shrink-0 rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
            >
              + New Topic
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Forum-mode "locked, can't reply" indicator. The viewer has an
          active topic but it's been locked AND they aren't a mod, so
          input is disabled. Leave-thread is still offered so they can
          back out and pick another topic. */}
      {forumLockedForViewer ? (
        <div className="flex items-center justify-between gap-2 rounded border border-keep-rule/60 bg-keep-bg/60 px-2 py-1 text-xs text-keep-muted">
          <span className="min-w-0 truncate">
            <span className="mr-1" aria-hidden>🔒</span>
            <b>{topicLabel(activeTopic!)}</b> is locked, no new replies.
          </span>
          {onLeaveThread ? (
            <button
              type="button"
              onClick={onLeaveThread}
              className="keep-button shrink-0 rounded border border-keep-rule/60 bg-keep-bg px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text"
              title="Leave this topic"
            >
              Leave thread
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Forum-mode "replying" indicator. Two variants:
            - normal:  active topic is unlocked, standard accent strip.
            - mod override: active topic is locked but the viewer is a
              moderator. Input stays enabled so they can post a verdict
              or notice, but the strip swaps to a muted-amber lock
              indicator so the override is unmistakable. */}
      {forumReplying ? (
        forumLockedModOverride ? (
          <div className="flex items-center justify-between gap-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">
            <span className="min-w-0 truncate">
              <span className="mr-1" aria-hidden>🔒</span>
              <span className="mr-1 text-[10px] uppercase tracking-widest opacity-70">Locked, replying as moderator</span>
              <b>{topicLabel(activeTopic!)}</b>
            </span>
            {onLeaveThread ? (
              <button
                type="button"
                onClick={onLeaveThread}
                className="keep-button shrink-0 rounded border border-keep-rule/60 bg-keep-bg px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text"
                title="Leave this topic"
              >
                Leave thread
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded border border-keep-action/40 bg-keep-action/10 px-2 py-1 text-xs text-keep-action">
            <span className="min-w-0 truncate">
              <span className="mr-1 text-[10px] uppercase tracking-widest opacity-70">Replying to</span>
              <b>{topicLabel(activeTopic!)}</b>
            </span>
            {onLeaveThread ? (
              <button
                type="button"
                onClick={onLeaveThread}
                className="keep-button shrink-0 rounded border border-keep-rule/60 bg-keep-bg px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner hover:text-keep-text"
                title="Stop replying to this topic"
              >
                Leave thread
              </button>
            ) : null}
          </div>
        )
      ) : null}

      {/* Forum-mode "create topic" form, title input + category select
          stacked above the body textarea below. */}
      {forumCreating ? (
        <div className="flex flex-col gap-1 rounded border border-keep-action/40 bg-keep-action/5 p-2">
          <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-widest text-keep-action">
            <span>New topic</span>
            {onCancelTopicCreate ? (
              <button
                type="button"
                onClick={onCancelTopicCreate}
                // Tap-target sizing: comfortable 32px height on mobile
                // so the cancel-out path is easy to hit; md+ stays
                // compact since pointer precision is higher.
                className="keep-button flex h-8 items-center rounded border border-keep-rule/60 bg-keep-bg px-3 normal-case tracking-normal text-keep-muted hover:bg-keep-banner hover:text-keep-text lg:h-6 lg:px-2"
              >
                Cancel
              </button>
            ) : null}
          </div>
          <input
            type="text"
            value={topicTitle}
            onChange={(e) => setTopicTitle(e.target.value)}
            maxLength={maxTopicTitleLength}
            placeholder="Topic title"
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
          {threadCategories && threadCategories.length > 0 ? (
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
              <span>Category:</span>
              <select
                value={effectiveCategoryId ?? ""}
                onChange={(e) => setAndPersistCategory(e.target.value || null)}
                className="rounded border border-keep-rule bg-keep-bg px-1 py-0.5 normal-case tracking-normal text-keep-text"
              >
                <option value="">Uncategorized</option>
                {threadCategories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      {/* Legacy thread-category picker for FLAT rooms that still have
          categories defined (a nested room that was flipped back, or
          a flat room with stale category rows). In nested rooms the
          picker now lives inside the topic-create form above; here
          it only renders for the legacy / flat case. */}
      {!isForumRoom && showCategoryPicker ? (
        <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
          {/* board.png replaces the 🧵 sewing-thread emoji for forum/
              thread affordances per the Earning asset pack. */}
          <img src="/assets/icons/board.png" alt="" aria-hidden className="h-3.5 w-3.5 select-none" draggable={false} />
          <span>Thread:</span>
          <select
            value={effectiveCategoryId ?? ""}
            onChange={(e) => setAndPersistCategory(e.target.value || null)}
            className="rounded border border-keep-rule bg-keep-bg px-1 py-0.5 normal-case tracking-normal text-keep-text"
          >
            <option value="">Uncategorized</option>
            {threadCategories!.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      {/* Formatting toolbar. Compact icon row above the textarea,
          each button wraps the current selection with the relevant
          markdown markers, or inserts the markers around a placeholder
          when nothing is selected. Hidden when the input is disabled
          (forum-locked-for-viewer or no-active-topic states) since
          formatting a blocked compose makes no sense. */}
      {/* Hero rank row (mobile only). Carries the rank / coin / XP read-out
          AND the MENU button that opens the rooms / userlist drawer. It
          renders in EVERY composer state (including forum-locked) so the
          drawer is always reachable on a phone — the old per-toolbar
          scroll button vanished in disabled states and could sit under the
          on-screen keyboard, which left iOS users unable to open the
          userlist. The rail is desktop-always-visible, so this whole row
          is `lg:hidden`.

          The earning strip self-hides when the snapshot hasn't loaded or
          the input is disabled (rendered WITHOUT `onOpenEarning` so the
          read-out isn't one giant accidental-tap link to the dashboard;
          the desktop strip in the toolbar below stays clickable). The
          rank read-out sits on the LEFT; MENU is pushed to the RIGHT with
          `ml-auto` so it stays right-aligned even when the strip is hidden
          (disabled states). */}
      {(onOpenRail || (!inputDisabled && onOpenEarning)) ? (
        <div className="mb-1 flex items-center gap-2 lg:hidden">
          {!inputDisabled && onOpenEarning ? <EarningStatsStrip /> : null}
          {onOpenRail ? (
            <button
              type="button"
              onClick={onOpenRail}
              aria-label="Open menu"
              title="Menu - rooms, servers, and people"
              className="keep-button ml-auto flex h-8 shrink-0 items-center justify-center rounded border border-keep-rule/60 bg-keep-bg/60 px-3 text-[11px] font-semibold uppercase tracking-widest leading-none hover:bg-keep-banner"
            >
              Menu
            </button>
          ) : null}
        </div>
      ) : null}
      {!inputDisabled ? (
        // Compact toolbar row. The mobile rooms-drawer trigger moved up to
        // the hero rank row above (as the MENU button), so the toolbar's
        // first item is the Bold button at every width and the input row
        // below reclaims the width the old drawer column was eating.
        <div className="flex flex-wrap items-center gap-0.5 text-xs">
          <FmtButton title="Bold (Ctrl+B)" onClick={() => wrapSelection("**", "**", "bold")}>
            <b>B</b>
          </FmtButton>
          <FmtButton title="Italic (Ctrl+I)" onClick={() => wrapSelection("*", "*", "italic")}>
            <i>I</i>
          </FmtButton>
          {/* Underline has no markdown equivalent (CommonMark reserves
              `__` for bold-alt), so we wrap selection in literal <u>…</u>
              and the inline parser recognizes the HTML tag as an alias.
              Same render path as the markdown buttons; the stored body
              just happens to keep the tag. */}
          <FmtButton title="Underline" onClick={() => wrapSelection("<u>", "</u>", "underline")}>
            <u>U</u>
          </FmtButton>
          <FmtButton title="Strikethrough" onClick={() => wrapSelection("~~", "~~", "strikethrough")}>
            <s>S</s>
          </FmtButton>
          <FmtButton title="Inline code" onClick={() => wrapSelection("`", "`", "code")}>
            <span className="font-mono">{"<>"}</span>
          </FmtButton>
          <FmtButton title="Spoiler (click to reveal)" onClick={() => wrapSelection("||", "||", "spoiler")}>
            <span aria-hidden>👁</span>
          </FmtButton>
          <FmtButton title="Blockquote, prefixes selected lines with '> '" onClick={() => prefixLines("> ")}>
            <span aria-hidden>❝</span>
          </FmtButton>
          <FmtButton title="Link, wraps selection as [text](url)" onClick={() => insertLinkOrImage("link")}>
            <span aria-hidden>🔗</span>
          </FmtButton>
          <FmtButton title="Image, inserts ![alt](url)" onClick={() => insertLinkOrImage("image")}>
            <span aria-hidden>🖼</span>
          </FmtButton>
          {/* Inline emoticon: pops the picker, then inserts the
              :slug:idx: token at the caret. The markdown renderer
              converts the token to a 24px sprite that scales up on
              hover.
              Explicit `className` mirrors FmtButton's geometry
              (h-8 w-8 squared, hairline border, bg-keep-bg/60) so
              the inline-emoticon trigger sits flush with the
              surrounding B / I / U / etc. The component's default
              className matches the SHARED FormattingToolbar (h-6
              transparent-border), which is what DM + Forum
              composers use, Composer's bigger row would otherwise
              look like a smaller pill dropped into the wrong
              toolbar. */}
          <EmoticonPickerButton
            onPick={(slug, idx) => insertAtCursor(`:${slug}:${idx}:`)}
            onPickUnicode={(char) => insertAtCursor(char)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-keep-rule/60 bg-keep-bg/60 text-sm leading-none text-keep-muted hover:bg-keep-banner hover:text-keep-text"
          />
          {/* Right-aligned group: character counter + earning strip
              together. Earlier each had its own `ml-auto` and flex
              split the slack between them, leaving the counter
              floating in the middle of the row. Wrapping both in a
              single `ml-auto` container collapses that to one
              right-aligned cluster with a tiny gap between them.
              The earning strip stays desktop-only via `hidden
              lg:flex`; on mobile the strip lives in its own row
              above (see the conditional just above), so this
              container only renders the counter on small screens. */}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <ComposerCharCount length={value.trimEnd().length} max={effectiveMaxLength} />
            {onOpenEarning ? (
              <div className="hidden lg:flex">
                <EarningStatsStrip onOpenEarning={onOpenEarning} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* The rooms-drawer trigger (💬) used to live here as a leading
          shrink-0 button. It's been relocated into the formatting
          toolbar row on mobile (md+ never had it), which gives the
          textarea full row-width and lets longer messages show more
          lines without scrolling. */}
      {/* Resolved-identity hint. When the draft contains `@id:`/`@cid:`
          tokens (inserted by the @-picker or pasted from a profile's
          copy-token chip), show who each one references so the opaque id
          isn't a mystery before sending. Unresolved tokens read as
          "unknown identity" so a stale/bad token is obvious. */}
      {tokenHints.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 px-0.5 text-[11px] text-keep-muted">
          <span className="opacity-70">Mentioning:</span>
          {tokenHints.map((h) => (
            h.name ? (
              <span
                key={h.key}
                className="rounded border border-keep-action/40 bg-keep-action/10 px-1.5 py-0.5 font-medium text-keep-text"
                title={`@${h.kind}:${h.id}`}
              >
                @{h.name}
              </span>
            ) : (
              <span
                key={h.key}
                className="rounded border border-keep-rule/50 bg-keep-bg/60 px-1.5 py-0.5"
                title={`@${h.kind}:${h.id}`}
              >
                {h.unknown ? "unknown identity" : "resolving…"}
              </span>
            )
          ))}
        </div>
      ) : null}
      <div className="flex items-stretch gap-2">
      <div className="relative flex-1">
        {/* The popup positions itself above the textarea via bottom-full. */}
        <CompleterPopup
          items={items}
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          onAccept={acceptItem}
        />
        {/* Thesaurus popup. Same anchor strategy as CompleterPopup
            (absolute, bottom-full) so highlighting a word in chat /
            forum messages pops a list of synonyms above the
            textarea, Enter or click swaps the highlighted word for
            the chosen synonym. */}
        <SynonymPopup inputRef={inputRef} value={value} onChange={onChange} />
        {/* History popup. Opens on ArrowUp (when the caret is on the
            first line of the textarea). Shows most-recent sends first
            without touching the in-progress draft, the user has to
            highlight + Enter (or click) to actually replace the
            text. Same bottom-full anchor as the other two popups so
            it slides up out of the textarea's top edge. */}
        {historyOpen && historyRef.current.length > 0 ? (
          <ul
            role="listbox"
            aria-label="Recent sends"
            className="absolute bottom-full left-0 z-30 mb-1 max-h-56 w-full overflow-y-auto rounded border border-keep-rule bg-keep-bg shadow-2xl"
          >
            <li className="border-b border-keep-rule/40 bg-keep-banner/40 px-2 py-1 text-[10px] uppercase tracking-widest text-keep-muted">
              Recent sends, Enter to insert
            </li>
            {historyRef.current
              .slice()
              .reverse()
              .map((entry, i) => (
                <li key={`${i}-${entry}`}>
                  <button
                    type="button"
                    // onMouseDown so the click lands before the
                    // textarea's blur (same Safari workaround the
                    // synonym/mention popups use).
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setHistoryOpen(false);
                      setHistoryIndex(0);
                      recallText(entry);
                    }}
                    onMouseEnter={() => setHistoryIndex(i)}
                    className={`block w-full truncate px-2 py-1 text-left text-xs ${
                      i === historyIndex
                        ? "bg-keep-banner/60 text-keep-text"
                        : "text-keep-text hover:bg-keep-banner/40"
                    }`}
                  >
                    {entry}
                  </button>
                </li>
              ))}
          </ul>
        ) : null}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            // selectionStart updates synchronously on input, so this stays
            // in sync with the new value during typing.
            setCaret(e.target.selectionStart ?? e.target.value.length);
            // Phase 4 typing pulse. Skip when:
            //   - the composer is disabled (forum-disabled / locked)
            //   - we don't have a roomId to scope to (mid-room-switch)
            //   - the textarea is now empty (deleting back to blank is
            //     a fine moment to let the indicator expire naturally)
            //   - we already pulsed within the throttle window
            if (inputDisabled) return;
            if (!roomId) return;
            if (e.target.value.length === 0) return;
            const now = Date.now();
            if (now - lastTypingEmitAtRef.current < 2_000) return;
            lastTypingEmitAtRef.current = now;
            // Send the per-tab identity claim alongside the pulse so the
            // server uses THIS tab's voicing for the indicator instead
            // of falling back to whichever identity a sibling tab last
            // wrote into the shared session.
            getSocket().emit("chat:typing", { roomId, asCharacterId: activeCharacterId });
          }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onKeyDown={onKeyDown}
          // Close the history popup if the textarea loses focus. The
          // popup's accept buttons use onMouseDown + preventDefault to
          // keep the textarea focused while clicking, so an actual
          // blur means the user clicked away (or tabbed out). Without
          // this, the popup would stay visible after focus shift and
          // re-anchor next time the user types into the textarea.
          onBlur={() => {
            if (historyOpen) {
              setHistoryOpen(false);
              setHistoryIndex(0);
            }
          }}
          rows={1}
          // enterKeyHint relabels the on-screen keyboard's return key to
          // "Send" so mobile users see the right affordance, Enter
          // submits, the dedicated ↵ button (mobile-only) inserts a
          // newline.
          enterKeyHint="send"
          disabled={inputDisabled}
          placeholder={
            placeholder ??
            (forumDisabled
              ? "Pick a topic or start a new one to post."
              : forumLockedForViewer
                ? "This topic is locked, no new replies."
                : forumCreating
                  ? "First post of the new topic..."
                  : forumLockedModOverride
                    ? `Post a moderator reply to "${topicLabel(activeTopic!)}"...`
                    : forumReplying
                      ? `Reply to "${topicLabel(activeTopic!)}"...`
                      : "Type a message... (Shift+Enter for a new line)")
          }
          // text-base on mobile prevents iOS Safari from auto-zooming on focus
          // (anything below 16px triggers zoom). md+ keeps our compact size.
          // resize-none + auto-grow effect manages height; leading-snug keeps
          // line spacing tight so multi-line posts don't waste vertical room.
          //
          // Mobile min-height (`min-h-[68px]`) is tuned to match the right
          // column's natural height, ↵ (h-6 = 24px) + gap-1 (4px) + Send
          // (h-10 = 40px), so a single-line empty textarea sits flush with
          // the column instead of leaving dead space below it. md+ keeps
          // the tight `min-h-8` because the ↵ button is hidden and Send
          // alone is only 32px tall. The auto-grow effect respects this
          // min via `el.style.height = "auto"` → scrollHeight measurement,
          // which folds min-height into the natural metric.
          className="block min-h-[68px] w-full resize-none rounded border border-keep-rule bg-keep-bg px-3 py-2 text-base leading-snug outline-none focus:border-keep-action disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-8 lg:py-1 lg:text-sm"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
        {/* `:emoji-name` typeahead. Renders nothing until the user
            types `:` at a word boundary. The popup itself is portaled
            to document.body so it can escape the composer's overflow
            and float over the message list. Hooks into the same
            `inputRef` + value/onChange triple already managed
            above. */}
        <EmoticonTypeahead
          textareaRef={inputRef}
          value={value}
          onChange={onChange}
        />
      </div>
      {/* Right column. On mobile the ↵ (newline) button stacks compact
          on top of Send so the two share a single vertical strip,
          freeing the textarea to fill the entire row width AND grow
          taller (the column's total height pushes the items-stretch
          textarea past its 40px floor for longer messages). On md+
          the ↵ is hidden (Shift+Enter works on a real keyboard) and
          the column collapses to just Send.
          `justify-end` pins both buttons to the bottom of the column
          so that when the textarea auto-grows to multiple lines the
          buttons stay near the keyboard / cursor line instead of
          floating up at the top of an oversized strip. */}
      <div className="flex shrink-0 flex-col justify-end gap-1">
        <button
          type="button"
          onClick={insertNewline}
          disabled={inputDisabled}
          aria-label="Insert line break"
          title="Insert line break"
          className="keep-button flex h-6 items-center justify-center rounded border border-keep-rule bg-keep-bg px-2 text-sm hover:bg-keep-banner disabled:cursor-not-allowed disabled:opacity-50 lg:hidden"
        >
          ↵
        </button>
        <button
          type="submit"
          disabled={submitDisabled}
          // h-10 mobile / lg:h-8 desktop. The mobile column is now
          // ↵ (h-6) + gap (4px) + Send (h-10) = 68px total, which
          // becomes the row's natural height via items-stretch, the
          // textarea grows to match, giving longer messages noticeably
          // more visible space. Breakpoint pinned to `lg` so the
          // mobile-vs-desktop boundary matches the rest of the chat
          // shell (rail visibility, ↵ button, format toolbar position)
          //, at viewports between `md` (768) and `lg` (1024) the rail
          // is still in drawer mode and the composer needs to keep its
          // mobile sizing to match.
          className="keep-button h-10 shrink-0 rounded border border-keep-rule bg-keep-bg px-4 text-sm hover:bg-keep-banner disabled:cursor-not-allowed disabled:opacity-50 lg:h-8"
        >
          {forumCreating ? "Post topic" : forumReplying ? "Reply" : "Send"}
        </button>
      </div>
      </div>
    </form>
  );
}

/**
 * Inline character counter for the toolbar row. Three-tier tint:
 *   - resting (≤ 80% of cap): muted, blends with the toolbar
 *   - approaching (> 80%, ≤ cap): amber, a warning before submit
 *   - over: accent (the theme's emphasis color), matches the
 *     TOO_LONG notice color so the toolbar and the toast feel
 *     coordinated. Submit handler blocks at > cap and leaves the
 *     draft in place; this is the user's visual cue to trim before
 *     resubmitting.
 */
function ComposerCharCount({
  length,
  max,
  className,
}: {
  length: number;
  max: number;
  className?: string;
}) {
  const over = length > max;
  const near = !over && length > max * 0.8;
  const tint = over
    ? "text-keep-accent font-semibold"
    : near
      ? "text-amber-500"
      : "text-keep-muted";
  return (
    <span
      aria-live="polite"
      aria-label={`Character count: ${length} of ${max}`}
      title={`${length} / ${max} characters`}
      className={`select-none whitespace-nowrap text-[11px] tabular-nums ${tint} ${className ?? ""}`}
    >
      {length} / {max}
      {/* "Chars" suffix hidden on narrow viewports to keep the
       *  counter compact when toolbar real estate is tight. */}
      <span className="ml-1 hidden lg:inline">Chars</span>
    </span>
  );
}

/**
 * Compact formatting-button helper for the Composer toolbar. Matches
 * the visual weight of the rail toggle / Send button (subtle border +
 * banner-tinted hover) so the strip reads as part of the same input.
 * onMouseDown.preventDefault keeps focus on the textarea, without it,
 * clicking a button would steal focus and the selection would
 * disappear before the wrap-handler runs.
 */
function FmtButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      // Square `h-8 w-8` (32px), previously `h-7 min-w-7 px-1.5`,
      // which let the `<>` button stretch wider than the single-char
      // buttons and let emoji glyphs (👁 ❝ 🔗 🖼) inflate the visual
      // bounds inconsistently across single-char text labels (B I S).
      // Forcing equal dimensions + `text-sm leading-none` normalizes
      // the row on mobile (which is where the misalignment was most
      // visible, because mobile renders emoji and text with bigger
      // baseline differences than desktop).
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-keep-rule/60 bg-keep-bg/60 text-sm leading-none text-keep-muted hover:bg-keep-banner hover:text-keep-text"
    >
      {children}
    </button>
  );
}
