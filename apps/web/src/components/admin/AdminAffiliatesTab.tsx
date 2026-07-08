import { useEffect, useState, type FormEvent } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { AffiliateCard } from "../marketing/AffiliateCard.js";
import { TagInput } from "../shared/TagInput.js";
import {
  AFFILIATE_LIMITS,
  adminCreateAffiliate,
  adminDeleteAffiliate,
  adminUpdateAffiliate,
  fetchAdminAffiliates,
  isValidAffiliateUrl,
  linkBackUrl,
  type AdminAffiliate,
  type PublicAffiliateCard,
} from "../../lib/affiliates.js";

/* =========================================================
 *  Affiliates tab, "Roleplay Communities" card manager (Affiliates v2)
 * =========================================================
 *
 * Card-first manager backed by GET/POST/PATCH/DELETE /admin/affiliates
 * (via the admin lib in lib/affiliates.ts, so every write is audited
 * server-side). Three sections:
 *
 *   1. Pending approvals  — member submissions (status='pending'). Card
 *      preview + owner + submitted URLs, Approve / Reject-with-note.
 *   2. Live cards         — kind='card' structured entries (the ones that
 *      render in the public section). Editable fields, enable/disable,
 *      sort order, delete, read-only in/out click stats + copyable
 *      link-back, plus an "Add card" form for admin-authored entries.
 *   3. Legacy (HTML)      — collapsed section for the old raw-HTML rows
 *      (kind='html'). Admin-trusted verbatim HTML for topsite networks
 *      (toprpsites etc.) whose anchor + tracking-pixel snippet must NOT be
 *      sanitized. Same trust posture as customHeadHtml in Settings. These
 *      render as legacy badges, not cards.
 */

/** Status chip colouring + label, matching the house copy in plan_ext §10. */
function affiliateStatusChip(status: AdminAffiliate["status"]): { label: string; className: string } {
  switch (status) {
    case "pending":
      return { label: "Pending review", className: "border-keep-action/50 bg-keep-action/10 text-keep-action" };
    case "approved":
      return { label: "Live", className: "border-emerald-500/50 bg-emerald-500/10 text-emerald-500" };
    case "rejected":
      return { label: "Needs changes", className: "border-keep-accent/50 bg-keep-accent/10 text-keep-accent" };
    case "disabled":
    default:
      return { label: "Hidden", className: "border-keep-rule bg-keep-panel/40 text-keep-muted" };
  }
}

/** Map an admin row to the public card shape so we can reuse `AffiliateCard`
 *  for a faithful preview (same banner-as-bg + scrim treatment the splash uses). */
function toCardPreview(row: AdminAffiliate): PublicAffiliateCard {
  return {
    id: row.id,
    title: row.title || row.label || "(untitled)",
    description: row.description ?? "",
    iconUrl: row.iconUrl,
    bannerUrl: row.bannerUrl,
    clicksIn: row.clicksIn,
    clicksOut: row.clicksOut,
    tags: row.tags ?? [],
  };
}

export function AffiliatesTab() {
  const [rows, setRows] = useState<AdminAffiliate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingCard, setCreatingCard] = useState(false);
  const [creatingLegacy, setCreatingLegacy] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);

  async function load() {
    setError(null);
    try {
      setRows(await fetchAdminAffiliates());
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    }
  }
  useEffect(() => { load(); }, []);

  /** Route every write through the admin lib (PATCH/DELETE/POST) so the
   *  server records the audit entry, then refresh. Surfaces failures in the
   *  shared error banner rather than swallowing them. */
  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await adminUpdateAffiliate(id, body);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    }
  }

  async function remove(id: string, prompt: string) {
    if (!window.confirm(prompt)) return;
    try {
      await adminDeleteAffiliate(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  const pending = rows?.filter((r) => r.kind === "card" && r.status === "pending") ?? [];
  const liveCards = rows?.filter((r) => r.kind === "card" && r.status !== "pending") ?? [];
  const legacy = rows?.filter((r) => r.kind === "html") ?? [];

  return (
    <section className="space-y-5 text-sm">
      <header>
        <h3 className="font-action text-base">Top RP Communities</h3>
        <p className="mt-1 text-[11px] text-keep-muted">
          Partner community cards for the splash, ranked by traffic (busiest first). Members submit their own entries
          here for review; approved cards go live in the Top RP Communities section and each one carries a link-back the
          partner puts on their site.
        </p>
      </header>

      {error ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
      ) : null}

      {rows === null ? (
        <p className="italic text-keep-muted">Loading...</p>
      ) : (
        <>
          {/* ---- 1. Pending approvals (hidden when the queue is empty) ---- */}
          {pending.length > 0 ? (
            <div className="space-y-2">
              <h4 className="font-action text-sm">
                Pending approvals
                <span className="ml-2 rounded-full border border-keep-action/50 bg-keep-action/10 px-1.5 py-0.5 text-[10px] text-keep-action">
                  {pending.length}
                </span>
              </h4>
              <ul className="space-y-3">
                {pending.map((row) => (
                  <AffiliatePendingItem
                    key={row.id}
                    row={row}
                    onApprove={() => patch(row.id, { status: "approved" })}
                    onReject={(note) => patch(row.id, { status: "rejected", reviewNote: note })}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {/* ---- 2. Live cards + admin "Add card" ---- */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-action text-sm">Live cards</h4>
              <button
                type="button"
                onClick={() => setCreatingCard(true)}
                className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-xs hover:bg-keep-banner/80"
              >
                + Add card
              </button>
            </div>
            {creatingCard ? (
              <AffiliateCardForm
                mode="create"
                onCancel={() => setCreatingCard(false)}
                onSaved={async () => { setCreatingCard(false); await load(); }}
              />
            ) : null}
            {liveCards.length === 0 && !creatingCard ? (
              <p className="italic text-keep-muted">
                No cards yet. Add one, or approve a member submission to surface it in the Top RP Communities section.
              </p>
            ) : (
              <ul className="space-y-3">
                {liveCards.map((row) => (
                  <AffiliateCardItem
                    key={row.id}
                    row={row}
                    onPatch={(body) => patch(row.id, body)}
                    onDelete={() => remove(row.id, "Delete this card? Its click stats and link-back go with it.")}
                  />
                ))}
              </ul>
            )}
          </div>

          {/* ---- 3. Legacy raw-HTML badges (collapsed) ---- */}
          <div className="space-y-2 border-t border-keep-rule/40 pt-4">
            <button
              type="button"
              onClick={() => setLegacyOpen((o) => !o)}
              className="flex w-full items-center gap-2 text-left font-action text-sm"
              aria-expanded={legacyOpen}
            >
              {legacyOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>Legacy badges (HTML)</span>
              <span className="rounded-full border border-keep-rule bg-keep-panel/40 px-1.5 py-0.5 text-[10px] text-keep-muted">
                {legacy.length}
              </span>
            </button>
            {legacyOpen ? (
              <div className="space-y-2 pl-6">
                <p className="text-[11px] text-keep-muted">
                  Old raw-HTML entries from topsite networks (toprpsites etc.). These render as verbatim badges, not
                  cards, and are NOT sanitized so their tracking pixels pass through. Only paste HTML you trust. New
                  partners should use cards instead.
                </p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setCreatingLegacy(true)}
                    className="rounded border border-keep-rule bg-keep-banner px-2 py-0.5 text-xs hover:bg-keep-banner/80"
                  >
                    + Add legacy badge
                  </button>
                </div>
                {creatingLegacy ? (
                  <AffiliateLegacyForm
                    mode="create"
                    onCancel={() => setCreatingLegacy(false)}
                    onSaved={async () => { setCreatingLegacy(false); await load(); }}
                  />
                ) : null}
                {legacy.length === 0 && !creatingLegacy ? (
                  <p className="italic text-keep-muted">No legacy badges.</p>
                ) : (
                  <ul className="space-y-2">
                    {legacy.map((row) => (
                      <AffiliateLegacyItem
                        key={row.id}
                        row={row}
                        onPatch={(body) => patch(row.id, body)}
                        onDelete={() => remove(row.id, "Delete this legacy badge?")}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

/** A copyable read-only field (link-back / submitted URL). Mirrors the
 *  password-copy pattern already in this file: best-effort clipboard with a
 *  brief "Copied" confirmation, falling back to selecting the text. */
function CopyableUrl({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the input is still selectable to copy by hand */
    }
  }
  return (
    <label className="block">
      <span className="mb-1 block uppercase tracking-widest text-keep-muted">{label}</span>
      <div className="flex gap-1">
        <input
          type="text"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-panel/30 px-2 py-1 text-[11px] outline-none focus:border-keep-action"
        />
        <button
          type="button"
          onClick={copy}
          title="Copy to clipboard"
          aria-label="Copy to clipboard"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
    </label>
  );
}

/** One row in the pending-approvals queue: live card preview + owner +
 *  submitted URLs, with Approve and Reject (reject reveals a note field). */
function AffiliatePendingItem({
  row,
  onApprove,
  onReject,
}: {
  row: AdminAffiliate;
  onApprove: () => Promise<void>;
  onReject: (note: string) => Promise<void>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  }

  return (
    <li className="rounded border border-keep-action/40 bg-keep-bg p-2 text-xs">
      <div className="flex flex-col gap-3">
        {/* Wide card preview — the exact Top RP Communities board layout. */}
        <AffiliateCard card={toCardPreview(row)} size="large" />
        <div className="min-w-0 space-y-2">
          <div className="text-[11px] text-keep-muted">
            Submitted by <span className="font-semibold text-keep-text">{row.ownerName ?? "unknown"}</span>
          </div>
          <div className="space-y-1">
            <div className="break-all">
              <span className="text-keep-muted">Target:</span> {row.targetUrl || "(none)"}
            </div>
            {row.iconUrl ? (
              <div className="break-all"><span className="text-keep-muted">Icon:</span> {row.iconUrl}</div>
            ) : null}
            {row.bannerUrl ? (
              <div className="break-all"><span className="text-keep-muted">Banner:</span> {row.bannerUrl}</div>
            ) : null}
          </div>
          {rejecting ? (
            <div className="space-y-1">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="What needs changing? (shown to the submitter)"
                className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setRejecting(false); setNote(""); }}
                  className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-0.5 hover:bg-keep-banner"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || !note.trim()}
                  onClick={() => run(async () => { await onReject(note.trim()); })}
                  className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-3 py-0.5 text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
                >
                  {busy ? "Rejecting..." : "Confirm reject"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => run(onApprove)}
                className="keep-button rounded border border-emerald-500/50 bg-keep-bg px-3 py-0.5 text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-50"
              >
                {busy ? "Approving..." : "Approve"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setRejecting(true)}
                className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-3 py-0.5 text-keep-accent hover:bg-keep-accent/10 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** A live structured card row: preview + status chip + owner + read-only
 *  in/out stats + copyable link-back, with enable/disable, edit, delete. */
function AffiliateCardItem({
  row,
  onPatch,
  onDelete,
}: {
  row: AdminAffiliate;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const chip = affiliateStatusChip(row.status);
  // Prefer the server-approved absolute link-back; fall back to composing one
  // from the hash so the field is copyable the moment a hash exists.
  const backUrl = row.linkBackUrl ?? (row.hash ? linkBackUrl(row.hash) : null);

  if (editing) {
    return (
      <li>
        <AffiliateCardForm
          mode="edit"
          initial={row}
          onCancel={() => setEditing(false)}
          onSaved={async (body) => { await onPatch(body); setEditing(false); }}
        />
      </li>
    );
  }

  return (
    <li className="rounded border border-keep-rule/60 bg-keep-bg p-2 text-xs">
      <div className="flex flex-col gap-3">
        <AffiliateCard card={toCardPreview(row)} size="large" />
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{row.title || row.label || "(untitled)"}</span>
            <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${chip.className}`}>{chip.label}</span>
            <span className="text-[10px] text-keep-muted">
              {row.ownerName ? `by ${row.ownerName}` : "admin-authored"}
            </span>
          </div>

          {/* Traffic counters. clicksIn/Out are the SHOWN totals (real + any
              synthetic padding); the breakdown appears only when padding is live. */}
          <div className="flex flex-wrap gap-4 text-[11px] text-keep-muted">
            <span title="Shown = real + padded">
              in: <span className="text-keep-text">{row.clicksIn.toLocaleString()}</span>
              {row.padClicksIn > 0 ? (
                <span> ({row.realClicksIn.toLocaleString()} real + {row.padClicksIn.toLocaleString()} padded)</span>
              ) : null}
            </span>
            <span title="Shown = real + padded">
              out: <span className="text-keep-text">{row.clicksOut.toLocaleString()}</span>
              {row.padClicksOut > 0 ? (
                <span> ({row.realClicksOut.toLocaleString()} real + {row.padClicksOut.toLocaleString()} padded)</span>
              ) : null}
            </span>
          </div>
          {row.padInEnabled || row.padOutEnabled ? (
            <div className="text-[10px] text-keep-muted">
              Padding on
              {row.padInEnabled ? ` · in up to ${row.padInMax.toLocaleString()}/day` : ""}
              {row.padOutEnabled ? ` · out up to ${row.padOutMax.toLocaleString()}/day` : ""}
            </div>
          ) : null}

          {row.reviewNote ? (
            <div className="text-[11px] text-keep-muted">Last note: {row.reviewNote}</div>
          ) : null}

          {backUrl ? (
            <CopyableUrl label="Link-back (partner puts this on their site)" url={backUrl} />
          ) : (
            <p className="text-[11px] italic text-keep-muted">No link-back yet (assigned on approval).</p>
          )}

          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => onPatch({ status: row.status === "disabled" ? "approved" : "disabled" })}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
            >
              {row.status === "disabled" ? "Enable" : "Disable"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
            >
              Edit
            </button>
            {row.padClicksIn > 0 || row.padClicksOut > 0 ? (
              <button
                type="button"
                onClick={() => onPatch({ resetPad: true })}
                title="Zero out the accumulated synthetic traffic"
                className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
              >
                Reset padding
              </button>
            ) : null}
            <button
              type="button"
              onClick={onDelete}
              className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

/** Create / edit a structured card. On create, posts an admin-authored card
 *  (server auto-approves it, ownerUserId=null); on edit, hands the changed
 *  fields up to the parent's PATCH. */
function AffiliateCardForm({
  mode,
  initial,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: AdminAffiliate;
  onCancel: () => void;
  onSaved: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [iconUrl, setIconUrl] = useState(initial?.iconUrl ?? "");
  const [bannerUrl, setBannerUrl] = useState(initial?.bannerUrl ?? "");
  const [targetUrl, setTargetUrl] = useState(initial?.targetUrl ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  // Traffic padding (synthetic in/out visits).
  const [padInEnabled, setPadInEnabled] = useState(initial?.padInEnabled ?? false);
  const [padInMax, setPadInMax] = useState(initial?.padInMax ?? 0);
  const [padOutEnabled, setPadOutEnabled] = useState(initial?.padOutEnabled ?? false);
  const [padOutMax, setPadOutMax] = useState(initial?.padOutMax ?? 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Optional URLs may be blank; when present they must be safe http/https.
  const targetOk = isValidAffiliateUrl(targetUrl);
  const iconOk = !iconUrl.trim() || isValidAffiliateUrl(iconUrl);
  const bannerOk = !bannerUrl.trim() || isValidAffiliateUrl(bannerUrl);
  const canSubmit = !!title.trim() && !!description.trim() && targetOk && iconOk && bannerOk;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    // Blank optionals go up as null so an admin can clear an existing icon/banner.
    const body: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim(),
      iconUrl: iconUrl.trim() || null,
      bannerUrl: bannerUrl.trim() || null,
      targetUrl: targetUrl.trim(),
      tags,
      padInEnabled,
      padInMax: Math.max(0, Math.round(padInMax) || 0),
      padOutEnabled,
      padOutMax: Math.max(0, Math.round(padOutMax) || 0),
    };
    try {
      if (mode === "create") {
        await adminCreateAffiliate({ kind: "card", ...body });
        await onSaved(body);
      } else {
        await onSaved(body);
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg p-2 text-xs">
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{err}</div>
      ) : null}
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={AFFILIATE_LIMITS.title}
          placeholder="e.g. The Sunken Court"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={AFFILIATE_LIMITS.description}
          rows={2}
          placeholder="A short blurb shown on the card."
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Target URL</span>
        <input
          type="url"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          maxLength={AFFILIATE_LIMITS.url}
          placeholder="https://partner.example"
          className={`w-full rounded border bg-keep-bg px-2 py-1 outline-none focus:border-keep-action ${
            targetUrl && !targetOk ? "border-keep-accent" : "border-keep-rule"
          }`}
        />
        {targetUrl && !targetOk ? (
          <span className="mt-0.5 block text-[10px] text-keep-accent">Must be a http(s) link.</span>
        ) : null}
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Icon URL (optional)</span>
          <input
            type="url"
            value={iconUrl}
            onChange={(e) => setIconUrl(e.target.value)}
            maxLength={AFFILIATE_LIMITS.url}
            placeholder="https://.../icon.png"
            className={`w-full rounded border bg-keep-bg px-2 py-1 outline-none focus:border-keep-action ${
              iconUrl && !iconOk ? "border-keep-accent" : "border-keep-rule"
            }`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">Banner URL (optional)</span>
          <input
            type="url"
            value={bannerUrl}
            onChange={(e) => setBannerUrl(e.target.value)}
            maxLength={AFFILIATE_LIMITS.url}
            placeholder="https://.../banner.jpg"
            className={`w-full rounded border bg-keep-bg px-2 py-1 outline-none focus:border-keep-action ${
              bannerUrl && !bannerOk ? "border-keep-accent" : "border-keep-rule"
            }`}
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Tags</span>
        <TagInput tags={tags} onChange={setTags} />
      </label>

      {/* Traffic padding: optional synthetic in/out visits so a quiet listing
          still shows some life. Real counters are never touched. */}
      <fieldset className="rounded border border-keep-rule/60 p-2">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-keep-muted">
          Traffic padding (synthetic)
        </legend>
        <p className="mb-2 text-[10px] leading-relaxed text-keep-muted">
          Adds fake daily visits, a random amount up to the max each day, spread out
          through the day, so a quiet community still shows some traffic. Real visit
          counts are never changed.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={padInEnabled}
                onChange={(e) => setPadInEnabled(e.target.checked)}
              />
              <span>Pad incoming visits</span>
            </label>
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Max in / day</span>
            <input
              type="number"
              min={0}
              max={AFFILIATE_LIMITS.padDailyMax}
              value={padInMax}
              onChange={(e) => setPadInMax(Number(e.target.value))}
              disabled={!padInEnabled}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action disabled:opacity-50"
            />
          </div>
          <div className="space-y-1">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={padOutEnabled}
                onChange={(e) => setPadOutEnabled(e.target.checked)}
              />
              <span>Pad outgoing visits</span>
            </label>
            <span className="mb-1 block uppercase tracking-widest text-keep-muted">Max out / day</span>
            <input
              type="number"
              min={0}
              max={AFFILIATE_LIMITS.padDailyMax}
              value={padOutMax}
              onChange={(e) => setPadOutMax(Number(e.target.value))}
              disabled={!padOutEnabled}
              className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action disabled:opacity-50"
            />
          </div>
        </div>
      </fieldset>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-0.5 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !canSubmit}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
        >
          {busy ? "Saving..." : mode === "create" ? "Create" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** One legacy raw-HTML badge row. Preserves the original enable/disable +
 *  delete behaviour and the verbatim HTML preview (admin-trusted, unsanitized). */
function AffiliateLegacyItem({
  row,
  onPatch,
  onDelete,
}: {
  row: AdminAffiliate;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li>
        <AffiliateLegacyForm
          mode="edit"
          initial={row}
          onCancel={() => setEditing(false)}
          onSaved={async (body) => { await onPatch(body); setEditing(false); }}
        />
      </li>
    );
  }
  return (
    <li className="rounded border border-keep-rule/60 bg-keep-bg p-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <span className={`mr-2 inline-block h-2 w-2 rounded-full ${row.enabled ? "bg-keep-action" : "bg-keep-rule"}`} />
          <span className="font-semibold">{row.label}</span>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onPatch({ enabled: !row.enabled })}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
          >
            {row.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 hover:bg-keep-banner"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="keep-button rounded border border-keep-accent/50 bg-keep-bg px-2 py-0.5 text-keep-accent hover:bg-keep-accent/10"
          >
            Delete
          </button>
        </div>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-keep-muted">HTML preview</summary>
        <div
          className="mt-1 rounded border border-keep-rule/40 bg-keep-panel/30 p-2 [&_img]:max-h-12"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: row.html ?? "" }}
        />
        <pre className="mt-1 overflow-x-auto rounded bg-keep-panel/30 p-2 text-[10px] text-keep-muted">{row.html ?? ""}</pre>
      </details>
    </li>
  );
}

/** Create / edit a legacy raw-HTML badge (label + verbatim HTML snippet). */
function AffiliateLegacyForm({
  mode,
  initial,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: AdminAffiliate;
  onCancel: () => void;
  onSaved: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [html, setHtml] = useState(initial?.html ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim() || !html.trim()) return;
    setBusy(true);
    setErr(null);
    const body: Record<string, unknown> = { label: label.trim(), html, enabled };
    try {
      if (mode === "create") {
        await adminCreateAffiliate({ kind: "html", ...body });
        await onSaved(body);
      } else {
        await onSaved(body);
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-keep-action/40 bg-keep-bg p-2 text-xs">
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-keep-accent">{err}</div>
      ) : null}
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">Label (admin-only)</span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
          placeholder="e.g. Top RP Sites"
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 outline-none focus:border-keep-action"
        />
      </label>
      <label className="block">
        <span className="mb-1 block uppercase tracking-widest text-keep-muted">HTML snippet</span>
        <textarea
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          rows={6}
          placeholder='<a href="..."><img src="..." alt="..." /></a>'
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-keep-action"
        />
        <span className="mt-0.5 block text-[10px] text-keep-muted">
          Paste verbatim from the affiliate's provided code. Tracking pixels and similar pass through unchanged.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Enabled</span>
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-0.5 hover:bg-keep-banner"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !label.trim() || !html.trim()}
          className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-0.5 hover:bg-keep-banner/80 disabled:opacity-50"
        >
          {busy ? "Saving..." : mode === "create" ? "Create" : "Save"}
        </button>
      </div>
    </form>
  );
}
