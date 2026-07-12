import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, UsersRound } from "lucide-react";
import { parseRoleSelectBody, type ChatMessage, type RoleSelectState } from "@thekeep/shared";
import { safeCssColor } from "../shared/RoleBadgeChips.js";

/**
 * Renders a `/roleselect` panel: a permanent, interactive role picker
 * (Discord reaction-roles style). One clickable row per `{role:…}` token
 * line in the message body; clicking toggles the viewer's own membership
 * through the existing self-role endpoints (PUT/DELETE
 * /servers/:id/self-roles/:gid — server membership + member-selectable
 * gates apply there, never here). Rows whose group has no hydrated entry
 * (deleted, or no longer self-assignable) render as plain text — never
 * clickable. Card chrome mirrors the PollCard so interactive blocks read
 * as one family.
 */

async function toggleSelfRole(serverId: string, groupId: string, join: boolean): Promise<boolean> {
  const r = await fetch(
    `/servers/${encodeURIComponent(serverId)}/self-roles/${encodeURIComponent(groupId)}`,
    { method: join ? "PUT" : "DELETE", credentials: "include" },
  );
  const j = (await r.json().catch(() => null)) as { error?: string; member?: boolean } | null;
  // Only surface the server body when it is a real localized sentence (the
  // 404 "not self-assignable" copy). The gate failures return the bare
  // token "forbidden" — an empty message here falls back to the translated
  // roleSelect.toggleFailed copy in the caller.
  if (!r.ok) throw new Error(j?.error && j.error !== "forbidden" ? j.error : "");
  return !!j?.member;
}

export function RoleSelectCard({ message, roleSelect, compact }: {
  message: ChatMessage;
  roleSelect: RoleSelectState;
  /** Tighter paddings for chat lines (mirrors PollCard's compact). */
  compact?: boolean;
}) {
  const { t } = useTranslation("chat");
  const tokens = useMemo(() => parseRoleSelectBody(message.body), [message.body]);
  const byId = useMemo(
    () => new Map(roleSelect.roles.map((r) => [r.usergroupId, r])),
    [roleSelect.roles],
  );
  // Local membership overrides on top of the hydrated state: seeded from the
  // server per-viewer on backlog, reconciled from each toggle's honest
  // `member` response (a sticky auto-earned role survives a "remove" —
  // mirror what the server says, not what was clicked).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => { setOverrides({}); }, [roleSelect]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(groupId: string, currentlyMember: boolean) {
    if (busyId) return;
    setBusyId(groupId);
    setErr(null);
    setOverrides((o) => ({ ...o, [groupId]: !currentlyMember })); // optimistic
    try {
      const member = await toggleSelfRole(roleSelect.serverId, groupId, !currentlyMember);
      setOverrides((o) => ({ ...o, [groupId]: member }));
    } catch (e) {
      setOverrides((o) => ({ ...o, [groupId]: currentlyMember })); // rollback
      const msg = e instanceof Error && e.message ? e.message : t("roleSelect.toggleFailed");
      setErr(msg);
    } finally {
      setBusyId(null);
    }
  }

  const pad = compact ? "p-2.5" : "p-3.5";

  return (
    <div
      className={`rounded-lg border border-keep-accent/40 bg-keep-panel/40 ${pad}`}
      role="group"
      aria-label={t("roleSelect.ariaLabel")}
    >
      <div className="mb-2 flex items-start gap-2">
        <UsersRound className="mt-0.5 h-4 w-4 shrink-0 text-keep-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug text-keep-text">{t("roleSelect.title")}</p>
          <p className="mt-0.5 text-[11px] uppercase tracking-widest text-keep-muted">{t("roleSelect.hint")}</p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {tokens.map((tok, i) => {
          const entry = byId.get(tok.usergroupId);
          if (!entry) {
            // Group gone / no longer self-assignable: the raw token line
            // degrades to plain text — never clickable.
            return (
              <p key={`${tok.usergroupId}-${i}`} className="whitespace-pre-wrap text-sm italic text-keep-muted">
                {tok.raw}
              </p>
            );
          }
          const member = overrides[tok.usergroupId] ?? entry.member;
          const color = safeCssColor(entry.color);
          return (
            <button
              key={`${tok.usergroupId}-${i}`}
              type="button"
              disabled={busyId !== null}
              onClick={() => void toggle(tok.usergroupId, member)}
              aria-pressed={member}
              title={member
                ? t("roleSelect.removeTitle", { name: entry.name })
                : t("roleSelect.addTitle", { name: entry.name })}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition disabled:opacity-50 ${
                member
                  ? "border-keep-accent bg-keep-accent/15 text-keep-text"
                  : "border-keep-rule bg-keep-bg/50 text-keep-text hover:border-keep-accent/60 hover:bg-keep-accent/10"
              }`}
            >
              <span
                aria-hidden
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                  member ? "border-keep-accent bg-keep-accent text-keep-bg" : "border-keep-rule"
                }`}
              >
                {member ? <Check className="h-3 w-3" /> : null}
              </span>
              {tok.emoji ? <span aria-hidden className="shrink-0 text-base leading-none">{tok.emoji}</span> : null}
              {/* Group color tints a leading dot ONLY (the RoleBadgeChips
                  idiom): the owner-picked color is arbitrary, so putting it
                  on the name text itself can vanish against the theme bg
                  (e.g. a "black" role on the dark theme). Names keep the
                  theme ink; usernames keep their purchasable cosmetics. */}
              {color ? (
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: color }}
                />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{entry.name}</span>
                {entry.description ? (
                  <span className="ml-2 text-xs text-keep-muted">{entry.description}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      {err ? <p className="mt-2 text-xs text-keep-accent">{err}</p> : null}
    </div>
  );
}
