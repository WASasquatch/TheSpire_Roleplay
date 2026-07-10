import type { ReactNode } from "react";
import type { PermissionKey } from "@thekeep/shared";

/** One long-form Help guide (a collapsible section on the Guides tab). */
export interface HelpGuide {
  id: string;
  title: string;
  body: ReactNode;
  /** Only shown to viewers holding this permission (e.g. the Theater guides). */
  requiresPermission?: PermissionKey;
}

/**
 * A locale module's rendering of ONE guide: translated copy only. The id,
 * ordering, and permission gate always come from the canonical English
 * module (./en.tsx) — translations can never add, remove, or re-gate guides.
 */
export interface HelpGuideTranslation {
  title: string;
  body: ReactNode;
}

/**
 * What `./locales/<lng>.tsx` exports as `guides`: translated content keyed
 * by canonical guide id. Any SUBSET of ids is valid — guides missing from a
 * locale module fall back to English individually (see HelpGuides.tsx), so
 * a partially-translated locale renders mixed rather than blank.
 */
export type HelpGuideTranslations = Partial<Record<string, HelpGuideTranslation>>;
