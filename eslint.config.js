// @ts-check
//
// Root ESLint flat config for the whole monorepo (apps/*, packages/*).
//
// Phase 0 of the cleanup plan (plan_ext.md §5, §6) is intentionally
// WARN-ONLY and NON-BLOCKING: this config exists to make governance
// available without forcing any source churn. NOTHING here is an `error`,
// so `pnpm lint` runs to completion and exits 0. Individual rules get
// ratcheted to `error` per-directory in later phases (§5.6) via additional
// flat-config blocks scoped to already-cleaned folders.
//
// MINIMAL by design (plan_ext.md §5.2): we do NOT extend the full
// `eslint:recommended` / `typescript-eslint` recommended presets, because
// those ship many `error`-level rules that would make a first-pass lint
// fail on the untouched god-files. Instead we use `tseslint.configs.base`
// (parser + plugin registration ONLY, zero rules) and enable just the
// handful of rules the plan names, all at `warn`.
//
// Deliberately NOT type-aware: we never set `languageOptions.parserOptions.project`.
// Type-checked linting is too slow and too noisy for a Phase 0 guardrail.
//
// IMPORTANT — do not fight the codebase's conventions:
//   * TS relative imports carry explicit `.js` extensions (ESM/tsx convention).
//     We therefore do NOT enable `import/no-unresolved` or `import/extensions`.
//   * The root `pnpm.overrides` pins @types/react to ^18; nothing here touches
//     module resolution.

import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";
// React-ecosystem plugins are registered ONLY so ESLint recognizes the inline
// `eslint-disable` directives the source already carries for their rules
// (react-hooks/exhaustive-deps, jsx-a11y/no-autofocus, react/no-danger).
// Their rules stay DORMANT in Phase 0 (see note in the rule block); they get
// switched on during the React cleanup (Phase 4). Without registering the
// plugins, those directives would raise "definition not found" ERRORS and
// break the warn-only guarantee.
import reactHooks from "eslint-plugin-react-hooks";
import react from "eslint-plugin-react";
import jsxA11y from "eslint-plugin-jsx-a11y";
// i18n literal-string guardrail (docs/I18N_PLAN.md §5) — registered only for
// the apps/web/src block near the bottom of this file. WARN-ONLY, like
// everything else here.
import i18next from "eslint-plugin-i18next";

export default tseslint.config(
  // --- Ignore globs -------------------------------------------------------
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "apps/server/drizzle/**",
      "apps/web/public/**",
      "**/public/games/**",
      "**/*.config.js",
      "**/*.min.*",
      "backups/**",
    ],
  },

  // --- Parser + plugin registration ONLY (no rules) -----------------------
  // `base` is typescript-eslint's minimal, non-type-checked preset: it wires
  // up the TS parser and the @typescript-eslint plugin without turning on a
  // single rule. That keeps Phase 0 strictly warn-only.
  tseslint.configs.base,

  // --- Project rule set (WARN-ONLY) --------------------------------------
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.ts"],
    plugins: {
      import: importPlugin,
      "unused-imports": unusedImports,
      // Registered for directive-recognition only; rules stay dormant (see header).
      "react-hooks": reactHooks,
      react,
      "jsx-a11y": jsxA11y,
    },
    linterOptions: {
      // Phase 0 carries many pre-existing / aspirational inline disable
      // directives (incl. ones for the dormant React rules above). Reporting
      // them as "unused" would be pure noise now, so silence it until the
      // relevant rules are switched on in later phases.
      reportUnusedDisableDirectives: "off",
    },
    settings: {
      react: { version: "18.3" },
    },
    languageOptions: {
      parserOptions: {
        // No `project`: non-type-checked mode on purpose (fast, quiet).
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // Unused IMPORTS are auto-removed on --fix by the unused-imports plugin;
      // genuinely-unused locals/args are still flagged (not auto-removed) with
      // the `_`-prefix escape. The core + TS unused-vars rules are off so these
      // two own it (running all three would double-report).
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Duplicate-import checking is OFF. A separate `import type {}` and
      // `import {}` from the SAME module is CORRECT and idiomatic under
      // verbatimModuleSyntax, not a defect. import/no-duplicates' autofixer
      // MERGES the two into a single `import type {}`, which (non-type-aware)
      // wrongly turns the value imports into type-only imports — it broke
      // rooms.ts / admin/routes.ts / typing.ts / arcadeUrugal.ts on --fix. The
      // core no-duplicate-imports is non-fixable but just noise here. Both off.
      "no-duplicate-imports": "off",
      "import/no-duplicates": "off",

      // NOTE: no-unresolved / import/extensions are intentionally absent so
      // the linter never fights the explicit `.js` import convention.
      "import/order": [
        "warn",
        {
          "newlines-between": "never",
          alphabetize: { order: "ignore" },
        },
      ],

      // consistent-type-imports is OFF: its autofixer is UNSAFE here. Phase 0
      // is non-type-aware (no parserOptions.project), so the fixer can't tell a
      // name is used as a value vs a type and mis-marks value imports as
      // `import type` (it broke ForumsCatalogModal on the first --fix run).
      // The codebase also uses inline `import("x").T` type annotations
      // deliberately (wire-type files, to avoid value-level import cycles), which
      // this rule fights. Revisit only if/when type-aware linting is enabled.
      "@typescript-eslint/consistent-type-imports": "off",
    },

    // ====================================================================
    // SHARED-FIRST CUSTOM LINT SKELETON — DORMANT UNTIL PHASE 1
    // ====================================================================
    // plan_ext.md §5.4: once the canonical helpers are extracted into the
    // shared module, re-declaring them anywhere must be flagged so the
    // mirror-heavy architecture can't re-drift. The helpers DO NOT EXIST
    // YET, so activating this in Phase 0 would produce false hits. It is
    // therefore intentionally COMMENTED OUT below. Uncomment (and point the
    // `message` at the real shared path) when Phase 1 lands the extractions,
    // then ratchet to `error` per §5.6.
    //
    // Canonical helpers to guard (plan_ext.md §5.4):
    //   jsonOrThrow, escapeHtml, escapeRegExp, identityKey,
    //   resolveActiveServerId, emitToUser, startOfUtcDayMs, parseLimit
    //
    // To activate, merge this into the `rules` block above:
    //
    //   "no-restricted-syntax": [
    //     "warn",
    //     {
    //       selector:
    //         "FunctionDeclaration[id.name=/^(jsonOrThrow|escapeHtml|escapeRegExp|identityKey|resolveActiveServerId|emitToUser|startOfUtcDayMs|parseLimit)$/]",
    //       message:
    //         "This helper is canonical — import it from @thekeep/shared instead of re-declaring it (plan_ext.md §5.4).",
    //     },
    //     {
    //       selector:
    //         "VariableDeclarator[id.name=/^(jsonOrThrow|escapeHtml|escapeRegExp|identityKey|resolveActiveServerId|emitToUser|startOfUtcDayMs|parseLimit)$/][init.type=/FunctionExpression|ArrowFunctionExpression/]",
    //       message:
    //         "This helper is canonical — import it from @thekeep/shared instead of re-declaring it (plan_ext.md §5.4).",
    //     },
    //   ],
  },

  // --- i18n literal-string guardrail (WARN-ONLY) — apps/web/src only ------
  // docs/I18N_PLAN.md §5 "Follow-up ratchet": flags user-facing string
  // literals that bypass t()/<Trans>. Installed warn-only; directories get
  // ratcheted to `error` per-folder as they're touched (same pattern as the
  // cleanup plan's ESLint ratchet). Server/shared strings are NOT covered
  // here on purpose — server copy went through the Phase 3 code→key map and
  // has no JSX for the rule to anchor on.
  //
  // Plugin mechanics that shape this config (eslint-plugin-i18next v6):
  //   * Option merge with the plugin defaults is SHALLOW — setting `words`
  //     replaces the ENTIRE default exclude set, so the defaults we still
  //     want are reproduced below.
  //   * `jsx-attributes.include` is a WHITELIST: with a non-empty `include`
  //     and an EMPTY `exclude`, only the listed attribute names are checked
  //     and every other attribute (className, style, onClick, variant, data-*,
  //     …) is skipped along with everything nested in its expression. Do NOT
  //     add entries to `exclude` here — a non-empty exclude flips shouldSkip()
  //     into "validate everything not excluded" and the warning count explodes.
  //   * String patterns are auto-anchored (^…$); RegExp literals pass through
  //     unchanged.
  //   * mode "jsx-only" = JSX text + attributes; plain .ts files (no JSX)
  //     produce nothing, and non-JSX code in .tsx files is not scanned.
  //     Template literals are not validated (plugin default) — the pseudo-
  //     locale sweep + coverage script remain the guardrails for those.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: [
      // Test files: none exist under apps/web/src today, but keep the carve-out
      // so future component tests never fight the guardrail.
      "apps/web/src/**/*.test.*",
      "apps/web/src/**/*.spec.*",
      "apps/web/src/**/__tests__/**",
      "apps/web/src/**/__mocks__/**",
      // Per-locale help-content JSX modules (I18N_PLAN.md §6): help guides
      // deliberately do NOT go through t()/JSON keys — each locale ships its
      // own JSX module with per-guide fallback. Their literal strings ARE the
      // translation mechanism (~2,000 of them), so the guardrail must not
      // count them. Infra in those folders (loader.ts, blocks.tsx, types.ts)
      // stays covered.
      "apps/web/src/components/helpGuides/en.tsx",
      "apps/web/src/components/helpGuides/locales/**",
      "apps/web/src/components/helpFormatting/en.tsx",
      "apps/web/src/components/helpFormatting/locales/**",
    ],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": [
        "warn",
        {
          mode: "jsx-only",
          // Only these attributes carry translatable copy. Everything else —
          // className/style, handlers, protocol props (kind/variant/size/id/…)
          // — is skipped by the whitelist (see mechanics note above; keep
          // `exclude` EMPTY).
          "jsx-attributes": {
            include: [
              "alt",
              "title",
              "label",
              "placeholder",
              "aria-label",
              "aria-description",
              "aria-placeholder",
              "aria-valuetext",
              "aria-roledescription",
            ],
            exclude: [],
          },
          words: {
            exclude: [
              // — Reproduced plugin defaults (shallow merge would drop them) —
              // Punctuation/digit-only runs, e.g. "…", "%", "1/2", ")". The
              // unicode-aware pattern below also covers separators like
              // "·", "—", "→" and emoji, plus raw HTML entities ("&middot;").
              /^(?:&[a-zA-Z0-9]+;|[^\p{L}])+$/u,
              // ALL-CAPS protocol/constant tokens: "OOC", "NSFW", "EXP",
              // "2FA", "24H" (default was [A-Z_-]+; digits added).
              "[A-Z0-9_-]+",
              // — Protocol identifiers (this codebase's shapes) —
              // Multi-segment tokens: permission keys (use_room_transitions),
              // error codes / i18n keys (chat.composer.send), socket events
              // (room:join), MIME types (application/json), locales (es-419).
              /^[\p{L}\p{N}]+(?:[._:/@#-][\p{L}\p{N}]+)+$/u,
              // Leading-symbol tokens: slash-commands (/mute), identity
              // tokens (@id:…/@cid:…), hashes/paths (#anchor, /f/slug).
              /^[/@#][\p{L}\p{N}._:/@#-]*$/u,
              // camelCase identifiers leaking into JSX positions (forumId).
              /^[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+$/,
              // Bare single lowercase ASCII tokens: overwhelmingly protocol
              // vocabulary in code positions inside JSX — kind/tab/mode ids
              // ("say", "whisper", "compose", id: "profile"). Deliberate
              // precision trade-off: real UI copy here is Sentence-cased or
              // multi-word, and the coverage script + pseudo-locale sweep
              // backstop any lowercase one-word copy this hides.
              /^[a-z0-9]+$/,
            ],
          },
        },
      ],
    },
  },
);
