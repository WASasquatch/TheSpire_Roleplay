/**
 * Admin > Earning > Awards tab.
 *
 * Phase 1 ships the Awards editor only — every numeric value the
 * engine reads from `site_settings.earning_config_json`. Future
 * phases will add Ranks / Name Styles / Cosmetics tabs in this same
 * file (kept off the AdminPanel.tsx mega-file for sanity).
 *
 * Tier policy:
 *   - All fields are visible to both `admin` and `masteradmin`.
 *   - The two masteradmin-only fields (`multiCharacterEarnDivisor`,
 *     `backfill.xpPerHistoricalMessage`) are disabled for plain
 *     admins with an inline explainer. The server's PUT handler
 *     enforces the gate independently — this is just the UI mirror.
 *
 * Save behavior: the form maintains a local draft, and Save submits
 * the full document. The server returns the normalized config which
 * we feed back into the draft. Defaults are exposed via a "Reset to
 * defaults" affordance using the `defaults` slice the GET returns.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { isMasterAdminRole } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { useEarning } from "../state/earning.js";
import {
  adminGrantBorder,
  adminGrantCurrency,
  adminGrantStyle,
  adminGrantXp,
  adminSetRank,
  createAdminNameStyle,
  createAdminRank,
  deleteAdminNameStyle,
  deleteAdminRank,
  deleteAdminTier,
  fetchAdminAwards,
  fetchAdminCosmetics,
  fetchAdminNameStyles,
  fetchAdminRanks,
  patchAdminCosmetic,
  patchAdminNameStyle,
  patchAdminRank,
  patchAdminTier,
  putAdminAwards,
  uploadRankAsset,
  type AdminCosmeticRow,
  type AdminNameStyleRow,
  type AdminRankRow,
  type AdminTierRow,
  type AwardAmount,
  type SourceEnableFlags,
  type EarningConfig,
} from "../lib/earning.js";
import { StyledName } from "./StyledName.js";
import { injectNameStyles } from "../lib/nameStyleInjector.js";

type SubTab = "awards" | "ranks" | "styles" | "cosmetics" | "grants";

/** Single source of truth for the Earning sub-sections. Order here is
 *  used by both the desktop button strip and the mobile dropdown. The
 *  `masterOnly` flag mirrors the role check below — plain admins don't
 *  see "Test grants" in either picker. */
const SUB_TABS: ReadonlyArray<{ id: SubTab; label: string; masterOnly?: boolean }> = [
  { id: "awards", label: "Awards" },
  { id: "ranks", label: "Ranks" },
  { id: "styles", label: "Name Styles" },
  { id: "cosmetics", label: "Cosmetics" },
  { id: "grants", label: "Test grants", masterOnly: true },
];

export function AdminEarningTab() {
  const isMaster = useChat((s) => isMasterAdminRole(s.me?.role ?? "user"));
  const [subTab, setSubTab] = useState<SubTab>("awards");
  const visible = SUB_TABS.filter((t) => !t.masterOnly || isMaster);
  return (
    <div className="space-y-3">
      {/* Mobile: dropdown picker, same pattern as the top-level admin
          panel tab picker — saves horizontal space and avoids the
          off-screen-wrap problem with a row of chips. */}
      <div className="border-b border-keep-rule pb-2 md:hidden">
        <select
          value={subTab}
          onChange={(e) => setSubTab(e.target.value as SubTab)}
          aria-label="Earning section"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        >
          {visible.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </div>
      {/* Desktop: row of chips, wraps if needed. */}
      <div className="hidden flex-wrap gap-2 border-b border-keep-rule pb-2 text-xs uppercase tracking-widest md:flex">
        {visible.map((t) => (
          <SubTabBtn key={t.id} active={subTab === t.id} onClick={() => setSubTab(t.id)}>{t.label}</SubTabBtn>
        ))}
      </div>
      {subTab === "awards" ? <AwardsSection /> : null}
      {subTab === "ranks" ? <RanksSection /> : null}
      {subTab === "styles" ? <NameStylesSection /> : null}
      {subTab === "cosmetics" ? <CosmeticsSection /> : null}
      {subTab === "grants" && isMaster ? <TestGrantsSection /> : null}
    </div>
  );
}

function SubTabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border border-keep-rule px-2 py-0.5 ${active ? "bg-keep-bg" : "bg-keep-banner/40 hover:bg-keep-banner"}`}
    >
      {children}
    </button>
  );
}

function AwardsSection() {
  const isMaster = useChat((s) => isMasterAdminRole(s.me?.role ?? "user"));
  const [config, setConfig] = useState<EarningConfig | null>(null);
  const [defaults, setDefaults] = useState<EarningConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gatedFields, setGatedFields] = useState<string[]>([]);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAdminAwards()
      .then((r) => {
        if (cancelled) return;
        setConfig(r.config);
        setDefaults(r.defaults);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load Awards");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const dirty = useMemo(() => {
    if (!config || !defaults) return false;
    return JSON.stringify(config) !== JSON.stringify(defaults);
  }, [config, defaults]);

  async function save() {
    if (!config) return;
    setSaving(true);
    setErr(null);
    setGatedFields([]);
    try {
      const result = await putAdminAwards(config);
      setConfig(result.config);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Save failed";
      const fields = (e as Error & { fields?: string[] }).fields;
      setErr(message);
      if (fields) setGatedFields(fields);
    } finally {
      setSaving(false);
    }
  }

  function resetToDefaults() {
    if (!defaults) return;
    if (!window.confirm("Reset Awards to defaults? Any unsaved changes will be discarded.")) return;
    setConfig({ ...defaults });
  }

  if (loading) return <p className="text-sm text-keep-muted">Loading Awards…</p>;
  if (!config) return <p className="text-sm text-keep-accent">{err ?? "Failed to load Awards."}</p>;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h3 className="font-action text-base">Awards</h3>
        <p className="text-xs text-keep-muted">
          Every numeric value the XP / Currency engine reads. Changes take effect on the next earn.
          Body floor and whisper amounts apply per message; presence amounts are per 5-minute block.
        </p>
      </header>

      <section className="rounded border border-keep-rule bg-keep-bg/40 p-3">
        <ToggleRow
          label="Earning enabled"
          help="Master kill-switch for the entire XP / Currency system. When off, no source awards anything."
          value={config.enabled}
          onChange={(v) => setConfig({ ...config, enabled: v })}
        />
      </section>

      <SectionFrame title="Per-source enable matrix"
        description="Toggle XP and Currency awards independently for each source. Either flag off → that pool earns zero from that source even if the amount below is non-zero.">
        <SourceMatrix
          flags={config.enabledSources}
          onChange={(next) => setConfig({ ...config, enabledSources: next })}
        />
      </SectionFrame>

      <SectionFrame title="Award amounts"
        description="Per-message and per-block credit amounts.">
        <div className="space-y-3">
          <SourceGroup
            heading="Chat messages"
            rows={[
              { key: "say", label: "Say (regular chat)" },
              { key: "action", label: "Action (/me, /scene, /npc, /announce)" },
              { key: "whisper", label: "Whisper (private)" },
            ]}
            values={config.awards.message}
            onChange={(next) => setConfig({ ...config, awards: { ...config.awards, message: next } })}
          />
          <SourceGroup
            heading="Forum posts"
            rows={[
              { key: "topic", label: "New topic" },
              { key: "reply", label: "Reply" },
            ]}
            values={config.awards.forum}
            onChange={(next) => setConfig({ ...config, awards: { ...config.awards, forum: next } })}
          />
          <SourceGroup
            heading="Presence"
            rows={[
              { key: "perBlock", label: "Per active 5-min block" },
            ]}
            values={config.awards.presence}
            onChange={(next) => setConfig({ ...config, awards: { ...config.awards, presence: next } })}
          />
        </div>
      </SectionFrame>

      <SectionFrame title="Floors and caps">
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberRow
            label="Body floor (chars)"
            help="Messages shorter than this earn nothing."
            value={config.bodyFloorChars}
            min={0}
            onChange={(v) => setConfig({ ...config, bodyFloorChars: v })}
          />
          <NumberRow
            label="Presence block (min)"
            help="Length of one presence-award block. Takes effect on next server boot."
            value={config.presenceBlockMinutes}
            min={1}
            max={60}
            onChange={(v) => setConfig({ ...config, presenceBlockMinutes: v })}
          />
          <NumberRow
            label="Presence daily cap"
            help="Max blocks per pool per day. Past the cap, presence still records activity but earns 0."
            value={config.presenceDailyBlockCap}
            min={0}
            onChange={(v) => setConfig({ ...config, presenceDailyBlockCap: v })}
          />
        </div>
      </SectionFrame>

      <SectionFrame title="Multi-character divisor"
        description="Multiplier applied to per-character IC awards when the user has more than one logged-in character. 1.0 = each character earns the full configured rate (current spec). Lower throttles multi-character earning."
        {...(!isMaster ? { masterOnlyHint: "Master admin only." } : {})}>
        <NumberRow
          label="Divisor"
          value={config.multiCharacterEarnDivisor}
          min={0}
          max={10}
          step={0.05}
          disabled={!isMaster}
          fieldError={gatedFields.includes("multiCharacterEarnDivisor")}
          onChange={(v) => setConfig({ ...config, multiCharacterEarnDivisor: v })}
        />
      </SectionFrame>

      <SectionFrame title="Currency transfers (/currency send)"
        description="Anti-abuse gates on user-to-user Currency transfers.">
        <ToggleRow
          label="Transfers enabled"
          value={config.currencyTransfer.enabled}
          onChange={(v) => setConfig({ ...config, currencyTransfer: { ...config.currencyTransfer, enabled: v } })}
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <NumberRow
            label="Daily send cap"
            value={config.currencyTransfer.dailySendCap}
            min={0}
            onChange={(v) => setConfig({ ...config, currencyTransfer: { ...config.currencyTransfer, dailySendCap: v } })}
          />
          <NumberRow
            label="Daily receive cap"
            value={config.currencyTransfer.dailyReceiveCap}
            min={0}
            onChange={(v) => setConfig({ ...config, currencyTransfer: { ...config.currencyTransfer, dailyReceiveCap: v } })}
          />
          <NumberRow
            label="Min sender account age (days)"
            value={config.currencyTransfer.minSenderAccountAgeDays}
            min={0}
            onChange={(v) => setConfig({ ...config, currencyTransfer: { ...config.currencyTransfer, minSenderAccountAgeDays: v } })}
          />
          <NumberRow
            label="Min recipient account age (days)"
            value={config.currencyTransfer.minRecipientAccountAgeDays}
            min={0}
            onChange={(v) => setConfig({ ...config, currencyTransfer: { ...config.currencyTransfer, minRecipientAccountAgeDays: v } })}
          />
          <NumberRow
            label="Min single transfer"
            value={config.currencyTransfer.minTransferAmount}
            min={0}
            onChange={(v) => setConfig({ ...config, currencyTransfer: { ...config.currencyTransfer, minTransferAmount: v } })}
          />
          <NumberRow
            label="Max single transfer"
            value={config.currencyTransfer.maxTransferAmount}
            min={0}
            onChange={(v) => setConfig({ ...config, currencyTransfer: { ...config.currencyTransfer, maxTransferAmount: v } })}
          />
        </div>
      </SectionFrame>

      <SectionFrame title="One-shot backfill (historical messages)"
        description="At first boot the engine credited XP per pre-existing message at the rate below. `completedAt` is set automatically by the backfill job; editing it is not exposed."
        {...(!isMaster ? { masterOnlyHint: "Master admin only." } : {})}>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberRow
            label="XP per historical message"
            value={config.backfill.xpPerHistoricalMessage}
            min={0}
            step={0.1}
            disabled={!isMaster}
            fieldError={gatedFields.includes("backfill.xpPerHistoricalMessage")}
            onChange={(v) => setConfig({ ...config, backfill: { ...config.backfill, xpPerHistoricalMessage: v } })}
          />
          <div className="self-end text-xs text-keep-muted">
            <span className="block uppercase tracking-widest">Backfill status</span>
            <span>
              {config.backfill.completedAt
                ? `Completed ${new Date(config.backfill.completedAt).toLocaleString()}`
                : "Not yet run — will fire on next boot."}
            </span>
          </div>
        </div>
      </SectionFrame>

      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">
          {err}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <div className="text-xs text-keep-muted">
          {savedFlash ? <span className="text-keep-system">Saved.</span> : (dirty ? "Unsaved changes." : "")}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetToDefaults}
            className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm text-keep-muted hover:bg-keep-banner hover:text-keep-text"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded border border-keep-action bg-keep-action/15 px-4 py-1 text-sm font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
 *  Building blocks
 * ========================================================= */

function SectionFrame({
  title,
  description,
  masterOnlyHint,
  children,
}: {
  title: string;
  description?: string;
  masterOnlyHint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="font-action text-sm uppercase tracking-widest text-keep-muted">{title}</h4>
        {masterOnlyHint ? (
          <span className="text-[10px] uppercase tracking-widest text-keep-accent">{masterOnlyHint}</span>
        ) : null}
      </header>
      {description ? (
        <p className="mb-2 text-xs text-keep-muted">{description}</p>
      ) : null}
      {children}
    </section>
  );
}

function ToggleRow({
  label,
  help,
  value,
  onChange,
  disabled,
}: {
  label: string;
  help?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex-1">
        <span className="block">{label}</span>
        {help ? <span className="block text-[10px] text-keep-muted">{help}</span> : null}
      </span>
    </label>
  );
}

function NumberRow({
  label,
  help,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  fieldError,
}: {
  label: string;
  help?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  fieldError?: boolean;
}) {
  return (
    <label className={`block text-xs ${fieldError ? "text-keep-accent" : "text-keep-text"}`}>
      <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className={`w-full rounded border bg-keep-bg px-2 py-1 text-sm ${fieldError ? "border-keep-accent" : "border-keep-rule"} disabled:opacity-50`}
      />
      {help ? <span className="mt-1 block text-[10px] text-keep-muted">{help}</span> : null}
    </label>
  );
}

function SourceMatrix({
  flags,
  onChange,
}: {
  flags: { message: SourceEnableFlags; forum: SourceEnableFlags; presence: SourceEnableFlags };
  onChange: (next: { message: SourceEnableFlags; forum: SourceEnableFlags; presence: SourceEnableFlags }) => void;
}) {
  function set<K extends keyof typeof flags>(source: K, pool: "xp" | "currency", val: boolean) {
    onChange({ ...flags, [source]: { ...flags[source], [pool]: val } });
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-xs uppercase tracking-widest text-keep-muted">
        <tr>
          <th className="py-1 text-left">Source</th>
          <th className="py-1 text-center">XP</th>
          <th className="py-1 text-center">Currency</th>
        </tr>
      </thead>
      <tbody>
        {(["message", "forum", "presence"] as const).map((source) => (
          <tr key={source} className="border-t border-keep-rule/40">
            <td className="py-1 capitalize">{source}</td>
            <td className="py-1 text-center">
              <input
                type="checkbox"
                checked={flags[source].xp}
                onChange={(e) => set(source, "xp", e.target.checked)}
              />
            </td>
            <td className="py-1 text-center">
              <input
                type="checkbox"
                checked={flags[source].currency}
                onChange={(e) => set(source, "currency", e.target.checked)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SourceGroup<K extends string>({
  heading,
  rows,
  values,
  onChange,
}: {
  heading: string;
  rows: Array<{ key: K; label: string }>;
  values: Record<K, AwardAmount>;
  onChange: (next: Record<K, AwardAmount>) => void;
}) {
  function set(key: K, pool: "xp" | "currency", v: number) {
    onChange({ ...values, [key]: { ...values[key], [pool]: v } });
  }
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-widest text-keep-muted">{heading}</div>
      <table className="w-full text-sm">
        <thead className="text-[10px] uppercase tracking-widest text-keep-muted">
          <tr>
            <th className="py-1 text-left"></th>
            <th className="py-1 text-right">XP</th>
            <th className="py-1 text-right">Currency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, label }) => (
            <tr key={key} className="border-t border-keep-rule/40">
              <td className="py-1">{label}</td>
              <td className="py-1 text-right">
                <input
                  type="number"
                  min={0}
                  className="w-20 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-right text-sm"
                  value={values[key].xp}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) set(key, "xp", n);
                  }}
                />
              </td>
              <td className="py-1 text-right">
                <input
                  type="number"
                  min={0}
                  className="w-20 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-right text-sm"
                  value={values[key].currency}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) set(key, "currency", n);
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* =========================================================
 *  Ranks sub-tab
 *
 *  Lists every rank + tier with inline edit, asset upload,
 *  enable toggle, and add/delete affordances. Asset uploads
 *  go to /admin/earning/assets/upload (PNG, ≤1MB) and
 *  return a URL the caller pastes into the relevant tier's
 *  sigilImageUrl / borderImageUrl field via PATCH.
 *
 *  Soft-close: disabling a rank does NOT migrate existing
 *  rank-holders. Delete is gated on the per-rank usage
 *  count returned by GET /admin/earning/ranks.
 * ========================================================= */

function RanksSection() {
  const [ranks, setRanks] = useState<AdminRankRow[]>([]);
  const [tiers, setTiers] = useState<AdminTierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchAdminRanks();
      setRanks(r.ranks);
      setTiers(r.tiers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load ranks");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function onCreateRank(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await createAdminRank({ key: newKey.trim(), name: newName.trim() });
      setNewKey("");
      setNewName("");
      setCreating(false);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    }
  }

  if (loading) return <p className="text-sm text-keep-muted">Loading ranks…</p>;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-action text-base">Ranks &amp; Tiers</h3>
          <p className="text-xs text-keep-muted">
            Edit thresholds, asset URLs, and enable flags. Saved changes take effect immediately;
            threshold edits re-place every earning row automatically. Disabling a rank is a soft close
            — existing rank-holders keep their rank, but new earners skip past it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-sm text-keep-action hover:bg-keep-action/25"
        >
          {creating ? "Cancel" : "Add rank"}
        </button>
      </header>

      {creating ? (
        <form onSubmit={onCreateRank} className="rounded border border-keep-rule bg-keep-bg/40 p-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">Key (slug)</span>
              <input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                pattern="[a-z][a-z0-9_]*"
                title="Lowercase letters, digits, underscores. Must start with a letter."
                required
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block uppercase tracking-widest text-keep-muted">Display name</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
              />
            </label>
          </div>
          <p className="text-[10px] text-keep-muted">
            Four default tiers (I, II, III, IV: Verified) are created automatically with zero thresholds.
            Edit them below after creating.
          </p>
          <button
            type="submit"
            className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-sm text-keep-action hover:bg-keep-action/25"
          >
            Create
          </button>
        </form>
      ) : null}

      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}

      <div className="space-y-4">
        {ranks.map((r) => (
          <RankCard
            key={r.key}
            rank={r}
            tiers={tiers.filter((t) => t.rankKey === r.key).sort((a, b) => a.tier - b.tier)}
            onChanged={() => void refresh()}
            onError={(m) => setErr(m)}
          />
        ))}
      </div>
    </div>
  );
}

function RankCard({
  rank,
  tiers,
  onChanged,
  onError,
}: {
  rank: AdminRankRow;
  tiers: AdminTierRow[];
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(rank.name);
  const [enabled, setEnabled] = useState(rank.enabled);
  const [saving, setSaving] = useState(false);
  const inUse = rank.users + rank.characters > 0;

  async function saveRank() {
    setSaving(true);
    try {
      await patchAdminRank(rank.key, { name, enabled });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function removeRank() {
    if (inUse) {
      onError(`Cannot delete: ${rank.users} users + ${rank.characters} characters currently hold this rank. Disable it instead.`);
      return;
    }
    if (!window.confirm(`Delete rank "${rank.name}"? This is permanent.`)) return;
    try {
      await deleteAdminRank(rank.key);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="mb-3 flex flex-wrap items-baseline gap-3">
        <code className="text-xs uppercase tracking-widest text-keep-muted">{rank.key}</code>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm font-semibold"
        />
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          enabled
        </label>
        <span className="text-[10px] text-keep-muted">
          {rank.users} users · {rank.characters} chars
        </span>
        <button
          type="button"
          onClick={() => void saveRank()}
          disabled={saving}
          className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => void removeRank()}
          disabled={inUse}
          title={inUse ? "Disable instead — users currently hold this rank." : "Delete rank"}
          className="rounded border border-keep-rule px-2 py-0.5 text-xs text-keep-muted hover:text-keep-accent disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Delete
        </button>
      </header>

      <div className="space-y-2">
        {tiers.map((t) => (
          <TierRow key={t.id} tier={t} onChanged={onChanged} onError={onError} />
        ))}
      </div>
    </section>
  );
}

function TierRow({
  tier,
  onChanged,
  onError,
}: {
  tier: AdminTierRow;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [label, setLabel] = useState(tier.label);
  const [threshold, setThreshold] = useState(tier.xpThreshold);
  const [sigilUrl, setSigilUrl] = useState(tier.sigilImageUrl);
  const [borderUrl, setBorderUrl] = useState(tier.borderImageUrl ?? "");
  const [borderCost, setBorderCost] = useState(tier.borderCost ?? 0);
  const [enabled, setEnabled] = useState(tier.enabled);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<"sigil" | "border" | null>(null);

  const isCapstone = tier.tier === 4;

  async function save() {
    setSaving(true);
    try {
      await patchAdminTier(tier.id, {
        label,
        xpThreshold: threshold,
        sigilImageUrl: sigilUrl,
        borderImageUrl: isCapstone ? (borderUrl || null) : null,
        borderCost: isCapstone && borderUrl ? borderCost : null,
        enabled,
      });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function upload(kind: "sigil" | "border", file: File) {
    setUploading(kind);
    try {
      const dataUrl = await fileToDataUrl(file);
      const url = await uploadRankAsset(dataUrl);
      if (kind === "sigil") setSigilUrl(url);
      else setBorderUrl(url);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(null);
    }
  }

  return (
    <div className="rounded border border-keep-rule/60 bg-keep-bg/60 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 rounded bg-keep-banner/40 px-1.5 py-0.5 font-action uppercase tracking-widest text-keep-muted">
          Tier {tier.tier}
        </span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          className="w-32 rounded border border-keep-rule bg-keep-bg px-2 py-0.5"
        />
        <label className="flex items-center gap-1">
          <span className="text-keep-muted">XP ≥</span>
          <input
            type="number"
            min={0}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value) || 0)}
            className="w-24 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-right"
          />
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          enabled
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="ml-auto rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          Save
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-keep-muted">Sigil:</span>
        {sigilUrl ? <img src={sigilUrl} alt="" className="h-7 w-7 select-none" draggable={false} /> : <span className="text-keep-muted">(none)</span>}
        <input
          value={sigilUrl}
          onChange={(e) => setSigilUrl(e.target.value)}
          placeholder="/assets/ranks/..."
          className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-[11px]"
        />
        <label className="rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5 text-keep-muted hover:bg-keep-banner cursor-pointer">
          {uploading === "sigil" ? "Uploading…" : "Upload PNG"}
          <input
            type="file"
            accept="image/png"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload("sigil", f);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {isCapstone ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-keep-muted">Border:</span>
          {borderUrl ? <img src={borderUrl} alt="" className="h-7 w-7 select-none" draggable={false} /> : <span className="text-keep-muted">(none)</span>}
          <input
            value={borderUrl}
            onChange={(e) => setBorderUrl(e.target.value)}
            placeholder="(optional — capstone border)"
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-[11px]"
          />
          <label className="rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5 text-keep-muted hover:bg-keep-banner cursor-pointer">
            {uploading === "border" ? "Uploading…" : "Upload PNG"}
            <input
              type="file"
              accept="image/png"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload("border", f);
                e.target.value = "";
              }}
            />
          </label>
          {borderUrl ? (
            <label className="flex items-center gap-1">
              <span className="text-keep-muted">Cost</span>
              <input
                type="number"
                min={0}
                value={borderCost}
                onChange={(e) => setBorderCost(Number(e.target.value) || 0)}
                className="w-24 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-right"
              />
              <span className="text-keep-muted">Currency</span>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

/* =========================================================
 *  Name Styles sub-tab
 *
 *  Live preview pane: while the admin edits HTML + CSS, the
 *  preview re-injects the draft CSS into the document head so
 *  the rendered <StyledName> shows the in-progress template.
 *  Built-in styles can be rewritten but not deleted.
 * ========================================================= */

function NameStylesSection() {
  const [rows, setRows] = useState<AdminNameStyleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchAdminNameStyles();
      setRows(r.styles);
      if (selectedKey && !r.styles.some((s) => s.key === selectedKey)) {
        setSelectedKey(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load styles");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  const selected = useMemo(
    () => rows.find((r) => r.key === selectedKey) ?? null,
    [rows, selectedKey],
  );

  if (loading) return <p className="text-sm text-keep-muted">Loading styles…</p>;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-action text-base">Name Styles</h3>
          <p className="text-xs text-keep-muted">
            HTML + CSS templates with a <code>{"{username}"}</code> placeholder. Edits go live on the next /earning/me fetch (every user sees the new CSS without a reload). Built-in seed styles can be rewritten but not deleted.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setCreating(true); setSelectedKey(null); }}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-sm text-keep-action hover:bg-keep-action/25"
        >
          New style
        </button>
      </header>

      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-[260px_1fr]">
        <aside className="space-y-1">
          {rows.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => { setSelectedKey(r.key); setCreating(false); }}
              className={`block w-full rounded border px-2 py-1 text-left text-sm ${
                r.key === selectedKey ? "border-keep-action bg-keep-action/10" : "border-keep-rule bg-keep-bg/40 hover:bg-keep-banner"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{r.name}</span>
                {r.isBuiltin ? <span className="text-[10px] uppercase tracking-widest text-keep-muted">builtin</span> : null}
              </div>
              <div className="text-[10px] text-keep-muted">
                {r.cost} Currency · {r.owners} owners · {r.equipped} equipped {r.enabled ? "" : " · disabled"}
              </div>
            </button>
          ))}
        </aside>
        <div>
          {creating ? (
            <StyleEditor
              kind="create"
              initial={{
                key: "",
                name: "",
                description: "",
                template: "<span class=\"ns-mystyle\">{username}</span>",
                styleCss: ".ns-mystyle { color: var(--user-color-1, currentColor); }",
                cost: 0,
                enabled: true,
                isBuiltin: false,
                order: 0,
                owners: 0,
                equipped: 0,
              }}
              onCancel={() => setCreating(false)}
              onSaved={async (key) => {
                setCreating(false);
                await refresh();
                setSelectedKey(key);
              }}
              onError={setErr}
            />
          ) : selected ? (
            <StyleEditor
              kind="edit"
              initial={selected}
              onCancel={() => setSelectedKey(null)}
              onSaved={async () => { await refresh(); }}
              onError={setErr}
            />
          ) : (
            <p className="text-sm text-keep-muted">Select a style from the list or create a new one.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function StyleEditor({
  kind,
  initial,
  onCancel,
  onSaved,
  onError,
}: {
  kind: "edit" | "create";
  initial: AdminNameStyleRow;
  onCancel: () => void;
  onSaved: (key: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [key, setKey] = useState(initial.key);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [template, setTemplate] = useState(initial.template);
  const [styleCss, setStyleCss] = useState(initial.styleCss);
  const [cost, setCost] = useState(initial.cost);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [saving, setSaving] = useState(false);

  // Live-inject the draft CSS so the preview component reflects
  // unsaved edits. We use a sentinel key prefix ("__preview__") to
  // avoid colliding with any real style in the catalog.
  const previewKey = `__preview__${initial.key || "new"}`;
  useEffect(() => {
    injectNameStyles([{
      key: previewKey,
      name,
      description,
      // Substitute the wrapper class in the template + CSS so the
      // preview's scoped class doesn't depend on the live key (this
      // matters when the editor is for a new row with no key yet).
      template: template.replace(/ns-[a-zA-Z0-9_-]+/g, `ns-${previewKey}`),
      styleCss: styleCss.replace(/ns-[a-zA-Z0-9_-]+/g, `ns-${previewKey}`),
      cost: 0,
      isBuiltin: false,
      order: 0,
    }]);
  }, [template, styleCss, previewKey, name, description]);

  async function save() {
    setSaving(true);
    try {
      if (kind === "create") {
        await createAdminNameStyle({
          key,
          name,
          description,
          template,
          styleCss,
          cost,
          enabled,
        });
        await onSaved(key);
      } else {
        await patchAdminNameStyle(initial.key, {
          name,
          description,
          template,
          styleCss,
          cost,
          enabled,
        });
        await onSaved(initial.key);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${initial.name}"? Users who own it will lose access.`)) return;
    try {
      await deleteAdminNameStyle(initial.key);
      onCancel();
      await onSaved(initial.key);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="space-y-3 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Key</span>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={kind === "edit"}
            pattern="[a-z][a-z0-9_]*"
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-sm disabled:opacity-50"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Display name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">HTML template (must include <code>{"{username}"}</code>)</span>
        <textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={3}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-sm"
        />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">CSS (scoped to your wrapper class)</span>
        <textarea
          value={styleCss}
          onChange={(e) => setStyleCss(e.target.value)}
          rows={6}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-sm"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1 text-xs">
          <span className="text-keep-muted">Cost</span>
          <input
            type="number"
            min={0}
            value={cost}
            onChange={(e) => setCost(Number(e.target.value) || 0)}
            className="w-24 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-right text-sm"
          />
          <span className="text-keep-muted">Currency</span>
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          enabled
        </label>
        {initial.isBuiltin ? <span className="text-[10px] uppercase tracking-widest text-keep-muted">built-in (delete protected)</span> : null}
      </div>

      <div className="rounded border border-keep-rule/60 bg-keep-bg/60 p-3">
        <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">Live preview</div>
        <div className="text-base">
          <StyledName
            displayName="Username"
            styleKey={previewKey}
            config={{ color1: "#ff7a45", color2: "#ffb47a", glow: "rgba(255,170,80,0.6)" }}
          />
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {kind === "edit" && !initial.isBuiltin ? (
          <button
            type="button"
            onClick={() => void remove()}
            className="rounded border border-keep-rule px-3 py-1 text-sm text-keep-muted hover:text-keep-accent"
          >
            Delete
          </button>
        ) : null}
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm text-keep-muted hover:bg-keep-banner hover:text-keep-text"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded border border-keep-action bg-keep-action/15 px-4 py-1 text-sm text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/* =========================================================
 *  Cosmetics sub-tab
 *
 *  One row per cosmetic; admins edit name / description / cost /
 *  enabled. Currently `inline_avatar` is the only buyable
 *  cosmetic; `rank_border` is a UX placeholder (real per-rank
 *  prices live on rank_tiers.borderCost via the Ranks tab).
 * ========================================================= */

function CosmeticsSection() {
  const [rows, setRows] = useState<AdminCosmeticRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchAdminCosmetics();
      setRows(r.cosmetics);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load cosmetics");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  if (loading) return <p className="text-sm text-keep-muted">Loading cosmetics…</p>;

  return (
    <div className="space-y-3">
      <header>
        <h3 className="font-action text-base">Cosmetics</h3>
        <p className="text-xs text-keep-muted">
          Edit the buyable cosmetics catalog. Rank borders are priced per-rank in the Ranks tab; this surface covers everything else.
        </p>
      </header>
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}
      <div className="space-y-2">
        {rows.map((r) => (
          <CosmeticRow key={r.key} row={r} onChanged={() => void refresh()} onError={setErr} />
        ))}
      </div>
    </div>
  );
}

function CosmeticRow({
  row,
  onChanged,
  onError,
}: {
  row: AdminCosmeticRow;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(row.name);
  const [description, setDescription] = useState(row.description);
  const [cost, setCost] = useState(row.cost);
  const [enabled, setEnabled] = useState(row.enabled);
  const [saving, setSaving] = useState(false);

  const isRankBorderPlaceholder = row.key === "rank_border";

  async function save() {
    setSaving(true);
    try {
      await patchAdminCosmetic(row.key, { name, description, cost, enabled });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40 p-3 space-y-2">
      <header className="flex flex-wrap items-baseline gap-2">
        <code className="text-xs uppercase tracking-widest text-keep-muted">{row.key}</code>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm font-semibold"
        />
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          enabled
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          Save
        </button>
      </header>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        />
      </label>
      {isRankBorderPlaceholder ? (
        <p className="rounded border border-keep-rule/60 bg-keep-banner/20 p-2 text-[11px] text-keep-muted">
          The cost field for <code>rank_border</code> is ignored — actual per-rank prices live on each rank's Tier IV row in the Ranks tab.
        </p>
      ) : (
        <label className="flex items-center gap-1 text-xs">
          <span className="text-keep-muted">Cost</span>
          <input
            type="number"
            min={0}
            value={cost}
            onChange={(e) => setCost(Number(e.target.value) || 0)}
            className="w-24 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-right text-sm"
          />
          <span className="text-keep-muted">Currency</span>
        </label>
      )}
    </section>
  );
}

/* =========================================================
 *  Test grants sub-tab — masteradmin-only
 *
 *  Direct grants for testing rank/border/style/cosmetic
 *  visibility without grinding XP or buying with Currency.
 *  Defaults the target username to the admin themselves so
 *  the most common test case (grant → see it on your own
 *  account) is one click away. Refreshes the earning
 *  snapshot after each grant so the live Banner indicator
 *  + dashboard wallet update.
 * ========================================================= */

function TestGrantsSection() {
  const me = useChat((s) => s.me);
  const [target, setTarget] = useState(me?.username ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const refreshEarning = useEarning((s) => s.refresh);

  // Load the rank/style catalogs so the pickers populate from
  // the live catalog rather than hardcoded lists. We piggyback on
  // the two existing admin endpoints.
  const [ranks, setRanks] = useState<AdminRankRow[]>([]);
  const [tiers, setTiers] = useState<AdminTierRow[]>([]);
  const [styles, setStyles] = useState<AdminNameStyleRow[]>([]);
  useEffect(() => {
    void Promise.all([
      fetchAdminRanks().then((r) => { setRanks(r.ranks); setTiers(r.tiers); }),
      fetchAdminNameStyles().then((r) => setStyles(r.styles)),
    ]).catch((e) => setErr(e instanceof Error ? e.message : "Failed to load catalogs"));
  }, []);

  async function run(label: string, op: () => Promise<void>) {
    if (!target.trim()) { setErr("Enter a target username."); return; }
    setBusy(true);
    setErr(null);
    try {
      await op();
      setSavedFlash(label);
      // Refresh the local earning snapshot if the grant is on
      // ourselves — that way the dashboard ribbon / wallet / sigil
      // all update without a reload.
      if (me?.username && target.trim().toLowerCase() === me.username.toLowerCase()) {
        await refreshEarning();
      }
      window.setTimeout(() => setSavedFlash(null), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  }

  const tier4ByRank = new Map<string, AdminTierRow>();
  for (const t of tiers) if (t.tier === 4) tier4ByRank.set(t.rankKey, t);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h3 className="font-action text-base">Test grants</h3>
        <p className="text-xs text-keep-muted">
          Quick path to preview ranks, borders, and styles in chat /
          userlist / profile without grinding XP. Every grant goes
          through the live engine (ledger + socket events), so the
          recipient's dashboard updates immediately. Master admin only.
        </p>
      </header>

      <section className="rounded border border-keep-rule bg-keep-bg/40 p-3 space-y-3">
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Target username</span>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={me?.username ?? "username"}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
        {err ? (
          <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div>
        ) : null}
        {savedFlash ? (
          <div className="text-xs text-keep-system">{savedFlash} — done.</div>
        ) : null}
      </section>

      <GrantAmountRow
        label="Currency"
        help="Positive amount credits, negative debits. Goes to master pool."
        busy={busy}
        onSubmit={(amount) => run(`Grant ${amount} Currency`, () => adminGrantCurrency(target, amount))}
      />
      <GrantAmountRow
        label="XP"
        help="Recomputes rank/tier via the resolver after the credit. Negative XP doesn't decrease peak rank."
        busy={busy}
        onSubmit={(amount) => run(`Grant ${amount} XP`, () => adminGrantXp(target, amount))}
      />

      <SectionFrame title="Set rank / tier" description="Direct rank-tier override. Bumps XP to the tier's threshold so the next earn doesn't drop the user back. Also bumps the eligibility peak so all lower-rank borders unlock for purchase.">
        <SetRankRow
          ranks={ranks}
          tiers={tiers}
          busy={busy}
          onSet={(rankKey, tier) => run(`Set rank ${rankKey} ${tier}`, () => adminSetRank(target, rankKey, tier))}
          onClear={() => run("Clear rank override", () => adminSetRank(target, null, null))}
        />
      </SectionFrame>

      <SectionFrame title="Grant border" description="Inserts ownership for the chosen rank's border. Bypasses the normal Tier IV eligibility gate — handy for previewing every frame without climbing.">
        <GrantPickerRow
          options={ranks
            .filter((r) => tier4ByRank.has(r.key) && tier4ByRank.get(r.key)!.borderImageUrl)
            .map((r) => ({ value: r.key, label: r.name }))}
          placeholder="Pick a rank…"
          busy={busy}
          buttonLabel="Grant border"
          onPick={(rankKey) => run(`Grant border ${rankKey}`, () => adminGrantBorder(target, rankKey))}
        />
      </SectionFrame>

      <SectionFrame title="Grant name style" description="Inserts ownership for the chosen style without a Currency charge. Recipient still needs to equip it from the dashboard.">
        <GrantPickerRow
          options={styles.map((s) => ({ value: s.key, label: s.name }))}
          placeholder="Pick a style…"
          busy={busy}
          buttonLabel="Grant style"
          onPick={(styleKey) => run(`Grant style ${styleKey}`, () => adminGrantStyle(target, styleKey))}
        />
      </SectionFrame>
    </div>
  );
}

function GrantAmountRow({
  label,
  help,
  busy,
  onSubmit,
}: {
  label: string;
  help: string;
  busy: boolean;
  onSubmit: (amount: number) => void;
}) {
  const [amount, setAmount] = useState(1000);
  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-action text-sm uppercase tracking-widest text-keep-muted">{label}</h4>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value) || 0)}
            className="w-28 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-right text-sm"
          />
          <button
            type="button"
            onClick={() => onSubmit(amount)}
            disabled={busy || amount === 0}
            className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
          >
            Grant
          </button>
        </div>
      </header>
      <p className="mt-1 text-xs text-keep-muted">{help}</p>
    </section>
  );
}

function SetRankRow({
  ranks,
  tiers,
  busy,
  onSet,
  onClear,
}: {
  ranks: AdminRankRow[];
  tiers: AdminTierRow[];
  busy: boolean;
  onSet: (rankKey: string, tier: number) => void;
  onClear: () => void;
}) {
  const [rankKey, setRankKey] = useState<string>("");
  const [tier, setTier] = useState<number>(1);
  const tiersForRank = tiers
    .filter((t) => t.rankKey === rankKey)
    .sort((a, b) => a.tier - b.tier);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select
        value={rankKey}
        onChange={(e) => { setRankKey(e.target.value); setTier(1); }}
        className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
      >
        <option value="">Pick a rank…</option>
        {ranks.map((r) => (
          <option key={r.key} value={r.key}>{r.name}</option>
        ))}
      </select>
      <select
        value={tier}
        onChange={(e) => setTier(Number(e.target.value))}
        disabled={!rankKey}
        className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm disabled:opacity-50"
      >
        {tiersForRank.length === 0 ? (
          <option value={1}>Tier…</option>
        ) : tiersForRank.map((t) => (
          <option key={t.id} value={t.tier}>Tier {t.tier} — {t.label}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => rankKey && onSet(rankKey, tier)}
        disabled={busy || !rankKey}
        className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
      >
        Set
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={busy}
        className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-keep-muted hover:bg-keep-banner hover:text-keep-text disabled:opacity-50"
      >
        Clear override
      </button>
    </div>
  );
}

function GrantPickerRow({
  options,
  placeholder,
  busy,
  buttonLabel,
  onPick,
}: {
  options: Array<{ value: string; label: string }>;
  placeholder: string;
  busy: boolean;
  buttonLabel: string;
  onPick: (value: string) => void;
}) {
  const [value, setValue] = useState<string>("");
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => value && onPick(value)}
        disabled={busy || !value}
        className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
      >
        {buttonLabel}
      </button>
    </div>
  );
}
