import { useEffect, useMemo, useState } from "react";
import {
  PROFILE_MARQUEE_MAX_QUOTES,
  PROFILE_MARQUEE_QUOTE_MAX_LEN,
  markdownToHtml,
  type ProfileMarqueeConfig,
  type ProfileVisitorOwnerSummary,
} from "@thekeep/shared";
import { sanitizeUserHtml } from "../../lib/userHtml.js";
import { readError, withIdentityQuery } from "../../lib/http.js";

/**
 * Self-contained editor for the two profile-customization Flair
 * surfaces. Fetches its own data via `/me/profile-flair` so it
 * doesn't depend on the earning-snapshot wiring inside
 * `ProfileEditor`, drop it into any owner-side panel and it
 * handles ownership gating, save persistence, and live preview on
 * its own.
 *
 * Per-identity scoping mirrors the rest of the flair system: pass
 * the matching `characterId` (or `null` for master / OOC) and the
 * editor reads + writes the correct row.
 */
export function ProfileFlairEditor({ characterId }: { characterId: string | null }) {
  const [marquee, setMarquee] = useState<ProfileMarqueeConfig | null>(null);
  const [visitors, setVisitors] = useState<ProfileVisitorOwnerSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quotesDraft, setQuotesDraft] = useState<string[]>([]);
  const [visitorsVisibleDraft, setVisitorsVisibleDraft] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(withIdentityQuery("/me/profile-flair", characterId), { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { marquee: ProfileMarqueeConfig; visitors: ProfileVisitorOwnerSummary };
      setMarquee(j.marquee);
      setVisitors(j.visitors);
      setQuotesDraft(j.marquee.quotes);
      setVisitorsVisibleDraft(j.visitors.visible);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [characterId]);

  async function saveQuotes(next: string[]) {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(withIdentityQuery("/me/profile-flair", characterId), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quotes: next }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }
  async function saveVisibility(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(withIdentityQuery("/me/profile-flair", characterId), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ showVisitorsCount: next }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-xs italic text-keep-muted">Loading profile-flair settings…</p>;
  if (!marquee || !visitors) return null;

  return (
    <div className="space-y-4">
      {error ? <p className="text-xs text-keep-accent">{error}</p> : null}

      {/* ----- Visitors counter ----- */}
      <fieldset className="rounded border border-keep-rule p-3">
        <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
          Profile visitors
        </legend>
        {visitors.ownsFlair ? (
          <>
            <p className="mb-2 text-[10px] text-keep-muted">
              Distinct visitors counted with one-per-day dedupe.
              Members are signed-in viewers; external counts anonymous traffic.
            </p>
            <dl className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded border border-keep-rule bg-keep-bg/40 p-2">
                <dt className="text-[10px] uppercase tracking-widest text-keep-muted">Members</dt>
                <dd className="text-base tabular-nums">{visitors.members}</dd>
              </div>
              <div className="rounded border border-keep-rule bg-keep-bg/40 p-2">
                <dt className="text-[10px] uppercase tracking-widest text-keep-muted">External</dt>
                <dd className="text-base tabular-nums">{visitors.external}</dd>
              </div>
              <div className="rounded border border-keep-rule bg-keep-bg/40 p-2">
                <dt className="text-[10px] uppercase tracking-widest text-keep-muted">Total</dt>
                <dd className="text-base tabular-nums">{visitors.total}</dd>
              </div>
            </dl>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={visitorsVisibleDraft}
                disabled={saving}
                onChange={(e) => {
                  setVisitorsVisibleDraft(e.target.checked);
                  void saveVisibility(e.target.checked);
                }}
              />
              <span>Show the visitors counter on my public profile.</span>
            </label>
          </>
        ) : (
          <p className="text-xs italic text-keep-muted">
            Purchase the <b>Profile Visitor Counter</b> Flair to track and display visitor counts.
          </p>
        )}
      </fieldset>

      {/* ----- Marquee quotes ----- */}
      <fieldset className="rounded border border-keep-rule p-3">
        <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
          Quote marquee
        </legend>
        {marquee.ownsFlair ? (
          <>
            <p className="mb-2 text-[10px] text-keep-muted">
              Up to {PROFILE_MARQUEE_MAX_QUOTES} short quotes ({PROFILE_MARQUEE_QUOTE_MAX_LEN} characters each) that rotate on your profile every ~8 seconds. Markdown supported.
            </p>
            <QuotesEditor
              value={quotesDraft}
              onChange={setQuotesDraft}
              disabled={saving}
              onSave={() => void saveQuotes(quotesDraft)}
              originalSaved={marquee.quotes}
            />
          </>
        ) : (
          <p className="text-xs italic text-keep-muted">
            Purchase the <b>Profile Quote Marquee</b> Flair to add rotating quotes to your profile.
          </p>
        )}
      </fieldset>
    </div>
  );
}

/**
 * Standalone "Show visitors counter on public profile" toggle for
 * the Privacy tab, mirrors the checkbox in {@link ProfileFlairEditor}
 * so users who instinctively look for visibility toggles under
 * Privacy find it there too. Self-saving: fires PUT
 * `/me/profile-flair` immediately on change.
 *
 * Renders nothing when the viewer doesn't own
 * `flair_profile_visitors` for the given identity, so it doesn't
 * clutter the privacy tab for accounts that haven't bought the
 * flair. The actual count breakdown stays on the Flair tab, this
 * row is just the public-visibility switch.
 */
export function VisitorsVisibilityToggleRow({ characterId }: { characterId: string | null }) {
  const [ownsFlair, setOwnsFlair] = useState(false);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    fetch(withIdentityQuery("/me/profile-flair", characterId), { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return (await r.json()) as { visitors: ProfileVisitorOwnerSummary };
      })
      .then((j) => {
        if (cancelled) return;
        setOwnsFlair(j.visitors.ownsFlair);
        setVisible(j.visitors.visible);
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Load failed.");
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [characterId]);

  async function save(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(withIdentityQuery("/me/profile-flair", characterId), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ showVisitorsCount: next }),
      });
      if (!r.ok) throw new Error(await readError(r));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      // Revert the optimistic flip so the checkbox stays honest.
      setVisible(!next);
    } finally {
      setSaving(false);
    }
  }

  // Hidden when the user doesn't own the flair, the row is a
  // visibility control, not a purchase prompt. The shop already
  // does that job.
  if (!loaded || !ownsFlair) return null;

  return (
    <fieldset className="rounded border border-keep-rule p-3">
      <legend className="px-1 text-xs uppercase tracking-widest text-keep-muted">
        Visitor counter
      </legend>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={visible}
          disabled={saving}
          onChange={(e) => {
            const next = e.target.checked;
            setVisible(next);
            void save(next);
          }}
        />
        <span>Show the visitor counter on my public profile.</span>
      </label>
      <p className="mt-1 text-[10px] italic text-keep-muted">
        When off, only you see the member / external breakdown in Edit Profile → Flair.
      </p>
      {error ? <p className="mt-1 text-xs text-keep-accent">{error}</p> : null}
    </fieldset>
  );
}

function QuotesEditor({
  value,
  onChange,
  onSave,
  disabled,
  originalSaved,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  onSave: () => void;
  disabled: boolean;
  originalSaved: string[];
}) {
  // Always render MAX_QUOTES rows so the user has visible empty
  // slots to fill in; non-empty rows survive the save filter,
  // empty rows are dropped server-side.
  const slots = useMemo(() => {
    const padded = [...value];
    while (padded.length < PROFILE_MARQUEE_MAX_QUOTES) padded.push("");
    return padded.slice(0, PROFILE_MARQUEE_MAX_QUOTES);
  }, [value]);

  const dirty = useMemo(() => {
    const cleanedDraft = slots.map((s) => s.trim()).filter((s) => s.length > 0);
    return JSON.stringify(cleanedDraft) !== JSON.stringify(originalSaved);
  }, [slots, originalSaved]);

  return (
    <div className="space-y-2">
      {slots.map((q, i) => {
        const over = q.length > PROFILE_MARQUEE_QUOTE_MAX_LEN;
        return (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-1 w-6 shrink-0 text-right text-[10px] text-keep-muted tabular-nums">{i + 1}</span>
            <div className="flex-1">
              <textarea
                value={q}
                onChange={(e) => {
                  const next = [...slots];
                  next[i] = e.target.value;
                  onChange(next);
                }}
                disabled={disabled}
                rows={1}
                maxLength={PROFILE_MARQUEE_QUOTE_MAX_LEN * 2 /* let the user paste over so the count flag is visible */}
                placeholder="A short, memorable line…"
                className="w-full resize-y rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
              />
              <div className="flex justify-end text-[10px] text-keep-muted">
                <span className={over ? "text-keep-accent" : ""}>
                  {q.length}/{PROFILE_MARQUEE_QUOTE_MAX_LEN}
                </span>
              </div>
            </div>
          </div>
        );
      })}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={disabled || !dirty || slots.some((q) => q.length > PROFILE_MARQUEE_QUOTE_MAX_LEN)}
          onClick={onSave}
          className="rounded border border-keep-action bg-keep-action/15 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
        >
          {disabled ? "Saving…" : "Save quotes"}
        </button>
      </div>
      {slots.some((q) => q.trim().length > 0) ? (
        <div className="rounded border border-keep-rule bg-keep-bg/40 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-keep-muted">Preview</div>
          {slots.filter((q) => q.trim().length > 0).map((q, i) => (
            <div
              key={i}
              className="border-b border-keep-rule/30 py-1 text-center text-sm last:border-b-0 [&_a]:underline [&_p]:m-0 [&_p]:inline"
              dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(markdownToHtml(q.trim())) }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
