import { useEffect, useState } from "react";
import DOMPurify from "dompurify";

interface RulesPayload {
  rulesHtml: string;
  securityNoticeHtml: string;
}

interface Props {
  /**
   * Called when the user clicks the "Back" link in the header. The
   * caller typically pops the SPA back to whatever route mounted
   * the page (or `/` if the page was opened in a fresh tab from the
   * registration form). Optional — when omitted, the back link
   * renders as a plain `<a href="/">` so a deep-linked visitor with
   * no history still has a way out.
   */
  onBack?: () => void;
}

/**
 * Public, no-auth-required Rules page.
 *
 * Mounted by App.tsx when `window.location.pathname === "/rules"` —
 * BEFORE the AuthGate / chat shell, so an anonymous visitor (someone
 * the registration form pointed at the rules link) can read the
 * house rules and privacy notice without signing up first.
 *
 * Content is the same JSON the in-app RulesModal pulls — both
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
  const [data, setData] = useState<RulesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/rules", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<RulesPayload>;
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, []);

  // Set a sensible document title so a tab landed on the rules
  // page reads as "Rules" in the browser tab strip / bookmarks
  // instead of inheriting whatever the previous SPA route set.
  useEffect(() => {
    const previous = document.title;
    document.title = "Rules";
    return () => { document.title = previous; };
  }, []);

  const handleBackClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onBack) {
      e.preventDefault();
      onBack();
    }
    // No onBack: fall through to the anchor's href="/" so the
    // visitor still has a working "Back" action.
  };

  return (
    <main className="min-h-screen w-full bg-keep-bg px-4 py-6 text-keep-text md:py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <header className="flex items-baseline justify-between gap-2 border-b border-keep-border pb-3">
          <h1 className="font-action text-2xl">Rules</h1>
          <a
            href="/"
            onClick={handleBackClick}
            className="text-sm text-keep-muted hover:text-keep-action"
          >
            ← Back
          </a>
        </header>

        <div className="keep-frame rounded border border-keep-rule bg-keep-panel/40 px-5 py-4 md:px-6 md:py-5">
          {error ? (
            <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
              {error}
            </div>
          ) : !data ? (
            <p className="italic text-keep-muted">Loading…</p>
          ) : (
            <div className="space-y-4">
              {data.securityNoticeHtml.trim() ? (
                <div
                  className="prose prose-sm max-w-none rounded border border-keep-action/40 bg-keep-action/5 p-3"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(data.securityNoticeHtml) }}
                />
              ) : null}
              {data.rulesHtml.trim() ? (
                <div
                  className="prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(data.rulesHtml) }}
                />
              ) : (
                <p className="italic text-keep-muted">No rules have been posted yet.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
