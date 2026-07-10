/**
 * Server Admin → Earning tab (Multi-Server Lift — the "Admin Partition", §plan_ext F).
 *
 * The per-server twin of the OPS half of components/AdminEarningTab.tsx (the
 * global Earning admin), scoped to ONE server. A server owner/mod holding
 * `manage_earning` tunes THIS server's economy and grants / revokes / claws
 * back awards + cosmetics. Every fetch hits /servers/:id/earning and the routes
 * re-check the grant + scope every pool read/write by `server_id` on the server
 * side.
 *
 * CATALOGS ARE GLOBAL. The shared rank / item / name-style / border DEFINITIONS
 * and their PRICES are edited once in the global Admin panel and apply to every
 * server — this tab never edits them. Grants here reference a catalog key (the
 * server validates it against the live catalog and rejects a typo); claw-backs
 * are driven by the per-server ownership lookup so you only ever revoke what the
 * user actually holds ON THIS SERVER.
 *
 * House conventions (mirrors the sibling tabs in ServerSettingsView.tsx):
 *   - keep-* utility classes, no lib/servers.ts widening (inline fetch helpers).
 *   - props are the console's TabProps-style contract; this tab uses the server
 *     id + viewer state, plus busy/run/onSaved for the shared error + spinner
 *     plumbing the console owns.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type ServerViewerState } from "@thekeep/shared";
import { readError } from "../../lib/http.js";

interface EarningTabProps {
  serverId: string;
  viewer: ServerViewerState;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}

/* The faucet/sink config document this tab edits. Mirrors the per-server
 * EarningConfig shape the route accepts (the platform-only branches —
 * multiCharacterEarnDivisor / backfill / scriptorium — are NOT editable here;
 * the server resolves them from the platform default). */
interface AwardAmount { xp: number; currency: number }
interface SourceFlags { xp: boolean; currency: boolean }
interface LengthBonus { enabled: boolean; floorChars: number; ceilChars: number; maxMultiplier: number }
interface EarningConfig {
  enabled: boolean;
  awards: {
    message: { say: AwardAmount; action: AwardAmount; whisper: AwardAmount };
    forum: { topic: AwardAmount; reply: AwardAmount };
    presence: { perBlock: AwardAmount };
  };
  bodyFloorChars: number;
  messageQuality: {
    lengthBonus: { say: LengthBonus; action: LengthBonus; whisper: LengthBonus };
    spam: { enabled: boolean; minLengthToCheck: number; uniqueCharRatioFloor: number; dominantTokenRatioCap: number; echoLookback: number };
  };
  presenceBlockMinutes: number;
  presenceDailyBlockCap: number;
  enabledSources: { message: SourceFlags; forum: SourceFlags; presence: SourceFlags };
  currencyTransfer: {
    enabled: boolean;
    dailySendCap: number;
    dailyReceiveCap: number;
    minSenderAccountAgeDays: number;
    minRecipientAccountAgeDays: number;
    minTransferAmount: number;
    maxTransferAmount: number;
  };
}

/** Tri-state subsystem switches: null = inherit (subsystem available), true/false
 *  = this server's explicit override. */
interface SubsystemToggles {
  shop: boolean | null;
  ranks: boolean | null;
  nameStyles: boolean | null;
  borders: boolean | null;
  roomTransitions: boolean | null;
  cosmetics: boolean | null;
}

interface ConfigResponse {
  override: EarningConfig | null;
  config: EarningConfig;
  defaults: EarningConfig;
  inheriting: boolean;
  flashSaleEnabled: boolean;
  subsystems: SubsystemToggles;
}

interface OwnershipResponse {
  userId: string;
  username: string;
  pool: { xp: number; currency: number; rankKey: string | null; tier: number | null } | null;
  ownedStyles: string[];
  ownedBorders: string[];
  ownedFreeformBorders: string[];
  inventory: { itemKey: string; quantity: number }[];
  inventoryByCharacter: Record<string, { itemKey: string; quantity: number }[]>;
  characters: { id: string; name: string }[];
}

const inputClass = "w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm text-keep-text outline-none focus:border-keep-action";
const numClass = "w-24 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-right text-sm text-keep-text outline-none focus:border-keep-action";
const btnClass = "rounded border border-keep-rule px-2 py-0.5 text-xs text-keep-muted hover:text-keep-text disabled:opacity-50";
const primaryBtn = "rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50";

const sid = (id: string) => encodeURIComponent(id);

export default function EarningTab({ serverId, viewer, busy, run, onSaved }: EarningTabProps) {
  const { t } = useTranslation("servers");
  const canManage = viewer.isOwner || viewer.permissions.includes("manage_earning");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-keep-muted">{t("earningTab.heading")}</h2>
        <p className="text-[11px] text-keep-muted">
          {t("earningTab.blurb")}
        </p>
      </header>

      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">{error}</div> : null}

      <ConfigSection serverId={serverId} canManage={canManage} busy={busy} run={run} onSaved={onSaved} setError={setError} />
      {canManage ? <ImportBuiltinsSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} setError={setError} /> : null}
      {canManage ? <RanksSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} setError={setError} /> : null}
      {canManage ? <NameStylesSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} setError={setError} /> : null}
      {canManage ? <FreeformBordersSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} setError={setError} /> : null}
      {canManage ? <CosmeticsSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} setError={setError} /> : null}
      {canManage ? <ItemsSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} setError={setError} /> : null}
      {canManage ? <RoomTransitionsSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} setError={setError} /> : null}
      {canManage ? <FlashSaleSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} setError={setError} /> : null}
      {canManage ? <GrantsSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} setError={setError} /> : null}
      {canManage ? <ClawbackSection serverId={serverId} busy={busy} run={run} onSaved={onSaved} setError={setError} /> : null}
    </div>
  );
}

/** Shared props for the catalog editor sections (all gated on manage_earning). */
interface CatalogSectionProps {
  serverId: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
  setError: (e: string | null) => void;
}

/** Tri-state subsystem switch: Inherit (null) / On (true) / Off (false). */
function SubsystemToggle({ label, value, onChange, disabled }: {
  label: string; value: boolean | null; onChange: (v: boolean | null) => void; disabled?: boolean;
}) {
  const { t } = useTranslation("servers");
  const sel = value === null ? "inherit" : value ? "on" : "off";
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-keep-muted">
      <span className="text-keep-text">{label}</span>
      <select
        disabled={disabled}
        className="rounded border border-keep-rule bg-keep-bg px-1 py-0.5 text-[11px] text-keep-text outline-none focus:border-keep-action disabled:opacity-50"
        value={sel}
        onChange={(e) => onChange(e.target.value === "inherit" ? null : e.target.value === "on")}
      >
        <option value="inherit">{t("earningTab.inheritOption")}</option>
        <option value="on">{t("earningTab.onOption")}</option>
        <option value="off">{t("earningTab.offOption")}</option>
      </select>
    </label>
  );
}

/* =========================================================
 *  Faucet / sink config
 * ========================================================= */

function ConfigSection({
  serverId, canManage, busy, run, onSaved, setError,
}: {
  serverId: string;
  canManage: boolean;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
  setError: (e: string | null) => void;
}) {
  const { t } = useTranslation("servers");
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [config, setConfig] = useState<EarningConfig | null>(null);
  const [flashSale, setFlashSale] = useState(false);
  const [subsystems, setSubsystems] = useState<SubsystemToggles | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/servers/${sid(serverId)}/earning/config`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as ConfigResponse;
      setData(j);
      setConfig(structuredClone(j.config));
      setFlashSale(j.flashSaleEnabled);
      setSubsystems({ ...j.subsystems });
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("shared.loadFailed"));
    }
  }, [serverId, setError, t]);
  useEffect(() => { void load(); }, [load]);

  function edit(mut: (c: EarningConfig) => void) {
    setConfig((prev) => { if (!prev) return prev; const next = structuredClone(prev); mut(next); return next; });
    setDirty(true);
  }

  async function save() {
    if (!config) return;
    setSaving(true); setError(null);
    try {
      const r = await fetch(`/servers/${sid(serverId)}/earning/config`, {
        method: "PUT", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config, flashSaleEnabled: flashSale, subsystems: subsystems ?? undefined }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("shared.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function clearOverride() {
    if (!window.confirm(t("earningTab.clearOverrideConfirm"))) return;
    await run(async () => {
      const r = await fetch(`/servers/${sid(serverId)}/earning/config`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      await load();
      onSaved();
    });
  }

  function resetToDefaults() {
    if (!data) return;
    setConfig(structuredClone(data.defaults));
    setDirty(true);
  }

  if (!config || !data) return <p className="text-xs italic text-keep-muted">{t("shared.loading")}</p>;

  const amountRow = (kind: string, a: AwardAmount) => (
    <div className="flex items-center gap-2">
      <span className="w-28 text-[11px] text-keep-muted">{t(`earningTab.awardKind.${kind}`)}</span>
      <label className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-keep-muted">{t("earningTab.xp")}
        <input type="number" min={0} disabled={!canManage} className={numClass} value={a.xp}
          onChange={(e) => edit((c) => setAmount(c, kind, { ...a, xp: Math.max(0, Number(e.target.value) || 0) }))} />
      </label>
      <label className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-keep-muted">{t("earningTab.currency")}
        <input type="number" min={0} disabled={!canManage} className={numClass} value={a.currency}
          onChange={(e) => edit((c) => setAmount(c, kind, { ...a, currency: Math.max(0, Number(e.target.value) || 0) }))} />
      </label>
    </div>
  );

  return (
    <section className="space-y-3 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-keep-text">{t("earningTab.faucetHeading")}</h3>
          <p className="text-[11px] text-keep-muted">
            {data.inheriting
              ? t("earningTab.inheritingNote")
              : t("earningTab.overrideNote")}
          </p>
        </div>
        {!data.inheriting && canManage ? (
          <button type="button" onClick={() => void clearOverride()} disabled={busy} className={`${btnClass} shrink-0`}>{t("earningTab.inheritDefaults")}</button>
        ) : null}
      </div>

      <label className="flex items-center gap-2 text-xs text-keep-text">
        <input type="checkbox" disabled={!canManage} checked={config.enabled} onChange={(e) => edit((c) => { c.enabled = e.target.checked; })} />
        {t("earningTab.masterSwitch")}
      </label>

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-widest text-keep-muted">{t("earningTab.perMessageAwards")}</div>
        {amountRow("say", config.awards.message.say)}
        {amountRow("action", config.awards.message.action)}
        {amountRow("whisper", config.awards.message.whisper)}
        <div className="text-[10px] uppercase tracking-widest text-keep-muted">{t("earningTab.forumAwards")}</div>
        {amountRow("topic", config.awards.forum.topic)}
        {amountRow("reply", config.awards.forum.reply)}
        <div className="text-[10px] uppercase tracking-widest text-keep-muted">{t("earningTab.presenceAward")}</div>
        {amountRow("perBlock", config.awards.presence.perBlock)}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <NumberField label={t("earningTab.bodyFloor")} value={config.bodyFloorChars} disabled={!canManage} onChange={(v) => edit((c) => { c.bodyFloorChars = v; })} />
        <NumberField label={t("earningTab.presenceBlock")} value={config.presenceBlockMinutes} min={1} disabled={!canManage} onChange={(v) => edit((c) => { c.presenceBlockMinutes = v; })} />
        <NumberField label={t("earningTab.presenceDailyCap")} value={config.presenceDailyBlockCap} disabled={!canManage} onChange={(v) => edit((c) => { c.presenceDailyBlockCap = v; })} />
      </div>

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-widest text-keep-muted">{t("earningTab.sourceToggles")}</div>
        {(["message", "forum", "presence"] as const).map((src) => (
          <div key={src} className="flex items-center gap-3">
            <span className="w-20 text-[11px] text-keep-muted">{t(`earningTab.source.${src}`)}</span>
            <label className="flex items-center gap-1 text-[11px] text-keep-muted">
              <input type="checkbox" disabled={!canManage} checked={config.enabledSources[src].xp} onChange={(e) => edit((c) => { c.enabledSources[src].xp = e.target.checked; })} /> {t("earningTab.xp")}
            </label>
            <label className="flex items-center gap-1 text-[11px] text-keep-muted">
              <input type="checkbox" disabled={!canManage} checked={config.enabledSources[src].currency} onChange={(e) => edit((c) => { c.enabledSources[src].currency = e.target.checked; })} /> {t("earningTab.currency")}
            </label>
          </div>
        ))}
      </div>

      <details className="rounded border border-keep-rule/60 bg-keep-panel/20 p-2">
        <summary className="cursor-pointer text-[11px] uppercase tracking-widest text-keep-muted">{t("earningTab.transferLimits")}</summary>
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2 text-xs text-keep-text">
            <input type="checkbox" disabled={!canManage} checked={config.currencyTransfer.enabled} onChange={(e) => edit((c) => { c.currencyTransfer.enabled = e.target.checked; })} />
            {t("earningTab.allowTransfers")}
          </label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <NumberField label={t("earningTab.dailySendCap")} value={config.currencyTransfer.dailySendCap} disabled={!canManage} onChange={(v) => edit((c) => { c.currencyTransfer.dailySendCap = v; })} />
            <NumberField label={t("earningTab.dailyReceiveCap")} value={config.currencyTransfer.dailyReceiveCap} disabled={!canManage} onChange={(v) => edit((c) => { c.currencyTransfer.dailyReceiveCap = v; })} />
            <NumberField label={t("earningTab.minTransfer")} value={config.currencyTransfer.minTransferAmount} disabled={!canManage} onChange={(v) => edit((c) => { c.currencyTransfer.minTransferAmount = v; })} />
            <NumberField label={t("earningTab.maxTransfer")} value={config.currencyTransfer.maxTransferAmount} disabled={!canManage} onChange={(v) => edit((c) => { c.currencyTransfer.maxTransferAmount = v; })} />
            <NumberField label={t("earningTab.senderMinAge")} value={config.currencyTransfer.minSenderAccountAgeDays} disabled={!canManage} onChange={(v) => edit((c) => { c.currencyTransfer.minSenderAccountAgeDays = v; })} />
            <NumberField label={t("earningTab.recipientMinAge")} value={config.currencyTransfer.minRecipientAccountAgeDays} disabled={!canManage} onChange={(v) => edit((c) => { c.currencyTransfer.minRecipientAccountAgeDays = v; })} />
          </div>
        </div>
      </details>

      <label className="flex items-center gap-2 text-xs text-keep-text">
        <input type="checkbox" disabled={!canManage} checked={flashSale} onChange={(e) => { setFlashSale(e.target.checked); setDirty(true); }} />
        {t("earningTab.flashSalesEnabled")}
      </label>

      {subsystems ? (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-widest text-keep-muted">{t("earningTab.subsystems")}</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {([
              ["shop", t("earningTab.subsystem.shop")], ["ranks", t("earningTab.subsystem.ranks")], ["nameStyles", t("earningTab.subsystem.nameStyles")],
              ["borders", t("earningTab.subsystem.borders")], ["roomTransitions", t("earningTab.subsystem.roomTransitions")], ["cosmetics", t("earningTab.subsystem.cosmetics")],
            ] as const).map(([key, label]) => (
              <SubsystemToggle key={key} label={label} disabled={!canManage} value={subsystems[key]}
                onChange={(v) => { setSubsystems((prev) => (prev ? { ...prev, [key]: v } : prev)); setDirty(true); }} />
            ))}
          </div>
        </div>
      ) : null}

      {canManage ? (
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void save()} disabled={saving || busy || !dirty} className={primaryBtn}>
            {saving ? t("shared.saving") : t("earningTab.saveEconomy")}
          </button>
          <button type="button" onClick={resetToDefaults} disabled={saving || busy} className={btnClass}>{t("earningTab.resetToDefaults")}</button>
          {dirty ? <span className="text-[11px] text-keep-muted">{t("earningTab.unsavedChanges")}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

/** Helper for the inline amount-row editor: writes the new amount onto the
 *  right path of the working (cloned) config by its label, mutating in place
 *  inside the `edit(mut)` closure. */
function setAmount(c: EarningConfig, label: string, next: AwardAmount): void {
  switch (label) {
    case "say": c.awards.message.say = next; break;
    case "action": c.awards.message.action = next; break;
    case "whisper": c.awards.message.whisper = next; break;
    case "topic": c.awards.forum.topic = next; break;
    case "reply": c.awards.forum.reply = next; break;
    case "perBlock": c.awards.presence.perBlock = next; break;
  }
}

function NumberField({ label, value, onChange, disabled, min = 0 }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean; min?: number }) {
  return (
    <label className="block text-[11px] text-keep-muted">
      <span className="mb-0.5 block uppercase tracking-widest">{label}</span>
      <input type="number" min={min} disabled={disabled} className={`${inputClass} text-right`} value={value}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))} />
    </label>
  );
}

/* =========================================================
 *  Grants — XP / Currency / rank / cosmetics / items
 * ========================================================= */

function GrantsSection({
  serverId, busy, run, onSaved, setError,
}: {
  serverId: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
  setError: (e: string | null) => void;
}) {
  const { t } = useTranslation("servers");
  const [username, setUsername] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  function need(): string | null {
    const u = username.trim();
    if (!u) { setError(t("earningTab.needUsername")); return null; }
    return u;
  }

  async function post(path: string, body: Record<string, unknown>, label: string) {
    const u = need(); if (!u) return;
    await run(async () => {
      const r = await fetch(`/servers/${sid(serverId)}/earning/${path}`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: u, ...body }),
      });
      if (!r.ok) throw new Error(await readError(r));
      setFlash(t("earningTab.doneFlash", { label }));
      window.setTimeout(() => setFlash(null), 1800);
      onSaved();
    });
  }

  return (
    <section className="space-y-3 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <div>
        <h3 className="text-sm font-semibold text-keep-text">{t("earningTab.grantHeading")}</h3>
        <p className="text-[11px] text-keep-muted">
          {t("earningTab.grantBlurb")}
        </p>
      </div>

      <label className="block text-xs text-keep-muted">
        {t("earningTab.targetAccount")}
        <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t("earningTab.usernamePlaceholder")} />
      </label>
      {flash ? <div className="text-[11px] text-keep-system">{flash}</div> : null}

      <AmountGrantRow label={t("earningTab.xp")} help={t("earningTab.xpHelp")} busy={busy}
        onSubmit={(amount) => void post("grant-xp", { amount }, amount >= 0 ? t("earningTab.grantXpLabel", { n: Math.abs(amount) }) : t("earningTab.debitXpLabel", { n: Math.abs(amount) }))} />
      <AmountGrantRow label={t("earningTab.currency")} help={t("earningTab.currencyHelp")} busy={busy}
        onSubmit={(amount) => void post("grant-currency", { amount }, amount >= 0 ? t("earningTab.grantCurrencyLabel", { n: Math.abs(amount) }) : t("earningTab.debitCurrencyLabel", { n: Math.abs(amount) }))} />

      <KeyGrantRow label={t("earningTab.rankTier")} placeholder={t("earningTab.rankKeyPlaceholder")} busy={busy} extraNumber={t("earningTab.tierExtra")}
        onSubmit={(rankKey, tier) => void post("set-rank", { rankKey, tier }, t("earningTab.setRankLabel", { key: rankKey, tier }))}
        onClear={() => void post("set-rank", { rankKey: null, tier: null }, t("earningTab.clearRankLabel"))} />

      <KeyGrantRow label={t("earningTab.nameStyle")} placeholder={t("earningTab.styleKeyPlaceholder")} busy={busy}
        onSubmit={(styleKey) => void post("grant-style", { styleKey }, t("earningTab.grantStyleLabel", { key: styleKey }))} />

      <KeyGrantRow label={t("earningTab.rankBorder")} placeholder={t("earningTab.rankKeyPlaceholder")} busy={busy}
        onSubmit={(rankKey) => void post("grant-border", { rankKey }, t("earningTab.grantBorderLabel", { key: rankKey }))} />

      <KeyGrantRow label={t("earningTab.freeformBorder")} placeholder={t("earningTab.borderKeyPlaceholder")} busy={busy}
        onSubmit={(borderKey) => void post("grant-freeform-border", { borderKey }, t("earningTab.grantBorderLabel", { key: borderKey }))} />

      <ItemGrantRow busy={busy}
        onSubmit={(itemKey, quantity) => void post("grant-item", { itemKey, quantity }, quantity > 0 ? t("earningTab.grantItemLabel", { n: Math.abs(quantity), key: itemKey }) : t("earningTab.revokeItemLabel", { n: Math.abs(quantity), key: itemKey }))} />
    </section>
  );
}

function AmountGrantRow({ label, help, busy, onSubmit }: { label: string; help: string; busy: boolean; onSubmit: (amount: number) => void }) {
  const { t } = useTranslation("servers");
  const [amount, setAmount] = useState(0);
  return (
    <div className="rounded border border-keep-rule/60 bg-keep-panel/20 p-2">
      <div className="flex items-center gap-2">
        <span className="w-20 text-xs font-semibold text-keep-text">{label}</span>
        <input type="number" className={numClass} value={amount} onChange={(e) => setAmount(Math.trunc(Number(e.target.value) || 0))} />
        <button type="button" disabled={busy || amount === 0} className={primaryBtn} onClick={() => onSubmit(amount)}>{t("earningTab.apply")}</button>
      </div>
      <p className="mt-1 text-[10px] text-keep-muted">{help}</p>
    </div>
  );
}

function KeyGrantRow({
  label, placeholder, busy, extraNumber, onSubmit, onClear,
}: {
  label: string;
  placeholder: string;
  busy: boolean;
  extraNumber?: string;
  onSubmit: (key: string, num: number) => void;
  onClear?: () => void;
}) {
  const { t } = useTranslation("servers");
  const [key, setKey] = useState("");
  const [num, setNum] = useState(1);
  return (
    <div className="rounded border border-keep-rule/60 bg-keep-panel/20 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 text-xs font-semibold text-keep-text">{label}</span>
        <input className={`${inputClass} max-w-[12rem] flex-1`} value={key} onChange={(e) => setKey(e.target.value)} placeholder={placeholder} />
        {extraNumber ? (
          <label className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-keep-muted">{extraNumber}
            <input type="number" min={1} max={20} className={numClass} value={num} onChange={(e) => setNum(Math.max(1, Number(e.target.value) || 1))} />
          </label>
        ) : null}
        <button type="button" disabled={busy || !key.trim()} className={primaryBtn} onClick={() => onSubmit(key.trim(), num)}>{t("earningTab.grant")}</button>
        {onClear ? <button type="button" disabled={busy} className={btnClass} onClick={onClear}>{t("earningTab.clearOverride")}</button> : null}
      </div>
    </div>
  );
}

function ItemGrantRow({ busy, onSubmit }: { busy: boolean; onSubmit: (itemKey: string, quantity: number) => void }) {
  const { t } = useTranslation("servers");
  const [itemKey, setItemKey] = useState("");
  const [quantity, setQuantity] = useState(1);
  return (
    <div className="rounded border border-keep-rule/60 bg-keep-panel/20 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 text-xs font-semibold text-keep-text">{t("earningTab.item")}</span>
        <input className={`${inputClass} max-w-[12rem] flex-1`} value={itemKey} onChange={(e) => setItemKey(e.target.value)} placeholder={t("earningTab.itemKeyPlaceholder")} />
        <label className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-keep-muted">{t("earningTab.qty")}
          <input type="number" className={numClass} value={quantity} onChange={(e) => setQuantity(Math.trunc(Number(e.target.value) || 0))} />
        </label>
        <button type="button" disabled={busy || !itemKey.trim() || quantity === 0} className={primaryBtn} onClick={() => onSubmit(itemKey.trim(), quantity)}>{t("earningTab.apply")}</button>
      </div>
      <p className="mt-1 text-[10px] text-keep-muted">{t("earningTab.itemHelp")}</p>
    </div>
  );
}

/* =========================================================
 *  Claw-back — revoke what the user actually owns on THIS server
 * ========================================================= */

function ClawbackSection({
  serverId, busy, run, onSaved, setError,
}: {
  serverId: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
  setError: (e: string | null) => void;
}) {
  const { t } = useTranslation("servers");
  const [username, setUsername] = useState("");
  const [data, setData] = useState<OwnershipResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function lookup(e?: FormEvent) {
    e?.preventDefault();
    const u = username.trim();
    if (!u) { setError(t("earningTab.needLookupUsername")); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/servers/${sid(serverId)}/earning/user-ownership?username=${encodeURIComponent(u)}`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      setData((await r.json()) as OwnershipResponse);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : t("earningTab.lookupFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function revoke(path: string, body: Record<string, unknown>) {
    if (!data) return;
    await run(async () => {
      const r = await fetch(`/servers/${sid(serverId)}/earning/${path}`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: data.username, ...body }),
      });
      if (!r.ok) throw new Error(await readError(r));
      // Re-read ownership so the revoked key drops out of the list.
      const rr = await fetch(`/servers/${sid(serverId)}/earning/user-ownership?username=${encodeURIComponent(data.username)}`, { credentials: "include" });
      if (rr.ok) setData((await rr.json()) as OwnershipResponse);
      onSaved();
    });
  }

  async function resetUser() {
    if (!data) return;
    if (!window.confirm(t("earningTab.resetUserConfirm", { name: data.username }))) return;
    await run(async () => {
      const r = await fetch(`/servers/${sid(serverId)}/earning/reset-user`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: data.username }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await lookup();
      onSaved();
    });
  }

  return (
    <section className="space-y-3 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <div>
        <h3 className="text-sm font-semibold text-keep-text">{t("earningTab.clawbackHeading")}</h3>
        <p className="text-[11px] text-keep-muted">
          {t("earningTab.clawbackBlurb")}
        </p>
      </div>

      <form onSubmit={lookup} className="flex items-center gap-2">
        <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t("earningTab.usernameOnlyPlaceholder")} />
        <button type="submit" disabled={loading || busy} className={`${primaryBtn} shrink-0`}>{loading ? "…" : t("earningTab.lookUp")}</button>
      </form>

      {data ? (
        <div className="space-y-3 rounded border border-keep-rule/60 bg-keep-panel/20 p-2 text-xs">
          <div className="text-keep-text">
            <span className="font-semibold">{data.username}</span>
            {data.pool ? (
              <span className="ml-2 text-keep-muted">{t("earningTab.poolLine", { xp: data.pool.xp, currency: data.pool.currency })}{data.pool.rankKey ? ` · ${data.pool.rankKey} ${data.pool.tier ?? ""}` : ""}</span>
            ) : <span className="ml-2 text-keep-muted">{t("earningTab.noPool")}</span>}
          </div>

          <OwnedList title={t("earningTab.nameStylesTitle")} keys={data.ownedStyles} busy={busy}
            onRevoke={(k) => void revoke("revoke-style", { styleKey: k })} />
          <OwnedList title={t("earningTab.rankBordersTitle")} keys={data.ownedBorders} busy={busy}
            onRevoke={(k) => void revoke("revoke-border", { rankKey: k })} />
          <OwnedList title={t("earningTab.freeformBordersTitle")} keys={data.ownedFreeformBorders} busy={busy}
            onRevoke={(k) => void revoke("revoke-freeform-border", { borderKey: k })} />

          {data.inventory.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">{t("earningTab.oocInventory")}</div>
              <ul className="space-y-1">
                {data.inventory.map((it) => (
                  <li key={it.itemKey} className="flex items-center justify-between gap-2">
                    <span className="text-keep-text">{it.itemKey} ×{it.quantity}</span>
                    <button type="button" disabled={busy} className="rounded border border-keep-accent/40 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
                      onClick={() => void revoke("grant-item", { itemKey: it.itemKey, quantity: -it.quantity })}>{t("earningTab.removeAll")}</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="border-t border-keep-rule/40 pt-2">
            <button type="button" disabled={busy} onClick={() => void resetUser()}
              className="rounded border border-keep-accent/50 bg-keep-accent/10 px-3 py-1 text-xs font-semibold text-keep-accent hover:bg-keep-accent/20">
              {t("earningTab.resetAll")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function OwnedList({ title, keys, busy, onRevoke }: { title: string; keys: string[]; busy: boolean; onRevoke: (key: string) => void }) {
  const { t } = useTranslation("servers");
  if (keys.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">{title}</div>
      <ul className="space-y-1">
        {keys.map((k) => (
          <li key={k} className="flex items-center justify-between gap-2">
            <span className="text-keep-text">{k}</span>
            <button type="button" disabled={busy} className="rounded border border-keep-accent/40 px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10" onClick={() => onRevoke(k)}>{t("earningTab.revoke")}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* =========================================================
 *  Per-server CATALOG editors
 *
 *  These mirror the global AdminEarningTab catalog UX but every fetch is
 *  scoped to /servers/:id/earning/… and the server re-scopes by server_id.
 *  Catalogs are defined per-server (the rows carry server_id in their PK), so
 *  an owner builds their own ladder / styles / borders / shop independently.
 * ========================================================= */

/** Collapsible section frame with a load-on-open data fetch. Keeps each catalog
 *  editor lazy (no fetch until the owner expands it) and uniform in chrome. */
function CatalogShell<T>({
  title, blurb, serverId, path, render,
}: {
  title: string;
  blurb: string;
  serverId: string;
  /** Sub-path after /servers/:id/earning/ (e.g. "ranks"). */
  path: string;
  render: (data: T, reload: () => Promise<void>) => ReactNode;
}) {
  const { t } = useTranslation("servers");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/servers/${sid(serverId)}/earning/${path}`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      setData((await r.json()) as T);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("shared.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [serverId, path, t]);
  useEffect(() => { if (open && data === null) void reload(); }, [open, data, reload]);
  return (
    <section className="rounded border border-keep-rule bg-keep-bg/40">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <div>
          <h3 className="text-sm font-semibold text-keep-text">{title}</h3>
          <p className="text-[11px] text-keep-muted">{blurb}</p>
        </div>
        <span className="text-keep-muted">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-keep-rule/60 p-3">
          {err ? <div className="text-[11px] text-keep-accent">{err}</div> : null}
          {loading && data === null ? <p className="text-xs italic text-keep-muted">{t("shared.loading")}</p>
            : data ? render(data, reload) : null}
        </div>
      ) : null}
    </section>
  );
}

/** POST/PATCH/DELETE helper for catalog mutations; reloads on success. */
async function catalogMutate(
  serverId: string, path: string, method: "POST" | "PATCH" | "DELETE",
  body: Record<string, unknown> | null,
  run: (fn: () => Promise<void>) => Promise<void>,
  reload: () => Promise<void>, onSaved: () => void, setError: (e: string | null) => void,
): Promise<void> {
  await run(async () => {
    setError(null);
    const r = await fetch(`/servers/${sid(serverId)}/earning/${path}`, {
      method, credentials: "include",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) { const m = await readError(r); setError(m); throw new Error(m); }
    await reload();
    onSaved();
  });
}

const labelCell = "text-[10px] uppercase tracking-widest text-keep-muted";

/* =========================================================
 *  Import Spire built-ins
 *
 *  A new server starts with an EMPTY catalog. This section lets an owner seed
 *  it from the Spire built-ins (the system server's rows) in one click — all of
 *  it, one catalog at a time, or just the Arcade's items. Every import skips
 *  keys this server already has, so it never overwrites an owner's edited row.
 * ========================================================= */

type ImportCount = { imported: number; skipped: number };
type ImportScope =
  | "all" | "arcade" | "ranks" | "name-styles" | "freeform-borders"
  | "items" | "cosmetics" | "room-transitions";
interface ImportResponse { ok: boolean; scope: ImportScope; counts: Record<string, ImportCount>; totals: ImportCount }

function ImportBuiltinsSection({ serverId, busy, run, onSaved, setError }: CatalogSectionProps) {
  const { t } = useTranslation("servers");
  const [flash, setFlash] = useState<string | null>(null);
  const [running, setRunning] = useState<ImportScope | null>(null);

  async function importScope(scope: ImportScope, label: string) {
    setRunning(scope); setError(null); setFlash(null);
    await run(async () => {
      try {
        const r = await fetch(`/servers/${sid(serverId)}/earning/import-builtins`, {
          method: "POST", credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope }),
        });
        if (!r.ok) throw new Error(await readError(r));
        const j = (await r.json()) as ImportResponse;
        setFlash(t("earningTab.importFlash", { label, imported: j.totals.imported, skipped: j.totals.skipped }));
        // Reload so the freshly-seeded rows show up in the catalog editors below.
        onSaved();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("earningTab.importFailed"));
      } finally {
        setRunning(null);
      }
    });
  }

  const importBtn = (scope: ImportScope, label: string) => (
    <button type="button" disabled={busy || running !== null} className={btnClass}
      onClick={() => void importScope(scope, label)}>
      {running === scope ? t("earningTab.importing") : label}
    </button>
  );

  return (
    <section className="space-y-3 rounded border border-keep-rule bg-keep-bg/40 p-3">
      <div>
        <h3 className="text-sm font-semibold text-keep-text">{t("earningTab.importHeading")}</h3>
        <p className="text-[11px] text-keep-muted">
          {t("earningTab.importBlurb")}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || running !== null} className={primaryBtn}
          onClick={() => void importScope("all", t("earningTab.allBuiltinsLabel"))}>
          {running === "all" ? t("earningTab.importing") : t("earningTab.importAll")}
        </button>
        <button type="button" disabled={busy || running !== null} className={primaryBtn}
          onClick={() => void importScope("arcade", t("earningTab.arcadeItemsLabel"))}>
          {running === "arcade" ? t("earningTab.importing") : t("earningTab.importArcade")}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {importBtn("ranks", t("earningTab.scopeRanks"))}
        {importBtn("name-styles", t("earningTab.scopeNameStyles"))}
        {importBtn("freeform-borders", t("earningTab.scopeFreeformBorders"))}
        {importBtn("items", t("earningTab.scopeItems"))}
        {importBtn("cosmetics", t("earningTab.scopeCosmetics"))}
        {importBtn("room-transitions", t("earningTab.scopeRoomTransitions"))}
      </div>

      <p className="text-[10px] text-keep-muted">
        {t("earningTab.arcadeNote")}
      </p>
      {flash ? <div className="text-[11px] text-keep-system">{flash}</div> : null}
    </section>
  );
}

/* ---------- Ranks + tiers (with rank-image upload) ---------- */

interface RankRow { key: string; name: string; order: number; enabled: boolean; users: number; characters: number }
interface TierRow { id: string; rankKey: string; tier: number; label: string; xpThreshold: number; sigilImageUrl: string; borderImageUrl: string | null; borderCost: number | null; enabled: boolean }
interface RanksData { ranks: RankRow[]; tiers: TierRow[] }

function RanksSection(p: CatalogSectionProps) {
  const { t } = useTranslation("servers");
  return (
    <CatalogShell<RanksData> title={t("earningTab.ranksTitle")} serverId={p.serverId} path="ranks"
      blurb={t("earningTab.ranksBlurb")}
      render={(data, reload) => <RanksEditor {...p} data={data} reload={reload} />} />
  );
}

function RanksEditor({ serverId, busy, run, onSaved, setError, data, reload }: CatalogSectionProps & { data: RanksData; reload: () => Promise<void> }) {
  const { t } = useTranslation("servers");
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const mut = (path: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown> | null) =>
    catalogMutate(serverId, path, method, body, run, reload, onSaved, setError);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className={`block ${labelCell}`}>{t("earningTab.keyLabel")}
          <input className={`${inputClass} mt-0.5 max-w-[10rem]`} value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="new_arrival" />
        </label>
        <label className={`block ${labelCell}`}>{t("earningTab.nameLabel")}
          <input className={`${inputClass} mt-0.5 max-w-[12rem]`} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("earningTab.rankNamePlaceholder")} />
        </label>
        <button type="button" disabled={busy || !newKey.trim() || !newName.trim()} className={primaryBtn}
          onClick={() => void mut("ranks", "POST", { key: newKey.trim(), name: newName.trim() }).then(() => { setNewKey(""); setNewName(""); })}>
          {t("earningTab.addRank")}
        </button>
      </div>

      {data.ranks.map((rk) => {
        const tiers = data.tiers.filter((t) => t.rankKey === rk.key).sort((a, b) => a.tier - b.tier);
        const inUse = rk.users + rk.characters > 0;
        return (
          <div key={rk.key} className="rounded border border-keep-rule/60 bg-keep-panel/20 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${inputClass} max-w-[12rem]`} defaultValue={rk.name}
                onBlur={(e) => { if (e.target.value !== rk.name) void mut(`ranks/${encodeURIComponent(rk.key)}`, "PATCH", { name: e.target.value }); }} />
              <span className={labelCell}>{t("earningTab.orderLower")}</span>
              <input type="number" className={numClass} defaultValue={rk.order}
                onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== rk.order) void mut(`ranks/${encodeURIComponent(rk.key)}`, "PATCH", { order: v }); }} />
              <label className="flex items-center gap-1 text-[11px] text-keep-muted">
                <input type="checkbox" checked={rk.enabled} onChange={(e) => void mut(`ranks/${encodeURIComponent(rk.key)}`, "PATCH", { enabled: e.target.checked })} /> {t("earningTab.enabledLower")}
              </label>
              <span className="text-[10px] text-keep-muted">{t("earningTab.holdersLine", { key: rk.key, n: rk.users + rk.characters })}</span>
              <button type="button" disabled={busy || inUse} title={inUse ? t("earningTab.disableInstead") : t("earningTab.deleteRankTitle")}
                className={`${btnClass} ml-auto`}
                onClick={() => { if (window.confirm(t("earningTab.deleteRankConfirm", { key: rk.key }))) void mut(`ranks/${encodeURIComponent(rk.key)}`, "DELETE", null); }}>{t("shared.delete")}</button>
            </div>

            <div className="mt-2 space-y-1 pl-2">
              {tiers.map((t) => (
                <TierRowEditor key={t.id} serverId={serverId} tier={t} busy={busy} mut={mut} />
              ))}
              <AddTierRow rankKey={rk.key} busy={busy} mut={mut} />
            </div>
          </div>
        );
      })}
      {data.ranks.length === 0 ? <p className="text-[11px] italic text-keep-muted">{t("earningTab.noRanks")}</p> : null}
    </div>
  );
}

function TierRowEditor({ serverId, tier, busy, mut }: {
  serverId: string; tier: TierRow; busy: boolean;
  mut: (path: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown> | null) => Promise<void>;
}) {
  const { t } = useTranslation("servers");
  const path = `rank-tiers/${encodeURIComponent(tier.id)}`;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-keep-rule/40 p-1">
      <span className="w-8 text-center text-[10px] text-keep-muted">{t("earningTab.tierShort", { n: tier.tier })}</span>
      <input className={`${inputClass} max-w-[8rem]`} defaultValue={tier.label}
        onBlur={(e) => { if (e.target.value !== tier.label) void mut(path, "PATCH", { label: e.target.value }); }} />
      <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.xpThreshold")}
        <input type="number" min={0} className={numClass} defaultValue={tier.xpThreshold}
          onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== tier.xpThreshold) void mut(path, "PATCH", { xpThreshold: v }); }} />
      </label>
      <RankImageField serverId={serverId} label={t("earningTab.sigilLabel")} url={tier.sigilImageUrl}
        onUploaded={(url) => void mut(path, "PATCH", { sigilImageUrl: url })} />
      <RankImageField serverId={serverId} label={t("earningTab.borderLabel")} url={tier.borderImageUrl ?? ""}
        onUploaded={(url) => void mut(path, "PATCH", { borderImageUrl: url })} />
      <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.costLower")}
        <input type="number" min={0} className={numClass} defaultValue={tier.borderCost ?? 0}
          onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== (tier.borderCost ?? 0)) void mut(path, "PATCH", { borderCost: v }); }} />
      </label>
      <label className="flex items-center gap-1 text-[10px] text-keep-muted">
        <input type="checkbox" checked={tier.enabled} onChange={(e) => void mut(path, "PATCH", { enabled: e.target.checked })} /> {t("earningTab.onLower")}
      </label>
      <button type="button" disabled={busy} className={btnClass}
        onClick={() => { if (window.confirm(t("earningTab.deleteTierConfirm", { n: tier.tier }))) void mut(path, "DELETE", null); }}>×</button>
    </div>
  );
}

function AddTierRow({ rankKey, busy, mut }: {
  rankKey: string; busy: boolean;
  mut: (path: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown> | null) => Promise<void>;
}) {
  const { t } = useTranslation("servers");
  const [tier, setTier] = useState(5);
  const [label, setLabel] = useState("");
  const [xp, setXp] = useState(0);
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.tierLower")}
        <input type="number" min={1} max={20} className={numClass} value={tier} onChange={(e) => setTier(Math.max(1, Number(e.target.value) || 1))} />
      </label>
      <input className={`${inputClass} max-w-[8rem]`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("earningTab.labelPlaceholder")} />
      <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.xpThreshold")}
        <input type="number" min={0} className={numClass} value={xp} onChange={(e) => setXp(Math.max(0, Number(e.target.value) || 0))} />
      </label>
      <button type="button" disabled={busy || !label.trim()} className={btnClass}
        onClick={() => void mut(`ranks/${encodeURIComponent(rankKey)}/tiers`, "POST", { tier, label: label.trim(), xpThreshold: xp }).then(() => setLabel(""))}>
        {t("earningTab.addTier")}
      </button>
    </div>
  );
}

/** Rank PNG upload: reads the file as a base64 data URL, POSTs it to the
 *  per-server asset endpoint, then hands the returned URL up to be stored in
 *  the tier's sigil/border field. */
function RankImageField({ serverId, label, url, onUploaded }: {
  serverId: string; label: string; url: string; onUploaded: (url: string) => void;
}) {
  const { t } = useTranslation("servers");
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function onFile(file: File) {
    setUploading(true); setErr(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error(t("earningTab.readFailed")));
        fr.readAsDataURL(file);
      });
      const r = await fetch(`/servers/${sid(serverId)}/earning/ranks/assets/upload`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { url: string };
      onUploaded(j.url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("earningTab.uploadFailed"));
    } finally {
      setUploading(false);
    }
  }
  return (
    <label className="flex items-center gap-1 text-[10px] text-keep-muted" title={err ?? url ?? ""}>
      {url ? <img src={url} alt="" className="h-5 w-5 rounded object-contain" /> : <span className="text-keep-muted">{label}</span>}
      <input type="file" accept="image/png" className="hidden" disabled={uploading}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.currentTarget.value = ""; }} />
      <span className="cursor-pointer rounded border border-keep-rule px-1 hover:text-keep-text">{uploading ? "…" : url ? "↻" : t("earningTab.pngButton")}</span>
    </label>
  );
}

/* ---------- Name styles ---------- */

interface StyleRow { key: string; name: string; description: string; template: string; styleCss: string; cost: number; enabled: boolean; isBuiltin: boolean; order: number; owners: number }

function NameStylesSection(p: CatalogSectionProps) {
  const { t } = useTranslation("servers");
  return (
    <CatalogShell<{ styles: StyleRow[] }> title={t("earningTab.nameStylesSection")} serverId={p.serverId} path="name-styles"
      blurb={t("earningTab.nameStylesBlurb")}
      render={(data, reload) => <NameStylesEditor {...p} rows={data.styles} reload={reload} />} />
  );
}

function NameStylesEditor({ serverId, busy, run, onSaved, setError, rows, reload }: CatalogSectionProps & { rows: StyleRow[]; reload: () => Promise<void> }) {
  const { t } = useTranslation("servers");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("<span>{username}</span>");
  const mut = (path: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown> | null) =>
    catalogMutate(serverId, path, method, body, run, reload, onSaved, setError);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <input className={`${inputClass} max-w-[9rem]`} value={key} onChange={(e) => setKey(e.target.value)} placeholder="style_key" />
        <input className={`${inputClass} max-w-[10rem]`} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("earningTab.displayNamePlaceholder")} />
        <input className={`${inputClass} max-w-[14rem] flex-1`} value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="<span>{username}</span>" />
        <button type="button" disabled={busy || !key.trim() || !name.trim() || !template.trim()} className={primaryBtn}
          onClick={() => void mut("name-styles", "POST", { key: key.trim(), name: name.trim(), template }).then(() => { setKey(""); setName(""); })}>{t("earningTab.add")}</button>
      </div>
      {rows.map((s) => (
        <div key={s.key} className="space-y-1 rounded border border-keep-rule/60 bg-keep-panel/20 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${inputClass} max-w-[10rem]`} defaultValue={s.name}
              onBlur={(e) => { if (e.target.value !== s.name) void mut(`name-styles/${encodeURIComponent(s.key)}`, "PATCH", { name: e.target.value }); }} />
            <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.costLower")}
              <input type="number" min={0} className={numClass} defaultValue={s.cost}
                onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== s.cost) void mut(`name-styles/${encodeURIComponent(s.key)}`, "PATCH", { cost: v }); }} />
            </label>
            <label className="flex items-center gap-1 text-[10px] text-keep-muted">
              <input type="checkbox" checked={s.enabled} onChange={(e) => void mut(`name-styles/${encodeURIComponent(s.key)}`, "PATCH", { enabled: e.target.checked })} /> {t("earningTab.onLower")}
            </label>
            <span className="text-[10px] text-keep-muted">{s.key}{s.isBuiltin ? t("earningTab.seedSuffix") : ""}{t("earningTab.ownersSuffix", { n: s.owners })}</span>
            {!s.isBuiltin ? (
              <button type="button" disabled={busy} className={`${btnClass} ml-auto`}
                onClick={() => { if (window.confirm(t("earningTab.deleteStyleConfirm", { key: s.key }))) void mut(`name-styles/${encodeURIComponent(s.key)}`, "DELETE", null); }}>{t("shared.delete")}</button>
            ) : null}
          </div>
          <textarea className={`${inputClass} font-mono text-[11px]`} rows={2} defaultValue={s.template}
            onBlur={(e) => { if (e.target.value !== s.template) void mut(`name-styles/${encodeURIComponent(s.key)}`, "PATCH", { template: e.target.value }); }} />
          <textarea className={`${inputClass} font-mono text-[11px]`} rows={2} defaultValue={s.styleCss} placeholder={t("earningTab.scopedCssPlaceholder")}
            onBlur={(e) => { if (e.target.value !== s.styleCss) void mut(`name-styles/${encodeURIComponent(s.key)}`, "PATCH", { styleCss: e.target.value }); }} />
        </div>
      ))}
    </div>
  );
}

/* ---------- Free-form borders ---------- */

interface FreeformBorderRow { key: string; name: string; description: string; imageUrl: string | null; template: string | null; styleCss: string | null; rarity: string; cost: number; enabled: boolean; isBuiltin: boolean; order: number; owners: number }

function FreeformBordersSection(p: CatalogSectionProps) {
  const { t } = useTranslation("servers");
  return (
    <CatalogShell<{ borders: FreeformBorderRow[] }> title={t("earningTab.freeformSection")} serverId={p.serverId} path="freeform-borders"
      blurb={t("earningTab.freeformBlurb")}
      render={(data, reload) => <FreeformBordersEditor {...p} rows={data.borders} reload={reload} />} />
  );
}

function FreeformBordersEditor({ serverId, busy, run, onSaved, setError, rows, reload }: CatalogSectionProps & { rows: FreeformBorderRow[]; reload: () => Promise<void> }) {
  const { t } = useTranslation("servers");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const mut = (path: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown> | null) =>
    catalogMutate(serverId, path, method, body, run, reload, onSaved, setError);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <input className={`${inputClass} max-w-[9rem]`} value={key} onChange={(e) => setKey(e.target.value)} placeholder="border-key" />
        <input className={`${inputClass} max-w-[10rem]`} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("earningTab.displayNamePlaceholder")} />
        <input className={`${inputClass} max-w-[14rem] flex-1`} value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder={t("earningTab.imageUrlPlaceholder")} />
        <button type="button" disabled={busy || !key.trim() || !name.trim() || !imageUrl.trim()} className={primaryBtn}
          onClick={() => void mut("freeform-borders", "POST", { key: key.trim(), name: name.trim(), imageUrl: imageUrl.trim() }).then(() => { setKey(""); setName(""); setImageUrl(""); })}>{t("earningTab.add")}</button>
      </div>
      <p className="text-[10px] text-keep-muted">{t("earningTab.freeformNote")}</p>
      {rows.map((b) => (
        <div key={b.key} className="flex flex-wrap items-center gap-2 rounded border border-keep-rule/60 bg-keep-panel/20 p-2">
          {b.imageUrl ? <img src={b.imageUrl} alt="" className="h-7 w-7 rounded object-contain" /> : <span className="text-[10px] text-keep-muted">{t("earningTab.tmplChip")}</span>}
          <input className={`${inputClass} max-w-[10rem]`} defaultValue={b.name}
            onBlur={(e) => { if (e.target.value !== b.name) void mut(`freeform-borders/${encodeURIComponent(b.key)}`, "PATCH", { name: e.target.value }); }} />
          <input className={`${inputClass} max-w-[6rem]`} defaultValue={b.rarity}
            onBlur={(e) => { if (e.target.value !== b.rarity) void mut(`freeform-borders/${encodeURIComponent(b.key)}`, "PATCH", { rarity: e.target.value }); }} />
          <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.costLower")}
            <input type="number" min={0} className={numClass} defaultValue={b.cost}
              onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== b.cost) void mut(`freeform-borders/${encodeURIComponent(b.key)}`, "PATCH", { cost: v }); }} />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-keep-muted">
            <input type="checkbox" checked={b.enabled} onChange={(e) => void mut(`freeform-borders/${encodeURIComponent(b.key)}`, "PATCH", { enabled: e.target.checked })} /> {t("earningTab.onLower")}
          </label>
          <span className="text-[10px] text-keep-muted">{b.key}{b.isBuiltin ? t("earningTab.seedSuffix") : ""}{t("earningTab.ownersSuffix", { n: b.owners })}</span>
          {!b.isBuiltin ? (
            <button type="button" disabled={busy} className={`${btnClass} ml-auto`}
              onClick={() => { if (window.confirm(t("earningTab.deleteBorderConfirm", { key: b.key }))) void mut(`freeform-borders/${encodeURIComponent(b.key)}`, "DELETE", null); }}>{t("shared.delete")}</button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ---------- Cosmetics (price / enabled only) ---------- */

interface CosmeticRow { key: string; name: string; description: string; cost: number; enabled: boolean; configJson: string | null }

function CosmeticsSection(p: CatalogSectionProps) {
  const { t } = useTranslation("servers");
  return (
    <CatalogShell<{ cosmetics: CosmeticRow[] }> title={t("earningTab.cosmeticsSection")} serverId={p.serverId} path="cosmetics"
      blurb={t("earningTab.cosmeticsBlurb")}
      render={(data, reload) => <CosmeticsEditor {...p} rows={data.cosmetics} reload={reload} />} />
  );
}

function CosmeticsEditor({ serverId, busy, run, onSaved, setError, rows, reload }: CatalogSectionProps & { rows: CosmeticRow[]; reload: () => Promise<void> }) {
  const { t } = useTranslation("servers");
  const mut = (path: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown> | null) =>
    catalogMutate(serverId, path, method, body, run, reload, onSaved, setError);
  if (rows.length === 0) return <p className="text-[11px] italic text-keep-muted">{t("earningTab.noCosmetics")}</p>;
  return (
    <div className="space-y-2">
      {rows.map((c) => (
        <div key={c.key} className="flex flex-wrap items-center gap-2 rounded border border-keep-rule/60 bg-keep-panel/20 p-2">
          <span className="w-40 text-xs text-keep-text">{c.name} <span className="text-[10px] text-keep-muted">({c.key})</span></span>
          <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.costLower")}
            <input type="number" min={0} className={numClass} defaultValue={c.cost}
              onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== c.cost) void mut(`cosmetics/${encodeURIComponent(c.key)}`, "PATCH", { cost: v }); }} />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-keep-muted">
            <input type="checkbox" checked={c.enabled} onChange={(e) => void mut(`cosmetics/${encodeURIComponent(c.key)}`, "PATCH", { enabled: e.target.checked })} /> {t("earningTab.onLower")}
          </label>
        </div>
      ))}
    </div>
  );
}

/* ---------- Items ---------- */

interface ItemRow { key: string; name: string; namePlural: string | null; description: string; iconUrl: string | null; price: number; category: string; enabled: boolean; forSale: boolean; order: number; isBuiltin: boolean; owners: number }

function ItemsSection(p: CatalogSectionProps) {
  const { t } = useTranslation("servers");
  return (
    <CatalogShell<{ items: ItemRow[] }> title={t("earningTab.itemsSection")} serverId={p.serverId} path="items"
      blurb={t("earningTab.itemsBlurb")}
      render={(data, reload) => <ItemsEditor {...p} rows={data.items} reload={reload} />} />
  );
}

function ItemsEditor({ serverId, busy, run, onSaved, setError, rows, reload }: CatalogSectionProps & { rows: ItemRow[]; reload: () => Promise<void> }) {
  const { t } = useTranslation("servers");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const mut = (path: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown> | null) =>
    catalogMutate(serverId, path, method, body, run, reload, onSaved, setError);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <input className={`${inputClass} max-w-[9rem]`} value={key} onChange={(e) => setKey(e.target.value)} placeholder="item_key" />
        <input className={`${inputClass} max-w-[11rem]`} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("earningTab.displayNamePlaceholder")} />
        <button type="button" disabled={busy || !key.trim() || !name.trim()} className={primaryBtn}
          onClick={() => void mut("items", "POST", { key: key.trim(), name: name.trim() }).then(() => { setKey(""); setName(""); })}>{t("earningTab.add")}</button>
      </div>
      {rows.map((it) => (
        <div key={it.key} className="flex flex-wrap items-center gap-2 rounded border border-keep-rule/60 bg-keep-panel/20 p-2">
          {it.iconUrl ? <img src={it.iconUrl} alt="" className="h-6 w-6 object-contain" /> : null}
          <input className={`${inputClass} max-w-[10rem]`} defaultValue={it.name}
            onBlur={(e) => { if (e.target.value !== it.name) void mut(`items/${encodeURIComponent(it.key)}`, "PATCH", { name: e.target.value }); }} />
          <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.priceLower")}
            <input type="number" min={0} className={numClass} defaultValue={it.price}
              onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== it.price) void mut(`items/${encodeURIComponent(it.key)}`, "PATCH", { price: v }); }} />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-keep-muted">
            <input type="checkbox" checked={it.enabled} onChange={(e) => void mut(`items/${encodeURIComponent(it.key)}`, "PATCH", { enabled: e.target.checked })} /> {t("earningTab.onLower")}
          </label>
          <label className="flex items-center gap-1 text-[10px] text-keep-muted">
            <input type="checkbox" checked={it.forSale} onChange={(e) => void mut(`items/${encodeURIComponent(it.key)}`, "PATCH", { forSale: e.target.checked })} /> {t("earningTab.forSaleLower")}
          </label>
          <span className="text-[10px] text-keep-muted">{it.key}{it.isBuiltin ? t("earningTab.seedSuffix") : ""}{t("earningTab.holdSuffix", { n: it.owners })}</span>
          {!it.isBuiltin ? (
            <button type="button" disabled={busy} className={`${btnClass} ml-auto`}
              onClick={() => { if (window.confirm(t("earningTab.deleteItemConfirm", { key: it.key }))) void mut(`items/${encodeURIComponent(it.key)}`, "DELETE", null); }}>{t("shared.delete")}</button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ---------- Room transitions (price / enabled / order only) ---------- */

interface RoomTransitionRow { key: string; label: string; description: string; cost: number; enabled: boolean; sortOrder: number }

function RoomTransitionsSection(p: CatalogSectionProps) {
  const { t } = useTranslation("servers");
  return (
    <CatalogShell<{ transitions: RoomTransitionRow[] }> title={t("earningTab.transitionsSection")} serverId={p.serverId} path="room-transitions"
      blurb={t("earningTab.transitionsBlurb")}
      render={(data, reload) => <RoomTransitionsEditor {...p} rows={data.transitions} reload={reload} />} />
  );
}

function RoomTransitionsEditor({ serverId, busy, run, onSaved, setError, rows, reload }: CatalogSectionProps & { rows: RoomTransitionRow[]; reload: () => Promise<void> }) {
  const { t } = useTranslation("servers");
  const mut = (path: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown> | null) =>
    catalogMutate(serverId, path, method, body, run, reload, onSaved, setError);
  return (
    <div className="space-y-1">
      {rows.map((row) => (
        <div key={row.key} className="flex flex-wrap items-center gap-2 rounded border border-keep-rule/60 bg-keep-panel/20 p-2">
          <span className="w-40 text-xs text-keep-text" title={row.description}>{row.label} <span className="text-[10px] text-keep-muted">({row.key})</span></span>
          <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.costLower")}
            <input type="number" min={0} className={numClass} defaultValue={row.cost}
              onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== row.cost) void mut(`room-transitions/${encodeURIComponent(row.key)}`, "PATCH", { cost: v }); }} />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.orderLower")}
            <input type="number" className={numClass} defaultValue={row.sortOrder}
              onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== row.sortOrder) void mut(`room-transitions/${encodeURIComponent(row.key)}`, "PATCH", { sortOrder: v }); }} />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-keep-muted">
            <input type="checkbox" checked={row.enabled} onChange={(e) => void mut(`room-transitions/${encodeURIComponent(row.key)}`, "PATCH", { enabled: e.target.checked })} /> {t("earningTab.onLower")}
          </label>
        </div>
      ))}
    </div>
  );
}

/* ---------- Flash-sale scheduler ---------- */

interface FlashSaleData { tomorrow: string; flashSaleEnabled: boolean; overrides: { category: string; forDate: string; targetKey: string; discountPct: number | null }[] }

function FlashSaleSection(p: CatalogSectionProps) {
  const { t } = useTranslation("servers");
  return (
    <CatalogShell<FlashSaleData> title={t("earningTab.flashSaleSection")} serverId={p.serverId} path="flash-sale"
      blurb={t("earningTab.flashSaleBlurb")}
      render={(data, reload) => <FlashSaleEditor {...p} data={data} reload={reload} />} />
  );
}

function FlashSaleEditor({ serverId, busy, run, onSaved, setError, data, reload }: CatalogSectionProps & { data: FlashSaleData; reload: () => Promise<void> }) {
  const { t } = useTranslation("servers");
  const [category, setCategory] = useState<"name_style" | "item" | "cosmetic" | "freeform_border">("item");
  const [forDate, setForDate] = useState(data.tomorrow);
  const [targetKey, setTargetKey] = useState("");
  const [discount, setDiscount] = useState("");
  async function queue(remove: boolean) {
    await run(async () => {
      setError(null);
      const body: Record<string, unknown> = { category, forDate, targetKey: remove ? null : targetKey.trim() };
      if (!remove && discount.trim()) body.discountPct = Math.max(1, Math.min(99, Number(discount) || 0));
      const r = await fetch(`/servers/${sid(serverId)}/earning/flash-sale/overrides`, {
        method: "PUT", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const m = await readError(r); setError(m); throw new Error(m); }
      await reload();
      onSaved();
    });
  }
  return (
    <div className="space-y-3">
      {!data.flashSaleEnabled ? <p className="text-[11px] text-keep-muted">{t("earningTab.flashSaleOffNote")}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <select className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm text-keep-text" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
          <option value="item">{t("earningTab.categoryItem")}</option>
          <option value="name_style">{t("earningTab.categoryNameStyle")}</option>
          <option value="cosmetic">{t("earningTab.categoryCosmetic")}</option>
          <option value="freeform_border">{t("earningTab.categoryFreeformBorder")}</option>
        </select>
        <input type="date" className={`${inputClass} max-w-[10rem]`} value={forDate} min={data.tomorrow} onChange={(e) => setForDate(e.target.value)} />
        <input className={`${inputClass} max-w-[10rem]`} value={targetKey} onChange={(e) => setTargetKey(e.target.value)} placeholder={t("earningTab.catalogKeyPlaceholder")} />
        <label className="flex items-center gap-1 text-[10px] text-keep-muted">{t("earningTab.discountLabel")}
          <input type="number" min={1} max={99} className={numClass} value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder={t("earningTab.defPlaceholder")} />
        </label>
        <button type="button" disabled={busy || !targetKey.trim()} className={primaryBtn} onClick={() => void queue(false)}>{t("earningTab.queue")}</button>
      </div>
      {data.overrides.length > 0 ? (
        <ul className="space-y-1">
          {data.overrides.map((o) => (
            <li key={`${o.category}-${o.forDate}`} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-keep-text">{o.forDate} · {o.category} → {o.targetKey}{o.discountPct ? ` (${o.discountPct}%)` : ""}</span>
              <button type="button" disabled={busy} className={btnClass}
                onClick={() => { setCategory(o.category as typeof category); setForDate(o.forDate); void queue(true); }}>{t("shared.remove")}</button>
            </li>
          ))}
        </ul>
      ) : <p className="text-[11px] italic text-keep-muted">{t("earningTab.noQueuedSales")}</p>}
    </div>
  );
}
