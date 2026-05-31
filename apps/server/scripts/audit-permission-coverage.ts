/**
 * Granular permission system — coverage audit.
 *
 * Answers two operational questions the resolver-invariant check
 * (`check-permissions.ts`) cannot:
 *
 *   1. **Is every catalog key actually checked by the server?**
 *      Greps every .ts under `apps/server/src/` for calls to the
 *      permission helpers (`hasPermission`, `requirePermission`,
 *      `requireSessionPermission`, `requireMatrixPermission`) and
 *      counts which catalog keys appear inside. Keys with zero call
 *      sites are either:
 *        - intentionally tab-only (`view_admin_*` — gates the UI tab
 *          on the client, the data endpoints behind it check a
 *          DIFFERENT key), OR
 *        - dead permissions left in the catalog after a refactor.
 *      Tagged respectively in the report.
 *
 *   2. **For every `view_admin_*` tab key, do the roles that hold the
 *      tab key also hold the data keys needed to render the tab?**
 *      Coherence pass cross-references a curated tab→data map against
 *      the seed grants. Concrete example of the bug class this catches:
 *      a route that gates on a different key from the tab visibility
 *      and a role that holds the first but not the second would see
 *      the tab and 403 on the data fetch. (That exact case — audit
 *      tab vs `view_audit_log` — was fixed in migration 0182 by
 *      consolidating onto `view_admin_audit`.)
 *
 * Run:
 *   pnpm --filter @thekeep/server run permissions:audit
 *
 * Exit code:
 *   0 = no orphans, no mismatches
 *   1 = at least one finding worth investigating
 *
 * False-positives to expect:
 *   - A key that's checked dynamically (`hasPermission(user, dynamicVar)`)
 *     where `dynamicVar` is built from a permKey lookup — won't show as
 *     a static call site. Currently rare; we'd add a `// audit:dynamic
 *     <key>` annotation comment if it becomes a problem.
 *   - The catalog file itself defines every key as a string literal;
 *     the scanner intentionally skips `packages/shared/src/permissions.ts`
 *     so those definitions don't count as call sites.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  type PermissionGroup,
  type PermissionKey,
  type Role,
} from "@thekeep/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, "..");
const SCAN_ROOT = resolve(SERVER_ROOT, "src");
const SEED_SQL_PATH = resolve(SERVER_ROOT, "drizzle/0179_permission_grants.sql");
const SEED_SQL_AFFILIATES_PATH = resolve(SERVER_ROOT, "drizzle/0180_permission_grants_affiliates.sql");

/* Scan strategy:
 *
 * We can't restrict the search to the canonical helper names
 * (`hasPermission`, `requirePermission`, …) because several callers
 * gate permissions through local wrappers that take a `PermissionKey`
 * parameter (e.g., `callerCanModerateRoom(ctx, "kick_user")` in
 * `commands/builtins/mod.ts`). With the helper-name filter on, those
 * wrapper call sites get classified as orphans even though the key
 * IS gated — just one level of indirection deeper.
 *
 * The looser policy: count any code-level reference to a catalog key
 * as evidence the key is wired in. Comments are excluded (otherwise
 * the catalog's own descriptions would show up), and the catalog
 * definition file is not in the scan root.
 *
 * Trade-off: a match in `recordAudit({ action: "ban_user" })` counts
 * the same as a real check call. We accept that — both confirm the
 * key isn't dead. The script's job is to surface keys with ZERO
 * references at all; deeper "is the check correctly gating the
 * intended route?" auditing has to happen by reading code. */
const KEY_LITERAL_RE = /['"]([a-z_]+)['"]/g;

/* =====================================================================
 * Tab → data-permission map.
 *
 * For each `view_admin_<X>` tab, lists the OTHER catalog keys that
 * gate the data the tab renders. The coherence pass uses this to
 * detect tabs where a role can see the tab but can't fetch anything
 * inside.
 *
 * `[]` means "no separate data gate" — the tab is self-contained
 * (read-only views that piggyback on the tab key itself, or content
 * the tab gate already covers). The coherence pass treats `[]` as
 * "always OK."
 *
 * **Manual review note:** the right way to maintain this map is to
 * read each AdminPanel tab's component and identify which endpoints
 * it calls + which keys those endpoints require. The mapping below
 * was assembled from a code walk on 2026-05-31 — if a future tab
 * adds a new endpoint, add the key here.
 * ===================================================================== */
const TAB_DATA_MAP: Record<string, readonly PermissionKey[]> = {
  view_admin_overview: [], // counter snapshots — same gate as the tab
  view_admin_users: ["view_user_directory_secure"],
  view_admin_rooms: [], // rooms list reuses public rooms endpoint
  view_admin_audit: [], // route gates on the tab key itself (consolidated 0182)
  view_admin_reports: ["view_report_queue"],
  view_admin_earning: ["view_earning_config"],
  view_admin_emoticons: ["manage_emoticon_catalog"],
  view_admin_settings: ["edit_site_settings"],
  view_admin_branding: ["edit_branding"],
  view_admin_rules: [], // rules edit is part of settings; tab is read-only
  view_admin_affiliates: ["manage_affiliates"],
  view_admin_scriptorium: ["view_others_scriptorium_drafts"],
  view_admin_backups: ["manage_backups"],
  view_admin_custom_commands: ["manage_custom_commands"],
  view_admin_title_kinds: ["manage_title_kinds"],
  view_admin_nav_links: ["manage_nav_links"],
  view_admin_permissions: [], // self-gated
};

const TAB_KEYS = Object.keys(TAB_DATA_MAP) as PermissionKey[];

const ALL_ROLES: readonly Role[] = ["user", "trusted", "mod", "admin", "masteradmin"] as const;
const NON_MASTER_ROLES: readonly Role[] = ["user", "trusted", "mod", "admin"] as const;

/* =====================================================================
 * SCAN PASS
 * Walk apps/server/src/ recursively. For each .ts file (but not
 * permissionsCore.ts / permissions.ts / requireSessionPermission.ts —
 * those DEFINE the helpers, references inside don't represent
 * application-level gates), find every helper call and extract the
 * keys mentioned.
 * ===================================================================== */

interface CallSite {
  key: PermissionKey;
  file: string;
  line: number;
}

const SKIP_FILES = new Set([
  resolve(SCAN_ROOT, "auth/permissions.ts"),
  resolve(SCAN_ROOT, "auth/permissionsCore.ts"),
  resolve(SCAN_ROOT, "auth/permissionsDiagnostics.ts"),
  resolve(SCAN_ROOT, "auth/requireSessionPermission.ts"),
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !SKIP_FILES.has(full)) out.push(full);
  }
  return out;
}

function extractCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  const catalogSet = new Set<string>(PERMISSION_KEYS);
  const files = walk(SCAN_ROOT);

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    // Strip line and block comments before scanning so the catalog's
    // own descriptive text inside JSDoc blocks doesn't get counted as
    // a reference. The stripper preserves source positions by
    // replacing comment bytes with spaces (newlines preserved), so
    // line numbers reported in findings stay accurate.
    const text = stripComments(raw);

    // Pre-compute line offsets so we can map an offset → 1-indexed line.
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
    function lineFor(offset: number): number {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (lineStarts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    }

    let m: RegExpExecArray | null;
    KEY_LITERAL_RE.lastIndex = 0;
    while ((m = KEY_LITERAL_RE.exec(text)) !== null) {
      const tok = m[1]!;
      if (!catalogSet.has(tok)) continue;
      sites.push({
        key: tok as PermissionKey,
        file: relative(SERVER_ROOT, file),
        line: lineFor(m.index),
      });
    }
  }

  return sites;
}

/**
 * Replace `// …` and `/* … *\/` regions with whitespace (preserving
 * newlines for line-number mapping). String literals are honoured so
 * a `"//"` inside a quoted string isn't mistaken for a line comment.
 *
 * Cheap and good-enough for an audit script — doesn't handle every
 * edge case (regex literals with comment-like contents, template
 * literal interpolations with comments), but those don't appear in
 * the server source in practice.
 */
function stripComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  let inStr: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    if (inStr) {
      out.push(ch);
      if (ch === "\\") { out.push(src[i + 1] ?? ""); i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; out.push(ch); i++; continue; }
    if (ch === "/" && src[i + 1] === "/") {
      // Line comment — eat through end of line, preserve the newline.
      while (i < src.length && src[i] !== "\n") {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      // Block comment — eat through closing */, preserve newlines.
      out.push("  ");
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < src.length) { out.push("  "); i += 2; }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/* =====================================================================
 * SEED LOADER (reused from check-permissions.ts conceptually).
 * ===================================================================== */

function loadSeedGrants(): Map<Role, Set<PermissionKey>> {
  const grants = new Map<Role, Set<PermissionKey>>();
  const catalog = new Set<string>(PERMISSION_KEYS);

  function ingest(path: string): void {
    const sql = readFileSync(path, "utf8");
    const blocks = sql.match(/INSERT\s+INTO\s+`role_permission_grants`[^;]*;/gi) ?? [];
    const tupleRe = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
    for (const block of blocks) {
      let m: RegExpExecArray | null;
      while ((m = tupleRe.exec(block)) !== null) {
        const role = m[1] as Role;
        const key = m[2]!;
        if (!catalog.has(key)) continue;
        const set = grants.get(role) ?? new Set<PermissionKey>();
        set.add(key as PermissionKey);
        grants.set(role, set);
      }
    }
  }
  ingest(SEED_SQL_PATH);
  ingest(SEED_SQL_AFFILIATES_PATH);
  return grants;
}

/* =====================================================================
 * REPORTING
 * ===================================================================== */

interface CoverageRow {
  key: PermissionKey;
  group: PermissionGroup;
  sites: number;
  status: "ok" | "tab-visibility" | "orphan";
}

interface CoherenceFinding {
  tabKey: PermissionKey;
  dataKeys: readonly PermissionKey[];
  role: Role;
  missing: PermissionKey[];
}

function summarize(): {
  coverage: CoverageRow[];
  coverageByGroup: Map<PermissionGroup, CoverageRow[]>;
  coherence: CoherenceFinding[];
  sites: CallSite[];
} {
  const sites = extractCallSites();
  const siteCount = new Map<PermissionKey, number>();
  for (const s of sites) siteCount.set(s.key, (siteCount.get(s.key) ?? 0) + 1);

  const coverage: CoverageRow[] = PERMISSION_KEYS.map((key) => {
    const count = siteCount.get(key) ?? 0;
    const isTabKey = TAB_KEYS.includes(key);
    let status: CoverageRow["status"];
    if (count > 0) status = "ok";
    else if (isTabKey) status = "tab-visibility";
    else status = "orphan";
    return { key, group: PERMISSION_GROUPS[key], sites: count, status };
  });

  // Per-group bucket, catalog order.
  const coverageByGroup = new Map<PermissionGroup, CoverageRow[]>();
  for (const row of coverage) {
    const arr = coverageByGroup.get(row.group) ?? [];
    arr.push(row);
    coverageByGroup.set(row.group, arr);
  }

  // Coherence pass.
  const seed = loadSeedGrants();
  const coherence: CoherenceFinding[] = [];
  for (const tabKey of TAB_KEYS) {
    const dataKeys = TAB_DATA_MAP[tabKey];
    if (dataKeys.length === 0) continue;
    for (const role of NON_MASTER_ROLES) {
      const grants = seed.get(role) ?? new Set<PermissionKey>();
      if (!grants.has(tabKey)) continue; // role doesn't see this tab
      const missing = dataKeys.filter((k) => !grants.has(k));
      if (missing.length > 0) {
        coherence.push({ tabKey, dataKeys, role, missing });
      }
    }
  }

  return { coverage, coverageByGroup, coherence, sites };
}

const GROUP_ORDER: readonly PermissionGroup[] = (() => {
  const seen = new Set<PermissionGroup>();
  const out: PermissionGroup[] = [];
  for (const key of PERMISSION_KEYS) {
    const g = PERMISSION_GROUPS[key];
    if (!seen.has(g)) { seen.add(g); out.push(g); }
  }
  return out;
})();

const GROUP_LABEL: Record<PermissionGroup, string> = {
  chat_moderation: "Chat moderation",
  room_admin: "Room administration",
  user_admin: "User administration",
  site_admin: "Site administration",
  content_admin: "Content moderation",
  audit_view: "Audit & reports",
  admin_panel_tabs: "Admin panel tabs",
  earning_admin: "Earning system",
  backups: "Backups",
  permission_admin: "Permission admin",
};

function colorize(s: string, code: number): string {
  if (!process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const green = (s: string) => colorize(s, 32);
const red = (s: string) => colorize(s, 31);
const yellow = (s: string) => colorize(s, 33);
const dim = (s: string) => colorize(s, 90);
const bold = (s: string) => colorize(s, 1);
const cyan = (s: string) => colorize(s, 36);

function render(): void {
  const summary = summarize();
  const { coverage, coverageByGroup, coherence, sites } = summary;
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

  console.log(bold("\nPermission system — coverage audit\n"));
  console.log(dim(`  Scanned ${sites.length} server call sites across permission helpers.\n`));

  console.log(bold("== Server call sites by key =="));
  console.log(dim("   ✓ ok   ⓘ tab-visibility (UI-only, expected zero server sites)   ⚠ orphan"));
  for (const group of GROUP_ORDER) {
    const rows = coverageByGroup.get(group) ?? [];
    console.log(`\n  ${bold(GROUP_LABEL[group])}`);
    for (const row of rows) {
      const tag = row.status === "ok"
        ? green("✓ ok            ")
        : row.status === "tab-visibility"
          ? cyan("ⓘ tab-visibility")
          : red("⚠ orphan        ");
      const sitesStr = row.sites > 0
        ? `${row.sites} site${row.sites === 1 ? "" : "s"}`
        : dim("0 sites");
      console.log(`    ${tag}  ${row.key.padEnd(40)} ${sitesStr}`);
    }
  }

  console.log(bold("\n== Tab/data coherence =="));
  console.log(dim("   For every view_admin_<X> tab key, every role that holds the tab"));
  console.log(dim("   must also hold the data keys needed to render the tab."));
  if (coherence.length === 0) {
    console.log(`\n  ${green("✓ all tabs coherent — every tab-holder can fetch the data behind it")}`);
  } else {
    for (const f of coherence) {
      console.log(
        `\n  ${red("✗")} ${bold(f.tabKey)} (held by ${f.role})`,
      );
      console.log(`      expects data perms: ${f.dataKeys.join(", ")}`);
      console.log(`      ${red(`missing: ${f.missing.join(", ")}`)}`);
      console.log(dim(`      result: ${f.role} sees the tab in the admin panel but the data fetch returns 403.`));
    }
  }

  if (verbose) {
    console.log(bold("\n== Call sites per key =="));
    console.log(dim("   File:line for every catalog-key literal found in the server source."));
    const byKey = new Map<PermissionKey, CallSite[]>();
    for (const s of sites) {
      const arr = byKey.get(s.key) ?? [];
      arr.push(s);
      byKey.set(s.key, arr);
    }
    for (const group of GROUP_ORDER) {
      const rows = (coverageByGroup.get(group) ?? []).filter((r) => r.sites > 0);
      if (rows.length === 0) continue;
      console.log(`\n  ${bold(GROUP_LABEL[group])}`);
      for (const row of rows) {
        const sitesForKey = (byKey.get(row.key) ?? []).sort(
          (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
        );
        console.log(`    ${cyan(row.key)}`);
        for (const s of sitesForKey) {
          console.log(`      ${dim(`${s.file}:${s.line}`)}`);
        }
      }
    }
  }

  const orphanCount = coverage.filter((r) => r.status === "orphan").length;
  const tabOnlyCount = coverage.filter((r) => r.status === "tab-visibility").length;
  const okCount = coverage.filter((r) => r.status === "ok").length;

  console.log(bold("\n== Summary =="));
  console.log(`  ${green(`${okCount} OK`)}, ${cyan(`${tabOnlyCount} tab-only`)}, ${
    orphanCount === 0 ? green("0 orphans") : red(`${orphanCount} orphans`)
  }`);
  console.log(`  Tab/data coherence: ${
    coherence.length === 0 ? green("clean") : red(`${coherence.length} mismatch${coherence.length === 1 ? "" : "es"}`)
  }`);
  console.log("");

  process.exit(orphanCount === 0 && coherence.length === 0 ? 0 : 1);
}

void ALL_ROLES; // referenced for type-system completeness in the helpers above.
render();
