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
import { makeHelpCommand } from "./help.js";
import { colorCommand } from "./color.js";
import { awayCommand } from "./away.js";
import { refreshCommand } from "./refresh.js";
import { rollCommand } from "./roll.js";
import { whisperCommand } from "./whisper.js";
import { ignoreCommand, unignoreCommand } from "./ignore.js";
import { usersCommand } from "./users.js";
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
  reg.registerBuiltin(colorCommand);
  reg.registerBuiltin(awayCommand);
  reg.registerBuiltin(refreshCommand);
  reg.registerBuiltin(rollCommand);
  reg.registerBuiltin(whisperCommand);
  reg.registerBuiltin(ignoreCommand);
  reg.registerBuiltin(unignoreCommand);
  reg.registerBuiltin(usersCommand);
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
  reg.registerBuiltin(makeHelpCommand(() => reg));
}
