import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, MODAL_CARD_CONTENT } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";
import { sanitizeUserHtml, sweepOrphanedUserBioStyles, USER_HTML_SCOPE_CLASS } from "../../lib/userHtml.js";
import { useRulesHashHighlight } from "../../lib/rulesHashHighlight.js";
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
 * The privacy notice is rendered above the rules, in an action-tinted
 * band, so the admin-can't-read-privates contract is the first thing
 * users see.
 */
export function RulesModal({ onClose }: Props) {
  // Which server's rules are we resolving? Same source the earning
  // dashboard reads `/earning/me` with. Null (flag-off / no active
  // server) sends no `serverId`, so the backend returns appRules only
  // and the modal collapses to the single-rules view.
  const currentServerId = useChat((s) => s.currentServerId);

  const [data, setData] = useState<RulesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<RulesTab>("app");
  const rulesRef = useRef<HTMLDivElement>(null);

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
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<RulesPayload>;
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, [currentServerId]);

  // Sweep any orphaned scoped <style> blocks when the modal unmounts (same
  // belt-and-suspenders cleanup bios use, so admin CSS never bleeds onward).
  useEffect(() => () => sweepOrphanedUserBioStyles(), []);

  const sanitizedActive = useMemo(
    () => (activeHtml.trim() ? sanitizeUserHtml(activeHtml) : ""),
    [activeHtml],
  );

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-bg`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-keep-border bg-keep-panel px-4 py-2">
          <h2 className="font-action text-lg">Rules</h2>
          <CloseButton onClick={onClose} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
          ) : !data ? (
            <div className="text-keep-muted">loading...</div>
          ) : (
            <div className="space-y-4">
              {data.securityNoticeHtml.trim() ? (
                <div
                  className={`prose prose-sm max-w-none rounded border border-keep-action/40 bg-keep-action/5 p-3 ${USER_HTML_SCOPE_CLASS}`}
                  dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(data.securityNoticeHtml) }}
                />
              ) : null}

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
                    App Rules
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
                    Server Rules
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
                    ? "This server has not posted its own rules."
                    : "No rules have been posted yet."}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-keep-border bg-keep-panel/40 px-4 py-2 text-[10px] text-keep-muted">
          Press <kbd className="rounded border border-keep-border bg-keep-bg px-1">Esc</kbd> to close.
        </div>
      </div>
    </Modal>
  );
}
