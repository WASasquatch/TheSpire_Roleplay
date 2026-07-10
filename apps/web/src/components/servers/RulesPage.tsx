import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { sanitizeUserHtml, sweepOrphanedUserBioStyles, USER_HTML_SCOPE_CLASS } from "../../lib/userHtml.js";
import { useRulesHashHighlight } from "../../lib/rulesHashHighlight.js";
import { useChat } from "../../state/store.js";
import { resolveSplashTheme, themeStyle } from "../../lib/theme.js";

interface RulesPayload {
  // The app-wide governing rules. This public page mounts BEFORE auth /
  // the chat shell, so there is no active server context here: it sends
  // no `serverId` and the backend returns `serverRules: null`, so only
  // these app rules show. (`serverRules` is typed for contract parity
  // but never rendered on this anonymous page.)
  appRules: string | null;
  serverRules: string | null;
  securityNoticeHtml: string;
}

interface Props {
  /**
   * Called when the user clicks the "Back" link in the header. The
   * caller typically pops the SPA back to whatever route mounted
   * the page (or `/` if the page was opened in a fresh tab from the
   * registration form). Optional, when omitted, the back link
   * renders as a plain `<a href="/">` so a deep-linked visitor with
   * no history still has a way out.
   */
  onBack?: () => void;
}

/**
 * Public, no-auth-required Rules page.
 *
 * Mounted by App.tsx when `window.location.pathname === "/rules"`,
 * BEFORE the AuthGate / chat shell, so an anonymous visitor (someone
 * the registration form pointed at the rules link) can read the
 * house rules and privacy notice without signing up first.
 *
 * Content is the same JSON the in-app RulesModal pulls, both
 * fetch `/api/rules`. The modal lives inside the chat shell and has
 * its own close affordance; this page wraps the same body in a
 * centered card with a "← Back" link in the header instead, so the
 * visual cue says "you are on a real page, not a popover."
 *
 * HTML bodies are sanitized server-side on save (same allow-list as
 * profile bios); we re-sanitize with DOMPurify on render as defense
 * in depth against any malicious payload that slipped through
 * historical inserts.
 */
export function RulesPage({ onBack }: Props) {
  const { t } = useTranslation("servers");
  const [data, setData] = useState<RulesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Apply the site's splash palette so this standalone public page matches the
  // rest of the site rather than the flat light :root defaults (keep-* vars are
  // otherwise unset here — the authed shell never mounts on this route).
  const branding = useChat((s) => s.branding);
  const rulesRef = useRef<HTMLDivElement>(null);
  // Deep-link highlight (e.g. /rules#3.6) once the rules HTML is injected.
  useRulesHashHighlight(rulesRef, !!data?.appRules?.trim());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/rules", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(t("shared.httpStatus", { status: r.status }));
        return r.json() as Promise<RulesPayload>;
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : t("shared.loadFailed")); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set a sensible document title so a tab landed on the rules
  // page reads as "Rules" in the browser tab strip / bookmarks
  // instead of inheriting whatever the previous SPA route set.
  useEffect(() => {
    const previous = document.title;
    document.title = t("rules.title");
    return () => { document.title = previous; };
  }, [t]);

  // Sweep orphaned scoped <style> blocks on unmount (parity with bios).
  useEffect(() => () => sweepOrphanedUserBioStyles(), []);

  const handleBackClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onBack) {
      e.preventDefault();
      onBack();
    }
    // No onBack: fall through to the anchor's href="/" so the
    // visitor still has a working "Back" action.
  };

  return (
    <main
      style={themeStyle(resolveSplashTheme(branding))}
      className="min-h-screen w-full bg-keep-bg px-4 py-6 text-keep-text md:py-10"
    >
      {/* Two-column mode gets a generous cap (100rem ≈ 1600px) so large
          displays actually use their width — each column still lands near
          a comfortable ~75-90ch reading measure at prose-sm. The single-
          column fallback keeps the tighter document width. */}
      <div className={`mx-auto flex flex-col gap-4 ${data?.securityNoticeHtml.trim() ? "max-w-[100rem]" : "max-w-3xl"}`}>
        <header className="flex items-baseline justify-between gap-2 border-b border-keep-border pb-3">
          <h1 className="font-action text-2xl">{t("rules.title")}</h1>
          <a
            href="/"
            onClick={handleBackClick}
            className="text-sm text-keep-muted hover:text-keep-action"
          >
            {t("rules.back")}
          </a>
        </header>

        {error ? (
          <div className="keep-frame rounded border border-keep-rule bg-keep-panel/40 px-5 py-4 md:px-6 md:py-5">
            <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
              {error}
            </div>
          </div>
        ) : !data ? (
          <div className="keep-frame rounded border border-keep-rule bg-keep-panel/40 px-5 py-4 md:px-6 md:py-5">
            <p className="italic text-keep-muted">{t("shared.loading")}</p>
          </div>
        ) : data.securityNoticeHtml.trim() ? (
          /* Two cards side by side on wide screens: privacy left, rules
             right, each under its own header. The privacy statement grew
             into a full policy document; stacked above the rules it buried
             them. On narrow screens they stack with the RULES first for
             the same reason. */
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <section
              className="keep-frame order-2 rounded border border-keep-rule bg-keep-panel/40 px-5 py-4 md:px-6 md:py-5 lg:order-1"
              aria-labelledby="rules-page-privacy-heading"
            >
              <h2 id="rules-page-privacy-heading" className="mb-3 border-b border-keep-border pb-2 font-action text-sm uppercase tracking-widest text-keep-muted">
                {t("rules.privacyColumn")}
              </h2>
              <div
                className={`prose prose-sm max-w-none rounded border border-keep-action/40 bg-keep-action/5 p-3 ${USER_HTML_SCOPE_CLASS}`}
                dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(data.securityNoticeHtml) }}
              />
            </section>
            <section
              className="keep-frame order-1 rounded border border-keep-rule bg-keep-panel/40 px-5 py-4 md:px-6 md:py-5 lg:order-2"
              aria-labelledby="rules-page-rules-heading"
            >
              <h2 id="rules-page-rules-heading" className="mb-3 border-b border-keep-border pb-2 font-action text-sm uppercase tracking-widest text-keep-muted">
                {t("rules.title")}
              </h2>
              {data.appRules?.trim() ? (
                <div
                  ref={rulesRef}
                  className={`prose prose-sm max-w-none ${USER_HTML_SCOPE_CLASS}`}
                  dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(data.appRules) }}
                />
              ) : (
                <p className="italic text-keep-muted">{t("rules.none")}</p>
              )}
            </section>
          </div>
        ) : (
          <div className="keep-frame rounded border border-keep-rule bg-keep-panel/40 px-5 py-4 md:px-6 md:py-5">
            {data.appRules?.trim() ? (
              <div
                ref={rulesRef}
                className={`prose prose-sm max-w-none ${USER_HTML_SCOPE_CLASS}`}
                dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(data.appRules) }}
              />
            ) : (
              <p className="italic text-keep-muted">{t("rules.none")}</p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
