/**
 * FindSetting — the "find a setting" search shared by the admin surfaces
 * (docs/ADMIN_IA.md §5). Generic on purpose: the Global Admin panel feeds
 * it admin-namespace entries and the Server Admin console can feed it
 * servers-namespace entries later; all search CHROME strings live in the
 * admin namespace (`panel.search.*`) so both surfaces share one set.
 *
 * The index is built at RUNTIME from the loaded i18next resources via the
 * caller's `resolve` (usually that surface's `t`): entry text always
 * matches the active locale, and i18next's en fallback means Spanish
 * search is never empty. Haystack and query are normalized with
 * lowercase + NFD diacritic stripping so "configuracion" matches
 * "configuración". A multi-word query also matches an entry when every
 * word appears somewhere in it (label or extra terms), so "edit window"
 * finds "Edit / delete window"; contiguous matches still rank first.
 *
 * Keyboard path: the input is focusable (the Global Admin shell also
 * wires Ctrl/Cmd+K to it), ArrowUp/Down move the active row, Enter picks
 * it, Esc closes the list (stopPropagation so the host modal stays open).
 *
 * Redirect rows ("not in this panel") are informational only: they render
 * under the `elsewhereHeading` label, never navigate, and are not part of
 * the keyboard-navigable option list.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { CloseButton } from "../shared/CloseButton.js";

/** One findable row: a catalog key plus where picking it should land. */
export interface FindSettingEntry<TTab extends string = string> {
  key: string;
  tab: TTab;
  subtab?: string;
  also?: readonly string[];
}

/** "Not in this panel" row: label + hint keys, resolved like entries. */
export interface FindSettingRedirect {
  labelKey: string;
  hintKey: string;
}

/** Lowercase + strip diacritics so accent-free typing still matches. */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Scroll the `data-admin-anchor="<key>"` element into view and pulse the
 * static `.tk-find-flash` outline on it (styles.css; CSP-safe, no runtime
 * <style>). Returns whether the anchor was found — a missing anchor is
 * NEVER an error, the jump just ends at the tab switch.
 */
export function flashAnchor(anchor: string, reduceMotion: boolean): boolean {
  const el = document.querySelector<HTMLElement>(
    `[data-admin-anchor="${CSS.escape(anchor)}"]`,
  );
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  // Restart cleanly if the same element is flashed twice in a row.
  el.classList.remove("tk-find-flash");
  void el.offsetWidth;
  el.classList.add("tk-find-flash");
  window.setTimeout(() => el.classList.remove("tk-find-flash"), 1600);
  return true;
}

/**
 * Run a callback after the NEXT paint (double requestAnimationFrame), so a
 * freshly-switched tab body has mounted before we query its anchors.
 * Returns a cancel function for effect cleanup.
 */
export function afterNextPaint(fn: () => void): () => void {
  let raf2 = 0;
  const raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(fn);
  });
  return () => {
    cancelAnimationFrame(raf1);
    cancelAnimationFrame(raf2);
  };
}

interface Props<TEntry extends FindSettingEntry> {
  entries: readonly TEntry[];
  redirects: readonly FindSettingRedirect[];
  /** Resolve a catalog key to display text (that surface's `t`). Its
   *  identity changes on locale switch, which re-derives the index. */
  resolve: (key: string) => string;
  /** Already-translated breadcrumb pieces for a hit (group, tab, subtab);
   *  the component interleaves aria-hidden "›" separators. */
  breadcrumb: (entry: TEntry) => readonly string[];
  /** Permission-visible tab ids; hits on hidden tabs never surface.
   *  (Redirect rows are informational and always shown.) */
  visibleTabIds: ReadonlySet<string>;
  onPick: (entry: TEntry) => void;
  /** "desktop": inline input + absolute popover under it.
   *  "mobile": full-width row (autofocus) + in-flow block list + X. */
  layout: "desktop" | "mobile";
  /** Mobile only: restore the normal header row. */
  onClose?: () => void;
  /** Optional external handle on the input (the shell's Ctrl/Cmd+K). */
  inputRef?: RefObject<HTMLInputElement>;
}

export function FindSetting<TEntry extends FindSettingEntry>({
  entries,
  redirects,
  resolve,
  breadcrumb,
  visibleTabIds,
  onPick,
  layout,
  onClose,
  inputRef,
}: Props<TEntry>) {
  const { t } = useTranslation("admin");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;

  // Mobile row appears via a tap on the search icon; focus immediately so
  // the keyboard opens without a second tap.
  useEffect(() => {
    if (layout === "mobile") ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // Runtime index: resolve every visible entry's text in the active locale.
  // `resolve` identity changes on language switch; `visibleTabIds` changes
  // with the viewer's permission set — both rebuild the memo.
  const index = useMemo(
    () =>
      entries
        .filter((entry) => visibleTabIds.has(entry.tab))
        .map((entry) => {
          const label = resolve(entry.key);
          const alsoText = (entry.also ?? []).map((k) => resolve(k)).join(" ");
          return { entry, label, labelNorm: normalize(label), alsoNorm: normalize(alsoText) };
        }),
    [entries, visibleTabIds, resolve],
  );
  const redirectIndex = useMemo(
    () =>
      redirects.map((r) => {
        const label = resolve(r.labelKey);
        const hint = resolve(r.hintKey);
        return { label, hint, haystack: normalize(`${label} ${hint}`) };
      }),
    [redirects, resolve],
  );

  const q = normalize(query.trim());
  // Rank: label startsWith > label word start > label substring > hint text
  // > every query word found somewhere. The last tier is what lets a
  // multi-word query match a label that splits its words ("edit window" →
  // "Edit / delete window"); any contiguous match always outranks it, and
  // single-word queries never reach it (tiers 2-3 already cover them).
  const hits = useMemo(() => {
    if (!q) return [];
    const tokens = q.split(/\s+/);
    const scored: Array<{ row: (typeof index)[number]; score: number }> = [];
    for (const row of index) {
      let score: number | null = null;
      if (row.labelNorm.startsWith(q)) score = 0;
      else if (row.labelNorm.split(/\s+/).some((w) => w.startsWith(q))) score = 1;
      else if (row.labelNorm.includes(q)) score = 2;
      else if (row.alsoNorm.includes(q)) score = 3;
      else if (
        tokens.length > 1 &&
        tokens.every((tok) => row.labelNorm.includes(tok) || row.alsoNorm.includes(tok))
      )
        score = 4;
      if (score !== null) scored.push({ row, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.row);
  }, [index, q]);
  const redirectHits = useMemo(
    () => (q ? redirectIndex.filter((r) => r.haystack.includes(q)) : []),
    [redirectIndex, q],
  );

  const listOpen = open && q.length > 0;
  const active = Math.min(activeIdx, Math.max(hits.length - 1, 0));
  const listId = layout === "desktop" ? "tk-find-list-desktop" : "tk-find-list-mobile";

  function pick(entry: TEntry) {
    setQuery("");
    setOpen(false);
    setActiveIdx(0);
    onPick(entry);
    onClose?.();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && listOpen && hits.length > 0) {
      e.preventDefault();
      setActiveIdx((active + 1) % hits.length);
    } else if (e.key === "ArrowUp" && listOpen && hits.length > 0) {
      e.preventDefault();
      setActiveIdx((active - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter" && listOpen && hits.length > 0) {
      e.preventDefault();
      const hit = hits[active];
      if (hit) pick(hit.entry);
    } else if (e.key === "Escape") {
      if (listOpen) {
        // Close only the result list; keep the host modal open (its Escape
        // listener sits at document level, so stop the bubble here).
        e.stopPropagation();
        setQuery("");
        setActiveIdx(0);
      } else if (layout === "mobile" && onClose) {
        e.stopPropagation();
        onClose();
      }
    }
  }

  // Shared result list body (popover on desktop, in-flow block on mobile).
  const resultList = listOpen ? (
    <div
      // Keep focus in the input while clicking rows (mousedown blurs first
      // otherwise and closes the list before the click lands).
      onMouseDown={(e) => e.preventDefault()}
      className={
        layout === "desktop"
          ? "absolute right-0 top-full z-30 mt-1 max-h-80 w-[24rem] max-w-[80vw] overflow-y-auto rounded border border-keep-rule bg-keep-bg p-1 text-left shadow-lg"
          : "mt-2 max-h-[50vh] overflow-y-auto rounded border border-keep-rule bg-keep-bg p-1"
      }
    >
      <p aria-live="polite" className="px-2 py-1 text-[10px] normal-case tracking-normal text-keep-muted">
        {hits.length > 0
          ? t("panel.search.resultCount", { count: hits.length })
          : redirectHits.length === 0
            ? t("panel.search.noResults")
            : null}
      </p>
      {hits.length > 0 ? (
        <ul id={listId} role="listbox" aria-label={t("panel.search.aria")} className="space-y-0.5">
          {hits.map((hit, i) => (
            <li
              key={hit.entry.key}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => pick(hit.entry)}
              className={`cursor-pointer rounded px-2 py-1.5 text-xs normal-case tracking-normal ${
                i === active ? "bg-keep-banner" : "hover:bg-keep-banner/60"
              }`}
            >
              <div className="text-keep-text">{hit.label}</div>
              <div className="mt-0.5 text-[10px] text-keep-muted">
                {breadcrumb(hit.entry).map((piece, j) => (
                  <span key={j}>
                    {j > 0 ? <span aria-hidden> › </span> : null}
                    {piece}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {redirectHits.length > 0 ? (
        <div className="mt-1 border-t border-keep-rule/60 pt-1">
          <p className="px-2 py-1 text-[10px] uppercase tracking-widest text-keep-muted">
            {t("panel.search.elsewhereHeading")}
          </p>
          {redirectHits.map((r) => (
            <div key={r.label} className="rounded px-2 py-1.5 text-xs normal-case tracking-normal">
              <div className="text-keep-text">{r.label}</div>
              <div className="mt-0.5 text-[10px] text-keep-muted">{r.hint}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  ) : null;

  const input = (
    <input
      ref={ref}
      type="text"
      value={query}
      onChange={(e) => {
        setQuery(e.target.value);
        setOpen(true);
        setActiveIdx(0);
      }}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={onKeyDown}
      placeholder={t("panel.search.placeholder")}
      aria-label={t("panel.search.aria")}
      role="combobox"
      aria-expanded={listOpen}
      aria-controls={listId}
      aria-autocomplete="list"
      {...(listOpen && hits.length > 0 ? { "aria-activedescendant": `${listId}-opt-${active}` } : {})}
      className={`rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs normal-case tracking-normal placeholder:text-keep-muted ${
        layout === "desktop" ? "w-full" : "min-w-0 flex-1"
      }`}
    />
  );

  if (layout === "desktop") {
    return (
      <div className="relative w-56 shrink-0">
        {input}
        {resultList}
      </div>
    );
  }
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        {input}
        {onClose ? <CloseButton onClick={onClose} /> : null}
      </div>
      {resultList}
    </div>
  );
}
