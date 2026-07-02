import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ExternalLink } from "lucide-react";
import { isDarkSurface, useActiveTheme } from "../lib/theme.js";
import { outUrl, type PublicAffiliateCard } from "../lib/affiliates.js";

/** Card scale. "compact" = the narrow splash rail (vertical card); "large" = the
 *  wider Top RP Communities board (a full-width horizontal row, bigger type). */
export type AffiliateCardSize = "compact" | "large";

/**
 * One Top RP Communities card. Always renders a full card, whatever is (or isn't)
 * supplied:
 *   - Background: the partner's widescreen banner, else a deterministic colored
 *     gradient + soft bokeh seeded from the card id (never a flat empty panel).
 *   - Icon: the partner's icon at natural aspect (scaled to fit, capped at 120px),
 *     or a lettered tile in the same slot.
 *   - Title / description: the text, or muted "No Title" / "No Description".
 *   - Tags, plus inbound / outbound view counters and a "Visit" button that hits
 *     our OUTBOUND redirect (`/affiliates/out/:id`) — the server counts a click and
 *     302s to the target. `sponsored` + `noopener noreferrer` on the rel.
 *
 * Two layouts: a vertical card (compact rail) and a full-width horizontal row
 * (large board). Ink is forced light with a soft shadow (there's always a colored
 * background). Partner images render only as `<img>` (never raw HTML), with
 * `referrerPolicy="no-referrer"`, `loading="lazy"`, and an `onError` fallback.
 */
export function AffiliateCard({
  card,
  size = "compact",
}: {
  card: PublicAffiliateCard;
  size?: AffiliateCardSize;
}) {
  const large = size === "large";
  const viewerDark = isDarkSurface(useActiveTheme());
  const bannerScrim = viewerDark ? "bg-black/55" : "bg-black/45";

  const [bannerBroken, setBannerBroken] = useState(false);
  const [iconBroken, setIconBroken] = useState(false);
  const hasBanner = !!card.bannerUrl && !bannerBroken;
  const hasIcon = !!card.iconUrl && !iconBroken;

  const title = card.title.trim();
  const description = card.description.trim();
  const letter = (title[0] ?? "?").toUpperCase();
  const maxTags = large ? 8 : 4;
  const shownTags = card.tags.slice(0, maxTags);

  // "See more" for the description: clamp by default, expand on tap. `clamped`
  // is measured so the toggle only appears when text is actually hidden.
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const descRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = descRef.current;
    if (!el || expanded) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [description, expanded, large]);

  const icon = hasIcon ? (
    <img
      src={card.iconUrl!}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setIconBroken(true)}
      className="h-auto max-h-[120px] w-auto max-w-[120px] shrink-0 rounded-lg border border-white/25 object-contain shadow-md"
    />
  ) : (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg border border-white/25 bg-black/30 font-semibold uppercase shadow-md ${
        large ? "h-16 w-16 text-3xl" : "h-12 w-12 text-xl"
      }`}
      aria-hidden="true"
    >
      {letter}
    </span>
  );

  const views = (
    <div className={`flex shrink-0 flex-col items-end gap-0.5 ${large ? "text-sm" : "text-xs"} text-white/90`}>
      <span className="inline-flex items-center gap-1" title="Visits sent to us">
        <ArrowDownLeft className={large ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" />
        <span className="tabular-nums">{card.clicksIn.toLocaleString()}</span>
        <span className="sr-only">visits sent to us</span>
      </span>
      <span className="inline-flex items-center gap-1" title="Visits we sent you">
        <ArrowUpRight className={large ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" />
        <span className="tabular-nums">{card.clicksOut.toLocaleString()}</span>
        <span className="sr-only">visits we sent you</span>
      </span>
    </div>
  );

  const tagRow =
    shownTags.length > 0 ? (
      <div className={`flex flex-wrap gap-1.5 ${large ? "mt-2.5" : "mt-2"}`}>
        {shownTags.map((t) => (
          <span
            key={t}
            className={`rounded-full bg-white/15 px-2 py-0.5 ${large ? "text-xs" : "text-[11px]"} lowercase text-white/90 ring-1 ring-white/10 [text-shadow:none] backdrop-blur-sm`}
          >
            {t}
          </span>
        ))}
        {card.tags.length > shownTags.length ? (
          <span className={`rounded-full bg-white/10 px-2 py-0.5 ${large ? "text-xs" : "text-[11px]"} text-white/70 [text-shadow:none]`}>
            +{card.tags.length - shownTags.length}
          </span>
        ) : null}
      </div>
    ) : null;

  const visitBtn = (
    <a
      href={outUrl(card.id)}
      target="_blank"
      rel="noopener noreferrer sponsored"
      className={`inline-flex items-center gap-1.5 rounded-md bg-keep-action font-semibold text-keep-bg no-underline shadow-md transition hover:brightness-110 hover:shadow-lg [text-shadow:none] ${
        large ? "px-5 py-2 text-sm" : "px-4 py-1.5 text-sm"
      }`}
    >
      Visit
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
    </a>
  );

  // Description + "See more" toggle, shared by both layouts.
  const descriptionBlock = (
    <>
      <p
        ref={descRef}
        className={`mt-1 ${expanded ? "" : large ? "line-clamp-3" : "line-clamp-2"} ${large ? "text-[15px] leading-relaxed" : "text-sm leading-snug"} ${description ? "text-white/90" : "italic text-white/60"}`}
      >
        {description || "No Description"}
      </p>
      {description && (clamped || expanded) ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-xs font-semibold text-white/85 underline underline-offset-2 [text-shadow:none] hover:text-white"
        >
          {expanded ? "See less" : "See more"}
        </button>
      ) : null}
    </>
  );

  // Shared background layers (banner + scrim, or the generated gradient) + the
  // bottom-anchored legibility gradient.
  const background = (
    <>
      {hasBanner ? (
        <>
          <img
            src={card.bannerUrl!}
            alt=""
            aria-hidden="true"
            loading="lazy"
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setBannerBroken(true)}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
          <div className={`absolute inset-0 ${bannerScrim}`} aria-hidden="true" />
        </>
      ) : (
        <div className="absolute inset-0 bg-black/15" aria-hidden="true" />
      )}
      {/* Soft top highlight + bottom shade for a glossier, more legible finish. */}
      <div className="absolute inset-0 bg-gradient-to-b from-white/10 via-transparent to-black/60" aria-hidden="true" />
    </>
  );

  const shell =
    "group relative flex overflow-hidden text-white [text-shadow:0_1px_2px_rgba(0,0,0,.75)] transition-all duration-200";
  const chrome = large
    ? "min-h-[9.5rem] w-full rounded-xl border border-white/10 shadow-[0_8px_26px_-12px_rgba(0,0,0,0.7)] ring-1 ring-white/5 hover:border-keep-action/70 hover:shadow-[0_14px_40px_-12px_rgb(var(--keep-action)/0.45)] hover:ring-keep-action/25"
    : "min-h-[9rem] flex-col rounded-lg border border-keep-rule shadow-md hover:border-keep-action";

  if (large) {
    return (
      <div
        className={`${shell} ${chrome}`}
        style={hasBanner ? undefined : { backgroundImage: placeholderBg(card.id) }}
      >
        {background}
        <div className="relative flex flex-1 items-center gap-4 p-5">
          {icon}
          <div className="min-w-0 flex-1">
            <div className={`truncate font-action text-2xl tracking-tight ${title ? "" : "italic text-white/70"}`}>
              {title || "No Title"}
            </div>
            {descriptionBlock}
            {tagRow}
          </div>
          <div className="flex shrink-0 flex-col items-end justify-between gap-4 self-stretch py-0.5">
            {views}
            {visitBtn}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${shell} ${chrome}`}
      style={hasBanner ? undefined : { backgroundImage: placeholderBg(card.id) }}
    >
      {background}
      <div className="relative flex flex-1 flex-col p-3">
        <div className="flex items-start gap-2.5">
          {icon}
          <div className="min-w-0 flex-1">
            <div className={`truncate font-action text-base ${title ? "" : "italic text-white/70"}`}>
              {title || "No Title"}
            </div>
            {descriptionBlock}
          </div>
          {views}
        </div>
        {tagRow}
        <div className="mt-auto flex justify-center pt-3">{visitBtn}</div>
      </div>
    </div>
  );
}

/**
 * Deterministic gradient + bokeh background for a banner-less card, built as a
 * CSS `background-image` value. Seeded from the card id so a given listing always
 * gets the same look (stable across re-renders) while different listings vary.
 */
function placeholderBg(id: string): string {
  const base = hashStr(id);
  const hue1 = base % 360;
  const hue2 = (hue1 + 45 + (base % 70)) % 360;
  const dot = (n: number) => {
    const h = hashStr(`${id}:${n}`);
    const x = h % 100;
    const y = (h >> 4) % 100;
    const spread = 22 + (h % 26);
    const hue = (hue1 + n * 63) % 360;
    return `radial-gradient(circle at ${x}% ${y}%, hsl(${hue} 78% 64% / 0.42) 0, transparent ${spread}%)`;
  };
  return [
    dot(1),
    dot(2),
    dot(3),
    `linear-gradient(135deg, hsl(${hue1} 58% 32%), hsl(${hue2} 62% 20%))`,
  ].join(", ");
}

/** Small stable string hash (djb2-ish) for seeding the placeholder palette. */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
