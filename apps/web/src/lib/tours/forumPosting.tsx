import type { TFunction } from "i18next";
import type { CoachStep } from "../../components/tours/CoachTour.js";

/**
 * Forum-posting tour. Fires on a board's front page. The "New Topic" button
 * is on screen immediately, so that step spotlights it; the composer steps
 * (title, NSFW tag, post) carry targets too and light up the moment the
 * writer actually opens a composer — CoachTour keeps polling for
 * late-mounting targets and centers the card until then, so following along
 * turns the narration into real highlights. The Say/Action and NPC steps
 * stay centered narration: those toggles belong to the reply composer inside
 * a thread, which can't exist on the board front page.
 */
export const steps = (t: TFunction<"tours">): CoachStep[] => [
  {
    title: t("forumPosting.startTopic.title"),
    body: t("forumPosting.startTopic.body"),
    targets: ['[data-tour="forum-new-topic-btn"]'],
  },
  {
    title: t("forumPosting.giveTitle.title"),
    body: t("forumPosting.giveTitle.body"),
    targets: ['[data-tour="forum-topic-title-input"]'],
  },
  {
    title: t("forumPosting.tag.title"),
    body: t("forumPosting.tag.body"),
    // Adult accounts only — minors never render the tag control, so the
    // step centers for them (the copy still reads fine as narration).
    targets: ['[data-tour="forum-composer-tag"]'],
  },
  {
    title: t("forumPosting.sayOrAct.title"),
    body: t("forumPosting.sayOrAct.body"),
  },
  {
    title: t("forumPosting.npc.title"),
    body: t("forumPosting.npc.body"),
  },
  {
    title: t("forumPosting.post.title"),
    body: t("forumPosting.post.body"),
    targets: ['[data-tour="forum-composer-post"]'],
  },
];
