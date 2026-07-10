/**
 * Full-screen zoom view for an Items-system catalog row.
 *
 * Two callers:
 *
 *   1. ProfileModal, clicking a Collection or Pets pin on a profile
 *      opens this overlay over the profile modal (z:60 sits above
 *      the profile modal's z:50).
 *
 *   2. App.tsx, the `/item <name>` chat command emits an
 *      `open-item` UiHint; the app-level handler mounts this same
 *      overlay so users can summon any item's full view from chat
 *      without first navigating to a profile that has it pinned.
 *
 * Closes on click anywhere on the backdrop or Esc. Esc is handled
 * via a document-level listener so the overlay doesn't need
 * keyboard focus to receive the key.
 *
 * Designed to be device-universal, on desktop it's a click-to-
 * magnify, on mobile it's the "tapped that little icon, give me a
 * bigger view" interaction. The same shape powers both surfaces so
 * the look is consistent regardless of how the user got there.
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "../../lib/reducedMotion.js";

export interface ItemZoomEntry {
  itemKey: string;
  name: string;
  namePlural: string | null;
  description: string;
  iconUrl: string | null;
  /** Owner-assigned nickname (pet pins only). When set, the zoom
   *  header reads "Nickname" with "Catalog name" as a subtitle. */
  nickname?: string | null;
}

export function ItemZoomView({
  entry,
  onClose,
}: {
  entry: ItemZoomEntry;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");
  // Calm-mode ease: this is a modal-like full-screen overlay (not the shared
  // Modal), so fade the backdrop in under Reduce Motion to match the modals.
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("itemZoom.fullViewAria", { name: entry.name })}
      onClick={onClose}
      className={`fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-black/85 p-6 backdrop-blur-sm${reduceMotion ? " tk-fade-in" : ""}`}
    >
      {entry.iconUrl ? (
        <img
          src={entry.iconUrl}
          alt=""
          className="max-h-[70vh] max-w-[90vw] rounded border border-white/20 bg-keep-bg object-contain"
        />
      ) : (
        <div
          className="grid h-64 w-64 max-h-[70vh] max-w-[90vw] place-items-center rounded border border-white/20 bg-keep-banner/40"
          aria-hidden="true"
        >
          <span className="text-6xl font-semibold text-white/60">
            {entry.name.slice(0, 1).toUpperCase()}
          </span>
        </div>
      )}
      <div className="max-w-md text-center text-white">
        {entry.nickname ? (
          <>
            <h3 className="font-action text-2xl">{entry.nickname}</h3>
            <p className="text-xs italic text-white/60">{entry.name}</p>
          </>
        ) : (
          <h3 className="font-action text-2xl">{entry.name}</h3>
        )}
        {entry.description ? (
          <p className="mt-2 text-sm text-white/80">{entry.description}</p>
        ) : null}
        <p className="mt-3 text-[10px] uppercase tracking-widest text-white/50">
          {t("itemZoom.closeHint")}
        </p>
      </div>
    </div>
  );
}
