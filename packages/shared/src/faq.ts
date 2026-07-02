/**
 * FAQ — admin-authored question/answer entries with per-entry URL slugs.
 *
 * Each entry has a globally-unique slug so a mod can paste a direct link
 * (`/faq/<slug>`) — including to logged-out visitors. The public index lives
 * at `/faqs`. Mirrors the slug/validation pattern of forums (see forum.ts).
 *
 * Wire types here are shared by the public read routes, the public pages,
 * and the admin CRUD tab.
 */

/** Slug shape: lowercase letters, digits, underscore. `/faq/how_worlds_work`. */
export const FAQ_SLUG_RE = /^[a-z0-9_]{3,40}$/;

/** Slugs reserved against route collisions / future surfaces (case-insensitive). */
export const RESERVED_FAQ_SLUGS: ReadonlySet<string> = new Set([
  "faq", "faqs", "api", "admin", "new", "edit", "create",
  "slug_availability", "slug-availability", "all", "index",
]);

export const FAQ_QUESTION_MAX = 200;
export const FAQ_ANSWER_MAX = 8000;
export const FAQ_CATEGORY_MAX = 60;

/**
 * Normalize + validate a candidate slug. Lowercases and trims, then checks the
 * shape and the reserved set. Returns the clean slug or null if invalid.
 */
export function normalizeFaqSlug(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!FAQ_SLUG_RE.test(s)) return null;
  if (RESERVED_FAQ_SLUGS.has(s)) return null;
  return s;
}

/** Public FAQ entry shape (enabled rows). `answerHtml` is sanitized server-side. */
export interface FaqEntry {
  id: string;
  slug: string;
  question: string;
  answerHtml: string;
  category: string | null;
  sortOrder: number;
}

/** Admin FAQ row (adds the draft/audit fields + the markdown source the
 *  editor round-trips, so re-editing doesn't double-wrap the stored HTML). */
export interface FaqAdminEntry extends FaqEntry {
  answerMarkdown: string;
  enabled: boolean;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A starter FAQ (slug + question + category + Markdown answer source). */
export interface DefaultFaq {
  slug: string;
  question: string;
  category: string;
  answerMarkdown: string;
}

/**
 * Starter FAQ set. Seeded on first boot (server `seed.ts`, only when the table
 * is empty) so a fresh install ships real, crawlable FAQ content at `/faqs`
 * instead of a blank page, and rendered on the public splash (`SplashFaq`).
 * These are a STARTING BASIS — admins can edit, reorder, disable, or extend
 * them from the FAQ admin tab; the seed never overwrites existing rows.
 *
 * Answers are plain prose (Markdown-compatible, no complex syntax) so the same
 * source renders both as sanitized HTML in `/faqs` and as plain paragraphs on
 * the splash. Tuned to the platform positioning: join the native RP community,
 * OR host your own chat community / forums.
 */
export const DEFAULT_FAQS: readonly DefaultFaq[] = [
  {
    slug: "what_is_the_spire",
    question: "What is The Spire?",
    category: "Getting started",
    answerMarkdown:
      "The Spire is a home for live, text-based roleplay, and a platform where anyone can host their own community. Join the native community to write with others in real time, or start your own space with its own chat rooms, forums, members, and rules.",
  },
  {
    slug: "is_it_free",
    question: "Is it free?",
    category: "Getting started",
    answerMarkdown:
      "Yes. Joining is free, and so is hosting your own community or forum. Create a character and start writing, or launch a community, without paying anything.",
  },
  {
    slug: "what_can_i_do",
    question: "What can I do here?",
    category: "Getting started",
    answerMarkdown:
      "Step into live chat rooms, build characters with custom profiles, explore shared worlds and lore, write long-form stories in the Scriptorium, and earn cosmetics as you play.",
  },
  {
    slug: "host_my_own_community",
    question: "Can I host my own community?",
    category: "Hosting",
    answerMarkdown:
      "Yes. You can create your own chat community with its own rooms, members, roles, economy, and moderation, plus your own forum boards with a public page you can share anywhere.",
  },
  {
    slug: "hosted_vs_main_spire",
    question: "How is a hosted community different from the main Spire?",
    category: "Hosting",
    answerMarkdown:
      "The main Spire is our native roleplay community, open to everyone. A hosted community is your own space that you run and moderate, with its own members and settings, living alongside the main one.",
  },
  {
    slug: "chat_rooms_vs_forums",
    question: "What's the difference between chat rooms and forums?",
    category: "Hosting",
    answerMarkdown:
      "Chat rooms are for live, real-time roleplay. Forums are for slower, threaded play-by-post and discussion that people reply to over days or weeks. You can use either or both in your community.",
  },
  {
    slug: "do_i_need_to_install",
    question: "Do I need to install anything?",
    category: "Getting started",
    answerMarkdown:
      "No. The Spire runs in your browser on desktop and mobile, with nothing to download.",
  },
  {
    slug: "age_and_safety",
    question: "Is there an age requirement, and is it safe?",
    category: "Safety",
    answerMarkdown:
      "Please review our house rules before joining. The Spire provides moderation tools, user blocking, and content controls; mature themes are gated, and every hosted community can set and enforce its own standards.",
  },
  {
    slug: "how_do_i_get_started",
    question: "How do I get started?",
    category: "Getting started",
    answerMarkdown:
      "Create a free account, make a character, and step into a public room, or open your community tools to start your own chat community or forum. Just browsing? You can read stories in the Scriptorium without an account.",
  },
];
