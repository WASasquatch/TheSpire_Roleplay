import { and, eq, isNull, sql } from "drizzle-orm";
import { characters, users } from "../../db/schema.js";
import type { CharacterStats, ProfileView, Theme } from "@thekeep/shared";
import { normalizeTheme } from "@thekeep/shared";
import { getSettings } from "../../settings.js";
import { listTitlesForIdentity } from "../../titles/service.js";
import type { CommandHandler } from "../types.js";

/**
 * Parse a stored theme JSON. On null/parse-failure, fall back to the
 * sitewide admin-configured default theme.
 */
async function parseTheme(
  db: import("../../db/index.js").Db,
  json: string | null,
): Promise<Theme> {
  if (json) {
    try { return normalizeTheme(JSON.parse(json)); }
    catch { /* fall through */ }
  }
  return (await getSettings(db)).defaultTheme;
}

/**
 * Resolve a name (master username OR character name) to a ProfileView.
 * Used by both /whois and the HTTP profile endpoint, plus the click-to-view
 * flow on the userlist.
 */
async function lookupProfile(
  db: import("../../db/index.js").Db,
  name: string,
): Promise<ProfileView | null> {
  // Master username takes precedence - it's globally unique, while character
  // names are only unique per-owner, so collisions between a master "Kaal"
  // and someone else's character "Kaal" resolve to the master.
  //
  // We deliberately return the master profile here even if the user has an
  // active character: /whois WAS should show WAS's master profile, not their
  // current character's. To view a specific character, use its name (e.g.
  // /whois Kaal) - looked up below.
  const u = (await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${name.toLowerCase()}`)
    .limit(1))[0];
  if (u && !u.disabledAt) {
    return {
      kind: "master",
      profile: {
        userId: u.id,
        username: u.username,
        bioHtml: u.bioHtml,
        avatarUrl: u.avatarUrl,
        gender: u.gender,
        theme: await parseTheme(db, u.themeJson),
        titles: await listTitlesForIdentity(db, { userId: u.id, characterId: null, displayName: u.username }),
        createdAt: +u.createdAt,
      },
    };
  }

  // Character lookup - by name, regardless of whether the owner is currently
  // switched to it. Soft-deleted characters and characters whose owner is
  // disabled are filtered out (the data still exists for message history but
  // shouldn't surface in profile lookups).
  const c = (await db
    .select()
    .from(characters)
    .where(sql`lower(${characters.name}) = ${name.toLowerCase()}`)
    .limit(1))[0];
  if (!c || c.deletedAt) return null;

  const owner = (await db.select().from(users).where(eq(users.id, c.userId)).limit(1))[0];
  if (!owner || owner.disabledAt) return null;

  const theme = await parseTheme(db, c.themeJson ?? owner.themeJson);
  return {
    kind: "character",
    profile: {
      id: c.id,
      userId: c.userId,
      name: c.name,
      bioHtml: c.bioHtml,
      stats: parseStats(c.statsJson),
      avatarUrl: c.avatarUrl,
      theme,
      titles: await listTitlesForIdentity(db, { userId: c.userId, characterId: c.id, displayName: c.name }),
      createdAt: +c.createdAt,
      updatedAt: +c.updatedAt,
    },
  };
}

/**
 * Pick a uniformly-random profile from the union of (active master accounts) and
 * (non-deleted characters whose owner is active). We count both pools, draw an
 * index across the combined total, and OFFSET into whichever pool the index
 * lands in - so every visible profile has equal probability regardless of how
 * lopsided the user/character ratio is.
 */
async function lookupRandomProfile(
  db: import("../../db/index.js").Db,
): Promise<ProfileView | null> {
  const masterCountRow = (await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(isNull(users.disabledAt)))[0];
  const masterCount = masterCountRow?.n ?? 0;

  const charCountRow = (await db
    .select({ n: sql<number>`count(*)` })
    .from(characters)
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(isNull(characters.deletedAt), isNull(users.disabledAt))))[0];
  const charCount = charCountRow?.n ?? 0;

  const total = masterCount + charCount;
  if (total === 0) return null;

  const idx = Math.floor(Math.random() * total);
  if (idx < masterCount) {
    const u = (await db
      .select()
      .from(users)
      .where(isNull(users.disabledAt))
      .orderBy(users.id)
      .limit(1)
      .offset(idx))[0];
    if (!u) return null;
    return {
      kind: "master",
      profile: {
        userId: u.id,
        username: u.username,
        bioHtml: u.bioHtml,
        avatarUrl: u.avatarUrl,
        gender: u.gender,
        theme: await parseTheme(db, u.themeJson),
        titles: await listTitlesForIdentity(db, { userId: u.id, characterId: null, displayName: u.username }),
        createdAt: +u.createdAt,
      },
    };
  }

  const row = (await db
    .select({ char: characters, ownerThemeJson: users.themeJson })
    .from(characters)
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(isNull(characters.deletedAt), isNull(users.disabledAt)))
    .orderBy(characters.id)
    .limit(1)
    .offset(idx - masterCount))[0];
  if (!row) return null;
  const c = row.char;
  return {
    kind: "character",
    profile: {
      id: c.id,
      userId: c.userId,
      name: c.name,
      bioHtml: c.bioHtml,
      stats: parseStats(c.statsJson),
      avatarUrl: c.avatarUrl,
      theme: await parseTheme(db, c.themeJson ?? row.ownerThemeJson),
      titles: await listTitlesForIdentity(db, { userId: c.userId, characterId: c.id, displayName: c.name }),
      createdAt: +c.createdAt,
      updatedAt: +c.updatedAt,
    },
  };
}

function parseStats(json: string): CharacterStats {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object") return parsed as CharacterStats;
  } catch { /* fall through */ }
  return {};
}

/**
 * /profile - opens YOUR editor for the active identity.
 *   - If you have an active character, edits that character.
 *   - Otherwise, edits your master profile.
 *
 * Args are rejected: viewing other users uses /whois.
 */
export const profileCommand: CommandHandler = {
  name: "profile",
  aliases: ["editprofile", "myprofile"],
  usage: "/profile",
  description: "Open the editor for your active profile (master or current character).",
  run(ctx) {
    if (ctx.argsText.trim()) {
      ctx.socket.emit("error:notice", {
        code: "NO_ARGS",
        message: "/profile takes no arguments. Use /whois <name> to view someone else.",
      });
      return;
    }
    if (ctx.user.activeCharacterId) {
      ctx.socket.emit("ui:hint", {
        kind: "open-my-editor",
        mode: "character",
        characterId: ctx.user.activeCharacterId,
      });
    } else {
      ctx.socket.emit("ui:hint", {
        kind: "open-my-editor",
        mode: "master",
        characterId: null,
      });
    }
  },
};

/**
 * /whois [name] - view a user's active profile (master fallback).
 * With no name, picks a random profile (any master or character) - a quick way
 * to stumble across someone's bio.
 * Aliases: /who (phpMyChat shorthand), /viewprofile.
 */
export const whoisCommand: CommandHandler = {
  name: "whois",
  aliases: ["who", "viewprofile"],
  usage: "/whois [username]",
  description:
    "View someone's profile (their active character, or master if none). With no name, opens a random profile.",
  subcommands: [
    {
      verb: "<name>",
      usage: "/whois <name>",
      description: "View this user's profile. Master usernames win over character names if both exist.",
    },
    {
      verb: "(no args)",
      usage: "/whois",
      description: "Open a uniformly-random profile from all active masters and characters.",
    },
  ],
  async run(ctx) {
    const target = ctx.argsText.trim();
    if (!target) {
      const view = await lookupRandomProfile(ctx.db);
      if (!view) {
        ctx.socket.emit("error:notice", {
          code: "NO_PROFILES",
          message: "No profiles found.",
        });
        return;
      }
      ctx.socket.emit("ui:hint", { kind: "open-profile", profile: view });
      return;
    }
    const view = await lookupProfile(ctx.db, target);
    if (!view) {
      ctx.socket.emit("error:notice", {
        code: "NO_USER",
        message: `No user or active character named "${target}".`,
      });
      return;
    }
    ctx.socket.emit("ui:hint", { kind: "open-profile", profile: view });
  },
};

export { lookupProfile };
