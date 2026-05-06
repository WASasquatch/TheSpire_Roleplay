import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandDoc } from "@thekeep/shared";

interface Props {
  /** Initial filter — pre-fills the search box (e.g. /help char). */
  initialFilter?: string;
  onClose: () => void;
}

/**
 * Help modal — searchable command reference with subcommand details.
 *
 * Replaces the previous /help toast which auto-dismissed and had no detail.
 * Lists every built-in + every enabled custom command from GET /commands;
 * an active filter is matched against name, aliases, descriptions, and
 * subcommand verbs/usage so users can find by example.
 */
export function HelpModal({ initialFilter, onClose }: Props) {
  const [commands, setCommands] = useState<CommandDoc[] | null>(null);
  const [filter, setFilter] = useState(initialFilter ?? "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/commands", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<{ commands: CommandDoc[] }>;
      })
      .then((j) => { if (!cancelled) setCommands(j.commands); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, []);

  // Focus the search input on open so / typing into the modal just works.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    if (!commands) return [];
    const q = filter.trim().toLowerCase().replace(/^\//, "");
    if (!q) return commands;
    return commands.filter((c) => {
      if (c.name.includes(q)) return true;
      if (c.aliases.some((a) => a.includes(q))) return true;
      if (c.description.toLowerCase().includes(q)) return true;
      if (c.usage.toLowerCase().includes(q)) return true;
      for (const s of c.subcommands) {
        if (s.verb.toLowerCase().includes(q)) return true;
        if (s.usage.toLowerCase().includes(q)) return true;
        if (s.description.toLowerCase().includes(q)) return true;
        if (s.aliases.some((a) => a.toLowerCase().includes(q))) return true;
      }
      return false;
    });
  }, [commands, filter]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[90vh] w-[min(900px,98vw)] flex-col rounded border border-keep-border bg-keep-bg shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-keep-border bg-keep-panel px-4 py-2">
          <h2 className="font-action text-lg">Commands</h2>
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search commands, aliases, subcommands…"
            className="flex-1 rounded border border-keep-border bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
          />
          <button onClick={onClose} className="text-sm text-keep-muted hover:text-keep-text">close</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error ? (
            <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
          ) : !commands ? (
            <div className="text-keep-muted">loading…</div>
          ) : filtered.length === 0 ? (
            <div className="text-keep-muted">no matches.</div>
          ) : (
            <ul className="space-y-2">
              {filtered.map((c) => (
                <CommandCard key={c.name} cmd={c} />
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 space-y-0.5 border-t border-keep-border bg-keep-panel/40 p-2 text-[10px] text-keep-muted">
          <div>
            Mention someone in chat by typing <code className="text-keep-action">@username</code> — clickable, opens their active profile.
          </div>
          <div>
            Tip: <code>/help char</code> jumps right here. Press <kbd className="rounded border border-keep-border bg-keep-bg px-1">Esc</kbd> to close.
          </div>
        </div>
      </div>
    </div>
  );
}

function CommandCard({ cmd }: { cmd: CommandDoc }) {
  return (
    <li className="rounded border border-keep-border bg-keep-bg p-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono font-bold text-keep-action">/{cmd.name}</span>
          {cmd.isCustom ? (
            <span className="rounded bg-keep-action/20 px-1 text-[10px] uppercase tracking-widest text-keep-action">custom</span>
          ) : null}
        </div>
        {cmd.aliases.length ? (
          <div className="font-mono text-keep-muted">
            also: {cmd.aliases.map((a) => `/${a}`).join(" ")}
          </div>
        ) : null}
      </div>

      <div className="mt-1 font-mono text-[11px] text-keep-text">{cmd.usage}</div>
      {cmd.description ? (
        <div className="mt-1 text-keep-muted">{cmd.description}</div>
      ) : null}

      {cmd.subcommands.length ? (
        <table className="mt-2 w-full text-[11px]">
          <tbody>
            {cmd.subcommands.map((s, i) => (
              <tr key={`${s.verb}-${i}`} className="align-top">
                <td className="w-24 py-0.5 pr-2 font-mono text-keep-action">{s.verb}</td>
                <td className="py-0.5">
                  <div className="font-mono">{s.usage}</div>
                  <div className="text-keep-muted">{s.description}</div>
                  {s.aliases.length ? (
                    <div className="mt-0.5 font-mono text-[10px] text-keep-muted">
                      aliases: {s.aliases.join(", ")}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </li>
  );
}
