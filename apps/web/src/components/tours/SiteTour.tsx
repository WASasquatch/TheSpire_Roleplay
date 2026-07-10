import { useCallback, useMemo } from "react";
import { Compass } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChat } from "../../state/store.js";
import { CoachTour, type CoachStep } from "./CoachTour.js";

/**
 * First-run guided tour of the whole chat screen.
 *
 * The site's counterpart to {@link DesignerTour}: a one-minute walkthrough that
 * points at the real UI (identity button, Menu, composer, room list, and — when
 * the multi-server feature is on — the community rail) so a brand-new member
 * knows where everything lives. It's a thin wrapper over the reusable
 * {@link CoachTour} overlay; all it owns is the step copy and the close side
 * effects.
 *
 * When to show: the shell mounts this either because `/me/profile` reported
 * `showSiteTour` (the server's seen-once gate) or because the user asked to
 * replay it from Help (`branding`-independent `siteTourForced` store flag).
 *
 * On close (finish OR skip), it does two things so the tour never re-nags:
 *   1. POST /me/tour/dismiss — records SITE_TOUR_VERSION server-side so the next
 *      /me/profile reports `showSiteTour:false`.
 *   2. setSiteTourForced(false) — clears any pending replay request so the shell
 *      unmounts the overlay.
 *
 * The community step is conditional on the servers feature being enabled
 * (`branding.serversEnabled`), matching the ServerRail's own gate — with the
 * flag off the rail never renders, so a step pointing at it would spotlight
 * nothing.
 */

export function SiteTour({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("tours");
  const serversEnabled = useChat((s) => s.branding.serversEnabled === true);
  const setSiteTourForced = useChat((s) => s.setSiteTourForced);

  // Copy follows the help-content voice: plain, friendly, no dev jargon.
  // Built at render time (not module scope) so a language switch re-renders it.
  // The communities step is only meaningful when the server rail is rendered.
  const steps = useMemo<CoachStep[]>(() => {
    const list: CoachStep[] = [
      {
        title: t("site.welcome.title"),
        body: t("site.welcome.body"),
      },
      {
        title: t("site.identity.title"),
        body: t("site.identity.body"),
        targets: ['[data-tour="identity-button"]'],
      },
      {
        title: t("site.menu.title"),
        body: t("site.menu.body"),
        targets: ['[data-tour="menu-button"]'],
      },
      {
        title: t("site.composer.title"),
        body: t("site.composer.body"),
        targets: ['[data-tour="composer"]'],
      },
      {
        title: t("site.rooms.title"),
        body: t("site.rooms.body"),
        targets: ['[data-tour="rooms-tree"]'],
      },
    ];
    if (serversEnabled) {
      list.push({
        title: t("site.communities.title"),
        body: t("site.communities.body"),
        targets: ['[data-tour="server-rail"]'],
      });
    }
    list.push({
      title: t("site.forums.title"),
      body: t("site.forums.body"),
      targets: ['[data-tour="menu-button"]'],
    });
    return list;
  }, [serversEnabled, t]);

  const handleClose = useCallback(() => {
    // Record the seen version so the server stops auto-opening the tour.
    // Fire-and-forget: a failed write just means the tour may re-offer on a
    // later load, which is harmless — never block dismissal on the network.
    void fetch("/me/tour/dismiss", { method: "POST", credentials: "include" }).catch(() => {});
    // Clear any pending replay request so the shell unmounts us.
    setSiteTourForced(false);
    onClose();
  }, [onClose, setSiteTourForced]);

  return (
    <CoachTour
      steps={steps}
      onClose={handleClose}
      icon={<Compass className="h-4 w-4" aria-hidden />}
    />
  );
}
