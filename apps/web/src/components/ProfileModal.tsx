import DOMPurify from "dompurify";
import type { ProfileView } from "@thekeep/shared";
import { themeStyle } from "../lib/theme.js";
import { genderGlyph } from "../lib/gender.js";
import type { Gender } from "../lib/gender.js";

interface Props {
  profile: ProfileView;
  onClose: () => void;
  /** Pre-fill composer with `/whisper <name> ` and close. */
  onWhisper?: (name: string) => void;
  /** Issue `/ignore <name>`. */
  onIgnore?: (name: string) => void;
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
 *   - Action row: whisper / ignore (the modal isn't shown for self — App
 *     diverts self-clicks to the editor — so these are always relevant)
 *   - Stats grid (characters only; hidden when empty)
 *   - Bio section with explicit empty-state message
 *
 * Every section degrades gracefully: characters with nothing filled out
 * still get a clean modal that says "X hasn't filled out their profile yet."
 */
export function ProfileModal({ profile, onClose, onWhisper, onIgnore }: Props) {
  const isChar = profile.kind === "character";
  const name = isChar ? profile.profile.name : profile.profile.username;
  const bio = profile.profile.bioHtml.trim();
  const avatar = profile.profile.avatarUrl;
  const ownerTheme = profile.profile.theme;
  const createdAt = profile.profile.createdAt;
  const stats = isChar ? profile.profile.stats : null;
  const gender = resolveGender(profile);

  // Stat entries that actually have a value — empty fields are dropped so
  // a half-filled character doesn't show a row of dashes.
  const statEntries = stats ? collectStatEntries(stats) : [];
  const isCompletelyBlank = !bio && statEntries.length === 0 && !avatar;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div
        // Inline-style override scopes the theme to this card only. The
        // explicit bg/color use rgb(var()) because the variables now hold
        // RGB triples (see lib/theme.ts), not direct color values.
        style={themeStyle(ownerTheme)}
        className="flex max-h-[85vh] w-[min(720px,96vw)] flex-col overflow-hidden rounded border border-keep-border bg-keep-bg text-keep-text shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero band — always visible, themed with the owner's panel color. */}
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
              {isChar ? "Character" : "Master account"}
              {createdAt ? (
                <>
                  {" · "}
                  joined {new Date(createdAt).toLocaleDateString()}
                </>
              ) : null}
            </div>
            {/* Action row */}
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
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

        {/* Body — scrolls independently of the hero */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {isCompletelyBlank ? (
            <EmptyProfile name={name} kind={isChar ? "character" : "master"} />
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

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
      title={`${name} hasn't set an avatar yet.`}
    >
      {initials}
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

function EmptyProfile({ name, kind }: { name: string; kind: "master" | "character" }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm">
      <div aria-hidden className="text-4xl text-keep-muted/60">📜</div>
      <div className="italic text-keep-muted">
        {name} hasn't filled out their {kind === "character" ? "character" : "master"} profile yet.
      </div>
      {kind === "character" ? (
        <div className="text-xs text-keep-muted/80">
          They could add stats, a bio, and an avatar to bring this character to life.
        </div>
      ) : null}
    </div>
  );
}

/**
 * Resolve the gender icon to display in the hero. Master profiles carry
 * an explicit OOC gender; characters store theirs in stats.gender (which
 * is free-form text — only normalize the canonical labels).
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
