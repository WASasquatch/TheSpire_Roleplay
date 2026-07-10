import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FloatingWindow } from "../shared/FloatingWindow.js";
import { BackToTop } from "../shared/BackToTop.js";
import { sanitizeUserHtml, sweepOrphanedUserBioStyles, USER_HTML_SCOPE_CLASS } from "../../lib/userHtml.js";
import { useRulesHashHighlight } from "../../lib/rulesHashHighlight.js";
import { useReducedMotion } from "../../lib/reducedMotion.js";
import { useChat } from "../../state/store.js";

/**
 * Multi-Server Lift rules payload. Rules are now two things:
 *
 *   appRules     the global, app-wide governing rules. Always shown,
 *                on every server and on the site. Authored in the
 *                global Admin Panel (Rules tab).
 *   serverRules  the active server's own rules. Shown only when the
 *                server has posted some (non-null); authored in that
 *                server's Server Admin → Settings.
 *
 * `securityNoticeHtml` is the privacy/safety notice. The backend lane
 * resolves it (and the welcome copy) per-server into the same field the
 * client already consumes, so nothing changes for it here.
 */
interface RulesPayload {
  appRules: string | null;
  serverRules: string | null;
  securityNoticeHtml: string;
}

interface Props {
  onClose: () => void;
}

type RulesTab = "app" | "server";

/**
 * Rules modal - shows the app-wide governing rules and, when the active
 * server has its own, that server's rules as a second tab, plus a
 * privacy/safety notice. All bodies are sanitized server-side on save
 * (same allow-list as profile bios); we re-sanitize with DOMPurify on
 * render as defense in depth against any malicious payload that slipped
 * through historical inserts.
 *
 * Two tabs:
 *   "App Rules"    the global governing rules. Always present; default tab.
 *   "Server Rules" the active server's own rules. Shown only when the
 *                  active server has posted rules (serverRules non-null).
 *
 * With no active server (or a server that hasn't posted rules) only the
 * App Rules tab renders, so the view is byte-identical to the old
 * single-rules modal.
 *
 * Layout: in wide WINDOWS (container query on the FloatingWindow content
 * box, not the viewport) the privacy statement and the rules render as
 * two INDEPENDENTLY SCROLLING columns (privacy left, rules right), each
 * under its own header. The privacy statement grew into a full policy
 * document; stacked above the rules it buried them below several screens
 * of scrolling. In narrow windows the columns stack with the RULES first
 * for the same reason. The privacy body keeps its action-tinted band.
 */
export function RulesModal({ onClose }: Props) {
  const { t } = useTranslation("servers");
  // Which server's rules are we resolving? Same source the earning
  // dashboard reads `/earning/me` with. Null (flag-off / no active
  // server) sends no `serverId`, so the backend returns appRules only
  // and the modal collapses to the single-rules view.
  const currentServerId = useChat((s) => s.currentServerId);

  const [data, setData] = useState<RulesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<RulesTab>("app");
  const rulesRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  // The mobile scroll container (state, not a plain ref, so BackToTop
  // re-renders and attaches its listener once the element mounts).
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const privacySectionRef = useRef<HTMLElement>(null);
  const rulesSectionRef = useRef<HTMLElement>(null);
  // Active state for the mobile jump tabs (privacy stacks first).
  const [activeJump, setActiveJump] = useState<"privacy" | "rules">("privacy");

  const hasServerRules = !!data?.serverRules?.trim();
  const activeTab: RulesTab = tab === "server" && hasServerRules ? "server" : "app";
  const activeHtml = activeTab === "server" ? data?.serverRules ?? "" : data?.appRules ?? "";

  // Highlight + scroll to a rule when the hash points at one (deep link
  // or an in-rules anchor click), once the active tab's rules HTML is
  // injected.
  useRulesHashHighlight(rulesRef, !!activeHtml.trim());

  useEffect(() => {
    let cancelled = false;
    const url = currentServerId
      ? `/api/rules?serverId=${encodeURIComponent(currentServerId)}`
      : "/api/rules";
    fetch(url, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(t("shared.httpStatus", { status: r.status }));
        return r.json() as Promise<RulesPayload>;
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : t("shared.loadFailed")); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentServerId]);

  // Sweep any orphaned scoped <style> blocks when the modal unmounts (same
  // belt-and-suspenders cleanup bios use, so admin CSS never bleeds onward).
  useEffect(() => () => sweepOrphanedUserBioStyles(), []);

  // Flip the mobile jump-tab highlight as the stacked sections scroll past
  // the sticky bar. No-ops on desktop where the tabs are hidden.
  useEffect(() => {
    if (!scrollerEl) return;
    const onScroll = () => {
      const containerTop = scrollerEl.getBoundingClientRect().top;
      const top = rulesSectionRef.current?.getBoundingClientRect().top;
      setActiveJump(top !== undefined && top - containerTop <= 64 ? "rules" : "privacy");
    };
    scrollerEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollerEl.removeEventListener("scroll", onScroll);
  }, [scrollerEl]);

  const jumpTo = (which: "privacy" | "rules") => {
    const el = which === "privacy" ? privacySectionRef.current : rulesSectionRef.current;
    el?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  };

  const sanitizedActive = useMemo(
    () => (activeHtml.trim() ? sanitizeUserHtml(activeHtml) : ""),
    [activeHtml],
  );

  const hasPrivacy = !!data?.securityNoticeHtml.trim();

  // The rules half (tabs + body) is identical in both layouts, so build it
  // once and slot it into whichever wrapper applies.
  const rulesBlock = data ? (
    <div className="space-y-4">
      {/* Tabs. The Server Rules tab only renders when the active
          server has posted its own rules; otherwise the row holds
          the App Rules tab alone, matching the old single view. */}
      {hasServerRules ? (
        <div className="flex gap-1 border-b border-keep-border" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "app"}
            onClick={() => setTab("app")}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-action ${
              activeTab === "app"
                ? "border-keep-action text-keep-text"
                : "border-transparent text-keep-muted hover:text-keep-text"
            }`}
          >
            {t("rules.appTab")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "server"}
            onClick={() => setTab("server")}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-action ${
              activeTab === "server"
                ? "border-keep-action text-keep-text"
                : "border-transparent text-keep-muted hover:text-keep-text"
            }`}
          >
            {t("rules.serverTab")}
          </button>
        </div>
      ) : null}

      {sanitizedActive ? (
        <div
          key={activeTab}
          ref={rulesRef}
          className={`prose prose-sm max-w-none ${USER_HTML_SCOPE_CLASS}`}
          dangerouslySetInnerHTML={{ __html: sanitizedActive }}
        />
      ) : (
        <p className="italic text-keep-muted">
          {activeTab === "server"
            ? t("rules.serverNone")
            : t("rules.none")}
        </p>
      )}
    </div>
  ) : null;

  const columnHeading =
    "mb-2 shrink-0 border-b border-keep-border pb-1.5 font-action text-sm uppercase tracking-widest text-keep-muted";

  return (
    <FloatingWindow onClose={onClose} zIndex={50} title={t("rules.title")} className="keep-frame rounded bg-keep-bg">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={setScrollerEl}
          className={`min-h-0 flex-1 px-5 py-4 ${hasPrivacy ? "overflow-y-auto [@container(min-width:1024px)]:overflow-hidden" : "overflow-y-auto"}`}
        >
          {error ? (
            <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
          ) : !data ? (
            <div className="text-keep-muted">{t("rules.loading")}</div>
          ) : hasPrivacy ? (
            <>
              {/* Narrow-window sticky jump tabs — either document one tap away
                  while the two stack. Hidden once the WINDOW is wide enough
                  for the columns to sit side by side. */}
              <nav
                aria-label={t("rules.jumpAria")}
                className="sticky top-0 z-10 -mx-5 -mt-4 mb-3 flex gap-1 border-b border-keep-border bg-keep-bg/95 px-5 py-2 backdrop-blur [@container(min-width:1024px)]:hidden"
              >
                <button
                  type="button"
                  onClick={() => jumpTo("privacy")}
                  aria-current={activeJump === "privacy" ? "true" : undefined}
                  className={`rounded-full border px-3 py-1 text-xs font-action uppercase tracking-widest ${
                    activeJump === "privacy"
                      ? "border-keep-action bg-keep-action/15 text-keep-text"
                      : "border-keep-border text-keep-muted"
                  }`}
                >
                  {t("rules.privacyTab")}
                </button>
                <button
                  type="button"
                  onClick={() => jumpTo("rules")}
                  aria-current={activeJump === "rules" ? "true" : undefined}
                  className={`rounded-full border px-3 py-1 text-xs font-action uppercase tracking-widest ${
                    activeJump === "rules"
                      ? "border-keep-action bg-keep-action/15 text-keep-text"
                      : "border-keep-border text-keep-muted"
                  }`}
                >
                  {t("rules.title")}
                </button>
              </nav>
              <div className="grid grid-cols-1 gap-x-6 gap-y-6 [@container(min-width:1024px)]:h-full [@container(min-width:1024px)]:grid-cols-2 [@container(min-width:1024px)]:grid-rows-[minmax(0,1fr)]">
                {/* Privacy column: left in wide windows, first when stacked. */}
                <section
                  ref={privacySectionRef}
                  className="flex min-h-0 min-w-0 scroll-mt-12 flex-col [@container(min-width:1024px)]:scroll-mt-0"
                  aria-labelledby="rules-privacy-heading"
                >
                  <h3 id="rules-privacy-heading" className={columnHeading}>
                    {t("rules.privacyColumn")}
                  </h3>
                  <div className="[@container(min-width:1024px)]:min-h-0 [@container(min-width:1024px)]:flex-1 [@container(min-width:1024px)]:overflow-y-auto [@container(min-width:1024px)]:pr-1.5">
                    <div
                      className={`prose prose-sm max-w-none ${USER_HTML_SCOPE_CLASS}`}
                      dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(data.securityNoticeHtml) }}
                    />
                  </div>
                </section>

                {/* Rules column: right in wide windows, below privacy when
                    stacked (the sticky tabs keep it one tap away). */}
                <section
                  ref={rulesSectionRef}
                  className="flex min-h-0 min-w-0 scroll-mt-12 flex-col [@container(min-width:1024px)]:scroll-mt-0"
                  aria-labelledby="rules-rules-heading"
                >
                  <h3 id="rules-rules-heading" className={columnHeading}>
                    {t("rules.title")}
                  </h3>
                  <div className="[@container(min-width:1024px)]:min-h-0 [@container(min-width:1024px)]:flex-1 [@container(min-width:1024px)]:overflow-y-auto [@container(min-width:1024px)]:pr-1.5">
                    {rulesBlock}
                  </div>
                </section>
              </div>
              <BackToTop scroller={scrollerEl} className="absolute bottom-12 right-4 [@container(min-width:1024px)]:hidden" />
            </>
          ) : (
            rulesBlock
          )}
        </div>

      </div>
    </FloatingWindow>
  );
}
