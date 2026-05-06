import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { characters, users } from "../../db/schema.js";
import { resolveDisplayName } from "../../auth/session.js";
import { getSettings } from "../../settings.js";
import type { CommandContext, CommandHandler } from "../types.js";

const MAX_NAME_LEN = 40;
const NAME_RX = /^[\p{L}\p{N}_\-' ]{1,40}$/u;

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

async function findCharacter(ctx: CommandContext, name: string) {
  const rows = await ctx.db
    .select()
    .from(characters)
    .where(
      and(
        eq(characters.userId, ctx.user.id),
        sql`lower(${characters.name}) = ${name.toLowerCase()}`,
        isNull(characters.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

async function createSubcommand(ctx: CommandContext, name: string) {
  if (!NAME_RX.test(name) || name.length > MAX_NAME_LEN) {
    return notice(
      ctx,
      "BAD_CHAR_NAME",
      "Character name must be 1–40 chars: letters, numbers, spaces, _ - '",
    );
  }
  const existing = await findCharacter(ctx, name);
  if (existing) return notice(ctx, "DUP_CHAR", `You already have a character named "${name}".`);

  const countRows = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(characters)
    .where(and(eq(characters.userId, ctx.user.id), isNull(characters.deletedAt)));
  const count = countRows[0]?.n ?? 0;
  const { maxCharactersPerUser } = await getSettings(ctx.db);
  if (count >= maxCharactersPerUser) {
    return notice(ctx, "CHAR_LIMIT", `Limit of ${maxCharactersPerUser} characters per account.`);
  }

  const id = nanoid();
  await ctx.db.insert(characters).values({ id, userId: ctx.user.id, name });

  ctx.socket.emit("ui:hint", { kind: "open-character-editor", characterId: id });
}

async function switchSubcommand(ctx: CommandContext, name: string) {
  // "OOC" / "master" / "off" / "none" all mean "drop the active character and
  // become the master account" — this is the natural inverse of /char switch
  // that's discoverable without remembering /char clear.
  if (/^(ooc|master|off|none)$/i.test(name)) return clearSubcommand(ctx);

  const c = await findCharacter(ctx, name);
  if (!c) return notice(ctx, "NO_CHAR", `No character named "${name}".`);

  await ctx.db
    .update(users)
    .set({ activeCharacterId: c.id })
    .where(eq(users.id, ctx.user.id));

  // mutate in-place so subsequent commands in this socket session see it
  ctx.user.activeCharacterId = c.id;
  ctx.user.displayName = await resolveDisplayName(ctx.db, ctx.user.id);

  // refresh occupant list so other clients see the rename
  const { broadcastPresence } = await import("../../realtime/broadcast.js");
  await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
}

async function clearSubcommand(ctx: CommandContext) {
  await ctx.db
    .update(users)
    .set({ activeCharacterId: null })
    .where(eq(users.id, ctx.user.id));
  ctx.user.activeCharacterId = null;
  ctx.user.displayName = ctx.user.username;

  const { broadcastPresence } = await import("../../realtime/broadcast.js");
  await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
}

async function editSubcommand(ctx: CommandContext, name: string) {
  const c = await findCharacter(ctx, name);
  if (!c) return notice(ctx, "NO_CHAR", `No character named "${name}".`);
  ctx.socket.emit("ui:hint", { kind: "open-character-editor", characterId: c.id });
}

async function deleteSubcommand(ctx: CommandContext, name: string) {
  const c = await findCharacter(ctx, name);
  if (!c) return notice(ctx, "NO_CHAR", `No character named "${name}".`);

  await ctx.db
    .update(characters)
    .set({ deletedAt: new Date() })
    .where(eq(characters.id, c.id));

  // if this was the active character, clear it
  if (ctx.user.activeCharacterId === c.id) {
    await ctx.db.update(users).set({ activeCharacterId: null }).where(eq(users.id, ctx.user.id));
    ctx.user.activeCharacterId = null;
    ctx.user.displayName = ctx.user.username;
    const { broadcastPresence } = await import("../../realtime/broadcast.js");
    await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
  }
}

export const charCommand: CommandHandler = {
  name: "char",
  aliases: ["character"],
  usage: "/char <create|switch|edit|delete|clear|list> [name]",
  description:
    "Manage your characters. /char switch OOC (or /char clear, /char disable) returns you to your master account.",
  subcommands: [
    { verb: "create", usage: "/char create <name>", description: "Create a new character and open the editor." },
    {
      verb: "switch",
      usage: "/char switch <name|OOC>",
      description:
        "Switch to a character (sets your display name + theme). Use 'OOC' as the name to drop the active character and become your master account again.",
      aliases: ["use"],
    },
    { verb: "edit", usage: "/char edit <name>", description: "Open the editor for a character." },
    {
      verb: "delete",
      usage: "/char delete <name>",
      description: "Soft-delete a character. Message history keeps the snapshotted name.",
      aliases: ["remove", "rm"],
    },
    {
      verb: "clear",
      usage: "/char clear",
      description: "Drop the active character and switch back to your master account (OOC).",
      aliases: ["off", "disable", "ooc"],
    },
    {
      verb: "list",
      usage: "/char list",
      description: "List your characters.",
      aliases: ["ls"],
    },
  ],
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    const subLower = (sub ?? "").toLowerCase();
    const restText = ctx.argsText.replace(/^\S+\s*/, "").trim();

    switch (subLower) {
      case "create": return createSubcommand(ctx, restText);
      case "switch":
      case "use": return switchSubcommand(ctx, restText);
      case "clear":
      case "off":
      case "disable":
      case "ooc": return clearSubcommand(ctx);
      case "edit": return editSubcommand(ctx, restText);
      case "delete":
      case "remove":
      case "rm": return deleteSubcommand(ctx, restText);
      case "":
      case "list":
      case "ls": {
        const list = await ctx.db
          .select({ name: characters.name })
          .from(characters)
          .where(and(eq(characters.userId, ctx.user.id), isNull(characters.deletedAt)));
        const names = list.map((c) => c.name).sort();
        const body = names.length
          ? `Your characters: ${names.join(", ")}`
          : "You have no characters yet. Create one with /char create <name>.";
        ctx.socket.emit("error:notice", { code: "CHAR_LIST", message: body });
        return;
      }
      default:
        notice(ctx, "BAD_SUBCMD", `Unknown subcommand. Try /char create, switch, edit, delete, clear (or 'switch OOC'), list.`);
    }
  },
};
