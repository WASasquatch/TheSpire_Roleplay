import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { AvatarCrop, CharacterAttribute, CharacterJournalEntry, CharacterPortrait, CharacterStats, CharacterStatsVisibility, CharacterVibeAxisKey, ProfileCollectionEntry, ProfileLink, ProfileView, Role, Theme } from "@thekeep/shared";
import { AVATAR_CROP_DEFAULTS, AVATAR_CROP_MAX_ZOOM, AVATAR_CROP_MIN_ZOOM, CHARACTER_ATTRIBUTES_MAX, CHARACTER_ATTRIBUTE_LABEL_MAX, CHARACTER_ATTRIBUTE_VALUE_MAX, CHARACTER_ATTRIBUTE_VALUE_MIN, CHARACTER_VIBE_AXES, LANGUAGE_TAGS, LANGUAGE_TAG_MAX, STAT_FIELD_MAX, clampAvatarCrop, isDarkPalette, isDefaultAvatarCrop, languageTagByKey, normalizeTheme } from "@thekeep/shared";
import { Code2, HelpCircle, Paintbrush2, X } from "lucide-react";
import { LangFlag } from "../flags/LangFlag.js";
import { applyStyle , DEFAULT_STYLE_KEY } from "../../lib/ornaments/index.js";
import { DesignerTour } from "../tours/DesignerTour.js";
import { ProfileFlairEditor, VisitorsVisibilityToggleRow } from "../cosmetics/ProfileFlairEditor.js";
import { applyTheme } from "../../lib/theme.js";
import { GENDER_OPTIONS, type Gender } from "../../lib/gender.js";
import {
  isSupported as notifyIsSupported,
  permission as notifyPermission,
  requestPermission as notifyRequestPermission,
  type NotifyPref,
} from "../../lib/notifications.js";
import { getSocket } from "../../lib/socket.js";
import {
  disablePush,
  enablePush,
  readPushState,
  type PushState,
} from "../../lib/push.js";
import { readError } from "../../lib/http.js";
import { formatDate, formatNumber } from "../../lib/intlFormat.js";
import { LOCALE_CHOICES, changeLocale } from "../../lib/i18n.js";
import { fetchEarningMe, patchEarningSettings, patchProfileBannerUrl } from "../../lib/earning.js";
import { fetchBlocks, removeBlock, type BlockedUser } from "../../lib/blocks.js";
import { useChat } from "../../state/store.js";
import { useEarning, lookupRankTier } from "../../state/earning.js";
import { StylePicker } from "../admin/AdminPanel.js";
import { Modal, MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { ThemePicker } from "../cosmetics/ThemePicker.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { CloseButton } from "../shared/CloseButton.js";
import { ScriptoriumPrivacyRow } from "../ScriptoriumPrivacyRow.js";
import { BirthDateRow } from "./BirthDateRow.js";
import { DisplayPrivacyRow } from "./DisplayPrivacyRow.js";
import { ProfileModal } from "./ProfileModal.js";
import { CreateCharacterModal } from "./CreateCharacterModal.js";

// GrapesJS is heavy (~hundreds of KB); lazy-load it so it only enters the
// bundle when a writer opens the visual Designer for their bio.
const ProfileDesigner = lazy(() => import("./ProfileDesigner.js"));

/**
 * GrapesJS needs real screen room and a precise pointer; below this width we
 * keep the bio editor as the raw-HTML Source textarea only (the Designer is
 * mouse/drag-oriented and unusable on phones). Site availability is gated
 * separately by the admin `branding.profileDesignerEnabled` flag.
 */
function isDesignerViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(min-width: 900px)").matches;
}

/** Marks that the user has seen the Designer coach tour. A one-time hint, so
 *  losing it (cleared storage, new browser) just re-shows the tour — harmless,
 *  unlike the Designer *availability* flag which lives on the server. */
const DESIGNER_TOUR_SEEN_KEY = "spire:designerTourSeen:v1";

interface Props {
  /** Initial selection. The user can switch via the dropdown. */
  mode: "master" | "character";
  characterId: string | null;
  /**
   * Optional initial tab. Threads through from `editor.initialTab` in
   * the chat store so a deep-link can land on a non-default tab,
   * e.g. the shop's "Configure in Edit Profile → Flair" CTA. Defaults
   * to "description" when omitted.
   */
  initialTab?: "description" | "profile" | "appearance" | "privacy" | "links" | "gallery" | "flair" | "journal";
  onClose: () => void;
  /**
   * Fires after every successful save so the parent can re-fetch the active
   * theme and re-apply it to the chat. The user doesn't have to close the
   * editor to see their theme change take effect.
   */
  /**
   * Fired after a successful save. The argument tells the parent
   * which identity was just saved so it can decide whether to
   * trigger a chat-wide theme refresh (only useful when the saved
   * target is what THIS tab is currently voicing; saving a sibling
   * identity should leave the chat's active palette alone). Omit
   * the parent's logic when not needed, argument is optional.
   */
  onSaved?: (savedTarget?: { kind: "master" | "character"; id?: string }) => void;
  /**
   * Admin-acting-on-another-user mode. When set, the editor:
   *   - Forces `mode: "character"` and edits the supplied `characterId`
   *     (master-account fields belong to the target user, out of scope
   *     for this UI; that's what the admin Users tab edits).
   *   - Skips the `/me/profile` + `/characters` initial fetches,
   *     those return the CALLER's data, not the target user's. The
   *     character itself loads through `/characters/:id`, which the
   *     server allows for admins regardless of ownership.
   *   - Hides the master/character dropdown + the +New / Switch / Delete
   *     buttons, admin edits ONE character at a time; to touch a
   *     different one, close and reopen from the admin Users row.
   *   - Shows an "Editing as admin: …" banner so the admin knows
   *     they're touching someone else's character.
   */
  adminContext?: { ownerUserId: string; ownerUsername: string };
}

type UiFontScale = "small" | "medium" | "large" | "xl";

interface MasterData {
  username: string;
  bioHtml: string;
  avatarUrl: string | null;
  /** Server-shipped avatar crop (migration 0178). Optional in the
   *  type for forward-compat with older /me/profile responses. */
  avatarCrop?: AvatarCrop;
  includeAvatarInGallery?: boolean;
  gender: Gender;
  /** Profile language tags (catalog keys, owner's order). Optional for
   *  forward-compat with older /me/profile responses. */
  languages?: string[];
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
  /** Viewer-side flair opt-outs (account-level). See FlairDisplayRow. */
  disableNameStyles?: boolean;
  disableBorderStyles?: boolean;
  disableInlineAvatars?: boolean;
  /** Userlist display: when true, rank sigil replaces gender glyph in rail. */
  useRankAsUserlistIcon?: boolean;
  role?: Role;
  isPublic?: boolean;
  isNsfw?: boolean;
  /** Public-profile backdrop image URL. Null/empty = use default. */
  publicProfileBgUrl?: string | null;
  /** "cover" | "contain" | "tile" | "stretch", display strategy for `publicProfileBgUrl`. */
  publicProfileBgMode?: string | null;
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
  /** Server-shipped avatar crop (migration 0178). Optional in the
   *  type for forward-compat with older /characters responses; the
   *  reader passes whatever comes back through `clampAvatarCrop`
   *  which snaps undefined to the identity crop. */
  avatarCrop?: AvatarCrop;
  includeAvatarInGallery?: boolean;
  themeJson: string | null;
  /**
   * Per-character chat color override. Null = inherit the master
   * account's color. When set, every message authored AS this
   * character uses this color regardless of the tab's current `/color`
   * state, so Character A and Character B stay visually distinct
   * even when both belong to the same master account.
   */
  chatColor?: string | null;
  /**
   * Per-character theme style override (medieval/modern/scifi). Null =
   * inherit through master → theme-pinned → site default. Lets each
   * character carry its own design when active, pairs with the
   * existing `themeJson` palette override.
   */
  styleKey?: string | null;
  isPublic?: boolean;
  isNsfw?: boolean;
  /** Public-profile backdrop image URL. Null/empty = use default. */
  publicProfileBgUrl?: string | null;
  /** "cover" | "contain" | "tile" | "stretch", display strategy for `publicProfileBgUrl`. */
  publicProfileBgMode?: string | null;
  /**
   * Per-character Direct Messenger reachability. When false, this
   * character is filtered out of friend-request lookups and DM recipient
   * pickers, existing friends + conversations are preserved but cannot
   * start a new DM thread with this identity. Reachability is OPT-OUT:
   * new characters default to true (migration 0253); owners turn it off
   * here only to make a character uncontactable.
   */
  directMessengerEnabled?: boolean;
}

type Target = { kind: "master" } | { kind: "character"; id: string };

type ClassicStatField = "age" | "race" | "gender" | "height" | "weight" | "alignment" | "occupation";
/** Classic stat fields in display order. Labels resolve through
 *  `statFields.<key>` at render time so a language switch relabels live. */
const STAT_FIELDS: ClassicStatField[] = [
  "age",
  "race",
  "gender",
  "height",
  "weight",
  "alignment",
  "occupation",
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
export function ProfileEditor({ mode: initialMode, characterId: initialCharId, initialTab, onClose, onSaved, adminContext }: Props) {
  const { t } = useTranslation("profile");
  const isAdminEdit = !!adminContext;
  const [target, setTarget] = useState<Target>(
    // Admin mode locks the target to the supplied character, no
    // master option (admin Users tab edits master fields), no
    // dropdown to other characters (the admin opened THIS one).
    isAdminEdit && initialCharId
      ? { kind: "character", id: initialCharId }
      : initialMode === "character" && initialCharId
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
  // Bio editing surface: the GrapesJS visual Designer (default — most users
  // don't write HTML) or raw HTML source. Both edit the SAME `bioHtml` string,
  // so switching carries edits across. The Designer offer requires the admin
  // site flag AND a desktop-width viewport (see `isDesignerViewport`); when it
  // isn't available the Source textarea renders regardless of this value.
  const [bioMode, setBioMode] = useState<"source" | "designer">("designer");
  const designerSiteEnabled = useChat((s) => s.branding.profileDesignerEnabled);
  // The SITE default palette (admin-configured `branding.defaultTheme`), which
  // is what a user with NO personal theme actually sees in chat. The live
  // preview + profile-card preview fall back to THIS when `theme` is null —
  // never to the hard-coded light `DEFAULT_THEME`, which would slam Parchment
  // onto <html> for every freshly-registered (no-theme) user the moment they
  // open the editor, and stick because the editor applies it directly.
  const siteDefaultTheme = useChat((s) => s.branding.defaultTheme);
  // Saved UI language (null = "System default"). Lives outside the editor's
  // save body: the Appearance-tab select applies + persists immediately via
  // changeLocale, mirroring the Menu row, so there's nothing to save here.
  const localePref = useChat((s) => s.localePref);
  const [isWideViewport, setIsWideViewport] = useState(isDesignerViewport);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 900px)");
    const onChange = () => setIsWideViewport(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const designerAvailable = designerSiteEnabled && isWideViewport;
  // First-run coach tour for the Designer. Shown once (per browser) the first
  // time the Designer is the active surface; replayable from the "?" button.
  const [showDesignerTour, setShowDesignerTour] = useState(false);
  const tourTriggeredRef = useRef(false);
  useEffect(() => {
    if (!designerAvailable || bioMode !== "designer" || tourTriggeredRef.current) return;
    tourTriggeredRef.current = true;
    try {
      if (localStorage.getItem(DESIGNER_TOUR_SEEN_KEY)) return;
    } catch { return; }
    // Let the Designer mount before spotlighting its panels (the tour also
    // polls for them, so this only needs to be roughly in time).
    const t = setTimeout(() => setShowDesignerTour(true), 500);
    return () => clearTimeout(t);
  }, [designerAvailable, bioMode]);
  const closeDesignerTour = () => {
    setShowDesignerTour(false);
    try { localStorage.setItem(DESIGNER_TOUR_SEEN_KEY, "1"); } catch { /* private mode */ }
  };
  const [avatarUrl, setAvatarUrl] = useState("");
  /**
   * Owner-picked zoom + focal point on the avatar source (migration
   * 0178). Defaults to the identity crop (centered, no zoom) which
   * reproduces the legacy render. Re-seeded on target change. The
   * picker UI below sets these via drag-to-pan + zoom slider; the
   * save flow ships them as `avatarCrop` on the PUT body.
   */
  const [avatarCrop, setAvatarCrop] = useState<AvatarCrop>({ ...AVATAR_CROP_DEFAULTS });
  /**
   * Per-identity "Include in Gallery" toggle next to the avatar URL
   * field. Persisted as `includeAvatarInGallery` on the master /
   * character row (migration 0114). The server prepends a synthetic
   * gallery entry for the avatar URL when this is true so visitors
   * see the avatar as the first tile in the gallery without the
   * user having to copy the URL into a real portrait row.
   */
  const [includeAvatarInGallery, setIncludeAvatarInGallery] = useState(false);
  const [chatColor, setChatColor] = useState<string | null>(null);
  const [gender, setGender] = useState<Gender>("undisclosed");
  /** Profile language tags (account-level catalog keys, display order). */
  const [languages, setLanguages] = useState<string[]>([]);
  const [stats, setStats] = useState<CharacterStats>({});
  /** When the form has a theme set; null means "use default / inherit". */
  const [theme, setTheme] = useState<Theme | null>(null);
  /**
   * Theme style override for the *current target*, master or character.
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
  // Viewer-side flair opt-outs. Default off (= flair shown). Pushed through
  // `useChat.setFlairPrefs` on save so StyledName / BorderedAvatar /
  // UserNameTag re-render plain immediately, no reload needed.
  const [disableNameStyles, setDisableNameStyles] = useState<boolean>(false);
  const [disableBorderStyles, setDisableBorderStyles] = useState<boolean>(false);
  const [disableInlineAvatars, setDisableInlineAvatars] = useState<boolean>(false);
  // Public + NSFW visibility flags. Default isPublic=true, isNsfw=false to
  // match the schema. NSFW=true forces isPublic=false on save (server
  // enforces this too); the UI mirrors that by disabling the Public box.
  const [isPublic, setIsPublic] = useState<boolean>(true);
  const [isNsfw, setIsNsfw] = useState<boolean>(false);
  // Per-character Direct Messenger reachability (character targets only).
  // The master target ignores this state. Default true to match the
  // opt-out schema ("new characters are reachable"); the loader below
  // resets to the persisted value when switching into a character.
  const [directMessengerEnabled, setDirectMessengerEnabled] = useState<boolean>(true);
  // Public-profile backdrop image + display mode. Painted on the
  // profile modal's backdrop (the area outside the modal card) for
  // any viewer of /p/<this identity>. Null URL = no override (modal
  // falls back to its default `bg-black/40` overlay). Mode is one of
  // "cover" | "contain" | "tile" | "stretch", mapped to the CSS
  // `background-size` / `background-repeat` pair at render time.
  const [publicProfileBgUrl, setPublicProfileBgUrl] = useState<string>("");
  const [publicProfileBgMode, setPublicProfileBgMode] = useState<"cover" | "contain" | "tile" | "stretch">("cover");
  // Live earning snapshot, the preview profile reads the user's
  // current collection + pet collection pins from here so the
  // preview matches the real profile 1:1. The dashboard already
  // keeps this fresh via the `earning:inventory_changed` socket
  // event, so no extra fetch needed.
  const earningSnapshot = useEarning((s) => s.snapshot);
  // Banner URL is a Flair cosmetic, not a regular profile field, so it
  // saves through its own PATCH endpoint instead of the main profile
  // form. After a successful banner save we refresh the earning
  // snapshot so the editor's preview + read-only badge update without
  // a manual page reload.
  const refreshEarning = useEarning((s) => s.refresh);
  const [bannerDraft, setBannerDraft] = useState<string>("");
  const [bannerSaving, setBannerSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  // Sync banner draft to the active identity's currently-saved URL.
  // Re-runs when the user switches target (master ↔ character) so the
  // input always shows the URL of the identity currently being edited,
  // and when the earning snapshot itself updates (e.g. after Save,
  // after a Flair-tab purchase, or a cross-tab change picked up by the
  // socket-driven refresh).
  useEffect(() => {
    const characterId = target.kind === "character" ? target.id : null;
    const url = characterId
      ? (earningSnapshot?.activeCosmetics.byCharacter?.[characterId]?.profileBannerUrl ?? "")
      : (earningSnapshot?.activeCosmetics.profileBannerUrl ?? "");
    setBannerDraft(url);
    setBannerError(null);
  }, [target, earningSnapshot]);
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
    | "flair"
    | "journal";
  const [activeTab, setActiveTab] = useState<EditorTab>(initialTab ?? "description");
  // Calm mode: fade the active tab's body in on each tab change. Applied only
  // when Reduce Motion is on (class + remount key on the shared tab-body
  // wrapper below); off-path render is unchanged.
  const reduceMotion = useReducedMotion();

  // Journal is character-only (the schema's character_journal_entries
  // table is character-attached). If the user is on the Journal tab
  // and switches to master, fall back to "profile" so the content
  // pane doesn't go blank. Gallery is available on master too as of
  // migration 0113, so no redirect for that tab anymore.
  useEffect(() => {
    if (target.kind === "master" && activeTab === "journal") {
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

  // Initial load: master + character list (we always need both for the
  // dropdown). Skipped in admin-edit mode, those endpoints return
  // the CALLER's master + characters, which has nothing to do with
  // the target user the admin is editing. The character itself
  // loads via the target useEffect below (admin-allowed `/characters/:id`).
  useEffect(() => {
    if (isAdminEdit) {
      setLoadingList(false);
      return;
    }
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
        if (!cancelled) setError(err instanceof Error ? err.message : t("errors.loadFailed"));
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAdminEdit]);

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
          // Pull the saved crop off the master preload. clampAvatarCrop
          // also handles a row that predates the column migration (the
          // server defaults to the identity crop, so this just normalizes).
          setAvatarCrop(clampAvatarCrop(master.avatarCrop));
          setIncludeAvatarInGallery(!!master.includeAvatarInGallery);
          setChatColor(master.chatColor);
          setGender(master.gender ?? "undisclosed");
          setLanguages(Array.isArray(master.languages) ? master.languages : []);
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
          setDisableNameStyles(master.disableNameStyles ?? false);
          setDisableBorderStyles(master.disableBorderStyles ?? false);
          setDisableInlineAvatars(master.disableInlineAvatars ?? false);
          setIsPublic(master.isPublic ?? true);
          setIsNsfw(master.isNsfw ?? false);
          setPublicProfileBgUrl(typeof master.publicProfileBgUrl === "string" ? master.publicProfileBgUrl : "");
          setPublicProfileBgMode(
            master.publicProfileBgMode === "contain" || master.publicProfileBgMode === "tile" || master.publicProfileBgMode === "stretch"
              ? master.publicProfileBgMode
              : "cover",
          );
          // Master/OOC gallery, same wire shape as the character
          // gallery below, just keyed on the user (user_portraits
          // table, added in migration 0113). Failing the fetch is
          // non-fatal; the editor's Gallery tab just shows empty.
          try {
            const pr = await fetch("/me/portraits", { credentials: "include" });
            if (pr.ok) {
              const pj = (await pr.json()) as { portraits: Array<{ id: string; url: string; label: string | null; nsfw?: boolean }> };
              if (!cancelled) setPortraits(pj.portraits.map((p) => ({ id: p.id, url: p.url, label: p.label, nsfw: !!p.nsfw })));
            } else {
              if (!cancelled) setPortraits([]);
            }
          } catch {
            if (!cancelled) setPortraits([]);
          }
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
          setAvatarCrop(clampAvatarCrop(c.avatarCrop));
          setIncludeAvatarInGallery(!!c.includeAvatarInGallery);
          // Per-character chat color. Null means "fall back to the
          // master account's color", preserved as a distinct state
          // from "" so the picker can tell apart "no override set"
          // (inherit) from a deliberate clear-to-default.
          setChatColor(c.chatColor ?? null);
          // Language tags are ACCOUNT-level; a character target isn't
          // editing them, but the preview pane still paints the owner's
          // saved set (same as the real character profile would).
          setLanguages(Array.isArray(master?.languages) ? master.languages : []);
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
          // Default to true when the field is absent (older shape) so it
          // reads as reachable, matching the opt-out policy.
          setDirectMessengerEnabled(c.directMessengerEnabled ?? true);
          setPublicProfileBgUrl(typeof c.publicProfileBgUrl === "string" ? c.publicProfileBgUrl : "");
          setPublicProfileBgMode(
            c.publicProfileBgMode === "contain" || c.publicProfileBgMode === "tile" || c.publicProfileBgMode === "stretch"
              ? c.publicProfileBgMode
              : "cover",
          );
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
          setError(err instanceof Error ? err.message : t("errors.loadFailed"));
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
            avatarCrop,
            includeAvatarInGallery,
            gender,
            languages,
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
            disableNameStyles,
            disableBorderStyles,
            disableInlineAvatars,
            chatColor,
            isPublic,
            isNsfw,
            // Public-profile backdrop. Empty string normalizes to null
            // (server treats "missing" and "explicit clear" the same).
            // Mode always rides along, it's a NOT NULL column with a
            // default, so sending it on every save keeps the row
            // consistent even when the URL itself is cleared.
            publicProfileBgUrl: publicProfileBgUrl.trim() === "" ? null : publicProfileBgUrl.trim(),
            publicProfileBgMode,
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
            avatarCrop,
            // Gallery-membership flag must round-trip through the
            // cache or the checkbox snaps back to false on the next
            // render, the form's local state stays correct, but
            // when the component re-derives from `master`, an
            // undefined `includeAvatarInGallery` evaluates to `!!u`
            // → false, which is what was happening before the fix.
            includeAvatarInGallery,
            gender,
            languages,
            notifyPref,
            soundDmEnabled,
            soundWhisperEnabled,
            soundChatEnabled,
            soundAlertEnabled,
            disableInputHistory,
            disableThesaurus,
            disableNameStyles,
            disableBorderStyles,
            disableInlineAvatars,
            styleKey: userStyleKey,
            uiFontFamily: uiFontFamily && uiFontFamily.trim() !== "" ? uiFontFamily.trim() : null,
            uiFontScale,
            chatColor,
            // NSFW=true forces isPublic=false on the server. Mirror that
            // implication client-side so the cached MasterData stays
            // consistent with what the next /me/profile load would return.
            isPublic: isNsfw ? false : isPublic,
            isNsfw,
            publicProfileBgUrl: publicProfileBgUrl.trim() === "" ? null : publicProfileBgUrl.trim(),
            publicProfileBgMode,
          };
          if (theme) next.theme = theme;
          else delete next.theme;
          return next;
        });
        // Push the new sound prefs into the global store so lib/sound
        // picks them up before the next ping/tap/alert event fires,
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
        // Push the flair opt-outs into the store so StyledName /
        // BorderedAvatar / UserNameTag repaint plain (or restore flair)
        // immediately on save, without waiting for the next /me/profile poll.
        useChat.getState().setFlairPrefs({
          disableNameStyles,
          disableBorderStyles,
          disableInlineAvatars,
        });
      } else {
        // Attribute-row sanitizer. The editor lets the user type
        // mid-stream (cross-field clamp moved to onBlur so typing
        // stays smooth), so a Save click that fires before the
        // user blurs the input could ship a row with min > max
        // or value outside [min, max], the schema would 400 the
        // whole stats body and the surface error wouldn't point at
        // the bad row. Same goes for rows the owner started but
        // never named: empty labels fail `z.string().min(1)`.
        //
        // We do BOTH fixes here before send so the payload is
        // always server-valid:
        //   1. Drop rows whose trimmed label is empty (clearly
        //      unfinished, not intended content).
        //   2. Re-apply the cross-field clamp on the surviving
        //      rows so anything the user typed but didn't blur
        //      out of still lands as a coherent (min, value, max).
        const cleanStats = stats.attributes
          ? (() => {
              const kept = stats.attributes
                .filter((r) => r.label.trim().length > 0)
                .map((r) => {
                  const next = { ...r };
                  if (next.min > next.max) next.max = next.min;
                  if (next.value < next.min) next.value = next.min;
                  if (next.value > next.max) next.value = next.max;
                  return next;
                });
              const { attributes: _drop, ...rest } = stats;
              void _drop;
              return kept.length > 0 ? { ...rest, attributes: kept } : rest;
            })()
          : stats;
        const r = await fetch(`/characters/${target.id}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bioHtml,
            stats: cleanStats,
            avatarUrl: avatarUrl.trim() || null,
            avatarCrop,
            includeAvatarInGallery,
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
            // Per-character public-profile backdrop. Empty string
            // normalizes to null on the wire. Mode rides along on
            // every save (NOT NULL column with a default).
            publicProfileBgUrl: publicProfileBgUrl.trim() === "" ? null : publicProfileBgUrl.trim(),
            publicProfileBgMode,
            // Per-character Direct Messenger opt-in. Flipping this
            // changes who can friend-request / DM this character; see
            // the toggle row in the Privacy tab for the UI affordance.
            directMessengerEnabled,
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
                  // See note on the master path above, without
                  // this the checkbox flips back to false on the
                  // next render even though the server persisted
                  // the value correctly.
                  includeAvatarInGallery,
                  themeJson: theme ? JSON.stringify(theme) : null,
                  chatColor,
                  styleKey: userStyleKey,
                  isPublic: isNsfw ? false : isPublic,
                  isNsfw,
                  publicProfileBgUrl: publicProfileBgUrl.trim() === "" ? null : publicProfileBgUrl.trim(),
                  publicProfileBgMode,
                  directMessengerEnabled,
                }
              : c,
          ),
        );
      }
      // Stay in the editor so the user can switch to another target. Could also
      // close here - left open by design to support batch edits.
      flashSaved();
      onSaved?.(target.kind === "master"
        ? { kind: "master" }
        : { kind: "character", id: target.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.saveFailed"));
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
   * Equivalent to typing `/char switch <name>` from chat, and like that
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
        // Active identity just changed to this character, chat
        // should refresh to that character's theme.
        onSaved?.({ kind: "character", id: charId });
      } else {
        setError(res.message ?? t("errors.switchFailed"));
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
    const charName = characters.find((c) => c.id === target.id)?.name ?? t("editor.header.thisCharacterFallback");
    if (!window.confirm(t("editor.header.deleteConfirm", { name: charName }))) return;
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
      onSaved?.({ kind: "master" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.deleteFailed"));
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
  // returns. Once it lands, the real counts replace them, including
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
  // Build live ProfileCollectionEntry arrays from the earning snapshot
  // so the preview matches what visitors see on the real profile.
  // Pure derivation, `snapshot.collection` etc. are sparse `{slot,
  // itemKey}[]` arrays; we join against the catalog to surface
  // name/icon/description. Master and character pins are kept
  // separate so identity-switching the preview target swaps the
  // pin sets correctly.
  // Derive the equipped name-style key + parsed config for the
  // preview target's identity. Mirrors what the server's
  // getEquippedNameStyle would return on a real /profiles/:name call,
  // so the editor preview paints the username with the same style
  // chat does. Master reads activeCosmetics + ownedStyles; a
  // character reads activeCosmetics.byCharacter + ownedStylesByCharacter.
  const previewNameStyle = useMemo(() => {
    if (!earningSnapshot) return { key: null, config: null } as { key: string | null; config: Record<string, unknown> | null };
    let key: string | null = null;
    let owned: { styleKey: string; configJson: string | null }[] = [];
    if (target.kind === "master") {
      key = earningSnapshot.activeCosmetics.activeNameStyleKey ?? null;
      owned = earningSnapshot.ownedStyles ?? [];
    } else {
      key = earningSnapshot.activeCosmetics.byCharacter?.[target.id]?.activeNameStyleKey ?? null;
      owned = earningSnapshot.ownedStylesByCharacter?.[target.id] ?? [];
    }
    if (!key) return { key: null, config: null };
    const row = owned.find((o) => o.styleKey === key);
    let config: Record<string, unknown> | null = null;
    if (row?.configJson) {
      try { config = JSON.parse(row.configJson) as Record<string, unknown>; }
      catch { config = null; }
    }
    return { key, config };
  }, [earningSnapshot, target]);

  const previewCollections = useMemo(() => {
    const empty = { items: [] as ProfileCollectionEntry[], pets: [] as ProfileCollectionEntry[] };
    if (!earningSnapshot) return empty;
    const catalog = earningSnapshot.catalog.items ?? [];
    const byKey = new Map(catalog.map((c) => [c.key, c]));
    const enrich = (pins: { slot: number; itemKey: string }[]): ProfileCollectionEntry[] =>
      pins
        .map((p) => {
          const it = byKey.get(p.itemKey);
          if (!it) return null;
          return {
            slot: p.slot,
            itemKey: p.itemKey,
            name: it.name,
            namePlural: it.namePlural,
            description: it.description,
            iconUrl: it.iconUrl,
          };
        })
        .filter((x): x is ProfileCollectionEntry => x !== null);
    if (target.kind === "master") {
      return {
        items: enrich(earningSnapshot.collection ?? []),
        pets: enrich(earningSnapshot.petCollection ?? []),
      };
    }
    return {
      items: enrich(earningSnapshot.collectionByCharacter?.[target.id] ?? []),
      pets: enrich(earningSnapshot.petCollectionByCharacter?.[target.id] ?? []),
    };
  }, [earningSnapshot, target]);

  const previewProfile: ProfileView | null = useMemo(() => {
    const previewTheme = theme ?? siteDefaultTheme;
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
      // Mirror the server's synthetic-portrait prepend so the
      // "Include in Gallery" checkbox shows its effect immediately
      // in the preview pane (without a save). When the toggle is
      // off OR the avatar URL is empty OR the avatar already
      // appears as a real portrait row, leave the list alone.
      const trimmedAvatar = avatarUrl.trim();
      const previewPortraits =
        includeAvatarInGallery && trimmedAvatar &&
        !portraits.some((p) => p.url === trimmedAvatar)
          ? [{ id: "avatar", url: trimmedAvatar, label: null, nsfw: isNsfw }, ...portraits]
          : portraits;
      return {
        kind: "master",
        profile: {
          userId: myUserId ?? "preview",
          username: master.username,
          bioHtml: bioHtml,
          avatarUrl: trimmedAvatar || null,
          avatarCrop,
          portraits: previewPortraits,
          gender,
          languages,
          theme: previewTheme,
          styleKey: userStyleKey || DEFAULT_STYLE_KEY,
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
          // Editor's preview doesn't fetch the Scriptorium author tier
          // (it'd be a separate /me/profile field we'd need to wire);
          // surface null so the modal renders without a badge in the
          // preview. The real profile view shows the real badge.
          scriptoriumAuthor: null,
          // Preview pins read live from the earning snapshot so the
          // preview matches the real profile 1:1, the editor still
          // doesn't expose pin management (users curate from the
          // Earning dashboard's Items > Collection / Pets tabs), but
          // the preview at least surfaces what's currently pinned.
          collection: previewCollections.items,
          petCollection: previewCollections.pets,
          library: [],
          nameStyleKey: previewNameStyle.key,
          nameStyleConfig: previewNameStyle.config,
          // Banner URL isn't editable from ProfileEditor, it lives on
          // the Flair tab. Surface the currently-equipped URL from
          // the earning snapshot so the preview shows what's saved
          // (or null when nothing's set / cosmetic isn't owned).
          profileBannerUrl: earningSnapshot?.activeCosmetics.profileBannerUrl ?? null,
          // Live BG so the preview's backdrop reflects the editor's
          // controls without a save round-trip.
          publicProfileBgUrl: publicProfileBgUrl.trim() === "" ? null : publicProfileBgUrl.trim(),
          publicProfileBgMode,
        },
      };
    }
    // Same synthetic-portrait dance as the master branch above,
    // the character preview also reflects the checkbox immediately.
    const trimmedCharAvatar = avatarUrl.trim();
    const previewCharPortraits =
      includeAvatarInGallery && trimmedCharAvatar &&
      !portraits.some((p) => p.url === trimmedCharAvatar)
        ? [{ id: "avatar", url: trimmedCharAvatar, label: null, nsfw: isNsfw }, ...portraits]
        : portraits;
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
        avatarUrl: trimmedCharAvatar || null,
        avatarCrop,
        portraits: previewCharPortraits,
        links,
        // Account-level tags: the character preview mirrors what the real
        // character profile shows — the owner's saved language set.
        languages: Array.isArray(master?.languages) ? master.languages : [],
        // Journal entries are managed inline in the editor (not via preview).
        // The preview ProfileModal shows the character preview as others
        // would see it, but live-fetching journal here would mix the
        // editor's "all entries" view with the modal's "public only" view.
        // Easier to leave the preview empty and let the user open the
        // actual profile to verify.
        journalEntries: [],
        theme: previewTheme,
        styleKey: userStyleKey || DEFAULT_STYLE_KEY,
        titles: [],
        isPublic: isNsfw ? false : isPublic,
        isNsfw,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metrics: fetchedMetrics,
        // Editor's preview doesn't fetch the Scriptorium author tier,
        // same null fallback as the master branch above. The actual
        // profile view (lookupProfile path) populates the real badge.
        scriptoriumAuthor: null,
        // Live pin counts from the snapshot, same parity goal as
        // the master branch above. Switching the preview target to
        // a character picks up that character's pin sets.
        collection: previewCollections.items,
        petCollection: previewCollections.pets,
        library: [],
        nameStyleKey: previewNameStyle.key,
        nameStyleConfig: previewNameStyle.config,
        // Per-character banner URL, looked up by character id; falls
        // back to null when this character doesn't own the cosmetic.
        profileBannerUrl: earningSnapshot?.activeCosmetics.byCharacter?.[target.id]?.profileBannerUrl ?? null,
        publicProfileBgUrl: publicProfileBgUrl.trim() === "" ? null : publicProfileBgUrl.trim(),
        publicProfileBgMode,
      },
    };
  }, [target, master, myUserId, name, bioHtml, avatarUrl, includeAvatarInGallery, gender, languages, stats, theme, siteDefaultTheme, portraits, links, isPublic, isNsfw, previewMetrics, previewTargetKey, previewCollections, previewNameStyle, publicProfileBgUrl, publicProfileBgMode, earningSnapshot]);

  const targetOptions = useMemo(() => {
    return [
      { value: "master:", label: master ? t("editor.header.masterOocWithName", { name: master.username }) : t("editor.header.masterOoc") },
      ...characters.map((c) => ({ value: `character:${c.id}`, label: c.name })),
    ];
  }, [master, characters, t]);

  function onSelectTarget(value: string) {
    if (value.startsWith("master:")) setTarget({ kind: "master" });
    else if (value.startsWith("character:")) setTarget({ kind: "character", id: value.slice(10) });
  }

  const isCharacter = target.kind === "character";
  const targetValue = target.kind === "master" ? "master:" : `character:${target.id}`;

  // Live preview, push the editor's pending palette + style + bg
  // URL onto <html> so the chat behind the editor reflects every
  // dropdown change instantly. Without this, the user has to click
  // Save (and sometimes re-open the modal) to verify their pick
  // landed. On close, the parent bumps themeVersion which triggers
  // App.tsx to re-fetch persisted state and re-apply, naturally
  // restoring the saved theme if the user cancelled.
  useEffect(() => {
    // Don't apply the live preview until the target's saved theme has actually
    // loaded. Before load, `theme` is still null, so this would slam the
    // fallback onto <html> OVER the already-active (correct) theme — a flash
    // across the whole app (chat shell AND the userlist), which then snaps back
    // once the saved theme arrives.
    //
    // The fallback is the SITE default palette, NOT the hard-coded light
    // `DEFAULT_THEME`. A user with no personal theme already sees
    // `branding.defaultTheme` in chat, so for them applying it here is a visual
    // no-op. Using `DEFAULT_THEME` instead was the "open the editor and the
    // whole app turns light" bug: every freshly-registered (no-theme) user got
    // Parchment forced onto <html>, and since the editor applies the preview
    // directly it stuck (clicking "Default" → setTheme(null) reproduced it too).
    if (loadingTarget) return;
    const previewTheme = theme ?? siteDefaultTheme;
    applyTheme(previewTheme);
    applyStyle(previewTheme, userStyleKey);
    const root = document.documentElement;
    if (userStyleKey === "glass") {
      const trimmed = publicProfileBgUrl.trim();
      const url = trimmed || (isDarkPalette(previewTheme) ? "/the_spire_bg_dark.jpg" : "/the_spire_bg.jpg");
      const size = trimmed
        ? (publicProfileBgMode === "stretch" ? "100% 100%" : publicProfileBgMode)
        : "cover";
      const repeat = trimmed && publicProfileBgMode === "tile" ? "repeat" : "no-repeat";
      // Publish as CSS vars only, the actual paint happens on
      // `.keep-bg-overlay` (inside the chat shell) so the image
      // never leaks past the shell when a devtools / extension UI
      // shifts the document.
      root.style.setProperty("--keep-shell-bg-url", `url("${url}")`);
      root.style.setProperty("--keep-shell-bg-size", size);
      root.style.setProperty("--keep-shell-bg-repeat", repeat);
      // Luminance-aware glass tints, mirror App.tsx so the live
      // preview matches post-save. White overlays on light themes;
      // palette-color overlays on dark themes.
      const isDark = isDarkPalette(previewTheme);
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
  }, [theme, siteDefaultTheme, userStyleKey, publicProfileBgUrl, publicProfileBgMode, loadingTarget]);

  return (
    <Modal onClose={onClose} zIndex={isAdminEdit ? 60 : 50} variant="mobile-fullscreen">
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-parchment`}
      >
        {/* header - fixed */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-keep-rule bg-keep-banner px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="shrink-0 font-action text-lg">{t("editor.header.title")}</h2>
            {isAdminEdit ? (
              // Admin-acting-on-other-user banner. Replaces the
              // master/character switcher + side buttons (those are
              // self-edit affordances, +New makes no sense on
              // another user's account, Switch acts on the admin's
              // own session, Delete is reserved to the admin Users
              // tab). The label `name` (set by the load effect from
              // the character row) appears here once it lands.
              <span
                className="shrink-0 rounded border border-keep-accent/60 bg-keep-accent/10 px-2 py-0.5 text-xs uppercase tracking-widest text-keep-accent"
                title={t("editor.header.adminEditTitle", { name: name || t("editor.header.loadingWord"), owner: adminContext.ownerUsername })}
              >
                {t("editor.header.adminEditPrefix")} {name || "…"} <span className="text-keep-muted normal-case">{t("editor.header.ownedBy", { owner: adminContext.ownerUsername })}</span>
              </span>
            ) : (
              <>
                <select
                  value={targetValue}
                  onChange={(e) => onSelectTarget(e.target.value)}
                  disabled={loadingList}
                  className="min-w-0 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm"
                >
                  {loadingList ? (
                    <option>{t("editor.loadingLower")}</option>
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
                  title={t("editor.header.newCharacterTitle")}
                  className="shrink-0 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm hover:bg-keep-banner disabled:opacity-50"
                >
                  {t("editor.header.newCharacter")}
                </button>
                {isCharacter && master && master.activeCharacterId !== (target.kind === "character" ? target.id : null) ? (
                  <button
                    type="button"
                    onClick={switchToCharacter}
                    disabled={switching || loadingTarget}
                    title={t("editor.header.switchTitle")}
                    className="keep-button shrink-0 rounded border border-keep-action/60 bg-keep-bg px-2 py-0.5 text-sm text-keep-action hover:bg-keep-action/10 disabled:opacity-50"
                  >
                    {switching ? t("editor.header.switching") : t("editor.header.switch")}
                  </button>
                ) : null}
                {isCharacter ? (
                  <button
                    type="button"
                    onClick={deleteCharacter}
                    disabled={deleting || loadingTarget}
                    title={t("editor.header.deleteTitle")}
                    className="keep-button shrink-0 rounded border border-keep-accent/60 bg-keep-bg px-2 py-0.5 text-sm text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
                  >
                    {deleting ? t("editor.header.deleting") : t("common:delete")}
                  </button>
                ) : null}
              </>
            )}
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {/* Tab strip. Replaces the old mobile-only Settings/Description
            split + the two-column desktop grid. Each tab gets the full
            modal width so the color picker, links editor, etc. have
            room to breathe instead of fighting a 420px sidebar. The
            strip scrolls horizontally on narrow viewports, mobile
            users swipe; desktop users see them all at once.
            `flex-nowrap` + `overflow-x-auto` is the canonical pattern
            for this. */}
        {(() => {
          const tabs: Array<{ id: EditorTab; label: string; show: boolean }> = [
            { id: "description", label: t("editor.tabs.description"), show: true },
            { id: "profile",     label: t("editor.tabs.profile"),     show: true },
            { id: "appearance",  label: t("editor.tabs.appearance"),  show: true },
            { id: "privacy",     label: t("editor.tabs.privacy"),     show: true },
            { id: "links",       label: t("editor.tabs.links"),       show: true },
            // Gallery is per-identity: characters use
            // /characters/:id/portraits (character_portraits table),
            // master uses /me/portraits (user_portraits, added in
            // migration 0113). Both expose the same shape so the
            // editor's PortraitGalleryEditor swaps endpoint URLs
            // based on the active target.
            { id: "gallery",     label: t("editor.tabs.gallery"),     show: true },
            { id: "flair",       label: t("editor.tabs.flair"),       show: true },
            { id: "journal",     label: t("editor.tabs.journal"),     show: isCharacter },
          ];
          const visible = tabs.filter((t) => t.show);
          return (
            <div
              className="shrink-0 border-b border-keep-rule bg-keep-banner/40"
              role="tablist"
            >
              {/* Mobile (<md): collapse the tab strip to a full-width
                  dropdown. The horizontal-scroll strip pushed the last
                  tab(s) off-screen on phones and made discovery
                  hostile, Gallery/Journal frequently fell into the
                  hidden overflow on character profiles. This pattern
                  mirrors AdminPanel + EarningDashboard, so the whole
                  app reads consistently on mobile. */}
              <div className="px-2 py-1 md:hidden">
                <select
                  value={activeTab}
                  onChange={(e) => setActiveTab(e.target.value as EditorTab)}
                  aria-label={t("editor.tabs.sectionAria")}
                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs uppercase tracking-widest text-keep-text outline-none focus:border-keep-action"
                >
                  {visible.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              </div>
              {/* Desktop (md+): the original horizontal strip. Hidden
                  on mobile by the matching `md:hidden` on the dropdown
                  above. `overflow-x-auto` is kept as a safety net for
                  narrow desktop widths but should rarely engage with
                  only 5-7 tabs at the typical desktop font size. */}
              <div className="hidden flex-nowrap overflow-x-auto md:flex">
                {visible.map((t) => (
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
            </div>
          );
        })()}

        {/* Tab content, fills remaining height; scrolls when long. */}
        {loadingTarget ? (
          <div className="flex flex-1 items-center justify-center text-keep-muted">{t("editor.loadingLower")}</div>
        ) : (
          <div
            // Calm-mode fade: remount on tab change (key) so `tk-fade-in`
            // replays as the new tab's body eases in. Key + class applied
            // ONLY when Reduce Motion is on; the per-tab bodies still own
            // their own scroll (overflow-y-auto), so the scroll container is
            // unchanged. Off-path render is byte-identical to before.
            {...(reduceMotion ? { key: activeTab } : {})}
            className={`flex min-h-0 flex-1 flex-col overflow-hidden${reduceMotion ? " tk-fade-in" : ""}`}
          >
            {/* DESCRIPTION, the bio HTML editor. Was the right column on
                desktop; now its own tab so it gets the full width too. */}
            {activeTab === "description" ? (
              <div className="flex min-h-0 flex-1 flex-col p-4">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="uppercase tracking-widest text-keep-muted">
                    {isCharacter ? t("editor.description.characterBio") : t("editor.description.oocBio")}
                  </span>
                  {designerAvailable ? (
                    // Designer / Source toggle. Both edit the same `bioHtml`,
                    // so switching carries edits across. The Designer remounts
                    // each time it's entered (keyed on the mode), so it always
                    // loads the latest source — including hand-edits.
                    <div className="inline-flex items-center gap-1.5">
                    {bioMode === "designer" ? (
                      <button
                        type="button"
                        onClick={() => setShowDesignerTour(true)}
                        title={t("editor.description.showTour")}
                        aria-label={t("editor.description.showTour")}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-keep-rule bg-keep-bg/60 text-keep-muted shadow-sm hover:text-keep-accent"
                      >
                        <HelpCircle className="h-4 w-4" aria-hidden />
                      </button>
                    ) : null}
                    <div data-tour="bio-mode-toggle" className="inline-flex items-center gap-1 rounded-lg border border-keep-rule bg-keep-bg/60 p-1 shadow-sm">
                      {([
                        { m: "designer", label: t("bioMode.designer"), Icon: Paintbrush2 },
                        { m: "source", label: t("bioMode.source"), Icon: Code2 },
                      ] as const).map(({ m, label, Icon }) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setBioMode(m)}
                          aria-pressed={bioMode === m}
                          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                            bioMode === m
                              ? "bg-keep-accent text-keep-bg shadow"
                              : "text-keep-muted hover:bg-keep-accent/10 hover:text-keep-text"
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" aria-hidden />
                          {label}
                        </button>
                      ))}
                    </div>
                    </div>
                  ) : (
                    <span className="text-keep-muted">
                      {t("editor.description.htmlHint")}
                    </span>
                  )}
                </div>
                {designerAvailable && bioMode === "designer" ? (
                  <div className="min-h-0 flex-1 overflow-hidden rounded border border-keep-rule">
                    <Suspense
                      fallback={<div className="flex h-full items-center justify-center text-xs italic text-keep-muted">{t("bioMode.loadingDesigner")}</div>}
                    >
                      <ProfileDesigner value={bioHtml} onChange={setBioHtml} />
                    </Suspense>
                  </div>
                ) : (
                  <textarea
                    value={bioHtml}
                    onChange={(e) => setBioHtml(e.target.value)}
                    className="min-h-0 w-full flex-1 resize-none rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs outline-none focus:border-keep-action"
                    placeholder={
                      isCharacter
                        ? t("editor.description.characterPlaceholder")
                        : t("editor.description.oocPlaceholder")
                    }
                  />
                )}
                <div className="mt-1 text-right text-[10px] text-keep-muted tabular-nums">
                  {formatNumber(bioHtml.length)} / {formatNumber(master?.limits?.maxBioLength ?? 50_000)}
                </div>
                {designerAvailable && bioMode === "designer" && showDesignerTour ? (
                  <DesignerTour onClose={closeDesignerTour} />
                ) : null}
              </div>
            ) : null}

            {/* PROFILE, name, avatar, gender (master) / stats (character).
                The bread-and-butter "who am I" tab. */}
            {activeTab === "profile" ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <Field
                  label={isCharacter ? t("fields.characterName") : t("editor.profileTab.masterUsername")}
                  value={name}
                  readOnly
                  hint={isCharacter ? t("editor.profileTab.renameBlockedHint") : t("editor.profileTab.setAtRegistration")}
                />
                {/* Gender (OOC), moved up here from below the gallery
                    toggle so the "who am I" identity fields cluster
                    together (name + gender) instead of being split by
                    the avatar block. Character views still keep their
                    gender inside the structured Stats grid below;
                    only the master/OOC view surfaces it as a
                    standalone field. */}
                {!isCharacter ? (
                  <label className="block text-xs">
                    <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.profileTab.genderOoc")}</span>
                    <select
                      value={gender}
                      onChange={(e) => setGender(e.target.value as Gender)}
                      className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
                    >
                      {GENDER_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{t(`gender.options.${o.value}`)}</option>
                      ))}
                    </select>
                    <span className="mt-1 block text-[10px] text-keep-muted">
                      {t("editor.profileTab.genderHint")}
                    </span>
                  </label>
                ) : null}
                {/* Language tags (account-level, master/OOC only). A fixed
                    catalog picker — chips with a remove ×, plus an "Add a
                    language" select listing what's left. Tags render as
                    flag chips in the profile header (characters show the
                    account's tags too). */}
                {!isCharacter ? (
                  <div className="text-xs">
                    <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.profileTab.languages")}</span>
                    {languages.length > 0 ? (
                      <div className="mb-1.5 flex flex-wrap items-center gap-1">
                        {languages.map((key) => {
                          const tag = languageTagByKey.get(key);
                          if (!tag) return null;
                          return (
                            <span
                              key={key}
                              className="inline-flex items-center gap-1.5 rounded border border-keep-rule bg-keep-bg px-1.5 py-1 leading-none"
                            >
                              <LangFlag code={tag.flag} className="h-2.5 w-[15px] shrink-0 overflow-hidden rounded-[2px] ring-1 ring-black/25" />
                              <span>{tag.label}</span>
                              <button
                                type="button"
                                onClick={() => setLanguages((prev) => prev.filter((k) => k !== key))}
                                title={t("editor.profileTab.languagesRemove", { language: tag.label })}
                                aria-label={t("editor.profileTab.languagesRemove", { language: tag.label })}
                                className="-mr-0.5 rounded p-0.5 text-keep-muted hover:bg-keep-action/10 hover:text-keep-text"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                    {languages.length < LANGUAGE_TAG_MAX ? (
                      <select
                        value=""
                        onChange={(e) => {
                          const key = e.target.value;
                          if (!key) return;
                          setLanguages((prev) =>
                            prev.includes(key) || prev.length >= LANGUAGE_TAG_MAX ? prev : [...prev, key],
                          );
                        }}
                        className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
                      >
                        <option value="">{t("editor.profileTab.languagesAdd")}</option>
                        {LANGUAGE_TAGS.filter((tag) => !languages.includes(tag.key)).map((tag) => (
                          <option key={tag.key} value={tag.key}>{tag.label}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="block text-[10px] text-keep-muted">
                        {t("editor.profileTab.languagesMax", { max: LANGUAGE_TAG_MAX })}
                      </span>
                    )}
                    <span className="mt-1 block text-[10px] text-keep-muted">
                      {t("editor.profileTab.languagesHint")}
                    </span>
                  </div>
                ) : null}
                <Field
                  label={t("editor.profileTab.mainImageLabel")}
                  value={avatarUrl}
                  onChange={setAvatarUrl}
                  placeholder={t("editor.profileTab.imageUrlPlaceholder")}
                  hint={t("editor.profileTab.mainImageHint")}
                />
                {/* Zoom + pan picker, lets the owner pick which part
                    of the source image becomes the visible circle. The
                    output threads through to the server as `avatarCrop`
                    on the PUT body, then back out to every BorderedAvatar
                    render via the `avatarCrop` prop. Defaults to the
                    identity crop so users who don't open the picker
                    keep the legacy centered-cover look. */}
                <AvatarCropPicker
                  url={avatarUrl}
                  crop={avatarCrop}
                  onChange={setAvatarCrop}
                />
                {/* "Include in Gallery", when ticked, the server
                    prepends a synthetic tile (the avatar) to the
                    portrait gallery list, so visitors see the avatar
                    alongside the other gallery images instead of only
                    as the hero. Stored on the row (migration 0114);
                    the synthetic entry resolves at lookup time so
                    changing the avatar URL never leaves a stale
                    duplicate in the gallery. */}
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0"
                    checked={includeAvatarInGallery}
                    onChange={(e) => setIncludeAvatarInGallery(e.target.checked)}
                    disabled={!avatarUrl.trim()}
                  />
                  <span className="min-w-0">
                    <span className="block uppercase tracking-widest text-keep-muted">
                      {t("editor.profileTab.includeInGallery")}
                    </span>
                    <span className="block text-[10px] text-keep-muted">
                      {t("editor.profileTab.includeInGalleryHint")}
                    </span>
                  </span>
                </label>
                {isCharacter ? (
                  <>
                    <fieldset className="rounded border border-keep-rule p-3">
                      <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">{t("modal.sections.stats")}</legend>
                      <p className="mb-2 text-[10px] text-keep-muted">
                        {t("editor.statsSection.hint")}
                      </p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {STAT_FIELDS.map((key) => {
                          const label = t(`statFields.${key}`);
                          const hidden = stats.visibility?.[key] === false;
                          return (
                            <div key={key} className="block text-xs">
                              <div className="mb-1 flex items-center justify-between gap-1">
                                <span className="uppercase tracking-widest text-keep-muted">{label}</span>
                                <VisibilityToggle
                                  hidden={hidden}
                                  onToggle={() => setStats((s) => toggleVisibility(s, key))}
                                  label={label}
                                />
                              </div>
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
                                  // Free text (numbers OR "Ageless" / "early 30s"); capped to
                                  // match the server so a long value is blocked here instead of
                                  // bouncing off save-time validation.
                                  maxLength={STAT_FIELD_MAX}
                                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                                  value={(stats[key] as string) ?? ""}
                                  onChange={(e) =>
                                    setStats((s) => ({ ...s, [key]: e.target.value || undefined }))
                                  }
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>

                    <VibeAxesEditor stats={stats} onChange={setStats} />
                    <AttributesEditor stats={stats} onChange={setStats} />
                  </>
                ) : null}
              </div>
            ) : null}

            {/* APPEARANCE, chat color, theme palette, theme style
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
                    {isCharacter ? t("editor.appearance.characterTheme") : t("editor.appearance.oocTheme")}
                  </legend>
                  <p className="mb-2 text-[10px] text-keep-muted">
                    {isCharacter
                      ? t("editor.appearance.characterThemeHint")
                      : t("editor.appearance.oocThemeHint")}
                  </p>
                  <ThemePicker
                    theme={theme ?? siteDefaultTheme}
                    onChange={setTheme}
                    onReset={() => setTheme(null)}
                  />
                  {!theme ? (
                    <div className="mt-1 text-[10px] italic text-keep-muted">
                      {t("editor.appearance.usingDefault")}
                    </div>
                  ) : null}
                </fieldset>
                <fieldset className="rounded border border-keep-rule p-3">
                  <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">{t("editor.appearance.themeStyle")}</legend>
                  <p className="mb-2 text-[10px] text-keep-muted">
                    {isCharacter
                      ? t("editor.appearance.themeStyleCharacterHint")
                      : t("editor.appearance.themeStyleOocHint")}
                  </p>
                  <StylePicker
                    value={userStyleKey}
                    onChange={setUserStyleKey}
                    allowInherit
                  />
                </fieldset>
                {/* PUBLIC PROFILE BACKGROUND, image painted on the
                    profile modal's backdrop (the area around the
                    modal card) when others view /p/<this identity>.
                    Per-identity: a character's BG is independent of
                    the master's. Clicking the backdrop still closes
                    the modal, the BG only changes how that area
                    looks, not how it behaves. */}
                <fieldset className="rounded border border-keep-rule p-3">
                  <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">{t("editor.bg.legend")}</legend>
                  <p className="mb-2 text-[10px] text-keep-muted">
                    {isCharacter
                      ? t("editor.bg.characterHint")
                      : t("editor.bg.oocHint")}
                  </p>
                  <label className="block text-xs">
                    <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.bg.imageUrl")}</span>
                    <input
                      type="url"
                      value={publicProfileBgUrl}
                      onChange={(e) => setPublicProfileBgUrl(e.target.value)}
                      placeholder={t("editor.bg.urlPlaceholder")}
                      maxLength={1000}
                      className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs"
                    />
                  </label>
                  <label className="mt-3 block text-xs">
                    <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.bg.displayMode")}</span>
                    <select
                      value={publicProfileBgMode}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "cover" || v === "contain" || v === "tile" || v === "stretch") {
                          setPublicProfileBgMode(v);
                        }
                      }}
                      className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
                    >
                      <option value="cover">{t("editor.bg.modeCover")}</option>
                      <option value="contain">{t("editor.bg.modeContain")}</option>
                      <option value="tile">{t("editor.bg.modeTile")}</option>
                      <option value="stretch">{t("editor.bg.modeStretch")}</option>
                    </select>
                  </label>
                  {publicProfileBgUrl.trim() !== "" ? (
                    // Inline preview tile, shows the URL with the
                    // chosen mode at a small fixed-aspect frame so the
                    // user can verify the BG renders correctly before
                    // saving. Same backgroundSize / backgroundRepeat
                    // mapping ProfileModal uses at render time.
                    <div className="mt-3">
                      <span className="mb-1 block text-[10px] uppercase tracking-widest text-keep-muted">{t("common:preview")}</span>
                      <div
                        className="h-32 w-full rounded border border-keep-rule bg-keep-bg"
                        style={{
                          backgroundImage: `url("${publicProfileBgUrl.trim()}")`,
                          backgroundSize:
                            publicProfileBgMode === "stretch"
                              ? "100% 100%"
                              : publicProfileBgMode === "tile"
                                ? "auto"
                                : publicProfileBgMode,
                          backgroundRepeat: publicProfileBgMode === "tile" ? "repeat" : "no-repeat",
                          backgroundPosition: "center",
                        }}
                      />
                    </div>
                  ) : null}
                </fieldset>
                {/* PROFILE BANNER, Flair cosmetic surfaced inline so
                    the URL is editable here (not just in the Flair tab).
                    Renders only when this identity OWNS the cosmetic;
                    purchase still happens on the Flair tab to keep all
                    buy flows + price logic in one place, but URL edits
                    happen wherever the user is currently looking at
                    their appearance, which is here. Per-identity:
                    master vs each character carries its own banner +
                    own purchase. */}
                {(() => {
                  const bannerOwned = isCharacter
                    ? (earningSnapshot?.activeCosmetics.byCharacter?.[target.id]?.profileBannerOwned ?? false)
                    : (earningSnapshot?.activeCosmetics.profileBannerOwned ?? false);
                  const equippedBannerUrl = isCharacter
                    ? (earningSnapshot?.activeCosmetics.byCharacter?.[target.id]?.profileBannerUrl ?? null)
                    : (earningSnapshot?.activeCosmetics.profileBannerUrl ?? null);
                  if (!bannerOwned) return null;
                  const trimmedDraft = bannerDraft.trim();
                  const dirty = trimmedDraft !== (equippedBannerUrl ?? "");
                  // Live URL preview, `trimmedDraft` for the input's
                  // current value, falling back to the saved URL so the
                  // section always has something to render when the
                  // slot has any image. Empty draft + empty saved =
                  // blank preview area (the "Clear" state).
                  const previewUrl = trimmedDraft || equippedBannerUrl;
                  async function saveBanner(next: string | null) {
                    setBannerSaving(true);
                    setBannerError(null);
                    try {
                      const characterId = target.kind === "character" ? target.id : null;
                      await patchProfileBannerUrl(next, characterId);
                      await refreshEarning();
                    } catch (e) {
                      setBannerError(e instanceof Error ? e.message : t("errors.saveFailedShort"));
                    } finally {
                      setBannerSaving(false);
                    }
                  }
                  return (
                    <fieldset className="rounded border border-keep-rule p-3">
                      <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
                        {t("editor.banner.legend")}
                      </legend>
                      <p className="mb-2 text-[10px] text-keep-muted">
                        {t("editor.banner.hint")}
                      </p>
                      <label className="block text-xs">
                        <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.banner.imageLink")}</span>
                        <input
                          type="url"
                          inputMode="url"
                          value={bannerDraft}
                          onChange={(e) => setBannerDraft(e.target.value)}
                          placeholder={t("editor.banner.urlPlaceholder")}
                          maxLength={1000}
                          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs"
                        />
                      </label>
                      {previewUrl ? (
                        <div className="mt-3">
                          <span className="mb-1 block text-[10px] uppercase tracking-widest text-keep-muted">{t("common:preview")}</span>
                          <div className="overflow-hidden rounded border border-keep-rule bg-keep-panel">
                            <img
                              src={previewUrl}
                              alt=""
                              loading="lazy"
                              className="block max-h-[220px] w-full object-cover object-center"
                              onError={(e) => {
                                const el = e.currentTarget as HTMLImageElement;
                                el.style.display = "none";
                              }}
                            />
                          </div>
                        </div>
                      ) : null}
                      {bannerError ? (
                        <p className="mt-1 text-[10px] text-keep-accent">{bannerError}</p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                        {equippedBannerUrl ? (
                          <button
                            type="button"
                            onClick={() => {
                              setBannerDraft("");
                              void saveBanner(null);
                            }}
                            disabled={bannerSaving}
                            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner disabled:opacity-50"
                          >
                            {t("common:clear")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void saveBanner(trimmedDraft || null)}
                          disabled={bannerSaving || !dirty}
                          className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
                        >
                          {bannerSaving ? t("common:saving") : t("editor.banner.save")}
                        </button>
                      </div>
                    </fieldset>
                  );
                })()}
                {!isCharacter ? (
                  <fieldset className="rounded border border-keep-rule p-3">
                    <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
                      {t("editor.fonts.legend")}
                    </legend>
                    <p className="mb-2 text-[10px] text-keep-muted">
                      {t("editor.fonts.hint")}
                    </p>
                    <label className="block text-xs">
                      <span className="mb-1 block uppercase tracking-widest text-keep-muted">
                        {t("editor.fonts.family")}
                      </span>
                      <select
                        value={uiFontFamily ?? ""}
                        onChange={(e) => setUiFontFamily(e.target.value === "" ? null : e.target.value)}
                        // Render the dropdown trigger in the currently-
                        // selected font so the preview is visible without
                        // having to save first. Per-option font previews
                        // are attempted via inline `style.fontFamily`;
                        // some browsers honor it in the open dropdown,
                        // some show all options in the default UI font,
                        // both behaviors are acceptable.
                        style={uiFontFamily ? { fontFamily: uiFontFamily } : undefined}
                        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
                      >
                        <option value="">{t("editor.fonts.defaultSiteFont")}</option>
                        <optgroup label={t("editor.fonts.groupSans")}>
                          <option value='"Roboto", sans-serif' style={{ fontFamily: '"Roboto", sans-serif' }}>Roboto</option>
                          <option value='"Open Sans", sans-serif' style={{ fontFamily: '"Open Sans", sans-serif' }}>Open Sans</option>
                          <option value='"Inter", sans-serif' style={{ fontFamily: '"Inter", sans-serif' }}>Inter</option>
                          <option value='"Lato", sans-serif' style={{ fontFamily: '"Lato", sans-serif' }}>Lato</option>
                          <option value='"Source Sans 3", sans-serif' style={{ fontFamily: '"Source Sans 3", sans-serif' }}>Source Sans 3</option>
                        </optgroup>
                        <optgroup label={t("editor.fonts.groupSerif")}>
                          <option value='"Lora", serif' style={{ fontFamily: '"Lora", serif' }}>Lora</option>
                          <option value='"Merriweather", serif' style={{ fontFamily: '"Merriweather", serif' }}>Merriweather</option>
                          <option value='"Roboto Slab", serif' style={{ fontFamily: '"Roboto Slab", serif' }}>Roboto Slab</option>
                        </optgroup>
                        <optgroup label={t("editor.fonts.groupAccessibility")}>
                          <option value='"Atkinson Hyperlegible", sans-serif' style={{ fontFamily: '"Atkinson Hyperlegible", sans-serif' }}>Atkinson Hyperlegible</option>
                          <option value='"Comic Sans MS", "Chalkboard SE", sans-serif' style={{ fontFamily: '"Comic Sans MS", "Chalkboard SE", sans-serif' }}>{t("editor.fonts.comicSans")}</option>
                        </optgroup>
                        <optgroup label={t("editor.fonts.groupSystem")}>
                          <option value='system-ui, sans-serif' style={{ fontFamily: 'system-ui, sans-serif' }}>{t("editor.fonts.systemSans")}</option>
                          <option value='Georgia, serif' style={{ fontFamily: 'Georgia, serif' }}>Georgia</option>
                          <option value='Verdana, sans-serif' style={{ fontFamily: 'Verdana, sans-serif' }}>Verdana</option>
                          <option value='Arial, sans-serif' style={{ fontFamily: 'Arial, sans-serif' }}>Arial</option>
                        </optgroup>
                      </select>
                    </label>
                    <label className="mt-3 block text-xs">
                      <span className="mb-1 block uppercase tracking-widest text-keep-muted">
                        {t("editor.fonts.size")}
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
                        <option value="">{t("editor.fonts.sizeDefault")}</option>
                        <option value="small">{t("editor.fonts.sizeSmall")}</option>
                        <option value="medium">{t("editor.fonts.sizeMedium")}</option>
                        <option value="large">{t("editor.fonts.sizeLarge")}</option>
                        <option value="xl">{t("editor.fonts.sizeXl")}</option>
                      </select>
                    </label>
                  </fieldset>
                ) : null}
                {!isCharacter ? (
                  <fieldset className="rounded border border-keep-rule p-3">
                    <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
                      {t("editor.language.legend")}
                    </legend>
                    <p className="mb-2 text-[10px] text-keep-muted">
                      {t("editor.language.hint")}
                    </p>
                    <label className="block text-xs">
                      <span className="mb-1 block uppercase tracking-widest text-keep-muted">
                        {t("editor.language.interfaceLanguage")}
                      </span>
                      <select
                        value={localePref ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          const choice = LOCALE_CHOICES.find((c) => c.value === v);
                          void changeLocale(choice ? choice.value : null);
                        }}
                        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
                      >
                        <option value="">{t("common:language.systemDefault")}</option>
                        {LOCALE_CHOICES.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                    </label>
                  </fieldset>
                ) : null}
              </div>
            ) : null}

            {/* PRIVACY, visibility (public / NSFW), push notifications,
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
                {isCharacter ? (
                  <CharacterDmOptInRow
                    enabled={directMessengerEnabled}
                    onChange={setDirectMessengerEnabled}
                  />
                ) : null}
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
                {!isCharacter ? (
                  <FlairDisplayRow
                    disableNameStyles={disableNameStyles}
                    disableBorderStyles={disableBorderStyles}
                    disableInlineAvatars={disableInlineAvatars}
                    onChangeDisableNameStyles={setDisableNameStyles}
                    onChangeDisableBorderStyles={setDisableBorderStyles}
                    onChangeDisableInlineAvatars={setDisableInlineAvatars}
                  />
                ) : null}
                {/* Earning, Currency privacy. Master-only; characters
                    inherit the master's privacy flag and don't have their
                    own. Self-saving (immediate PATCH to
                    /earning/me/settings), so it doesn't ride the
                    profile form's Save button. */}
                {!isCharacter ? <CurrencyPrivacyRow /> : null}
                {/* Visitor-counter public-display toggle, mirrored
                    from Edit Profile → Flair so users hunting for
                    visibility switches under Privacy find it here
                    too. Renders nothing when the active identity
                    doesn't own `flair_profile_visitors`, so it
                    doesn't clutter for non-buyers. The actual
                    member / external count breakdown stays on the
                    Flair tab. */}
                <VisitorsVisibilityToggleRow
                  characterId={target.kind === "character" ? target.id : null}
                />

                {/* Read-only birth date (age plan Phase 0). Master-only,
                    the date is account-level. No edit control on purpose:
                    corrections go through staff. */}
                {!isCharacter ? <BirthDateRow /> : null}
                {/* Rank-visibility toggles + metric privacy. Both
                    are per-master-account preferences; characters
                    don't have separate versions, so we gate the
                    render on `!isCharacter`. Self-saving via the
                    /me/profile PUT for the same reason CurrencyPrivacyRow
                    self-saves, the row sits alongside other privacy
                    sections and "checked it, expected it, didn't see
                    a Save button" was a sharp paper-cut earlier. */}
                {!isCharacter ? <DisplayPrivacyRow /> : null}
                {/* Adult "Hide 18+ content" preference (age plan Phase
                    4). Master-only (account-level, feeds the server's
                    soft canSeeNsfw tier). Renders nothing for minors:
                    their account can never see 18+ content, so there is
                    no state for the toggle to show. */}
                {!isCharacter ? <HideNsfwRow /> : null}
                {/* Minor isolation mode (age plan Phase 5). Master-only,
                    account-level; renders nothing for adults (the server
                    rejects the field for them and goes inert at 18). */}
                {!isCharacter ? <IsolationRow /> : null}
                {/* Scriptorium catalog prefs: NSFW opt-in + per-user
                    CW blocklist. Master-only, characters don't have
                    their own catalog filters (the master account is
                    the reader identity, not the per-character mask). */}
                {!isCharacter ? <ScriptoriumPrivacyRow /> : null}
                {/* Blocked-users management. Master-only (blocks are global
                    + account-level). The only place to UNDO a block, since
                    a blocked user's profile is no longer reachable. */}
                {!isCharacter ? <BlockedUsersRow /> : null}
                {/* Password (change, or first-time set for Google-only
                    accounts). Master-only — a password is account-level, not
                    per-character. Always shown so a password user can change it
                    even when Google sign-in is off. */}
                {!isCharacter ? <PasswordRow /> : null}
                {/* Connected accounts (Google sign-in). Master-only, an
                    OAuth link is account-level, not per-character. Renders
                    nothing when the admin hasn't enabled Google sign-in so
                    it doesn't tease a switch that can't be used. */}
                {!isCharacter ? <ConnectedAccountsRow /> : null}
              </div>
            ) : null}

            {/* LINKS, profile-link chips, edited via the existing
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

            {/* GALLERY, portrait gallery, available for both
                character and master/OOC profiles. Scope is picked
                from the active target and threaded through to the
                editor; the gallery component itself doesn't care
                which endpoint backs it. */}
            {activeTab === "gallery" ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <PortraitGalleryEditor
                  scope={
                    target.kind === "character"
                      ? { kind: "character", characterId: target.id }
                      : { kind: "master" }
                  }
                  portraits={portraits}
                  onChange={setPortraits}
                />
              </div>
            ) : null}

            {/* JOURNAL, character journal entries (character only). */}
            {activeTab === "journal" && isCharacter && target.kind === "character" ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <JournalEditor characterId={target.id} />
              </div>
            ) : null}

            {/* FLAIR, profile-customization flairs (visitor counter +
                quote marquee). Self-contained: handles its own fetch,
                ownership gating, and saves against `/me/profile-flair`. */}
            {activeTab === "flair" ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <ProfileFlairEditor characterId={isCharacter && target.kind === "character" ? target.id : null} />
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
            {savedFlash ? t("saved") : ""}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPreviewing(true)}
              disabled={loadingTarget || !previewProfile}
              title={t("editor.footer.viewProfileTitle")}
              className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm disabled:opacity-50 hover:bg-keep-banner"
            >
              {t("editor.footer.viewProfile")}
            </button>
            <button
              type="button"
              onClick={onClose}
              // Cancel = neutral, muted. Save = primary, action-color
              // tint. The two are visually distinct so a fast click
              // doesn't accidentally discard unsaved edits, the
              // accent on Save reads as the "go" button at a glance.
              className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm text-keep-muted hover:bg-keep-banner hover:text-keep-text"
            >
              {t("common:cancel")}
            </button>
            <button
              type="submit"
              data-tour="profile-save"
              disabled={saving || loadingTarget}
              className="keep-button rounded border border-keep-action bg-keep-action/15 px-4 py-1 text-sm font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              {saving ? t("common:savingDots") : t("common:save")}
            </button>
          </div>
        </div>
      </form>
      {previewing && previewProfile ? (
        // stopPropagation so clicking the preview backdrop (which closes the
        // preview) doesn't bubble to the editor's backdrop and close that too.
        // zIndex must beat the editor underneath us. The editor sits at 50
        // (or 60 in admin-edit mode), so the preview goes one tier higher
        //, without this the preview opened UNDER the editor and was
        // invisible. Modal portals to <body> in both cases, so these
        // z-index values compete in a single sibling stacking context.
        <div onClick={(e) => e.stopPropagation()}>
          <ProfileModal
            profile={previewProfile}
            onClose={() => setPreviewing(false)}
            zIndex={isAdminEdit ? 70 : 60}
          />
        </div>
      ) : null}
      {createOpen ? (
        <div onClick={(e) => e.stopPropagation()}>
          <CreateCharacterModal<CharacterRow>
            onCancel={() => setCreateOpen(false)}
            onCreated={(c) => {
              setCharacters((prev) => [...prev, c]);
              setTarget({ kind: "character", id: c.id });
              // Drop the user onto the description tab so they can start
              // writing immediately, most of the other tabs are empty
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
 * Multi-portrait gallery management UI for character targets. Add by URL,
 * label, delete. Reordering deferred, most galleries are small and the
 * primary avatarUrl already drives the hero/userlist icon.
 *
 * Each mutation hits the server immediately so the gallery stays consistent
 * with what others see, no "save" button per portrait.
 */
/**
 * Gallery scope drives the REST endpoint shape:
 *   { kind: "character", characterId } → /characters/:id/portraits
 *   { kind: "master" }                 → /me/portraits
 * Both shapes return + accept the same per-portrait body, so the
 * component logic is identical apart from the URL builder.
 */
type GalleryScope =
  | { kind: "character"; characterId: string }
  | { kind: "master" };

function portraitListUrl(scope: GalleryScope): string {
  return scope.kind === "character"
    ? `/characters/${scope.characterId}/portraits`
    : `/me/portraits`;
}
function portraitItemUrl(scope: GalleryScope, id: string): string {
  return scope.kind === "character"
    ? `/characters/${scope.characterId}/portraits/${id}`
    : `/me/portraits/${id}`;
}

/** Cap mirrors the server's PORTRAIT_CAP_PER_CHARACTER (currently 20).
 *  Bumped from 12 alongside the editor rewrite. The server still
 *  enforces the limit on POST; the client just gates the
 *  spawn-new-draft logic so the UI doesn't dangle an empty slot
 *  past the cap. */
const PORTRAIT_GALLERY_CAP = 20;

/** Image-load lifecycle for the live-preview card. Tracked per URL
 *  so cards sharing a URL share a single load attempt. */
type ImgStatus = "loading" | "loaded" | "error";

/**
 * Card-based portrait gallery editor.
 *
 * Each saved portrait renders as a card with a live image preview,
 * editable URL / label / NSFW fields, drag-and-drop reorder (with
 * touch-friendly up/down arrow buttons as a fallback that works the
 * same on every device), and a delete button. A trailing "new
 * portrait" draft card sits at the end of the list so adding more is
 * a single field-paste away, no separate "Add" mode toggle.
 *
 * Edits commit on blur: URL/label PATCH the existing row, or POST a
 * new row when the draft slot is filled. NSFW toggles immediately.
 * Reorders fire one PATCH per row whose sort_order changed (parallel
 * via Promise.all) which is fine at the 20-card cap.
 *
 * Live image preview uses native `<img onLoad/onError>` so a broken
 * URL or a server that blocks hotlinking (returns 4xx or an error
 * image) surfaces a warning right there in the card instead of only
 * showing the badness after save + reload.
 */
function PortraitGalleryEditor({
  scope,
  portraits,
  onChange,
}: {
  scope: GalleryScope;
  portraits: CharacterPortrait[];
  onChange: (next: CharacterPortrait[]) => void;
}) {
  const { t } = useTranslation("profile");
  const [err, setErr] = useState<string | null>(null);
  // Draft slot, the trailing empty card. Captured here (not inside
  // the card itself) so it survives if portraits prop refetches.
  const [draftUrl, setDraftUrl] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftNsfw, setDraftNsfw] = useState(false);
  // Card under active HTML5 drag, for drop-target affordance.
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Image-load state map keyed by URL so toggling a card's URL
  // re-runs the preview check without sharing state with the
  // previous URL. Cleared opportunistically as portraits change.
  const [imgStatus, setImgStatus] = useState<Record<string, ImgStatus>>({});
  function markImg(url: string, status: ImgStatus) {
    setImgStatus((prev) => (prev[url] === status ? prev : { ...prev, [url]: status }));
  }

  async function saveField(
    id: string,
    field: "url" | "label" | "nsfw",
    value: string | boolean | null,
  ): Promise<void> {
    try {
      const res = await fetch(portraitItemUrl(scope, id), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onChange(portraits.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
      setErr(null);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("errors.saveFailed"));
    }
  }

  async function remove(id: string) {
    if (!window.confirm(t("editor.gallery.removeConfirm"))) return;
    try {
      const res = await fetch(portraitItemUrl(scope, id), {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      onChange(portraits.filter((p) => p.id !== id));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("errors.deleteFailed"));
    }
  }

  /** Commit the draft slot's URL: POST a new portrait, clear the
   *  draft inputs so the spawned card stops showing them, and let
   *  the parent's portraits prop reflect the new row. Caller passes
   *  the trimmed url so we don't re-compute it. */
  async function commitDraft(u: string) {
    if (!u || portraits.length >= PORTRAIT_GALLERY_CAP) return;
    try {
      const res = await fetch(portraitListUrl(scope), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: u,
          ...(draftLabel.trim() ? { label: draftLabel.trim() } : {}),
          ...(draftNsfw ? { nsfw: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const row = (await res.json()) as { id: string; url: string; label: string | null; nsfw: boolean };
      onChange([...portraits, { id: row.id, url: row.url, label: row.label, nsfw: !!row.nsfw }]);
      setDraftUrl("");
      setDraftLabel("");
      setDraftNsfw(false);
      setErr(null);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("errors.addFailed"));
    }
  }

  /** Move card at index `from` to index `to`. PATCHes every card
   *  whose final index changed (set sort_order = new index). The
   *  server orders by sort_order so a dense 0..N-1 assignment is
   *  always the cheapest correct reshuffle. */
  async function reorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= portraits.length || to >= portraits.length) return;
    const next = portraits.slice();
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    onChange(next);
    // PATCH every card whose new index differs from its OLD position
    // (i.e. its array position pre-reorder). Parallel because the
    // cap is small. We DON'T have the old positions cleanly here;
    // simplest correct approach: PATCH all of them. At cap=20 that's
    // 20 small JSON requests. Fast enough; not worth optimizing.
    try {
      await Promise.all(
        next.map((p, i) =>
          fetch(portraitItemUrl(scope, p.id), {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sortOrder: i }),
          }),
        ),
      );
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("errors.reorderFailed"));
    }
  }

  const showDraft = portraits.length < PORTRAIT_GALLERY_CAP;

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.tabs.gallery")}</legend>
      <p className="mb-3 text-[10px] text-keep-muted">
        {t("editor.gallery.hint", { max: PORTRAIT_GALLERY_CAP })}
      </p>
      {err ? (
        <div className="mb-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-[11px] text-keep-accent">
          {err}
        </div>
      ) : null}
      <div className="space-y-2">
        {portraits.map((p, idx) => (
          <PortraitCard
            key={p.id}
            portrait={p}
            index={idx}
            total={portraits.length}
            dragging={draggingId === p.id}
            imgStatus={imgStatus[p.url] ?? "loading"}
            onMarkImg={markImg}
            onDragStart={() => setDraggingId(p.id)}
            onDragEnd={() => setDraggingId(null)}
            onDropOnto={(fromId) => {
              const from = portraits.findIndex((q) => q.id === fromId);
              const to = idx;
              void reorder(from, to);
            }}
            onMoveUp={() => void reorder(idx, idx - 1)}
            onMoveDown={() => void reorder(idx, idx + 1)}
            onSaveUrl={(u) => void saveField(p.id, "url", u)}
            onSaveLabel={(l) => void saveField(p.id, "label", l || null)}
            onToggleNsfw={() => void saveField(p.id, "nsfw", !p.nsfw)}
            onDelete={() => void remove(p.id)}
          />
        ))}
        {showDraft ? (
          <DraftPortraitCard
            url={draftUrl}
            label={draftLabel}
            nsfw={draftNsfw}
            onUrlChange={setDraftUrl}
            onLabelChange={setDraftLabel}
            onNsfwToggle={() => setDraftNsfw((v) => !v)}
            onCommit={() => void commitDraft(draftUrl.trim())}
            imgStatus={draftUrl.trim() ? (imgStatus[draftUrl.trim()] ?? "loading") : null}
            onMarkImg={markImg}
          />
        ) : (
          <p className="text-[11px] italic text-keep-muted">
            {t("editor.gallery.full", { max: PORTRAIT_GALLERY_CAP })}
          </p>
        )}
      </div>
    </fieldset>
  );
}

/**
 * Renders its children only for accounts 18 or older (age plan Phase 1).
 * Wraps the NSFW-flag checkboxes so under-18 accounts never see a control
 * the server would refuse. Cosmetic mirror only, the write routes reject
 * the flag regardless. `viewerAge` defaults adult before /me/profile
 * seeds it, so adult editors never get a flash of missing controls.
 */
function MinorSafe({ children }: { children: ReactNode }) {
  const viewerIsAdult = useChat((s) => s.viewerAge.isAdult);
  return viewerIsAdult ? <>{children}</> : null;
}

/** Single saved-portrait card with live preview + edit fields +
 *  drag/reorder controls. Pure presentation, every mutation goes
 *  through callbacks so the parent owns the transactional state. */
function PortraitCard({
  portrait,
  index,
  total,
  dragging,
  imgStatus,
  onMarkImg,
  onDragStart,
  onDragEnd,
  onDropOnto,
  onMoveUp,
  onMoveDown,
  onSaveUrl,
  onSaveLabel,
  onToggleNsfw,
  onDelete,
}: {
  portrait: CharacterPortrait;
  index: number;
  total: number;
  dragging: boolean;
  imgStatus: ImgStatus;
  onMarkImg: (url: string, status: ImgStatus) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOnto: (fromId: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSaveUrl: (next: string) => void;
  onSaveLabel: (next: string) => void;
  onToggleNsfw: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("profile");
  // Local edit buffers, values commit to the parent (and the
  // server) on blur. This keeps every keystroke from PATCHing,
  // which would be wasteful AND would race when the user is
  // mid-edit and a refetch overwrites their buffer.
  const [urlBuf, setUrlBuf] = useState(portrait.url);
  const [labelBuf, setLabelBuf] = useState(portrait.label ?? "");
  // Sync buffers if the prop changes (parent refetch after save).
  useEffect(() => { setUrlBuf(portrait.url); }, [portrait.url]);
  useEffect(() => { setLabelBuf(portrait.label ?? ""); }, [portrait.label]);
  const [dropHover, setDropHover] = useState(false);

  return (
    <div
      draggable
      onDragStart={(e) => {
        // Dragged payload IS the portrait id, drop targets read it
        // to compute the from-index.
        e.dataTransfer.setData("text/portrait-id", portrait.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!dropHover) setDropHover(true);
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropHover(false);
        const fromId = e.dataTransfer.getData("text/portrait-id");
        if (fromId && fromId !== portrait.id) onDropOnto(fromId);
      }}
      className={`flex items-stretch gap-2 rounded border bg-keep-bg/30 p-2 transition ${
        dragging ? "opacity-40" : ""
      } ${dropHover ? "border-keep-action ring-1 ring-keep-action" : "border-keep-rule"}`}
    >
      {/* Live preview tile. Loading state shows the URL muted; error
          shows a "won't load" warning so the user knows the
          host probably blocks hotlinking. */}
      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded border border-keep-rule bg-keep-banner/40">
        {imgStatus !== "error" ? (
          <img
            src={portrait.url}
            alt={portrait.label ?? t("editor.gallery.portraitAltFallback")}
            referrerPolicy="no-referrer"
            onLoad={() => onMarkImg(portrait.url, "loaded")}
            onError={() => onMarkImg(portrait.url, "error")}
            className={`h-full w-full object-cover ${portrait.nsfw ? "blur-md scale-105" : ""}`}
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-center text-[9px] uppercase tracking-widest text-keep-accent">
            {t("editor.gallery.wontLoad")}
          </div>
        )}
      </div>

      {/* Editable fields stack to the right of the preview. */}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-1">
          <span
            aria-hidden
            className="cursor-grab select-none px-1 text-keep-muted active:cursor-grabbing"
            title={t("editor.gallery.dragToReorder")}
          >
            ⠿
          </span>
          <input
            type="text"
            value={urlBuf}
            onChange={(e) => setUrlBuf(e.target.value)}
            onBlur={() => {
              const u = urlBuf.trim();
              if (u && u !== portrait.url) onSaveUrl(u);
              else if (!u) setUrlBuf(portrait.url); // empty = revert; deletion uses the ✕ button
            }}
            placeholder={t("editor.profileTab.imageUrlPlaceholder")}
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 font-mono text-[11px] outline-none focus:border-keep-action"
          />
          {/* Up / Down / Delete, universal so touch users have a
              real reorder path even when HTML5 drag doesn't fire on
              their device. */}
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            title={t("editor.gallery.moveUp")}
            aria-label={t("editor.gallery.moveUp")}
            className="rounded border border-keep-rule bg-keep-bg px-1 text-keep-muted hover:bg-keep-banner disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index >= total - 1}
            title={t("editor.gallery.moveDown")}
            aria-label={t("editor.gallery.moveDown")}
            className="rounded border border-keep-rule bg-keep-bg px-1 text-keep-muted hover:bg-keep-banner disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onDelete}
            title={t("editor.gallery.removePortrait")}
            aria-label={t("editor.gallery.removePortrait")}
            className="rounded border border-keep-rule bg-keep-bg px-1 text-keep-accent hover:bg-keep-accent/10"
          >
            ✕
          </button>
        </div>
        <input
          type="text"
          value={labelBuf}
          onChange={(e) => setLabelBuf(e.target.value)}
          onBlur={() => {
            const next = labelBuf.trim();
            const cur = portrait.label ?? "";
            if (next !== cur) onSaveLabel(next);
          }}
          placeholder={t("editor.gallery.labelPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-0.5 outline-none focus:border-keep-action"
        />
        {/* Per-tile 18+ flag is an adult-only write (age plan Phase 1);
            hide the checkbox for under-18 accounts so they never see a
            control the server would refuse. A mod-marked NSFW tile still
            shows its blurred preview + label/URL editing either way. */}
        <MinorSafe>
          <label className="flex items-center gap-1 text-[11px] text-keep-muted">
            <input
              type="checkbox"
              checked={portrait.nsfw}
              onChange={onToggleNsfw}
              className="h-3 w-3"
            />
            <span>{t("editor.gallery.nsfwLabel")}</span>
          </label>
        </MinorSafe>
        {imgStatus === "error" ? (
          <p className="text-[10px] text-keep-accent">
            {t("editor.gallery.imgError")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Trailing draft card. Same visual layout as a saved card but
 *  with no server id yet, committing the URL POSTs it and
 *  promotes it to a real portrait. */
function DraftPortraitCard({
  url,
  label,
  nsfw,
  onUrlChange,
  onLabelChange,
  onNsfwToggle,
  onCommit,
  imgStatus,
  onMarkImg,
}: {
  url: string;
  label: string;
  nsfw: boolean;
  onUrlChange: (next: string) => void;
  onLabelChange: (next: string) => void;
  onNsfwToggle: () => void;
  onCommit: () => void;
  imgStatus: ImgStatus | null;
  onMarkImg: (url: string, status: ImgStatus) => void;
}) {
  const { t } = useTranslation("profile");
  const trimmed = url.trim();
  // Commit-on-card-exit, not commit-on-url-blur: if we POST the
  // moment URL loses focus, the draft card unmounts mid-typing
  // when the user tabs to the label or NSFW. So we listen on the
  // card wrapper and only commit when focus has actually left the
  // entire card (relatedTarget is outside), letting URL/Label/NSFW
  // edits all happen inside the draft before promoting it.
  return (
    <div
      onBlur={(e) => {
        if (!trimmed) return;
        const next = e.relatedTarget as Node | null;
        if (next && e.currentTarget.contains(next)) return;
        onCommit();
      }}
      className="flex items-stretch gap-2 rounded border border-dashed border-keep-rule bg-keep-bg/20 p-2"
    >
      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded border border-keep-rule/60 bg-keep-banner/30">
        {trimmed && imgStatus !== "error" ? (
          <img
            src={trimmed}
            alt=""
            referrerPolicy="no-referrer"
            onLoad={() => onMarkImg(trimmed, "loaded")}
            onError={() => onMarkImg(trimmed, "error")}
            className={`h-full w-full object-cover ${nsfw ? "blur-md scale-105" : ""}`}
          />
        ) : trimmed && imgStatus === "error" ? (
          <div className="grid h-full w-full place-items-center text-center text-[9px] uppercase tracking-widest text-keep-accent">
            {t("editor.gallery.wontLoad")}
          </div>
        ) : (
          <div className="grid h-full w-full place-items-center text-center text-[9px] uppercase tracking-widest text-keep-muted/60">
            {t("editor.gallery.previewPlaceholder")}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <input
          type="text"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (trimmed) onCommit(); } }}
          placeholder={t("editor.gallery.draftUrlPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-0.5 font-mono text-[11px] outline-none focus:border-keep-action"
        />
        <input
          type="text"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder={t("editor.gallery.draftLabelPlaceholder")}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-0.5 outline-none focus:border-keep-action"
        />
        {/* Same adult-only rule as the saved-card checkbox above. */}
        <MinorSafe>
          <label className="flex items-center gap-1 text-[11px] text-keep-muted">
            <input
              type="checkbox"
              checked={nsfw}
              onChange={onNsfwToggle}
              className="h-3 w-3"
            />
            <span>{t("modal.gallery.nsfw")}</span>
          </label>
        </MinorSafe>
        {trimmed && imgStatus === "error" ? (
          <p className="text-[10px] text-keep-accent">
            {t("editor.gallery.draftImgError")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ============================================================
 *  LinksEditor, owner-set external links rendered as styled
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
  const { t } = useTranslation("profile");
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

  // Triggered by the inline "Add" button. NOT a form submit handler,
  // the surrounding ProfileEditor is itself a <form onSubmit={save}>, and
  // an inner <form> nested inside it is invalid HTML. Browsers route
  // submit events from an inner form's button up to whichever ancestor
  // form the DOM commits to, which used to fire the outer profile save
  // instead of this handler, links never POSTed, the outer save ran,
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
      setErr(e2 instanceof Error ? e2.message : t("errors.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm(t("editor.links.removeConfirm"))) return;
    try {
      const res = await fetch(`${linksEndpoint(scope)}/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res));
      onChange(links.filter((l) => l.id !== id));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("errors.deleteFailed"));
    }
  }

  const atCap = links.length >= LINKS_CAP;

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.links.legend")}</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {t("editor.links.hint", { max: LINKS_CAP })}
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
                title={t("editor.links.removeLink")}
                aria-label={t("editor.links.removeLink")}
                className="shrink-0 rounded border border-keep-accent/50 bg-keep-bg px-1.5 py-0 text-[10px] text-keep-accent hover:bg-keep-accent/10"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-2 italic text-keep-muted">{t("editor.links.empty")}</p>
      )}
      {adding ? (
        <div className="space-y-1">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("editor.links.titlePlaceholder")}
            maxLength={60}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
          />
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("editor.links.urlPlaceholder")}
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
            <span>{t("editor.links.customizeColors")}</span>
          </label>
          {customColors ? (
            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col text-[10px] text-keep-muted">
                <span className="uppercase tracking-widest">{t("editor.links.border")}</span>
                <input type="color" value={borderColor} onChange={(e) => setBorderColor(e.target.value)} className="h-6 w-full rounded border border-keep-rule" />
              </label>
              <label className="flex flex-col text-[10px] text-keep-muted">
                <span className="uppercase tracking-widest">{t("editor.links.background")}</span>
                <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="h-6 w-full rounded border border-keep-rule" />
              </label>
              <label className="flex flex-col text-[10px] text-keep-muted">
                <span className="uppercase tracking-widest">{t("editor.links.text")}</span>
                <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} className="h-6 w-full rounded border border-keep-rule" />
              </label>
            </div>
          ) : null}
          {customColors ? (
            <div className="mt-1 text-[10px] text-keep-muted">
              {t("editor.links.previewLabel")}{" "}
              <span
                className="inline-block rounded border px-1.5 py-0.5 text-[11px]"
                style={{ borderColor, backgroundColor: bgColor, color: textColor }}
              >
                {title.trim() || t("editor.links.sampleLink")}
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
              {t("common:cancel")}
            </button>
            <button
              type="button"
              onClick={() => { void add(); }}
              disabled={busy || !title.trim() || !url.trim()}
              className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
            >
              {busy ? t("editor.links.adding") : t("editor.links.add")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={atCap}
          title={atCap ? t("editor.links.limitTitle", { max: LINKS_CAP }) : undefined}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
        >
          {t("editor.links.addLink")}
        </button>
      )}
    </fieldset>
  );
}

/**
 * AvatarCropPicker, drag-to-pan + zoom slider over a square preview.
 *
 * Layout: a square crop window (192px) holds a circle-mask overlay
 * showing exactly what the avatar will look like once saved. The
 * source image fills the square via `object-fit: cover` and is
 * positioned with the same `object-position` + `transform-origin`
 * coupling the renderer uses, so what the picker shows is what the
 * profile will show.
 *
 * Dragging inside the window moves the focal point. Movement is
 * converted from pixel delta to percent delta against the source's
 * natural dimensions (read after the image loads), accounting for the
 * fact that `object-fit: cover` already crops some of the source, we
 * only let the user pan within the "hidden" overflow region.
 *
 * Zoom is a 1..MAX slider. Both axes are clamped via the shared
 * `clampAvatarCrop` helper so a wild numeric input can't desync the
 * picker from the renderer.
 *
 * No-URL state: when the URL field is empty the picker renders a
 * muted placeholder explaining that a Main Profile Image URL is
 * required. Saves still work, they ship the current crop value but
 * it has no visual effect until an avatar URL exists.
 */
function AvatarCropPicker({
  url,
  crop,
  onChange,
}: {
  url: string;
  crop: AvatarCrop;
  onChange: (next: AvatarCrop) => void;
}) {
  const { t } = useTranslation("profile");
  const trimmed = url.trim();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<{ startX: number; startY: number; baseOffsetX: number; baseOffsetY: number } | null>(null);
  const [imgError, setImgError] = useState(false);
  // Reset error state when the URL changes so the user gets a clean
  // attempt instead of a stuck "broken" placeholder after editing.
  useEffect(() => { setImgError(false); }, [trimmed]);

  function applyClamp(next: Partial<AvatarCrop>) {
    onChange(clampAvatarCrop({ ...crop, ...next }));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!trimmed || imgError) return;
    const el = containerRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    draggingRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseOffsetX: crop.offsetX,
      baseOffsetY: crop.offsetY,
    };
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = draggingRef.current;
    const el = containerRef.current;
    if (!drag || !el) return;
    const rect = el.getBoundingClientRect();
    // Convert pixel delta to percent delta on the source image. We
    // approximate by treating the container as the source's
    // shorter-axis projection, for the 192px square preview this
    // gives a comfortable 1:1 drag feel. Dividing by zoom keeps the
    // pan rate consistent when zoomed in (a small pixel drag moves
    // the focal point a smaller percent when the image is bigger).
    const dxPct = ((e.clientX - drag.startX) / rect.width) * 100 / crop.zoom;
    const dyPct = ((e.clientY - drag.startY) / rect.height) * 100 / crop.zoom;
    applyClamp({
      offsetX: drag.baseOffsetX - dxPct,
      offsetY: drag.baseOffsetY - dyPct,
    });
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = null;
    const el = containerRef.current;
    if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  const showsCrop = !!trimmed && !imgError;
  const imgStyle: React.CSSProperties = {
    objectPosition: `${crop.offsetX}% ${crop.offsetY}%`,
    transform: `scale(${crop.zoom})`,
    transformOrigin: `${crop.offsetX}% ${crop.offsetY}%`,
  };

  return (
    <div className="space-y-1">
      <span className="block text-xs uppercase tracking-widest text-keep-muted">
        {t("editor.crop.title")}
      </span>
      {/* Tight column constrained to the preview's width so the zoom
          slider and reset button stack neatly below the circle without
          stretching across the whole form. */}
      <div className="inline-flex flex-col items-stretch gap-2" style={{ width: 192 }}>
        <div
          ref={containerRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="relative h-48 w-48 select-none overflow-hidden rounded-full border border-keep-rule bg-keep-banner"
          style={{
            touchAction: "none",
            cursor: showsCrop ? (draggingRef.current ? "grabbing" : "grab") : "default",
          }}
        >
          {showsCrop ? (
            <>
              <img
                src={trimmed}
                alt=""
                draggable={false}
                onError={() => setImgError(true)}
                className="pointer-events-none h-full w-full object-cover"
                style={imgStyle}
              />
              {/* Pan affordance, small four-way arrows badge that
                  hovers in the bottom-center of the circle so users
                  who don't read tooltips still see "this is draggable."
                  Fades on grab so it doesn't compete with the photo
                  while you're moving things around. */}
              <span
                aria-hidden
                className={`pointer-events-none absolute inset-x-0 bottom-2 flex justify-center transition-opacity ${
                  draggingRef.current ? "opacity-0" : "opacity-90"
                }`}
              >
                <span className="inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-white shadow-sm">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 9l-3 3 3 3" />
                    <path d="M9 5l3-3 3 3" />
                    <path d="M15 19l-3 3-3-3" />
                    <path d="M19 9l3 3-3 3" />
                    <path d="M2 12h20" />
                    <path d="M12 2v20" />
                  </svg>
                  {t("editor.crop.dragToPan")}
                </span>
              </span>
            </>
          ) : (
            <div className="flex h-full w-full items-center justify-center px-3 text-center text-[11px] italic text-keep-muted">
              {trimmed && imgError
                ? t("editor.crop.loadError")
                : t("editor.crop.needUrl")}
            </div>
          )}
        </div>
        {/* Zoom slider directly under the preview, same width. */}
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">
          <span className="flex items-baseline justify-between">
            <span>{t("editor.crop.zoom")}</span>
            <span className="normal-case tracking-normal text-keep-muted">{t("editor.crop.zoomValue", { value: crop.zoom.toFixed(2) })}</span>
          </span>
          <input
            type="range"
            min={AVATAR_CROP_MIN_ZOOM}
            max={AVATAR_CROP_MAX_ZOOM}
            step={0.05}
            value={crop.zoom}
            disabled={!showsCrop}
            onChange={(e) => applyClamp({ zoom: Number.parseFloat(e.target.value) })}
            className="mt-1 block w-full accent-keep-action"
          />
        </label>
        <button
          type="button"
          onClick={() => onChange({ ...AVATAR_CROP_DEFAULTS })}
          disabled={!showsCrop || isDefaultAvatarCrop(crop)}
          className="self-start rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-banner disabled:opacity-50"
          title={t("editor.crop.resetTitle")}
        >
          {t("editor.crop.reset")}
        </button>
      </div>
    </div>
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
 *   - `master` , null = system default. This is the OOC color and the
 *                 fallback every character without its own override
 *                 inherits.
 *   - `character`, null = inherit the master color. Setting a hex
 *                 makes this character's messages render in that color
 *                 regardless of the tab's `/color` state, which is the
 *                 whole reason the per-character column exists (so
 *                 Character A and Character B stay visually distinct
 *                 even after a `/char switch`).
 *
 * The "Use OOC color" / "Use system default" button writes null rather
 * than a hex so the inheritance chain stays intact, clearing to a
 * literal "#000000" would freeze the inheritance even when the upstream
 * color changes later.
 */
/**
 * Flip a single field's visibility flag on a stats object. Undefined
 * (default = show) and explicit `true` both round-trip to `false`; an
 * existing `false` round-trips back to undefined so the saved blob
 * doesn't accumulate redundant `: true` entries on every flip. The
 * field stays in the stats blob regardless, visibility only affects
 * the rendered profile, not the persisted value.
 */
function toggleVisibility(stats: CharacterStats, key: keyof CharacterStatsVisibility): CharacterStats {
  const current = stats.visibility?.[key];
  const next: CharacterStatsVisibility = { ...stats.visibility };
  if (current === false) delete next[key];
  else next[key] = false;
  // exactOptionalPropertyTypes: drop the key entirely when there are no
  // active overrides instead of assigning undefined, so the saved blob
  // doesn't carry an empty `visibility: {}` object.
  const { visibility: _, ...rest } = stats;
  void _;
  return Object.keys(next).length > 0 ? { ...rest, visibility: next } : rest;
}

/**
 * Tiny eye / eye-slash button used inline next to a stats field label.
 * Pure cosmetic affordance, the actual visibility toggling is owned
 * by the parent's `onToggle` so the button stays stateless and
 * reusable across all the editor sections that want a show/hide
 * indicator (classic fields, the Vibe section header, the Attributes
 * section header).
 */
function VisibilityToggle({
  hidden,
  onToggle,
  label,
}: {
  hidden: boolean;
  onToggle: () => void;
  label: string;
}) {
  const { t } = useTranslation("profile");
  return (
    <button
      type="button"
      onClick={onToggle}
      title={hidden ? t("editor.visibilityToggle.showTitle", { label }) : t("editor.visibilityToggle.hideTitle", { label })}
      aria-label={hidden ? t("editor.visibilityToggle.showAria", { label }) : t("editor.visibilityToggle.hideAria", { label })}
      className={`shrink-0 rounded px-1 text-[11px] leading-none transition-colors ${
        hidden
          ? "text-keep-muted/50 hover:text-keep-action"
          : "text-keep-action hover:text-keep-muted"
      }`}
    >
      {hidden ? "🙈" : "👁"}
    </button>
  );
}

/**
 * Vibe-axes editor, eight bipolar 0..100 sliders that paint the
 * "what kind of character is this at a glance" read. Each axis can
 * be UNSET (null), in which case it doesn't render on the profile;
 * the editor still shows the slider with a "Not set, drag to set"
 * label so the owner can opt the axis in.
 *
 * Distinct from World vibe axes (magnitude); each end of the axis
 * has its own label and the dot sits between them. Section-level
 * visibility toggle lives in the legend so the owner can hide the
 * whole vibe block without clearing each axis individually.
 */
function VibeAxesEditor({
  stats,
  onChange,
}: {
  stats: CharacterStats;
  onChange: (next: CharacterStats | ((prev: CharacterStats) => CharacterStats)) => void;
}) {
  const { t } = useTranslation("profile");
  const sectionHidden = stats.visibility?.vibe === false;
  function setAxis(key: CharacterVibeAxisKey, value: number | null) {
    onChange((prev) => {
      const nextVibe = { ...(prev.vibe ?? {}) };
      if (value === null) delete nextVibe[key];
      else nextVibe[key] = value;
      const { vibe: _, ...rest } = prev;
      void _;
      return Object.keys(nextVibe).length > 0 ? { ...rest, vibe: nextVibe } : rest;
    });
  }
  return (
    <fieldset className="rounded border border-keep-rule p-3">
      <legend className="flex items-center gap-2 px-1 text-xs uppercase tracking-widest text-keep-muted">
        {t("modal.sections.disposition")}
        <VisibilityToggle
          hidden={sectionHidden}
          onToggle={() => onChange((s) => toggleVisibility(s, "vibe"))}
          label={t("modal.sections.disposition")}
        />
      </legend>
      <p className="mb-3 text-[10px] text-keep-muted">
        {t("editor.vibe.hint")}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CHARACTER_VIBE_AXES.map((axis) => {
          const value = stats.vibe?.[axis.key] ?? null;
          const isSet = value !== null;
          return (
            <div key={axis.key} className="rounded border border-keep-rule/40 bg-keep-banner/20 p-2">
              <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
                <span className="font-semibold text-keep-text">{t(`vibe.${axis.key}.low`)}</span>
                <span className="text-keep-muted">{isSet ? `${value}` : t("editor.vibe.notSet")}</span>
                <span className="font-semibold text-keep-text">{t(`vibe.${axis.key}.high`)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={isSet ? (value as number) : 50}
                onChange={(e) => setAxis(axis.key, parseInt(e.target.value, 10))}
                className="w-full"
                aria-label={t("editor.vibe.rangeAria", { low: t(`vibe.${axis.key}.low`), high: t(`vibe.${axis.key}.high`) })}
              />
              {isSet ? (
                <button
                  type="button"
                  onClick={() => setAxis(axis.key, null)}
                  className="mt-1 text-[10px] text-keep-muted hover:text-keep-accent"
                >
                  {t("editor.vibe.clearAxis")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setAxis(axis.key, 50)}
                  className="mt-1 text-[10px] text-keep-muted hover:text-keep-action"
                >
                  {t("editor.vibe.setAxis")}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Attributes editor, a freeform numeric stat block. Each row is a
 * label + value + per-row min/max bounds so a D&D-style "STR 14"
 * (min 1, max 20) and an HP gauge (min 0, max whatever) can coexist
 * on the same character without sharing scales.
 *
 * Server caps the array at {@link CHARACTER_ATTRIBUTES_MAX}; the
 * Add button disables when that ceiling is reached. Row id is a
 * stable client-side `nanoid`-ish key so React doesn't thrash on
 * reorder; the server preserves whatever shape the client sent.
 */
function AttributesEditor({
  stats,
  onChange,
}: {
  stats: CharacterStats;
  onChange: (next: CharacterStats | ((prev: CharacterStats) => CharacterStats)) => void;
}) {
  const { t } = useTranslation("profile");
  const sectionHidden = stats.visibility?.attributes === false;
  const rows = stats.attributes ?? [];
  const canAdd = rows.length < CHARACTER_ATTRIBUTES_MAX;
  function update(idx: number, patch: Partial<CharacterAttribute>) {
    // Mid-typing path: apply the patch verbatim, no cross-field
    // clamp. Auto-clamping on every keystroke produced surprising
    // state when a user typed "55" intending "550", the "55"
    // cascade dragged value+max along with min and the next digit
    // landed on the cascaded state instead of the original. The
    // clamp now runs on blur (see `clampRow` below) and again on
    // save (`sanitizeAttributesForSave`), so the smooth-typing UX
    // doesn't sacrifice the "save body is always server-valid"
    // contract.
    onChange((prev) => {
      const next = [...(prev.attributes ?? [])];
      const row = next[idx];
      if (!row) return prev;
      next[idx] = { ...row, ...patch };
      return { ...prev, attributes: next };
    });
  }
  // Field-leave path: snap any cross-field inconsistency the user
  // typed (min > max, value outside [min, max]) into a stable
  // configuration. Same three-step resolution `update` used to run
  // on every keystroke, but bound to onBlur so it doesn't interrupt
  // typing. Idempotent on rows that are already valid.
  function clampRow(idx: number) {
    onChange((prev) => {
      const cur = prev.attributes ?? [];
      const row = cur[idx];
      if (!row) return prev;
      const next = [...cur];
      const merged = { ...row };
      if (merged.min > merged.max) merged.max = merged.min;
      if (merged.value < merged.min) merged.value = merged.min;
      if (merged.value > merged.max) merged.value = merged.max;
      // Skip the state write entirely when nothing moved, keeps
      // useless re-renders out of the tree.
      if (
        merged.min === row.min &&
        merged.max === row.max &&
        merged.value === row.value
      ) {
        return prev;
      }
      next[idx] = merged;
      return { ...prev, attributes: next };
    });
  }
  function remove(idx: number) {
    onChange((prev) => {
      const next = [...(prev.attributes ?? [])];
      next.splice(idx, 1);
      const { attributes: _, ...rest } = prev;
      void _;
      return next.length > 0 ? { ...rest, attributes: next } : rest;
    });
  }
  function reorder(idx: number, dir: -1 | 1) {
    // Pure swap with the neighbor in the requested direction. Out-of-
    // bounds (first row up, last row down) is a no-op; the buttons
    // disable at the ends so this guard is belt-and-suspenders.
    onChange((prev) => {
      const cur = prev.attributes ?? [];
      const target = idx + dir;
      if (target < 0 || target >= cur.length) return prev;
      const next = [...cur];
      const a = next[idx];
      const b = next[target];
      if (!a || !b) return prev;
      next[idx] = b;
      next[target] = a;
      return { ...prev, attributes: next };
    });
  }
  function add() {
    onChange((prev) => {
      const rows = prev.attributes ?? [];
      if (rows.length >= CHARACTER_ATTRIBUTES_MAX) return prev;
      const id = `attr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const next: CharacterAttribute = { id, label: "", value: 10, min: 0, max: 20 };
      return { ...prev, attributes: [...rows, next] };
    });
  }
  return (
    <fieldset className="rounded border border-keep-rule p-3">
      <legend className="flex items-center gap-2 px-1 text-xs uppercase tracking-widest text-keep-muted">
        {t("modal.sections.attributes")}
        <VisibilityToggle
          hidden={sectionHidden}
          onToggle={() => onChange((s) => toggleVisibility(s, "attributes"))}
          label={t("modal.sections.attributes")}
        />
      </legend>
      <p className="mb-3 text-[10px] text-keep-muted">
        {t("editor.attributes.hint")}
      </p>
      {rows.length === 0 ? (
        <p className="mb-2 text-[11px] italic text-keep-muted">
          {t("editor.attributes.empty")}
        </p>
      ) : (
        <ul className="mb-2 space-y-2">
          {rows.map((row, idx) => (
            <li
              key={row.id}
              className="grid grid-cols-[1fr_60px_60px_60px_auto] items-end gap-2 rounded border border-keep-rule/40 bg-keep-banner/20 p-2 text-[11px]"
            >
              <label className="block">
                <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.attributes.label")}</span>
                <input
                  type="text"
                  maxLength={CHARACTER_ATTRIBUTE_LABEL_MAX}
                  placeholder={t("editor.attributes.labelPlaceholder")}
                  value={row.label}
                  onChange={(e) => update(idx, { label: e.target.value })}
                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                />
              </label>
              <label className="block">
                <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.attributes.min")}</span>
                <input
                  type="number"
                  min={CHARACTER_ATTRIBUTE_VALUE_MIN}
                  max={CHARACTER_ATTRIBUTE_VALUE_MAX}
                  value={row.min}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isNaN(v)) return;
                    update(idx, { min: v });
                  }}
                  onBlur={() => clampRow(idx)}
                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                />
              </label>
              <label className="block">
                <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.attributes.value")}</span>
                <input
                  type="number"
                  min={row.min}
                  max={row.max}
                  value={row.value}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isNaN(v)) return;
                    update(idx, { value: v });
                  }}
                  onBlur={() => clampRow(idx)}
                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                />
              </label>
              <label className="block">
                <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("editor.attributes.max")}</span>
                <input
                  type="number"
                  min={CHARACTER_ATTRIBUTE_VALUE_MIN}
                  max={CHARACTER_ATTRIBUTE_VALUE_MAX}
                  value={row.max}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isNaN(v)) return;
                    update(idx, { max: v });
                  }}
                  onBlur={() => clampRow(idx)}
                  className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
                />
              </label>
              <div className="flex flex-col gap-1">
                {/* Up / down reorder. Disabled at the ends so the
                    layout is stable; mouse + keyboard can both move
                    a row. Tab-friendly: buttons are sequential next
                    to the row's fields. */}
                <div className="flex gap-0.5">
                  <button
                    type="button"
                    onClick={() => reorder(idx, -1)}
                    disabled={idx === 0}
                    title={t("editor.attributes.moveUpTitle")}
                    aria-label={t("editor.attributes.moveUpAria", { label: row.label || t("editor.attributes.rowFallback") })}
                    className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-[10px] text-keep-muted hover:bg-keep-banner hover:text-keep-text disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => reorder(idx, 1)}
                    disabled={idx === rows.length - 1}
                    title={t("editor.attributes.moveDownTitle")}
                    aria-label={t("editor.attributes.moveDownAria", { label: row.label || t("editor.attributes.rowFallback") })}
                    className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-[10px] text-keep-muted hover:bg-keep-banner hover:text-keep-text disabled:opacity-30"
                  >
                    ▼
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => remove(idx)}
                  title={t("editor.attributes.removeTitle")}
                  aria-label={t("editor.attributes.removeAria", { label: row.label || t("editor.attributes.rowFallback") })}
                  className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-keep-accent hover:bg-keep-accent/25"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={add}
        disabled={!canAdd}
        className="rounded border border-keep-action/40 bg-keep-action/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/25 disabled:opacity-40"
      >
        {t("editor.attributes.add")} {canAdd ? "" : t("editor.attributes.addMax", { max: CHARACTER_ATTRIBUTES_MAX })}
      </button>
    </fieldset>
  );
}

function ChatColorRow({
  scope,
  value,
  onChange,
}: {
  scope: "master" | "character";
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const { t } = useTranslation("profile");
  // Local mirror so an in-progress typed hex doesn't bubble up on every
  // keystroke and trigger downstream side effects (formDirty etc.).
  // Pushed up on blur or via the explicit "Set" button, the swatch
  // picker still commits on each pick, since that's a discrete choice.
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => { setDraft(value ?? ""); }, [value]);
  const isHex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(draft);

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.chatColor.legend")}</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {scope === "master"
          ? t("editor.chatColor.masterHint")
          : t("editor.chatColor.characterHint")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          value={value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#990000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded border border-keep-rule"
          aria-label={t("editor.chatColor.legend")}
        />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft === "") onChange(null);
            else if (isHex) onChange(draft);
          }}
          placeholder={scope === "master" ? t("editor.chatColor.defaultPlaceholder") : t("editor.chatColor.inheritPlaceholder")}
          maxLength={7}
          pattern="^#[0-9a-fA-F]{6}$"
          className="flex-1 min-w-[8rem] rounded border border-keep-rule px-2 py-1 font-mono"
        />
        <button
          type="button"
          onClick={() => onChange(null)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted hover:text-keep-text"
          title={scope === "master" ? t("editor.chatColor.useDefaultTitle") : t("editor.chatColor.inheritTitle")}
        >
          {scope === "master" ? t("editor.chatColor.useDefault") : t("editor.chatColor.inheritOoc")}
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span className="text-keep-muted">{t("editor.links.previewLabel")}</span>
        <span
          className="rounded bg-keep-banner/30 px-1.5 py-0.5"
          style={value ? { color: value } : undefined}
        >
          {t("editor.chatColor.sample")}
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
  const { t } = useTranslation("profile");
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
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.notifications.legend")}</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {t("editor.notifications.hint")}
      </p>
      <label className="flex items-center gap-2">
        <span className="w-20 uppercase tracking-widest text-keep-muted">{t("editor.notifications.notifyMe")}</span>
        <select
          value={pref}
          onChange={(e) => onChangePref(e.target.value as NotifyPref)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
        >
          <option value="off">{t("editor.notifications.off")}</option>
          <option value="mentions">{t("editor.notifications.mentions")}</option>
          <option value="all">{t("editor.notifications.all")}</option>
        </select>
      </label>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-keep-muted">
          {t("editor.notifications.permissionLabel")}{" "}
          <span className="font-mono">{supported ? perm : t("editor.notifications.unsupported")}</span>
        </span>
        {supported && perm === "default" ? (
          <button
            type="button"
            onClick={enable}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80"
          >
            {t("editor.enable")}
          </button>
        ) : supported && perm === "denied" ? (
          <span className="text-[10px] text-keep-accent">
            {t("editor.notifications.denied")}
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
 * settings, saved when the user clicks Save in the editor footer, not
 * on toggle.
 *
 * All four default on; users opt out of the noises they find
 * intrusive. The toggles take effect immediately on save thanks to the
 * Zustand store push in the parent's onSubmit, no need to reload the
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
  const { t } = useTranslation("profile");
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.sounds.legend")}</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {t("editor.sounds.hint")}
      </p>
      <label className="mb-1 flex items-start gap-2">
        <input
          type="checkbox"
          checked={dm}
          onChange={(e) => onChangeDm(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">{t("editor.sounds.dm")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.sounds.dmHint")}
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
          <span className="block text-keep-text">{t("editor.sounds.whisper")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.sounds.whisperHint")}
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
          <span className="block text-keep-text">{t("editor.sounds.chat")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.sounds.chatHint")}
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
          <span className="block text-keep-text">{t("editor.sounds.alert")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.sounds.alertHint")}
          </span>
        </span>
      </label>
    </fieldset>
  );
}

/**
 * Character-only Direct Messenger reachability toggle. Reachability is
 * OPT-OUT: new characters are reachable by default, and the player turns
 * this OFF here to remove a character from friend-add lookups and DM
 * recipient pickers. The copy below leans on plain language so the
 * consequence is obvious: existing friendships stick around, but new
 * reach attempts can't land while the switch is off.
 */
function CharacterDmOptInRow({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useTranslation("profile");
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">
        {t("editor.dm.legend")}
      </legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold">{t("editor.dm.label")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.dm.hint")}
          </span>
        </span>
      </label>
    </fieldset>
  );
}

/**
 * Input behavior opt-outs. Two toggles for composer features that some
 * users find intrusive rather than helpful:
 *   - Command/post history (ArrowUp recall), easy to brush ArrowUp by
 *     accident while moving the cursor; with history off, the arrow
 *     keys do nothing but move the caret.
 *   - Thesaurus on highlight, the synonym popup opens whenever a word
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
  const { t } = useTranslation("profile");
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.input.legend")}</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {t("editor.input.hint")}
      </p>
      <label className="mb-1 flex items-start gap-2">
        <input
          type="checkbox"
          checked={disableHistory}
          onChange={(e) => onChangeDisableHistory(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">{t("editor.input.history")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.input.historyHint")}
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
          <span className="block text-keep-text">{t("editor.input.thesaurus")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.input.thesaurusHint")}
          </span>
        </span>
      </label>
    </fieldset>
  );
}

/**
 * Visual-flair opt-outs. Account-wide, global toggles that turn OFF
 * rendering of OTHER people's cosmetic flair FOR THIS VIEWER, a smoother-
 * experience escape hatch for older / slower devices. Nothing is taken
 * away from anyone else; these only change what this account's screen
 * draws. Saved to /me/profile and pushed into the chat store so chat,
 * the userlist, and profiles repaint immediately.
 */
function FlairDisplayRow({
  disableNameStyles,
  disableBorderStyles,
  disableInlineAvatars,
  onChangeDisableNameStyles,
  onChangeDisableBorderStyles,
  onChangeDisableInlineAvatars,
}: {
  disableNameStyles: boolean;
  disableBorderStyles: boolean;
  disableInlineAvatars: boolean;
  onChangeDisableNameStyles: (v: boolean) => void;
  onChangeDisableBorderStyles: (v: boolean) => void;
  onChangeDisableInlineAvatars: (v: boolean) => void;
}) {
  const { t } = useTranslation("profile");
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.flair.legend")}</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {t("editor.flair.hint")}
      </p>
      <label className="mb-1 flex items-start gap-2">
        <input
          type="checkbox"
          checked={disableNameStyles}
          onChange={(e) => onChangeDisableNameStyles(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">{t("editor.flair.nameStyles")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.flair.nameStylesHint")}
          </span>
        </span>
      </label>
      <label className="mb-1 flex items-start gap-2">
        <input
          type="checkbox"
          checked={disableBorderStyles}
          onChange={(e) => onChangeDisableBorderStyles(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">{t("editor.flair.borders")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.flair.bordersHint")}
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={disableInlineAvatars}
          onChange={(e) => onChangeDisableInlineAvatars(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">{t("editor.flair.inlineAvatars")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.flair.inlineAvatarsHint")}
          </span>
        </span>
      </label>
    </fieldset>
  );
}

/**
 * Earning, hide-Currency toggle.
 *
 * Master-scope only (character pools cascade off the master flag).
 * Saves immediately on change rather than riding the profile form's
 * Save button, so the toggle doesn't get stranded by an unrelated
 * validation error elsewhere in the form. Pulls initial state from
 * the Earning store (which the App-level useEffect refreshes on
 * sign-in); falls back to a direct /earning/me fetch when the
 * store hasn't loaded yet.
 */
/**
 * Manage the account's block list. Blocks are global + mutual, so this is a
 * master-only row. The Block ACTION lives on user profiles (the "Block"
 * button); this is the only place to UNDO one, since a blocked user's profile
 * is no longer reachable once blocked.
 */
function BlockedUsersRow() {
  const { t } = useTranslation("profile");
  const [list, setList] = useState<BlockedUser[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBlocks()
      .then((b) => { if (!cancelled) setList(b); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : t("errors.failedToLoad")); });
    return () => { cancelled = true; };
  }, []);

  async function remove(userId: string) {
    setBusyId(userId);
    setErr(null);
    try {
      await removeBlock(userId);
      setList((cur) => (cur ?? []).filter((b) => b.userId !== userId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.failedToRemove"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.blocked.legend")}</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {t("editor.blocked.hint")}
      </p>
      {err ? <div className="mb-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{err}</div> : null}
      {list === null ? (
        <p className="italic text-keep-muted">{t("common:loading")}</p>
      ) : list.length === 0 ? (
        <p className="italic text-keep-muted">{t("editor.blocked.empty")}</p>
      ) : (
        <ul className="space-y-1">
          {list.map((b) => (
            <li key={b.userId} className="flex items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1.5">
              {b.avatarUrl ? (
                <img src={b.avatarUrl} alt="" referrerPolicy="no-referrer" className="h-6 w-6 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-keep-rule/40 text-[10px] uppercase text-keep-muted">{b.username.slice(0, 1)}</span>
              )}
              <span className="min-w-0 flex-1 truncate text-keep-text">{b.username}</span>
              <button
                type="button"
                disabled={busyId === b.userId}
                onClick={() => void remove(b.userId)}
                className="shrink-0 rounded border border-keep-rule px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
              >
                {t("editor.blocked.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/**
 * Password management for the master account (profile → Privacy). Two modes,
 * decided by GET /me/password-status:
 *   - has a password → "Change password": current + new + confirm.
 *   - OAuth-only (no password yet) → "Set a password": new + confirm, shown with
 *     an IMPORTANT highlight, because for a Google-only account a lost Google
 *     login means no way back in. Setting one is the safety net.
 * Submits POST /me/password; on success it flips to change-mode, clears the
 * fields, and flashes. Not gated on Google being enabled — a password user can
 * always change it. The server keeps THIS session and revokes the others.
 */
function PasswordRow() {
  const { t } = useTranslation("profile");
  // undefined = loading; true = has a password (change mode); false = OAuth-only
  // (set-a-password mode with the highlight).
  const [hasPassword, setHasPassword] = useState<boolean | undefined>(undefined);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/me/password-status", { credentials: "include" });
        if (!r.ok) throw new Error(await readError(r));
        const j = (await r.json()) as { hasPassword: boolean };
        if (!cancelled) setHasPassword(j.hasPassword);
      } catch {
        // On error default to change-mode: the safer branch (requires a current
        // password), never accidentally offering a no-current-password set.
        if (!cancelled) setHasPassword(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const settingNew = hasPassword === false; // OAuth-only: setting a first password

  async function submit() {
    setErr(null);
    if (next.length < 8) { setErr(t("editor.password.tooShort")); return; }
    if (next !== confirm) { setErr(t("editor.password.mismatch")); return; }
    if (!settingNew && !current) { setErr(t("editor.password.needCurrent")); return; }
    setBusy(true);
    try {
      const r = await fetch("/me/password", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(settingNew ? {} : { currentPassword: current }),
          newPassword: next,
        }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setHasPassword(true);
      setCurrent(""); setNext(""); setConfirm("");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.passwordSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className={`rounded border p-3 text-xs ${settingNew ? "border-keep-accent/60 bg-keep-accent/5" : "border-keep-rule"}`}>
      <legend className="px-1 uppercase tracking-widest text-keep-muted">
        {settingNew ? t("editor.password.setLegend") : t("editor.password.legend")}
      </legend>
      {hasPassword === undefined ? (
        <p className="italic text-keep-muted">{t("common:loading")}</p>
      ) : (
        <>
          {settingNew ? (
            <p className="mb-2 rounded border border-keep-accent/50 bg-keep-accent/10 p-2 text-keep-accent">
              {t("editor.password.oauthOnly")}
            </p>
          ) : (
            <p className="mb-2 text-[10px] text-keep-muted">
              {t("editor.password.changeHint")}
            </p>
          )}
          {err ? <div className="mb-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{err}</div> : null}
          {saved ? <div className="mb-2 text-keep-system">{t("editor.password.saved")}</div> : null}
          <div className="flex flex-col gap-1.5">
            {!settingNew ? (
              <input
                type="password"
                autoComplete="current-password"
                placeholder={t("editor.password.currentPlaceholder")}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
              />
            ) : null}
            <input
              type="password"
              autoComplete="new-password"
              placeholder={t("editor.password.newPlaceholder")}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder={t("editor.password.confirmPlaceholder")}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="self-start rounded border border-keep-rule px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
            >
              {busy ? t("common:saving") : settingNew ? t("editor.password.set") : t("editor.password.change")}
            </button>
          </div>
        </>
      )}
    </fieldset>
  );
}

/**
 * Connected-accounts management (Google sign-in) for the master account.
 *
 * Renders nothing when the admin hasn't enabled Google sign-in
 * (`branding.googleAuthEnabled`) so we don't advertise a switch that can't
 * be flipped. Otherwise fetches GET /me/oauth and shows either:
 *   - linked   → the Google email + an Unlink button. The server refuses
 *                (409) if unlinking would leave the account with no way to
 *                sign in (no password + no other provider); we surface that
 *                message inline so the user knows to set a password first.
 *   - unlinked → a "Link Google account" button that full-page-redirects to
 *                /auth/google/start?mode=link (OAuth is a browser round-trip,
 *                not a fetch). On return the app root shows a "linked" toast.
 */
function ConnectedAccountsRow() {
  const { t } = useTranslation("profile");
  const googleAuthEnabled = useChat((s) => s.branding.googleAuthEnabled);
  // Undefined = still loading; null = loaded + not linked; string(-able) =
  // linked, carrying the informational provider email (may itself be null
  // when Google didn't return one, in which case we show a generic label).
  const [google, setGoogle] = useState<{ email: string | null } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!googleAuthEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/me/oauth", { credentials: "include" });
        if (!r.ok) throw new Error(await readError(r));
        const j = (await r.json()) as {
          providers: Array<{ provider: string; providerEmail: string | null }>;
        };
        const row = j.providers.find((p) => p.provider === "google");
        if (!cancelled) setGoogle(row ? { email: row.providerEmail } : null);
      } catch (e) {
        if (!cancelled) {
          setGoogle(null);
          setErr(e instanceof Error ? e.message : t("errors.failedToLoad"));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [googleAuthEnabled]);

  // Admin hasn't turned Google sign-in on: nothing to connect, render nothing.
  if (!googleAuthEnabled) return null;

  async function unlink() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/me/oauth/google/unlink", {
        method: "POST",
        credentials: "include",
      });
      // 409 is the lockout guard ("set a password first"); readError surfaces
      // the server's exact wording so the user knows the concrete next step.
      if (!r.ok) throw new Error(await readError(r));
      setGoogle(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.failedToUnlink"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.connected.legend")}</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {t("editor.connected.hint")}
      </p>
      {err ? <div className="mb-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{err}</div> : null}
      {google === undefined ? (
        <p className="italic text-keep-muted">{t("common:loading")}</p>
      ) : (
        <div className="flex items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg/40 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-keep-text">
            Google
            {google ? (
              <span className="text-keep-muted">
                {" — "}
                {google.email ?? t("editor.connected.linkedFallback")}
              </span>
            ) : (
              <span className="text-keep-muted">{" — "}{t("editor.connected.notLinked")}</span>
            )}
          </span>
          {google ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void unlink()}
              className="shrink-0 rounded border border-keep-rule px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
            >
              {t("editor.connected.unlink")}
            </button>
          ) : (
            <button
              type="button"
              // OAuth link is a browser round-trip, not a fetch: navigate the
              // whole page to Google's consent screen. mode=link tells the
              // server to attach the Google identity to THIS signed-in account
              // rather than mint / sign into a separate one.
              onClick={() => { window.location.href = "/auth/google/start?mode=link"; }}
              className="shrink-0 rounded border border-keep-rule px-2 py-0.5 hover:bg-keep-banner"
            >
              {t("editor.connected.link")}
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
}

/**
 * Adult "Hide 18+ content" preference (age plan Phase 4). One
 * self-saving checkbox that PUTs `hideNsfw` to /me/profile, the field
 * behind the server's SOFT `canSeeNsfw` tier (forum topic lists, both
 * searches, discovery/catalog listings). It does NOT lock adults out of
 * 18+ rooms they navigate to — that's the point of the soft tier.
 *
 * Minor accounts render nothing: they can never see 18+ content, so the
 * toggle has no state to show (a forced, disabled checkbox is exactly
 * the dead control the age plan bans for minors).
 *
 * Same self-fetch + optimistic-revert pattern as the sibling rows
 * (DisplayPrivacyRow, ScriptoriumPrivacyRow); additionally mirrors the
 * saved value into `viewerAge.hideNsfw` in the store so client-side
 * soft-gated surfaces react without a reload.
 */
function HideNsfwRow() {
  const { t } = useTranslation("profile");
  const isAdult = useChat((s) => s.viewerAge.isAdult);
  const [loaded, setLoaded] = useState(false);
  const [hideNsfw, setHideNsfw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (!isAdult) return; // row never renders for minors; skip the fetch
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/me/profile", { credentials: "include" });
        if (!r.ok) throw new Error(t("errors.loadFailed"));
        const j = await r.json() as { hideNsfw?: boolean };
        if (cancelled) return;
        setHideNsfw(j.hideNsfw ?? false);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : t("errors.loadFailed"));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot fetch per adult-state; `t` only shapes error copy
  }, [isAdult]);

  async function save(next: boolean) {
    const prev = hideNsfw;
    setHideNsfw(next);
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/me/profile", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideNsfw: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      // Keep the store's cosmetic mirror in step so soft-gated surfaces
      // pick the change up live. Read at call time (not from a render
      // closure) so a concurrent /me/profile seed isn't clobbered.
      const cur = useChat.getState().viewerAge;
      useChat.getState().setViewerAge({ ...cur, hideNsfw: next });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.failedToSave"));
      setHideNsfw(prev);
    } finally {
      setSaving(false);
    }
  }

  if (!isAdult) return null;

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.nsfwPref.legend")}</legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={hideNsfw}
          disabled={!loaded || saving}
          onChange={(e) => void save(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">{t("editor.nsfwPref.label")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.nsfwPref.hint")}
          </span>
        </span>
      </label>
      {err ? (
        <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-[10px] text-keep-accent">{err}</div>
      ) : null}
      {savedFlash ? (
        <div className="mt-1 text-[10px] text-keep-system">{t("saved")}</div>
      ) : null}
    </fieldset>
  );
}

/**
 * Minor isolation toggle (age plan Phase 5). Shown to under-18 accounts
 * ONLY — the server rejects the field for adults, and an adult (or a
 * minor who just turned 18) has no state for it to show, so rendering
 * nothing beats a dead control. Self-saving `isolateFromAdults` via the
 * /me/profile PUT, same pattern as HideNsfwRow above; mirrors the saved
 * value into `viewerAge.isolateFromAdults` so client surfaces can react
 * without a reload (the server repaints presence live on its side).
 */
function IsolationRow() {
  const { t } = useTranslation("profile");
  const isAdult = useChat((s) => s.viewerAge.isAdult);
  const [loaded, setLoaded] = useState(false);
  const [isolate, setIsolate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (isAdult) return; // row never renders for adults; skip the fetch
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/me/profile", { credentials: "include" });
        if (!r.ok) throw new Error(t("errors.loadFailed"));
        const j = await r.json() as { isolateFromAdults?: boolean };
        if (cancelled) return;
        setIsolate(j.isolateFromAdults ?? false);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : t("errors.loadFailed"));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot fetch per adult-state; `t` only shapes error copy
  }, [isAdult]);

  async function save(next: boolean) {
    const prev = isolate;
    setIsolate(next);
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/me/profile", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isolateFromAdults: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const cur = useChat.getState().viewerAge;
      useChat.getState().setViewerAge({ ...cur, isolateFromAdults: next });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.failedToSave"));
      setIsolate(prev);
    } finally {
      setSaving(false);
    }
  }

  if (isAdult) return null;

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.isolation.legend")}</legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={isolate}
          disabled={!loaded || saving}
          onChange={(e) => void save(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">{t("editor.isolation.label")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.isolation.hint")}
          </span>
        </span>
      </label>
      {err ? (
        <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-[10px] text-keep-accent">{err}</div>
      ) : null}
      {savedFlash ? (
        <div className="mt-1 text-[10px] text-keep-system">{t("saved")}</div>
      ) : null}
    </fieldset>
  );
}

function CurrencyPrivacyRow() {
  const { t } = useTranslation("profile");
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
      .catch(() => { /* user can still toggle, server is source of truth on save */ });
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
      setErr(e instanceof Error ? e.message : t("errors.failedToSave"));
      if (kind === "currency") setHideCurrency(!next); else setHideXp(!next);
    } finally {
      setSaving(false);
    }
  }

  // Current totals readout, so the user sees their own Earning state
  // here, not just the privacy toggles. Mirrors what the chat strip
  // shows; pulled from the same snapshot so it stays in sync with
  // live `earning:earned` updates.
  const master = snapshot?.master ?? null;
  const { rank, tierRow } = lookupRankTier(snapshot, master?.rankKey ?? null, master?.tier ?? null);
  const rankLabel = rank ? `${rank.name}${tierRow ? ` ${tierRow.label}` : ""}` : t("editor.earning.unranked");
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.earning.legend")}</legend>
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
          <span className="font-semibold tabular-nums text-keep-text">{formatNumber(master?.currency ?? 0)}</span>
        </span>
        <span aria-hidden className="h-4 w-px shrink-0 bg-keep-rule/60" />
        <span className="inline-flex items-baseline gap-1">
          <span className="font-semibold tabular-nums text-keep-text">{formatNumber(master?.xp ?? 0)}</span>
          <span className="uppercase tracking-widest text-keep-muted">{t("modal.hero.xp")}</span>
        </span>
      </div>
      <p className="mb-2 text-[10px] text-keep-muted">
        {t("editor.earning.hint")}
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
          <span className="block text-keep-text">{t("editor.earning.hideCurrency")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.earning.hideCurrencyHint")}
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
          <span className="block text-keep-text">{t("editor.earning.hideXp")}</span>
          <span className="block text-[10px] text-keep-muted">
            {t("editor.earning.hideXpHint")}
          </span>
        </span>
      </label>
      {err ? (
        <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-[10px] text-keep-accent">{err}</div>
      ) : null}
      {savedFlash ? (
        <div className="mt-1 text-[10px] text-keep-system">{t("saved")}</div>
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
  const { t } = useTranslation("profile");
  const publicPath = kind === "master" ? "/profiles/<username>" : "/profiles/<character>";
  // Age plan Phase 1: under-18 accounts can't flag a profile 18+ (the
  // server rejects the write), so don't render a checkbox that could
  // only ever error. Cosmetic mirror only, the server stays the gate.
  const viewerIsAdult = useChat((s) => s.viewerAge.isAdult);
  // When NSFW is on, the Public box is disabled and visually shows as
  // unchecked - matches the server's normalization on save.
  const effectivePublic = isNsfw ? false : isPublic;
  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.visibilityRow.legend")}</legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={effectivePublic}
          disabled={isNsfw}
          onChange={(e) => onChangePublic(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold">{t("editor.visibilityRow.public")}</span>
          <span className="block text-[10px] text-keep-muted">
            <Trans
              t={t}
              i18nKey={kind === "master" ? "editor.visibilityRow.publicHintMaster" : "editor.visibilityRow.publicHintCharacter"}
              values={{ path: publicPath }}
              // Trans entity-escapes interpolated values while building its
              // node tree; without this the literal "<username>" placeholder
              // double-escapes and renders as "&lt;username&gt;".
              shouldUnescape
              components={{ code: <code /> }}
            />
          </span>
        </span>
      </label>
      {/* A minor can't see (or clear) the NSFW checkbox below, so when a
          moderator has marked their profile 18+ the disabled Public box
          needs its own explanation - otherwise it reads as a dead control
          with no stated reason and no path to contest it. */}
      {!viewerIsAdult && isNsfw ? (
        <p className="mt-1 text-[10px] text-keep-system">
          {t("editor.visibilityRow.minorNsfwNote")}
        </p>
      ) : null}
      {viewerIsAdult ? (
        <label className="mt-2 flex items-start gap-2">
          <input
            type="checkbox"
            checked={isNsfw}
            onChange={(e) => onChangeNsfw(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">{t("editor.visibilityRow.nsfwLabel")}</span>
            <span className="block text-[10px] text-keep-muted">
              {t("editor.visibilityRow.nsfwHint")}
            </span>
          </span>
        </label>
      ) : null}
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
  const { t } = useTranslation("profile");
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
      setError(err instanceof Error ? err.message : t("errors.enableFailed"));
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
      setError(err instanceof Error ? err.message : t("errors.disableFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (state === "unsupported") {
    return (
      <div className="mt-2 text-[10px] italic text-keep-muted">
        {t("editor.push.unsupported")}
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-keep-rule/50 pt-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-keep-text">{t("editor.push.title")}</div>
          <div className="text-[10px] text-keep-muted">
            {t("editor.push.hint")}
          </div>
        </div>
        {state === "loading" ? (
          <span className="text-[10px] text-keep-muted">…</span>
        ) : state === "denied" ? (
          <span className="text-[10px] text-keep-accent">{t("editor.push.denied")}</span>
        ) : state === "subscribed" ? (
          <button
            type="button"
            onClick={turnOff}
            disabled={busy}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner disabled:opacity-50"
          >
            {busy ? "..." : t("editor.disable")}
          </button>
        ) : (
          <button
            type="button"
            onClick={turnOn}
            disabled={busy}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-xs hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {busy ? "..." : t("editor.enable")}
          </button>
        )}
      </div>
      {error ? <div className="mt-1 text-[10px] text-keep-accent">{error}</div> : null}
    </div>
  );
}

/* ============================================================
 *  JournalEditor, owner-only solo writing attached to a
 *  character. Public entries surface on the profile in
 *  chronological order; private entries only show here.
 * ============================================================ */
function JournalEditor({ characterId }: { characterId: string }) {
  const { t } = useTranslation("profile");
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
      setError(e instanceof Error ? e.message : t("errors.loadFailed"));
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [characterId]);

  async function remove(id: string) {
    if (!window.confirm(t("editor.journal.deleteConfirm"))) return;
    try {
      const r = await fetch(`/characters/${characterId}/journal/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.deleteFailed"));
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
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("editor.tabs.journal")}</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {t("editor.journal.hint")}
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
        <p className="italic text-keep-muted">{t("editor.journal.loadingEntries")}</p>
      ) : entries.length === 0 ? (
        <p className="italic text-keep-muted">{t("editor.journal.noEntries")}</p>
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
                      {e.title || <span className="italic text-keep-muted">{t("modal.journal.untitled")}</span>}
                      <span
                        className={`ml-2 rounded px-1 text-[10px] uppercase tracking-widest ${
                          e.privacy === "public"
                            ? "bg-keep-action/15 text-keep-action"
                            : "bg-keep-rule/30 text-keep-muted"
                        }`}
                      >
                        {t(`editor.journal.privacyChip.${e.privacy}`)}
                      </span>
                    </span>
                    <span className="text-[10px] text-keep-muted">
                      {formatDate(e.createdAt)}
                    </span>
                  </header>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-keep-muted">{t("common:preview")}</summary>
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
                      {t("editor.journal.edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(e.id)}
                      className="rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
                    >
                      {t("common:delete")}
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
          {t("editor.journal.addEntry")}
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
  const { t } = useTranslation("profile");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [bodyHtml, setBodyHtml] = useState(initial?.bodyHtml ?? "");
  const [privacy, setPrivacy] = useState<"public" | "private">(initial?.privacy ?? "public");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Plain handler (not onSubmit), see LinksEditor.add for why nesting a
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
      setErr(e2 instanceof Error ? e2.message : t("errors.saveFailed"));
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
        placeholder={t("editor.journal.titlePlaceholder")}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
      />
      <textarea
        value={bodyHtml}
        onChange={(e) => setBodyHtml(e.target.value)}
        rows={8}
        placeholder={t("editor.journal.bodyPlaceholder")}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-keep-action"
      />
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1 text-[11px] text-keep-muted">
          <span>{t("editor.journal.visibilityLabel")}</span>
          <select
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as "public" | "private")}
            className="rounded border border-keep-rule bg-keep-bg px-1 py-0.5"
          >
            <option value="public">{t("editor.journal.publicOption")}</option>
            <option value="private">{t("editor.journal.privateOption")}</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
          >
            {t("common:cancel")}
          </button>
          <button
            type="button"
            onClick={() => { void submit(); }}
            disabled={busy || !bodyHtml.trim()}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {busy ? t("common:savingDots") : mode === "create" ? t("createCharacter.create") : t("common:save")}
          </button>
        </div>
      </div>
      {err ? <div className="text-[10px] text-keep-accent">{err}</div> : null}
    </div>
  );
}
