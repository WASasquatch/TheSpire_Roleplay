import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { isDarkPalette } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { resolveSplashTheme, splashBgUrl, themeStyle } from "../lib/theme.js";
import { CommunityBoard } from "./CommunityBoard.js";
import { fetchPublicAffiliates, type PublicAffiliateCard } from "../lib/affiliates.js";

/**
 * Public /top-communities page — the topsite board mirrored to the open web, so
 * anyone (signed in or not) can browse partner communities and add their own.
 * Uses the front-page splash theme + background art + light/dark palette, headed
 * by the site logo with a "Top Communities" subtitle. Rendered by App as a
 * pre-auth early-return.
 *
 * "Add Your Site" forwards a logged-out visitor to registration and a signed-in
 * one into the app with the Add-Your-Community modal open (via a one-shot intent
 * flag the app consumes on entry).
 */

export const TOP_COMMUNITIES_PATH = "/top-communities";

/** One-shot "open the Add-Your-Community modal once you're in the app" flag. */
const ADD_COMMUNITY_INTENT_KEY = "spire:add-community-intent";

export function isTopCommunitiesUrl(): boolean {
  return window.location.pathname.replace(/\/+$/, "") === TOP_COMMUNITIES_PATH;
}

/** Read + clear the add-community intent. App calls this on authed entry. */
export function consumeAddCommunityIntent(): boolean {
  try {
    if (window.localStorage.getItem(ADD_COMMUNITY_INTENT_KEY)) {
      window.localStorage.removeItem(ADD_COMMUNITY_INTENT_KEY);
      return true;
    }
  } catch {
    /* storage unavailable — no intent */
  }
  return false;
}

function setAddCommunityIntent(): void {
  try {
    window.localStorage.setItem(ADD_COMMUNITY_INTENT_KEY, "1");
  } catch {
    /* storage unavailable — the modal just won't auto-open */
  }
}

function navigate(to: string): void {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function TopCommunitiesPage() {
  const branding = useChat((s) => s.branding);
  const me = useChat((s) => s.me);
  const siteName = branding.siteName || "The Spire";
  const theme = resolveSplashTheme(branding);
  const dark = isDarkPalette(theme);

  const [cards, setCards] = useState<PublicAffiliateCard[] | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = `Top Communities · ${siteName}`;
    return () => { document.title = prev; };
  }, [siteName]);

  useEffect(() => {
    let alive = true;
    fetchPublicAffiliates()
      .then((res) => { if (alive) setCards(res.cards); })
      .catch(() => { if (alive) setCards([]); });
    return () => { alive = false; };
  }, []);

  // Signed in → drop into the app with the modal open; else → registration.
  function addYourSite() {
    setAddCommunityIntent();
    navigate(me ? "/" : "/register");
  }

  return (
    <div style={themeStyle(theme)} className="relative min-h-screen w-full overflow-hidden text-keep-text">
      {/* Spire background art, portaled to <body> so it stays a true viewport-fixed
          layer (matches the splash). z-index 0 paints above the body bg; content
          below is lifted to z-10. */}
      {createPortal(
        <div aria-hidden style={{ ...themeStyle(theme), position: "fixed", inset: 0, zIndex: 0 }}>
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${splashBgUrl(theme)})` }}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-keep-bg/70 via-keep-bg/60 to-keep-bg/85" />
          {dark ? (
            <>
              <div
                className="pointer-events-none absolute -left-32 -top-32 h-[28rem] w-[28rem]"
                style={{ background: "radial-gradient(circle, rgba(63,165,160,0.30) 0%, rgba(63,165,160,0.10) 35%, transparent 70%)" }}
              />
              <div
                className="pointer-events-none absolute -bottom-32 -right-32 h-[32rem] w-[32rem]"
                style={{ background: "radial-gradient(circle, rgba(220,230,255,0.18) 0%, rgba(220,230,255,0.06) 40%, transparent 75%)" }}
              />
            </>
          ) : null}
        </div>,
        document.body,
      )}

      <div className="relative z-10 mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-8 md:py-12">
        <header className="flex flex-col items-center gap-3 text-center">
          <a
            href="/"
            onClick={(e) => { e.preventDefault(); navigate("/"); }}
            className="inline-flex flex-col items-center gap-2"
            aria-label={`${siteName} home`}
          >
            {branding.logoUrl ? (
              <img
                src={branding.logoUrl}
                alt={siteName}
                className="h-16 w-auto max-w-[260px] object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)]"
              />
            ) : (
              <span className="font-action text-4xl drop-shadow" style={{ fontFamily: "var(--keep-logo-font)" }}>
                {siteName}
              </span>
            )}
          </a>
          <p className="text-sm uppercase tracking-[0.35em] text-keep-muted">Top Communities</p>
          <div className="mt-1 flex items-center gap-4">
            <button
              type="button"
              onClick={addYourSite}
              className="inline-flex items-center gap-1.5 rounded-lg border border-keep-action bg-keep-action px-5 py-2.5 text-sm font-semibold uppercase tracking-widest text-keep-bg shadow-[0_6px_20px_-8px_rgb(var(--keep-action)/0.6)] transition hover:brightness-110 active:brightness-95"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add Your Site
            </button>
            <a
              href="/"
              onClick={(e) => { e.preventDefault(); navigate("/"); }}
              className="text-sm text-keep-muted hover:text-keep-action"
            >
              ← Back
            </a>
          </div>
        </header>

        <div className="rounded-2xl border border-keep-border/60 bg-keep-bg/55 p-4 shadow-[0_20px_60px_-24px_rgba(0,0,0,0.75)] ring-1 ring-white/5 backdrop-blur-xl md:p-6">
          {cards === null ? (
            <p className="py-10 text-center text-sm italic text-keep-muted">Gathering communities…</p>
          ) : (
            <CommunityBoard
              cards={cards}
              size="large"
              emptyText="No communities listed yet. Be the first — hit Add Your Site."
            />
          )}
        </div>
      </div>
    </div>
  );
}
