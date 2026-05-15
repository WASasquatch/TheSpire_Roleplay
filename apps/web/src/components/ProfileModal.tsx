import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { isAdminRole } from "@thekeep/shared";
import type { CharacterPortrait, ProfileLink, ProfileView, WorldMembership } from "@thekeep/shared";
import { themeStyle } from "../lib/theme.js";
import { genderGlyph } from "../lib/gender.js";
import type { Gender } from "../lib/gender.js";
import { profileShareUrl } from "../lib/profiles.js";
import { Modal } from "./Modal.js";

interface Props {
  profile: ProfileView;
  onClose: () => void;
  /** Pre-fill composer with `/whisper <name> ` and close. */
  onWhisper?: (name: string) => void;
  /**
   * Open the DM floating panel keyed to the profile's owner. Phase 4
   * surface for the Direct Messages feature. The parent hides this
   * action when the viewer is anonymous OR equals the profile owner
   * OR the target has `dmsEnabled === false` — same gate posture as
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
export function ProfileModal({ profile, onClose, onWhisper, onMessage, onIgnore, onOpenProfile, onOpenWorld, activeCharacterAction, bypassNsfwGate }: Props) {
  const isChar = profile.kind === "character";
  const name = isChar ? profile.profile.name : profile.profile.username;
  const bio = profile.profile.bioHtml.trim();
  const avatar = profile.profile.avatarUrl;
  const ownerTheme = profile.profile.theme;
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

  // Stat entries that actually have a value - empty fields are dropped so
  // a half-filled character doesn't show a row of dashes.
  const statEntries = stats ? collectStatEntries(stats) : [];
  // Portraits live on the character profile only — master profiles don't
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

  return (
    <Modal onClose={onClose} variant="mobile-fullscreen">
      <div
        // Inline-style override scopes the theme to this card only. The
        // explicit bg/color use rgb(var()) because the variables now hold
        // RGB triples (see lib/theme.ts), not direct color values.
        //
        // Mobile: full-viewport sheet (h-dvh handles the iOS address-bar
        // shrink so the close button stays reachable). No border / rounded
        // corners since we sit edge-to-edge. Dismiss is via the close
        // button only — backdrop tap doesn't reach us at this size.
        // Desktop (md+): 75vw on widescreens with a ceiling so it doesn't
        // become absurd on ultra-wide monitors, capped at 85vh tall, with
        // the original border / rounded / shadow treatment.
        style={themeStyle(ownerTheme)}
        className="flex h-dvh w-full flex-col overflow-hidden bg-keep-bg text-keep-text md:h-auto md:max-h-[85vh] md:w-[78vw] md:max-w-[1400px] md:rounded md:border md:border-keep-border md:shadow-xl"
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
  stats: { age?: string; race?: string; gender?: string; height?: string; weight?: string; alignment?: string; occupation?: string; custom?: Record<string, string> } | null;
  gender: Gender;
  titles: ProfileView["profile"]["titles"];
  links: ProfileLink[];
  journal: NonNullable<Extract<ProfileView, { kind: "character" }>["profile"]["journalEntries"]>;
  statEntries: Array<[string, string]>;
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
  return (
    <>
      {/* Hero band - always visible, themed with the owner's panel color. */}
        <div className="flex shrink-0 items-start gap-4 border-b border-keep-rule bg-keep-panel px-5 py-4">
          <Avatar url={avatar} name={name} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h2 className="font-action text-2xl tracking-wide" title={name}>
                {name}
              </h2>
              <span
                aria-hidden
                className="text-lg leading-none"
                title={genderGlyph(gender).title}
                style={{ color: genderGlyph(gender).color }}
              >
                {genderGlyph(gender).icon}
              </span>
            </div>
            <div className="mt-0.5 text-xs uppercase tracking-widest text-keep-muted">
              {profile.kind === "character" ? (
                "Character"
              ) : (
                <>
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
                </>
              )}
              {createdAt ? (
                <>
                  {" · "}
                  joined {new Date(createdAt).toLocaleDateString()}
                </>
              ) : null}
              <span className="mx-1">·</span>
              <CopyProfileLink name={name} />
            </div>
            {/* Action row - renders when there's at least one action to
                offer. Self-views (App suppresses whisper/ignore) still get
                this row when there's a Switch / Disable action to take. */}
            {onWhisper || onMessage || onIgnore || activeCharacterAction ? (
              <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
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
          <button
            type="button"
            onClick={onClose}
            className="ml-2 shrink-0 text-sm text-keep-muted hover:text-keep-text"
            aria-label="Close"
          >
            close
          </button>
        </div>

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

              <WorldsSection userId={profile.profile.userId} onOpenWorld={onOpenWorld} />


              {statEntries.length > 0 ? (
                <Section title="Stats">
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                    {statEntries.map(([k, v]) => (
                      <div
                        key={k}
                        className="flex justify-between gap-3 border-b border-keep-rule/40 py-0.5"
                      >
                        <dt className="text-xs uppercase tracking-widest text-keep-muted">{k}</dt>
                        <dd className="truncate text-right">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </Section>
              ) : null}

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

              <Section title="Bio">
                {bio ? (
                  <div
                    className="prose prose-sm max-w-none break-words"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bio) }}
                  />
                ) : (
                  <p className="italic text-keep-muted">
                    {name} hasn't written a bio yet.
                  </p>
                )}
              </Section>

              {/* Full-size avatar footer - the hero crops to a 96/112px square,
                  so we show the natural-resolution image down here for users
                  who want to see the whole portrait. Lives inside the
                  scrolling body so it doesn't push the bio off-screen on
                  short viewports. */}
              {avatar ? (
                <div className="mt-2 flex justify-center border-t border-keep-rule/60 pt-4">
                  <img
                    src={avatar}
                    alt={`${name} - full portrait`}
                    className="max-w-full rounded border border-keep-border"
                  />
                </div>
              ) : null}

              {/* Additional portraits (character profiles only). Renders as a
                  responsive grid so a character with multiple looks/forms
                  shows them all without dominating the modal. Each tile is a
                  click-to-zoom that swaps the large image inline. */}
              {profile.kind === "character" && profile.profile.portraits.length > 0 ? (
                <PortraitGallery portraits={profile.profile.portraits} alt={name} />
              ) : null}

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
                          className="prose prose-sm max-w-none break-words"
                          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(e.bodyHtml) }}
                        />
                      </li>
                    ))}
                  </ol>
                </Section>
              ) : null}
            </>
          )}
        </div>
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

function Avatar({ url, name }: { url: string | null; name: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt={name}
        className="h-24 w-24 shrink-0 rounded border border-keep-border object-cover sm:h-28 sm:w-28"
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
      className="flex h-24 w-24 shrink-0 items-center justify-center rounded border border-keep-border bg-keep-bg text-2xl font-semibold uppercase tracking-wide text-keep-muted sm:h-28 sm:w-28"
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
  const [activeId, setActiveId] = useState<string | null>(null);
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
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-keep-muted">
        Gallery
      </h3>
      {active ? (
        <div className="mb-2 flex flex-col items-center gap-1">
          <div className="relative inline-block max-w-full">
            <img
              src={active.url}
              alt={active.label || `${alt} portrait`}
              className={`max-w-full rounded border border-keep-border transition ${
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
            <span className="text-xs italic text-keep-muted">{active.label}</span>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
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
              title={p.nsfw ? `${p.label ?? "Portrait"} (NSFW — click to reveal)` : p.label ?? "Portrait"}
              className={`relative aspect-square overflow-hidden rounded border ${
                activeId === p.id ? "border-keep-action ring-2 ring-keep-action/40" : "border-keep-border hover:border-keep-action"
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
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1.5 border-b border-keep-rule/60 pb-0.5 text-xs font-semibold uppercase tracking-widest text-keep-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * World memberships for the profile being viewed. Lazily fetched per-profile;
 * renders nothing while loading and nothing if the user has no visible
 * memberships (private worlds the viewer can't see are filtered server-side).
 * The primary membership gets a small "primary" chip so visitors can tell at
 * a glance which world this user identifies with most.
 */
function WorldsSection({ userId, onOpenWorld }: { userId: string; onOpenWorld: ((slug: string) => void) | undefined }) {
  // Tristate: `null` while loading, `"private"` when the server gated
  // the response (anonymous viewer — see /users/:id/world-memberships),
  // or the membership list when the viewer is authed and the user has
  // any visible memberships. Empty memberships still render nothing so
  // the section doesn't show an awkward "Worlds:" with no chips.
  const [memberships, setMemberships] = useState<WorldMembership[] | "private" | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/users/${encodeURIComponent(userId)}/world-memberships`, { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<{ memberships?: WorldMembership[]; private?: true }>) : null))
      .then((j) => {
        if (cancelled || !j) return;
        if (j.private) setMemberships("private");
        else if (j.memberships) setMemberships(j.memberships);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);
  if (memberships === null) return null;
  if (memberships === "private") {
    return (
      <Section title="Worlds">
        <p className="text-xs italic text-keep-muted">
          Worlds are private. <a href="/login" className="text-keep-action hover:underline">Log in</a> or{" "}
          <a href="/register" className="text-keep-action hover:underline">register</a> to view.
        </p>
      </Section>
    );
  }
  if (memberships.length === 0) return null;
  return (
    <Section title="Worlds">
      <ul className="flex flex-wrap gap-1.5 text-sm">
        {memberships.map((m) => {
          const chipClass = `rounded border px-2 py-0.5 ${
            m.isPrimary
              ? "border-keep-action/50 bg-keep-action/10"
              : "border-keep-rule/60 bg-keep-panel/60"
          }`;
          const title = `Open ${m.worldName} (by ${m.ownerUsername}${m.isPrimary ? ", primary" : ""})`;
          const inner = (
            <>
              <span className="font-medium">{m.worldName}</span>
              <span className="ml-1 text-[10px] text-keep-muted">/{m.worldSlug}</span>
              {m.isPrimary ? (
                <span className="ml-1 rounded bg-keep-action/20 px-1 text-[9px] uppercase tracking-widest text-keep-action">
                  primary
                </span>
              ) : null}
            </>
          );
          return (
            <li key={m.worldId}>
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
                <span className={chipClass} title={`by ${m.ownerUsername}${m.isPrimary ? " (primary)" : ""}`}>
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

function collectStatEntries(stats: NonNullable<ReturnType<typeof statsFromProfile>>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const k of CANONICAL_STAT_ORDER) {
    const v = stats[k];
    if (typeof v === "string" && v.trim()) out.push([k, v]);
  }
  if (stats.custom) {
    for (const [k, v] of Object.entries(stats.custom)) {
      if (typeof v === "string" && v.trim()) out.push([k, v]);
    }
  }
  return out;
}

function statsFromProfile(p: ProfileView) {
  return p.kind === "character" ? p.profile.stats : null;
}
