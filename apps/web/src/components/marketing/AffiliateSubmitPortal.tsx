import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { FloatingWindow } from "../shared/FloatingWindow.js";
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

/** Chip chrome per status; the user-facing labels live in the marketing
 *  catalog (portal.status.*) and are resolved with t() at render time. */
const STATUS_META: Record<
  AffiliateStatus,
  { labelKey: string; className: string }
> = {
  pending: { labelKey: "portal.status.pending", className: "border-keep-accent/60 bg-keep-accent/10 text-keep-accent" },
  approved: { labelKey: "portal.status.approved", className: "border-emerald-500/60 bg-emerald-500/10 text-emerald-400" },
  rejected: { labelKey: "portal.status.rejected", className: "border-amber-500/60 bg-amber-500/10 text-amber-400" },
  disabled: { labelKey: "portal.status.disabled", className: "border-keep-rule bg-keep-panel/50 text-keep-muted" },
};

function StatusChip({ status }: { status: AffiliateStatus }) {
  const { t } = useTranslation("marketing");
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${meta.className}`}
    >
      {t(meta.labelKey)}
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
  label,
  className,
}: {
  /** Defaults to the localized "List your community" (§10 copy). */
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation("marketing");
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
        {label ?? t("portal.listYourCommunity")}
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
  const { t } = useTranslation("marketing");
  const me = useChat((s) => s.me);
  const [view, setView] = useState<PortalView>(initialView);

  return (
    <FloatingWindow
      onClose={onClose}
      title={t("portal.title")}
      initialWidth={960}
      className="keep-frame rounded border border-keep-rule bg-keep-bg"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-keep-rule bg-keep-banner/30 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {view === "add" ? (
              <button
                type="button"
                onClick={() => setView("list")}
                aria-label={t("portal.backToBoard")}
                title={t("portal.backToBoard")}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-keep-rule text-keep-muted hover:border-keep-action hover:text-keep-action"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {view === "list" ? (
              <button
                type="button"
                onClick={() => setView("add")}
                className="inline-flex items-center gap-1.5 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg transition-colors hover:bg-keep-action/90"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t("portal.addYourCommunity")}
              </button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {view === "list" ? (
            <BoardView />
          ) : (
            <>
              <p className="mb-4 text-sm text-keep-muted">
                {t("portal.intro")}
              </p>
              {me ? <SignedInPanes /> : <LoggedOutPrompt />}
            </>
          )}
        </div>
      </div>
    </FloatingWindow>
  );
}

/* ---------- list view: the topsite board ---------- */

function BoardView() {
  const { t } = useTranslation("marketing");
  const [cards, setCards] = useState<PublicAffiliateCard[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPublicAffiliates()
      .then((res) => { if (alive) setCards(res.cards); })
      .catch(() => { if (alive) setCards([]); });
    return () => { alive = false; };
  }, []);

  if (cards === null) {
    return <p className="py-6 text-center text-sm italic text-keep-muted">{t("gathering")}</p>;
  }
  return (
    <CommunityBoard
      cards={cards}
      size="large"
      emptyText={t("portal.emptyBoard")}
    />
  );
}

/* ---------- logged-out ---------- */

function LoggedOutPrompt() {
  const { t } = useTranslation("marketing");
  return (
    <div className="rounded border border-keep-rule bg-keep-panel/40 px-4 py-6 text-center">
      <p className="text-sm text-keep-text">{t("portal.loginToList")}</p>
      <p className="mt-1 text-xs text-keep-muted">
        {t("portal.ownEntry")}
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <a
          href="/login"
          className="rounded border border-keep-rule px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-text hover:border-keep-action hover:text-keep-action"
        >
          {t("auth.logIn")}
        </a>
        <a
          href="/register"
          className="rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg hover:bg-keep-action/90"
        >
          {t("auth.register")}
        </a>
      </div>
    </div>
  );
}

/* ---------- logged-in: submit form + my submissions ---------- */

function SignedInPanes() {
  const { t } = useTranslation("marketing");
  const [mine, setMine] = useState<MyAffiliate[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoadErr(null);
      setMine(await fetchMyAffiliates());
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : t("portal.loadFailed"));
      setMine([]);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <SubmitForm onSubmitted={refresh} />

      <section>
        <h4 className="mb-2 font-action text-sm text-keep-text">{t("portal.mySubmissions")}</h4>
        {loadErr ? (
          <p className="rounded border border-keep-rule bg-keep-panel/40 px-3 py-2 text-xs text-keep-accent">
            {loadErr}
          </p>
        ) : mine === null ? (
          <p className="py-3 text-center text-xs italic text-keep-muted">{t("common:loading")}</p>
        ) : mine.length === 0 ? (
          <p className="py-3 text-center text-xs italic text-keep-muted">
            {t("portal.noneYet")}
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
  const { t } = useTranslation("marketing");
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
      setErr(e instanceof Error ? e.message : t("portal.submitFailed"));
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
      <h4 className="mb-2 font-action text-sm text-keep-text">{t("portal.listCommunity")}</h4>

      {/* Wide live preview on top — exactly how the card lands on the board. */}
      <div className="mb-4">
        <span className={labelClass}>{t("common:preview")}</span>
        <div className="mt-1">
          <AffiliateCard card={previewCard} size="large" />
        </div>
      </div>

      {/* Fields. */}
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="aff-title">{t("portal.fieldTitle")}</label>
          <input
            id="aff-title"
            className={inputClass}
            value={form.title}
            maxLength={AFFILIATE_LIMITS.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder={t("portal.titlePlaceholder")}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="aff-target">{t("portal.fieldTargetUrl")}</label>
          <input
            id="aff-target"
            className={inputClass}
            value={form.targetUrl}
            onChange={(e) => set("targetUrl", e.target.value)}
            placeholder={t("portal.targetPlaceholder")}
          />
          {form.targetUrl.trim() && !targetOk ? (
            <p className="mt-1 text-[11px] text-keep-accent">{t("portal.urlHint")}</p>
          ) : null}
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="aff-desc">{t("portal.fieldDescription")}</label>
          <textarea
            id="aff-desc"
            className={`${inputClass} min-h-[4.5rem] resize-y`}
            value={form.description}
            maxLength={AFFILIATE_LIMITS.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder={t("portal.descPlaceholder")}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="aff-icon">{t("portal.fieldIconUrl")}</label>
          <input
            id="aff-icon"
            className={inputClass}
            value={form.iconUrl}
            onChange={(e) => set("iconUrl", e.target.value)}
            placeholder={t("portal.iconPlaceholder")}
          />
          {form.iconUrl.trim() && !iconOk ? (
            <p className="mt-1 text-[11px] text-keep-accent">{t("portal.urlHint")}</p>
          ) : null}
        </div>
        <div>
          <label className={labelClass} htmlFor="aff-banner">{t("portal.fieldBannerUrl")}</label>
          <input
            id="aff-banner"
            className={inputClass}
            value={form.bannerUrl}
            onChange={(e) => set("bannerUrl", e.target.value)}
            placeholder={t("portal.bannerPlaceholder")}
          />
          {form.bannerUrl.trim() && !bannerOk ? (
            <p className="mt-1 text-[11px] text-keep-accent">{t("portal.urlHint")}</p>
          ) : null}
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>{t("portal.fieldTags")}</label>
          <div className="mt-1">
            <TagInput
              tags={form.tags}
              onChange={(tags) => { setForm((f) => ({ ...f, tags })); setDone(false); }}
            />
          </div>
          <p className="mt-1 text-[11px] text-keep-muted">{t("portal.tagsHint")}</p>
        </div>
      </div>

      {err ? (
        <p className="mt-3 rounded border border-keep-rule bg-keep-panel/40 px-3 py-2 text-xs text-keep-accent">
          {err}
        </p>
      ) : null}
      {done ? (
        <p className="mt-3 rounded border border-keep-rule bg-keep-panel/40 px-3 py-2 text-xs text-keep-text">
          {t("portal.pendingNote")}
        </p>
      ) : null}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 rounded border border-keep-action bg-keep-action px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-bg transition-colors hover:bg-keep-action/90 disabled:opacity-50"
        >
          {busy ? t("portal.submitting") : t("portal.submitCta")}
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
  const { t } = useTranslation("marketing");
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
      setErr(e instanceof Error ? e.message : t("portal.withdrawFailed"));
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
            title={t("portal.edit")}
            aria-label={t("portal.edit")}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-keep-rule text-keep-muted hover:border-keep-action hover:text-keep-action disabled:opacity-50"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={withdraw}
            disabled={busy}
            title={t("portal.withdraw")}
            aria-label={t("portal.withdraw")}
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
            {t("portal.linkBackLabel")}
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
              title={t("portal.copyLinkBack")}
              aria-label={t("portal.copyLinkBack")}
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
  const { t } = useTranslation("marketing");
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
      setErr(e instanceof Error ? e.message : t("portal.saveFailed"));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-keep-muted">
        {t("portal.editNote")}
      </p>
      <input
        className={inputClass}
        value={form.title}
        maxLength={AFFILIATE_LIMITS.title}
        onChange={(e) => set("title", e.target.value)}
        placeholder={t("portal.fieldTitle")}
        aria-label={t("portal.fieldTitle")}
      />
      <textarea
        className={`${inputClass} min-h-[3.5rem] resize-y`}
        value={form.description}
        maxLength={AFFILIATE_LIMITS.description}
        onChange={(e) => set("description", e.target.value)}
        placeholder={t("portal.fieldDescription")}
        aria-label={t("portal.fieldDescription")}
      />
      <input
        className={inputClass}
        value={form.targetUrl}
        onChange={(e) => set("targetUrl", e.target.value)}
        placeholder={t("portal.fieldTargetUrl")}
        aria-label={t("portal.fieldTargetUrl")}
      />
      <input
        className={inputClass}
        value={form.iconUrl}
        onChange={(e) => set("iconUrl", e.target.value)}
        placeholder={t("portal.fieldIconUrl")}
        aria-label={t("portal.iconUrlAria")}
      />
      <input
        className={inputClass}
        value={form.bannerUrl}
        onChange={(e) => set("bannerUrl", e.target.value)}
        placeholder={t("portal.fieldBannerUrl")}
        aria-label={t("portal.bannerUrlAria")}
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
          {t("card.visit")}
        </a>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded border border-keep-rule px-2.5 py-1 text-xs text-keep-muted hover:text-keep-text disabled:opacity-50"
        >
          {t("common:cancel")}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="rounded border border-keep-action bg-keep-action px-2.5 py-1 text-xs font-semibold uppercase tracking-widest text-keep-bg hover:bg-keep-action/90 disabled:opacity-50"
        >
          {busy ? t("common:saving") : t("common:save")}
        </button>
      </div>
    </div>
  );
}
