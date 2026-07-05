/**
 * Curated set of Lucide icons a manager can attach to a community event, shown
 * before the event title on the calendar. Events store a stable lowercase slug
 * (e.g. "sword"); this maps the slug to its Lucide component. Add entries to
 * offer more; removing one just makes stored events with that slug render
 * without an icon (never an error). Keep the slugs in sync with the server's
 * icon validation (a plain [a-z0-9-] slug).
 */
import {
  CalendarDays,
  Sword,
  Swords,
  BookOpen,
  Sparkles,
  Crown,
  Users,
  Flame,
  Music,
  Drama,
  Dices,
  MapPin,
  Star,
  Gift,
  Skull,
  Trophy,
  Megaphone,
  PartyPopper,
  Ghost,
  Moon,
  Sun,
  Scroll,
  Shield,
  Heart,
  Zap,
  Feather,
  Mic,
  Gamepad2,
  Bell,
  Coffee,
  Wine,
  Landmark,
  type LucideIcon,
} from "lucide-react";

/** Slug -> Lucide component. The slug is what gets stored on the event. */
export const EVENT_ICONS: Record<string, LucideIcon> = {
  calendar: CalendarDays,
  sword: Sword,
  swords: Swords,
  book: BookOpen,
  sparkles: Sparkles,
  crown: Crown,
  users: Users,
  flame: Flame,
  music: Music,
  drama: Drama,
  dice: Dices,
  map: MapPin,
  star: Star,
  gift: Gift,
  skull: Skull,
  trophy: Trophy,
  megaphone: Megaphone,
  party: PartyPopper,
  ghost: Ghost,
  moon: Moon,
  sun: Sun,
  scroll: Scroll,
  shield: Shield,
  heart: Heart,
  zap: Zap,
  feather: Feather,
  mic: Mic,
  game: Gamepad2,
  bell: Bell,
  coffee: Coffee,
  wine: Wine,
  landmark: Landmark,
};

/** Stable ordered list of the offered icon slugs (for the picker grid). */
export const EVENT_ICON_NAMES = Object.keys(EVENT_ICONS);

/**
 * Render an event's icon by slug. Renders nothing for a null/unknown slug, so
 * it's always safe to drop before a title.
 */
export function EventIcon({
  name,
  className,
}: {
  name?: string | null;
  className?: string;
}) {
  const Icon = name ? EVENT_ICONS[name] : undefined;
  if (!Icon) return null;
  return <Icon className={className ?? "h-4 w-4"} aria-hidden="true" />;
}
