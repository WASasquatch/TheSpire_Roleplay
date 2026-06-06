import { useEffect, useState } from "react";
import { STORY_CONTENT_WARNINGS } from "@thekeep/shared";

/**
 * Scriptorium catalog privacy toggle, a self-saving CW blocklist
 * that PATCHes `/me/profile` on each change:
 *
 *   cw-blocklist , content warnings the user wants filtered OUT of
 *                   the catalog entirely. Cards tagged with ANY
 *                   blocklisted warning are hidden (not just blurred).
 *
 * The legacy `storyShowNsfw` opt-in toggle was removed: signed-in
 * viewers now see every rating by default (the body-open splash
 * warning is the gate), so the toggle had no behavior to control.
 * The DB column stays (harmless dead state) so existing rows aren't
 * migrated; the API still accepts the field for backward compat
 * with any in-flight clients, but nothing reads it server-side any
 * more.
 *
 * Same self-saving pattern as DisplayPrivacyRow + CurrencyPrivacyRow:
 * optimistic update with revert-on-fail.
 */
export function ScriptoriumPrivacyRow() {
  const [loaded, setLoaded] = useState(false);
  const [cwBlocklist, setCwBlocklist] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/me/profile", { credentials: "include" });
        if (!r.ok) throw new Error("load failed");
        const j = await r.json() as {
          storyCwBlocklist?: string[];
        };
        if (cancelled) return;
        setCwBlocklist(j.storyCwBlocklist ?? []);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "load failed");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function save(patch: { storyCwBlocklist?: string[] }) {
    setBusy(true);
    setErr(null);
    setSavedFlash(false);
    try {
      const r = await fetch("/me/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error("save failed");
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  function toggleCw(cw: string) {
    const has = cwBlocklist.includes(cw);
    const next = has ? cwBlocklist.filter((x) => x !== cw) : [...cwBlocklist, cw];
    const prev = cwBlocklist;
    setCwBlocklist(next);
    void save({ storyCwBlocklist: next }).catch(() => setCwBlocklist(prev));
  }

  if (!loaded) {
    return <p className="text-xs italic text-keep-muted">Loading Scriptorium privacy…</p>;
  }

  return (
    <section className="rounded border border-keep-rule/40 bg-keep-panel/30 p-3">
      <header className="mb-2 flex items-baseline justify-between">
        <h4 className="font-action text-sm uppercase tracking-widest text-keep-text">Scriptorium</h4>
        {savedFlash ? <span className="text-[10px] italic text-keep-action">saved</span> : null}
        {err ? <span className="text-[10px] text-keep-accent">{err}</span> : null}
      </header>
      <p className="mb-3 text-xs text-keep-muted">
        Catalog preferences for long-form stories. Anonymous viewers see up to R; signed-in
        viewers see every rating and get a splash warning before opening mature content.
      </p>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">
          Always hide stories tagged
        </label>
        <p className="mt-1 text-xs text-keep-muted">
          Cards carrying any of these warnings are hidden from the catalog entirely. Not blurred, just gone.
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {STORY_CONTENT_WARNINGS.map((cw) => {
            const on = cwBlocklist.includes(cw);
            return (
              <button
                key={cw}
                type="button"
                disabled={busy}
                onClick={() => toggleCw(cw)}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                  on
                    ? "border-keep-accent bg-keep-accent/15 text-keep-accent"
                    : "border-keep-rule bg-keep-bg text-keep-muted hover:text-keep-text"
                }`}
              >
                {cw}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
