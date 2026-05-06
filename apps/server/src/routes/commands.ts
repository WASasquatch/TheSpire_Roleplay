import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import type { CommandDoc } from "@thekeep/shared";
import type { CommandRegistry } from "../commands/registry.js";
import { customCommandAliases, customCommands } from "../db/schema.js";
import type { Db } from "../db/index.js";

/**
 * GET /commands — what the help modal renders.
 *
 * Returns every built-in command (with subcommand info if declared) plus
 * every enabled custom command. Custom commands are flagged with
 * `isCustom: true` so the UI can group/badge them.
 */
export async function registerCommandsRoutes(
  app: FastifyInstance,
  db: Db,
  registry: CommandRegistry,
): Promise<void> {
  app.get("/commands", async () => {
    const builtins = registry.listCanonical();
    const builtinDocs: CommandDoc[] = builtins.map((c) => ({
      name: c.name,
      aliases: [...(c.aliases ?? [])],
      usage: c.usage ?? `/${c.name}`,
      description: c.description ?? "",
      subcommands: (c.subcommands ?? []).map((s) => ({
        verb: s.verb,
        usage: s.usage,
        description: s.description,
        aliases: [...(s.aliases ?? [])],
      })),
      isCustom: false,
    }));

    // Custom commands aren't in the builtin list; pull from the DB so we
    // surface descriptions/aliases that admins authored.
    const customRows = await db
      .select()
      .from(customCommands)
      .where(eq(customCommands.enabled, true))
      .orderBy(asc(customCommands.name));
    const aliasRows = await db.select().from(customCommandAliases);
    const aliasesByCmd = new Map<string, string[]>();
    for (const a of aliasRows) {
      const list = aliasesByCmd.get(a.commandId) ?? [];
      list.push(a.alias);
      aliasesByCmd.set(a.commandId, list);
    }
    const customDocs: CommandDoc[] = customRows.map((c) => ({
      name: c.name,
      aliases: aliasesByCmd.get(c.id) ?? [],
      usage: `/${c.name} [args]`,
      description: c.description ?? `(custom — ${c.kind})`,
      subcommands: [],
      isCustom: true,
    }));

    // Builtins protected from shadowing → already only one entry per name.
    // Sort everything alphabetically for a predictable modal.
    const all = [...builtinDocs, ...customDocs].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return { commands: all };
  });
}
