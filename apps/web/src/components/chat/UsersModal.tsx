import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Gender } from "../../lib/gender.js";
import { genderGlyph } from "../../lib/gender.js";
import { formatDate, formatNumber } from "../../lib/intlFormat.js";
import { useEarning } from "../../state/earning.js";
import { Modal, MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";
import { RankSigil } from "../earning/RankSigil.js";

export interface UserRow {
  userId: string;
  username: string;
  gender: Gender;
  avatarUrl: string | null;
  chatColor: string | null;
  online: boolean;
  away: boolean;
  awayMessage: string | null;
  activeCharacterId: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  /** Master-pool rank key, drives the per-row gem icon. Null = unranked. */
  rankKey: string | null;
  /** Current tier within the rank (1..N). Tier label is resolved client-side from the earning catalog. */
  rankTier: number | null;
  /** Lifetime visible-post count (chat + forum). Null = user opted into per-element privacy; renderer shows "private". */
  messageCount: number | null;
  characters: Array<{ id: string; name: string; avatarUrl: string | null }>;
}

type SortMode = "online" | "messages" | "joined" | "name";

interface Props {
  onClose: () => void;
  /** Click on any name (master OR character) opens that profile. */
  onOpenName: (name: string) => void;
  /** Pre-fill the search box (used by /find <name>). */
  initialQuery?: string;
}

/**
 * Searchable directory of registered accounts. Each row groups the master
 * username with all of its characters, so curious users can see who plays
 * whom. Online accounts float to the top; the search box matches against
 * master usernames AND character names.
 *
 * Only authenticated users can open this - the server gates /users behind
 * a session, so the directory isn't exposed to the public internet.
 */
export function UsersModal({ onClose, onOpenName, initialQuery }: Props) {
  const { t } = useTranslation("chat");
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(initialQuery ?? "");
  // Rank filter (master-pool rank key), "" means "any rank". Populated
  // from the live earning catalog so admins adding / disabling ranks
  // see the dropdown change without a code release.
  const [rankFilter, setRankFilter] = useState<string>("");
  const [sortMode, setSortMode] = useState<SortMode>("online");
  const ranks = useEarning((s) => s.snapshot?.catalog.ranks ?? []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      // Build query: q + optional rank filter + sort mode. The server
      // applies them all (rank narrows the set; sort orders the page).
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (rankFilter) params.set("rank", rankFilter);
      if (sortMode !== "online") params.set("sort", sortMode);
      const qs = params.toString();
      const url = qs ? `/users?${qs}` : "/users";
      fetch(url, { credentials: "include", signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(t("users.statusError", { status: r.status }));
          return r.json() as Promise<{ users: UserRow[] }>;
        })
        .then((j) => { if (!cancelled) { setRows(j.users); setError(null); } })
        .catch((err) => {
          if (cancelled || err?.name === "AbortError") return;
          setError(err instanceof Error ? err.message : t("users.loadFailed"));
        });
    }, 200); // debounce search keystrokes
    return () => { cancelled = true; controller.abort(); window.clearTimeout(handle); };
  }, [q, rankFilter, sortMode]);

  // Local count for the heading - useful when search narrows the list.
  const counts = useMemo(() => {
    if (!rows) return { online: 0, total: 0 };
    let online = 0;
    for (const u of rows) if (u.online) online++;
    return { online, total: rows.length };
  }, [rows]);

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-bg`}
      >
        <div className="flex shrink-0 flex-col gap-2 border-b border-keep-border bg-keep-panel px-4 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <h2 className="font-action text-lg">{t("users.title")}</h2>
              <span className="text-xs text-keep-muted">
                {t("users.counts", { online: counts.online, shown: counts.total })}
              </span>
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("users.searchPlaceholder")}
              autoFocus
              className="flex-1 rounded border border-keep-border bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
            />
            <CloseButton onClick={onClose} />
          </div>
          {/* Filter + sort controls. Render even when the catalog
              hasn't loaded (the rank dropdown just shows "Any rank"
              and the user can still sort/search). */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1 text-keep-muted">
              <span className="uppercase tracking-widest">{t("users.rank")}</span>
              <select
                value={rankFilter}
                onChange={(e) => setRankFilter(e.target.value)}
                className="rounded border border-keep-border bg-keep-bg px-1.5 py-0.5 text-keep-text outline-none focus:border-keep-action"
              >
                <option value="">{t("users.anyRank")}</option>
                {ranks.map((r) => (
                  <option key={r.key} value={r.key}>{r.name}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-keep-muted">
              <span className="uppercase tracking-widest">{t("users.sort")}</span>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="rounded border border-keep-border bg-keep-bg px-1.5 py-0.5 text-keep-text outline-none focus:border-keep-action"
              >
                <option value="online">{t("users.sortOnline")}</option>
                <option value="messages">{t("users.sortMessages")}</option>
                <option value="joined">{t("users.sortJoined")}</option>
                <option value="name">{t("users.sortName")}</option>
              </select>
            </label>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error ? (
            <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
          ) : !rows ? (
            <div className="text-keep-muted">{t("users.loading")}</div>
          ) : rows.length === 0 ? (
            <div className="text-keep-muted">{t("users.noMatches")}</div>
          ) : (
            <ul className="space-y-2">
              {rows.map((u) => (
                <li key={u.userId} className="rounded border border-keep-border bg-keep-bg p-2">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenName(u.username)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-keep-panel"
                      title={t("actions.viewProfile", { name: u.username })}
                    >
                      {/* Rank gem replaces the gender icon when the
                          user has a rank, matching the in-chat rule.
                          Falls back to the gender glyph for unranked
                          accounts so the row is never icon-less. */}
                      {u.rankKey ? (
                        <RankSigil rankKey={u.rankKey} tier={u.rankTier} size="md" variant="gem" />
                      ) : (
                        <span aria-hidden style={{ color: genderGlyph(u.gender).color }}>{genderGlyph(u.gender).icon}</span>
                      )}
                      <span
                        className="truncate font-semibold"
                        style={u.chatColor ? { color: u.chatColor } : undefined}
                      >
                        {u.username}
                      </span>
                      {u.online ? (
                        <span className="ml-1 inline-block h-2 w-2 shrink-0 rounded-full bg-keep-action" title={t("users.online")} />
                      ) : (
                        <span className="ml-1 inline-block h-2 w-2 shrink-0 rounded-full bg-keep-muted/40" title={t("users.offline")} />
                      )}
                      {u.away ? (
                        <span
                          className="ml-1 shrink-0 rounded bg-keep-system/15 px-1 text-[10px] uppercase tracking-widest text-keep-system"
                          title={u.awayMessage ?? ""}
                        >
                          {t("users.away")}
                        </span>
                      ) : null}
                    </button>
                    <div className="flex shrink-0 items-center gap-2 text-[10px] text-keep-muted tabular-nums">
                      {/* Lifetime visible-post count. "0" still shows
                          (it IS information: this user has signed up
                          but never posted). */}
                      <span title={u.messageCount === null ? t("users.postsHidden") : t("users.postsLifetime")}>
                        {u.messageCount === null ? t("users.private") : t("users.postCount", { n: formatNumber(u.messageCount) })}
                      </span>
                      <span aria-hidden className="text-keep-rule">·</span>
                      <span>
                        {u.lastLoginAt
                          ? t("users.seen", { date: formatDate(u.lastLoginAt) })
                          : t("users.joined", { date: formatDate(u.createdAt) })}
                      </span>
                    </div>
                  </div>

                  {u.characters.length ? (
                    <ul className="mt-1 ml-5 space-y-0.5 border-l border-keep-rule/60 pl-3 text-xs">
                      {u.characters.map((c) => (
                        <li key={c.id} className="flex items-center gap-1.5">
                          <span className="text-keep-muted" aria-hidden>↳</span>
                          <button
                            type="button"
                            onClick={() => onOpenName(c.name)}
                            className={`rounded px-1 py-0.5 text-left hover:bg-keep-panel ${
                              c.id === u.activeCharacterId ? "font-semibold text-keep-action" : ""
                            }`}
                            title={
                              c.id === u.activeCharacterId
                                ? t("users.characterActive", { name: c.name })
                                : `${c.name}`
                            }
                          >
                            {c.name}
                          </button>
                          {c.id === u.activeCharacterId ? (
                            <span className="text-[10px] uppercase tracking-widest text-keep-action">{t("users.active")}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 border-t border-keep-border bg-keep-panel/40 p-2 text-[10px] text-keep-muted">
          {t("users.footer")}
        </div>
      </div>
    </Modal>
  );
}
