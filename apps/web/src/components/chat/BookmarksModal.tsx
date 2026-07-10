import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { customCmdCssToStyle, resolveMessageColor, type Bookmark } from "@thekeep/shared";
import { formatDateTime } from "../../lib/intlFormat.js";
import { parseInline } from "../../lib/markdown.js";
import { useActiveTheme } from "../../lib/theme.js";
import { readError } from "../../lib/http.js";
import { Modal, MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";

interface Props {
  onClose: () => void;
  /**
   * Called when the user clicks a bookmark row. Caller resolves to the
   * right room + scroll target via the shared `jumpToMessage` flow that
   * Phase 1 introduced.
   */
  onJumpToMessage: (roomId: string, messageId: string) => void;
}

const UNCATEGORIZED = "Uncategorized";

/**
 * Bookmarks viewer / manager. Lists the caller's bookmarks grouped by
 * user-defined category (empty string maps to "Uncategorized"). Clicking
 * a row jumps to the bookmarked message via the cross-cutting Phase 1
 * helper; editing a row's category or note re-PATCHes the server.
 *
 * Soft-deleted messages render as their `[message removed]` placeholder
 * (the server returns it) so the user can decide to clean the row up.
 */
export function BookmarksModal({ onClose, onJumpToMessage }: Props) {
  const { t } = useTranslation("chat");
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");

  async function load() {
    setError(null);
    try {
      const r = await fetch("/me/bookmarks", { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { bookmarks: Bookmark[] };
      setBookmarks(j.bookmarks);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bookmarks.loadFailed"));
    }
  }
  useEffect(() => { load(); }, []);

  // Group by category for rendering. Empty string folds into a stable
  // "Uncategorized" bucket. Sort categories alphabetically, with the
  // uncategorized bucket last so the user's deliberately-named buckets
  // surface first.
  const grouped = useMemo(() => {
    if (!bookmarks) return [] as Array<{ category: string; rows: Bookmark[] }>;
    // Client-side search over the already-loaded list: matches the body,
    // note, category, author name, and room name (case-insensitive). Empty
    // query shows everything. No server round-trip, the full list is
    // already in memory.
    const q = query.trim().toLowerCase();
    const matches = (b: Bookmark) => {
      if (!q) return true;
      const m = b.message;
      return (
        m.body.toLowerCase().includes(q) ||
        (b.note ?? "").toLowerCase().includes(q) ||
        b.category.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        m.roomName.toLowerCase().includes(q)
      );
    };
    const map = new Map<string, Bookmark[]>();
    for (const b of bookmarks) {
      if (!matches(b)) continue;
      const key = b.category.trim() || UNCATEGORIZED;
      const arr = map.get(key) ?? [];
      arr.push(b);
      map.set(key, arr);
    }
    const entries = [...map.entries()].sort(([a], [b]) => {
      if (a === UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED) return -1;
      return a.localeCompare(b);
    });
    return entries.map(([category, rows]) => ({ category, rows }));
  }, [bookmarks, query]);

  async function removeBookmark(id: string) {
    if (!window.confirm(t("bookmarks.removeConfirm"))) return;
    try {
      const r = await fetch(`/me/bookmarks/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r));
      setBookmarks((cur) => (cur ? cur.filter((b) => b.id !== id) : cur));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bookmarks.deleteFailed"));
    }
  }

  async function saveEdit(id: string, category: string, note: string) {
    try {
      const r = await fetch(`/me/bookmarks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: category.trim(), note: note.trim() || null }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setBookmarks((cur) =>
        cur
          ? cur.map((b) =>
              b.id === id
                ? { ...b, category: category.trim(), note: note.trim() || null }
                : b,
            )
          : cur,
      );
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bookmarks.saveFailed"));
    }
  }

  function toggleSection(category: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  return (
    <Modal onClose={onClose} variant="mobile-fullscreen">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`${MODAL_CARD_CONTENT} keep-frame bg-keep-bg text-keep-text lg:rounded`}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <h2 className="font-action text-lg">{t("bookmarks.title")}</h2>
          <CloseButton onClick={onClose} />
        </header>

        {bookmarks && bookmarks.length > 0 ? (
          <div className="shrink-0 border-b border-keep-rule/50 px-3 py-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("bookmarks.searchPlaceholder")}
              aria-label={t("bookmarks.searchAria")}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm placeholder:text-keep-muted"
            />
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {error ? (
            <div className="mb-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
              {error}
            </div>
          ) : null}
          {bookmarks === null && !error ? (
            <p className="italic text-keep-muted">{t("bookmarks.loading")}</p>
          ) : null}
          {bookmarks && bookmarks.length === 0 ? (
            <p className="italic text-keep-muted">
              {t("bookmarks.empty")}
            </p>
          ) : null}
          {bookmarks && bookmarks.length > 0 && grouped.length === 0 ? (
            <p className="italic text-keep-muted">{t("bookmarks.noMatches")}</p>
          ) : null}

          {grouped.map(({ category, rows }) => {
            const isCollapsed = collapsed.has(category);
            return (
              <section key={category} className="mb-3">
                <button
                  type="button"
                  onClick={() => toggleSection(category)}
                  className="flex w-full items-center justify-between border-b border-keep-rule/60 bg-keep-banner/40 px-2 py-1 text-left text-xs uppercase tracking-widest text-keep-muted hover:bg-keep-banner/60"
                >
                  <span>
                    <span aria-hidden className="mr-1">{isCollapsed ? "▶" : "▼"}</span>
                    {category === UNCATEGORIZED ? t("bookmarks.uncategorized") : category}
                  </span>
                  <span className="tabular-nums">{rows.length}</span>
                </button>
                {isCollapsed ? null : (
                  <ul className="divide-y divide-keep-rule/30">
                    {rows.map((b) => (
                      <li key={b.id}>
                        {editingId === b.id ? (
                          <EditForm
                            bookmark={b}
                            onSave={(cat, note) => saveEdit(b.id, cat, note)}
                            onCancel={() => setEditingId(null)}
                          />
                        ) : (
                          <Row
                            bookmark={b}
                            onOpen={() => {
                              onJumpToMessage(b.message.roomId, b.message.id);
                              onClose();
                            }}
                            onEdit={() => setEditingId(b.id)}
                            onDelete={() => removeBookmark(b.id)}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

function Row({
  bookmark,
  onOpen,
  onEdit,
  onDelete,
}: {
  bookmark: Bookmark;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("chat");
  const m = bookmark.message;
  const when = formatDateTime(m.createdAt);
  const removed = m.body === "[message removed]";
  // Archived = the original message expired out of the retention window and
  // we're rendering the saved snapshot. There's no live row to jump to, so
  // the body is a plain (non-clickable) block with an explanatory tooltip.
  const archived = !!m.archived;
  // Only offer a clickable "Jump" when there's a REAL live target to jump to.
  // The server sends id="" / roomId="" for both the archived snapshot AND the
  // soft-deleted/[removed] placeholder; jumping with those empty ids misfired
  // (and regressed soft-deleted rows into a broken jump). A row is jumpable
  // only when it's neither archived nor removed AND carries real ids.
  const jumpable = !archived && !removed && !!m.id && !!m.roomId;
  // Match the chat renderer's styling pass so a bookmarked kind="cmd"
  // row reads in the same palette + CSS the user remembers seeing
  // when they bookmarked it. `useActiveTheme().bg` lets the legibility
  // nudge swap in a contrastier variant of an admin-set color when
  // the viewer's theme would have made it unreadable.
  const themeBg = useActiveTheme().bg;
  const color = resolveMessageColor(m.color, themeBg);
  const cmdStyle = m.kind === "cmd" ? customCmdCssToStyle(m.cmdCss ?? null, themeBg) : null;
  const bodyStyle = {
    ...(color ? { color } : {}),
    ...(cmdStyle ?? {}),
  };
  return (
    <div className="group px-2 py-2 hover:bg-keep-banner/30">
      <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-widest text-keep-muted">
        <span className="truncate">
          <b className="text-keep-text">{m.displayName}</b>
          <span className="mx-1">·</span>
          {m.roomName}
          {m.replyToId ? <span className="ml-1 italic text-keep-action/80">{t("bookmarks.inThread")}</span> : null}
          {archived ? (
            <span className="ml-1 rounded bg-keep-muted/20 px-1 py-0.5 text-[9px] not-italic text-keep-muted">
              {t("bookmarks.archived")}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 tabular-nums">{when}</span>
      </div>
      {jumpable ? (
        <button
          type="button"
          onClick={onOpen}
          className="mt-1 block w-full text-left text-sm leading-snug hover:underline"
          title={t("actions.jumpToMessage")}
        >
          <span className="break-words" style={bodyStyle}>
            {parseInline(m.body)}
          </span>
        </button>
      ) : (
        // No live message to jump to (archived snapshot, or soft-deleted /
        // [removed]); render the body inline, non-clickable, so a click can't
        // misfire a jump with empty ids.
        <div
          className="mt-1 block w-full text-left text-sm leading-snug"
          title={
            removed
              ? t("bookmarks.removedTooltip")
              : t("bookmarks.archivedTooltip")
          }
        >
          <span
            className={removed ? "italic text-keep-muted" : "break-words"}
            style={removed ? undefined : bodyStyle}
          >
            {removed ? m.body : parseInline(m.body)}
          </span>
        </div>
      )}
      {bookmark.note ? (
        <div className="mt-1 break-words rounded border-l-2 border-keep-action/40 bg-keep-action/5 px-2 py-0.5 text-xs italic text-keep-text/85">
          {bookmark.note}
        </div>
      ) : null}
      <div className="mt-1 flex gap-2 text-[10px] uppercase tracking-widest text-keep-muted opacity-0 group-hover:opacity-100">
        <button type="button" onClick={onEdit} className="hover:text-keep-action">{t("bookmarks.edit")}</button>
        <button type="button" onClick={onDelete} className="hover:text-keep-accent">{t("bookmarks.remove")}</button>
      </div>
    </div>
  );
}

function EditForm({
  bookmark,
  onSave,
  onCancel,
}: {
  bookmark: Bookmark;
  onSave: (category: string, note: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("chat");
  const [category, setCategory] = useState(bookmark.category);
  const [note, setNote] = useState(bookmark.note ?? "");
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSave(category, note); }}
      className="space-y-1 bg-keep-banner/30 p-2"
    >
      <input
        type="text"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        maxLength={60}
        placeholder={t("bookmarks.categoryPlaceholder")}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        placeholder={t("bookmarks.notePlaceholder")}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
      />
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner"
        >
          {t("common:cancel")}
        </button>
        <button
          type="submit"
          className="rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-xs font-semibold text-keep-action hover:bg-keep-action/20"
        >
          {t("common:save")}
        </button>
      </div>
    </form>
  );
}
