import type { ReactNode } from "react";

/**
 * Shared tab-pill button used by the dashboards (Earning, Admin, Help)
 * and their sub-tab strips. Consolidates several byte-identical copies.
 *
 * Options preserve each call site's exact rendered markup/classes:
 * - `variant`: `"rule"` (default) uses `border-keep-rule` +
 *   `bg-keep-banner/40 hover:bg-keep-banner` for the inactive state;
 *   `"panel"` uses `border-keep-border` + `bg-keep-panel/40
 *   hover:bg-keep-panel` (the Help modal's token pair).
 * - `includeShrink`: prepend `shrink-0 whitespace-nowrap` so tabs keep
 *   their intrinsic size inside a scrolling nav. MUST default off — the
 *   sub-tab strips omit it and adding it would change their wrap/shrink.
 * - `tourAnchor`: when set, stamps a `data-tour` attribute for tours.
 */
export function TabBtn({
  active,
  onClick,
  children,
  variant = "rule",
  includeShrink = false,
  tourAnchor,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  variant?: "rule" | "panel";
  includeShrink?: boolean;
  tourAnchor?: string;
}) {
  const shrink = includeShrink ? "shrink-0 whitespace-nowrap " : "";
  const border = variant === "panel" ? "border-keep-border" : "border-keep-rule";
  const inactive =
    variant === "panel" ? "bg-keep-panel/40 hover:bg-keep-panel" : "bg-keep-banner/40 hover:bg-keep-banner";
  return (
    <button
      type="button"
      onClick={onClick}
      {...(tourAnchor ? { "data-tour": tourAnchor } : {})}
      className={`${shrink}rounded border ${border} px-2 py-0.5 ${active ? "bg-keep-bg" : inactive}`}
    >
      {children}
    </button>
  );
}
