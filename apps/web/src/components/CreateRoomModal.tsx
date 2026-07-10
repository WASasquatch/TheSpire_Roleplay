import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { RoomSummary } from "@thekeep/shared";
import { useChat } from "../state/store.js";
import { Modal } from "./cosmetics/Modal.js";

interface Props {
  /** Sends a slash command through the same path the composer uses. The
   *  create tab builds `/go <name>` (public), `/private <name> <password>`
   *  (private), or `/gopair <name>` (with a linked 18+ twin) so creation
   *  reuses all the server-side rules (validation, archived-room
   *  resurrection, join + broadcast, error notices). */
  onCommand: (text: string) => void;
  /** The viewer's current room list (the rail's payload). Feeds the
   *  "Link 18+ pair" tab's pickers and the existing-pairs list. */
  rooms: RoomSummary[];
  onClose: () => void;
}

/** Mirrors the server's NAME_RX (room.ts) MINUS the space, because the
 *  command layer splits on whitespace (first token = name). We convert
 *  spaces to underscores before validating, matching the existing room
 *  naming convention (Oak_Tavern, BL_Meadow, …). */
const NAME_RX = /^[\p{L}\p{N}_\-']{1,40}$/u;

const FIELD =
  "mt-1 block w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-base outline-none focus:border-keep-action md:text-sm";
const LABEL = "mt-3 block text-xs uppercase tracking-wider text-keep-muted";

/**
 * The Room Builder, opened from the Rooms header's "+ New" button. Two tabs:
 *
 *   "New room"      — name (+ optional password, + optional linked 18+ twin
 *                     via /gopair). Submitting fires the matching slash
 *                     command and closes; server-side rejections surface
 *                     through the usual error-notice toast.
 *
 *   "Link 18+ pair" — pair two EXISTING rooms (the prod reality: rooms like
 *                     OOC_Lobby + OOC_Lobby_Adult already exist) so they
 *                     list as ONE room with a SFW/18+ side toggle. Pick the
 *                     all-ages room and the 18+ room; if the 18+ side isn't
 *                     flagged yet the server flags it as part of linking
 *                     (evicting minors, auditing — the /nsfw core), so the
 *                     owner never has to run commands first. Existing pairs
 *                     are listed below with an Unlink button. Backed by
 *                     POST /rooms/link + /rooms/unlink (the /linkroom and
 *                     /unlinkroom commands remain the chat-first path).
 */
export function CreateRoomModal({ onCommand, rooms, onClose }: Props) {
  const { t } = useTranslation("common");
  const [tab, setTab] = useState<"create" | "pair">("create");
  const isAdult = useChat((s) => s.viewerAge.isAdult);

  return (
    <Modal onClose={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="keep-frame w-full rounded bg-keep-bg p-5 text-keep-text md:w-[min(480px,78vw)]"
      >
        <h2 className="font-action text-lg">{t("createRoom.title")}</h2>
        {/* The pair tab is an adults-only surface (creating/flagging 18+
            rooms is an adult-only write server-side); minors just get the
            plain create form with no tab row at all. */}
        {isAdult ? (
          <div className="mt-2 flex gap-1 border-b border-keep-rule" role="tablist">
            {(["create", "pair"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-action ${
                  tab === key
                    ? "border-keep-action text-keep-text"
                    : "border-transparent text-keep-muted hover:text-keep-text"
                }`}
              >
                {key === "create" ? t("createRoom.tabCreate") : t("createRoom.tabPair")}
              </button>
            ))}
          </div>
        ) : null}
        {tab === "create" || !isAdult ? (
          <CreateTab onCommand={onCommand} onClose={onClose} isAdult={isAdult} />
        ) : (
          <PairTab rooms={rooms} onClose={onClose} />
        )}
      </div>
    </Modal>
  );
}

function CreateTab({ onCommand, onClose, isAdult }: { onCommand: (text: string) => void; onClose: () => void; isAdult: boolean }) {
  const { t } = useTranslation("common");
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState("");
  const [withNsfwPair, setWithNsfwPair] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

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
    // The pair's 18+ twin is "<name>_Adult" and must fit the same 40-char
    // room-name cap, so the base name loses 6 characters of headroom.
    if (withNsfwPair && !isPrivate && cleanName.length > 34) {
      setError(t("createRoom.errorPairNameTooLong"));
      return;
    }
    if (isPrivate && !password.trim()) {
      setError(t("createRoom.errorPasswordRequired"));
      return;
    }

    if (isPrivate) {
      onCommand(`/private ${cleanName} ${password.trim()}`);
    } else if (withNsfwPair) {
      // Creates <name> (SFW) + <name>_Adult (18+), linked as one rail entry
      // with a SFW/18+ side toggle, and joins the SFW side.
      onCommand(`/gopair ${cleanName}`);
    } else {
      onCommand(`/go ${cleanName}`);
    }
    onClose();
  }

  return (
    <form onSubmit={submit}>
      <p className="mt-2 text-sm text-keep-muted">
        <Trans t={t} i18nKey="createRoom.intro">
          Pick a name. Spaces become underscores, so <b>Oak Tavern</b> becomes <b>Oak_Tavern</b>.
        </Trans>
      </p>

      <label className={LABEL} htmlFor="create-room-name">
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
        className={FIELD}
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

      {/* Linked 18+ twin (adults, public rooms only): one checkbox turns the
          create into a pair — <name> plus <name>_Adult — listed as a single
          room with a SFW/18+ toggle instead of two rail entries. */}
      {!isPrivate && isAdult ? (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={withNsfwPair}
            onChange={(e) => { setWithNsfwPair(e.target.checked); setError(null); }}
            className="h-4 w-4 accent-keep-action"
          />
          <span>
            <Trans t={t} i18nKey="createRoom.pairLabel">
              With a linked 18+ room <span className="text-keep-muted">(adds an adults-only side behind a SFW/18+ toggle)</span>
            </Trans>
          </span>
        </label>
      ) : null}

      {isPrivate ? (
        <>
          <label className={LABEL} htmlFor="create-room-password">
            {t("password")}
          </label>
          <input
            id="create-room-password"
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(null); }}
            autoComplete="new-password"
            className={FIELD}
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
  );
}

function PairTab({ rooms, onClose }: { rooms: RoomSummary[]; onClose: () => void }) {
  const { t } = useTranslation("common");
  const me = useChat((s) => s.me);
  const [sfwId, setSfwId] = useState("");
  const [nsfwId, setNsfwId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rooms this viewer can pair from the Builder: owned (or any room, for
  // staff holding the room-edit grant), public, not forum boards, not
  // already in a pair. Room MODS who aren't owners can still pair via the
  // /linkroom command; the picker only lists what it can verify locally.
  const canEditAll = !!me?.permissions.includes("edit_any_room_metadata");
  const editable = useMemo(
    () =>
      rooms.filter(
        (r) =>
          r.type === "public"
          && !r.forumId
          && !r.linkedSfwRoomId
          && !r.linkedNsfwRoomId
          && (canEditAll || (me != null && r.ownerId === me.id)),
      ),
    [rooms, canEditAll, me],
  );
  const sfwChoices = editable.filter((r) => !r.isNsfw);
  const nsfwChoices = editable.filter((r) => r.id !== sfwId);
  const nsfwPick = rooms.find((r) => r.id === nsfwId);

  // Existing pairs the viewer can manage, for the Unlink list.
  const pairs = useMemo(
    () =>
      rooms
        .filter(
          (r) =>
            r.linkedNsfwRoomId
            && (canEditAll || (me != null && r.ownerId === me.id)),
        )
        .map((base) => ({
          base,
          annex: rooms.find((r) => r.id === base.linkedNsfwRoomId) ?? null,
        })),
    [rooms, canEditAll, me],
  );

  const post = async (url: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const j = (await r.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch { /* non-JSON */ }
        setError(msg);
        return false;
      }
      return true;
    } catch {
      setError(t("createRoom.pairNetworkError"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const link = async () => {
    if (!sfwId || !nsfwId) return;
    if (await post("/rooms/link", { sfwRoomId: sfwId, nsfwRoomId: nsfwId })) onClose();
  };
  const unlink = async (roomId: string) => {
    // Success repaints via the server's tree pulse (the rail refetches
    // /rooms and this modal's `rooms` prop updates), so no local state.
    await post("/rooms/unlink", { roomId });
  };

  return (
    <div>
      <p className="mt-2 text-sm text-keep-muted">{t("createRoom.pairIntro")}</p>

      {sfwChoices.length === 0 || editable.length < 2 ? (
        <p className="mt-3 rounded border border-keep-rule bg-keep-panel/40 px-2 py-2 text-xs text-keep-muted">
          {t("createRoom.pairNoEligible")}
        </p>
      ) : (
        <>
          <label className={LABEL} htmlFor="pair-sfw-room">
            {t("createRoom.pairSfwLabel")}
          </label>
          <select
            id="pair-sfw-room"
            value={sfwId}
            onChange={(e) => { setSfwId(e.target.value); setError(null); }}
            className={FIELD}
          >
            <option value="">{t("createRoom.pairPick")}</option>
            {sfwChoices.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>

          <label className={LABEL} htmlFor="pair-nsfw-room">
            {t("createRoom.pairNsfwLabel")}
          </label>
          <select
            id="pair-nsfw-room"
            value={nsfwId}
            onChange={(e) => { setNsfwId(e.target.value); setError(null); }}
            className={FIELD}
          >
            <option value="">{t("createRoom.pairPick")}</option>
            {nsfwChoices.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          {nsfwPick && !nsfwPick.isNsfw ? (
            <p className="mt-1 text-[11px] text-keep-muted">{t("createRoom.pairWillFlag", { name: nsfwPick.name })}</p>
          ) : null}
        </>
      )}

      {pairs.length > 0 ? (
        <>
          <h3 className="mt-4 text-xs uppercase tracking-wider text-keep-muted">{t("createRoom.pairExisting")}</h3>
          <ul className="mt-1 space-y-1">
            {pairs.map(({ base, annex }) => (
              <li key={base.id} className="flex items-center justify-between gap-2 rounded border border-keep-rule/60 px-2 py-1 text-sm">
                <span className="min-w-0 truncate">
                  {base.name} <span className="text-keep-muted">⇄</span> {annex?.name ?? base.linkedNsfwRoomId}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void unlink(base.id)}
                  className="shrink-0 rounded border border-keep-rule px-2 py-0.5 text-xs text-keep-muted hover:bg-keep-accent/10 hover:text-keep-accent disabled:opacity-50"
                >
                  {t("createRoom.pairUnlink")}
                </button>
              </li>
            ))}
          </ul>
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
          type="button"
          disabled={busy || !sfwId || !nsfwId}
          onClick={() => void link()}
          className="rounded border border-keep-action/60 bg-keep-action/10 px-3 py-1 text-sm font-semibold text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
        >
          {t("createRoom.pairSubmit")}
        </button>
      </div>
    </div>
  );
}
