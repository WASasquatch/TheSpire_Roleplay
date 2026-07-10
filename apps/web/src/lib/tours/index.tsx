import type { ReactNode } from "react";
import {
  Compass,
  Landmark,
  PenSquare,
  Plus,
  Settings,
  Shield,
  ShieldAlert,
} from "lucide-react";
import type { TFunction } from "i18next";
import type { TourId } from "@thekeep/shared";
import type { CoachStep } from "../../components/tours/CoachTour.js";
import { steps as forumsBrowseSteps } from "./forumsBrowse.js";
import { steps as forumPostingSteps } from "./forumPosting.js";
import { steps as forumCreateSteps } from "./forumCreate.js";
import { steps as forumAdminSteps } from "./forumAdmin.js";
import { steps as serverCreateSteps } from "./serverCreate.js";
import { steps as serverAdminSteps } from "./serverAdmin.js";
import { steps as siteAdminSteps } from "./siteAdmin.js";

/**
 * Client-side catalog of contextual tour content: the CoachStep builder + header
 * icon for each shared TourId. The step builders live in per-surface modules
 * (owned by the surface teams) and resolve their copy through the `tours`
 * namespace at render time — a function of `t`, not a module constant, so a
 * language flip re-renders with the new copy. A tour whose builder returns no
 * steps simply doesn't open. <ContextualTour> reads this registry to drive
 * <CoachTour>.
 */
export const TOUR_REGISTRY: Record<
  TourId,
  { steps: (t: TFunction<"tours">) => CoachStep[]; icon: ReactNode }
> = {
  "forums-browse": { steps: forumsBrowseSteps, icon: <Compass /> },
  "forum-posting": { steps: forumPostingSteps, icon: <PenSquare /> },
  "forum-create": { steps: forumCreateSteps, icon: <Plus /> },
  "forum-admin": { steps: forumAdminSteps, icon: <Shield /> },
  "server-create": { steps: serverCreateSteps, icon: <Landmark /> },
  "server-admin": { steps: serverAdminSteps, icon: <Settings /> },
  "site-admin": { steps: siteAdminSteps, icon: <ShieldAlert /> },
};
