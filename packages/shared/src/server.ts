/**
 * Servers — user-owned chat communities (see plan.md, "Multi-Server Lift").
 *
 * Vocabulary (one term per concept, used in code, routes, and UI):
 *   - Server:  the tenant container (name, slug, theme, banner, settings). New
 *              top-level entity, `servers` table. The existing chat is the
 *              undeletable default server (`server_spire_system`, isSystem).
 *   - Room:    a chat room INSIDE a server (`rooms.serverId` set). Rooms reuse
 *              all existing room/presence/message machinery.
 *   - Forum:   an INNER sub-container of a server (a forum belongs to a server
 *              via `forums.serverId`); its boards are server rooms too.
 *
 * The mental model: server is the OUTER container, forum is an INNER
 * sub-container, room is the leaf.
 *
 * This module is the **per-server permission registry** — the deliberate
 * mirror of `forum.ts`. Its keys live HERE, never in the global
 * `PERMISSION_KEYS` catalog (`permissions.ts`): a separate registry is what
 * stops a server owner from gaining power on every OTHER server. The server
 * routes resolve them via `serverAuthority(db, user, serverId)`; the client
 * mirrors the resolved set on {@link ServerViewerState} purely to show/hide
 * controls. The four PLATFORM-level keys (apply_create_server,
 * review_server_applications, manage_any_server, view_admin_servers) are the
 * forum-quartet analogs and DO live in the global catalog — they are not in
 * this file.
 *
 * Wire types here are shared by the server routes, the Server Rail, the admin
 * Servers tab, and the public `/s/<slug>` page.
 */

/** Server-level role held in `server_members`. Owner is the approved
 *  applicant (or the platform admin, for the default server); `admin` is the
 *  trusted-lieutenant tier (a mod implicitly holding the FULL
 *  {@link ServerModPermission} set); `mod` holds an owner-picked granular
 *  subset; `member` holds none. Servers add the `admin` tier above `mod`
 *  that forums lack. */
export type ServerRole = "owner" | "admin" | "mod" | "member";

/* ============================================================
 * Granular moderator permissions
 *
 * A server mod no longer has a fixed power set — the owner grants each mod an
 * explicit subset of these keys (stored as `server_members.permissions_json`).
 * The server OWNER (and platform staff with `manage_any_server`) implicitly
 * hold ALL of them; a server `admin` (the lieutenant tier) ALSO implicitly
 * holds all of them. A plain `member` holds none. The server is the source of
 * truth and re-checks every key; the client mirrors the set (on
 * ServerViewerState) only to show/hide controls.
 *
 * These names are deliberately SERVER-scoped and distinct from the global
 * PERMISSION_KEYS (e.g. `kick_member`, not `kick_user`; `manage_rooms`,
 * not `edit_any_room_metadata`) so the two registries can never be confused
 * and a grant on one can never be mistaken for the other.
 *
 * Invariant preserved from the forum model: a mod can never act on content
 * authored by the server OWNER (delete/edit), even with the matching grant —
 * that's enforced server-side regardless of the grant.
 * ============================================================ */
export const SERVER_MOD_PERMISSIONS = [
  "manage_rooms",            // create / edit / delete this server's rooms; set the landing room
  "manage_members",          // promote members to mod/admin, remove members
  "manage_usergroups",       // create/edit usergroups + assign members
  "manage_appearance",       // server name / icon / banner / theme / rules / welcome
  "manage_announcements",    // banner + scheduled (cron) announcements for this server
  "manage_emoticons",        // this server's emoticon catalog + submission review
  "manage_faqs",             // this server's FAQ entries
  "manage_commands",         // this server's custom !cmd commands + social-game config
  "manage_titles",           // this server's mutual-title kinds catalog
  "manage_reports",          // view + resolve this server's message report queue
  "manage_mod_cases",        // create / edit / resolve this server's moderation cases
  "view_mod_log",            // read this server's Mod Log (the server-scoped audit feed)
  "manage_earning",          // this server's faucet/sinks + grant/revoke + cosmetic claw-back
  "manage_applications",     // approve / reject membership applications
  "manage_invites",          // mint / revoke invite codes (invite_only servers)
  "kick_member",             // eject a member from a room (NOT a platform force-logout)
  "ban_member",              // ban a user from this server
  "unban_member",            // lift a server ban
  "mute_member",             // silence a member in a room for a duration
  "unmute_member",           // lift a mute
  "delete_others_message",   // soft-delete other members' messages (never the owner's)
  "edit_others_message",     // edit other members' messages (never the owner's)
  "view_deleted_post_body",  // read the original body of soft-deleted messages
] as const;

export type ServerModPermission = (typeof SERVER_MOD_PERMISSIONS)[number];

/** UI copy for each grantable permission (Server Settings Roles tab checkboxes). */
export const SERVER_MOD_PERMISSION_META: Record<
  ServerModPermission,
  { label: string; description: string }
> = {
  manage_rooms: { label: "Manage rooms", description: "Create, edit, and delete this server's rooms, and set the landing room." },
  manage_members: { label: "Manage members", description: "Promote members to moderator or admin, and remove members." },
  manage_usergroups: { label: "Manage usergroups", description: "Create and edit usergroups and assign members to them." },
  manage_appearance: { label: "Manage appearance", description: "Edit the server name, icon, banner, theme, house rules, and welcome." },
  manage_announcements: { label: "Manage announcements", description: "Create the rotating banner and scheduled announcements for this server." },
  manage_emoticons: { label: "Manage emoticons", description: "Curate this server's emoticon catalog and review submissions." },
  manage_faqs: { label: "Manage FAQs", description: "Create, edit, and delete this server's FAQ entries." },
  manage_commands: { label: "Manage commands", description: "Create, edit, and delete this server's custom commands and social-game config." },
  manage_titles: { label: "Manage titles", description: "Manage this server's mutual-title kinds catalog." },
  manage_reports: { label: "Handle reports", description: "See and resolve this server's reported messages." },
  manage_mod_cases: { label: "Manage mod cases", description: "Create, edit, and resolve entries in this server's moderation case log." },
  view_mod_log: { label: "View Mod Log", description: "Read this server's Mod Log (the server-scoped audit feed)." },
  manage_earning: { label: "Manage earning", description: "Tune this server's earning faucet and sinks, and grant, revoke, or claw back awards." },
  manage_applications: { label: "Review applications", description: "Approve or reject membership applications." },
  manage_invites: { label: "Manage invites", description: "Mint and revoke invite codes (for invite-only servers)." },
  kick_member: { label: "Kick members", description: "Eject a member from a room (does not log them out of the platform)." },
  ban_member: { label: "Ban members", description: "Ban a user from this server." },
  unban_member: { label: "Unban members", description: "Lift a ban on a user in this server." },
  mute_member: { label: "Mute members", description: "Silence a member in a room for a duration." },
  unmute_member: { label: "Unmute members", description: "Lift a mute on a member." },
  delete_others_message: { label: "Delete messages", description: "Soft-delete other members' messages (never the owner's)." },
  edit_others_message: { label: "Edit messages", description: "Edit other members' messages (never the owner's)." },
  view_deleted_post_body: { label: "View deleted message bodies", description: "Read the original body of soft-deleted messages." },
};

/* ============================================================
 * Member-FEATURE permissions (the second half of the unified registry).
 *
 * Moderation perms above answer "what may this person police"; feature perms
 * answer "what may this person DO". Both live in one registry
 * (SERVER_PERMISSIONS) so a usergroup can grant any of them. Feature perms are
 * the baseline a server's DEFAULT usergroup starts with
 * (SERVER_FEATURE_PERMISSIONS) so existing members stay fully able — every
 * participant gets them until an owner narrows the default group.
 * ============================================================ */
export const SERVER_FEATURE_PERMISSIONS = [
  "post_messages",  // post in this server's rooms
  "create_rooms",   // open a new room in this server (subject to the per-owner cap)
  "upload_images",  // embed images in a message
  "use_emoticons",  // use this server's emoticon catalog in messages
  "send_invites",   // share a join link / invite others (subject to join mode)
] as const;

export type ServerFeaturePermission = (typeof SERVER_FEATURE_PERMISSIONS)[number];

export const SERVER_FEATURE_PERMISSION_META: Record<
  ServerFeaturePermission,
  { label: string; description: string }
> = {
  post_messages: { label: "Post messages", description: "Send messages in this server's rooms." },
  create_rooms: { label: "Create rooms", description: "Open a new room in this server (up to the per-owner cap)." },
  upload_images: { label: "Embed images", description: "Put images in a message." },
  use_emoticons: { label: "Use emoticons", description: "Use this server's emoticon catalog in messages." },
  send_invites: { label: "Invite others", description: "Share a join link to bring people into this server." },
};

/** The full unified permission registry: moderation + member features. A
 *  usergroup may grant ANY of these; a member's effective set is the union of
 *  their groups (+ default group + any direct mod grant). */
export const SERVER_PERMISSIONS = [
  ...SERVER_MOD_PERMISSIONS,
  ...SERVER_FEATURE_PERMISSIONS,
] as const;

export type ServerPermission = ServerModPermission | ServerFeaturePermission;

/** UI copy for every permission, both halves of the registry. */
export const SERVER_PERMISSION_META: Record<ServerPermission, { label: string; description: string }> = {
  ...SERVER_MOD_PERMISSION_META,
  ...SERVER_FEATURE_PERMISSION_META,
};

/** Which half a permission belongs to, for grouping the checkbox grid. */
export function serverPermissionCategory(key: ServerPermission): "moderation" | "feature" {
  return (SERVER_FEATURE_PERMISSIONS as readonly string[]).includes(key) ? "feature" : "moderation";
}

export function isServerPermission(s: string): s is ServerPermission {
  return (SERVER_PERMISSIONS as readonly string[]).includes(s);
}

/** Tolerant parse of a stored permission array (groups + direct grants). */
export function parseServerPermissions(json: string | null | undefined): ServerPermission[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    const out = new Set<ServerPermission>();
    for (const v of arr) if (typeof v === "string" && isServerPermission(v)) out.add(v);
    return [...out];
  } catch {
    return [];
  }
}

/** Canonical (sorted) serialization so equal sets compare equal in storage. */
export function serializeServerPermissions(perms: readonly ServerPermission[]): string {
  return JSON.stringify([...new Set(perms)].filter(isServerPermission).sort());
}

export function isServerModPermission(s: string): s is ServerModPermission {
  return (SERVER_MOD_PERMISSIONS as readonly string[]).includes(s);
}

/** Parse a stored `permissions_json` string into a clean, de-duped set of
 *  valid keys. Tolerant: bad JSON / unknown keys are dropped, never thrown.
 *  Used by the server (authority) and any client that reads the raw row. */
export function parseServerModPermissions(json: string | null | undefined): ServerModPermission[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    const out = new Set<ServerModPermission>();
    for (const v of arr) if (typeof v === "string" && isServerModPermission(v)) out.add(v);
    return [...out];
  } catch {
    return [];
  }
}

/** Canonical serialization (sorted) for storage so equal sets compare equal. */
export function serializeServerModPermissions(perms: readonly ServerModPermission[]): string {
  const clean = [...new Set(perms)].filter(isServerModPermission).sort();
  return JSON.stringify(clean);
}

/** The set a freshly-appointed mod gets when the owner doesn't customize —
 *  the everyday "room janitor" powers, minus the sensitive ones (ban,
 *  manage members, manage earning, manage appearance) which the owner must
 *  grant deliberately. The `admin` lieutenant tier ignores this and holds the
 *  full {@link SERVER_MOD_PERMISSIONS} set implicitly. */
export const SERVER_MOD_DEFAULT_PERMISSIONS: ServerModPermission[] = [
  "manage_rooms", "manage_reports", "kick_member", "mute_member", "unmute_member",
  "delete_others_message", "edit_others_message",
];

/* ============================================================
 * Lifecycle enums (membership, status, visibility, applications)
 * ============================================================ */

/** How a user joins: `open` = instant self-join; `application` = reviewed by
 *  the owner/mods; `invite` = only via an `server_invites` code. */
export type ServerJoinMode = "open" | "application" | "invite";

/** `featured` pins to the top of the rail/catalog (admin-curated, like
 *  forums); owners flip between active and archived. */
export type ServerStatus = "active" | "featured" | "archived";

/** Catalog discoverability: `public` is listed and has a public landing;
 *  `unlisted` is reachable by link but not listed; `invite_only` is hidden
 *  and entered solely through an invite code. */
export type ServerVisibility = "public" | "unlisted" | "invite_only";

/** Membership / creation application lifecycle (mirrors forum_applications). */
export type ServerApplicationStatus = "pending" | "approved" | "rejected" | "withdrawn";

/* ============================================================
 * Validation constants (shared by client forms + server Zod)
 * ============================================================ */

/** Slug shape: lowercase letters, digits, underscore. Short enough for a
 *  share URL, long enough for a real name: `/s/shadows_of_darkness`. */
export const SERVER_SLUG_RE = /^[a-z0-9_]{3,40}$/;

/** Slugs that must never become servers — they collide with real routes,
 *  upload paths, or future reserved surfaces. Checked case-insensitively. */
export const RESERVED_SERVER_SLUGS: ReadonlySet<string> = new Set([
  "admin", "api", "auth", "assets", "uploads", "static",
  "s", "f", "p", "w", "u", "profiles", "rooms", "worlds", "forums", "forum",
  "servers", "server", "spire_system", "login", "logout", "register",
  "settings", "help", "terms", "privacy", "rules", "about", "new", "create", "edit",
  // Static segments under /servers/* — a server with one of these slugs
  // would be unreachable behind the same-named API route.
  "applications", "slug_availability", "slug-availability", "mine", "by_slug",
  "membership-applications", "invites", "join", "leave", "transfer",
]);

export const SERVER_NAME_MIN = 3;
export const SERVER_NAME_MAX = 60;
export const SERVER_TAGLINE_MAX = 200;
/** The creation application's "what is your server for" prose. */
export const SERVER_PURPOSE_MIN = 30;
export const SERVER_PURPOSE_MAX = 500;
/** Membership-application answer (free text shown to the owner). */
export const SERVER_MEMBER_ANSWER_MAX = 500;
/** Rooms per server (admin-tunable later; the route enforces this default). */
export const SERVER_MAX_ROOMS_DEFAULT = 50;
/** Owned servers per user (admin-tunable later). */
export const SERVER_MAX_OWNED_DEFAULT = 2;
/** Days an applicant must wait after a rejection before re-applying. */
export const SERVER_REAPPLY_COOLDOWN_DAYS = 7;

/** Normalize + validate a requested slug; returns the canonical lowercase
 *  slug or null when unusable. Shared by the live availability check and
 *  the server's create path so they can never disagree. */
export function normalizeServerSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  if (!SERVER_SLUG_RE.test(slug)) return null;
  if (RESERVED_SERVER_SLUGS.has(slug)) return null;
  return slug;
}

/* ============================================================
 * Viewer state
 * ============================================================ */

/** The caller's relationship to a server — the per-server channel the UI
 *  gates on. This is NEVER merged into `me.permissions` (that stays the
 *  platform-global set); it ships on `GET /servers/:id`, advisory only —
 *  the server re-checks every key via `serverAuthority`. */
export interface ServerViewerState {
  role: ServerRole | null;
  /** Owner-tier control: server owner OR platform staff with
   *  `manage_any_server` OR the `admin` lieutenant role. Shows the
   *  settings gear / owner console. */
  isOwner: boolean;
  /** Holds at least one moderation power (a mod with grants, an admin, or an
   *  owner). Broader than a non-null mod role; owner/admin imply it. */
  isMod: boolean;
  /**
   * Whether the viewer counts as a member for read/post gating. Broader than a
   * non-null `role`: it's also true for the server owner, platform staff with
   * `manage_any_server`, and EVERY signed-in user on the system/default server
   * (implicit membership). UI should gate "join" prompts on this, not on
   * `role`, or an implicit member of the default server gets nagged to join
   * something they already belong to.
   */
  isMember: boolean;
  /** This viewer's effective server permissions — the UNION of the default
   *  usergroup, every group they're in, and any direct mod grant (owner/admin/
   *  staff hold every key, so `isOwner` implies all). Spans the whole registry
   *  (moderation + member features). Client UI gates each control on the
   *  matching key; the server re-checks regardless. */
  permissions: ServerPermission[];
}
