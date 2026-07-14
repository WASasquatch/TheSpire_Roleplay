/**
 * Lucide icon resolution for UI-route chips.
 *
 * The shared catalog (`uiRoutes.ts` + `arcade.ts`) stores each chip's
 * icon as a lucide-react icon NAME (PascalCase). This module is the
 * single web-side map from name → component, plus the `<UiRouteIcon>`
 * renderer used by every chip surface:
 *   - the React chat chip (`markdown.tsx` UiRouteChip),
 *   - the Help "Shortcut chips" reference (`HelpGuides.tsx`),
 *   - the HTML announcement hydrator (`hydrateUiRouteChips.ts`), which
 *     mounts this component into the placeholder spans the shared HTML
 *     generator emits.
 *
 * Only the icons the catalog actually references are imported, so the
 * bundle stays tree-shaken. An unknown name resolves to `null` and the
 * chip simply renders label-only (no broken glyph).
 */

import { createElement } from "react";
import {
  Award,
  Backpack,
  BookOpen,
  Boxes,
  Coins,
  Dices,
  DoorOpen,
  Egg,
  Frame,
  Gamepad2,
  Ghost,
  Globe,
  Heart,
  HelpCircle,
  LayoutDashboard,
  Library,
  Medal,
  Megaphone,
  MessageSquare,
  MessageSquareText,
  MessagesSquare,
  NotebookText,
  Package,
  Palette,
  PawPrint,
  Pickaxe,
  Pin,
  Scroll,
  Settings,
  Shield,
  ShoppingCart,
  Sparkles,
  Trophy,
  Type,
  UserCircle,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

/** name → component. Keys MUST match the `icon` values in the shared catalog. */
const UI_ROUTE_ICONS: Record<string, LucideIcon> = {
  Award,
  Backpack,
  BookOpen,
  Boxes,
  Coins,
  Dices,
  DoorOpen,
  Egg,
  Frame,
  Gamepad2,
  Ghost,
  Globe,
  Heart,
  HelpCircle,
  LayoutDashboard,
  Library,
  Medal,
  Megaphone,
  MessageSquare,
  MessageSquareText,
  MessagesSquare,
  NotebookText,
  Package,
  Palette,
  PawPrint,
  Pickaxe,
  Pin,
  Scroll,
  Settings,
  Shield,
  ShoppingCart,
  Sparkles,
  Trophy,
  Type,
  UserCircle,
  UserPlus,
};

/** Resolve a catalog icon name to its lucide component, or null when unknown. */
export function uiRouteIconComponent(name: string | null | undefined): LucideIcon | null {
  if (!name) return null;
  return UI_ROUTE_ICONS[name] ?? null;
}

/**
 * Inline chip glyph. Sized to ~1em so it tracks the surrounding label
 * text; the chip wrapper's `inline-flex items-center` handles vertical
 * alignment. Renders nothing for an unknown/absent name.
 */
export function UiRouteIcon({
  name,
  className = "inline-block h-[1em] w-[1em] shrink-0",
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const Icon = uiRouteIconComponent(name);
  if (!Icon) return null;
  return createElement(Icon, { "aria-hidden": true, className });
}
