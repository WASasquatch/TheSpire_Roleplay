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
import type { TourId } from "@thekeep/shared";
import type { CoachStep } from "../../components/CoachTour.js";
import { steps as forumsBrowseSteps } from "./forumsBrowse.js";
import { steps as forumPostingSteps } from "./forumPosting.js";
import { steps as forumCreateSteps } from "./forumCreate.js";
import { steps as forumAdminSteps } from "./forumAdmin.js";
import { steps as serverCreateSteps } from "./serverCreate.js";
import { steps as serverAdminSteps } from "./serverAdmin.js";
import { steps as siteAdminSteps } from "./siteAdmin.js";

/**
 * Client-side catalog of contextual tour content: the CoachStep list + header
 * icon for each shared TourId. The step arrays live in per-surface modules
 * (owned by the surface teams) and start empty; a tour with no steps simply
 * doesn't open. <ContextualTour> reads this registry to drive <CoachTour>.
 */
export const TOUR_REGISTRY: Record<TourId, { steps: CoachStep[]; icon: ReactNode }> = {
  "forums-browse": { steps: forumsBrowseSteps, icon: <Compass /> },
  "forum-posting": { steps: forumPostingSteps, icon: <PenSquare /> },
  "forum-create": { steps: forumCreateSteps, icon: <Plus /> },
  "forum-admin": { steps: forumAdminSteps, icon: <Shield /> },
  "server-create": { steps: serverCreateSteps, icon: <Landmark /> },
  "server-admin": { steps: serverAdminSteps, icon: <Settings /> },
  "site-admin": { steps: siteAdminSteps, icon: <ShieldAlert /> },
};
