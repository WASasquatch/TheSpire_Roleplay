import { eq } from "drizzle-orm";
import {
  clampExportMs,
  DEFAULT_EXPORT_MS,
  formatDurationShort,
  parseExportDuration,
} from "@thekeep/shared";
import { rooms } from "../../db/schema.js";
import { getSettings } from "../../settings.js";
import { tFor } from "../../i18n.js";
import type { CommandHandler } from "../types.js";

/**
 * `/export [duration]` — download the recent chat as a formatted HTML log so a
 * scene can be archived and an RP continued later. Fixes what copy/paste of the
 * live feed loses: timestamps, the author's name (OOC master username OR active
 * character name, snapshotted), and each speaker's colour.
 *
 * The command only parses + clamps the window and hands the client a download
 * URL via a `ui:hint`; the actual file is built by `GET /rooms/:id/export`
 * (HTTP, off the socket) so generation never blocks chat for anyone. The window
 * is clamped to how long messages are retained — you can't export what's
 * already been swept — and to a hard ceiling.
 */
export const exportCommand: CommandHandler = {
  name: "export",
  aliases: ["savelog"],
  usage: "/export [duration] [dark|light]",
  description:
    "Download the recent chat as a formatted HTML log: timestamps, names (OOC or character), and colours intact. e.g. /export 5h, /export 90m, /export 2d. Add 'dark' or 'light' for the page theme (default dark). No duration = last 12h. The range is capped at how long messages are kept here.",
  async run(ctx) {
    // Args are order-independent: a `dark`/`light` token picks the page theme,
    // everything else is the duration (e.g. `/export 5h dark`, `/export light`).
    let theme: "light" | "dark" = "dark";
    const durTokens: string[] = [];
    for (const tok of ctx.argsText.trim().split(/\s+/).filter(Boolean)) {
      const low = tok.toLowerCase();
      if (low === "light" || low === "dark") theme = low;
      else durTokens.push(tok);
    }
    const durText = durTokens.join(" ");
    const requestedMs = durText ? parseExportDuration(durText) : DEFAULT_EXPORT_MS;
    if (requestedMs === null) {
      ctx.socket.emit("error:notice", {
        code: "EXPORT_BAD_DURATION",
        message: tFor(ctx.user.locale, "commands:export.badDuration"),
      });
      return;
    }

    const settings = await getSettings(ctx.db);
    const room = (await ctx.db
      .select({ name: rooms.name, expiry: rooms.messageExpiryMinutes, retentionExempt: rooms.retentionExempt })
      .from(rooms)
      .where(eq(rooms.id, ctx.roomId))
      .limit(1))[0];
    // Retention-exempt rooms (migration 0347) keep history forever: skip the
    // retention/expiry clamps (retention 0 = "forever"), matching the route.
    const windowMs = room?.retentionExempt
      ? clampExportMs(requestedMs, 0, null)
      : clampExportMs(requestedMs, settings.messageRetentionMs, room?.expiry ?? null);

    // Relative URL; the client appends its timezone offset and fetches it with
    // credentials, then triggers the download (see the `download-export` hint).
    const url = `/rooms/${encodeURIComponent(ctx.roomId)}/export?ms=${windowMs}&theme=${theme}`;
    const safeName = (room?.name || "chat")
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "chat";
    ctx.socket.emit("ui:hint", {
      kind: "download-export",
      url,
      filename: `${safeName}-log.html`,
    });

    // If retention (or the hard cap) trimmed the request, say so plainly so the
    // user isn't surprised the log is shorter than they asked for.
    if (windowMs < requestedMs) {
      ctx.socket.emit("error:notice", {
        code: "EXPORT_CLAMPED",
        message: tFor(ctx.user.locale, "commands:export.clamped", {
          duration: formatDurationShort(windowMs),
        }),
      });
    }
  },
};
