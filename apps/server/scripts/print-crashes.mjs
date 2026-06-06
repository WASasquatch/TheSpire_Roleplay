#!/usr/bin/env node
// Standalone crash-log viewer for `fly ssh console` use.
//
// When the server is dead (10-restart loop hit, container won't
// even boot), the admin API at /admin/diagnostics/crashes can't be
// reached. This CLI reads the same JSONL log file the API does,
// formats each entry as a human-readable block, and prints to
// stdout. Works from a fresh `fly ssh console` session with no
// dependencies beyond plain Node.
//
// Usage:
//   node apps/server/scripts/print-crashes.mjs              # last 50 entries
//   node apps/server/scripts/print-crashes.mjs --limit 10   # last 10 entries
//   node apps/server/scripts/print-crashes.mjs --raw        # one JSON per line
//   node apps/server/scripts/print-crashes.mjs --path       # just print the log path
//
// Reads from BOTH the current log (crash-log.jsonl) and the
// rotated previous generation (crash-log.jsonl.prev) so a crash
// storm that triggered rotation still surfaces all entries.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import "dotenv/config";

const SQLITE_PATH = process.env.SQLITE_PATH ?? process.env.DATABASE_URL ?? "./data/thekeep.sqlite";
// The migration runner resolves dbDir relative to the server root,
// so we mirror that resolution here for parity.
const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(__dirname, "..");
const DB_DIR = dirname(resolve(ROOT, SQLITE_PATH));
const CRASH_LOG_PATH = resolve(DB_DIR, "crash-log.jsonl");
const PREV_LOG_PATH = CRASH_LOG_PATH + ".prev";

const args = process.argv.slice(2);
let limit = 50;
let raw = false;
let pathOnly = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--limit" || a === "-n") {
    const next = parseInt(args[i + 1] ?? "", 10);
    if (Number.isFinite(next) && next > 0) {
      limit = next;
      i++;
    }
  } else if (a === "--raw") {
    raw = true;
  } else if (a === "--path") {
    pathOnly = true;
  } else if (a === "--help" || a === "-h") {
    console.log("Usage: node print-crashes.mjs [--limit N] [--raw] [--path]");
    process.exit(0);
  }
}

if (pathOnly) {
  console.log(CRASH_LOG_PATH);
  process.exit(0);
}

// Read both files (current + rotated) so a crash storm that
// triggered rotation doesn't bury context. Most-recent-first.
function readEntries(maxN) {
  const out = [];
  for (const path of [CRASH_LOG_PATH, PREV_LOG_PATH]) {
    if (out.length >= maxN) break;
    if (!existsSync(path)) continue;
    let content;
    try { content = readFileSync(path, "utf8"); }
    catch (err) {
      console.error(`error reading ${path}: ${err?.message ?? err}`);
      continue;
    }
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        out.push(e);
        if (out.length >= maxN) break;
      } catch { /* skip malformed line */ }
    }
  }
  return out;
}

const entries = readEntries(limit);

if (raw) {
  for (const e of entries) console.log(JSON.stringify(e));
  process.exit(0);
}

if (entries.length === 0) {
  console.log(`no crash entries found in ${CRASH_LOG_PATH}`);
  console.log(`(also checked ${PREV_LOG_PATH})`);
  console.log("if you expected entries: check that the /data volume is mounted and writable");
  process.exit(0);
}

const dim = (s) => `[2m${s}[0m`;
const red = (s) => `[31m${s}[0m`;
const yellow = (s) => `[33m${s}[0m`;
const green = (s) => `[32m${s}[0m`;
const cyan = (s) => `[36m${s}[0m`;
const colorForKind = (k) => {
  if (k === "boot-ok") return green;
  if (k === "boot-start") return cyan;
  if (k === "signal") return yellow;
  return red;
};

console.log(`${entries.length} crash entries (most recent first), from ${CRASH_LOG_PATH}`);
console.log("=".repeat(70));
for (const e of entries) {
  const when = new Date(e.ts).toISOString();
  const color = colorForKind(e.kind);
  console.log("");
  console.log(`${color(e.kind)}, ${when} (uptime ${e.uptimeSec}s, pid ${e.pid})`);
  if (e.flyMachineId) {
    console.log(dim(`  fly: ${e.flyApp || "?"} / ${e.flyRegion || "?"} / ${e.flyMachineId}`));
  }
  if (e.signal) console.log(`  signal: ${e.signal}`);
  if (e.message) console.log(`  message: ${e.message}`);
  if (e.context) {
    console.log(`  context: ${JSON.stringify(e.context)}`);
  }
  if (e.stack) {
    console.log(dim("  stack:"));
    for (const line of e.stack.split("\n")) {
      console.log(dim(`    ${line}`));
    }
  }
}
console.log("");
console.log("=".repeat(70));
