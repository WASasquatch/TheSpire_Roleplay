import { useEffect, useMemo, useState } from "react";
import { Ban, EyeOff, Flag, MessageSquare, Send } from "lucide-react";
import { sanitizeUserHtml, sweepOrphanedUserBioStyles, USER_HTML_SCOPE_CLASS } from "../lib/userHtml.js";
import { CHARACTER_VIBE_AXES, isAdminRole, legibleAgainstBg, legibleThemePalette, parseFreeformBorderConfig, roleRank } from "@thekeep/shared";
import type { CharacterAttribute, CharacterPortrait, CharacterVibeAxisKey, EidolonProfileSummary, ProfileLibraryEntry, ProfileLink, ProfileView, WorldMembership } from "@thekeep/shared";
import { themeStyle } from "../lib/theme.js";
import { buildOrnamentStyle } from "../lib/ornaments/index.js";
import { BorderedAvatar } from "./BorderedAvatar.js";
import { CloseButton } from "./CloseButton.js";
import { genderGlyph } from "../lib/gender.js";
import type { Gender } from "../lib/gender.js";
import { profileShareUrl, reportProfile } from "../lib/profiles.js";
import { fetchPublicEarning, type PublicEarningResponse } from "../lib/earning.js";
import { ArcadeError, fetchEidolonSummary, patFamiliar } from "../lib/arcade.js";
import { ItemZoomView } from "./ItemZoomView.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { RankSigil } from "./RankSigil.js";
import { StyledName } from "./StyledName.js";
import { useChat } from "../state/store.js";
import { ProfileMarquee, ProfileVisitorsChip, useTrackProfileView } from "./ProfileFlairSurfaces.js";
import { EditBioModal } from "./EditBioModal.js";
import { loadViewerHiddenImageIds, saveViewerHiddenImageIds } from "../lib/viewerNsfw.js";
import {
  banAccount,
  fetchUserModeration,
  saveModBio,
  setPortraitNsfw,
  unbanAccount,
  type UserModeration,
} from "../lib/profileModeration.js";

/**
 * Unified profile action-button styling. Every button shares ONE shape; only
 * the color slot changes, and it encodes intent so the row reads at a glance:
 *   - action  : communicate (Message / Whisper / Switch identity)
 *   - accent  : caution, reversible        (Ignore)
 *   - system  : strongest, account-level   (Block)
 * `ACT_PILL_*` are the desktop pills; `ACT_SEG_*` are the mobile full-width
 * segmented bar. Keep these as the single source so the buttons can't drift
 * back into the four-different-designs state they were in.
 *
 * The buttons render Lucide icons only (compact), so each carries an
 * `aria-label` + `title` to supply the name/tooltip the visible text used to
 * give. The bases center their icon.
 */
// No `bg-keep-bg` fill: the pills sit transparently on the hero band
// (`bg-keep-panel`) so the band is unambiguously their background, and the
// per-pill inline ink (computed in ProfileBody against the panel color) is
// guaranteed legible. A solid fill could turn translucent under glass
// designs / profile BG images and let the band bleed through, which was the
// "invisible icons" bug. Hover tints still paint over the transparent base.
const ACT_PILL = "inline-flex items-center justify-center rounded border px-2 py-1 transition-colors";
const ACT_PILL_ACTION = `${ACT_PILL} border-keep-action/50 text-keep-action hover:bg-keep-action/10`;
const ACT_PILL_NEUTRAL = `${ACT_PILL} border-keep-rule text-keep-text hover:bg-keep-panel`;
const ACT_PILL_ACCENT = `${ACT_PILL} border-keep-accent/60 text-keep-accent hover:bg-keep-accent/10`;
const ACT_PILL_SYSTEM = `${ACT_PILL} border-keep-system/60 text-keep-system hover:bg-keep-system/10`;

const ACT_SEG = "flex flex-1 items-center justify-center px-2 py-2.5 transition-colors";
const ACT_SEG_ACTION = `${ACT_SEG} text-keep-action hover:bg-keep-action/10`;
const ACT_SEG_NEUTRAL = `${ACT_SEG} text-keep-text hover:bg-keep-panel`;
const ACT_SEG_ACCENT = `${ACT_SEG} text-keep-accent hover:bg-keep-accent/10`;
const ACT_SEG_SYSTEM = `${ACT_SEG} text-keep-system hover:bg-keep-system/10`;
const ACT_SEG_DIVIDER = "border-r border-keep-rule";

interface Props {
  profile: ProfileView;
  onClose: () => void;
  /** Pre-fill composer with `/whisper <name> ` and close. */
  onWhisper?: (name: string) => void;
  /**
   * Open the DM floating panel keyed to the profile's owner. Phase 4
   * surface for the Direct Messages feature. The parent hides this
   * action when the viewer is anonymous OR equals the profile owner
   * OR the target has `dmsEnabled === false`, same gate posture as
   * Whisper. The handler receives the target's userId since the DM
   * routing is user-based, not name-based.
   */
  onMessage?: (userId: string, displayName: string, avatarUrl: string | null) => void;
  /** Issue `/ignore <name>`. */
  onIgnore?: (name: string) => void;
  /** Block this user globally + mutually (POST /me/blocks). Block-only:
   *  after blocking, the profile is no longer reachable, so undo lives in
   *  Profile -> Privacy, not here. */
  onBlock?: (name: string) => void;
  /** Open another profile by name (used to follow a mutual-title link). */
  onOpenProfile?: (name: string) => void;
  /** Open a world viewer by slug. Used by the Worlds section chips. */
  onOpenWorld?: (slug: string) => void;
  /**
   * When true, skip the NSFW gate splash that otherwise blocks viewing of
   * profiles with isNsfw=true. Parent passes this when the viewer is the
   * profile's owner OR a site admin - they're trusted to skip the warning.
   */
  bypassNsfwGate?: boolean;
  /**
   * Active-character action to expose on the viewer's own profiles. Parent
   * decides the label + behaviour based on viewer state:
   *   - master profile + viewer has an active character → "Switch to OOC"
   *     (clears the active character)
   *   - non-active character of yours                  → "Switch to <name>"
   *     (activates this character)
   *   - your currently-active character                → "Disable <name>"
   *     (clears the active character)
   *   - master profile + no active character           → omit (no-op)
   *   - someone else's profile                         → omit (caller filters)
   */
  activeCharacterAction?: { label: string; onClick: () => void };
  /**
   * Called after a moderator action that changes the displayed profile
   * (gallery NSFW flag, bio edit). The parent should re-fetch this
   * profile and re-pass it so the change reflects without a manual
   * reopen. Ban/unban state is managed inside the mod panel's own
   * fetch, so it doesn't depend on this.
   */
  onModerated?: () => void;
  /**
   * Stacking override for the modal backdrop. Defaults to the Modal
   * baseline (40). Bumped above 50 when the profile is opened from
   * inside the admin panel so it sits on top of the admin shell
   * instead of being hidden underneath it.
   */
  zIndex?: number;
}

/** Stable empty-permissions fallback so the `useChat` selector returns a
 *  referentially-stable value for anonymous viewers (a fresh `[]` literal
 *  would make zustand re-render on every unrelated store change). */
const EMPTY_PERMS: readonly string[] = [];

/**
 * Read-only profile viewer.
 *
 * The modal applies the OWNER's chosen theme (via CSS-var override on the
 * card element), so each user's profile feels distinctly theirs regardless
 * of who's viewing it. The viewer's chat theme remains unaffected.
 *
 * Layout:
 *   - Hero band: avatar (or placeholder), name, kind label, gender, joined
 *   - Action row: whisper / ignore (the modal isn't shown for self - App
 *     diverts self-clicks to the editor - so these are always relevant)
 *   - Stats grid (characters only; hidden when empty)
 *   - Bio section with explicit empty-state message
 *
 * Every section degrades gracefully: characters with nothing filled out
 * still get a clean modal that says "X hasn't filled out their profile yet."
 */
export function ProfileModal({ profile, onClose, onWhisper, onMessage, onIgnore, onBlock, onOpenProfile, onOpenWorld, activeCharacterAction, onModerated, bypassNsfwGate, zIndex }: Props) {
  const isChar = profile.kind === "character";
  const name = isChar ? profile.profile.name : profile.profile.username;
  const bio = profile.profile.bioHtml.trim();
  const avatar = profile.profile.avatarUrl;
  const ownerTheme = profile.profile.theme;
  const ownerStyleKey = profile.profile.styleKey;
  const ownerOrnaments = buildOrnamentStyle(ownerTheme, ownerStyleKey);
  const createdAt = profile.profile.createdAt;
  const stats = isChar ? profile.profile.stats : null;
  const gender = resolveGender(profile);
  const titles = profile.profile.titles ?? [];
  const links = profile.profile.links ?? [];
  const journal = isChar ? (profile.profile.journalEntries ?? []) : [];

  // NSFW gate: a warning splash that blocks viewing until the user clicks
  // "View Profile". Trusted viewers (owner + admin) skip the gate via the
  // bypassNsfwGate prop. State is per-modal-mount, so closing + reopening
  // re-prompts (intentional - "I confirmed once 20 minutes ago" isn't a
  // strong enough signal to skip the gate forever).
  // Gate when the profile is wholly marked NSFW OR contains ANY NSFW image
  // in its gallery, so a profile that slips explicit content into portraits
  // (without flagging the whole profile) still prompts before reveal.
  const anyPortraitNsfw = isChar && profile.profile.portraits.some((p) => p.nsfw);
  const requiresGate = (profile.profile.isNsfw || anyPortraitNsfw) && !bypassNsfwGate;
  const [gateAccepted, setGateAccepted] = useState(false);
  const gated = requiresGate && !gateAccepted;

  // Visibility-gate bypass for the rendered profile. Two viewer
  // classes get the full stats regardless of the owner's hide flags:
  //   - The owner themselves, so the editor + viewer surfaces don't
  //     disagree on what they own. Without this, an owner toggling
  //     a field 🙈 in the editor would see the field vanish from
  //     their own profile view too, which reads as data loss rather
  //     than a visibility tweak.
  //   - Site admins (mod+), since the owner contract is "hide from
  //     strangers, not from staff", see the docstring on
  //     `CharacterStats.visibility` in shared/profile.ts.
  // The detection runs lazily via useChat below; the helper short-
  // circuits to "no bypass" when nobody's signed in (anonymous
  // viewers always see the gated set).
  const myId = useChat((s) => s.me?.id ?? null);
  const myRole = useChat((s) => s.me?.role ?? null);
  const bypassVisibility =
    (myId !== null && myId === profile.profile.userId) ||
    (myRole !== null && roleRank(myRole) >= roleRank("mod"));
  // Stat entries that actually have a value - empty fields are dropped so
  // a half-filled character doesn't show a row of dashes.
  const statEntries = stats ? collectStatEntries(stats, bypassVisibility) : [];
  // Portraits live on the character profile only, master profiles don't
  // carry a gallery, so master views fall back to length 0. The blank
  // check counts them as "filled out" so a character with only gallery
  // images (no bio/stats/avatar) still shows the gallery instead of the
  // empty-profile placeholder.
  const portraitCount = isChar ? profile.profile.portraits.length : 0;
  const isCompletelyBlank = !bio
    && statEntries.length === 0
    && !avatar
    && titles.length === 0
    && links.length === 0
    && journal.length === 0
    && portraitCount === 0;

  // Owner-configured public-profile background. When set, the Modal's
  // backdrop (the area outside the card) paints this image with the
  // chosen sizing strategy. The backdrop's own `onClick={onClose}`
  // stays intact, clicking outside the card still dismisses the
  // modal exactly like the default backdrop, so logged-in viewers
  // landing on a profile from chat can still tap-out back to the
  // shell. Backdrop also keeps its `bg-black/40` darken color, which
  // CSS paints UNDER the inline backgroundImage; we don't double
  // that up with a gradient so vivid BGs come through clean.
  const profileBgUrl = profile.profile.publicProfileBgUrl?.trim() ?? "";
  const profileBgMode = profile.profile.publicProfileBgMode ?? "cover";
  const backdropStyle: React.CSSProperties | undefined = profileBgUrl
    ? {
        backgroundImage: `url("${profileBgUrl}")`,
        backgroundSize:
          profileBgMode === "stretch"
            ? "100% 100%"
            : profileBgMode === "tile"
              ? "auto"
              : profileBgMode, // "cover" | "contain" pass straight to CSS
        backgroundRepeat: profileBgMode === "tile" ? "repeat" : "no-repeat",
        backgroundPosition: "center",
        backgroundAttachment: "fixed",
      }
    : undefined;

  // Belt-and-suspenders cleanup for the writer's `<style>` blocks.
  // The bio container is portaled to <body> via <Modal>, and React's
  // normal teardown removes it (and the scoped `<style>` tags inside)
  // when this component unmounts. But a "the profile's custom CSS
  // bled into the login modal after closing the public profile"
  // report pinned a path where a leftover block was still being
  // matched against the next mounted tree, likely a Strict-mode
  // double-mount or the SPA route swap destroying and recreating the
  // host shell on the same tick. Running the sweep here on unmount
  // (after React's own removal) guarantees that no marker-tagged
  // user-bio stylesheet survives the close, regardless of which
  // surface comes up next.
  useEffect(() => {
    return () => { sweepOrphanedUserBioStyles(); };
  }, []);

  // Scoped CSS-var overrides applied to the modal card.
  //
  // The card ALWAYS renders on the owner's OPAQUE surfaces, even when the
  // profile has a BG image. The image is shown only as the modal BACKDROP
  // (around the card), never bled through the card itself. The previous
  // translucent-glass-over-image treatment was the legibility killer:
  // `legibleThemePalette` lifts the owner's text to contrast against the
  // owner's `theme.bg`, but a translucent card let a light image wash the
  // surface to near-white while the (dark-theme) text stayed light —
  // white-on-white. Forcing every `.keep-frame` / `.keep-panel` glass
  // tint to full opacity (plus the inline `backgroundColor` below) means
  // the rendered surface equals the color the contrast math assumes, so
  // the body stays legible on every theme + image combination.
  const legibilityVars: Record<string, string> = {
    "--keep-glass-panel-tint": "rgb(var(--keep-panel))",
    "--keep-glass-bg-tint": "rgb(var(--keep-bg))",
  };

  return (
    <Modal
      onClose={onClose}
      variant="mobile-fullscreen"
      // Conditional spread, not `prop={maybeUndef}`, `exactOptionalPropertyTypes`
      // in tsconfig rejects `undefined` as a value for optional props.
      {...(backdropStyle ? { backdropStyle } : {})}
      {...(zIndex !== undefined ? { zIndex } : {})}
    >
      {/* Layout-transparent wrapper that hosts the owner-design
          attributes. Every `[data-theme-style="…"] .keep-frame`,
          `… .keep-panel`, `… .keep-button`, etc. rule in styles.css
          uses a DESCENDANT combinator, so the card-as-keep-frame can
          only get those design treatments via an ANCESTOR carrying
          the attribute. In overlay mode (chat mounted) the viewer's
          `applyStyle` writes the attribute onto `<html>` and the
          modal card coincidentally matches via that ancestor, with
          the VIEWER's design, not the owner's. On a deep-link
          refresh the standalone shell is rendered (Chat never
          mounts, `applyStyle` never runs), `<html>` carries no
          attribute, and the card lost every design treatment ("the
          custom theme isn't applied correctly after refresh").
          Stamping the attributes on this contents-wrapper fixes both
          cases: the card is now a descendant of an element carrying
          the OWNER's style, so the rules engage with the correct
          values regardless of what `<html>` is wearing. `contents`
          collapses the wrapper out of layout so the card's
          MODAL_CARD_CONTENT sizing measures against the modal
          backdrop directly, exactly as before. */}
      <div
        data-theme-style={ownerOrnaments.styleKey}
        {...(profileBgUrl ? { "data-profile-bg": "1" } : {})}
        className="contents"
      >
      <div
        // Inline-style override scopes the theme to this card only. The
        // explicit bg/color use rgb(var()) because the variables now hold
        // RGB triples (see lib/theme.ts), not direct color values.
        //
        // Mobile: full-viewport sheet (h-dvh handles the iOS address-bar
        // shrink so the close button stays reachable). No border / rounded
        // corners since we sit edge-to-edge. Dismiss is via the close
        // button only, backdrop tap doesn't reach us at this size.
        // Desktop (md+): 75vw on widescreens with a ceiling so it doesn't
        // become absurd on ultra-wide monitors, capped at 85vh tall, with
        // the original border / rounded / shadow treatment.
        // Inline `backgroundColor` defeats the scifi `.keep-frame`
        // rule that paints the modal at 50% panel-alpha, that bleed
        // was the source of the "viewer's theme leaks through and
        // collapses contrast" bug. Inline beats every `[data-theme-
        // style="…"] .keep-frame` selector since none of them use
        // `!important`. Medieval / modern were already opaque, so
        // the override is a no-op there. The legibility-nudged text
        // in `legibleThemePalette` then computes against the bg the
        // user actually sees, not a blend.
        //
        // Applied UNCONDITIONALLY — including when the profile has a BG
        // image. The image lives on the modal backdrop (around the card);
        // the card stays opaque so the owner's text never lands on a
        // washed-out, image-tinted surface (the white-on-near-white bug).
        style={{
          ...themeStyle(ownerTheme),
          ...ownerOrnaments.vars,
          ...legibilityVars,
          backgroundColor: "rgb(var(--keep-bg))",
        }}
        className={`${MODAL_CARD_CONTENT} keep-frame bg-keep-bg text-keep-text lg:rounded`}
        onClick={(e) => e.stopPropagation()}
      >
        {gated ? (
          <NsfwGate
            name={name}
            kind={isChar ? "character" : "master"}
            onAccept={() => setGateAccepted(true)}
            onCancel={onClose}
          />
        ) : (
          <ProfileBody
            profile={profile}
            name={name}
            bio={bio}
            avatar={avatar}
            createdAt={createdAt}
            stats={stats}
            gender={gender}
            titles={titles}
            links={links}
            journal={journal}
            statEntries={statEntries}
            bypassVisibility={bypassVisibility}
            isCompletelyBlank={isCompletelyBlank}
            onClose={onClose}
            onWhisper={onWhisper}
            onMessage={onMessage}
            onIgnore={onIgnore}
            onBlock={onBlock}
            onOpenProfile={onOpenProfile}
            onOpenWorld={onOpenWorld}
            activeCharacterAction={activeCharacterAction}
            onModerated={onModerated}
          />
        )}
      </div>
      </div>
    </Modal>
  );
}


/* ============================================================ *
 *  ProfileBody - everything that was in the modal before the
 *  NSFW gate landed. Lifted out so the gated branch can return
 *  cleanly without juggling fragments.
 * ============================================================ */

function ProfileBody({
  profile,
  name,
  bio,
  avatar,
  createdAt,
  stats,
  gender,
  titles,
  links,
  journal,
  statEntries,
  bypassVisibility,
  isCompletelyBlank,
  onClose,
  onWhisper,
  onMessage,
  onIgnore,
  onBlock,
  onOpenProfile,
  onOpenWorld,
  activeCharacterAction,
  onModerated,
}: {
  /** Discriminated union; ProfileBody narrows on `profile.kind` to access master-only or character-only fields. */
  profile: ProfileView;
  name: string;
  bio: string;
  avatar: string | null;
  createdAt: number;
  stats: {
    age?: string;
    race?: string;
    gender?: string;
    height?: string;
    weight?: string;
    alignment?: string;
    occupation?: string;
    custom?: Record<string, string>;
    vibe?: Partial<Record<CharacterVibeAxisKey, number | null>>;
    attributes?: CharacterAttribute[];
    visibility?: {
      age?: boolean; race?: boolean; gender?: boolean; height?: boolean;
      weight?: boolean; alignment?: boolean; occupation?: boolean;
      custom?: boolean; vibe?: boolean; attributes?: boolean;
    };
  } | null;
  gender: Gender;
  titles: ProfileView["profile"]["titles"];
  links: ProfileLink[];
  journal: NonNullable<Extract<ProfileView, { kind: "character" }>["profile"]["journalEntries"]>;
  statEntries: Array<[string, string]>;
  /** True when the viewer is the profile owner or a mod+ admin viewer
   * , those classes see all sections regardless of `visibility`. */
  bypassVisibility: boolean;
  isCompletelyBlank: boolean;
  onClose: () => void;
  // `| undefined` (rather than `?:`) so callers can spread the value
  // straight through without exactOptionalPropertyTypes complaining.
  onWhisper: ((name: string) => void) | undefined;
  onMessage: ((userId: string, displayName: string, avatarUrl: string | null) => void) | undefined;
  onIgnore: ((name: string) => void) | undefined;
  onBlock: ((name: string) => void) | undefined;
  onOpenProfile: ((name: string) => void) | undefined;
  onOpenWorld: ((slug: string) => void) | undefined;
  activeCharacterAction: { label: string; onClick: () => void } | undefined;
  onModerated: (() => void) | undefined;
}) {
  const isChar = profile.kind === "character";
  // Viewer's role drives the mod-tools row: mod+ sees copy-id chips so
  // moderation flows (kick/ban/disable, admin tab lookups) can grab
  // the raw user/character ids without retyping. Read directly off
  // the chat store, ProfileModal can be opened from many surfaces
  // and a dedicated prop would just be parent-prop-drilling.
  const viewerRole = useChat((s) => s.me?.role ?? null);
  const isModViewer = viewerRole !== null && roleRank(viewerRole) >= roleRank("mod");
  // Moderation affordances. All gate on the viewer holding the specific
  // permission AND not viewing their own account (App already diverts
  // self-clicks to the editor, but a mod opening their OWN profile from a
  // chat line shouldn't see "ban yourself"). Character vs master profiles
  // use different permissions: characters reuse `edit_others_character`,
  // master/OOC profiles use the new `edit_others_user`.
  const myPerms = useChat((s) => s.me?.permissions ?? EMPTY_PERMS);
  const viewerId = useChat((s) => s.me?.id ?? null);
  const isSelfAccount = viewerId !== null && viewerId === profile.profile.userId;
  const profileEditPerm = isChar ? "edit_others_character" : "edit_others_user";
  const canEditBio = isModViewer && !isSelfAccount && myPerms.includes(profileEditPerm);
  const canFlagGallery = canEditBio; // same permission family gates both
  const canBanAccount = isModViewer && !isSelfAccount && myPerms.includes("ban_account");
  // Any signed-in non-owner can report this profile for review.
  const canReport = viewerId !== null && !isSelfAccount;
  const [reportOpen, setReportOpen] = useState(false);
  // Scope object reused by the gallery NSFW toggle + the bio editor.
  const modScope: { kind: "character"; characterId: string } | { kind: "master" } = isChar
    ? { kind: "character", characterId: (profile.profile as { id: string }).id }
    : { kind: "master" };
  // Earning, fetch the IDENTITY's own pool so the hero shows the
  // right XP / currency / rank / border. Character profiles must
  // pass their character id; without it the endpoint returns the
  // master/OOC pool and a fresh character would inherit the owner's
  // accumulated XP, currency, and equipped border (the project's
  // "a character is its own account" contract, nothing is shared
  // between OOC and a character).
  const characterIdForEarning = isChar
    ? (profile.profile as { id: string }).id
    : null;
  const [earning, setEarning] = useState<PublicEarningResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchPublicEarning(profile.profile.userId, characterIdForEarning)
      .then((r) => { if (!cancelled) setEarning(r); })
      .catch(() => { /* unranked / not-found / network, hide the chip */ });
    return () => { cancelled = true; };
  }, [profile.profile.userId, characterIdForEarning]);
  // The identity's Eidolon Tamer familiar, shown as a small profile card.
  // Public-view (no stats/economy); null = no familiar (or hidden/error).
  const [familiar, setFamiliar] = useState<EidolonProfileSummary | null>(null);
  const [patState, setPatState] = useState<"idle" | "busy" | "done" | "cooldown">("idle");
  useEffect(() => {
    let cancelled = false;
    const scope = characterIdForEarning ? "character" : "user";
    const ownerId = characterIdForEarning ?? profile.profile.userId;
    void fetchEidolonSummary(scope, ownerId).then((s) => { if (!cancelled) { setFamiliar(s); setPatState("idle"); } });
    return () => { cancelled = true; };
  }, [profile.profile.userId, characterIdForEarning]);
  // Patting is a "someone else cares" gesture, so it's only offered on
  // another player's profile (never your own identities).
  const myId = useChat((s) => s.me?.id ?? null);
  const canPatFamiliar = myId !== null && myId !== profile.profile.userId;
  const doPat = async () => {
    if (patState !== "idle") return;
    setPatState("busy");
    try {
      const scope = characterIdForEarning ? "character" : "user";
      await patFamiliar(scope, characterIdForEarning ?? profile.profile.userId);
      setPatState("done");
    } catch (e) {
      setPatState(e instanceof ArcadeError && e.status === 429 ? "cooldown" : "idle");
    }
  };
  const freeformConfig = useMemo(() => {
    const json = earning?.freeformBorderConfigJson;
    if (!json) return null;
    const parsed = parseFreeformBorderConfig(json);
    return Object.keys(parsed).length > 0 ? parsed : null;
  }, [earning?.freeformBorderConfigJson]);
  // Avatar crop lives on the profile payload; BorderedAvatar applies
  // the zoom + pan when it's non-default. Declared inside ProfileBody
  // because the outer ProfileModal hoisted-declaration was out of
  // scope here and crashed the render. See `profile.ts`'s
  // `AvatarCrop` shape for the field semantics.
  const avatarCrop = profile.profile.avatarCrop;
  // Tap-to-zoom state for the Collection / Pets pin sections. Null
  // when nothing is zoomed; an entry shape (same row the pin
  // rendered) when a pin is clicked. Closes on click anywhere or
  // Esc (handled inside CollectionPinZoom). Lives in ProfileBody
  // because both pin sections are inside this scope.
  const [zoomedPin, setZoomedPin] = useState<
    | { itemKey: string; name: string; namePlural: string | null; description: string; iconUrl: string | null }
    | null
  >(null);
  // Mobile vs desktop both render this header, with two diverging
  // treatments triggered by the `sm:` breakpoint (640px):
  //   - mobile (<640px): tighter padding, smaller avatar (`lg`=64px
  //     portrait / 96px frame), inline meta line (no XP/currency
  //     chips), and the Message/Whisper/Ignore action set lives in a
  //     full-width segmented bar BELOW the avatar/content row so the
  //     primary actions are thumb-reachable and the buttons line up
  //     edge-to-edge with the band.
  //   - desktop (≥640px): original layout preserved, XL avatar,
  //     XP/Currency as the prominent chip pair, action buttons inline
  //     beneath the meta.
  const hasActions = !!(onWhisper || onMessage || onIgnore || onBlock || activeCharacterAction || canReport);
  // Action-button ink, made legible against the hero band SPECIFICALLY.
  // The band is a solid `bg-keep-panel`, and the pills/segments render with
  // transparent fills directly on it — so their semantic colors must be
  // lifted against the PANEL color, not `theme.bg` (which is all
  // `legibleThemePalette` targets). Without this the icons vanish on themes
  // whose panel and bg luminance diverge, or under glass / profile-BG-image
  // surfaces where the band shows through. `legibleAgainstBg` preserves each
  // hue while guaranteeing contrast, so Message/Whisper stay action-tinted,
  // Ignore stays accent, and Block stays its system red.
  const ownerTheme = profile.profile.theme;
  const bandHex = ownerTheme.panel;
  const lp = legibleThemePalette(ownerTheme);
  // Target 4.5:1 (not 3.0) — these are thin icon strokes, which need more
  // contrast than large UI shapes to stay visible on a near-white panel.
  const inkAction = legibleAgainstBg(lp.action, bandHex, 4.5);
  const inkNeutral = legibleAgainstBg(lp.text, bandHex, 4.5);
  const inkAccent = legibleAgainstBg(lp.accent, bandHex, 4.5);
  const inkSystem = legibleAgainstBg(lp.system, bandHex, 4.5);
  // Profile banner, the URL slot the owner equipped via the Flair
  // tab. Renders as a 3:1 hero strip ABOVE the existing avatar/name
  // hero band. Falls through to nothing when the URL is null (slot
  // empty, cosmetic not owned, or admin cleared an abusive link).
  const bannerUrl = profile.profile.profileBannerUrl?.trim() ?? "";
  return (
    <>
      {bannerUrl ? (
        // Standalone hero strip - desktop only. On mobile the same
        // banner image gets re-used as the hero band's background
        // (see the absolute-positioned `<img>` inside the hero band
        // below) so we don't burn 220px of precious mobile vertical
        // space on a separate banner strip.
        <div className="hidden shrink-0 overflow-hidden border-b border-keep-rule bg-keep-panel sm:block">
          {/* Adaptive sizing: full-width, natural aspect ratio up to a
              `max-h-[220px]` ceiling. Wide banner-shaped uploads (3:1
              and wider) render at their true proportions and stay
              under the cap on typical modal widths. Off-spec uploads
              (squares, portrait phone screenshots) hit the ceiling
              and `object-cover` center-crops a horizontal slice so the
              banner stays modal-friendly without distorting the image.
              A previous version used `aspect-[3/1]` which aggressively
              cropped anything non-banner-shaped; a follow-up bumped
              the cap to 40vh which let the banner dominate ~half the
              modal on wide desktops, 220px is the sweet spot where
              the strip reads as a hero band, not the whole hero.
              onError hides the img on a broken link so visitors don't
              see the browser's "missing image" icon. */}
          <img
            src={bannerUrl}
            alt=""
            loading="lazy"
            className="block max-h-[220px] w-full object-cover object-center"
            onError={(e) => {
              const el = e.currentTarget as HTMLImageElement;
              el.style.display = "none";
            }}
          />
        </div>
      ) : null}
      {/* Hero band - always visible, themed with the owner's panel color.
          Outer flex-col so the mobile action bar can sit underneath
          the avatar/content row without breaking the desktop flex-row.
          `relative` so the mobile banner backdrop + scrim below can
          absolute-position behind the content. */}
        <div className="relative flex shrink-0 flex-col border-b border-keep-rule bg-keep-panel">
        {/* Mobile banner backdrop + scrim. The owner's profile banner
            doubles as the hero band's background on mobile (sm:hidden)
            so we don't burn 220px of vertical space on a dedicated
            banner strip on a phone. The scrim is `bg-keep-bg/75`,
            the theme's bg color at 75% opacity, which naturally reads
            dark on dark themes and light on light themes, keeping the
            avatar / name / chips legible over whatever image the user
            picked. `pointer-events-none` so the scrim doesn't steal
            clicks from anything that might extend behind it. */}
        {bannerUrl ? (
          <>
            <img
              aria-hidden
              src={bannerUrl}
              alt=""
              loading="lazy"
              className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center sm:hidden"
              onError={(e) => {
                const el = e.currentTarget as HTMLImageElement;
                el.style.display = "none";
              }}
            />
            {/* Scrim color is applied via inline style (NOT a
                `bg-keep-bg/*` class) on purpose: the glass theme's
                stylesheet matches `[class*="bg-keep-bg"]` and stamps
                a heavy `backdrop-filter: blur(18px) saturate(1.3)`
                onto anything carrying that class, which on top of a
                translucent overlay reduced the banner to a featureless
                blur. Inline `style` keeps the theme-aware bg-color
                tint (var(--keep-bg) is dark on dark themes, light on
                light themes) WITHOUT triggering the glass blur. The
                0.45 opacity is enough to keep the avatar / name /
                chips readable while letting the banner read through. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 sm:hidden"
              style={{ backgroundColor: "rgb(var(--keep-bg) / 0.45)" }}
            />
          </>
        ) : null}
        {/* `items-center` on the hero so the rank/name/account stack
            sits at the avatar's vertical midline. The avatar (xl =
            124px + frame container) is taller than the three text
            rows; with `items-start` the text floated at the top and
            left a tall empty gutter under it. Mobile drops to `lg`
            avatar (96px frame) so the hero doesn't eat half the
            viewport. `relative` here so the content sits ABOVE the
            mobile banner backdrop + scrim sibling above. */}
        <div className="relative flex items-center gap-3 px-3 py-3 sm:gap-4 sm:px-5 sm:py-4">
          {/* Profile hero portrait uses BorderedAvatar so the user's
              equipped rank border frames the avatar exactly the way
              it does in chat / forum / Earning catalog. `xl` slot
              gives a 124px portrait inside a 186px frame container.
              The frame only renders when the user has both reached
              tier IV AND equipped that rank's border via the Earning
              dashboard. Dual-render so mobile gets a tighter `lg`
              footprint (64px / 96px framed) and desktop keeps the
              full showcase size, BorderedAvatar's size is fixed at
              render time so a single instance can't responsively
              swap. The cached image bytes are reused across both
              renders. */}
          <div className="sm:hidden">
            <BorderedAvatar
              avatarUrl={avatar}
              avatarCrop={avatarCrop}
              name={name}
              size="lg"
              borderRankKey={earning?.selectedBorderRankKey ?? null}
              freeformBorderKey={earning?.selectedFreeformBorderKey ?? null}
              freeformConfig={freeformConfig}
            />
          </div>
          <div className="hidden sm:block">
            <BorderedAvatar
              avatarUrl={avatar}
              avatarCrop={avatarCrop}
              name={name}
              size="xl"
              borderRankKey={earning?.selectedBorderRankKey ?? null}
              freeformBorderKey={earning?.selectedFreeformBorderKey ?? null}
              freeformConfig={freeformConfig}
            />
          </div>
          <div className="min-w-0 flex-1">
            {/* Name + gender glyph on the top line; XP + Currency
                chips on their OWN row beneath the name on tight
                viewports. The earlier layout had everything in a
                single flex-wrap, which meant one chip could land on
                the name line while the other wrapped to the next
                row, visually unbalanced and prone to clipping the
                name. Splitting into two siblings (with the chips in
                their own flex container) keeps the chips together
                regardless of viewport width while still wrapping
                cleanly when the name is long. */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Name style cosmetics surface here too, a styled name
                  is a show-off cosmetic, not just chat decoration, so
                  the profile hero paints it the same way chat does.
                  Falls back to plain text when no style is equipped.
                  Wrapped in font-action so the hero's display font
                  still applies to non-styled glyphs (the .ns-* style
                  classes override face/weight as needed). */}
              <h2 className="font-action text-xl tracking-wide sm:text-2xl" title={name}>
                <StyledName
                  displayName={name}
                  styleKey={profile.profile.nameStyleKey}
                  config={profile.profile.nameStyleConfig}
                />
              </h2>
              <span
                aria-hidden
                className="text-base leading-none sm:text-lg"
                title={genderGlyph(gender).title}
                style={{ color: genderGlyph(gender).color }}
              >
                {genderGlyph(gender).icon}
              </span>
              {/* Desktop rank, sits inline with the name (lg+) with a
                  pipe separator. Mobile keeps its own dedicated rank
                  lockup row below the name (the `lg:hidden` block
                  further down); the right-edge desktop lockup that
                  used to live next to the close button was retired
                  in favor of this inline placement. Flex-wrap on the
                  parent lets the rank chip drop to the next line if
                  the name + meta line gets long. */}
              {earning?.rankKey && earning.tier != null ? (
                <div className="hidden items-center gap-1.5 lg:flex">
                  <span aria-hidden className="text-keep-muted/60">|</span>
                  <RankSigil rankKey={earning.rankKey} tier={earning.tier} size="md" />
                  <span className="font-action text-sm uppercase tracking-widest text-keep-text">
                    {earning.rankName ?? earning.rankKey}
                    {earning.tierLabel ? <span className="ml-1 text-keep-muted">{earning.tierLabel}</span> : null}
                  </span>
                </div>
              ) : null}
            </div>
            {/* Earning chips (desktop). Live on their own row below the
                name so they never split across rows (XP on the name
                line, Currency wrapped, the broken UX before this
                change). Hidden on mobile in favor of an inline meta
                line that wraps everything together. */}
            {earning?.xp != null || earning?.currency != null ? (
              <div className="mt-1 hidden flex-wrap items-center gap-2 sm:flex">
                {earning?.xp != null ? (
                  <span
                    className="inline-flex h-8 items-center gap-1 rounded border border-keep-rule bg-keep-bg/60 px-2 text-sm uppercase tracking-widest text-keep-muted"
                    title="Experience"
                  >
                    <span className="font-semibold tabular-nums text-keep-text">{earning.xp.toLocaleString()}</span>
                    <span>XP</span>
                  </span>
                ) : null}
                {earning?.currency != null ? (
                  <span
                    className="inline-flex h-8 items-center gap-1 rounded border border-keep-rule bg-keep-bg/60 px-2 text-sm"
                    title="Currency"
                  >
                    <img
                      src="/assets/earning/cache_pouch.png"
                      alt=""
                      aria-hidden
                      className="select-none"
                      style={{ width: "1.75rem", height: "1.75rem" }}
                      draggable={false}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <span className="font-semibold tabular-nums text-keep-text">{earning.currency.toLocaleString()}</span>
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* Mobile rank lockup, uses the gem variant (same icon
                set chat lines + the userlist render) so the rank
                reads as the compact "identity tag" it does
                everywhere else on the site. The tier chevron (used
                on desktop's xl lockup) is too detailed for the
                tight inline footprint here. `mb-0` keeps it from
                pushing the meta line down; hidden at lg+ where the
                desktop column-right lockup takes over. */}
            {earning?.rankKey && earning.tier != null ? (
              <div className="mb-0 mt-1 flex items-center gap-1.5 lg:hidden">
                <RankSigil rankKey={earning.rankKey} tier={earning.tier} size="md" variant="gem" />
                <span className="font-action text-[11px] uppercase tracking-widest text-keep-text sm:text-xs">
                  {earning.rankName ?? earning.rankKey}
                  {earning.tierLabel ? <span className="ml-1 text-keep-muted">{earning.tierLabel}</span> : null}
                </span>
              </div>
            ) : null}
            {/* Meta line. Mobile inlines XP/currency alongside account
                kind, role, joined date, and the /p/slug copy chip so
                everything fits one wrapping block at `text-[11px]`.
                Desktop keeps the original `text-xs` cadence with
                XP/currency as their own chips above this row. */}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] uppercase tracking-widest text-keep-muted sm:text-xs">
              {/* XP + currency inline (mobile only, desktop has the
                  chip pair above). Hidden when the user hasn't earned
                  anything yet so the meta line doesn't lead with a
                  zero. */}
              {earning?.xp != null ? (
                <span className="sm:hidden">
                  <span className="font-semibold tabular-nums normal-case tracking-normal text-keep-text">{earning.xp.toLocaleString()}</span> XP
                </span>
              ) : null}
              {earning?.currency != null ? (
                <span className="inline-flex items-center gap-1 sm:hidden">
                  <img
                    src="/assets/earning/cache_pouch.png"
                    alt=""
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 select-none"
                    draggable={false}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                  <span className="font-semibold tabular-nums normal-case tracking-normal text-keep-text">{earning.currency.toLocaleString()}</span>
                </span>
              ) : null}
              {(earning?.xp != null || earning?.currency != null) ? (
                <span className="sm:hidden" aria-hidden>·</span>
              ) : null}
              {profile.kind === "character" ? (
                <span>Character</span>
              ) : (
                <span>
                  Master account
                  {/* Account-level role marker - only meaningful on the master
                      profile (characters are owned by a master that already
                      shows it). Site admins/mods are surfaced so visitors can
                      tell who's staff at a glance. */}
                  {isAdminRole(profile.profile.role) ? (
                    <span className="ml-1 italic text-keep-action">· Admin</span>
                  ) : profile.profile.role === "mod" ? (
                    <span className="ml-1 italic text-keep-action">· Global Moderator</span>
                  ) : profile.profile.role === "trusted" ? (
                    <span className="ml-1 italic text-keep-system" title="Trusted account - elevated rate limits earned through participation.">· Trusted</span>
                  ) : null}
                  {/* Scriptorium passive author tier, surfaces alongside
                      the role chip. Counted from the master account's
                      published-story count; same value on master and
                      character views. */}
                  {profile.profile.scriptoriumAuthor ? (
                    <span
                      className={`ml-1 italic ${scriptoriumTierClass(profile.profile.scriptoriumAuthor.tier)}`}
                      title={`${profile.profile.scriptoriumAuthor.publishedStories} ${profile.profile.scriptoriumAuthor.publishedStories === 1 ? "story" : "stories"} published in the Scriptorium`}
                    >
                      · {scriptoriumTierLabel(profile.profile.scriptoriumAuthor.tier)}
                    </span>
                  ) : null}
                </span>
              )}
              {createdAt ? (
                <>
                  <span aria-hidden>·</span>
                  <span>joined {new Date(createdAt).toLocaleDateString()}</span>
                </>
              ) : null}
              <span aria-hidden>·</span>
              <CopyProfileLink name={name} />
              <span aria-hidden>·</span>
              {/* Paste-ready identity token. `@cid:<id>` for a character,
                  `@id:<userId>` for a master/OOC account — drop it straight
                  into /whisper, /currency send, /friend, /title, etc. (names
                  with spaces can't be typed as command args). */}
              <CopyIdentityToken token={isChar ? `@cid:${profile.profile.id}` : `@id:${profile.profile.userId}`} />
              {/* Visitor counter, renders only when the owner owns
                  `flair_profile_visitors` AND has flipped visibility
                  on. Returns null otherwise, so the meta line is
                  unchanged for everyone else. */}
              <ProfileVisitorsChip
                profileName={isChar ? profile.profile.name : profile.profile.username}
                characterId={isChar ? profile.profile.id : null}
              />
            </div>
            {/* Mod-only attribution + id-copy chips. Two gates:
                  - `ownerUsername` is shipped server-side only to
                    mod+ viewers on character profiles, so its very
                    presence proves the viewer is privileged.
                  - For master profiles, the server doesn't ship a
                    parallel marker; we gate the row on the viewer's
                    own role read from the chat store (`isModViewer`).
                Either condition surfaces the row; if both are absent
                we render nothing so non-mod viewers see no chrome.
                The MOD chip is a visual reminder that this is
                privileged info, don't screen-share it carelessly. */}
            {(profile.kind === "character" && profile.profile.ownerUsername) || isModViewer ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-keep-muted">
                <span
                  className="rounded border border-keep-accent/40 bg-keep-accent/10 px-1 py-0 text-[9px] font-semibold uppercase tracking-widest text-keep-accent"
                  title="Visible to moderators only."
                >
                  Mod
                </span>
                {profile.kind === "character" && profile.profile.ownerUsername ? (
                  <span className="inline-flex items-center gap-1">
                    <span>Owned by</span>
                    {onOpenProfile ? (
                      <button
                        type="button"
                        onClick={() => onOpenProfile(profile.profile.ownerUsername!)}
                        className="font-semibold text-keep-action hover:underline"
                        title={`Open ${profile.profile.ownerUsername}'s master profile`}
                      >
                        {profile.profile.ownerUsername}
                      </button>
                    ) : (
                      <span className="font-semibold text-keep-text">{profile.profile.ownerUsername}</span>
                    )}
                  </span>
                ) : null}
                {/* Id chips. User id always renders for mod viewers;
                    character id only on character profiles. Both copy
                    the full nanoid to the clipboard on click, the
                    label "user id" / "character id" stays distinct so
                    a mod copying into /disable vs /ban-by-character
                    can't grab the wrong one. */}
                {isModViewer ? (
                  <>
                    <CopyId label="user id" id={profile.profile.userId} />
                    {profile.kind === "character" ? (
                      <CopyId label="char id" id={profile.profile.id} />
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
            {/* Moderator actions: edit this user's bio, and issue/lift a
                timed account ban (with the ban status + history for review).
                Each affordance hides unless the viewer holds the matching
                permission. */}
            {canEditBio || canBanAccount ? (
              <ProfileModPanel
                profile={profile}
                isChar={isChar}
                editTarget={
                  isChar
                    ? { kind: "character", characterId: (profile.profile as { id: string }).id }
                    : { kind: "master", userId: profile.profile.userId }
                }
                canEditBio={canEditBio}
                canBan={canBanAccount}
                onModerated={onModerated}
              />
            ) : null}
            {/* Action row, desktop only. Mobile moves the same
                actions into the full-width segmented bar that sits
                below the avatar/content row (see further down). Self-
                views (App suppresses whisper/ignore) still surface
                this when there's a Switch / Disable action to take. */}
            {hasActions ? (
              <div className="mt-3 hidden flex-wrap gap-1.5 text-xs sm:flex">
                {activeCharacterAction ? (
                  <button
                    type="button"
                    onClick={activeCharacterAction.onClick}
                    title="Change your active identity - chat name and theme update immediately."
                    style={{ color: inkAction, borderColor: inkAction }}
                    className="keep-button rounded border px-2 py-1 hover:bg-keep-action/10"
                  >
                    {activeCharacterAction.label}
                  </button>
                ) : null}
                {onMessage ? (
                  <button
                    type="button"
                    onClick={() => onMessage(profile.profile.userId, name, avatar)}
                    title="Open a direct message thread with this user."
                    aria-label="Message"
                    style={{ color: inkAction, borderColor: inkAction }}
                    className={ACT_PILL_ACTION}
                  >
                    <MessageSquare className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
                {onWhisper ? (
                  <button
                    type="button"
                    onClick={() => onWhisper(name)}
                    title="Send a one-off private message in chat."
                    aria-label="Whisper"
                    style={{ color: inkNeutral, borderColor: inkNeutral }}
                    className={ACT_PILL_NEUTRAL}
                  >
                    <Send className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
                {onIgnore ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Ignore ${name}? You won't see their messages until you /unignore.`)) {
                        onIgnore(name);
                      }
                    }}
                    title="Hide this user's messages from you (one-way, reversible)."
                    aria-label="Ignore"
                    style={{ color: inkAccent, borderColor: inkAccent }}
                    className={ACT_PILL_ACCENT}
                  >
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
                {onBlock ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Block ${name}? You won't see each other anywhere - chat, userlist, whispers, DMs, friends, or search. Undo later in Profile -> Privacy.`)) {
                        onBlock(name);
                      }
                    }}
                    title="Block: you and this user become invisible to each other everywhere."
                    aria-label="Block"
                    style={{ color: inkSystem, borderColor: inkSystem }}
                    className={ACT_PILL_SYSTEM}
                  >
                    <Ban className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
                {/* Report: any signed-in viewer (not the owner) can flag a
                    profile for moderator review (e.g. explicit imagery). */}
                {canReport ? (
                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    title="Report this profile for moderator review"
                    aria-label="Report profile"
                    className={ACT_PILL_ACCENT}
                  >
                    <Flag className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {/* Disposition used to live as a header sidecar here; it
              now lives in the body as a 25%-width right-side column
              beside the Stats / Activity block, so the hero stays
              focused on identity + rank and the personality bars get
              their own deliberate column of vertical space. Mobile
              and desktop both render the body version. The `ml-auto`
              that this slot used to enforce is gone too, the rank
              inline above already pushes the close button right via
              its own flex math. */}
          {/* `self-start` anchors the close affordance to the top of
              the vertically-centered hero so the hero text can ride
              the avatar's midline without dragging the close button
              with it. */}
          <CloseButton onClick={onClose} className="ml-auto self-start" />
        </div>
        {/* Mobile action bar, full-width segmented row pinned to the
            bottom of the hero band on phones. Each visible button
            takes an equal share via `flex-1`, separator borders sit
            between them, and the row carries a top border so it reads
            as the footer of the band. Hidden on `sm+` where the
            inline action row inside the content column takes over.
            Skipped entirely when there are no actions to offer (e.g.
            a self-view with no Switch action). */}
        {hasActions ? (
          <div className="relative flex border-t border-keep-rule text-sm sm:hidden">
            {activeCharacterAction ? (
              <button
                type="button"
                onClick={activeCharacterAction.onClick}
                title="Change your active identity - chat name and theme update immediately."
                style={{ color: inkAction }}
                className="keep-button flex-1 border-r border-keep-rule px-2 py-2.5 hover:bg-keep-action/10"
              >
                {activeCharacterAction.label}
              </button>
            ) : null}
            {onMessage ? (
              <button
                type="button"
                onClick={() => onMessage(profile.profile.userId, name, avatar)}
                title="Open a direct message thread with this user."
                aria-label="Message"
                style={{ color: inkAction }}
                className={`${ACT_SEG_ACTION} ${ACT_SEG_DIVIDER}`}
              >
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            {onWhisper ? (
              <button
                type="button"
                onClick={() => onWhisper(name)}
                title="Send a one-off private message in chat."
                aria-label="Whisper"
                style={{ color: inkNeutral }}
                className={`${ACT_SEG_NEUTRAL} ${ACT_SEG_DIVIDER}`}
              >
                <Send className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            {onIgnore ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Ignore ${name}? You won't see their messages until you /unignore.`)) {
                    onIgnore(name);
                  }
                }}
                title="Hide this user's messages from you (one-way, reversible)."
                aria-label="Ignore"
                style={{ color: inkAccent }}
                className={`${ACT_SEG_ACCENT} ${ACT_SEG_DIVIDER}`}
              >
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            {onBlock ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Block ${name}? You won't see each other anywhere - chat, userlist, whispers, DMs, friends, or search. Undo later in Profile -> Privacy.`)) {
                    onBlock(name);
                  }
                }}
                title="Block: you and this user become invisible to each other everywhere."
                aria-label="Block"
                style={{ color: inkSystem }}
                // Right-border separator only when the Report segment follows;
                // otherwise Block is the last segment and gets no trailing rule.
                className={`${ACT_SEG_SYSTEM}${canReport ? ` ${ACT_SEG_DIVIDER}` : ""}`}
              >
                <Ban className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            {canReport ? (
              <button
                type="button"
                onClick={() => setReportOpen(true)}
                title="Report this profile for moderator review"
                aria-label="Report profile"
                style={{ color: inkAccent }}
                className={ACT_SEG_ACCENT}
              >
                <Flag className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
        </div>

        {reportOpen ? (
          <ReportProfileModal
            targetUserId={profile.profile.userId}
            targetCharacterId={isChar ? (profile.profile as { id: string }).id : null}
            targetName={name}
            onClose={() => setReportOpen(false)}
          />
        ) : null}

        {/* Profile-flair surfaces, the quote marquee (when the
            owner has flair_profile_marquee + configured quotes)
            sits between the hero band and the scrolling body so
            it reads as part of the profile chrome. The visitor
            chip is intentionally inline in the hero meta further
            up; this block only owns the wide strip + the side
            effect of logging the view. */}
        <ProfileMarquee
          profileName={isChar ? profile.profile.name : profile.profile.username}
          characterId={isChar ? profile.profile.id : null}
        />
        <ProfileViewTracker
          profileName={isChar ? profile.profile.name : profile.profile.username}
          characterId={isChar ? profile.profile.id : null}
          profileUserId={profile.profile.userId}
        />

        {/* Body - scrolls independently of the hero */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {isCompletelyBlank ? (
            <EmptyProfile name={name} kind={isChar ? "character" : "master"} />
          ) : (
            <>
              {titles.length > 0 ? (
                <Section title="Bonds">
                  <ul className="flex flex-wrap gap-1.5 text-sm">
                    {titles.map((t) => (
                      <li
                        key={t.id}
                        className="rounded border border-keep-rule/60 bg-keep-panel/60 px-2 py-0.5"
                      >
                        {onOpenProfile ? (
                          <button
                            type="button"
                            onClick={() => onOpenProfile(t.other.displayName)}
                            className="font-medium hover:underline"
                            title={`View ${t.other.displayName}'s profile`}
                          >
                            {t.text}
                          </button>
                        ) : (
                          <span className="font-medium">{t.text}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {familiar ? (
                <Section title="Familiar">
                  <div className="flex items-center gap-3 rounded border border-keep-rule/60 bg-keep-panel/50 px-3 py-2">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-keep-rule/50 bg-keep-bg/60 text-2xl">
                      {familiar.kind === "pet" && familiar.petIconUrl ? (
                        <img src={familiar.petIconUrl} alt="" className="max-h-full max-w-full object-contain" />
                      ) : (
                        <span aria-hidden>{familiar.dead ? "💤" : "🥚"}</span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">
                        {familiar.variant ? <span className="text-keep-action" title="Prismatic">✦ </span> : null}
                        {familiar.name}
                        {familiar.streakCount > 0 && !familiar.dead ? (
                          <span className="ml-1.5 text-xs text-keep-muted" title={`${familiar.streakCount}-day care streak`}>🔥{familiar.streakCount}</span>
                        ) : null}
                      </div>
                      <div className="text-xs text-keep-muted">
                        Lv {familiar.level} · {familiar.dead ? "dormant" : familiar.moodLabel}
                        {familiar.kind === "species" && familiar.speciesId ? ` · ${familiar.speciesId}` : familiar.kind === "pet" ? " · pet" : ""}
                      </div>
                    </div>
                    {canPatFamiliar && !familiar.dead ? (
                      <button
                        type="button"
                        onClick={() => void doPat()}
                        disabled={patState !== "idle"}
                        className="ml-auto shrink-0 self-center rounded border border-keep-action/50 px-2.5 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/10 disabled:opacity-50"
                        title="Pat this familiar — a little joy, once a day"
                      >
                        {patState === "done" ? "Patted ♥" : patState === "cooldown" ? "Patted today" : patState === "busy" ? "…" : "Pat ♥"}
                      </button>
                    ) : null}
                  </div>
                </Section>
              ) : null}

              {/* Per migration 0187 the Worlds section is scoped to
                  the IDENTITY being viewed: a character profile
                  shows only that character's memberships, a master
                  profile shows only the master's OOC memberships.
                  This closes the leak where character profiles
                  previously displayed the master's world list. */}
              <WorldsSection
                userId={profile.profile.userId}
                identityFilter={profile.kind === "character" ? profile.profile.id : "ooc"}
                onOpenWorld={onOpenWorld}
              />


              {/* Two-column body block: Stats / Attributes / Activity
                  share a 3/4-width left column, Disposition takes the
                  remaining 1/4 on the right. Below lg the grid
                  collapses and everything stacks in source order
                  (Stats → Attributes → Activity → Disposition). The
                  left column owns its own `mb-5` rhythm via the
                  Section component; the grid `gap-x-5` separates the
                  two columns on desktop without doubling padding. */}
              <div className="mb-5 grid grid-cols-1 gap-x-5 lg:grid-cols-4">
                <div className="lg:col-span-3">
                  {statEntries.length > 0 ? (
                    <Section title="Stats">
                      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                        {statEntries.map(([k, v]) => (
                          <div
                            key={k}
                            className="flex justify-between gap-3 border-b border-keep-rule/40 py-1"
                          >
                            <dt className="text-sm uppercase tracking-widest text-keep-text/80">{k}</dt>
                            <dd className="truncate text-right text-sm">{v}</dd>
                          </div>
                        ))}
                      </dl>
                    </Section>
                  ) : null}

                  <AttributesSection stats={stats} bypassVisibility={bypassVisibility} />

                  {/* Activity counters, lifetime totals computed server-side
                      at fetch time. Scoped per identity: character profile
                      shows that character's posts; master profile shows
                      everything authored under the user account. Zero is a
                      legitimate value (brand-new account, never posted) so
                      the section always renders rather than hiding when
                      totals are 0, "0 posts" IS information.

                      Per-metric privacy: when the user has the matching
                      hide-flag set on /me/profile, the server returns null
                      for that field and we render "private" instead of the
                      number. The tile still renders so the user's intent
                      ("I am opting out") is visible to viewers, silently
                      hiding the whole tile would read as "they never
                      posted any forum topics" which is a different claim. */}
                  <Section title="Activity">
                    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                      {[
                        { key: "chat", label: "Chat messages", value: profile.profile.metrics.chatMessages },
                        { key: "topics", label: "Forum topics", value: profile.profile.metrics.forumTopics },
                        { key: "replies", label: "Forum replies", value: profile.profile.metrics.forumReplies },
                      ].map((m) => {
                        const isPrivate = m.value === null;
                        return (
                          <div
                            key={m.key}
                            className="flex flex-col items-center gap-0.5 rounded border border-keep-rule/40 bg-keep-bg/40 px-2 py-1.5"
                          >
                            <dd
                              className={
                                isPrivate
                                  ? "text-sm uppercase tracking-widest text-keep-muted"
                                  : "font-action text-xl tabular-nums text-keep-text"
                              }
                              title={isPrivate ? `${m.label} hidden by user` : undefined}
                            >
                              {isPrivate ? "private" : m.value!.toLocaleString()}
                            </dd>
                            <dt className="text-xs uppercase tracking-widest text-keep-text/80">
                              {m.label}
                            </dt>
                          </div>
                        );
                      })}
                    </dl>
                  </Section>
                </div>

                {/* Disposition column, 25% on desktop, full-width
                    stacked below on mobile. Hidden entirely when the
                    character has no visible axes; wrapping in the
                    standard Section gives it the same header rhythm
                    as Stats/Activity. VibeSection's compact variant
                    drops its own Section chrome (so we don't
                    double-nest) and lays out axes in a single
                    column. */}
                {stats && collectVibeAxes(stats, bypassVisibility).length > 0 ? (
                  <div className="lg:col-span-1">
                    <Section title="Disposition">
                      <VibeSection
                        stats={stats}
                        bypassVisibility={bypassVisibility}
                        variant="compact"
                      />
                    </Section>
                  </div>
                ) : null}
              </div>

              {links.length > 0 ? (
                <Section title="Links">
                  <ul className="flex flex-wrap gap-1.5 text-sm">
                    {links.map((l) => (
                      <li key={l.id}>
                        <LinkChip link={l} />
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {/* Collection + Pets sit ABOVE the bio because they read
                  as the visual marquee of the profile, a glance-able
                  showcase of what the identity owns, the way a pinned
                  Tweet or a "now playing" widget tops a personal page.
                  The bio is the long-form prose below it. Each section
                  is hidden when empty so a fresh profile doesn't show
                  empty rails. */}

              {/* Collection showcase, pinned items from the identity's
                  10-slot Collection. Each identity (OOC + each
                  character) has its own pin set; viewing this profile
                  shows ONLY this identity's pins (a character profile
                  never inherits the OOC's pins and vice versa).
                  Sparse, a user can pin slots 0, 3, 7 and leave the
                  rest empty; we collapse empty slots so the renderer
                  shows only filled tiles. Section hidden entirely
                  when nothing is pinned. */}
              {/* Collection + Pets (wide left column) with Library as a narrow
                  right column — mirrors the Stats / Disposition split above so
                  the showcase reads side-by-side on desktop instead of stacking
                  and pushing the bio further down. On mobile the grid collapses
                  to one column and they stack naturally. The whole block hides
                  when nothing is pinned anywhere. */}
              {(profile.profile.collection.length > 0
                || profile.profile.petCollection.length > 0
                || profile.profile.library.length > 0) ? (
                <div className="mb-5 grid grid-cols-1 gap-x-5 lg:grid-cols-4">
                  <div className="lg:col-span-3">
                    {profile.profile.collection.length > 0 ? (
                      <Section title="Collection">
                        {/* Grid (not flex-wrap) so the pinned tiles distribute
                            across the row. 3-up on phones, 5-up on small/medium,
                            8-up on lg+ (the column is 3/4 width here, so 8 keeps
                            the tiles from getting cramped). */}
                        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8">
                          {profile.profile.collection.map((c) => (
                            <li key={c.slot} className="flex justify-center">
                              <CollectionPin entry={c} variant="item" onClick={() => setZoomedPin(c)} />
                            </li>
                          ))}
                        </ul>
                      </Section>
                    ) : null}

                    {/* Pet Collection, separate 5-slot showcase scoped to
                        items with category='pet'. Same identity partitioning
                        as the item collection above. */}
                    {profile.profile.petCollection.length > 0 ? (
                      <Section title="Pets">
                        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
                          {profile.profile.petCollection.map((c) => (
                            <li key={c.slot} className="flex justify-center">
                              <CollectionPin entry={c} variant="pet" onClick={() => setZoomedPin(c)} />
                            </li>
                          ))}
                        </ul>
                      </Section>
                    ) : null}
                  </div>

                  {/* Library (right column), the owner's showcased Scriptorium
                      copies. 2-up in the narrow desktop column (covers are tall
                      2:3), more columns when stacked full-width on mobile. Each
                      cover opens the story in the reader. */}
                  {profile.profile.library.length > 0 ? (
                    <div className="lg:col-span-1">
                      <Section title="Library">
                        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-2">
                          {profile.profile.library.map((b) => (
                            <li key={b.slot} className="flex justify-center">
                              <LibraryPin entry={b} />
                            </li>
                          ))}
                        </ul>
                      </Section>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <Section title="Bio">
                {bio ? (
                  // `USER_HTML_SCOPE_CLASS` is the anchor the server's
                  // `<style>` selector prefix binds to. Without it,
                  // writer-authored CSS like `.list-card { ... }`
                  // (which the server stored as
                  // `.user-html-scope .list-card { ... }`) wouldn't
                  // match anything, the wrapper class is the
                  // contract.
                  <div
                    className={`prose prose-sm max-w-none break-words ${USER_HTML_SCOPE_CLASS}`}
                    dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(bio) }}
                  />
                ) : (
                  <p className="text-sm italic text-keep-muted">
                    {name} hasn't written a bio yet.
                  </p>
                )}
              </Section>

              {/* Additional portraits gallery. Character profiles and
                  master / OOC profiles both render this, the master
                  gallery lives in user_portraits (added in migration
                  0113), the character gallery in character_portraits;
                  both ship the same wire shape so a single component
                  handles both. The empty state still renders the
                  section heading + a hint pointing at the editor so
                  the feature stays discoverable on fresh profiles. */}
              <PortraitGallery
                portraits={profile.profile.portraits}
                alt={name}
                canModerate={canFlagGallery}
                onToggleNsfw={async (portraitId, nextNsfw) => {
                  await setPortraitNsfw(modScope, portraitId, nextNsfw);
                  onModerated?.();
                }}
              />

              {/* Character journal (public entries only - private ones are
                  filtered server-side and only ever appear in the owner's
                  editor). Reads chronologically (oldest first) so a
                  character's diary works as a timeline. */}
              {journal.length > 0 ? (
                <Section title="Journal">
                  <ol className="space-y-3">
                    {journal.map((e) => (
                      <li key={e.id} className="rounded border border-keep-rule/50 bg-keep-panel/30 p-3">
                        <header className="mb-1 flex items-baseline justify-between gap-2">
                          <span className="font-semibold">
                            {e.title || <span className="italic text-keep-muted">untitled</span>}
                          </span>
                          <time className="text-[10px] uppercase tracking-widest text-keep-muted" title={new Date(e.createdAt).toLocaleString()}>
                            {new Date(e.createdAt).toLocaleDateString()}
                          </time>
                        </header>
                        <div
                          className={`prose prose-sm max-w-none break-words ${USER_HTML_SCOPE_CLASS}`}
                          dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(e.bodyHtml) }}
                        />
                      </li>
                    ))}
                  </ol>
                </Section>
              ) : null}
            </>
          )}
        </div>
      {/* Tap-to-zoom overlay. Mounted at the fragment's end so it's
          a sibling of the scrolling body, fixed positioning + z:60
          puts it above the profile card (z:50) regardless of where
          it sits in the DOM. Closes on any click, Esc, or when the
          parent modal unmounts. */}
      {zoomedPin ? (
        <ItemZoomView entry={zoomedPin} onClose={() => setZoomedPin(null)} />
      ) : null}
    </>
  );
}

/* ---------- helpers ---------- */

/**
 * Pre-content gate for NSFW profiles. Logged-in viewers (other than the
 * owner / admins, who bypass via parent prop) get a warning splash with a
 * "View Profile" button before the modal renders the body. State lives in
 * the modal mount, so closing + reopening re-prompts (one explicit
 * confirmation per session, not "I clicked once weeks ago").
 */
function NsfwGate({
  name,
  kind,
  onAccept,
  onCancel,
}: {
  name: string;
  kind: "master" | "character";
  onAccept: () => void;
  onCancel: () => void;
}) {
  const subject = kind === "character" ? `${name}'s character profile` : `${name}'s profile`;
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <div aria-hidden className="text-4xl text-keep-accent">⚠</div>
      <h2 className="font-action text-xl">NSFW Profile</h2>
      <p className="max-w-prose text-sm text-keep-text/80">
        {subject} contains content marked <b>NSFW</b>. Do you want to proceed?
        Closing this modal and re-opening will prompt again.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm hover:bg-keep-banner"
        >
          Go back
        </button>
        <button
          type="button"
          onClick={onAccept}
          className="rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-sm font-semibold text-keep-accent hover:bg-keep-accent/20"
        >
          Proceed
        </button>
      </div>
    </div>
  );
}

/**
 * Report-a-profile modal. Any signed-in viewer (not the owner) can flag a
 * profile for moderator review, e.g. explicit imagery / rule-breaking
 * content. Sends a `kind: "profile"` report; the queue surfaces it for
 * mods. A reason is encouraged but optional.
 */
function ReportProfileModal({
  targetUserId,
  targetCharacterId,
  targetName,
  onClose,
}: {
  targetUserId: string;
  targetCharacterId: string | null;
  targetName: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await reportProfile(targetUserId, targetCharacterId, reason);
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Report failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} zIndex={70}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="keep-frame w-[min(440px,96vw)] rounded bg-keep-parchment p-4"
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-action text-lg">Report {targetName}</h3>
          <CloseButton onClick={onClose} />
        </div>
        {done ? (
          <>
            <p className="text-sm text-keep-text/80">
              Thank you. This profile has been sent to the moderators for review.
            </p>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm hover:bg-keep-banner"
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-2 text-xs text-keep-muted">
              Flag this profile for moderator review (e.g. explicit imagery or rule-breaking content).
              Tell us what's wrong, optional but helpful.
            </p>
            <textarea
              value={reason}
              maxLength={500}
              rows={4}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What's wrong with this profile?"
              className="w-full resize-none rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            {err ? <div className="mt-2 text-[11px] text-keep-accent">{err}</div> : null}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm hover:bg-keep-banner disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-sm font-semibold text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
              >
                {busy ? "Reporting…" : "Submit report"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Display label + tint for the Scriptorium passive author tier. Three
 * tiers, three colors, same palette family as the role chips above
 * so the author badge feels native to the profile header. The full
 * `(N stories)` count is in the title attribute (hover/tap), we
 * don't crowd the inline text with it.
 */
function scriptoriumTierLabel(tier: "author" | "storyteller" | "loremaster"): string {
  switch (tier) {
    case "author":      return "Author";
    case "storyteller": return "Storyteller";
    case "loremaster":  return "Loremaster";
  }
}
function scriptoriumTierClass(tier: "author" | "storyteller" | "loremaster"): string {
  switch (tier) {
    case "author":      return "text-sky-300";
    case "storyteller": return "text-amber-300";
    case "loremaster":  return "text-rose-300";
  }
}

/**
 * Inline "Copy link" affordance shown next to the profile metadata. Mirrors
 * the world viewer's Copy Link pattern. Falls back to a window.prompt with
 * the URL when navigator.clipboard isn't available (Safari pre-13.1, some
 * sandboxed iframes).
 */
/**
 * Click-to-copy identity token (`@id:<userId>` / `@cid:<characterId>`). Public
 * (unlike the mod-only raw CopyId): every user can grab it to target this
 * identity in slash-commands without retyping a name (which breaks on spaces).
 */
function CopyIdentityToken({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this token:", token);
    }
  }
  const preview = token.length > 14 ? `${token.slice(0, 12)}…` : token;
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${token} — paste into /whisper, /currency send, /friend, /title, etc.`}
      className="rounded border border-keep-rule/60 px-1 font-mono text-[10px] hover:border-keep-action hover:text-keep-action"
    >
      {copied ? "copied!" : preview}
    </button>
  );
}

function CopyProfileLink({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const url = profileShareUrl(name);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${profileShareUrl(name)}`}
      className="rounded border border-keep-rule/60 px-1 font-mono text-[10px] hover:border-keep-action hover:text-keep-action"
    >
      {copied ? "copied!" : `/p/${name}`}
    </button>
  );
}

/**
 * Mod-only "copy this id" pill. Renders the identity label
 * ("user id", "character id") next to a click-to-copy chip showing
 * an abbreviated prefix of the full id. Tooltip carries the full id
 * so a mod can confirm what they're about to copy before clicking.
 *
 * Used in the moderator attribution row on the profile so mods +
 * admins can grab the raw id for moderation features (kick/ban/disable
 * routes, admin tab lookups, etc.) without bouncing through the URL
 * bar or the admin panel.
 */
function CopyId({ label, id }: { label: string; id: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Same Safari pre-13.1 / sandboxed-iframe fallback CopyProfileLink uses.
      window.prompt("Copy this id:", id);
    }
  }
  // Show only the first segment to keep the chip narrow, full id
  // rides on the title attribute. nanoid ids run ~21 chars, so a
  // 6-char prefix is enough to disambiguate at a glance without
  // crowding the meta row.
  const preview = id.length > 8 ? `${id.slice(0, 6)}…` : id;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-widest text-keep-muted">{label}</span>
      <button
        type="button"
        onClick={copy}
        title={`Copy ${id}`}
        className="rounded border border-keep-rule/60 px-1 font-mono text-[10px] hover:border-keep-action hover:text-keep-action"
      >
        {copied ? "copied!" : preview}
      </button>
    </span>
  );
}

function Avatar({ url, name }: { url: string | null; name: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt={name}
        // Round portrait, matches the chat-line + userlist treatment so
        // the head avatar reads the same everywhere. The "full size"
        // gallery view further down in the modal keeps its natural
        // rectangular crop; only this hero is circular.
        className="h-24 w-24 shrink-0 rounded-full border border-keep-border object-cover sm:h-28 sm:w-28"
      />
    );
  }
  // Initials fallback so blank profiles don't have a gaping hole. Uses
  // the first two letters of the display name; falls back to "?".
  const initials = name
    .split(/\s+/)
    .map((s) => s[0]?.toUpperCase())
    .filter(Boolean)
    .slice(0, 2)
    .join("") || "?";
  return (
    <div
      className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border border-keep-border bg-keep-bg text-2xl font-semibold uppercase tracking-wide text-keep-muted sm:h-28 sm:w-28"
      aria-hidden
      title={`${name} hasn't set a main profile image yet.`}
    >
      {initials}
    </div>
  );
}

/**
 * Owner-set link chip rendered in the Links section. Optional inline colors
 * override the theme defaults (border-keep-rule, bg-keep-panel, text-keep-
 * action). Always opens in a new tab with `noopener noreferrer ugc` per the
 * rest of the codebase's external-link convention.
 */
/**
 * One Collection pin tile rendered on a profile. Shows the item's
 * icon (or a letter-placeholder for items without an iconUrl) at
 * 48px with the item name underneath. Hovering surfaces the item's
 * description as a native tooltip so visitors can read the full
 * blurb without the profile growing taller per pin. */
function CollectionPin({
  entry,
  variant,
  onClick,
}: {
  entry: {
    itemKey: string;
    name: string;
    namePlural: string | null;
    description: string;
    iconUrl: string | null;
    /** Owner-assigned nickname; renders as the primary label with the
     *  catalog `name` shown as a smaller subtitle. Pet pins only. */
    nickname?: string | null;
  };
  /** "item" → 10-slot showcase (caps smaller at lg). "pet" → 5-slot
   *  showcase (caps larger because there's only 5 tiles, so each gets
   *  more real estate). */
  variant: "item" | "pet";
  onClick: () => void;
}) {
  // Two responsive icon-size ramps. Items cap at ~128px (lg); pets cap
  // at ~256px (xl) because the showcase is 5 tiles instead of 10 so
  // each tile has roughly twice the row width to spend. Both ramps
  // start small on mobile so a thumb-friendly grid still fits on a
  // 360px viewport. The icons are centered within the tile (which is
  // grid-cell-sized via w-full), so they look proportional regardless
  // of the cell width.
  const iconCls = variant === "pet"
    ? "h-20 w-20 sm:h-24 sm:w-24 md:h-32 md:w-32 lg:h-48 lg:w-48 xl:h-64 xl:w-64"
    : "h-16 w-16 sm:h-20 sm:w-20 md:h-24 md:w-24 lg:h-32 lg:w-32";

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col items-center gap-1 rounded border border-keep-rule/60 bg-keep-bg/40 p-2 text-center text-[11px] transition hover:border-keep-action hover:bg-keep-banner"
      title={
        entry.nickname
          ? `${entry.nickname} (${entry.name})${entry.description ? `, ${entry.description}` : ""}`
          : entry.description ? `${entry.name}, ${entry.description}` : entry.name
      }
    >
      {entry.iconUrl ? (
        <img
          src={entry.iconUrl}
          alt=""
          loading="lazy"
          className={`rounded border border-keep-rule/40 bg-keep-bg object-contain ${iconCls}`}
        />
      ) : (
        <div
          className={`grid place-items-center rounded border border-keep-rule/40 bg-keep-banner/40 text-keep-muted ${iconCls}`}
          aria-hidden="true"
        >
          <span className="text-2xl font-semibold sm:text-3xl md:text-4xl">{entry.name.slice(0, 1).toUpperCase()}</span>
        </div>
      )}
      {/* When a nickname is set, lead with it; the catalog name (breed
          / species) reads as a smaller subtitle so viewers still know
          what kind of creature it is. No nickname → unchanged from the
          pre-nickname behavior: just the catalog name. */}
      {entry.nickname ? (
        <>
          <span className="line-clamp-1 break-all font-semibold text-keep-text">{entry.nickname}</span>
          <span className="line-clamp-1 break-all text-[10px] italic text-keep-muted">{entry.name}</span>
        </>
      ) : (
        <span className="line-clamp-1 break-all font-semibold text-keep-text">{entry.name}</span>
      )}
    </button>
  );
}

/** A showcased book in the profile Library. A cover tile (or a glyph
 *  fallback) that opens the story in the reader via the store bridge. */
function LibraryPin({ entry }: { entry: ProfileLibraryEntry }) {
  const setOpenStoryReader = useChat((s) => s.setOpenStoryReader);
  return (
    <button
      type="button"
      onClick={() => setOpenStoryReader(entry.storyId)}
      title={`${entry.title} — by ${entry.authorName}`}
      className="flex w-full flex-col items-center gap-1 rounded border border-keep-rule/60 bg-keep-bg/40 p-2 text-center text-[11px] transition hover:border-keep-action hover:bg-keep-banner"
    >
      {entry.coverImageUrl ? (
        <img
          src={entry.coverImageUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="aspect-[2/3] w-full rounded border border-keep-rule/40 bg-keep-bg object-cover"
        />
      ) : (
        <div className="grid aspect-[2/3] w-full place-items-center rounded border border-keep-rule/40 bg-keep-banner/40 text-keep-muted" aria-hidden="true">
          <span className="text-3xl">📖</span>
        </div>
      )}
      <span className="line-clamp-1 break-all font-semibold text-keep-text">{entry.title}</span>
      <span className="line-clamp-1 break-all text-[10px] italic text-keep-muted">by {entry.authorName}</span>
    </button>
  );
}

function LinkChip({ link }: { link: ProfileLink }) {
  const style: React.CSSProperties = {};
  if (link.borderColor) style.borderColor = link.borderColor;
  if (link.bgColor) style.backgroundColor = link.bgColor;
  if (link.textColor) style.color = link.textColor;
  // Custom border keeps a 1px rule visible regardless of theme.
  if (link.borderColor) style.borderWidth = "1px";
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer ugc"
      title={link.url}
      style={style}
      className="inline-block rounded border border-keep-rule bg-keep-panel/60 px-2 py-0.5 font-medium text-keep-action hover:underline"
    >
      {link.title}
    </a>
  );
}

/**
 * Multi-portrait gallery footer for character profiles. Tiles are 88px square
 * thumbnails; clicking a tile swaps a larger preview inline above the strip
 * so viewers can study individual portraits without leaving the modal.
 */
function PortraitGallery({
  portraits,
  alt,
  canModerate = false,
  onToggleNsfw,
}: {
  portraits: CharacterPortrait[];
  alt: string;
  /** Mod viewer with the gallery-flag permission: show a per-image NSFW
   *  toggle on the expanded preview. */
  canModerate?: boolean;
  onToggleNsfw?: (portraitId: string, nextNsfw: boolean) => Promise<void> | void;
}) {
  // Pending state for the moderator NSFW toggle (per active image).
  const [flagBusy, setFlagBusy] = useState(false);
  const [flagErr, setFlagErr] = useState<string | null>(null);
  // Default to the first portrait expanded so visitors see at least
  // one full-size image without having to click a thumbnail. Empty
  // galleries default to null (no expanded view; the thumbnail
  // strip below also renders empty, so only the section heading +
  // empty-state hint is visible).
  const [activeId, setActiveId] = useState<string | null>(() => portraits[0]?.id ?? null);
  // If the portraits prop changes (live profile refetch after the
  // owner edits the gallery, or switching between profiles within
  // the same modal session) and the previously-active id is no
  // longer in the list, snap back to the first available portrait.
  // Keep the user's selection when it's still valid so a viewer
  // who clicked into image #3 doesn't bounce back to #1 on a benign
  // re-render.
  useEffect(() => {
    if (portraits.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (activeId !== null && portraits.some((p) => p.id === activeId)) return;
    setActiveId(portraits[0]!.id);
  }, [portraits, activeId]);
  // Per-portrait SESSION reveal state for censored tiles. Resets on profile
  // re-open (the modal remounts), so a viewer who reveals here doesn't stay
  // revealed after closing and reopening the profile.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  // Per-VIEWER permanent censor marks, persisted in localStorage. The viewer
  // can hide ANY image they dislike (NSFW-flagged or not); it stays censored
  // for them across sessions until they toggle it back. Private to them, the
  // owner/mod `nsfw` flag is separate (see lib/viewerNsfw).
  const [viewerHidden, setViewerHidden] = useState<Set<string>>(loadViewerHiddenImageIds);
  // An image is censored when EITHER the owner/mod flagged it NSFW OR this
  // viewer hid it, and it hasn't been session-revealed.
  const isCensored = (p: CharacterPortrait): boolean =>
    (p.nsfw || viewerHidden.has(p.id)) && !revealed.has(p.id);
  const active = portraits.find((p) => p.id === activeId) ?? null;
  const activeIsCensored = !!active && isCensored(active);

  function reveal(id: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  /** Toggle the viewer's private censor for an image (the red-eye control).
   *  Visible → hide (persisted, re-blurs now). Censored → reveal this
   *  session AND clear any persisted hide so it stays shown next time;
   *  an owner/mod NSFW flag can't be cleared this way (it just reveals
   *  for the session, the existing per-mount behavior). */
  function toggleViewerCensor(p: CharacterPortrait) {
    const censored = isCensored(p);
    if (censored) {
      reveal(p.id);
      if (viewerHidden.has(p.id)) {
        setViewerHidden((prev) => {
          const next = new Set(prev); next.delete(p.id); saveViewerHiddenImageIds(next); return next;
        });
      }
    } else {
      setViewerHidden((prev) => {
        const next = new Set(prev); next.add(p.id); saveViewerHiddenImageIds(next); return next;
      });
      // Drop any session reveal so it re-blurs immediately.
      setRevealed((prev) => {
        if (!prev.has(p.id)) return prev;
        const next = new Set(prev); next.delete(p.id); return next;
      });
    }
  }

  return (
    <div className="mt-4 flex flex-col border-t border-keep-rule/60 pt-3">
      {/* Centered header so the gallery section reads as a unified
          centered block (header → active preview → thumbnails), all
          horizontally aligned. Earlier this h3 was left-aligned, which
          read as disconnected from the 70%-centered preview below. */}
      <h3 className="mb-2 text-center text-xs font-semibold uppercase tracking-widest text-keep-muted">
        Gallery
      </h3>
      {/* Empty-state hint: render the section even when the gallery is
          empty so the feature stays discoverable. Owners reading "No
          additional portraits yet" know to look for the manage path
          (profile editor → Gallery tab); visitors see a clean
          "nothing here" message instead of the section vanishing
          entirely (which made it look like the feature itself was
          missing). */}
      {portraits.length === 0 ? (
        <p className="text-center text-sm italic text-keep-muted">
          No additional portraits yet. Owners can add more via the profile editor's Gallery tab.
        </p>
      ) : null}
      {active ? (
        <div className="order-2 mb-2 flex flex-col items-center gap-1">
          {/* Expanded gallery preview is capped at 70% of the profile
              width and centered, so a tall portrait doesn't dominate
              the modal at every viewport size. The thumbnail strip
              below is the navigation surface, the centered preview
              is for "study one image at a time" without crowding the
              rest of the profile. */}
          {/* w-fit so the wrapper hugs the image's ACTUAL rendered box
              (not a fixed 70% column the image is centered within). The
              red-eye toggle + the censor `inset-0` overlay anchor to this
              wrapper, so without the hug they floated in the letterbox gap
              beside a narrower image. max-w-[70%] still caps a large image;
              the parent's items-center keeps it centered. */}
          <div className="relative w-fit max-w-[70%] overflow-hidden rounded">
            <img
              src={active.url}
              alt={active.label || `${alt} portrait`}
              className={`block max-w-full rounded transition ${
                activeIsCensored ? "blur-2xl scale-105" : ""
              }`}
            />
            {activeIsCensored ? (
              <button
                type="button"
                onClick={() => toggleViewerCensor(active)}
                className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded bg-black/40 text-xs uppercase tracking-widest text-white hover:bg-black/30"
              >
                <span>{active.nsfw ? "NSFW" : "Hidden"}</span>
                <span className="rounded border border-white/60 bg-black/40 px-2 py-0.5 text-[10px]">click to reveal</span>
              </button>
            ) : (
              // Red-eye re-censor toggle on a visible image: hide it for
              // YOU (persists across sessions until you toggle it back).
              // Works on any image, NSFW-flagged or not.
              <button
                type="button"
                onClick={() => toggleViewerCensor(active)}
                className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/30 bg-black/55 text-keep-accent hover:bg-black/75"
                title="Censor this image for you (stays hidden when you view this profile again)"
                aria-label="Censor this image for you"
              >
                <EyeOff className="h-4 w-4" />
              </button>
            )}
          </div>
          {active.label ? (
            <span className="text-sm italic text-keep-muted">{active.label}</span>
          ) : null}
          {/* Moderator NSFW toggle for the focused image. Owner-set NSFW
              and mod-set NSFW write the same per-portrait flag, so a mod
              flagging an image here is identical to the owner having
              ticked it in their gallery editor. */}
          {canModerate && onToggleNsfw ? (
            <div className="flex flex-col items-center gap-0.5">
              <button
                type="button"
                disabled={flagBusy}
                onClick={async () => {
                  if (flagBusy) return;
                  setFlagBusy(true);
                  setFlagErr(null);
                  try {
                    await onToggleNsfw(active.id, !active.nsfw);
                  } catch (e) {
                    setFlagErr(e instanceof Error ? e.message : "Failed to update.");
                  } finally {
                    setFlagBusy(false);
                  }
                }}
                className="rounded border border-keep-accent/50 bg-keep-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
                title={active.nsfw ? "Clear the NSFW flag on this image" : "Mark this image NSFW (blurs it for viewers)"}
              >
                {flagBusy ? "Saving…" : active.nsfw ? "Unmark NSFW" : "Mark NSFW"}
              </button>
              {flagErr ? <span className="text-[10px] text-[#e06070]">{flagErr}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* Match the active preview's 70% cap + centering so the
          thumbnail strip reads as a unified continuation of the
          preview above, not a full-width row that clings to the
          modal edges. `auto-fit` (not auto-fill) collapses any
          unused 88px tracks so `justify-center` actually centers
          the populated tiles, `auto-fill` left phantom tracks on
          the right and pushed the visible row to the left. */}
      <div className="order-1 mx-auto grid max-w-[70%] grid-cols-[repeat(auto-fit,88px)] justify-center gap-2">
        {portraits.map((p) => {
          const tileCensored = isCensored(p);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                // First click on a censored tile reveals it (don't expand
                // yet). Subsequent click expands. Non-NSFW tiles toggle
                // expansion as before.
                if (tileCensored) {
                  reveal(p.id);
                  return;
                }
                setActiveId((prev) => (prev === p.id ? null : p.id));
              }}
              title={tileCensored ? `${p.label ?? "Portrait"} (${p.nsfw ? "NSFW" : "hidden"}, click to reveal)` : p.label ?? "Portrait"}
              className={`relative aspect-square overflow-hidden rounded transition ${
                activeId === p.id ? "ring-2 ring-keep-action" : "hover:ring-2 hover:ring-keep-action/50"
              }`}
            >
              <img
                src={p.url}
                alt={p.label || `${alt} portrait`}
                loading="lazy"
                className={`h-full w-full object-cover transition ${tileCensored ? "blur-xl scale-110" : ""}`}
              />
              {tileCensored ? (
                <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-[10px] font-semibold uppercase tracking-widest text-white">
                  {p.nsfw ? "NSFW" : "Hidden"}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================ *
 *  Moderator panel - Edit Bio + timed account ban + review.
 *  Rendered in the hero's mod section; each affordance is already
 *  permission-gated by the caller.
 * ============================================================ */

const BAN_DURATIONS: ReadonlyArray<{ label: string; ms: number | null }> = [
  { label: "1 day", ms: 1 * 24 * 60 * 60 * 1000 },
  { label: "3 days", ms: 3 * 24 * 60 * 60 * 1000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "Permanent", ms: null },
];

function fmtTs(ts: number | null): string {
  if (ts == null) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return "—"; }
}

function ProfileModPanel({
  profile,
  isChar,
  editTarget,
  canEditBio,
  canBan,
  onModerated,
}: {
  profile: ProfileView;
  isChar: boolean;
  editTarget: { kind: "character"; characterId: string } | { kind: "master"; userId: string };
  canEditBio: boolean;
  canBan: boolean;
  onModerated: (() => void) | undefined;
}) {
  const userId = profile.profile.userId;
  const targetName = profile.kind === "character" ? profile.profile.name : profile.profile.username;
  const [editOpen, setEditOpen] = useState(false);
  const [banOpen, setBanOpen] = useState(false);
  const [mod, setMod] = useState<UserModeration | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refreshMod() {
    if (!canBan) return;
    try { setMod(await fetchUserModeration(userId)); }
    catch { /* leave prior state; non-fatal for the panel */ }
  }
  useEffect(() => {
    let alive = true;
    if (canBan) {
      fetchUserModeration(userId).then((m) => { if (alive) setMod(m); }).catch(() => {});
    } else {
      setMod(null);
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, canBan]);

  const ban = mod?.ban ?? null;

  async function doUnban() {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await unbanAccount(userId); await refreshMod(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Unban failed."); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {/* Active-ban banner */}
      {ban ? (
        <div className="rounded border border-[#e06070]/50 bg-[#e06070]/10 px-2.5 py-1.5 text-[11px] text-keep-text">
          <span className="font-semibold text-[#e06070]">⛔ Banned</span>{" "}
          {ban.bannedUntil ? <>until {fmtTs(ban.bannedUntil)}</> : <>permanently</>}
          {ban.reason ? <> — “{ban.reason}”</> : null}
          {ban.by ? <span className="text-keep-muted"> (by {ban.by})</span> : null}
        </div>
      ) : null}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-1.5">
        {canEditBio ? (
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-keep-action hover:bg-keep-action/20"
            title={`Edit ${targetName}'s bio`}
          >
            Edit Bio
          </button>
        ) : null}
        {canBan && ban ? (
          <button
            type="button"
            onClick={() => void doUnban()}
            disabled={busy}
            className="rounded border border-keep-rule bg-keep-panel px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-keep-text hover:bg-keep-banner disabled:opacity-50"
          >
            {busy ? "Working…" : "Unban"}
          </button>
        ) : null}
        {canBan && !ban ? (
          <button
            type="button"
            onClick={() => setBanOpen(true)}
            className="rounded border border-[#e06070]/60 bg-[#e06070]/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-[#e06070] hover:bg-[#e06070]/20"
          >
            Ban
          </button>
        ) : null}
      </div>
      {err ? <div className="text-[10px] text-[#e06070]">{err}</div> : null}

      {/* History (mod-only) */}
      {canBan && mod && mod.history.length > 0 ? (
        <details className="text-[11px] text-keep-muted">
          <summary className="cursor-pointer select-none uppercase tracking-widest">
            Ban history ({mod.history.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {mod.history.map((h, i) => (
              <li key={i} className="leading-snug">
                <span className="text-keep-text">{fmtTs(h.at)}</span>{" "}
                {h.action === "account_ban" ? (
                  <>ban{h.until ? <> (until {fmtTs(h.until)})</> : <> (permanent)</>}</>
                ) : (
                  <>unban</>
                )}{" "}
                <span className="text-keep-muted">by {h.by}</span>
                {h.reason ? <> — “{h.reason}”</> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {editOpen ? (
        <EditBioModal
          initialBio={profile.profile.bioHtml}
          targetLabel={isChar ? targetName : `${targetName} (OOC)`}
          maxBioLength={50_000}
          onSave={async (html) => {
            await saveModBio(editTarget, html);
            onModerated?.();
          }}
          onClose={() => setEditOpen(false)}
        />
      ) : null}

      {banOpen ? (
        <BanDialog
          targetName={targetName}
          onClose={() => setBanOpen(false)}
          onConfirm={async (durationMs, reason) => {
            setBusy(true); setErr(null);
            try {
              await banAccount(userId, durationMs, reason);
              setBanOpen(false);
              await refreshMod();
            } catch (e) {
              setErr(e instanceof Error ? e.message : "Ban failed.");
              throw e; // keep the dialog open on failure
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function BanDialog({
  targetName,
  onConfirm,
  onClose,
}: {
  targetName: string;
  onConfirm: (durationMs: number | null, reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [durIdx, setDurIdx] = useState(0);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const trimmed = reason.trim();

  async function confirm() {
    if (submitting || !trimmed) return;
    setSubmitting(true);
    try {
      await onConfirm(BAN_DURATIONS[durIdx]!.ms, trimmed);
    } catch { /* parent surfaces the error + keeps dialog open */ }
    finally { setSubmitting(false); }
  }

  return (
    <Modal onClose={onClose} variant="centered" zIndex={70}>
      <div
        className="w-[min(440px,94vw)] rounded-lg border border-keep-rule bg-keep-bg p-4 text-keep-text shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-base font-semibold">Ban {targetName}</h3>
        <p className="mb-3 text-xs text-keep-muted">
          Blocks login and chat. A timed ban lifts itself when it expires.
        </p>

        <div className="mb-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">Duration</div>
          <div className="flex flex-wrap gap-1.5">
            {BAN_DURATIONS.map((d, i) => (
              <button
                key={d.label}
                type="button"
                onClick={() => setDurIdx(i)}
                aria-pressed={durIdx === i}
                className={`rounded border px-2.5 py-1 text-xs font-semibold transition-colors ${
                  durIdx === i
                    ? "border-keep-action bg-keep-action text-keep-bg"
                    : "border-keep-rule bg-keep-panel text-keep-text hover:bg-keep-banner"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-keep-muted">
            Reason <span className="text-[#e06070]">(required)</span>
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Visible to other moderators in the ban history."
            className="w-full resize-none rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
          />
        </label>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-keep-rule bg-keep-panel px-3 py-1.5 text-xs text-keep-text hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={submitting || !trimmed}
            className="rounded border border-[#e06070]/80 bg-[#e06070] px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Banning…" : "Ban account"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      {/* Header uses `text-keep-text` (not `text-keep-muted`) so it
          inherits the profile owner's theme nudged for full 4.5:1
          contrast, `muted` only nudges to 3:1, which at 12px uppercase
          rendered as borderline-invisible on user-picked palettes that
          sat close to bg. Bumped to `text-sm` (14px) for parity with
          chat headers + so the labels read as section dividers, not
          metadata. */}
      <h3 className="mb-2 border-b border-keep-rule/60 pb-1 text-sm font-semibold uppercase tracking-widest text-keep-text">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * World memberships for the profile being viewed. Per migration 0187
 * the section is identity-scoped: a master profile passes
 * `identityFilter="ooc"` so it only shows the master's OOC
 * memberships; a character profile passes the character id and only
 * that character's memberships render. The "isPrimary" chip was
 * retired alongside the per-master primary-world concept.
 */
function WorldsSection({
  userId,
  identityFilter,
  onOpenWorld,
}: {
  userId: string;
  /** "ooc" for the master profile, a character id for a character profile. */
  identityFilter: string;
  onOpenWorld: ((slug: string) => void) | undefined;
}) {
  const [memberships, setMemberships] = useState<WorldMembership[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ characterId: identityFilter }).toString();
    fetch(`/users/${encodeURIComponent(userId)}/world-memberships?${qs}`, { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<{ memberships?: WorldMembership[] }>) : null))
      .then((j) => {
        if (cancelled || !j) return;
        if (j.memberships) setMemberships(j.memberships);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId, identityFilter]);
  if (memberships === null) return null;
  if (memberships.length === 0) return null;
  return (
    <Section title="Worlds">
      <ul className="flex flex-wrap gap-1.5 text-sm">
        {memberships.map((m) => {
          const chipClass = "rounded border border-keep-rule/60 bg-keep-panel/60 px-2 py-0.5";
          const title = `Open ${m.worldName} (by ${m.ownerUsername})`;
          const inner = (
            <>
              <span className="font-medium">{m.worldName}</span>
              <span className="ml-1 text-[10px] text-keep-muted">/{m.worldSlug}</span>
            </>
          );
          return (
            <li key={`${m.worldId}:${m.characterId ?? ""}`}>
              {onOpenWorld ? (
                <button
                  type="button"
                  onClick={() => onOpenWorld(m.worldSlug)}
                  className={`${chipClass} hover:border-keep-action hover:text-keep-action`}
                  title={title}
                >
                  {inner}
                </button>
              ) : (
                <span className={chipClass} title={`by ${m.ownerUsername}`}>
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function EmptyProfile({ name, kind }: { name: string; kind: "master" | "character" }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm">
      <div aria-hidden className="text-4xl text-keep-muted/60">📜</div>
      <div className="italic text-keep-muted">
        {name} hasn't filled out their {kind === "character" ? "character" : "master"} profile yet.
      </div>
      {kind === "character" ? (
        <div className="text-xs text-keep-muted/80">
          They could add stats, a bio, and a main profile image to bring this character to life.
        </div>
      ) : null}
    </div>
  );
}

/**
 * Resolve the gender icon to display in the hero. Master profiles carry
 * an explicit OOC gender; characters store theirs in stats.gender (which
 * is free-form text - only normalize the canonical labels).
 */
/**
 * View tracker wrapper, wires `useTrackProfileView` from
 * ProfileFlairSurfaces against the viewer's identity so a self-view
 * doesn't bump the counter. Pulls the viewer id from the chat store
 * since ProfileModal already lives inside the same context.
 */
function ProfileViewTracker({
  profileName,
  characterId,
  profileUserId,
}: {
  profileName: string;
  characterId: string | null;
  profileUserId: string;
}) {
  const myUserId = useChat((s) => s.me?.id ?? null);
  useTrackProfileView({
    profileName,
    characterId,
    isSelf: myUserId !== null && myUserId === profileUserId,
  });
  return null;
}

function resolveGender(profile: ProfileView): Gender {
  if (profile.kind === "master") return profile.profile.gender;
  const raw = profile.profile.stats?.gender?.toLowerCase().trim();
  if (raw === "male" || raw === "female" || raw === "nonbinary" || raw === "other") return raw;
  return "undisclosed";
}

/**
 * Pull stat fields into [label, value] pairs in a stable order. Empty
 * strings are dropped. Custom entries follow the canonical fields,
 * preserving the author's insertion order.
 */
const CANONICAL_STAT_ORDER = [
  "age",
  "race",
  "gender",
  "height",
  "weight",
  "alignment",
  "occupation",
] as const;

function collectStatEntries(
  stats: NonNullable<ReturnType<typeof statsFromProfile>>,
  bypassVisibility: boolean,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const vis = stats.visibility ?? {};
  for (const k of CANONICAL_STAT_ORDER) {
    if (!bypassVisibility && vis[k] === false) continue;
    const v = stats[k];
    if (typeof v === "string" && v.trim()) out.push([k, v]);
  }
  // Custom block is gated as a whole, the owner can hide every
  // free-form row at once via `visibility.custom = false` without
  // having to delete each entry. Visibility takes effect at render
  // time only; the saved blob still carries the data.
  if (stats.custom && (bypassVisibility || vis.custom !== false)) {
    for (const [k, v] of Object.entries(stats.custom)) {
      if (typeof v === "string" && v.trim()) out.push([k, v]);
    }
  }
  return out;
}

/**
 * Return the vibe axes the renderer should paint, in catalog order.
 * Drops axes with no value (null / undefined) and short-circuits to
 * an empty array when the section is gated off via
 * `visibility.vibe = false`. Each returned tuple carries the axis
 * metadata so the renderer doesn't have to re-look it up.
 */
function collectVibeAxes(
  stats: NonNullable<ReturnType<typeof statsFromProfile>>,
  bypassVisibility: boolean,
): Array<{ key: CharacterVibeAxisKey; lowLabel: string; highLabel: string; value: number }> {
  if (!bypassVisibility && stats.visibility?.vibe === false) return [];
  const vibe = stats.vibe;
  if (!vibe) return [];
  const out: Array<{ key: CharacterVibeAxisKey; lowLabel: string; highLabel: string; value: number }> = [];
  for (const axis of CHARACTER_VIBE_AXES) {
    const v = vibe[axis.key];
    if (typeof v !== "number") continue;
    // Defensive clamp to [0, 100] before the renderer uses it as a
    // `left: ${value}%` offset. The Zod schema bounds new writes, but
    // any pre-validator data already in the column could in theory
    // carry an out-of-range value, clamping keeps the dot on the
    // track instead of pushing it off either edge.
    const clamped = Math.max(0, Math.min(100, v));
    out.push({ key: axis.key, lowLabel: axis.lowLabel, highLabel: axis.highLabel, value: clamped });
  }
  return out;
}

/** Visible attribute rows, in stored order. Empty when section is hidden. */
function collectAttributes(
  stats: NonNullable<ReturnType<typeof statsFromProfile>>,
  bypassVisibility: boolean,
): CharacterAttribute[] {
  if (!bypassVisibility && stats.visibility?.attributes === false) return [];
  return stats.attributes ?? [];
}

function statsFromProfile(p: ProfileView) {
  return p.kind === "character" ? p.profile.stats : null;
}

/**
 * Personality vibe block, eight bipolar bars (low label ◄ dot ►
 * high label). Each bar's dot sits at the stored 0..100 value as a
 * % offset along the track; unset axes are dropped at collection
 * time so the bar list only carries axes the owner explicitly
 * opted in to. Renders nothing when the owner hid the section or
 * never set any axis.
 */
function VibeSection({
  stats,
  bypassVisibility,
  variant = "section",
}: {
  stats: NonNullable<ReturnType<typeof statsFromProfile>> | null;
  bypassVisibility: boolean;
  /**
   * "section", body block wrapped in the standard
   * `<Section title="Vibe">` chrome. Mobile-friendly grid that
   * scales from 1 → 2 columns as the viewport widens.
   *
   * "compact", hero-sidecar variant. Drops the Section wrapper +
   * VIBE heading, locks the inner grid to 2 columns regardless of
   * viewport (the parent slot is a fixed 380px wide at lg+, so
   * responsive breakpoints would over-fit), and tightens the row
   * spacing so 4 rows of 2 axes ride the avatar's vertical
   * footprint. Same bar/dot/glow geometry.
   */
  variant?: "section" | "compact";
}) {
  if (!stats) return null;
  const axes = collectVibeAxes(stats, bypassVisibility);
  if (axes.length === 0) return null;
  const gridClass =
    variant === "compact"
      ? // Single column: used inside the body's Disposition column
        // (1/4 of the modal width on desktop), where a 2-col grid
        // would cram label-bar-label into ~120px each. Vertical
        // stack of 8 axes fits cleanly beside the 3/4-width Stats
        // column without dead space.
        "grid grid-cols-1 gap-y-2"
      : "grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2";
  const list = (
    <ul className={gridClass}>
      {axes.map((axis) => (
        <li key={axis.key} className={variant === "compact" ? "text-[11px]" : "text-xs"}>
          <div className="mb-0.5 flex items-baseline justify-between gap-2">
            <span className="font-semibold text-keep-text/85">{axis.lowLabel}</span>
            <span className="font-semibold text-keep-text/85">{axis.highLabel}</span>
          </div>
          {/* The bar is a flat track plus an absolutely-positioned
              dot. -translate-x-1/2 centers the dot on its computed
              left%, so 0 / 50 / 100 all read as "at the start /
              middle / end" without the dot clipping the track edge. */}
          <div className="relative h-1.5 w-full rounded-full bg-keep-rule/40">
            {/* Accent glow under the dot. A 60px-wide horizontal
                linear gradient with solid accent in the middle and
                transparent fades on each end, gives the dot a
                soft "this region of the axis" highlight that reads
                even at a glance, without coloring the whole bar
                (which would lose the position signal). Stops at
                25% / 75% leave ~15px of solid color on each side
                of the dot with a ~15px fade-out beyond. Painted
                before the dot in source order so the dot sits on
                top.

                The glow lives inside its own `overflow-hidden`
                clip layer (matching the track's rounded bounds) so
                that near the extremes (value → 0 / 100) the 60px
                gradient is trimmed at the bar edge instead of
                bleeding past "Minimum"/"Maximum". The dot is a
                SIBLING of this clip layer, not a child, so it keeps
                its intended centered overhang at the ends (it's
                taller than the track and would otherwise be clipped). */}
            <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
              <span
                aria-hidden
                className="absolute top-1/2 h-1.5 w-[60px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: `${axis.value}%`,
                  background:
                    "linear-gradient(90deg, rgb(var(--keep-action) / 0) 0%, rgb(var(--keep-action) / 0.85) 25%, rgb(var(--keep-action) / 0.85) 75%, rgb(var(--keep-action) / 0) 100%)",
                }}
              />
            </span>
            <span
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-keep-action/60 bg-keep-action shadow"
              style={{ left: `${axis.value}%` }}
              aria-label={`${axis.value} between ${axis.lowLabel} and ${axis.highLabel}`}
            />
          </div>
        </li>
      ))}
    </ul>
  );
  return variant === "compact" ? list : <Section title="Disposition">{list}</Section>;
}

/**
 * Numeric attribute sheet, D&D ability scores, HP gauges, or any
 * custom labeled stats the owner added. Each row paints the label
 * on the left, the number on the right, and a fill-bar underneath
 * showing where the value sits within its own [min, max] range. The
 * per-row range keeps a "STR 14 (1-20)" bar from sharing scale with
 * a "HP 75 (0-200)" bar, different stat systems live side by side
 * without distorting each other.
 */
function AttributesSection({
  stats,
  bypassVisibility,
}: {
  stats: NonNullable<ReturnType<typeof statsFromProfile>> | null;
  bypassVisibility: boolean;
}) {
  if (!stats) return null;
  const rows = collectAttributes(stats, bypassVisibility);
  if (rows.length === 0) return null;
  return (
    <Section title="Attributes">
      <ul className="space-y-2">
        {rows.map((row) => {
          // Defensive against a stored row whose min/max somehow ended
          // up equal, division would NaN. The server schema's
          // `min <= value <= max` guard prevents that for new saves,
          // but old data could in theory carry the degenerate case.
          // Pin to 100% in that case so the bar still paints something
          // legible rather than a blank track.
          const span = row.max - row.min;
          const pct = span > 0
            ? Math.max(0, Math.min(100, ((row.value - row.min) / span) * 100))
            : 100;
          return (
            <li key={row.id} className="text-xs">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="font-semibold uppercase tracking-widest text-keep-text/85">
                  {row.label || "-"}
                </span>
                <span className="text-keep-muted tabular-nums">
                  {row.value}
                  <span className="ml-1 text-[10px] text-keep-muted/70">
                    ({row.min}–{row.max})
                  </span>
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-keep-rule/40">
                <div
                  className="h-full rounded-full bg-keep-action"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
