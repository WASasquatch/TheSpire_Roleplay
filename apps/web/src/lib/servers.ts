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
  AvatarCrop,
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
  /** Owner-set accent ring around the rail icon — shows even on logo tiles. */
  borderColor?: string | null;
  /** Pan/zoom focus for the square icon image (AvatarCrop). Null ⇒ centered. */
  iconCrop?: AvatarCrop | null;
  /** Header banner image URL — used to rebrand the chat shell's top bar while
   *  the viewer is inside this server. Null ⇒ no image banner. */
  bannerImageUrl?: string | null;
  /** CSS `background` shorthand for the header banner (admin/owner-set). Takes
   *  precedence over {@link bannerImageUrl} when both are present. */
  bannerCoverCss?: string | null;
  /** Vertical focus (0-100%) for the banner image's `background-position`
   *  (legacy single-axis; {@link bannerCrop} supersedes it for new positioning). */
  bannerFocusY?: number | null;
  /** Pan/zoom focus for the banner image (AvatarCrop). Null ⇒ centered. */
  bannerCrop?: AvatarCrop | null;
  /** Owner-set top-bar banner height in px. Null ⇒ default responsive height. */
  bannerHeight?: number | null;
  /** Wide wordmark logo that replaces the app logo in the top bar inside this
   *  server (distinct from {@link logoUrl}, the square rail icon). */
  horizontalLogoUrl?: string | null;
  isSystem: boolean;
  isDefault: boolean;
  status: ServerStatus;
  visibility: ServerVisibility;
  joinMode: ServerJoinMode;
  /** Owner-set genre/category tags for discovery search (normalizeTags). The
   *  backend always returns this (`[]` when none), so it is required here — the
   *  discover modal renders chips/filters off it. */
  tags: string[];
  /** The viewer's role on this server, or null when not a member. */
  viewerRole: ServerRole | null;
  /** True when this is the viewer's chosen favorite/default server
   *  (users.default_server_id) — the rail/discover marks it and a global
   *  profile view of the viewer renders its per-server identity. */
  isMyDefault?: boolean;
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

/** The Discover landing payload: two curated lists the modal renders side by
 *  side in its default (no query, no tag) view. Both are PUBLIC servers the
 *  viewer can browse to. Empty arrays when the catalog is bare. */
export interface ServerDiscover {
  popular: ServerSummary[];
  new: ServerSummary[];
}

/** GET /servers/discover — the curated Popular / New lists for the default
 *  browse view. Throws on transport/permission failure so the caller can show
 *  its error state (the modal already has one). */
export async function fetchServerDiscover(): Promise<ServerDiscover> {
  const r = await fetch("/servers/discover", { credentials: "include" });
  if (!r.ok) throw new Error(`Couldn't load the server catalog (${r.status}).`);
  const j = (await r.json()) as { popular?: ServerSummary[]; new?: ServerSummary[] };
  return { popular: j.popular ?? [], new: j.new ?? [] };
}

/** GET /servers/discover/search — name/tag search. `q` is the free-text query
 *  (matched against name + tags server-side); `tag` is an optional exact-tag
 *  filter from the chip row. Returns the flat result list (`.items`). Treats a
 *  transport error as "no matches" so the search view degrades to its empty
 *  state instead of crashing. */
export async function searchServers(q: string, tag: string | null): Promise<ServerSummary[]> {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (tag) params.set("tag", tag);
  const r = await fetch(`/servers/discover/search?${params.toString()}`, { credentials: "include" });
  if (!r.ok) return [];
  const j = (await r.json()) as { items?: ServerSummary[] };
  return j.items ?? [];
}

/** A tag and how many discoverable servers carry it — powers the chip row
 *  (rendered most-used first by the caller). */
export interface ServerTagCount {
  tag: string;
  count: number;
}

/** GET /servers/tags — the tag cloud for the chip row. Treats a transport
 *  error as "no tags" so the chip row simply doesn't render. */
export async function fetchServerTags(): Promise<ServerTagCount[]> {
  const r = await fetch("/servers/tags", { credentials: "include" });
  if (!r.ok) return [];
  const j = (await r.json()) as { tags?: ServerTagCount[] };
  return j.tags ?? [];
}

/** GET /api/registration-rules?kind=server — the admin-authored rules a
 *  create-a-server applicant must agree to. Returns the raw HTML (empty string
 *  ⇒ no rules set, so the form shows no rules block / checkbox). Treats a
 *  transport error as "no rules" so a blip never blocks the application. */
export async function fetchServerRegistrationRules(): Promise<string> {
  const r = await fetch("/api/registration-rules?kind=server", { credentials: "include" });
  if (!r.ok) return "";
  const j = (await r.json()) as { html?: string };
  return j.html ?? "";
}

/** Full detail + the viewer's per-server relationship. */
export async function getServer(idOrSlug: string): Promise<{ server: ServerDetail; viewer: ServerViewerState }> {
  const r = await fetch(`/servers/${encodeURIComponent(idOrSlug)}`, { credentials: "include" });
  if (r.status === 404) throw new Error("That server doesn't exist (or was archived).");
  if (!r.ok) throw new Error(`Couldn't load that server (${r.status}).`);
  return (await r.json()) as { server: ServerDetail; viewer: ServerViewerState };
}

/** Apply to create a new server (gated on the global `apply_create_server`).
 *  Returns the created application id so the caller can poll its status.
 *  `agreedToRules` is the registration-rules acknowledgement — the backend
 *  REQUIRES it true whenever admin-authored server registration rules are set,
 *  and ignores it otherwise. */
export async function applyForServer(input: {
  requestedName: string;
  requestedSlug: string;
  purpose: string;
  agreedToRules?: boolean;
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

/** Join an OPEN server instantly, or an INVITE-mode server by passing the
 *  invite `code` (mirrors room-invite redemption). Application-mode servers go
 *  through {@link applyToJoinServer} instead. The caller resolves the landing
 *  room afterward via {@link visitServer}. */
export async function joinServer(id: string, code?: string): Promise<void> {
  const r = await fetch(`/servers/${encodeURIComponent(id)}/join`, {
    method: "POST",
    credentials: "include",
    ...(code
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }
      : {}),
  });
  await jsonOrThrow(r);
}

/** Apply to join an APPLICATION-mode server. `answer` is the optional prose the
 *  server's reviewers read. Resolves once the application is enqueued. */
export async function applyToJoinServer(id: string, answer?: string): Promise<void> {
  const r = await fetch(`/servers/${encodeURIComponent(id)}/membership-applications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(answer?.trim() ? { answer: answer.trim() } : {}),
  });
  await jsonOrThrow(r);
}

/** Live slug-availability result for the create-a-server form. `reason`
 *  distinguishes already-taken vs claimed-by-a-pending-application vs a
 *  reserved word vs a bad format, so the form can phrase the hint. */
export type ServerSlugCheck = { ok: true } | { ok: false; reason: string };

/** Debounced availability probe used by the create form (GET
 *  /servers/slug-availability). Treats a transport error as "unknown" (ok:false
 *  with a format reason) so the form never claims a bad slug is free. */
export async function checkServerSlug(slug: string): Promise<ServerSlugCheck> {
  const r = await fetch(`/servers/slug-availability?slug=${encodeURIComponent(slug)}`, {
    credentials: "include",
  });
  if (!r.ok) return { ok: false, reason: "format" };
  return (await r.json()) as ServerSlugCheck;
}

/** One of the viewer's own "create a server" applications (GET
 *  /servers/applications/mine). Mirrors the forum creation-application wire. */
export interface ServerCreationApplicationWire {
  id: string;
  requestedName: string;
  requestedSlug: string;
  purpose: string;
  status: "pending" | "approved" | "rejected";
  submittedAt: number;
  reviewedAt: number | null;
  reviewedByUsername: string | null;
  reviewNote: string | null;
}

/** The viewer's recent create-a-server applications (newest first). */
export async function fetchMyServerApplications(): Promise<ServerCreationApplicationWire[]> {
  const r = await fetch("/servers/applications/mine", { credentials: "include" });
  if (!r.ok) throw new Error(`Couldn't load your applications (${r.status}).`);
  const j = (await r.json()) as { applications: ServerCreationApplicationWire[] };
  return j.applications;
}

/**
 * What the create-a-server CTA needs to know, derived from
 * {@link fetchMyServerApplications}: the single in-flight `pending`
 * application (the backend allows only one at a time, so its presence
 * suppresses re-applying) and the most recent `rejected` one (whose
 * `reviewNote` we surface so the viewer can fix it and re-apply). A pending
 * application always wins — a stale rejection behind it isn't actionable.
 */
export interface ServerApplicationStatus {
  pending: ServerCreationApplicationWire | null;
  /** Newest rejection, only when nothing is pending (else `null`). */
  rejected: ServerCreationApplicationWire | null;
}

/** Resolve the viewer's create-a-server status (pending / most-recent
 *  rejection) for the discover modal's CTA. Treats a transport error as
 *  "nothing in flight" so the CTA stays usable rather than wedged. */
export async function fetchMyServerApplicationStatus(): Promise<ServerApplicationStatus> {
  const apps = await fetchMyServerApplications().catch(() => [] as ServerCreationApplicationWire[]);
  return {
    pending: apps.find((a) => a.status === "pending") ?? null,
    rejected: apps.find((a) => a.status === "pending") ? null : apps.find((a) => a.status === "rejected") ?? null,
  };
}

/** Upload (or clear, with null) the server's round icon or header banner. Body
 *  is a base64 data URL — magic-byte checked + content-hashed server-side,
 *  served from /uploads/servers/. Mirrors {@link setForumImage}. Returns the
 *  new URL (null when cleared). Gated on the server's `manage_appearance`. */
export async function setServerImage(
  serverId: string,
  kind: "logo" | "banner",
  imageDataUrl: string | null,
): Promise<string | null> {
  const r = await fetch(`/servers/${encodeURIComponent(serverId)}/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(imageDataUrl ? { imageDataUrl } : { clear: true }),
  });
  const j = await jsonOrThrow<{ url: string | null }>(r);
  return j.url;
}

/** Read a picked file as a data URL with a client-side size guard (the server
 *  re-checks; this just fails fast before shipping megabytes). Mirrors the
 *  forum helper of the same name. */
export function readServerImageFile(file: File, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > maxBytes) {
      reject(new Error(`Image too large (max ${Math.round(maxBytes / 1024)}KB).`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

/** Mark a server as the caller's favorite/default (users.default_server_id) —
 *  the server whose per-server identity a global profile view of the caller
 *  reflects. Must be a server the caller belongs to (server re-checks). */
export async function setServerDefault(id: string): Promise<void> {
  const r = await fetch(`/servers/${encodeURIComponent(id)}/favorite`, {
    method: "POST",
    credentials: "include",
  });
  await jsonOrThrow(r);
}

/** Clear the caller's favorite/default server back to NULL — the profile then
 *  falls back to the system server. */
export async function clearServerDefault(id: string): Promise<void> {
  const r = await fetch(`/servers/${encodeURIComponent(id)}/favorite`, {
    method: "DELETE",
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

/**
 * Resolve a `/s/<slug>` share link to a server the viewer may open, or `null`
 * when it doesn't exist / is private to them (the server 404s those to keep a
 * private server's existence undisclosed). Backs the SPA's `/s/:slug`
 * deep-link.
 */
export async function resolveServerSlug(slug: string): Promise<{ id: string; name: string } | null> {
  const r = await fetch(`/servers/by-slug/${encodeURIComponent(slug)}`, { credentials: "include" });
  if (!r.ok) return null;
  return (await r.json()) as { id: string; name: string };
}
