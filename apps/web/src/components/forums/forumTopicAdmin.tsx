import { useEffect, useState } from "react";
import { fetchBoardTopics, fetchRoomCategories, mergeTopicInto, moveTopicToBoard, setTopicCategory } from "../../lib/forums.js";
import { type ForumTopicAdminBoard } from "../../lib/forumTopicAdminContext.js";
import { Modal } from "../cosmetics/Modal.js";
import type { ChatMessage, ForumTopicCard, ThreadCategory } from "@thekeep/shared";

/**
 * Unified "Move topic" modal, opened from the topic toolbar's Move button
 * (mods holding move_topics). One place for the three placement actions:
 * recategorize within the current board, move to another board, or merge into
 * another topic. The board list arrives via ForumTopicAdminContext; the current
 * board's categories are fetched on open (so the modal is self-contained and
 * needs no category prop-drilling). The server re-checks every action. Forums
 * Catalog viewers aren't on the board socket, so on success we just ask the
 * catalog to refresh (`onChanged`) rather than relying on a `message:update`.
 */
export function TopicManageModal({ topic, boards, onClose, onChanged }: {
  topic: ChatMessage;
  boards: ForumTopicAdminBoard[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [cats, setCats] = useState<ThreadCategory[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Merge is lazy: a board's topic list only loads once the section is opened.
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeBoard, setMergeBoard] = useState<string>(topic.roomId);
  const [mergeTopics, setMergeTopics] = useState<ForumTopicCard[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchRoomCategories(topic.roomId).then((c) => { if (alive) setCats(c); }).catch(() => { if (alive) setCats([]); });
    return () => { alive = false; };
  }, [topic.roomId]);

  useEffect(() => {
    if (!mergeOpen) return;
    let alive = true;
    setMergeTopics(null);
    fetchBoardTopics(mergeBoard).then((p) => { if (alive) setMergeTopics(p.topics); }).catch(() => { if (alive) setMergeTopics([]); });
    return () => { alive = false; };
  }, [mergeOpen, mergeBoard]);

  const otherBoards = boards.filter((b) => b.roomId !== topic.roomId);
  const currentCat = topic.threadCategoryId ?? "";

  function guard(p: Promise<void>) {
    setBusy(true); setErr(null);
    p.then(() => { onChanged(); onClose(); })
     .catch((e) => { setErr(e instanceof Error ? e.message : "Action failed."); setBusy(false); });
  }
  function recategorize(next: string) {
    const categoryId = next === "" ? null : next;
    if ((topic.threadCategoryId ?? null) === categoryId) return;
    guard(setTopicCategory(topic.id, categoryId));
  }
  function toBoard(roomId: string) { guard(moveTopicToBoard(topic.id, roomId, null)); }
  function doMerge(targetId: string, targetTitle: string) {
    if (!window.confirm(`Merge "${topic.title ?? "this topic"}" into "${targetTitle}"? Its posts become replies there. This can't be auto-undone.`)) return;
    guard(mergeTopicInto(topic.id, targetId));
  }

  return (
    <Modal onClose={onClose} zIndex={60}>
      <div onClick={(e) => e.stopPropagation()} className="keep-frame w-full rounded bg-keep-bg p-5 text-keep-text md:w-[min(480px,86vw)]">
        <h2 className="font-action text-lg">Move topic</h2>
        <p className="mt-1 truncate text-sm text-keep-muted">"{topic.title ?? "this topic"}"</p>

        {/* Recategorize within the current board (only when it has categories). */}
        {cats && cats.length > 0 ? (
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">Category</div>
            <select
              value={currentCat}
              disabled={busy}
              onChange={(e) => recategorize(e.target.value)}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm disabled:opacity-50"
            >
              <option value="">Uncategorized</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ) : null}

        {/* Move the whole topic to a different board. */}
        {otherBoards.length > 0 ? (
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">Move to another board</div>
            <ul className="space-y-1">
              {otherBoards.map((b) => (
                <li key={b.roomId}>
                  <button
                    type="button" disabled={busy} onClick={() => toBoard(b.roomId)}
                    className="flex w-full items-center justify-between rounded border border-keep-rule px-2 py-1.5 text-left text-sm hover:border-keep-action hover:bg-keep-banner/40 disabled:opacity-50"
                  >
                    <span className="truncate">{b.name}</span>
                    <span className="ml-2 shrink-0 text-[10px] text-keep-muted">{b.topicCount} topics</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Merge this topic into another (posts become replies). Lazy-loaded. */}
        <div className="mt-3">
          <button
            type="button" disabled={busy} onClick={() => setMergeOpen((o) => !o)}
            className="text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
          >{mergeOpen ? "▾" : "▸"} Merge into another topic</button>
          {mergeOpen ? (
            <div className="mt-2 space-y-2">
              {boards.length > 1 ? (
                <select value={mergeBoard} onChange={(e) => setMergeBoard(e.target.value)} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm">
                  {boards.map((b) => <option key={b.roomId} value={b.roomId}>{b.name}</option>)}
                </select>
              ) : null}
              {!mergeTopics ? (
                <p className="text-xs italic text-keep-muted">Loading topics…</p>
              ) : (
                <ul className="max-h-60 space-y-1 overflow-y-auto">
                  {mergeTopics.filter((t) => t.id !== topic.id).map((t) => (
                    <li key={t.id}>
                      <button
                        type="button" disabled={busy} onClick={() => doMerge(t.id, t.title)}
                        className="w-full truncate rounded border border-keep-rule px-2 py-1.5 text-left text-sm hover:border-keep-action hover:bg-keep-banner/40 disabled:opacity-50"
                      >{t.title}</button>
                    </li>
                  ))}
                  {mergeTopics.filter((t) => t.id !== topic.id).length === 0 ? (
                    <li className="text-xs italic text-keep-muted">No other topics on this board.</li>
                  ) : null}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        {err ? <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{err}</div> : null}
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded border border-keep-rule px-3 py-1 text-sm hover:bg-keep-banner">Close</button>
        </div>
      </div>
    </Modal>
  );
}
