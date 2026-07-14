import { and, eq } from "drizzle-orm";
import { CONTAINER_STYLES, isContainerColor, isContainerStyle } from "@thekeep/shared";
import { roomMembers } from "../../db/schema.js";
import { addMessage } from "../../realtime/broadcast.js";
import { hasPermission } from "../../auth/permissions.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Same gate as /scene: room owner, room mod, or the site-wide
 * `edit_any_room_metadata`. A container is a director/staff announcement
 * affordance (a "Posted by X" embed that fills the feed), so ordinary
 * members can't drop them.
 */
async function canPostContainer(ctx: CommandContext): Promise<boolean> {
  if (await hasPermission(ctx.user, "edit_any_room_metadata", ctx.db)) return true;
  const member = (await ctx.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, ctx.roomId), eq(roomMembers.userId, ctx.user.id)))
    .limit(1))[0];
  return member?.role === "owner" || member?.role === "mod";
}

/**
 * /container <style> [color]
 * <your multi-line body...>
 *
 * Posts a themed "embed" block (Discord-style card) whose multi-line body is
 * rendered inside a themed surface with a "Posted by <name>" header and NO
 * (edited) indicator. Everything after the `<style> [color]` header — across
 * as many lines as the sender typed (Shift+Enter) — is the body, with its
 * newlines and chat markdown/chips preserved.
 *
 *   /container glass
 *   Welcome to the Spire ...
 *
 *   /container gradient purple
 *   **Notice** ...
 *
 * style : solid | glass | parchment | bokeh | gradient
 * color : optional accent keyword (alert | green | purple | ...); absent = the
 *         viewer's theme accent. Only recognized when it sits on the header
 *         line right after the style; a word on a later line is body text.
 *
 * The card's base colors track the VIEWER's active theme; the accent is
 * resolved from the keyword per viewer at render (never snapshotted), so a
 * container re-themes when a viewer changes palette. Owner/mod only.
 */
export const containerCommand: CommandHandler = {
  name: "container",
  aliases: ["embed", "card"],
  usage: "/container <style> [color]  then your text on the next lines",
  description:
    "Post a themed embed block visible to everyone (owner/mod only). Styles: solid, glass, parchment, bokeh, gradient. Optional accent color.",
  subcommands: [
    { verb: "<style>", usage: "/container glass\\nYour text...", description: "Post an embed in the given style; body is the following lines." },
    { verb: "<style> <color>", usage: "/container gradient purple\\nYour text...", description: "Same, tinted with an accent color (alert, green, purple, ...)." },
  ],
  async run(ctx) {
    if (!(await canPostContainer(ctx))) {
      notice(ctx, "PERM", tFor(ctx.user.locale, "commands:container.permission"));
      return;
    }
    // argsText is "<style> [color]<newline><body...>" with newlines preserved
    // (COMMAND_RX uses the `s` flag). Peel the leading style + optional color
    // token off the FRONT, keeping every interior newline of the body intact
    // (do NOT trim the whole thing — that's the multi-line content).
    const raw = ctx.argsText.replace(/^[ \t]+/, ""); // strip only leading inline spaces, keep newlines
    const styleMatch = /^([a-z]+)/i.exec(raw);
    const style = (styleMatch?.[1] ?? "").toLowerCase();
    if (!styleMatch || !isContainerStyle(style)) {
      notice(ctx, "CONTAINER_STYLE", tFor(ctx.user.locale, "commands:container.badStyle", { styles: CONTAINER_STYLES.join(", ") }));
      return;
    }
    let rest = raw.slice(styleMatch[0].length).replace(/^[ \t]+/, "");
    // A color keyword counts ONLY when it's the next token on the SAME (header)
    // line — a word on a later line is body text, so match against `rest`
    // before any newline is consumed.
    let color: string | null = null;
    const colorMatch = /^([a-z]+)/i.exec(rest);
    if (colorMatch && isContainerColor(colorMatch[1]!.toLowerCase())) {
      color = colorMatch[1]!.toLowerCase();
      rest = rest.slice(colorMatch[0].length).replace(/^[ \t]+/, "");
    }
    // The body is everything after the header: drop the blank line(s) that
    // separate the header from the content, then trailing-trim only.
    const body = rest.replace(/^\r?\n+/, "").trimEnd();
    if (!body.trim()) {
      notice(ctx, "CONTAINER_EMPTY", tFor(ctx.user.locale, "commands:container.empty"));
      return;
    }
    await addMessage(ctx, { kind: "container", body, containerStyle: style, containerColor: color });
  },
};
