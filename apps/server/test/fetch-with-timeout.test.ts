import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout } from "../src/lib/fetchWithTimeout.js";

/**
 * Characterization test for the consolidated `fetchWithTimeout` helper
 * (apps/server/src/lib/fetchWithTimeout.ts), extracted from the three
 * hand-rolled `AbortController` + `setTimeout(..., ms)` + `clearTimeout`
 * scaffolds in auth/googleOauth.ts (`fetchJson`), lib/youtube.ts (`apiGet`),
 * and unfurl.ts (`fetchHtml`).
 *
 * Pins the observable contract every caller relied on:
 *   - the url is forwarded verbatim (string or URL),
 *   - the caller's init (method/headers/body/redirect) is passed through
 *     unchanged via a shallow spread,
 *   - a bare `AbortController` signal is attached, overriding any signal the
 *     caller put in init,
 *   - the deadline fires regardless (covers body consumption; the timer is
 *     never cleared, matching the old finally-clearTimeout that ran only after
 *     the caller's body read),
 *   - on timeout the rejection is a plain `AbortError` ("This operation was
 *     aborted") — NOT a `TimeoutError` — because youtube.apiGet surfaces that
 *     message to users; `AbortSignal.timeout` would have changed it.
 */
describe("fetchWithTimeout", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function captureFetch(): Array<{ url: unknown; init: RequestInit | undefined }> {
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    globalThis.fetch = ((url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;
    return calls;
  }

  test("forwards the url verbatim (string)", async () => {
    const calls = captureFetch();
    await fetchWithTimeout("https://example.com/x?a=1", {}, 5_000);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://example.com/x?a=1");
  });

  test("forwards the url verbatim (URL object)", async () => {
    const calls = captureFetch();
    const u = new URL("https://example.com/y");
    await fetchWithTimeout(u, {}, 5_000);
    assert.equal(calls[0]!.url, u);
  });

  test("passes caller init (method/headers/body/redirect) through unchanged", async () => {
    const calls = captureFetch();
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: "code=abc",
      redirect: "manual",
    };
    await fetchWithTimeout("https://example.com/token", init, 8_000);
    const passed = calls[0]!.init!;
    assert.equal(passed.method, "POST");
    assert.deepEqual(passed.headers, {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    });
    assert.equal(passed.body, "code=abc");
    assert.equal(passed.redirect, "manual");
  });

  test("attaches an AbortSignal via the timeout", async () => {
    const calls = captureFetch();
    await fetchWithTimeout("https://example.com/z", {}, 5_000);
    const signal = calls[0]!.init!.signal;
    assert.ok(signal instanceof AbortSignal, "signal is an AbortSignal");
    assert.equal(signal!.aborted, false, "not aborted synchronously");
  });

  test("the attached signal overrides any signal in caller init", async () => {
    const calls = captureFetch();
    const callerCtrl = new AbortController();
    await fetchWithTimeout("https://example.com/z", { signal: callerCtrl.signal }, 5_000);
    assert.notEqual(calls[0]!.init!.signal, callerCtrl.signal);
    assert.ok(calls[0]!.init!.signal instanceof AbortSignal);
  });

  test("the timeout signal aborts after the deadline (fires regardless)", async () => {
    const calls = captureFetch();
    await fetchWithTimeout("https://example.com/z", {}, 5);
    const signal = calls[0]!.init!.signal!;
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return resolve();
      // The abort timer is unref'd, so hold the event loop open with a ref'd
      // safety timer while we wait for the abort to fire.
      const safety = setTimeout(() => reject(new Error("signal did not abort")), 500);
      signal.addEventListener("abort", () => { clearTimeout(safety); resolve(); }, { once: true });
    });
    assert.equal(signal.aborted, true, "signal aborts once the timeout elapses");
  });

  test("on timeout the fetch rejects with an AbortError, not a TimeoutError", async () => {
    // Pins the B1 contract: youtube.apiGet surfaces the abort message to users,
    // so it must stay "This operation was aborted" (AbortError). AbortSignal.timeout
    // would have produced a TimeoutError with a different, user-visible message.
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        const sig = init!.signal!;
        sig.addEventListener("abort", () => rej(sig.reason), { once: true });
      })) as typeof fetch;
    // fetchWithTimeout's abort timer is unref'd (in production a real hung fetch
    // holds the loop via its socket); under the test runner nothing else keeps
    // the loop alive, so hold it open with a ref'd safety timer past the 5ms deadline.
    const keepAlive = setTimeout(() => {}, 300);
    try {
      await assert.rejects(
        fetchWithTimeout("https://example.com/slow", {}, 5),
        (err: unknown) => {
          const e = err as { name?: string; message?: string };
          assert.equal(e.name, "AbortError", `expected AbortError, got ${e.name}`);
          assert.match(e.message ?? "", /this operation was aborted/i);
          return true;
        },
      );
    } finally {
      clearTimeout(keepAlive);
    }
  });
});
