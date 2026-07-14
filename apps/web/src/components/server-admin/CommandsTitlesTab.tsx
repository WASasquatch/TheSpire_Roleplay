/**
 * Server Admin → Commands & Titles (Admin Partition — plan_ext.md §4).
 *
 * The per-server analog of the global admin Commands + Titles surfaces. A server
 * owner/mod manages THIS server's custom `!commands` and mutual-title kinds from
 * the Server Admin console, mirroring the global panel but scoped to one server.
 *
 * Two sections in one tab:
 *   - Commands — CRUD over this server's custom slash commands (gated server-side
 *     on `manage_commands`). Includes a READ-ONLY social-game (built-in command)
 *     panel: `builtin_command_config` is globally keyed (no server_id column
 *     yet), so per-server tuning has no storage and is surfaced read-only +
 *     clearly labelled. See the backend module's SOCIAL-GAME NOTE.
 *   - Titles — CRUD over this server's mutual-title kinds (gated server-side on
 *     `manage_titles`).
 *
 * House style mirrors the existing console tabs in ServerSettingsView.tsx:
 * inline fetch helpers (lib/servers.ts stays untouched), `keep-*` utility
 * classes, the shared `{ busy, run, onSaved }` action contract. The prop
 * contract is `{ serverId, viewer, busy, run, onSaved }` — the orchestrator
 * passes the active server's id directly.
 */
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ServerViewerState } from "@thekeep/shared";
import { i18n } from "../../lib/i18n.js";
import { safeCssColor } from "../shared/RoleBadgeChips.js";

/* ============================================================
 * Props (matches the console tab action contract; serverId passed directly).
 * ============================================================ */
interface CommandsTitlesTabProps {
  serverId: string;
  viewer: ServerViewerState;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}

/* ============================================================
 * Wire shapes (read-only off the documented /servers/:id endpoints).
 * ============================================================ */
interface CustomCmdRow {
  id: string;
  name: string;
  kind: "action" | "say";
  template: string;
  description: string | null;
  color: string | null;
  enabled: boolean;
  allowInline: boolean;
  inlineTemplate: string | null;
  css: string | null;
  aliases: string[];
}
interface CustomCmdInput {
  name: string;
  kind: "action" | "say";
  template: string;
  description?: string | null;
  aliases?: string[];
  enabled?: boolean;
  color?: string | null;
  allowInline?: boolean;
  inlineTemplate?: string | null;
  css?: string | null;
}
interface SocialGameRow {
  name: string;
  label: string;
  description: string;
  durationLabel: string;
  supportsReward: boolean;
  defaultDurationMs: number;
  defaultRewardXp: number;
  defaultRewardCurrency: number;
  hasConfig: boolean;
  rewardXp: number;
  rewardCurrency: number;
  rewardItemKey: string | null;
  rewardItemCount: number;
  durationMs: number | null;
}
/** One controllable command in the availability editor (built-in without its
 *  own staff permission gate, or this server's custom command). */
interface RuleCommandRow {
  name: string;
  aliases: string[];
  description: string;
  isCustom: boolean;
}
interface RuleGroupRow { id: string; name: string; color: string | null }
interface CommandRuleWire { command: string; mode: "disabled" | "roles"; roleIds: string[] }
type RuleMode = "everyone" | "disabled" | "roles";

interface TitleKindRow {
  id: string;
  slug: string;
  label: string;
  symmetric: boolean;
  formatA: string;
  formatB: string;
  exclusive: boolean;
  enabled: boolean;
  usageCount: number;
}
interface TitleKindInput {
  slug: string;
  label: string;
  symmetric: boolean;
  formatA: string;
  formatB: string;
  exclusive: boolean;
  enabled: boolean;
}

/* ============================================================
 * Inline fetch helpers (do NOT widen lib/servers.ts).
 * ============================================================ */
async function jsonOrThrow<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!r.ok) throw new Error(j?.error ?? i18n.t("errors:requestFailed", { status: r.status }));
  return j as T;
}
const sid = (id: string) => encodeURIComponent(id);

async function apiGetCommands(serverId: string): Promise<{ commands: CustomCmdRow[]; socialGames: SocialGameRow[]; socialGamesReadOnly: boolean }> {
  return jsonOrThrow(await fetch(`/servers/${sid(serverId)}/commands`, { credentials: "include" }));
}
async function apiCreateCommand(serverId: string, body: CustomCmdInput): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/commands`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiPatchCommand(serverId: string, cmdId: string, body: Partial<CustomCmdInput>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/commands/${sid(cmdId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiDeleteCommand(serverId: string, cmdId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/commands/${sid(cmdId)}`, { method: "DELETE", credentials: "include" }));
}
/** Set (or reset to inherited default) this server's social-game config. */
async function apiSetSocialGame(serverId: string, name: string, body: Record<string, unknown>): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/commands/social-games/${sid(name)}`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiGetCommandRules(serverId: string): Promise<{ commands: RuleCommandRow[]; groups: RuleGroupRow[]; rules: CommandRuleWire[] }> {
  return jsonOrThrow(await fetch(`/servers/${sid(serverId)}/command-rules`, { credentials: "include" }));
}
async function apiPutCommandRule(serverId: string, command: string, body: { mode: RuleMode; roleIds?: string[] }): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/command-rules/${sid(command)}`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiGetTitles(serverId: string): Promise<{ kinds: TitleKindRow[] }> {
  return jsonOrThrow(await fetch(`/servers/${sid(serverId)}/titles`, { credentials: "include" }));
}
async function apiCreateTitle(serverId: string, body: TitleKindInput): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/titles`, {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiPutTitle(serverId: string, kindId: string, body: TitleKindInput): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/titles/${sid(kindId)}`, {
    method: "PUT", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body),
  }));
}
async function apiDeleteTitle(serverId: string, kindId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/servers/${sid(serverId)}/titles/${sid(kindId)}`, { method: "DELETE", credentials: "include" }));
}

function formatMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/* ============================================================
 * Tab
 * ============================================================ */
export default function CommandsTitlesTab({ serverId, viewer, busy, run, onSaved }: CommandsTitlesTabProps) {
  const { t } = useTranslation("servers");
  const canCommands = viewer.isOwner || viewer.permissions.includes("manage_commands");
  const canTitles = viewer.isOwner || viewer.permissions.includes("manage_titles");
  return (
    <div className="space-y-6">
      {canCommands ? <CommandsSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} /> : null}
      {canCommands ? <CommandAvailabilitySection serverId={serverId} busy={busy} run={run} onSaved={onSaved} /> : null}
      {canTitles ? <TitlesSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} /> : null}
      {!canCommands && !canTitles ? (
        <p className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
          {t("commandsTab.noPermission")}
        </p>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Commands section
 * ============================================================ */
function CommandsSection({ serverId, busy, run, onSaved }: { serverId: string; busy: boolean; run: CommandsTitlesTabProps["run"]; onSaved: () => void }) {
  const { t } = useTranslation("servers");
  const [cmds, setCmds] = useState<CustomCmdRow[]>([]);
  const [games, setGames] = useState<SocialGameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomCmdRow | null>(null);
  const [adding, setAdding] = useState(false);

  async function reload() {
    setLoading(true);
    setErr(null);
    try {
      const j = await apiGetCommands(serverId);
      setCmds(j.commands);
      setGames(j.socialGames ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("shared.loadFailed"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [serverId]);

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="text-xs text-keep-muted sm:max-w-[60%]">
          <span className="mb-1 block text-sm font-semibold text-keep-text">{t("commandsTab.commandsHeading")}</span>
          {t("commandsTab.commandsBlurb")}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => { setAdding(true); setEditing(null); }}
          className="self-end rounded border border-keep-rule bg-keep-banner px-3 py-1 text-xs hover:bg-keep-banner/80 disabled:opacity-50 sm:self-auto"
        >
          {t("commandsTab.newCommand")}
        </button>
      </div>

      {err ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div> : null}

      {adding ? (
        <CommandForm
          mode="create"
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={(input) => run(async () => { await apiCreateCommand(serverId, input); setAdding(false); onSaved(); await reload(); })}
        />
      ) : null}

      {editing ? (
        <CommandForm
          mode="edit"
          initial={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={(input) => run(async () => { await apiPatchCommand(serverId, editing.id, input); setEditing(null); onSaved(); await reload(); })}
          onDelete={() => {
            if (!window.confirm(t("commandsTab.deleteCommandConfirm", { name: editing.name }))) return;
            void run(async () => { await apiDeleteCommand(serverId, editing.id); setEditing(null); onSaved(); await reload(); });
          }}
        />
      ) : null}

      {loading ? (
        <div className="text-xs text-keep-muted">{t("commandsTab.loading")}</div>
      ) : cmds.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">{t("commandsTab.noCommands")}</div>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[560px] text-xs">
            <thead className="bg-keep-banner/50 uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="px-2 py-1 text-left">{t("commandsTab.colName")}</th>
                <th className="px-2 py-1 text-left">{t("commandsTab.colKind")}</th>
                <th className="px-2 py-1 text-left">{t("commandsTab.colAliases")}</th>
                <th className="px-2 py-1 text-left">{t("commandsTab.colTemplate")}</th>
                <th className="px-2 py-1">{t("commandsTab.colOn")}</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {cmds.map((c) => (
                <tr key={c.id} className="border-t border-keep-rule">
                  <td className="px-2 py-1 font-mono">/{c.name}</td>
                  <td className="px-2 py-1">{c.kind}</td>
                  <td className="px-2 py-1 font-mono">{c.aliases.length ? c.aliases.map((a) => `/${a}`).join(" ") : "-"}</td>
                  <td className="max-w-xs truncate px-2 py-1" title={c.template}>{c.template}</td>
                  <td className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      disabled={busy}
                      onChange={() => void run(async () => { await apiPatchCommand(serverId, c.id, { enabled: !c.enabled }); onSaved(); await reload(); })}
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setEditing(c); setAdding(false); }}
                      className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
                    >
                      {t("shared.edit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SocialGamesPanel games={games} loading={loading} serverId={serverId} busy={busy} run={run}
        onSaved={() => { onSaved(); void reload(); }} />
    </section>
  );
}

/** Read-only social-game (built-in command) reward/duration panel. Per-server
 *  tuning has no storage yet (builtin_command_config is globally keyed), so the
 *  effective SHARED values are shown for reference and clearly marked. */
function SocialGamesPanel({ games, loading, serverId, busy, run, onSaved }: {
  games: SocialGameRow[];
  loading: boolean;
  serverId: string;
  busy: boolean;
  run: CommandsTitlesTabProps["run"];
  onSaved: () => void;
}) {
  const { t } = useTranslation("servers");
  if (loading) return null;
  if (!games.length) return null;
  return (
    <section className="mt-4 space-y-2 border-t border-keep-rule pt-4">
      <div className="text-xs text-keep-muted">
        <span className="mr-2 inline-block rounded border border-keep-action/60 bg-keep-action/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-keep-action">
          {t("commandsTab.socialGamesChip")}
        </span>
        {t("commandsTab.socialGamesBlurb")}
      </div>
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {games.map((g) => (
          <SocialGameCard key={g.name} game={g} serverId={serverId} busy={busy} run={run} onSaved={onSaved} />
        ))}
      </div>
    </section>
  );
}

/** Editable per-server config for one social game (duration + rewards). */
function SocialGameCard({ game: g, serverId, busy, run, onSaved }: {
  game: SocialGameRow;
  serverId: string;
  busy: boolean;
  run: CommandsTitlesTabProps["run"];
  onSaved: () => void;
}) {
  const { t } = useTranslation("servers");
  // Duration shown in SECONDS for friendliness; blank = inherit.
  const [durationSec, setDurationSec] = useState<string>(g.durationMs != null ? String(Math.round(g.durationMs / 1000)) : "");
  const [xp, setXp] = useState<string>(String(g.rewardXp));
  const [currency, setCurrency] = useState<string>(String(g.rewardCurrency));
  const [itemKey, setItemKey] = useState<string>(g.rewardItemKey ?? "");
  const [itemCount, setItemCount] = useState<string>(String(g.rewardItemCount || 0));

  function save() {
    void run(async () => {
      await apiSetSocialGame(serverId, g.name, {
        durationMs: durationSec.trim() === "" ? null : Math.max(1000, Math.round(Number(durationSec) * 1000)),
        ...(g.supportsReward ? {
          rewardXp: Math.max(0, Number(xp) || 0),
          rewardCurrency: Math.max(0, Number(currency) || 0),
          rewardItemKey: itemKey.trim() ? itemKey.trim() : null,
          rewardItemCount: Math.max(0, Number(itemCount) || 0),
        } : {}),
      });
      onSaved();
    });
  }
  function reset() {
    void run(async () => { await apiSetSocialGame(serverId, g.name, { reset: true }); onSaved(); });
  }

  const inputCls = "w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs outline-none focus:border-keep-action";
  return (
    <article className="flex flex-col gap-2 rounded border border-keep-rule bg-keep-bg/40 p-3 text-xs">
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="font-semibold">/{g.name} <span className="text-keep-muted">· {g.label}</span></h4>
        <span className="text-[10px] uppercase tracking-widest text-keep-muted">{g.hasConfig ? t("commandsTab.custom") : t("commandsTab.inherits")}</span>
      </header>
      <p className="text-[11px] text-keep-muted">{g.description}</p>
      <label className="block">
        <span className="mb-0.5 block text-[10px] uppercase tracking-widest text-keep-muted">{t("commandsTab.durationLabel", { label: g.durationLabel, default: formatMs(g.defaultDurationMs) })}</span>
        <input type="number" min={1} value={durationSec} onChange={(e) => setDurationSec(e.target.value)} placeholder={t("commandsTab.defaultPlaceholder")} className={`${inputCls} w-28`} />
      </label>
      {g.supportsReward ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className="mb-0.5 block text-[10px] uppercase tracking-widest text-keep-muted">{t("commandsTab.xpPerWinner")}</span>
            <input type="number" min={0} value={xp} onChange={(e) => setXp(e.target.value)} className={inputCls} /></label>
          <label className="block"><span className="mb-0.5 block text-[10px] uppercase tracking-widest text-keep-muted">{t("commandsTab.currencyPerWinner")}</span>
            <input type="number" min={0} value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls} /></label>
          <label className="block"><span className="mb-0.5 block text-[10px] uppercase tracking-widest text-keep-muted">{t("commandsTab.itemKeyLabel")}</span>
            <input value={itemKey} onChange={(e) => setItemKey(e.target.value)} placeholder={t("commandsTab.nonePlaceholder")} className={`${inputCls} font-mono`} /></label>
          <label className="block"><span className="mb-0.5 block text-[10px] uppercase tracking-widest text-keep-muted">{t("commandsTab.itemCountLabel")}</span>
            <input type="number" min={0} value={itemCount} onChange={(e) => setItemCount(e.target.value)} disabled={!itemKey.trim()} className={inputCls} /></label>
        </div>
      ) : (
        <p className="italic text-keep-muted">{t("commandsTab.rewardIgnored")}</p>
      )}
      <div className="flex justify-end gap-2">
        {g.hasConfig ? (
          <button type="button" disabled={busy} onClick={reset}
            className="rounded border border-keep-rule px-2 py-1 text-[10px] uppercase tracking-widest text-keep-muted hover:text-keep-text disabled:opacity-50">{t("commandsTab.reset")}</button>
        ) : null}
        <button type="button" disabled={busy} onClick={save}
          className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">{t("shared.save")}</button>
      </div>
    </article>
  );
}

function CommandForm({ mode, initial, busy, onSubmit, onCancel, onDelete }: {
  mode: "create" | "edit";
  initial?: CustomCmdRow;
  busy: boolean;
  onSubmit: (input: CustomCmdInput) => Promise<void> | void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation("servers");
  const KIND_PRESETS = {
    action: { template: "{sender} ", css: "font-style: italic", color: "theme:action" as string | null },
    say: { template: "[{sender}] ", css: "", color: null as string | null },
  } as const;
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKindRaw] = useState<"action" | "say">(initial?.kind ?? "action");
  const [template, setTemplate] = useState(initial?.template ?? KIND_PRESETS[initial?.kind ?? "action"].template);
  const [aliases, setAliases] = useState((initial?.aliases ?? []).join(" "));
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? KIND_PRESETS[initial?.kind ?? "action"].color);
  const [allowInline, setAllowInline] = useState<boolean>(initial?.allowInline ?? false);
  const [inlineTemplate, setInlineTemplate] = useState<string>(initial?.inlineTemplate ?? initial?.template ?? "");
  const [css, setCss] = useState<string>(initial?.css ?? KIND_PRESETS[initial?.kind ?? "action"].css);
  const [error, setError] = useState<string | null>(null);

  // Kind acts as a preset loader in create mode (seeds template/css/color while
  // they're still on the other kind's preset); edit mode only swaps the kind.
  function setKind(next: "action" | "say") {
    const prev = kind;
    setKindRaw(next);
    if (mode === "edit" || prev === next) return;
    const prevPreset = KIND_PRESETS[prev];
    const nextPreset = KIND_PRESETS[next];
    if (template.trim() === "" || template === prevPreset.template) setTemplate(nextPreset.template);
    if (css.trim() === "" || css === prevPreset.css) setCss(nextPreset.css);
    if (color === prevPreset.color) setColor(nextPreset.color);
  }

  function onToggleAllowInline(next: boolean) {
    if (next && !inlineTemplate.trim()) setInlineTemplate(template);
    setAllowInline(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const body: CustomCmdInput = { name: name.trim().toLowerCase(), kind, template };
      if (description.trim()) body.description = description.trim();
      const aliasList = aliases.split(/[\s,]+/).map((a) => a.replace(/^\//, "").trim().toLowerCase()).filter(Boolean);
      if (mode === "create" || aliasList.length || (initial?.aliases.length ?? 0) > 0) body.aliases = aliasList;
      if (mode === "create") {
        if (color) body.color = color;
      } else if (color !== (initial?.color ?? null)) {
        body.color = color;
      }
      if (mode === "create") {
        if (allowInline) {
          body.allowInline = true;
          if (inlineTemplate.trim()) body.inlineTemplate = inlineTemplate;
        }
      } else {
        if (allowInline !== (initial?.allowInline ?? false)) body.allowInline = allowInline;
        if (allowInline) {
          const initialInline = initial?.inlineTemplate ?? null;
          const nextInline = inlineTemplate.trim() ? inlineTemplate : null;
          if (nextInline !== initialInline) body.inlineTemplate = nextInline;
        }
      }
      if (mode === "create") {
        if (css.trim()) body.css = css.trim();
      } else {
        const initialCss = initial?.css ?? null;
        const nextCss = css.trim() ? css.trim() : null;
        if (nextCss !== initialCss) body.css = nextCss;
      }
      await onSubmit(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("shared.saveFailed"));
    }
  }

  return (
    <form onSubmit={submit} className="rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="truncate font-semibold">{mode === "create" ? t("commandsTab.newCommandTitle") : t("commandsTab.editCommandTitle", { name: initial?.name })}</div>
        <button type="button" onClick={onCancel} className="shrink-0 text-keep-muted hover:text-keep-text">{t("commandsTab.cancelLower")}</button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("commandsTab.colName")}</span>
          <input
            required value={name} onChange={(e) => setName(e.target.value)}
            placeholder={t("commandsTab.namePlaceholder")} maxLength={32} pattern="[a-zA-Z][a-zA-Z0-9_-]*"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
          />
        </label>
        <label>
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("commandsTab.colKind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as "action" | "say")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1">
            <option value="action">{t("commandsTab.kindAction")}</option>
            <option value="say">{t("commandsTab.kindSay")}</option>
          </select>
        </label>
        <label className="col-span-1 sm:col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("commandsTab.colTemplate")}</span>
          <textarea required value={template} onChange={(e) => setTemplate(e.target.value)} placeholder={t("commandsTab.templatePlaceholder")} rows={2} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono" />
        </label>
        <label className="col-span-1 sm:col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("commandsTab.descriptionLabel")}</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" />
        </label>
        <label className="col-span-1 sm:col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("commandsTab.aliasesLabel")}</span>
          <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder={t("commandsTab.aliasesPlaceholder")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono" />
        </label>
        <div className="col-span-1 flex items-start gap-2 sm:col-span-2">
          <input id={`allow-inline-${initial?.id ?? "new"}`} type="checkbox" checked={allowInline} onChange={(e) => onToggleAllowInline(e.target.checked)} className="mt-0.5" />
          <label htmlFor={`allow-inline-${initial?.id ?? "new"}`} className="flex-1">
            <span className="block uppercase tracking-widest text-keep-muted">{t("commandsTab.allowInline")}</span>
            <span className="block text-[10px] text-keep-muted"><Trans t={t} i18nKey="commandsTab.allowInlineHint" values={{ name: name || t("commandsTab.nameFallback") }} components={{ code: <code /> }} /></span>
          </label>
        </div>
        {allowInline ? (
          <label className="col-span-1 sm:col-span-2">
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("commandsTab.inlineTemplateLabel")}</span>
            <textarea value={inlineTemplate} onChange={(e) => setInlineTemplate(e.target.value)} placeholder={t("commandsTab.inlineTemplatePlaceholder")} rows={2} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono" />
          </label>
        ) : null}
        <label className="col-span-1 sm:col-span-2">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("commandsTab.cssLabel")}</span>
          <input value={css} onChange={(e) => setCss(e.target.value)} placeholder={t("commandsTab.cssPlaceholder")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono" />
          <span className="mt-0.5 block text-[10px] text-keep-muted">{t("commandsTab.cssHint")}</span>
        </label>
        <label className="col-span-1 sm:col-span-2 flex items-center gap-2">
          <input type="checkbox" checked={color === null} onChange={(e) => setColor(e.target.checked ? null : "#4a8a6a")} />
          <span className="uppercase tracking-widest text-keep-muted">{t("commandsTab.inheritColor")}</span>
          {color !== null ? (
            <input type="text" value={color} onChange={(e) => setColor(e.target.value)} placeholder={t("commandsTab.colorPlaceholder")} className="ml-2 w-40 rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono" />
          ) : null}
        </label>
      </div>

      {error ? <p className="mt-2 text-[11px] text-keep-accent">{error}</p> : null}

      <div className="mt-3 flex items-center justify-between">
        <div>
          {mode === "edit" && onDelete ? (
            <button type="button" disabled={busy} onClick={onDelete} className="rounded border border-keep-accent/60 bg-keep-bg px-3 py-1 text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50">{t("shared.delete")}</button>
          ) : null}
        </div>
        <button type="submit" disabled={busy} className="rounded border border-keep-action/60 bg-keep-action/10 px-3 py-1 font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20 disabled:opacity-50">
          {mode === "create" ? t("commandsTab.create") : t("shared.save")}
        </button>
      </div>
    </form>
  );
}

/* ============================================================
 * Command availability section (server_command_rules, migration 0355)
 * ============================================================ */

/** Per-server availability rules over the FULL command list (built-ins
 *  without their own staff gate + this server's custom commands): each row
 *  is Everyone / Specific roles / Off. Staff-gated builtins and /help +
 *  /report never appear — they can't be restricted. Zero rules = today's
 *  behavior; the blurb states the staff bypass and the zero-role fallback
 *  honestly. */
function CommandAvailabilitySection({ serverId, busy, run, onSaved }: { serverId: string; busy: boolean; run: CommandsTitlesTabProps["run"]; onSaved: () => void }) {
  const { t } = useTranslation("servers");
  const [data, setData] = useState<{ commands: RuleCommandRow[]; groups: RuleGroupRow[]; rules: CommandRuleWire[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    setErr(null);
    apiGetCommandRules(serverId)
      .then((j) => { if (alive) setData(j); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : t("shared.loadFailed")); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, tick]);

  const ruleByCommand = useMemo(() => {
    const m = new Map<string, CommandRuleWire>();
    for (const r of data?.rules ?? []) m.set(r.command, r);
    return m;
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase().replace(/^\//, "");
    if (!q) return data.commands;
    return data.commands.filter((c) =>
      c.name.includes(q)
      || c.aliases.some((a) => a.includes(q))
      || c.description.toLowerCase().includes(q));
  }, [data, query]);

  function save(command: string, mode: RuleMode, roleIds: string[]) {
    void run(async () => {
      // Refetch on failure too: the row's key derives from the fetched rule,
      // so reseeding from server truth reverts a select left showing a mode
      // the PUT never landed. The rejection still reaches run()'s error line.
      try {
        await apiPutCommandRule(serverId, command, mode === "roles" ? { mode, roleIds } : { mode });
        onSaved();
      } finally {
        setTick((n) => n + 1);
      }
    });
  }

  return (
    <section className="space-y-3 border-t border-keep-rule pt-5" data-admin-anchor="commandsTab.availability.heading">
      <div className="text-xs text-keep-muted sm:max-w-[80%]">
        <span className="mb-1 block text-sm font-semibold text-keep-text">{t("commandsTab.availability.heading")}</span>
        {t("commandsTab.availability.blurb")}{" "}
        <span className="text-keep-muted/90">{t("commandsTab.availability.staffNote")}</span>
      </div>

      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
          {err}{" "}
          <button type="button" onClick={() => setTick((n) => n + 1)} className="underline hover:text-keep-text">
            {t("commandsTab.availability.retry")}
          </button>
        </div>
      ) : null}

      {!data && !err ? <div className="text-xs text-keep-muted">{t("commandsTab.loading")}</div> : null}

      {data ? (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("commandsTab.availability.searchPlaceholder")}
            aria-label={t("commandsTab.availability.searchPlaceholder")}
            className="w-full max-w-xs rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs outline-none focus:border-keep-action"
          />
          {filtered.length === 0 ? (
            <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">
              {t("commandsTab.availability.noMatches")}
            </div>
          ) : (
            <ul className="divide-y divide-keep-rule/60 rounded border border-keep-rule bg-keep-bg/40">
              {filtered.map((c) => {
                const rule = ruleByCommand.get(c.name);
                return (
                  <CommandRuleRow
                    // Remount on every saved state change so local edits
                    // always reseed from the server's truth after a save.
                    key={`${c.name}:${rule ? `${rule.mode}:${rule.roleIds.join(",")}` : "everyone"}`}
                    cmd={c}
                    groups={data.groups}
                    rule={rule}
                    busy={busy}
                    onSave={(mode, roleIds) => save(c.name, mode, roleIds)}
                  />
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

/** One command's availability control. "Everyone" / "Off" save on pick;
 *  "Specific roles" expands the role chips + an explicit Save (blocked at
 *  zero roles, same convention as the room editor's role gates). */
function CommandRuleRow({ cmd, groups, rule, busy, onSave }: {
  cmd: RuleCommandRow;
  groups: RuleGroupRow[];
  rule: CommandRuleWire | undefined;
  busy: boolean;
  onSave: (mode: RuleMode, roleIds: string[]) => void;
}) {
  const { t } = useTranslation("servers");
  const savedMode: RuleMode = rule ? (rule.mode === "disabled" ? "disabled" : "roles") : "everyone";
  const [mode, setMode] = useState<RuleMode>(savedMode);
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set(rule?.roleIds ?? []));
  const rolesDirty = mode === "roles" && (savedMode !== "roles"
    || roleIds.size !== (rule?.roleIds.length ?? 0)
    || (rule?.roleIds ?? []).some((id) => !roleIds.has(id)));
  const needsRole = mode === "roles" && roleIds.size === 0;

  function pickMode(next: RuleMode) {
    setMode(next);
    // Everyone / Off apply immediately; roles waits for an explicit Save so
    // a half-picked chip set never hits the server.
    if (next !== "roles" && next !== savedMode) onSave(next, []);
  }

  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="font-mono text-xs text-keep-text">/{cmd.name}</span>
            {cmd.aliases.length ? (
              <span className="font-mono text-[10px] text-keep-muted">{cmd.aliases.map((a) => `/${a}`).join(" ")}</span>
            ) : null}
            {cmd.isCustom ? (
              <span className="rounded border border-keep-action/60 bg-keep-action/10 px-1 py-px text-[9px] font-semibold uppercase tracking-widest text-keep-action">
                {t("commandsTab.availability.customChip")}
              </span>
            ) : null}
          </div>
          {cmd.description ? (
            <p className="truncate text-[11px] text-keep-muted" title={cmd.description}>{cmd.description}</p>
          ) : null}
        </div>
        <select
          value={mode}
          disabled={busy}
          onChange={(e) => pickMode(e.target.value as RuleMode)}
          aria-label={t("commandsTab.availability.controlAria", { name: cmd.name })}
          className="shrink-0 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
        >
          <option value="everyone">{t("commandsTab.availability.everyone")}</option>
          <option value="roles">{t("commandsTab.availability.roles")}</option>
          <option value="disabled">{t("commandsTab.availability.off")}</option>
        </select>
      </div>
      {mode === "roles" ? (
        <div className="mt-1.5">
          {groups.length === 0 ? (
            <p className="text-[10px] italic text-keep-muted">{t("console.rooms.roleGates.noGroups")}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("commandsTab.availability.roles")}>
              {groups.map((g) => {
                const color = safeCssColor(g.color);
                const checked = roleIds.has(g.id);
                return (
                  <label
                    key={g.id}
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-xs ${
                      checked
                        ? "border-keep-action bg-keep-action/10 text-keep-text"
                        : "border-keep-rule bg-keep-bg text-keep-muted hover:border-keep-action/60 hover:text-keep-text"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-3 w-3"
                      checked={checked}
                      onChange={() => setRoleIds((cur) => {
                        const next = new Set(cur);
                        if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
                        return next;
                      })}
                    />
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full bg-keep-muted/60"
                      style={color ? { background: color } : undefined}
                    />
                    {g.name}
                  </label>
                );
              })}
            </div>
          )}
          {/* Zero roles on the server: the noGroups line above is the only
              guidance — "check at least one role" would be impossible to
              follow with no chips rendered. */}
          {groups.length === 0 ? null : needsRole ? (
            <span className="mt-1 block text-[10px] text-keep-accent/90">{t("commandsTab.availability.needsRole")}</span>
          ) : (
            <span className="mt-1 block text-[10px] text-keep-muted">{t("commandsTab.availability.zeroRoleFallback")}</span>
          )}
          {rolesDirty ? (
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                disabled={busy || needsRole}
                onClick={() => onSave("roles", [...roleIds])}
                className="rounded border border-keep-action bg-keep-action px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
              >
                {t("shared.save")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/* ============================================================
 * Titles section
 * ============================================================ */
function TitlesSection({ serverId, busy, run, onSaved }: { serverId: string; busy: boolean; run: CommandsTitlesTabProps["run"]; onSaved: () => void }) {
  const { t } = useTranslation("servers");
  const [kinds, setKinds] = useState<TitleKindRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TitleKindRow | null>(null);
  const [adding, setAdding] = useState(false);

  async function reload() {
    setLoading(true);
    setErr(null);
    try {
      const j = await apiGetTitles(serverId);
      setKinds(j.kinds);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("shared.loadFailed"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [serverId]);

  return (
    <section className="space-y-3 border-t border-keep-rule pt-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="text-xs text-keep-muted sm:max-w-[60%]">
          <span className="mb-1 block text-sm font-semibold text-keep-text">{t("commandsTab.titlesHeading")}</span>
          <Trans
            t={t}
            i18nKey="commandsTab.titlesBlurb"
            values={{ cmd: "/request <slug> <user>", target: "{target}" }}
            components={{ code: <code /> }}
          />
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => { setAdding(true); setEditing(null); }}
          className="self-end rounded border border-keep-rule bg-keep-banner px-3 py-1 text-xs hover:bg-keep-banner/80 disabled:opacity-50 sm:self-auto"
        >
          {t("commandsTab.newTitleKind")}
        </button>
      </div>

      {err ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div> : null}

      {adding ? (
        <TitleKindForm
          mode="create"
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={(input) => run(async () => { await apiCreateTitle(serverId, input); setAdding(false); onSaved(); await reload(); })}
        />
      ) : null}

      {editing ? (
        <TitleKindForm
          mode="edit"
          initial={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={(input) => run(async () => { await apiPutTitle(serverId, editing.id, input); setEditing(null); onSaved(); await reload(); })}
          onDelete={() => {
            const msg = editing.usageCount > 0
              ? t("commandsTab.deleteKindInUseConfirm", { n: editing.usageCount })
              : t("commandsTab.deleteKindConfirm");
            if (!window.confirm(msg)) return;
            void run(async () => { await apiDeleteTitle(serverId, editing.id); setEditing(null); onSaved(); await reload(); });
          }}
        />
      ) : null}

      {loading ? (
        <div className="text-xs text-keep-muted">{t("commandsTab.loading")}</div>
      ) : kinds.length === 0 ? (
        <div className="rounded border border-keep-rule bg-keep-bg p-4 text-center text-sm text-keep-muted">{t("commandsTab.noTitleKinds")}</div>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="bg-keep-banner/50 uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="px-2 py-1 text-left">{t("commandsTab.colSlug")}</th>
                <th className="px-2 py-1 text-left">{t("commandsTab.colLabel")}</th>
                <th className="px-2 py-1 text-left">{t("commandsTab.colASide")}</th>
                <th className="px-2 py-1 text-left">{t("commandsTab.colBSide")}</th>
                <th className="px-2 py-1">{t("commandsTab.colExcl")}</th>
                <th className="px-2 py-1">{t("commandsTab.colInUse")}</th>
                <th className="px-2 py-1">{t("commandsTab.colOn")}</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((k) => (
                <tr key={k.id} className="border-t border-keep-rule">
                  <td className="px-2 py-1 font-mono">{k.slug}</td>
                  <td className="px-2 py-1">{k.label}</td>
                  <td className="max-w-[180px] truncate px-2 py-1" title={k.formatA}>{k.formatA}</td>
                  <td className="max-w-[180px] truncate px-2 py-1" title={k.formatB}>
                    {k.symmetric ? <span className="italic text-keep-muted">{t("commandsTab.same")}</span> : k.formatB}
                  </td>
                  <td className="px-2 py-1 text-center">{k.exclusive ? "✓" : ""}</td>
                  <td className="px-2 py-1 text-center tabular-nums">{k.usageCount}</td>
                  <td className="px-2 py-1 text-center">{k.enabled ? "✓" : ""}</td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setEditing(k); setAdding(false); }}
                      className="mr-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner disabled:opacity-50"
                    >
                      {t("shared.edit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TitleKindForm({ mode, initial, busy, onSubmit, onCancel, onDelete }: {
  mode: "create" | "edit";
  initial?: TitleKindRow;
  busy: boolean;
  onSubmit: (input: TitleKindInput) => Promise<void> | void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation("servers");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [symmetric, setSymmetric] = useState(initial?.symmetric ?? true);
  const [formatA, setFormatA] = useState(initial?.formatA ?? t("commandsTab.formatAPlaceholder"));
  const [formatB, setFormatB] = useState(initial?.formatB ?? t("commandsTab.formatAPlaceholder"));
  const [exclusive, setExclusive] = useState(initial?.exclusive ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await onSubmit({
        slug: slug.trim().toLowerCase(),
        label: label.trim(),
        symmetric,
        formatA: formatA.trim(),
        formatB: symmetric ? formatA.trim() : formatB.trim(),
        exclusive,
        enabled,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("shared.saveFailed"));
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-rule bg-keep-bg p-3 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="truncate font-semibold">{mode === "create" ? t("commandsTab.newTitleKindTitle") : t("commandsTab.editTitleKindTitle", { slug: initial?.slug })}</div>
        <button type="button" onClick={onCancel} className="shrink-0 text-keep-muted hover:text-keep-text">{t("commandsTab.cancelLower")}</button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <div className="uppercase tracking-widest text-keep-muted">{t("commandsTab.colSlug")}</div>
          <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t("commandsTab.slugPlaceholder")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono" required />
        </label>
        <label className="space-y-1">
          <div className="uppercase tracking-widest text-keep-muted">{t("commandsTab.colLabel")}</div>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("commandsTab.labelPlaceholder")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1" required />
        </label>
      </div>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={symmetric} onChange={(e) => setSymmetric(e.target.checked)} />
        <span>{t("commandsTab.symmetricLabel")}</span>
      </label>

      <label className="block space-y-1">
        <div className="uppercase tracking-widest text-keep-muted">{symmetric ? t("commandsTab.displayFormat") : t("commandsTab.aSideLabel")}</div>
        <input type="text" value={formatA} onChange={(e) => setFormatA(e.target.value)} placeholder={t("commandsTab.formatAPlaceholder")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono" required />
        <div className="text-[10px] text-keep-muted">{t("commandsTab.targetHint")}</div>
      </label>

      {!symmetric ? (
        <label className="block space-y-1">
          <div className="uppercase tracking-widest text-keep-muted">{t("commandsTab.bSideLabel")}</div>
          <input type="text" value={formatB} onChange={(e) => setFormatB(e.target.value)} placeholder={t("commandsTab.formatBPlaceholder")} className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono" required />
        </label>
      ) : null}

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} />
          <span>{t("commandsTab.exclusiveLabel")}</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t("shared.enabled")}</span>
        </label>
      </div>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{error}</div> : null}

      <div className="flex items-center justify-between pt-1">
        <div>
          {mode === "edit" && onDelete ? (
            <button type="button" disabled={busy} onClick={onDelete} className="rounded border border-keep-accent/60 bg-keep-bg px-3 py-1 text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50">{t("shared.delete")}</button>
          ) : null}
        </div>
        <button type="submit" disabled={busy} className="rounded border border-keep-action/60 bg-keep-action/10 px-3 py-1 font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/20 disabled:opacity-50">
          {mode === "create" ? t("commandsTab.create") : t("shared.save")}
        </button>
      </div>
    </form>
  );
}
