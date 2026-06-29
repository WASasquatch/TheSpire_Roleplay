/**
 * Servers fetch helpers (Multi-Server Lift, Phase 6 — the web rail's data
 * layer). Thin wrappers over the `/servers` endpoints, the deliberate mirror
 * of `lib/forums.ts`. Everything here is a NO-OP surface when the servers
 * feature flag is off: the routes 404 like any disabled feature, so callers
 * only ever invoke these once `branding.serversEnabled` is true.
 *
 * `ServerViewerState` is shared (the server re-checks every permission key);
 * `ServerSummary`/`ServerDetail` are the wire shapes the rail + console
 * consume and are defined here until/unless they earn a home in
 * `@thekeep/shared`.
 */
import type {
  ServerRole,
  ServerStatus,
  ServerVisibility,
  ServerJoinMode,
  ServerViewerState,
} from "@thekeep/shared";

/**
 * One row in `GET /servers`. Mirrors the forum catalog's `ForumSummary`:
 * `viewerRole != null || isSystem` is "owned/joined"; everything else is
 * "discover". `hasUnseen` drives the rail's unseen dot.
 */
export interface ServerSummary {
  id: string;
  slug: string;
  name: string;
  tagline?: string | null;
  /** Square logo/icon image URL. Null ⇒ render the lettered fallback tile. */
  logoUrl?: string | null;
  /** Accent color for the lettered fallback tile + active pill. */
  iconColor?: string | null;
  isSystem: boolean;
  isDefault: boolean;
  status: ServerStatus;
  visibility: ServerVisibility;
  joinMode: ServerJoinMode;
  /** The viewer's role on this server, or null when not a member. */
  viewerRole: ServerRole | null;
  /** Activity the viewer hasn't seen since their last visit. */
  hasUnseen?: boolean;
}

/**
 * Full server dossier behind `GET /servers/:id`. The console + public page
 * read this; the rail only needs `ServerSummary`. Kept intentionally loose
 * here — the owner console (a sibling track's file) narrows what it uses.
 */
export interface ServerDetail extends ServerSummary {
  /** Landing room the rail joins on icon-click. Null ⇒ resolve via /visit. */
  landingRoomId?: string | null;
  rulesHtml?: string | null;
  welcomeHtml?: string | null;
  themeJson?: string | null;
  themeStyleKey?: string | null;
  memberCount?: number;
  createdAt?: number;
}

/** Pull `{ error }` out of a non-OK response, falling back to the status. */
async function jsonOrThrow<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!r.ok) throw new Error(j?.error ?? `Request failed (${r.status}).`);
  return j as T;
}

/** The whole catalog the rail renders. owned/joined + discover are split by
 *  the caller (viewerRole != null || isSystem ⇒ owned/joined). */
export async function listServers(): Promise<ServerSummary[]> {
  const r = await fetch("/servers", { credentials: "include" });
  if (!r.ok) throw new Error(`Couldn't load servers (${r.status}).`);
  const j = (await r.json()) as { servers: ServerSummary[] };
  return j.servers;
}

/** Full detail + the viewer's per-server relationship. */
export async function getServer(idOrSlug: string): Promise<{ server: ServerDetail; viewer: ServerViewerState }> {
  const r = await fetch(`/servers/${encodeURIComponent(idOrSlug)}`, { credentials: "include" });
  if (r.status === 404) throw new Error("That server doesn't exist (or was archived).");
  if (!r.ok) throw new Error(`Couldn't load that server (${r.status}).`);
  return (await r.json()) as { server: ServerDetail; viewer: ServerViewerState };
}

/** Apply to create a new server (gated on the global `apply_create_server`).
 *  Returns the created application id so the caller can poll its status. */
export async function applyForServer(input: {
  requestedName: string;
  requestedSlug: string;
  purpose: string;
}): Promise<{ id: string }> {
  const r = await fetch("/servers/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  const j = await jsonOrThrow<{ application: { id: string } }>(r);
  return j.application;
}

/** Join a server (open join, or enqueue an application when join-gated). The
 *  caller resolves the landing room afterward via {@link visitServer}. */
export async function joinServer(id: string): Promise<void> {
  const r = await fetch(`/servers/${encodeURIComponent(id)}/join`, {
    method: "POST",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

/** Leave a server (no-op / refused for the undeletable system server). */
export async function leaveServer(id: string): Promise<void> {
  const r = await fetch(`/servers/${encodeURIComponent(id)}/leave`, {
    method: "POST",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

/**
 * "Visit" a server: marks it seen (clears the unseen dot) and resolves the
 * room the rail should drop the viewer into — the server's landing/default
 * room. The rail joins that room over the existing socket room-join path.
 */
export async function visitServer(id: string): Promise<{ landingRoomId: string | null }> {
  const r = await fetch(`/servers/${encodeURIComponent(id)}/visit`, {
    method: "POST",
    credentials: "include",
  });
  return jsonOrThrow<{ landingRoomId: string | null }>(r);
}
