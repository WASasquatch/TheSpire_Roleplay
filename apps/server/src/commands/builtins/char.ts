import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { CHAR_NAME_RX, normalizeCharName } from "@thekeep/shared";
import { characters, users } from "../../db/schema.js";
import { resolveDisplayName } from "../../auth/session.js";
import { getSettings } from "../../settings.js";
import { eqNameInsensitive } from "../../lib/nameLookup.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

const MAX_NAME_LEN = 40;
// `CHAR_NAME_RX` and `normalizeCharName` are the canonical shared
// helpers from @thekeep/shared (packages/shared/src/names.ts); both
// server creation paths import them so they stay in lockstep. A
// non-breaking space (U+00A0) is allowed and PRESERVED (the parser
// treats it as a normal word character, so it stays parser-safe); an
// ASCII space is still accepted for backward compatibility.

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

async function findCharacter(ctx: CommandContext, name: string) {
  // `@cid:<id>` selects one of YOUR characters by id — paste-friendly from a
  // profile, and unambiguous when a name has spaces or collides. Still scoped
  // to the caller's own characters (you can only switch/edit/delete your own).
  const trimmed = name.trim();
  if (trimmed.startsWith("@cid:")) {
    const charId = trimmed.slice(5).trim();
    if (!charId || /\s/.test(charId)) return undefined;
    const byId = await ctx.db
      .select()
      .from(characters)
      .where(and(eq(characters.id, charId), eq(characters.userId, ctx.user.id), isNull(characters.deletedAt)))
      .limit(1);
    return byId[0];
  }
  // Space-/case-insensitive lookup, same helper the friend / DM /
  // whisper paths use. Tolerates NBSP-vs-ASCII-space mismatches between
  // the typed query and whatever's stored, regardless of which form the
  // user used when creating the character.
  const rows = await ctx.db
    .select()
    .from(characters)
    .where(
      and(
        eq(characters.userId, ctx.user.id),
        eqNameInsensitive(characters.name, name),
        isNull(characters.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

async function createSubcommand(ctx: CommandContext, rawName: string) {
  const name = normalizeCharName(rawName);
  if (!CHAR_NAME_RX.test(name) || name.length > MAX_NAME_LEN) {
    return notice(
      ctx,
      "BAD_CHAR_NAME",
      tFor(ctx.user.locale, "commands:char.badName"),
    );
  }
  const existing = await findCharacter(ctx, name);
  if (existing) return notice(ctx, "DUP_CHAR", tFor(ctx.user.locale, "commands:char.duplicate", { name }));

  const countRows = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(characters)
    .where(and(eq(characters.userId, ctx.user.id), isNull(characters.deletedAt)));
  const count = countRows[0]?.n ?? 0;
  const { maxCharactersPerUser } = await getSettings(ctx.db);
  if (count >= maxCharactersPerUser) {
    return notice(ctx, "CHAR_LIMIT", tFor(ctx.user.locale, "commands:char.limit", { max: maxCharactersPerUser }));
  }

  const id = nanoid();
  // Reachable by default (opt-out) — see the route create handler in
  // routes/characters.ts for the rationale; set explicitly so the older
  // DB column default can't create an unreachable character.
  await ctx.db.insert(characters).values({ id, userId: ctx.user.id, name, directMessengerEnabled: true });

  ctx.socket.emit("ui:hint", { kind: "open-character-editor", characterId: id });
}

/**
 * Set this socket's tab-local active character. Updates the DB (so the
 * next fresh tab the user opens picks up the same default) AND the
 * `socket.data.tabCharId` override so the per-tab routing in
 * `chat:input` (see index.ts) doesn't get clobbered by a /char run on a
 * sibling tab. Also emits `me:character-update` to the caller so its
 * React state can refresh activeCharacterId/Name + theme without
 * polling `/me/profile`.
 */
async function applyTabCharacter(
  ctx: CommandContext,
  newCharId: string | null,
): Promise<void> {
  await ctx.db
    .update(users)
    .set({ activeCharacterId: newCharId })
    .where(eq(users.id, ctx.user.id));
  (ctx.socket.data as { tabCharId?: string | null }).tabCharId = newCharId;
  ctx.user.activeCharacterId = newCharId;
  ctx.user.displayName = newCharId === null
    ? ctx.user.username
    : await resolveDisplayName(ctx.db, ctx.user.id, newCharId);
  const { broadcastPresence } = await import("../../realtime/broadcast.js");
  await broadcastPresence(ctx.io, ctx.db, ctx.roomId);
  ctx.socket.emit("me:character-update", {
    activeCharacterId: newCharId,
    activeCharacterName: newCharId === null ? null : ctx.user.displayName,
  });
}

async function switchSubcommand(ctx: CommandContext, rawName: string) {
  const name = normalizeCharName(rawName);
  // "OOC" / "master" / "off" / "none" all mean "drop the active character and
  // become the master account" - this is the natural inverse of /char switch
  // that's discoverable without remembering /char clear.
  if (/^(ooc|master|off|none)$/i.test(name)) return clearSubcommand(ctx);

  const c = await findCharacter(ctx, name);
  if (!c) return notice(ctx, "NO_CHAR", tFor(ctx.user.locale, "commands:char.notFound", { name }));

  await applyTabCharacter(ctx, c.id);
}

async function clearSubcommand(ctx: CommandContext) {
  await applyTabCharacter(ctx, null);
}

async function editSubcommand(ctx: CommandContext, rawName: string) {
  const name = normalizeCharName(rawName);
  const c = await findCharacter(ctx, name);
  if (!c) return notice(ctx, "NO_CHAR", tFor(ctx.user.locale, "commands:char.notFound", { name }));
  ctx.socket.emit("ui:hint", { kind: "open-character-editor", characterId: c.id });
}

async function deleteSubcommand(ctx: CommandContext, rawName: string) {
  const name = normalizeCharName(rawName);
  const c = await findCharacter(ctx, name);
  if (!c) return notice(ctx, "NO_CHAR", tFor(ctx.user.locale, "commands:char.notFound", { name }));

  await ctx.db
    .update(characters)
    .set({ deletedAt: new Date() })
    .where(eq(characters.id, c.id));

  // Char deletion is a global action, every tab that was voicing this
  // character has to drop to OOC, not just the calling tab. Find every
  // live socket for this user whose `tabCharId` matches the deletion
  // and clear it. Each affected socket gets its own me:character-update
  // so its React state refreshes without a /me/profile poll. We also
  // null out users.activeCharacterId in the DB so fresh tabs default to
  // OOC instead of trying to resolve a tombstoned character.
  await ctx.db.update(users).set({ activeCharacterId: null }).where(eq(users.id, ctx.user.id));
  const affectedRooms = new Set<string>();
  const sockets = await ctx.io.fetchSockets();
  for (const s of sockets) {
    if ((s.data as { userId?: string }).userId !== ctx.user.id) continue;
    const sCharId = (s.data as { tabCharId?: string | null }).tabCharId;
    if (sCharId !== c.id) continue;
    (s.data as { tabCharId?: string | null }).tabCharId = null;
    s.emit("me:character-update", { activeCharacterId: null, activeCharacterName: null });
    const r = (s.data as { roomId?: string }).roomId;
    if (r) affectedRooms.add(r);
  }
  // Update the calling socket's in-memory user too, it may not be in
  // the io.fetchSockets() iteration if we're mid-event-handler.
  if (ctx.user.activeCharacterId === c.id) {
    ctx.user.activeCharacterId = null;
    ctx.user.displayName = ctx.user.username;
    affectedRooms.add(ctx.roomId);
  }
  if (affectedRooms.size > 0) {
    const { broadcastPresence } = await import("../../realtime/broadcast.js");
    for (const roomId of affectedRooms) {
      await broadcastPresence(ctx.io, ctx.db, roomId);
    }
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
        // Reference content the user might want to read or copy
        // (especially with many characters), persistent modal beats
        // the 6-second toast.
        if (names.length === 0) {
          ctx.socket.emit("ui:hint", {
            kind: "open-info-modal",
            title: tFor(ctx.user.locale, "commands:char.listTitle"),
            body: tFor(ctx.user.locale, "commands:char.listEmptyBody"),
          });
        } else {
          // One name per line so long lists stay scannable. Toast
          // mode used a comma-joined single line; the modal can
          // afford to spread out.
          ctx.socket.emit("ui:hint", {
            kind: "open-info-modal",
            title: tFor(ctx.user.locale, "commands:char.listTitleCount", { total: names.length }),
            body: names.map((n) => `  ${n}`).join("\n"),
          });
        }
        return;
      }
      default:
        notice(ctx, "BAD_SUBCMD", tFor(ctx.user.locale, "commands:char.badSubcommand"));
    }
  },
};
