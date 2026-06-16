# Server route tests

Hermetic, in-process tests for the HTTP route handlers. No network, no real DB —
each run builds a fresh `:memory:` SQLite with the full migration set applied and
mounts the real route handlers on a bare Fastify app, then drives them with
`app.inject(...)`.

## Running

```bash
npm test          # from apps/server
```

**Requires Node 22** (same as migrations) — `better-sqlite3` is compiled against
the Node 22 ABI, so running under another version fails to load with an
`ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` error. If you use nvm: `nvm use 22`
first. The script is `node --import tsx --test test/*.test.ts`, so the runner is
Node's built-in test runner with the `tsx` loader for TypeScript — no extra deps.

Test files live flat in `test/` as `*.test.ts` (the script glob is
`test/*.test.ts`, expanded by the shell — keep tests at this level).

## Harness (`test/helpers/`)

- `env.ts` — **import first in every test file.** Points `SQLITE_PATH` at a temp
  file so importing route modules (which create the `src/db/index.ts` singleton
  at load time) never touches the dev DB. Tests use their own in-memory db.
- `harness.ts`:
  - `makeTestDb()` → `{ db, raw }` — fresh in-memory DB, all `drizzle/*.sql`
    applied (incl. permission-grant seeds, so role-based `hasPermission` works).
  - `buildUsersApp(db)` — Fastify app with `registerUsersRoutes` mounted +
    the production `ZodError → 400` error handler replicated.
  - `createUser(db, { role, ... })`, `tokenFor(db, userId)` (a `sessions` row =
    a bearer token), `auth(token)` header helper.

## Adding a test

```ts
import "./helpers/env.js"; // MUST be first
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUsersApp, createUser, makeTestDb, tokenFor, auth } from "./helpers/harness.js";

// ...build db + app once, create principals, app.inject(), assert status/body.
```

## What's covered

- `account-ban.test.ts` — the account-ban lifecycle + permission gates: who may
  ban (role grants + hierarchy), that a ban blocks authentication, unban + expiry
  restore access, and the mod-only review endpoint.

This is the seed suite. Extend coverage toward the **risky** routes (auth,
permissions/moderation, earning/currency, data invariants) rather than every
route — see the harness pattern above to add a `registerXRoutes`-backed app.
