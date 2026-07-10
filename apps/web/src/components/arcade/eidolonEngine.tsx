/**
 * Eidolon Tamer — visual engine, ported from the standalone simulator
 * (the_spire__eidolon_tamer.jsx). This module is presentational only: the
 * layered SVG familiar, the egg, gauges, day/night sky, and the scoped CSS.
 * It owns NO game state — the server is authoritative (see lib/arcade.ts);
 * EidolonTamer.tsx drives these from server snapshots and a local decay tick.
 *
 * Two changes from the original:
 *  - THEME: the gothic palette vars are remapped onto The Spire's `--keep-*`
 *    theme tokens, so the device chrome adapts to the active palette AND a
 *    user's custom colors. The diegetic "screen" interior (night sky, the
 *    creature's own species colors, mood FX) stays as authored — it's the
 *    game world, not chrome, like the screen of a handheld.
 *  - PET PATH: `kind:"pet"` renders an owned pet's PNG as the body (with the
 *    same mood filters + ambient FX overlays), skipping the hand-drawn face.
 */
import React from "react";
import { useTranslation } from "react-i18next";
import { eidolonPrimaryMood, EIDOLON_MOOD_LABEL, isNightHour, NIGHT_END, NIGHT_START } from "@thekeep/shared";
import type { EidolonMood, EidolonStats } from "@thekeep/shared";
import { i18n } from "../../lib/i18n";

/* ---- small math helpers (verbatim) ---- */
type RGB = [number, number, number];
const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix = (c1: RGB, c2: RGB, t: number): RGB => [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];
const rgbStr = (c: RGB): string => `rgb(${c[0]},${c[1]},${c[2]})`;
export const inv = (v: number, hi: number, lo: number): number => clamp((hi - v) / (hi - lo), 0, 1);

/** Cast a style object carrying CSS custom properties to CSSProperties. */
const sv = (o: Record<string, string | number>): React.CSSProperties => o as React.CSSProperties;

export { isNightHour };

/* ---- mood: the glow palette is client-only (visual); the mood SELECTION
   and text now live in @thekeep/shared so the /eidolon server emote speaks the
   exact mood the sprite shows. STATUS_LINE/LABEL are re-exported for callers. */
const GLOW: Record<string, string> = { happy: "150,90,255", sad: "70,110,200", angry: "220,60,55", hungry: "190,150,70", sick: "120,200,90", dirty: "130,100,55", tired: "110,110,170", sleeping: "90,80,170", dead: "150,150,170" };
export { EIDOLON_STATUS_LINE as STATUS_LINE, EIDOLON_MOOD_LABEL as LABEL } from "@thekeep/shared";

export interface Visual {
  hungerI: number; sadI: number; tiredI: number; dirtI: number; sickI: number; angryI: number; happyI: number;
  asleep: boolean; dead: boolean; anim: string; primary: EidolonMood;
  label: string; skin: string; dark: string; eye: string; glow: string; aura: string;
}

export function deriveVisual(stats: EidolonStats, opts: { asleep: boolean; sick: boolean; dead: boolean }, base: RGB = [139, 92, 246]): Visual {
  const { asleep, sick, dead } = opts;
  const hungerI = inv(stats.satiety, 55, 8);
  const sadI = inv(stats.joy, 55, 12);
  const tiredI = inv(stats.vigor, 48, 6);
  const dirtI = inv(stats.hygiene, 74, 8);
  const sickI = sick ? 1 : inv(stats.health, 45, 10);
  const angryI = stats.joy < 24 ? inv(stats.joy, 24, 4) : 0;
  const worst = Math.max(hungerI, sadI, tiredI, dirtI, sickI, angryI);
  const happyI = clamp(1 - worst * 1.7, 0, 1);

  const mud: RGB = [120, 104, 78], green: RGB = [120, 170, 86], blue: RGB = [88, 118, 188], gray: RGB = [154, 154, 166];
  let c: RGB = base.slice() as RGB;
  if (dead) c = gray.slice() as RGB;
  else {
    if (sadI > 0) c = mix(c, blue, sadI * 0.3);
    if (dirtI > 0) c = mix(c, mud, dirtI * 0.55);
    if (sickI > 0) c = mix(c, green, sickI * 0.75);
  }
  const dark = mix(c, [12, 8, 22], 0.5);
  const eyeC: RGB = sickI > 0.4 ? [234, 251, 224] : [254, 246, 255];

  // Mood selection is the shared single source of truth (server emote uses it too).
  const primary = eidolonPrimaryMood(stats, { asleep, sick, dead });

  let anim = "bob";
  if (dead) anim = "ghost";
  else if (asleep) anim = "sleep";
  else if (sickI > 0.55) anim = "woozy";
  else if (angryI > 0.4) anim = "shake";
  else if (sadI > 0.55 || tiredI > 0.6) anim = "slump";
  else if (hungerI > 0.5) anim = "droop";

  const g = GLOW[primary] || GLOW.happy;
  return {
    hungerI, sadI, tiredI, dirtI, sickI, angryI, happyI, asleep, dead, anim, primary,
    label: EIDOLON_MOOD_LABEL[primary], skin: rgbStr(c), dark: rgbStr(dark), eye: rgbStr(eyeC),
    glow: `rgba(${g},.55)`, aura: `rgba(${g},.28)`,
  };
}

/* ---------- species bodies (drawn behind the shared face) — verbatim ---------- */
function DragonBody(): React.JSX.Element {
  return (
    <g>
      <path className="skin-d wing" d="M64 98 C46 84 26 64 8 70 C18 78 14 92 28 92 C14 100 24 114 38 108 C28 120 44 126 52 116 C58 124 66 118 66 108 Z" />
      <path className="skin-d wing" d="M136 98 C154 84 174 64 192 70 C182 78 186 92 172 92 C186 100 176 114 162 108 C172 120 156 126 148 116 C142 124 134 118 134 108 Z" />
      <path className="strut" d="M64 100 L16 74 M64 100 L30 96 M64 100 L42 110" />
      <path className="strut" d="M136 100 L184 74 M136 100 L170 96 M136 100 L158 110" />
      <path className="skin-d" d="M74 62 C66 38 70 24 82 26 C80 44 86 54 90 60 Z" />
      <path className="skin-d" d="M126 62 C134 38 130 24 118 26 C120 44 114 54 110 60 Z" />
      <path className="skin-d" d="M140 176 C172 180 184 150 166 138 C178 150 160 162 152 156 C162 172 146 178 140 172 Z" />
      <path className="skin-d" d="M100 50 l9 13 -18 0 z" /><path className="skin-d" d="M83 57 l7 11 -14 0 z" /><path className="skin-d" d="M117 57 l7 11 -14 0 z" />
      <path className="skin body" d="M100 58 C58 58 48 96 48 128 C48 166 70 186 100 186 C130 186 152 166 152 128 C152 96 142 58 100 58 Z" />
      <ellipse className="belly" cx="100" cy="142" rx="30" ry="36" />
      <path className="plate" d="M82 138 q18 8 36 0" /><path className="plate" d="M82 150 q18 8 36 0" /><path className="plate" d="M84 162 q16 7 32 0" />
      <ellipse className="skin-d" cx="78" cy="186" rx="14" ry="9" /><ellipse className="skin-d" cx="122" cy="186" rx="14" ry="9" />
    </g>
  );
}
function GargoyleBody(): React.JSX.Element {
  return (
    <g>
      <path className="skin-d wing" d="M58 102 C44 92 32 86 26 82 Q26 96 26 112 Q30 120 40 134 Q44 140 56 148 Q60 130 58 102 Z" />
      <path className="skin-d wing" d="M142 102 C156 92 168 86 174 82 Q174 96 174 112 Q170 120 160 134 Q156 140 144 148 Q140 130 142 102 Z" />
      <path className="strut" d="M30 90 L26 112 M34 96 L40 134 M44 104 L56 148" />
      <path className="strut" d="M170 90 L174 112 M166 96 L160 134 M156 104 L144 148" />
      <path className="skin-d" d="M70 58 L58 32 L86 52 Z" /><path className="skin-d" d="M130 58 L142 32 L114 52 Z" />
      <path className="skin body" d="M100 58 C54 58 48 96 48 130 C48 168 72 186 100 186 C128 186 152 168 152 130 C152 96 146 58 100 58 Z" />
      <path className="skin-d" d="M62 104 Q100 92 138 104 L138 110 Q100 100 62 110 Z" />
      <path className="crackline" d="M70 150 l10 8 -4 10" /><path className="crackline" d="M128 140 l-8 10 6 8" /><path className="crackline" d="M98 168 l8 -5" />
      <path className="fang" d="M90 150 l4 11 4 -11 z" /><path className="fang" d="M104 150 l4 11 4 -11 z" />
      <rect className="skin-d" x="60" y="178" width="28" height="14" rx="2" /><rect className="skin-d" x="112" y="178" width="28" height="14" rx="2" />
    </g>
  );
}
function WraithBody(): React.JSX.Element {
  return (
    <g>
      <path className="skin-d" style={{ opacity: 0.85 }} d="M100 40 C60 40 44 74 44 116 C44 150 54 170 54 170 C60 164 70 176 78 170 C86 164 94 176 100 170 C106 176 114 164 122 170 C130 176 138 164 146 170 C146 170 156 150 156 116 C156 74 140 40 100 40 Z" />
      <path className="skin-d tendril" d="M52 122 C34 132 32 150 42 156 C40 144 50 138 57 134 Z" /><path className="skin-d tendril" d="M148 122 C166 132 168 150 158 156 C160 144 150 138 143 134 Z" />
      <path className="skin body" style={{ opacity: 0.92 }} d="M100 56 C68 56 56 84 56 116 C56 146 64 162 64 162 C70 156 78 168 86 162 C92 158 100 166 100 162 C108 166 116 156 122 162 C128 168 136 156 136 162 C136 162 144 146 144 116 C144 84 132 56 100 56 Z" />
    </g>
  );
}
function SlimeBody(): React.JSX.Element {
  return (
    <g>
      <path className="skin" d="M118 74 q6 -16 12 -2 q2 10 -4 12 z" />
      <path className="skin body" style={{ opacity: 0.94 }} d="M100 72 C58 72 40 106 40 142 C40 170 66 184 100 184 C134 184 160 170 160 142 C160 106 142 72 100 72 Z" />
      <path className="gloss" d="M64 96 C58 110 60 122 70 124 C78 120 80 104 74 94 C70 90 66 92 64 96 Z" />
      <circle className="bub-in" cx="122" cy="152" r="7" /><circle className="bub-in" cx="134" cy="132" r="4" /><circle className="bub-in" cx="78" cy="166" r="5" />
    </g>
  );
}

export interface SpeciesVisual {
  name: string;
  base: RGB;
  shell: string;
  accent: string;
  flavor: string;
  tagline: string;
  Body: () => React.JSX.Element;
}

// i18n note: the name/tagline/flavor strings below are the REFERENCE (source)
// copies; every render site shows them via the `arcade` catalog
// (arcade.eidolon.species.<id>.*), so edits must be mirrored in
// packages/shared/locales/en/arcade.json.
export const SPECIES_VISUAL: Record<string, SpeciesVisual> = {
  dragon: { name: "Dragon", base: [78, 142, 96], shell: "#1d3a2a", accent: "#74e0a0", flavor: "A scaled wyrmling.", tagline: "Hardy · Ravenous", Body: DragonBody },
  gargoyle: { name: "Gargoyle", base: [148, 150, 160], shell: "#2b2d36", accent: "#aeb8cc", flavor: "Hewn from cursed stone.", tagline: "Stoic · Low-upkeep", Body: GargoyleBody },
  wraith: { name: "Wraith", base: [150, 138, 214], shell: "#2a2046", accent: "#bda8ff", flavor: "A hungering shade.", tagline: "Fasting · Restless", Body: WraithBody },
  slime: { name: "Slime", base: [96, 198, 184], shell: "#123230", accent: "#7df0dd", flavor: "Gelatinous and giddy.", tagline: "Messy · Carefree", Body: SlimeBody },
};
const speciesVisual = (id: string | null): SpeciesVisual => (id && SPECIES_VISUAL[id]) || SPECIES_VISUAL.dragon!;
export const speciesBase = (id: string | null): RGB => speciesVisual(id).base;

/** Visual growth stage from level — the familiar visibly grows as it's raised.
 *  Pure CSS scale + an elder aura (no new art), driven by the snapshot level.
 *  `label` is the reference copy; callers render t("arcade.eidolon.growth.<tier>"). */
export function growthTier(level: number): { tier: "hatchling" | "adult" | "elder"; scale: number; label: string } {
  if (level >= 20) return { tier: "elder", scale: 1.12, label: "Elder" };
  if (level >= 5) return { tier: "adult", scale: 1, label: "Adult" };
  return { tier: "hatchling", scale: 0.86, label: "Hatchling" };
}

/* ---------- the layered familiar sprite ---------- */
const SMUDGES: Array<[number, number, number, number]> = [[74, 150, 11, 7], [122, 156, 9, 6], [98, 169, 8, 5], [62, 131, 7, 5], [134, 139, 8, 6], [101, 126, 6, 4], [86, 159, 7, 5]];

export function Familiar({ vis, speciesId, kind, petIconUrl, squish }: {
  vis: Visual; speciesId: string | null; kind: "species" | "pet"; petIconUrl: string | null; squish: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("arcade");
  const Body = speciesVisual(speciesId).Body;
  const { skin, dark, eye, glow, dirtI, hungerI, sadI, tiredI, sickI, angryI, happyI, asleep, dead, anim } = vis;
  const isPet = kind === "pet" && !!petIconUrl;
  const filter = `drop-shadow(0 0 14px ${glow}) saturate(${(1 - dirtI * 0.45).toFixed(2)}) brightness(${(1 - dirtI * 0.12).toFixed(2)})`;
  // Pets can't show the drawn face, so push mood through extra image filters:
  // green/sick hue-rotate, grayscale when dead, desaturate as Spirit drops.
  const petFilter = isPet
    ? `saturate(${dead ? 0 : (1 - sadI * 0.4 + happyI * 0.15).toFixed(2)}) brightness(${(1 - dirtI * 0.18).toFixed(2)})${sickI > 0.3 ? ` hue-rotate(${Math.round(sickI * 55)}deg)` : ""}`
    : undefined;

  let eyeStyle = "normal";
  if (asleep) eyeStyle = "closed";
  else if (sickI > 0.45) eyeStyle = "sick";
  else if (tiredI > 0.5) eyeStyle = "tired";
  else if (sadI > 0.55) eyeStyle = "sad";
  else if (angryI > 0.4) eyeStyle = "angry";

  let mouthStyle = "neutral";
  if (asleep) mouthStyle = "sleep";
  else if (sickI > 0.5) mouthStyle = "sick";
  else if (hungerI > 0.45) mouthStyle = "hungry";
  else if (angryI > 0.4) mouthStyle = "angry";
  else if (sadI > 0.5) mouthStyle = "sad";
  else if (happyI > 0.5) mouthStyle = "happy";

  const Eye = (cx: number): React.JSX.Element => {
    if (eyeStyle === "closed") return <path className="lid" d={`M${cx - 10} 116 q10 8 20 0`} />;
    if (eyeStyle === "sick") return <path className="swirl" d={`M${cx - 6} 120 m0 0 a7 7 0 1 1 -1 -6`} />;
    if (eyeStyle === "tired") return (
      <g>
        <path className="lid-arc" d={`M${cx - 11} 114 Q${cx} 110 ${cx + 11} 114`} />
        <path className="eye-slit" d={`M${cx - 9} 117 Q${cx} 121 ${cx + 9} 117`} />
        <path className="bag" d={`M${cx - 8} 126 Q${cx} 129 ${cx + 8} 126`} />
      </g>
    );
    if (eyeStyle === "angry") return (
      <g><circle className="eye" cx={cx} cy="120" r="9" /><circle className="pupil" cx={cx} cy="121" r="4" /></g>
    );
    const py = eyeStyle === "sad" ? 124 : 118;
    return (
      <g>
        <circle className="eye" cx={cx} cy="116" r="11" />
        <circle className="pupil" cx={cx} cy={py} r="5" />
        {eyeStyle === "normal" && <circle className="glint" cx={cx - 3} cy="113" r="2.4" />}
      </g>
    );
  };

  return (
    <svg
      className={`familiar familiar--${anim} familiar--${speciesId ?? "pet"} ${squish ? "familiar--squish" : ""} ${isPet ? "familiar--petimg" : ""}`}
      viewBox="0 0 200 210"
      style={sv({ "--skin": skin, "--dark": dark, "--eye": eye, filter, opacity: dead ? 0.78 : 1 })}
      role="img" aria-label={t("arcade.eidolon.familiarAria")}
    >
      <ellipse className="shadow" cx="100" cy="192" rx="46" ry="9" />
      {isPet ? (
        <image href={petIconUrl!} x="46" y="50" width="108" height="120" preserveAspectRatio="xMidYMid meet" style={{ filter: petFilter }} />
      ) : (
        <Body />
      )}

      {/* accumulating dirt — opacity scales with how filthy it is. Always
          rendered (opacity 0 when clean) with a stable key so the CSS
          opacity transition animates instead of the element mount/unmounting. */}
      {!dead && SMUDGES.map(([x, y, rx, ry], i) => {
        const op = clamp((dirtI - (i / SMUDGES.length) * 0.55) * 2.2, 0, 0.85);
        return <ellipse key={`smudge-${i}`} className="smudge" cx={x} cy={y} rx={rx} ry={ry} style={{ opacity: op }} />;
      })}
      {!dead && dirtI > 0.5 && <path className="stink" style={{ opacity: (dirtI - 0.5) * 2 }} d="M150 70 q5 -6 0 -12 q-5 -6 0 -12" />}

      {dead ? (
        !isPet ? (
          <g>
            <path className="xeye" d="M72 110 l16 16 M88 110 l-16 16" /><path className="xeye" d="M112 110 l16 16 M128 110 l-16 16" />
            <ellipse className="mouth--o" cx="100" cy="148" rx="6" ry="8" />
          </g>
        ) : null
      ) : (
        <>
          {/* drawn face — species only (a pet's PNG already has its own face) */}
          {!isPet && eyeStyle !== "closed" && eyeStyle !== "sick" && angryI > 0.4 && (
            <g><path className="brow brow--hard" style={{ opacity: clamp(angryI * 1.4, 0, 1) }} d="M68 102 L92 112" /><path className="brow brow--hard" style={{ opacity: clamp(angryI * 1.4, 0, 1) }} d="M132 102 L108 112" /></g>
          )}
          {!isPet && eyeStyle === "sad" && (
            <g><path className="brow" d="M70 104 Q80 110 90 108" /><path className="brow" d="M130 104 Q120 110 110 108" /></g>
          )}
          {!isPet && Eye(80)}{!isPet && Eye(120)}
          {!isPet && mouthStyle === "happy" && <path className="mouth" d="M86 140 Q100 156 114 140" />}
          {!isPet && mouthStyle === "neutral" && <path className="mouth" d="M90 146 Q100 149 110 146" />}
          {!isPet && mouthStyle === "sad" && <path className="mouth" d="M86 150 Q100 140 114 150" />}
          {!isPet && mouthStyle === "angry" && <path className="mouth mouth--grit" d="M84 146 L116 146 M90 142 L92 150 M100 142 L100 150 M110 142 L108 150" />}
          {!isPet && mouthStyle === "hungry" && <path className="mouth mouth--s" d="M84 145 q7 -7 14 0 q7 7 14 0" />}
          {!isPet && mouthStyle === "sick" && (<><path className="mouth mouth--wave" d="M84 146 q8 -6 16 0 q8 6 16 0" /><path className="tongue" d="M104 148 q6 10 0 16 q-6 -6 0 -16 z" /></>)}
          {!isPet && mouthStyle === "sleep" && <ellipse className="mouth--o" cx="100" cy="146" rx="5" ry="7" />}

          {/* ambient FX — both species and pets (mood read at the periphery) */}
          {!asleep && hungerI > 0.3 && (
            <g style={{ opacity: clamp((hungerI - 0.3) * 1.8, 0, 1) }}>
              <g className="drool"><path className="droolP" d="M112 150 q-4 14 0 20 q4 -6 0 -20 z" /></g>
              <g className="rumble"><path className="rumbleP" d="M60 152 q4 -5 8 0 q4 5 8 0" /></g>
              <text className="ellip" x="140" y="100">···</text>
            </g>
          )}
          {!asleep && sadI > 0.45 && eyeStyle !== "sick" && (
            <g style={{ opacity: clamp((sadI - 0.45) * 2, 0, 1) }}>
              <g className="tear tear--l"><path className="tearP" d="M74 130 q-5 9 0 13 q5 -4 0 -13 z" /></g>
              <g className="tear tear--r"><path className="tearP" d="M126 130 q-5 9 0 13 q5 -4 0 -13 z" /></g>
            </g>
          )}
          {!asleep && sickI > 0.4 && (
            <g style={{ opacity: clamp(sickI, 0, 1) }}>
              <g className="sweat"><path className="sweatP" d="M146 102 q-5 9 0 13 q5 -4 0 -13 z" /></g>
              <g className="nausea nausea--1"><circle className="bubble" cx="150" cy="120" r="4" /></g>
              <g className="nausea nausea--2"><circle className="bubble" cx="158" cy="110" r="3" /></g>
            </g>
          )}
          {!asleep && angryI > 0.4 && (
            <g className="anger" style={{ opacity: clamp(angryI * 1.3, 0, 1) }}>
              <path className="angerP" d="M150 86 h10 M155 81 v10" /><path className="angerP" d="M158 92 h8 M162 88 v8" />
            </g>
          )}
          {!asleep && happyI > 0.45 && (
            <g style={{ opacity: clamp((happyI - 0.45) * 2, 0, 1) }}>
              {!isPet && <ellipse className="blush" cx="68" cy="135" rx="8" ry="5" />}
              {!isPet && <ellipse className="blush" cx="132" cy="135" rx="8" ry="5" />}
              <g className="spark spark--1"><path className="sparkP" d="M150 78 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 z" /></g>
              <g className="spark spark--2"><path className="sparkP" d="M44 96 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 z" /></g>
            </g>
          )}
          {asleep && (<g className="zzz"><text className="z z1" x="130" y="92">z</text><text className="z z2" x="142" y="78">Z</text><text className="z z3" x="156" y="62">Z</text></g>)}
        </>
      )}
    </svg>
  );
}

/* ---------- egg ---------- */
export function Egg({ crack = 0, shell = "#241a3a", accent = "#f0d785", noRock = false }: {
  crack?: number; shell?: string; accent?: string; noRock?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("arcade");
  return (
    <svg className={`egg egg--c${crack} ${noRock ? "egg--still" : ""}`} viewBox="0 0 200 210" role="img" aria-label={t("arcade.eidolon.eggAria")}>
      <ellipse className="egg-shadow" cx="100" cy="192" rx="42" ry="8" />
      <path className="egg-body" style={{ fill: shell }} d="M100 28 C60 28 44 100 44 138 C44 174 70 192 100 192 C130 192 156 174 156 138 C156 100 140 28 100 28 Z" />
      <path className="egg-band" d="M50 120 Q100 138 150 120 L150 134 Q100 152 50 134 Z" />
      <circle className="egg-rune" style={{ stroke: accent }} cx="100" cy="100" r="20" />
      <path className="egg-glyph" style={{ stroke: accent }} d="M100 86 L100 114 M88 100 L112 100 M92 92 L108 108 M108 92 L92 108" />
      {crack >= 1 && <path className="crack" d="M100 30 L94 56 L104 70 L96 96" />}
      {crack >= 2 && <path className="crack" d="M156 120 L138 128 L150 142 L132 150" />}
      {crack >= 3 && <path className="crack" d="M44 130 L64 138 L52 152 L70 162" />}
    </svg>
  );
}

/* ---------- ambient + chrome bits ---------- */
export function Ooze({ x, y, delay }: { x: number; y: number; delay: number }): React.JSX.Element {
  return (
    <svg className="ooze" viewBox="0 0 60 36" style={{ left: x + "%", top: y + "%", animationDelay: delay + "ms" }}>
      <ellipse className="ooze-pool" cx="30" cy="26" rx="24" ry="9" />
      <circle className="ooze-bub bub1" cx="22" cy="20" r="4" /><circle className="ooze-bub bub2" cx="36" cy="22" r="3" />
      <path className="ooze-stink" d="M30 12 q4 -5 0 -10" />
    </svg>
  );
}
export function Sun(): React.JSX.Element {
  return (
    <svg viewBox="0 0 40 40" className="celest-svg sun">
      <g className="sun-rays" stroke="#f0c45a" strokeWidth="2" strokeLinecap="round">
        <path d="M20 3 v5" /><path d="M20 32 v5" /><path d="M3 20 h5" /><path d="M32 20 h5" />
        <path d="M8 8 l3.5 3.5" /><path d="M28.5 28.5 l3.5 3.5" /><path d="M8 32 l3.5 -3.5" /><path d="M28.5 11.5 l3.5 -3.5" />
      </g>
      <circle cx="20" cy="20" r="8.5" fill="#f3cf6e" />
    </svg>
  );
}
export function Moon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 40 40" className="celest-svg moon">
      <path d="M27 9 a12 12 0 1 0 6 19 a10 10 0 0 1 -6 -19 z" fill="#cdd6ff" />
      <circle cx="16" cy="16" r="1.6" fill="#9aa6e0" opacity=".7" /><circle cx="20" cy="24" r="1.1" fill="#9aa6e0" opacity=".7" />
    </svg>
  );
}
export function Gauge({ icon, label, value, danger }: { icon: string; label: string; value: number; danger: boolean }): React.JSX.Element {
  const v = clamp(value);
  return (
    <div className={`gauge ${danger ? "gauge--danger" : ""}`}>
      <div className="gauge-glyph" dangerouslySetInnerHTML={{ __html: icon }} />
      <div className="gauge-track"><div className="gauge-fill" style={{ width: v + "%" }} /><div className="gauge-name">{label}</div></div>
    </div>
  );
}
export function Action({ glyph, name, onClick, disabled, on }: { glyph: string; name: string; onClick: () => void; disabled?: boolean; on?: boolean }): React.JSX.Element {
  return (
    <button className={`act ${on ? "act--on" : ""}`} onClick={onClick} disabled={disabled} aria-label={name}>
      <span className="act-disc"><span className="act-glyph" dangerouslySetInnerHTML={{ __html: glyph }} /></span>
      <span className="act-name">{name}</span>
    </button>
  );
}

export const G: Record<string, string> = {
  feed: `<svg viewBox="0 0 24 24"><path d="M7 2v8a3 3 0 0 0 6 0V2M10 2v20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M17 2c2 1 2 6 0 8 0 4 0 9 0 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  play: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.2" opacity=".7"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/></svg>`,
  clean: `<svg viewBox="0 0 24 24"><path d="M14 3l4 4-8 8-4 1 1-4 7-9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M5 21c2-3 5-3 7 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  cure: `<svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-4 9a2 2 0 0 0 2 3h8a2 2 0 0 0 2-3l-4-9V3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 14h6" stroke="currentColor" stroke-width="1.4"/></svg>`,
  rest: `<svg viewBox="0 0 24 24"><path d="M20 14a8 8 0 1 1-9-11 7 7 0 0 0 9 11z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  toy: `<svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="7.5" r="1.5" fill="currentColor"/><path d="M12 15v3.5M10.4 21h3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
};
export const GAUGE_ICON: Record<string, string> = {
  satiety: `<svg viewBox="0 0 24 24"><path d="M7 3v7a3 3 0 0 0 6 0V3M10 3v18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  joy: `<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-9-9C1 8 4 4 8 5c2 .5 3 2 4 3 1-1 2-2.5 4-3 4-1 7 3 5 7-2 4.5-9 9-9 9z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  vigor: `<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  hygiene: `<svg viewBox="0 0 24 24"><path d="M12 3C8 8 6 11 6 14a6 6 0 0 0 12 0c0-3-2-6-6-11z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  health: `<svg viewBox="0 0 24 24"><path d="M12 21S4 14 4 8.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 8 2.5C20 14 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
};

export function fmtClock(t: number): string {
  const h = Math.floor(t) % 24; const m = Math.floor((t - Math.floor(t)) * 60);
  // i18n.t (not a hook): this is a plain helper. Callers render it from
  // ticking state, so a language flip is picked up within a second.
  const ap = h < 12 ? i18n.t("arcade:arcade.eidolon.clock.am") : i18n.t("arcade:arcade.eidolon.clock.pm");
  let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ap}`;
}
export function celestial(t: number, night: boolean): { left: number; top: number } {
  let prog: number;
  if (!night) prog = (t - NIGHT_END) / 12;
  else { const nh = t >= NIGHT_START ? t - NIGHT_START : t + (24 - NIGHT_START); prog = nh / 12; }
  prog = Math.max(0, Math.min(1, prog));
  return { left: 8 + prog * 84, top: 70 - Math.sin(prog * Math.PI) * 44 };
}

/* =========================================================================
   STYLES — scoped under .eidolon-root. The gothic palette vars are mapped
   onto The Spire's `--keep-*` theme tokens (RGB triples), so device chrome
   adapts to the active palette + custom colors. The diegetic `.screen`
   interior (night sky, creature art, FX) stays as authored. Danger red is
   kept fixed for legibility across light/dark themes. The standalone's
   Google-fonts @import is dropped (no network fetch): body copy inherits
   `--keep-font-family`, and the display faces (Pirata One / Cinzel) lead
   their stacks but degrade to a generic serif when the user's system
   lacks them — an intentional consolidation, so the title / nameplate /
   sleeping Zzz may render in serif rather than the original Pirata One.
   ========================================================================= */
export const EIDOLON_CSS = `
.eidolon-root{
  --void: rgb(var(--keep-bg, 8 6 13));
  --obsidian: rgb(var(--keep-panel, 22 16 32));
  --obsidian-2: rgb(var(--keep-bg, 15 11 24));
  --brass: rgb(var(--keep-accent, 200 164 76));
  --brass-d: rgb(var(--keep-border, 138 111 41));
  --brass-l: rgb(var(--keep-action, 240 215 133));
  --bone: rgb(var(--keep-text, 233 225 207));
  --ash: rgb(var(--keep-muted, 154 147 168));
  --blood: #c0394a;
  --edge: rgb(var(--keep-border, 138 111 41) / .55);
  position:relative; width:100%; box-sizing:border-box; display:flex; align-items:center; justify-content:center;
  font-family: var(--keep-font-family, 'EB Garamond', Georgia, serif); color:var(--bone);}
.eidolon-root *{box-sizing:border-box;}
.device{position:relative; width:100%; background:linear-gradient(180deg, rgb(var(--keep-panel, 34 26 48)) 0%, rgb(var(--keep-bg, 22 16 32)) 100%); border-radius:26px 26px 30px 30px; border:2px solid var(--brass-d); box-shadow:0 0 0 4px rgb(var(--keep-bg, 12 8 20)), 0 0 0 6px var(--brass-d), 0 18px 44px rgba(0,0,0,.5), inset 0 2px 12px rgb(var(--keep-accent, 240 215 133) / .12); padding:18px 20px 22px;}
.rivet{position:absolute; width:9px; height:9px; border-radius:50%; background:radial-gradient(circle at 35% 30%, var(--brass-l), var(--brass-d)); box-shadow:0 1px 2px rgba(0,0,0,.6);}
.r-tl{top:12px;left:12px} .r-tr{top:12px;right:12px} .r-bl{bottom:14px;left:16px} .r-br{bottom:14px;right:16px}
.crest{position:relative; text-align:center; margin:0 0 8px;}
.title{font-family:'Pirata One','Cinzel','EB Garamond',serif; font-size:30px; letter-spacing:5px; margin:0; line-height:1; color:var(--brass-l); text-shadow:0 0 14px rgb(var(--keep-accent, 200 164 76) / .45);}
.subtitle{font-family:'Cinzel','EB Garamond',serif; font-size:8.5px; letter-spacing:3px; text-transform:uppercase; color:var(--ash); margin:4px 0 0;}
.crest-wing{position:absolute; top:14px; width:48px; height:2px; background:linear-gradient(90deg,transparent,var(--brass-d));}
.crest-wing.left{left:6px} .crest-wing.right{right:6px; background:linear-gradient(270deg,transparent,var(--brass-d));}
.screen{position:relative; height:300px; border-radius:18px; overflow:hidden; background:radial-gradient(120% 100% at 50% 0%, #1c1136 0%, #0a0716 60%, #05030c 100%); border:2px solid #060410; box-shadow:inset 0 0 50px rgba(0,0,0,.85), inset 0 0 22px var(--screen-glow), 0 0 0 4px rgb(var(--keep-bg, 26 19 38)), 0 0 0 5px var(--brass-d), 0 10px 24px rgba(0,0,0,.45); transition:filter .6s ease; touch-action:none; user-select:none;}
.screen--dim{filter:brightness(.55) saturate(.75);}
.daylight{position:absolute; inset:0; pointer-events:none; opacity:0; transition:opacity 1.6s ease; background:radial-gradient(90% 60% at 50% -10%, rgba(220,150,110,.22), transparent 55%), linear-gradient(180deg, rgba(140,110,160,.18), transparent 50%);}
.screen.is-day .daylight{opacity:1;} .screen.is-night .daylight{opacity:0;}
.vignette{position:absolute; inset:0; pointer-events:none; background:radial-gradient(120% 90% at 50% 45%, transparent 50%, rgba(0,0,0,.7) 100%);}
.scanlines{position:absolute; inset:0; pointer-events:none; opacity:.16; mix-blend-mode:overlay; background:repeating-linear-gradient(0deg, rgba(255,255,255,.5) 0 1px, transparent 1px 3px);}
.aura{position:absolute; left:50%; top:54%; width:220px; height:220px; transform:translate(-50%,-50%); background:radial-gradient(circle, var(--aura) 0%, transparent 65%); pointer-events:none; transition:background .6s ease; animation:auraPulse 5s ease-in-out infinite;}
@keyframes auraPulse{0%,100%{transform:translate(-50%,-50%) scale(1)}50%{transform:translate(-50%,-50%) scale(1.12)}}
.starfield{position:absolute; inset:0; pointer-events:none; transition:opacity 1.6s ease;}
.screen.is-day .starfield{opacity:.22;} .screen.is-night .starfield{opacity:1;}
.star{position:absolute; border-radius:50%; background:#fff; box-shadow:0 0 4px #cdbfff; animation:tw 3.5s ease-in-out infinite;}
@keyframes tw{0%,100%{opacity:.2}50%{opacity:1}}
.celestial{position:absolute; width:32px; height:32px; z-index:2; pointer-events:none; transition:left 1.2s linear, top 1.2s linear;}
.celest-svg{width:100%; height:100%;} .celest-svg.sun{filter:drop-shadow(0 0 10px rgba(240,200,90,.7));} .celest-svg.moon{filter:drop-shadow(0 0 8px rgba(160,170,255,.6));}
.sun-rays{animation:sunspin 24s linear infinite; transform-origin:20px 20px;} @keyframes sunspin{to{transform:rotate(360deg)}}
.hud{position:absolute; top:8px; left:10px; z-index:6; display:flex; align-items:center; gap:6px; font-family:'Cinzel','EB Garamond',serif; font-size:11px; letter-spacing:1px; color:#e9e1cf; background:rgba(6,4,12,.5); padding:3px 9px; border-radius:12px; border:1px solid rgba(200,164,76,.25);}
.hud .ph{font-size:12px; line-height:1;}
.stage-pet{position:absolute; left:50%; top:50%; width:190px; height:200px; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:3; touch-action:none; transform:translate(-50%,-50%); transition:transform .8s ease, filter .8s ease;}
.stage-pet.is-elder{filter:drop-shadow(0 0 11px rgb(var(--keep-accent, 200 164 76) / .5));}
/* rare prismatic variant — a shimmering rainbow aura (overrides the elder glow
   while it cycles; a prismatic familiar is the rarer flex). */
.stage-pet.is-prismatic{animation:prismGlow 4.5s linear infinite;}
@keyframes prismGlow{0%,100%{filter:drop-shadow(0 0 10px rgba(255,90,90,.6))}25%{filter:drop-shadow(0 0 10px rgba(245,225,90,.6))}50%{filter:drop-shadow(0 0 10px rgba(90,235,140,.6))}75%{filter:drop-shadow(0 0 10px rgba(110,150,255,.6))}}
.pet-inner{width:100%; height:100%; transform-origin:center bottom; display:flex; align-items:center; justify-content:center;}
.pet-inner.is-chomp{animation:chomp .36s ease;} @keyframes chomp{0%,100%{transform:scaleY(1)}45%{transform:scaleY(.82) scaleX(1.12)}}
.pet-inner.is-excited{animation:excited .28s ease;} @keyframes excited{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
.pet-inner.is-purr{animation:purr .28s ease;} @keyframes purr{0%,100%{transform:rotate(0)}30%{transform:rotate(-2deg)}70%{transform:rotate(2deg)}}
.pet-inner.is-pounceL{animation:pounceL .36s ease;} @keyframes pounceL{0%,100%{transform:translateX(0) rotate(0)}45%{transform:translateX(-18px) rotate(-7deg)}}
.pet-inner.is-pounceR{animation:pounceR .36s ease;} @keyframes pounceR{0%,100%{transform:translateX(0) rotate(0)}45%{transform:translateX(18px) rotate(7deg)}}
.pet-inner.is-cough{animation:cough .5s ease;} @keyframes cough{0%,100%{transform:translateY(0)}25%{transform:translateY(2px) scaleY(.96)}45%{transform:translateY(-3px) rotate(-1deg)}65%{transform:translateY(1px)}}
.pet-inner.is-levelup{animation:levelup .6s ease;} @keyframes levelup{0%,100%{transform:scale(1)}30%{transform:scale(1.12) translateY(-6px)}60%{transform:scale(.98)}}
.familiar{width:100%; height:100%; transform-origin:center bottom; will-change:transform; transition:filter .5s ease;}
.familiar .skin{fill:var(--skin); transition:fill .6s ease;} .familiar .skin-d{fill:var(--dark); transition:fill .6s ease;} .familiar .body{stroke:rgba(0,0,0,.25); stroke-width:1;}
.familiar .belly{fill:rgba(255,255,255,.10);} .familiar .shadow{fill:rgba(0,0,0,.45);}
.familiar .eye{fill:var(--eye);} .familiar .pupil{fill:#1a0f2a;} .familiar .glint{fill:#fff;}
.familiar .smudge{fill:#241608; transition:opacity .5s ease;}
.familiar .wing{opacity:.9;}
.familiar .strut{fill:none; stroke:rgba(0,0,0,.28); stroke-width:1.6; stroke-linecap:round;}
.familiar .plate{fill:none; stroke:rgba(255,255,255,.16); stroke-width:2;}
.familiar .crackline{fill:none; stroke:rgba(0,0,0,.35); stroke-width:1.6; stroke-linecap:round;}
.familiar .fang{fill:#efeae0;}
.familiar .tendril{opacity:.85;}
.familiar .gloss{fill:rgba(255,255,255,.28);}
.familiar .bub-in{fill:rgba(255,255,255,.16);}
.familiar .stink{fill:none; stroke:rgba(120,150,60,.6); stroke-width:2; stroke-linecap:round; animation:stk 2.4s ease-in-out infinite;}
.familiar .blush{fill:rgba(255,120,160,.35);}
.familiar .mouth{fill:none; stroke:#1a0f2a; stroke-width:4; stroke-linecap:round;} .familiar .mouth--grit{stroke-width:3;} .familiar .mouth--s{stroke-width:3.4;} .familiar .mouth--o{fill:#1a0f2a;}
.familiar .brow{fill:none; stroke:#1a0f2a; stroke-width:3.4; stroke-linecap:round;} .familiar .brow--hard{stroke-width:4;}
.familiar .lid{fill:none; stroke:#1a0f2a; stroke-width:3.6; stroke-linecap:round;}
.familiar .lid-arc{fill:none; stroke:#1a0f2a; stroke-width:3.2; stroke-linecap:round;}
.familiar .eye-slit{fill:none; stroke:#1a0f2a; stroke-width:3; stroke-linecap:round;}
.familiar .bag{fill:none; stroke:#1a0f2a; stroke-width:2; stroke-linecap:round; opacity:.45;}
.familiar .tongue{fill:#d96a8a;} .familiar .xeye{stroke:#1a0f2a; stroke-width:4; stroke-linecap:round; fill:none;} .familiar .swirl{fill:none; stroke:#1a0f2a; stroke-width:3; stroke-linecap:round;}
.familiar .tearP{fill:#8fd0ff;} .familiar .droolP{fill:#bfe5c0; opacity:.85;} .familiar .sweatP{fill:#cfeaff;} .familiar .bubble{fill:#bfe7a8; opacity:.8;}
.familiar .angerP{stroke:var(--blood); stroke-width:3; stroke-linecap:round;} .familiar .sparkP{fill:var(--brass-l);}
.familiar .ellip{fill:#1a0f2a; font:600 20px Cinzel, serif;} .familiar .rumbleP{fill:none; stroke:rgba(0,0,0,.3); stroke-width:2;}
.familiar .z{fill:#cdbfff; font:600 18px 'Pirata One','Cinzel',serif;} .familiar .z2{font-size:22px} .familiar .z3{font-size:26px}
.familiar--petimg image{ }
.familiar--squish{animation:squish .32s ease !important;} @keyframes squish{0%,100%{transform:scaleY(1) scaleX(1)}40%{transform:scaleY(.86) scaleX(1.1)}}
.familiar--bob{animation:bob 2.6s ease-in-out infinite;} @keyframes bob{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-9px) rotate(.5deg)}}
.familiar--slump{animation:slump 4s ease-in-out infinite;} @keyframes slump{0%,100%{transform:translateY(4px) rotate(-2deg)}50%{transform:translateY(7px) rotate(2deg)}}
.familiar--shake{animation:shk .16s linear infinite;} @keyframes shk{0%{transform:translate(-2px,0) rotate(-1deg)}50%{transform:translate(2px,0) rotate(1deg)}100%{transform:translate(-2px,0) rotate(-1deg)}}
.familiar--droop{animation:droop 3s ease-in-out infinite;} @keyframes droop{0%,100%{transform:translateY(2px) scaleY(.99)}50%{transform:translateY(6px) scaleY(.96)}}
.familiar--woozy{animation:woozy 2.4s ease-in-out infinite;} @keyframes woozy{0%,100%{transform:rotate(-4deg) scale(1)}50%{transform:rotate(4deg) scale(1.03)}}
.familiar--sleep{animation:sleepb 3.4s ease-in-out infinite;} @keyframes sleepb{0%,100%{transform:scale(1) translateY(2px)}50%{transform:scale(1.04) translateY(5px)}}
.familiar--ghost{animation:ghost 4s ease-in-out infinite;} @keyframes ghost{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
.tear{animation:tearfall 1.6s ease-in infinite;} .tear--r{animation-delay:.7s} @keyframes tearfall{0%{transform:translateY(0);opacity:0}20%{opacity:1}100%{transform:translateY(34px);opacity:0}}
.drool{animation:dripd 2.4s ease-in infinite;} @keyframes dripd{0%{transform:scaleY(.4);opacity:.4}60%{transform:scaleY(1);opacity:.9}100%{transform:scaleY(1.3) translateY(10px);opacity:0}}
.sweat{animation:tearfall 1.8s ease-in infinite .4s;}
.anger{animation:angp 1s ease-in-out infinite;} @keyframes angp{0%,100%{opacity:.4;transform:scale(.9)}50%{opacity:1;transform:scale(1.15)}}
.spark{animation:spk 2.4s ease-in-out infinite; transform-origin:center;} .spark--2{animation-delay:1.1s} @keyframes spk{0%,100%{opacity:0;transform:scale(.5) rotate(0)}50%{opacity:1;transform:scale(1) rotate(40deg)}}
.nausea{animation:nau 2s ease-in infinite;} .nausea--2{animation-delay:.6s} @keyframes nau{0%{transform:translateY(8px) scale(.5);opacity:0}50%{opacity:.9}100%{transform:translateY(-14px) scale(1);opacity:0}}
@keyframes stk{0%,100%{opacity:.2;transform:translateY(0)}50%{opacity:.7;transform:translateY(-6px)}}
.zzz .z{opacity:0; animation:zfloat 3s ease-in-out infinite;} .z2{animation-delay:.5s !important} .z3{animation-delay:1s !important}
@keyframes zfloat{0%{opacity:0;transform:translate(0,6px)}40%{opacity:1}100%{opacity:0;transform:translate(8px,-14px)}}
.swirl{animation:sw 3s linear infinite; transform-origin:center;} @keyframes sw{to{transform:rotate(360deg)}}
.rumble{animation:angp 1.2s ease-in-out infinite;}
.egg{width:80%; height:90%; transform-origin:center bottom; animation:eggrock 3s ease-in-out infinite;} @keyframes eggrock{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
.egg--still{animation:eggrock 5s ease-in-out infinite;}
.select-wrap{position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:3; gap:4px; padding:12px 8px; overflow-y:auto;}
.select-title{font-family:'Cinzel','EB Garamond',serif; font-size:10px; letter-spacing:2px; text-transform:uppercase; color:var(--ash);}
.select-grid{display:flex; flex-wrap:wrap; justify-content:center; gap:2px 8px; padding:2px;}
.egg-choice{display:flex; flex-direction:column; align-items:center; gap:0; background:none; border:none; cursor:pointer; padding:2px; border-radius:12px; width:80px; transition:transform .15s ease, background .15s ease;}
.egg-choice-egg{width:48px; height:52px; display:flex; align-items:center; justify-content:center; filter:drop-shadow(0 0 8px rgba(0,0,0,.5));}
.egg-choice .egg{width:100%; height:100%;}
.egg-choice-pet{width:48px; height:52px; display:flex; align-items:center; justify-content:center; border-radius:14px; border:1px dashed var(--brass-d);}
.egg-choice-pet img{max-width:80%; max-height:80%; object-fit:contain;}
.egg-label{max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:'Cinzel','EB Garamond',serif; font-size:9px; letter-spacing:1.5px; text-transform:uppercase; color:var(--ash); transition:color .15s ease;}
.egg-tag{max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:'EB Garamond',serif; font-size:8.5px; font-style:italic; color:var(--ash); opacity:.65; letter-spacing:.5px;}
.egg-choice:hover{transform:translateY(-3px); background:rgb(var(--keep-accent, 240 215 133) / .08);}
.egg-choice:hover .egg-label{color:var(--brass-l);}
.egg-choice:hover .egg-choice-egg{filter:drop-shadow(0 0 12px rgb(var(--keep-accent, 240 215 133) / .5));}
.egg-shadow{fill:rgba(0,0,0,.45);} .egg-body{fill:#241a3a; stroke:var(--brass-d); stroke-width:2;} .egg-band{fill:var(--brass-d); opacity:.85;}
.egg-rune{fill:none; stroke:var(--brass-l); stroke-width:2; opacity:.7; animation:runeglow 2.4s ease-in-out infinite;} @keyframes runeglow{0%,100%{opacity:.4}50%{opacity:1}}
.egg-glyph{stroke:var(--brass-l); stroke-width:2; fill:none; opacity:.7;} .crack{stroke:#06030c; stroke-width:2.4; fill:none; stroke-linejoin:round;}
.ooze{position:absolute; width:46px; height:28px; z-index:2; animation:oozein .4s ease;} @keyframes oozein{from{transform:scale(0)}to{transform:scale(1)}}
.ooze-pool{fill:#2c1c10; opacity:.9;} .ooze-bub{fill:#43301a; animation:bubr 1.8s ease-in-out infinite;} .bub2{animation-delay:.6s} @keyframes bubr{0%,100%{transform:translateY(0);opacity:.7}50%{transform:translateY(-3px);opacity:1}}
.ooze-stink{stroke:rgba(120,150,60,.5); stroke-width:1.5; fill:none; animation:stk 2.4s ease-in-out infinite;}
.float{position:absolute; bottom:44px; transform:translateX(-50%); z-index:8; font-family:'Cinzel','EB Garamond',serif; font-size:14px; font-weight:600; letter-spacing:1px; pointer-events:none; animation:flup 1.4s ease-out forwards; text-shadow:0 1px 4px #000;}
.float--good{color:var(--brass-l)} .float--bad{color:#ff8a8a} .float--neutral{color:#bfb6ff}
@keyframes flup{0%{opacity:0;transform:translate(-50%,8px)}20%{opacity:1}100%{opacity:0;transform:translate(-50%,-42px)}}
.readout{position:absolute; bottom:0; left:0; right:0; z-index:9; padding:7px 12px; text-align:center; font-size:13.5px; font-style:italic; background:linear-gradient(0deg, rgba(6,4,12,.92), transparent); color:#e9e1cf; pointer-events:none;}
.readout b{font-style:normal; color:#f0d785;} .readout i{color:#9a93a8; font-size:12px;}
.nameplate{display:flex; align-items:baseline; justify-content:space-between; margin:12px 4px 9px; padding-bottom:8px; border-bottom:1px solid var(--edge);}
.np-name{font-family:'Pirata One','Cinzel','EB Garamond',serif; font-size:20px; color:var(--brass-l); letter-spacing:2px;}
.np-meta{font-family:'Cinzel','EB Garamond',serif; font-size:9.5px; letter-spacing:2px; text-transform:uppercase; color:var(--ash);}
.np-warn{color:var(--blood); font-style:normal;}
.gauges{display:flex; flex-direction:column; gap:6px; margin-bottom:14px;}
.gauge{display:flex; align-items:center; gap:9px;}
.gauge-glyph{width:17px; height:17px; color:var(--brass); flex:none; opacity:.9;} .gauge-glyph svg{width:100%; height:100%;}
.gauge-track{position:relative; flex:1; height:15px; border-radius:8px; background:rgb(var(--keep-bg, 12 8 20) / .85); border:1px solid var(--edge); overflow:hidden; box-shadow:inset 0 1px 3px rgba(0,0,0,.5);}
.gauge-fill{position:absolute; inset:1px; width:0; border-radius:7px; background:linear-gradient(90deg, var(--brass-d), var(--brass) 60%, var(--brass-l)); box-shadow:0 0 8px rgb(var(--keep-accent, 200 164 76) / .5); transition:width .5s cubic-bezier(.4,0,.2,1);}
.gauge-name{position:absolute; left:9px; top:50%; transform:translateY(-50%); font-family:'Cinzel','EB Garamond',serif; font-size:8.5px; letter-spacing:2px; text-transform:uppercase; color:rgb(var(--keep-text, 233 225 207)); font-weight:700; text-shadow:0 1px 2px rgb(var(--keep-bg, 6 4 12) / .9); z-index:2;}
.gauge--danger .gauge-fill{background:linear-gradient(90deg,#5e1620,var(--blood) 70%,#e0586e); box-shadow:0 0 10px rgba(192,57,74,.7); animation:warn 1s ease-in-out infinite;}
.gauge--danger .gauge-glyph{color:var(--blood); animation:warn 1s ease-in-out infinite;} @keyframes warn{0%,100%{opacity:1}50%{opacity:.5}}
.controls{display:flex; justify-content:space-between; gap:8px;}
.act{flex:1; display:flex; flex-direction:column; align-items:center; gap:5px; background:none; border:none; cursor:pointer; padding:0; font-family:inherit;}
.act-disc{width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; background:radial-gradient(circle at 35% 28%, rgb(var(--keep-panel, 58 45 18)), rgb(var(--keep-bg, 26 18 8))); border:2px solid var(--brass-d); box-shadow:0 4px 0 rgb(var(--keep-border, 12 8 20) / .7), inset 0 0 8px rgb(var(--keep-accent, 240 215 133) / .18); transition:transform .12s ease, box-shadow .12s ease, border-color .12s ease;}
.act-glyph{width:22px; height:22px; color:var(--brass-l); display:block;} .act-glyph svg{width:100%; height:100%;}
.act-name{font-family:'Cinzel','EB Garamond',serif; font-size:8.5px; letter-spacing:1.5px; text-transform:uppercase; color:var(--ash);}
.act:hover:not(:disabled) .act-disc{transform:translateY(-1px); box-shadow:0 5px 0 rgb(var(--keep-border, 12 8 20) / .7), inset 0 0 12px rgb(var(--keep-accent, 240 215 133) / .35); border-color:var(--brass);}
.act:hover:not(:disabled) .act-name{color:var(--brass-l);}
.act:active:not(:disabled) .act-disc{transform:translateY(3px); box-shadow:0 1px 0 rgb(var(--keep-border, 12 8 20) / .7), inset 0 0 8px rgb(var(--keep-accent, 240 215 133) / .4);}
.act--on .act-disc{border-color:var(--brass-l); box-shadow:0 4px 0 rgb(var(--keep-border, 12 8 20) / .7), inset 0 0 16px rgb(var(--keep-accent, 240 215 133) / .6), 0 0 12px rgb(var(--keep-accent, 240 215 133) / .5);}
.act--on .act-name{color:var(--brass-l);}
.act:disabled{opacity:.32; cursor:not-allowed;}
.dead-panel{display:flex; flex-direction:column; align-items:center; gap:12px; padding:8px 0 2px;}
.dead-panel p{font-style:italic; color:var(--ash); margin:0;}
.dead-actions{display:flex; gap:10px; justify-content:center; flex-wrap:wrap;}
.resummon{font-family:'Cinzel','EB Garamond',serif; font-size:12px; letter-spacing:3px; text-transform:uppercase; padding:10px 24px; border-radius:10px; cursor:pointer; color:var(--brass-l); background:linear-gradient(180deg, rgb(var(--keep-panel, 44 32 18)), rgb(var(--keep-bg, 22 15 8))); border:2px solid var(--brass-d); box-shadow:0 4px 0 rgb(var(--keep-border, 12 8 20) / .7), inset 0 0 10px rgb(var(--keep-accent, 240 215 133) / .2); transition:transform .12s ease;}
.resummon:hover:not(:disabled){transform:translateY(-1px); border-color:var(--brass); box-shadow:0 5px 0 rgb(var(--keep-border, 12 8 20) / .7), inset 0 0 16px rgb(var(--keep-accent, 240 215 133) / .4);}
.resummon:active:not(:disabled){transform:translateY(3px);}
.resummon:disabled{opacity:.4; cursor:not-allowed;}
.resummon--ghost{color:var(--ash); background:rgb(var(--keep-bg, 12 8 20) / .5); border-color:var(--edge); box-shadow:none; letter-spacing:2px;}
.resummon--ghost:hover:not(:disabled){color:var(--bone); border-color:var(--brass-d); box-shadow:none;}

/* ---- level row + sell ---- */
.ei-levelrow{display:flex; align-items:center; gap:10px; margin:0 4px 12px;}
.ei-level{font-family:'Cinzel','EB Garamond',serif; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:var(--brass-l); white-space:nowrap;}
.ei-xptrack{flex:1; height:6px; border-radius:4px; background:rgb(var(--keep-bg, 12 8 20) / .6); border:1px solid var(--edge); overflow:hidden;}
.ei-xpfill{height:100%; background:linear-gradient(90deg, var(--brass-d), var(--brass-l)); transition:width .5s ease;}
.ei-sell{display:inline-flex; align-items:center; gap:4px; font-family:'Cinzel','EB Garamond',serif; font-size:9px; letter-spacing:1px; text-transform:uppercase; padding:5px 9px; border-radius:8px; border:1px solid var(--brass-d); color:var(--brass-l); background:rgb(var(--keep-accent, 200 164 76) / .1); cursor:pointer; white-space:nowrap;}
.ei-sell:hover:not(:disabled){border-color:var(--brass);}
.ei-sell:disabled{opacity:.4; cursor:not-allowed;}
.ei-sell.is-armed{color:var(--blood); border-color:var(--blood); background:rgb(192 57 74 / .14);}
.ei-trait{flex:none; font-family:'Cinzel','EB Garamond',serif; font-size:8px; letter-spacing:1px; text-transform:uppercase; color:var(--ash); border:1px solid var(--edge); border-radius:6px; padding:2px 6px; white-space:nowrap;}
.ei-flame{font-size:10px; color:var(--brass-l); opacity:.7;}
.ei-flame.is-fresh{opacity:1;}
.ei-bell{flex:none; width:28px; height:28px; border-radius:8px; cursor:pointer; line-height:1; font-size:13px; border:1px solid var(--brass-d); background:rgb(var(--keep-bg, 12 8 20) / .6); color:var(--ash);}
.ei-bell.is-on{color:var(--brass-l); border-color:var(--brass);}
.ei-bell:hover:not(:disabled){border-color:var(--brass);}
.ei-bell:disabled{opacity:.5; cursor:not-allowed;}

/* ---- gesture overlay (play wisp / cleanse scrub) — diegetic, lives in the dark screen ---- */
.ei-overlay{position:absolute; inset:0; z-index:5; touch-action:none;}
.ei-wisp{position:absolute; width:40px; height:40px; transform:translate(-50%,-50%); cursor:grab; z-index:6; touch-action:none; filter:drop-shadow(0 0 12px rgba(150,230,255,.9));}
.ei-wisp svg{width:100%; height:100%;}
.ei-wisp-halo{fill:rgba(150,230,255,.25); animation:halo 1.6s ease-in-out infinite; transform-origin:center;}
@keyframes halo{0%,100%{transform:scale(.8);opacity:.5}50%{transform:scale(1.15);opacity:.9}}
.ei-grime{position:absolute; width:38px; height:38px; transform:translate(-50%,-50%); z-index:6; filter:drop-shadow(0 0 4px rgba(0,0,0,.5)); transition:opacity .25s ease, transform .25s ease; pointer-events:none;}
.ei-grime svg{width:100%; height:100%;}
.ei-grime.is-clean{opacity:0; transform:translate(-50%,-50%) scale(.4);}
.ei-cloth{position:absolute; width:52px; height:52px; transform:translate(-50%,-50%); border-radius:50%; pointer-events:none; z-index:7; background:radial-gradient(circle, rgba(200,230,255,.28), rgba(200,230,255,.05) 60%, transparent 70%); border:2px solid rgba(190,225,255,.5); box-shadow:0 0 14px rgba(150,200,255,.5);}

/* ---- item drawer (feed / remedy) ---- */
.ei-drawer-scrim{position:absolute; inset:0; z-index:40; display:flex; align-items:flex-end; justify-content:center; background:rgba(0,0,0,.45); animation:eiFade .15s ease;}
@keyframes eiFade{from{opacity:0}to{opacity:1}}
.ei-drawer{width:min(440px,100%); max-height:88%; display:flex; flex-direction:column; background:linear-gradient(180deg, rgb(var(--keep-panel, 34 26 48)) 0%, rgb(var(--keep-bg, 22 16 32)) 100%); border:2px solid var(--brass-d); border-radius:18px 18px 22px 22px; box-shadow:0 -10px 30px rgba(0,0,0,.5); padding:12px 14px 16px; animation:eiSlide .2s ease;}
@keyframes eiSlide{from{transform:translateY(40px);opacity:.4}to{transform:translateY(0);opacity:1}}
.ei-drawer-head{display:flex; align-items:center; gap:10px; margin-bottom:10px;}
.ei-drawer-title{font-family:'Cinzel','EB Garamond',serif; font-size:12px; letter-spacing:1.5px; text-transform:uppercase; color:var(--brass-l); flex:1;}
.ei-wallet{font-size:12px; color:var(--bone); white-space:nowrap;}
.ei-drawer-x{background:none; border:1px solid var(--brass-d); color:var(--ash); border-radius:8px; width:24px; height:24px; cursor:pointer; line-height:1;}
.ei-drawer-x:hover{color:var(--brass-l); border-color:var(--brass);}
.ei-revive-note{margin-bottom:10px; padding:8px 12px; border-radius:10px; background:rgb(var(--keep-accent, 200 164 76) / .08); border:1px solid var(--edge); color:var(--ash); font-style:italic; font-size:12px; line-height:1.4;}
.ei-heal-basic{display:flex; flex-direction:column; align-items:flex-start; gap:1px; width:100%; text-align:left; margin-bottom:8px; padding:8px 12px; border-radius:10px; cursor:pointer; color:var(--brass-l); background:rgb(var(--keep-accent, 200 164 76) / .12); border:1px solid var(--brass-d); font-family:'Cinzel','EB Garamond',serif; font-size:12px; letter-spacing:1px;}
.ei-heal-basic small{font-family:var(--keep-font-family, serif); font-style:italic; letter-spacing:0; text-transform:none; font-size:11px; color:var(--ash);}
.ei-heal-basic:hover:not(:disabled){border-color:var(--brass);}
.ei-heal-basic:disabled{opacity:.4; cursor:not-allowed;}
.ei-drawer-err{color:#ff8a8a; font-size:12px; margin-bottom:6px;}
.ei-drawer-list{flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:6px;}
.ei-empty{text-align:center; color:var(--ash); font-style:italic; padding:20px;}
.ei-item{display:flex; align-items:center; gap:10px; padding:7px 10px; border-radius:10px; background:rgb(var(--keep-bg, 12 8 20) / .6); border:1px solid var(--edge);}
.ei-item-icon{width:30px; height:30px; flex:none; display:flex; align-items:center; justify-content:center; font-size:18px;}
.ei-item-icon img{max-width:100%; max-height:100%; object-fit:contain;}
.ei-item-text{flex:1; display:flex; flex-direction:column; min-width:0;}
.ei-item-name{font-size:13px; color:var(--bone); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.ei-item-sub{font-size:10px; color:var(--ash); text-transform:uppercase; letter-spacing:1px;}
.ei-item-use,.ei-item-buy{display:inline-flex; align-items:center; gap:4px; font-family:'Cinzel','EB Garamond',serif; font-size:10px; letter-spacing:1px; text-transform:uppercase; padding:6px 10px; border-radius:8px; cursor:pointer; white-space:nowrap; border:1px solid var(--brass-d);}
.ei-heal-line{display:inline-flex; align-items:center; gap:4px;}
.ei-item-use{color:rgb(var(--keep-bg, 6 4 12)); background:rgb(var(--keep-action, 200 164 76)); border-color:rgb(var(--keep-action, 200 164 76));}
.ei-item-use:hover{filter:brightness(1.08);}
.ei-item-buy{color:var(--brass-l); background:rgb(var(--keep-accent, 200 164 76) / .1);}
.ei-item-buy:hover:not(:disabled){border-color:var(--brass);}
.ei-item-buy:disabled{opacity:.4; cursor:not-allowed;}

/* ---- The Hall (memorial gallery of departed familiars) ---- */
.ei-hall-row{display:flex; flex-direction:column; gap:1px; padding:7px 10px; border-radius:10px; background:rgb(var(--keep-bg, 12 8 20) / .6); border:1px solid var(--edge);}
.ei-hall-name{font-family:'Cinzel','EB Garamond',serif; font-size:13px; letter-spacing:.5px; color:var(--bone);}
.ei-hall-prism{background:linear-gradient(90deg,#ff6a6a,#f5e15a,#5aeb8c,#6e96ff,#ff6a6a); -webkit-background-clip:text; background-clip:text; color:transparent; font-weight:700;}
.ei-hall-meta{font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--ash);}
.ei-hall-link{margin-top:6px; background:none; border:none; cursor:pointer; font-family:'Cinzel','EB Garamond',serif; font-size:9px; letter-spacing:1.5px; text-transform:uppercase; color:var(--ash); text-decoration:underline dotted; padding:2px;}
.ei-hall-link:hover{color:var(--brass-l);}
`;
