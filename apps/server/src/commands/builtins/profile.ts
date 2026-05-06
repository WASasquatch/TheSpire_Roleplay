import { eq, sql } from "drizzle-orm";
import { characters, users } from "../../db/schema.js";
import type { CharacterStats, ProfileView, Theme } from "@thekeep/shared";
import { normalizeTheme } from "@thekeep/shared";
import { getSettings } from "../../settings.js";
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
  // Master username takes precedence — it's globally unique, while character
  // names are only unique per-owner, so collisions between a master "Kaal"
  // and someone else's character "Kaal" resolve to the master.
  //
  // We deliberately return the master profile here even if the user has an
  // active character: /whois WAS should show WAS's master profile, not their
  // current character's. To view a specific character, use its name (e.g.
  // /whois Kaal) — looked up below.
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
        createdAt: +u.createdAt,
      },
    };
  }

  // Character lookup — by name, regardless of whether the owner is currently
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
 * /profile — opens YOUR editor for the active identity.
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
 * /whois <name> — view a user's active profile (master fallback).
 * Aliases: /who (phpMyChat shorthand), /viewprofile.
 */
export const whoisCommand: CommandHandler = {
  name: "whois",
  aliases: ["who", "viewprofile"],
  usage: "/whois <username>",
  description: "View someone's profile (their active character, or master if none).",
  async run(ctx) {
    const target = ctx.argsText.trim();
    if (!target) {
      ctx.socket.emit("error:notice", { code: "NEED_NAME", message: "Usage: /whois <username>" });
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
