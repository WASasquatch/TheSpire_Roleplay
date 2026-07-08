/**
 * Eidolon Tamer — the server-synced game. The server is authoritative for
 * all state and economy (see apps/server/src/routes/arcade.ts); this
 * component anchors to the snapshot each endpoint returns and runs the
 * shared decay engine LOCALLY only to keep the gauges/mood moving smoothly
 * between syncs (it re-anchors on focus, on an interval, and after every
 * action — so local drift never becomes authoritative).
 *
 * Interactions:
 *  - Feed / Remedy open the ItemDrawer (they consume real inventory items /
 *    currency), so they stay menu-driven.
 *  - Play and Cleanse are armed TOOLS with a hands-on gesture over the
 *    screen (drag the wisp to play; scrub the grime off to cleanse). The
 *    gesture is client-side flair; finishing it commits the matching free
 *    server action (which owns the stat change). Rest is an instant toggle.
 *  - A familiar earns XP passively for being kept well; its level + sale
 *    value show in the level row, and it can be sold for currency.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyDecay, effectiveTraits, eidolonIsDormant, isNightHour, eidolonXpForLevel, streakRewardFor, EIDOLON_SPECIES_IDS, EIDOLON_TRAITS, EIDOLON_VARIANTS } from "@thekeep/shared";
import type { EidolonHallEntry, EidolonSnapshot, EidolonStats } from "@thekeep/shared";
import { useEarning } from "../../state/earning";
import { ArcadeError, eidolonAction, fetchEidolon, fetchEidolonHall, feedEidolon, hatchEidolon, playToyEidolon, releaseEidolon, remedyEidolon, reviveEidolon, sellEidolon, setEidolonNudgeOptin } from "../../lib/arcade";
import { enablePush, isSupported as pushSupported } from "../../lib/push";
import type { ArcadeAccess, HatchPet, HatchSpecies } from "../../lib/arcade";
import { CoinAmount } from "../earning/CoinAmount";
import { ensureInjectedStyle } from "../../lib/injectStyle";
import {
  Action, EIDOLON_CSS, Egg, Familiar, Gauge, GAUGE_ICON, G, Moon, Ooze, STATUS_LINE, Sun,
  SPECIES_VISUAL, celestial, deriveVisual, fmtClock, growthTier, inv, speciesBase,
} from "./eidolonEngine";
import { ItemDrawer } from "./ItemDrawer";

interface Live {
  stats: EidolonStats;
  simHour: number;
  asleep: boolean;
  sick: boolean;
  ageHours: number;
  messCount: number;
  dead: boolean;
}
interface FloatMsg { id: number; text: string; tone: "good" | "bad" | "neutral"; x: number }
interface Grime { id: string; x: number; y: number; cleaned: boolean }

const cssVars = (o: Record<string, string>): React.CSSProperties => o as React.CSSProperties;
const clampPct = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));

const liveFromSnap = (s: EidolonSnapshot): Live => ({
  stats: { ...s.stats }, simHour: s.simHour, asleep: s.asleep, sick: s.sick,
  ageHours: s.ageHours, messCount: s.messCount, dead: eidolonIsDormant(s.stage),
});

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Inject the device stylesheet with the CSP nonce stamped. A plain
  // <style>{EIDOLON_CSS}</style> is blocked by the strict prod CSP, which left
  // the whole minigame unstyled in prod (worked in dev where there's no CSP).
  useEffect(() => { ensureInjectedStyle("eidolon-css", EIDOLON_CSS); }, []);
  return <div className="eidolon-root">{children}</div>;
}
const noticeStyle: React.CSSProperties = { padding: "48px 24px", textAlign: "center", fontStyle: "italic", lineHeight: 1.5 };

export function EidolonTamer({ characterId }: { characterId: string | null }): React.JSX.Element {
  const [access, setAccess] = useState<ArcadeAccess | "loading">("loading");
  const [snap, setSnap] = useState<EidolonSnapshot | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<null | "food" | "remedy" | "revive" | "toy">(null);
  const [floats, setFloats] = useState<FloatMsg[]>([]);
  const [petAnim, setPetAnim] = useState("");
  const [squish, setSquish] = useState(false);
  // gestural tools
  const [tool, setTool] = useState<null | "play" | "clean">(null);
  const [grime, setGrime] = useState<Grime[]>([]);
  const [wisp, setWisp] = useState({ x: 50, y: 64 });
  const [cloth, setCloth] = useState({ x: 0, y: 0, show: false });
  const [lean, setLean] = useState(0);
  // sell confirm
  const [sellArm, setSellArm] = useState(false);
  const [nudgeBusy, setNudgeBusy] = useState(false);
  // The Hall (memorial gallery of departed familiars)
  const [hallOpen, setHallOpen] = useState(false);

  const liveRef = useRef<Live | null>(null); liveRef.current = live;
  const metaRef = useRef<{ kind: "species" | "pet"; speciesId: string | null; trait: string | null }>({ kind: "species", speciesId: null, trait: null });
  const lastTick = useRef(0);
  const fid = useRef(0);
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevStreakRef = useRef<number | null>(null);
  const prevLevelRef = useRef<number | null>(null);
  const xpRef = useRef(0); // last anchored XP, so a tend can float the delta it earned
  const interactingRef = useRef(false); // true while a tool is armed or an action is in flight
  const screenRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: "play" | "wipe" } | null>(null);
  const playLast = useRef(0);
  // Synchronous in-flight guard for mutating actions. The `busy` STATE drives
  // UI disabling, but it can't gate re-entry: two clicks in the same tick both
  // read the stale `busy=false` closure before React re-renders, so both fire
  // (a double-fire that double-consumes food/potions). A ref is set/checked
  // synchronously with no await between, so the second call is dropped.
  const inFlight = useRef(false);

  const earning = useEarning((s) => s.snapshot);
  const refreshEarning = useEarning((s) => s.refresh);
  // Mirror "is the player mid-interaction" into a ref the ambient timer reads.
  interactingRef.current = !!tool || busy;

  const pushFloat = useCallback((text: string, tone: FloatMsg["tone"] = "good", x?: number) => {
    const id = ++fid.current;
    const fx = x == null ? 38 + Math.random() * 24 : clampPct(x, 6, 94);
    setFloats((f) => [...f, { id, text, tone, x: fx }]);
    setTimeout(() => setFloats((f) => f.filter((z) => z.id !== id)), 1400);
  }, []);
  const flash = useCallback((cls: string, ms = 360) => {
    setPetAnim(cls);
    if (animTimer.current) clearTimeout(animTimer.current);
    animTimer.current = setTimeout(() => setPetAnim(""), ms);
  }, []);

  /** Re-anchor all local state to a fresh server snapshot. */
  const anchor = useCallback((s: EidolonSnapshot | null) => {
    setSnap(s);
    // Tear down any in-progress gesture / sell-confirm so a re-sync (focus,
    // 60s tick, or post-action) can't leave stale interaction state.
    setTool(null); setGrime([]); setLean(0); setSellArm(false);
    dragRef.current = null;
    if (sellTimer.current) { clearTimeout(sellTimer.current); sellTimer.current = null; }
    if (s) {
      metaRef.current = { kind: s.kind, speciesId: s.speciesId, trait: s.trait };
      // Celebrate when the care-streak advances (a tend on a new day). The
      // daily loop WANTS this little pop — it's the reward moment.
      if (prevStreakRef.current != null && s.streakCount > prevStreakRef.current) {
        const reward = streakRewardFor(s.streakCount);
        pushFloat(reward > 0 ? `🔥 ${s.streakCount}-day streak · +${reward}!` : `🔥 ${s.streakCount}-day streak!`, "good", 50);
      }
      prevStreakRef.current = s.streakCount;
      // Level-up celebration (a wanted pop for this engagement minigame).
      if (prevLevelRef.current != null && s.level > prevLevelRef.current) {
        flash("levelup", 600);
        pushFloat(`✦ Level ${s.level} ✦`, "good", 50);
      }
      prevLevelRef.current = s.level;
      xpRef.current = s.xp;
      setLive(liveFromSnap(s));
      lastTick.current = Date.now();
    } else {
      prevStreakRef.current = null;
      prevLevelRef.current = null;
      xpRef.current = 0;
      setLive(null);
    }
  }, [pushFloat, flash]);

  /* ---- initial load + periodic / on-focus re-sync ---- */
  const sync = useCallback(async () => {
    try {
      const res = await fetchEidolon(characterId);
      setAccess(res.access);
      if (res.access === "ok") anchor(res.eidolon);
    } catch {
      setAccess("forbidden");
    }
  }, [characterId, anchor]);

  useEffect(() => { setAccess("loading"); void sync(); }, [sync]);
  useEffect(() => {
    const iv = setInterval(() => { if (document.visibilityState === "visible") void sync(); }, 60_000);
    const onVis = () => { if (document.visibilityState === "visible") void sync(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [sync]);

  /* ---- local visual tick (smoothing only; never persisted) ---- */
  useEffect(() => {
    if (access !== "ok" || !snap || eidolonIsDormant(snap.stage)) return;
    lastTick.current = Date.now();
    const id = setInterval(() => {
      const L = liveRef.current;
      if (!L || L.dead) return;
      const now = Date.now();
      let dtSec = (now - lastTick.current) / 1000; lastTick.current = now;
      if (dtSec < 0) dtSec = 0; if (dtSec > 3600) dtSec = 3600;
      const dtH = dtSec / 3600; // realtime: one sim-hour per real-hour
      const nextSim = (L.simHour + dtH) % 24;
      const night = isNightHour(nextSim);
      const wasNight = isNightHour(L.simHour);
      let asleep = L.asleep;
      if (night && !wasNight) asleep = true;
      if (!night && wasNight) asleep = false;
      const tr = effectiveTraits(metaRef.current.kind, metaRef.current.speciesId, metaRef.current.trait);
      const stats = applyDecay(L.stats, dtH, { asleep, night, sick: L.sick, messCount: L.messCount }, tr);
      const dead = stats.health <= 0;
      setLive({ stats, simHour: nextSim, asleep, sick: L.sick, ageHours: L.ageHours + dtH, messCount: L.messCount, dead });
      if (dead) void sync();
    }, 1000);
    return () => clearInterval(id);
  }, [access, snap, sync]);

  useEffect(() => () => {
    if (animTimer.current) clearTimeout(animTimer.current);
    if (sellTimer.current) clearTimeout(sellTimer.current);
  }, []);

  /* ---- ambient idle micro-reactions: a little life between actions ---- */
  useEffect(() => {
    if (access !== "ok") return;
    const id = setInterval(() => {
      const L = liveRef.current;
      if (!L || L.dead || L.asleep || interactingRef.current) return;
      if (L.sick) { if (Math.random() < 0.5) flash("cough", 500); }
      else if (L.stats.joy > 70) { if (Math.random() < 0.3) flash("purr", 320); }
    }, 22_000);
    return () => clearInterval(id);
  }, [access, flash]);

  /* ---- action runner (free server actions: play / clean / rest) ---- */
  const runAction = useCallback(async (fn: () => Promise<EidolonSnapshot>, opts?: { anim?: string; float?: [string, FloatMsg["tone"]] }) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const beforeXp = xpRef.current;
      const next = await fn();
      anchor(next);
      // Surface the XP this tend earned (server-authoritative) so the Lv/XP bar
      // visibly pays off. floor-diff so sub-1 passive drift doesn't show a "+0".
      const gainedXp = Math.floor(next.xp) - Math.floor(beforeXp);
      if (gainedXp >= 1) pushFloat(`+${gainedXp} XP`, "good", 50);
      if (opts?.anim) flash(opts.anim);
      if (opts?.float) pushFloat(opts.float[0], opts.float[1]);
      void refreshEarning();
    } catch (e) {
      const msg = e instanceof ArcadeError && typeof e.body.error === "string" ? e.body.error : "The ritual faltered.";
      pushFloat(msg, "bad", 50);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [anchor, flash, pushFloat, refreshEarning]);

  const doSquish = useCallback(() => { setSquish(true); setTimeout(() => setSquish(false), 320); }, []);

  /** Hatch an egg (species or pet) and celebrate the result: a rare prismatic
   *  variant, a lineage head-start (level > 1 from an inherited bloodline), or
   *  an ordinary hatch. The server rolls the variant + applies lineage. */
  const doHatch = useCallback(async (choice: HatchSpecies | HatchPet) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const next = await hatchEidolon(characterId, choice);
      anchor(next);
      if (next.variant) pushFloat(`✦ ${EIDOLON_VARIANTS[next.variant]?.label ?? "Rare"}! ✦`, "good", 50);
      else if (next.level > 1) pushFloat(`✦ the bloodline endures · Lv ${next.level} ✦`, "good", 50);
      else pushFloat("✦ hatched ✦", "good", 50);
      void refreshEarning();
    } catch (e) {
      const msg = e instanceof ArcadeError && typeof e.body.error === "string" ? e.body.error : "The ritual faltered.";
      pushFloat(msg, "bad", 50);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [characterId, anchor, pushFloat, refreshEarning]);

  /** "Release": delete the dormant familiar server-side, then drop to the
   *  egg-select screen (for a player who'd rather start over than spend a
   *  Potion to revive). Server-side delete (not just anchor(null)) so the
   *  periodic re-sync can't re-load the dormant row and bounce the UI back. */
  const resummon = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await releaseEidolon(characterId);
      anchor(null);
    } catch (e) {
      const msg = e instanceof ArcadeError && typeof e.body.error === "string" ? e.body.error : "Could not release it.";
      pushFloat(msg, "bad", 50);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [characterId, anchor, pushFloat]);

  /** Sell the living familiar for currency (two-click confirm). */
  const doSell = useCallback(async () => {
    if (inFlight.current || !snap) return;
    inFlight.current = true;
    setBusy(true); setSellArm(false);
    try {
      const res = await sellEidolon(characterId);
      pushFloat(`✦ sold · +${res.value}`, "good", 50);
      anchor(null);
      void refreshEarning();
    } catch (e) {
      const msg = e instanceof ArcadeError && typeof e.body.error === "string" ? e.body.error : "Sale failed.";
      pushFloat(msg, "bad", 50);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [snap, characterId, anchor, pushFloat, refreshEarning]);

  const onSellClick = useCallback(() => {
    if (sellArm) { if (sellTimer.current) clearTimeout(sellTimer.current); void doSell(); return; }
    setSellArm(true);
    if (sellTimer.current) clearTimeout(sellTimer.current);
    sellTimer.current = setTimeout(() => setSellArm(false), 4000);
  }, [sellArm, doSell]);

  /** Toggle daily "needs you" push nudges. Enabling also prompts the browser
   *  push permission within this click gesture (browsers require a gesture). */
  const toggleNudge = useCallback(async () => {
    if (!snap || nudgeBusy) return;
    const next = !snap.nudgeOptin;
    setNudgeBusy(true);
    try {
      if (next && pushSupported()) { try { await enablePush(); } catch { /* denied/unsupported — still record the preference */ } }
      anchor(await setEidolonNudgeOptin(characterId, next));
    } catch {
      pushFloat("Couldn't update reminders.", "bad", 50);
    } finally {
      setNudgeBusy(false);
    }
  }, [snap, nudgeBusy, characterId, anchor, pushFloat]);

  /* ---- owned pets for the egg-select pet-hatch option ---- */
  const ownedPets = useMemo(() => {
    if (!earning) return [] as Array<{ key: string; name: string; iconUrl: string | null }>;
    const inventory = characterId ? (earning.inventoryByCharacter[characterId] ?? []) : earning.inventory;
    const byKey = new Map(earning.catalog.items.map((it) => [it.key, it]));
    return inventory
      .map((e) => byKey.get(e.itemKey))
      .filter((it): it is NonNullable<typeof it> => !!it && it.category === "pet")
      .map((it) => ({ key: it.key, name: it.name, iconUrl: it.iconUrl }));
  }, [earning, characterId]);

  // Commit the cleanse once every grime patch is wiped. MUST live above the
  // early returns below — it's a hook, so it has to run on every render
  // regardless of access state (Rules of Hooks).
  useEffect(() => {
    if (tool === "clean" && grime.length > 0 && grime.every((g) => g.cleaned)) {
      setTool(null); setGrime([]);
      void runAction(() => eidolonAction(characterId, "clean"), { float: ["✦ cleansed", "good"] });
    }
  }, [tool, grime, runAction, characterId]);

  if (access === "loading") return <Shell><div style={noticeStyle}>Summoning…</div></Shell>;
  if (access === "forbidden") return <Shell><div style={noticeStyle}>The Arcade is closed to you right now.</div></Shell>;
  if (access === "locked") return <Shell><div style={noticeStyle}>This game is locked. Unlock the Eidolon Tamer from the Spire Arcade.</div></Shell>;

  const v = live;
  const sp = snap;
  // "dead" here means the lifeless DORMANT state (frozen, awaiting a Potion-revive)
  // — the chosen death model, not permadeath. Kept as `dead` to avoid churn.
  const dead = !!(sp && (eidolonIsDormant(sp.stage) || v?.dead));
  const asleep = !!v?.asleep;
  const sick = !!v?.sick;
  const stats: EidolonStats = v?.stats ?? { satiety: 0, joy: 0, vigor: 0, hygiene: 0, health: 0 };
  const simHour = v?.simHour ?? 8;
  const night = isNightHour(simHour);
  const cel = celestial(simHour, night);
  const base = sp && sp.kind === "species" ? speciesBase(sp.speciesId) : ([150, 138, 214] as [number, number, number]);
  const vis = deriveVisual(stats, { asleep, sick, dead }, base);
  const ageH = Math.floor(v?.ageHours ?? 0);
  const ageStr = ageH >= 24 ? `${Math.floor(ageH / 24)}d ${ageH % 24}h` : `${ageH}h`;
  const busyTool = !sp || dead || asleep || busy;
  const name = sp?.name ?? "??????";
  const speciesName = sp ? (sp.kind === "pet" ? "Pet" : (SPECIES_VISUAL[sp.speciesId ?? "dragon"]?.name ?? "Eidolon")) : "";
  const messToShow = sp && stats.hygiene < 30 ? Math.min(3, v?.messCount ?? 0) : 0;

  // level / XP bar (from the authoritative snapshot). Defaulted defensively
  // so a snapshot missing the progression fields degrades gracefully instead
  // of crashing the window (e.g. CoinAmount calling .toLocaleString on undefined).
  const level = sp?.level ?? 1;
  const xp = sp?.xp ?? 0;
  const saleValue = sp?.saleValue ?? 0;
  const intoLevel = Math.max(0, xp - eidolonXpForLevel(level));
  const levelSpan = eidolonXpForLevel(level + 1) - eidolonXpForLevel(level);
  const xpPct = levelSpan > 0 ? clampPct((intoLevel / levelSpan) * 100) : 0;
  const streakCount = sp?.streakCount ?? 0;
  const checkedInToday = !!sp?.checkedInToday;
  const streakMultiplier = sp?.streakMultiplier ?? 1;
  const nudgeOptin = !!sp?.nudgeOptin;
  const growth = growthTier(level); // visual growth stage from level
  const traitInfo = sp?.trait ? EIDOLON_TRAITS[sp.trait] : null;
  const variant = sp?.variant ?? null; // rare variant (e.g. prismatic)
  const variantLabel = variant ? (EIDOLON_VARIANTS[variant]?.label ?? "") : "";

  /* ---- gesture plumbing ---- */
  const localPos = (e: React.PointerEvent) => {
    const r = screenRef.current!.getBoundingClientRect();
    return {
      x: clampPct(((e.clientX - r.left) / r.width) * 100), y: clampPct(((e.clientY - r.top) / r.height) * 100),
      px: e.clientX - r.left, py: e.clientY - r.top, w: r.width, h: r.height,
    };
  };
  const genGrime = (): Grime[] => {
    const dirtI = inv(stats.hygiene, 74, 8);
    const n = 5 + Math.round(dirtI * 5);
    const out: Grime[] = [];
    for (let i = 0; i < n; i++) out.push({ id: `g${i}`, x: 32 + Math.random() * 36, y: 30 + Math.random() * 40, cleaned: false });
    return out;
  };
  const armTool = (t: "play" | "clean") => {
    if (busyTool) return;
    if (tool === t) { setTool(null); setGrime([]); return; }
    setTool(t);
    if (t === "play") { setWisp({ x: 50, y: 62 }); playLast.current = 0; }
    if (t === "clean") setGrime(genGrime());
  };
  const wipeAt = (p: { px: number; py: number; w: number; h: number }) => {
    setGrime((gs) => {
      let changed = false;
      const ng = gs.map((g) => {
        if (g.cleaned) return g;
        const gx = (g.x / 100) * p.w, gy = (g.y / 100) * p.h;
        if (Math.hypot(gx - p.px, gy - p.py) < 30) { changed = true; return { ...g, cleaned: true }; }
        return g;
      });
      return changed ? ng : gs;
    });
  };
  const overlayDown = (e: React.PointerEvent) => {
    e.preventDefault();
    // Capture the pointer so a fast drag can't escape the screen bounds (and
    // so pointerleave won't fire mid-drag and prematurely commit a play).
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = localPos(e);
    if (tool === "play") { setWisp({ x: p.x, y: p.y }); dragRef.current = { kind: "play" }; setLean(((p.x - 50) / 50) * 12); }
    if (tool === "clean") { dragRef.current = { kind: "wipe" }; setCloth({ x: p.px, y: p.py, show: true }); wipeAt(p); }
  };
  const overlayMove = (e: React.PointerEvent) => {
    const p = localPos(e);
    if (tool === "clean") setCloth({ x: p.px, y: p.py, show: true });
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "play") {
      setWisp({ x: p.x, y: p.y });
      setLean(((p.x - 50) / 50) * 12);
      const dist = Math.hypot(p.px - 0.5 * p.w, p.py - 0.5 * p.h);
      const now = performance.now();
      if (dist < 110 && now - playLast.current > 150) { playLast.current = now; if (Math.random() < 0.45) pushFloat("♥", "good", p.x); flash("excited", 240); }
    } else if (d.kind === "wipe") wipeAt(p);
  };
  // Intentional release (pointerup) commits the play action.
  const overlayUp = (e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const d = dragRef.current; dragRef.current = null; setLean(0); setCloth((c) => ({ ...c, show: false }));
    if (d?.kind === "play") { flash(wisp.x < 50 ? "pounceL" : "pounceR", 360); setTool(null); void runAction(() => eidolonAction(characterId, "play"), { float: ["♥", "good"] }); }
  };
  // Interruption (pointercancel) just tears down the gesture — never commits.
  const overlayCancel = (e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = null; setLean(0); setCloth((c) => ({ ...c, show: false }));
  };
  // Hover-out only hides the cleanse cloth; during a drag the pointer is
  // captured so this won't fire and can't commit anything.
  const overlayLeave = () => { if (!dragRef.current) setCloth((c) => ({ ...c, show: false })); };

  const onStageClick = () => { if (!sp || dead || asleep || tool) return; doSquish(); };

  return (
    <Shell>
      <div className="device" style={cssVars({ "--screen-glow": vis.glow })}>
        <span className="rivet r-tl" /><span className="rivet r-tr" /><span className="rivet r-bl" /><span className="rivet r-br" />

        <div ref={screenRef} className={`screen ${asleep ? "screen--dim" : ""} ${night ? "is-night" : "is-day"}`} style={cssVars({ "--aura": vis.aura })}>
          <div className="daylight" /><div className="vignette" /><div className="scanlines" />
          <div className="starfield">{STARS.map((st, i) => (<span key={i} className="star" style={{ left: st.x + "%", top: st.y + "%", width: st.s + "px", height: st.s + "px", opacity: st.o, animationDelay: st.d + "s" }} />))}</div>
          <div className="celestial" style={{ left: cel.left + "%", top: cel.top + "px" }}>{night ? <Moon /> : <Sun />}</div>
          <div className="hud"><span className="ph">{night ? "☾" : "☀"}</span><span>{fmtClock(simHour)}</span></div>
          <div className="aura" />

          {MESS_SLOTS.slice(0, messToShow).map((o) => <Ooze key={o.id} x={o.x} y={o.y} delay={o.delay} />)}

          {!sp ? (
            <div className="select-wrap">
              <span className="select-title">Choose an egg to summon</span>
              <div className="select-grid">
                {EIDOLON_SPECIES_IDS.map((id) => {
                  const s = SPECIES_VISUAL[id]!;
                  return (
                    <button key={id} className="egg-choice" disabled={busy} onClick={() => void doHatch({ kind: "species", speciesId: id })}>
                      <span className="egg-choice-egg"><Egg crack={0} shell={s.shell} accent={s.accent} noRock /></span>
                      <span className="egg-label">{s.name}</span>
                      <span className="egg-tag">{s.tagline}</span>
                    </button>
                  );
                })}
              </div>
              <span className="select-title" style={{ marginTop: 4 }}>{ownedPets.length ? "- or hatch with a pet -" : "- acquire a pet to hatch one as a familiar -"}</span>
              {ownedPets.length > 0 && (
                <div className="select-grid">
                  {ownedPets.slice(0, 4).map((p) => (
                    <button key={p.key} className="egg-choice" disabled={busy} onClick={() => void doHatch({ kind: "pet", petItemKey: p.key })}>
                      <span className="egg-choice-pet">{p.iconUrl ? <img src={p.iconUrl} alt={p.name} /> : <span className="egg-label">?</span>}</span>
                      <span className="egg-label">{p.name}</span>
                      <span className="egg-tag">your pet</span>
                    </button>
                  ))}
                </div>
              )}
              <button className="ei-hall-link" onClick={() => setHallOpen(true)}>📖 The Hall, familiars past</button>
            </div>
          ) : (
            <div className={`stage-pet ${growth.tier === "elder" ? "is-elder" : ""} ${variant === "prismatic" ? "is-prismatic" : ""}`} onClick={onStageClick} style={{ transform: `translate(-50%,-50%) translateX(${lean}px) scale(${growth.scale})` }}>
              <div className={`pet-inner ${petAnim ? "is-" + petAnim : ""}`}>
                <Familiar vis={vis} speciesId={sp.speciesId} kind={sp.kind} petIconUrl={sp.petIconUrl} squish={squish} />
              </div>
            </div>
          )}

          {tool && sp && !dead && !asleep && (
            <div
              className="ei-overlay"
              style={{ cursor: tool === "clean" ? "none" : "grab" }}
              onPointerDown={overlayDown}
              onPointerMove={overlayMove}
              onPointerUp={overlayUp}
              onPointerCancel={overlayCancel}
              onPointerLeave={overlayLeave}
            >
              {tool === "play" && (
                <span className="ei-wisp" style={{ left: wisp.x + "%", top: wisp.y + "%" }}>
                  <svg viewBox="0 0 40 40"><circle className="ei-wisp-halo" cx="20" cy="20" r="14" /><circle cx="20" cy="20" r="6.5" fill="#bff4ff" /><circle cx="20" cy="20" r="3" fill="#fff" /></svg>
                </span>
              )}
              {tool === "clean" && (
                <>
                  {grime.map((g) => (
                    <span key={g.id} className={`ei-grime ${g.cleaned ? "is-clean" : ""}`} style={{ left: g.x + "%", top: g.y + "%" }}>
                      <svg viewBox="0 0 40 40"><path d="M8 16 Q4 8 12 7 Q16 2 24 6 Q34 4 34 14 Q40 20 32 26 Q32 36 22 33 Q12 38 9 28 Q2 24 8 16 Z" fill="#2c1c10" opacity=".88" /></svg>
                    </span>
                  ))}
                  {cloth.show && <span className="ei-cloth" style={{ left: cloth.x + "px", top: cloth.y + "px" }} />}
                </>
              )}
            </div>
          )}

          {floats.map((f) => (<span key={f.id} className={`float float--${f.tone}`} style={{ left: f.x + "%" }}>{f.text}</span>))}

          {sp && (
            <div className="readout">
              {dead ? (<span>{STATUS_LINE.dead!(name)}</span>)
                : tool === "play" ? (<span><b>Drag the wisp</b> near your familiar, then release.</span>)
                  : tool === "clean" ? (<span><b>Scrub</b> the grime away.</span>)
                    : (<span>{STATUS_LINE[vis.primary]!(name)}</span>)}
            </div>
          )}
        </div>

        <div className="nameplate">
          <span className="np-name">{!sp ? "??????" : name}</span>
          <span className="np-meta">
            {!sp ? "unbound" : `${dead ? "" : growth.label + " "}${variantLabel ? variantLabel + " " : ""}${speciesName} · ${dead ? "dormant" : vis.label} · ${ageStr}`}
            {sick && !dead && sp && <em className="np-warn"> · afflicted</em>}
          </span>
        </div>

        {sp && !dead && (
          <div className="ei-levelrow">
            <span className="ei-level" title={`${Math.floor(xp)} total XP`}>
              Lv {level}
              {streakCount > 0 && (
                <span className={`ei-flame ${checkedInToday ? "is-fresh" : ""}`} title={`${checkedInToday ? "Tended today" : "Not tended yet today"} · passive XP ×${streakMultiplier.toFixed(2)}`}> · 🔥{streakCount}</span>
              )}
            </span>
            {traitInfo ? <span className="ei-trait" title={traitInfo.flavor}>{traitInfo.label}</span> : null}
            <div className="ei-xptrack" title={`${Math.floor(intoLevel)} / ${levelSpan} to next level`}><div className="ei-xpfill" style={{ width: xpPct + "%" }} /></div>
            <button className="ei-bell" onClick={() => setHallOpen(true)} title="The Hall, familiars past" aria-label="Open the Hall">📖</button>
            <button className={`ei-bell ${nudgeOptin ? "is-on" : ""}`} disabled={nudgeBusy} onClick={() => void toggleNudge()} title={nudgeOptin ? "Daily reminders on" : "Daily reminders off"} aria-label="Toggle daily reminders">
              {nudgeOptin ? "🔔" : "🔕"}
            </button>
            <button className={`ei-sell ${sellArm ? "is-armed" : ""}`} disabled={busy} onClick={onSellClick} title="Sells for the currency it has earned (an inherited head-start isn't counted), and frees you to tame anew">
              {sellArm ? <>Confirm sale · <CoinAmount amount={saleValue} /></> : <>Sell · <CoinAmount amount={saleValue} /></>}
            </button>
          </div>
        )}

        <div className="gauges">
          <Gauge icon={GAUGE_ICON.satiety!} label="Satiety" value={stats.satiety} danger={stats.satiety < 24} />
          <Gauge icon={GAUGE_ICON.joy!} label="Spirit" value={stats.joy} danger={stats.joy < 24} />
          <Gauge icon={GAUGE_ICON.vigor!} label="Vigor" value={stats.vigor} danger={stats.vigor < 22} />
          <Gauge icon={GAUGE_ICON.hygiene!} label="Hygiene" value={stats.hygiene} danger={stats.hygiene < 24} />
          <Gauge icon={GAUGE_ICON.health!} label="Health" value={stats.health} danger={stats.health < 28} />
        </div>

        {dead ? (
          <div className="dead-panel">
            <p>It has gone dormant. A magical item will wake it.</p>
            <div className="dead-actions">
              <button className="resummon" disabled={busy} onClick={() => setDrawer("revive")}>Revive</button>
              <button className="resummon resummon--ghost" disabled={busy} onClick={() => void resummon()}>Release</button>
            </div>
          </div>
        ) : (
          <div className="controls">
            <Action glyph={G.feed!} name="Feed" onClick={() => setDrawer("food")} disabled={busyTool} />
            <Action glyph={G.play!} name="Play" onClick={() => armTool("play")} on={tool === "play"} disabled={busyTool} />
            <Action glyph={G.toy!} name="Toys" onClick={() => setDrawer("toy")} disabled={busyTool} />
            <Action glyph={G.clean!} name="Cleanse" onClick={() => armTool("clean")} on={tool === "clean"} disabled={busyTool} />
            <Action glyph={G.cure!} name="Remedy" onClick={() => setDrawer("remedy")} disabled={!sp || dead} />
            <Action glyph={G.rest!} name={asleep ? "Wake" : "Rest"} onClick={() => { pushFloat(asleep ? "✦ awoken" : "✦ slumber", "neutral"); void runAction(() => eidolonAction(characterId, "rest")); }} disabled={!sp || dead || busy} />
          </div>
        )}
      </div>

      {drawer && sp && (
        <ItemDrawer
          mode={drawer}
          characterId={characterId}
          onClose={() => setDrawer(null)}
          onFeed={(itemKey) => { setDrawer(null); void runAction(() => feedEidolon(characterId, itemKey), { anim: "chomp", float: ["✦ nom", "good"] }); }}
          onUsePotion={(itemKey) => {
            const m = drawer; // remedy | revive | toy — route the non-food use by mode
            setDrawer(null);
            if (m === "toy") void runAction(() => playToyEidolon(characterId, itemKey), { anim: "excited", float: ["♥", "good"] });
            else if (m === "revive") void runAction(() => reviveEidolon(characterId, itemKey), { anim: "levelup", float: ["✦ awoken", "good"] });
            else void runAction(() => remedyEidolon(characterId, itemKey), { float: ["✦ remedy", "good"] });
          }}
          onBasicHeal={() => { setDrawer(null); void runAction(() => remedyEidolon(characterId), { float: ["+ vitality", "good"] }); }}
        />
      )}

      {hallOpen && <HallOverlay characterId={characterId} onClose={() => setHallOpen(false)} />}
    </Shell>
  );
}

/** The Hall — a read-only memorial gallery of this identity's departed
 *  familiars (sold or released), most recent first. Reuses the item-drawer
 *  shell for visual consistency. */
function HallOverlay({ characterId, onClose }: { characterId: string | null; onClose: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState<EidolonHallEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchEidolonHall(characterId).then((h) => { if (alive) setEntries(h); }).catch(() => { if (alive) setEntries([]); });
    return () => { alive = false; };
  }, [characterId]);
  return (
    <div className="ei-drawer-scrim" onClick={onClose} role="presentation">
      <div className="ei-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ei-drawer-head">
          <span className="ei-drawer-title">The Hall · familiars past</span>
          <button className="ei-drawer-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="ei-drawer-list">
          {entries == null ? (
            <div className="ei-empty">Opening the Hall…</div>
          ) : entries.length === 0 ? (
            <div className="ei-empty">No familiars have departed yet. Those you raise will be remembered here.</div>
          ) : entries.map((h) => {
            const sp = h.kind === "pet" ? "Pet" : (SPECIES_VISUAL[h.speciesId ?? "dragon"]?.name ?? "Eidolon");
            const trait = h.trait ? EIDOLON_TRAITS[h.trait]?.label : null;
            const varLabel = h.variant ? EIDOLON_VARIANTS[h.variant]?.label : null;
            const ageH = Math.floor(h.ageHours);
            const ageStr = ageH >= 24 ? `${Math.floor(ageH / 24)}d` : `${ageH}h`;
            return (
              <div className="ei-hall-row" key={h.id}>
                <span className="ei-hall-name">{varLabel ? <span className="ei-hall-prism">✦ </span> : null}{h.name}</span>
                <span className="ei-hall-meta">
                  Lv {h.peakLevel} · {varLabel ? `${varLabel} ` : ""}{sp}{trait ? ` · ${trait}` : ""} · {ageStr} · {h.departReason === "sold" ? "sold" : "released"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* stable ambient decorations (no per-frame randomness) */
const STARS = Array.from({ length: 36 }, (_, i) => ({
  x: (i * 53) % 100, y: (i * 89) % 100, s: ((i * 7) % 12) / 10 + 0.6, d: (i % 5) * 0.8, o: ((i * 13) % 5) / 10 + 0.35,
}));
const MESS_SLOTS = [
  { id: "m0", x: 30, y: 70, delay: 0 },
  { id: "m1", x: 60, y: 74, delay: 200 },
  { id: "m2", x: 46, y: 78, delay: 400 },
];
