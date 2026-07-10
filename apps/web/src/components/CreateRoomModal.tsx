import { useEffect, useRef, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useChat } from "../state/store.js";
import { Modal } from "./cosmetics/Modal.js";

interface Props {
  /** Sends a slash command through the same path the composer uses. The
   *  modal builds `/go <name>` (public), `/private <name> <password>`
   *  (private), or `/gopair <name>` (with an 18+ channel) so creation
   *  reuses all the server-side rules (validation, archived-room
   *  resurrection, join + broadcast, error notices). */
  onCommand: (text: string) => void;
  onClose: () => void;
}

/** Mirrors the server's NAME_RX (room.ts) MINUS the space, because the
 *  command layer splits on whitespace (first token = name). We convert
 *  spaces to underscores before validating, matching the existing room
 *  naming convention (Oak_Tavern, BL_Meadow, …). */
const NAME_RX = /^[\p{L}\p{N}_\-']{1,40}$/u;

/**
 * "Create Room" prompt opened from the Rooms header. Collects a room name
 * and, when "Private" is ticked, a password; adults on public rooms can
 * also tick "With an 18+ channel" — an adults-only side feed behind a
 * SFW/18+ toggle on the room's rail row (lib/adultChannel.ts), managed
 * later via /nsfw channel on|off or the server console. Submitting fires
 * the matching slash command and closes; any server-side rejection (name
 * taken, invalid, etc.) surfaces through the existing error-notice toast,
 * exactly as if the user had typed the command.
 */
export function CreateRoomModal({ onCommand, onClose }: Props) {
  const { t } = useTranslation("common");
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState("");
  const [withChannel, setWithChannel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  // Creating an 18+ channel is an adult-only write (the server refuses it
  // anyway); minors simply don't see the option.
  const isAdult = useChat((s) => s.viewerAge.isAdult);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    // Collapse internal whitespace to underscores so a multi-word name
    // survives the command's first-token split intact.
    const cleanName = name.trim().replace(/\s+/g, "_");
    if (!cleanName) {
      setError(t("createRoom.errorNameRequired"));
      return;
    }
    if (!NAME_RX.test(cleanName)) {
      setError(t("createRoom.errorNameInvalid"));
      return;
    }
    // The channel's internal feed is "<name>_Adult" and must fit the same
    // 40-char room-name cap, so the name loses 6 characters of headroom.
    if (withChannel && !isPrivate && cleanName.length > 34) {
      setError(t("createRoom.errorPairNameTooLong"));
      return;
    }
    if (isPrivate && !password.trim()) {
      setError(t("createRoom.errorPasswordRequired"));
      return;
    }

    if (isPrivate) {
      onCommand(`/private ${cleanName} ${password.trim()}`);
    } else if (withChannel) {
      // Creates the room with its 18+ channel and joins the SFW side.
      onCommand(`/gopair ${cleanName}`);
    } else {
      onCommand(`/go ${cleanName}`);
    }
    onClose();
  }

  return (
    <Modal onClose={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="keep-frame w-full rounded bg-keep-bg p-5 text-keep-text md:w-[min(440px,78vw)]"
      >
        <h2 className="font-action text-lg">{t("createRoom.title")}</h2>
        <p className="mt-1 text-sm text-keep-muted">
          <Trans t={t} i18nKey="createRoom.intro">
            Pick a name. Spaces become underscores, so <b>Oak Tavern</b> becomes <b>Oak_Tavern</b>.
          </Trans>
        </p>

        <label className="mt-3 block text-xs uppercase tracking-wider text-keep-muted" htmlFor="create-room-name">
          {t("createRoom.nameLabel")}
        </label>
        <input
          id="create-room-name"
          ref={nameRef}
          type="text"
          value={name}
          maxLength={40}
          onChange={(e) => { setName(e.target.value); setError(null); }}
          autoComplete="off"
          className="mt-1 block w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-base outline-none focus:border-keep-action md:text-sm"
          placeholder={t("createRoom.namePlaceholder")}
        />

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => { setIsPrivate(e.target.checked); setError(null); }}
            className="h-4 w-4 accent-keep-action"
          />
          <span>
            <Trans t={t} i18nKey="createRoom.privateLabel">
              Private <span className="text-keep-muted">(password required to join)</span>
            </Trans>
          </span>
        </label>

        {/* 18+ channel (adults, public rooms only): an adults-only side of
            the room with its own chat feed, behind a SFW/18+ toggle on the
            room's rail row — never a second listed room. */}
        {!isPrivate && isAdult ? (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={withChannel}
              onChange={(e) => { setWithChannel(e.target.checked); setError(null); }}
              className="h-4 w-4 accent-keep-action"
            />
            <span>
              <Trans t={t} i18nKey="createRoom.pairLabel">
                With an 18+ channel <span className="text-keep-muted">(an adults-only side of the room behind a SFW/18+ toggle)</span>
              </Trans>
            </span>
          </label>
        ) : null}

        {isPrivate ? (
          <>
            <label className="mt-3 block text-xs uppercase tracking-wider text-keep-muted" htmlFor="create-room-password">
              {t("password")}
            </label>
            <input
              id="create-room-password"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              autoComplete="new-password"
              className="mt-1 block w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-base outline-none focus:border-keep-action md:text-sm"
              placeholder={t("password")}
            />
          </>
        ) : null}

        {error ? (
          <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm hover:bg-keep-banner"
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            disabled={!name.trim() || (isPrivate && !password.trim())}
            className="rounded border border-keep-action/60 bg-keep-action/10 px-3 py-1 text-sm font-semibold text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
          >
            {t("createRoom.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
