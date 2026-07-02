import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { MAX_TAGS_PER_ENTITY, normalizeTag } from "@thekeep/shared";

/**
 * Genre/category tag editor, mirroring the chat-server / forum tag input. Adds a
 * tag on Enter or comma, removes with the chip's × or Backspace-on-empty, and
 * normalizes each tag (lowercase, cleaned) through the shared `normalizeTag`.
 * Caps at MAX_TAGS_PER_ENTITY. Emits the cleaned list up via `onChange`.
 */
export function TagInput({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const full = tags.length >= MAX_TAGS_PER_ENTITY;

  function commit(raw: string) {
    const next = [...tags];
    for (const part of raw.split(",")) {
      const t = normalizeTag(part);
      if (t && !next.includes(t) && next.length < MAX_TAGS_PER_ENTITY) next.push(t);
    }
    onChange(next);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (draft.trim()) commit(draft);
    } else if (e.key === "Backspace" && !draft && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1 rounded border border-keep-rule bg-keep-bg px-2 py-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-full bg-keep-panel/60 px-2 py-0.5 text-xs lowercase text-keep-text"
        >
          {t}
          <button
            type="button"
            onClick={() => onChange(tags.filter((x) => x !== t))}
            aria-label={`Remove ${t}`}
            className="text-keep-muted hover:text-keep-text"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      {!full ? (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => { if (draft.trim()) commit(draft); }}
          placeholder={tags.length ? "Add tag…" : "e.g. high fantasy, 18+, sci-fi"}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
          aria-label="Add a tag"
        />
      ) : (
        <span className="px-1 text-[10px] text-keep-muted">Max {MAX_TAGS_PER_ENTITY} tags</span>
      )}
    </div>
  );
}
