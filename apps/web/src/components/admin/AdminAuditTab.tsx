import { useEffect, useState } from "react";
import type { AuditEntry } from "@thekeep/shared";
import { AUDIT_ACTION_GROUPS } from "@thekeep/shared";
import { readError } from "../../lib/http.js";

/* =========================================================
 *  Audit tab, append-only feed of admin/mod actions
 * ========================================================= */
export function AuditTab() {
  const [actionFilter, setActionFilter] = useState("");
  // Category preset bundles multiple action strings into a single
  // ?actions= query so the feed can render e.g. "all permission
  // changes" without pasting four names into the text filter.
  // "all" / "" means no preset; the text input still works alongside.
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    const params = new URLSearchParams();
    if (actionFilter) params.set("action", actionFilter);
    const groupActions = AUDIT_ACTION_GROUPS[groupFilter]?.actions ?? [];
    if (groupActions.length > 0) params.set("actions", groupActions.join(","));
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetch(`/admin/audit${qs}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<{ entries: AuditEntry[] }>;
      })
      .then((j) => { if (!cancelled) setEntries(j.entries); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, [actionFilter, groupFilter, refreshKey]);

  return (
    <section className="space-y-2 text-sm">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="font-action text-base">Audit log</h3>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            aria-label="Audit category"
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5"
          >
            {Object.entries(AUDIT_ACTION_GROUPS).map(([key, group]) => (
              <option key={key} value={key}>{group.label}</option>
            ))}
          </select>
          <input
            type="text"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value.trim())}
            placeholder="Filter by action (e.g. ban)"
            className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 sm:flex-none"
          />
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="shrink-0 rounded border border-keep-rule bg-keep-banner/40 px-2 py-0.5 hover:bg-keep-banner"
          >
            Refresh
          </button>
        </div>
      </header>
      {error ? <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div> : null}
      {entries === null ? (
        <p className="italic text-keep-muted">Loading audit entries...</p>
      ) : entries.length === 0 ? (
        <p className="italic text-keep-muted">No matching entries.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.id} className="rounded border border-keep-rule/60 bg-keep-bg p-2 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span>
                  <span className="font-mono uppercase text-keep-action">{e.action}</span>
                  {" · "}
                  <span className="font-semibold">{e.actorDisplayName}</span>
                  {e.targetDisplayName ? (
                    <>
                      {" → "}
                      <span className="font-semibold">{e.targetDisplayName}</span>
                    </>
                  ) : null}
                  {e.targetRoomName ? (
                    <>
                      {" in "}
                      <span className="italic">{e.targetRoomName}</span>
                    </>
                  ) : null}
                </span>
                <span className="text-keep-muted" title={new Date(e.createdAt).toLocaleString()}>
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
              {e.reason ? <div className="mt-1 italic">"{e.reason}"</div> : null}
              {e.metadata && Object.keys(e.metadata).length > 0 ? (
                <div className="mt-1 font-mono text-[10px] text-keep-muted">
                  {JSON.stringify(e.metadata)}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
