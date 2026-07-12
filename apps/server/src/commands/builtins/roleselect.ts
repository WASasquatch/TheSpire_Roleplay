import { and, eq } from "drizzle-orm";
import {
  ROLE_SELECT_MAX_ROLES,
  buildRoleSelectBody,
  isModeratorRole,
} from "@thekeep/shared";
import { serverUsergroups } from "../../db/schema.js";
import { resolveRoomServerId } from "../../earning/pool.js";
import { serverAuthority, serverCan } from "../../servers/authority.js";
import { addMessage } from "../../realtime/broadcast.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * An emoji-ish glyph token: short (≤8 code points for ZWJ sequences), no
 * letters (an emoji is never alphabetic; digits stay legal for keycaps),
 * no angle brackets. Same posture as /icon's short-glyph rule, and kept in
 * lockstep with the letter test in shared roleSelect.ts' line parser.
 */
function isEmojiToken(tok: string): boolean {
  if (!tok || [...tok].length > 8) return false;
  if (/[<>]/.test(tok)) return false;
  return !/\p{L}/u.test(tok);
}

/** Case-fold a group name for matching: NBSP (U+00A0, the parser-safe way
 *  to type a spaced name) and underscores both read as plain spaces, and
 *  space runs collapse, so `/roleselect Cool_Artists` and the NBSP form
 *  both match the console-typed "Cool Artists". */
function foldName(name: string): string {
  return name.toLowerCase().replace(/[ _]+/g, " ").replace(/ +/g, " ").trim();
}

/**
 * /roleselect [emoji] <group> [[emoji] <group> …]
 *
 * Posts a permanent, interactive role-picker PANEL into the room (Discord
 * reaction-roles style): one clickable row per listed usergroup; members
 * click to give themselves / remove the role via the existing self-role
 * endpoints. The persisted body is `{role:<usergroupId>}` token lines (see
 * shared roleSelect.ts); the live half hydrates per viewer like a poll.
 *
 * Gate: site staff, or the room's server `manage_usergroups`. Every listed
 * group must belong to the room's server AND be member-selectable — the
 * command refuses NAMING the offender rather than silently dropping it, so
 * admins learn the console flag exists. Issued as a reply (topic-bound
 * composer), the panel attaches beneath that post via the ordinary reply
 * pipeline — nothing special here.
 */
export const roleSelectCommand: CommandHandler = {
  name: "roleselect",
  aliases: ["rolepicker"],
  usage: "/roleselect [emoji] <group> [[emoji] <group> ...]",
  description:
    "Post a role picker: members click a role to give it to themselves (or remove it). Groups must be marked self-assignable in the server console. Quote names with real spaces.",
  subcommands: [
    { verb: "basic", usage: "/roleselect Artists Gamers", description: "Offer the Artists and Gamers roles as clickable rows." },
    { verb: "emoji", usage: "/roleselect 🎨 Artists 🎮 Gamers", description: "Put an emoji before a group name to decorate its row." },
    { verb: "quoted", usage: "/roleselect \"Night Owls\"", description: "Quote a group name that contains real spaces." },
  ],
  async run(ctx) {
    const serverId = await resolveRoomServerId(ctx.db, ctx.roomId);
    // Site staff pass outright; otherwise the room's server must grant
    // manage_usergroups. Checked here (not via handler.serverPermission)
    // because the dispatcher's per-server fallback deliberately excludes
    // the default/system server, where site staff are exactly who should
    // be able to post a picker.
    if (!isModeratorRole(ctx.user.role)) {
      const a = await serverAuthority(ctx.db, ctx.user, serverId);
      if (!a.server || !serverCan(a, "manage_usergroups")) {
        notice(ctx, "PERM", tFor(ctx.user.locale, "commands:roleselect.permission"));
        return;
      }
    }

    const args = ctx.args.filter((a) => a.length > 0);
    if (args.length === 0) {
      notice(ctx, "ROLESELECT_HELP", tFor(ctx.user.locale, "commands:roleselect.usage"));
      return;
    }

    // Pair optional emoji glyphs with the group name that follows them. A
    // trailing glyph with nothing after it falls through as a NAME (a
    // group could legitimately be named "🎨").
    const wanted: Array<{ emoji: string | null; name: string }> = [];
    for (let i = 0; i < args.length; i++) {
      const tok = args[i]!;
      if (isEmojiToken(tok) && i + 1 < args.length) {
        wanted.push({ emoji: tok, name: args[++i]! });
      } else {
        wanted.push({ emoji: null, name: tok });
      }
    }
    if (wanted.length > ROLE_SELECT_MAX_ROLES) {
      notice(ctx, "ROLESELECT_TOO_MANY", tFor(ctx.user.locale, "commands:roleselect.tooMany", { max: ROLE_SELECT_MAX_ROLES }));
      return;
    }

    // Resolve every name against THIS server's named groups. Refusals name
    // the offender — a silent drop would leave admins guessing why a group
    // never shows (and hide that the member-selectable flag exists).
    const groups = await ctx.db
      .select({
        id: serverUsergroups.id,
        name: serverUsergroups.name,
        memberSelectable: serverUsergroups.memberSelectable,
      })
      .from(serverUsergroups)
      .where(and(eq(serverUsergroups.serverId, serverId), eq(serverUsergroups.isDefault, false)));
    const byFolded = new Map(groups.map((g) => [foldName(g.name), g]));
    const entries: Array<{ emoji: string | null; usergroupId: string }> = [];
    const seen = new Set<string>();
    for (const w of wanted) {
      const g = byFolded.get(foldName(w.name));
      if (!g) {
        notice(ctx, "ROLESELECT_UNKNOWN", tFor(ctx.user.locale, "commands:roleselect.unknownGroup", { name: w.name }));
        return;
      }
      if (!g.memberSelectable) {
        notice(ctx, "ROLESELECT_NOT_SELECTABLE", tFor(ctx.user.locale, "commands:roleselect.notSelectable", { name: g.name }));
        return;
      }
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      entries.push({ emoji: w.emoji, usergroupId: g.id });
    }
    if (entries.length === 0) {
      notice(ctx, "ROLESELECT_HELP", tFor(ctx.user.locale, "commands:roleselect.usage"));
      return;
    }

    // A normal say whose body is the token lines; the server-only
    // roleSelectPanel flag stamps messages.isRoleSelect, which every
    // hydration point requires — token lines typed into a plain say stay
    // plain text. addMessage hydrates the panel state onto the creation
    // broadcast and inherits ctx.replyContext (topic-bound composer →
    // footer under that post).
    await addMessage(ctx, { kind: "say", body: buildRoleSelectBody(entries), roleSelectPanel: true });
  },
};
