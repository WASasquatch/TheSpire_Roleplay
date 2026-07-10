import { useMemo } from "react";
import { Paintbrush2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CoachTour, type CoachStep } from "./CoachTour.js";

/**
 * First-run coach tour for the profile bio Designer.
 *
 * Most members don't write HTML, so the Designer is now the default editing
 * surface. This walks a first-time user through the few things they need: where
 * the blocks are, that they drop onto the page and click to edit, the
 * Designer/Source toggle, and Save. It spotlights real elements (GrapesJS's
 * blocks panel + canvas, the editor's toggle + Save button) by their bounding
 * box, with a tooltip card and Back/Next/Skip controls.
 *
 * This is now a thin wrapper over the reusable {@link CoachTour} overlay — the
 * spotlight/placement/keyboard/reduced-motion behavior all live there. Here we
 * only own the Designer-specific STEPS + the Paintbrush2 header icon. The
 * external API is unchanged (ProfileEditor still mounts `<DesignerTour onClose />`).
 */

export function DesignerTour({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("tours");

  // Copy follows the help-content voice: plain, friendly, no dev jargon.
  // Built at render time (not module scope) so a language switch re-renders it.
  const steps = useMemo<CoachStep[]>(
    () => [
      {
        title: t("designer.welcome.title"),
        body: t("designer.welcome.body"),
      },
      {
        title: t("designer.blocks.title"),
        body: t("designer.blocks.body"),
        targets: [".gjs-blocks-c", ".gjs-pn-views-container", ".profile-designer"],
      },
      {
        title: t("designer.canvas.title"),
        body: t("designer.canvas.body"),
        targets: [".gjs-cv-canvas", ".profile-designer"],
      },
      {
        title: t("designer.mode.title"),
        body: t("designer.mode.body"),
        targets: ['[data-tour="bio-mode-toggle"]'],
      },
      {
        title: t("designer.save.title"),
        body: t("designer.save.body"),
        targets: ['[data-tour="profile-save"]'],
      },
    ],
    [t],
  );

  return (
    <CoachTour
      steps={steps}
      onClose={onClose}
      icon={<Paintbrush2 className="h-4 w-4" aria-hidden />}
    />
  );
}
