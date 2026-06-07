import { useEffect, useMemo, useState } from "react";
import { sanitizeUserHtml, sweepOrphanedUserBioStyles, USER_HTML_SCOPE_CLASS } from "../lib/userHtml.js";
import { CHARACTER_VIBE_AXES, isAdminRole, isDarkPalette, parseFreeformBorderConfig, roleRank } from "@thekeep/shared";
import type { CharacterAttribute, CharacterPortrait, CharacterVibeAxisKey, EidolonProfileSummary, ProfileLink, ProfileView, WorldMembership } from "@thekeep/shared";
import { themeStyle } from "../lib/theme.js";
import { buildOrnamentStyle } from "../lib/ornaments/index.js";
import { BorderedAvatar } from "./BorderedAvatar.js";
import { CloseButton } from "./CloseButton.js";
import { genderGlyph } from "../lib/gender.js";
import type { Gender } from "../lib/gender.js";
import { profileShareUrl } from "../lib/profiles.js";
import { fetchPublicEarning, type PublicEarningResponse } from "../lib/earning.js";
import { ArcadeError, fetchEidolonSummary, patFamiliar } from "../lib/arcade.js";
import { ItemZoomView } from "./ItemZoomView.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { RankSigil } from "./RankSigil.js";
import { StyledName } from "./StyledName.js";
import { useChat } from "../state/store.js";
import { ProfileMarquee, ProfileVisitorsChip, useTrackProfileView } from "./ProfileFlairSurfaces.js";

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
   * Stacking override for the modal backdrop. Defaults to the Modal
   * baseline (40). Bumped above 50 when the profile is opened from
   * inside the admin panel so it sits on top of the admin shell
   * instead of being hidden underneath it.
   */
  zIndex?: number;
}

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
export function ProfileModal({ profile, onClose, onWhisper, onMessage, onIgnore, onOpenProfile, onOpenWorld, activeCharacterAction, bypassNsfwGate, zIndex }: Props) {
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
  const requiresGate = profile.profile.isNsfw && !bypassNsfwGate;
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

  // Sample the BG image's average luminance so the modal can nudge
  // its scoped text color toward the high-contrast end and tighten
  // the glass panel opacity. Sampling is best-effort: cross-origin
  // images without CORS headers taint the canvas and `getImageData`
  // throws, in which case we leave the luminance null and still
  // apply the opacity-tightening fallback. Avoids the "neon city
  // BG bleeds through the panel and the soft theme text becomes
  // unreadable" failure mode.
  const bgLuminance = useBgLuminance(profileBgUrl || null);

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
  // Always-on contract (independent of profile BG image): fully opaque
  // glass tints. Every theme-style's `.keep-frame` / `.keep-panel`
  // rule reads `--keep-glass-panel-tint` / `--keep-glass-bg-tint`
  // (the few that don't, scifi's flat 0.5-alpha, are also overridden
  // by the inline `backgroundColor` on the card div below). Forcing
  // these to 1.0 alpha means the owner's theme actually renders
  // against the owner's `bg`, NOT a 50% blend with whatever's behind
  // the modal (the viewer's chat shell + the bg-black/40 backdrop).
  // The blend was the legibility killer: text contrast is computed
  // against `theme.bg` in `legibleThemePalette`, but with translucent
  // surfaces the rendered bg color was a totally different value, so
  // the nudge guaranteed nothing.
  const ownerIsDark = isDarkPalette(ownerTheme);
  const legibilityVars: Record<string, string> = {
    "--keep-glass-panel-tint": "rgb(var(--keep-panel))",
    "--keep-glass-bg-tint": "rgb(var(--keep-bg))",
  };
  if (profileBgUrl) {
    // Profile BG image path: keep the high-alpha glass tints (~85-92%)
    // so the image still reads through faintly as a wash behind the
    // panel chrome. Mark the owner-is-dark hint with a near-opaque
    // panel-color tint; light themes get a near-opaque white wash so
    // bright images don't bleach the body text.
    legibilityVars["--keep-glass-panel-tint"] = ownerIsDark
      ? "rgb(var(--keep-panel) / 0.85)"
      : "rgb(255 255 255 / 0.92)";
    legibilityVars["--keep-glass-bg-tint"] = ownerIsDark
      ? "rgb(var(--keep-bg) / 0.85)"
      : "rgb(255 255 255 / 0.92)";

    // If we successfully sampled the BG luminance, swap the text
    // color toward the opposite extreme so contrast is guaranteed
    // regardless of which neon hue is blooming behind the panel.
    // Mid-luminance BGs (0.35..0.6) leave the theme default alone
    //, those are already neutral enough for the theme to win.
    if (bgLuminance !== null) {
      if (bgLuminance > 0.6) {
        legibilityVars["--keep-text"] = "20 20 20";
        legibilityVars["--keep-muted"] = "80 80 80";
      } else if (bgLuminance < 0.35) {
        legibilityVars["--keep-text"] = "240 240 240";
        legibilityVars["--keep-muted"] = "180 180 180";
      }
    }
  }

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
        // Skipped when the profile has a BG image: that path is
        // designed around a frosted-glass treatment that lets the
        // image read faintly through the card, so we keep the
        // theme-style's translucent surface in play and rely on
        // the bgLuminance-driven text-color swap (legibilityVars
        // above) for legibility instead.
        style={{
          ...themeStyle(ownerTheme),
          ...ownerOrnaments.vars,
          ...legibilityVars,
          ...(profileBgUrl ? {} : { backgroundColor: "rgb(var(--keep-bg))" }),
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
            onOpenProfile={onOpenProfile}
            onOpenWorld={onOpenWorld}
            activeCharacterAction={activeCharacterAction}
          />
        )}
      </div>
      </div>
    </Modal>
  );
}

/* ============================================================ *
 *  useBgLuminance, sample the average perceived luminance of a
 *  remote image. Returns null while loading, on error, or on
 *  CORS-tainted canvas (cross-origin images without the right
 *  headers throw on getImageData). Callers fall back to safer
 *  fixed-opacity scrims when sampling fails so legibility holds
 *  regardless of the source's CORS posture.
 * ============================================================ */
function useBgLuminance(url: string | null): number | null {
  const [lum, setLum] = useState<number | null>(null);
  useEffect(() => {
    if (!url) { setLum(null); return; }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      if (cancelled) return;
      try {
        const w = 32, h = 32;
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        let total = 0;
        const samples = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
          // Rec. 709 perceived luminance, weights human eye
          // sensitivity to green much higher than red/blue, so a
          // neon-cyan BG reads as bright (forces dark text) where
          // a deep navy reads as dark (forces light text).
          total += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
        }
        if (!cancelled) setLum(total / samples / 255);
      } catch {
        // CORS-tainted canvas, getImageData throws. Leave null so
        // callers fall back to the opacity-tightening path.
        if (!cancelled) setLum(null);
      }
    };
    img.onerror = () => { if (!cancelled) setLum(null); };
    img.src = url;
    return () => { cancelled = true; };
  }, [url]);
  return lum;
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
  onOpenProfile,
  onOpenWorld,
  activeCharacterAction,
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
  onOpenProfile: ((name: string) => void) | undefined;
  onOpenWorld: ((slug: string) => void) | undefined;
  activeCharacterAction: { label: string; onClick: () => void } | undefined;
}) {
  const isChar = profile.kind === "character";
  // Viewer's role drives the mod-tools row: mod+ sees copy-id chips so
  // moderation flows (kick/ban/disable, admin tab lookups) can grab
  // the raw user/character ids without retyping. Read directly off
  // the chat store, ProfileModal can be opened from many surfaces
  // and a dedicated prop would just be parent-prop-drilling.
  const viewerRole = useChat((s) => s.me?.role ?? null);
  const isModViewer = viewerRole !== null && roleRank(viewerRole) >= roleRank("mod");
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
  const hasActions = !!(onWhisper || onMessage || onIgnore || activeCharacterAction);
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
                    <span className="ml-1 italic text-keep-action">· Moderator</span>
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
                    className="keep-button rounded border border-keep-action/60 bg-keep-bg px-2 py-1 text-keep-action hover:bg-keep-action/10"
                  >
                    {activeCharacterAction.label}
                  </button>
                ) : null}
                {onMessage ? (
                  <button
                    type="button"
                    onClick={() => onMessage(profile.profile.userId, name, avatar)}
                    title="Open a direct message thread with this user."
                    className="rounded border border-keep-action/40 bg-keep-bg px-2 py-1 text-keep-action hover:bg-keep-action/10"
                  >
                    💬 Message
                  </button>
                ) : null}
                {onWhisper ? (
                  <button
                    type="button"
                    onClick={() => onWhisper(name)}
                    className="rounded border border-keep-border bg-keep-bg px-2 py-1 hover:bg-keep-panel"
                  >
                    Whisper
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
                    className="rounded border border-keep-accent/60 bg-keep-bg px-2 py-1 text-keep-accent hover:bg-keep-accent/10"
                  >
                    Ignore
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
                className="keep-button flex-1 border-r border-keep-rule px-2 py-2.5 text-keep-action hover:bg-keep-action/10"
              >
                {activeCharacterAction.label}
              </button>
            ) : null}
            {onMessage ? (
              <button
                type="button"
                onClick={() => onMessage(profile.profile.userId, name, avatar)}
                title="Open a direct message thread with this user."
                className="flex-1 border-r border-keep-rule px-2 py-2.5 text-keep-action hover:bg-keep-action/10"
              >
                💬 Message
              </button>
            ) : null}
            {onWhisper ? (
              <button
                type="button"
                onClick={() => onWhisper(name)}
                className="flex-1 border-r border-keep-rule px-2 py-2.5 text-keep-text hover:bg-keep-panel"
              >
                Whisper
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
                className="flex-1 px-2 py-2.5 text-keep-accent hover:bg-keep-accent/10"
              >
                Ignore
              </button>
            ) : null}
          </div>
        ) : null}
        </div>

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
              {profile.profile.collection.length > 0 ? (
                <Section title="Collection">
                  {/* Grid (not flex-wrap) so the 10 pinned tiles distribute
                      across the row width instead of clumping at the left.
                      Column counts ramp by viewport: 3-up on phones, 5-up
                      on small/medium, 10-up on lg+ so the full collection
                      becomes a single tidy row on desktop. */}
                  <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-10">
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
                  as the item collection above; rendered directly
                  under it so visitors see the pin sets together. The
                  section header reads "Pets" rather than "Pet
                  Collection", the modal already has "Collection"
                  for items, so the simpler noun keeps the two
                  sections visually distinct without verbose repetition. */}
              {profile.profile.petCollection.length > 0 ? (
                <Section title="Pets">
                  {/* Grid so the up-to-5 pet tiles distribute across the
                      row instead of clumping at the left. 2 cols on the
                      tightest phones (taller tiles wrap to two rows), 3
                      on small phones, then 5-up on md+ so the full
                      showcase reads as one row on tablet/desktop. */}
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
                    {profile.profile.petCollection.map((c) => (
                      <li key={c.slot} className="flex justify-center">
                        <CollectionPin entry={c} variant="pet" onClick={() => setZoomedPin(c)} />
                      </li>
                    ))}
                  </ul>
                </Section>
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
              <PortraitGallery portraits={profile.profile.portraits} alt={name} />

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
      <h2 className="font-action text-xl">NSFW content ahead</h2>
      <p className="max-w-prose text-sm text-keep-text/80">
        {subject} is marked <b>NSFW</b> by its owner. Click{" "}
        <span className="font-semibold">View Profile</span> to confirm you want to see it.
        Closing this modal and re-opening will prompt again.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm hover:bg-keep-banner"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onAccept}
          className="rounded border border-keep-accent/60 bg-keep-accent/10 px-3 py-1 text-sm font-semibold text-keep-accent hover:bg-keep-accent/20"
        >
          View Profile
        </button>
      </div>
    </div>
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
function PortraitGallery({ portraits, alt }: { portraits: CharacterPortrait[]; alt: string }) {
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
  // Per-portrait reveal state for owner-marked NSFW tiles. Resets on profile
  // re-open (the modal remounts), so a viewer who reveals here doesn't stay
  // revealed after closing and reopening the profile.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const active = portraits.find((p) => p.id === activeId) ?? null;
  const activeIsCensored = !!active && active.nsfw && !revealed.has(active.id);

  function reveal(id: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  return (
    <div className="mt-4 border-t border-keep-rule/60 pt-3">
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
        <div className="mb-2 flex flex-col items-center gap-1">
          {/* Expanded gallery preview is capped at 70% of the profile
              width and centered, so a tall portrait doesn't dominate
              the modal at every viewport size. The thumbnail strip
              below is the navigation surface, the centered preview
              is for "study one image at a time" without crowding the
              rest of the profile. */}
          <div className="relative block w-full max-w-[70%]">
            <img
              src={active.url}
              alt={active.label || `${alt} portrait`}
              className={`mx-auto block max-w-full rounded transition ${
                activeIsCensored ? "blur-2xl scale-105" : ""
              }`}
            />
            {activeIsCensored ? (
              <button
                type="button"
                onClick={() => reveal(active.id)}
                className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded bg-black/40 text-xs uppercase tracking-widest text-white hover:bg-black/30"
              >
                <span>NSFW</span>
                <span className="rounded border border-white/60 bg-black/40 px-2 py-0.5 text-[10px]">click to reveal</span>
              </button>
            ) : null}
          </div>
          {active.label ? (
            <span className="text-sm italic text-keep-muted">{active.label}</span>
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
      <div className="mx-auto grid max-w-[70%] grid-cols-[repeat(auto-fit,88px)] justify-center gap-2">
        {portraits.map((p) => {
          const tileCensored = p.nsfw && !revealed.has(p.id);
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
              title={p.nsfw ? `${p.label ?? "Portrait"} (NSFW, click to reveal)` : p.label ?? "Portrait"}
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
                  NSFW
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
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
                top. */}
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 h-1.5 w-[60px] -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${axis.value}%`,
                background:
                  "linear-gradient(90deg, rgb(var(--keep-action) / 0) 0%, rgb(var(--keep-action) / 0.85) 25%, rgb(var(--keep-action) / 0.85) 75%, rgb(var(--keep-action) / 0) 100%)",
              }}
            />
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
  return variant === "compact" ? list : <Section title="Vibe">{list}</Section>;
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
