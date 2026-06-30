/**
 * Client helpers for the profile-modal moderation actions: flagging a
 * gallery image NSFW, editing another user's bio, and the timed account
 * ban (issue / lift / review). All hit mod-gated endpoints, the server
 * enforces the permission; these just shape the requests + responses.
 */

async function readErr(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j?.error) return j.error;
  } catch { /* non-JSON body */ }
  return `Request failed (${res.status})`;
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readErr(res));
}

/* ----------------------------- gallery NSFW ----------------------------- */

/** Build the portrait PATCH endpoint for the moderated profile. Character
 *  galleries route by character id (`edit_others_character`); master
 *  galleries route through `/me/portraits` keyed on the global portrait id
 *  (`edit_others_user`). */
export function portraitModUrl(
  scope: { kind: "character"; characterId: string } | { kind: "master" },
  portraitId: string,
): string {
  return scope.kind === "character"
    ? `/characters/${scope.characterId}/portraits/${portraitId}`
    : `/me/portraits/${portraitId}`;
}

/** Flag / unflag a gallery portrait NSFW (moderator action). */
export async function setPortraitNsfw(
  scope: { kind: "character"; characterId: string } | { kind: "master" },
  portraitId: string,
  nsfw: boolean,
): Promise<void> {
  const res = await fetch(portraitModUrl(scope, portraitId), {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nsfw }),
  });
  if (!res.ok) throw new Error(await readErr(res));
}

/* ------------------------------ mod bio edit ---------------------------- */

/** Save a moderated bio. Character bios go through the existing
 *  `edit_others_character` route; master bios through the new
 *  `edit_others_user` route. */
export async function saveModBio(
  target: { kind: "character"; characterId: string } | { kind: "master"; userId: string },
  bioHtml: string,
): Promise<void> {
  const url = target.kind === "character"
    ? `/characters/${target.characterId}`
    : `/users/${target.userId}/profile`;
  const res = await fetch(url, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bioHtml }),
  });
  if (!res.ok) throw new Error(await readErr(res));
}

/* ------------------------------ account ban ----------------------------- */

export interface ModerationHistoryEntry {
  action: "account_ban" | "account_unban";
  at: number;
  by: string;
  reason: string | null;
  until: number | null;
}

export interface UserModeration {
  ban: {
    bannedAt: number | null;
    bannedUntil: number | null;
    reason: string | null;
    by: string | null;
  } | null;
  history: ModerationHistoryEntry[];
}

/** Fetch a user's current ban status + history. Mod-gated (`ban_account`);
 *  returns null when the viewer lacks the permission (403) so the panel can
 *  quietly hide rather than error. */
export async function fetchUserModeration(userId: string): Promise<UserModeration | null> {
  const res = await fetch(`/users/${userId}/moderation`, { credentials: "include" });
  if (res.status === 403) return null;
  if (!res.ok) throw new Error(await readErr(res));
  return (await res.json()) as UserModeration;
}

/**
 * A "remove their recent posts" window for a ban: a lookback in
 * milliseconds, `"all"` for everything, or `null` to leave posts alone.
 */
export type PurgePosts = number | "all" | null;

/** Issue an account ban. `durationMs: null` = permanent. `purgePosts` opt-in
 *  soft-hides their recent posts at ban time (kept for audit). */
export async function banAccount(
  userId: string,
  durationMs: number | null,
  reason: string,
  purgePosts: PurgePosts = null,
): Promise<void> {
  await postJson(`/users/${userId}/ban`, {
    durationMs,
    reason,
    ...(purgePosts != null ? { purgePosts } : {}),
  });
}

/** Lift an account ban. */
export async function unbanAccount(userId: string): Promise<void> {
  await postJson(`/users/${userId}/unban`, {});
}
