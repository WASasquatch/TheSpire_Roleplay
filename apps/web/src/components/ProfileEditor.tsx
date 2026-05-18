import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { CharacterJournalEntry, CharacterPortrait, CharacterStats, ProfileLink, ProfileView, Role, Theme } from "@thekeep/shared";
import { DEFAULT_THEME, normalizeTheme } from "@thekeep/shared";
import { GENDER_OPTIONS, type Gender } from "../lib/gender.js";
import {
  isSupported as notifyIsSupported,
  permission as notifyPermission,
  requestPermission as notifyRequestPermission,
  type NotifyPref,
} from "../lib/notifications.js";
import { getSocket } from "../lib/socket.js";
import {
  disablePush,
  enablePush,
  readPushState,
  type PushState,
} from "../lib/push.js";
import { readError } from "../lib/http.js";
import { fetchEarningMe, patchEarningSettings } from "../lib/earning.js";
import { useChat } from "../state/store.js";
import { useEarning, lookupRankTier } from "../state/earning.js";
import { StylePicker } from "./AdminPanel.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { ProfileModal } from "./ProfileModal.js";
import { ThemePicker } from "./ThemePicker.js";
import { CloseButton } from "./CloseButton.js";
import { DisplayPrivacyRow } from "./DisplayPrivacyRow.js";

interface Props {
  /** Initial selection. The user can switch via the dropdown. */
  mode: "master" | "character";
  characterId: string | null;
  onClose: () => void;
  /**
   * Fires after every successful save so the parent can re-fetch the active
   * theme and re-apply it to the chat. The user doesn't have to close the
   * editor to see their theme change take effect.
   */
  onSaved?: () => void;
}

type UiFontScale = "small" | "medium" | "large" | "xl";

interface MasterData {
  username: string;
  bioHtml: string;
  avatarUrl: string | null;
  gender: Gender;
  chatColor: string | null;
  activeCharacterId: string | null;
  theme?: Theme;
  /** Per-user theme style override. Null/undefined means "use site default". */
  styleKey?: string | null;
  /** Free-form CSS font-family stack. Null = use default chat font. */
  uiFontFamily?: string | null;
  /** Font-size tier. Null = medium (default 16px). */
  uiFontScale?: UiFontScale | null;
  notifyPref?: NotifyPref;
  /** Per-event in-app sound toggles. Account-level (not per-character). */
  soundDmEnabled?: boolean;
  soundWhisperEnabled?: boolean;
  soundChatEnabled?: boolean;
  soundAlertEnabled?: boolean;
  /** Input-behavior opt-outs (account-level). See SoundRow / InputBehaviorRow. */
  disableInputHistory?: boolean;
  disableThesaurus?: boolean;
  /** Userlist display: when true, rank sigil replaces gender glyph in rail. */
  useRankAsUserlistIcon?: boolean;
  role?: Role;
  isPublic?: boolean;
  isNsfw?: boolean;
  /** Admin-tunable input caps. Surfaced so each composer's counter matches the server's accept threshold. */
  limits?: {
    maxBioLength: number;
    maxMessageLength: number;
    maxDirectMessageLength: number;
    maxForumPostLength: number;
    maxForumTopicTitleLength: number;
  };
}

interface CharacterRow {
  id: string;
  name: string;
  bioHtml: string;
  statsJson: string;
  avatarUrl: string | null;
  themeJson: string | null;
  /**
   * Per-character chat color override. Null = inherit the master
   * account's color. When set, every message authored AS this
   * character uses this color regardless of the tab's current `/color`
   * state — so Character A and Character B stay visually distinct
   * even when both belong to the same master account.
   */
  chatColor?: string | null;
  /**
   * Per-character theme style override (medieval/modern/scifi). Null =
   * inherit through master → theme-pinned → site default. Lets each
   * character carry its own design when active — pairs with the
   * existing `themeJson` palette override.
   */
  styleKey?: string | null;
  isPublic?: boolean;
  isNsfw?: boolean;
}

type Target = { kind: "master" } | { kind: "character"; id: string };

const STAT_FIELDS: Array<{ key: keyof CharacterStats; label: string }> = [
  { key: "age", label: "Age" },
  { key: "race", label: "Race" },
  { key: "gender", label: "Gender" },
  { key: "height", label: "Height" },
  { key: "weight", label: "Weight" },
  { key: "alignment", label: "Alignment" },
  { key: "occupation", label: "Occupation" },
];

/**
 * Profile editor with a target picker.
 *
 * The dropdown lists "Master account (OOC)" plus every character on the
 * account. Switching targets re-fetches that target's data and resets the
 * form. Saving is per-target and writes to the appropriate endpoint:
 *   - master       → PUT /me/profile
 *   - character    → PUT /characters/:id
 *
 * The character name and master username are read-only here. Master username
 * changes belong to account settings; character renames are blocked because
 * `messages.displayName` is snapshotted at send time and renaming would leave
 * a fragmented history.
 */
export function ProfileEditor({ mode: initialMode, characterId: initialCharId, onClose, onSaved }: Props) {
  const [target, setTarget] = useState<Target>(
    initialMode === "character" && initialCharId
      ? { kind: "character", id: initialCharId }
      : { kind: "master" },
  );
  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [master, setMaster] = useState<MasterData | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingTarget, setLoadingTarget] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state - reset whenever target changes
  const [name, setName] = useState("");
  const [bioHtml, setBioHtml] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [chatColor, setChatColor] = useState<string | null>(null);
  const [gender, setGender] = useState<Gender>("undisclosed");
  const [stats, setStats] = useState<CharacterStats>({});
  /** When the form has a theme set; null means "use default / inherit". */
  const [theme, setTheme] = useState<Theme | null>(null);
  /**
   * Theme style override for the *current target* — master or character.
   * Master: persisted to `users.style_key`; null = follow theme-pinned
   * design then site default.
   * Character: persisted to `characters.style_key`; null = inherit
   * the chain (master → theme-pinned → site default).
   * Re-keyed on every target switch in the load effect below.
   */
  const [userStyleKey, setUserStyleKey] = useState<string | null>(null);
  // Per-user UI font + size accessibility prefs (master target only).
  // Characters don't get their own; font is a per-account setting.
  const [uiFontFamily, setUiFontFamily] = useState<string | null>(null);
  const [uiFontScale, setUiFontScale] = useState<UiFontScale | null>(null);
  const [notifyPref, setNotifyPref] = useState<NotifyPref>("mentions");
  // Per-event in-app sound toggles. Account-level (master target only); a
  // character switch doesn't carry its own audio prefs. All default
  // to enabled to match the server schema.
  const [soundDmEnabled, setSoundDmEnabled] = useState<boolean>(true);
  const [soundWhisperEnabled, setSoundWhisperEnabled] = useState<boolean>(true);
  const [soundChatEnabled, setSoundChatEnabled] = useState<boolean>(true);
  const [soundAlertEnabled, setSoundAlertEnabled] = useState<boolean>(true);
  // Per-user input-behavior toggles. Default off (= features on). Pushed
  // through `useChat.setInputPrefs` on save so the live Composer/Synonym
  // popup picks them up without a reload.
  const [disableInputHistory, setDisableInputHistory] = useState<boolean>(false);
  const [disableThesaurus, setDisableThesaurus] = useState<boolean>(false);
  // Public + NSFW visibility flags. Default isPublic=true, isNsfw=false to
  // match the schema. NSFW=true forces isPublic=false on save (server
  // enforces this too); the UI mirrors that by disabling the Public box.
  const [isPublic, setIsPublic] = useState<boolean>(true);
  const [isNsfw, setIsNsfw] = useState<boolean>(false);
  /** Extra portraits beyond the primary avatarUrl (character targets only). */
  const [portraits, setPortraits] = useState<CharacterPortrait[]>([]);
  /** Owner-set external links rendered as styled chips on the profile. */
  const [links, setLinks] = useState<ProfileLink[]>([]);
  // Permission state is volatile - re-read on each render via a key bump.
  const [permVersion, setPermVersion] = useState(0);

  /**
   * Active editor tab. The settings used to stack vertically in one column
   * next to the bio editor, which made the color picker etc. cramped at
   * 420px and forced scrolling through unrelated sections. The tabbed
   * layout gives each section the full modal width.
   *
   * Tabs:
   *   - description: bio HTML editor (was the right column)
   *   - profile:     name, avatar, gender (master), stats (character)
   *   - appearance:  theme colors, theme style, fonts (master only)
   *   - privacy:     visibility, NSFW, push, notifications
   *   - links:       profile-link chips
   *   - gallery:     portrait gallery (character only)
   *   - journal:     character journal (character only)
   */
  type EditorTab =
    | "description"
    | "profile"
    | "appearance"
    | "privacy"
    | "links"
    | "gallery"
    | "journal";
  const [activeTab, setActiveTab] = useState<EditorTab>("description");

  // Switching from a character → master target removes the Gallery and
  // Journal tabs from the strip. If the user happened to be on one of
  // those tabs at the moment of the switch, fall back to "profile" so
  // the content pane doesn't go blank.
  useEffect(() => {
    if (target.kind === "master" && (activeTab === "gallery" || activeTab === "journal")) {
      setActiveTab("profile");
    }
  }, [target.kind, activeTab]);

  // "+ New character" modal toggle. When the user creates a character we POST
  // /characters, splice the row into the local list, and switch the editor's
  // target to the new character so the user lands in its editor.
  const [createOpen, setCreateOpen] = useState(false);
  // Per-character delete in-flight flag. The button stays disabled while
  // DELETE /characters/:id is pending so users can't double-submit and have
  // the second call return 404.
  const [deleting, setDeleting] = useState(false);
  const [switching, setSwitching] = useState(false);

  // Initial load: master + character list (we always need both for the dropdown).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [mRes, cRes] = await Promise.all([
          fetch("/me/profile", { credentials: "include" }),
          fetch("/characters", { credentials: "include" }),
        ]);
        if (!mRes.ok) throw new Error(await readError(mRes));
        if (!cRes.ok) throw new Error(await readError(cRes));
        const m = (await mRes.json()) as MasterData;
        const cl = (await cRes.json()) as { characters: CharacterRow[] };
        if (cancelled) return;
        setMaster(m);
        setCharacters(cl.characters);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Re-populate the form whenever target changes (or its source data arrives).
  useEffect(() => {
    let cancelled = false;
    setLoadingTarget(true);
    setError(null);
    (async () => {
      try {
        if (target.kind === "master") {
          if (!master) return; // not loaded yet
          if (cancelled) return;
          setName(master.username);
          setBioHtml(master.bioHtml ?? "");
          setAvatarUrl(master.avatarUrl ?? "");
          setChatColor(master.chatColor);
          setGender(master.gender ?? "undisclosed");
          setStats({});
          setTheme(master.theme ? normalizeTheme(master.theme) : null);
          setUserStyleKey(typeof master.styleKey === "string" ? master.styleKey : null);
          setUiFontFamily(typeof master.uiFontFamily === "string" ? master.uiFontFamily : null);
          setUiFontScale(
            master.uiFontScale === "small" || master.uiFontScale === "medium" ||
            master.uiFontScale === "large" || master.uiFontScale === "xl"
              ? master.uiFontScale
              : null,
          );
          setNotifyPref(master.notifyPref ?? "mentions");
          setSoundDmEnabled(master.soundDmEnabled ?? true);
          setSoundWhisperEnabled(master.soundWhisperEnabled ?? true);
          setSoundChatEnabled(master.soundChatEnabled ?? true);
          setSoundAlertEnabled(master.soundAlertEnabled ?? true);
          setDisableInputHistory(master.disableInputHistory ?? false);
          setDisableThesaurus(master.disableThesaurus ?? false);
          setIsPublic(master.isPublic ?? true);
          setIsNsfw(master.isNsfw ?? false);
          setPortraits([]); // master has no gallery; only characters do
          // Master/OOC links live under /me/links (characterId IS NULL).
          try {
            const lr = await fetch("/me/links", { credentials: "include" });
            if (lr.ok) {
              const lj = (await lr.json()) as { links: ProfileLink[] };
              if (!cancelled) setLinks(lj.links);
            }
          } catch { /* links section is non-fatal */ }
          setLoadingTarget(false);
        } else {
          // Always re-fetch on switch so we have fresh statsJson; the list endpoint
          // returns the same data but we don't want to assume.
          const r = await fetch(`/characters/${target.id}`, { credentials: "include" });
          if (!r.ok) throw new Error(await readError(r));
          const c = (await r.json()) as CharacterRow;
          if (cancelled) return;
          setName(c.name);
          setBioHtml(c.bioHtml ?? "");
          setAvatarUrl(c.avatarUrl ?? "");
          // Per-character chat color. Null means "fall back to the
          // master account's color" — preserved as a distinct state
          // from "" so the picker can tell apart "no override set"
          // (inherit) from a deliberate clear-to-default.
          setChatColor(c.chatColor ?? null);
          try {
            setStats(c.statsJson ? JSON.parse(c.statsJson) : {});
          } catch {
            setStats({});
          }
          if (c.themeJson) {
            try { setTheme(normalizeTheme(JSON.parse(c.themeJson))); }
            catch { setTheme(null); }
          } else {
            setTheme(null);
          }
          // Per-character design override. Null = inherit through
          // master → theme-pinned → site default. Persists the user's
          // pick in the Theme Style picker below.
          setUserStyleKey(typeof c.styleKey === "string" ? c.styleKey : null);
          setIsPublic(c.isPublic ?? true);
          setIsNsfw(c.isNsfw ?? false);
          // Pull the gallery in parallel with the row fetch above? We do it
          // sequentially here to keep the early-return-on-error simple; the
          // payload is small (under 12 rows in the worst case).
          try {
            const pr = await fetch(`/characters/${target.id}/portraits`, { credentials: "include" });
            if (pr.ok) {
              const pj = (await pr.json()) as { portraits: Array<{ id: string; url: string; label: string | null; nsfw?: boolean }> };
              if (!cancelled) setPortraits(pj.portraits.map((p) => ({ id: p.id, url: p.url, label: p.label, nsfw: !!p.nsfw })));
            }
          } catch { /* gallery is non-fatal */ }
          try {
            const lr = await fetch(`/characters/${target.id}/links`, { credentials: "include" });
            if (lr.ok) {
              const lj = (await lr.json()) as { links: ProfileLink[] };
              if (!cancelled) setLinks(lj.links);
            }
          } catch { /* links section is non-fatal */ }
          setLoadingTarget(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "load failed");
          setLoadingTarget(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [target, master]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (target.kind === "master") {
        const r = await fetch("/me/profile", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bioHtml,
            avatarUrl: avatarUrl.trim() || null,
            gender,
            theme,
            styleKey: userStyleKey,
            uiFontFamily: uiFontFamily && uiFontFamily.trim() !== "" ? uiFontFamily.trim() : null,
            uiFontScale,
            notifyPref,
            soundDmEnabled,
            soundWhisperEnabled,
            soundChatEnabled,
            soundAlertEnabled,
            disableInputHistory,
            disableThesaurus,
            chatColor,
            isPublic,
            isNsfw,
          }),
        });
        if (!r.ok) throw new Error(await readError(r));
        // Update the in-memory master copy so the dropdown stays in sync.
        setMaster((prev) => {
          if (!prev) return prev;
          const next: MasterData = {
            ...prev,
            bioHtml,
            avatarUrl: avatarUrl.trim() || null,
            gender,
            notifyPref,
            soundDmEnabled,
            soundWhisperEnabled,
            soundChatEnabled,
            soundAlertEnabled,
            disableInputHistory,
            disableThesaurus,
            styleKey: userStyleKey,
            uiFontFamily: uiFontFamily && uiFontFamily.trim() !== "" ? uiFontFamily.trim() : null,
            uiFontScale,
            chatColor,
            // NSFW=true forces isPublic=false on the server. Mirror that
            // implication client-side so the cached MasterData stays
            // consistent with what the next /me/profile load would return.
            isPublic: isNsfw ? false : isPublic,
            isNsfw,
          };
          if (theme) next.theme = theme;
          else delete next.theme;
          return next;
        });
        // Push the new sound prefs into the global store so lib/sound
        // picks them up before the next ping/tap/alert event fires —
        // no need to wait for the next /me/profile reload.
        useChat.getState().setSoundPrefs({
          dm: soundDmEnabled,
          whisper: soundWhisperEnabled,
          chat: soundChatEnabled,
          alert: soundAlertEnabled,
        });
        // Mirror the input-behavior opt-outs into the store so the
        // Composer (history) + SynonymPopup (thesaurus) honor the new
        // values before the next /me/profile refresh runs.
        useChat.getState().setInputPrefs({
          disableHistory: disableInputHistory,
          disableThesaurus,
        });
      } else {
        const r = await fetch(`/characters/${target.id}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bioHtml,
            stats,
            avatarUrl: avatarUrl.trim() || null,
            theme,
            chatColor,
            // Per-character design override. Null = inherit; non-null
            // overrides the resolution chain when this character is
            // active. The server's PUT handler accepts the same shape
            // as `chatColor` (partial-update with null-clears-override
            // semantics).
            styleKey: userStyleKey,
            isPublic,
            isNsfw,
          }),
        });
        if (!r.ok) throw new Error(await readError(r));
        // Update the cached character list so the dropdown shows fresh names/avatars
        setCharacters((prev) =>
          prev.map((c) =>
            c.id === target.id
              ? {
                  ...c,
                  bioHtml,
                  statsJson: JSON.stringify(stats),
                  avatarUrl: avatarUrl.trim() || null,
                  themeJson: theme ? JSON.stringify(theme) : null,
                  chatColor,
                  styleKey: userStyleKey,
                  isPublic: isNsfw ? false : isPublic,
                  isNsfw,
                }
              : c,
          ),
        );
      }
      // Stay in the editor so the user can switch to another target. Could also
      // close here - left open by design to support batch edits.
      flashSaved();
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  const [savedFlash, setSavedFlash] = useState(false);
  function flashSaved() {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1500);
  }

  /**
   * Switch THIS tab's active character to the one currently being edited.
   * Equivalent to typing `/char switch <name>` from chat — and like that
   * path, it routes through the socket so the change is scoped to this
   * tab. Other tabs the user has open keep voicing whatever they were.
   * The server emits `me:character-update` which App.tsx picks up to
   * refresh local activeCharacterId/Name + theme without polling.
   */
  async function switchToCharacter() {
    if (target.kind !== "character") return;
    setError(null);
    setSwitching(true);
    const charId = target.id;
    getSocket().emit("me:switch-character", { characterId: charId }, (res) => {
      setSwitching(false);
      if (res.ok) {
        // Track the change locally so the Switch button hides without
        // waiting for the App.tsx-level me:character-update handler
        // to round-trip its state update back to props.
        setMaster((prev) => (prev ? { ...prev, activeCharacterId: charId } : prev));
        onSaved?.();
      } else {
        setError(res.message ?? "switch failed");
      }
    });
  }

  /**
   * Delete the currently-targeted character. Soft-delete on the server so
   * past chat history keeps its snapshotted name. After success we drop the
   * row from the local list and switch back to the master target.
   */
  async function deleteCharacter() {
    if (target.kind !== "character") return;
    const charName = characters.find((c) => c.id === target.id)?.name ?? "this character";
    if (!window.confirm(
      `Delete "${charName}"? Past chat history keeps the name; the character can't be restored.`,
    )) return;
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/characters/${target.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      setCharacters((prev) => prev.filter((c) => c.id !== target.id));
      setTarget({ kind: "master" });
      // The active theme may change if the deleted char was active (server
      // cleared activeCharacterId, so chat falls back to the master theme).
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Preview pane - opens a ProfileModal showing the current form state as
   * other users would see it. Pulled from local state (not the server) so
   * the user can preview unsaved edits while iterating.
   */
  const [previewing, setPreviewing] = useState(false);
  // Real authenticated user id, used by the preview path so the
  // ProfileModal's earning fetch (`/earning/users/:id`) resolves to
  // the actual rank/XP/currency for the viewer. The original
  // implementation used the stub string "preview" which 404'd the
  // fetch and silently hid the earning chips on the in-editor
  // preview.
  const myUserId = useChat((s) => s.me?.id ?? null);
  // Real activity counts for the previewed identity. Fetched from
  // `/profiles/:name` lazily on first preview open; cached per target
  // so flipping the modal closed and back open doesn't refetch. Null
  // entries here mean "haven't fetched yet"; the modal renders
  // "private" placeholders for the brief moment before the fetch
  // returns. Once it lands, the real counts replace them — including
  // for the owner's own preview, because /profiles/:name bypasses
  // the hide-flag redaction when viewer === owner.
  const [previewMetrics, setPreviewMetrics] = useState<
    Record<string, { chatMessages: number | null; forumTopics: number | null; forumReplies: number | null }>
  >({});
  const previewTargetKey = target.kind === "master" ? "master" : `c:${target.id}`;
  useEffect(() => {
    if (!previewing) return;
    if (previewMetrics[previewTargetKey]) return;
    const name = target.kind === "master" ? master?.username : characters.find((c) => c.id === target.id)?.name;
    if (!name) return;
    let cancelled = false;
    fetch(`/profiles/${encodeURIComponent(name)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        if (cancelled || !j || typeof j !== "object") return;
        const view = j as { profile?: { metrics?: typeof previewMetrics[string] } };
        const m = view.profile?.metrics;
        if (!m) return;
        setPreviewMetrics((prev) => ({ ...prev, [previewTargetKey]: m }));
      })
      .catch(() => { /* falls back to null placeholders */ });
    return () => { cancelled = true; };
  }, [previewing, previewTargetKey, target, master, characters, previewMetrics]);
  const previewProfile: ProfileView | null = useMemo(() => {
    const previewTheme = theme ?? DEFAULT_THEME;
    // Metrics come from the server-side fetch above (cached per
    // target). Until that lands, fall through to null placeholders
    // so the modal renders "private" briefly rather than fake zeros.
    const fetchedMetrics = previewMetrics[previewTargetKey] ?? {
      chatMessages: null,
      forumTopics: null,
      forumReplies: null,
    };
    if (target.kind === "master") {
      if (!master) return null;
      return {
        kind: "master",
        profile: {
          userId: myUserId ?? "preview",
          username: master.username,
          bioHtml: bioHtml,
          avatarUrl: avatarUrl.trim() || null,
          gender,
          theme: previewTheme,
          // Titles are populated server-side from accepted relationships;
          // the editor preview shows the form's contents only.
          titles: [],
          links,
          role: master.role ?? "user",
          isPublic: isNsfw ? false : isPublic,
          isNsfw,
          createdAt: Date.now(),
          // Real lifetime activity counts pulled via /profiles/:name on
          // first preview open. The server-side computeProfileMetrics
          // bypasses the owner's hide flags for self-view, so the
          // preview reflects what OTHER users would see while still
          // showing the owner their own counts when their flags are
          // off. (Earlier this was hardcoded to null, which always
          // rendered "private" regardless of the owner's flags.)
          metrics: fetchedMetrics,
        },
      };
    }
    return {
      kind: "character",
      profile: {
        id: target.id,
        // Real owning userId so the ProfileModal preview fetches
        // actual earning. See master branch above for context.
        userId: myUserId ?? "preview",
        name,
        bioHtml,
        stats,
        avatarUrl: avatarUrl.trim() || null,
        portraits,
        links,
        // Journal entries are managed inline in the editor (not via preview).
        // The preview ProfileModal shows the character preview as others
        // would see it, but live-fetching journal here would mix the
        // editor's "all entries" view with the modal's "public only" view.
        // Easier to leave the preview empty and let the user open the
        // actual profile to verify.
        journalEntries: [],
        theme: previewTheme,
        titles: [],
        isPublic: isNsfw ? false : isPublic,
        isNsfw,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metrics: fetchedMetrics,
      },
    };
  }, [target, master, myUserId, name, bioHtml, avatarUrl, gender, stats, theme, portraits, links, isPublic, isNsfw, previewMetrics, previewTargetKey]);

  const targetOptions = useMemo(() => {
    return [
      { value: "master:", label: master ? `Master OOC - ${master.username}` : "Master OOC" },
      ...characters.map((c) => ({ value: `character:${c.id}`, label: c.name })),
    ];
  }, [master, characters]);

  function onSelectTarget(value: string) {
    if (value.startsWith("master:")) setTarget({ kind: "master" });
    else if (value.startsWith("character:")) setTarget({ kind: "character", id: value.slice(10) });
  }

  const isCharacter = target.kind === "character";
  const targetValue = target.kind === "master" ? "master:" : `character:${target.id}`;

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-parchment`}
      >
        {/* header - fixed */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-keep-rule bg-keep-banner px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="shrink-0 font-action text-lg">Edit profile</h2>
            <select
              value={targetValue}
              onChange={(e) => onSelectTarget(e.target.value)}
              disabled={loadingList}
              className="min-w-0 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm"
            >
              {loadingList ? (
                <option>loading...</option>
              ) : (
                targetOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))
              )}
            </select>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              disabled={loadingList}
              title="Create a new character under your account"
              className="shrink-0 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm hover:bg-keep-banner disabled:opacity-50"
            >
              + New
            </button>
            {isCharacter && master && master.activeCharacterId !== (target.kind === "character" ? target.id : null) ? (
              <button
                type="button"
                onClick={switchToCharacter}
                disabled={switching || loadingTarget}
                title="Switch to this character - your chat name and theme update immediately."
                className="keep-button shrink-0 rounded border border-keep-action/60 bg-keep-bg px-2 py-0.5 text-sm text-keep-action hover:bg-keep-action/10 disabled:opacity-50"
              >
                {switching ? "Switching..." : "Switch"}
              </button>
            ) : null}
            {isCharacter ? (
              <button
                type="button"
                onClick={deleteCharacter}
                disabled={deleting || loadingTarget}
                title="Delete this character. Past message history keeps the snapshotted name."
                className="keep-button shrink-0 rounded border border-keep-accent/60 bg-keep-bg px-2 py-0.5 text-sm text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            ) : null}
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {/* Tab strip. Replaces the old mobile-only Settings/Description
            split + the two-column desktop grid. Each tab gets the full
            modal width so the color picker, links editor, etc. have
            room to breathe instead of fighting a 420px sidebar. The
            strip scrolls horizontally on narrow viewports — mobile
            users swipe; desktop users see them all at once.
            `flex-nowrap` + `overflow-x-auto` is the canonical pattern
            for this. */}
        {(() => {
          const tabs: Array<{ id: EditorTab; label: string; show: boolean }> = [
            { id: "description", label: "Description", show: true },
            { id: "profile",     label: "Profile",     show: true },
            { id: "appearance",  label: "Appearance",  show: true },
            { id: "privacy",     label: "Privacy",     show: true },
            { id: "links",       label: "Links",       show: true },
            { id: "gallery",     label: "Gallery",     show: isCharacter },
            { id: "journal",     label: "Journal",     show: isCharacter },
          ];
          return (
            <div
              className="flex shrink-0 flex-nowrap overflow-x-auto border-b border-keep-rule bg-keep-banner/40"
              role="tablist"
            >
              {tabs.filter((t) => t.show).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`shrink-0 whitespace-nowrap px-3 py-2 text-xs uppercase tracking-widest ${
                    activeTab === t.id
                      ? "border-b-2 border-keep-action text-keep-text"
                      : "text-keep-muted hover:text-keep-text"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          );
        })()}

        {/* Tab content — fills remaining height; scrolls when long. */}
        {loadingTarget ? (
          <div className="flex flex-1 items-center justify-center text-keep-muted">loading...</div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* DESCRIPTION — the bio HTML editor. Was the right column on
                desktop; now its own tab so it gets the full width too. */}
            {activeTab === "description" ? (
              <div className="flex min-h-0 flex-1 flex-col p-4">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="uppercase tracking-widest text-keep-muted">
                    {isCharacter ? "Character bio" : "OOC bio"}
                  </span>
                  <span className="text-keep-muted">
                    HTML allowed: b, i, u, em, strong, a, img, br, p, ul/ol/li, blockquote, hr, h3-h6, span style=color
                  </span>
                </div>
                <textarea
                  value={bioHtml}
                  onChange={(e) => setBioHtml(e.target.value)}
                  className="min-h-0 w-full flex-1 resize-none rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs outline-none focus:border-keep-action"
                  placeholder={
                    isCharacter
                      ? "<p>A weather-beaten mercenary from the Reach...</p>"
                      : "<p>Time-zone, contact preferences, RP boundaries, anything OOC.</p>"
                  }
                />
                <div className="mt-1 text-right text-[10px] text-keep-muted tabular-nums">
                  {bioHtml.length.toLocaleString()} / {(master?.limits?.maxBioLength ?? 50_000).toLocaleString()}
                </div>
              </div>
            ) : null}

            {/* PROFILE — name, avatar, gender (master) / stats (character).
                The bread-and-butter "who am I" tab. */}
            {activeTab === "profile" ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <Field
                  label={isCharacter ? "Character name" : "Master username"}
                  value={name}
                  readOnly
                  hint={isCharacter ? "Renaming is blocked - message history snapshots the name at send time." : "Set at registration."}
                />
                <Field
                  label="Main Profile Image URL"
                  value={avatarUrl}
                  onChange={setAvatarUrl}
                  placeholder="https://example.com/portrait.png"
                  hint="Drives the userlist icon, the modal hero, and the full-size footer image."
                />
                {!isCharacter ? (
                  <label className="block text-xs">
                    <span className="mb-1 block uppercase tracking-widest text-keep-muted">Gender (OOC)</span>
                    <select
                      value={gender}
                      onChange={(e) => setGender(e.target.value as Gender)}
                      className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
                    >
                      {GENDER_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span className="mt-1 block text-[10px] text-keep-muted">
                      Renders as an icon next to your username when no character is active.
                    </span>
                  </label>
                ) : null}
                {isCharacter ? (
                  <fieldset className="rounded border border-keep-rule p-3">
                    <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">Stats</legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {STAT_FIELDS.map(({ key, label }) => (
                        <label key={key} className="block text-xs">
                          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
                          {key === "gender" ? (
                            <select
                              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                              value={(stats.gender as string) ?? ""}
                              onChange={(e) =>
                                setStats((s) => {
                                  const next = { ...s };
                                  if (e.target.value) next.gender = e.target.value;
                                  else delete next.gender;
                                  return next;
                                })
                              }
                            >
                              <option value="">-</option>
                              {GENDER_OPTIONS.filter((o) => o.value !== "undisclosed").map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                              value={(stats[key] as string) ?? ""}
                              onChange={(e) =>
                                setStats((s) => ({ ...s, [key]: e.target.value || undefined }))
                              }
                            />
                          )}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
              </div>
            ) : null}

            {/* APPEARANCE — chat color, theme palette, theme style
                (master), font/size (master). All the visual customization
                in one place so the color picker has the full modal width
                instead of getting squeezed to 420px. */}
            {activeTab === "appearance" ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <ChatColorRow
                  scope={isCharacter ? "character" : "master"}
                  value={chatColor}
                  onChange={setChatColor}
                />
                <fieldset className="rounded border border-keep-rule p-3">
                  <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
                    {isCharacter ? "Character theme" : "OOC theme"}
                  </legend>
                  <p className="mb-2 text-[10px] text-keep-muted">
                    {isCharacter
                      ? "Switching to this character applies this theme to your chat. Others viewing this character's profile see it themed this way."
                      : "Applied to your chat when no character is active, and to your master profile modal."}
                  </p>
                  <ThemePicker
                    theme={theme ?? DEFAULT_THEME}
                    onChange={setTheme}
                    onReset={() => setTheme(null)}
                  />
                  {!theme ? (
                    <div className="mt-1 text-[10px] italic text-keep-muted">
                      Currently using the system default - change a color or pick a preset to start customizing.
                    </div>
                  ) : null}
                </fieldset>
                <fieldset className="rounded border border-keep-rule p-3">
                  <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">Theme style</legend>
                  <p className="mb-2 text-[10px] text-keep-muted">
                    {isCharacter
                      ? "Visual treatment — ornaments, borders, textures — applied when this character is active. Leave on \"use default\" to inherit your master account, then the theme's pinned design, then the site default."
                      : "Visual treatment — ornaments, borders, textures. Orthogonal to the palette above; the same style works with any colors. Leave on \"use default\" to follow the theme's pinned design (admin-configured per palette) and finally the site default."}
                  </p>
                  <StylePicker
                    value={userStyleKey}
                    onChange={setUserStyleKey}
                    allowInherit
                  />
                </fieldset>
                {!isCharacter ? (
                  <fieldset className="rounded border border-keep-rule p-3">
                    <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
                      Reading &amp; accessibility
                    </legend>
                    <p className="mb-2 text-[10px] text-keep-muted">
                      Pick a font and a size to override the defaults if the
                      regular interface is hard to read. The Google web fonts
                      load automatically; the rest are system fonts every OS
                      ships with. Leave on "Default" to follow the site's
                      built-in font.
                    </p>
                    <label className="block text-xs">
                      <span className="mb-1 block uppercase tracking-widest text-keep-muted">
                        Font family
                      </span>
                      <select
                        value={uiFontFamily ?? ""}
                        onChange={(e) => setUiFontFamily(e.target.value === "" ? null : e.target.value)}
                        // Render the dropdown trigger in the currently-
                        // selected font so the preview is visible without
                        // having to save first. Per-option font previews
                        // are attempted via inline `style.fontFamily`;
                        // some browsers honor it in the open dropdown,
                        // some show all options in the default UI font —
                        // both behaviors are acceptable.
                        style={uiFontFamily ? { fontFamily: uiFontFamily } : undefined}
                        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
                      >
                        <option value="">Default (site font)</option>
                        <optgroup label="Sans-serif (Google)">
                          <option value='"Roboto", sans-serif' style={{ fontFamily: '"Roboto", sans-serif' }}>Roboto</option>
                          <option value='"Open Sans", sans-serif' style={{ fontFamily: '"Open Sans", sans-serif' }}>Open Sans</option>
                          <option value='"Inter", sans-serif' style={{ fontFamily: '"Inter", sans-serif' }}>Inter</option>
                          <option value='"Lato", sans-serif' style={{ fontFamily: '"Lato", sans-serif' }}>Lato</option>
                          <option value='"Source Sans 3", sans-serif' style={{ fontFamily: '"Source Sans 3", sans-serif' }}>Source Sans 3</option>
                        </optgroup>
                        <optgroup label="Serif (Google)">
                          <option value='"Lora", serif' style={{ fontFamily: '"Lora", serif' }}>Lora</option>
                          <option value='"Merriweather", serif' style={{ fontFamily: '"Merriweather", serif' }}>Merriweather</option>
                          <option value='"Roboto Slab", serif' style={{ fontFamily: '"Roboto Slab", serif' }}>Roboto Slab</option>
                        </optgroup>
                        <optgroup label="Accessibility">
                          <option value='"Atkinson Hyperlegible", sans-serif' style={{ fontFamily: '"Atkinson Hyperlegible", sans-serif' }}>Atkinson Hyperlegible</option>
                          <option value='"Comic Sans MS", "Chalkboard SE", sans-serif' style={{ fontFamily: '"Comic Sans MS", "Chalkboard SE", sans-serif' }}>Comic Sans (dyslexia-friendly)</option>
                        </optgroup>
                        <optgroup label="System fonts">
                          <option value='system-ui, sans-serif' style={{ fontFamily: 'system-ui, sans-serif' }}>System sans-serif</option>
                          <option value='Georgia, serif' style={{ fontFamily: 'Georgia, serif' }}>Georgia</option>
                          <option value='Verdana, sans-serif' style={{ fontFamily: 'Verdana, sans-serif' }}>Verdana</option>
                          <option value='Arial, sans-serif' style={{ fontFamily: 'Arial, sans-serif' }}>Arial</option>
                        </optgroup>
                      </select>
                    </label>
                    <label className="mt-3 block text-xs">
                      <span className="mb-1 block uppercase tracking-widest text-keep-muted">
                        Font size
                      </span>
                      <select
                        value={uiFontScale ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "small" || v === "medium" || v === "large" || v === "xl") {
                            setUiFontScale(v);
                          } else {
                            setUiFontScale(null);
                          }
                        }}
                        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
                      >
                        <option value="">Default (medium)</option>
                        <option value="small">Small (14px desktop / 12px mobile)</option>
                        <option value="medium">Medium (16px desktop / 14px mobile)</option>
                        <option value="large">Large (18px desktop / 16px mobile)</option>
                        <option value="xl">Extra large (20px desktop / 18px mobile)</option>
                      </select>
                    </label>
                  </fieldset>
                ) : null}
              </div>
            ) : null}

            {/* PRIVACY — visibility (public / NSFW), push notifications,
                desktop notification preference. All the "who can see /
                hear from me" toggles. */}
            {activeTab === "privacy" ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <VisibilityRow
                  isPublic={isPublic}
                  isNsfw={isNsfw}
                  onChangePublic={setIsPublic}
                  onChangeNsfw={setIsNsfw}
                  kind={isCharacter ? "character" : "master"}
                />
                {!isCharacter ? (
                  <NotificationsRow
                    pref={notifyPref}
                    onChangePref={setNotifyPref}
                    permVersion={permVersion}
                    onPermissionChange={() => setPermVersion((v) => v + 1)}
                  />
                ) : null}
                {!isCharacter ? (
                  <SoundRow
                    dm={soundDmEnabled}
                    whisper={soundWhisperEnabled}
                    chat={soundChatEnabled}
                    alert={soundAlertEnabled}
                    onChangeDm={setSoundDmEnabled}
                    onChangeWhisper={setSoundWhisperEnabled}
                    onChangeChat={setSoundChatEnabled}
                    onChangeAlert={setSoundAlertEnabled}
                  />
                ) : null}
                {!isCharacter ? (
                  <InputBehaviorRow
                    disableHistory={disableInputHistory}
                    disableThesaurus={disableThesaurus}
                    onChangeDisableHistory={setDisableInputHistory}
                    onChangeDisableThesaurus={setDisableThesaurus}
                  />
                ) : null}
                {/* Earning — Currency privacy. Master-only; characters
                    inherit the master's privacy flag and don't have their
                    own. Self-saving (immediate PATCH to
                    /earning/me/settings), so it doesn't ride the
                    profile form's Save button. */}
                {!isCharacter ? <CurrencyPrivacyRow /> : null}
                {/* Rank-visibility toggles + metric privacy. Both
                    are per-master-account preferences; characters
                    don't have separate versions, so we gate the
                    render on `!isCharacter`. Self-saving via the
                    /me/profile PUT for the same reason CurrencyPrivacyRow
                    self-saves — the row sits alongside other privacy
                    sections and "checked it, expected it, didn't see
                    a Save button" was a sharp paper-cut earlier. */}
                {!isCharacter ? <DisplayPrivacyRow /> : null}
              </div>
            ) : null}

            {/* LINKS — profile-link chips, edited via the existing
                LinksEditor component. */}
            {activeTab === "links" ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <LinksEditor
                  scope={target.kind === "character" ? { kind: "character", id: target.id } : { kind: "master" }}
                  links={links}
                  onChange={setLinks}
                />
              </div>
            ) : null}

            {/* GALLERY — portrait gallery (character only). */}
            {activeTab === "gallery" && isCharacter && target.kind === "character" ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <PortraitGalleryEditor
                  characterId={target.id}
                  portraits={portraits}
                  onChange={setPortraits}
                />
              </div>
            ) : null}

            {/* JOURNAL — character journal entries (character only). */}
            {activeTab === "journal" && isCharacter && target.kind === "character" ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <JournalEditor characterId={target.id} />
              </div>
            ) : null}

            {error ? (
              <div className="mx-4 mb-2 shrink-0 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
                {error}
              </div>
            ) : null}
          </div>
        )}

        {/* footer - fixed */}
        <div className="flex shrink-0 items-center justify-between border-t border-keep-rule bg-keep-banner/40 p-2">
          <span className={`text-xs ${savedFlash ? "text-keep-system" : "text-keep-muted"}`}>
            {savedFlash ? "Saved." : ""}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPreviewing(true)}
              disabled={loadingTarget || !previewProfile}
              title="Preview this profile as other users will see it (uses your unsaved edits)."
              className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm disabled:opacity-50 hover:bg-keep-banner"
            >
              View profile
            </button>
            <button
              type="button"
              onClick={onClose}
              // Cancel = neutral, muted. Save = primary, action-color
              // tint. The two are visually distinct so a fast click
              // doesn't accidentally discard unsaved edits — the
              // accent on Save reads as the "go" button at a glance.
              className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm text-keep-muted hover:bg-keep-banner hover:text-keep-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || loadingTarget}
              className="keep-button rounded border border-keep-action bg-keep-action/15 px-4 py-1 text-sm font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </form>
      {previewing && previewProfile ? (
        // stopPropagation so clicking the preview backdrop (which closes the
        // preview) doesn't bubble to the editor's backdrop and close that too.
        <div onClick={(e) => e.stopPropagation()}>
          <ProfileModal profile={previewProfile} onClose={() => setPreviewing(false)} />
        </div>
      ) : null}
      {createOpen ? (
        <div onClick={(e) => e.stopPropagation()}>
          <CreateCharacterModal
            onCancel={() => setCreateOpen(false)}
            onCreated={(c) => {
              setCharacters((prev) => [...prev, c]);
              setTarget({ kind: "character", id: c.id });
              // Drop the user onto the description tab so they can start
              // writing immediately — most of the other tabs are empty
              // for a fresh character.
              setActiveTab("description");
              setCreateOpen(false);
            }}
          />
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * Name-prompt modal for creating a new character. POSTs /characters and on
 * success returns the new row to the parent so the editor can navigate to it.
 * Server is authoritative on validation; the client-side regex is a fast
 * pre-check so users get immediate feedback for bad chars.
 */
function CreateCharacterModal({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (c: CharacterRow) => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const localValid = /^[\p{L}\p{N}_\-' ]{1,40}$/u.test(trimmed);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!localValid || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/characters", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const c = (await res.json()) as CharacterRow;
      onCreated(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal onClose={onCancel} zIndex={60}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="keep-frame w-[min(420px,96vw)] rounded bg-keep-parchment p-4"
      >
        <h3 className="mb-2 font-action text-lg">New character</h3>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Character name</span>
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. JohnSmith"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-base outline-none focus:border-keep-action md:text-sm"
          />
        </label>
        <p className="mt-1 text-[10px] text-keep-muted">
          1-40 chars: letters, numbers, spaces, _ - '. Character names can't be changed, choose wisely.
        </p>
        {error ? (
          <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!localValid || submitting}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 text-sm hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Multi-portrait gallery management UI for character targets. Add by URL,
 * label, delete. Reordering deferred — most galleries are small and the
 * primary avatarUrl already drives the hero/userlist icon.
 *
 * Each mutation hits the server immediately so the gallery stays consistent
 * with what others see — no "save" button per portrait.
 */
function PortraitGalleryEditor({
  characterId,
  portraits,
  onChange,
}: {
  characterId: string;
  portraits: CharacterPortrait[];
  onChange: (next: CharacterPortrait[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [nsfw, setNsfw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Plain handler (not onSubmit) — see LinksEditor.add for why nesting a
  // <form> inside the outer ProfileEditor <form> silently routes the
  // submit to the wrong handler.
  async function add() {
    const u = url.trim();
    if (!u) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(`/characters/${characterId}/portraits`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: u,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(nsfw ? { nsfw: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const row = (await res.json()) as { id: string; url: string; label: string | null; nsfw: boolean };
      onChange([...portraits, { id: row.id, url: row.url, label: row.label, nsfw: !!row.nsfw }]);
      setUrl("");
      setLabel("");
      setNsfw(false);
      setAdding(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Remove this portrait from the gallery?")) return;
    try {
      const res = await fetch(`/characters/${characterId}/portraits/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      onChange(portraits.filter((p) => p.id !== id));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "delete failed");
    }
  }

  /** Toggle a portrait's NSFW flag in-place. */
  async function toggleNsfw(id: string, next: boolean) {
    try {
      const res = await fetch(`/characters/${characterId}/portraits/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nsfw: next }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onChange(portraits.map((p) => (p.id === id ? { ...p, nsfw: next } : p)));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "toggle failed");
    }
  }

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Gallery</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        Extra portraits shown beneath the bio on this character's profile. The Main Profile Image above is the one rendered first (userlist, modal hero, full-size footer). Mark a tile NSFW to blur it for viewers (they can click to reveal).
      </p>
      {portraits.length > 0 ? (
        <div className="mb-2 grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2">
          {portraits.map((p) => (
            <div key={p.id} className="relative">
              <img
                src={p.url}
                alt={p.label ?? "portrait"}
                className={`aspect-square w-full rounded border border-keep-border object-cover ${p.nsfw ? "blur-md scale-105" : ""}`}
              />
              <button
                type="button"
                onClick={() => toggleNsfw(p.id, !p.nsfw)}
                title={p.nsfw ? "Marked NSFW (blurred for viewers) - click to unmark." : "Mark NSFW so viewers see this tile blurred until they reveal."}
                aria-label="Toggle NSFW"
                aria-pressed={p.nsfw}
                className={`absolute bottom-0 left-0 rounded-bl rounded-tr border border-keep-rule px-1 text-[10px] ${
                  p.nsfw ? "bg-keep-accent text-white" : "bg-keep-bg/80 text-keep-muted hover:bg-keep-banner"
                }`}
              >
                NSFW
              </button>
              <button
                type="button"
                onClick={() => remove(p.id)}
                title="Remove portrait"
                aria-label="Remove portrait"
                className="absolute right-0 top-0 rounded-bl rounded-tr border border-keep-rule bg-keep-bg/80 px-1 text-[10px] text-keep-accent hover:bg-keep-accent/10"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-2 italic text-keep-muted">No extra portraits yet.</p>
      )}
      {adding ? (
        <div className="space-y-1">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/portrait.png"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional - e.g. 'transformed')"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          <label className="flex items-center gap-1 text-[11px] text-keep-muted">
            <input
              type="checkbox"
              checked={nsfw}
              onChange={(e) => setNsfw(e.target.checked)}
              className="h-3 w-3"
            />
            <span>Mark NSFW (viewers see this blurred until they reveal it)</span>
          </label>
          {err ? <div className="text-[10px] text-keep-accent">{err}</div> : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setAdding(false); setUrl(""); setLabel(""); setNsfw(false); setErr(null); }}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void add(); }}
              disabled={busy || !url.trim()}
              className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
            >
              {busy ? "Adding..." : "Add"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
        >
          + Add portrait
        </button>
      )}
    </fieldset>
  );
}

/* ============================================================
 *  LinksEditor — owner-set external links rendered as styled
 *  chips on the profile. Up to 6 per profile (server-enforced).
 * ============================================================ */

type LinksScope = { kind: "master" } | { kind: "character"; id: string };

const LINKS_CAP = 6;
const LINK_DEFAULT_BORDER = "#a89572";
const LINK_DEFAULT_BG = "#e2d6b8";
const LINK_DEFAULT_TEXT = "#2c5d2c";

function linksEndpoint(scope: LinksScope): string {
  return scope.kind === "master" ? "/me/links" : `/characters/${scope.id}/links`;
}

function LinksEditor({
  scope,
  links,
  onChange,
}: {
  scope: LinksScope;
  links: ProfileLink[];
  onChange: (next: ProfileLink[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [customColors, setCustomColors] = useState(false);
  const [borderColor, setBorderColor] = useState(LINK_DEFAULT_BORDER);
  const [bgColor, setBgColor] = useState(LINK_DEFAULT_BG);
  const [textColor, setTextColor] = useState(LINK_DEFAULT_TEXT);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function resetForm() {
    setTitle("");
    setUrl("");
    setCustomColors(false);
    setBorderColor(LINK_DEFAULT_BORDER);
    setBgColor(LINK_DEFAULT_BG);
    setTextColor(LINK_DEFAULT_TEXT);
    setErr(null);
  }

  // Triggered by the inline "Add" button. NOT a form submit handler —
  // the surrounding ProfileEditor is itself a <form onSubmit={save}>, and
  // an inner <form> nested inside it is invalid HTML. Browsers route
  // submit events from an inner form's button up to whichever ancestor
  // form the DOM commits to, which used to fire the outer profile save
  // instead of this handler — links never POSTed, the outer save ran,
  // and the user saw the profile-save side effects instead of a saved link.
  async function add() {
    if (!title.trim() || !url.trim()) return;
    setErr(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { title: title.trim(), url: url.trim() };
      if (customColors) {
        body.borderColor = borderColor;
        body.bgColor = bgColor;
        body.textColor = textColor;
      }
      const res = await fetch(linksEndpoint(scope), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      const row = (await res.json()) as ProfileLink;
      onChange([...links, row]);
      resetForm();
      setAdding(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Remove this link?")) return;
    try {
      const res = await fetch(`${linksEndpoint(scope)}/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      onChange(links.filter((l) => l.id !== id));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "delete failed");
    }
  }

  const atCap = links.length >= LINKS_CAP;

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Profile links</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        Up to {LINKS_CAP} external links rendered as styled chips on this profile. Useful for cross-site character profiles, world docs, refs. They open in a new tab.
      </p>
      {links.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {links.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 rounded border border-keep-rule/60 bg-keep-bg px-2 py-1">
              <span
                className="inline-block truncate rounded border px-1.5 py-0.5 text-[11px]"
                style={{
                  borderColor: l.borderColor ?? "rgb(var(--keep-border))",
                  backgroundColor: l.bgColor ?? "rgb(var(--keep-panel))",
                  color: l.textColor ?? "rgb(var(--keep-action))",
                }}
                title={l.url}
              >
                {l.title}
              </span>
              <span className="truncate text-[10px] text-keep-muted">{l.url}</span>
              <button
                type="button"
                onClick={() => remove(l.id)}
                title="Remove link"
                aria-label="Remove link"
                className="shrink-0 rounded border border-keep-accent/50 bg-keep-bg px-1.5 py-0 text-[10px] text-keep-accent hover:bg-keep-accent/10"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-2 italic text-keep-muted">No links yet.</p>
      )}
      {adding ? (
        <div className="space-y-1">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. 'F-List profile')"
            maxLength={60}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/your-profile"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          <label className="flex items-center gap-1 text-[11px] text-keep-muted">
            <input
              type="checkbox"
              checked={customColors}
              onChange={(e) => setCustomColors(e.target.checked)}
              className="h-3 w-3"
            />
            <span>Customize chip colors</span>
          </label>
          {customColors ? (
            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col text-[10px] text-keep-muted">
                <span className="uppercase tracking-widest">Border</span>
                <input type="color" value={borderColor} onChange={(e) => setBorderColor(e.target.value)} className="h-6 w-full rounded border border-keep-rule" />
              </label>
              <label className="flex flex-col text-[10px] text-keep-muted">
                <span className="uppercase tracking-widest">Background</span>
                <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="h-6 w-full rounded border border-keep-rule" />
              </label>
              <label className="flex flex-col text-[10px] text-keep-muted">
                <span className="uppercase tracking-widest">Text</span>
                <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} className="h-6 w-full rounded border border-keep-rule" />
              </label>
            </div>
          ) : null}
          {customColors ? (
            <div className="mt-1 text-[10px] text-keep-muted">
              Preview:{" "}
              <span
                className="inline-block rounded border px-1.5 py-0.5 text-[11px]"
                style={{ borderColor, backgroundColor: bgColor, color: textColor }}
              >
                {title.trim() || "Sample link"}
              </span>
            </div>
          ) : null}
          {err ? <div className="text-[10px] text-keep-accent">{err}</div> : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setAdding(false); resetForm(); }}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void add(); }}
              disabled={busy || !title.trim() || !url.trim()}
              className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
            >
              {busy ? "Adding..." : "Add"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={atCap}
          title={atCap ? `Limit of ${LINKS_CAP} links per profile.` : undefined}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
        >
          + Add link
        </button>
      )}
    </fieldset>
  );
}

function Field({
  label,
  value,
  onChange,
  readOnly,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
      <input
        type="text"
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
        className={`w-full rounded border border-keep-rule px-2 py-1 outline-none ${
          readOnly ? "bg-keep-banner/30 text-keep-muted" : "bg-keep-bg focus:border-keep-action"
        }`}
      />
      {hint ? <span className="mt-1 block text-[10px] text-keep-muted">{hint}</span> : null}
    </label>
  );
}

/**
 * Editable chat-color picker. Writes onto the profile form state; the
 * containing save() handler bundles it into the PUT body for master or
 * character. Two scopes:
 *   - `master`  — null = system default. This is the OOC color and the
 *                 fallback every character without its own override
 *                 inherits.
 *   - `character` — null = inherit the master color. Setting a hex
 *                 makes this character's messages render in that color
 *                 regardless of the tab's `/color` state, which is the
 *                 whole reason the per-character column exists (so
 *                 Character A and Character B stay visually distinct
 *                 even after a `/char switch`).
 *
 * The "Use OOC color" / "Use system default" button writes null rather
 * than a hex so the inheritance chain stays intact — clearing to a
 * literal "#000000" would freeze the inheritance even when the upstream
 * color changes later.
 */
function ChatColorRow({
  scope,
  value,
  onChange,
}: {
  scope: "master" | "character";
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  // Local mirror so an in-progress typed hex doesn't bubble up on every
  // keystroke and trigger downstream side effects (formDirty etc.).
  // Pushed up on blur or via the explicit "Set" button — the swatch
  // picker still commits on each pick, since that's a discrete choice.
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => { setDraft(value ?? ""); }, [value]);
  const isHex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(draft);

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Chat color</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {scope === "master"
          ? "Drives your OOC messages and acts as the fallback for any character without its own color."
          : "Locks this character's messages to this color, regardless of the tab's /color state. Leave on \"inherit\" to use your OOC color."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          value={value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#990000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded border border-keep-rule"
          aria-label="Chat color"
        />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft === "") onChange(null);
            else if (isHex) onChange(draft);
          }}
          placeholder={scope === "master" ? "(default)" : "(inherit OOC)"}
          maxLength={7}
          pattern="^#[0-9a-fA-F]{6}$"
          className="flex-1 min-w-[8rem] rounded border border-keep-rule px-2 py-1 font-mono"
        />
        <button
          type="button"
          onClick={() => onChange(null)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted hover:text-keep-text"
          title={scope === "master" ? "Revert to the system default color" : "Inherit the master / OOC color"}
        >
          {scope === "master" ? "Use default" : "Inherit OOC"}
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span className="text-keep-muted">Preview:</span>
        <span
          className="rounded bg-keep-banner/30 px-1.5 py-0.5"
          style={value ? { color: value } : undefined}
        >
          The quick brown fox jumps.
        </span>
      </div>
    </fieldset>
  );
}

/**
 * Desktop notification config - preference dropdown + permission status row.
 * Browsers require permission to be requested from a user gesture, so we
 * expose an explicit "Enable" button rather than asking on mount.
 */
function NotificationsRow({
  pref,
  onChangePref,
  permVersion,
  onPermissionChange,
}: {
  pref: NotifyPref;
  onChangePref: (p: NotifyPref) => void;
  permVersion: number;
  onPermissionChange: () => void;
}) {
  // permVersion is unused inside but its presence forces a re-read of permission()
  // when the parent bumps it after a permission grant/deny.
  void permVersion;
  const perm = notifyPermission();
  const supported = notifyIsSupported();

  async function enable() {
    await notifyRequestPermission();
    onPermissionChange();
  }

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Desktop notifications</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        Toasts appear when this tab is hidden - minimized, on another tab, or in another app.
      </p>
      <label className="flex items-center gap-2">
        <span className="w-20 uppercase tracking-widest text-keep-muted">Notify me</span>
        <select
          value={pref}
          onChange={(e) => onChangePref(e.target.value as NotifyPref)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
        >
          <option value="off">Off - never</option>
          <option value="mentions">Whispers &amp; announcements only</option>
          <option value="all">All messages in rooms I'm in</option>
        </select>
      </label>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-keep-muted">
          Browser permission:{" "}
          <span className="font-mono">{supported ? perm : "unsupported"}</span>
        </span>
        {supported && perm === "default" ? (
          <button
            type="button"
            onClick={enable}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80"
          >
            Enable
          </button>
        ) : supported && perm === "denied" ? (
          <span className="text-[10px] text-keep-accent">
            Denied - re-enable in your browser's site permissions.
          </span>
        ) : null}
      </div>
      <PushRow />
    </fieldset>
  );
}

/**
 * In-app sound effect toggles. Three discrete events, three checkboxes.
 * Stored as boolean columns on `users` (sound_*_enabled) and persisted
 * via the same /me/profile PUT that handles the rest of the master
 * settings — saved when the user clicks Save in the editor footer, not
 * on toggle.
 *
 * All four default on; users opt out of the noises they find
 * intrusive. The toggles take effect immediately on save thanks to the
 * Zustand store push in the parent's onSubmit — no need to reload the
 * page or the Audio elements.
 */
function SoundRow({
  dm,
  whisper,
  chat,
  alert,
  onChangeDm,
  onChangeWhisper,
  onChangeChat,
  onChangeAlert,
}: {
  dm: boolean;
  whisper: boolean;
  chat: boolean;
  alert: boolean;
  onChangeDm: (v: boolean) => void;
  onChangeWhisper: (v: boolean) => void;
  onChangeChat: (v: boolean) => void;
  onChangeAlert: (v: boolean) => void;
}) {
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Sound effects</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        Per-event audio cues. Saved with the rest of your profile.
      </p>
      <label className="mb-1 flex items-start gap-2">
        <input
          type="checkbox"
          checked={dm}
          onChange={(e) => onChangeDm(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">Direct messages (ping)</span>
          <span className="block text-[10px] text-keep-muted">
            Plays when someone DMs you, anywhere in the app.
          </span>
        </span>
      </label>
      <label className="mb-1 flex items-start gap-2">
        <input
          type="checkbox"
          checked={whisper}
          onChange={(e) => onChangeWhisper(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">Whispers (whisper)</span>
          <span className="block text-[10px] text-keep-muted">
            Plays when someone whispers to you in chat. Distinct from DMs so an in-room whisper sounds different from a cross-room ping.
          </span>
        </span>
      </label>
      <label className="mb-1 flex items-start gap-2">
        <input
          type="checkbox"
          checked={chat}
          onChange={(e) => onChangeChat(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">Chat messages (tap)</span>
          <span className="block text-[10px] text-keep-muted">
            Plays on incoming room messages and /me actions.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={alert}
          onChange={(e) => onChangeAlert(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">Announcements (alert)</span>
          <span className="block text-[10px] text-keep-muted">
            Plays on admin announcements and other system events.
          </span>
        </span>
      </label>
    </fieldset>
  );
}

/**
 * Input behavior opt-outs. Two toggles for composer features that some
 * users find intrusive rather than helpful:
 *   - Command/post history (ArrowUp recall) — easy to brush ArrowUp by
 *     accident while moving the cursor; with history off, the arrow
 *     keys do nothing but move the caret.
 *   - Thesaurus on highlight — the synonym popup opens whenever a word
 *     is selected, which surprises users who highlight just to copy.
 *
 * Both default off (= feature enabled) for new accounts; flipping the
 * checkbox + Save persists the preference to /me/profile and pushes
 * it into the chat store so it takes effect immediately.
 */
function InputBehaviorRow({
  disableHistory,
  disableThesaurus,
  onChangeDisableHistory,
  onChangeDisableThesaurus,
}: {
  disableHistory: boolean;
  disableThesaurus: boolean;
  onChangeDisableHistory: (v: boolean) => void;
  onChangeDisableThesaurus: (v: boolean) => void;
}) {
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Input behavior</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        Quiet down composer features you don't want to see while typing.
      </p>
      <label className="mb-1 flex items-start gap-2">
        <input
          type="checkbox"
          checked={disableHistory}
          onChange={(e) => onChangeDisableHistory(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">Disable command and message history</span>
          <span className="block text-[10px] text-keep-muted">
            Turns off the ArrowUp / ArrowDown recall of recently sent messages and commands in the chat composer.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={disableThesaurus}
          onChange={(e) => onChangeDisableThesaurus(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">Disable synonym popup on highlighted words</span>
          <span className="block text-[10px] text-keep-muted">
            Stops the thesaurus list from appearing when you select a word inside the composer.
          </span>
        </span>
      </label>
    </fieldset>
  );
}

/**
 * Earning — hide-Currency toggle.
 *
 * Master-scope only (character pools cascade off the master flag).
 * Saves immediately on change rather than riding the profile form's
 * Save button, so the toggle doesn't get stranded by an unrelated
 * validation error elsewhere in the form. Pulls initial state from
 * the Earning store (which the App-level useEffect refreshes on
 * sign-in); falls back to a direct /earning/me fetch when the
 * store hasn't loaded yet.
 */
function CurrencyPrivacyRow() {
  const snapshot = useEarning((s) => s.snapshot);
  const refresh = useEarning((s) => s.refresh);
  const [hideCurrency, setHideCurrency] = useState<boolean | null>(snapshot?.master.hideCurrencyCount ?? null);
  const [hideXp, setHideXp] = useState<boolean | null>(snapshot?.master.hideXpCount ?? null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // When the store snapshot lands after this row mounted, fold the
  // server value in. Only overwrite null (initial) state so we don't
  // clobber an in-flight optimistic toggle.
  useEffect(() => {
    if (!snapshot) return;
    if (hideCurrency === null) setHideCurrency(!!snapshot.master.hideCurrencyCount);
    if (hideXp === null) setHideXp(!!snapshot.master.hideXpCount);
  }, [snapshot, hideCurrency, hideXp]);

  // Direct fetch fallback when the editor opened before /earning/me ever ran.
  useEffect(() => {
    if (snapshot || (hideCurrency !== null && hideXp !== null)) return;
    let cancelled = false;
    fetchEarningMe()
      .then((r) => {
        if (cancelled) return;
        if (hideCurrency === null) setHideCurrency(!!r.master.hideCurrencyCount);
        if (hideXp === null) setHideXp(!!r.master.hideXpCount);
      })
      .catch(() => { /* user can still toggle — server is source of truth on save */ });
    return () => { cancelled = true; };
  }, [snapshot, hideCurrency, hideXp]);

  async function save(kind: "currency" | "xp", next: boolean) {
    if (kind === "currency") setHideCurrency(next); else setHideXp(next);
    setSaving(true);
    setErr(null);
    try {
      await patchEarningSettings(
        kind === "currency" ? { hideCurrencyCount: next } : { hideXpCount: next },
      );
      setSavedFlash(true);
      void refresh();
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
      if (kind === "currency") setHideCurrency(!next); else setHideXp(!next);
    } finally {
      setSaving(false);
    }
  }

  // Current totals readout — so the user sees their own Earning state
  // here, not just the privacy toggles. Mirrors what the chat strip
  // shows; pulled from the same snapshot so it stays in sync with
  // live `earning:earned` updates.
  const master = snapshot?.master ?? null;
  const { rank, tierRow } = lookupRankTier(snapshot, master?.rankKey ?? null, master?.tier ?? null);
  const rankLabel = rank ? `${rank.name}${tierRow ? ` ${tierRow.label}` : ""}` : "Unranked";
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Earning</legend>
      <div className="mb-2 flex flex-wrap items-center gap-3 rounded border border-keep-rule bg-keep-bg/50 px-2 py-1.5">
        <span className="font-action uppercase tracking-widest text-keep-text">{rankLabel}</span>
        <span aria-hidden className="h-4 w-px shrink-0 bg-keep-rule/60" />
        <span className="inline-flex items-center gap-1">
          <img
            src="/assets/earning/cache_pouch.png"
            alt=""
            aria-hidden
            className="select-none"
            style={{ width: "1.75rem", height: "1.75rem" }}
            draggable={false}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <span className="font-semibold tabular-nums text-keep-text">{(master?.currency ?? 0).toLocaleString()}</span>
        </span>
        <span aria-hidden className="h-4 w-px shrink-0 bg-keep-rule/60" />
        <span className="inline-flex items-baseline gap-1">
          <span className="font-semibold tabular-nums text-keep-text">{(master?.xp ?? 0).toLocaleString()}</span>
          <span className="uppercase tracking-widest text-keep-muted">XP</span>
        </span>
      </div>
      <p className="mb-2 text-[10px] text-keep-muted">
        Rank, tier, and sigil are always visible on your profile. XP and Currency totals can be
        hidden independently.
      </p>
      <label className="mb-2 flex items-start gap-2">
        <input
          type="checkbox"
          checked={hideCurrency ?? false}
          disabled={saving || hideCurrency === null}
          onChange={(e) => void save("currency", e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">Hide my Currency total from other users</span>
          <span className="block text-[10px] text-keep-muted">
            Other users see "private" instead of your balance in /currency lookups and on your public profile.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={hideXp ?? false}
          disabled={saving || hideXp === null}
          onChange={(e) => void save("xp", e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">Hide my XP total from other users</span>
          <span className="block text-[10px] text-keep-muted">
            Other users see "private" instead of your XP on your profile and in /exp lookups.
          </span>
        </span>
      </label>
      {err ? (
        <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-[10px] text-keep-accent">{err}</div>
      ) : null}
      {savedFlash ? (
        <div className="mt-1 text-[10px] text-keep-system">Saved.</div>
      ) : null}
    </fieldset>
  );
}

/**
 * Profile visibility + NSFW gate.
 *
 * Two checkboxes:
 *   - Public: when off, the profile is hidden from anonymous viewers
 *     (logged-out visitors get 404 from /profiles/:name).
 *   - NSFW: pre-gates the whole profile. Logged-in viewers see a warning
 *     splash with a "View Profile" button before the content renders.
 *     The owner + admins always skip the gate.
 *
 * NSFW=true forces Public=false (server enforces; the UI mirrors by
 * disabling and unchecking the Public box). Independent of the per-portrait
 * NSFW flag we already shipped, which only blurs individual gallery images.
 */
function VisibilityRow({
  isPublic,
  isNsfw,
  onChangePublic,
  onChangeNsfw,
  kind,
}: {
  isPublic: boolean;
  isNsfw: boolean;
  onChangePublic: (v: boolean) => void;
  onChangeNsfw: (v: boolean) => void;
  kind: "master" | "character";
}) {
  const subject = kind === "master" ? "your master profile" : "this character's profile";
  // When NSFW is on, the Public box is disabled and visually shows as
  // unchecked - matches the server's normalization on save.
  const effectivePublic = isNsfw ? false : isPublic;
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Visibility</legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={effectivePublic}
          disabled={isNsfw}
          onChange={(e) => onChangePublic(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold">Public</span>
          <span className="block text-[10px] text-keep-muted">
            Anyone (including logged-out visitors) can view {subject} via{" "}
            <code>/profiles/{kind === "master" ? "<username>" : "<character>"}</code>. Uncheck to
            require login.
          </span>
        </span>
      </label>
      <label className="mt-2 flex items-start gap-2">
        <input
          type="checkbox"
          checked={isNsfw}
          onChange={(e) => onChangeNsfw(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold">NSFW (whole profile)</span>
          <span className="block text-[10px] text-keep-muted">
            Forces non-public to anonymous viewers, and shows a warning splash with a "View
            Profile" button to logged-in viewers before the content renders. Use when the
            profile itself is explicit (independent of marking individual gallery images NSFW).
          </span>
        </span>
      </label>
    </fieldset>
  );
}

/**
 * Web Push (offline notifications) opt-in. Sits inside NotificationsRow so
 * the user sees both surfaces in one place: foreground toasts (browser
 * Notification API) and background pushes (service worker).
 *
 * Privacy reminder rendered alongside the toggle: payloads carry no message
 * body, only "you have a whisper / mention waiting".
 */
function PushRow() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readPushState().then((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; };
  }, []);

  async function turnOn() {
    setError(null);
    setBusy(true);
    try {
      const next = await enablePush();
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "enable failed");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setError(null);
    setBusy(true);
    try {
      const next = await disablePush();
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "disable failed");
    } finally {
      setBusy(false);
    }
  }

  if (state === "unsupported") {
    return (
      <div className="mt-2 text-[10px] italic text-keep-muted">
        Browser push isn't available in this browser.
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-keep-rule/50 pt-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-keep-text">Browser push (offline)</div>
          <div className="text-[10px] text-keep-muted">
            Pings even when this tab is closed. Privacy: payloads carry no message body — just "whisper waiting" / "mention waiting".
          </div>
        </div>
        {state === "loading" ? (
          <span className="text-[10px] text-keep-muted">…</span>
        ) : state === "denied" ? (
          <span className="text-[10px] text-keep-accent">Permission denied</span>
        ) : state === "subscribed" ? (
          <button
            type="button"
            onClick={turnOff}
            disabled={busy}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner disabled:opacity-50"
          >
            {busy ? "..." : "Disable"}
          </button>
        ) : (
          <button
            type="button"
            onClick={turnOn}
            disabled={busy}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-xs hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {busy ? "..." : "Enable"}
          </button>
        )}
      </div>
      {error ? <div className="mt-1 text-[10px] text-keep-accent">{error}</div> : null}
    </div>
  );
}

/* ============================================================
 *  JournalEditor — owner-only solo writing attached to a
 *  character. Public entries surface on the profile in
 *  chronological order; private entries only show here.
 * ============================================================ */
function JournalEditor({ characterId }: { characterId: string }) {
  const [entries, setEntries] = useState<CharacterJournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/characters/${characterId}/journal`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { entries: CharacterJournalEntry[] };
      setEntries(j.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [characterId]);

  async function remove(id: string) {
    if (!window.confirm("Delete this journal entry?")) return;
    try {
      const r = await fetch(`/characters/${characterId}/journal/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  async function save(body: { title: string | null; bodyHtml: string; privacy: "public" | "private" }, id?: string) {
    try {
      const url = id
        ? `/characters/${characterId}/journal/${id}`
        : `/characters/${characterId}/journal`;
      const method = id ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
      setCreating(false);
      setEditingId(null);
    } catch (e) {
      throw e;
    }
  }

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">Journal</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        Solo writing attached to this character. Backstory, in-world diary, world notes. Public entries surface on
        the profile chronologically. Private entries are only visible to you.
      </p>
      {error ? <div className="mb-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{error}</div> : null}
      {creating ? (
        <JournalEntryForm
          mode="create"
          onCancel={() => setCreating(false)}
          onSave={(body) => save(body)}
        />
      ) : null}
      {entries === null ? (
        <p className="italic text-keep-muted">Loading entries...</p>
      ) : entries.length === 0 ? (
        <p className="italic text-keep-muted">No entries yet.</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((e) => (
            <li key={e.id} className="rounded border border-keep-rule/60 bg-keep-bg p-2">
              {editingId === e.id ? (
                <JournalEntryForm
                  mode="edit"
                  initial={e}
                  onCancel={() => setEditingId(null)}
                  onSave={(body) => save(body, e.id)}
                />
              ) : (
                <>
                  <header className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold">
                      {e.title || <span className="italic text-keep-muted">untitled</span>}
                      <span
                        className={`ml-2 rounded px-1 text-[10px] uppercase tracking-widest ${
                          e.privacy === "public"
                            ? "bg-keep-action/15 text-keep-action"
                            : "bg-keep-rule/30 text-keep-muted"
                        }`}
                      >
                        {e.privacy}
                      </span>
                    </span>
                    <span className="text-[10px] text-keep-muted">
                      {new Date(e.createdAt).toLocaleDateString()}
                    </span>
                  </header>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-keep-muted">Preview</summary>
                    <div className="mt-1 max-h-40 overflow-y-auto rounded border border-keep-rule/40 bg-keep-panel/30 p-2 font-mono text-[11px]">
                      {e.bodyHtml}
                    </div>
                  </details>
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingId(e.id)}
                      className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(e.id)}
                      className="rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {!creating && editingId === null ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mt-2 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
        >
          + Add entry
        </button>
      ) : null}
    </fieldset>
  );
}

function JournalEntryForm({
  mode,
  initial,
  onCancel,
  onSave,
}: {
  mode: "create" | "edit";
  initial?: CharacterJournalEntry;
  onCancel: () => void;
  onSave: (body: { title: string | null; bodyHtml: string; privacy: "public" | "private" }) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [bodyHtml, setBodyHtml] = useState(initial?.bodyHtml ?? "");
  const [privacy, setPrivacy] = useState<"public" | "private">(initial?.privacy ?? "public");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Plain handler (not onSubmit) — see LinksEditor.add for why nesting a
  // <form> inside the outer ProfileEditor <form> silently routes the
  // submit to the wrong handler.
  async function submit() {
    if (!bodyHtml.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({
        title: title.trim() || null,
        bodyHtml: bodyHtml,
        privacy,
      });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={120}
        placeholder="Title (optional)"
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
      />
      <textarea
        value={bodyHtml}
        onChange={(e) => setBodyHtml(e.target.value)}
        rows={8}
        placeholder={"<p>Write your entry here. The same HTML allow-list as your bio applies (b, i, em, p, ul/ol/li, blockquote, h3-h6, etc.).</p>"}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-keep-action"
      />
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1 text-[11px] text-keep-muted">
          <span>Visibility:</span>
          <select
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as "public" | "private")}
            className="rounded border border-keep-rule bg-keep-bg px-1 py-0.5"
          >
            <option value="public">Public (on profile)</option>
            <option value="private">Private (only you)</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { void submit(); }}
            disabled={busy || !bodyHtml.trim()}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {busy ? "Saving..." : mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </div>
      {err ? <div className="text-[10px] text-keep-accent">{err}</div> : null}
    </div>
  );
}
