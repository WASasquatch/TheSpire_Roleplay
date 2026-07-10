/**
 * RatingChip — the room/server content-rating indicator (age-restriction
 * plan, Phase 2): a prominent "18+" when a space is adults-only, a
 * deliberately muted "SFW" otherwise, so members always know which side of
 * the partition they're in. Rendered in the room rail, the room info bar,
 * and the expanded top-banner band.
 *
 * The server never sends `isNsfw: true` rows to under-18 accounts (18+
 * rooms/servers are hidden from them entirely), so the prominent variant
 * only ever reaches adults; minors just see the everyone-safe SFW chip.
 * The 18+ red is a concrete color, not a theme slot, mirroring the admin
 * "Banned" badge: a warning marker must read as a warning on every palette.
 */
import { useTranslation } from "react-i18next";

export function RatingChip({ nsfw, className }: { nsfw: boolean; className?: string }) {
  const { t } = useTranslation("common");
  const base =
    "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] uppercase leading-none tracking-widest";
  return nsfw ? (
    <span
      title={t("rating.nsfwTitle")}
      className={`${base} border-[#e06070] bg-[#e06070]/10 font-bold text-[#e06070] ${className ?? ""}`}
    >
      {t("rating.nsfw")}
    </span>
  ) : (
    <span
      title={t("rating.sfwTitle")}
      className={`${base} border-keep-rule/60 font-semibold text-keep-muted/70 ${className ?? ""}`}
    >
      {t("rating.sfw")}
    </span>
  );
}
