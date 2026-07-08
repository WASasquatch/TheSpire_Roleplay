import { Paintbrush2 } from "lucide-react";
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

// Copy follows the help-content voice: plain, friendly, no dev jargon.
const STEPS: CoachStep[] = [
  {
    title: "Welcome to the Designer",
    body: "Build your profile by dragging pieces onto the page. No code needed. Here's a quick tour.",
  },
  {
    title: "Your building blocks",
    body: "Drag any of these onto the page. The themed templates are ready-made styled sections; the plain blocks let you build your own. Hover one to preview what it is.",
    targets: [".gjs-blocks-c", ".gjs-pn-views-container", ".profile-designer"],
  },
  {
    title: "Your profile page",
    body: "Drop blocks here, then click any text to type your own. Select a piece to move or restyle it.",
    targets: [".gjs-cv-canvas", ".profile-designer"],
  },
  {
    title: "Designer or code",
    body: "Prefer writing your own HTML and CSS? Switch to Source any time. Your work carries across both ways.",
    targets: ['[data-tour="bio-mode-toggle"]'],
  },
  {
    title: "Save when you're ready",
    body: "Happy with it? Hit Save to publish your profile. You can come back and tweak it whenever you like.",
    targets: ['[data-tour="profile-save"]'],
  },
];

export function DesignerTour({ onClose }: { onClose: () => void }) {
  return (
    <CoachTour
      steps={STEPS}
      onClose={onClose}
      icon={<Paintbrush2 className="h-4 w-4" aria-hidden />}
    />
  );
}
