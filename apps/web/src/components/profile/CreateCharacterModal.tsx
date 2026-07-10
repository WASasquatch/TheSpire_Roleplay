import { useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Modal } from "../cosmetics/Modal.js";
import { readError } from "../../lib/http.js";

/**
 * Name-prompt modal for creating a new character. POSTs `/characters`
 * and hands the created row back to the caller via `onCreated` so each
 * surface can do its own post-create navigation (the profile editor
 * jumps to the new character's tabs; the identity switcher switches
 * into it and opens the editor).
 *
 * Generic over the created shape (defaults to the minimal id/name/avatar
 * projection). The server returns the full character row, so a caller
 * that needs the richer fields can pass its own `T`,
 * `CreateCharacterModal<CharacterRow>`, and read them off `onCreated`.
 *
 * Name policy (mirrors the server, see routes/characters.ts):
 *   - A NORMAL (ASCII) space is rejected. The command parser splits
 *     args on ASCII whitespace, so "John Smith" breaks /whisper, /char,
 *     and every other name-taking command, the long-standing "names
 *     with spaces don't work" papercut. We steer creators to a
 *     non-breaking space (Alt+0160 / U+00A0), which the parser treats
 *     as a normal word character, or an underscore.
 *   - Everything else the server allows (letters, numbers, _ - ' and
 *     NBSP) passes the local pre-check; the server stays authoritative.
 */

/** Minimal created-character projection. The POST returns the full row;
 *  this is the subset every caller needs. */
export interface CreatedCharacter {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export function CreateCharacterModal<T = CreatedCharacter>({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (c: T) => void;
}) {
  const { t } = useTranslation("profile");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  // An INTERIOR ASCII space (or tab) is the parser-breaking case we
  // explicitly disallow, surfaced as a dedicated warning + one-click
  // fix below. Edge spaces are ignored, they're trimmed away and
  // harmless, so warning on them would be noise.
  const hasAsciiSpace = /[ \t]/.test(trimmed);
  // Allowed set matches the server regex: letters, numbers, _ - ' and a
  // non-breaking space (U+00A0). ASCII space is deliberately excluded.
  const localValid =
    trimmed.length >= 1 &&
    trimmed.length <= 40 &&
    /^[\p{L}\p{N}_\-'\u00A0]+$/u.test(trimmed);

  /** Swap every normal space for an underscore, the most common fix. */
  function fixSpaces() {
    setName((n) => n.replace(/[ \t]+/g, "_"));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!localValid || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/characters", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const c = await res.json();
      onCreated(c as T);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.createFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal onClose={onCancel} zIndex={60}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="keep-frame w-[min(420px,96vw)] rounded bg-keep-parchment p-4"
      >
        <h3 className="mb-2 font-action text-lg">{t("createCharacter.title")}</h3>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-widest text-keep-muted">{t("fields.characterName")}</span>
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("createCharacter.namePlaceholder")}
            className="w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-base outline-none focus:border-keep-action md:text-sm"
          />
        </label>
        <p className="mt-1 text-[10px] text-keep-muted">
          {t("createCharacter.nameRules")}
        </p>
        {/* Dedicated space warning. Spaces parse as argument separators,
            so a name with one breaks /whisper, /char, etc. Offer the
            one-click underscore fix right next to the explanation. */}
        {hasAsciiSpace ? (
          <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-[11px] text-keep-accent">
            <Trans
              t={t}
              i18nKey="createCharacter.spaceWarning"
              components={{
                cmd: <span className="font-semibold" />,
                mono: <span className="font-mono" />,
                key: <span className="font-semibold" />,
              }}
            />
            <button
              type="button"
              onClick={fixSpaces}
              className="ml-1 rounded border border-keep-accent/50 px-1.5 py-0.5 font-semibold uppercase tracking-wide hover:bg-keep-accent/20"
            >
              {t("createCharacter.replaceSpaces")}
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm hover:bg-keep-banner"
          >
            {t("common:cancel")}
          </button>
          <button
            type="submit"
            disabled={!localValid || submitting}
            className="keep-button rounded border border-keep-rule bg-keep-banner px-3 py-1 text-sm hover:bg-keep-banner/80 disabled:opacity-50"
          >
            {submitting ? t("createCharacter.creating") : t("createCharacter.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
