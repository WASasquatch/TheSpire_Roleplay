import { useEffect, useState } from "react";
import {
  banAccount,
  fetchUserModeration,
  unbanAccount,
  type UserModeration,
} from "../lib/profileModeration.js";
import { BanModal } from "./BanModal.js";

function fmtTs(ts: number | null): string {
  if (ts == null) return "-";
  try { return new Date(ts).toLocaleString(); } catch { return "-"; }
}

/**
 * Account-ban widget shared by the profile mod panel and the Global Admin
 * user editor, so both offer the SAME ban experience (timed/permanent + reason
 * + optional post sweep) and the same current-ban banner + history. The server
 * enforces the real permissions (`ban_account` / `unban_account`); `canBan`
 * just gates the whole control so non-mods never see it or fetch its data.
 */
export function AccountBanControl({
  userId,
  targetName,
  canBan,
  onChanged,
}: {
  userId: string;
  targetName: string;
  canBan: boolean;
  onChanged?: (() => void) | undefined;
}) {
  const [mod, setMod] = useState<UserModeration | null>(null);
  const [banOpen, setBanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (canBan) {
      fetchUserModeration(userId).then((m) => { if (alive) setMod(m); }).catch(() => {});
    } else {
      setMod(null);
    }
    return () => { alive = false; };
  }, [userId, canBan]);

  if (!canBan) return null;

  async function refreshMod() {
    try { setMod(await fetchUserModeration(userId)); }
    catch { /* leave prior state; non-fatal for the panel */ }
  }

  const ban = mod?.ban ?? null;

  async function doUnban() {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await unbanAccount(userId); await refreshMod(); onChanged?.(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Unban failed."); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Active-ban banner */}
      {ban ? (
        <div className="rounded border border-[#e06070]/50 bg-[#e06070]/10 px-2.5 py-1.5 text-[11px] text-keep-text">
          <span className="font-semibold text-[#e06070]">⛔ Banned</span>{" "}
          {ban.bannedUntil ? <>until {fmtTs(ban.bannedUntil)}</> : <>permanently</>}
          {ban.reason ? <>, “{ban.reason}”</> : null}
          {ban.by ? <span className="text-keep-muted"> (by {ban.by})</span> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {ban ? (
          <button
            type="button"
            onClick={() => void doUnban()}
            disabled={busy}
            className="rounded border border-keep-rule bg-keep-panel px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-keep-text hover:bg-keep-banner disabled:opacity-50"
          >
            {busy ? "Working…" : "Unban"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setBanOpen(true)}
            className="rounded border border-[#e06070]/60 bg-[#e06070]/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-[#e06070] hover:bg-[#e06070]/20"
          >
            Ban
          </button>
        )}
      </div>
      {err ? <div className="text-[10px] text-[#e06070]">{err}</div> : null}

      {/* History (mod-only) */}
      {mod && mod.history.length > 0 ? (
        <details className="text-[11px] text-keep-muted">
          <summary className="cursor-pointer select-none uppercase tracking-widest">
            Ban history ({mod.history.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {mod.history.map((h, i) => (
              <li key={i} className="leading-snug">
                <span className="text-keep-text">{fmtTs(h.at)}</span>{" "}
                {h.action === "account_ban" ? (
                  <>ban{h.until ? <> (until {fmtTs(h.until)})</> : <> (permanent)</>}</>
                ) : (
                  <>unban</>
                )}{" "}
                <span className="text-keep-muted">by {h.by}</span>
                {h.reason ? <>, “{h.reason}”</> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {banOpen ? (
        <BanModal
          targetName={targetName}
          onClose={() => setBanOpen(false)}
          onConfirm={async (durationMs, reason, purge) => {
            setBusy(true); setErr(null);
            try {
              await banAccount(userId, durationMs, reason, purge);
              setBanOpen(false);
              await refreshMod();
              onChanged?.();
            } catch (e) {
              setErr(e instanceof Error ? e.message : "Ban failed.");
              throw e; // keep the modal open on failure
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}
