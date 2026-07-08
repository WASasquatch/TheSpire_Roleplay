import { Module } from "node:module";
import type { Config } from "drizzle-kit";

// drizzle-kit loads the schema through esbuild-register (CommonJS), whose
// resolver does not remap NodeNext ".js" import specifiers back to their ".ts"
// source. The schema is split across ./src/db/schema/*.ts modules that import
// one another (and ./_helpers) with ".js" extensions, so add a ".js" -> ".ts"
// fallback for relative specifiers. drizzle-kit installs/reverts its own
// `_resolveFilename` wrapper around every schema load, so we pin ours as a
// permanent, outermost getter that delegates to the resolver captured here
// (which itself resolves normally) rather than back through this hook.
// Runtime-only for `drizzle-kit`; the app never loads this file.
/* eslint-disable @typescript-eslint/no-explicit-any */
const mod = Module as any;
const pristineResolve: (request: string, ...rest: unknown[]) => string =
  mod._resolveFilename.bind(Module);
const tsFallbackResolve = function (
  this: unknown,
  request: string,
  ...rest: unknown[]
): string {
  if (typeof request === "string" && request.startsWith(".") && request.endsWith(".js")) {
    try {
      return pristineResolve(request, ...rest);
    } catch {
      return pristineResolve(`${request.slice(0, -3)}.ts`, ...rest);
    }
  }
  return pristineResolve(request, ...rest);
};
Object.defineProperty(mod, "_resolveFilename", {
  configurable: true,
  get: () => tsFallbackResolve,
  // Swallow drizzle-kit's own tsconfig-paths patch + its revert; the split
  // schema resolves fine through the pristine resolver above.
  set: () => {},
});

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.SQLITE_PATH ?? process.env.DATABASE_URL ?? "./data/thekeep.sqlite",
  },
} satisfies Config;
