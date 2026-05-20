import type { CommandHandler } from "../types.js";

/**
 * Earning-related UI shortcut commands. None of these mutate state on
 * the server — they just emit a `ui:hint` that the client's App.tsx
 * resolves into opening the Earning dashboard at a specific tab + sub-
 * tab. The commands exist so a user can deep-link to the spot they
 * actually want (shop / collection / pets / overview) instead of
 * opening the dashboard and then clicking through to it.
 *
 * Mirrors the pattern used by `/users`, `/worlds`, `/bookmarks` — all
 * tiny dispatchers that send a single `ui:hint`. Each command rejects
 * stray arguments so a typo'd `/shop something` surfaces a clear
 * usage hint instead of silently opening the modal and dropping the
 * extra text.
 */

function rejectArgs(ctx: Parameters<NonNullable<CommandHandler["run"]>>[0], usage: string): boolean {
  if (ctx.argsText.trim()) {
    ctx.socket.emit("error:notice", {
      code: "NO_ARGS",
      message: `${usage} takes no arguments.`,
    });
    return true;
  }
  return false;
}

/**
 * /earnings — open the Earnings dashboard at the Overview tab. The
 * dashboard is also reachable from the bottom-right tools panel
 * ("Your Earning"); the command is a keyboard-friendly shortcut.
 */
export const earningsCommand: CommandHandler = {
  name: "earnings",
  aliases: ["earning"],
  usage: "/earnings",
  description: "Open your Earnings dashboard (XP, currency, rank, cosmetics, items).",
  run(ctx) {
    if (rejectArgs(ctx, "/earnings")) return;
    ctx.socket.emit("ui:hint", { kind: "open-earning" });
  },
};

/**
 * /shop — open Earnings ▸ Items ▸ Shop in one shot. The shop is the
 * "spend currency on items" surface; the named command is the
 * fastest path to it from anywhere in chat.
 */
export const shopCommand: CommandHandler = {
  name: "shop",
  aliases: ["store", "market"],
  usage: "/shop",
  description: "Open the item shop (Earnings ▸ Items ▸ Shop).",
  run(ctx) {
    if (rejectArgs(ctx, "/shop")) return;
    ctx.socket.emit("ui:hint", { kind: "open-earning", tab: "items", itemSubTab: "shop" });
  },
};

/**
 * /collection — open Earnings ▸ Items ▸ Collection. The 10-slot
 * pinned-item showcase that other players see on your profile. Each
 * identity (master + each character) keeps its own collection; the
 * dashboard surfaces the active identity's slots.
 */
export const collectionCommand: CommandHandler = {
  name: "collection",
  aliases: ["pins"],
  usage: "/collection",
  description: "Open your pinned-item Collection (Earnings ▸ Items ▸ Collection).",
  run(ctx) {
    if (rejectArgs(ctx, "/collection")) return;
    ctx.socket.emit("ui:hint", { kind: "open-earning", tab: "items", itemSubTab: "collection" });
  },
};

/**
 * /pets — open Earnings ▸ Items ▸ Pets. The 5-slot pinned-pet
 * showcase. Same partitioning rules as the item collection (one set
 * per identity), but only items with category='pet' are pinnable
 * here. The server-side PUT enforces that gate; the command just
 * routes the user there.
 */
export const petsCommand: CommandHandler = {
  name: "pets",
  aliases: ["pet-collection"],
  usage: "/pets",
  description: "Open your pinned-pet showcase (Earnings ▸ Items ▸ Pets).",
  run(ctx) {
    if (rejectArgs(ctx, "/pets")) return;
    ctx.socket.emit("ui:hint", { kind: "open-earning", tab: "items", itemSubTab: "pets" });
  },
};
