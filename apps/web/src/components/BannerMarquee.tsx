import { useEffect, useMemo, useState } from "react";
import type { AnnouncementBanner } from "@thekeep/shared";
import { legibleAgainstBg, renderUiRouteChipsInHtml } from "@thekeep/shared";
import { useActiveTheme } from "../lib/theme.js";
import { sanitizeUserHtml } from "../lib/userHtml.js";
import { useDismissed, dismiss } from "../lib/dismissedBanners.js";
import { getSocket } from "../lib/socket.js";
import { handleUiRouteClickInHtml } from "../lib/uiRouteOpen.js";

/**
 * Persistent close key — content-aware. The key is the marquee
 * namespace joined with a signature of the CURRENT enabled banner
 * set (each entry's id + updatedAt). When an admin adds, edits, or
 * removes a banner, the signature changes → key changes → dismissed
 * lookup misses → the bar re-shows. Closing again only dismisses
 * THAT specific content set; the next admin change re-shows on its
 * own without forcing the viewer to manually clear site data.
 *
 * Mirrors the version-keyed close on the StaleVersionBanner
 * (`stale-version:0.20.4`) — the viewer's "I've seen this" is
 * scoped to the artifact they dismissed, not the surface itself.
 *
 * The empty-set sentinel keeps the key stable while the initial
 * fetch is in flight so a transient "no banners" state doesn't get
 * its own dismiss entry persisted by mistake.
 */
const DISMISS_NAMESPACE = "announcement-marquee";
function buildDismissKey(banners: AnnouncementBanner[]): string {
  if (banners.length === 0) return `${DISMISS_NAMESPACE}:empty`;
  const sig = banners.map((b) => `${b.id}@${b.updatedAt}`).sort().join("|");
  return `${DISMISS_NAMESPACE}:${sig}`;
}

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
  // Compute the content-aware dismiss key from the CURRENT banner
  // set. Memo'd so every render isn't re-stringifying the signature.
  const dismissKey = useMemo(() => buildDismissKey(banners), [banners]);
  const dismissed = useDismissed(dismissKey);
  const theme = useActiveTheme();

  useEffect(() => {
    // ALWAYS fetch — the dismiss-key signature depends on the
    // current banner set, so we have to load the set BEFORE we can
    // ask "is this content-set dismissed?" An earlier draft
    // short-circuited here on `dismissed`, but with a content-aware
    // key that gates would have left the viewer locked out even
    // after an admin added a fresh banner. The render branch below
    // skips the chrome when dismissed; the fetch + state still
    // run so the key can update when the admin edits the set.
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

  // Memo the chip-rendered HTML per active banner so a rotation tick
  // doesn't re-run sanitize + chip replacement on stable bodies. The
  // dep set is small (id + bodyHtml) so the swap is cheap.
  const renderedHtml = useMemo(
    () => renderUiRouteChipsInHtml(sanitizeUserHtml((banners[activeIdx]?.bodyHtml) ?? "")),
    [banners, activeIdx],
  );

  if (dismissed) return null;
  if (banners.length === 0) return null;

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
      // 3-column grid keeps the body OPTICALLY centered (between the
      // empty left column and the right controls column) while
      // pinning the dot row + close button to the right edge. A
      // simple flex with `justify-center` would offset the body
      // leftward once the right controls were added, since they take
      // their own width out of the centering math.
      className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-1.5 text-sm"
    >
      {/* Left spacer — sized symmetrically to the right column via
          the 1fr-auto-1fr track shape so the auto (body) column lands
          dead center. */}
      <div aria-hidden />
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
        // The structural-tag overrides flatten paragraph/list spacing
        // so multi-paragraph bodies render on one line. We DELIBERATELY
        // avoid `[&_*]:m-0` here — that wildcard previously stripped
        // the UI-route chip's own `mx-1.5` breathing-room margin and
        // left the chip pressed against the surrounding text. Listing
        // just the structural tags lets the chip's margin survive.
        //
        // Width: `max-w-5xl` (1024px) gives the body ~145 chars of
        // one-line space at `text-sm` before truncation kicks in. The
        // editor cap (`ANNOUNCEMENT_BANNER_BODY_MAX = 180`) is sized
        // to leave a small markdown-expansion tolerance past that.
        // The previous `max-w-3xl` ate ~40% of typical banner text
        // even when the author stayed well under the announced
        // 4000-char cap — that's the inconsistency this bumps.
        className="max-w-5xl truncate text-center text-sm leading-snug [&_a]:underline [&_a]:underline-offset-2 [&_li]:m-0 [&_li]:inline [&_li]:before:content-['•'] [&_li]:before:mx-1 [&_ol]:m-0 [&_p]:m-0 [&_p]:inline [&_strong]:font-semibold [&_ul]:m-0 [&_ul]:inline"
        // Delegated click handler picks up any `{token}` chip the
        // post-sanitize chip generator stamped into the HTML body.
        // Non-chip clicks fall through to the bar's natural
        // interaction (none, currently).
        onClick={handleUiRouteClickInHtml}
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
      {/* Right controls — dot row (when 2+ banners) + close button,
          aligned to the right edge of the row via `justify-self-end`
          on the grid track. */}
      <div className="flex items-center justify-self-end gap-2">
        {banners.length > 1 ? (
          <div className="flex items-center gap-1" aria-hidden>
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
                className="h-2 w-2 rounded-full transition hover:scale-125"
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
          onClick={() => dismiss(dismissKey)}
          style={{ color: textHex }}
          className="rounded px-1 text-lg leading-none opacity-60 hover:opacity-100"
          aria-label="Dismiss site announcements"
          title="Dismiss this set. Re-shows when an admin adds or edits a banner."
        >
          ×
        </button>
      </div>
    </div>
  );
}
