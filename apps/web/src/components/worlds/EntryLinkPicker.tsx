/**
 * "+ Link entry" affordance for world body editors. Opens a filterable list of
 * the world's entries (+ Lore pages) and, on pick, inserts an `@kind:slug`
 * token via the supplied callback. The decorator (worldMentions) turns those
 * tokens into clickable chips in the viewer.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorldEntityLight } from "@thekeep/shared";

export interface LinkTarget {
  kind: string;
  slug: string;
  label: string;
  /** Display group header (kind label or "Lore"). */
  group: string;
}

export function buildLinkTargets(
  entities: WorldEntityLight[],
  pages: Array<{ slug: string; title: string }>,
  kindLabel: (kind: string) => string,
): LinkTarget[] {
  const out: LinkTarget[] = entities.map((e) => ({
    kind: e.kind, slug: e.slug, label: e.name, group: kindLabel(e.kind),
  }));
  for (const p of pages) out.push({ kind: "lore", slug: p.slug, label: p.title, group: "Lore" });
  return out;
}

export function EntryLinkPicker({ targets, onPick }: { targets: LinkTarget[]; onPick: (token: string) => void }) {
  const { t } = useTranslation("worlds");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? targets.filter((t) => t.label.toLowerCase().includes(needle) || t.slug.includes(needle))
      : targets;
    return list.slice(0, 50);
  }, [targets, q]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-keep-rule px-2 py-0.5 text-[11px] text-keep-muted hover:bg-keep-banner"
        title={t("linkPicker.buttonTitle")}
      >
        {t("linkPicker.button")}
      </button>
    );
  }
  return (
    <div className="rounded border border-keep-rule bg-keep-bg p-2">
      <div className="mb-1 flex items-center gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("linkPicker.searchPlaceholder")}
          className="flex-1 rounded border border-keep-rule bg-keep-bg px-2 py-1 text-xs"
        />
        <button type="button" onClick={() => { setOpen(false); setQ(""); }} className="rounded border border-keep-rule px-2 py-1 text-[11px] text-keep-muted hover:bg-keep-banner">{t("common:close")}</button>
      </div>
      {filtered.length === 0 ? (
        <p className="px-1 py-2 text-xs italic text-keep-muted">{t("linkPicker.noMatches")}</p>
      ) : (
        <ul className="max-h-48 overflow-y-auto">
          {filtered.map((t) => (
            <li key={`${t.kind}:${t.slug}`}>
              <button
                type="button"
                onClick={() => { onPick(`@${t.kind}:${t.slug} `); setOpen(false); setQ(""); }}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-keep-banner"
              >
                <span className="min-w-0 truncate">{t.label}</span>
                <span className="shrink-0 font-mono text-[10px] text-keep-muted">@{t.kind}:{t.slug}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
