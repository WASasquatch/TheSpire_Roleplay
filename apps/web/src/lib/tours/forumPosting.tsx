import type { CoachStep } from "../../components/tours/CoachTour.js";

/**
 * Forum-posting tour. Fires on a board's front page, where only the section
 * headers and their "New Topic" buttons are on screen — the topic composer and
 * its Say / Action / NPC toggles don't mount until you actually open one. So
 * every step here is a centered card that narrates the flow; none spotlight the
 * composer fields, which would center on nothing until you start writing.
 */
export const steps: CoachStep[] = [
  {
    title: "Start a topic",
    body: "Each section on a board has a New Topic button. Click it to open a fresh topic right where you want it.",
  },
  {
    title: "Give it a title",
    body: "When the topic opens, name it at the top, then write your opening post just below.",
  },
  {
    title: "Tag it",
    body: "Add a tag so people can tell at a glance what a topic is about. You'll find the tag picker on the topic once it's open.",
  },
  {
    title: "Say or act",
    body: "Replies default to speech. Switch a reply to Action to describe what your character does instead of what they say.",
  },
  {
    title: "Voice an NPC",
    body: "If the keeper allows it, switch a reply to NPC to post as one of your saved characters and bring the scene to life.",
  },
  {
    title: "Post it",
    body: "When you're happy, send your reply and it joins the topic for everyone to read.",
  },
];
