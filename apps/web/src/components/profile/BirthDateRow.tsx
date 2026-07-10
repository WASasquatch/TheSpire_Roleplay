import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate } from "../../lib/intlFormat.js";

/**
 * Read-only "Birth date" row for the Privacy tab (age-restriction plan,
 * Phase 0). Shows the viewer's OWN stored date of birth from /me/profile.
 * Deliberately no edit control: the date is set once at signup and only
 * staff can correct it (decision #7 — self-service edits would let an
 * account flip-flop past the age gates). Legacy accounts registered
 * before the date was collected show "Not set" (they count as adults).
 *
 * Self-fetching like the sibling rows (ScriptoriumPrivacyRow etc.) so a
 * staff correction shows up on the next editor open without an app reload.
 */
export function BirthDateRow() {
  const { t } = useTranslation("profile");
  const [loaded, setLoaded] = useState(false);
  const [birthdate, setBirthdate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

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

  return (
    <section className="rounded border border-keep-rule/40 bg-keep-panel/30 p-3">
      <header className="mb-2 flex items-baseline justify-between">
        <h4 className="font-action text-sm uppercase tracking-widest text-keep-text">{t("birthDate.title")}</h4>
        {err ? <span className="text-[10px] text-keep-accent">{err}</span> : null}
      </header>
      <p className="text-sm text-keep-text">
        {!loaded && !err
          ? t("common:loading")
          : birthdate
            ? formatBirthdate(birthdate)
            : t("birthDate.notSet")}
      </p>
      <p className="mt-1 text-xs text-keep-muted">
        {t("birthDate.hint")}
      </p>
    </section>
  );
}
