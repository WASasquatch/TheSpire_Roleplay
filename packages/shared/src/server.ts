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
  "manage_events",           // create / edit / cancel this server's scheduled events
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
  manage_events: { label: "Manage events", description: "Create, edit, and cancel this server's scheduled events." },
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

export function isServerFeaturePermission(s: string): s is ServerFeaturePermission {
  return (SERVER_FEATURE_PERMISSIONS as readonly string[]).includes(s);
}

/** Parse a stored usergroup `permissions_json`, keeping ONLY member-feature
 *  keys. Moderation keys are dropped — a usergroup grants features, never
 *  moderation power (that's the role tier's job). Tolerant of bad JSON. */
export function parseServerFeaturePermissions(json: string | null | undefined): ServerFeaturePermission[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    const out = new Set<ServerFeaturePermission>();
    for (const v of arr) if (typeof v === "string" && isServerFeaturePermission(v)) out.add(v);
    return [...out];
  } catch {
    return [];
  }
}

/** Canonical (sorted) serialization of a feature-only set for usergroup storage. */
export function serializeServerFeaturePermissions(perms: readonly ServerFeaturePermission[]): string {
  const clean = [...new Set(perms)].filter(isServerFeaturePermission).sort();
  return JSON.stringify(clean);
}

/** The set a freshly-appointed mod gets when the owner doesn't customize —
 *  the everyday "room janitor" powers, minus the sensitive ones (ban,
 *  manage members, manage earning, manage appearance) which the owner must
 *  grant deliberately. A `mod` is a CHAT MODERATOR by default; broader
 *  management is the `admin` tier's job. */
export const SERVER_MOD_DEFAULT_PERMISSIONS: ServerModPermission[] = [
  "manage_rooms", "manage_reports", "kick_member", "mute_member", "unmute_member",
  "delete_others_message", "edit_others_message",
];

/** The `admin` lieutenant tier's implicit power set: EVERY moderation key
 *  EXCEPT `manage_appearance`. An admin runs the community day-to-day —
 *  members, rooms, usergroups, earning, announcements, emoticons, FAQs,
 *  commands, titles, reports, mod cases, invites, applications, bans/mutes,
 *  message moderation, the mod log — but may NOT change the server's
 *  appearance / name / theme / rules / settings, and (structurally, never via
 *  a permission key) may not transfer or delete the server. Those last acts
 *  stay with the OWNER (and platform staff holding `manage_any_server`).
 *
 *  Defined as an explicit list (not "all mod perms") so the owner-only
 *  boundary lives in one auditable place; `serverAuthority` grants this to
 *  the `admin` role. */
export const SERVER_ADMIN_DEFAULT_PERMISSIONS: ServerModPermission[] =
  SERVER_MOD_PERMISSIONS.filter((k) => k !== "manage_appearance") as ServerModPermission[];

/** The owner-only powers no `admin` or `mod` can hold via the role tier — the
 *  settings/appearance surface plus the existential acts. Used to label the
 *  Roles UI and to assert the boundary in tests. `manage_appearance` is the
 *  only *permission key* in here; transfer/delete are gated structurally
 *  (owner-only routes), not by a grantable key. */
export const SERVER_OWNER_ONLY_PERMISSIONS: ServerModPermission[] = ["manage_appearance"];

/** The moderation keys an owner/admin may actually grant to a mod — the full
 *  mod registry minus the owner-only keys. The Roles grid renders these, and
 *  the role/permission routes clamp grants to this set, so a mod can never be
 *  handed `manage_appearance` (appearance stays owner-only). Identical in
 *  membership to {@link SERVER_ADMIN_DEFAULT_PERMISSIONS} today, but kept as a
 *  distinct name because they answer different questions (what a mod may be
 *  granted vs what an admin holds by default). */
export const SERVER_GRANTABLE_MOD_PERMISSIONS: ServerModPermission[] =
  SERVER_MOD_PERMISSIONS.filter((k) => !(SERVER_OWNER_ONLY_PERMISSIONS as readonly string[]).includes(k)) as ServerModPermission[];

/** Is this a moderation key an owner may grant to a mod (i.e. not owner-only)? */
export function isGrantableServerModPermission(s: string): s is ServerModPermission {
  return (SERVER_GRANTABLE_MOD_PERMISSIONS as readonly string[]).includes(s);
}

/* ============================================================
 * Usergroups (member-feature bundles + auto-join rules)
 *
 * A usergroup is a NAMED, color-coded bundle of MEMBER-FEATURE permissions
 * (plus an identity color) applied to ordinary members — the deliberate
 * mirror of forum usergroups. Every participant is in the implicit DEFAULT
 * group (the member baseline); named groups layer extra feature perks +
 * identity on top, via manual rosters or earned auto-rules.
 *
 * Roles vs usergroups are kept DISTINCT: a usergroup grants member FEATURES,
 * never moderation power. Moderation authority comes only from the role tier
 * (owner/admin/mod) + a mod's direct grant. The server clamps a usergroup's
 * grant to {@link SERVER_FEATURE_PERMISSIONS} so a group can never silently
 * mint a moderator.
 * ============================================================ */

export const SERVER_USERGROUP_NAME_MAX = 40;
export const SERVER_MAX_USERGROUPS = 25;
/** Cap on auto-join rules per group (keeps the on-post evaluation cheap). */
export const SERVER_MAX_AUTO_RULES = 6;

/** One auto-join rule. A member joins a group when they satisfy EVERY rule on
 *  it (AND). Evaluated lazily when a member posts in the server. The server
 *  analogs of the forum rule kinds: messages-in-server (post_count),
 *  posted-in-room (posted_in_category), account age, and server-member age. */
export type ServerAutoRule =
  | { kind: "message_count"; min: number }        // total messages sent in this server's rooms
  | { kind: "posted_in_room"; roomId: string }    // has a message in this room
  | { kind: "account_age_days"; min: number }     // account age
  | { kind: "member_age_days"; min: number };     // time since joining this server

export type ServerAutoRuleKind = ServerAutoRule["kind"];

/** UI copy for each auto-rule kind. */
export const SERVER_AUTO_RULE_META: Record<ServerAutoRuleKind, { label: string; unit: string | null }> = {
  message_count: { label: "Message count at least", unit: "messages" },
  posted_in_room: { label: "Has posted in room", unit: null },
  account_age_days: { label: "Account age at least", unit: "days" },
  member_age_days: { label: "Server member for at least", unit: "days" },
};

/** Tolerant parse of a stored `auto_rules_json`. Drops malformed entries. */
export function parseServerAutoRules(json: string | null | undefined): ServerAutoRule[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    const out: ServerAutoRule[] = [];
    for (const r of arr) {
      if (out.length >= SERVER_MAX_AUTO_RULES) break;
      if (!r || typeof r.kind !== "string") continue;
      if (r.kind === "posted_in_room") {
        if (typeof r.roomId === "string" && r.roomId) out.push({ kind: "posted_in_room", roomId: r.roomId });
      } else if (
        (r.kind === "message_count" || r.kind === "account_age_days" || r.kind === "member_age_days") &&
        typeof r.min === "number" && Number.isFinite(r.min) && r.min >= 1
      ) {
        // Floor of 1: a `min: 0` threshold matches everyone who posts (it's
        // always true), which would silently auto-grant the group to the whole
        // active membership the moment they speak.
        out.push({ kind: r.kind, min: Math.floor(r.min) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeServerAutoRules(rules: readonly ServerAutoRule[]): string {
  return JSON.stringify(rules);
}

/** One usergroup as shown in the owner's Usergroups settings tab. */
export interface ServerUsergroupWire {
  id: string;
  name: string;
  color: string | null;
  /** Member-FEATURE permissions only (the server clamps to this half). */
  permissions: ServerFeaturePermission[];
  /** The implicit baseline group (every participant); not manually joinable. */
  isDefault: boolean;
  sortOrder: number;
  autoRules: ServerAutoRule[];
  /** Explicit members (manual + auto). The default group reports 0 — its
   *  membership is everyone, so it isn't enumerated. */
  memberCount: number;
  /**
   * Self-role toggle (migration 0320). When true a member may add/remove
   * themselves from this group without a manager. Default false.
   */
  memberSelectable: boolean;
  /** Member-facing blurb shown next to the self-role toggle / onboarding option (migration 0320). Null = none. */
  description: string | null;
}

/** One explicit member row in a group's roster (GET .../usergroups/:gid/members). */
export interface ServerUsergroupMemberWire {
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** True = earned via auto-rules; false = added by a manager. */
  isAuto: boolean;
  addedAt: number;
}

/** A staff row in the Roles tab (owner / admin / mod), with the mod's direct
 *  grant resolved for the checkbox grid. */
export interface ServerStaffEntry {
  userId: string;
  username: string;
  avatarUrl: string | null;
  role: ServerRole;
  /** The mod's direct granular grant (empty for owner/admin — they're preset). */
  permissions: ServerModPermission[];
  joinedAt: number;
}

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

/** Slug shape: lowercase letters, digits, hyphens — the URL-standard slug, so
 *  it reads as the chat's name: `/s/the-spire`, `/s/shadows-of-darkness`. */
export const SERVER_SLUG_RE = /^[a-z0-9-]{3,40}$/;

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
  /** Owner-tier control: ONLY the server owner OR platform staff with
   *  `manage_any_server`. The `admin` lieutenant is NOT owner-tier — it can't
   *  change the server's appearance/settings, transfer, or delete. Gate
   *  owner-only acts (transfer, appoint/remove admin, appearance) on this. */
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
