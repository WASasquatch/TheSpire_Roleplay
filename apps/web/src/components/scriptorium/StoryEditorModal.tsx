import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  StoryCard,
  StoryChapter,
  StoryChapterLockState,
  StoryChapterRef,
  StoryChapterVersion,
  StoryDetail,
  StoryGenre,
  StoryRating,
  StoryStatus,
  StoryVisibility,
} from "@thekeep/shared";
import {
  STORY_CANONICAL_TAGS,
  STORY_CHAPTER_CAP,
  STORY_CHAPTER_LOCK_HEARTBEAT_MS,
  STORY_CONTENT_WARNINGS,
  STORY_COPY_PRICE_MIN,
  STORY_COPY_PRICE_MAX,
  STORY_GENRES,
  STORY_STATUSES,
  countWords,
  deriveSlug,
} from "@thekeep/shared";
import { RichEditor } from "../shared/RichEditor.js";
import { readError } from "../../lib/http.js";
import { formatDateTime, formatNumber } from "../../lib/intlFormat.js";
import { FloatingWindow } from "../shared/FloatingWindow.js";
import { RatingPicker } from "./RatingPicker.js";
import { StoryCodexTab } from "./StoryCodexTab.js";
import { StoryCollaboratorsTab } from "./StoryCollaboratorsTab.js";

interface Props {
  /** Existing story id, or null to land in the New Story wizard. */
  storyId: string | null;
  onClose: () => void;
  onDeleted?: () => void;
  /** When provided, the header shows a "← Back" affordance, used when
   *  the editor is stacked on top of the catalog so the user can
   *  return to browsing without collapsing the whole stack. */
  onBack?: () => void;
}

type Tab = "overview" | "chapters" | "codex" | "collaborators";

/**
 * Author-only editor for a story. Tabs: Overview (story meta) +
 * Chapters (list + per-chapter editor pane).
 *
 * When storyId is null we render a compact New Story wizard that
 * creates a minimal stub (title + slug only) and then transitions
 * into the full editor with the new id. Same pattern as
 * WorldEditorModal's tabbed layout.
 */
export function StoryEditorModal({ storyId: initialId, onClose, onDeleted, onBack }: Props) {
  const { t } = useTranslation("scriptorium");
  const [storyId, setStoryId] = useState<string | null>(initialId);
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      const r = await fetch(`/stories/${id}`);
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as StoryDetail;
      setDetail(j);
      if (selectedChapterId && !j.chapters.find((c) => c.id === selectedChapterId)) {
        setSelectedChapterId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.loadFailed"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (storyId) void load(storyId);
    else setDetail(null);
  }, [storyId, load]);

  async function deleteStory() {
    if (!detail) return;
    if (!window.confirm(
      t("editor.confirmDeleteStory", { title: detail.story.title, count: detail.chapters.length }),
    )) return;
    try {
      const r = await fetch(`/stories/${detail.story.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await readError(r));
      onDeleted?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.deleteFailed"));
    }
  }

  if (!storyId) {
    return (
      <FloatingWindow
        onClose={onClose}
        zIndex={60}
        title={t("editor.startNewStory")}
        className="keep-frame rounded bg-keep-bg text-keep-text"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {onBack ? (
            <header className="flex shrink-0 items-center border-b border-keep-rule bg-keep-banner px-4 py-2">
              <button
                type="button"
                onClick={onBack}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
                title={t("backToScriptorium")}
              >
                {t("back")}
              </button>
            </header>
          ) : null}
          <NewStoryWizard
            onCreated={(card) => setStoryId(card.id)}
            onCancel={onClose}
          />
        </div>
      </FloatingWindow>
    );
  }

  return (
    <FloatingWindow
      onClose={onClose}
      zIndex={50}
      className="keep-frame rounded bg-keep-bg text-keep-text"
      title={
        <>
          {detail ? t("editor.editTitle", { title: detail.story.title }) : t("common:loadingDots")}
          {detail ? (
            <span className="ml-2 text-xs text-keep-muted">/{detail.story.slug}</span>
          ) : null}
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {onBack ? (
          <header className="flex shrink-0 items-center border-b border-keep-rule bg-keep-banner px-4 py-2">
            <button
              type="button"
              onClick={onBack}
              className="shrink-0 rounded border border-keep-rule bg-keep-bg px-2 py-0.5 text-[11px] uppercase tracking-widest text-keep-muted hover:text-keep-text"
              title={t("backToScriptorium")}
            >
              {t("back")}
            </button>
          </header>
        ) : null}

        <nav className="flex shrink-0 items-center gap-1 border-b border-keep-rule bg-keep-panel/30 px-3 py-1.5 text-sm">
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>{t("editor.tabs.overview")}</TabButton>
          <TabButton active={tab === "chapters"} onClick={() => setTab("chapters")}>
            {t("editor.tabs.chapters")} {detail ? <span className="text-keep-muted">({detail.chapters.length})</span> : null}
          </TabButton>
          <TabButton active={tab === "codex"} onClick={() => setTab("codex")}>{t("editor.tabs.codex")}</TabButton>
          <TabButton active={tab === "collaborators"} onClick={() => setTab("collaborators")}>{t("editor.tabs.collaborators")}</TabButton>
          <span className="flex-1" />
        </nav>

        {error ? (
          <div className="mx-4 mt-3 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}

        {detail === null ? (
          <p className="p-4 italic text-keep-muted">{t("common:loadingDots")}</p>
        ) : tab === "overview" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <OverviewEditor detail={detail} onSaved={() => load(storyId)} onDelete={deleteStory} />
          </div>
        ) : tab === "chapters" ? (
          <ChaptersTab
            detail={detail}
            selectedChapterId={selectedChapterId}
            onSelectChapter={setSelectedChapterId}
            onReload={() => load(storyId)}
          />
        ) : tab === "codex" ? (
          <StoryCodexTab detail={detail} />
        ) : (
          <StoryCollaboratorsTab detail={detail} />
        )}
      </div>
    </FloatingWindow>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-t border-b-2 px-3 py-1 text-xs uppercase tracking-widest transition ${
        active
          ? "border-keep-action bg-keep-bg text-keep-action"
          : "border-transparent text-keep-muted hover:text-keep-text"
      }`}
    >
      {children}
    </button>
  );
}

/* =============================================================
 *  New Story wizard
 * ============================================================= */

function NewStoryWizard({
  onCreated,
  onCancel,
}: {
  onCreated: (card: StoryCard) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("scriptorium");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [genre, setGenre] = useState<StoryGenre>("other");
  const [rating, setRating] = useState<StoryRating>("PG");
  /** Empty string = master account; otherwise a character id. Allows
   *  the same master to publish under multiple identities (a personal
   *  byline vs. an in-character serial). */
  const [authorCharacterId, setAuthorCharacterId] = useState<string>("");
  const [characters, setCharacters] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/characters", { credentials: "include" });
        if (!r.ok) return;
        const j = (await r.json()) as { characters: { id: string; name: string }[] };
        if (!cancelled) setCharacters(j.characters ?? []);
      } catch {
        // Non-critical, the selector falls back to master-only.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const previewSlug = slug.trim() || deriveSlug(title);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          ...(slug.trim() ? { slug: slug.trim().toLowerCase() } : {}),
          ...(authorCharacterId ? { authorCharacterId } : {}),
          genre,
          rating,
        }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const card = (await r.json()) as StoryCard;
      onCreated(card);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("errors.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 p-4">
      {err ? <p className="text-xs text-keep-accent">{err}</p> : null}

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("editor.titleLabel")}</label>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-base"
          placeholder={t("editor.titlePlaceholder")}
        />
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("editor.slugLabel")}</label>
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          maxLength={60}
          placeholder={t("editor.slugPlaceholder")}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm font-mono"
        />
        <p className="mt-1 text-[10px] text-keep-muted">
          {t("editor.urlLabel")} <code>/stories/@you/{previewSlug || "your-slug"}</code>
        </p>
      </div>

      {characters.length > 0 ? (
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("editor.postingAs")}</label>
          <select
            value={authorCharacterId}
            onChange={(e) => setAuthorCharacterId(e.target.value)}
            className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm"
          >
            <option value="">{t("editor.postingAsYou")}</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-keep-muted">
            {t("editor.postingAsHint")}
          </p>
        </div>
      ) : null}

      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("genre")}</label>
        <select
          value={genre}
          onChange={(e) => setGenre(e.target.value as StoryGenre)}
          className="mt-1 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm"
        >
          {STORY_GENRES.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{t("rating.legend")}</label>
        <div className="mt-1">
          <RatingPicker value={rating} onChange={setRating} name="new-story-rating" compact />
        </div>
      </div>

      <p className="rounded border border-keep-rule bg-keep-panel/40 px-2 py-1.5 text-[11px] text-keep-muted">
        {t("editor.startsPrivateNote")}
      </p>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm text-keep-muted hover:text-keep-text"
        >
          {t("common:cancel")}
        </button>
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="rounded border border-keep-action bg-keep-action px-4 py-1 text-sm font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50"
        >
          {busy ? t("editor.creatingDots") : t("editor.createDraft")}
        </button>
      </div>
    </form>
  );
}

/* =============================================================
 *  Overview tab, story meta editor
 * ============================================================= */

function OverviewEditor({
  detail,
  onSaved,
  onDelete,
}: {
  detail: StoryDetail;
  onSaved: () => Promise<void> | void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("scriptorium");
  const s = detail.story;
  const [title, setTitle] = useState(s.title);
  const [slug, setSlug] = useState(s.slug);
  const [summary, setSummary] = useState(s.summary);
  const [synopsisHtml, setSynopsisHtml] = useState(s.synopsisHtml);
  const [coverImageUrl, setCoverImageUrl] = useState(s.coverImageUrl ?? "");
  const [genre, setGenre] = useState<StoryGenre>(s.genre);
  const [rating, setRating] = useState<StoryRating>(s.rating);
  const [visibility, setVisibility] = useState<StoryVisibility>(s.visibility);
  const [status, setStatus] = useState<StoryStatus>(s.status);
  const [tags, setTags] = useState<string[]>(s.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [cws, setCws] = useState<string[]>(s.contentWarnings);
  const [allowReviews, setAllowReviews] = useState(s.allowReviews);
  const [allowApplause, setAllowApplause] = useState(s.allowApplause);
  const [buyToRead, setBuyToRead] = useState(s.buyToRead);
  // Raw text so the field can be blank (= inherit the site default price).
  const [copyPrice, setCopyPrice] = useState<string>(
    detail.copyPriceCustom != null ? String(detail.copyPriceCustom) : "",
  );
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function addTag(t: string) {
    const norm = t.trim().toLowerCase();
    if (!norm || tags.includes(norm)) return;
    setTags([...tags, norm]);
    setTagDraft("");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (title.trim() !== s.title) body.title = title.trim();
      if (slug.trim() && slug.trim().toLowerCase() !== s.slug) body.slug = slug.trim().toLowerCase();
      if (summary !== s.summary) body.summary = summary;
      if (synopsisHtml !== s.synopsisHtml) body.synopsisHtml = synopsisHtml;
      const coverNext = coverImageUrl.trim() === "" ? null : coverImageUrl.trim();
      if (coverNext !== (s.coverImageUrl ?? null)) body.coverImageUrl = coverNext;
      if (genre !== s.genre) body.genre = genre;
      if (rating !== s.rating) body.rating = rating;
      if (visibility !== s.visibility) body.visibility = visibility;
      if (status !== s.status) body.status = status;
      if (tags.join(",") !== s.tags.join(",")) body.tags = tags;
      if (cws.join(",") !== s.contentWarnings.join(",")) body.contentWarnings = cws;
      if (allowReviews !== s.allowReviews) body.allowReviews = allowReviews;
      if (allowApplause !== s.allowApplause) body.allowApplause = allowApplause;
      if (buyToRead !== s.buyToRead) body.buyToRead = buyToRead;
      // Price: blank → null (inherit site default); else a whole number in
      // the allowed bracket. Only send it when it actually changed.
      const priceTrimmed = copyPrice.trim();
      let copyPriceNext: number | null = null;
      if (priceTrimmed !== "") {
        const n = Math.round(Number(priceTrimmed));
        if (!Number.isFinite(n) || n < STORY_COPY_PRICE_MIN || n > STORY_COPY_PRICE_MAX) {
          setErr(t("editor.priceRangeError", { min: STORY_COPY_PRICE_MIN, max: STORY_COPY_PRICE_MAX }));
          setBusy(false);
          return;
        }
        copyPriceNext = n;
      }
      if (copyPriceNext !== (detail.copyPriceCustom ?? null)) body.copyPrice = copyPriceNext;
      if (Object.keys(body).length === 0) { setBusy(false); return; }
      const r = await fetch(`/stories/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r));
      setSavedAt(Date.now());
      await onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("errors.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {err ? (
        <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{err}</div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 [@container(min-width:768px)]:grid-cols-2">
        <Field label={t("editor.titleLabel")}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5" />
        </Field>
        <Field label={t("editor.slugLabel")}>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} maxLength={60}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 font-mono text-sm" />
        </Field>
      </div>

      <Field label={t("editor.summaryLabel", { length: summary.length })}>
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={280} rows={2}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm" />
      </Field>

      <Field label={t("editor.synopsisLabel")}>
        <RichEditor
          value={synopsisHtml}
          onChange={setSynopsisHtml}
          placeholder={t("editor.synopsisPlaceholder")}
          minHeight="10rem"
        />
      </Field>

      <Field label={t("editor.coverImageLabel")}>
        <input value={coverImageUrl} onChange={(e) => setCoverImageUrl(e.target.value)}
          placeholder="https://..." className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm" />
        {coverImageUrl ? (
          <img src={coverImageUrl} alt={t("editor.coverPreviewAlt")} referrerPolicy="no-referrer"
            className="mt-2 h-32 w-auto rounded border border-keep-rule object-cover" />
        ) : null}
      </Field>

      <div className="grid grid-cols-1 gap-3 [@container(min-width:768px)]:grid-cols-3">
        <Field label={t("genre")}>
          <select value={genre} onChange={(e) => setGenre(e.target.value as StoryGenre)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm">
            {STORY_GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </Field>
        <Field label={t("editor.visibilityLabel")}>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as StoryVisibility)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm">
            <option value="private">{t("editor.visibility.private")}</option>
            <option value="unlisted">{t("editor.visibility.unlisted")}</option>
            <option value="public">{t("editor.visibility.public")}</option>
          </select>
        </Field>
        <Field label={t("statusLabel")}>
          <select value={status} onChange={(e) => setStatus(e.target.value as StoryStatus)}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm">
            {STORY_STATUSES.map((s) => <option key={s} value={s}>{t(`statusesLower.${s}`)}</option>)}
          </select>
        </Field>
      </div>

      <Field label={t("editor.ratingFieldLabel")}>
        <RatingPicker value={rating} onChange={setRating} name="story-rating" />
      </Field>

      <Field label={t("catalog.tags")}>
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <button key={t} type="button"
              onClick={() => setTags(tags.filter((x) => x !== t))}
              className="rounded-full border border-keep-action bg-keep-action/15 px-2 py-0.5 text-xs text-keep-action">
              {t} ×
            </button>
          ))}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(tagDraft); } }}
            placeholder={t("editor.addTagPlaceholder")}
            className="w-48 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs" />
          <span className="text-[10px] text-keep-muted">{tags.length}/20</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {STORY_CANONICAL_TAGS.filter((t) => !tags.includes(t)).map((t) => (
            <button key={t} type="button" onClick={() => addTag(t)}
              className="rounded-full border border-keep-rule bg-keep-bg px-2 py-0.5 text-[11px] text-keep-muted hover:text-keep-text">
              + {t}
            </button>
          ))}
        </div>
      </Field>

      <Field label={t("editor.contentWarningsLabel")}>
        <div className="flex flex-wrap gap-1">
          {STORY_CONTENT_WARNINGS.map((c) => {
            const on = cws.includes(c);
            return (
              <button key={c} type="button"
                onClick={() => setCws(on ? cws.filter((x) => x !== c) : [...cws, c])}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                  on ? "border-keep-accent bg-keep-accent/15 text-keep-accent" : "border-keep-rule bg-keep-bg text-keep-muted"
                }`}>
                {c}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="grid grid-cols-1 gap-3 [@container(min-width:768px)]:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allowReviews} onChange={(e) => setAllowReviews(e.target.checked)} />
          {t("editor.allowReviews")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allowApplause} onChange={(e) => setAllowApplause(e.target.checked)} />
          {t("editor.allowApplause")}
        </label>
      </div>

      <Field label={t("editor.copyPriceLabel")}>
        <input
          type="number"
          inputMode="numeric"
          min={STORY_COPY_PRICE_MIN}
          max={STORY_COPY_PRICE_MAX}
          value={copyPrice}
          onChange={(e) => setCopyPrice(e.target.value)}
          placeholder={t("editor.priceDefaultPlaceholder", { price: detail.copyPriceDefault })}
          className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1.5"
        />
        <p className="mt-1 text-[11px] text-keep-muted">
          {t("editor.copyPriceHelp", {
            price: detail.copyPriceDefault,
            min: STORY_COPY_PRICE_MIN,
            max: STORY_COPY_PRICE_MAX,
          })}
        </p>
      </Field>

      <Field label={t("editor.buyToReadLabel")}>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={buyToRead}
            onChange={(e) => setBuyToRead(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            {t("editor.buyToReadHint")}
          </span>
        </label>
      </Field>

      <div className="flex items-center justify-between border-t border-keep-rule pt-3">
        <button type="button" onClick={onDelete}
          className="rounded border border-keep-accent/40 bg-keep-accent/10 px-3 py-1 text-xs text-keep-accent hover:bg-keep-accent/20">
          {t("editor.deleteStory")}
        </button>
        <div className="flex items-center gap-3">
          {savedAt ? <span className="text-[11px] italic text-keep-muted">{t("saved")}</span> : null}
          <button type="submit" disabled={busy}
            className="rounded border border-keep-action bg-keep-action px-4 py-1 text-sm font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
            {busy ? t("common:savingDots") : t("common:save")}
          </button>
        </div>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-widest text-keep-muted">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/* =============================================================
 *  Chapters tab, list + editor pane
 * ============================================================= */

function ChaptersTab({
  detail,
  selectedChapterId,
  onSelectChapter,
  onReload,
}: {
  detail: StoryDetail;
  selectedChapterId: string | null;
  onSelectChapter: (id: string | null) => void;
  onReload: () => Promise<void> | void;
}) {
  const { t } = useTranslation("scriptorium");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [orderedIds, setOrderedIds] = useState<string[]>(() => detail.chapters.map((c) => c.id));
  useEffect(() => {
    setOrderedIds(detail.chapters.map((c) => c.id));
  }, [detail.chapters]);

  const chapterMap = useMemo(() => {
    const m = new Map<string, StoryChapterRef>();
    for (const c of detail.chapters) m.set(c.id, c);
    return m;
  }, [detail.chapters]);

  const selectedRef = selectedChapterId ? chapterMap.get(selectedChapterId) ?? null : null;

  async function addChapter() {
    if (detail.chapters.length >= STORY_CHAPTER_CAP) {
      setErr(t("editor.chapterCapReached", { cap: STORY_CHAPTER_CAP }));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/stories/${detail.story.id}/chapters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(await readError(r));
      const created = (await r.json()) as StoryChapter;
      await onReload();
      onSelectChapter(created.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function deleteChapter(id: string) {
    const c = chapterMap.get(id);
    if (!c) return;
    if (!window.confirm(t("editor.confirmDeleteChapter", {
      title: c.title || t("editor.chapterN", { number: c.sortOrder + 1 }),
    }))) return;
    try {
      const r = await fetch(`/stories/${detail.story.id}/chapters/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await readError(r));
      if (selectedChapterId === id) onSelectChapter(null);
      await onReload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.deleteFailed"));
    }
  }

  async function commitReorder(nextOrder: string[]) {
    setOrderedIds(nextOrder);
    try {
      const r = await fetch(`/stories/${detail.story.id}/chapters/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: nextOrder }),
      });
      if (!r.ok) throw new Error(await readError(r));
      await onReload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.reorderFailed"));
      setOrderedIds(detail.chapters.map((c) => c.id));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col [@container(min-width:768px)]:flex-row">
      <aside className="flex shrink-0 flex-col border-keep-rule [@container(min-width:768px)]:w-72 [@container(min-width:768px)]:border-r">
        <div className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner/40 px-3 py-1.5 text-xs">
          <span className="uppercase tracking-widest text-keep-muted">{t("editor.tabs.chapters")}</span>
          <button type="button" onClick={addChapter} disabled={busy}
            className="rounded border border-keep-rule bg-keep-bg px-1.5 py-0.5 text-[11px] hover:bg-keep-banner disabled:opacity-50"
            title={t("editor.addChapterTitle")}>
            {t("editor.addChapter")}
          </button>
        </div>
        {err ? <p className="border-b border-keep-rule bg-keep-accent/10 px-2 py-1 text-[11px] text-keep-accent">{err}</p> : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {orderedIds.length === 0 ? (
            <p className="p-3 text-xs italic text-keep-muted">{t("editor.noChaptersYet")}</p>
          ) : (
            <ChapterList
              orderedIds={orderedIds}
              chapterMap={chapterMap}
              selectedId={selectedChapterId}
              onSelect={onSelectChapter}
              onDelete={deleteChapter}
              onReorder={commitReorder}
            />
          )}
        </div>
      </aside>

      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {selectedRef ? (
          <ChapterEditor
            key={selectedRef.id}
            storyId={detail.story.id}
            chapterRef={selectedRef}
            onSaved={() => onReload()}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-keep-muted">
            {detail.chapters.length === 0
              ? t("editor.clickAddChapter")
              : t("editor.pickChapter")}
          </div>
        )}
      </section>
    </div>
  );
}

function ChapterList({
  orderedIds,
  chapterMap,
  selectedId,
  onSelect,
  onDelete,
  onReorder,
}: {
  orderedIds: string[];
  chapterMap: Map<string, StoryChapterRef>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (nextOrder: string[]) => void;
}) {
  const { t } = useTranslation("scriptorium");
  function move(id: string, dir: -1 | 1) {
    const idx = orderedIds.indexOf(id);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= orderedIds.length) return;
    const next = orderedIds.slice();
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    onReorder(next);
  }
  return (
    <ul className="space-y-0.5">
      {orderedIds.map((id, idx) => {
        const c = chapterMap.get(id);
        if (!c) return null;
        const selected = selectedId === c.id;
        return (
          <li key={c.id} className={`group rounded ${selected ? "bg-keep-action/15" : "hover:bg-keep-muted/20"}`}>
            <div className="flex items-center gap-1 px-1 py-1">
              <span className="w-6 text-right text-[10px] tabular-nums text-keep-muted">{idx + 1}.</span>
              <button type="button" onClick={() => onSelect(c.id)}
                className={`min-w-0 flex-1 truncate text-left text-xs ${selected ? "text-keep-action" : "text-keep-text"}`}
                title={c.title || t("editor.chapterN", { number: idx + 1 })}>
                {c.title || t("editor.chapterN", { number: idx + 1 })}
                {c.status === "published" ? (
                  <span className="ml-1 rounded bg-emerald-500/15 px-1 py-0 text-[9px] uppercase tracking-widest text-emerald-300">
                    {t("editor.pubChip")}
                  </span>
                ) : (
                  <span className="ml-1 rounded bg-keep-muted/25 px-1 py-0 text-[9px] uppercase tracking-widest text-keep-muted">
                    {t("editor.draftChip")}
                  </span>
                )}
              </button>
              <div className="flex gap-0.5 opacity-60 group-hover:opacity-100 focus-within:opacity-100">
                <button type="button" onClick={() => move(c.id, -1)} disabled={idx === 0}
                  className="rounded border border-keep-rule px-1 text-[10px] text-keep-muted disabled:opacity-30"
                  title={t("editor.moveUp")}>↑</button>
                <button type="button" onClick={() => move(c.id, 1)} disabled={idx === orderedIds.length - 1}
                  className="rounded border border-keep-rule px-1 text-[10px] text-keep-muted disabled:opacity-30"
                  title={t("editor.moveDown")}>↓</button>
                <button type="button" onClick={() => onDelete(c.id)}
                  className="rounded border border-keep-accent/40 px-1 text-[10px] text-keep-accent"
                  title={t("common:delete")}>×</button>
              </div>
            </div>
            <div className="pl-7 pr-2 pb-1 text-[10px] text-keep-muted tabular-nums">
              {t("editor.wordsCount", { formatted: formatNumber(c.wordCount) })}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* =============================================================
 *  Chapter editor
 * ============================================================= */

function ChapterEditor({
  storyId,
  chapterRef,
  onSaved,
}: {
  storyId: string;
  chapterRef: StoryChapterRef;
  onSaved: () => Promise<void> | void;
}) {
  const { t } = useTranslation("scriptorium");
  const [full, setFull] = useState<StoryChapter | null>(null);
  const [title, setTitle] = useState(chapterRef.title);
  const [body, setBody] = useState("");
  const [notes, setNotes] = useState("");
  const [cws, setCws] = useState<string[]>(chapterRef.contentWarnings);
  const [previewing, setPreviewing] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  /* ---------- Soft-lock (Phase 5) ----------
   *
   * Advisory chapter-edit lock. When a second collaborator opens the
   * chapter, the lock POST returns the holder's identity and the
   * banner gates the textarea into read-only. The user can "Force
   * edit" anyway, saves still go through, the version table captures
   * the divergence. Heartbeat every STORY_CHAPTER_LOCK_HEARTBEAT_MS;
   * release on unmount.
   */
  const [lock, setLock] = useState<StoryChapterLockState | null>(null);
  const [forceEdit, setForceEdit] = useState(false);
  /** The chapter `updatedAt` we last surfaced a divergence for, i.e.
   *  the value seen on the heartbeat that beat our loaded snapshot. */
  const [lastDivergedAt, setLastDivergedAt] = useState<number>(0);
  /** The user can dismiss the banner; we store the value they dismissed
   *  so the banner stays hidden until ANOTHER, newer save happens. */
  const [divergeDismissedFor, setDivergeDismissedFor] = useState<number>(0);
  /** updatedAt we last observed for this chapter row (initial load or
   *  after our own save). Heartbeat compares this against the lock
   *  payload's `currentUpdatedAt`, a newer server value means someone
   *  else saved while we were editing. */
  const loadedUpdatedAtRef = useRef<number>(0);

  const loadChapter = useCallback(async (signal?: { cancelled: boolean }) => {
    setErr(null);
    setFull(null);
    try {
      const r = await fetch(`/stories/${storyId}/chapters/${chapterRef.id}`);
      if (!r.ok) throw new Error(await readError(r));
      const c = (await r.json()) as StoryChapter;
      if (signal?.cancelled) return;
      setFull(c);
      setTitle(c.title);
      setBody(c.bodyHtml);
      setNotes(c.authorNotesHtml);
      setCws(c.contentWarnings);
      setLastDivergedAt(0);
      setDivergeDismissedFor(0);
    } catch (e) {
      if (!signal?.cancelled) setErr(e instanceof Error ? e.message : t("errors.loadFailed"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId, chapterRef.id]);

  useEffect(() => {
    const signal = { cancelled: false };
    void loadChapter(signal);
    return () => { signal.cancelled = true; };
  }, [loadChapter]);

  // Sync our "last known savepoint" whenever the chapter row reloads.
  useEffect(() => {
    if (!full) return;
    loadedUpdatedAtRef.current = full.updatedAt;
  }, [full]);

  // Acquire + heartbeat the lock; release on chapter change / unmount.
  // The boolean `full !== null` flips exactly once per chapter (null →
  // loaded), which is when we want to start heartbeating. Subsequent
  // saves update `full` to a fresh object but keep this boolean true,
  // so the interval is not torn down between saves.
  const fullLoaded = full !== null;
  useEffect(() => {
    if (!fullLoaded) return;
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetch(`/stories/${storyId}/chapters/${chapterRef.id}/lock`, {
          method: "POST",
        });
        if (!r.ok) return;
        const j = (await r.json()) as StoryChapterLockState;
        if (cancelled) return;
        setLock(j);
        if (j.currentUpdatedAt > loadedUpdatedAtRef.current) setLastDivergedAt(j.currentUpdatedAt);
      } catch {
        // Network blip, try again on the next tick.
      }
    }
    void tick();
    const id = window.setInterval(tick, STORY_CHAPTER_LOCK_HEARTBEAT_MS);
    // Backgrounded tabs throttle setInterval, refresh the moment the
    // user comes back so the lock doesn't lapse mid-session and the
    // banner can pick up someone else taking over while we were away.
    const onVis = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      // Best-effort release. No-op server-side if we don't hold it.
      void fetch(`/stories/${storyId}/chapters/${chapterRef.id}/lock`, { method: "DELETE" })
        .catch(() => {});
    };
  }, [storyId, chapterRef.id, fullLoaded]);

  const isReadOnly = !!(lock && !lock.heldByMe && !forceEdit);
  const showDivergence = lastDivergedAt > 0 && lastDivergedAt > divergeDismissedFor;

  const liveWords = useMemo(() => countWords(body), [body]);

  const lastSavedBody = useRef({ body: "", notes: "", title: "" });
  useEffect(() => {
    if (!full) return;
    lastSavedBody.current = { body: full.bodyHtml, notes: full.authorNotesHtml, title: full.title };
  }, [full]);

  const isDirty =
    !!full &&
    (body !== lastSavedBody.current.body
      || notes !== lastSavedBody.current.notes
      || title !== lastSavedBody.current.title
      || cws.join(",") !== chapterRef.contentWarnings.join(","));

  // Autosave drafts on 5s debounce.
  // Suppressed in read-only mode (lock held by someone else and we
  // haven't force-edited) so we don't silently overwrite their work.
  useEffect(() => {
    if (!full || full.status !== "draft") return;
    if (isReadOnly) return;
    const dirty =
      body !== lastSavedBody.current.body ||
      notes !== lastSavedBody.current.notes ||
      title !== lastSavedBody.current.title ||
      cws.join(",") !== chapterRef.contentWarnings.join(",");
    if (!dirty) return;
    const t = window.setTimeout(() => { void save("autosave"); }, 5000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, notes, title, cws, full, isReadOnly]);

  async function save(reason: "autosave" | "manual" | "publish" | "unpublish") {
    if (!full) return;
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {};
      if (title !== full.title) payload.title = title;
      if (body !== full.bodyHtml) payload.bodyHtml = body;
      if (notes !== full.authorNotesHtml) payload.authorNotesHtml = notes;
      if (cws.join(",") !== full.contentWarnings.join(",")) payload.contentWarnings = cws;
      if (reason === "publish") payload.status = "published";
      if (reason === "unpublish") payload.status = "draft";
      if (reason === "manual") payload.reason = "manual";
      const r = await fetch(`/stories/${storyId}/chapters/${chapterRef.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await readError(r));
      const updated = (await r.json()) as StoryChapter;
      setFull(updated);
      setTitle(updated.title);
      setBody(updated.bodyHtml);
      setNotes(updated.authorNotesHtml);
      setCws(updated.contentWarnings);
      lastSavedBody.current = { body: updated.bodyHtml, notes: updated.authorNotesHtml, title: updated.title };
      setSavedAt(Date.now());
      // The pill is a brief flash, not a permanent badge, the dirty
      // indicator below tells the user whether the buffer is actually
      // in sync. 4s is long enough to register, short enough to fade.
      window.setTimeout(() => {
        setSavedAt((prev) => (prev && Date.now() - prev >= 4000 ? null : prev));
      }, 4000);
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!full && err) {
    return <p className="p-4 text-xs text-keep-accent">{err}</p>;
  }
  if (!full) {
    return <p className="p-4 italic text-keep-muted">{t("editor.loadingChapter")}</p>;
  }

  const published = full.status === "published";

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-keep-rule bg-keep-panel/30 px-3 py-2 text-xs">
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120}
          placeholder={t("editor.chapterN", { number: chapterRef.sortOrder + 1 })}
          readOnly={isReadOnly}
          className="min-w-0 flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm read-only:opacity-60" />
        <span className="text-[11px] tabular-nums text-keep-muted">{t("editor.wordsCount", { formatted: formatNumber(liveWords) })}</span>
        <button type="button" onClick={() => setPreviewing((v) => !v)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1">
          {previewing ? t("edit") : t("common:preview")}
        </button>
        <button type="button" onClick={() => setShowHistory((v) => !v)}
          className="rounded border border-keep-rule bg-keep-bg px-2 py-1">
          {showHistory ? t("editor.hideHistory") : t("editor.history")}
        </button>
        {published ? (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t("editor.confirmUnpublish"))) {
                void save("unpublish");
              }
            }}
            disabled={busy || isReadOnly}
            className="rounded border border-keep-rule bg-keep-bg px-2 py-1 text-keep-muted disabled:opacity-50"
          >
            {t("editor.unpublish")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t("editor.confirmPublish"))) {
                void save("publish");
              }
            }}
            disabled={busy || isReadOnly}
            className="rounded border border-emerald-500 bg-emerald-500/15 px-2 py-1 font-semibold uppercase tracking-widest text-emerald-300 disabled:opacity-50"
          >
            {t("editor.publish")}
          </button>
        )}
        <button type="button" onClick={() => save("manual")} disabled={busy || isReadOnly}
          className="rounded border border-keep-action bg-keep-action px-2 py-1 font-semibold uppercase tracking-widest text-keep-bg disabled:opacity-50">
          {busy ? t("common:savingDots") : t("common:save")}
        </button>
        {busy ? null : isDirty ? (
          <span className="text-[10px] italic text-amber-300">{t("editor.unsavedChanges")}</span>
        ) : savedAt ? (
          <span className="text-[10px] italic text-keep-muted">{t("saved")}</span>
        ) : null}
      </div>

      {isReadOnly && lock?.holder ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-keep-rule bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <span className="font-semibold">{t("editor.lockHolder", { name: lock.holder.username })}</span>
          <span className="text-amber-300/80">{t("editor.readOnlyNote")}</span>
          <button
            type="button"
            onClick={() => setForceEdit(true)}
            className="ml-auto rounded border border-amber-400 bg-amber-500/20 px-2 py-1 font-semibold uppercase tracking-widest text-amber-100"
          >
            {t("editor.forceEdit")}
          </button>
        </div>
      ) : null}

      {forceEdit && lock && !lock.heldByMe ? (
        <div className="border-b border-keep-rule bg-amber-500/5 px-3 py-1 text-[11px] italic text-amber-300/80">
          {t("editor.forceEditingNote", { name: lock.holder?.username ?? t("editor.anotherCollaborator") })}
        </div>
      ) : null}

      {showDivergence ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-keep-rule bg-keep-accent/10 px-3 py-2 text-xs text-keep-accent">
          <span className="font-semibold">{t("editor.divergenceWarning")}</span>
          <span className="opacity-80">{t("editor.divergenceNote")}</span>
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="rounded border border-keep-accent/60 bg-keep-bg px-2 py-1"
          >
            {t("editor.viewHistory")}
          </button>
          <button
            type="button"
            onClick={() => { void loadChapter(); }}
            className="rounded border border-keep-accent bg-keep-accent/20 px-2 py-1 font-semibold uppercase tracking-widest"
          >
            {t("editor.reload")}
          </button>
          <button
            type="button"
            onClick={() => setDivergeDismissedFor(lastDivergedAt)}
            title={t("editor.dismissTitle")}
            className="ml-auto rounded border border-keep-accent/40 bg-keep-bg px-2 py-1"
          >
            {t("editor.dismiss")}
          </button>
        </div>
      ) : null}

      {err ? <p className="border-b border-keep-rule bg-keep-accent/10 px-3 py-1 text-xs text-keep-accent">{err}</p> : null}

      {showHistory ? (
        <VersionHistoryPane
          storyId={storyId}
          chapterId={chapterRef.id}
          onRestore={(v) => {
            setBody(v.bodyHtml);
            setNotes(v.authorNotesHtml);
            setShowHistory(false);
          }}
          onClose={() => setShowHistory(false)}
        />
      ) : previewing ? (
        <div className="flex-1 overflow-y-auto p-6">
          {body ? (
            <article className="prose mx-auto max-w-prose text-keep-text"
              dangerouslySetInnerHTML={{ __html: body }} />
          ) : (
            <article className="prose mx-auto max-w-prose text-keep-text">
              <p><i>{t("editor.emptyChapterPreview")}</i></p>
            </article>
          )}
          {notes ? (
            <div className="mx-auto mt-6 max-w-prose border-t border-keep-rule pt-3 text-sm text-keep-muted">
              <h4 className="mb-1 text-xs uppercase tracking-widest">{t("authorsNotes")}</h4>
              <div className="prose prose-sm" dangerouslySetInnerHTML={{ __html: notes }} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 flex-col gap-2 p-3">
          <RichEditor
            value={body}
            onChange={setBody}
            readOnly={isReadOnly}
            enableMarginNote
            placeholder={t("editor.chapterBodyPlaceholder")}
            minHeight="24rem"
          />
          <details className="rounded border border-keep-rule bg-keep-panel/30">
            <summary className="cursor-pointer px-3 py-1.5 text-xs uppercase tracking-widest text-keep-muted">
              {t("editor.authorsNotesOptional")}
            </summary>
            <div className="border-t border-keep-rule p-2">
              <RichEditor
                value={notes}
                onChange={setNotes}
                readOnly={isReadOnly}
                placeholder={t("editor.notesPlaceholder")}
                minHeight="6rem"
              />
            </div>
          </details>
          <details className="rounded border border-keep-rule bg-keep-panel/30">
            <summary className="cursor-pointer px-3 py-1.5 text-xs uppercase tracking-widest text-keep-muted">
              {t("editor.chapterCwLabel")}
            </summary>
            <div className="flex flex-wrap gap-1 border-t border-keep-rule p-2">
              {STORY_CONTENT_WARNINGS.map((c) => {
                const on = cws.includes(c);
                return (
                  <button key={c} type="button"
                    onClick={() => setCws(on ? cws.filter((x) => x !== c) : [...cws, c])}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${
                      on ? "border-keep-accent bg-keep-accent/15 text-keep-accent" : "border-keep-rule bg-keep-bg text-keep-muted"
                    }`}>
                    {c}
                  </button>
                );
              })}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

/* =============================================================
 *  Version history pane
 * ============================================================= */

function VersionHistoryPane({
  storyId,
  chapterId,
  onRestore,
  onClose,
}: {
  storyId: string;
  chapterId: string;
  onRestore: (v: StoryChapterVersion) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("scriptorium");
  const [versions, setVersions] = useState<StoryChapterVersion[] | null>(null);
  const [active, setActive] = useState<StoryChapterVersion | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/stories/${storyId}/chapters/${chapterId}/versions`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return (await r.json()) as { versions: StoryChapterVersion[] };
      })
      .then((j) => {
        if (cancelled) return;
        setVersions(j.versions);
        setActive(j.versions[0] ?? null);
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : t("errors.loadFailed")); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId, chapterId]);

  return (
    <div className="flex flex-1 min-h-0 flex-col [@container(min-width:768px)]:flex-row">
      <aside className="border-keep-rule [@container(min-width:768px)]:w-56 [@container(min-width:768px)]:shrink-0 [@container(min-width:768px)]:border-r">
        <div className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner/40 px-3 py-1.5">
          <span className="text-xs uppercase tracking-widest text-keep-muted">{t("editor.history")}</span>
          <button type="button" onClick={onClose} className="text-keep-muted hover:text-keep-text" title={t("editor.closeHistory")}>×</button>
        </div>
        {err ? <p className="p-2 text-xs text-keep-accent">{err}</p> : null}
        {versions === null ? <p className="p-2 italic text-keep-muted">{t("common:loadingDots")}</p> : null}
        {versions?.length === 0 ? <p className="p-2 italic text-keep-muted">{t("editor.noVersions")}</p> : null}
        <ul className="overflow-y-auto">
          {versions?.map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => setActive(v)}
                className={`w-full px-2 py-1.5 text-left text-xs ${
                  active?.id === v.id ? "bg-keep-action/15 text-keep-action" : "hover:bg-keep-muted/20"
                }`}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold tabular-nums">v{v.version}</span>
                  <span className={`rounded px-1 py-0 text-[9px] uppercase tracking-widest ${
                    v.reason === "publish"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : v.reason === "manual"
                        ? "bg-sky-500/15 text-sky-300"
                        : "bg-keep-muted/25 text-keep-muted"
                  }`}>{v.reason}</span>
                </div>
                <div className="text-[10px] text-keep-muted">
                  {formatDateTime(v.savedAt)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-keep-rule bg-keep-panel/30 px-3 py-1.5">
          <span className="text-xs text-keep-muted">
            {active ? t("editor.previewVersion", { version: active.version }) : t("editor.pickVersion")}
          </span>
          {active ? (
            <button type="button" onClick={() => onRestore(active)}
              className="rounded border border-keep-action bg-keep-action px-2 py-0.5 text-xs font-semibold uppercase tracking-widest text-keep-bg">
              {t("editor.restoreIntoDraft")}
            </button>
          ) : null}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {active ? (
            active.bodyHtml ? (
              <article className="prose max-w-prose text-keep-text"
                dangerouslySetInnerHTML={{ __html: active.bodyHtml }} />
            ) : (
              <article className="prose max-w-prose text-keep-text">
                <p><i>{t("editor.emptyVersion")}</i></p>
              </article>
            )
          ) : null}
        </div>
      </section>
    </div>
  );
}
