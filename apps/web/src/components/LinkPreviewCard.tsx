/**
 * OpenGraph link-preview card (Discord-style) rendered under a message
 * whose body carried a link. Site name, title (the click-through),
 * description, and a thumbnail when the site offered one.
 *
 * The author sees an ✕ — removing the card persists server-side
 * (DELETE /messages/:id/link-preview) and disappears for EVERYONE via
 * the message:update broadcast; this component also hides itself
 * optimistically so the author gets instant feedback.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LinkPreview } from "@thekeep/shared";

export function LinkPreviewCard({ preview, canRemove, messageId }: {
  preview: LinkPreview;
  canRemove: boolean;
  messageId: string;
}) {
  const { t } = useTranslation("common");
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  if (hidden) return null;

  let host = "";
  try { host = new URL(preview.url).hostname.replace(/^www\./, ""); } catch { /* unparsable url */ }

  return (
    <div className="group/lp relative mt-1.5 max-w-md overflow-hidden rounded border border-keep-rule border-l-4 border-l-keep-action/70 bg-keep-panel/40">
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer ugc"
        className="flex gap-3 p-2.5 no-underline"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[10px] uppercase tracking-widest text-keep-muted">
            {preview.siteName ?? host}
          </span>
          {preview.title ? (
            <span className="mt-0.5 block break-words text-sm font-semibold leading-snug text-keep-action group-hover/lp:underline">
              {preview.title}
            </span>
          ) : null}
          {preview.description ? (
            <span className="mt-0.5 line-clamp-3 block text-xs leading-snug text-keep-text/80">
              {preview.description}
            </span>
          ) : null}
        </span>
        {preview.imageUrl ? (
          <img
            src={preview.imageUrl}
            alt=""
            loading="lazy"
            className="h-16 w-16 shrink-0 self-center rounded object-cover md:h-20 md:w-20"
          />
        ) : null}
      </a>
      {canRemove ? (
        <button
          type="button"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            setBusy(true);
            void fetch(`/messages/${encodeURIComponent(messageId)}/link-preview`, {
              method: "DELETE",
              credentials: "include",
            })
              .then((r) => { if (r.ok) setHidden(true); })
              .catch(() => { /* stays visible; retry available */ })
              .finally(() => setBusy(false));
          }}
          title={t("linkPreview.removeTitle")}
          aria-label={t("linkPreview.removeAria")}
          className="absolute right-1 top-1 rounded bg-keep-bg/70 px-1.5 text-xs leading-5 text-keep-muted hover:text-keep-text"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
