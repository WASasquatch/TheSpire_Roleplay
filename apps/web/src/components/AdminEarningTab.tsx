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
import DOMPurify from "dompurify";
import { isMasterAdminRole } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { BorderedAvatar } from "./BorderedAvatar.js";
import { useEarning } from "../state/earning.js";
import { applyNameStylePlaceholders } from "../lib/nameStyleTemplate.js";
import {
  adminGrantBorder,
  adminGrantCurrency,
  adminGrantItem,
  adminGrantStyle,
  adminGrantXp,
  adminSetRank,
  createAdminItem,
  createAdminNameStyle,
  createAdminRank,
  deleteAdminItem,
  deleteAdminNameStyle,
  deleteAdminRank,
  deleteAdminTier,
  fetchAdminAwards,
  fetchAdminCosmetics,
  fetchAdminFreeformBorders,
  fetchAdminItems,
  fetchAdminNameStyles,
  fetchAdminRanks,
  createAdminFreeformBorder,
  patchAdminFreeformBorder,
  deleteAdminFreeformBorder,
  adminClearProfileBanner,
  adminClearRoomPresence,
  adminClearSessionPresence,
  adminClearTypingPhrase,
  adminGrantFreeformBorder,
  adminRevokeFreeformBorder,
  adminRevokeBorder,
  adminRevokeStyle,
  patchAdminCosmetic,
  patchAdminItem,
  patchAdminNameStyle,
  patchAdminRank,
  patchAdminTier,
  putAdminAwards,
  uploadRankAsset,
  fetchAdminFlashSale,
  patchAdminFlashSaleSettings,
  putAdminFlashSaleOverride,
  downloadCatalogExport,
  uploadCatalogImport,
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  type AdminCosmeticRow,
  type AdminFreeformBorderRow,
  type AdminItemRow,
  type AdminNameStyleRow,
  type AdminRankRow,
  type AdminTierRow,
  type AdminFlashSaleResponse,
  type AwardAmount,
  type CatalogImportResult,
  type EarningTransferKind,
  type ItemCategory,
  type SourceEnableFlags,
  type EarningConfig,
} from "../lib/earning.js";

type SubTab = "awards" | "ranks" | "styles" | "borders" | "cosmetics" | "items" | "flashsale" | "transfer" | "grants";

/** Single source of truth for the Earning sub-sections. Order here is
 *  used by both the desktop button strip and the mobile dropdown. The
 *  `masterOnly` flag mirrors the role check below — plain admins don't
 *  see "Test grants" in either picker. */
const SUB_TABS: ReadonlyArray<{ id: SubTab; label: string; masterOnly?: boolean }> = [
  { id: "awards", label: "Awards" },
  { id: "ranks", label: "Ranks" },
  { id: "styles", label: "Name Styles" },
  { id: "borders", label: "Borders" },
  { id: "cosmetics", label: "Flair" },
  { id: "items", label: "Items" },
  { id: "flashsale", label: "Flash Sale" },
  { id: "transfer", label: "Backup" },
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
      {subTab === "borders" ? <FreeformBordersSection /> : null}
      {subTab === "cosmetics" ? <CosmeticsSection /> : null}
      {subTab === "items" ? <ItemsSection /> : null}
      {subTab === "flashsale" ? <FlashSaleSection /> : null}
      {subTab === "transfer" ? <CatalogTransferSection /> : null}
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

      <SectionFrame
        title="Message length bonus"
        description="Reward longer effortful posts with a multiplier on the per-kind XP+Currency. Linear interpolation from 1.0× at Floor up to Max× at Ceil; above Ceil clamps to Max. Disable per-kind to keep that source on the flat base rate."
      >
        <div className="grid gap-3 lg:grid-cols-3">
          {(["say", "action", "whisper"] as const).map((kind) => {
            const spec = config.messageQuality.lengthBonus[kind];
            const update = (next: Partial<typeof spec>) => setConfig({
              ...config,
              messageQuality: {
                ...config.messageQuality,
                lengthBonus: {
                  ...config.messageQuality.lengthBonus,
                  [kind]: { ...spec, ...next },
                },
              },
            });
            return (
              <div key={kind} className="rounded border border-keep-rule bg-keep-bg/40 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <strong className="capitalize">{kind}</strong>
                  <label className="flex items-center gap-1 text-xs text-keep-muted">
                    <input
                      type="checkbox"
                      checked={spec.enabled}
                      onChange={(e) => update({ enabled: e.target.checked })}
                    />
                    Enabled
                  </label>
                </div>
                <div className="grid gap-2">
                  <NumberRow
                    label="Floor (chars)"
                    help="At or below this length: 1.0× (base rate)."
                    value={spec.floorChars}
                    min={0}
                    disabled={!spec.enabled}
                    onChange={(v) => update({ floorChars: v })}
                  />
                  <NumberRow
                    label="Ceil (chars)"
                    help="At or above this length: Max multiplier (clamped)."
                    value={spec.ceilChars}
                    min={spec.floorChars + 1}
                    disabled={!spec.enabled}
                    onChange={(v) => update({ ceilChars: v })}
                  />
                  <NumberRow
                    label="Max multiplier"
                    help="Cap on the multiplier at or above Ceil. 1.0–10.0."
                    value={spec.maxMultiplier}
                    min={1}
                    max={10}
                    step={0.1}
                    disabled={!spec.enabled}
                    onChange={(v) => update({ maxMultiplier: v })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </SectionFrame>

      <SectionFrame
        title="Spam detection"
        description="Heuristics that drop the award to zero on suspect messages. Each check has its own threshold; setting any to 0 disables that check individually. Master switch (Enabled) bypasses every check at once. Flagged messages still post normally — only the award is denied — and the ledger metadata records why so admins can audit and tune."
      >
        <ToggleRow
          label="Spam detection enabled"
          value={config.messageQuality.spam.enabled}
          onChange={(v) => setConfig({
            ...config,
            messageQuality: { ...config.messageQuality, spam: { ...config.messageQuality.spam, enabled: v } },
          })}
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NumberRow
            label="Min length to check"
            help="Skip every heuristic below this length — short messages are not flagged."
            value={config.messageQuality.spam.minLengthToCheck}
            min={0}
            disabled={!config.messageQuality.spam.enabled}
            onChange={(v) => setConfig({
              ...config,
              messageQuality: { ...config.messageQuality, spam: { ...config.messageQuality.spam, minLengthToCheck: v } },
            })}
          />
          <NumberRow
            label="Unique-char floor"
            help='Flag if unique-chars / total-chars is below this. 0.18 catches "aaaaaaaaaa" and "!!!!!!!". 0 disables.'
            value={config.messageQuality.spam.uniqueCharRatioFloor}
            min={0}
            max={1}
            step={0.01}
            disabled={!config.messageQuality.spam.enabled}
            onChange={(v) => setConfig({
              ...config,
              messageQuality: { ...config.messageQuality, spam: { ...config.messageQuality.spam, uniqueCharRatioFloor: v } },
            })}
          />
          <NumberRow
            label="Dominant-token cap"
            help='Flag if any single word repeats > this share of total tokens. 0.55 catches "spam spam spam spam". 0 disables.'
            value={config.messageQuality.spam.dominantTokenRatioCap}
            min={0}
            max={1}
            step={0.01}
            disabled={!config.messageQuality.spam.enabled}
            onChange={(v) => setConfig({
              ...config,
              messageQuality: { ...config.messageQuality, spam: { ...config.messageQuality.spam, dominantTokenRatioCap: v } },
            })}
          />
          <NumberRow
            label="Echo lookback"
            help="How many recent messages-per-user to compare for exact-duplicate detection. 0 disables."
            value={config.messageQuality.spam.echoLookback}
            min={0}
            max={20}
            disabled={!config.messageQuality.spam.enabled}
            onChange={(v) => setConfig({
              ...config,
              messageQuality: { ...config.messageQuality, spam: { ...config.messageQuality.spam, echoLookback: v } },
            })}
          />
        </div>
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
 *  preview renders inside a Shadow DOM (see NameStylePreview)
 *  so the admin's exact classes + rules apply verbatim against
 *  the typed-in template — no scope mangling, no leakage in or
 *  out of the page's own styles. Built-in styles can be
 *  rewritten but not deleted.
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
            // `key={selected.key}` forces React to unmount the
            // previous editor and mount a fresh one when the admin
            // picks a different style from the sidebar. Without it
            // the StyleEditor's `useState(initial.*)` initializers
            // only run on first mount — clicking another row
            // updated the `initial` prop but every form field
            // (name, template, CSS, cost, enabled) stayed frozen
            // on the originally-selected style, so the admin
            // could only edit the first row they clicked until a
            // full page refresh.
            <StyleEditor
              key={selected.key}
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

/**
 * Tags / attributes mirrored from StyledName's production sanitizer.
 * Keeping them in lockstep means what the admin sees in the preview is
 * what users will see at runtime — same DOMPurify rules, same drops.
 */
const PREVIEW_SANITIZER_TAGS = ["span", "b", "i", "em", "strong", "u", "s", "small", "sub", "sup", "mark"];
const PREVIEW_SANITIZER_ATTRS = ["class", "style", "data-*"];

/**
 * Live preview for the Name-Styles editor. Renders the admin's
 * *exact* HTML template + CSS inside a Shadow DOM so what they see is
 * literally what'll save — no class-name rewriting, no scope mangling,
 * no risk of the draft clobbering already-rendered names elsewhere on
 * the page (the shadow boundary handles isolation in both directions).
 *
 * Why shadow DOM and not "inject the CSS into a scoped style tag":
 *  - The previous approach rewrote `ns-<slug>` to `ns-<previewKey>` in
 *    both the template and the CSS so the draft wouldn't collide with
 *    catalog rules. That worked for single-element built-ins but quietly
 *    collapsed BEM children (`ns-foo__bar` → `ns-foo`) — admins editing
 *    multi-element templates saw the DOM render but with every nested
 *    class flattened to the wrapper, so none of their `__element` CSS
 *    rules matched and the preview painted as bare text. Fixing the
 *    regex helped but kept introducing edge cases (BEM modifiers,
 *    keyframes name collisions, custom-property names that contain `--`,
 *    nested `@scope`/`@media`). Shadow DOM removes the whole class of
 *    bug — the admin's classes apply to the admin's HTML, full stop.
 *  - Style isolation goes both ways: the page's `keep-*` tokens and
 *    tailwind utilities don't bleed into the preview, so admins
 *    authoring against the host page can't accidentally rely on app
 *    styles that won't exist at runtime.
 *
 * Inherited CSS (color, font-family, line-height) still flows through
 * the host element into the shadow root — that's a property of the
 * cascade, not a leak — so the preview text picks up the editor's
 * typography for context.
 */
function NameStylePreview({
  template,
  styleCss,
  displayName,
}: {
  template: string;
  styleCss: string;
  displayName: string;
}) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  // Attach the shadow root once on mount. attachShadow throws if called
  // twice on the same host, so we stash the returned root and reuse it.
  useEffect(() => {
    if (!hostRef.current || shadowRef.current) return;
    shadowRef.current = hostRef.current.attachShadow({ mode: "open" });
  }, []);

  // (Re)render the shadow content on every change. Clears then rebuilds
  // — cheap for a single styled span, and avoids needing to diff the
  // user's freeform HTML/CSS.
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild);

    // CSS goes into a proper <style> element so the CSP nonce can be
    // stamped on it. Strict prod policies (`style-src 'self' 'nonce-…'`)
    // would otherwise drop the inline stylesheet, leaving the preview
    // unstyled even though the user's CSS is "there".
    const styleEl = document.createElement("style");
    const nonceMeta = document.head.querySelector('meta[name="csp-nonce"]') as HTMLMetaElement | null;
    const nonce = nonceMeta?.content || "";
    if (nonce) styleEl.setAttribute("nonce", nonce);
    styleEl.textContent = styleCss;
    shadow.appendChild(styleEl);

    // HTML goes through the same DOMPurify config StyledName uses at
    // runtime, so the admin sees what's actually going to survive
    // sanitization (e.g. `title=` attrs and disallowed tags getting
    // stripped). KEEP_CONTENT means stripped tags keep their inner
    // text — matches production exactly. Placeholder substitution
    // (`{username}` + `{username-span}`) routes through the shared
    // helper so the preview can't drift from the runtime render.
    const merged = applyNameStylePlaceholders(template, displayName);
    const clean = DOMPurify.sanitize(merged, {
      ALLOWED_TAGS: PREVIEW_SANITIZER_TAGS,
      ALLOWED_ATTR: PREVIEW_SANITIZER_ATTRS,
      KEEP_CONTENT: true,
    });
    const wrapper = document.createElement("span");
    wrapper.innerHTML = clean;
    shadow.appendChild(wrapper);
  }, [template, styleCss, displayName]);

  // `inline-block` so the host establishes its own box; otherwise the
  // shadow content (mostly inline spans) wouldn't reserve any height
  // when the user's CSS uses transforms / absolute positioning on the
  // template's children.
  return <span ref={hostRef} className="inline-block" />;
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

  // Preview is rendered via NameStylePreview (Shadow DOM). No
  // class-name rewriting, no page-level style injection — the admin's
  // exact HTML + CSS apply inside an isolated shadow tree, so the
  // preview literally matches what saving will produce.

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
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">
          HTML template (include <code>{"{username}"}</code> or <code>{"{username-span}"}</code>)
        </span>
        <textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={3}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-sm"
        />
        <span className="mt-1 block text-[10px] normal-case tracking-normal text-keep-muted">
          <code>{"{username}"}</code> drops the name as one text run.
          {" "}
          <code>{"{username-span}"}</code> wraps each character in its own
          <code>&lt;span data-i="N"&gt;</code> so per-character CSS works —
          target via <code>{"span[data-i=\"0\"]"}</code> or
          <code>:nth-child()</code> for alternating colors, per-letter
          animations, etc.
        </span>
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
        {/* `text-2xl font-bold` mirrors the EarningDashboard's
            Available card preview sizing — at smaller weight the 1px
            text-stroke a lot of styles use overwhelms the fill, so
            matching the store's bigger sizing gives the admin a
            like-for-like comparison with what users see when shopping. */}
        <div className="text-2xl font-bold">
          <NameStylePreview
            template={template}
            styleCss={styleCss}
            displayName="Username"
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
 *  Free-form Borders sub-tab
 *
 *  Catalog CRUD for the parallel `freeform_borders` table
 *  introduced in migration 0149. Each row ships in EITHER
 *  `imageUrl` mode (overlay PNG / APNG) OR `template`+`styleCss`
 *  mode (admin-authored DOM template with the literal `{avatar}`
 *  placeholder). Server enforces the XOR; this UI surfaces both
 *  fields and the admin picks one.
 *
 *  Rarity is an open string — admins can introduce a new tier
 *  ("seasonal", "limited", whatever) by typing it. The user-facing
 *  BordersTab palette covers a fixed set and falls back to the
 *  'common' palette for anything else.
 * ========================================================= */

function FreeformBordersSection() {
  const [rows, setRows] = useState<AdminFreeformBorderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<AdminFreeformBorderRow> | null>(null);
  const [creating, setCreating] = useState(false);

  // Pull the admin's own avatar from the room-occupant cosmetics
  // cache so previews show their actual portrait inside the frame.
  // Same lookup BordersTab uses for the user-facing preview. Falls
  // back to null (BorderedAvatar then shows the initials chip).
  const me = useChat((s) => s.me);
  const previewAvatarUrl = useChat((s) => {
    if (!me) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find((o) => o.userId === me.id);
      if (row?.avatarUrl) return row.avatarUrl;
    }
    return null;
  });

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchAdminFreeformBorders();
      setRows(r.borders);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load borders");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  function beginEdit(row: AdminFreeformBorderRow) {
    setEditing(row.key);
    setDraft({ ...row });
    setCreating(false);
  }

  function beginCreate() {
    setEditing(null);
    setCreating(true);
    setDraft({
      key: "",
      name: "",
      description: "",
      imageUrl: null,
      template: null,
      styleCss: null,
      rarity: "common",
      cost: 0,
      enabled: true,
      order: 0,
    });
  }

  function cancelEdit() {
    setEditing(null);
    setCreating(false);
    setDraft(null);
  }

  async function save() {
    if (!draft) return;
    setErr(null);
    try {
      if (creating) {
        if (!draft.key || !draft.name) {
          setErr("Key and name are required");
          return;
        }
        // Build the body with conditional spreads so optional fields
        // stay undefined-absent (matches `exactOptionalPropertyTypes`).
        await createAdminFreeformBorder({
          key: draft.key,
          name: draft.name,
          ...(draft.description !== undefined ? { description: draft.description } : {}),
          imageUrl: draft.imageUrl ?? null,
          template: draft.template ?? null,
          styleCss: draft.styleCss ?? null,
          ...(draft.rarity !== undefined ? { rarity: draft.rarity } : {}),
          ...(draft.cost !== undefined ? { cost: draft.cost } : {}),
          ...(draft.enabled !== undefined ? { enabled: draft.enabled } : {}),
          ...(draft.order !== undefined ? { order: draft.order } : {}),
        });
      } else if (editing) {
        await patchAdminFreeformBorder(editing, {
          ...(draft.name !== undefined ? { name: draft.name } : {}),
          ...(draft.description !== undefined ? { description: draft.description } : {}),
          imageUrl: draft.imageUrl ?? null,
          template: draft.template ?? null,
          styleCss: draft.styleCss ?? null,
          ...(draft.rarity !== undefined ? { rarity: draft.rarity } : {}),
          ...(draft.cost !== undefined ? { cost: draft.cost } : {}),
          ...(draft.enabled !== undefined ? { enabled: draft.enabled } : {}),
          ...(draft.order !== undefined ? { order: draft.order } : {}),
        });
      }
      cancelEdit();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function remove(row: AdminFreeformBorderRow) {
    if (row.isBuiltin) {
      setErr("Built-in borders cannot be deleted; disable instead");
      return;
    }
    const msg = row.owners > 0 || row.equipped > 0
      ? `Delete "${row.name}"? ${row.owners} owner(s), ${row.equipped} equip(s) will be cleared.`
      : `Delete "${row.name}"?`;
    if (!window.confirm(msg)) return;
    setErr(null);
    try {
      await deleteAdminFreeformBorder(row.key);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  const showEditor = creating || (editing !== null && draft !== null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-action text-sm uppercase tracking-widest text-keep-muted">
          Free-form Borders
        </h3>
        {!showEditor ? (
          <button
            type="button"
            onClick={beginCreate}
            className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action hover:bg-keep-action/25"
          >
            + New border
          </button>
        ) : null}
      </div>
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}
      {showEditor && draft ? (
        <FreeformBorderEditor
          draft={draft}
          setDraft={setDraft}
          creating={creating}
          onCancel={cancelEdit}
          onSave={() => void save()}
        />
      ) : null}
      {loading ? (
        <div className="text-sm text-keep-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-keep-muted">No free-form borders yet.</div>
      ) : (
        // Card grid — one tile per border, with a live preview using
        // BorderedAvatar's freeformOverride path so disabled rows
        // still render at full fidelity. Responsive: 1col mobile,
        // 2col tablet, 3col desktop, 4col wide.
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {rows.map((r) => (
            <div
              key={r.key}
              className={`flex flex-col gap-2 rounded border p-3 text-sm ${
                r.enabled ? "border-keep-rule bg-keep-bg/40" : "border-keep-accent/40 bg-keep-accent/5"
              }`}
            >
              {/* Live preview — same render path as the user-facing
                  picker. `freeformOverride` bypasses the snapshot
                  catalog so disabled rows still display, and inlines
                  the row's CSS into the preview so admin-edited
                  drafts work too. Show "(no template)" for empty
                  rows that ship neither path. */}
              <div className="flex items-center justify-center rounded bg-keep-banner/40 p-2 min-h-[120px]">
                {r.template || r.imageUrl ? (
                  <BorderedAvatar
                    avatarUrl={previewAvatarUrl}
                    name={r.name}
                    size="xl"
                    freeformOverride={{
                      key: r.key,
                      imageUrl: r.imageUrl,
                      template: r.template,
                      styleCss: r.styleCss,
                    }}
                  />
                ) : (
                  <span className="text-xs italic text-keep-muted">(no template / image)</span>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{r.name}</span>
                  <span className="text-xs text-keep-muted">{r.key}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-keep-muted">
                    {r.rarity}
                  </span>
                  {!r.enabled ? (
                    <span className="rounded border border-keep-accent/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-keep-accent">
                      Disabled
                    </span>
                  ) : null}
                  {r.isBuiltin ? (
                    <span className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-keep-muted">
                      Built-in
                    </span>
                  ) : null}
                  <span className="rounded border border-keep-rule px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-keep-muted">
                    {r.template ? "Template" : r.imageUrl ? "Image" : "Empty"}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-keep-muted">
                  Cost {r.cost} · Owners {r.owners} · Equipped {r.equipped}
                </div>
              </div>
              <div className="mt-auto flex justify-end gap-1">
                <button
                  type="button"
                  onClick={() => beginEdit(r)}
                  className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs hover:bg-keep-banner"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void remove(r)}
                  disabled={r.isBuiltin}
                  title={r.isBuiltin ? "Built-in — disable instead" : "Delete border"}
                  className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-0.5 text-xs text-keep-accent hover:bg-keep-accent/20 disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FreeformBorderEditor({
  draft,
  setDraft,
  creating,
  onCancel,
  onSave,
}: {
  draft: Partial<AdminFreeformBorderRow>;
  setDraft: (d: Partial<AdminFreeformBorderRow>) => void;
  creating: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  // Local helper to update a single field without losing the
  // unspecified fields. Lets the input handlers stay terse.
  function set<K extends keyof AdminFreeformBorderRow>(k: K, v: AdminFreeformBorderRow[K]) {
    setDraft({ ...draft, [k]: v });
  }
  // Pull the admin's own avatar for the live preview — same source
  // as the section's grid previews.
  const me = useChat((s) => s.me);
  const previewAvatarUrl = useChat((s) => {
    if (!me) return null;
    for (const list of Object.values(s.occupants)) {
      const row = list.find((o) => o.userId === me.id);
      if (row?.avatarUrl) return row.avatarUrl;
    }
    return null;
  });
  return (
    <div className="space-y-2 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="text-sm font-semibold">
          {creating ? "New free-form border" : `Editing: ${draft.key}`}
        </div>
        {/* Live editor preview — feeds the draft through the same
            BorderedAvatar override path the card grid uses, so the
            admin sees the rendered border update as they type. */}
        {draft.template || draft.imageUrl ? (
          <div className="flex items-center justify-center rounded border border-keep-rule bg-keep-banner/40 p-2">
            <BorderedAvatar
              avatarUrl={previewAvatarUrl}
              name={draft.name ?? draft.key ?? "Preview"}
              size="xl"
              freeformOverride={{
                key: draft.key ?? "preview",
                imageUrl: draft.imageUrl ?? null,
                template: draft.template ?? null,
                styleCss: draft.styleCss ?? null,
              }}
            />
          </div>
        ) : null}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {creating ? (
          <label className="text-xs">
            <span className="text-keep-muted">Key (lowercase, a-z 0-9 _ -)</span>
            <input
              type="text"
              value={draft.key ?? ""}
              onChange={(e) => set("key", e.target.value)}
              className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
            />
          </label>
        ) : null}
        <label className="text-xs">
          <span className="text-keep-muted">Name</span>
          <input
            type="text"
            value={draft.name ?? ""}
            onChange={(e) => set("name", e.target.value)}
            className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="text-keep-muted">Rarity (open string)</span>
          <input
            type="text"
            value={draft.rarity ?? ""}
            onChange={(e) => set("rarity", e.target.value)}
            placeholder="common / rare / epic / legendary / mythic / exotic / atmospheric"
            className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="text-keep-muted">Cost (Currency)</span>
          <input
            type="number"
            min={0}
            value={draft.cost ?? 0}
            onChange={(e) => set("cost", Number(e.target.value))}
            className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="text-keep-muted">Order</span>
          <input
            type="number"
            value={draft.order ?? 0}
            onChange={(e) => set("order", Number(e.target.value))}
            className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="text-keep-muted">Enabled</span>
          <input
            type="checkbox"
            checked={!!draft.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
            className="ml-2"
          />
        </label>
      </div>
      <label className="block text-xs">
        <span className="text-keep-muted">Description (optional)</span>
        <textarea
          rows={2}
          value={draft.description ?? ""}
          onChange={(e) => set("description", e.target.value)}
          className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        />
      </label>
      {/* Image vs template mode is exclusive — the server enforces
          XOR. The UI lets the admin clear one to switch to the
          other. */}
      <label className="block text-xs">
        <span className="text-keep-muted">Image URL (PNG / APNG / WebP, transparent center). Leave blank if using a template.</span>
        <input
          type="text"
          value={draft.imageUrl ?? ""}
          onChange={(e) => set("imageUrl", e.target.value || null)}
          className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        />
      </label>
      <label className="block text-xs">
        <span className="text-keep-muted">Template (HTML, uses literal `&#123;avatar&#125;` for the avatar slot). Leave blank if using an image URL.</span>
        <textarea
          rows={4}
          value={draft.template ?? ""}
          onChange={(e) => set("template", e.target.value || null)}
          placeholder={'<div class="av b-mykey"><div class="pic">{avatar}</div></div>'}
          className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs"
        />
      </label>
      <label className="block text-xs">
        <span className="text-keep-muted">Style CSS (scoped to the `.b-&lt;key&gt;` chain referenced by the template)</span>
        <textarea
          rows={6}
          value={draft.styleCss ?? ""}
          onChange={(e) => set("styleCss", e.target.value || null)}
          className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs"
        />
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs text-keep-muted hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action hover:bg-keep-action/25"
        >
          Save
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
        <h3 className="font-action text-base">Flair</h3>
        <p className="text-xs text-keep-muted">
          Edit the buyable cosmetics catalog. Rank borders are priced per-rank in the Ranks tab; this surface covers everything else.
        </p>
      </header>
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}
      {/* Card grid — saves vertical space on tablet+ while staying
          1col on mobile. Each CosmeticRow keeps its own layout
          (header + description + inputs) so converting to a grid is
          purely the outer flow. */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <CosmeticRow key={r.key} row={r} onChanged={() => void refresh()} onError={setErr} />
        ))}
      </div>
      <FlairModerationSection />
    </div>
  );
}

/* =========================================================
 *  Flair moderation levers
 *
 *  Per-cosmetic "clear this user's free-form content" actions.
 *  Banner URL and typing phrase are both user-supplied strings
 *  protected only by the up-front purchase + length checks — when
 *  a moderator gets a report ("Bob's banner is hotlinked NSFW",
 *  "Alice's typing phrase is harassing"), this is where they
 *  zero it out. Ownership of the cosmetic is retained so the user
 *  can set a (presumably policy-compliant) value afterwards.
 *
 *  Auditable: each action writes a `profile_banner_clear` or
 *  `typing_phrase_clear` audit row with the optional reason.
 * ========================================================= */
function FlairModerationSection() {
  return (
    <section className="space-y-3 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <header>
        <h4 className="font-action text-sm uppercase tracking-widest text-keep-muted">
          Moderation
        </h4>
        <p className="text-xs text-keep-muted">
          Wipe a user's free-form Flair content (banner URL, typing phrase) without touching their ownership of the cosmetic.
        </p>
      </header>
      <div className="grid gap-2 md:grid-cols-2">
        <ClearFlairCard
          title="Clear profile banner"
          kind="banner"
          hint="Empties the banner-URL slot for the target identity. Use after a hotlinked image report."
        />
        <ClearFlairCard
          title="Clear typing phrase"
          kind="typing-phrase"
          hint="Empties the custom typing phrase for the target identity. Use after a harassment / language report."
        />
        <ClearFlairCard
          title="Clear room entrance / exit"
          kind="room-presence"
          hint="Wipes both the join and leave room broadcast templates for the target identity. Use after an abusive room-presence flair report."
        />
        <ClearFlairCard
          title="Clear session greeting"
          kind="session-presence"
          hint="Wipes both the login and logout broadcast templates. Master-only; character id is ignored."
        />
      </div>
    </section>
  );
}

function ClearFlairCard({
  title,
  kind,
  hint,
}: {
  title: string;
  kind: "banner" | "typing-phrase" | "room-presence" | "session-presence";
  hint: string;
}) {
  const [username, setUsername] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok"; message: string } | { kind: "err"; message: string } | null>(null);
  // Session-presence is master-only — hide the character-id input
  // so admins don't think they can target a character's session
  // greeting (it doesn't exist).
  const supportsCharacterScope = kind !== "session-presence";

  async function submit() {
    setBusy(true);
    setStatus(null);
    try {
      const args = {
        username: username.trim(),
        ...(supportsCharacterScope && characterId.trim() ? { characterId: characterId.trim() } : { characterId: null as string | null }),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      };
      if (kind === "banner") {
        await adminClearProfileBanner(args);
      } else if (kind === "typing-phrase") {
        await adminClearTypingPhrase(args);
      } else if (kind === "room-presence") {
        await adminClearRoomPresence(args);
      } else {
        await adminClearSessionPresence({ username: args.username, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      }
      setStatus({ kind: "ok", message: "Cleared." });
      // Leave the username field populated so a moderator can clear
      // the same user's other slot without retyping. Wipe the reason
      // so the next click doesn't carry it forward unintentionally.
      setReason("");
    } catch (e) {
      setStatus({ kind: "err", message: e instanceof Error ? e.message : "Clear failed" });
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = username.trim().length > 0 && !busy;
  return (
    <div className="space-y-2 rounded border border-keep-rule bg-keep-bg/60 p-2 text-xs">
      <div className="font-semibold">{title}</div>
      <p className="text-[10px] text-keep-muted">{hint}</p>
      <label className="block">
        <span className="text-keep-muted">Target username</span>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
      </label>
      {supportsCharacterScope ? (
        <label className="block">
          <span className="text-keep-muted">Character id (optional — leave blank to clear master/OOC)</span>
          <input
            type="text"
            value={characterId}
            onChange={(e) => setCharacterId(e.target.value)}
            placeholder="charXXXX…"
            className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[10px]"
          />
        </label>
      ) : null}
      <label className="block">
        <span className="text-keep-muted">Reason (optional, recorded in audit log)</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. hotlinked NSFW"
          className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1"
        />
      </label>
      {status ? (
        <div
          className={`rounded border px-2 py-1 text-[10px] ${
            status.kind === "ok"
              ? "border-keep-action/40 bg-keep-action/10 text-keep-action"
              : "border-keep-accent/40 bg-keep-accent/10 text-keep-accent"
          }`}
        >
          {status.message}
        </div>
      ) : null}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/20 disabled:opacity-50"
        >
          {busy ? "Clearing…" : "Clear"}
        </button>
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
 *  Items sub-tab — full CRUD on the items catalog.
 *
 *  Mirrors the Name Styles editor shape: sidebar list of items
 *  + an editor pane on the right. The editor exposes identity
 *  (key/name/plural/description), visuals (icon URL), economy
 *  (price/stack limit), availability (enabled + forSale + sale
 *  window), and per-command message tables for /give /throw /drop.
 *
 *  Built-in seed items (migration 0094) carry `isBuiltin=1` and are
 *  delete-protected — admins can rewrite every field except the
 *  key, but the row stays. Custom items are fully deletable; the
 *  server cascades the FK on identity_inventory so deleting a
 *  custom item drops every outstanding inventory stack of it.
 * ========================================================= */

function ItemsSection() {
  const [rows, setRows] = useState<AdminItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // null = browsing the catalog grid. Non-null = editing that key.
  // `creating` is a separate flag so a brand-new-item editor doesn't
  // collide with the selectedKey state machine.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Browse-mode filters. Category chip + text search keep the grid
  // manageable as the catalog grows past 60+ items. State doesn't
  // persist across mounts — admins re-filter per session.
  const [filterCategory, setFilterCategory] = useState<ItemCategory | "all">("all");
  const [query, setQuery] = useState("");

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchAdminItems();
      setRows(r.items);
      if (selectedKey && !r.items.some((s) => s.key === selectedKey)) {
        setSelectedKey(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load items");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  const selected = useMemo(
    () => rows.find((r) => r.key === selectedKey) ?? null,
    [rows, selectedKey],
  );

  // Filtered grid contents. Pure derivation from rows + filter inputs;
  // the underlying array stays sorted by `order` from the API.
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filterCategory !== "all" && r.category !== filterCategory) return false;
      if (q.length > 0) {
        const haystack = `${r.key} ${r.name} ${r.namePlural ?? ""} ${r.aliases.join(" ")}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filterCategory, query]);

  if (loading) return <p className="text-sm text-keep-muted">Loading items…</p>;

  // EDIT MODE — full-width editor with a back-to-catalog button.
  // We swap the entire view rather than splitting because the editor
  // already runs long (header + messages + sale window + commands)
  // and a side-by-side split made it cramped on anything below
  // ultrawide. Full-width also means the editor's two-column form
  // (sm:grid-cols-2 / sm:grid-cols-3) actually has room to breathe.
  if (creating || selected) {
    return (
      <div className="space-y-3">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => { setCreating(false); setSelectedKey(null); }}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-banner hover:text-keep-text"
              title="Back to the catalog grid"
            >
              ← Back
            </button>
            <h3 className="font-action text-base">
              {creating ? "New item" : selected?.name}
            </h3>
          </div>
        </header>
        {err ? (
          <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
        ) : null}
        {creating ? (
          <ItemEditor
            kind="create"
            initial={{
              key: "",
              name: "",
              namePlural: null,
              description: "",
              iconUrl: null,
              price: 0,
              stackLimit: 99,
              giveMessages: [],
              throwMessages: [],
              dropMessages: [],
              aliases: [],
              category: "misc",
              enabled: true,
              forSale: true,
              saleStartsAt: null,
              saleEndsAt: null,
              order: 0,
              isBuiltin: false,
              owners: 0,
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
          // `key={selected.key}` forces a fresh mount when the admin
          // pivots from one card to another via the editor's
          // jump-to-edit links — useState(initial.*) in the editor
          // only runs on first mount, so without the key prop the
          // form fields stay frozen on the originally-selected row.
          <ItemEditor
            key={selected.key}
            kind="edit"
            initial={selected}
            onCancel={() => setSelectedKey(null)}
            onSaved={async () => { await refresh(); }}
            onError={setErr}
          />
        ) : null}
      </div>
    );
  }

  // BROWSE MODE — header + filter + responsive card grid.
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-action text-base">Items</h3>
          <p className="text-xs text-keep-muted">
            Catalog of collectible items users buy with Currency, hand to each other via /give, or toss at each other via /throw and /drop. Every identity (OOC master + each character) keeps an independent inventory; nothing is shared across identities.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setCreating(true); setSelectedKey(null); }}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-sm text-keep-action hover:bg-keep-action/25"
        >
          + New item
        </button>
      </header>

      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-sm text-keep-accent">{err}</div>
      ) : null}

      {/* Filter row — category select + free-text search. Both narrow
          the visible grid so the admin doesn't scroll an infinite list.
          Empty categories are hidden from the picker so it doesn't
          carry dead "Weapons (0)" rows. */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value as ItemCategory | "all")}
          aria-label="Filter by category"
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        >
          <option value="all">All categories ({rows.length})</option>
          {ITEM_CATEGORIES
            .filter((c) => rows.some((r) => r.category === c))
            .map((c) => (
              <option key={c} value={c}>
                {ITEM_CATEGORY_LABELS[c]} ({rows.filter((r) => r.category === c).length})
              </option>
            ))}
        </select>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, key, or alias…"
          className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        />
        <span className="text-xs text-keep-muted">
          Showing {filteredRows.length} of {rows.length}
        </span>
      </div>

      {/* Card grid. 2 cols mobile → 6 at xl so a wide admin viewport
          shows many items per row. Each card is icon-first so the
          admin scans visually instead of reading every name. */}
      {filteredRows.length === 0 ? (
        <p className="text-sm text-keep-muted">No items match the current filter.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {filteredRows.map((r) => (
            <ItemCard
              key={r.key}
              row={r}
              onClick={() => { setSelectedKey(r.key); setCreating(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Icon-first card. Image at top, name + price + category chip + a
 *  status chip for at-a-glance scanning. Clicking opens the full
 *  editor. The fallback letter-tile mirrors the same renderer the
 *  user-facing dashboard uses (apps/web ItemIcon-equivalent) so the
 *  admin sees what the user would see for items without uploaded
 *  artwork.
 *
 *  Card prioritizes visual scan over data density:
 *    - Icon: 64px square, top
 *    - Name: bold, line-clamp(1)
 *    - Price + category as a single meta line
 *    - One status chip MAX (the most relevant one), so cards stay
 *      same-height in the grid. The full chip set is back in the
 *      editor for power-user disambiguation. */
function ItemCard({
  row,
  onClick,
}: {
  row: AdminItemRow;
  onClick: () => void;
}) {
  const now = Date.now();
  // Pick ONE status to surface on the card. Disabled wins over "not
  // for sale" wins over the sale-window chips. Builtin is shown
  // separately as a tiny corner badge to free up the status slot.
  let status: { label: string; tone: "muted" | "warn" | "info" } | null = null;
  if (!row.enabled) status = { label: "disabled", tone: "warn" };
  else if (!row.forSale) status = { label: "not for sale", tone: "muted" };
  else if (row.saleStartsAt && now < row.saleStartsAt) {
    status = { label: `opens in ${formatDurationShort(row.saleStartsAt - now)}`, tone: "info" };
  } else if (row.saleEndsAt && now >= row.saleEndsAt) {
    status = { label: "sale ended", tone: "warn" };
  } else if (row.saleEndsAt && now < row.saleEndsAt) {
    status = { label: `ends in ${formatDurationShort(row.saleEndsAt - now)}`, tone: "info" };
  }
  const statusToneClass =
    status?.tone === "warn" ? "border-keep-accent/40 bg-keep-accent/10 text-keep-accent" :
    status?.tone === "info" ? "border-keep-action/40 bg-keep-action/10 text-keep-action" :
    "border-keep-rule bg-keep-banner/40 text-keep-muted";

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${row.name} — ${row.description || "(no description)"}`}
      className="group relative flex flex-col items-center gap-1 rounded border border-keep-rule bg-keep-bg/40 p-2 text-center text-xs hover:border-keep-action hover:bg-keep-banner"
    >
      {row.isBuiltin ? (
        <span
          className="absolute right-1 top-1 rounded border border-keep-rule/60 bg-keep-bg/80 px-1 text-[8px] uppercase tracking-widest text-keep-muted"
          title="Seeded built-in. Delete-protected; every field still editable."
        >
          B
        </span>
      ) : null}
      {row.iconUrl ? (
        <img
          src={row.iconUrl}
          alt=""
          width={64}
          height={64}
          loading="lazy"
          className="rounded border border-keep-rule/40 bg-keep-bg object-contain"
        />
      ) : (
        <div
          className="grid h-16 w-16 place-items-center rounded border border-keep-rule/40 bg-keep-banner/40"
          aria-hidden="true"
        >
          <span className="text-lg font-semibold text-keep-muted">
            {row.name.slice(0, 1).toUpperCase()}
          </span>
        </div>
      )}
      <span className="line-clamp-1 w-full break-all font-semibold text-keep-text">
        {row.name}
      </span>
      <span className="text-[10px] uppercase tracking-widest text-keep-muted">
        {row.price.toLocaleString()} · {ITEM_CATEGORY_LABELS[row.category]}
      </span>
      {status ? (
        <span className={`rounded border px-1.5 py-0 text-[9px] uppercase tracking-widest ${statusToneClass}`}>
          {status.label}
        </span>
      ) : null}
    </button>
  );
}

/** Human-readable short duration: "3h", "2d 4h", "12m". Used by the
 *  sidebar's sale-window chips so the admin sees at a glance how
 *  long until a sale opens / closes. */
function formatDurationShort(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) {
    const mins = totalMin % 60;
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

function ItemEditor({
  kind,
  initial,
  onCancel,
  onSaved,
  onError,
}: {
  kind: "edit" | "create";
  initial: AdminItemRow;
  onCancel: () => void;
  onSaved: (key: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [key, setKey] = useState(initial.key);
  const [name, setName] = useState(initial.name);
  const [namePlural, setNamePlural] = useState(initial.namePlural ?? "");
  const [description, setDescription] = useState(initial.description);
  const [iconUrl, setIconUrl] = useState(initial.iconUrl ?? "");
  const [price, setPrice] = useState(initial.price);
  const [stackLimit, setStackLimit] = useState(initial.stackLimit);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [forSale, setForSale] = useState(initial.forSale);
  const [saleStartsAt, setSaleStartsAt] = useState<number | null>(initial.saleStartsAt);
  const [saleEndsAt, setSaleEndsAt] = useState<number | null>(initial.saleEndsAt);
  // Messages stored as newline-joined text in the textarea state for
  // ergonomics; we split on save so an empty array means "command
  // disabled for this item" without any extra toggle.
  const [giveMessages, setGiveMessages] = useState(initial.giveMessages.join("\n"));
  const [throwMessages, setThrowMessages] = useState(initial.throwMessages.join("\n"));
  const [dropMessages, setDropMessages] = useState(initial.dropMessages.join("\n"));
  // Aliases stored as a comma-separated string in the textarea — typed
  // inline in one row rather than line-per-entry like messages, since
  // alias lists are short and read more naturally as a single line.
  const [aliasesText, setAliasesText] = useState(initial.aliases.join(", "));
  const [category, setCategory] = useState<ItemCategory>(initial.category);
  const [saving, setSaving] = useState(false);

  function splitMessages(s: string): string[] {
    return s.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /** Parse the aliases field — split by commas, trim whitespace, drop
   *  empties + dupes (case-insensitive). Keeps storage tight and
   *  avoids accidental "  drink ,  drink  " bloating the array. */
  function splitAliases(s: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of s.split(",")) {
      const v = raw.trim();
      if (!v) continue;
      const lower = v.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(v);
    }
    return out;
  }

  async function save() {
    setSaving(true);
    try {
      const payload = {
        name,
        namePlural: namePlural.trim() ? namePlural.trim() : null,
        description,
        iconUrl: iconUrl.trim() ? iconUrl.trim() : null,
        price,
        stackLimit,
        giveMessages: splitMessages(giveMessages),
        throwMessages: splitMessages(throwMessages),
        dropMessages: splitMessages(dropMessages),
        aliases: splitAliases(aliasesText),
        category,
        enabled,
        forSale,
        saleStartsAt,
        saleEndsAt,
      };
      if (kind === "create") {
        await createAdminItem({ key, ...payload });
        await onSaved(key);
      } else {
        await patchAdminItem(initial.key, payload);
        await onSaved(initial.key);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(
      initial.owners > 0
        ? `Delete "${initial.name}"? ${initial.owners} identit${initial.owners === 1 ? "y owns" : "ies own"} it — every stack will be wiped.`
        : `Delete "${initial.name}"?`,
    )) return;
    try {
      await deleteAdminItem(initial.key);
      onCancel();
      await onSaved(initial.key);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  // Live "Available …" readout that summarizes the layered enabled /
  // forSale / window switches into one human sentence. Mirrors the
  // server-side `purchasable` computation so the admin sees exactly
  // what users will see when the row saves.
  const availabilitySummary = useMemo(() => {
    if (!enabled) return "Hidden everywhere (enabled = off).";
    if (!forSale) return "Exists, but not in the shop right now.";
    const now = Date.now();
    if (saleStartsAt && now < saleStartsAt) {
      return `Sale starts ${new Date(saleStartsAt).toLocaleString()} (in ${formatDurationShort(saleStartsAt - now)}).`;
    }
    if (saleEndsAt && now >= saleEndsAt) {
      return `Sale ended ${new Date(saleEndsAt).toLocaleString()}.`;
    }
    if (saleEndsAt) {
      return `On sale until ${new Date(saleEndsAt).toLocaleString()} (in ${formatDurationShort(saleEndsAt - now)}).`;
    }
    if (saleStartsAt) {
      return `On sale since ${new Date(saleStartsAt).toLocaleString()}. No end date.`;
    }
    return "On sale (no time limit).";
  }, [enabled, forSale, saleStartsAt, saleEndsAt]);

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
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Plural (optional)</span>
          <input
            value={namePlural}
            onChange={(e) => setNamePlural(e.target.value)}
            placeholder={`${name}s`}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Icon URL</span>
          <input
            value={iconUrl}
            onChange={(e) => setIconUrl(e.target.value)}
            placeholder="/assets/items/cookie.png"
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
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Aliases (comma-separated)</span>
        <input
          value={aliasesText}
          onChange={(e) => setAliasesText(e.target.value)}
          placeholder="e.g. knife, blade"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          Casual names users can type instead of the canonical name. Whitespace + case ignored, duplicates dropped.
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Price (Currency)</span>
          <input
            type="number"
            min={0}
            value={price}
            onChange={(e) => setPrice(Number(e.target.value) || 0)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Stack limit</span>
          <input
            type="number"
            min={1}
            value={stackLimit}
            onChange={(e) => setStackLimit(Math.max(1, Number(e.target.value) || 1))}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Category</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ItemCategory)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          >
            {ITEM_CATEGORIES.map((c) => (
              <option key={c} value={c}>{ITEM_CATEGORY_LABELS[c]}</option>
            ))}
          </select>
          <span className="mt-0.5 block text-[10px] text-keep-muted">
            Drives the shop bucket. <code>pet</code> routes to the 5-slot Pet Collection; everything else to the 10-slot Item Collection.
          </span>
        </label>
      </div>

      {/* Availability block — layered switches with a live summary. */}
      <fieldset className="space-y-2 rounded border border-keep-rule/60 bg-keep-banner/20 p-2">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-keep-muted">Availability</legend>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            enabled (item exists at all)
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={forSale} onChange={(e) => setForSale(e.target.checked)} disabled={!enabled} />
            for sale (shop visibility)
          </label>
        </div>
        <SaleWindowControls
          saleStartsAt={saleStartsAt}
          saleEndsAt={saleEndsAt}
          onChangeStart={setSaleStartsAt}
          onChangeEnd={setSaleEndsAt}
          disabled={!enabled || !forSale}
        />
        <p className="rounded border border-keep-rule/40 bg-keep-bg/40 p-2 text-[11px] text-keep-muted">
          {availabilitySummary}
        </p>
      </fieldset>

      {/* Per-command message tables. Empty array = command disabled. */}
      <fieldset className="space-y-3 rounded border border-keep-rule/60 bg-keep-banner/20 p-2">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-keep-muted">Command messages — one template per line. Placeholders: {"{sender}"} {"{target}"} {"{num}"} {"{item_name}"} {"{icon}"} (inline image of this item's icon). Leave blank to disable that command for this item.</legend>
        <CommandMessageEditor label="/give" hint="Transfers the item to the target's inventory." value={giveMessages} onChange={setGiveMessages} />
        <CommandMessageEditor label="/throw" hint="Consumes the item as a silly weapon — target gets nothing." value={throwMessages} onChange={setThrowMessages} />
        <CommandMessageEditor label="/drop" hint="Consumes the item as a 'drop on someone' gag — target gets nothing." value={dropMessages} onChange={setDropMessages} />
      </fieldset>

      {initial.isBuiltin ? (
        <p className="text-[10px] uppercase tracking-widest text-keep-muted">built-in (delete protected) · {initial.owners} owner{initial.owners === 1 ? "" : "s"}</p>
      ) : (
        <p className="text-[10px] uppercase tracking-widest text-keep-muted">{initial.owners} owner{initial.owners === 1 ? "" : "s"}</p>
      )}

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
          disabled={saving || (kind === "create" && !key.match(/^[a-z][a-z0-9_]*$/)) || !name.trim()}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-sm text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {saving ? "Saving…" : kind === "create" ? "Create" : "Save"}
        </button>
      </div>
    </div>
  );
}

/** Per-command message textarea + a small hint line. Lives in its own
 *  component so each command panel shares the same shape and the
 *  outer editor can stay readable. */
function CommandMessageEditor({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (s: string) => void;
}) {
  const lines = value.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <code className="text-xs font-mono text-keep-action">{label}</code>
        <span className="text-[11px] text-keep-muted">{hint}</span>
        <span className="ml-auto text-[10px] uppercase tracking-widest text-keep-muted">
          {lines.length === 0 ? "disabled" : `${lines.length} template${lines.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={`e.g. {sender} hands {target} {num} {icon} {item_name}.`}
        className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-xs"
      />
    </div>
  );
}

/** Sale window scheduler. Two datetime-local inputs + a "Sell for
 *  the next N hours/days" convenience widget that auto-fills the
 *  window from now. Each input is independent — clearing one leaves
 *  the other intact. */
function SaleWindowControls({
  saleStartsAt,
  saleEndsAt,
  onChangeStart,
  onChangeEnd,
  disabled,
}: {
  saleStartsAt: number | null;
  saleEndsAt: number | null;
  onChangeStart: (v: number | null) => void;
  onChangeEnd: (v: number | null) => void;
  disabled: boolean;
}) {
  const [quickN, setQuickN] = useState(7);
  const [quickUnit, setQuickUnit] = useState<"hours" | "days">("days");

  function applyQuick() {
    const ms = quickUnit === "hours" ? quickN * 3600_000 : quickN * 86400_000;
    const now = Date.now();
    onChangeStart(now);
    onChangeEnd(now + ms);
  }

  function clearWindow() {
    onChangeStart(null);
    onChangeEnd(null);
  }

  return (
    <div className={`space-y-2 ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-[11px]">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Sale starts at</span>
          <DateTimeInput value={saleStartsAt} onChange={onChangeStart} />
        </label>
        <label className="block text-[11px]">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Sale ends at</span>
          <DateTimeInput value={saleEndsAt} onChange={onChangeEnd} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-keep-muted">Sell for the next</span>
        <input
          type="number"
          min={1}
          value={quickN}
          onChange={(e) => setQuickN(Math.max(1, Number(e.target.value) || 1))}
          className="w-16 rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-right"
        />
        <select
          value={quickUnit}
          onChange={(e) => setQuickUnit(e.target.value as "hours" | "days")}
          className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5"
        >
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
        <button
          type="button"
          onClick={applyQuick}
          className="rounded border border-keep-action bg-keep-action/15 px-2 py-0.5 text-keep-action hover:bg-keep-action/25"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={clearWindow}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-keep-muted hover:text-keep-text"
        >
          Clear window
        </button>
      </div>
    </div>
  );
}

/** Wrapper around `<input type="datetime-local">` that round-trips a
 *  unix-ms number against the browser's local-time string format.
 *  Empty input → null. */
function DateTimeInput({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  // Convert epoch ms to "YYYY-MM-DDTHH:MM" in the local timezone. The
  // datetime-local input expects no timezone suffix; toISOString would
  // give UTC and shift the displayed time off the admin's expectation.
  function fmt(ms: number | null): string {
    if (!ms) return "";
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return (
    <input
      type="datetime-local"
      value={fmt(value)}
      onChange={(e) => {
        if (!e.target.value) { onChange(null); return; }
        const parsed = new Date(e.target.value).getTime();
        onChange(Number.isFinite(parsed) ? parsed : null);
      }}
      className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
    />
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

  // Load the rank/style/item catalogs so the pickers populate from
  // the live catalog rather than hardcoded lists. We piggyback on
  // the three existing admin endpoints.
  const [ranks, setRanks] = useState<AdminRankRow[]>([]);
  const [tiers, setTiers] = useState<AdminTierRow[]>([]);
  const [styles, setStyles] = useState<AdminNameStyleRow[]>([]);
  const [itemsCatalog, setItemsCatalog] = useState<AdminItemRow[]>([]);
  const [freeformBorders, setFreeformBorders] = useState<AdminFreeformBorderRow[]>([]);
  useEffect(() => {
    void Promise.all([
      fetchAdminRanks().then((r) => { setRanks(r.ranks); setTiers(r.tiers); }),
      fetchAdminNameStyles().then((r) => setStyles(r.styles)),
      fetchAdminItems().then((r) => setItemsCatalog(r.items)),
      fetchAdminFreeformBorders().then((r) => setFreeformBorders(r.borders)),
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

      <SectionFrame
        title="Grant item"
        description="Deposit (positive) or revoke (negative) units of an item into the target's OOC master inventory. Bypasses the shop's enabled / forSale / sale-window checks so admins can pre-seed testers with items that aren't yet on sale. Character-scoped grants live on the character's own inventory; this row only writes the OOC pool. Stack-cap enforced server-side; overflow returns a 409."
      >
        <GrantItemRow
          items={itemsCatalog}
          busy={busy}
          onSubmit={(itemKey, quantity) =>
            run(
              `${quantity > 0 ? "Grant" : "Revoke"} ${Math.abs(quantity)} ${itemKey}`,
              async () => { await adminGrantItem(target, itemKey, quantity); },
            )
          }
        />
      </SectionFrame>

      {/* ---- Free-form border grant / revoke (Phase 1 catalog) ---- */}
      <SectionFrame
        title="Grant free-form border"
        description="Inserts ownership for the chosen free-form border (master pool). Idempotent. Auto-equips on first acquisition if the identity has no freeform border equipped — matches the user-facing purchase behavior."
      >
        <GrantPickerRow
          options={freeformBorders.map((b) => ({ value: b.key, label: `${b.name} (${b.rarity})` }))}
          placeholder={freeformBorders.length === 0 ? "No free-form borders defined" : "Pick a border…"}
          busy={busy}
          buttonLabel="Grant border"
          onPick={(key) => run(`Grant freeform border ${key}`, () => adminGrantFreeformBorder(target, key))}
        />
      </SectionFrame>

      <SectionFrame
        title="Revoke free-form border"
        description="Removes ownership of the chosen free-form border from the target's master pool. If they had it equipped, the equip slot clears too. Idempotent on unowned."
      >
        <GrantPickerRow
          options={freeformBorders.map((b) => ({ value: b.key, label: `${b.name} (${b.rarity})` }))}
          placeholder={freeformBorders.length === 0 ? "No free-form borders defined" : "Pick a border…"}
          busy={busy}
          buttonLabel="Revoke border"
          onPick={(key) => run(`Revoke freeform border ${key}`, () => adminRevokeFreeformBorder(target, key))}
        />
      </SectionFrame>

      {/* ---- Revoke for the existing rank-tier catalog rows ---- */}
      <SectionFrame
        title="Revoke rank border"
        description="Removes the chosen rank-tier border from the target's owned set. Clears the equip slot if it pointed at this border."
      >
        <GrantPickerRow
          options={ranks
            .filter((r) => tier4ByRank.has(r.key) && tier4ByRank.get(r.key)!.borderImageUrl)
            .map((r) => ({ value: r.key, label: r.name }))}
          placeholder="Pick a rank…"
          busy={busy}
          buttonLabel="Revoke border"
          onPick={(rankKey) => run(`Revoke border ${rankKey}`, () => adminRevokeBorder(target, rankKey))}
        />
      </SectionFrame>

      <SectionFrame
        title="Revoke name style"
        description="Removes the chosen name-style ownership row. Clears the active-cosmetics slot if the style was equipped."
      >
        <GrantPickerRow
          options={styles.map((s) => ({ value: s.key, label: s.name }))}
          placeholder="Pick a style…"
          busy={busy}
          buttonLabel="Revoke style"
          onPick={(styleKey) => run(`Revoke style ${styleKey}`, () => adminRevokeStyle(target, styleKey))}
        />
      </SectionFrame>
    </div>
  );
}

/** Item grant picker — item + signed quantity. Same shape as the
 *  other GrantPickerRow rows but with an extra numeric input. Empty
 *  catalog renders a small explainer pointing the admin at the Items
 *  sub-tab so they can seed at least one item first. */
function GrantItemRow({
  items,
  busy,
  onSubmit,
}: {
  items: AdminItemRow[];
  busy: boolean;
  onSubmit: (itemKey: string, quantity: number) => void;
}) {
  const [itemKey, setItemKey] = useState<string>("");
  const [quantity, setQuantity] = useState<number>(1);
  if (items.length === 0) {
    return (
      <p className="text-xs text-keep-muted">
        No items in the catalog yet — create one in the Items sub-tab first.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select
        value={itemKey}
        onChange={(e) => setItemKey(e.target.value)}
        className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
      >
        <option value="">Pick an item…</option>
        {items.map((i) => (
          <option key={i.key} value={i.key}>
            {i.name}{i.enabled ? "" : " (disabled)"}
          </option>
        ))}
      </select>
      <input
        type="number"
        value={quantity}
        onChange={(e) => setQuantity(Number(e.target.value) || 0)}
        className="w-20 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-right text-sm"
      />
      <button
        type="button"
        onClick={() => itemKey && quantity !== 0 && onSubmit(itemKey, quantity)}
        disabled={busy || !itemKey || quantity === 0}
        className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
      >
        {quantity >= 0 ? "Grant" : "Revoke"}
      </button>
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

/* ============================================================
 *  Flash Sale sub-tab
 *
 *  Two panels in one section:
 *    1. Today's picks (read-only — the resolver has already made
 *       its choice for today; the only way to change it is queue
 *       an override for a FUTURE date).
 *    2. Future queue — one row per (category, date) override.
 *       Admin picks a target key + optional discount %. Queueing
 *       null target removes the queue (day falls back to random).
 *
 *  Plus a settings strip across the top: per-category enable
 *  toggles + the global default discount %.
 * ============================================================ */
function FlashSaleSection() {
  const [data, setData] = useState<AdminFlashSaleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [styles, setStyles] = useState<AdminNameStyleRow[]>([]);
  const [allItems, setAllItems] = useState<AdminItemRow[]>([]);
  const [allCosmetics, setAllCosmetics] = useState<AdminCosmeticRow[]>([]);
  const [allFreeformBorders, setAllFreeformBorders] = useState<AdminFreeformBorderRow[]>([]);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const [fs, ns, items, cos, fb] = await Promise.all([
        fetchAdminFlashSale(),
        fetchAdminNameStyles(),
        fetchAdminItems(),
        fetchAdminCosmetics(),
        fetchAdminFreeformBorders(),
      ]);
      setData(fs);
      setStyles(ns.styles);
      setAllItems(items.items);
      setAllCosmetics(cos.cosmetics);
      setAllFreeformBorders(fb.borders);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  if (loading) return <p className="text-sm text-keep-muted">Loading flash-sale state…</p>;
  if (!data) return <p className="text-sm text-keep-accent">{err ?? "Load failed."}</p>;

  // The "for_date" the override form starts at — tomorrow. Admins
  // can edit the date input to queue further out, but tomorrow is
  // the most common case.
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h3 className="font-action text-base">Flash Sale</h3>
        <p className="text-xs text-keep-muted">
          One row per category goes on sale each UTC day. Today's picks are read-only — the
          resolver has already chosen. Queue a specific row for any future date, or leave a
          date un-queued to keep it random. Override targets that get disabled in the catalog
          before resolution day still get picked (admin intent wins over availability).
        </p>
      </header>

      <FlashSaleSettings settings={data.settings} onSaved={refresh} />

      <section className="rounded border border-keep-rule bg-keep-bg/40 p-3">
        <h4 className="mb-2 font-action text-sm uppercase tracking-widest text-keep-muted">Today</h4>
        <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <FlashSaleTodayCell label="Name Style" keyVal={data.today.nameStyleKey} discount={data.today.nameStyleDiscountPct} />
          <FlashSaleTodayCell label="Border" keyVal={data.today.freeformBorderKey} discount={data.today.freeformBorderDiscountPct} />
          <FlashSaleTodayCell label="Item" keyVal={data.today.itemKey} discount={data.today.itemDiscountPct} />
          <FlashSaleTodayCell label="Cosmetic" keyVal={data.today.cosmeticKey} discount={data.today.cosmeticDiscountPct} />
        </div>
      </section>

      <section className="rounded border border-keep-rule bg-keep-bg/40 p-3">
        <h4 className="mb-2 font-action text-sm uppercase tracking-widest text-keep-muted">
          Queue for {data.tomorrow} or later
        </h4>
        <p className="mb-2 text-xs text-keep-muted">
          Pick a row + an optional per-pick discount. Click Save to queue. Setting target to
          "(random)" removes any existing queue for that slot.
        </p>
        <div className="space-y-2">
          {(["name_style", "freeform_border", "item", "cosmetic"] as const).map((cat) => (
            <FlashSaleOverrideRow
              key={cat}
              category={cat}
              defaultDate={data.tomorrow}
              allOverrides={data.overrides}
              styles={styles}
              items={allItems}
              cosmetics={allCosmetics}
              freeformBorders={allFreeformBorders}
              onSaved={refresh}
            />
          ))}
        </div>
        {data.overrides.length > 0 ? (
          <div className="mt-3 border-t border-keep-rule pt-3">
            <h5 className="mb-2 text-[10px] uppercase tracking-widest text-keep-muted">
              All queued ({data.overrides.length})
            </h5>
            <ul className="space-y-1 text-xs">
              {data.overrides.map((o) => (
                <li key={`${o.category}:${o.forDate}`} className="flex flex-wrap items-center gap-2 rounded border border-keep-rule/60 bg-keep-bg px-2 py-1">
                  <span className="text-keep-muted">{o.forDate}</span>
                  <span className="rounded bg-keep-banner px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-keep-text">{o.category}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{o.targetKey}</span>
                  {o.discountPct != null ? (
                    <span className="text-keep-action">-{o.discountPct}%</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
    </div>
  );
}

function FlashSaleTodayCell({ label, keyVal, discount }: { label: string; keyVal: string | null; discount: number | null }) {
  return (
    <div className="rounded border border-keep-rule bg-keep-bg p-2">
      <div className="text-[10px] uppercase tracking-widest text-keep-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-xs text-keep-text">{keyVal ?? "(none)"}</div>
      {discount != null ? (
        <div className="text-[10px] text-keep-action">-{discount}% off</div>
      ) : null}
    </div>
  );
}

function FlashSaleSettings({
  settings,
  onSaved,
}: {
  settings: AdminFlashSaleResponse["settings"];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setDraft(settings); }, [settings]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await patchAdminFlashSaleSettings(draft);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40 p-3">
      <h4 className="mb-2 font-action text-sm uppercase tracking-widest text-keep-muted">Settings</h4>
      <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex items-center gap-2">
          <span className="text-xs text-keep-muted">Default discount %</span>
          <input
            type="number"
            min={1}
            max={99}
            value={draft.defaultDiscountPct}
            onChange={(e) => setDraft({ ...draft, defaultDiscountPct: Math.max(1, Math.min(99, Number.parseInt(e.target.value, 10) || 25)) })}
            className="w-16 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm"
          />
        </label>
        <ToggleLabel checked={draft.stylesEnabled} onChange={(v) => setDraft({ ...draft, stylesEnabled: v })} label="Name Styles" />
        <ToggleLabel checked={draft.freeformBordersEnabled} onChange={(v) => setDraft({ ...draft, freeformBordersEnabled: v })} label="Borders" />
        <ToggleLabel checked={draft.itemsEnabled} onChange={(v) => setDraft({ ...draft, itemsEnabled: v })} label="Items" />
        <ToggleLabel checked={draft.cosmeticsEnabled} onChange={(v) => setDraft({ ...draft, cosmeticsEnabled: v })} label="Flair" />
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        {err ? <span className="mr-auto text-xs text-keep-accent">{err}</span> : null}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </section>
  );
}

function ToggleLabel({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function FlashSaleOverrideRow({
  category,
  defaultDate,
  allOverrides,
  styles,
  items,
  cosmetics,
  freeformBorders,
  onSaved,
}: {
  category: "name_style" | "item" | "cosmetic" | "freeform_border";
  defaultDate: string;
  allOverrides: AdminFlashSaleResponse["overrides"];
  styles: AdminNameStyleRow[];
  items: AdminItemRow[];
  cosmetics: AdminCosmeticRow[];
  freeformBorders: AdminFreeformBorderRow[];
  onSaved: () => void;
}) {
  const [date, setDate] = useState<string>(defaultDate);
  // `existing` is derived from the CURRENT date state, not a static
  // prop — so when the admin types a different future date into the
  // input, the row immediately reflects "is there already a queue
  // for this category on that date?" instead of frozenly showing
  // whatever tomorrow's queue happens to be. Empty string in
  // target = "(random)" = no queue.
  const existing = useMemo(
    () => allOverrides.find((o) => o.category === category && o.forDate === date) ?? null,
    [allOverrides, category, date],
  );
  const [target, setTarget] = useState<string>(existing?.targetKey ?? "");
  const [discount, setDiscount] = useState<string>(existing?.discountPct != null ? String(existing.discountPct) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Sync the local form draft to the derived `existing` so a date
  // change (or a parent refresh after Save) populates the row with
  // whatever's currently queued for that (category, date) — instead
  // of leaving a stale "40%" in the discount field after navigating
  // to a date with no queue. The lookup is by-value of the derived
  // record, so React only re-runs these when the actual existing row
  // changes.
  useEffect(() => { setTarget(existing?.targetKey ?? ""); }, [existing?.targetKey]);
  useEffect(() => {
    setDiscount(existing?.discountPct != null ? String(existing.discountPct) : "");
  }, [existing?.discountPct]);
  // Parent refresh after Save can also shift `defaultDate` (e.g.,
  // calendar rolls over mid-session and tomorrow is now a new day);
  // reset the row's date to match unless the admin moved it manually.
  // We only follow defaultDate when the row hasn't been edited away.
  useEffect(() => { setDate((cur) => (cur === defaultDate ? defaultDate : cur)); }, [defaultDate]);

  // Options come from the corresponding catalog. Disabled rows are
  // included — admins can pin one anyway (intent wins over availability).
  const options: Array<{ key: string; name: string }> =
    category === "name_style" ? styles.map((s) => ({ key: s.key, name: s.name }))
    : category === "item" ? items.map((i) => ({ key: i.key, name: i.name }))
    : category === "cosmetic" ? cosmetics.map((c) => ({ key: c.key, name: c.name }))
    : freeformBorders.map((b) => ({ key: b.key, name: b.name }));

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const discountPct = discount.trim() === "" ? null : Math.max(1, Math.min(99, Number.parseInt(discount, 10) || 0));
      await putAdminFlashSaleOverride({
        category,
        forDate: date,
        targetKey: target || null,
        discountPct,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const label = category === "name_style" ? "Name Style"
    : category === "item" ? "Item"
    : category === "cosmetic" ? "Cosmetic"
    : "Border";

  return (
    <div className="grid items-center gap-2 rounded border border-keep-rule bg-keep-bg p-2 text-xs sm:grid-cols-[120px_140px_1fr_80px_auto]">
      <div className="font-semibold text-keep-text">{label}</div>
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
      />
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="rounded border border-keep-rule bg-keep-bg px-2 py-1"
      >
        <option value="">(random)</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>{o.name} — {o.key}</option>
        ))}
      </select>
      <input
        type="number"
        placeholder="%"
        min={1}
        max={99}
        value={discount}
        onChange={(e) => setDiscount(e.target.value)}
        className="w-16 rounded border border-keep-rule bg-keep-bg px-2 py-1"
        title="Optional per-pick discount %"
      />
      <button
        type="button"
        onClick={save}
        disabled={busy}
        className="rounded border border-keep-action bg-keep-action/15 px-2 py-1 text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
      >
        {busy ? "…" : (target ? "Queue" : "Clear")}
      </button>
      {err ? <span className="col-span-full text-keep-accent">{err}</span> : null}
    </div>
  );
}

/* ============================================================
 *  Catalog Backup (export/import) sub-tab
 *
 *  Four catalogs available. Each gets an Export button (downloads
 *  a ZIP) and an Import button (file-picker → POST). Import is
 *  upsert-by-key; absent rows are left alone — see
 *  apps/server/src/admin/earningTransfer.ts for the semantics.
 * ============================================================ */
function CatalogTransferSection() {
  const kinds: ReadonlyArray<{ id: EarningTransferKind; label: string; help: string }> = [
    { id: "name-styles", label: "Name Styles", help: "Templates + CSS. No image assets." },
    { id: "items", label: "Items", help: "Catalog rows + icon images." },
    { id: "borders", label: "Borders", help: "Border image + cost on each Tier IV. Surgical: only border columns are touched on import." },
    { id: "freeform-borders", label: "Free-form Borders", help: "Non-rank-tied border catalog (image-mode and template+CSS-mode). Ownership ledgers are NOT exported." },
    { id: "ranks", label: "Ranks", help: "Full rank hierarchy: ranks + tiers + sigils + borders." },
  ];
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h3 className="font-action text-base">Catalog Backup</h3>
        <p className="text-xs text-keep-muted">
          Per-catalog ZIP export + import. Imports are <strong>upsert by key</strong> — rows you
          didn't include keep their existing values. Bundled `/uploads/*` images extract back to
          their original paths so a round-trip restores custom art too. Re-importing a file you
          just exported is a clean no-op.
        </p>
      </header>
      {kinds.map((k) => (
        <TransferRow key={k.id} kind={k.id} label={k.label} help={k.help} />
      ))}
    </div>
  );
}

function TransferRow({ kind, label, help }: { kind: EarningTransferKind; label: string; help: string }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [result, setResult] = useState<CatalogImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function onExport() {
    setBusy(true);
    setStatus(null);
    setResult(null);
    try {
      await downloadCatalogExport(kind);
      setStatus({ kind: "ok", text: "Export downloaded." });
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : "Export failed" });
    } finally {
      setBusy(false);
    }
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!f) return;
    if (!window.confirm(`Import ${f.name} into ${label}? This UPSERTS by key — existing rows with matching keys will be overwritten.`)) return;
    setBusy(true);
    setStatus(null);
    setResult(null);
    try {
      const r = await uploadCatalogImport(kind, f);
      setResult(r);
      setStatus({
        kind: "ok",
        text: `Import done. Inserted ${r.inserted}, updated ${r.updated}, ${r.writtenAssets.length} asset(s) written.`,
      });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : "Import failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{label}</div>
          <div className="text-xs text-keep-muted">{help}</div>
        </div>
        <button
          type="button"
          onClick={onExport}
          disabled={busy}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs hover:bg-keep-banner disabled:opacity-50"
        >
          {busy ? "Working…" : "Export ZIP"}
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="rounded border border-keep-action bg-keep-action/15 px-2 py-1 text-xs text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          Import ZIP…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          onChange={onImportFile}
          className="hidden"
        />
      </div>
      {status ? (
        <p className={`mt-2 text-xs ${status.kind === "ok" ? "text-keep-action" : "text-keep-accent"}`}>
          {status.text}
        </p>
      ) : null}
      {result && result.warnings.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-xs text-keep-muted">
          {result.warnings.map((w, i) => (<li key={i}>{w}</li>))}
        </ul>
      ) : null}
    </section>
  );
}
