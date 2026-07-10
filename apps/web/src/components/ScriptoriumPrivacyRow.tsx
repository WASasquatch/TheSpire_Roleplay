import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { STORY_CONTENT_WARNINGS } from "@thekeep/shared";
import { useChat } from "../state/store.js";

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
  const { t } = useTranslation("scriptorium");
  const viewerIsAdult = useChat((s) => s.viewerAge.isAdult);
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
        if (!r.ok) throw new Error(t("errors.loadFailed"));
        const j = await r.json() as {
          storyCwBlocklist?: string[];
        };
        if (cancelled) return;
        setCwBlocklist(j.storyCwBlocklist ?? []);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : t("errors.loadFailed"));
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
      if (!r.ok) throw new Error(t("errors.saveFailed"));
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.saveFailed"));
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
    return <p className="text-xs italic text-keep-muted">{t("privacy.loading")}</p>;
  }

  return (
    <section className="rounded border border-keep-rule/40 bg-keep-panel/30 p-3">
      <header className="mb-2 flex items-baseline justify-between">
        <h4 className="font-action text-sm uppercase tracking-widest text-keep-text">{t("privacy.title")}</h4>
        {savedFlash ? <span className="text-[10px] italic text-keep-action">{t("privacy.savedFlash")}</span> : null}
        {err ? <span className="text-[10px] text-keep-accent">{err}</span> : null}
      </header>
      {/* The CW blocklist is rating-independent (gore or self-harm tags
          appear on PG-13 stories too), so under-18 accounts keep it. Only
          the sentence describing the adult rating behavior swaps out —
          their catalog is clamped to G / PG / PG-13 server-side (age plan
          Phase 4), so that copy would be wrong for them. */}
      <p className="mb-3 text-xs text-keep-muted">
        {viewerIsAdult ? t("privacy.introAdult") : t("privacy.intro")}
      </p>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">
          {t("privacy.alwaysHideLabel")}
        </label>
        <p className="mt-1 text-xs text-keep-muted">
          {t("privacy.alwaysHideHint")}
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
