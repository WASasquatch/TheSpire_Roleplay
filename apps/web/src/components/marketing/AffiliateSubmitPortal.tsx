import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useChat } from "../../state/store.js";
import { Modal } from "../cosmetics/Modal.js";
import { CloseButton } from "../shared/CloseButton.js";
import { TagInput } from "../shared/TagInput.js";
import {
  AFFILIATE_LIMITS,
  fetchMyAffiliates,
  fetchPublicAffiliates,
  isValidAffiliateUrl,
  submitAffiliate,
  updateMyAffiliate,
  withdrawMyAffiliate,
  type AffiliateStatus,
  type AffiliateSubmitInput,
  type MyAffiliate,
  type PublicAffiliateCard,
} from "../../lib/affiliates.js";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard.js";
import { CommunityBoard } from "./CommunityBoard.js";
import { AffiliateCard } from "./AffiliateCard.js";

/**
 * Self-service submission portal for the Roleplay Communities section.
 *
 * Exports:
 *   - `SubmitAffiliateButton` — a self-managing CTA that owns its own open state
 *     and mounts the modal on click. No App-level plumbing; drop it anywhere.
 *   - `AffiliateSubmitPortal` — the modal itself, if a caller needs to control
 *     open state (e.g. a menu entry that toggles it).
 *
 * Logged out → a short pitch + log-in / register anchors. Logged in → a Submit
 * form (title, description, target URL, icon URL, banner URL with live 16/9
 * banner + icon preview; URLs client-validated before submit) and a "My
 * submissions" list with per-entry status chip, rejection note, a copyable
 * link-back once approved, and edit / withdraw actions.
 *
 * Cards render as structured text + `<img>` (never raw HTML), so there is no
 * XSS surface — the same posture the server enforces on every URL.
 */

/* ---------- status chips (§10 copy) ---------- */

const STATUS_META: Record<
  AffiliateStatus,
  { label: string; className: string }
> = {
  pending: { label: "Pending review", className: "border-keep-accent/60 bg-keep-accent/10 text-keep-accent" },
  approved: { label: "Live", className: "border-emerald-500/60 bg-emerald-500/10 text-emerald-400" },
  rejected: { label: "Needs changes", className: "border-amber-500/60 bg-amber-500/10 text-amber-400" },
  disabled: { label: "Hidden", className: "border-keep-rule bg-keep-panel/50 text-keep-muted" },
};

function StatusChip({ status }: { status: AffiliateStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

/* ---------- the trigger ---------- */

/**
 * The section / menu CTA. Manages its own modal open state so a caller can drop
 * it in without wiring anything. `label` defaults to the §10 copy; `className`
 * overrides the button chrome for context (e.g. a menu row vs a splash CTA).
 */
export function SubmitAffiliateButton({
  label = "List your community",
  className,
}: {
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "inline-flex items-center gap-1.5 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg transition-colors hover:bg-keep-action/90"
        }
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </button>
      {open ? <AffiliateSubmitPortal onClose={() => setOpen(false)} initialView="add" /> : null}
    </>
  );
}

/* ---------- the modal ---------- */

type PortalView = "list" | "add";

/**
 * The Top RP Communities modal. Two views:
 *   - `list` (default) — the full topsite board (searchable / sortable / tag
 *     filterable), same as the public /top-communities page.
 *   - `add` — "Add Your Community": the submit form + the member's own listings
 *     (with copyable link-backs). Logged-out viewers get a log-in / register
 *     prompt here instead.
 * "Add Your Community" sits top-right in the header; a Back arrow returns to the
 * board.
 */
export function AffiliateSubmitPortal({
  onClose,
  initialView = "list",
}: {
  onClose: () => void;
  initialView?: PortalView;
}) {
  const me = useChat((s) => s.me);
  const [view, setView] = useState<PortalView>(initialView);

  return (
    <Modal onClose={onClose} variant="mobile-fullscreen">
      <div
        className="keep-frame flex h-full w-full flex-col overflow-hidden rounded border border-keep-rule bg-keep-bg lg:h-[88vh] lg:w-[80vw] lg:max-w-[960px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-keep-rule bg-keep-banner/30 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {view === "add" ? (
              <button
                type="button"
                onClick={() => setView("list")}
                aria-label="Back to the board"
                title="Back to the board"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-keep-rule text-keep-muted hover:border-keep-action hover:text-keep-action"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            <h3 className="truncate font-action text-lg text-keep-text">Top RP Communities</h3>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {view === "list" ? (
              <button
                type="button"
                onClick={() => setView("add")}
                className="inline-flex items-center gap-1.5 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg transition-colors hover:bg-keep-action/90"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add Your Community
              </button>
            ) : null}
            <CloseButton onClick={onClose} label="Close" />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {view === "list" ? (
            <BoardView />
          ) : (
            <>
              <p className="mb-4 text-sm text-keep-muted">
                List your roleplay community here. Add our link-back to your site, and we&apos;ll count
                visits both ways so everyone can see what&apos;s active.
              </p>
              {me ? <SignedInPanes /> : <LoggedOutPrompt />}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ---------- list view: the topsite board ---------- */

function BoardView() {
  const [cards, setCards] = useState<PublicAffiliateCard[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPublicAffiliates()
      .then((res) => { if (alive) setCards(res.cards); })
      .catch(() => { if (alive) setCards([]); });
    return () => { alive = false; };
  }, []);

  if (cards === null) {
    return <p className="py-6 text-center text-sm italic text-keep-muted">Gathering communities…</p>;
  }
  return (
    <CommunityBoard
      cards={cards}
      size="large"
      emptyText="No communities listed yet. Be the first — hit Add Your Community."
    />
  );
}

/* ---------- logged-out ---------- */

function LoggedOutPrompt() {
  return (
    <div className="rounded border border-keep-rule bg-keep-panel/40 px-4 py-6 text-center">
      <p className="text-sm text-keep-text">Log in to list your community.</p>
      <p className="mt-1 text-xs text-keep-muted">
        You&apos;ll own the entry, so you can return anytime to copy your link-back.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <a
          href="/login"
          className="rounded border border-keep-rule px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-text hover:border-keep-action hover:text-keep-action"
        >
          Log in
        </a>
        <a
          href="/register"
          className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg hover:bg-keep-action/90"
        >
          Register
        </a>
      </div>
    </div>
  );
}

/* ---------- logged-in: submit form + my submissions ---------- */

function SignedInPanes() {
  const [mine, setMine] = useState<MyAffiliate[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoadErr(null);
      setMine(await fetchMyAffiliates());
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Couldn't load your submissions.");
      setMine([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <SubmitForm onSubmitted={refresh} />

      <section>
        <h4 className="mb-2 font-action text-sm text-keep-text">My submissions</h4>
        {loadErr ? (
          <p className="rounded border border-keep-rule bg-keep-panel/40 px-3 py-2 text-xs text-keep-accent">
            {loadErr}
          </p>
        ) : mine === null ? (
          <p className="py-3 text-center text-xs italic text-keep-muted">Loading…</p>
        ) : mine.length === 0 ? (
          <p className="py-3 text-center text-xs italic text-keep-muted">
            You haven&apos;t listed a community yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {mine.map((a) => (
              <MySubmissionRow key={a.id} entry={a} onChanged={refresh} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ---------- submit form ---------- */

const inputClass =
  "w-full rounded border border-keep-rule bg-keep-bg/60 px-2.5 py-1.5 text-sm text-keep-text placeholder:text-keep-muted focus:border-keep-action focus:outline-none";
const labelClass = "block text-xs font-semibold uppercase tracking-wider text-keep-muted";

interface FormState {
  title: string;
  description: string;
  targetUrl: string;
  iconUrl: string;
  bannerUrl: string;
  tags: string[];
}

const EMPTY_FORM: FormState = {
  title: "",
  description: "",
  targetUrl: "",
  iconUrl: "",
  bannerUrl: "",
  tags: [],
};

function SubmitForm({ onSubmitted }: { onSubmitted: () => Promise<void> }) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setDone(false);
  }

  // Client-side gates before we let the submit fire. Target is required; the
  // optional icon/banner only need to validate when supplied. The server
  // re-checks all three, this just keeps a clearly-bad URL from a round-trip.
  const targetOk = isValidAffiliateUrl(form.targetUrl);
  const iconOk = !form.iconUrl.trim() || isValidAffiliateUrl(form.iconUrl);
  const bannerOk = !form.bannerUrl.trim() || isValidAffiliateUrl(form.bannerUrl);
  const canSubmit =
    !busy &&
    form.title.trim().length > 0 &&
    form.description.trim().length > 0 &&
    targetOk &&
    iconOk &&
    bannerOk;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const input: AffiliateSubmitInput = {
        title: form.title.trim(),
        description: form.description.trim(),
        targetUrl: form.targetUrl.trim(),
        ...(form.iconUrl.trim() ? { iconUrl: form.iconUrl.trim() } : {}),
        ...(form.bannerUrl.trim() ? { bannerUrl: form.bannerUrl.trim() } : {}),
        ...(form.tags.length ? { tags: form.tags } : {}),
      };
      await submitAffiliate(input);
      setForm(EMPTY_FORM);
      setDone(true);
      await onSubmitted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't submit. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const bannerPreviewOk = !!form.bannerUrl.trim() && bannerOk;
  const iconPreviewOk = !!form.iconUrl.trim() && iconOk;

  // Live preview built from the form so the "List a community" form shows the
  // exact wide card the board will paint (invalid URLs fall back rather than
  // trying to load).
  const previewCard: PublicAffiliateCard = {
    id: "preview",
    title: form.title.trim(),
    description: form.description.trim(),
    iconUrl: iconPreviewOk ? form.iconUrl.trim() : null,
    bannerUrl: bannerPreviewOk ? form.bannerUrl.trim() : null,
    clicksIn: 0,
    clicksOut: 0,
    tags: form.tags,
  };

  return (
    <section className="rounded border border-keep-rule bg-keep-panel/30 p-3">
      <h4 className="mb-2 font-action text-sm text-keep-text">List a community</h4>

      {/* Wide live preview on top — exactly how the card lands on the board. */}
      <div className="mb-4">
        <span className={labelClass}>Preview</span>
        <div className="mt-1">
          <AffiliateCard card={previewCard} size="large" />
        </div>
      </div>

      {/* Fields. */}
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="aff-title">Title</label>
          <input
            id="aff-title"
            className={inputClass}
            value={form.title}
            maxLength={AFFILIATE_LIMITS.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Your community's name"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="aff-target">Target URL</label>
          <input
            id="aff-target"
            className={inputClass}
            value={form.targetUrl}
            onChange={(e) => set("targetUrl", e.target.value)}
            placeholder="https://example.com"
          />
          {form.targetUrl.trim() && !targetOk ? (
            <p className="mt-1 text-[11px] text-keep-accent">Use a full http/https link.</p>
          ) : null}
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="aff-desc">Description</label>
          <textarea
            id="aff-desc"
            className={`${inputClass} min-h-[4.5rem] resize-y`}
            value={form.description}
            maxLength={AFFILIATE_LIMITS.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="A line or two about your community"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="aff-icon">Icon URL (optional)</label>
          <input
            id="aff-icon"
            className={inputClass}
            value={form.iconUrl}
            onChange={(e) => set("iconUrl", e.target.value)}
            placeholder="https://example.com/icon.png"
          />
          {form.iconUrl.trim() && !iconOk ? (
            <p className="mt-1 text-[11px] text-keep-accent">Use a full http/https link.</p>
          ) : null}
        </div>
        <div>
          <label className={labelClass} htmlFor="aff-banner">Banner URL (optional)</label>
          <input
            id="aff-banner"
            className={inputClass}
            value={form.bannerUrl}
            onChange={(e) => set("bannerUrl", e.target.value)}
            placeholder="https://example.com/banner.jpg"
          />
          {form.bannerUrl.trim() && !bannerOk ? (
            <p className="mt-1 text-[11px] text-keep-accent">Use a full http/https link.</p>
          ) : null}
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Tags (optional)</label>
          <div className="mt-1">
            <TagInput
              tags={form.tags}
              onChange={(tags) => { setForm((f) => ({ ...f, tags })); setDone(false); }}
            />
          </div>
          <p className="mt-1 text-[11px] text-keep-muted">Genre or category, so seekers can find you.</p>
        </div>
      </div>

      {err ? (
        <p className="mt-3 rounded border border-keep-rule bg-keep-panel/40 px-3 py-2 text-xs text-keep-accent">
          {err}
        </p>
      ) : null}
      {done ? (
        <p className="mt-3 rounded border border-keep-rule bg-keep-panel/40 px-3 py-2 text-xs text-keep-text">
          Thanks! Your community is pending review. It goes live once a moderator approves it.
        </p>
      ) : null}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg transition-colors hover:bg-keep-action/90 disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Submit for review"}
        </button>
      </div>
    </section>
  );
}

/* ---------- my-submissions row (edit + withdraw + link-back copy) ---------- */

function MySubmissionRow({
  entry,
  onChanged,
}: {
  entry: MyAffiliate;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { copied, copy: copyToClipboard } = useCopyToClipboard({ resetMs: 1500 });

  async function withdraw() {
    setBusy(true);
    setErr(null);
    try {
      await withdrawMyAffiliate(entry.id);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't withdraw.");
      setBusy(false);
    }
  }

  function copyLinkBack() {
    if (!entry.linkBackUrl) return;
    // Clipboard denied (permissions / insecure context): leave the field so
    // the member can select-copy manually.
    void copyToClipboard(entry.linkBackUrl);
  }

  if (editing) {
    return (
      <li className="rounded border border-keep-rule bg-keep-panel/30 p-3">
        <EditForm
          entry={entry}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onChanged();
          }}
        />
      </li>
    );
  }

  return (
    <li className="rounded border border-keep-rule bg-keep-panel/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-action text-sm text-keep-text">{entry.title}</span>
            <StatusChip status={entry.status} />
          </div>
          {entry.status === "rejected" && entry.reviewNote ? (
            <p className="mt-1 text-xs text-amber-400">{entry.reviewNote}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            title="Edit"
            aria-label="Edit"
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-keep-rule text-keep-muted hover:border-keep-action hover:text-keep-action disabled:opacity-50"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={withdraw}
            disabled={busy}
            title="Withdraw"
            aria-label="Withdraw"
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-keep-rule text-keep-muted hover:border-keep-accent hover:text-keep-accent disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Link-back — present only once approved. Read-only field + copy. */}
      {entry.status === "approved" && entry.linkBackUrl ? (
        <div className="mt-2">
          <label className="block text-[11px] text-keep-muted">
            Your link-back (put this on your site)
          </label>
          <div className="mt-1 flex items-center gap-1.5">
            <input
              readOnly
              value={entry.linkBackUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded border border-keep-rule bg-keep-bg/60 px-2 py-1 text-xs text-keep-text"
            />
            <button
              type="button"
              onClick={copyLinkBack}
              title="Copy link-back"
              aria-label="Copy link-back"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-keep-rule text-keep-muted hover:border-keep-action hover:text-keep-action"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      ) : null}

      {err ? <p className="mt-2 text-xs text-keep-accent">{err}</p> : null}
    </li>
  );
}

/* ---------- inline edit form ---------- */

function EditForm({
  entry,
  onCancel,
  onSaved,
}: {
  entry: MyAffiliate;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<FormState>({
    title: entry.title,
    description: entry.description,
    targetUrl: entry.targetUrl,
    iconUrl: entry.iconUrl ?? "",
    bannerUrl: entry.bannerUrl ?? "",
    tags: entry.tags ?? [],
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const targetOk = isValidAffiliateUrl(form.targetUrl);
  const iconOk = !form.iconUrl.trim() || isValidAffiliateUrl(form.iconUrl);
  const bannerOk = !form.bannerUrl.trim() || isValidAffiliateUrl(form.bannerUrl);
  const canSave =
    !busy &&
    form.title.trim().length > 0 &&
    form.description.trim().length > 0 &&
    targetOk &&
    iconOk &&
    bannerOk;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      await updateMyAffiliate(entry.id, {
        title: form.title.trim(),
        description: form.description.trim(),
        targetUrl: form.targetUrl.trim(),
        iconUrl: form.iconUrl.trim(),
        bannerUrl: form.bannerUrl.trim(),
        tags: form.tags,
      });
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-keep-muted">
        Editing a live listing sends it back for review before it shows again.
      </p>
      <input
        className={inputClass}
        value={form.title}
        maxLength={AFFILIATE_LIMITS.title}
        onChange={(e) => set("title", e.target.value)}
        placeholder="Title"
        aria-label="Title"
      />
      <textarea
        className={`${inputClass} min-h-[3.5rem] resize-y`}
        value={form.description}
        maxLength={AFFILIATE_LIMITS.description}
        onChange={(e) => set("description", e.target.value)}
        placeholder="Description"
        aria-label="Description"
      />
      <input
        className={inputClass}
        value={form.targetUrl}
        onChange={(e) => set("targetUrl", e.target.value)}
        placeholder="Target URL"
        aria-label="Target URL"
      />
      <input
        className={inputClass}
        value={form.iconUrl}
        onChange={(e) => set("iconUrl", e.target.value)}
        placeholder="Icon URL (optional)"
        aria-label="Icon URL"
      />
      <input
        className={inputClass}
        value={form.bannerUrl}
        onChange={(e) => set("bannerUrl", e.target.value)}
        placeholder="Banner URL (optional)"
        aria-label="Banner URL"
      />
      <TagInput tags={form.tags} onChange={(tags) => set("tags", tags)} />
      {err ? <p className="text-xs text-keep-accent">{err}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <a
          href={entry.targetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mr-auto inline-flex items-center gap-1 text-[11px] text-keep-muted hover:text-keep-action"
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          Visit
        </a>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded border border-keep-rule px-2.5 py-1 text-xs text-keep-muted hover:text-keep-text disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="rounded border border-keep-action bg-keep-action px-2.5 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg hover:bg-keep-action/90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
