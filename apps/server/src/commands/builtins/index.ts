import type { CommandRegistry } from "../registry.js";
import { meCommand } from "./me.js";
import { charCommand } from "./char.js";
import {
  describeCommand,
  goCommand,
  inviteCommand,
  privateRoomCommand,
  topicCommand,
} from "./room.js";
import { profileCommand, whoisCommand } from "./profile.js";
import { dissolveCommand, requestCommand, titlesCommand } from "./titles.js";
import { makeHelpCommand } from "./help.js";
import { colorCommand } from "./color.js";
import { awayCommand, backCommand } from "./away.js";
import { incognitoCommand } from "./incognito.js";
import { refreshCommand } from "./refresh.js";
import { rollCommand } from "./roll.js";
import { whisperCommand } from "./whisper.js";
import { replyCommand } from "./reply.js";
import { moodCommand } from "./mood.js";
import { sceneCommand } from "./scene.js";
import { npcCommand, npcModeCommand } from "./npc.js";
import {
  acceptFriendCommand,
  declineFriendCommand,
  friendCommand,
  friendsCommand,
  unfriendCommand,
} from "./friends.js";
import { worldCommand, worldsCommand } from "./world.js";
import { scriptoriumCommand, storyCommand, writeCommand } from "./scriptorium.js";
import { expiryCommand, replyModeCommand } from "./room_modes.js";
import { ignoreCommand, unignoreCommand } from "./ignore.js";
import { usersCommand } from "./users.js";
import { bookmarksCommand } from "./bookmarks.js";
import { clearCommand, findCommand, listCommand } from "./rooms_list.js";
import {
  announceCommand,
  banCommand,
  demoteAdminCommand,
  demoteCommand,
  kickCommand,
  muteCommand,
  promoteAdminCommand,
  promoteCommand,
  unbanCommand,
  unmuteCommand,
} from "./mod.js";
import { currencyCommand, expCommand } from "./earning.js";
import {
  collectionCommand,
  earningsCommand,
  petsCommand,
  shopCommand,
} from "./earning_ui.js";
import { dropCommand, giveCommand, throwCommand } from "./items.js";
import { itemCommand } from "./item_lookup.js";
import {
  announceRaffleCommand,
  answerCommand,
  claimCommand,
  gamesCommand,
  raffleCommand,
  rpsCommand,
  scrambleCommand,
  storyDiceCommand,
  triviaCommand,
} from "./social_games.js";
import { duelCommand } from "./duel.js";
import { registerRps } from "../../games/rps.js";
import { registerRaffle } from "../../games/raffle.js";
import { registerTrivia } from "../../games/trivia.js";
import { registerStoryDice } from "../../games/storydice.js";
import { registerScramble } from "../../games/scramble.js";
import { registerDuel } from "../../games/duel.js";

/** Registers all built-in commands. Must run before custom commands are loaded. */
export function registerBuiltins(reg: CommandRegistry): void {
  reg.registerBuiltin(meCommand);
  reg.registerBuiltin(charCommand);
  reg.registerBuiltin(goCommand);
  reg.registerBuiltin(privateRoomCommand);
  reg.registerBuiltin(inviteCommand);
  reg.registerBuiltin(topicCommand);
  reg.registerBuiltin(describeCommand);
  reg.registerBuiltin(profileCommand);
  reg.registerBuiltin(whoisCommand);
  reg.registerBuiltin(requestCommand);
  reg.registerBuiltin(dissolveCommand);
  reg.registerBuiltin(titlesCommand);
  reg.registerBuiltin(colorCommand);
  reg.registerBuiltin(awayCommand);
  reg.registerBuiltin(backCommand);
  reg.registerBuiltin(incognitoCommand);
  reg.registerBuiltin(refreshCommand);
  reg.registerBuiltin(rollCommand);
  reg.registerBuiltin(whisperCommand);
  reg.registerBuiltin(replyCommand);
  reg.registerBuiltin(moodCommand);
  reg.registerBuiltin(sceneCommand);
  reg.registerBuiltin(npcCommand);
  reg.registerBuiltin(npcModeCommand);
  reg.registerBuiltin(friendCommand);
  reg.registerBuiltin(acceptFriendCommand);
  reg.registerBuiltin(declineFriendCommand);
  reg.registerBuiltin(unfriendCommand);
  reg.registerBuiltin(friendsCommand);
  reg.registerBuiltin(worldCommand);
  reg.registerBuiltin(worldsCommand);
  // Scriptorium, long-form fiction.
  reg.registerBuiltin(writeCommand);
  reg.registerBuiltin(storyCommand);
  reg.registerBuiltin(scriptoriumCommand);
  reg.registerBuiltin(expiryCommand);
  reg.registerBuiltin(replyModeCommand);
  reg.registerBuiltin(ignoreCommand);
  reg.registerBuiltin(unignoreCommand);
  reg.registerBuiltin(usersCommand);
  reg.registerBuiltin(bookmarksCommand);
  reg.registerBuiltin(listCommand);
  reg.registerBuiltin(clearCommand);
  reg.registerBuiltin(findCommand);
  // Moderation
  reg.registerBuiltin(kickCommand);
  reg.registerBuiltin(muteCommand);
  reg.registerBuiltin(unmuteCommand);
  reg.registerBuiltin(banCommand);
  reg.registerBuiltin(unbanCommand);
  reg.registerBuiltin(announceCommand);
  reg.registerBuiltin(promoteCommand);
  reg.registerBuiltin(demoteCommand);
  reg.registerBuiltin(promoteAdminCommand);
  reg.registerBuiltin(demoteAdminCommand);
  // Earning
  reg.registerBuiltin(currencyCommand);
  reg.registerBuiltin(expCommand);
  // Earning UI shortcuts, open the dashboard at specific tabs.
  reg.registerBuiltin(earningsCommand);
  reg.registerBuiltin(shopCommand);
  reg.registerBuiltin(collectionCommand);
  reg.registerBuiltin(petsCommand);
  // Items, hand / throw / drop catalog items from your inventory.
  reg.registerBuiltin(giveCommand);
  reg.registerBuiltin(throwCommand);
  reg.registerBuiltin(dropCommand);
  // /item <name>, open the full-screen item view from chat. Same
  // zoom overlay as tapping a Collection / Pets pin on a profile.
  reg.registerBuiltin(itemCommand);
  // Social mini-games: rock-paper-scissors and raffles. The
  // per-kind resolution hooks (group-elim for RPS, random-draw for
  // raffle, refund-on-cancel-or-empty for both) are wired into the
  // shared session registry by the two `register*` calls below,
  // they run once at boot, NOT per-command, so resolution behaves
  // the same regardless of which command spawned the session.
  registerRps();
  registerRaffle();
  registerTrivia();
  registerStoryDice();
  registerScramble();
  registerDuel();
  reg.registerBuiltin(rpsCommand);
  reg.registerBuiltin(raffleCommand);
  reg.registerBuiltin(claimCommand);
  reg.registerBuiltin(announceRaffleCommand);
  reg.registerBuiltin(triviaCommand);
  reg.registerBuiltin(answerCommand);
  reg.registerBuiltin(storyDiceCommand);
  reg.registerBuiltin(scrambleCommand);
  reg.registerBuiltin(duelCommand);
  reg.registerBuiltin(gamesCommand);
  reg.registerBuiltin(makeHelpCommand(() => reg));
}
