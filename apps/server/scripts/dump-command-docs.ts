/**
 * Dump every builtin command's user-facing doc prose (description +
 * subcommand descriptions) as JSON on stdout — the extraction source for
 * the commands.json `docs.*` catalog section (GET /commands localization).
 * Usage: npx tsx apps/server/scripts/dump-command-docs.ts
 */
import { CommandRegistry } from "../src/commands/registry.js";
import { registerBuiltins } from "../src/commands/builtins/index.js";

const registry = new CommandRegistry();
registerBuiltins(registry);

const out: Record<string, { description: string; sub?: Record<string, string> }> = {};
for (const c of registry.listCanonical()) {
  const entry: { description: string; sub?: Record<string, string> } = {
    description: c.description ?? "",
  };
  const subs = c.subcommands ?? [];
  if (subs.length > 0) {
    entry.sub = {};
    for (const s of subs) {
      // Key segment: the verb with i18next-reserved "." and ":" replaced.
      const verbKey = s.verb.replace(/[.:]/g, "_");
      entry.sub[verbKey] = s.description;
    }
  }
  out[c.name] = entry;
}
console.log(JSON.stringify(out, null, 2));
