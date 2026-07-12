import { DoorOpen, Landmark, MessageCircle, Sparkles, Users, X } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Newcomer "start here" empty-state panel (retention package).
 *
 * A warm, dismissible strip at the BOTTOM of the message feed — not a modal —
 * shown to accounts younger than 48h. It exists because the funnel data says
 * most never-returning registrants do NOTHING after signup: this hands them
 * three-or-four one-tap first actions instead of a blinking cursor.
 *
 * Lifecycle is owned by App: dismissal persists per device (`tk:` localStorage)
 * and the panel auto-hides once the user has sent a few messages — by then
 * they're talking, which is the whole point. Deliberately static (no
 * entrance animation), so there is nothing to gate on Reduce Motion.
 */
export function NewcomerStartPanel({
  onSayHi,
  onSeePeople,
  onFindRoom,
  onExplore,
  onDismiss,
}: {
  /** Prefill + focus the composer with a friendly opener. */
  onSayHi: () => void;
  /** Show the userlist (opens the drawer on mobile, flashes it on desktop). */
  onSeePeople: () => void;
  /** Show the room list with its headcounts. */
  onFindRoom: () => void;
  /** Open the forums/lore for the quiet hours. */
  onExplore: () => void;
  /** Persistently dismiss the panel on this device. */
  onDismiss: () => void;
}) {
  const { t } = useTranslation("chat");
  const action =
    "inline-flex items-center gap-1.5 rounded border border-keep-action/50 bg-keep-action/10 px-2.5 py-1 text-[11px] font-semibold text-keep-action hover:bg-keep-action/20";
  return (
    <div className="mx-3 mb-2 shrink-0 rounded-lg border border-keep-rule bg-keep-banner/50 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-keep-text">{t("newcomer.title")}</div>
          <p className="mt-0.5 text-xs text-keep-muted">{t("newcomer.body")}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" onClick={onSayHi} className={action}>
              <MessageCircle className="h-3.5 w-3.5" aria-hidden />
              {t("newcomer.sayHi")}
            </button>
            <button type="button" onClick={onSeePeople} className={action}>
              <Users className="h-3.5 w-3.5" aria-hidden />
              {t("newcomer.seePeople")}
            </button>
            <button type="button" onClick={onFindRoom} className={action}>
              <DoorOpen className="h-3.5 w-3.5" aria-hidden />
              {t("newcomer.findRoom")}
            </button>
            <button type="button" onClick={onExplore} className={action}>
              <Landmark className="h-3.5 w-3.5" aria-hidden />
              {t("newcomer.explore")}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          title={t("newcomer.dismiss")}
          aria-label={t("newcomer.dismiss")}
          className="shrink-0 rounded p-0.5 text-keep-muted hover:bg-keep-bg hover:text-keep-text"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
