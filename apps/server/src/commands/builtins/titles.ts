import { and, eq, isNull, or, sql } from "drizzle-orm";
import { titleKinds, mutualTitles } from "../../db/schema.js";
import {
  currentIdentity,
  dissolveTitle,
  emitMutualPrompt,
  emitMutualSettled,
  listTitlesForIdentity,
  requestTitle,
} from "../../titles/service.js";
import { emitAmbiguousIdentityModal, resolveIdentityArg } from "../identityArg.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * /request <kind> <name> - propose a mutual title to another identity.
 *
 * The kind is the catalog slug (marriage, partner, mate, bestfriend, etc.;
 * admins can add more). The recipient sees an inline Accept | Decline card
 * via the `mutual:prompt` event. On accept, both profiles surface the
 * formatted title.
 */
export const requestCommand: CommandHandler = {
  name: "request",
  aliases: ["propose"],
  usage: "/request <kind> <user-or-character>",
  description:
    "Propose a mutual title (marriage, partner, mate, bestfriend, etc.). The other party gets an Accept | Decline prompt. View available kinds with /request list.",
  subcommands: [
    {
      verb: "list",
      usage: "/request list",
      description: "List available title kinds you can request.",
      aliases: ["kinds", "ls"],
    },
  ],
  async run(ctx) {
    const [first, ...rest] = ctx.args;
    const firstLower = (first ?? "").toLowerCase();

    if (!first || firstLower === "list" || firstLower === "kinds" || firstLower === "ls") {
      const kinds = await ctx.db
        .select({ slug: titleKinds.slug, label: titleKinds.label })
        .from(titleKinds)
        .where(eq(titleKinds.enabled, true))
        .orderBy(titleKinds.slug);
      if (kinds.length === 0) {
        notice(ctx, "NO_KINDS", "No title kinds are configured.");
        return;
      }
      const body = kinds.map((k) => `${k.slug} (${k.label})`).join(", ");
      notice(ctx, "REQUEST_KINDS", `Available titles: ${body}. Usage: /request <kind> <user>.`);
      return;
    }

    const targetName = rest.join(" ").trim();
    if (!targetName) {
      notice(ctx, "NEED_TARGET", `Usage: /request ${first} <user-or-character>`);
      return;
    }

    const result = await requestTitle(
      ctx.db,
      ctx.io,
      currentIdentity(ctx.user),
      targetName,
      first,
    );

    if (!result.ok) {
      notice(ctx, result.code ?? "REQUEST_FAILED", result.message ?? "Request failed.");
      return;
    }

    if (result.prompt && result.recipientUserId) {
      await emitMutualPrompt(ctx.io, result.recipientUserId, result.prompt);
    }

    // Confirmation to the requester. We deliberately use error:notice as the
    // success channel too - matches how /char create / /whisper / etc. echo
    // a one-line confirmation back via the same "notice" plumbing.
    notice(
      ctx,
      "REQUEST_SENT",
      `Request sent to ${targetName}. They'll see an Accept | Decline prompt.`,
    );
  },
};

/**
 * /dissolve <kind> <name> - request to remove an accepted mutual title.
 * Also flows through Accept | Decline: the other party must agree to the
 * removal. /dissolve without a kind tries to find any single accepted title
 * with that name and uses its kind, to spare users from remembering kinds.
 */
export const dissolveCommand: CommandHandler = {
  name: "dissolve",
  aliases: ["unrequest", "untitle"],
  usage: "/dissolve [kind] <user-or-character>",
  description:
    "Request to remove an accepted mutual title. The other party gets an Accept | Decline prompt. Kind is optional when you only have one shared title with that name.",
  subcommands: [
    {
      verb: "<name>",
      usage: "/dissolve <name>",
      description: "Dissolve your shared title with this user. Only works if you share exactly one title kind with them.",
    },
    {
      verb: "<kind> <name>",
      usage: "/dissolve marriage Bob",
      description: "Dissolve a specific title kind with this user (required when you share multiple).",
    },
  ],
  async run(ctx) {
    const args = ctx.args;
    if (args.length === 0) {
      notice(ctx, "NEED_TARGET", "Usage: /dissolve [kind] <user-or-character>");
      return;
    }

    let kindSlug: string | null = null;
    let targetName: string;

    // Two arities:
    //   /dissolve <name>          - infer kind (only if there's exactly one)
    //   /dissolve <kind> <name>   - explicit kind
    if (args.length === 1) {
      targetName = args[0]!;
    } else {
      kindSlug = args[0]!;
      targetName = args.slice(1).join(" ");
    }

    if (kindSlug === null) {
      // Infer the kind: find all accepted titles between this identity and
      // the named target, pick the kind if there's exactly one. Route the
      // target through the canonical resolver so a name shared by more than
      // one identity prompts for a token instead of silently picking one.
      const resolution = await resolveIdentityArg(ctx.db, targetName);
      if (resolution.kind === "none") {
        notice(ctx, "NO_USER", `No user or character named "${targetName}".`);
        return;
      }
      if (resolution.kind === "ambiguous") {
        emitAmbiguousIdentityModal(ctx, targetName, resolution.matches);
        return;
      }
      const target = resolution.target;
      const me = currentIdentity(ctx.user);
      const aChar = me.characterId === null
        ? sql`${mutualTitles.aCharacterId} IS NULL`
        : sql`${mutualTitles.aCharacterId} = ${me.characterId}`;
      const bChar = me.characterId === null
        ? sql`${mutualTitles.bCharacterId} IS NULL`
        : sql`${mutualTitles.bCharacterId} = ${me.characterId}`;
      const aCharOther = target.characterId === null
        ? sql`${mutualTitles.aCharacterId} IS NULL`
        : sql`${mutualTitles.aCharacterId} = ${target.characterId}`;
      const bCharOther = target.characterId === null
        ? sql`${mutualTitles.bCharacterId} IS NULL`
        : sql`${mutualTitles.bCharacterId} = ${target.characterId}`;
      const candidates = await ctx.db
        .select({ slug: titleKinds.slug })
        .from(mutualTitles)
        .innerJoin(titleKinds, eq(titleKinds.id, mutualTitles.kindId))
        .where(
          and(
            eq(mutualTitles.status, "accepted"),
            or(
              and(
                eq(mutualTitles.aUserId, me.userId), aChar,
                eq(mutualTitles.bUserId, target.userId), bCharOther,
              ),
              and(
                eq(mutualTitles.aUserId, target.userId), aCharOther,
                eq(mutualTitles.bUserId, me.userId), bChar,
              ),
            ),
          ),
        );
      if (candidates.length === 0) {
        notice(ctx, "NO_TITLE", `You have no accepted titles with ${target.displayName}.`);
        return;
      }
      if (candidates.length > 1) {
        notice(
          ctx,
          "AMBIGUOUS",
          `Multiple titles with ${target.displayName} (${candidates.map((c) => c.slug).join(", ")}). Specify which: /dissolve <kind> <name>.`,
        );
        return;
      }
      kindSlug = candidates[0]!.slug;
    }

    const result = await dissolveTitle(
      ctx.db,
      ctx.io,
      currentIdentity(ctx.user),
      targetName,
      kindSlug,
    );

    if (!result.ok) {
      notice(ctx, result.code ?? "DISSOLVE_FAILED", result.message ?? "Dissolve failed.");
      return;
    }

    if (result.prompt && result.recipientUserId) {
      await emitMutualPrompt(ctx.io, result.recipientUserId, result.prompt);
    }
    if (result.affectedUserIds) {
      // Profile views need to refresh - the title now shows as in-flight.
      await emitMutualSettled(ctx.io, result.affectedUserIds);
    }

    notice(
      ctx,
      "DISSOLVE_SENT",
      `Dissolve request sent to ${targetName}. They'll see an Accept | Decline prompt.`,
    );
  },
};

/**
 * /titles [name] - list mutual titles. Without a name, lists your own
 * (active identity); with a name, lists that user/character's accepted
 * titles - same data the profile modal shows.
 */
export const titlesCommand: CommandHandler = {
  name: "titles",
  usage: "/titles [user-or-character]",
  description: "List mutual titles for yourself, or someone else by name.",
  subcommands: [
    {
      verb: "(no args)",
      usage: "/titles",
      description: "List your own titles (for your active identity - master or current character).",
    },
    {
      verb: "<name>",
      usage: "/titles <name>",
      description: "List the accepted titles on someone else's profile.",
    },
  ],
  async run(ctx) {
    const target = ctx.argsText.trim();
    let identityName: string;
    let titles: Awaited<ReturnType<typeof listTitlesForIdentity>>;

    if (!target) {
      const me = currentIdentity(ctx.user);
      titles = await listTitlesForIdentity(ctx.db, me);
      identityName = me.displayName;
    } else {
      const resolution = await resolveIdentityArg(ctx.db, target);
      if (resolution.kind === "none") {
        notice(ctx, "NO_USER", `No user or character named "${target}".`);
        return;
      }
      if (resolution.kind === "ambiguous") {
        emitAmbiguousIdentityModal(ctx, target, resolution.matches);
        return;
      }
      titles = await listTitlesForIdentity(ctx.db, resolution.target);
      identityName = resolution.target.displayName;
    }

    if (titles.length === 0) {
      notice(ctx, "NO_TITLES", `${identityName} has no mutual titles.`);
      return;
    }

    const body = titles.map((t) => t.text).join("; ");
    notice(ctx, "TITLE_LIST", `${identityName}: ${body}`);
  },
};
// Avoid unused-import warning in case of future trims.
void isNull;
