/**
 * Curated set of Lucide icons a manager can attach to a community event, shown
 * before the event title on the calendar. Events store a stable lowercase slug
 * (e.g. "sword"); this maps the slug to its Lucide component. Add entries to
 * offer more; removing one just makes stored events with that slug render
 * without an icon (never an error). Keep the slugs in sync with the server's
 * icon validation (a plain [a-z0-9-] slug; see servers/events.ts).
 *
 * The set spans BOTH the RP/fantasy flavor (sword, crown, scroll, …) AND the
 * everyday-community events communities actually schedule — watch parties,
 * listening sessions, game nights, art jams, workshops, Q&As, meetups,
 * giveaways, seasonal socials — so a manager isn't forced to label a movie
 * night with a broadsword. Grouped below by theme; the picker renders them in
 * this order.
 */
import {
  // Calendar / general
  CalendarDays,
  Star,
  Sparkles,
  Megaphone,
  Bell,
  PartyPopper,
  Users,
  Heart,
  Flag,
  Globe,
  // RP / fantasy
  Sword,
  Swords,
  Shield,
  Crown,
  Skull,
  Ghost,
  Dices,
  Flame,
  Moon,
  Sun,
  Landmark,
  // Writing / lore
  BookOpen,
  Scroll,
  Feather,
  Drama,
  // Watch parties / screen / broadcast
  Film,
  Clapperboard,
  Popcorn,
  Tv,
  Video,
  // Music / audio
  Music,
  Mic,
  Headphones,
  Radio,
  Guitar,
  Disc3,
  // Food & drink / social
  Coffee,
  Wine,
  Beer,
  Pizza,
  Cake,
  UtensilsCrossed,
  IceCream,
  // Creative / art / photo
  Palette,
  Paintbrush,
  Camera,
  Image as ImageIcon,
  Pencil,
  // Games / competition
  Gamepad2,
  Gamepad,
  Joystick,
  Puzzle,
  Target,
  Trophy,
  Medal,
  Award,
  // Learning / talks / meetings
  GraduationCap,
  Lightbulb,
  Presentation,
  Brain,
  MessagesSquare,
  HelpCircle,
  Vote,
  Handshake,
  ClipboardList,
  // Time / scheduling
  Clock,
  Timer,
  Hourglass,
  // Travel / outdoors / seasonal
  MapPin,
  Compass,
  Mountain,
  TreePine,
  Tent,
  Ship,
  Rocket,
  Snowflake,
  // Rewards / tickets
  Gift,
  Ticket,
  Zap,
  type LucideIcon,
} from "lucide-react";

/** Slug -> Lucide component. The slug is what gets stored on the event. */
export const EVENT_ICONS: Record<string, LucideIcon> = {
  // Calendar / general
  calendar: CalendarDays,
  star: Star,
  sparkles: Sparkles,
  megaphone: Megaphone,
  bell: Bell,
  party: PartyPopper,
  users: Users,
  heart: Heart,
  flag: Flag,
  globe: Globe,
  // RP / fantasy
  sword: Sword,
  swords: Swords,
  shield: Shield,
  crown: Crown,
  skull: Skull,
  ghost: Ghost,
  dice: Dices,
  flame: Flame,
  moon: Moon,
  sun: Sun,
  landmark: Landmark,
  // Writing / lore
  book: BookOpen,
  scroll: Scroll,
  feather: Feather,
  drama: Drama,
  // Watch parties / screen / broadcast
  film: Film,
  clapperboard: Clapperboard,
  popcorn: Popcorn,
  tv: Tv,
  video: Video,
  // Music / audio
  music: Music,
  mic: Mic,
  headphones: Headphones,
  radio: Radio,
  guitar: Guitar,
  disc: Disc3,
  // Food & drink / social
  coffee: Coffee,
  wine: Wine,
  beer: Beer,
  pizza: Pizza,
  cake: Cake,
  utensils: UtensilsCrossed,
  icecream: IceCream,
  // Creative / art / photo
  palette: Palette,
  paintbrush: Paintbrush,
  camera: Camera,
  image: ImageIcon,
  pencil: Pencil,
  // Games / competition
  game: Gamepad2,
  gamepad: Gamepad,
  joystick: Joystick,
  puzzle: Puzzle,
  target: Target,
  trophy: Trophy,
  medal: Medal,
  award: Award,
  // Learning / talks / meetings
  graduation: GraduationCap,
  lightbulb: Lightbulb,
  presentation: Presentation,
  brain: Brain,
  chat: MessagesSquare,
  question: HelpCircle,
  vote: Vote,
  handshake: Handshake,
  clipboard: ClipboardList,
  // Time / scheduling
  clock: Clock,
  timer: Timer,
  hourglass: Hourglass,
  // Travel / outdoors / seasonal
  map: MapPin,
  compass: Compass,
  mountain: Mountain,
  tree: TreePine,
  tent: Tent,
  ship: Ship,
  rocket: Rocket,
  snowflake: Snowflake,
  // Rewards / tickets
  gift: Gift,
  ticket: Ticket,
  zap: Zap,
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
