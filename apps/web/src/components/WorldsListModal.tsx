import { useEffect, useState, type FormEvent } from "react";
import type { WorldMembership, WorldSummary, WorldVisibility } from "@thekeep/shared";
import { deriveSlug } from "../lib/worlds.js";
import { readError } from "../lib/http.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { CloseButton } from "./CloseButton.js";

interface Props {
  onClose: () => void;
  onOpenEditor: (worldId: string) => void;
  onOpenViewer: (worldId: string) => void;
  onOpenCatalog: () => void;
}

/**
 * Lists the user's own worlds with quick actions: edit, view, delete. Below
 * that, "Worlds I've joined" - the worlds the caller is a member of (any
 * other author's open world they joined). Members can set a primary
 * affiliation, used to group them in chat userlists.
 */
export function WorldsListModal({ onClose, onOpenEditor, onOpenViewer, onOpenCatalog }: Props) {
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [memberships, setMemberships] = useState<WorldMembership[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [wRes, mRes] = await Promise.all([
        fetch("/me/worlds", { credentials: "include" }),
        fetch("/me/worlds/memberships", { credentials: "include" }),
      ]);
      if (!wRes.ok) throw new Error(await readError(wRes));
      if (!mRes.ok) throw new Error(await readError(mRes));
      const wJ = (await wRes.json()) as { worlds: WorldSummary[] };
      const mJ = (await mRes.json()) as { memberships: WorldMembership[] };
      setWorlds(wJ.worlds);
      setMemberships(mJ.memberships);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }
  useEffect(() => { load(); }, []);

  // setPrimary was removed in migration 0187, primary-world is gone
  // alongside the userlist's world-bucket grouping that used to make
  // a "headline affiliation" meaningful.

  async function leave(worldId: string, name: string) {
    if (!window.confirm(`Leave "${name}"? You can re-join from the world catalog any time.`)) return;
    setError(null);
    try {
      const r = await fetch(`/worlds/${worldId}/members`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "leave failed");
    }
  }

  // Memberships in worlds the user OWNS show up in both lists naturally;
  // we hide them from the "joined" section to avoid duplicates - the owned
  // list is the source of truth for those.
  const ownedIds = new Set((worlds ?? []).map((w) => w.id));
  const joinedOnly = (memberships ?? []).filter((m) => !ownedIds.has(m.worldId));

  async function remove(w: WorldSummary) {
    if (!window.confirm(
      `Delete "${w.name}"? This cascades to all ${w.pageCount} pages and removes any room links. Cannot be undone.`,
    )) return;
    try {
      const r = await fetch(`/worlds/${w.id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-parchment`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-lg">Your worlds</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onOpenCatalog}
              className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm hover:bg-keep-banner"
              title="Browse open worlds you can use in your rooms"
            >
              Browse catalog
            </button>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-sm hover:bg-keep-banner"
            >
              + New world
            </button>
            <CloseButton onClick={onClose} />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <div className="mb-3 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
          ) : null}
          {creating ? (
            <NewWorldForm
              onCancel={() => setCreating(false)}
              onCreated={(w) => {
                setCreating(false);
                onOpenEditor(w.id);
              }}
            />
          ) : null}
          {worlds === null ? (
            <p className="italic text-keep-muted">Loading...</p>
          ) : worlds.length === 0 ? (
            <p className="italic text-keep-muted">No worlds yet. Click "+ New world" to start one.</p>
          ) : (
            <ul className="space-y-2">
              {worlds.map((w) => (
                <li key={w.id} className="rounded border border-keep-rule/60 bg-keep-bg p-3">
                  <header className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-semibold">{w.name}</span>
                      <span className="ml-2 text-[11px] text-keep-muted">/{w.slug}</span>
                      <span
                        className={`ml-2 rounded px-1 text-[10px] uppercase tracking-widest ${
                          w.visibility === "open"
                            ? "bg-keep-action/20 text-keep-action"
                            : w.visibility === "public"
                              ? "bg-keep-system/20 text-keep-system"
                              : "bg-keep-rule/30 text-keep-muted"
                        }`}
                      >
                        {w.visibility}
                      </span>
                    </div>
                    <div className="shrink-0 text-[10px] text-keep-muted">
                      {w.pageCount} {w.pageCount === 1 ? "page" : "pages"}
                    </div>
                  </header>
                  {w.description ? (
                    <p className="mt-1 text-sm text-keep-text/80">{w.description}</p>
                  ) : null}
                  <div className="mt-2 flex justify-end gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => onOpenViewer(w.id)}
                      className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                    >
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenEditor(w.id)}
                      className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(w)}
                      className="rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Joined-but-not-owned worlds. Hidden when the user has no
              memberships beyond their own worlds, to avoid an empty section. */}
          {joinedOnly.length > 0 ? (
            <>
              <h3 className="mb-2 mt-5 font-action text-sm uppercase tracking-widest text-keep-muted">
                Worlds I've joined
              </h3>
              <ul className="space-y-2">
                {joinedOnly.map((m) => (
                  <li
                    key={`${m.worldId}:${m.characterId ?? ""}`}
                    className="rounded border border-keep-rule/60 bg-keep-bg p-3"
                  >
                    <header className="flex items-baseline justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-semibold">{m.worldName}</span>
                        <span className="ml-2 text-[11px] text-keep-muted">/{m.worldSlug}</span>
                        <span className="ml-2 text-[11px] text-keep-muted">by {m.ownerUsername}</span>
                        {/* Identity badge, characters and OOC each
                            join independently per migration 0187, so
                            the same world can appear twice (or more)
                            in this list. The pill makes which face
                            joined explicit. */}
                        <span
                          className="ml-2 rounded border border-keep-rule bg-keep-banner/60 px-1 text-[10px] uppercase tracking-widest text-keep-muted"
                          title={m.characterId !== null
                            ? `Joined as your character ${m.identityDisplayName}`
                            : "Joined as OOC (your master account)"}
                        >
                          as {m.characterId !== null ? m.identityDisplayName : "OOC"}
                        </span>
                      </div>
                      <div className="shrink-0 text-[10px] text-keep-muted">
                        joined {new Date(m.joinedAt).toLocaleDateString()}
                      </div>
                    </header>
                    <div className="mt-2 flex justify-end gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => onOpenViewer(m.worldId)}
                        className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => leave(m.worldId, m.worldName)}
                        className="rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
                      >
                        Leave
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function NewWorldForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (w: WorldSummary) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<WorldVisibility>("private");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        visibility,
      };
      if (slug.trim()) body.slug = slug.trim();
      if (description.trim()) body.description = description.trim();
      const r = await fetch("/worlds", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      const w = (await r.json()) as WorldSummary;
      onCreated(w);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  const previewSlug = slug.trim() ? slug.trim().toLowerCase() : deriveSlug(name);

  return (
    <form onSubmit={submit} className="mb-3 rounded border border-keep-action/40 bg-keep-bg p-3 text-xs">
      <h3 className="mb-2 font-action text-sm">New world</h3>
      <label className="mb-1 block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Name</span>
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="mb-1 block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Slug (optional)</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={previewSlug || "e.g. darkrealm"}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono outline-none focus:border-keep-action"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          Used in URLs and the /world link slash command. Auto-derived from the name if blank.
        </span>
      </label>
      <label className="mb-1 block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={2000}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="mb-2 block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Visibility</span>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as WorldVisibility)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
        >
          <option value="private">Private (only you)</option>
          <option value="public">Public (anyone with the link)</option>
          <option value="open">Open (catalog-listed, others can link to their rooms)</option>
        </select>
      </label>
      {err ? <div className="mb-1 text-[10px] text-keep-accent">{err}</div> : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-2 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
        >
          {busy ? "Creating..." : "Create"}
        </button>
      </div>
    </form>
  );
}

