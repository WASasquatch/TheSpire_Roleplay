/**
 * Spire Arcade launcher (a modal). Lists the arcade's games; game #1 is the
 * Eidolon Tamer. The lock state comes from the arcade endpoint itself (a
 * 402 = "permission OK, not yet unlocked"), not the earning snapshot, so the
 * launcher can show Play vs. Unlock without extra plumbing. Unlocking buys
 * the one-time `flair_eidolon_tamer` cosmetic for the active identity, then
 * launches the floating window.
 */
import React, { useEffect, useMemo, useState } from "react";
import { EIDOLON_UNLOCK_COST } from "@thekeep/shared";
import { Modal } from "../Modal";
import { CoinAmount } from "../CoinAmount";
import { useEarning } from "../../state/earning";
import { fetchEidolon, unlockEidolon } from "../../lib/arcade";

type Access = "loading" | "ok" | "locked" | "forbidden";

export function ArcadeLauncher({ characterId, onLaunch, onClose }: {
  characterId: string | null;
  onLaunch: (game: "eidolon") => void;
  onClose: () => void;
}): React.JSX.Element {
  const [access, setAccess] = useState<Access>("loading");
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const earning = useEarning((s) => s.snapshot);
  const refresh = useEarning((s) => s.refresh);

  const currency = useMemo(() => {
    if (!earning) return 0;
    if (!characterId) return earning.master.currency;
    return earning.characters.find((p) => p.ownerId === characterId)?.currency ?? 0;
  }, [earning, characterId]);

  useEffect(() => {
    let alive = true;
    setAccess("loading");
    fetchEidolon(characterId)
      .then((r) => { if (alive) setAccess(r.access === "ok" ? "ok" : r.access); })
      .catch(() => { if (alive) setAccess("forbidden"); });
    return () => { alive = false; };
  }, [characterId]);

  const unlock = async () => {
    if (working) return;
    setWorking(true); setErr(null);
    try {
      await unlockEidolon(characterId);
      await refresh();
      setAccess("ok");
      onLaunch("eidolon");
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unlock failed.");
    } finally {
      setWorking(false);
    }
  };

  const T = (a: number) => `rgb(var(--keep-text) / ${a})`;
  // Card layout lives in Tailwind (not inline) so it can go responsive:
  // egg + copy stack as a row, and the CTA drops to a full-width button
  // beneath the description on mobile, then returns to a right-aligned
  // inline button from `sm:` up. Shared by the live game card and the
  // dimmed "More games" placeholder so they stay visually identical.
  const cardClass = "rounded-[14px] border border-keep-border/60 bg-keep-bg p-4";
  const ctaBase: React.CSSProperties = {
    padding: "9px 18px", borderRadius: 10, cursor: "pointer", fontWeight: 600, fontSize: 13,
    border: "1px solid rgb(var(--keep-action) / .8)", whiteSpace: "nowrap",
  };

  const canAfford = currency >= EIDOLON_UNLOCK_COST;

  return (
    <Modal onClose={onClose}>
      <div
        style={{
          width: "min(560px, 94vw)", maxHeight: "88vh", overflowY: "auto", borderRadius: 16,
          background: "rgb(var(--keep-panel) / 1)", color: T(1), padding: 22,
          border: "1px solid rgb(var(--keep-border) / .6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 22, letterSpacing: 1 }}>🕹 Spire Arcade</h2>
          <span style={{ fontSize: 13, color: T(0.75) }}><CoinAmount amount={currency} size="md" /></span>
        </div>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: T(0.7) }}>
          A growing cabinet of games to play between scenes. Each game unlocks once, then it's yours to keep.
        </p>

        <div className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-3.5 ${cardClass}`}>
          <div className="flex min-w-0 flex-1 items-center gap-3.5">
            <div className="shrink-0" style={{ fontSize: 40, lineHeight: 1 }} aria-hidden>🥚</div>
            <div className="min-w-0 flex-1">
              <div style={{ fontSize: 16, fontWeight: 700 }}>Eidolon Tamer</div>
              <div style={{ fontSize: 12.5, color: T(0.7), lineHeight: 1.45 }}>
                Hatch a gothic familiar — one of four eggs, or hatch one of your own pets — then keep it fed, played
                with, clean, and well. It lives on while you're away. Feed it food from your bag, cure it with a potion.
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:items-end">
            {access === "loading" && <span style={{ fontSize: 12, color: T(0.6), textAlign: "center" }}>…</span>}
            {access === "forbidden" && <span className="text-center sm:max-w-[140px]" style={{ fontSize: 12, color: T(0.6) }}>Unavailable to you right now.</span>}
            {access === "ok" && (
              <button
                className="w-full sm:w-auto"
                style={{ ...ctaBase, background: "rgb(var(--keep-action) / 1)", color: "rgb(var(--keep-bg) / 1)" }}
                onClick={() => { onLaunch("eidolon"); onClose(); }}
              >
                ▶ Play
              </button>
            )}
            {access === "locked" && (
              <button
                className="w-full sm:w-auto"
                style={{ ...ctaBase, background: canAfford ? "rgb(var(--keep-accent) / .15)" : "transparent", color: T(canAfford ? 1 : 0.45), opacity: working ? 0.6 : 1, cursor: canAfford && !working ? "pointer" : "not-allowed" }}
                disabled={!canAfford || working}
                onClick={() => void unlock()}
                title={canAfford ? "Unlock the Eidolon Tamer" : "Not enough currency"}
              >
                {working ? "Unlocking…" : <>Unlock · <CoinAmount amount={EIDOLON_UNLOCK_COST} /></>}
              </button>
            )}
          </div>
        </div>

        {err && <div style={{ marginTop: 10, color: "#e06070", fontSize: 13 }}>{err}</div>}

        <div className={`mt-3 flex items-center gap-3.5 opacity-[0.55] ${cardClass}`}>
          <div className="shrink-0" style={{ fontSize: 40, lineHeight: 1 }} aria-hidden>✦</div>
          <div className="min-w-0 flex-1">
            <div style={{ fontSize: 16, fontWeight: 700 }}>More games</div>
            <div style={{ fontSize: 12.5, color: T(0.7) }}>Coming soon to the cabinet.</div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
