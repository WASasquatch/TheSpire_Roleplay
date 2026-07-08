/**
 * Outbound-fetch timeout scaffolding shared by the server's third-party HTTP
 * clients (googleOauth, youtube, unfurl). Wraps `fetch` with a bare
 * `AbortController` + `setTimeout(() => abort(), ms)`, byte-for-byte matching
 * the old hand-rolled scaffolds each caller had.
 *
 * Two properties matter and are both preserved:
 *   1. The deadline stays live through BODY consumption. We deliberately do NOT
 *      clear the timer when this function returns — the caller reads the
 *      response body AFTER we hand back the Response, and the old code only
 *      cleared its timer in a `finally` that ran after that read. On a
 *      successful completion the timer later fires against an already-settled
 *      request, a harmless no-op (and it's `unref`'d so it never holds the
 *      event loop / process open).
 *   2. The abort error is a plain `AbortError` ("This operation was aborted"),
 *      NOT the `TimeoutError` ("...aborted due to timeout") that
 *      `AbortSignal.timeout` produces. `youtube.apiGet` surfaces the abort
 *      message to users via the /theater error notice, so the message must not
 *      change.
 *
 * Callers keep their own timeout constants and their own catch/return shapes;
 * only this scaffolding is shared.
 */
export function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Non-blocking: on a fast success the uncleared timer must not delay exit.
  timer.unref?.();
  return fetch(url, { ...init, signal: controller.signal });
}
