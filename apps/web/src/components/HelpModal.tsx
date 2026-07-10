import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { CommandDoc } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { FormattingHelp } from "./FormattingHelp.js";
import { HelpGuides } from "./HelpGuides.js";
import { TabBtn } from "./shared/TabBtn.js";
import { FloatingWindow } from "./shared/FloatingWindow.js";

interface Props {
  /** Initial filter - pre-fills the search box (e.g. /help char). */
  initialFilter?: string;
  /** Open straight to the Guides tab and scroll to this guide id. */
  initialGuide?: string;
  onClose: () => void;
}

type HelpTab = "guides" | "commands" | "formatting";

/**
 * Help modal - searchable command reference with subcommand details.
 *
 * Replaces the previous /help toast which auto-dismissed and had no detail.
 * Lists every built-in + every enabled custom command from GET /commands;
 * an active filter is matched against name, aliases, descriptions, and
 * subcommand verbs/usage so users can find by example.
 */
export function HelpModal({ initialFilter, initialGuide, onClose }: Props) {
  const { t } = useTranslation("help");
  // /help <something> jumps straight to the Commands tab so the filter applies;
  // an explicit guide deep-link opens on Guides; bare /help opens on Guides
  // since most newcomers want concept walkthroughs before slash commands.
  const [tab, setTab] = useState<HelpTab>(initialGuide ? "guides" : initialFilter ? "commands" : "guides");
  const [commands, setCommands] = useState<CommandDoc[] | null>(null);
  const [filter, setFilter] = useState(initialFilter ?? "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keyed on `commandsVersion` so the App-level listener for the
  // server's `commands:updated` broadcast forces a refetch when an
  // admin edits a custom command while this modal is already open
  // (or about to open). Without the key, a freshly-added command
  // wouldn't show up in the help list until a full tab reload.
  const commandsVersion = useChat((s) => s.commandsVersion);

  // Lets a returning player replay the first-run interface walkthrough on
  // demand. Closes this modal, then flips the shared flag the site tour
  // watches so the spotlight overlay opens over the live chat.
  const setSiteTourForced = useChat((s) => s.setSiteTourForced);
  function replayTour() {
    onClose();
    setSiteTourForced(true);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/commands", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(t("modal.loadStatus", { status: r.status }));
        return r.json() as Promise<{ commands: CommandDoc[] }>;
      })
      .then((j) => { if (!cancelled) setCommands(j.commands); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : t("modal.loadFailed")); });
    return () => { cancelled = true; };
  }, [commandsVersion]);

  // Focus the search input on open so / typing into the modal just works.
  // Only fires on the Commands tab - the Formatting tab has no search box.
  useEffect(() => {
    if (tab === "commands") inputRef.current?.focus();
  }, [tab]);

  const filtered = useMemo(() => {
    if (!commands) return [];
    const q = filter.trim().toLowerCase().replace(/^\//, "");
    if (!q) return commands;
    // Score each command by best-matching field. Lower = better. The
    // previous implementation was a plain `.filter()` that left results
    // in catalog order, so searching "request" surfaced /accept,
    // /decline, /dissolve (which mention "request" in their description)
    // BEFORE /request itself. Now exact-name matches always win, then
    // name-prefix, then name-substring, then aliases, then subcommands,
    // then description/usage hits as the long-tail fallback.
    function scoreCommand(c: CommandDoc): number {
      const name = c.name.toLowerCase();
      if (name === q) return 0;
      if (name.startsWith(q)) return 1;
      const aliasExact = c.aliases.some((a) => a.toLowerCase() === q);
      if (aliasExact) return 2;
      if (name.includes(q)) return 3;
      const aliasPrefix = c.aliases.some((a) => a.toLowerCase().startsWith(q));
      if (aliasPrefix) return 4;
      const aliasContains = c.aliases.some((a) => a.toLowerCase().includes(q));
      if (aliasContains) return 5;
      // Subcommand verb hits: exact / prefix / substring.
      let bestSub = Infinity;
      for (const s of c.subcommands) {
        const verb = s.verb.toLowerCase();
        if (verb === q) bestSub = Math.min(bestSub, 6);
        else if (verb.startsWith(q)) bestSub = Math.min(bestSub, 7);
        else if (verb.includes(q)) bestSub = Math.min(bestSub, 8);
        else if (s.aliases.some((a) => a.toLowerCase() === q)) bestSub = Math.min(bestSub, 8);
        else if (s.usage.toLowerCase().includes(q)) bestSub = Math.min(bestSub, 9);
        else if (s.description.toLowerCase().includes(q)) bestSub = Math.min(bestSub, 9);
      }
      if (bestSub < Infinity) return bestSub;
      if (c.usage.toLowerCase().includes(q)) return 10;
      if (c.description.toLowerCase().includes(q)) return 11;
      return Infinity;
    }
    const scored: Array<{ c: CommandDoc; score: number; idx: number }> = [];
    commands.forEach((c, idx) => {
      const score = scoreCommand(c);
      if (score < Infinity) scored.push({ c, score, idx });
    });
    // Stable sort by score asc, then original index asc so ties keep
    // catalog order (alphabetical, presumably) instead of shuffling.
    scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
    return scored.map((s) => s.c);
  }, [commands, filter]);

  return (
    <FloatingWindow onClose={onClose} zIndex={50} title={t("modal.title")} className="keep-frame rounded bg-keep-bg">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-keep-border bg-keep-panel px-4 py-2">
          <nav className="flex gap-1 text-xs uppercase tracking-widest">
            <TabBtn variant="panel" active={tab === "guides"} onClick={() => setTab("guides")}>
              {t("modal.tabs.guides")}
            </TabBtn>
            <TabBtn variant="panel" active={tab === "commands"} onClick={() => setTab("commands")}>
              {t("modal.tabs.commands")}
            </TabBtn>
            <TabBtn variant="panel" active={tab === "formatting"} onClick={() => setTab("formatting")}>
              {t("modal.tabs.formatting")}
            </TabBtn>
          </nav>
          {tab === "commands" ? (
            <input
              ref={inputRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("modal.searchPlaceholder")}
              className="min-w-0 flex-1 rounded border border-keep-border bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
            />
          ) : (
            <div className="flex flex-1 justify-end">
              {tab === "guides" ? (
                <button
                  type="button"
                  onClick={replayTour}
                  title={t("modal.takeTourTitle")}
                  className="rounded border border-keep-action/50 bg-keep-action/10 px-2 py-1 text-xs font-action uppercase tracking-widest text-keep-action hover:bg-keep-action/20"
                >
                  {t("modal.takeTour")}
                </button>
              ) : null}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === "commands" ? (
            error ? (
              <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
            ) : !commands ? (
              <div className="text-keep-muted">{t("modal.loading")}</div>
            ) : filtered.length === 0 ? (
              <div className="text-keep-muted">{t("modal.noMatches")}</div>
            ) : (
              <ul className="space-y-2">
                {filtered.map((c) => (
                  <CommandCard key={c.name} cmd={c} />
                ))}
              </ul>
            )
          ) : tab === "formatting" ? (
            <FormattingHelp />
          ) : (
            <HelpGuides {...(initialGuide ? { initialGuide } : {})} />
          )}
        </div>

        <div className="shrink-0 space-y-0.5 border-t border-keep-border bg-keep-panel/40 p-2 text-[10px] text-keep-muted">
          <div>
            <Trans t={t} i18nKey="modal.footerMention">
              Mention someone in chat by typing <code className="text-keep-action">@username</code> - clickable, opens their active profile.
            </Trans>
          </div>
          <div>
            {/* No Esc mention: the desktop window deliberately ignores
                Escape (workspace, not dialog) — close lives on the bar. */}
            <Trans t={t} i18nKey="modal.footerTip">
              Tip: <code>/help char</code> jumps right here.
            </Trans>
          </div>
        </div>
      </div>
    </FloatingWindow>
  );
}


function CommandCard({ cmd }: { cmd: CommandDoc }) {
  const { t } = useTranslation("help");
  return (
    <li className="rounded border border-keep-border bg-keep-bg p-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono font-bold text-keep-action">/{cmd.name}</span>
          {cmd.isCustom ? (
            <span className="rounded bg-keep-action/20 px-1 text-[10px] uppercase tracking-widest text-keep-action">{t("commands.customBadge")}</span>
          ) : null}
        </div>
        {cmd.aliases.length ? (
          <div className="font-mono text-keep-muted">
            {t("commands.also", { aliases: cmd.aliases.map((a) => `/${a}`).join(" ") })}
          </div>
        ) : null}
      </div>

      <div className="mt-1 font-mono text-[11px] text-keep-text">{cmd.usage}</div>
      {cmd.description ? (
        <div className="mt-1 text-keep-muted">{cmd.description}</div>
      ) : null}

      {cmd.subcommands.length ? (
        <div className="mt-2 rounded border border-keep-rule/40 bg-keep-panel/30">
          <div className="border-b border-keep-rule/40 px-2 py-1 text-[10px] uppercase tracking-widest text-keep-muted">
            {t("commands.options")}
          </div>
          <table className="w-full text-[11px]">
            <tbody>
              {cmd.subcommands.map((s, i) => (
                <tr key={`${s.verb}-${i}`} className="border-t border-keep-rule/20 align-top first:border-t-0">
                  {/* whitespace-nowrap so a long placeholder verb like
                      "(no args, away)" doesn't wrap and squash the description */}
                  <td className="whitespace-nowrap py-1 pl-2 pr-3 font-mono text-keep-action">{s.verb}</td>
                  <td className="py-1 pr-2">
                    <div className="font-mono">{s.usage}</div>
                    <div className="text-keep-muted">{s.description}</div>
                    {s.aliases.length ? (
                      <div className="mt-0.5 font-mono text-[10px] text-keep-muted">
                        {t("commands.aliases", { aliases: s.aliases.join(", ") })}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </li>
  );
}
