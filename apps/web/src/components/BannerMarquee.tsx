import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight } from "lucide-react";
import type { AnnouncementBanner, AnnouncementBannerSource } from "@thekeep/shared";
import { legibleAgainstBg, renderUiRouteChipsInHtml } from "@thekeep/shared";
import { useActiveTheme } from "../lib/theme.js";
import { sanitizeUserHtml } from "../lib/userHtml.js";
import { useDismissed, dismiss, undismiss, dismissedAt } from "../lib/dismissedBanners.js";
import { setMarqueeHidden } from "../lib/marqueeVisibility.js";
import { getSocket } from "../lib/socket.js";
import { handleUiRouteClickInHtml } from "../lib/uiRouteOpen.js";
import { hydrateDynamicUiRouteChips } from "../lib/hydrateDynamicUiRouteChips.js";
import { useReducedMotion } from "../lib/reducedMotion.js";
import { useChat } from "../state/store.js";

/**
 * Persistent close key, content-aware. The key is the marquee
 * namespace joined with a signature of the CURRENT enabled banner
 * set (each entry's id + updatedAt). When an admin adds, edits, or
 * removes a banner, the signature changes → key changes → dismissed
 * lookup misses → the bar re-shows. Closing again only dismisses
 * THAT specific content set; the next admin change re-shows on its
 * own without forcing the viewer to manually clear site data.
 *
 * Mirrors the version-keyed close on the StaleVersionBanner
 * (`stale-version:0.20.4`), the viewer's "I've seen this" is
 * scoped to the artifact they dismissed, not the surface itself.
 *
 * The empty-set sentinel keeps the key stable while the initial
 * fetch is in flight so a transient "no banners" state doesn't get
 * its own dismiss entry persisted by mistake.
 */
const DISMISS_NAMESPACE = "announcement-marquee";
/** How long a dismissal hides the marquee before it re-shows on its own.
 *  The viewer can bring it back sooner from the Room Info bar's button. */
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;
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
 *  style below, declared as a constant so tests / a future
 *  reduced-motion override can read it. */
const FADE_MS = 300;

interface Props {
  /** Site/app name (branding.siteName), the label + tooltip for the
   *  platform-wide announcement stream ("{appName} Announcements"). */
  appName: string;
  /** The viewer's CURRENT community server name, or null when they're only
   *  on the home/default server or the servers feature is off. When null the
   *  bar has nothing to switch TO, so the source toggle is hidden and only the
   *  app stream shows. Drives the second toggle label
   *  ("{serverName} Announcements"). */
  serverName: string | null;
}

/**
 * Chat-top rotating banner. Renders the enabled `announcement_banners`
 * set in a fade-rotation: one banner at a time, fading to the next
 * every {@link ROTATION_MS}. A single banner is held statically (no
 * fade flicker on a single-entry catalog).
 *
 * TWO SEPARATE SOURCES, one shown at a time. The public route tags each
 * row with a `source` ("app" | "server"); the bar partitions on that and
 * shows only the SELECTED stream — the community-server announcements are
 * NOT appended onto the platform ones. A toggle (to the right of the dots)
 * flips between "{appName} Announcements" and "{serverName} Announcements";
 * it only appears when the viewer is inside a real community server AND both
 * streams have something to show. A fixed left label names the current
 * source, and the bar's background carries a faint source-coded tint (app vs
 * server) so a source switch reads at a glance.
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
export function BannerMarquee({ appName, serverName }: Props) {
  const { t } = useTranslation("common");
  const [banners, setBanners] = useState<AnnouncementBanner[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [fading, setFading] = useState(false);
  // Which stream the viewer is looking at. Defaults to the app stream; the
  // toggle flips it. Kept as the RAW choice — the EFFECTIVE source (below)
  // resolves an empty selection back to whichever stream actually has content
  // so a source with nothing to show never paints an empty bar.
  const [sourceMode, setSourceMode] = useState<AnnouncementBannerSource>("app");
  // Bumped when the viewer manually jumps to a specific banner (dot
  // click). The auto-rotation effect uses this in its deps so a
  // manual jump restarts the ROTATION_MS timer, without it the
  // viewer could land on a chosen banner and have it advance ~1
  // second later because the existing interval fired mid-jump.
  const [rotationResetKey, setRotationResetKey] = useState(0);
  // Compute the content-aware dismiss key from the CURRENT banner
  // set (both streams). Memo'd so every render isn't re-stringifying the
  // signature. Spanning both streams keeps a single dismissal covering the
  // whole bar; switching source doesn't resurrect a dismissed bar.
  const dismissKey = useMemo(() => buildDismissKey(banners), [banners]);
  const dismissed = useDismissed(dismissKey, DISMISS_TTL_MS);
  const theme = useActiveTheme();
  // Reduce Motion: when on, hold the current banner statically instead of
  // auto-rotating. Reactive so flipping the toggle live starts/stops the
  // rotation interval immediately (it's in the effect's dep array).
  const reduceMotion = useReducedMotion();
  // The server the viewer's CURRENT room belongs to (derived from room:state
  // in the store; we only READ it here). Passed to the public banners route so
  // it returns the default/system banners PLUS this one server's — tagged by
  // `source` so we can split them. Null = not-yet-resolved / flag off, in which
  // case the route returns only the platform-wide set.
  const currentServerId = useChat((s) => s.currentServerId);

  // Split the fetched set into the two streams. The route tags each row's
  // `source`; anything without a tag (older bundle / defensive) counts as app.
  const appBanners = useMemo(
    () => banners.filter((b) => (b.source ?? "app") === "app"),
    [banners],
  );
  const serverBanners = useMemo(
    () => banners.filter((b) => b.source === "server"),
    [banners],
  );
  // A community server is only switchable-to when we HAVE its name (App passes
  // it only for a real, non-home server with the flag on) AND it actually has
  // announcements to show. Otherwise there's nothing to toggle to.
  const hasServerSource = !!serverName && serverBanners.length > 0;

  // The EFFECTIVE source. Honor the viewer's choice, but never paint an empty
  // bar for a source that has nothing:
  //   - "server" is only honored when it actually has content (hasServerSource).
  //   - if the resulting "app" stream is ALSO empty (a community server with
  //     server-only announcements and no platform ones), fall through to the
  //     server stream so its banners still show. Between the two only-non-empty
  //     streams reach here (the total-empty case returns null below).
  const wantsServer = sourceMode === "server" && hasServerSource;
  const effectiveSource: AnnouncementBannerSource =
    wantsServer || appBanners.length === 0 ? (hasServerSource ? "server" : "app") : "app";
  const shown = effectiveSource === "server" ? serverBanners : appBanners;
  const sourceLabel = t("marquee.sourceLabel", {
    name: effectiveSource === "server" ? serverName : appName,
  });

  // Publish hidden-state to the Room Info bar's "bring back announcements"
  // button: hidden ONLY when there are banners but the viewer dismissed
  // them. The resurrect callback clears this exact (content-aware) key.
  useEffect(() => {
    setMarqueeHidden(dismissed && banners.length > 0, () => undismiss(dismissKey));
  }, [dismissed, banners.length, dismissKey]);

  // Auto-expiry: a tab left open past the 24h window won't re-render on
  // its own (the dismissal store only notifies on change), so schedule
  // the re-show at the exact boundary. `undismiss` both clears the stale
  // entry and flips the bar back on via the store's notify.
  useEffect(() => {
    if (!dismissed) return;
    const ts = dismissedAt(dismissKey);
    if (ts == null) return;
    const remaining = DISMISS_TTL_MS - (Date.now() - ts);
    if (remaining <= 0) { undismiss(dismissKey); return; }
    const id = window.setTimeout(() => undismiss(dismissKey), remaining + 250);
    return () => window.clearTimeout(id);
  }, [dismissed, dismissKey]);

  useEffect(() => {
    // ALWAYS fetch, the dismiss-key signature depends on the
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
        // Pass the viewer's current server so community-server banners can be
        // tagged `source: "server"`; the route always includes the
        // default/system set tagged `source: "app"`.
        const url = currentServerId
          ? `/announcements/banners?serverId=${encodeURIComponent(currentServerId)}`
          : "/announcements/banners";
        const r = await fetch(url);
        if (!r.ok) return;
        const j = (await r.json()) as { banners?: AnnouncementBanner[] };
        if (!cancelled && Array.isArray(j.banners)) {
          setBanners(j.banners);
          // Reset the rotation pointer when the catalog shape changes
          // so an admin edit doesn't strand the viewer on a now-
          // out-of-range index.
          setActiveIdx(0);
        }
      } catch { /* network blip, keep last good catalog */ }
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
  }, [dismissed, currentServerId]);

  // Keep the rotation pointer in range whenever the DISPLAYED stream changes
  // shape (source toggle, admin edit that shrank the current stream). Without
  // this a toggle from a 3-banner stream to a 1-banner stream could leave
  // activeIdx at 2 and render nothing.
  useEffect(() => {
    setActiveIdx(0);
    setFading(false);
  }, [effectiveSource, shown.length]);

  // Auto-rotate the DISPLAYED stream. Only schedules when it has 2+ banners, a
  // single banner stays put without a redundant fade. `rotationResetKey`
  // in the deps means a manual dot-jump tears down the interval
  // and starts a fresh ROTATION_MS window so the viewer gets the
  // full reading time on the banner they explicitly chose.
  useEffect(() => {
    if (dismissed) return;
    if (shown.length < 2) return;
    // Reduce Motion: don't start the rotation interval; the current
    // banner is held statically (no fade either, since the fade only
    // fires on a rotation tick).
    if (reduceMotion) return;
    const id = window.setInterval(() => {
      setFading(true);
      window.setTimeout(() => {
        setActiveIdx((i) => (i + 1) % shown.length);
        setFading(false);
      }, FADE_MS);
    }, ROTATION_MS);
    return () => window.clearInterval(id);
  }, [shown.length, dismissed, rotationResetKey, reduceMotion, effectiveSource]);

  // Memo the chip-rendered HTML per active banner so a rotation tick
  // doesn't re-run sanitize + chip replacement on stable bodies. The
  // dep set is small (id + bodyHtml) so the swap is cheap.
  const renderedHtml = useMemo(
    () => renderUiRouteChipsInHtml(sanitizeUserHtml((shown[activeIdx]?.bodyHtml) ?? "")),
    [shown, activeIdx],
  );

  // Hydrate any dynamic chip (e.g. {scriptorium:latest:story}) AFTER
  // `dangerouslySetInnerHTML` has put the rendered HTML into the
  // body div, the chip's static label is the skeleton, the
  // hydration helper fetches + writes in the real title. Re-runs
  // when the rendered HTML changes (rotation tick, admin edit) so a
  // freshly-shown banner with a dynamic chip gets resolved too.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    return hydrateDynamicUiRouteChips(el);
  }, [renderedHtml]);

  if (dismissed) return null;
  if (banners.length === 0) return null;

  // Same legibility computation as StaleVersionBanner, opaque
  // panel bg, text nudged against it, action color for the close
  // button border. Without this the body washes out on glass /
  // dark themes whose default banner CSS is translucent.
  const bgHex = theme.panel;
  const textHex = legibleAgainstBg(theme.text, bgHex, 4.5);
  const actionHex = legibleAgainstBg(theme.action, bgHex, 4.5);
  // Source-coded accent color for the left label + divider + the faint
  // background wash. App uses the theme's ACTION hue, the community server the
  // ACCENT hue — two theme tokens that read as distinct without hardcoding a
  // color, and both already nudged legible against the panel.
  const accentHex = effectiveSource === "server"
    ? legibleAgainstBg(theme.accent, bgHex, 4.5)
    : actionHex;

  return (
    <div
      role="region"
      aria-label={t("marquee.regionAria")}
      style={{
        backgroundColor: bgHex,
        color: textHex,
        borderBottom: `2px solid ${actionHex}`,
      }}
      // 3-column grid keeps the body OPTICALLY centered (between the
      // left label column and the right controls column) while
      // pinning the source label to the left edge and the dot row +
      // source toggle + close button to the right edge.
      className="relative grid grid-cols-[auto_1fr_auto] items-stretch gap-3 py-1.5 pl-3 pr-4 text-sm"
    >
      {/* Faint source-coded background wash. A low-opacity tint OVER the opaque
          panel (so legibility math still holds) that DIFFERS between the app
          and server streams, so a source switch is felt as well as read. Sits
          under the content (the grid children carry no bg of their own). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ backgroundColor: `${accentHex}14`, transition: `background-color ${FADE_MS}ms ease-in-out` }}
      />
      {/* Left: fixed source label + a full-bar-height vertical rule partitioning
          it from the scrolling content. The label names the stream currently on
          screen; the rule is a real full-height divider (self-stretch + w-px).
          Hidden below `sm`: on a phone this nowrap label (e.g. "THE SPIRE
          ANNOUNCEMENTS") reserved ~45% of the row and forced the body to wrap
          to several lines; dropping it there gives the announcement the width
          to stay on one or two lines. The source-coded background wash + the
          right-hand source toggle still convey which stream is showing. */}
      <div className="relative z-10 hidden items-stretch gap-3 sm:flex">
        <span
          className="flex items-center whitespace-nowrap text-[11px] font-semibold uppercase tracking-widest"
          style={{ color: accentHex }}
          title={sourceLabel}
        >
          {sourceLabel}
        </span>
        {/* Full-height vertical divider (a rule turned on its side). `self-stretch`
            makes it span the whole bar height; the source-accent color ties it to
            the active stream. */}
        <hr
          aria-hidden
          className="m-0 w-px self-stretch border-0"
          style={{ backgroundColor: `${accentHex}66` }}
        />
      </div>
      <div
        ref={bodyRef}
        // The fade is purely CSS, opacity 1 → 0 → 1 around the
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
        // avoid `[&_*]:m-0` here, that wildcard previously stripped
        // the UI-route chip's own `mx-1.5` breathing-room margin and
        // left the chip pressed against the surrounding text. Listing
        // just the structural tags lets the chip's margin survive.
        //
        // Width: `max-w-5xl` (1024px) gives the body ~145 chars of
        // one-line space at `text-sm` on desktop before truncation
        // kicks in. The editor cap (`ANNOUNCEMENT_BANNER_BODY_MAX
        // = 180`) leaves a small markdown-expansion tolerance past
        // that. The previous `max-w-3xl` ate ~40% of typical banner
        // text even when the author stayed well under the announced
        // 4000-char cap, that's the inconsistency this bumps.
        //
        // Truncate is `sm:`-prefixed so phones don't lose 90% of the
        // body to ellipsis; below the `sm` breakpoint (640px) the
        // strip wraps to as many lines as the body needs. The
        // controls cell stays vertically centered against the
        // wrapped block via `items-stretch` on the grid above, so a
        // 3-line mobile banner reads as one cohesive strip with the
        // close button parked beside it.
        className="relative z-10 flex max-w-5xl items-center justify-self-center text-center text-sm leading-snug sm:truncate [&_a]:underline [&_a]:underline-offset-2 [&_li]:m-0 [&_li]:inline [&_li]:before:content-['•'] [&_li]:before:mx-1 [&_ol]:m-0 [&_p]:m-0 [&_p]:inline [&_strong]:font-semibold [&_ul]:m-0 [&_ul]:inline"
        // Delegated click handler picks up any `{token}` chip the
        // post-sanitize chip generator stamped into the HTML body.
        // Non-chip clicks fall through to the bar's natural
        // interaction (none, currently).
        onClick={handleUiRouteClickInHtml}
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
      {/* Right controls, dot row (when the shown stream has 2+ banners) +
          source toggle (when there's a second stream to switch to) + close
          button, aligned to the right edge of the row via `justify-self-end`. */}
      <div className="relative z-10 flex items-center justify-self-end gap-2">
        {shown.length > 1 ? (
          // Dots hidden on mobile, h-2 w-2 is too small to tap
          // reliably on touch, and the wrapped multi-line body
          // already gives mobile readers the whole banner without
          // needing to flip between rotations. Auto-rotation still
          // runs underneath.
          <div className="hidden items-center gap-1 sm:flex" aria-hidden>
            {shown.map((b, i) => (
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
                  backgroundColor: i === activeIdx ? accentHex : `${accentHex}55`,
                }}
                aria-label={t("marquee.showAnnouncement", { index: i + 1, total: shown.length })}
                title={t("marquee.showAnnouncement", { index: i + 1, total: shown.length })}
              />
            ))}
          </div>
        ) : null}
        {/* Source toggle. Sits to the RIGHT of the dots. Only rendered when the
            viewer is inside a community server that HAS announcements AND the app
            stream also has content — i.e. there's genuinely a second source to
            switch to. Icon-only (lucide), so it carries both a title and an
            aria-label naming the source it will switch TO. */}
        {hasServerSource && appBanners.length > 0 ? (
          <button
            type="button"
            onClick={() =>
              setSourceMode((m) => (m === "server" ? "app" : "server"))
            }
            className="flex h-5 w-5 items-center justify-center rounded border border-keep-action/40 bg-keep-action/20 text-keep-action hover:border-keep-action hover:bg-keep-action/40"
            aria-label={t("marquee.showSource", {
              name: effectiveSource === "server" ? appName : serverName,
            })}
            title={t("marquee.showSource", {
              name: effectiveSource === "server" ? appName : serverName,
            })}
          >
            <ArrowLeftRight aria-hidden className="h-3 w-3" />
          </button>
        ) : null}
        {/* Dismiss ×, matches the world-banner + topic-banner close
            chips in App.tsx (h-5 w-5 rounded box, action-tinted bg +
            border, hover deepens both). The marquee X used to be a
            plain `text-lg opacity-60` glyph, which read as a
            different family of control than the other top-of-chat
            banners stacked underneath it and visibly mismatched once
            the world / topic banners painted side by side with the
            marquee. The action color slot is theme-aware (CSS var)
            so it still honors the chat's palette without needing
            the marquee's earlier `legibleAgainstBg` math. */}
        <button
          type="button"
          onClick={() => dismiss(dismissKey)}
          className="flex h-5 w-5 items-center justify-center rounded border border-keep-action/40 bg-keep-action/20 text-[11px] leading-none text-keep-action hover:border-keep-action hover:bg-keep-action/40"
          aria-label={t("marquee.dismissAria")}
          title={t("marquee.dismissTitle")}
        >
          ×
        </button>
      </div>
    </div>
  );
}
