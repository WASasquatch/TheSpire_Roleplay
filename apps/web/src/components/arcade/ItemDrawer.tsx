/**
 * In-window slide-up drawer for the Eidolon Tamer. Lists the active
 * identity's edible items (mode "food"), curatives (mode "remedy"), or Potions
 * to wake a dormant familiar (mode "revive") with an owned count, lets the
 * player FEED/USE/REVIVE with what they hold, and BUY more with currency
 * without leaving the game. Remedy mode also offers a currency-charged "basic
 * heal" when no potion is used. All data comes from the cached /earning/me
 * snapshot; buying calls the existing buy endpoint and refreshes, which the
 * socket-driven store also keeps live.
 */
import React, { useMemo, useState } from "react";
import { EIDOLON_BASIC_HEAL_COST, eidolonFoodEffect, eidolonToyEffect } from "@thekeep/shared";
import { buyItem } from "../../lib/earning";
import type { ItemCatalogRow } from "../../lib/earning";
import { useEarning } from "../../state/earning";
import { useChat } from "../../state/store";
import { CoinAmount } from "../CoinAmount";

interface Props {
  mode: "food" | "remedy" | "revive" | "toy";
  characterId: string | null;
  onClose: () => void;
  onFeed: (itemKey: string) => void;
  /** Use a non-food item: a Potion (remedy/revive) or a toy (play). The parent
   *  routes by the current mode. */
  onUsePotion: (itemKey: string) => void;
  onBasicHeal: () => void;
}

export function ItemDrawer({ mode, characterId, onClose, onFeed, onUsePotion, onBasicHeal }: Props): React.JSX.Element {
  const earning = useEarning((s) => s.snapshot);
  const refresh = useEarning((s) => s.refresh);
  // Multi-Server Lift: buy against the SAME server the drawer's wallet /
  // inventory snapshot is scoped to, so currency is debited and the item
  // granted on the server the player is actually in (not the home pool).
  const currentServerId = useChat((s) => s.currentServerId);
  const [buyingKey, setBuyingKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const wantCategory = mode === "food" ? "food" : mode === "toy" ? "toy" : "magic";

  const currency = useMemo(() => {
    if (!earning) return 0;
    if (!characterId) return earning.master.currency;
    return earning.characters.find((p) => p.ownerId === characterId)?.currency ?? 0;
  }, [earning, characterId]);

  const ownedByKey = useMemo(() => {
    const m = new Map<string, number>();
    if (!earning) return m;
    const inv = characterId ? (earning.inventoryByCharacter[characterId] ?? []) : earning.inventory;
    for (const e of inv) m.set(e.itemKey, e.quantity);
    return m;
  }, [earning, characterId]);

  const rows = useMemo(() => {
    if (!earning) return [] as ItemCatalogRow[];
    return earning.catalog.items
      .filter((it) => it.category === wantCategory && (it.enabled || (ownedByKey.get(it.key) ?? 0) > 0))
      .sort((a, b) => {
        const oa = ownedByKey.get(a.key) ?? 0, ob = ownedByKey.get(b.key) ?? 0;
        if ((oa > 0) !== (ob > 0)) return oa > 0 ? -1 : 1; // owned first
        return a.price - b.price;
      });
  }, [earning, wantCategory, ownedByKey]);

  const use = (key: string) => (mode === "food" ? onFeed(key) : onUsePotion(key));
  const title = mode === "food" ? "Feed your familiar" : mode === "revive" ? "Wake your familiar" : mode === "toy" ? "Play with a toy" : "Tend its ailment";
  const useLabel = mode === "food" ? "Feed" : mode === "revive" ? "Revive" : mode === "toy" ? "Play" : "Use";
  const emptyMsg = mode === "food" ? "No food in the shop yet." : mode === "revive" ? "You need a magical item to wake it." : mode === "toy" ? "No toys in the shop yet." : "No curatives in the shop yet.";

  // What an item does, so the shop isn't a guessing game. Food + toys have
  // concrete stat deltas (from the shared engine); the gauge "Spirit" is `joy`.
  const fmtDelta = (label: string, v: number) => `${v > 0 ? "+" : ""}${v} ${label}`;
  const effectHint = (key: string, price: number): string | null => {
    if (mode === "food") {
      const e = eidolonFoodEffect({ key, price });
      return [["Satiety", e.satiety], ["Spirit", e.joy], ["Vigor", e.vigor], ["Hygiene", e.hygiene]]
        .filter(([, v]) => (v as number) !== 0).map(([l, v]) => fmtDelta(l as string, v as number)).join(" · ") || null;
    }
    if (mode === "toy") {
      const e = eidolonToyEffect(key);
      return [["Spirit", e.joy], ["Vigor", e.vigor], ["Hygiene", e.hygiene]]
        .filter(([, v]) => (v as number) !== 0).map(([l, v]) => fmtDelta(l as string, v as number)).join(" · ") || null;
    }
    return null; // remedy/revive: the per-mode copy already explains
  };

  const buy = async (key: string) => {
    if (buyingKey) return;
    setBuyingKey(key); setErr(null);
    try {
      await buyItem(key, 1, characterId, currentServerId);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Purchase failed.");
    } finally {
      setBuyingKey(null);
    }
  };

  return (
    <div className="ei-drawer-scrim" onClick={onClose} role="presentation">
      <div className="ei-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ei-drawer-head">
          <span className="ei-drawer-title">{title}</span>
          <span className="ei-wallet" title="Your currency"><CoinAmount amount={currency} size="md" /></span>
          <button className="ei-drawer-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {mode === "revive" && (
          <div className="ei-revive-note">Your familiar lies dormant. A magical item will wake it to a fragile second life.</div>
        )}

        {mode === "remedy" && (
          <button
            className="ei-heal-basic"
            disabled={currency < EIDOLON_BASIC_HEAL_COST}
            onClick={onBasicHeal}
            title={currency < EIDOLON_BASIC_HEAL_COST ? "Not enough currency" : "Spend currency on a basic heal"}
          >
            <span className="ei-heal-line">Basic heal · −<CoinAmount amount={EIDOLON_BASIC_HEAL_COST} /></span>
            <small>a little vitality, no cure</small>
          </button>
        )}

        {err && <div className="ei-drawer-err">{err}</div>}

        <div className="ei-drawer-list">
          {rows.length === 0 && (
            <div className="ei-empty">{emptyMsg}</div>
          )}
          {rows.map((it) => {
            const owned = ownedByKey.get(it.key) ?? 0;
            const hint = effectHint(it.key, it.price);
            const ownedStr = owned > 0 ? `${owned} owned` : "none owned";
            // Toys are reusable — once you own one, buying more is pointless, so
            // hide Buy. Food/curatives are consumed, so keep Buy regardless.
            const showBuy = it.purchasable && !(mode === "toy" && owned > 0);
            return (
              <div className="ei-item" key={it.key}>
                <span className="ei-item-icon">
                  {it.iconUrl ? <img src={it.iconUrl} alt="" /> : <span aria-hidden>{mode === "food" ? "🍖" : mode === "toy" ? "🧸" : "⚗"}</span>}
                </span>
                <span className="ei-item-text">
                  <span className="ei-item-name">{it.name}</span>
                  <span className="ei-item-sub">{hint ? `${hint} · ${ownedStr}` : ownedStr}</span>
                </span>
                {owned > 0 && (
                  <button className="ei-item-use" onClick={() => use(it.key)}>
                    {useLabel}
                  </button>
                )}
                {showBuy && (
                  <button
                    className="ei-item-buy"
                    disabled={currency < it.price || buyingKey != null}
                    onClick={() => void buy(it.key)}
                    title={currency < it.price ? "Not enough currency" : `Buy one for ${it.price}`}
                  >
                    {buyingKey === it.key ? "…" : <>Buy · <CoinAmount amount={it.price} /></>}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
