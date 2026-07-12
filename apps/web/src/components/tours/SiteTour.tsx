import { useCallback, useMemo, useRef } from "react";
import { Compass } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChat } from "../../state/store.js";
import { parseInline } from "../../lib/markdown.js";
import { CoachTour, type CoachStep } from "./CoachTour.js";

/**
 * First-run guided tour of the whole chat screen.
 *
 * The site's counterpart to {@link DesignerTour}: a one-minute walkthrough
 * whose steps COACH the first actions that keep new members around — see who's
 * here, find the room where people are talking, say a first line, make a
 * character when ready, and where the slower-paced stuff (forums, worlds,
 * stories) lives for the quiet hours. It's a thin wrapper over the reusable
 * {@link CoachTour} overlay; all it owns is the step copy, the mobile drawer
 * staging, and the close side effects.
 *
 * When to show: the shell mounts this either because `/me/profile` reported
 * `showSiteTour` (the server's seen-once gate) or because the user asked to
 * replay it from Help (`branding`-independent `siteTourForced` store flag).
 *
 * MOBILE drawer staging: on phones the userlist / room list / identity /
 * Menu / server-rail targets all live inside the right-side navigation
 * drawer, which is CLOSED by default — a spotlight there used to point at
 * nothing. Steps that target drawer content carry a `prepare` that opens the
 * drawer (via the `railOpen`/`setRailOpen` pair App owns) so the tour
 * demonstrates the real control; steps whose target lives in the main pane
 * close it again, and finishing/skipping restores whatever state the drawer
 * had when the tour began. On desktop (lg+) the drawer dissolves into static
 * columns and every prepare is a no-op.
 *
 * On close (finish OR skip — outside clicks no longer dismiss, see
 * CoachTour), it does two things so the tour never re-nags:
 *   1. POST /me/tour/dismiss — records SITE_TOUR_VERSION server-side so the
 *      next /me/profile reports `showSiteTour:false`.
 *   2. setSiteTourForced(false) — clears any pending replay request so the
 *      shell unmounts the overlay.
 */

/** Matches the drawer's `lg:contents` breakpoint: below lg the right-side
 *  navigation cluster is a slide-in overlay. */
function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
}

export function SiteTour({
  onClose,
  railOpen,
  setRailOpen,
}: {
  onClose: () => void;
  /** Current mobile-drawer state, captured at mount for the final restore. */
  railOpen?: boolean;
  /** Open/close the mobile right-side navigation drawer (App's railOpen). */
  setRailOpen?: (open: boolean) => void;
}) {
  const { t } = useTranslation("tours");
  const serversEnabled = useChat((s) => s.branding.serversEnabled === true);
  const isAdult = useChat((s) => s.viewerAge.isAdult === true);
  const setSiteTourForced = useChat((s) => s.setSiteTourForced);

  // Drawer state at tour start, restored on close. Captured once at mount —
  // the prop keeps updating as prepares toggle the drawer, and re-reading it
  // later would "restore" a mid-tour state.
  const initialRailOpen = useRef(railOpen === true);

  // Stage the drawer for a step. Idempotent (two consecutive drawer steps
  // re-"open" an already-open drawer with no flicker) and mobile-only.
  const stageDrawer = useCallback(
    (open: boolean) => () => {
      if (!setRailOpen || !isMobileViewport()) return;
      setRailOpen(open);
    },
    [setRailOpen],
  );

  // Copy follows the help-content voice: plain, friendly, no dev jargon —
  // and every step coaches an ACTION, not a piece of chrome.
  // Built at render time (not module scope) so a language switch re-renders it.
  // The communities step is only meaningful when the server rail is rendered.
  const steps = useMemo<CoachStep[]>(() => {
    const list: CoachStep[] = [
      {
        title: t("site.welcome.title"),
        body: t("site.welcome.body"),
        prepare: stageDrawer(false),
      },
      {
        title: t("site.people.title"),
        body: t("site.people.body"),
        targets: ['[data-tour="rooms-tree"]'],
        prepare: stageDrawer(true),
      },
      {
        title: t("site.rooms.title"),
        body: t("site.rooms.body"),
        targets: ['[data-tour="rooms-tree"]'],
        prepare: stageDrawer(true),
      },
      {
        title: t("site.firstLine.title"),
        body: t("site.firstLine.body"),
        targets: ['[data-tour="composer"]'],
        // The composer lives in the main pane; the drawer would cover it.
        prepare: stageDrawer(false),
      },
      {
        title: t("site.character.title"),
        body: t("site.character.body"),
        targets: ['[data-tour="identity-button"]'],
        prepare: stageDrawer(true),
      },
      {
        title: t("site.quiet.title"),
        body: t("site.quiet.body"),
        targets: ['[data-tour="menu-button"]'],
        prepare: stageDrawer(true),
      },
    ];
    if (isAdult) {
      // Adults only: minors never see an 18+ channel (the toggle doesn't
      // render for them), so this step would describe an invisible
      // control. The body runs through parseInline so its {rules} token
      // renders as the live rules chip.
      list.push({
        title: t("site.channels.title"),
        body: parseInline(t("site.channels.body")),
        targets: ['[data-tour="rooms-tree"]'],
        prepare: stageDrawer(true),
      });
    }
    if (serversEnabled) {
      list.push({
        title: t("site.communities.title"),
        body: t("site.communities.body"),
        targets: ['[data-tour="server-rail"]'],
        prepare: stageDrawer(true),
      });
    }
    return list;
  }, [serversEnabled, isAdult, t, stageDrawer]);

  const handleClose = useCallback(() => {
    // Put the mobile drawer back the way the tour found it.
    if (setRailOpen && isMobileViewport()) setRailOpen(initialRailOpen.current);
    // Record the seen version so the server stops auto-opening the tour.
    // Fire-and-forget: a failed write just means the tour may re-offer on a
    // later load, which is harmless — never block dismissal on the network.
    void fetch("/me/tour/dismiss", { method: "POST", credentials: "include" }).catch(() => {});
    // Clear any pending replay request so the shell unmounts us.
    setSiteTourForced(false);
    onClose();
  }, [onClose, setSiteTourForced, setRailOpen]);

  return (
    <CoachTour
      steps={steps}
      onClose={handleClose}
      icon={<Compass className="h-4 w-4" aria-hidden />}
    />
  );
}
