/**
 * Pull a human-readable error message out of a non-OK Response. The server
 * returns either `{ error: "..." }` or `{ message: "..." }` depending on
 * the route — older routes use `error`, zod-validation routes use
 * `message`. Falls back to `<status> <statusText>` when the body isn't
 * JSON or doesn't carry either field.
 *
 * Single source of truth — without this, six components each rolled their
 * own copy and any future server-side change to the error shape would
 * have to land in all of them.
 */
export async function readError(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: string; message?: string };
    return j.error ?? j.message ?? `${r.status} ${r.statusText}`;
  } catch {
    return `${r.status} ${r.statusText}`;
  }
}
