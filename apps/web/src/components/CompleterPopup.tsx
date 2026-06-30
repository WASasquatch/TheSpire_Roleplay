import { useEffect, useRef } from "react";
import { useReducedMotion } from "../lib/reducedMotion.js";

export interface CompletionItem {
  /** Inserted into the composer when the item is accepted. */
  value: string;
  /** Primary display string (usually the same as value but without leading `/` or `@`). */
  label: string;
  /** Optional secondary line - command description, character role, etc. */
  sublabel?: string;
}

interface Props {
  items: CompletionItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onAccept: (item: CompletionItem) => void;
}

/**
 * Floating list shown above the composer when a slash / at-mention trigger is
 * active. Keyboard navigation is owned by the parent (Composer's textarea
 * intercepts Up/Down/Enter/Tab/Esc) - this component just renders, hover-
 * highlights, and reports clicks.
 */
export function CompleterPopup({ items, selectedIndex, onSelect, onAccept }: Props) {
  const listRef = useRef<HTMLUListElement | null>(null);
  // Calm-mode ease: this popup opens ABOVE the textarea (bottom-full), so it
  // slides up into place. Pure CSS positioning, so the slide transform is safe.
  const reduceMotion = useReducedMotion();

  // Keep the active row scrolled into view as the parent moves selection
  // through the items.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const child = list.children[selectedIndex] as HTMLElement | undefined;
    if (child) child.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!items.length) return null;

  return (
    <div
      role="listbox"
      // bottom-full pins this above the textarea; the parent wrapper is
      // `relative` so this pops in-place. Capped height with overflow so a
      // long command list doesn't push past the chat area.
      className={`absolute bottom-full left-0 right-0 z-30 mb-1 max-h-60 overflow-y-auto rounded border border-keep-rule bg-keep-bg shadow-lg${reduceMotion ? " tk-slide-up-in" : ""}`}
      // Don't let mousedown inside the popup steal focus from the textarea -
      // keyboard navigation needs the textarea to retain focus.
      onMouseDown={(e) => e.preventDefault()}
    >
      <ul ref={listRef} className="text-sm">
        {items.map((item, idx) => {
          const active = idx === selectedIndex;
          return (
            <li
              key={`${item.value}-${idx}`}
              role="option"
              aria-selected={active}
              onMouseEnter={() => onSelect(idx)}
              onClick={() => onAccept(item)}
              className={`cursor-pointer px-3 py-1 ${
                active ? "bg-keep-action/15 text-keep-text" : "hover:bg-keep-panel"
              }`}
            >
              <div className="font-mono text-xs text-keep-action">{item.label}</div>
              {item.sublabel ? (
                <div className="truncate text-[11px] text-keep-muted">{item.sublabel}</div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
