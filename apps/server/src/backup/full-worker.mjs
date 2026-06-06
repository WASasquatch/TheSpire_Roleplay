// Worker thread for full-DB snapshot generation.
//
// `VACUUM INTO` is a synchronous SQLite call that can take seconds
// on a multi-hundred-MB database, and better-sqlite3 has no async
// variant, running it on the main thread blocks the entire Node
// event loop for the duration. Socket.IO heartbeats time out, HTTP
// requests stall, and every connected user feels the freeze.
//
// Running the same call inside `worker_threads.Worker` keeps the
// main thread free. SQLite's WAL journal mode lets multiple
// readers proceed concurrently with the writer that VACUUM INTO
// holds; the main process can keep handling requests against the
// same database file from its own better-sqlite3 handle while
// this worker copies into a fresh sibling file.
//
// Contract:
//   workerData = { sourcePath: string, destPath: string }
//   On success: postMessage({ ok: true, sizeBytes: number })
//                + process.exit(0)
//   On failure: postMessage({ ok: false, error: string })
//                + process.exit(1)
//
// .mjs (not .ts) so the file is loaded natively by Node without
// needing tsx transpilation inside the worker, the parent process
// runs under tsx, but worker threads inherit V8 isolation, not the
// parent's module loader hooks.

import { parentPort, workerData } from "node:worker_threads";
import { statSync } from "node:fs";
import Database from "better-sqlite3";

function fail(err) {
  parentPort?.postMessage({ ok: false, error: err.message ?? String(err) });
  process.exit(1);
}

try {
  const { sourcePath, destPath } = workerData ?? {};
  if (typeof sourcePath !== "string" || typeof destPath !== "string") {
    throw new Error("worker requires { sourcePath, destPath } in workerData");
  }

  // Open the source DB read-only. VACUUM INTO doesn't actually need
  // write privileges on the source, it produces a fresh copy at
  // destPath, and readonly mode is a defense-in-depth gate against
  // accidentally mutating the live DB if a malformed query slips in.
  const src = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    // SQLite's parameter binding does NOT apply to filenames. The
    // destPath value originates from our own filename composer
    // (server-side, never user input) but escape the single quotes
    // defensively in case the path ever contains one.
    src.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }

  const sizeBytes = statSync(destPath).size;
  parentPort?.postMessage({ ok: true, sizeBytes });
  process.exit(0);
} catch (err) {
  fail(err);
}
