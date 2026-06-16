/**
 * Spire Arcade launcher (a modal). Lists the arcade's games; game #1 is the
 * Eidolon Tamer. The lock state comes from the arcade endpoint itself (a
 * 402 = "permission OK, not yet unlocked"), not the earning snapshot, so the
 * launcher can show Play vs. Unlock without extra plumbing. Unlocking buys
 * the one-time `flair_eidolon_tamer` cosmetic for the active identity, then
 * launches the floating window.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Monitor } from "lucide-react";
import { EIDOLON_UNLOCK_COST, URUGAL_UNLOCK_COST, GRIMHOLD_UNLOCK_COST } from "@thekeep/shared";
import { Modal } from "../Modal";
import { CloseButton } from "../CloseButton";
import { CoinAmount } from "../CoinAmount";
import { useEarning } from "../../state/earning";
import { fetchEidolon, unlockEidolon } from "../../lib/arcade";
import { fetchUrugalAccess, unlockUrugal } from "../../lib/urugal";
import { fetchGrimholdAccess, unlockGrimhold } from "../../lib/grimhold";

type Access = "loading" | "ok" | "locked" | "forbidden";

// Urugal's Descent is a keyboard-driven roguelike with a desktop-sized
// playfield, so it's gated to desktop. Matches the chat shell's lg
// mobile/desktop boundary (see EidolonWindow / Modal's variants).
const MOBILE_QUERY = "(max-width: 1023px)";

/** Live-tracks the mobile/desktop boundary so the gate flips on rotation or a
 *  desktop window resize across the breakpoint. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

export function ArcadeLauncher({ characterId, onLaunch, onClose }: {
  characterId: string | null;
  onLaunch: (game: "eidolon" | "urugal" | "grimhold") => void;
  onClose: () => void;
}): React.JSX.Element {
  const [access, setAccess] = useState<Access>("loading");
  const [working, setWorking] = useState(false);
  const [urugalAccess, setUrugalAccess] = useState<Access>("loading");
  const [urugalWorking, setUrugalWorking] = useState(false);
  const [grimholdAccess, setGrimholdAccess] = useState<Access>("loading");
  const [grimholdWorking, setGrimholdWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mobile = useIsMobile();
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
    setUrugalAccess("loading");
    fetchEidolon(characterId)
      .then((r) => { if (alive) setAccess(r.access === "ok" ? "ok" : r.access); })
      .catch(() => { if (alive) setAccess("forbidden"); });
    fetchUrugalAccess(characterId)
      .then((a) => { if (alive) setUrugalAccess(a); })
      .catch(() => { if (alive) setUrugalAccess("forbidden"); });
    setGrimholdAccess("loading");
    fetchGrimholdAccess(characterId)
      .then((a) => { if (alive) setGrimholdAccess(a); })
      .catch(() => { if (alive) setGrimholdAccess("forbidden"); });
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

  const unlockUrugalGame = async () => {
    if (urugalWorking) return;
    setUrugalWorking(true); setErr(null);
    try {
      await unlockUrugal(characterId);
      await refresh();
      setUrugalAccess("ok");
      onLaunch("urugal");
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unlock failed.");
    } finally {
      setUrugalWorking(false);
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

  const unlockGrimholdGame = async () => {
    if (grimholdWorking) return;
    setGrimholdWorking(true); setErr(null);
    try {
      await unlockGrimhold(characterId);
      await refresh();
      setGrimholdAccess("ok");
      onLaunch("grimhold");
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unlock failed.");
    } finally {
      setGrimholdWorking(false);
    }
  };

  const canAfford = currency >= EIDOLON_UNLOCK_COST;
  const canAffordUrugal = currency >= URUGAL_UNLOCK_COST;
  const canAffordGrimhold = currency >= GRIMHOLD_UNLOCK_COST;

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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 22, letterSpacing: 1 }}>🕹 Spire Arcade</h2>
          {/* Coin balance + an explicit close. The X matters most when the
              card fills a phone screen, there the backdrop is barely
              tappable, so without it the modal felt trapping. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, color: T(0.75) }}><CoinAmount amount={currency} size="md" /></span>
            <CloseButton onClick={onClose} />
          </div>
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

        {/* Game #2: Urugal's Descent. Phase 1 — playable for anyone with arcade
            access (the unlock/purchase gate + reward wiring land in later phases). */}
        <div className={`mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-3.5 ${cardClass}`}>
          <div className="flex min-w-0 flex-1 items-center gap-3.5">
            <div className="shrink-0" style={{ fontSize: 40, lineHeight: 1 }} aria-hidden>🗡</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2" style={{ fontSize: 16, fontWeight: 700 }}>
                <span>Urugal&apos;s Descent</span>
                {/* Always-on tag so the desktop-only nature is clear even on
                    desktop (where the CTA isn't swapped for the note). */}
                <span
                  className="inline-flex items-center gap-1"
                  style={{
                    fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                    color: T(0.6), border: "1px solid rgb(var(--keep-border) / .7)", borderRadius: 6,
                    padding: "1px 6px", whiteSpace: "nowrap",
                  }}
                >
                  <Monitor className="h-3 w-3" aria-hidden="true" /> Desktop only
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: T(0.7), lineHeight: 1.45 }}>
                A gothic roguelike. Pick a class and delve a procedurally-built dungeon — fight, loot,
                and descend as deep as you dare. Every run is different, and every floor is a fresh gamble.
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:items-end">
            {mobile ? (
              // Desktop-only: the roguelike needs a keyboard and a larger
              // playfield, so the CTA is replaced with a note on phones/small
              // tablets rather than launching an unplayable window.
              <span className="text-center sm:max-w-[140px]" style={{ fontSize: 12, color: T(0.6) }}>Available on desktop only.</span>
            ) : (<>
            {urugalAccess === "loading" && <span style={{ fontSize: 12, color: T(0.6), textAlign: "center" }}>…</span>}
            {urugalAccess === "forbidden" && <span className="text-center sm:max-w-[140px]" style={{ fontSize: 12, color: T(0.6) }}>Unavailable to you right now.</span>}
            {urugalAccess === "ok" && (
              <button
                className="w-full sm:w-auto"
                style={{ ...ctaBase, background: "rgb(var(--keep-action) / 1)", color: "rgb(var(--keep-bg) / 1)" }}
                onClick={() => { onLaunch("urugal"); onClose(); }}
              >
                ▶ Play
              </button>
            )}
            {urugalAccess === "locked" && (
              <button
                className="w-full sm:w-auto"
                style={{ ...ctaBase, background: canAffordUrugal ? "rgb(var(--keep-accent) / .15)" : "transparent", color: T(canAffordUrugal ? 1 : 0.45), opacity: urugalWorking ? 0.6 : 1, cursor: canAffordUrugal && !urugalWorking ? "pointer" : "not-allowed" }}
                disabled={!canAffordUrugal || urugalWorking}
                onClick={() => void unlockUrugalGame()}
                title={canAffordUrugal ? "Unlock Urugal's Descent" : "Not enough currency"}
              >
                {urugalWorking ? "Unlocking…" : <>Unlock · <CoinAmount amount={URUGAL_UNLOCK_COST} /></>}
              </button>
            )}
            </>)}
          </div>
        </div>

        {/* Game #3: the Grimhold cabinet — six small score games. Playable
            on mobile (the bundle has an on-screen touch pad), so no
            desktop gate. One unlock covers all six. */}
        <div className={`mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-3.5 ${cardClass}`}>
          <div className="flex min-w-0 flex-1 items-center gap-3.5">
            <div className="shrink-0" style={{ fontSize: 40, lineHeight: 1 }} aria-hidden>🕹</div>
            <div className="min-w-0 flex-1">
              <div style={{ fontSize: 16, fontWeight: 700 }}>Grimhold</div>
              <div style={{ fontSize: 12.5, color: T(0.7), lineHeight: 1.45 }}>
                A cabinet of six cursed amusements — Runefall, Loong, Arrowstorm, The Spire,
                Graveward, and Voidwake. Quick arcade runs that trickle Currency and XP, daily-capped.
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:items-end">
            {grimholdAccess === "loading" && <span style={{ fontSize: 12, color: T(0.6), textAlign: "center" }}>…</span>}
            {grimholdAccess === "forbidden" && <span className="text-center sm:max-w-[140px]" style={{ fontSize: 12, color: T(0.6) }}>Unavailable to you right now.</span>}
            {grimholdAccess === "ok" && (
              <button
                className="w-full sm:w-auto"
                style={{ ...ctaBase, background: "rgb(var(--keep-action) / 1)", color: "rgb(var(--keep-bg) / 1)" }}
                onClick={() => { onLaunch("grimhold"); onClose(); }}
              >
                ▶ Play
              </button>
            )}
            {grimholdAccess === "locked" && (
              <button
                className="w-full sm:w-auto"
                style={{ ...ctaBase, background: canAffordGrimhold ? "rgb(var(--keep-accent) / .15)" : "transparent", color: T(canAffordGrimhold ? 1 : 0.45), opacity: grimholdWorking ? 0.6 : 1, cursor: canAffordGrimhold && !grimholdWorking ? "pointer" : "not-allowed" }}
                disabled={!canAffordGrimhold || grimholdWorking}
                onClick={() => void unlockGrimholdGame()}
                title={canAffordGrimhold ? "Unlock the Grimhold cabinet" : "Not enough currency"}
              >
                {grimholdWorking ? "Unlocking…" : <>Unlock · <CoinAmount amount={GRIMHOLD_UNLOCK_COST} /></>}
              </button>
            )}
          </div>
        </div>

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
