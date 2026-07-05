import { useCallback, useMemo } from "react";
import { Compass } from "lucide-react";
import { CoachTour, type CoachStep } from "./CoachTour.js";
import { useChat } from "../state/store.js";

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

// Copy follows the help-content voice: plain, friendly, no dev jargon.
const WELCOME_STEP: CoachStep = {
  title: "Welcome to The Spire",
  body: "Here is a quick tour of the screen so you know where everything is. It takes about a minute, and you can replay it any time from Help.",
};

const IDENTITY_STEP: CoachStep = {
  title: "You and your characters",
  body: "This button at the bottom of the rail shows who you are posting as. Click it to switch into a character, create one, or go back to yourself. To open your own profile, use the Menu just below, or type /profile.",
  targets: ['[data-tour="identity-button"]'],
};

const MENU_STEP: CoachStep = {
  title: "The Menu holds everything",
  body: "Open the Menu for your profile, worlds, forums, messages, friends, and Help. When you are not sure where something lives, look here first.",
  targets: ['[data-tour="menu-button"]'],
};

const COMPOSER_STEP: CoachStep = {
  title: "Say something",
  body: "Type here and press Enter to talk. Start a line with / for commands, @ to mention someone, or : to write an action.",
  targets: ['[data-tour="composer"]'],
};

const ROOMS_STEP: CoachStep = {
  title: "Move between rooms",
  body: "Every room you can join is listed here with its headcount. Click a room's name to hop in. Private rooms ask for a password.",
  targets: ['[data-tour="rooms-tree"]'],
};

const COMMUNITIES_STEP: CoachStep = {
  title: "Explore communities",
  body: "These icons are the communities you have joined. Use the button at the bottom to discover more, or to apply to start your own.",
  targets: ['[data-tour="server-rail"]'],
};

const FORUMS_STEP: CoachStep = {
  title: "Forums, and this tour again",
  body: "Forums, for writing you want to keep, live in the Menu and above the room list. You can replay this whole tour any time from Help.",
  targets: ['[data-tour="menu-button"]'],
};

export function SiteTour({ onClose }: { onClose: () => void }) {
  const serversEnabled = useChat((s) => s.branding.serversEnabled === true);
  const setSiteTourForced = useChat((s) => s.setSiteTourForced);

  // The communities step is only meaningful when the server rail is rendered.
  const steps = useMemo<CoachStep[]>(() => {
    const list: CoachStep[] = [
      WELCOME_STEP,
      IDENTITY_STEP,
      MENU_STEP,
      COMPOSER_STEP,
      ROOMS_STEP,
    ];
    if (serversEnabled) list.push(COMMUNITIES_STEP);
    list.push(FORUMS_STEP);
    return list;
  }, [serversEnabled]);

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
