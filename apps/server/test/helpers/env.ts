/**
 * Test environment shim. MUST be the first import in every test file, before
 * anything that transitively imports `src/db/index.ts` (which opens
 * `SQLITE_PATH` as a singleton at module-eval time). Pointing it at a throwaway
 * temp file keeps the real dev DB untouched, the tests build their own
 * in-memory database (see harness.ts) and never use this singleton.
 *
 * ESM evaluates the dependency graph in import order, depth-first, so as long
 * as a test does `import "./helpers/env.js"` before importing the harness /
 * route modules, this runs first and the env var is set in time.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "spire-test-")), "singleton.sqlite");
// Quiet a couple of boot-time env reads other modules may touch.
process.env.SESSION_SECRET ??= "test-secret";
process.env.NODE_ENV ??= "test";
