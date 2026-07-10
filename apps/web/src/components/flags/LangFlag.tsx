/**
 * Hand-drawn inline SVG flags for the profile language tags.
 *
 * Why not emoji flags: Windows ships no color flag emoji, so 🇬🇧 renders as
 * the bare letters "GB" for a large slice of the user base. Why not a CDN
 * sprite: the production CSP blocks third-party origins (the GrapesJS
 * icon lesson). Bundling ~35 tiny inline SVGs is CSP-safe, crisp at chip
 * size, and adds no network cost.
 *
 * Drawings are deliberately SIMPLIFIED (no coats of arms, no fine stripe
 * counts) — at 18×12 px a faithful 13-stripe US flag just aliases into
 * mush. Each design keeps the two or three shapes that make the flag
 * recognizable at a glance. Keys match `LanguageTag.flag` in
 * `@thekeep/shared` (see languageTags.ts); adding a catalog entry means
 * adding its drawing here (the catalog test pins the pairing).
 *
 * All drawings live in a 24×16 viewBox. The <svg> clips (default
 * `overflow: hidden`), so shapes may safely overshoot the edges.
 */

import type { JSX } from "react";

/** Points string for a 5-point star centered on (cx, cy), outer radius r. */
function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.382;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

function Star({ cx, cy, r, fill }: { cx: number; cy: number; r: number; fill: string }) {
  return <polygon points={starPoints(cx, cy, r)} fill={fill} />;
}

/** Union Jack in the full 24×16 box — used by GB directly and scaled into
 *  the AU canton. Diagonals via stroked paths, crosses via rects. */
function UnionJack() {
  return (
    <>
      <rect width="24" height="16" fill="#012169" />
      <path d="M0,0 L24,16 M24,0 L0,16" stroke="#fff" strokeWidth="3.2" />
      <path d="M0,0 L24,16 M24,0 L0,16" stroke="#C8102E" strokeWidth="1.3" />
      <rect x="9.6" width="4.8" height="16" fill="#fff" />
      <rect y="5.6" width="24" height="4.8" fill="#fff" />
      <rect x="10.8" width="2.4" height="16" fill="#C8102E" />
      <rect y="6.8" width="24" height="2.4" fill="#C8102E" />
    </>
  );
}

const FLAGS: Record<string, JSX.Element> = {
  us: (
    <>
      <rect width="24" height="16" fill="#fff" />
      {[0, 4.57, 9.14, 13.71].map((y) => (
        <rect key={y} y={y} width="24" height="2.29" fill="#B22234" />
      ))}
      <rect width="9.6" height="8" fill="#3C3B6E" />
      {[
        [1.6, 1.7], [4.8, 1.7], [8, 1.7],
        [3.2, 4], [6.4, 4],
        [1.6, 6.3], [4.8, 6.3], [8, 6.3],
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="0.5" fill="#fff" />
      ))}
    </>
  ),
  gb: <UnionJack />,
  au: (
    <>
      <rect width="24" height="16" fill="#012169" />
      <g transform="scale(0.5)">
        <UnionJack />
      </g>
      <Star cx={6} cy={12.2} r={1.8} fill="#fff" />
      <Star cx={18} cy={3} r={1} fill="#fff" />
      <Star cx={21.2} cy={6.4} r={1} fill="#fff" />
      <Star cx={18} cy={10.2} r={1} fill="#fff" />
      <Star cx={14.9} cy={6} r={1} fill="#fff" />
      <Star cx={19.4} cy={13.2} r={0.7} fill="#fff" />
    </>
  ),
  ca: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="6" height="16" fill="#D80621" />
      <rect x="18" width="6" height="16" fill="#D80621" />
      <path
        d="M12,3.2 L13,5.6 L15.2,4.8 L14.2,7.2 L16.6,7.2 L12,12.4 L7.4,7.2 L9.8,7.2 L8.8,4.8 L11,5.6 Z"
        fill="#D80621"
      />
    </>
  ),
  es: (
    <>
      <rect width="24" height="16" fill="#F1BF00" />
      <rect width="24" height="4" fill="#AA151B" />
      <rect y="12" width="24" height="4" fill="#AA151B" />
    </>
  ),
  // Español (Latinoamérica) spans a continent, not a country, so the chip
  // gets a stylized globe showing the Americas instead of one nation's flag.
  latam: (
    <>
      <rect width="24" height="16" fill="#0B4EA2" />
      <circle cx="12" cy="8" r="5.6" fill="#2E86D1" />
      <path d="M9.2,3.4 C11.4,2.9 13.6,3.4 14.4,4.6 C13.2,5.4 11.6,5.2 10.8,6.2 C10,5.8 9,4.6 9.2,3.4 Z" fill="#4CAF6D" />
      <path d="M11.4,7.4 C12.6,7.2 13.6,7.8 13.8,9 C14,10.6 13,12.6 12.2,13.2 C11.6,11.8 11,9.4 11.4,7.4 Z" fill="#4CAF6D" />
      <circle cx="12" cy="8" r="5.6" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="0.6" />
    </>
  ),
  br: (
    <>
      <rect width="24" height="16" fill="#009B3A" />
      <polygon points="12,1.8 22.2,8 12,14.2 1.8,8" fill="#FEDF00" />
      <circle cx="12" cy="8" r="3.4" fill="#002776" />
      <path d="M8.8,7.4 C11,6.6 14.2,7.2 15.2,8.8" stroke="#fff" strokeWidth="0.7" fill="none" />
    </>
  ),
  pt: (
    <>
      <rect width="24" height="16" fill="#DA291C" />
      <rect width="9" height="16" fill="#046A38" />
      <circle cx="9" cy="8" r="2.9" fill="none" stroke="#FFE900" strokeWidth="1" />
      <circle cx="9" cy="8" r="1.5" fill="#fff" />
    </>
  ),
  fr: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="8" height="16" fill="#002395" />
      <rect x="16" width="8" height="16" fill="#ED2939" />
    </>
  ),
  de: (
    <>
      <rect width="24" height="16" fill="#FFCE00" />
      <rect width="24" height="5.33" fill="#000" />
      <rect y="5.33" width="24" height="5.34" fill="#DD0000" />
    </>
  ),
  it: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="8" height="16" fill="#009246" />
      <rect x="16" width="8" height="16" fill="#CE2B37" />
    </>
  ),
  nl: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="24" height="5.33" fill="#AE1C28" />
      <rect y="10.67" width="24" height="5.33" fill="#21468B" />
    </>
  ),
  se: (
    <>
      <rect width="24" height="16" fill="#006AA7" />
      <rect x="7.2" width="3" height="16" fill="#FECC02" />
      <rect y="6.5" width="24" height="3" fill="#FECC02" />
    </>
  ),
  no: (
    <>
      <rect width="24" height="16" fill="#BA0C2F" />
      <rect x="6.3" width="5.4" height="16" fill="#fff" />
      <rect y="5.3" width="24" height="5.4" fill="#fff" />
      <rect x="7.8" width="2.4" height="16" fill="#00205B" />
      <rect y="6.8" width="24" height="2.4" fill="#00205B" />
    </>
  ),
  dk: (
    <>
      <rect width="24" height="16" fill="#C8102E" />
      <rect x="7.2" width="2.8" height="16" fill="#fff" />
      <rect y="6.6" width="24" height="2.8" fill="#fff" />
    </>
  ),
  fi: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect x="6.8" width="3.4" height="16" fill="#002F6C" />
      <rect y="6.3" width="24" height="3.4" fill="#002F6C" />
    </>
  ),
  pl: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect y="8" width="24" height="8" fill="#DC143C" />
    </>
  ),
  cz: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect y="8" width="24" height="8" fill="#D7141A" />
      <polygon points="0,0 11,8 0,16" fill="#11457E" />
    </>
  ),
  ru: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect y="5.33" width="24" height="5.34" fill="#0039A6" />
      <rect y="10.67" width="24" height="5.33" fill="#D52B1E" />
    </>
  ),
  ua: (
    <>
      <rect width="24" height="16" fill="#0057B7" />
      <rect y="8" width="24" height="8" fill="#FFD700" />
    </>
  ),
  gr: (
    <>
      <rect width="24" height="16" fill="#0D5EAF" />
      {[1.78, 5.33, 8.89, 12.44].map((y) => (
        <rect key={y} y={y} width="24" height="1.78" fill="#fff" />
      ))}
      <rect width="8.9" height="8.9" fill="#0D5EAF" />
      <rect x="3.55" width="1.8" height="8.9" fill="#fff" />
      <rect y="3.55" width="8.9" height="1.8" fill="#fff" />
    </>
  ),
  tr: (
    <>
      <rect width="24" height="16" fill="#E30A17" />
      <circle cx="8.5" cy="8" r="4" fill="#fff" />
      <circle cx="9.5" cy="8" r="3.2" fill="#E30A17" />
      <Star cx={14} cy={8} r={1.7} fill="#fff" />
    </>
  ),
  // Saudi flag simplified: the calligraphy band + sword read as two white
  // bars at chip size.
  sa: (
    <>
      <rect width="24" height="16" fill="#165B33" />
      <rect x="4.5" y="5" width="15" height="2" rx="0.6" fill="#fff" />
      <rect x="4.5" y="10" width="11" height="1" rx="0.5" fill="#fff" />
    </>
  ),
  il: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect y="1.7" width="24" height="1.9" fill="#0038B8" />
      <rect y="12.4" width="24" height="1.9" fill="#0038B8" />
      <polygon points="12,4.9 14.7,9.6 9.3,9.6" fill="none" stroke="#0038B8" strokeWidth="0.8" />
      <polygon points="12,11.1 9.3,6.4 14.7,6.4" fill="none" stroke="#0038B8" strokeWidth="0.8" />
    </>
  ),
  in: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="24" height="5.33" fill="#FF9933" />
      <rect y="10.67" width="24" height="5.33" fill="#138808" />
      <circle cx="12" cy="8" r="1.9" fill="none" stroke="#000080" strokeWidth="0.5" />
      <circle cx="12" cy="8" r="0.4" fill="#000080" />
    </>
  ),
  jp: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <circle cx="12" cy="8" r="4.8" fill="#BC002D" />
    </>
  ),
  kr: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <circle cx="12" cy="8" r="3.6" fill="#0047A0" />
      <path d="M8.4,8 A3.6,3.6 0 0 1 15.6,8 A1.8,1.8 0 0 1 12,8 A1.8,1.8 0 0 0 8.4,8 Z" fill="#CD2E3A" />
      {[
        [4.2, 3.4, 34], [19.8, 3.4, -34], [4.2, 12.6, -34], [19.8, 12.6, 34],
      ].map(([x, y, a]) => (
        <g key={`${x}-${y}`} transform={`translate(${x},${y}) rotate(${a})`} fill="#000">
          <rect x="-1.5" y="-1.1" width="3" height="0.55" />
          <rect x="-1.5" y="-0.27" width="3" height="0.55" />
          <rect x="-1.5" y="0.55" width="3" height="0.55" />
        </g>
      ))}
    </>
  ),
  cn: (
    <>
      <rect width="24" height="16" fill="#DE2910" />
      <Star cx={4.6} cy={5.2} r={2.3} fill="#FFDE00" />
      <Star cx={9.2} cy={1.9} r={0.8} fill="#FFDE00" />
      <Star cx={10.6} cy={4} r={0.8} fill="#FFDE00" />
      <Star cx={10.6} cy={6.6} r={0.8} fill="#FFDE00" />
      <Star cx={9.2} cy={8.6} r={0.8} fill="#FFDE00" />
    </>
  ),
  tw: (
    <>
      <rect width="24" height="16" fill="#FE0000" />
      <rect width="12" height="8" fill="#000095" />
      <circle cx="6" cy="4" r="2.2" fill="#fff" />
      <circle cx="6" cy="4" r="1.4" fill="#000095" />
      <circle cx="6" cy="4" r="1.1" fill="#fff" />
    </>
  ),
  vn: (
    <>
      <rect width="24" height="16" fill="#DA251D" />
      <Star cx={12} cy={8} r={3.2} fill="#FFFF00" />
    </>
  ),
  th: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="24" height="2.67" fill="#A51931" />
      <rect y="13.33" width="24" height="2.67" fill="#A51931" />
      <rect y="5.33" width="24" height="5.34" fill="#2D2A4A" />
    </>
  ),
  id: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="24" height="8" fill="#CE1126" />
    </>
  ),
  ph: (
    <>
      <rect width="24" height="8" fill="#0038A8" />
      <rect y="8" width="24" height="8" fill="#CE1126" />
      <polygon points="0,0 10,8 0,16" fill="#fff" />
      <circle cx="3.4" cy="8" r="1.7" fill="#FCD116" />
    </>
  ),
  ro: (
    <>
      <rect width="24" height="16" fill="#FCD116" />
      <rect width="8" height="16" fill="#002B7F" />
      <rect x="16" width="8" height="16" fill="#CE1126" />
    </>
  ),
  hu: (
    <>
      <rect width="24" height="16" fill="#fff" />
      <rect width="24" height="5.33" fill="#CE2939" />
      <rect y="10.67" width="24" height="5.33" fill="#477050" />
    </>
  ),
};

/** Flag keys with a drawing — exported so a test can pin catalog coverage. */
export const LANG_FLAG_CODES: readonly string[] = Object.keys(FLAGS);

/**
 * A single language-tag flag. Purely decorative (`aria-hidden`) — the chip
 * text carries the language name. Renders nothing for an unknown code so a
 * newer server catalog can't break an older client.
 */
export function LangFlag({ code, className }: { code: string; className?: string }) {
  const drawing = FLAGS[code];
  if (!drawing) return null;
  return (
    <svg
      viewBox="0 0 24 16"
      className={className}
      aria-hidden
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
    >
      {drawing}
    </svg>
  );
}
