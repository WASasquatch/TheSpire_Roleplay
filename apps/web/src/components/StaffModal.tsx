import { useEffect, useState } from "react";
import type { AvatarCrop, Role } from "@thekeep/shared";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { CloseButton } from "./CloseButton.js";
import { BorderedAvatar } from "./BorderedAvatar.js";
import { StyledName } from "./StyledName.js";
import { readError } from "../lib/http.js";

/** One staff member's card, as returned by GET /staff. */
interface StaffCard {
  userId: string;
  username: string;
  role: Role;
  avatarUrl: string | null;
  avatarCrop: AvatarCrop;
  borderRankKey: string | null;
  freeformBorderKey: string | null;
  freeformConfig: Record<string, string> | null;
  nameStyleKey: string | null;
  nameStyleConfig: Record<string, unknown> | null;
  bio: string | null;
  intro: string | null;
  canEdit: boolean;
}

const MAX_BIO = 120;
const MAX_INTRO = 256;

/** Friendly label + theme color slot per staff role. */
function roleLabel(role: Role): string {
  return role === "masteradmin" ? "Master Admin" : role === "admin" ? "Admin" : "Moderator";
}
function roleClasses(role: Role): string {
  // Tiered tint so the hierarchy reads at a glance: accent (warmest)
  // for masteradmin, action for admin, system for moderator.
  return role === "masteradmin"
    ? "border-keep-accent/50 bg-keep-accent/10 text-keep-accent"
    : role === "admin"
      ? "border-keep-action/50 bg-keep-action/10 text-keep-action"
      : "border-keep-system/50 bg-keep-system/10 text-keep-system";
}

/**
 * The Staff page. A modal directory of every mod/admin/masteradmin,
 * each as a card showing their avatar (with equipped border frame),
 * name in their equipped name style, role, a short bio + a longer
 * introduction, and a Message button. Staff can edit the bio/intro on
 * their OWN card inline.
 *
 * Layout: a centered flex-wrap grid, up to 4 cards per row on wide
 * screens, narrowing to 2 then 1; cards stay centered when there are
 * fewer than a full row. Full-width single column on mobile.
 */
export function StaffModal({
  onClose,
  onMessage,
  meId,
}: {
  onClose: () => void;
  /** Open a DM with this staff member (master/OOC identity). */
  onMessage: (userId: string) => void;
  /** Viewer's own user id, drives the "you" treatment + edit. */
  meId: string | null;
}) {
  const [cards, setCards] = useState<StaffCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/staff", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return (await r.json()) as { staff: StaffCard[] };
      })
      .then((j) => { if (!cancelled) setCards(j.staff); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "load failed"); });
    return () => { cancelled = true; };
  }, []);

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`${MODAL_CARD_CONTENT} keep-frame bg-keep-bg lg:rounded`}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-keep-rule bg-keep-banner px-4 py-2">
          <div>
            <h2 className="font-action text-lg">Staff</h2>
            <p className="text-[11px] text-keep-muted">The people who keep the Spire running.</p>
          </div>
          <CloseButton onClick={onClose} />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <div className="mx-auto max-w-md rounded border border-keep-accent/40 bg-keep-accent/10 p-3 text-sm text-keep-accent">
              {error}
            </div>
          ) : cards === null ? (
            <div className="py-10 text-center text-sm italic text-keep-muted">Loading…</div>
          ) : cards.length === 0 ? (
            <div className="py-10 text-center text-sm italic text-keep-muted">No staff to show.</div>
          ) : (
            <ul className="flex flex-wrap justify-center gap-4">
              {cards.map((c) => (
                <li
                  key={c.userId}
                  // 1 / row on mobile, 2 on sm, 4 on xl; flex-wrap +
                  // justify-center keeps a partial last row centered.
                  className="w-full sm:w-[calc(50%-0.5rem)] xl:w-[calc(25%-0.75rem)]"
                >
                  <StaffCardView
                    card={c}
                    isSelf={!!meId && c.userId === meId}
                    onMessage={() => onMessage(c.userId)}
                    onSaved={(bio, intro) =>
                      setCards((prev) =>
                        prev
                          ? prev.map((p) => (p.userId === c.userId ? { ...p, bio, intro } : p))
                          : prev,
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function StaffCardView({
  card,
  isSelf,
  onMessage,
  onSaved,
}: {
  card: StaffCard;
  isSelf: boolean;
  onMessage: () => void;
  onSaved: (bio: string | null, intro: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="keep-frame flex h-full flex-col items-center rounded border border-keep-rule bg-keep-panel/40 p-4 text-center">
      {/* Role chip, pinned at the top so the hierarchy reads first. */}
      <span
        className={`mb-3 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${roleClasses(card.role)}`}
      >
        {roleLabel(card.role)}
      </span>

      <BorderedAvatar
        avatarUrl={card.avatarUrl}
        avatarCrop={card.avatarCrop}
        name={card.username}
        borderRankKey={card.borderRankKey}
        freeformBorderKey={card.freeformBorderKey}
        freeformConfig={card.freeformConfig}
        size="xl"
      />

      <div className="mt-3 text-lg font-semibold leading-tight text-keep-text">
        <StyledName
          displayName={card.username}
          styleKey={card.nameStyleKey}
          config={card.nameStyleConfig}
        />
      </div>

      {/* Short tagline. */}
      {card.bio ? (
        <p className="mt-1 text-xs italic leading-snug text-keep-muted">{card.bio}</p>
      ) : null}

      {/* Longer introduction. `flex-1` lets the action row below sit at a
          consistent baseline across cards of differing intro length. */}
      {card.intro ? (
        <p className="mt-3 min-h-0 flex-1 whitespace-pre-wrap text-sm leading-snug text-keep-text/90">
          {card.intro}
        </p>
      ) : (
        <p className="mt-3 min-h-0 flex-1 text-sm italic text-keep-muted/60">
          {isSelf ? "Add an introduction with “Edit card”." : ""}
        </p>
      )}

      {editing ? (
        <StaffCardEditor card={card} onClose={() => setEditing(false)} onSaved={onSaved} />
      ) : (
        <div className="mt-4 flex w-full shrink-0 items-center justify-center gap-2">
          {isSelf ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs hover:bg-keep-banner"
            >
              Edit card
            </button>
          ) : (
            <button
              type="button"
              onClick={onMessage}
              title={`Message ${card.username}`}
              className="keep-button rounded border border-keep-action bg-keep-action/10 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/20"
            >
              💬 Message
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StaffCardEditor({
  card,
  onClose,
  onSaved,
}: {
  card: StaffCard;
  onClose: () => void;
  onSaved: (bio: string | null, intro: string | null) => void;
}) {
  const [bio, setBio] = useState(card.bio ?? "");
  const [intro, setIntro] = useState(card.intro ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/me/staff-card", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bio, intro }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const j = (await r.json()) as { bio: string | null; intro: string | null };
      onSaved(j.bio, j.intro);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 w-full shrink-0 space-y-2 text-left">
      <label className="block text-[10px] uppercase tracking-widest text-keep-muted">
        Tagline
        <input
          type="text"
          value={bio}
          maxLength={MAX_BIO}
          onChange={(e) => setBio(e.target.value)}
          placeholder="One line about you"
          className="mt-0.5 w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm normal-case tracking-normal text-keep-text outline-none focus:border-keep-action"
        />
        <span className="mt-0.5 block text-right text-[9px] text-keep-muted">{bio.length}/{MAX_BIO}</span>
      </label>
      <label className="block text-[10px] uppercase tracking-widest text-keep-muted">
        Introduction
        <textarea
          value={intro}
          maxLength={MAX_INTRO}
          rows={3}
          onChange={(e) => setIntro(e.target.value)}
          placeholder="A short introduction shown on your card"
          className="mt-0.5 w-full resize-none rounded border border-keep-rule bg-keep-bg px-2 py-1 text-sm normal-case tracking-normal text-keep-text outline-none focus:border-keep-action"
        />
        <span className="mt-0.5 block text-right text-[9px] text-keep-muted">{intro.length}/{MAX_INTRO}</span>
      </label>
      {err ? <div className="text-[11px] text-keep-accent">{err}</div> : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-xs hover:bg-keep-banner disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="keep-button rounded border border-keep-action bg-keep-action/10 px-3 py-1 text-xs font-semibold text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
