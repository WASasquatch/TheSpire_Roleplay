import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Display + per-metric privacy toggles. Five self-saving checkboxes
 * that hit PUT /me/profile on each flip:
 *
 *   show-rank-in-userlist, when off, the user's userlist row drops
 *     back to the gender glyph (server nulls the rank fields on the
 *     occupant payload, and the existing UserNameTag conditional
 *     handles the fallback). Re-broadcasts presence on save so the
 *     change shows up in every viewer's rail without a reload.
 *   show-rank-in-chat, when off, future chat messages from this
 *     user persist with null rank fields so no gem renders next to
 *     the line. Past messages keep whatever was snapshotted at send
 *     time, toggling the flag never rewrites history.
 *
 *   hide-chat-message-count / hide-forum-topic-count
 *   hide-forum-reply-count, when on, the matching ProfileMetrics
 *     field is returned as null from /profile, and the modal
 *     renders "private" in place of the number.
 *
 * Each row optimistically updates local state and reverts on save
 * failure, same pattern CurrencyPrivacyRow uses.
 *
 * Surfaced in two places (1:1 parity is intentional, the same
 * toggles, same labels, same hints, same on-save behavior):
 *   - Profile Editor → Privacy tab
 *   - Earning Modal  → Settings tab
 *
 * Centralizing the component here means a copy edit in one place
 * propagates to both surfaces and they can't drift apart.
 */
export function DisplayPrivacyRow() {
  const { t } = useTranslation("profile");
  const [loaded, setLoaded] = useState(false);
  const [showRankInUserlist, setShowRankInUserlist] = useState(true);
  const [showRankInChat, setShowRankInChat] = useState(true);
  const [hideChat, setHideChat] = useState(false);
  const [hideTopics, setHideTopics] = useState(false);
  const [hideReplies, setHideReplies] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Load current values once on mount. We fetch /me/profile here
  // directly rather than threading state through props because the
  // two callers (ProfileEditor + Earning Modal SettingsTab) have
  // very different surrounding state shapes, and a self-contained
  // load keeps the component drop-in-anywhere.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/me/profile", { credentials: "include" });
        if (!r.ok) throw new Error(t("errors.loadFailed"));
        const j = await r.json() as {
          showRankInUserlist?: boolean;
          showRankInChat?: boolean;
          hideChatMessageCount?: boolean;
          hideForumTopicCount?: boolean;
          hideForumReplyCount?: boolean;
        };
        if (cancelled) return;
        setShowRankInUserlist(j.showRankInUserlist ?? true);
        setShowRankInChat(j.showRankInChat ?? true);
        setHideChat(j.hideChatMessageCount ?? false);
        setHideTopics(j.hideForumTopicCount ?? false);
        setHideReplies(j.hideForumReplyCount ?? false);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : t("errors.loadFailed"));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot fetch on mount; `t` only shapes error copy
  }, []);

  // One save helper for all five toggles. Takes the field name + new
  // value + a local-state setter so optimistic flip + revert-on-fail
  // is consistent across rows.
  async function save<T>(
    key: string,
    field: string,
    next: T,
    setter: (v: T) => void,
    prev: T,
  ) {
    setter(next);
    setSavingKey(key);
    setErr(null);
    try {
      const r = await fetch("/me/profile", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.failedToSave"));
      setter(prev);
    } finally {
      setSavingKey(null);
    }
  }

  function row(
    key: string,
    field: string,
    label: string,
    hint: string,
    checked: boolean,
    setter: (v: boolean) => void,
  ) {
    return (
      <label className="mb-1 flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={!loaded || savingKey === key}
          onChange={(e) => void save(key, field, e.target.checked, setter, checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="block text-keep-text">{label}</span>
          <span className="block text-[10px] text-keep-muted">{hint}</span>
        </span>
      </label>
    );
  }

  return (
    <fieldset className="rounded border border-keep-rule p-3 text-xs">
      <legend className="px-1 uppercase tracking-widest text-keep-muted">{t("displayPrivacy.legend")}</legend>
      <p className="mb-2 text-[10px] text-keep-muted">
        {t("displayPrivacy.intro")}
      </p>
      {row(
        "rank-userlist",
        "showRankInUserlist",
        t("displayPrivacy.rankUserlist.label"),
        t("displayPrivacy.rankUserlist.hint"),
        showRankInUserlist,
        setShowRankInUserlist,
      )}
      {row(
        "rank-chat",
        "showRankInChat",
        t("displayPrivacy.rankChat.label"),
        t("displayPrivacy.rankChat.hint"),
        showRankInChat,
        setShowRankInChat,
      )}
      <div className="mt-3 border-t border-keep-rule/40 pt-2">
        <p className="mb-2 text-[10px] text-keep-muted">
          {t("displayPrivacy.countersIntro")}
        </p>
        {row(
          "hide-chat",
          "hideChatMessageCount",
          t("displayPrivacy.hideChat"),
          t("displayPrivacy.rendersPrivate"),
          hideChat,
          setHideChat,
        )}
        {row(
          "hide-topics",
          "hideForumTopicCount",
          t("displayPrivacy.hideTopics"),
          t("displayPrivacy.rendersPrivate"),
          hideTopics,
          setHideTopics,
        )}
        {row(
          "hide-replies",
          "hideForumReplyCount",
          t("displayPrivacy.hideReplies"),
          t("displayPrivacy.rendersPrivate"),
          hideReplies,
          setHideReplies,
        )}
      </div>
      {err ? (
        <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-[10px] text-keep-accent">{err}</div>
      ) : null}
      {savedFlash ? (
        <div className="mt-1 text-[10px] text-keep-system">{t("saved")}</div>
      ) : null}
    </fieldset>
  );
}
