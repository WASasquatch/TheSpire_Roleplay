import { useEffect, useState } from "react";
import type { WorldCatalogEntry } from "@thekeep/shared";

interface Props {
  /** Current room id for "Use in this room". If null, the link button is hidden. */
  currentRoomId: string | null;
  onClose: () => void;
  onOpenViewer: (worldId: string) => void;
}

/**
 * Browse all worlds with visibility="open". Each entry can be opened in the
 * viewer or, if the caller is in a room and is owner/mod/admin of that room,
 * linked to the current room via PUT /rooms/:roomId/world. The server enforces
 * the room-mod check, so the button just surfaces the action.
 */
export function WorldCatalogModal({ currentRoomId, onClose, onOpenViewer }: Props) {
  const [entries, setEntries] = useState<WorldCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [linkedFlash, setLinkedFlash] = useState<string | null>(null);
  // Worlds the viewer has already joined - drives "Join" vs "Joined" labels.
  // Loaded alongside the catalog so the buttons render correctly on first paint.
  const [memberWorldIds, setMemberWorldIds] = useState<Set<string>>(new Set());
  const [joining, setJoining] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      fetch("/worlds/catalog", { credentials: "include" }),
      fetch("/me/worlds/memberships", { credentials: "include" }),
    ])
      .then(async ([catRes, memRes]) => {
        if (!catRes.ok) throw new Error(await readError(catRes));
        const cat = (await catRes.json()) as { entries: WorldCatalogEntry[] };
        // Memberships fetch requires auth; if 401, treat as "no memberships".
        const mem = memRes.ok
          ? ((await memRes.json()) as { memberships: { worldId: string }[] }).memberships
          : [];
        if (cancelled) return;
        setEntries(cat.entries);
        setMemberWorldIds(new Set(mem.map((m) => m.worldId)));
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "load failed"); });
    return () => { cancelled = true; };
  }, []);

  async function joinWorld(worldId: string) {
    setJoining(worldId);
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}/members`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      setMemberWorldIds((s) => new Set(s).add(worldId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "join failed");
    } finally {
      setJoining(null);
    }
  }

  async function linkToRoom(worldId: string) {
    if (!currentRoomId) return;
    setLinking(worldId);
    setError(null);
    try {
      const r = await fetch(`/rooms/${currentRoomId}/world`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worldId }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setLinkedFlash(worldId);
      window.setTimeout(() => setLinkedFlash(null), 2400);
    } catch (e) {
      setError(e instanceof Error ? e.message : "link failed");
    } finally {
      setLinking(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-[min(820px,96vw)] flex-col overflow-hidden rounded border border-keep-rule bg-keep-parchment shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-lg">World catalog</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-keep-muted hover:text-keep-text"
          >
            close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-3 text-xs text-keep-muted">
            Open worlds anyone can browse, and that room owners or mods can link to their rooms. Authors mark a world
            as "open" from the world editor.
          </p>
          {error ? (
            <div className="mb-3 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
              {error}
            </div>
          ) : null}
          {entries === null ? (
            <p className="italic text-keep-muted">Loading...</p>
          ) : entries.length === 0 ? (
            <p className="italic text-keep-muted">No open worlds yet. Be the first - mark one of yours as "open" in its settings.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((e) => (
                <li key={e.id} className="rounded border border-keep-rule/60 bg-keep-bg p-3">
                  <header className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-semibold">{e.name}</span>
                      <span className="ml-2 text-[11px] text-keep-muted">/{e.slug}</span>
                      <span className="ml-2 text-[11px] text-keep-muted">by {e.ownerUsername}</span>
                    </div>
                    <div className="shrink-0 text-[10px] text-keep-muted">
                      {e.pageCount} {e.pageCount === 1 ? "page" : "pages"}
                      <span className="mx-1">·</span>
                      {e.memberCount} {e.memberCount === 1 ? "member" : "members"}
                    </div>
                  </header>
                  {e.description ? (
                    <p className="mt-1 text-sm text-keep-text/80">{e.description}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs">
                    {linkedFlash === e.id ? (
                      <span className="text-[11px] text-keep-action">linked to this room</span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onOpenViewer(e.id)}
                      className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                    >
                      Browse
                    </button>
                    {memberWorldIds.has(e.id) ? (
                      <span
                        className="rounded border border-keep-action/40 bg-keep-action/10 px-2 py-0.5 text-keep-action"
                        title="You're a member of this world. Manage from My Worlds."
                      >
                        Joined
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => joinWorld(e.id)}
                        disabled={joining === e.id}
                        title="Join this world to declare an affiliation. Doesn't affect room access."
                        className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
                      >
                        {joining === e.id ? "Joining..." : "Join"}
                      </button>
                    )}
                    {currentRoomId ? (
                      <button
                        type="button"
                        onClick={() => linkToRoom(e.id)}
                        disabled={linking === e.id}
                        className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
                        title="Attach this world to the room you're currently in (owner/mod only)"
                      >
                        {linking === e.id ? "Linking..." : "Use in this room"}
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

async function readError(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: string; message?: string };
    return j.error ?? j.message ?? `${r.status} ${r.statusText}`;
  } catch {
    return `${r.status} ${r.statusText}`;
  }
}
