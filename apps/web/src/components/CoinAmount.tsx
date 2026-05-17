/**
 * CoinAmount — small inline pairing of coin.png + a numeric amount.
 *
 * Used everywhere Currency is shown as a value (purchase costs,
 * send/receive notifications, ledger deltas) so the icon stays
 * consistent across surfaces. Pair with `cache_pouch.png` for
 * a "total wallet" display (EarningStatsStrip, ProfileModal hero),
 * which has its own pouch-themed treatment.
 */

interface Props {
  amount: number;
  /** Optional className for context-specific spacing / weight. */
  className?: string;
  /** Tooltip; defaults to "Currency". */
  title?: string;
  /** "sm" (default, 14px) for inline text, "md" (18px) for buttons / headers. */
  size?: "sm" | "md";
}

const SIZE_PX: Record<NonNullable<Props["size"]>, number> = {
  sm: 14,
  md: 18,
};

export function CoinAmount({ amount, className, title, size = "sm" }: Props) {
  const px = SIZE_PX[size];
  return (
    <span
      className={`inline-flex items-center gap-1 tabular-nums ${className ?? ""}`}
      title={title ?? "Currency"}
    >
      <img
        src="/assets/earning/coin.png"
        alt=""
        aria-hidden
        width={px}
        height={px}
        className="select-none align-text-bottom"
        draggable={false}
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
      <span>{amount.toLocaleString()}</span>
    </span>
  );
}
