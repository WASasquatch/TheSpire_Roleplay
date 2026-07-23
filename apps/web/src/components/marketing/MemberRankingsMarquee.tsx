import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useReducedMotion } from "../../lib/reducedMotion.js";

/**
 * "Our members" rankings marquee for the anonymous marketing homepage.
 *
 * A public clone of the earning dashboard's Rankings tab: every
 * leaderboard the earning system exposes arrives as one compact
 * section, and the marquee rotates through them one after another
 * (FeaturedWorldCards pattern: auto-advance + prev/next arrows +
 * pause on hover/focus; frozen entirely under reduce-motion, the
 * BannerMarquee pattern). A randomly-rotating featured member card
 * sits beside it with a prominent portrait + abridged profile.
 *
 * Deliberate differences from the in-app rankings renderer:
 *   - No animated cosmetics (name styles / border frames). The
 *     homepage stays free of the perpetual cosmetic-animation repaint
 *     cost and the injector bundle; earned status shows through the
 *     static rank sigil + rank name instead.
 *   - Names LINK OUT to the public profile page (/p/<name>) in a new
 *     tab rather than opening the in-app modal — visitors here are
 *     anonymous, and the public page is the shareable surface.
 *   - Private accounts render as an italic "Private User" (the server
 *     ships them identity-less; they keep their honest positions).
 *
 * Self-hides on fetch failure / empty payload, like every other
 * splash section (cold-start rule).
 */

interface SplashRankingRow {
  name: string;
  private?: boolean;
  avatarUrl: string | null;
  sigilImageUrl: string | null;
  rankName: string | null;
  profileName?: string;
  subtitle?: string;
  value: number;
  valueKind: "number" | "rating" | "hours" | "rankName";
}

interface SplashRankingSection {
  key: string;
  label: string;
  metric: string;
  rows: SplashRankingRow[];
}

interface SplashFeaturedMember {
  name: string;
  avatarUrl: string | null;
  rankName: string | null;
  sigilImageUrl: string | null;
  memberSince: number;
  messages: number | null;
  forumPosts: number | null;
  characters: number;
  gender: "male" | "female" | "nonbinary" | "other" | null;
  languages: string[];
}

/** Raw `inert` attribute for inactive grid-stacked slides (React 18 has
 *  no typed prop for it). Blocks focus + clicks on the profile links
 *  inside invisible sections. */
const INERT = { inert: "" } as unknown as React.HTMLAttributes<HTMLOListElement>;

export interface SplashRankingsPayload {
  sections: SplashRankingSection[];
  featured: SplashFeaturedMember | null;
  generatedAt: number;
}

/** Fetch the marquee payload, resolving null on any failure or an empty
 *  section list — SplashLanding gates BOTH the section and its nav tab
 *  on the resolved value, so a cold install never shows a dead tab. */
export async function fetchSplashRankings(): Promise<SplashRankingsPayload | null> {
  try {
    const r = await fetch("/rankings/splash", { credentials: "include" });
    if (!r.ok) return null;
    const j = (await r.json()) as SplashRankingsPayload;
    return j && Array.isArray(j.sections) && j.sections.length > 0 ? j : null;
  } catch {
    return null; // cold API / offline → section self-hides
  }
}

const ROTATE_MS = 7000;

export function MemberRankingsMarquee({ data }: { data: SplashRankingsPayload }) {
  const { t, i18n } = useTranslation("marketing");
  const reduceMotion = useReducedMotion();
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  // Bumped on manual prev/next so the auto-advance interval restarts —
  // otherwise a click just before the tick would advance twice at once.
  const [epoch, setEpoch] = useState(0);
  const nf = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const sinceFmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }),
    [i18n.language],
  );

  const sections = data.sections;
  const sectionCount = sections.length;
  useEffect(() => {
    // Reduce-motion freezes the rotation entirely (manual arrows still
    // work) — the BannerMarquee posture, NOT FeatureShowcase's
    // keep-spinning one.
    if (reduceMotion || paused || sectionCount <= 1) return;
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % sectionCount);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [reduceMotion, paused, sectionCount, epoch]);

  if (sectionCount === 0) return null;
  const section = sections[Math.min(idx, sectionCount - 1)]!;

  function advance(dir: -1 | 1): void {
    setIdx((i) => (i + dir + sectionCount) % sectionCount);
    setEpoch((e) => e + 1);
  }

  function valueText(row: SplashRankingRow): string {
    switch (row.valueKind) {
      case "rankName": return row.rankName ?? "—";
      case "rating": return row.value > 0 ? row.value.toFixed(2) : "—";
      case "hours": return `${nf.format(Math.round(row.value))}h`;
      default: return nf.format(row.value);
    }
  }

  return (
    <section id="members" aria-label={t("memberRankings.heading")} className="scroll-mt-20">
      <header className="mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-keep-accent">
          {t("memberRankings.kicker")}
        </p>
        <h2 className="font-action text-2xl text-keep-text">{t("memberRankings.heading")}</h2>
        <p className="mt-1 text-sm text-keep-muted">{t("memberRankings.sub")}</p>
      </header>

      {/* `grid-cols-1` (not a bare `grid`) matters on mobile: a bare grid's
          single implicit column is sized to max-content, so a wide ranking
          row would push the whole section past the viewport (the reported
          off-screen overflow). grid-cols-1 = minmax(0,1fr), which lets the
          column — and every truncating child inside it — shrink to fit. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        {data.featured ? <FeaturedMemberCard member={data.featured} sinceFmt={sinceFmt} nf={nf} /> : null}

        <div
          className="min-w-0 rounded-lg border border-keep-rule bg-keep-bg/60 p-3"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
        >
          <div className="mb-2 flex items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold uppercase tracking-widest text-keep-text">
              {t(`memberRankings.boards.${section.key}`, { defaultValue: section.label })}
            </h3>
            <span className="shrink-0 text-[11px] tabular-nums text-keep-muted">
              {t("memberRankings.counter", { current: idx + 1, total: sectionCount })}
            </span>
            <button
              type="button"
              onClick={() => advance(-1)}
              title={t("memberRankings.prev")}
              aria-label={t("memberRankings.prev")}
              className="shrink-0 rounded border border-keep-rule p-1 text-keep-muted hover:border-keep-action hover:text-keep-action"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => advance(1)}
              title={t("memberRankings.next")}
              aria-label={t("memberRankings.next")}
              className="shrink-0 rounded border border-keep-rule p-1 text-keep-muted hover:border-keep-action hover:text-keep-action"
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>

          {/* GRID-STACK: every section stays mounted in the same grid cell
              (col-start-1 row-start-1), so the board's height is the
              TALLEST section's — the page never reflows as the rotation
              advances. Inactive sections are invisible + aria-hidden +
              inert (their profile links can't be tabbed to or clicked),
              and their avatar <img>s aren't mounted at all (fixed-size
              placeholder boxes hold the height) so twenty stacked
              sections don't fetch a hundred avatars on page load. The
              swap animation replays when a section GAINS the class on
              activation; suppressed under reduce-motion in CSS. */}
          <div className="grid grid-cols-1">
            {sections.map((s, si) => {
              const isActive = s.key === section.key;
              return (
                <ol
                  key={s.key}
                  className={`col-start-1 row-start-1 min-w-0 space-y-1.5 ${isActive ? "member-rankings-swap" : "invisible"}`}
                  aria-hidden={!isActive}
                  {...(isActive ? {} : INERT)}
                >
                  {s.rows.map((row, i) => (
                    <li key={`${s.key}-${i}`} className="flex items-center gap-2 rounded border border-keep-rule/60 bg-keep-panel/30 px-2 py-1.5">
                      <span className={`w-5 shrink-0 text-center text-sm font-bold tabular-nums ${i < 3 ? "text-keep-action" : "text-keep-muted"}`}>
                        {i + 1}
                      </span>
                      <RowAvatar row={row} active={isActive} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">
                          {row.private ? (
                            <span className="font-normal italic text-keep-muted">{t("memberRankings.privateUser")}</span>
                          ) : row.profileName ? (
                            <a
                              href={`/p/${encodeURIComponent(row.profileName)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-keep-action hover:underline"
                            >
                              {row.name}
                            </a>
                          ) : (
                            row.name
                          )}
                        </span>
                        {row.subtitle || row.rankName ? (
                          <span className="block truncate text-[10px] uppercase tracking-wide text-keep-muted">
                            {row.subtitle ?? row.rankName}
                          </span>
                        ) : null}
                      </span>
                      {row.sigilImageUrl ? (
                        <img src={row.sigilImageUrl} alt="" className="h-4 w-4 shrink-0 object-contain" loading="lazy" />
                      ) : null}
                      <span className="shrink-0 text-right">
                        <span className="block text-sm font-semibold tabular-nums">{valueText(row)}</span>
                        {row.valueKind !== "rankName" ? (
                          <span className="block text-[9px] uppercase tracking-widest text-keep-muted">
                            {t(`memberRankings.metrics.${s.key}`, { defaultValue: s.metric })}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Small round avatar / cover thumb; neutral silhouette for private rows,
 *  initial tile when a public row has no image. `active: false` (an
 *  invisible grid-stacked section) renders the initial tile in place of
 *  the <img> — identical box size, zero image fetches until the section
 *  actually shows. */
function RowAvatar({ row, active }: { row: SplashRankingRow; active: boolean }) {
  if (row.private) {
    return <span aria-hidden className="h-8 w-8 shrink-0 rounded-full border border-keep-rule/70 bg-keep-panel/60" />;
  }
  if (row.avatarUrl && active) {
    return <img src={row.avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full border border-keep-rule/70 object-cover" loading="lazy" />;
  }
  return (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-keep-rule/70 bg-keep-panel/60 text-xs font-bold text-keep-muted">
      {row.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The featured-member spotlight: prominent portrait + a two-column
 *  grid of TYPED profile metadata, linking out to the public page.
 *  Deliberately no bio excerpt: designer-built bios are arbitrary HTML
 *  whose text-stripped form reads as run-together template labels. */
function FeaturedMemberCard({ member, sinceFmt, nf }: {
  member: SplashFeaturedMember;
  sinceFmt: Intl.DateTimeFormat;
  nf: Intl.NumberFormat;
}) {
  const { t } = useTranslation("marketing");
  const profileUrl = `/p/${encodeURIComponent(member.name)}`;
  // Label/value rows for the metadata grid; unset or hidden fields are
  // simply omitted so the grid packs clean.
  const meta: Array<{ label: string; value: string }> = [
    { label: t("memberRankings.meta.memberSince"), value: sinceFmt.format(new Date(member.memberSince)) },
  ];
  if (member.messages != null && member.messages > 0) {
    meta.push({ label: t("memberRankings.meta.messages"), value: nf.format(member.messages) });
  }
  if (member.characters > 0) {
    meta.push({ label: t("memberRankings.meta.characters"), value: nf.format(member.characters) });
  }
  if (member.forumPosts != null && member.forumPosts > 0) {
    meta.push({ label: t("memberRankings.meta.forumPosts"), value: nf.format(member.forumPosts) });
  }
  if (member.gender) {
    meta.push({ label: t("memberRankings.meta.gender"), value: t(`memberRankings.gender.${member.gender}`) });
  }
  if (member.languages.length > 0) {
    meta.push({ label: t("memberRankings.meta.languages"), value: member.languages.join(", ") });
  }
  return (
    <article className="flex min-w-0 flex-col items-center gap-3 rounded-lg border border-keep-accent/40 bg-keep-panel/30 p-4 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-keep-accent">
        {t("memberRankings.featuredKicker")}
      </p>
      <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
        {member.avatarUrl ? (
          <img
            src={member.avatarUrl}
            alt={member.name}
            className="h-28 w-28 rounded-full border-2 border-keep-accent/60 object-cover shadow-lg"
            loading="lazy"
          />
        ) : (
          <span aria-hidden className="flex h-28 w-28 items-center justify-center rounded-full border-2 border-keep-accent/60 bg-keep-panel text-3xl font-bold text-keep-muted">
            {member.name.slice(0, 1).toUpperCase()}
          </span>
        )}
      </a>
      <div className="min-w-0">
        <a
          href={profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="break-words font-action text-xl text-keep-text hover:text-keep-action hover:underline"
        >
          {member.name}
        </a>
        {member.rankName ? (
          <p className="mt-0.5 flex items-center justify-center gap-1 text-[11px] uppercase tracking-wide text-keep-muted">
            {member.sigilImageUrl ? (
              <img src={member.sigilImageUrl} alt="" className="h-4 w-4 object-contain" loading="lazy" />
            ) : null}
            {member.rankName}
          </p>
        ) : null}
      </div>
      <dl className="grid w-full grid-cols-2 gap-x-4 gap-y-2 text-left">
        {meta.map((m) => (
          <div key={m.label} className="min-w-0 rounded border border-keep-rule/50 bg-keep-bg/40 px-2 py-1.5">
            <dt className="text-[9px] uppercase tracking-widest text-keep-muted">{m.label}</dt>
            <dd className="truncate text-sm font-semibold text-keep-text">{m.value}</dd>
          </div>
        ))}
      </dl>
      <a
        href={profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-auto rounded border border-keep-action bg-keep-action/10 px-4 py-1.5 text-sm font-semibold text-keep-action hover:bg-keep-action/20"
      >
        {t("memberRankings.viewProfile")}
      </a>
    </article>
  );
}
