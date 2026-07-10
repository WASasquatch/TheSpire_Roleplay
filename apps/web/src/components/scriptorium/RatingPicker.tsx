import { useTranslation } from "react-i18next";
import type { StoryRating } from "@thekeep/shared";
import { SFW_RATINGS, STORY_RATING_INFO, STORY_RATINGS } from "@thekeep/shared";
import { useChat } from "../../state/store.js";

interface Props {
  value: StoryRating;
  onChange: (next: StoryRating) => void;
  /** Optional id-prefix for the radio inputs so two pickers on the same
   *  page (e.g. New Story wizard + an open editor) don't share names. */
  name?: string;
  /** Compact mode trims the description text, used inside the New
   *  Story wizard where vertical space is tighter. */
  compact?: boolean;
}

/**
 * Card-based rating selector for the Scriptorium editor. Renders the
 * full rating catalog as a stack of selectable cards, each with the
 * rating chip + short label + descriptive copy explaining what the
 * tier covers. Drops the previous `<select>` because writers were
 * picking the wrong tier without the inline guidance, the line
 * between R and NC-17 in particular is "depicted vs. graphic" and
 * needs to be spelled out.
 *
 * Renders as a single column on mobile, two columns on md+ so the
 * cards stay scannable without the wizard ballooning vertically.
 */
export function RatingPicker({ value, onChange, name = "story-rating", compact }: Props) {
  const { t } = useTranslation("scriptorium");
  const viewerIsAdult = useChat((s) => s.viewerAge.isAdult);
  // Cosmetic mirror of the server-side authoring clamp (age plan
  // Phase 4): accounts under 18 publish G / PG / PG-13 only, so the
  // adult tiers don't render at all — no dead cards. If a mod set an
  // adult rating on a minor's story it still shows (selected) so the
  // picker never lies about the current state.
  const ratings = viewerIsAdult
    ? STORY_RATINGS
    : STORY_RATINGS.filter((r) => (SFW_RATINGS as readonly string[]).includes(r) || r === value);
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">{t("rating.legend")}</legend>
      <div className={`grid gap-2 ${compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"}`}>
        {ratings.map((r) => (
          <RatingCard
            key={r}
            rating={r}
            selected={value === r}
            onPick={() => onChange(r)}
            inputName={name}
            compact={!!compact}
          />
        ))}
      </div>
    </fieldset>
  );
}

/* =============================================================
 *  Per-card
 * ============================================================= */
function RatingCard({
  rating,
  selected,
  onPick,
  inputName,
  compact,
}: {
  rating: StoryRating;
  selected: boolean;
  onPick: () => void;
  inputName: string;
  compact: boolean;
}) {
  const { t } = useTranslation("scriptorium");
  const info = STORY_RATING_INFO[rating];
  // Per-tier accent so a selected card visually matches its severity
  // (green for family-friendly, amber for teen, red for adult,
  // magenta for NSFW). Unselected cards stay neutral; the accent only
  // surfaces on selection so the picker doesn't feel like a traffic
  // light at rest.
  const accent = ACCENT_BY_RATING[rating];
  return (
    <label
      className={`group block cursor-pointer rounded border p-2.5 transition ${
        selected
          ? `${accent.border} ${accent.bg} shadow-sm`
          : "border-keep-rule bg-keep-panel/30 hover:border-keep-action/40 hover:bg-keep-panel/50"
      }`}
    >
      <div className="flex items-start gap-2">
        <input
          type="radio"
          name={inputName}
          value={rating}
          checked={selected}
          onChange={onPick}
          className="mt-1 shrink-0 accent-keep-action"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
              selected ? accent.chip : "border border-keep-rule bg-keep-bg text-keep-muted"
            }`}>
              {info.label}
            </span>
            <span className={`text-sm font-semibold ${selected ? accent.text : "text-keep-text"}`}>
              {t(`rating.info.${rating}.short`)}
            </span>
            {!info.publicReadable ? (
              <span className="ml-auto rounded-full border border-keep-accent/50 bg-keep-accent/10 px-1.5 py-0 text-[10px] uppercase tracking-widest text-keep-accent">
                {t("rating.loginRequired")}
              </span>
            ) : null}
          </div>
          {!compact ? (
            <p className={`mt-1 text-xs leading-relaxed ${selected ? "text-keep-text" : "text-keep-muted"}`}>
              {t(`rating.info.${rating}.description`)}
            </p>
          ) : null}
        </div>
      </div>
    </label>
  );
}

/* =============================================================
 *  Per-tier color accents, applied only when the card is selected.
 *  Tailwind class strings (not inline styles) so the theme variables
 *  flow through opacity modifiers correctly.
 * ============================================================= */
const ACCENT_BY_RATING: Record<StoryRating, {
  border: string;
  bg: string;
  text: string;
  chip: string;
}> = {
  "G": {
    border: "border-emerald-400/70",
    bg: "bg-emerald-400/10",
    text: "text-emerald-300",
    chip: "bg-emerald-400/20 text-emerald-200 border border-emerald-400/40",
  },
  "PG": {
    border: "border-sky-400/70",
    bg: "bg-sky-400/10",
    text: "text-sky-300",
    chip: "bg-sky-400/20 text-sky-200 border border-sky-400/40",
  },
  "PG-13": {
    border: "border-amber-400/70",
    bg: "bg-amber-400/10",
    text: "text-amber-300",
    chip: "bg-amber-400/20 text-amber-200 border border-amber-400/40",
  },
  "R": {
    border: "border-orange-500/70",
    bg: "bg-orange-500/10",
    text: "text-orange-300",
    chip: "bg-orange-500/20 text-orange-200 border border-orange-500/40",
  },
  "NC-17": {
    border: "border-rose-500/70",
    bg: "bg-rose-500/10",
    text: "text-rose-300",
    chip: "bg-rose-500/20 text-rose-200 border border-rose-500/40",
  },
};
