import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate } from "../../lib/intlFormat.js";
import { useChat } from "../../state/store.js";

/**
 * "Birth date" row for the Privacy tab (age-restriction plan, Phase 0).
 * Shows the viewer's OWN stored date of birth from /me/profile.
 *
 * Once a date is on file it is read-only: it was set at signup (or via this
 * row) and only staff can correct it (decision #7 — self-service edits would
 * let an account flip-flop past the age gates). Legacy accounts registered
 * before the date was collected have NULL on file and get a ONE-TIME set
 * flow here: a date input plus an explicit confirm step spelling out that
 * the date is permanent and controls access to 18+ areas. The server
 * (`POST /me/birthdate`) only accepts the write while the stored date is
 * NULL, so the client gate is cosmetic.
 *
 * Self-fetching like the sibling rows (ScriptoriumPrivacyRow etc.) so a
 * staff correction shows up on the next editor open without an app reload.
 */
export function BirthDateRow() {
  const { t } = useTranslation("profile");
  const [loaded, setLoaded] = useState(false);
  const [birthdate, setBirthdate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/me/profile", { credentials: "include" });
        if (!r.ok) throw new Error(t("errors.loadFailed"));
        const j = await r.json() as { birthdate?: string | null };
        if (cancelled) return;
        setBirthdate(j.birthdate ?? null);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : t("errors.loadFailed"));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot fetch on mount; `t` only shapes error copy
  }, []);

  /** Render the stored ISO date in the viewer's locale ("July 8, 2008");
   *  fall back to the raw ISO string if the date is somehow unparseable. */
  function formatBirthdate(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return formatDate(d.getTime(), {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  /** Cosmetic mirror of the server's UTC date-only age math, used only to
   *  pick which confirm warning to show (the server re-derives on save). */
  function isUnder18(iso: string): boolean {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return false;
    const now = new Date();
    let age = now.getUTCFullYear() - d.getUTCFullYear();
    const beforeBirthday =
      now.getUTCMonth() < d.getUTCMonth() ||
      (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate());
    if (beforeBirthday) age -= 1;
    return age < 18;
  }

  /** <input type="date"> bounds: nothing under the 13-year floor, no
   *  century typos. The server enforces the same range; these just trim
   *  the picker. */
  const maxDate = new Date();
  maxDate.setUTCFullYear(maxDate.getUTCFullYear() - 13);
  const maxIso = maxDate.toISOString().slice(0, 10);
  const minIso = `${new Date().getUTCFullYear() - 130}-01-01`;

  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const confirmWasOpen = useRef(false);
  // Opening the confirm step unmounts the button that had focus, which
  // would drop keyboard focus to <body>; move it onto the warning panel
  // (and back to the date input on "Go back") so the flow stays reachable.
  useEffect(() => {
    if (confirming) {
      confirmWasOpen.current = true;
      confirmRef.current?.focus();
    } else if (confirmWasOpen.current) {
      confirmWasOpen.current = false;
      dateInputRef.current?.focus();
    }
  }, [confirming]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/me/birthdate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ birthdate: value }),
      });
      const j = await r.json().catch(() => ({} as { error?: string; isAdult?: boolean }));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      setBirthdate(value);
      setConfirming(false);
      // Keep the store's cosmetic mirror in step so age-gated surfaces pick
      // the change up live. An under-18 date also gets the account signed
      // out server-side (session:kicked lands on the socket right after),
      // so for that path this mirror only bridges the last moments.
      const cur = useChat.getState().viewerAge;
      useChat.getState().setViewerAge({
        ...cur,
        birthdate: value,
        isAdult: (j as { isAdult?: boolean }).isAdult ?? cur.isAdult,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.failedToSave"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded border border-keep-rule/40 bg-keep-panel/30 p-3">
      <header className="mb-2 flex items-baseline justify-between">
        <h4 className="font-action text-sm uppercase tracking-widest text-keep-text">{t("birthDate.title")}</h4>
        {err ? <span className="text-[10px] text-keep-accent">{err}</span> : null}
      </header>
      {!loaded && !err ? (
        <p className="text-sm text-keep-text">{t("common:loading")}</p>
      ) : birthdate ? (
        <>
          <p className="text-sm text-keep-text">{formatBirthdate(birthdate)}</p>
          {savedFlash ? <p className="mt-1 text-[10px] text-keep-system">{t("saved")}</p> : null}
          <p className="mt-1 text-xs text-keep-muted">{t("birthDate.hint")}</p>
        </>
      ) : loaded ? (
        <>
          <p className="text-sm text-keep-text">{t("birthDate.notSet")}</p>
          <p className="mt-1 text-xs text-keep-muted">{t("birthDate.setHint")}</p>
          {!confirming ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-keep-text">
                <span>{t("birthDate.inputLabel")}</span>
                <input
                  ref={dateInputRef}
                  type="date"
                  value={value}
                  min={minIso}
                  max={maxIso}
                  onChange={(e) => setValue(e.target.value)}
                  className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs text-keep-text"
                />
              </label>
              <button
                type="button"
                disabled={!value || saving}
                onClick={() => { setErr(null); setConfirming(true); }}
                className="keep-button rounded border border-keep-action bg-keep-action/20 px-2 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/30 disabled:opacity-50"
              >
                {t("birthDate.saveButton")}
              </button>
            </div>
          ) : (
            <div
              ref={confirmRef}
              tabIndex={-1}
              role="alert"
              className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-text"
            >
              <p className="font-semibold">{t("birthDate.confirmTitle")}</p>
              <p className="mt-1">{t("birthDate.confirmDate", { date: formatBirthdate(value) })}</p>
              <p className="mt-1 text-keep-muted">{t("birthDate.confirmPermanent")}</p>
              {isUnder18(value) ? (
                <p className="mt-1 text-keep-accent">{t("birthDate.confirmMinor")}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setConfirming(false)}
                  className="keep-button rounded border border-keep-rule px-2 py-1 text-xs hover:bg-keep-banner disabled:opacity-50"
                >
                  {t("birthDate.confirmCancel")}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void save()}
                  className="keep-button rounded border border-keep-action bg-keep-action/20 px-2 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/30 disabled:opacity-50"
                >
                  {t("birthDate.confirmSave")}
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
