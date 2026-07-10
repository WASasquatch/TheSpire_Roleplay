/**
 * Grouped-tab-strip helpers, extracted verbatim from AdminPanel.tsx
 * (docs/ADMIN_IA.md §6) so the Global Admin panel and the per-server
 * console can share one grouping mental model: `<optgroup>`s on the
 * mobile `<select>`, hairline separators on the desktop strip. Pure
 * relocation with the group id genericized; behaviour is unchanged.
 */

/** Bucket a list of (already-filtered-for-visibility) tabs by their
 *  `group` field. Returns the buckets in input order so the mobile
 *  dropdown preserves the same vertical sequence as the desktop
 *  strip. Empty groups drop out entirely, a viewer whose permission
 *  set hides every tab in a category doesn't see that category's
 *  optgroup label. */
export function groupVisibleTabs<T extends { group: string }>(
  tabs: readonly T[],
): Array<[T["group"], T[]]> {
  const buckets = new Map<T["group"], T[]>();
  for (const t of tabs) {
    const arr = buckets.get(t.group) ?? [];
    arr.push(t);
    buckets.set(t.group, arr);
  }
  return Array.from(buckets.entries());
}

/** Walk the visible-tab list and yield a flat sequence of tab buttons
 *  interspersed with separator markers whenever the group changes.
 *  Returns a discriminated union so the renderer can pattern-match
 *  on `kind` and pick the right element type. The separator carries
 *  the group it's transitioning AWAY from so the title hover shows
 *  which section just ended. */
export type StripEntry<TGroup extends string, T> =
  | { kind: "tab"; tab: T }
  | { kind: "separator"; afterGroup: TGroup };

export function withGroupSeparators<T extends { group: string }>(
  tabs: readonly T[],
): StripEntry<T["group"], T>[] {
  const out: StripEntry<T["group"], T>[] = [];
  let prevGroup: T["group"] | null = null;
  for (const t of tabs) {
    if (prevGroup !== null && t.group !== prevGroup) {
      out.push({ kind: "separator", afterGroup: prevGroup });
    }
    out.push({ kind: "tab", tab: t });
    prevGroup = t.group;
  }
  return out;
}
