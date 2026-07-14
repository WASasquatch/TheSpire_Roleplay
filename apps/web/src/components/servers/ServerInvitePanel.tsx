/**
 * Member-facing "Invite people" panel. Opened from the room rail's header
 * while inside a community whose owner allows the viewer to mint invite
 * links (servers.invite_create_mode: staff / picked roles / all members —
 * the server enforces the policy again on every write).
 *
 * Small prompt-sized modal (deliberately NOT MODAL_CARD_CONTENT): create a
 * link with sane defaults (7-day expiry, unlimited uses), one-click copy of
 * the FULL public URL (/i/<code>), the caller's own live links with revoke,
 * and the non-staff active-link cap surfaced plainly.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Link2, Trash2, X } from "lucide-react";
import { Modal } from "../cosmetics/Modal.js";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard.js";
import {
  createServerInvite,
  fetchMyServerInvites,
  inviteLinkFor,
  revokeServerInvite,
  type MyServerInvites,
  type ServerInviteWire,
} from "../../lib/servers.js";
import { formatDate } from "../../lib/intlFormat.js";

const EXPIRY_CHOICES = [
  { key: "day", hours: 24 },
  { key: "week", hours: 24 * 7 },
  { key: "month", hours: 24 * 30 },
  { key: "never", hours: null },
] as const;

export function ServerInvitePanel({ serverId, serverName, onClose }: {
  serverId: string;
  serverName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("servers");
  const [mine, setMine] = useState<MyServerInvites | null>(null);
  // Load failure is tracked apart from the policy shape: a fabricated
  // cap-0 "can't create" would read as a policy limit, not a hiccup.
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Default = 7 days, unlimited uses (the Discord-familiar default).
  const [expiry, setExpiry] = useState<(typeof EXPIRY_CHOICES)[number]["key"]>("week");

  useEffect(() => {
    let alive = true;
    setMine(null);
    setLoadFailed(false);
    fetchMyServerInvites(serverId)
      .then((m) => { if (alive) setMine(m); })
      .catch(() => { if (alive) setLoadFailed(true); });
    return () => { alive = false; };
  }, [serverId]);

  async function refresh() {
    setMine(await fetchMyServerInvites(serverId));
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const hours = EXPIRY_CHOICES.find((c) => c.key === expiry)?.hours ?? null;
      await createServerInvite(serverId, { expiresInHours: hours });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("shared.loadFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(code: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await revokeServerInvite(serverId, code);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("shared.loadFailed"));
    } finally {
      setBusy(false);
    }
  }

  const atCap = !!mine && !mine.staff && mine.invites.length >= mine.cap;

  return (
    <Modal onClose={onClose} zIndex={60}>
      <div
        className="keep-frame w-[min(94vw,28rem)] max-h-[85vh] overflow-y-auto rounded-lg border border-keep-rule bg-keep-bg p-4 text-keep-text shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-action text-lg leading-tight">{t("invitePanel.title", { name: serverName })}</h2>
            <p className="mt-0.5 text-xs text-keep-muted">{t("invitePanel.subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t("shared.close")}
            aria-label={t("shared.close")}
            className="shrink-0 rounded p-1 text-keep-muted hover:text-keep-text"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Create row: expiry choice + mint button. Hidden (with a short
            note) when the policy no longer admits the caller — their
            existing links below stay copyable/revocable either way. */}
        {loadFailed ? (
          <p className="rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs">{t("shared.loadFailed")}</p>
        ) : !mine || mine.canCreate ? (
          <div className="flex flex-wrap items-end gap-2 rounded border border-keep-rule bg-keep-panel/30 p-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] uppercase tracking-widest text-keep-muted">
              {t("invitePanel.expiresLabel")}
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value as typeof expiry)}
                className="rounded border border-keep-rule bg-keep-bg px-2 py-1.5 text-sm normal-case tracking-normal text-keep-text"
              >
                {EXPIRY_CHOICES.map((c) => (
                  <option key={c.key} value={c.key}>{t(`invitePanel.expiry.${c.key}`)}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy || atCap}
              className="flex items-center gap-1.5 rounded border border-keep-action bg-keep-action/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-keep-action hover:bg-keep-action/25 disabled:opacity-50"
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t("invitePanel.create")}
            </button>
          </div>
        ) : (
          <p className="rounded border border-keep-rule bg-keep-panel/30 px-3 py-2 text-[11px] text-keep-muted">
            {t("invitePanel.createOff")}
          </p>
        )}
        {mine && mine.canCreate && !mine.staff ? (
          <p className={`mt-1.5 text-[11px] ${atCap ? "font-semibold text-keep-accent" : "text-keep-muted"}`}>
            {atCap
              ? t("invitePanel.capReached", { cap: mine.cap })
              : t("invitePanel.capNote", { used: mine.invites.length, cap: mine.cap })}
          </p>
        ) : null}
        {err ? (
          <p className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs">{err}</p>
        ) : null}

        {/* The caller's own live links. */}
        <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-widest text-keep-muted">
          {t("invitePanel.yoursTitle")}
        </p>
        {!mine ? (
          <p className="text-xs italic text-keep-muted">{loadFailed ? t("shared.loadFailed") : t("shared.loading")}</p>
        ) : mine.invites.length === 0 ? (
          <p className="rounded border border-dashed border-keep-rule px-3 py-4 text-center text-xs italic text-keep-muted">
            {t("invitePanel.empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {mine.invites.map((inv) => (
              <InviteRow key={inv.code} invite={inv} busy={busy} onRevoke={() => void revoke(inv.code)} />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function InviteRow({ invite, busy, onRevoke }: {
  invite: ServerInviteWire;
  busy: boolean;
  onRevoke: () => void;
}) {
  const { t } = useTranslation("servers");
  const { copied, copy } = useCopyToClipboard({
    onError: (text) => window.prompt(t("invitePanel.copyManual"), text),
  });
  const url = inviteLinkFor(invite);
  return (
    <li className="flex items-center gap-2 rounded border border-keep-rule bg-keep-panel/20 px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs text-keep-text">{url}</p>
        <p className="mt-0.5 text-[11px] text-keep-muted">
          {invite.maxUses != null
            ? t("invitePanel.usesOf", { used: invite.usedCount, max: invite.maxUses })
            : t("invitePanel.uses", { count: invite.usedCount })}
          {" · "}
          {invite.expiresAt
            ? t("invitePanel.expires", { date: formatDate(invite.expiresAt) })
            : t("invitePanel.neverExpires")}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void copy(url)}
        title={copied ? t("invitePanel.copied") : t("invitePanel.copyLink")}
        aria-label={copied ? t("invitePanel.copied") : t("invitePanel.copyLink")}
        className="shrink-0 rounded border border-keep-rule p-1.5 text-keep-muted hover:border-keep-action hover:text-keep-action"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-keep-action" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
      <button
        type="button"
        onClick={onRevoke}
        disabled={busy}
        title={t("invitePanel.revoke")}
        aria-label={t("invitePanel.revoke")}
        className="shrink-0 rounded border border-keep-rule p-1.5 text-keep-muted hover:border-keep-accent hover:text-keep-accent disabled:opacity-50"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}
