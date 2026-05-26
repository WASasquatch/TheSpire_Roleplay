import { and, eq, sql } from "drizzle-orm";
import { stories } from "../../db/schema.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Resolve a slug to a story id, preferring the caller's own stories
 * over public/unlisted matches.
 */
async function resolveStorySlug(ctx: CommandContext, slug: string) {
  const lower = slug.toLowerCase();
  const own = (await ctx.db
    .select()
    .from(stories)
    .where(and(eq(stories.authorUserId, ctx.user.id), sql`lower(${stories.slug}) = ${lower}`))
    .limit(1))[0];
  if (own) return own;
  const pub = (await ctx.db
    .select()
    .from(stories)
    .where(sql`lower(${stories.slug}) = ${lower}`)
    .limit(1))[0];
  return pub ?? null;
}

/**
 * /write              - open the editor on the most recently-edited
 *                       draft, or the New Story wizard if none.
 * /write new          - skip straight to the New Story wizard.
 * /write <slug>       - open the editor for a specific story you own.
 *
 * Aliases: /writing /fanfic.
 */
export const writeCommand: CommandHandler = {
  name: "write",
  aliases: ["writing", "fanfic"],
  usage: "/write | /write new | /write <slug>",
  description: "Open the Scriptorium editor on a draft or start a new story.",
  subcommands: [
    { verb: "(no args)", usage: "/write", description: "Open the editor on your most recently-edited draft." },
    { verb: "new", usage: "/write new", description: "Open the New Story wizard." },
    { verb: "(slug)", usage: "/write <slug>", description: "Edit one of your stories by slug." },
  ],
  async run(ctx) {
    const [first, ...rest] = ctx.args;
    const head = (first ?? "").toLowerCase();

    if (head === "new") {
      ctx.socket.emit("ui:hint", { kind: "open-story-editor", storyId: null });
      return;
    }

    if (first) {
      const slug = [first, ...rest].join(" ").trim();
      const s = (await ctx.db
        .select()
        .from(stories)
        .where(and(eq(stories.authorUserId, ctx.user.id), sql`lower(${stories.slug}) = ${slug.toLowerCase()}`))
        .limit(1))[0];
      if (!s) {
        return notice(ctx, "NO_STORY", `You don't have a story with slug "${slug}". /write new to start one.`);
      }
      ctx.socket.emit("ui:hint", { kind: "open-story-editor", storyId: s.id });
      return;
    }

    const recent = (await ctx.db
      .select()
      .from(stories)
      .where(eq(stories.authorUserId, ctx.user.id))
      .orderBy(sql`${stories.updatedAt} desc`)
      .limit(1))[0];
    ctx.socket.emit("ui:hint", { kind: "open-story-editor", storyId: recent?.id ?? null });
  },
};

/**
 * /story <slug>              - open the reader for a story.
 * /story <slug> chapter <N>  - jump to a specific chapter (1-indexed).
 */
export const storyCommand: CommandHandler = {
  name: "story",
  usage: "/story <slug> | /story <slug> chapter <N>",
  description: "Open a story in the reader. Pass `chapter N` to jump to a specific chapter.",
  subcommands: [
    { verb: "(slug)", usage: "/story <slug>", description: "Open the story landing page." },
    { verb: "chapter", usage: "/story <slug> chapter <N>", description: "Jump to chapter N (1-indexed)." },
  ],
  async run(ctx) {
    const first = ctx.args[0];
    if (!first) return notice(ctx, "USAGE", "Usage: /story <slug> [chapter <N>]");

    let slugTokens = ctx.args.slice();
    let chapterIndex: number | undefined;
    const idx = slugTokens.findIndex((t) => t.toLowerCase() === "chapter" || t.toLowerCase() === "ch");
    if (idx >= 0 && slugTokens[idx + 1]) {
      const n = parseInt(slugTokens[idx + 1]!, 10);
      if (!Number.isFinite(n) || n < 1) {
        return notice(ctx, "CH_USAGE", "Chapter index must be a positive integer.");
      }
      chapterIndex = n - 1;
      slugTokens = slugTokens.slice(0, idx);
    }
    const slug = slugTokens.join(" ").trim();
    if (!slug) return notice(ctx, "USAGE", "Usage: /story <slug>");

    const s = await resolveStorySlug(ctx, slug);
    if (!s) return notice(ctx, "NO_STORY", `No story with slug "${slug}".`);
    ctx.socket.emit("ui:hint", {
      kind: "open-story",
      storyId: s.id,
      ...(chapterIndex !== undefined ? { chapterIndex } : {}),
    });
  },
};

/**
 * /scriptorium [tab]   - open the in-app Scriptorium catalog.
 *                        Aliases: /stories
 */
export const scriptoriumCommand: CommandHandler = {
  name: "scriptorium",
  aliases: ["stories"],
  usage: "/scriptorium [find | my | reading | following]",
  description: "Open the Scriptorium catalog. The Spire's library of long-form fiction.",
  subcommands: [
    { verb: "(no args)", usage: "/scriptorium", description: "Browse all public stories." },
    { verb: "find", usage: "/scriptorium find", description: "Browse all public stories." },
    { verb: "my", usage: "/scriptorium my", description: "Open your own stories (drafts + published)." },
    { verb: "reading", usage: "/scriptorium reading", description: "Stories you're partway through." },
    { verb: "following", usage: "/scriptorium following", description: "Stories you've subscribed to." },
  ],
  run(ctx) {
    const head = (ctx.args[0] ?? "").toLowerCase();
    const tab = head === "my" || head === "reading" || head === "find" || head === "following" ? head : undefined;
    if (head && !tab) {
      return notice(ctx, "USAGE", `Unknown tab "${head}". Try /scriptorium find | my | reading | following.`);
    }
    ctx.socket.emit("ui:hint", tab ? { kind: "open-scriptorium", tab } : { kind: "open-scriptorium" });
  },
};
