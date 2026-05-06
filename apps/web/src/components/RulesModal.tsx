import { useEffect, useState } from "react";
import DOMPurify from "dompurify";

interface RulesPayload {
  rulesHtml: string;
  securityNoticeHtml: string;
}

interface Props {
  onClose: () => void;
}

/**
 * Rules modal — shows admin-authored house rules plus a privacy/safety
 * notice. Both bodies are sanitized server-side on save (same allow-list as
 * profile bios); we re-sanitize with DOMPurify on render as defense in depth
 * against any malicious payload that slipped through historical inserts.
 *
 * The privacy notice is rendered above the rules, in an action-tinted band,
 * so the admin-can't-read-privates contract is the first thing users see.
 */
export function RulesModal({ onClose }: Props) {
  const [data, setData] = useState<RulesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/rules", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<RulesPayload>;
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[85vh] w-[min(720px,98vw)] flex-col rounded border border-keep-border bg-keep-bg shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-keep-border bg-keep-panel px-4 py-2">
          <h2 className="font-action text-lg">Rules</h2>
          <button onClick={onClose} className="text-sm text-keep-muted hover:text-keep-text">close</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
          ) : !data ? (
            <div className="text-keep-muted">loading…</div>
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

        <div className="shrink-0 border-t border-keep-border bg-keep-panel/40 px-4 py-2 text-[10px] text-keep-muted">
          Press <kbd className="rounded border border-keep-border bg-keep-bg px-1">Esc</kbd> to close.
        </div>
      </div>
    </div>
  );
}
