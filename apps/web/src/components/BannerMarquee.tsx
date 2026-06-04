import { useEffect, useState } from "react";
import type { AnnouncementBanner } from "@thekeep/shared";
import { legibleAgainstBg } from "@thekeep/shared";
import { useActiveTheme } from "../lib/theme.js";
import { sanitizeUserHtml } from "../lib/userHtml.js";
import { useDismissed, dismiss } from "../lib/dismissedBanners.js";
import { getSocket } from "../lib/socket.js";

/**
 * Persistent close key. One key for the whole bar (not per-banner)
 * because the user's preference here is "I don't want the marquee
 * at the top of my chat" — flipping every individual entry would
 * be tedious for the admin's typical "rotate through a handful at
 * once" use case.
 *
 * Persists in `tk:dismissedBanners:v1` via lib/dismissedBanners.ts,
 * which keeps a single union set shared with the StaleVersionBanner,
 * the room banner, the earning notifications, and every other
 * close-able surface — wiped together by a future "reset banner
 * dismissals" affordance in user settings.
 */
const DISMISS_KEY = "announcement-marquee";

/** Time between rotations when the catalog has 2+ banners. ~8s reads
 *  long enough to actually parse a sentence-or-two announcement but
 *  short enough that a viewer who arrived mid-rotation sees their
 *  next-up banner without losing the room flow. */
const ROTATION_MS = 8_000;
/** Fade transition duration. Keep in sync with the inline transition
 *  style below — declared as a constant so tests / a future
 *  reduced-motion override can read it. */
const FADE_MS = 300;

/**
 * Chat-top rotating banner. Renders the enabled `announcement_banners`
 * set in a fade-rotation: one banner at a time, fading to the next
 * every {@link ROTATION_MS}. A single banner is held statically (no
 * fade flicker on a single-entry catalog).
 *
 * Body is the server-sanitized HTML the admin authored (Markdown
 * is converted client-side at save time, then run through
 * `sanitizeBio` on the server, then re-passed through
 * `sanitizeUserHtml` here as a defense-in-depth pass before it
 * lands in the DOM).
 *
 * Legibility nudging mirrors `StaleVersionBanner`: the bar paints
 * an opaque panel background so the chat shell's bg image (Spire
 * artwork on glass theme, the public-profile backdrop when wired
 * into the shell) can't bleed through and wash out the text. Text /
 * border / action colors are nudged against that opaque panel via
 * `legibleAgainstBg` so every theme + backdrop combo clears the
 * WCAG floor.
 */
export function BannerMarquee() {
  const [banners, setBanners] = useState<AnnouncementBanner[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [fading, setFading] = useState(false);
  // Bumped when the viewer manually jumps to a specific banner (dot
  // click). The auto-rotation effect uses this in its deps so a
  // manual jump restarts the ROTATION_MS timer — without it the
  // viewer could land on a chosen banner and have it advance ~1
  // second later because the existing interval fired mid-jump.
  const [rotationResetKey, setRotationResetKey] = useState(0);
  const dismissed = useDismissed(DISMISS_KEY);
  const theme = useActiveTheme();

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/announcements/banners");
        if (!r.ok) return;
        const j = (await r.json()) as { banners?: AnnouncementBanner[] };
        if (!cancelled && Array.isArray(j.banners)) {
          setBanners(j.banners);
          // Reset the rotation pointer when the catalog shape changes
          // so an admin edit doesn't strand the viewer on a now-
          // out-of-range index.
          setActiveIdx(0);
        }
      } catch { /* network blip — keep last good catalog */ }
    }
    void load();
    // Socket push from the admin's create/edit/delete so the marquee
    // refreshes without waiting on the next mount.
    const socket = getSocket();
    socket.on("announcements:banners-changed", load);
    return () => {
      cancelled = true;
      socket.off("announcements:banners-changed", load);
    };
  }, [dismissed]);

  // Auto-rotate. Only schedules when there are 2+ banners — a single
  // banner stays put without a redundant fade. `rotationResetKey`
  // in the deps means a manual dot-jump tears down the interval
  // and starts a fresh ROTATION_MS window so the viewer gets the
  // full reading time on the banner they explicitly chose.
  useEffect(() => {
    if (dismissed) return;
    if (banners.length < 2) return;
    const id = window.setInterval(() => {
      setFading(true);
      window.setTimeout(() => {
        setActiveIdx((i) => (i + 1) % banners.length);
        setFading(false);
      }, FADE_MS);
    }, ROTATION_MS);
    return () => window.clearInterval(id);
  }, [banners.length, dismissed, rotationResetKey]);

  if (dismissed) return null;
  if (banners.length === 0) return null;
  const active = banners[activeIdx] ?? banners[0]!;

  // Same legibility computation as StaleVersionBanner — opaque
  // panel bg, text nudged against it, action color for the close
  // button border. Without this the body washes out on glass /
  // dark themes whose default banner CSS is translucent.
  const bgHex = theme.panel;
  const textHex = legibleAgainstBg(theme.text, bgHex, 4.5);
  const actionHex = legibleAgainstBg(theme.action, bgHex, 4.5);

  return (
    <div
      role="region"
      aria-label="Site announcements"
      style={{
        backgroundColor: bgHex,
        color: textHex,
        borderBottom: `2px solid ${actionHex}`,
      }}
      className="relative flex items-center justify-center gap-3 px-4 py-1.5 text-xs"
    >
      <div
        // The fade is purely CSS — opacity 1 → 0 → 1 around the
        // index swap. `transition` is inline so it stays tied to
        // FADE_MS without us needing a custom Tailwind config.
        // Inline `<p>` + zero-margin overrides keep multi-paragraph
        // or list-shaped HTML from breaking the bar's single-line
        // height; an admin who needs a long-form announcement
        // should split it into multiple banner rows rather than
        // letting one row push the chat shell down.
        style={{
          opacity: fading ? 0 : 1,
          transition: `opacity ${FADE_MS}ms ease-in-out`,
        }}
        className="max-w-3xl flex-1 truncate text-center text-xs leading-snug [&_*]:m-0 [&_a]:underline [&_a]:underline-offset-2 [&_li]:inline [&_li]:before:content-['•'] [&_li]:before:mx-1 [&_p]:inline [&_strong]:font-semibold [&_ul]:inline"
        dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(active.bodyHtml) }}
      />
      {/* Position indicator chips — only meaningful when there are
          multiple banners. Clicking one jumps the rotation directly
          to that banner; the interval continues from there. */}
      {banners.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1" aria-hidden>
          {banners.map((b, i) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                if (i === activeIdx) return;
                setFading(true);
                window.setTimeout(() => {
                  setActiveIdx(i);
                  setFading(false);
                  // Bump so the auto-rotation effect tears down +
                  // restarts its interval; viewer gets the full
                  // ROTATION_MS on the banner they clicked.
                  setRotationResetKey((k) => k + 1);
                }, FADE_MS);
              }}
              className="h-1.5 w-1.5 rounded-full transition hover:scale-125"
              style={{
                backgroundColor: i === activeIdx ? actionHex : `${actionHex}55`,
              }}
              aria-label={`Show announcement ${i + 1} of ${banners.length}`}
              title={`Show announcement ${i + 1} of ${banners.length}`}
            />
          ))}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => dismiss(DISMISS_KEY)}
        style={{ color: textHex }}
        className="shrink-0 rounded px-1 text-base leading-none opacity-60 hover:opacity-100"
        aria-label="Dismiss site announcements"
        title="Dismiss (stays closed until you clear your site data)"
      >
        ×
      </button>
    </div>
  );
}
