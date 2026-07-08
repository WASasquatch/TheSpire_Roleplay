import { useEffect, useState, type FormEvent } from "react";
import type {
  StoryCollaborator,
  StoryCollaboratorRole,
  StoryDetail,
} from "@thekeep/shared";
import {
  STORY_COLLABORATOR_ROLES,
  permissionsForCollaboratorRole,
} from "@thekeep/shared";
import { readError } from "../../lib/http.js";
import { useChat } from "../../state/store.js";

interface Props {
  detail: StoryDetail;
}

/**
 * Editor's Collaborators tab. Owner sees an invite form + role grid +
 * per-row controls; a collaborator viewing this tab gets a read-only
 * list. (The owner-only mutate routes 403 anyone else server-side, so
 * the UI is a soft gate.)
 *
 * The role grid mirrors permissionsForCollaboratorRole(), kept in
 * lockstep so the matrix in the UI matches what the server actually
 * enforces.
 */
export function StoryCollaboratorsTab({ detail }: Props) {
  const me = useChat((s) => s.me);
  const storyId = detail.story.id;
  const isOwner = !!me && me.id === detail.story.author.userId;

  const [collaborators, setCollaborators] = useState<StoryCollaborator[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const r = await fetch(`/stories/${storyId}/collaborators`);
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { collaborators: StoryCollaborator[] };
      setCollaborators(j.collaborators);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [storyId]);

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      {/* Quick reference: what does each role do? */}
      <RoleMatrix />

      {isOwner ? (
        <InviteForm storyId={storyId} onInvited={() => load()} />
      ) : null}

      <section>
        <h3 className="mb-2 font-action text-base">Current collaborators</h3>
        {collaborators === null ? (
          <p className="italic text-keep-muted">Loading…</p>
        ) : collaborators.length === 0 ? (
          <p className="text-sm italic text-keep-muted">
            No collaborators yet. {isOwner ? "Invite someone above to share the story." : ""}
          </p>
        ) : (
          <ul className="space-y-2">
            {collaborators.map((c) => (
              <CollaboratorRow
                key={c.userId}
                collaborator={c}
                storyId={storyId}
                isOwner={isOwner}
                onChanged={() => load()}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* =============================================================
 *  Role matrix, quick reference for the author and reader.
 * ============================================================= */

function RoleMatrix() {
  const perms = STORY_COLLABORATOR_ROLES.map((r) => ({ role: r, ...permissionsForCollaboratorRole(r) }));
  return (
    <details className="rounded border border-keep-rule/40 bg-keep-panel/30">
      <summary className="cursor-pointer px-3 py-1.5 text-xs uppercase tracking-widest text-keep-muted">
        Role matrix
      </summary>
      <div className="overflow-x-auto px-3 pb-3">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-keep-muted">
              <th className="py-1 pr-3 font-normal">Role</th>
              <th className="py-1 pr-3 font-normal">Read drafts</th>
              <th className="py-1 pr-3 font-normal">Edit chapters</th>
              <th className="py-1 pr-3 font-normal">Add chapters</th>
              <th className="py-1 pr-3 font-normal">Manage codex</th>
              <th className="py-1 pr-3 font-normal">Publish</th>
            </tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p.role}>
                <td className="py-1 pr-3 font-semibold">{labelForRole(p.role)}</td>
                <Cell on={p.readDrafts} />
                <Cell on={p.editChapters} />
                <Cell on={p.addChapters} />
                <Cell on={p.manageCodex} />
                <Cell on={p.publish} />
              </tr>
            ))}
            <tr>
              <td className="py-1 pr-3 font-semibold text-keep-action">Owner</td>
              <Cell on /><Cell on /><Cell on /><Cell on /><Cell on />
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-[10px] text-keep-muted">
          The owner is the only role that can manage collaborators and delete the story.
        </p>
      </div>
    </details>
  );
}

function Cell({ on }: { on?: boolean }) {
  return (
    <td className="py-1 pr-3">
      {on ? <span className="text-keep-action">✓</span> : <span className="text-keep-muted">·</span>}
    </td>
  );
}

/* =============================================================
 *  Invite form (owner-only).
 * ============================================================= */

function InviteForm({ storyId, onInvited }: { storyId: string; onInvited: () => void }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<StoryCollaboratorRole>("editor");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setBusy(true);
    setErr(null);
    setOkMsg(null);
    try {
      const r = await fetch(`/stories/${storyId}/collaborators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), role }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { ok: true; status: "invited" | "pending" | "role_changed" };
      setOkMsg(
        j.status === "invited" ? `Invite sent to ${username.trim()}.` :
        j.status === "pending" ? `Already-pending invite to ${username.trim()} updated.` :
        `Role changed for ${username.trim()}.`,
      );
      setUsername("");
      onInvited();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "invite failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-keep-rule/40 bg-keep-panel/30 p-3">
      <h3 className="mb-2 font-action text-base">Invite a collaborator</h3>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[10rem]">
          <label className="block text-[10px] uppercase tracking-widest text-keep-muted">Username</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={40}
            placeholder="their master username"
            className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-keep-muted">Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as StoryCollaboratorRole)}
            className="mt-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm"
          >
            {STORY_COLLABORATOR_ROLES.map((r) => (
              <option key={r} value={r}>{labelForRole(r)}</option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={busy || !username.trim()}
          className="rounded border border-keep-action bg-keep-action px-4 py-1.5 text-sm font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {busy ? "Sending…" : "Invite"}
        </button>
      </form>
      {err ? <p className="mt-2 text-xs text-keep-accent">{err}</p> : null}
      {okMsg ? <p className="mt-2 text-xs italic text-keep-action">{okMsg}</p> : null}
    </section>
  );
}

/* =============================================================
 *  Per-row collaborator card.
 * ============================================================= */

function CollaboratorRow({
  collaborator,
  storyId,
  isOwner,
  onChanged,
}: {
  collaborator: StoryCollaborator;
  storyId: string;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const me = useChat((s) => s.me);
  const isSelf = !!me && me.id === collaborator.userId;
  const pending = collaborator.acceptedAt == null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function changeRole(role: StoryCollaboratorRole) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${storyId}/collaborators/${collaborator.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!r.ok) throw new Error(await readError(r));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "role change failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const verb = pending ? "Rescind the invite to" : isSelf ? "Leave this collaboration as" : "Remove";
    if (!window.confirm(`${verb} ${collaborator.username}?`)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${storyId}/collaborators/${collaborator.userId}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(await readError(r));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "remove failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`rounded border p-3 ${pending ? "border-keep-accent/40 bg-keep-accent/5" : "border-keep-rule/40 bg-keep-panel/20"}`}>
      <div className="flex items-center gap-2">
        {collaborator.avatarUrl ? (
          <img src={collaborator.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <div className="h-7 w-7 rounded-full bg-keep-bg" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <b>{collaborator.username}</b>
            <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${roleBadgeClass(collaborator.role)}`}>
              {labelForRole(collaborator.role)}
            </span>
            {pending ? (
              <span className="rounded bg-keep-accent/15 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-accent">
                pending
              </span>
            ) : null}
            {isSelf ? <span className="text-[10px] italic text-keep-muted">(you)</span> : null}
          </div>
          <div className="text-[10px] text-keep-muted">
            Invited {new Date(collaborator.invitedAt).toLocaleString()}
            {collaborator.invitedByUsername ? <> by {collaborator.invitedByUsername}</> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs">
          {isOwner ? (
            <select
              value={collaborator.role}
              onChange={(e) => changeRole(e.target.value as StoryCollaboratorRole)}
              disabled={busy}
              className="rounded border border-keep-rule bg-keep-bg px-1 py-0.5 text-xs"
            >
              {STORY_COLLABORATOR_ROLES.map((r) => (
                <option key={r} value={r}>{labelForRole(r)}</option>
              ))}
            </select>
          ) : null}
          {isOwner || isSelf ? (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="rounded border border-keep-accent/40 bg-keep-accent/5 px-2 py-0.5 text-keep-accent"
              title={pending ? "Rescind invite" : isSelf ? "Leave" : "Remove"}
            >
              {pending ? "Rescind" : isSelf ? "Leave" : "Remove"}
            </button>
          ) : null}
        </div>
      </div>
      {err ? <p className="mt-1 text-xs text-keep-accent">{err}</p> : null}
    </li>
  );
}

/* =============================================================
 *  Helpers
 * ============================================================= */

function labelForRole(role: StoryCollaboratorRole): string {
  return role === "co_author" ? "Co-author" : role.charAt(0).toUpperCase() + role.slice(1);
}

function roleBadgeClass(role: StoryCollaboratorRole): string {
  switch (role) {
    case "reader":     return "bg-keep-muted/25 text-keep-muted";
    case "editor":     return "bg-sky-500/15 text-sky-300";
    case "co_author":  return "bg-amber-500/15 text-amber-300";
  }
}
